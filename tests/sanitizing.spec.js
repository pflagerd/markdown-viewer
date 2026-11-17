// A document must not be able to run code, load active content, restyle the
// app or break its controls. Each negative test also checks that the document
// itself is still displayed, so a test cannot pass merely because nothing was
// rendered.
const { test, expect, openApp, openMarkdown, appErrors, view, clickFileMenuItem, openFileMenu,
  fileMenuItem, shownFilename } = require('./helpers');

test.beforeEach(async ({ page }) => { await openApp(page); });

// Every payload tries to set this global.
const PWN = 'window.__pwned = 1';
const pwned = (page) => page.evaluate(() => window.__pwned);

// Names of event-handler attributes (on*) on any element inside the document.
const handlerAttributes = (page) => view(page).evaluate((root) =>
  [...root.querySelectorAll('*')].flatMap((el) =>
    el.getAttributeNames().filter((n) => n.startsWith('on')).map((n) => `${el.localName}[${n}]`)));

// hrefs (including SVG xlink:href) in the document that use the javascript: scheme.
const javascriptUrls = (page) => view(page).evaluate((root) =>
  [...root.querySelectorAll('*')].flatMap((el) =>
    ['href', 'xlink:href', 'src', 'action', 'formaction', 'data']
      .map((n) => el.getAttribute(n)).filter((v) => v && /^\s*javascript:/i.test(v))));

test.describe('scripts and event handlers', () => {
  test('a <script> element in the document is removed and does not run', async ({ page }) => {
    await openMarkdown(page, `Before\n\n<script>${PWN}</script>\n\nAfter <script src="data:text/javascript,${PWN}"></script>`);
    await expect(view(page).locator('p').first()).toHaveText('Before');
    await expect(view(page).locator('script')).toHaveCount(0);
    expect(await pwned(page)).toBeUndefined();
    expect(appErrors(page)).toEqual([]);
  });

  test('an onerror handler on an image is removed and does not run', async ({ page }) => {
    await openMarkdown(page, `Text\n\n<img src="/no-such-image.png" onerror="${PWN}">`);
    const img = view(page).locator('img');
    // Wait until the load has failed, i.e. the moment the handler would run.
    await expect.poll(() => img.evaluate((el) => el.complete && el.naturalWidth === 0)).toBe(true);
    expect(await handlerAttributes(page)).toEqual([]);
    expect(await pwned(page)).toBeUndefined();
    expect(appErrors(page, [/Failed to load resource.*\/no-such-image\.png$/])).toEqual([]);
  });

  test('an onclick handler on a link is removed and clicking the link runs nothing', async ({ page }) => {
    await openMarkdown(page, `<a href="#top" onclick="${PWN}" onmouseover="${PWN}">click me</a>\n\n# Top`);
    expect(await handlerAttributes(page)).toEqual([]);
    await view(page).getByText('click me').click();
    expect(await pwned(page)).toBeUndefined();
    expect(appErrors(page)).toEqual([]);
  });

  test('an onload handler on inline SVG is removed and does not run', async ({ page }) => {
    await openMarkdown(page, `<svg onload="${PWN}" width="20" height="20"><circle r="5" onclick="${PWN}"/><script>${PWN}</script><animate onbegin="${PWN}" attributeName="x" dur="1s"/></svg>\n\nAfter`);
    await expect(view(page).locator('svg circle')).toHaveCount(1);
    await expect(view(page).locator('svg script')).toHaveCount(0);
    expect(await handlerAttributes(page)).toEqual([]);
    expect(await pwned(page)).toBeUndefined();
    expect(appErrors(page)).toEqual([]);
  });

  test('javascript: links lose their target and clicking them runs nothing', async ({ page }) => {
    await openMarkdown(page, `[markdown link](javascript:${encodeURI(PWN)})\n\n<a href="javascript:${PWN}">raw link</a>\n\n<a href=" JaVaScRiPt:${PWN}">odd link</a>`);
    expect(await javascriptUrls(page)).toEqual([]);
    const url = page.url();
    for (const text of ['markdown link', 'raw link', 'odd link']) {
      await view(page).getByText(text).click();
    }
    expect(await pwned(page)).toBeUndefined();
    expect(page.url()).toBe(url);
    expect(appErrors(page)).toEqual([]);
  });
});

