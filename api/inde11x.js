const http = require('http');
const https = require('https');
const nacl = require('tweetnacl');

// ─── Config ──────────────────────────────────────────────────────────────────
const KEY_HEX = 'c75136c5668bbfe65a7ecad431a745db68b5f381555b38d8f6c699449cf11fcd';
const KEY = hexToBytes(KEY_HEX);
const NONCE = new Uint8Array(24); // 24 zero bytes

const UPSTREAM_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://vidlink.pro',
  'Referer': 'https://vidlink.pro/',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'cross-site'
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*'
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

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

  let b64 = Buffer.from(payload).toString('base64');
  b64 = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return b64;
}

function fetchUpstream(urlStr, extraHeaders = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    let parsedUrl;
    try { parsedUrl = new URL(urlStr); } catch (e) { return reject(e); }
    
    const options = {
      headers: { ...UPSTREAM_HEADERS, ...extraHeaders, 'Host': parsedUrl.host }
    };
    
    (urlStr.startsWith('https') ? https : http).get(urlStr, options, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location;
        const nextUrl = loc.startsWith('http') ? loc : new URL(loc, urlStr).href;
        return resolve(fetchUpstream(nextUrl, extraHeaders, redirects + 1));
      }
      resolve(res);
    }).on('error', reject);
  });
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ─── /movie & /tv ────────────────────────────────────────────────────────────
async function handleSource(res, mediaId, type, origin, season, episode) {
  try {
    const token = encryptToken(mediaId);
    let apiUrl = type === 'movie' 
      ? `https://vidlink.pro/api/b/movie/${token}?multiLang=1`
      : `https://vidlink.pro/api/b/tv/${token}/${season}/${episode}?multiLang=1`;

    const upstream = await fetchUpstream(apiUrl);
    let body = '';
    for await (const chunk of upstream) body += chunk;
    
    if (upstream.statusCode !== 200) {
      return sendJson(res, { error: `Upstream ${upstream.statusCode}` }, upstream.statusCode);
    }
    
    const data = JSON.parse(body);
    if (!data) return sendJson(res, { error: 'No source found' }, 404);

    const rewritten = rewriteSourceUrls(data, origin, 'https://cdn.cinesl.top');
    sendJson(res, rewritten);
  } catch (err) {
    sendJson(res, { error: err.message }, 500);
  }
}

function rewriteSourceUrls(obj, origin, proxyOrigin = null) {
  if (typeof obj === 'string') {
    if (obj.includes('.m3u8') || obj.startsWith('http')) {
      try {
        new URL(obj); 
        // Use PHP proxy if provided, otherwise use local watch endpoint
        const proxyUrl = proxyOrigin || origin;
        return `${proxyOrigin}/proxy.php?url=${encodeURIComponent(obj)}`;
      } catch { }
    }
    return obj;
  }
  if (Array.isArray(obj)) return obj.map(item => rewriteSourceUrls(item, origin, proxyOrigin));
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = rewriteSourceUrls(v, origin, proxyOrigin);
    }
    return out;
  }
  return obj;
}

// ─── /watch — Zero-RAM streaming proxy ───────────────────────────────────────
async function handleWatch(req, res, targetUrlStr, workerOrigin) {
  let targetUrl;
  try {
    targetUrl = new URL(targetUrlStr);
  } catch {
    return sendJson(res, { error: 'Invalid URL' }, 400);
  }

  const reqHeaders = {};
  if (req.headers.range) reqHeaders['Range'] = req.headers.range;

  try {
    const upstream = await fetchUpstream(targetUrlStr, reqHeaders);

    if (upstream.statusCode >= 400 && upstream.statusCode !== 206) {
      res.writeHead(upstream.statusCode, CORS_HEADERS);
      return res.end(`Upstream error: ${upstream.statusCode}`);
    }

    const contentType = (upstream.headers['content-type'] || '').toLowerCase();
    const isM3U8 = targetUrlStr.includes('.m3u8') || contentType.includes('mpegurl') || contentType.includes('x-mpegurl');

    if (isM3U8) {
      let body = '';
      for await (const chunk of upstream) body += chunk;
      const rewritten = rewriteM3U8(body, targetUrlStr, workerOrigin);
      res.writeHead(200, {
        ...CORS_HEADERS,
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-cache'
      });
      return res.end(rewritten);
    }

    // Direct pipe for zero-RAM buffering (essential for Oracle VPS)
    const responseHeaders = {
      ...CORS_HEADERS,
      'Content-Type': contentType || 'video/mp2t',
      'Accept-Ranges': 'bytes'
    };
    if (upstream.headers['content-length']) responseHeaders['Content-Length'] = upstream.headers['content-length'];
    if (upstream.headers['content-range']) responseHeaders['Content-Range'] = upstream.headers['content-range'];

    res.writeHead(upstream.statusCode, responseHeaders);
    upstream.pipe(res);
  } catch (err) {
    res.writeHead(502, CORS_HEADERS);
    res.end(err.message);
  }
}

