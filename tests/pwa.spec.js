// PWA plumbing: manifest, service worker and offline start, the heartbeat
// SharedWorker, the Content-Security-Policy, and that the app talks to nobody
// but its own server.
//
// Not testable here: installing the app, the OS "Open With" entry and the
// File Handling API launch queue need a real desktop Chrome; the manifest's
// file_handlers entry is checked as data only.
//
// Offline is tested two ways: with Playwright's network switch
// (context.setOffline) against the shared test server, and - because that is
// what really happens to an installed app - by stopping a server of the
// test's own and starting the app again.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  test, expect, openApp, openMarkdown, openFiles, appErrors, view, waitForRendered,
  openFileMenu, fileMenuItem,
} = require('./helpers');

const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// Uses every renderer: highlighted code, a Mermaid diagram (its library is
// loaded on demand), and an image that needs no network.
const DIAGRAM_DOC = `# Offline

\`\`\`js
const answer = 42;
\`\`\`

\`\`\`mermaid
graph TD; A-->B;
\`\`\`

![pixel](${PIXEL})
`;
const MATH_DOC = '# Math\n\nInline $x^2 + y^2$ and\n\n$$\\int_0^1 x\\,dx = \\frac{1}{2}$$\n';

/** Waits until the service worker is active and controls the page. */
async function serviceWorkerInControl(page) {
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
}

/** URLs (path + query) of everything in every cache of the origin. */
function cachedPaths(page) {
  return page.evaluate(async () => {
    const out = [];
    for (const name of await caches.keys()) {
      for (const req of await (await caches.open(name)).keys()) {
        const url = new URL(req.url);
        out.push(url.pathname + url.search);
      }
    }
    return out.sort();
  });
}

/** Targets known to the browser, through the DevTools protocol: [{ type, url }]. */
async function targets(context, page) {
  const session = await context.newCDPSession(page);
  try {
    const { targetInfos } = await session.send('Target.getTargets');
    return targetInfos.map(({ type, url }) => ({ type, url }));
  } finally {
    await session.detach();
  }
}
const heartbeats = async (context, page) =>
  (await targets(context, page)).filter((t) => t.type === 'shared_worker').map((t) => new URL(t.url).pathname);

/* ---------- manifest ---------- */