test.describe('active and embedded content', () => {
  test('<iframe> is removed', async ({ page }) => {
    await openMarkdown(page, `Before\n\n<iframe src="https://example.com/" srcdoc="<script>parent.__pwned = 1</script>"></iframe>\n\nAfter`);
    await expect(view(page).locator('p').first()).toHaveText('Before');
    await expect(view(page).locator('iframe')).toHaveCount(0);
    expect(page.frames()).toHaveLength(1);
    expect(await pwned(page)).toBeUndefined();
    expect(appErrors(page)).toEqual([]);
  });

  test('<object> and <embed> are removed', async ({ page }) => {
    await openMarkdown(page, 'Before\n\n<object data="https://example.com/x.swf"><param name="a" value="b"></object><embed src="https://example.com/x.swf">\n\nAfter');
    await expect(view(page).locator('p').first()).toHaveText('Before');
    await expect(view(page).locator('object, embed, param')).toHaveCount(0);
    expect(appErrors(page)).toEqual([]);
  });

  test('<form> is removed, so a document cannot submit anything', async ({ page }) => {
    await openMarkdown(page, 'Before\n\n<form action="https://example.com/steal" method="post"><input name="q" value="secret"><button type="submit">Send</button></form>\n\nAfter');
    await expect(view(page).locator('p').first()).toHaveText('Before');
    await expect(view(page).locator('form')).toHaveCount(0);
    await expect(view(page).locator('[formaction]')).toHaveCount(0);
    expect(appErrors(page)).toEqual([]);
  });

  test('<style> is removed and cannot restyle the app', async ({ page }) => {
    await openMarkdown(page, 'Before\n\n<style>#toolbar { display: none !important } body { background: rgb(255, 0, 0) !important }</style>\n\nAfter');
    await expect(view(page).locator('p').first()).toHaveText('Before');
    await expect(view(page).locator('style')).toHaveCount(0);
    await expect(page.locator('#toolbar')).toBeVisible();
    await expect(page.locator('body')).not.toHaveCSS('background-color', 'rgb(255, 0, 0)');
    expect(appErrors(page)).toEqual([]);
  });

  test('<link rel=stylesheet> is removed', async ({ page }) => {
    const requests = [];
    page.on('request', (r) => requests.push(r.url()));
    await openMarkdown(page, 'Before\n\n<link rel="stylesheet" href="/evil.css">\n\nAfter');
    await expect(view(page).locator('p').first()).toHaveText('Before');
    await expect(view(page).locator('link')).toHaveCount(0);
    await expect(page.locator('link[href*="evil.css"]')).toHaveCount(0);
    expect(requests.filter((u) => u.includes('evil.css'))).toEqual([]);
    expect(appErrors(page)).toEqual([]);
  });

  test('<base> is removed and does not change where the app\'s URLs point', async ({ page }) => {
    const baseBefore = await page.evaluate(() => document.baseURI);
    await openMarkdown(page, 'Before\n\n<base href="https://example.com/" target="_blank">\n\nAfter');
    await expect(view(page).locator('p').first()).toHaveText('Before');
    await expect(page.locator('base')).toHaveCount(0);
    expect(await page.evaluate(() => document.baseURI)).toBe(baseBefore);
    // The sanitizer parses the <base> in a scratch document, which makes
    // Chrome report that the page's policy (base-uri 'none') blocked it.
    expect(appErrors(page, [/base URI.*Content Security Policy/])).toEqual([]);
  });

  test('<meta http-equiv=refresh> is removed, so the document cannot redirect the app', async ({ page }) => {
    await openMarkdown(page, 'Before\n\n<meta http-equiv="refresh" content="0; url=https://example.com/">\n\nAfter');
    await expect(view(page).locator('p').first()).toHaveText('Before');
    await expect(view(page).locator('meta')).toHaveCount(0);
    await expect(page.locator('meta[http-equiv="refresh" i]')).toHaveCount(0);
    expect(page.url()).toBe(new URL('/', page.url()).href);
    expect(appErrors(page)).toEqual([]);
  });
});

