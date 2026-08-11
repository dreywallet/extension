/* global URL, process */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';

const HOST = '127.0.0.1';
const PORT = 4173;
const ROOT = import.meta.dirname;
const FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/frame.html', ['frame.html', 'text/html; charset=utf-8']],
  ['/dapp.js', ['dapp.js', 'text/javascript; charset=utf-8']],
]);

const server = createServer(async (request, response) => {
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  const url = new URL(request.url ?? '/', `http://${HOST}:${PORT}`);
  if (url.pathname === '/health') {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('ok');
    return;
  }
  const entry = FILES.get(url.pathname);
  if (!entry || request.method !== 'GET') {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('not found');
    return;
  }
  const [filename, contentType] = entry;
  const file = path.join(ROOT, filename);
  const metadata = await stat(file);
  response.writeHead(200, { 'content-type': contentType, 'content-length': metadata.size });
  createReadStream(file).pipe(response);
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`Drey E2E dapp listening on http://${HOST}:${PORT}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
