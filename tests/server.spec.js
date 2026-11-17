// server.js as a process: static serving, request validation, /api, idle
// exit, pid file, argument handling.
//
// Every test starts its own server on the worker's own port (8160-8199) with
// a private state directory (XDG_RUNTIME_DIR), see proc-helpers.js. Tests
// tagged @negative check that something that must not happen does not happen.

const { test, expect } = require('./helpers');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const {
  ROOT, SERVER, LAUNCHER, APP_DIR,
  delay, waitFor, listening, sandbox, startServer, raw, openStream,
} = require('./proc-helpers');

const NEG = { tag: '@negative' };

let box;
test.beforeEach(() => { box = sandbox(); });
test.afterEach(async () => { await box.cleanup(); });

const appFile = (name) => fs.readFileSync(path.join(APP_DIR, name));

/** First file under app/ with this extension, as a URL path. */
function findAppFile(ext, dir = APP_DIR) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findAppFile(ext, full);
      if (found) return found;
    } else if (entry.name.endsWith(ext)) {
      return `/${path.relative(APP_DIR, full).split(path.sep).join('/')}`;
    }
  }
  return null;
}

// Pieces of files outside app/ that no response may ever contain.
const OUTSIDE = [
  ['server.js', fs.readFileSync(SERVER, 'latin1').slice(20, 220)],
  ['package.json', fs.readFileSync(path.join(ROOT, 'package.json'), 'latin1').slice(0, 80)],
  ['the launcher', fs.readFileSync(LAUNCHER, 'latin1').slice(20, 220)],
  ['playwright.config.js', fs.readFileSync(path.join(ROOT, 'playwright.config.js'), 'latin1').slice(0, 80)],
  ['/etc/passwd', fs.readFileSync('/etc/passwd', 'latin1').split('\n')[0]],
];

function expectNoLeak(response, what) {
  for (const [name, piece] of OUTSIDE) {
    expect(response.raw.includes(piece), `${what} must not return ${name}`).toBe(false);
  }
}

/* ---------- start-up ---------- */

test.describe('start-up', () => {
  test('announces its URL and serves the app on --port N', async () => {
    const server = await startServer(box);
    expect(server.stdout).toBe(`Markdown Viewer serving http://localhost:${box.port}/\n`);
    expect(server.stderr).toBe('');
    const res = await raw(box.port, '/');
    expect(res.status).toBe(200);
    expect(res.body).toBe(appFile('index.html').toString('latin1'));
  });

  test('accepts --port=N', async () => {
    const server = await startServer(box, [`--port=${box.port}`]);
    expect(server.stdout).toContain(`http://localhost:${box.port}/`);
    expect((await raw(box.port, '/')).status).toBe(200);
  });

  test('takes the port from MARKDOWN_VIEWER_PORT when --port is absent', async () => {
    const server = await startServer(box, [], { MARKDOWN_VIEWER_PORT: String(box.port) });
    expect(server.stdout).toContain(`http://localhost:${box.port}/`);
    expect((await raw(box.port, '/')).status).toBe(200);
    expect(fs.existsSync(box.pidFile)).toBe(true);
  });

  test('--port wins over MARKDOWN_VIEWER_PORT', async () => {
    // The env port is one nothing may listen on because of this test.
    const server = await startServer(box, ['--port', String(box.port)], { MARKDOWN_VIEWER_PORT: '8159' });
    expect(server.stdout).toBe(`Markdown Viewer serving http://localhost:${box.port}/\n`);
    expect(fs.existsSync(path.join(box.run, 'markdown-viewer-8159.pid'))).toBe(false);
  });

  test('writes its pid to the pid file once listening', async () => {
    const server = await startServer(box);
    expect(fs.readFileSync(box.pidFile, 'utf8').trim()).toBe(String(server.pid));
    expect(fs.readdirSync(box.run)).toEqual([`markdown-viewer-${box.port}.pid`]);
  });

  for (const [name, args, env] of [
    ['an unknown option', ['--bogus'], {}],
    ['a stray word', ['serve'], {}],
    ['--port without a value', ['--port'], {}],
    ['a non-numeric port', ['--port', 'abc'], {}],
    ['port 0', ['--port=0'], {}],
    ['a port above 65535', ['--port', '70000'], {}],
    ['a negative port', ['--port', '-1'], {}],
    ['an empty --port=', ['--port='], {}],
    ['a non-numeric MARKDOWN_VIEWER_PORT', [], { MARKDOWN_VIEWER_PORT: '81x' }],
    ['a valid port followed by a bad argument', ['--port', '@PORT@', '--nope'], {}],
  ]) {
    test(`exits with code 2 and serves nothing for ${name}`, NEG, async () => {
      const server = await startServer(box, args.map((a) => a.replace('@PORT@', box.port)), env);
      const { code, signal } = await server.exited;
      expect({ code, signal }).toEqual({ code: 2, signal: null });
      expect(server.stdout).toBe('');
      expect(server.stderr).toMatch(/usage: node server\.js/);
      expect(fs.readdirSync(box.run)).toEqual([]);
      expect(await listening(box.port)).toBe(false);
    });
  }

  test('a second server on the same port fails and leaves the first one alone', NEG, async () => {
    const first = await startServer(box);
    const second = await startServer(box);
    const { code, signal } = await second.exited;
    expect(signal).toBeNull();
    expect(code).not.toBe(0);
    expect(code).not.toBeNull();
    expect(second.stdout).toBe('');
    expect(second.stderr).toMatch(new RegExp(`port ${box.port} is already in use`));
    // The first server keeps its pid file and keeps serving.
    expect(fs.readFileSync(box.pidFile, 'utf8').trim()).toBe(String(first.pid));
    expect(first.running()).toBe(true);
    expect((await raw(box.port, '/')).status).toBe(200);
  });

  test('is not reachable on a non-loopback address', NEG, async () => {
    const external = Object.values(os.networkInterfaces()).flat()
      .filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);
    test.skip(external.length === 0, 'this machine has no non-loopback IPv4 address');
    await startServer(box);
    expect(await listening(box.port, '127.0.0.1')).toBe(true);
    for (const address of external) {
      expect(await listening(box.port, address), `connect to ${address}:${box.port}`).toBe(false);
    }
  });

  test('is not reachable on the IPv6 loopback address', NEG, async () => {
    await startServer(box);
    expect(await listening(box.port, '::1')).toBe(false);
  });
});