test.describe('ids that collide with the app\'s own', () => {
  const COLLIDING = [
    '<div id="toolbar">fake toolbar</div>',
    '<div id="view">fake view</div>',
    '<div id="file-menu">fake menu</div>',
    '<button id="file-menu-btn">fake button</button>',
    '<span id="status">fake status</span>',
    '# Real heading',
  ].join('\n\n');

  test('the File menu still opens and its items still work', async ({ page }) => {
    await openMarkdown(page, COLLIDING, 'collide.md');
    await expect(view(page).locator('h1')).toHaveText('Real heading');
    expect(await shownFilename(page)).toBe('collide.md');

    await openFileMenu(page);
    await expect(fileMenuItem(page, 'Reload')).toBeEnabled();
    await expect(fileMenuItem(page, 'Close')).toBeEnabled();
    await page.keyboard.press('Escape');
    await expect(page.locator('#file-menu').first()).toBeHidden();

    await clickFileMenuItem(page, 'Reload');
    await expect(view(page).locator('h1')).toHaveText('Real heading');

    await clickFileMenuItem(page, 'Close');
    await expect(view(page).locator('h1')).toHaveText('Markdown Viewer');   // the empty state
    expect(await shownFilename(page)).toBe('No file open');
    await expect(page.getByText('fake toolbar')).toHaveCount(0);
    expect(appErrors(page)).toEqual([]);
  });

  test('the app keeps addressing its own elements, not the document\'s', async ({ page }) => {
    await openMarkdown(page, COLLIDING, 'collide.md');
    const owners = await page.evaluate(() => ['toolbar', 'view', 'file-menu', 'file-menu-btn', 'status']
      .map((id) => `${id}:${document.getElementById(id).closest('main') ? 'document' : 'app'}`));
    // <main id="view"> is the app's own element; it is its own closest('main').
    expect(owners).toEqual(['toolbar:app', 'view:document', 'file-menu:app', 'file-menu-btn:app', 'status:app']);
    expect(await page.evaluate(() => document.getElementById('view').localName)).toBe('main');
  });
});

test.describe('math and diagrams', () => {
  // KaTeX does not accept "_" in text mode, so the math payloads set a global
  // without one.
  const MATH_PWN = 'window.mathpwned=1';
  const mathPwned = (page) => page.evaluate(() => window.mathpwned);

  test('HTML inside math is shown as text and does not become elements', async ({ page }) => {
    await openMarkdown(page, `Inline $\\text{<img src=/in-math.png onerror=${MATH_PWN}>}$ here.\n\n$$\n\\text{<svg onload=${MATH_PWN}>}\n$$\n\n\`\`\`math\n\\text{<script>${MATH_PWN}</script>}\n\`\`\``);
    await expect(view(page).locator('.katex')).toHaveCount(3);
    await expect(view(page).locator('.katex-error')).toHaveCount(0);
    await expect(view(page).locator('img, script, svg[onload]')).toHaveCount(0);
    await expect(view(page).locator('p .katex-html')).toContainText('<img');
    await expect(view(page).locator('.katex-display .katex-html').last()).toContainText('<script>');
    expect(await handlerAttributes(page)).toEqual([]);
    expect(await mathPwned(page)).toBeUndefined();
    expect(appErrors(page)).toEqual([]);
  });

  test('HTML inside $$ math containing a closing script tag does not become elements', async ({ page }) => {
    // The sanitizer drops this formula altogether (see the known failure in
    // rendering.spec.js); what matters here is that nothing runs.
    await openMarkdown(page, `Before\n\n$$\n\\text{</script><script>${MATH_PWN}</script><img src=/in-math.png onerror=${MATH_PWN}>}\n$$\n\nAfter`);
    await expect(view(page).locator('p').first()).toHaveText('Before');
    await expect(view(page).locator('p').last()).toHaveText('After');
    await expect(view(page).locator('img, script')).toHaveCount(0);
    expect(await handlerAttributes(page)).toEqual([]);
    expect(await mathPwned(page)).toBeUndefined();
    expect(appErrors(page)).toEqual([]);
  });

  test('KaTeX commands that produce links, images or raw attributes are not honoured', async ({ page }) => {
    await openMarkdown(page, `$\\href{javascript:${MATH_PWN}}{link}$ and $\\htmlData{onclick=${MATH_PWN}}{x}$ and $\\url{javascript:${MATH_PWN}}$ and $\\includegraphics{/in-math.png}$`);
    await expect(view(page).locator('.math')).toHaveCount(4);
    await expect(view(page).locator('.math .katex')).toHaveCount(4);
    await expect(view(page).locator('.math a, .math img')).toHaveCount(0);
    await expect(view(page).locator('.math [data-onclick], .math [onclick]')).toHaveCount(0);
    expect(await javascriptUrls(page)).toEqual([]);
    expect(await handlerAttributes(page)).toEqual([]);
    expect(await mathPwned(page)).toBeUndefined();
    expect(appErrors(page)).toEqual([]);
  });

  test('HTML inside Mermaid labels cannot run code', async ({ page }) => {
    await openMarkdown(page, [
      '```mermaid',
      'graph TD',
      `  A["<img src=/in-label.png onerror='${PWN}'>img"] --> B["<script>${PWN}</script>script"]`,
      `  B --> C["<a href='javascript:${PWN}' onclick='${PWN}'>anchor</a>"]`,
      `  click A "javascript:${PWN}"`,
      '  click B call eval()',
      '```',
    ].join('\n'));
    const svg = view(page).locator('.mermaid-diagram svg');
    await expect(svg).toHaveCount(1);
    await expect(svg).toContainText('script');
    await expect(svg.locator('script, iframe, object, embed')).toHaveCount(0);
    expect(await handlerAttributes(page)).toEqual([]);
    expect(await javascriptUrls(page)).toEqual([]);
    await expect(svg.locator('g.node')).toHaveCount(3);
    for (const node of await svg.locator('g.node').all()) await node.click();
    expect(await pwned(page)).toBeUndefined();
    // Mermaid keeps the (now harmless) <img>; its file does not exist.
    expect(appErrors(page, [/Failed to load resource.*\/in-label\.png$/])).toEqual([]);
  });
});

