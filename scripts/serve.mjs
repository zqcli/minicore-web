import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = fileURLToPath(new URL('../web/', import.meta.url));
const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
};

export async function startServer({ root = webRoot, host = '127.0.0.1', port = 8080, config } = {}) {
  root = await realpath(root);
  const server = createServer(async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    try {
      const url = new URL(request.url, 'http://localhost');
      const pathname = decodeURIComponent(url.pathname);
      if (pathname.includes('\\') || pathname.includes('\0')) throw new Error('Invalid path');
      const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
      let body;
      let type;
      if (config && requested === 'config.json') {
        body = Buffer.from(JSON.stringify(config));
        type = mime['.json'];
      } else {
        const path = await realpath(resolve(root, requested));
        const inside = relative(root, path);
        if (inside === '..' || inside.startsWith('..' + sep) || resolve(root, inside) !== path) {
          throw new Error('Outside static root');
        }
        body = await readFile(path);
        type = mime[extname(path)] || 'application/octet-stream';
      }
      response.writeHead(200, {
        'Content-Type': type, 'Content-Length': body.length,
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.MINICORE_WEB_PORT || 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid MINICORE_WEB_PORT');
  const server = await startServer({ port });
  console.log(`MiniCore Web: http://127.0.0.1:${server.address().port}`);
}
