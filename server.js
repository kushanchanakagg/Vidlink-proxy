const http = require('http');
const handler = require('./api/index.js');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  handler(req, res);
});

server.listen(PORT, () => {
  console.log(`\n==========================================`);
  console.log(`🚀 VidLink Proxy Server running on port ${PORT}`);
  console.log(`🔗 http://localhost:${PORT}`);
  console.log(`==========================================\n`);
});
