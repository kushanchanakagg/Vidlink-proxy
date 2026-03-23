<div align="center">
  <h3><b>The Ultimate VidLink.pro Node.js & Vercel Proxy</b></h3>
  <p>A high-performance dual-environment proxy that bypasses Cloudflare Geo-blocks (403 errors) to retrieve direct M3U8 streaming links for Movies and TV Shows natively, with zero RAM overhead and full seeking support.</p>
</div>

---

### 🚀 **Features**

- ⚡ **Dual Environment**: Runs smoothly on a bare-metal Node.js Server (e.g., Oracle Cloud VPS) or as a Vercel Serverless Function.
- 🛡️ **Bypasses Cloudflare 403s**: Actively circumvents Cloudflare-to-Cloudflare `1020` blocks.
- 🔐 **Native Decryption**: Uses `tweetnacl` to replicate VidLink's `XSalsa20-Poly1305` logic natively in JS (No heavy WASM payloads).
- 🕒 **Adaptive Time-Sync**: Intelligence-based timestamp offset to prevent token expiration.
- 🕵️ **Zero-RAM Streaming Proxy**: Uses Node.js `stream.pipe()` capabilities to act as a stealth proxy for `m3u8` playlists and `.ts` chunk segments without buffering into memory.
- 🎨 **Range & Seek Support**: Fully passes `Range` headers back and forth, allowing you to seek immediately in your video player.
- 🎨 **Minimalist Documentation**: Built-in aesthetic landing page for easy testing.

---

### 🛠️ **Installation (Oracle Cloud VPS / Local Node.js)**

1. **Clone the repository**
   ```bash
   git clone https://github.com/mdtahseen7/Vidlink-proxy.git
   cd Vidlink-proxy
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Start the server**
   ```bash
   npm start
   ```

The local proxy will be running at `http://localhost:3000`.

---

### 🌍 **Deploy to Vercel**

If you don't have a VPS, you can instantly deploy the serverless version to Vercel:

```bash
npx vercel deploy
```
Vercel will detect `vercel.json` and deploy `api/index.js` as a serverless function automatically.

---

### 📖 **Usage**

Once your server is running or deployed, you can hit the following endpoints:

| Endpoint | Description |
| :--- | :--- |
| `GET /movie/{tmdb_id}` | Fetch direct sources for movies, with fully rewritten proxy streams. |
| `GET /tv/{tmdb_id}/{s}/{e}` | Fetch direct sources for episodes. |
| `GET /watch?url={encoded}` | Streaming zero-RAM M3U8 proxy to circumvent 403 headers and CORS blocks. |

---

### ⚙️ **Technical Breakdown**

This project reverse-engineered the VidLink Pro encryption logic. Unlike traditional solutions that rely on a browser or WASM bridge, this tool:

1. Generates a valid 24-byte nonce.
2. Constructs a binary message containing the `Media ID` and a `64-bit Big-Endian Timestamp`.
3. Encrypts the payload using the production key.
4. Acts as a transparent proxy for `.ts` video chunk retrieval by spoofing correct headers.

---

<div align="center">
  <p><b>Developed by <a href="https://github.com/mdtahseen7">Tahseen</a></b></p>
  <sub>Built with ❤️ for the open-source community.</sub>
</div>
