// Мини-сервер превью: node scripts/serve-preview.js [порт]
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '.preview');
const port = Number(process.argv[2]) || 8123;

http.createServer((req, res) => {
  const name = path.basename(decodeURIComponent(req.url.split('?')[0])) || 'task-dark.html';
  const file = path.join(root, name.endsWith('.html') ? name : 'task-dark.html');
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
}).listen(port, '127.0.0.1', () => console.log('preview at http://127.0.0.1:' + port + '/task-dark.html'));
