'use strict';
// Минимальная раздача статики: ETag/304, gzip для текста, защита от выхода за пределы корня.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.webm': 'audio/webm',
};
const COMPRESS = new Set(['.html', '.js', '.css', '.json', '.svg', '.txt']);
const MAX_CACHED = 2 * 1024 * 1024;

function createStatic(root) {
  root = path.resolve(root);
  const cache = new Map(); // file -> { etag, buf, gz }

  // serve(req, res, pathname, next): вызывает next(), если файла нет
  return function serve(req, res, pathname, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { return next(); }
    if (rel.includes('\0') || rel.split('/').some((s) => s.startsWith('.'))) return next();
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.join(root, path.normalize(rel));
    if (!file.startsWith(root + path.sep)) return next();
    const ext = path.extname(file).toLowerCase();
    const type = TYPES[ext];
    if (!type) return next();

    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return next();
      const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
      const isAudio = type.startsWith('audio/');
      const headers = {
        'Content-Type': type,
        ETag: etag,
        'Cache-Control': isAudio ? 'public, max-age=3600' : 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        Vary: 'Accept-Encoding',
      };
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers);
        return res.end();
      }
      const wantGzip = COMPRESS.has(ext) && /\bgzip\b/.test(req.headers['accept-encoding'] || '');

      const finish = (buf, gz) => {
        let body = buf;
        if (wantGzip && gz) { body = gz; headers['Content-Encoding'] = 'gzip'; }
        headers['Content-Length'] = body.length;
        res.writeHead(200, headers);
        res.end(req.method === 'HEAD' ? undefined : body);
      };

      const hit = cache.get(file);
      if (hit && hit.etag === etag) return finish(hit.buf, hit.gz);

      if (st.size > MAX_CACHED) {
        headers['Content-Length'] = st.size;
        res.writeHead(200, headers);
        if (req.method === 'HEAD') return res.end();
        return fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
      }
      fs.readFile(file, (e, buf) => {
        if (e) return next();
        const gz = COMPRESS.has(ext) ? zlib.gzipSync(buf) : null;
        cache.set(file, { etag, buf, gz });
        finish(buf, gz);
      });
    });
  };
}

module.exports = { createStatic };