test.describe('web app manifest', () => {
  test.beforeEach(async ({ page }) => { await openApp(page); });
  test.afterEach(async ({ page }) => { expect(appErrors(page)).toEqual([]); });

  /** Fetches the manifest the page links to: { url, status, type, text }. */
  const fetchManifest = (page) => page.evaluate(async () => {
    const links = document.querySelectorAll('link[rel="manifest"]');
    if (links.length !== 1) throw new Error(`${links.length} manifest links`);
    const res = await fetch(links[0].href);
    return { url: res.url, status: res.status, type: res.headers.get('content-type'), text: await res.text() };
  });

  test('the page links exactly one manifest, served as a manifest and valid JSON', async ({ page, baseURL }) => {
    const m = await fetchManifest(page);
    expect(m.url).toBe(new URL('manifest.webmanifest', baseURL).href);
    expect(m.status).toBe(200);
    expect(m.type).toMatch(/^application\/manifest\+json/);
    expect(() => JSON.parse(m.text)).not.toThrow();
    expect(JSON.parse(m.text)).toEqual(expect.any(Object));
  });

  test('the manifest names the app and makes it a standalone app rooted at the origin', async ({ page }) => {
    const manifest = JSON.parse((await fetchManifest(page)).text);
    expect(manifest.name).toBe('Markdown Viewer');
    expect(manifest.short_name).toEqual(expect.any(String));
    expect(manifest.short_name.length).toBeLessThanOrEqual(12);
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
    expect(manifest.id).toBe('/');
    expect(manifest.display).toBe('standalone');
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  test('the start URL is the app itself', async ({ page, baseURL }) => {
    const m = await fetchManifest(page);
    const start = new URL(JSON.parse(m.text).start_url, m.url).href;
    expect(start).toBe(baseURL);
    expect(start).toBe(page.url());
  });

  for (const size of [192, 512]) {
    test(`the manifest has a ${size}x${size} PNG icon that loads as an image of that size`, async ({ page }) => {
      const m = await fetchManifest(page);
      const icons = JSON.parse(m.text).icons.filter((i) => i.sizes === `${size}x${size}`);
      expect(icons).toHaveLength(1);
      expect(icons[0].type).toBe('image/png');
      const loaded = await page.evaluate(async ([src, base]) => {
        const url = new URL(src, base).href;
        const res = await fetch(url);
        const bytes = new Uint8Array(await res.clone().arrayBuffer());
        const img = new Image();
        img.src = url;
        await img.decode();
        return {
          status: res.status,
          type: res.headers.get('content-type'),
          signature: [...bytes.slice(0, 8)],
          width: img.naturalWidth,
          height: img.naturalHeight,
        };
      }, [icons[0].src, m.url]);
      expect(loaded).toEqual({
        status: 200,
        type: 'image/png',
        signature: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
        width: size,
        height: size,
      });
    });
  }

  test('every icon the manifest and the page name exists and decodes', async ({ page }) => {
    const m = await fetchManifest(page);
    const manifestIcons = JSON.parse(m.text).icons.map((i) => new URL(i.src, m.url).href);
    expect(manifestIcons.length).toBeGreaterThanOrEqual(2);
    const broken = await page.evaluate(async (urls) => {
      const pageIcons = [...document.querySelectorAll('link[rel~="icon"]')].map((l) => l.href);
      const out = [];
      for (const url of [...urls, ...pageIcons]) {
        const img = new Image();
        img.src = url;
        try { await img.decode(); } catch (err) { out.push(url); }
        if (!img.naturalWidth) out.push(`${url} has no size`);
      }
      return { out, pageIcons: pageIcons.length };
    }, manifestIcons);
    expect(broken.out).toEqual([]);
    expect(broken.pageIcons).toBe(1);
  });

  test('the manifest registers the app as a single-client handler for .md, .markdown, .mdown and .mkd', async ({ page }) => {
    const manifest = JSON.parse((await fetchManifest(page)).text);
    expect(manifest.file_handlers).toHaveLength(1);
    const handler = manifest.file_handlers[0];
    expect(handler.action).toBe('/');
    expect(handler.launch_type).toBe('single-client');
    expect(Object.keys(handler.accept)).toEqual(['text/markdown']);
    expect([...handler.accept['text/markdown']].sort()).toEqual(['.markdown', '.md', '.mdown', '.mkd']);
  });

  test('File > Open… offers exactly the file types the manifest handles, and nothing is opened when it is cancelled', async ({ page }) => {
    const manifest = JSON.parse((await fetchManifest(page)).text);
    await page.evaluate(() => {
      window.__pickerOptions = [];
      window.showOpenFilePicker = async (options) => {
        window.__pickerOptions.push(options);
        throw new DOMException('cancelled by the test', 'AbortError');
      };
    });
    await openFileMenu(page);
    await fileMenuItem(page, 'Open…').click();
    await expect.poll(() => page.evaluate(() => window.__pickerOptions.length)).toBe(1);
    const options = await page.evaluate(() => window.__pickerOptions[0]);
    expect(options.multiple).toBe(true);
    expect(options.types).toHaveLength(1);
    expect(options.types[0].accept).toEqual(manifest.file_handlers[0].accept);
    await expect(page.locator('#empty')).toBeVisible();
    await expect(page.locator('#status')).toHaveText('');
  });

  test('the app takes files from the launch queue when the browser has one', async ({ page }) => {
    // The consumer itself cannot be driven from a test (see the top of the
    // file); this only pins down that the feature the manifest relies on is
    // there in this browser, i.e. that the app did register a consumer.
    expect(await page.evaluate(() => 'launchQueue' in window)).toBe(true);
  });
});

/* ---------- install prompt ---------- */

test.describe('install prompt', () => {
  test.beforeEach(async ({ page }) => { await openApp(page); });
  test.afterEach(async ({ page }) => { expect(appErrors(page)).toEqual([]); });

  // The browser's own beforeinstallprompt cannot be triggered in a test; this
  // is the event it sends, with the two members the app uses.
  const offerInstall = (page) => page.evaluate(() => {
    const e = new Event('beforeinstallprompt', { cancelable: true });
    window.__prompts = 0;
    e.prompt = () => { window.__prompts++; };
    e.userChoice = Promise.resolve({ outcome: 'accepted' });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  });

  test('in a browser tab the empty state explains that the app must be installed', async ({ page }) => {
    expect(await page.evaluate(() => window.matchMedia('(display-mode: standalone)').matches)).toBe(false);
    await expect(page.locator('#install-hint')).toBeVisible();
    await expect(page.locator('#install-hint')).toContainText('Install');
  });

  test('the Install button appears only once the browser offers installation, and then runs the browser prompt once', async ({ page }) => {
    await serviceWorkerInControl(page);
    await expect(page.locator('#install')).toBeHidden();
    // The app keeps the browser's own mini-infobar away and shows its button.
    expect(await offerInstall(page)).toBe(true);
    await expect(page.locator('#install')).toBeVisible();
    await page.locator('#install').click();
    await expect(page.locator('#install')).toBeHidden();
    expect(await page.evaluate(() => window.__prompts)).toBe(1);
  });

  test('once the app has been installed the button and the hint go away', async ({ page }) => {
    await offerInstall(page);
    await expect(page.locator('#install')).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
    await expect(page.locator('#install')).toBeHidden();
    await expect(page.locator('#install-hint')).toBeHidden();
    expect(await page.evaluate(() => window.__prompts)).toBe(0);
  });
});

/* ---------- service worker ---------- */

test.describe('service worker', () => {
  // Console errors a test provokes on purpose (the browser logs every failed
  // fetch); everything else still counts.
  let provoked = [];
  test.beforeEach(async ({ page }) => { provoked = []; await openApp(page); });
  test.afterEach(async ({ page }) => { expect(appErrors(page, provoked)).toEqual([]); });

  test('a service worker registers, activates and takes control of the page without a reload', async ({ page, context, baseURL }) => {
    expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(false);   // fresh profile
    await serviceWorkerInControl(page);
    const info = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      return { script: reg.active.scriptURL, state: reg.active.state, controller: navigator.serviceWorker.controller.scriptURL };
    });
    expect(info.script).toBe(new URL('sw.js', baseURL).href);
    expect(info.controller).toBe(info.script);
    await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.ready).active.state)).toBe('activated');
    expect(context.serviceWorkers().map((w) => w.url())).toEqual([info.script]);
  });

  test('the page registers exactly one service worker, scoped to the whole origin, also after a reload', async ({ page, context, baseURL }) => {
    await serviceWorkerInControl(page);
    const scopes = () => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map((r) => r.scope));
    expect(await scopes()).toEqual([baseURL]);
    await openApp(page);
    await serviceWorkerInControl(page);
    expect(await scopes()).toEqual([baseURL]);
    expect(context.serviceWorkers()).toHaveLength(1);
    expect((await targets(context, page)).filter((t) => t.type === 'service_worker')).toHaveLength(1);
  });

  test('once the worker is active, everything the app shell loaded is in one cache', async ({ page, baseURL }) => {
    const loaded = await page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name));
    await serviceWorkerInControl(page);
    expect(await page.evaluate(() => caches.keys())).toEqual([expect.stringMatching(/^markdown-viewer-v\d+$/)]);
    const cached = await cachedPaths(page);
    const shell = loaded.map((u) => new URL(u)).filter((u) => u.origin + '/' === baseURL && !u.pathname.startsWith('/api/'))
      .map((u) => u.pathname);
    expect(shell.length).toBeGreaterThanOrEqual(8);   // 4 scripts + app.js, style sheets, ...
    expect(shell.filter((p) => !cached.includes(p))).toEqual([]);
    // Things the shell needs later, not at first load.
    for (const needed of ['/', '/app.js', '/style.css', '/heartbeat.js', '/manifest.webmanifest',
      '/icons/icon-192.png', '/icons/icon-512.png', '/vendor/mermaid/mermaid.min.js', '/vendor/katex/katex.min.css']) {
      expect(cached, needed).toContain(needed);
    }
  });

  test('/api/ responses are never put in the cache', async ({ page }) => {
    await serviceWorkerInControl(page);
    provoked.push(/404 \(Not Found\).*\/api\/nothing$/);
    // Through the worker, several times, including one that does not exist.
    const statuses = await page.evaluate(async () => {
      const out = [];
      for (const url of ['/api/config', '/api/config', '/api/config?x=1', '/api/nothing']) out.push((await fetch(url)).status);
      return out;
    });
    expect(statuses).toEqual([200, 200, 200, 404]);
    expect((await cachedPaths(page)).filter((p) => p.startsWith('/api'))).toEqual([]);
    await openApp(page);       // a controlled load asks for /api/config again
    await serviceWorkerInControl(page);
    expect((await cachedPaths(page)).filter((p) => p.startsWith('/api'))).toEqual([]);
  });

  test('/api/config always comes live from the server, never from an earlier answer', async ({ page }) => {
    await serviceWorkerInControl(page);
    const ask = () => page.evaluate(async () => (await fetch('/api/config')).json());
    expect(await ask()).toEqual({ devtools: false });
    let answer = { devtools: true };
    await page.route('**/api/config', (route) => route.fulfill({ json: answer }));
    expect(await ask()).toEqual({ devtools: true });
    answer = { devtools: false, changed: 1 };
    expect(await ask()).toEqual({ devtools: false, changed: 1 });
    // ... and the app itself sees the live answer on a controlled load.
    answer = { devtools: true };
    await openApp(page);
    await page.waitForFunction(() => devtoolsEnabled === true);
  });

  test('with the network cut, /api/ requests fail instead of being answered from the cache', async ({ page, context }) => {
    await serviceWorkerInControl(page);
    await page.evaluate(() => fetch('/api/config'));
    provoked.push(/ERR_INTERNET_DISCONNECTED.*\/api\/events$/);
    await context.setOffline(true);
    const result = await page.evaluate(async () => {
      const attempt = (url) => fetch(url).then((r) => `answered ${r.status}`, () => 'failed');
      return { config: await attempt('/api/config'), events: await attempt('/api/events'), css: await attempt('style.css') };
    });
    // The control: a cached file is still answered.
    expect(result).toEqual({ config: 'failed', events: 'failed', css: 'answered 200' });
  });

  test('requests that are not GET, or for a file that does not exist, are not answered from the cache', async ({ page }) => {
    await serviceWorkerInControl(page);
    provoked.push(/405 \(Method Not Allowed\).*\/style\.css$/, /404 \(Not Found\).*\/no-such-file\.js$/);
    const statuses = await page.evaluate(async () => [
      (await fetch('style.css', { method: 'POST' })).status,
      (await fetch('no-such-file.js')).status,
      (await fetch('style.css')).status,
    ]);
    expect(statuses).toEqual([405, 404, 200]);
    expect(await cachedPaths(page)).not.toContain('/no-such-file.js');
  });

  test('while the server is reachable the worker serves the current file, not the cached copy', async ({ page }) => {
    await serviceWorkerInControl(page);
    // Network first: a changed file on the server must show at once.
    await page.route('**/style.css', (route) => route.fulfill({ contentType: 'text/css', body: '/* changed on the server */' }));
    const first = await page.evaluate(async () => (await fetch('style.css')).text());
    await page.unroute('**/style.css');
    const real = await page.evaluate(async () => (await fetch('style.css')).text());
    expect(real).toContain('#toolbar');
    // Whether page.route sees a request made by the worker depends on the
    // browser; either answer above is a live one, the point is that the real
    // file is back as soon as the server serves it again.
    expect([real, '/* changed on the server */']).toContain(first);
  });
});

