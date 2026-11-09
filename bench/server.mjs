// 4Kフレーム転送の受信側(localhost HTTP方式の計測用)。依存なしで node server.mjs で起動する。
import http from 'node:http';

const PORT = Number(process.env.PORT ?? 8787);

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'x-token, content-type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.method !== 'POST' || req.url !== '/frame') { res.writeHead(404); return res.end(); }
  if (req.headers['x-token'] !== 'bench') { res.writeHead(403); return res.end(); }
  let bytes = 0;
  const t0 = process.hrtime.bigint();
  req.on('data', c => { bytes += c.length; });
  req.on('end', () => {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log(`received ${(bytes / 1e6).toFixed(1)} MB in ${ms.toFixed(1)} ms (server side)`);
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(String(bytes));
  });
}).listen(PORT, '127.0.0.1', () => console.log(`listening http://127.0.0.1:${PORT}/frame`));
