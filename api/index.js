const http = require('http');
const https = require('https');
const nacl = require('tweetnacl');

// ─── CONFIG ────────────────────────────────────────────────────────────────
const KEY_HEX = 'c75136c5668bbfe65a7ecad431a745db68b5f381555b38d8f6c699449cf11fcd';
const KEY = hexToBytes(KEY_HEX);
const NONCE = new Uint8Array(24);

// 🔥 YOUR PHP PROXY SERVERS
const EDGES = [
  'https://cdn1.cinesl.top',
  'https://cdn2.cinesl.top',
  'https://cdn3.cinesl.top'
];

// ─── HEADERS ───────────────────────────────────────────────────────────────
const UPSTREAM_HEADERS = {
  'User-Agent': 'Mozilla/5.0',
  'Origin': 'https://vidlink.pro',
  'Referer': 'https://vidlink.pro/'
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*'
};

// ─── HELPERS ───────────────────────────────────────────────────────────────
function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

function getRandomEdge() {
  return EDGES[Math.floor(Math.random() * EDGES.length)];
}

// ─── TOKEN ─────────────────────────────────────────────────────────────────
function encryptToken(mediaId) {
  const timestamp = Math.floor(Date.now() / 1000) + 480;
  const idBytes = new TextEncoder().encode(mediaId);

  const tsBuf = new Uint8Array(8);
  const view = new DataView(tsBuf.buffer);
  view.setUint32(0, Math.floor(timestamp / 0x100000000));
  view.setUint32(4, timestamp >>> 0);

  const message = new Uint8Array(idBytes.length + 8);
  message.set(idBytes);
  message.set(tsBuf, idBytes.length);

  const encrypted = nacl.secretbox(message, NONCE, KEY);

  const payload = new Uint8Array(24 + encrypted.length);
  payload.set(NONCE);
  payload.set(encrypted, 24);

  return Buffer.from(payload)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// ─── FETCH ─────────────────────────────────────────────────────────────────
function fetchUpstream(urlStr) {
  return new Promise((resolve, reject) => {
    https.get(urlStr, { headers: UPSTREAM_HEADERS }, resolve)
      .on('error', reject);
  });
}

// ─── 🔥 MAIN CHANGE HERE ────────────────────────────────────────────────────
function rewriteSourceUrls(obj) {
  if (typeof obj === 'string') {
    if (obj.includes('.m3u8') || obj.startsWith('http')) {
      try {
        new URL(obj);

        const edge = getRandomEdge();

        return `${edge}/proxy.php?url=${encodeURIComponent(obj)}`;
      } catch {}
    }
    return obj;
  }

  if (Array.isArray(obj)) return obj.map(rewriteSourceUrls);

  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = rewriteSourceUrls(v);
    }
    return out;
  }

  return obj;
}

// ─── HANDLER ───────────────────────────────────────────────────────────────
async function handleSource(res, mediaId, type, season, episode) {
  try {
    const token = encryptToken(mediaId);

    const apiUrl =
      type === 'movie'
        ? `https://vidlink.pro/api/b/movie/${token}?multiLang=1`
        : `https://vidlink.pro/api/b/tv/${token}/${season}/${episode}?multiLang=1`;

    const upstream = await fetchUpstream(apiUrl);

    let body = '';
    for await (const chunk of upstream) body += chunk;

    const data = JSON.parse(body);
    const rewritten = rewriteSourceUrls(data);

    res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify(rewritten));

  } catch (err) {
    res.writeHead(500, CORS_HEADERS);
    res.end(err.message);
  }
}

// ─── ROUTER ────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;

    const movie = path.match(/^\/movie\/([^/]+)$/);
    if (movie) return handleSource(res, movie[1], 'movie');

    const tv = path.match(/^\/tv\/([^/]+)\/(\d+)\/(\d+)$/);
    if (tv) return handleSource(res, tv[1], 'tv', tv[2], tv[3]);

    res.end('OK');
  } catch (err) {
    res.end(err.message);
  }
};
