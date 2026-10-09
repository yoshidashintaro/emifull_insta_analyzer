// 依存ゼロの静的ファイルサーバー。`npm start` で http://localhost:5173 を開く。
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PUBLIC_DIR = join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 5173;

// URL パス → 実ファイルの対応。/vendor は node_modules から Chart.js を配信する。
const MOUNTS = [
  ['/vendor/chart.umd.min.js', join(ROOT, 'node_modules/chart.js/dist/chart.umd.min.js')],
  ['/samples/', join(ROOT, 'samples')],
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

function resolvePath(urlPath) {
  for (const [prefix, target] of MOUNTS) {
    if (prefix.endsWith('/') ? urlPath.startsWith(prefix) : urlPath === prefix) {
      if (!prefix.endsWith('/')) return target;
      const rel = normalize(urlPath.slice(prefix.length));
      const full = join(target, rel);
      return full.startsWith(target) ? full : null;
    }
  }
  const rel = normalize(urlPath === '/' ? '/index.html' : urlPath);
  const full = join(PUBLIC_DIR, rel);
  // ディレクトリトラバーサル防止
  return full.startsWith(PUBLIC_DIR) ? full : null;
}

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = resolvePath(urlPath);
    if (!file || !(await stat(file)).isFile()) throw new Error('not found');
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
});

server.listen(PORT, () => {
  console.log(`Instagram インサイト分析: http://localhost:${PORT}`);
});
