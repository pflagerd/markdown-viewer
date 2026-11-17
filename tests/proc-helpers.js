// Process-level helpers for server.spec.js and launcher.spec.js: starting
// server.js and the launcher with private state, raw HTTP, and cleaning up.
//
// Isolation rules these helpers implement:
//   - every test gets a fresh temp dir (sandbox()) whose run/ subdirectory is
//     passed as XDG_RUNTIME_DIR, so pid/devtools files never touch real state;
//   - every test claims a port of its own from 8160-8199 through a lock file
//     in the temp dir (claimPort()), so parallel workers and even two test
//     runs at the same time never share one; a test must leave its port free
//     again (sandbox.cleanup() waits for that, then releases the claim);
//   - cleanup kills only processes whose environment carries this test's
//     XDG_RUNTIME_DIR, so nothing that belongs to someone else is touched.

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'server.js');
const LAUNCHER = path.join(ROOT, 'markdown-viewer');
const APP_DIR = path.join(ROOT, 'app');

const FIRST_PORT = 8160;
const PORTS = 40;   // 8160-8199

/**
 * Claims a free port: { port, release() }. The claim is a lock file created
 * exclusively; a lock whose owner process is gone is taken over.
 */
function claimPort() {
  for (let port = FIRST_PORT; port < FIRST_PORT + PORTS; port++) {
    const lock = path.join(os.tmpdir(), `markdown-viewer-test-port-${port}.lock`);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.writeFileSync(lock, `${process.pid}\n`, { flag: 'wx' });
        return { port, release: () => fs.rmSync(lock, { force: true }) };
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        let owner = 0;
        try { owner = Number(fs.readFileSync(lock, 'utf8')); } catch (err2) { /* just released */ }
        if (owner && alive(owner)) break;      // really in use: next port
        fs.rmSync(lock, { force: true });      // stale: try once more
      }
    }
  }
  throw new Error(`no free test port in ${FIRST_PORT}-${FIRST_PORT + PORTS - 1}`);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `fn` until it returns something truthy; throws after `timeout` ms. */
async function waitFor(fn, what, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(25);
  }
}

/** True if something accepts TCP connections on host:port. */
function listening(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    socket.setTimeout(1000);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(false));
  });
}

/** State of a process that need not be our child: false for gone or zombie. */
function alive(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2)[0] !== 'Z';
  } catch (err) {
    return false;
  }
}

function cmdline(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
  } catch (err) {
    return [];
  }
}

/** Pids of live processes started with XDG_RUNTIME_DIR=<runDir>. */
function pidsWithRunDir(runDir) {
  const needle = `XDG_RUNTIME_DIR=${runDir}`;
  const pids = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      const env = fs.readFileSync(`/proc/${name}/environ`, 'utf8').split('\0');
      if (env.includes(needle) && alive(name)) pids.push(Number(name));
    } catch (err) { /* gone, or not ours to read */ }
  }
  return pids;
}

/**
 * A private world for one test: temp dir with run/ (state), home/, data/.
 * cleanup() kills whatever was started with this run dir, waits until the
 * port is free again and removes the temp dir.
 */
function sandbox() {
  const claim = claimPort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'markdown-viewer-proc-'));
  const box = {
    dir,
    port: claim.port,
    run: path.join(dir, 'run'),
    home: path.join(dir, 'home'),
    data: path.join(dir, 'data'),
    children: [],
  };
  for (const d of [box.run, box.home, box.data]) fs.mkdirSync(d);
  box.pidFile = path.join(box.run, `markdown-viewer-${box.port}.pid`);
  box.devtoolsFile = path.join(box.run, `markdown-viewer-${box.port}.devtools`);
  box.origin = `http://localhost:${box.port}`;
  box.cleanup = async () => {
    for (const child of box.children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    for (const pid of pidsWithRunDir(box.run)) {
      try { process.kill(pid, 'SIGKILL'); } catch (err) { /* already gone */ }
    }
    await waitFor(async () => !(await listening(box.port)), `port ${box.port} to be free`);
    fs.rmSync(dir, { recursive: true, force: true });
    claim.release();
  };
  return box;
}

/** Environment without any inherited MARKDOWN_VIEWER_* / XDG_* settings. */
function cleanEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(MARKDOWN_VIEWER_|XDG_)/.test(key)) env[key] = value;
  }
  return { ...env, ...extra };
}

