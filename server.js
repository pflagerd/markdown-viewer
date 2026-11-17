#!/usr/bin/env node
'use strict';

// Local server for Markdown Viewer: serves the static app in app/ on the
// loopback interface, and exits by itself once no app window is attached.
//
//   node server.js [--port N] [--headless]
//
// Environment:
//   MARKDOWN_VIEWER_PORT          default port (8137)
//   MARKDOWN_VIEWER_IDLE_SECONDS  seconds without an attached window before
//                                 exiting (30); ignored with --headless

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const APP_DIR = path.join(__dirname, 'app');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.md': 'text/markdown; charset=utf-8',
};

function usage(message) {
  console.error(`server.js: ${message}\nusage: node server.js [--port N] [--headless]`);
  process.exit(2);
}

function parsePort(text) {
  const port = Number(text);
  if (!/^\d+$/.test(String(text)) || port < 1 || port > 65535) usage(`invalid port: ${text}`);
  return port;
}

let port = parsePort(process.env.MARKDOWN_VIEWER_PORT || '8137');
let headless = false;
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--headless') headless = true;
  else if (arg === '--port' && i + 1 < process.argv.length) port = parsePort(process.argv[++i]);
  else if (arg.startsWith('--port=')) port = parsePort(arg.slice(7));
  else usage(`unknown argument: ${arg}`);
}

const idleSeconds = Number(process.env.MARKDOWN_VIEWER_IDLE_SECONDS || '30');
if (!(idleSeconds > 0)) usage('MARKDOWN_VIEWER_IDLE_SECONDS must be a positive number');

// The launcher shares these files with us, so both must derive the same names.
const STATE_DIR = process.env.XDG_RUNTIME_DIR || os.tmpdir();
const PID_FILE = path.join(STATE_DIR, `markdown-viewer-${port}.pid`);
const DEVTOOLS_FILE = path.join(STATE_DIR, `markdown-viewer-${port}.devtools`);

// A page on another origin can point its own host name at 127.0.0.1 (DNS
// rebinding) and then read our responses; such requests carry its host name.
const HOSTS = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);

// ---- idle exit -------------------------------------------------------------

// Every app window holds (through one SharedWorker) an /api/events stream, so
// "no stream for a while" means "no window is open any more".
let streams = 0;
let idleTimer = null;

function armIdleTimer() {
  if (headless || streams > 0 || idleTimer) return;
  idleTimer = setTimeout(() => process.exit(0), idleSeconds * 1000);
}

function disarmIdleTimer() {
  clearTimeout(idleTimer);
  idleTimer = null;
}

// ---- request handling ------------------------------------------------------

function send(res, status, type, body, head) {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(head ? undefined : body);
}

function sendStatus(res, status, head) {
  send(res, status, 'text/plain; charset=utf-8', `${status} ${http.STATUS_CODES[status]}\n`, head);
}

function events(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  // Something must be written for the browser to consider the stream open.
  res.write('retry: 2000\n: connected\n\n');
  // Comment lines keep the connection from looking dead to either end.
  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15000);
  streams++;
  disarmIdleTimer();
  res.on('close', () => {
    clearInterval(keepAlive);
    streams--;
    armIdleTimer();
  });
}

function serveFile(pathname, res, head) {
  // path.join normalizes ".." segments; whatever is left must still be inside
  // app/. Prefixing with APP_DIR also makes "//etc/passwd" relative to it.
  const file = path.join(APP_DIR, pathname.endsWith('/') ? `${pathname}index.html` : pathname);
  if (pathname.includes('\0') || !file.startsWith(APP_DIR + path.sep)) return sendStatus(res, 403, head);

  // Resolve symlinks before checking again, so a link inside app/ cannot
  // point the server at a file outside it.
  fs.realpath(file, (err, real) => {
    if (err) return sendStatus(res, 404, head);
    fs.realpath(APP_DIR, (err2, root) => {
      if (err2 || !real.startsWith(root + path.sep)) return sendStatus(res, 403, head);
      fs.stat(real, (err3, stat) => {
        if (err3 || !stat.isFile()) return sendStatus(res, 404, head);
        res.writeHead(200, {
          'Content-Type': TYPES[path.extname(real).toLowerCase()] || 'application/octet-stream',
          'Content-Length': stat.size,
          'Cache-Control': 'no-cache',
          'X-Content-Type-Options': 'nosniff',
        });
        if (head) return res.end();
        fs.createReadStream(real).on('error', () => res.destroy()).pipe(res);
      });
    });
  });
}

const server = http.createServer((req, res) => {
  const head = req.method === 'HEAD';
  if (!HOSTS.has(String(req.headers.host).toLowerCase())) return sendStatus(res, 403, head);
  if (req.method !== 'GET' && !head) {
    res.setHeader('Allow', 'GET, HEAD');
    return sendStatus(res, 405, head);
  }

  // Only origin-form targets ("/path?query"); decode once, and never again.
  let pathname;
  try {
    if (!req.url.startsWith('/')) throw new Error('not origin-form');
    pathname = decodeURIComponent(req.url.split(/[?#]/, 1)[0]);
  } catch (err) {
    return sendStatus(res, 400, head);
  }

  if (pathname === '/api/config') {
    const config = { devtools: fs.existsSync(DEVTOOLS_FILE) };
    return send(res, 200, TYPES['.json'], `${JSON.stringify(config)}\n`, head);
  }
  if (pathname === '/api/events') {
    // A HEAD request must not count as an attached window.
    if (head) return sendStatus(res, 405, head);
    return events(req, res);
  }
  if (pathname.startsWith('/api/')) return sendStatus(res, 404, head);
  serveFile(pathname, res, head);
});

// ---- lifecycle -------------------------------------------------------------

function removePidFile() {
  try {
    // Leave the file alone if another server instance has since claimed it.
    if (fs.readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) fs.unlinkSync(PID_FILE);
  } catch (err) { /* already gone */ }
}

server.on('error', (err) => {
  const why = err.code === 'EADDRINUSE' ? `port ${port} is already in use` : err.message;
  console.error(`server.js: cannot listen on 127.0.0.1:${port}: ${why}`);
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  fs.writeFileSync(PID_FILE, `${process.pid}\n`);
  process.on('exit', removePidFile);
  // Exiting through process.exit() is what runs the 'exit' handler above.
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => process.exit(0));
  console.log(`Markdown Viewer serving http://localhost:${port}/`);
  armIdleTimer();
});
