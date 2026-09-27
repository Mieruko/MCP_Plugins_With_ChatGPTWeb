import http from 'node:http';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const html = fileURLToPath(new URL('../docs/fixtures/computer-use-lab.html', import.meta.url));
const port = Number(process.env.CU_LAB_PORT || 3877);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid CU_LAB_PORT');
const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET') { res.writeHead(405).end(); return; }
  if (req.url === '/health') { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({fixture:'workbench-cu-lab-v1'})); return; }
  if (req.url !== '/') { res.writeHead(404).end(); return; }
  try {
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    res.end(await fs.readFile(html));
  } catch { res.writeHead(500).end('Fixture unavailable'); }
});
server.listen(port,'127.0.0.1',()=>console.log(`Computer Use lab: http://127.0.0.1:${port}/`));
