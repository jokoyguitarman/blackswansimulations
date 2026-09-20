/**
 * Hardened static server for the demo capture.
 *
 * The Vite dev server is not survivable here: 26 browser contexts churning
 * connections for two and a half hours produced an unhandled ECONNRESET that
 * took the whole dev server down, which would have killed all 26 screens at
 * once. This serves the prebuilt SPA instead and refuses to die on socket
 * errors.
 *
 *   npx tsx demo-run/serve.ts [port]
 */

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.argv[2] ?? 3002);
const DIST = path.resolve('frontend', 'dist');
/** Photos for the staged shoot. Mounted here rather than copied into the SPA
 *  build so nothing fictional ever ships inside the product. */
const STAGED = path.resolve('demo-run', 'assets');

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error(`No build found at ${DIST}. Run: npm run build:frontend`);
  process.exit(1);
}

const app = express();

app.use('/staged', express.static(STAGED, { maxAge: '1h' }));

app.use(
  express.static(DIST, {
    // Hashed assets are immutable; index.html must never be cached or the
    // browsers could pin a stale bundle between runs.
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-store');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  }),
);

// SPA fallback: every client route resolves to the app shell.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/assets/') || req.path.startsWith('/staged/')) return next();
  res.sendFile(path.join(DIST, 'index.html'));
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[serve] frontend/dist on http://localhost:${PORT}`);
});

// A browser context closing mid-request resets the socket. Express does not
// treat that as fatal, but an unhandled 'error' on the raw socket does.
server.on('connection', (socket) => {
  socket.on('error', () => undefined);
});
server.on('clientError', (_err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

process.on('uncaughtException', (err) => {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ECONNRESET' || code === 'EPIPE') {
    console.warn(`[serve] ignored socket error: ${code}`);
    return;
  }
  console.error('[serve] uncaught exception', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[serve] unhandled rejection', reason);
});