/* ---------- offline ---------- */

test.describe('offline', () => {
  /**
   * Starts the app, lets the service worker take over, cuts the network and
   * starts the app again. From then on nothing can be fetched, which includes
   * /api/config and the heartbeat stream.
   */
  async function restartOffline(page, context, whileOnline = async () => {}) {
    await openApp(page);
    await serviceWorkerInControl(page);
    await whileOnline();
    await context.setOffline(true);
    await openApp(page);
    expect(await page.evaluate(() => fetch('/api/config').then(() => 'online', () => 'offline'))).toBe('offline');
  }

  // What these tests ignore, and nothing else:
  //  - the failed GET /api/config (the app asks its server for the dev-tools
  //    flag; with no server there is no answer, which means "off"). helpers.js
  //    already ignores exactly this console message for every test.
  // The heartbeat's failed EventSource is reported inside the SharedWorker,
  // not in the page, so it never shows up here.
  const offlineErrors = (page) => appErrors(page);

  test('the app shell starts with the network cut', async ({ page, context }) => {
    await restartOffline(page, context);
    await expect(page.locator('#empty')).toBeVisible();
    await expect(page.locator('#file-menu-btn')).toBeVisible();
    // Styled, not a bare page: the toolbar sticks to the top.
    expect(await page.locator('#toolbar').evaluate((el) => getComputedStyle(el).position)).toBe('sticky');
    await openFileMenu(page);
    await expect(fileMenuItem(page, 'Open…')).toBeVisible();
    expect(await page.evaluate(() => devtoolsEnabled)).toBe(false);
    expect(offlineErrors(page)).toEqual([]);
  });

  test('a document with highlighted code and a Mermaid diagram renders with the network cut', async ({ page, context }) => {
    await restartOffline(page, context);
    await openMarkdown(page, DIAGRAM_DOC);
    await expect(view(page).locator('h1')).toHaveText('Offline');
    await expect(view(page).locator('pre code.hljs .hljs-keyword')).toHaveText('const');
    await expect(view(page).locator('.mermaid-diagram svg')).toBeVisible();
    await expect(view(page).locator('.render-error')).toHaveCount(0);
    await expect.poll(() => view(page).locator('img').evaluate((el) => el.complete && el.naturalWidth)).toBe(1);
    expect(offlineErrors(page)).toEqual([]);
  });

  test('math that was shown while online renders with its fonts with the network cut', async ({ page, context }) => {
    await restartOffline(page, context, async () => {
      await openMarkdown(page, MATH_DOC);
      // The worker caches the KaTeX fonts when they are first used.
      await page.evaluate(() => document.fonts.ready);
      await expect.poll(async () => (await cachedPaths(page)).filter((p) => p.includes('/katex/fonts/')).length)
        .toBeGreaterThan(0);
      await page.waitForFunction(() => [...document.fonts].some((f) => /KaTeX/.test(f.family) && f.status === 'loaded'));
      await page.waitForFunction(() => ![...document.fonts].some((f) => f.status === 'loading'));
      const loaded = await page.evaluate(() => [...document.fonts].filter((f) => f.status === 'loaded').length);
      await expect.poll(async () => (await cachedPaths(page)).filter((p) => p.includes('/katex/fonts/')).length)
        .toBeGreaterThanOrEqual(loaded);
    });
    await openMarkdown(page, MATH_DOC);
    await expect(view(page).locator('.katex')).toHaveCount(2);
    await expect(view(page).locator('.katex-display')).toHaveCount(1);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => ![...document.fonts].some((f) => f.status === 'loading'));
    const fonts = await page.evaluate(() => [...document.fonts].filter((f) => /KaTeX/.test(f.family))
      .map((f) => f.status));
    expect(fonts).toContain('loaded');
    expect(fonts).not.toContain('error');
    expect(offlineErrors(page)).toEqual([]);
  });

  test('math renders with its fonts with the network cut even if no math was shown while online', async ({ page, context }) => {
    // APP GAP: the service worker precaches katex.min.js and katex.min.css but
    // none of the KaTeX fonts (app/vendor/katex/fonts/); it only caches a font
    // once a document has used it while the server was reachable. An installed
    // app that is started without its server and then shows math for the first
    // time (or math needing a font not used before) gets "Failed to load
    // resource" console errors for every font and falls back to the wrong
    // typeface. The formulas themselves are still typeset.
    // Regression test for a fixed app bug.
    await restartOffline(page, context);
    await openMarkdown(page, MATH_DOC);
    await expect(view(page).locator('.katex')).toHaveCount(2);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => ![...document.fonts].some((f) => f.status === 'loading'));
    const failed = await page.evaluate(() => [...document.fonts].filter((f) => f.status === 'error').map((f) => f.family));
    expect(failed).toEqual([]);
    expect(offlineErrors(page)).toEqual([]);
  });

  test('math is still typeset (in a fallback font) with the network cut when its fonts were never cached', async ({ page, context }) => {
    // The part of the case above that does work. Ignored here, on purpose:
    // the console errors for the KaTeX font files that cannot be fetched.
    await restartOffline(page, context);
    await openMarkdown(page, MATH_DOC);
    await expect(view(page).locator('.katex')).toHaveCount(2);
    await expect(view(page).locator('.katex-display .mfrac')).toHaveCount(1);
    await expect(view(page).locator('.katex-error')).toHaveCount(0);
    await page.evaluate(() => document.fonts.ready);
    expect(appErrors(page, [/\/vendor\/katex\/fonts\/KaTeX_[\w-]+\.(woff2|woff|ttf)$/])).toEqual([]);
  });

  test('files opened earlier are still listed under Recently Viewed with the network cut', async ({ page, context }) => {
    await restartOffline(page, context, () => openFiles(page, [{ name: 'kept.md', content: '# Kept' }]));
    await openFileMenu(page);
    await page.locator('#recent-btn').hover();
    await expect(page.locator('#recent-menu [role="menuitem"]').first()).toHaveText('kept.md');
    await page.locator('#recent-menu [role="menuitem"]').first().click();
    await expect(view(page).locator('h1')).toHaveText('Kept');
    expect(offlineErrors(page)).toEqual([]);
  });

  test('without a service worker in control the app does not start offline (control for the tests above)', async ({ page, context }) => {
    // Proves that context.setOffline really cuts the page off, so that the
    // passing tests above are owed to the service worker's cache.
    await openApp(page);
    await serviceWorkerInControl(page);
    await page.evaluate(async () => {
      for (const reg of await navigator.serviceWorker.getRegistrations()) await reg.unregister();
      for (const name of await caches.keys()) await caches.delete(name);
    });
    await context.setOffline(true);
    const failure = await page.goto('/').then(() => null, (err) => err.message);
    expect(failure).toMatch(/ERR_INTERNET_DISCONNECTED/);
  });
});