/* ---------- static files ---------- */

test.describe('static files', () => {
  test.beforeEach(async () => { await startServer(box); });

  test('serves / and /index.html identically', async () => {
    const root = await raw(box.port, '/');
    const index = await raw(box.port, '/index.html');
    expect(root.status).toBe(200);
    expect(index.status).toBe(200);
    expect(root.body).toBe(index.body);
    expect(root.headers['content-type']).toMatch(/^text\/html\b/);
    expect(Number(root.headers['content-length'])).toBe(appFile('index.html').length);
  });

  for (const [ext, type] of [
    ['.html', /^text\/html; charset=utf-8$/],
    ['.css', /^text\/css; charset=utf-8$/],
    ['.js', /^text\/javascript; charset=utf-8$/],
    ['.webmanifest', /^application\/manifest\+json\b/],
    ['.svg', /^image\/svg\+xml$/],
    ['.png', /^image\/png$/],
    ['.woff2', /^font\/woff2$/],
  ]) {
    test(`serves ${ext} files byte for byte with the right content type`, async () => {
      const url = findAppFile(ext);
      expect(url, `an ${ext} file in app/`).not.toBeNull();
      const res = await raw(box.port, url);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(type);
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(Buffer.from(res.body, 'latin1').equals(appFile(url.slice(1)))).toBe(true);
    });
  }

  test('serves files in nested directories and ignores the query string', async () => {
    const url = findAppFile('.woff2');
    expect(url.split('/').length).toBeGreaterThan(3);
    const plain = await raw(box.port, '/style.css');
    const query = await raw(box.port, '/style.css?v=1&x=../../server.js');
    expect(query.status).toBe(200);
    expect(query.body).toBe(plain.body);
  });

  test('decodes percent-escapes in the path once', async () => {
    const res = await raw(box.port, '/%69ndex.html');
    expect(res.status).toBe(200);
    expect(res.body).toBe(appFile('index.html').toString('latin1'));
    // Decoded twice, this would be /index.html.
    expect((await raw(box.port, '/%2569ndex.html')).status).toBe(404);
  });

  test('HEAD returns the headers of GET without a body', async () => {
    for (const url of ['/', '/app.js', findAppFile('.png')]) {
      const get = await raw(box.port, url);
      const head = await raw(box.port, url, { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(head.body).toBe('');
      expect(head.headers['content-length']).toBe(get.headers['content-length']);
      expect(head.headers['content-type']).toBe(get.headers['content-type']);
      expect(head.headers['cache-control']).toBe('no-cache');
      expect(head.headers['x-content-type-options']).toBe('nosniff');
    }
  });

  test('answers on Host 127.0.0.1:<port> as well as localhost:<port>', async () => {
    const res = await raw(box.port, '/', { host: `127.0.0.1:${box.port}` });
    expect(res.status).toBe(200);
    expect(res.body).toBe(appFile('index.html').toString('latin1'));
  });

  test('keeps serving after a burst of parallel requests', async () => {
    const urls = ['/', '/app.js', '/style.css', '/missing', '/../server.js', '/api/config'];
    const all = await Promise.all(Array.from({ length: 60 }, (_, i) => raw(box.port, urls[i % urls.length])));
    expect(all.map((r) => r.status)).toEqual(Array.from({ length: 60 }, (_, i) => [200, 200, 200, 404, 403, 200][i % 6]));
  });

  for (const url of ['/missing.html', '/index.htm', '/index.html/', '/index.html/x', '/INDEX.HTML',
    '/app.js.map', '/server.js', '/package.json', '/markdown-viewer', '/tests/helpers.js',
    '/.git/HEAD', '/.gitignore', '/app/index.html', '/api/', '/api/nothing', '/api/config/', '/api/events/x']) {
    test(`404 for ${url}`, NEG, async () => {
      const res = await raw(box.port, url);
      expect(res.status).toBe(404);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-type']).toMatch(/^text\/plain\b/);
      expectNoLeak(res, url);
      const head = await raw(box.port, url, { method: 'HEAD' });
      expect(head.status).toBe(404);
      expect(head.body).toBe('');
    });
  }

  test('404 for directories without an index, with and without trailing slash', NEG, async () => {
    for (const url of ['/vendor', '/vendor/', '/icons', '/icons/', '/vendor/katex/fonts/']) {
      const res = await raw(box.port, url);
      expect(res.status, url).toBe(404);
      // No directory listing either.
      expect(res.body).not.toMatch(/woff2|icon-192|katex/);
    }
  });

  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH']) {
    test(`405 with an Allow header for ${method}`, NEG, async () => {
      for (const url of ['/', '/index.html', '/api/config', '/api/events', '/missing']) {
        const res = await raw(box.port, url, { method, headers: ['Content-Length: 0'] });
        expect(res.status, `${method} ${url}`).toBe(405);
        expect(res.headers.allow).toBe('GET, HEAD');
        expect(res.body).not.toContain('<html');
        expect(res.body).not.toContain('devtools');
      }
    });
  }

  test('a POST body is not stored or echoed', NEG, async () => {
    const res = await raw(box.port, '/planted.html', {
      method: 'POST', headers: ['Content-Type: text/html', 'Content-Length: 12'],
    });
    expect(res.status).toBe(405);
    expect(fs.existsSync(path.join(APP_DIR, 'planted.html'))).toBe(false);
    expect((await raw(box.port, '/planted.html')).status).toBe(404);
  });
});

/* ---------- Host header ---------- */

test.describe('Host header (DNS rebinding protection)', () => {
  test.beforeEach(async () => { await startServer(box); });

  const P = '@PORT@';
  for (const host of ['localhost', '127.0.0.1', `localhost:1${P}`, 'localhost:80', `127.0.0.1:1${P}`,
    `evil.example:${P}`, 'evil.example', `[::1]:${P}`, `0.0.0.0:${P}`, `localhost.evil.example:${P}`,
    `xlocalhost:${P}`, `localhost:${P}.evil.example`, `localhost:${P}:${P}`, `user@localhost:${P}`,
    `localhost:${P}/`, `127.0.0.2:${P}`, `127.1:${P}`, `localhost.:${P}`, `:${P}`, '']) {
    test(`403 for Host "${host}"`, NEG, async () => {
      const value = host.replaceAll(P, String(box.port));
      for (const url of ['/', '/index.html', '/api/config', '/api/events', '/missing']) {
        const res = await raw(box.port, url, { host: value });
        expect(res.status, url).toBe(403);
        expect(res.body).toBe('403 Forbidden\n');
        expect(res.headers['content-type']).not.toMatch(/event-stream|html|json/);
      }
      expect((await raw(box.port, '/', { host: value, method: 'HEAD' })).status).toBe(403);
    });
  }

  test('403 without a Host header (HTTP/1.0)', NEG, async () => {
    const res = await raw(box.port, '/', { host: null, version: '1.0' });
    expect(res.status).toBe(403);
    expect(res.body).not.toContain('<html');
  });

  test('refuses an HTTP/1.1 request without a Host header', NEG, async () => {
    // Node's HTTP parser may answer this itself with 400 before the handler runs.
    const res = await raw(box.port, '/', { host: null });
    expect([400, 403]).toContain(res.status);
    expect(res.raw).not.toContain('<html');
  });

  test('a good Host header after a bad one does not help', NEG, async () => {
    const res = await raw(box.port, '/', { host: 'evil.example', headers: [`Host: localhost:${box.port}`] });
    expect([400, 403]).toContain(res.status);
    expect(res.raw).not.toContain('<html');
  });

  test('X-Forwarded-Host and an absolute-form target do not override Host', NEG, async () => {
    const forwarded = await raw(box.port, '/', {
      host: 'evil.example', headers: [`X-Forwarded-Host: localhost:${box.port}`],
    });
    expect(forwarded.status).toBe(403);
    const absolute = await raw(box.port, `http://localhost:${box.port}/`, { host: 'evil.example' });
    expect([400, 403]).toContain(absolute.status);
    expect(absolute.raw).not.toContain('<html');
  });
});

/* ---------- nothing outside app/ ---------- */

test.describe('confinement to app/', () => {
  test.beforeEach(async () => { await startServer(box); });

  // [request target, allowed statuses]
  const TRAVERSALS = [
    ['/../server.js', [403]],
    ['/../package.json', [403]],
    ['/../markdown-viewer', [403]],
    ['/..', [403]],
    ['/../', [403]],
    ['/../app/../server.js', [403]],
    ['/vendor/../../server.js', [403]],
    ['/vendor/katex/fonts/../../../../server.js', [403]],
    ['/./../server.js', [403]],
    ['/x/y/z/../../../../server.js', [403]],
    ['/%2e%2e/server.js', [403]],
    ['/%2E%2E/server.js', [403]],
    ['/.%2e/server.js', [403]],
    ['/%2e./server.js', [403]],
    ['/..%2fserver.js', [403]],
    ['/..%2Fserver.js', [403]],
    ['/%2e%2e%2fserver.js', [403]],
    ['/%2e%2e%2f%2e%2e%2f%2e%2e%2f%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd', [403]],
    ['/../../../../../../../../../../etc/passwd', [403]],
    ['/vendor/%2e%2e/%2e%2e/package.json', [403]],
    ['/index.html/../../server.js', [403]],
    // Not traversal for this server, but must still stay inside app/.
    ['//etc/passwd', [404]],
    ['/%2fetc/passwd', [404]],
    ['///etc/passwd', [404]],
    ['//server.js', [404]],
    ['/etc/passwd', [404]],
    ['/..%5cserver.js', [403, 404]],
    ['/..\\server.js', [403, 404]],
    ['/..%5c..%5cetc%5cpasswd', [403, 404]],
    ['/....//server.js', [404]],
    ['/..../server.js', [404]],
    ['/.../server.js', [404]],
    ['/..;/server.js', [404]],
    ['/%252e%252e/server.js', [404]],
    ['/..%252fserver.js', [404]],
    ['/%25%32%65%25%32%65/server.js', [404]],
    ['/file:///etc/passwd', [404]],
    ['/~/server.js', [404]],
    ['/~root/.bashrc', [404]],
    ['/proc/self/environ', [404]],
    // NUL bytes.
    ['/%00', [403]],
    ['/index.html%00', [403]],
    ['/index.html%00.png', [403]],
    ['/%00/../server.js', [403]],
    ['/../server.js%00.html', [403]],
    ['/..%00/server.js', [403]],
    // Escapes that do not decode.
    ['/%', [400]],
    ['/%zz', [400]],
    ['/a%2', [400]],
    ['/%c0%ae%c0%ae/server.js', [400]],
    ['/%c0%ae%c0%ae%c0%afserver.js', [400]],
    ['/%ff/../server.js', [400]],
    ['/..%c0%afserver.js', [400]],
    ['/%u002e%u002e/server.js', [400]],
    ['/../server.js%', [400]],
    // Not origin-form.
    ['http://localhost:@PORT@/../server.js', [400]],
    ['http://localhost:@PORT@/index.html', [400]],
    ['file:///etc/passwd', [400]],
    ['*', [400]],
    ['server.js', [400]],
    ['../server.js', [400]],
    ['\\..\\server.js', [400]],
    ['?/../server.js', [400]],
  ];

  for (const [target, allowed] of TRAVERSALS) {
    test(`GET ${target} -> ${allowed.join(' or ')}, nothing leaked`, NEG, async () => {
      const requestTarget = target.replace('@PORT@', box.port);
      for (const method of ['GET', 'HEAD']) {
        const res = await raw(box.port, requestTarget, { method });
        expect(allowed, `${method} ${requestTarget} answered ${res.status}`).toContain(res.status);
        expectNoLeak(res, `${method} ${requestTarget}`);
        expect(res.raw).not.toContain('<html');
        if (res.headers['content-length'] !== undefined && method === 'GET') {
          // Only the short status text comes back, never a file.
          expect(Number(res.headers['content-length'])).toBeLessThan(40);
        }
      }
    });
  }

  test('traversal hidden in the query string or fragment serves only the named app file', NEG, async () => {
    const index = appFile('index.html').toString('latin1');
    for (const target of ['/?/../../server.js', '/index.html?../server.js', '/?file=/etc/passwd',
      '/#/../../server.js', '/index.html#%2e%2e/server.js', '/?%00', '/?%zz']) {
      const res = await raw(box.port, target);
      expect(res.status, target).toBe(200);
      expect(res.body).toBe(index);
      expectNoLeak(res, target);
    }
  });

  test('the files that must not leak are really there to be leaked', async () => {
    // Guards the leak check itself: each marker is non-trivial and the same
    // request shape does return content for a file inside app/.
    for (const [name, piece] of OUTSIDE) expect(piece.length, name).toBeGreaterThan(10);
    const res = await raw(box.port, '/vendor/../index.html');
    expect(res.status).toBe(200);
    expect(res.body).toBe(appFile('index.html').toString('latin1'));
  });
});

test.describe('confinement, with a private copy of server.js and its own app/', () => {
  // Symlinks and odd directories cannot be planted in the real app/ (other
  // tests are using it), so these run an unmodified copy of server.js next to
  // a made-up app directory.
  let secret;
  test.beforeEach(async () => {
    const root = path.join(box.dir, 'copy');
    const app = path.join(root, 'app');
    fs.mkdirSync(path.join(app, 'empty'), { recursive: true });
    fs.mkdirSync(path.join(app, 'sub'));
    fs.mkdirSync(path.join(root, 'app-private'));
    fs.copyFileSync(SERVER, path.join(root, 'server.js'));
    secret = `TOP-SECRET-${Math.random().toString(36).slice(2)}`;
    fs.writeFileSync(path.join(root, 'secret.txt'), secret);
    fs.writeFileSync(path.join(root, 'app-private', 'secret.txt'), secret);
    fs.writeFileSync(path.join(app, 'index.html'), '<!doctype html><title>root</title>');
    fs.writeFileSync(path.join(app, 'sub', 'index.html'), '<!doctype html><title>sub</title>');
    fs.writeFileSync(path.join(app, 'data.bin'), 'binary');
    fs.writeFileSync(path.join(app, 'UPPER.HTML'), '<!doctype html><title>upper</title>');
    fs.writeFileSync(path.join(app, 'with space.md'), '# spaced');
    fs.symlinkSync('../secret.txt', path.join(app, 'link.txt'));
    fs.symlinkSync(path.join(root, 'secret.txt'), path.join(app, 'abs-link.txt'));
    fs.symlinkSync('..', path.join(app, 'up'));
    fs.symlinkSync('/etc', path.join(app, 'etc'));
    fs.symlinkSync('sub/index.html', path.join(app, 'inside-link.html'));
    fs.symlinkSync('nowhere', path.join(app, 'dangling'));
    await startServer(box, ['--port', String(box.port)], {}, path.join(root, 'server.js'));
  });

  test('serves the copy\'s own app: subdirectory index, unknown and upper-case extensions, spaces', async () => {
    expect((await raw(box.port, '/')).body).toContain('<title>root</title>');
    const sub = await raw(box.port, '/sub/');
    expect(sub.status).toBe(200);
    expect(sub.body).toContain('<title>sub</title>');
    const bin = await raw(box.port, '/data.bin');
    expect(bin.status).toBe(200);
    expect(bin.headers['content-type']).toBe('application/octet-stream');
    expect((await raw(box.port, '/UPPER.HTML')).headers['content-type']).toMatch(/^text\/html\b/);
    const spaced = await raw(box.port, '/with%20space.md');
    expect(spaced.status).toBe(200);
    expect(spaced.body).toBe('# spaced');
  });

  test('follows a symlink that stays inside app/', async () => {
    const res = await raw(box.port, '/inside-link.html');
    expect(res.status).toBe(200);
    expect(res.body).toContain('<title>sub</title>');
  });

  test('does not follow symlinks that leave app/', NEG, async () => {
    for (const url of ['/link.txt', '/abs-link.txt', '/up/secret.txt', '/up/server.js', '/up/app-private/secret.txt',
      '/etc/passwd', '/etc/hostname', '/up/', '/up', '/etc/']) {
      for (const method of ['GET', 'HEAD']) {
        const res = await raw(box.port, url, { method });
        expect([403, 404], `${method} ${url} answered ${res.status}`).toContain(res.status);
        expect(res.raw).not.toContain(secret);
        expectNoLeak(res, url);
      }
    }
    expect((await raw(box.port, '/link.txt')).status).toBe(403);
    expect((await raw(box.port, '/etc/passwd')).status).toBe(403);
  });

  test('does not serve a sibling directory whose name starts with "app"', NEG, async () => {
    for (const url of ['/../app-private/secret.txt', '/..%2fapp-private%2fsecret.txt', '/%2e%2e/app-private/secret.txt']) {
      const res = await raw(box.port, url);
      expect(res.status, url).toBe(403);
      expect(res.raw).not.toContain(secret);
    }
  });

  test('404 for an empty directory, a directory without slash, and a dangling symlink', NEG, async () => {
    for (const url of ['/empty/', '/empty', '/sub', '/dangling', '/sub/index.html/']) {
      const res = await raw(box.port, url);
      expect(res.status, url).toBe(404);
      expect(res.body).toBe('404 Not Found\n');
    }
  });
});

/* ---------- /api ---------- */

test.describe('/api/config', () => {
  test.beforeEach(async () => { await startServer(box); });

  test('reports devtools:false without the state file', NEG, async () => {
    const res = await raw(box.port, '/api/config');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json\b/);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(JSON.parse(res.body)).toEqual({ devtools: false });
  });

  test('follows the state file at request time, in both directions', async () => {
    const get = async () => JSON.parse((await raw(box.port, '/api/config')).body);
    expect(await get()).toEqual({ devtools: false });
    fs.writeFileSync(box.devtoolsFile, '');
    expect(await get()).toEqual({ devtools: true });
    expect(await get()).toEqual({ devtools: true });
    fs.unlinkSync(box.devtoolsFile);
    expect(await get()).toEqual({ devtools: false });
    fs.writeFileSync(box.devtoolsFile, 'anything');
    expect(await get()).toEqual({ devtools: true });
  });

  test('ignores the state files of other ports and other names', NEG, async () => {
    fs.writeFileSync(path.join(box.run, `markdown-viewer-${box.port + 1000}.devtools`), '');
    fs.writeFileSync(path.join(box.run, 'markdown-viewer-8137.devtools'), '');
    fs.writeFileSync(path.join(box.run, 'markdown-viewer.devtools'), '');
    fs.writeFileSync(path.join(box.run, `markdown-viewer-${box.port}.devtools.bak`), '');
    expect(JSON.parse((await raw(box.port, '/api/config')).body)).toEqual({ devtools: false });
  });

  test('accepts a query string and HEAD', async () => {
    fs.writeFileSync(box.devtoolsFile, '');
    const res = await raw(box.port, '/api/config?t=123');
    expect(JSON.parse(res.body)).toEqual({ devtools: true });
    const head = await raw(box.port, '/api/config', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
    expect(head.headers['content-length']).toBe(res.headers['content-length']);
  });

  test('does not create, change or remove state files', NEG, async () => {
    await raw(box.port, '/api/config');
    expect(fs.readdirSync(box.run)).toEqual([`markdown-viewer-${box.port}.pid`]);
    fs.writeFileSync(box.devtoolsFile, 'keep');
    await raw(box.port, '/api/config');
    expect(fs.readFileSync(box.devtoolsFile, 'utf8')).toBe('keep');
  });
});

test.describe('/api/events', () => {
  test.beforeEach(async () => { await startServer(box); });

  test('is an event stream that stays open', async () => {
    const stream = await openStream(box.port);
    expect(stream.status).toBe(200);
    expect(stream.headers['content-type']).toBe('text/event-stream');
    expect(stream.headers['cache-control']).toBe('no-cache');
    expect(stream.headers['content-length']).toBeUndefined();
    // Valid SSE: only field lines / comments, terminated by a blank line.
    expect(stream.firstChunk).toMatch(/^((retry: \d+|:[^\n]*)\n)+\n$/);
    // Other requests are served while it is open, and it is still open after.
    for (let i = 0; i < 5; i++) expect((await raw(box.port, '/app.js')).status).toBe(200);
    expect(stream.isOpen()).toBe(true);
    await stream.close();
  });

  test('serves several streams at once', async () => {
    const streams = await Promise.all(Array.from({ length: 8 }, () => openStream(box.port)));
    expect(streams.map((s) => s.status)).toEqual(Array(8).fill(200));
    expect((await raw(box.port, '/api/config')).status).toBe(200);
    expect(streams.every((s) => s.isOpen())).toBe(true);
    await Promise.all(streams.map((s) => s.close()));
  });

  test('HEAD is 405 and opens no stream', NEG, async () => {
    const res = await raw(box.port, '/api/events', { method: 'HEAD' });
    expect(res.status).toBe(405);
    expect(res.headers['content-type']).not.toMatch(/event-stream/);
    expect(res.body).toBe('');
  });
});

/* ---------- lifecycle ---------- */

test.describe('pid file and signals', () => {
  for (const signal of ['SIGTERM', 'SIGINT']) {
    test(`${signal}: exits with code 0 and removes the pid file`, async () => {
      const server = await startServer(box);
      expect(fs.existsSync(box.pidFile)).toBe(true);
      server.child.kill(signal);
      expect(await server.exited).toMatchObject({ code: 0, signal: null });
      expect(fs.existsSync(box.pidFile)).toBe(false);
      expect(await listening(box.port)).toBe(false);
    });
  }

  test('SIGTERM ends the server even while an event stream is open', async () => {
    const server = await startServer(box);
    const stream = await openStream(box.port);
    server.child.kill('SIGTERM');
    expect(await server.exited).toMatchObject({ code: 0, signal: null });
    await stream.closed;
    expect(fs.existsSync(box.pidFile)).toBe(false);
  });

  test('exit leaves the devtools file and other state files alone', NEG, async () => {
    const server = await startServer(box);
    const other = path.join(box.run, 'markdown-viewer-8137.pid');
    fs.writeFileSync(box.devtoolsFile, '');
    fs.writeFileSync(other, '1\n');
    server.child.kill('SIGTERM');
    await server.exited;
    expect(fs.readdirSync(box.run).sort()).toEqual(['markdown-viewer-8137.pid', `markdown-viewer-${box.port}.devtools`]);
  });

  test('the port can be served again right after the server has gone', async () => {
    const first = await startServer(box);
    first.child.kill('SIGTERM');
    await first.exited;
    const second = await startServer(box);
    expect(second.running()).toBe(true);
    expect(fs.readFileSync(box.pidFile, 'utf8').trim()).toBe(String(second.pid));
    expect((await raw(box.port, '/')).status).toBe(200);
  });
});

test.describe('idle exit', () => {
  const IDLE = { MARKDOWN_VIEWER_IDLE_SECONDS: '1' };
  const args = () => ['--port', String(box.port)];
  // Generous: the timer is 1 s; a loaded machine may be late, never early.
  const SOON = 8_000;

  const exitWithin = (server, ms) => Promise.race([
    server.exited,
    delay(ms).then(() => { throw new Error(`server still running after ${ms} ms`); }),
  ]);

  test('exits with code 0 after the idle time when no window ever attached', async () => {
    const server = await startServer(box, args(), IDLE);
    expect(server.running()).toBe(true);
    const exit = await exitWithin(server, SOON);
    expect(exit).toMatchObject({ code: 0, signal: null });
    expect(exit.at - server.startedAt).toBeGreaterThanOrEqual(1000);
    expect(fs.existsSync(box.pidFile)).toBe(false);
    expect(await listening(box.port)).toBe(false);
  });

  test('accepts a fractional idle time', async () => {
    const server = await startServer(box, args(), { MARKDOWN_VIEWER_IDLE_SECONDS: '0.3' });
    expect(await exitWithin(server, SOON)).toMatchObject({ code: 0, signal: null });
  });

  for (const value of ['0', '-1', 'soon']) {
    test(`rejects MARKDOWN_VIEWER_IDLE_SECONDS=${value} with exit code 2`, NEG, async () => {
      const server = await startServer(box, args(), { MARKDOWN_VIEWER_IDLE_SECONDS: value });
      expect(await server.exited).toMatchObject({ code: 2, signal: null });
      expect(await listening(box.port)).toBe(false);
    });
  }

  test('ordinary requests do not postpone the exit', NEG, async () => {
    const server = await startServer(box, args(), { MARKDOWN_VIEWER_IDLE_SECONDS: '2' });
    // Keep asking until the server is gone; if requests re-armed the timer it
    // would never go.
    let asked = 0;
    const poll = (async () => {
      while (server.running()) {
        await Promise.all([
          raw(box.port, '/').catch(() => {}),
          raw(box.port, '/api/config').catch(() => {}),
        ]);
        asked++;
        await delay(100);
      }
    })();
    expect(await exitWithin(server, 10_000)).toMatchObject({ code: 0, signal: null });
    await poll;
    expect(asked).toBeGreaterThan(3);
  });

  test('requests that are not an open stream do not keep it alive', NEG, async () => {
    const server = await startServer(box, args(), IDLE);
    // None of these may count as an attached window.
    expect((await raw(box.port, '/api/events', { method: 'HEAD' })).status).toBe(405);
    expect((await raw(box.port, '/api/events', { method: 'POST', headers: ['Content-Length: 0'] })).status).toBe(405);
    expect((await raw(box.port, '/api/events', { host: 'evil.example' })).status).toBe(403);
    expect((await raw(box.port, '/api/events/', {})).status).toBe(404);
    // An idle keep-alive connection that asks for nothing.
    const idleSocket = net.connect({ port: box.port, host: '127.0.0.1' });
    idleSocket.on('error', () => {});
    try {
      expect(await exitWithin(server, SOON)).toMatchObject({ code: 0, signal: null });
    } finally {
      idleSocket.destroy();
    }
  });

  test('stays alive while a stream is open, exits the idle time after the last one closes', async () => {
    const server = await startServer(box, args(), IDLE);
    const a = await openStream(box.port);
    const b = await openStream(box.port);
    await delay(2500);                       // 2.5 idle periods with two streams
    expect(server.running()).toBe(true);
    await a.close();
    await delay(2500);                       // ... and with one of them closed
    expect(server.running()).toBe(true);
    expect(b.isOpen()).toBe(true);
    expect((await raw(box.port, '/')).status).toBe(200);
    expect(fs.existsSync(box.pidFile)).toBe(true);

    await b.close();
    const closedAt = Date.now();
    const exit = await exitWithin(server, SOON);
    expect(exit).toMatchObject({ code: 0, signal: null });
    // Not at once: a window that reloads gets the idle time to come back.
    expect(exit.at - closedAt).toBeGreaterThanOrEqual(900);
    expect(fs.existsSync(box.pidFile)).toBe(false);
  });

  test('a stream that reconnects within the idle time keeps the server alive', async () => {
    const server = await startServer(box, args(), { MARKDOWN_VIEWER_IDLE_SECONDS: '2' });
    // Five reconnects, each after a gap well below 2 s: about 3 s in total,
    // and never 2 s without a stream.
    let stream = await openStream(box.port);
    for (let i = 0; i < 5; i++) {
      await stream.close();
      await delay(600);
      expect(server.running(), `after gap ${i + 1}`).toBe(true);
      stream = await openStream(box.port);
    }
    expect(server.running()).toBe(true);
    await stream.close();
    expect(await exitWithin(server, 10_000)).toMatchObject({ code: 0, signal: null });
  });

  test('--headless never exits by itself', NEG, async () => {
    const server = await startServer(box, [...args(), '--headless'], IDLE);
    expect(server.stdout).toBe(`Markdown Viewer serving http://localhost:${box.port}/\n`);
    // A stream that comes and goes must not arm the timer either.
    await (await openStream(box.port)).close();
    await delay(3000);                       // three idle periods
    expect(server.running()).toBe(true);
    expect((await raw(box.port, '/')).status).toBe(200);
    expect(fs.readFileSync(box.pidFile, 'utf8').trim()).toBe(String(server.pid));
    server.child.kill('SIGTERM');
    expect(await server.exited).toMatchObject({ code: 0, signal: null });
    expect(fs.existsSync(box.pidFile)).toBe(false);
  });

  test('--headless before --port works the same', NEG, async () => {
    const server = await startServer(box, ['--headless', `--port=${box.port}`], { MARKDOWN_VIEWER_IDLE_SECONDS: '0.5' });
    await delay(2000);
    expect(server.running()).toBe(true);
  });

  test('an open app window keeps the server alive; closing it lets the server exit', async ({ page }) => {
    const server = await startServer(box, args(), IDLE);
    await page.goto(`${box.origin}/`);
    await page.waitForFunction(() => typeof openHandles === 'function');
    await delay(3500);                       // 3.5 idle periods with the page open
    expect(server.running()).toBe(true);
    expect((await raw(box.port, '/')).status).toBe(200);

    // A second window, then closing the first: still one window attached.
    const second = await page.context().newPage();
    await second.goto(`${box.origin}/`);
    await second.waitForFunction(() => typeof openHandles === 'function');
    await page.close();
    await delay(2500);
    expect(server.running()).toBe(true);

    await second.close();
    expect(await exitWithin(server, 15_000)).toMatchObject({ code: 0, signal: null });
    expect(fs.existsSync(box.pidFile)).toBe(false);
  });

  test('a page that only loads a static file (no app, no worker) does not keep it alive', NEG, async ({ page }) => {
    const server = await startServer(box, args(), IDLE);
    await page.goto(`${box.origin}/style.css`);
    expect(await exitWithin(server, SOON)).toMatchObject({ code: 0, signal: null });
  });
});