test.describe('Content Security Policy', () => {
  test('the page declares a policy that allows scripts only from the app itself', async ({ page }) => {
    const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
    const directives = Object.fromEntries(csp.split(';').map((d) => d.trim().split(/\s+/))
      .filter((p) => p[0]).map(([name, ...values]) => [name, values]));
    expect(directives['script-src']).toEqual(["'self'"]);
    expect(directives['default-src']).toEqual(["'self'"]);
    expect(directives['object-src']).toEqual(["'none'"]);
    expect(directives['base-uri']).toEqual(["'none'"]);
    expect(directives['form-action']).toEqual(["'none'"]);
  });

  test('an inline script injected at runtime is blocked', async ({ page }) => {
    const violation = await page.evaluate(() => new Promise((resolve) => {
      document.addEventListener('securitypolicyviolation', (e) => resolve({
        directive: e.effectiveDirective, blocked: e.blockedURI, disposition: e.disposition,
      }), { once: true });
      const s = document.createElement('script');
      s.textContent = 'window.__pwned = 1';
      document.body.append(s);
    }));
    expect(violation).toEqual({ directive: 'script-src-elem', blocked: 'inline', disposition: 'enforce' });
    expect(await pwned(page)).toBeUndefined();
    expect(appErrors(page, [/Content Security Policy/])).toEqual([]);
  });

  test('an inline event handler injected at runtime is blocked', async ({ page }) => {
    const violation = await page.evaluate(() => new Promise((resolve) => {
      document.addEventListener('securitypolicyviolation', (e) => resolve(e.effectiveDirective), { once: true });
      const b = document.createElement('button');
      b.setAttribute('onclick', 'window.__pwned = 1');
      document.body.append(b);
      b.click();
    }));
    expect(violation).toBe('script-src-attr');
    expect(await pwned(page)).toBeUndefined();
  });
});

test.describe('harmless raw HTML is kept', () => {
  test('<kbd>, <sub>, <sup> and <br> are kept', async ({ page }) => {
    await openMarkdown(page, 'Press <kbd>Ctrl</kbd>+<kbd>C</kbd>. H<sub>2</sub>O, x<sup>2</sup>.<br>Next line.');
    await expect(view(page).locator('kbd')).toHaveText(['Ctrl', 'C']);
    await expect(view(page).locator('sub')).toHaveText('2');
    await expect(view(page).locator('sup')).toHaveText('2');
    await expect(view(page).locator('p br')).toHaveCount(1);
    expect(appErrors(page)).toEqual([]);
  });

  test('<details> with <summary> is kept and can be expanded', async ({ page }) => {
    await openMarkdown(page, '<details><summary>More</summary>\n\nHidden **text**\n\n</details>');
    const details = view(page).locator('details');
    await expect(details.locator('summary')).toHaveText('More');
    await expect(details.locator('strong')).toBeHidden();
    await details.locator('summary').click();
    await expect(details.locator('strong')).toBeVisible();
    expect(appErrors(page)).toEqual([]);
  });

  test('ordinary attributes such as class, title and align survive', async ({ page }) => {
    await openMarkdown(page, '<p align="center" title="tip" class="note">Centered</p>\n\n<a href="https://example.com/" name="anchor">link</a>');
    const p = view(page).locator('p.note');
    await expect(p).toHaveAttribute('align', 'center');
    await expect(p).toHaveAttribute('title', 'tip');
    await expect(view(page).getByRole('link', { name: 'link' })).toHaveAttribute('href', 'https://example.com/');
    expect(appErrors(page)).toEqual([]);
  });
});