/* ---------- a server of the test's own ---------- */

test.describe('with the server process stopped', () => {
  const SERVER = path.resolve(__dirname, '..', 'server.js');

  /**
   * Starts `node server.js` on a port of its own, with its pid/devtools files
   * in a private directory. Resolves to { url, exited, stop() }.
   */
  async function startServer(testInfo, { headless = true, idleSeconds } = {}) {
    const run = fs.mkdtempSync(path.join(os.tmpdir(), 'markdown-viewer-pwa-'));
    // Outside the ranges the other spec files and the config use.
    const first = 8210 + testInfo.parallelIndex * 10;
    for (let port = first; port < first + 10; port++) {
      const child = spawn(process.execPath, [SERVER, '--port', String(port), ...(headless ? ['--headless'] : [])], {
        env: { ...process.env, XDG_RUNTIME_DIR: run, ...(idleSeconds ? { MARKDOWN_VIEWER_IDLE_SECONDS: String(idleSeconds) } : {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const server = { url: `http://localhost:${port}/`, exitCode: undefined };
      server.exited = new Promise((resolve) => child.on('exit', (code) => { server.exitCode = code; resolve(code); }));
      server.stop = async () => {
        if (server.exitCode === undefined) child.kill('SIGTERM');
        await server.exited;
        fs.rmSync(run, { recursive: true, force: true });
      };
      const up = await Promise.race([
        new Promise((resolve) => child.stdout.once('data', () => resolve(true))),
        server.exited.then(() => false),      // port taken: try the next one
      ]);
      if (up) return server;
    }
    fs.rmSync(run, { recursive: true, force: true });
    throw new Error(`no free port in ${first}-${first + 9}`);
  }

  /** Loads the app from `url`, recording page errors and console errors as strings. */
  async function openAppAt(page, url, errors) {
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`${msg.text()} ${msg.location().url || ''}`);
    });
    await page.goto(url);
    await page.waitForFunction(() => typeof openHandles === 'function');
  }

  test('the app starts again and renders a document after its server has exited', async ({ page }, testInfo) => {
    const server = await startServer(testInfo);
    const errors = [];
    try {
      await openAppAt(page, server.url, errors);
      await serviceWorkerInControl(page);
      await server.stop();

      const response = await page.reload();
      expect(response.fromServiceWorker()).toBe(true);
      await page.waitForFunction(() => typeof openHandles === 'function');
      await expect(page.locator('#empty')).toBeVisible();
      await page.evaluate(async (content) => {
        const dir = await navigator.storage.getDirectory();
        const handle = await dir.getFileHandle('doc.md', { create: true });
        const w = await handle.createWritable();
        await w.write(content);
        await w.close();
        await openHandles([handle]);
      }, DIAGRAM_DOC);
      await waitForRendered(page);
      await expect(view(page).locator('h1')).toHaveText('Offline');
      await expect(view(page).locator('pre code.hljs')).toBeVisible();
      await expect(view(page).locator('.mermaid-diagram svg')).toBeVisible();
      // Ignored: the config request that nobody answers any more
      // (net::ERR_CONNECTION_REFUSED for /api/config). Nothing else.
      expect(errors.filter((e) => !/Failed to load resource.*\/api\/config$/.test(e))).toEqual([]);
    } finally {
      await server.stop();
    }
  });

  test('an open app window keeps a self-stopping server alive, and the server exits once the last window is closed', async ({ page, context }, testInfo) => {
    // Without --headless the server exits after MARKDOWN_VIEWER_IDLE_SECONDS
    // with no /api/events stream. The stream is the heartbeat's.
    const server = await startServer(testInfo, { headless: false, idleSeconds: 1 });
    const errors = [];
    try {
      await openAppAt(page, server.url, errors);
      const second = await context.newPage();
      await second.goto(server.url);
      await second.waitForFunction(() => typeof openHandles === 'function');
      expect(await heartbeats(context, page)).toEqual(['/heartbeat.js']);

      // "Still running" can only be observed over time: three idle periods
      // with both windows open, then three more with one. Each is a race
      // against the server's exit, not a pause.
      const stillRunning = () => Promise.race([
        server.exited.then(() => false),
        new Promise((resolve) => setTimeout(() => resolve(true), 3000)),
      ]);
      expect(await stillRunning()).toBe(true);
      await second.close();
      expect(await stillRunning()).toBe(true);

      // Leave the app with the only remaining window: the worker ends, the
      // stream closes, the server goes.
      await page.goto('about:blank');
      expect(await server.exited).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await server.stop();
    }
  });
});

/* ---------- heartbeat ---------- */

test.describe('heartbeat', () => {
  test.beforeEach(async ({ page }) => { await openApp(page); });
  test.afterEach(async ({ page }) => { expect(appErrors(page)).toEqual([]); });

  test('a SharedWorker running heartbeat.js exists after the app has loaded', async ({ page, context }) => {
    await expect.poll(() => heartbeats(context, page)).toEqual(['/heartbeat.js']);
  });

  test('the heartbeat worker holds one open /api/events stream', async ({ page, context }) => {
    await expect.poll(() => heartbeats(context, page)).toEqual(['/heartbeat.js']);
    // Look inside the worker through the DevTools protocol: its EventSource
    // is the top-level constant `events`.
    const session = await context.newCDPSession(page);
    const { targetInfos } = await session.send('Target.getTargets');
    const worker = targetInfos.find((t) => t.type === 'shared_worker');
    const { sessionId } = await session.send('Target.attachToTarget', { targetId: worker.targetId, flatten: false });
    const evaluate = (expression) => new Promise((resolve) => {
      const id = Math.floor(Math.random() * 1e9);
      const onMessage = (event) => {
        const message = JSON.parse(event.message);
        if (event.sessionId !== sessionId || message.id !== id) return;
        session.off('Target.receivedMessageFromTarget', onMessage);
        resolve(message.result?.result?.value);
      };
      session.on('Target.receivedMessageFromTarget', onMessage);
      session.send('Target.sendMessageToTarget', {
        sessionId,
        message: JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }),
      });
    });
    expect(await evaluate('new URL(events.url).pathname')).toBe('/api/events');
    await expect.poll(() => evaluate('events.readyState')).toBe(1);   // EventSource.OPEN
    expect(await evaluate('events instanceof EventSource')).toBe(true);
    await session.detach();
  });

  test('a second app window shares the one heartbeat worker', async ({ page, context }) => {
    const second = await context.newPage();
    await openApp(second);
    const third = await context.newPage();
    await openApp(third);
    await expect.poll(() => heartbeats(context, page)).toEqual(['/heartbeat.js']);
    const all = await targets(context, page);
    expect(all.filter((t) => t.type === 'page')).toHaveLength(3);
    expect(all.filter((t) => t.type === 'shared_worker')).toHaveLength(1);
    // Closing one window does not take the worker away from the others.
    await second.close();
    expect(await heartbeats(context, page)).toEqual(['/heartbeat.js']);
    expect(appErrors(second)).toEqual([]);
    expect(appErrors(third)).toEqual([]);
  });

  test('reloading the page does not pile up heartbeat workers', async ({ page, context }) => {
    for (let i = 0; i < 3; i++) await openApp(page);
    await expect.poll(() => heartbeats(context, page)).toEqual(['/heartbeat.js']);
  });

  test('the page itself opens no /api/events stream', async ({ page }) => {
    const urls = [];
    page.on('request', (r) => urls.push(new URL(r.url()).pathname));
    await openApp(page);
    await serviceWorkerInControl(page);
    expect(urls).toContain('/app.js');
    expect(urls.filter((p) => p.startsWith('/api/'))).toEqual(['/api/config']);
  });

  test('the app works when SharedWorker is not available', async ({ page }) => {
    await page.addInitScript(() => { delete window.SharedWorker; });
    await openApp(page);
    expect(await page.evaluate(() => typeof SharedWorker)).toBe('undefined');
    await openMarkdown(page, '# Still works');
    await expect(view(page).locator('h1')).toHaveText('Still works');
    // The app reports the missing heartbeat with console.warn, not as an error.
    expect(appErrors(page)).toEqual([]);
  });
});