/**
 * Starts `node server.js <args>` as a child. Resolves once it either printed
 * its "serving" line or exited; look at `.exitCode` / await `.exited`.
 *   exited: Promise<{ code, signal, at }>  (from the child's 'exit' event)
 */
async function startServer(box, args = ['--port', String(box.port)], env = {}, script = SERVER) {
  const child = spawn(process.execPath, [script, ...args], {
    env: cleanEnv({ XDG_RUNTIME_DIR: box.run, ...env }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  box.children.push(child);
  const proc = { child, pid: child.pid, stdout: '', stderr: '', startedAt: Date.now() };
  let ready;
  const serving = new Promise((resolve) => { ready = resolve; });
  child.stdout.on('data', (chunk) => {
    proc.stdout += chunk;
    if (/^Markdown Viewer serving .*\n/m.test(proc.stdout)) ready();
  });
  child.stderr.on('data', (chunk) => { proc.stderr += chunk; });
  proc.exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal, at: Date.now() }));
  });
  // 'close' comes after 'exit' and after all output has been read.
  proc.closed = new Promise((resolve) => child.once('close', resolve));
  proc.running = () => child.exitCode === null && child.signalCode === null;
  await Promise.race([serving, proc.closed]);
  return proc;
}

/**
 * One HTTP exchange over a raw socket, so the request line and headers go out
 * exactly as given. `target` is the request target verbatim.
 *   options: method ('GET'), host (Host header value; null = send none),
 *            version ('1.1'), headers (extra header lines)
 * Resolves { status, headers, body, raw } where body is a latin1 string.
 */
function raw(port, target, options = {}) {
  const { method = 'GET', version = '1.1', headers = [] } = options;
  const host = options.host === undefined ? `localhost:${port}` : options.host;
  const lines = [`${method} ${target} HTTP/${version}`];
  if (host !== null) lines.push(`Host: ${host}`);
  lines.push('Connection: close', ...headers, '', '');
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port, host: options.address || '127.0.0.1' });
    const chunks = [];
    socket.setTimeout(10_000, () => socket.destroy(new Error(`no complete response to ${method} ${target}`)));
    socket.on('connect', () => socket.write(Buffer.from(lines.join('\r\n'), 'latin1')));
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('end', () => {
      socket.destroy();
      const text = Buffer.concat(chunks).toString('latin1');
      const split = text.indexOf('\r\n\r\n');
      const headLines = text.slice(0, split < 0 ? text.length : split).split('\r\n');
      const parsed = {};
      for (const line of headLines.slice(1)) {
        const colon = line.indexOf(':');
        parsed[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
      }
      resolve({
        status: Number((headLines[0] || '').split(' ')[1]),
        headers: parsed,
        body: split < 0 ? '' : text.slice(split + 4),
        raw: text,
      });
    });
  });
}

/**
 * Opens GET /api/events and resolves once the response head and the first
 * bytes have arrived: { status, headers, firstChunk, close(), closed }.
 */
function openStream(port, host = `localhost:${port}`) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/events', headers: { Host: host }, agent: false,
    });
    req.on('error', reject);
    req.on('response', (res) => {
      let ended = false;
      const closed = new Promise((done) => res.once('close', () => { ended = true; done(); }));
      res.on('error', () => {});
      res.once('data', (chunk) => resolve({
        status: res.statusCode,
        headers: res.headers,
        firstChunk: String(chunk),
        isOpen: () => !ended,
        closed,
        close: () => { req.destroy(); return closed; },
      }));
    });
    req.end();
  });
}

/**
 * Chromium's web app id for a manifest id: SHA-256 twice, first 16 bytes,
 * each hex digit 0-f written as a letter a-p. Written independently of the
 * launcher's implementation on purpose.
 */
function appId(manifestId) {
  const once = crypto.createHash('sha256').update(manifestId, 'utf8').digest();
  const twice = crypto.createHash('sha256').update(once).digest();
  let id = '';
  for (const byte of twice.subarray(0, 16)) {
    id += String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 15));
  }
  return id;
}

module.exports = {
  ROOT, SERVER, LAUNCHER, APP_DIR,
  delay, waitFor, listening, alive, cmdline, sandbox, cleanEnv, startServer, raw, openStream, appId,
};
