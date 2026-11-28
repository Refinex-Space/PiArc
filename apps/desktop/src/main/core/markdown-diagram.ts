// A fixed, unprivileged document renders Mermaid into passive images. It has no Core
// file grant. Neither the URL path nor diagram text can name a bundle file to serve.
import path from 'node:path';
import { readFile } from 'node:fs/promises';
export const DIAGRAM_PAGE = 'piarc-document://markdown-diagram/index.html';
export function diagramAssets(folder: string, engine: string) {
  const files = new Map([
    ['/index.html', { path: path.join(folder, 'index.html'), mime: 'text/html; charset=utf-8' }],
    ['/engine.js', { path: engine, mime: 'text/javascript' }],
    ['/frame.js', { path: path.join(folder, 'frame.js'), mime: 'text/javascript' }],
  ]);
  return async (req: Request) => {
    const file = files.get(new URL(req.url).pathname);
    if (!file || !['GET', 'HEAD'].includes(req.method)) return new Response(null, { status: 404 });
    const headers = {
      'Content-Type': file.mime,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy':
        "default-src 'none'; script-src piarc-document://markdown-diagram; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; worker-src 'none'; frame-src 'none'; form-action 'none'; object-src 'none'; base-uri 'none'; sandbox allow-scripts",
    };
    return new Response(req.method === 'HEAD' ? null : new Uint8Array(await readFile(file.path)), {
      headers,
    });
  };
}