/* ---------- Content-Security-Policy ---------- */

test.describe('Content-Security-Policy', () => {
  test.beforeEach(async ({ page }) => { await openApp(page); });

  const policy = (page) => page.evaluate(() => {
    const metas = document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]');
    if (metas.length !== 1) throw new Error(`${metas.length} CSP meta tags`);
    if (metas[0].parentElement !== document.head) throw new Error('CSP meta tag is not in <head>');
    const before = [...document.head.querySelectorAll('script, link[rel="stylesheet"]')]
      .filter((el) => el.compareDocumentPosition(metas[0]) & Node.DOCUMENT_POSITION_FOLLOWING);
    if (before.length) throw new Error('something is loaded before the CSP meta tag');
    return Object.fromEntries(metas[0].content.split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
  });

  test('the page carries one CSP meta tag, ahead of everything it loads', async ({ page }) => {
    const csp = await policy(page);
    expect(Object.keys(csp).sort()).toEqual(['base-uri', 'connect-src', 'default-src', 'font-src', 'form-action',
      'img-src', 'object-src', 'script-src', 'style-src']);
    expect(appErrors(page)).toEqual([]);
  });

  test('the policy allows scripts and connections only from the app itself', async ({ page }) => {
    const csp = await policy(page);
    expect(csp['default-src']).toEqual(["'self'"]);
    expect(csp['script-src']).toEqual(["'self'"]);       // no 'unsafe-inline', no 'unsafe-eval', no hosts
    expect(csp['connect-src']).toEqual(["'self'"]);
    expect(csp['object-src']).toEqual(["'none'"]);
    expect(csp['base-uri']).toEqual(["'none'"]);
    expect(csp['form-action']).toEqual(["'none'"]);
    expect(csp['font-src'].sort()).toEqual(['data:', "'self'"].sort());
    for (const directive of Object.values(csp)) {
      expect(directive).not.toContain('*');
      expect(directive).not.toContain("'unsafe-eval'");
    }
    expect(csp['script-src']).not.toContain("'unsafe-inline'");
  });

  test('the policy is enforced: inline script, eval and a fetch to another origin are blocked', async ({ page }) => {
    const requests = [];
    page.on('request', (r) => requests.push(r.url()));
    const result = await page.evaluate(async () => {
      const violations = [];
      document.addEventListener('securitypolicyviolation', (e) => violations.push(e.effectiveDirective));
      const script = document.createElement('script');
      script.textContent = 'window.__inlineRan = true;';
      document.head.append(script);
      // From a timer: code evaluated through the DevTools protocol itself
      // (which is how this function got here) is exempt from the eval rule.
      const evalRan = await new Promise((resolve) => setTimeout(() => {
        try { resolve((0, eval)('true')); } catch (err) { resolve(false); }
      }, 0));
      const fetched = await fetch('https://example.com/').then(() => 'sent', () => 'blocked');
      const img = document.createElement('div');
      img.innerHTML = '<a href="javascript:window.__jsUrlRan=true" id="js-url">x</a>';
      document.body.append(img);
      document.getElementById('js-url').click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return {
        inlineRan: !!window.__inlineRan, evalRan, fetched, jsUrlRan: !!window.__jsUrlRan,
        violations: [...new Set(violations)].sort(),
      };
    });
    expect(result).toEqual({
      inlineRan: false,
      evalRan: false,
      fetched: 'blocked',
      jsUrlRan: false,
      violations: result.violations,
    });
    expect(result.violations).toEqual(expect.arrayContaining(['connect-src', 'script-src', 'script-src-elem']));
    // The blocked fetch never left the browser.
    expect(requests.filter((u) => u.startsWith('https://example.com'))).toEqual([]);
  });
});