function rewriteM3U8(text, baseUrl, workerOrigin) {
  return text.split('\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      if (trimmed.includes('URI="')) {
        return trimmed.replace(/URI="([^"]+)"/g, (match, uri) => {
          const absolute = resolveUrl(uri, baseUrl);
          return `URI="${workerOrigin}/watch?url=${encodeURIComponent(absolute)}"`;
        });
      }
      return line;
    }
    const absolute = resolveUrl(trimmed, baseUrl);
    return `${workerOrigin}/watch?url=${encodeURIComponent(absolute)}`;
  }).join('\n');
}

function resolveUrl(uri, baseUrl) {
  try { return new URL(uri, baseUrl).toString(); } 
  catch { return uri; }
}

// ─── Landing page ────────────────────────────────────────────────────────────
function handleHome(res) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>VidLink Pro API — Dual Environment Proxy</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600&family=Outfit:wght@300;600&display=swap" rel="stylesheet">
  <style>
    :root { --bg: #0a0a0c; --card-bg: rgba(255,255,255,0.03); --accent: #10b981; --text: #fff; --text-dim: #94a3b8; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: var(--bg); color: var(--text); font-family: 'Inter', sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; overflow: hidden; }
    .glow { position: absolute; width: 600px; height: 600px; background: radial-gradient(circle, rgba(16,185,129,0.08) 0%, transparent 70%); top: 50%; left: 50%; transform: translate(-50%,-50%); z-index: -1; }
    .container { max-width: 800px; width: 90%; background: var(--card-bg); backdrop-filter: blur(20px); border: 1px solid rgba(255,255,255,0.06); border-radius: 24px; padding: 40px; text-align: center; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5); }
    h1 { font-family: 'Outfit', sans-serif; font-size: 2.5rem; margin-bottom: 8px; background: linear-gradient(to right,#fff,#94a3b8); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .badge { display: inline-block; background: rgba(16,185,129,0.15); color: var(--accent); padding: 4px 12px; border-radius: 20px; font-size: 0.75rem; font-weight: 600; margin-bottom: 16px; letter-spacing: 1px; }
    p.desc { color: var(--text-dim); margin-bottom: 32px; font-weight: 300; }
    .endpoints { text-align: left; background: rgba(0,0,0,0.2); border-radius: 16px; padding: 24px; margin-bottom: 32px; }
    .endpoint { margin-bottom: 24px; }
    .endpoint:last-child { margin-bottom: 0; }
    .label { font-family: 'Outfit', sans-serif; font-weight: 600; color: var(--accent); font-size: 0.8rem; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; display: block; }
    .info { color: var(--text-dim); font-size: 0.85rem; margin-bottom: 8px; font-weight: 300; }
    .path { font-family: monospace; background: rgba(255,255,255,0.05); padding: 10px 14px; border-radius: 8px; display: block; word-break: break-all; color: #e2e8f0; margin-bottom: 12px; font-size: 0.9rem; }
  </style>
</head>
<body>
  <div class="glow"></div>
  <div class="container">
    <h1>VidLink Pro Proxy</h1>
    <span class="badge">ZERO-RAM NODE SERVER</span>
    <p class="desc">Vercel & Oracle Cloud VPS Compatible Streaming Engine</p>
    <div class="endpoints">
      <div class="endpoint">
        <span class="label">Movie Endpoint</span>
        <span class="path">/movie/{tmdb_id}</span>
      </div>
      <div class="endpoint">
        <span class="label">TV Endpoint</span>
        <span class="path">/tv/{tmdb_id}/{season}/{episode}</span>
      </div>
      <div class="endpoint">
        <span class="label">Watch Proxy</span>
        <span class="path">/watch?url={encoded_url}</span>
      </div>
    </div>
  </div>
</body>
</html>`;
  res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

// ─── Router ──────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }

  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
    const origin = `${proto}://${host}`;
    
    // In Vercel, req.url might be rewritten, so we just use the raw URL path
    const parsedUrl = new URL(req.url, origin);
    let path = parsedUrl.pathname;

    // Vercel rewrite might prefix /api
    if (path.startsWith('/api')) {
      path = path.replace('/api', '') || '/';
    }

    if (path === '/') return handleHome(res);

    const movieMatch = path.match(/^\/movie\/([^/]+)$/);
    if (movieMatch) return handleSource(res, movieMatch[1], 'movie', origin);

    const tvMatch = path.match(/^\/tv\/([^/]+)\/(\d+)\/(\d+)$/);
    if (tvMatch) return handleSource(res, tvMatch[1], 'tv', origin, tvMatch[2], tvMatch[3]);

    if (path === '/watch') {
      const targetUrl = parsedUrl.searchParams.get('url');
      if (!targetUrl) return sendJson(res, { error: 'Missing ?url= parameter' }, 400);
      return handleWatch(req, res, targetUrl, origin);
    }

    sendJson(res, { error: 'Not found' }, 404);
  } catch (err) {
    sendJson(res, { error: err.message }, 500);
  }
};
