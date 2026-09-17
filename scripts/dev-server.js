const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8765;
const SCRIPT_FILE = path.join(__dirname, '..', 'x-split-reader.user.js');

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === '/' || url.pathname === '/x-split-reader.user.js') {
    fs.readFile(SCRIPT_FILE, 'utf8', (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`Error reading script: ${err.message}`);
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      });
      res.end(data);
      console.log(`[${new Date().toLocaleTimeString()}] Served x-split-reader.user.js (${data.length} bytes) to browser`);
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`
============================================================
  🚀 X Split Reader 本地热加载开发服务器已启动
  🌐 服务地址: http://127.0.0.1:${PORT}/x-split-reader.user.js
============================================================

【使用方法】：
1. 在油猴 / 暴力猴中新建脚本，将根目录下的 dev-loader.user.js 内容粘贴进去并保存（只需一次）。
2. 在本地修改代码并保存后，直接在推特页面按 F5 刷新，即可直接运行最新代码！
============================================================
`);
});