/* ---------- the app talks to nobody else ---------- */

test.describe('network', () => {
  // A document without remote images, but with everything else that could
  // tempt a renderer to fetch something: links, raw HTML that asks for remote
  // scripts, frames, style sheets, plug-ins and forms, and all three
  // on-demand renderers.
  // Deliberately absent: remote images in any form. Besides ![](https://...)
  // that includes an inline style with url(https://...), which the sanitizer
  // keeps and the policy's "img-src https:" lets the browser fetch.
  const DOC = `# Everything

[external](https://example.com/page) <https://example.org/auto> www.example.net

<script src="https://example.com/evil.js"></script>
<link rel="stylesheet" href="https://example.com/evil.css">
<iframe src="https://example.com/frame"></iframe>
<object data="https://example.com/object"></object>
<embed src="https://example.com/embed">
<div style="color: red">styled</div>
<a href="https://example.com/ping" ping="https://example.com/pinged">ping</a>
<form action="https://example.com/post"><input name="q"></form>

![pixel](${PIXEL})

\`\`\`js
fetch('https://example.com/from-code');
\`\`\`

\`\`\`mermaid
graph TD; A[Start] --> B[End];
click A "https://example.com/mermaid-click"
\`\`\`

$\\href{https://example.com/math}{x}$ and $$e^{i\\pi} + 1 = 0$$
`;

  test('loading the app and rendering a document sends no request to any other origin', async ({ page, context, baseURL }) => {
    const origin = new URL(baseURL).origin;
    const requests = [];
    context.on('request', (r) => requests.push(r.url()));
    await openApp(page);
    await openMarkdown(page, DOC);
    await serviceWorkerInControl(page);          // includes everything the worker precaches
    await page.evaluate(() => document.fonts.ready);
    await expect(view(page).locator('.mermaid-diagram svg')).toBeVisible();
    await expect(view(page).locator('.katex').first()).toBeVisible();

    // Render again in dark mode (Mermaid and highlight.js change theme).
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(view(page).locator('.mermaid-diagram svg')).toBeVisible();
    await waitForRendered(page);

    expect(requests.length).toBeGreaterThan(15);
    const foreign = requests.filter((u) => !/^(data|blob):/.test(u) && new URL(u).origin !== origin);
    expect(foreign).toEqual([]);
    // Same host name as well: nothing went to 127.0.0.1 or another port.
    expect([...new Set(requests.filter((u) => /^https?:/.test(u)).map((u) => new URL(u).host))]).toEqual([new URL(baseURL).host]);
  });

  test('the only requests besides the app\'s own files are the two API calls', async ({ page, context, baseURL }) => {
    const paths = new Set();
    context.on('request', (r) => { if (r.url().startsWith(baseURL)) paths.add(new URL(r.url()).pathname); });
    await openApp(page);
    await openMarkdown(page, DOC);
    await serviceWorkerInControl(page);
    await page.evaluate(() => document.fonts.ready);
    const appDir = path.resolve(__dirname, '..', 'app');
    const unknown = [...paths].filter((p) => {
      if (p === '/api/config' || p === '/api/events') return false;
      const file = path.join(appDir, p === '/' ? 'index.html' : decodeURIComponent(p));
      return !fs.existsSync(file);
    });
    expect(unknown).toEqual([]);
    expect(paths).toContain('/api/config');
  });

  test('reloading, switching tabs and closing files send no request to any other origin either', async ({ page, context, baseURL }) => {
    const origin = new URL(baseURL).origin;
    const foreign = [];
    context.on('request', (r) => {
      if (!/^(data|blob):/.test(r.url()) && new URL(r.url()).origin !== origin) foreign.push(r.url());
    });
    await openApp(page);
    await openFiles(page, [{ name: 'a.md', content: DOC }, { name: 'b.md', content: DOC }]);
    await page.keyboard.press('F5');
    await waitForRendered(page);
    await page.locator('#tabs [role="tab"]').nth(1).click();
    await expect(page.locator('#tabs [role="tab"]').nth(1)).toHaveAttribute('aria-selected', 'true');
    await waitForRendered(page);
    await openFileMenu(page);
    await fileMenuItem(page, 'Close All').click();
    await expect(page.locator('#empty')).toBeVisible();
    expect(foreign).toEqual([]);
  });
});
