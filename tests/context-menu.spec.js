// Right-click: Chrome's own context menu is suppressed everywhere and replaced
// by the app's menu, which offers only
//
//   Copy                (only with a non-empty selection)
//   Copy Link Address   (only when the right-click was on a link in the document)
//   ----                (when either of the two is there)
//   Reload              (disabled when no file is open)
//   Close               (disabled when no file is open)
//
// Right-clicks are real mouse input (button: 'right'), which makes Chromium
// fire a trusted contextmenu event. Whether Chrome's native menu would have
// opened cannot be seen in headless mode; "the contextmenu event was
// defaultPrevented" is what suppresses it, and that is what is asserted.
const {
  test, expect, openApp, openFiles, openMarkdown, writeFile, rerender, appErrors, view, tabs, tab,
  statusText, shownFilename, openFileMenu, fileMenuItem,
} = require('./helpers');

const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const RELOAD_CLOSE = ['Reload', 'Close'];
const DISABLED = ['Reload (disabled)', 'Close (disabled)'];

// A document with one of everything a right-click can land on.
const SAMPLE = `# Sample

Plain text with **bold words** and \`inline code\` in it.

An [external link](https://EXAMPLE.com/Some/Path?q=1#frag), an [anchor link](#sample),
a [relative link](notes/other.md#part) and a [mail link](mailto:someone@example.com).

A link around [**strong text**](https://example.org/strong) and around an image:
[<img alt="linked" width="40" height="40" src="${PIXEL}">](https://example.org/image)

<img alt="pixel" width="40" height="40" src="${PIXEL}">

\`\`\`js
const answer = 42;
\`\`\`

| A | B |
|---|---|
| 1 | 2 |

- [ ] task item
`;

const menu = (page) => page.locator('#context-menu').first();
const item = (page, label) => menu(page).getByRole('menuitem', { name: label, exact: true });

/**
 * What the app's context menu shows: null while it is closed, otherwise its
 * rows in order - item labels, '---' for a separator, ' (disabled)' appended
 * to items that cannot be chosen.
 */
function menuRows(page) {
  return page.evaluate(() => {
    const el = document.querySelector('#context-menu');
    if (el.hidden || !el.getClientRects().length) return null;
    return [...el.children].map((c) => (c.tagName === 'HR' ? '---' : c.textContent + (c.disabled ? ' (disabled)' : '')));
  });
}

/** Marks the page and records every contextmenu event as the browser's default handling sees it. */
async function instrument(page) {
  await page.evaluate(() => {
    window.__marker = 'same page';
    window.__contextmenus = [];
    window.addEventListener('contextmenu', (e) => window.__contextmenus.push({
      prevented: e.defaultPrevented, x: e.clientX, y: e.clientY,
    }));
    window.__picker = 0;
    window.showOpenFilePicker = async () => {
      window.__picker++;
      throw new DOMException('cancelled by the test', 'AbortError');
    };
  });
}

/**
 * Right-clicks the middle of a locator (or `position` inside it) and returns
 * the contextmenu event the page saw: { prevented, x, y }.
 * Uses pointer coordinates rather than locator.click(), which refuses
 * disabled elements such as task-list checkboxes. If the app's menu from an
 * earlier right-click happens to cover the spot, it is closed first, as a
 * user would have to.
 */
async function rightClick(page, locator, { position } = {}) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  const x = Math.round(box.x + (position ? position.x : box.width / 2));
  const y = Math.round(box.y + (position ? position.y : box.height / 2));
  const inMenu = await locator.evaluate((el) => !!el.closest('#context-menu'));
  const covered = await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('#context-menu'), [x, y]);
  if (covered && !inMenu) {
    await page.keyboard.press('Escape');
    await expect(page.locator('#context-menu').first()).toBeHidden();
  }
  const before = await page.evaluate(() => window.__contextmenus.length);
  await page.mouse.click(x, y, { button: 'right' });
  await page.waitForFunction((n) => window.__contextmenus.length > n, before);
  expect(await page.evaluate(() => window.__contextmenus.length)).toBe(before + 1);
  return page.evaluate(() => window.__contextmenus[window.__contextmenus.length - 1]);
}

/** Right-clicks a viewport position. */
async function rightClickAt(page, x, y) {
  const before = await page.evaluate(() => window.__contextmenus.length);
  await page.mouse.click(x, y, { button: 'right' });
  await page.waitForFunction((n) => window.__contextmenus.length > n, before);
  return page.evaluate(() => window.__contextmenus[window.__contextmenus.length - 1]);
}

/** Selects the contents of the first element matching `selector`; returns the selected text. */
function select(page, selector) {
  return page.evaluate((selector) => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector(selector));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return String(selection);
  }, selector);
}
const selection = (page) => page.evaluate(() => String(window.getSelection()));

async function useClipboard(page, context) {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(() => navigator.clipboard.writeText('clipboard untouched'));
}
const clipboard = (page) => page.evaluate(() => navigator.clipboard.readText());

const menuBox = (page) => page.evaluate(() => {
  const r = document.querySelector('#context-menu').getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
});

test.beforeEach(async ({ page }) => {
  await openApp(page);
  await instrument(page);
});
test.afterEach(async ({ page }) => { expect(appErrors(page)).toEqual([]); });

/* ---------- Chrome's menu is suppressed everywhere ---------- */

test.describe('the browser context menu is suppressed', () => {
  const PLACES = {
    'the document heading': (page) => view(page).locator('h1'),
    'plain document text': (page) => view(page).locator('p').first(),
    'a link in the document': (page) => view(page).getByRole('link', { name: 'external link' }),
    'an image in the document': (page) => view(page).locator('img[alt="pixel"]'),
    'a code block': (page) => view(page).locator('pre code'),
    'a table cell': (page) => view(page).locator('td').first(),
    'a task-list checkbox': (page) => view(page).locator('li input'),
    'the toolbar': (page) => page.locator('#toolbar'),
    'the File button': (page) => page.locator('#file-menu-btn'),
    'the tab bar': (page) => page.locator('#tabs'),
    'the selected tab': (page) => tab(page, 'sample.md'),
    'another tab': (page) => tab(page, 'second.md'),
    'a tab\'s close button': (page) => page.getByRole('button', { name: 'Close second.md' }),
  };
  for (const [place, locate] of Object.entries(PLACES)) {
    test(`on ${place}`, async ({ page, context }) => {
      await openFiles(page, [{ name: 'sample.md', content: SAMPLE }, { name: 'second.md', content: '# Second' }]);
      const seen = await rightClick(page, locate(page), place === 'the tab bar' ? { position: { x: 600, y: 10 } } : {});
      expect(seen.prevented).toBe(true);
      // The app's own menu is what opens instead, with nothing but its designed items.
      const rows = await menuRows(page);
      expect(rows).toEqual(place === 'a link in the document' ? ['Copy Link Address', '---', ...RELOAD_CLOSE] : RELOAD_CLOSE);
      // A right-click is not a click: nothing was activated, opened or closed.
      expect(await tabs(page)).toEqual({ names: ['sample.md', 'second.md'], active: 'sample.md' });
      expect(context.pages()).toHaveLength(1);
      expect(await page.evaluate(() => window.__marker)).toBe('same page');
      await expect(page.locator('#file-menu')).toBeHidden();
    });
  }

  test('on the document body below a short document', async ({ page }) => {
    await openMarkdown(page, '# Short');
    const seen = await rightClickAt(page, 500, 600);
    expect(seen.prevented).toBe(true);
    expect(await menuRows(page)).toEqual(RELOAD_CLOSE);
  });

  test('on the single-document file name in the toolbar', async ({ page }) => {
    await openMarkdown(page, '# Short');
    expect((await rightClick(page, page.locator('#filename'))).prevented).toBe(true);
    expect(await menuRows(page)).toEqual(RELOAD_CLOSE);
  });

  test('on the empty state, before any file is open', async ({ page }) => {
    for (const locator of [page.locator('#empty h1'), page.locator('#empty p').first(), page.locator('#toolbar'),
      page.locator('#file-menu-btn'), page.locator('#filename')]) {
      expect((await rightClick(page, locator)).prevented).toBe(true);
      expect(await menuRows(page)).toEqual(DISABLED);
    }
    expect((await rightClickAt(page, 900, 650)).prevented).toBe(true);
    expect(await menuRows(page)).toEqual(DISABLED);
  });

  test('inside the open File menu, where it chooses nothing and the app menu replaces the File menu', async ({ page }) => {
    await openFiles(page, [{ name: 'sample.md', content: SAMPLE }, { name: 'second.md', content: '# Second' }]);
    for (const label of ['Open…', 'Recently Viewed', 'Reload', 'Close', 'Close All', 'Exit']) {
      await openFileMenu(page);
      const seen = await rightClick(page, fileMenuItem(page, label));
      expect(seen.prevented, label).toBe(true);
      expect(await menuRows(page), label).toEqual(RELOAD_CLOSE);
      await expect(page.locator('#file-menu')).toBeHidden();
    }
    // None of the File menu items ran.
    expect(await tabs(page)).toEqual({ names: ['sample.md', 'second.md'], active: 'sample.md' });
    expect(await page.evaluate(() => window.__picker)).toBe(0);
    expect(await statusText(page)).toBe('');
  });

  test('inside the open Recently Viewed submenu', async ({ page }) => {
    await openMarkdown(page, SAMPLE, 'sample.md');
    await openFileMenu(page);
    await page.locator('#recent-btn').hover();
    const entry = page.locator('#recent-menu [role="menuitem"]').first();
    await expect(entry).toHaveText('sample.md');
    expect((await rightClick(page, entry)).prevented).toBe(true);
    expect(await menuRows(page)).toEqual(RELOAD_CLOSE);
    await expect(page.locator('#file-menu')).toBeHidden();
  });

  test('on the app\'s own context menu, which stays as it is', async ({ page }) => {
    await openMarkdown(page, SAMPLE);
    await rightClick(page, view(page).getByRole('link', { name: 'external link' }));
    const rows = await menuRows(page);
    const box = await menuBox(page);
    for (const target of [item(page, 'Reload'), item(page, 'Copy Link Address'), menu(page).locator('hr')]) {
      expect((await rightClick(page, target)).prevented).toBe(true);
      expect(await menuRows(page)).toEqual(rows);
      expect(await menuBox(page)).toEqual(box);
    }
    // Right-clicking an item does not choose it.
    await expect(view(page).locator('h1')).toHaveText('Sample');
    expect(await page.locator('#context-menu').count()).toBe(1);
  });

  test('for a contextmenu event from the keyboard or from script, anywhere in the page', async ({ page }) => {
    await openMarkdown(page, SAMPLE);
    const notPrevented = await page.evaluate(() => {
      const out = [];
      for (const selector of ['html', 'body', '#toolbar', '#file-menu-btn', '#file-menu', '#view', '#view a',
        '#view img', '#view pre', '#context-menu']) {
        const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 });
        document.querySelector(selector).dispatchEvent(e);
        if (!e.defaultPrevented) out.push(selector);
      }
      return out;
    });
    expect(notPrevented).toEqual([]);
  });
});

/* ---------- what the menu offers ---------- */

test.describe('menu contents', () => {
  test('no file open: Reload and Close, both disabled, and nothing else', async ({ page }) => {
    await rightClick(page, page.locator('#empty h1'));
    expect(await menuRows(page)).toEqual(DISABLED);
    await expect(menu(page)).toHaveAttribute('role', 'menu');
  });

  test('no file open, text of the empty state selected: Copy plus the two disabled items', async ({ page }) => {
    expect(await select(page, '#empty h1')).toBe('Markdown Viewer');
    await rightClick(page, page.locator('#empty h1'));
    expect(await menuRows(page)).toEqual(['Copy', '---', ...DISABLED]);
  });

  const NO_EXTRAS = {
    'plain text': 'h1',
    'bold text': 'strong',
    'inline code': 'p code',
    'an image (no image items)': 'img[alt="pixel"]',
    'a code block': 'pre code',
    'a table cell': 'td',
    'a table header': 'th',
    'a list item': 'li',
    'a checkbox': 'li input',
  };
  for (const [what, selector] of Object.entries(NO_EXTRAS)) {
    test(`on ${what} without a selection: just Reload and Close`, async ({ page }) => {
      await openMarkdown(page, SAMPLE);
      await rightClick(page, view(page).locator(selector).first());
      expect(await menuRows(page)).toEqual(RELOAD_CLOSE);
    });
  }

  test('on a Mermaid diagram and on typeset math: just Reload and Close', async ({ page }) => {
    await openMarkdown(page, '# D\n\n```mermaid\ngraph TD; A-->B;\n```\n\nInline $x^2$ math.\n');
    await rightClick(page, view(page).locator('.mermaid-diagram svg'));
    expect(await menuRows(page)).toEqual(RELOAD_CLOSE);
    await rightClick(page, view(page).locator('.katex').first());
    expect(await menuRows(page)).toEqual(RELOAD_CLOSE);
  });

  test('on selected text: Copy, separator, Reload, Close', async ({ page }) => {
    await openMarkdown(page, SAMPLE);
    expect(await select(page, '#view strong')).toBe('bold words');
    await rightClick(page, view(page).locator('strong').first());
    expect(await menuRows(page)).toEqual(['Copy', '---', ...RELOAD_CLOSE]);
    expect(await selection(page)).toBe('bold words');
  });

  test('on selected code in a code block: Copy, separator, Reload, Close', async ({ page }) => {
    await openMarkdown(page, SAMPLE);
    await select(page, '#view pre code');
    await rightClick(page, view(page).locator('pre code'), { position: { x: 20, y: 8 } });
    expect(await menuRows(page)).toEqual(['Copy', '---', ...RELOAD_CLOSE]);
  });

  const LINKS = ['external link', 'anchor link', 'relative link', 'mail link'];
  for (const name of LINKS) {
    test(`on the ${name} without a selection: Copy Link Address, separator, Reload, Close`, async ({ page }) => {
      await openMarkdown(page, SAMPLE);
      await rightClick(page, view(page).getByRole('link', { name }));
      expect(await menuRows(page)).toEqual(['Copy Link Address', '---', ...RELOAD_CLOSE]);
    });
  }

  test('on text nested inside a link and on an image inside a link: Copy Link Address is offered', async ({ page }) => {
    await openMarkdown(page, SAMPLE);
    await rightClick(page, view(page).locator('a strong'));
    expect(await menuRows(page)).toEqual(['Copy Link Address', '---', ...RELOAD_CLOSE]);
    await rightClick(page, view(page).locator('a img'));
    expect(await menuRows(page)).toEqual(['Copy Link Address', '---', ...RELOAD_CLOSE]);
  });

  test('on a selected link: Copy, Copy Link Address, separator, Reload, Close - in that order', async ({ page }) => {
    await openMarkdown(page, SAMPLE);
    expect(await select(page, '#view a')).toBe('external link');
    await rightClick(page, view(page).getByRole('link', { name: 'external link' }));
    expect(await menuRows(page)).toEqual(['Copy', 'Copy Link Address', '---', ...RELOAD_CLOSE]);
  });

  test('on the toolbar and on tabs: just Reload and Close', async ({ page }) => {
    await openFiles(page, [{ name: 'sample.md', content: SAMPLE }, { name: 'second.md', content: '# Second' }]);
    for (const target of [page.locator('#file-menu-btn'), tab(page, 'sample.md'), tab(page, 'second.md'),
      page.getByRole('button', { name: 'Close sample.md' })]) {
      await rightClick(page, target);
      expect(await menuRows(page)).toEqual(RELOAD_CLOSE);
    }
  });

  test('a selection inside the toolbar offers Copy but never Copy Link Address', async ({ page }) => {
    await openMarkdown(page, SAMPLE, 'sample.md');
    expect(await select(page, '#filename')).toBe('sample.md');
    await rightClick(page, page.locator('#filename'));
    expect(await menuRows(page)).toEqual(['Copy', '---', ...RELOAD_CLOSE]);
  });

  test('a link in the document does not add Copy Link Address to a right-click elsewhere', async ({ page }) => {
    await openMarkdown(page, SAMPLE);
    for (const target of [view(page).locator('h1'), page.locator('#toolbar'), page.locator('#file-menu-btn')]) {
      await rightClick(page, target);
      expect(await menuRows(page)).toEqual(RELOAD_CLOSE);
    }
  });

  test('a link-like element outside the document is not treated as a document link', async ({ page }) => {
    await openMarkdown(page, SAMPLE);
    // The app has no links of its own in the toolbar; put one there to prove
    // the rule is "a link in the document", not "any link".
    await page.evaluate(() => {
      const a = document.createElement('a');
      a.id = 'test-link';
      a.href = 'https://example.com/toolbar';
      a.textContent = 'toolbar link';
      document.querySelector('#toolbar').append(a);
    });
    await rightClick(page, page.locator('#test-link'));
    expect(await menuRows(page)).toEqual(RELOAD_CLOSE);
  });

  test('Copy is absent for a collapsed selection (a caret)', async ({ page }) => {
    await openMarkdown(page, SAMPLE);
    await page.evaluate(() => {
      const text = document.querySelector('#view strong').firstChild;
      window.getSelection().collapse(text, 3);
    });
    expect(await page.evaluate(() => window.getSelection().rangeCount)).toBe(1);
    await rightClick(page, view(page).locator('strong').first());
    expect(await menuRows(page)).toEqual(RELOAD_CLOSE);
  });

  test('Copy is absent after the selection has been cleared', async ({ page }) => {
    await openMarkdown(page, SAMPLE);
    await select(page, '#view strong');
    await page.evaluate(() => window.getSelection().removeAllRanges());
    await rightClick(page, view(page).locator('strong').first());
    expect(await menuRows(page)).toEqual(RELOAD_CLOSE);
  });

  test('Copy is absent when the right-click lands outside the selection, which Chrome then drops', async ({ page }) => {
    await openMarkdown(page, SAMPLE);
    await select(page, '#view strong');
    await rightClick(page, view(page).locator('td').first());
    // Either the selection survived and Copy is offered, or it is gone and
    // Copy is not: the menu must agree with what is selected.
    const selected = await selection(page);
    expect(await menuRows(page)).toEqual(selected ? ['Copy', '---', ...RELOAD_CLOSE] : RELOAD_CLOSE);
    expect(selected).toBe('');
  });

  test('the menu is rebuilt for every right-click and never accumulates items', async ({ page }) => {
    await openMarkdown(page, SAMPLE);
    const link = view(page).getByRole('link', { name: 'external link' });
    for (let i = 0; i < 3; i++) {
      await rightClick(page, link);
      expect(await menuRows(page)).toEqual(['Copy Link Address', '---', ...RELOAD_CLOSE]);
      await rightClick(page, view(page).locator('h1'));
      expect(await menuRows(page)).toEqual(RELOAD_CLOSE);
    }
  });
});

/* ---------- the items ---------- */

test.describe('Copy', () => {
  test('puts exactly the selected text on the clipboard and keeps the selection', async ({ page, context }) => {
    await openMarkdown(page, SAMPLE);
    await useClipboard(page, context);
    await select(page, '#view strong');
    await rightClick(page, view(page).locator('strong').first());
    expect(await clipboard(page)).toBe('clipboard untouched');   // nothing is copied before Copy is chosen
    await item(page, 'Copy').click();
    await expect.poll(() => clipboard(page)).toBe('bold words');
    await expect(menu(page)).toBeHidden();
    expect(await selection(page)).toBe('bold words');
    expect(await statusText(page)).toBe('');
  });

  test('copies a selection that spans several elements exactly as selected', async ({ page, context }) => {
    await openMarkdown(page, 'Alpha **beta** `gamma` [delta](https://example.com/) epsilon.\n\nSecond paragraph.');
    await useClipboard(page, context);
    const selected = await page.evaluate(() => {
      const range = document.createRange();
      range.setStart(document.querySelector('#view strong').firstChild, 2);
      range.setEnd(document.querySelector('#view a').firstChild, 3);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
      return String(window.getSelection());
    });
    expect(selected).toBe('ta gamma del');
    await rightClick(page, view(page).locator('p code'));
    expect(await menuRows(page)).toEqual(['Copy', '---', ...RELOAD_CLOSE]);
    await item(page, 'Copy').click();
    await expect.poll(() => clipboard(page)).toBe('ta gamma del');
    expect(await selection(page)).toBe('ta gamma del');
  });

  test('copies the text, not the link address, of a selected link', async ({ page, context }) => {
    await openMarkdown(page, SAMPLE);
    await useClipboard(page, context);
    await select(page, '#view a');
    await rightClick(page, view(page).getByRole('link', { name: 'external link' }));
    await item(page, 'Copy').click();
    await expect.poll(() => clipboard(page)).toBe('external link');
  });

  test('copies selected toolbar text', async ({ page, context }) => {
    await openMarkdown(page, SAMPLE, 'sample.md');
    await useClipboard(page, context);
    await select(page, '#filename');
    await rightClick(page, page.locator('#filename'));
    await item(page, 'Copy').click();
    await expect.poll(() => clipboard(page)).toBe('sample.md');
  });

  test('chosen with the keyboard copies the selection too', async ({ page, context }) => {
    await openMarkdown(page, SAMPLE);
    await useClipboard(page, context);
    await select(page, '#view strong');
    await rightClick(page, view(page).locator('strong').first());
    await page.keyboard.press('ArrowDown');
    await expect(item(page, 'Copy')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect.poll(() => clipboard(page)).toBe('bold words');
    await expect(menu(page)).toBeHidden();
    expect(await selection(page)).toBe('bold words');
  });

  test('reports a failure in the status area instead of failing silently', async ({ page }) => {
    await openMarkdown(page, SAMPLE);
    await page.evaluate(() => {
      navigator.clipboard.writeText = () => Promise.reject(new Error('clipboard is broken'));
    });
    await select(page, '#view strong');
    await rightClick(page, view(page).locator('strong').first());
    await item(page, 'Copy').click();
    await expect(page.locator('#status')).toHaveText('Could not copy: clipboard is broken');
  });
});

test.describe('Copy Link Address', () => {
  const ADDRESSES = [
    // [link text, what must be copied, why]
    ['external link', 'https://example.com/Some/Path?q=1#frag', 'the absolute URL of an external link'],
    ['strong text', 'https://example.org/strong', 'the URL of the link around nested text'],
    ['mail link', 'mailto:someone@example.com', 'a mailto: address'],
    ['anchor link', '#sample', 'an #anchor as written, not resolved against the app\'s URL'],
    ['relative link', 'notes/other.md#part', 'a relative link as written, not resolved against the app\'s URL'],
  ];
  for (const [name, address, why] of ADDRESSES) {
    test(`copies ${why}`, async ({ page, context }) => {
      await openMarkdown(page, SAMPLE);
      await useClipboard(page, context);
      await rightClick(page, view(page).getByRole('link', { name }));
      await item(page, 'Copy Link Address').click();
      await expect.poll(() => clipboard(page)).toBe(address);
      await expect(menu(page)).toBeHidden();
      // Copying the address did not follow the link.
      expect(context.pages()).toHaveLength(1);
      expect(await page.evaluate(() => window.__marker)).toBe('same page');
      expect(await statusText(page)).toBe('');
    });
  }

  test('copies the address of the link around an image', async ({ page, context }) => {
    await openMarkdown(page, SAMPLE);
    await useClipboard(page, context);
    await rightClick(page, view(page).locator('a img'));
    await item(page, 'Copy Link Address').click();
    await expect.poll(() => clipboard(page)).toBe('https://example.org/image');
  });

  test('copies the address, not the selected text, when both are offered', async ({ page, context }) => {
    await openMarkdown(page, SAMPLE);
    await useClipboard(page, context);
    await select(page, '#view a');
    await rightClick(page, view(page).getByRole('link', { name: 'external link' }));
    await item(page, 'Copy Link Address').click();
    await expect.poll(() => clipboard(page)).toBe('https://example.com/Some/Path?q=1#frag');
    expect(await selection(page)).toBe('external link');
  });

  test('copies relative links with parent directories, queries and spaces as written', async ({ page, context }) => {
    await openMarkdown(page, '[up](../up/file.md?x=1) and [spaced](<my notes.md>) and [abs](/root.md)');
    await useClipboard(page, context);
    for (const [name, address] of [['up', '../up/file.md?x=1'], ['spaced', 'my%20notes.md'], ['abs', '/root.md']]) {
      await rightClick(page, view(page).getByRole('link', { name }));
      await item(page, 'Copy Link Address').click();
      await expect.poll(() => clipboard(page), name).toBe(address);
    }
  });
});

test.describe('Reload', () => {
  test('re-reads the changed file', async ({ page }) => {
    await openMarkdown(page, '# Before');
    await writeFile(page, 'doc.md', '# After');
    await rightClick(page, view(page).locator('h1'));
    await rerender(page, () => item(page, 'Reload').click());
    await expect(view(page).locator('h1')).toHaveText('After');
    await expect(menu(page)).toBeHidden();
    expect(await page.evaluate(() => window.__marker)).toBe('same page');
  });

  test('re-reads the current file only and keeps the tabs', async ({ page }) => {
    await openFiles(page, [{ name: 'a.md', content: '# A' }, { name: 'b.md', content: '# B' }]);
    await writeFile(page, 'a.md', '# A changed');
    await writeFile(page, 'b.md', '# B changed');
    await rightClick(page, view(page).locator('h1'));
    await rerender(page, () => item(page, 'Reload').click());
    await expect(view(page).locator('h1')).toHaveText('A changed');
    expect(await tabs(page)).toEqual({ names: ['a.md', 'b.md'], active: 'a.md' });
    // b.md was not re-read: it still holds what it held when it was opened.
    await rerender(page, () => tab(page, 'b.md').click());
    await expect(view(page).locator('h1')).toHaveText('B');
  });

  test('opened from a right-click on another tab still reloads the file being shown', async ({ page }) => {
    await openFiles(page, [{ name: 'a.md', content: '# A' }, { name: 'b.md', content: '# B' }]);
    await writeFile(page, 'a.md', '# A changed');
    await rightClick(page, tab(page, 'b.md'));
    await rerender(page, () => item(page, 'Reload').click());
    await expect(view(page).locator('h1')).toHaveText('A changed');
    expect(await tabs(page)).toEqual({ names: ['a.md', 'b.md'], active: 'a.md' });
  });

  test('chosen with the keyboard re-reads the file', async ({ page }) => {
    await openMarkdown(page, '# Before');
    await writeFile(page, 'doc.md', '# After');
    await rightClick(page, view(page).locator('h1'));
    await page.keyboard.press('ArrowDown');
    await expect(item(page, 'Reload')).toBeFocused();
    await rerender(page, () => page.keyboard.press('Enter'));
    await expect(view(page).locator('h1')).toHaveText('After');
  });

  test('says so when the file has disappeared', async ({ page }) => {
    await openMarkdown(page, '# Before');
    await page.evaluate(async () => (await navigator.storage.getDirectory()).removeEntry('doc.md'));
    await rightClick(page, view(page).locator('h1'));
    await item(page, 'Reload').click();
    await expect(page.locator('#status')).toContainText('Could not read doc.md');
    await expect(view(page).locator('h1')).toHaveText('Before');
  });
});

test.describe('Close', () => {
  test('closes the only file and shows the empty state', async ({ page }) => {
    await openMarkdown(page, '# Only');
    await rightClick(page, view(page).locator('h1'));
    await item(page, 'Close').click();
    await expect(page.locator('#empty')).toBeVisible();
    expect(await shownFilename(page)).toBe('No file open');
    await expect(menu(page)).toBeHidden();
    // ... after which the menu offers nothing that can be chosen.
    await rightClick(page, page.locator('#empty h1'));
    expect(await menuRows(page)).toEqual(DISABLED);
  });

  test('closes the current file only', async ({ page }) => {
    await openFiles(page, [{ name: 'a.md', content: '# A' }, { name: 'b.md', content: '# B' }, { name: 'c.md', content: '# C' }]);
    await rerender(page, () => tab(page, 'b.md').click());
    await rightClick(page, view(page).locator('h1'));
    await rerender(page, () => item(page, 'Close').click());
    expect(await tabs(page)).toEqual({ names: ['a.md', 'c.md'], active: 'c.md' });
    await expect(view(page).locator('h1')).toHaveText('C');
  });

  test('opened from a right-click on another tab closes the file being shown, not that tab', async ({ page }) => {
    await openFiles(page, [{ name: 'a.md', content: '# A' }, { name: 'b.md', content: '# B' }, { name: 'c.md', content: '# C' }]);
    await rightClick(page, tab(page, 'c.md'));
    expect(await tabs(page)).toEqual({ names: ['a.md', 'b.md', 'c.md'], active: 'a.md' });
    await rerender(page, () => item(page, 'Close').click());
    expect(await tabs(page)).toEqual({ names: ['b.md', 'c.md'], active: 'b.md' });
  });

  test('chosen with the keyboard closes the current file', async ({ page }) => {
    await openFiles(page, [{ name: 'a.md', content: '# A' }, { name: 'b.md', content: '# B' }]);
    await rightClick(page, view(page).locator('h1'));
    await page.keyboard.press('ArrowUp');          // from nothing, up goes to the last item
    await expect(item(page, 'Close')).toBeFocused();
    await rerender(page, () => page.keyboard.press('Enter'));
    expect(await shownFilename(page)).toBe('b.md');
    await expect(view(page).locator('h1')).toHaveText('B');
  });
});

/* ---------- where it appears ---------- */

test.describe('position', () => {
  test('the menu appears with its corner at the pointer', async ({ page }) => {
    await openMarkdown(page, SAMPLE);
    for (const [x, y] of [[200, 300], [37, 111], [500, 20], [640, 455]]) {
      const seen = await rightClickAt(page, x, y);
      expect(seen).toEqual({ prevented: true, x, y });
      const box = await menuBox(page);
      expect([box.left, box.top]).toEqual([x, y]);
    }
  });

  test('near the right and bottom edges the whole menu stays inside the viewport', async ({ page }) => {
    await openMarkdown(page, SAMPLE);
    const { width, height } = page.viewportSize();
    for (const [x, y] of [[width - 3, 300], [300, height - 3], [width - 3, height - 3], [width - 60, height - 20], [2, height - 2]]) {
      await rightClickAt(page, x, y);
      await expect(menu(page)).toBeVisible();
      const box = await menuBox(page);
      const visible = await page.evaluate(() => ({
        width: document.documentElement.clientWidth, height: document.documentElement.clientHeight,
      }));
      expect(box.left, `left for ${x},${y}`).toBeGreaterThanOrEqual(0);
      expect(box.top, `top for ${x},${y}`).toBeGreaterThanOrEqual(0);
      expect(box.right, `right for ${x},${y}`).toBeLessThanOrEqual(visible.width);
      expect(box.bottom, `bottom for ${x},${y}`).toBeLessThanOrEqual(visible.height);
      // ... and it is moved no further than necessary.
      expect(Math.abs(box.left - Math.min(x, visible.width - box.width - 2))).toBeLessThan(1);
      expect(Math.abs(box.top - Math.min(y, visible.height - box.height - 2))).toBeLessThan(1);
      expect(box.width).toBeGreaterThan(100);
      expect(box.height).toBeGreaterThan(40);
    }
  });

  test('the menu stays inside a very small window', async ({ page }) => {
    await openMarkdown(page, SAMPLE);
    await page.setViewportSize({ width: 260, height: 200 });
    await rightClickAt(page, 255, 195);
    const box = await menuBox(page);
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(260);
    expect(box.bottom).toBeLessThanOrEqual(200);
  });

  test('the menu is positioned against the window, not the document, when the page is scrolled', async ({ page }) => {
    await openMarkdown(page, `# Long\n\n${Array.from({ length: 150 }, (_, i) => `Line ${i}`).join('\n\n')}`);
    await page.evaluate(() => window.scrollTo(0, 2000));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(2000);
    await rightClickAt(page, 300, 400);
    const box = await menuBox(page);
    expect([box.left, box.top]).toEqual([300, 400]);
    expect(await page.evaluate(() => window.scrollY)).toBe(2000);   // opening the menu did not scroll
  });

  test('right-clicking twice shows one menu, at the new position', async ({ page }) => {
    await openMarkdown(page, SAMPLE);
    await rightClickAt(page, 200, 300);
    await rightClickAt(page, 520, 410);
    expect(await page.locator('#context-menu').count()).toBe(1);
    expect(await page.locator('[role="menu"]:visible').count()).toBe(1);
    const box = await menuBox(page);
    expect([box.left, box.top]).toEqual([520, 410]);
    expect(await menuRows(page)).toEqual(RELOAD_CLOSE);
  });

  test('the menu lies on top of the toolbar and the document', async ({ page }) => {
    await openMarkdown(page, SAMPLE);
    await rightClickAt(page, 100, 20);    // on the sticky toolbar
    const box = await menuBox(page);
    const top = await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y).closest('#context-menu'),
      [box.left + box.width / 2, box.top + box.height / 2]);
    expect(top).toBe(true);
  });
});

/* ---------- closing ---------- */

test.describe('the menu closes', () => {
  const LONG = `# Long\n\n[a link](https://example.com/)\n\n${Array.from({ length: 150 }, (_, i) => `Line ${i}`).join('\n\n')}`;

  async function openMenuOnHeading(page) {
    await rightClick(page, view(page).locator('h1'));
    await expect(menu(page)).toBeVisible();
  }

  test('on Escape, without anything else happening', async ({ page }) => {
    await openFiles(page, [{ name: 'a.md', content: LONG }, { name: 'b.md', content: '# B' }]);
    await openMenuOnHeading(page);
    await page.keyboard.press('Escape');
    await expect(menu(page)).toBeHidden();
    expect(await menuRows(page)).toBeNull();
    expect(await tabs(page)).toEqual({ names: ['a.md', 'b.md'], active: 'a.md' });
    await expect(view(page).locator('h1')).toHaveText('Long');
  });

  test('on a click elsewhere in the document', async ({ page }) => {
    await openMarkdown(page, LONG);
    await openMenuOnHeading(page);
    await view(page).locator('p').nth(3).click();
    await expect(menu(page)).toBeHidden();
  });

  test('on a click in the toolbar', async ({ page }) => {
    await openMarkdown(page, LONG);
    await openMenuOnHeading(page);
    await page.locator('#toolbar').click({ position: { x: 700, y: 10 } });
    await expect(menu(page)).toBeHidden();
  });

  test('when the document is scrolled', async ({ page }) => {
    await openMarkdown(page, LONG);
    await openMenuOnHeading(page);
    await page.mouse.move(600, 500);
    await page.mouse.wheel(0, 400);
    await expect(menu(page)).toBeHidden();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  });

  test('when something inside the document is scrolled', async ({ page }) => {
    await openMarkdown(page, `# Wide\n\n\`\`\`\n${'x'.repeat(600)}\n\`\`\`\n`);
    await openMenuOnHeading(page);
    const scrolled = await view(page).locator('pre').evaluate((pre) => {
      pre.scrollLeft = 200;
      return pre.scrollLeft;
    });
    expect(scrolled).toBe(200);
    await expect(menu(page)).toBeHidden();
  });

  test('when the window loses focus', async ({ page }) => {
    await openMarkdown(page, LONG);
    await openMenuOnHeading(page);
    // A headless window cannot really be deactivated; this is the event the
    // browser sends when it is.
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await expect(menu(page)).toBeHidden();
  });

  test('when an item is chosen', async ({ page }) => {
    await openMarkdown(page, LONG);
    await openMenuOnHeading(page);
    await rerender(page, () => item(page, 'Reload').click());
    await expect(menu(page)).toBeHidden();
  });

  test('when the File menu opens', async ({ page }) => {
    await openMarkdown(page, LONG);
    await openMenuOnHeading(page);
    await page.locator('#file-menu-btn').click();
    await expect(page.locator('#file-menu')).toBeVisible();
    await expect(menu(page)).toBeHidden();
    expect(await page.locator('[role="menu"]:visible').count()).toBe(1);
  });

  test('when the File menu is opened without a mouse press', async ({ page }) => {
    await openMarkdown(page, LONG);
    await openMenuOnHeading(page);
    // openMenu() is what the File button runs; called directly so that the
    // button's mouse press is not what closes the context menu.
    await page.evaluate(() => openMenu());
    await expect(page.locator('#file-menu')).toBeVisible();
    await expect(menu(page)).toBeHidden();
  });

  test('and opening it closes the File menu and its submenu', async ({ page }) => {
    await openMarkdown(page, LONG);
    await openFileMenu(page);
    await page.locator('#recent-btn').hover();
    await expect(page.locator('#recent-menu')).toBeVisible();
    await rightClick(page, view(page).locator('p').nth(3));
    await expect(menu(page)).toBeVisible();
    await expect(page.locator('#file-menu')).toBeHidden();
    await expect(page.locator('#recent-menu')).toBeHidden();
    await expect(page.locator('#file-menu-btn')).toHaveAttribute('aria-expanded', 'false');
    expect(await page.locator('[role="menu"]:visible').count()).toBe(1);
  });

  test('and does not stay closed: it can be opened again after each way of closing', async ({ page }) => {
    await openMarkdown(page, LONG);
    for (const close of [
      () => page.keyboard.press('Escape'),
      () => view(page).locator('p').nth(3).click(),
      () => page.evaluate(() => window.dispatchEvent(new Event('blur'))),
    ]) {
      await openMenuOnHeading(page);
      await close();
      await expect(menu(page)).toBeHidden();
    }
    await openMenuOnHeading(page);
    expect(await menuRows(page)).toEqual(RELOAD_CLOSE);
  });

  test('a press on an item does not close the menu before the click arrives', async ({ page }) => {
    await openMarkdown(page, LONG);
    await openMenuOnHeading(page);
    const box = await item(page, 'Reload').boundingBox();
    await page.mouse.move(box.x + 10, box.y + box.height / 2);
    await page.mouse.down();
    await expect(menu(page)).toBeVisible();
    await rerender(page, () => page.mouse.up());
    await expect(menu(page)).toBeHidden();
  });
});

/* ---------- keyboard ---------- */

test.describe('keyboard', () => {
  test('arrow keys walk through the items and wrap around; Enter chooses', async ({ page, context }) => {
    await openMarkdown(page, SAMPLE);
    await useClipboard(page, context);
    await rightClick(page, view(page).getByRole('link', { name: 'anchor link' }));
    // Nothing is chosen until a key is pressed.
    await expect(menu(page)).toBeFocused();
    const order = [];
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('ArrowDown');
      order.push(await page.evaluate(() => document.activeElement.textContent));
    }
    expect(order).toEqual(['Copy Link Address', 'Reload', 'Close', 'Copy Link Address']);
    await page.keyboard.press('ArrowUp');
    await expect(item(page, 'Close')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await expect(item(page, 'Copy Link Address')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect.poll(() => clipboard(page)).toBe('#sample');
    await expect(menu(page)).toBeHidden();
  });

  test('Enter with no item chosen does nothing', async ({ page }) => {
    await openFiles(page, [{ name: 'a.md', content: '# A' }, { name: 'b.md', content: '# B' }]);
    await writeFile(page, 'a.md', '# A changed');
    // Focus a control first: Enter must not reach it through the open menu.
    await page.locator('#file-menu-btn').focus();
    await rightClick(page, view(page).locator('h1'));
    await page.keyboard.press('Enter');
    await expect(menu(page)).toBeVisible();
    await expect(page.locator('#file-menu')).toBeHidden();
    await expect(view(page).locator('h1')).toHaveText('A');
    expect(await tabs(page)).toEqual({ names: ['a.md', 'b.md'], active: 'a.md' });
  });

  test('arrow keys skip disabled items, so with no file open nothing can be chosen', async ({ page }) => {
    await rightClick(page, page.locator('#empty h1'));
    for (const key of ['ArrowDown', 'ArrowDown', 'ArrowUp', 'Enter', 'Space']) await page.keyboard.press(key);
    await expect(menu(page)).toBeVisible();
    await expect(menu(page)).toBeFocused();
    expect(await menuRows(page)).toEqual(DISABLED);
    expect(await statusText(page)).toBe('');
  });

  test('arrow keys move through the menu instead of scrolling the document', async ({ page }) => {
    await openMarkdown(page, `# Long\n\n${Array.from({ length: 150 }, (_, i) => `Line ${i}`).join('\n\n')}`);
    await page.evaluate(() => window.scrollTo(0, 1000));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(1000);
    await rightClickAt(page, 300, 300);
    for (const key of ['ArrowDown', 'ArrowDown', 'ArrowUp']) await page.keyboard.press(key);
    await expect(item(page, 'Reload')).toBeFocused();
    await expect(menu(page)).toBeVisible();
    expect(await page.evaluate(() => window.scrollY)).toBe(1000);
  });

  test('Escape gives the focus back to where it was', async ({ page }) => {
    await openMarkdown(page, SAMPLE);
    await rightClick(page, view(page).locator('h1'));
    const before = await page.evaluate(() => document.activeElement === document.querySelector('#context-menu'));
    expect(before).toBe(true);
    await page.keyboard.press('Escape');
    await expect(menu(page)).toBeHidden();
    expect(await page.evaluate(() => document.querySelector('#context-menu').contains(document.activeElement))).toBe(false);
    // ... and the next Escape or Enter has nothing left to act on.
    await page.keyboard.press('Enter');
    await expect(view(page).locator('h1')).toHaveText('Sample');
  });

  test('while the menu is open r and o are not shortcuts, and other keys do nothing', async ({ page }) => {
    await openMarkdown(page, '# Before');
    await writeFile(page, 'doc.md', '# After');
    await rightClick(page, view(page).locator('h1'));
    for (const key of ['r', 'o', 'x', 'c', 'Delete', 'Backspace', 'F1', 'Control+s', 'ArrowLeft', 'ArrowRight']) {
      await page.keyboard.press(key);
    }
    await expect(menu(page)).toBeVisible();
    expect(await menuRows(page)).toEqual(RELOAD_CLOSE);
    await expect(view(page).locator('h1')).toHaveText('Before');
    expect(await page.evaluate(() => window.__picker)).toBe(0);
    expect(await statusText(page)).toBe('');
  });

  test('the menu key and Shift+F10 are suppressed keystrokes and open nothing', async ({ page }) => {
    await openMarkdown(page, SAMPLE);
    const prevented = await page.evaluate(() => {
      window.__keys = [];
      window.addEventListener('keydown', (e) => { if (e.key !== 'Shift') window.__keys.push(e.defaultPrevented); });
    });
    expect(prevented).toBeUndefined();
    await page.keyboard.press('ContextMenu');
    await page.keyboard.press('Shift+F10');
    await expect.poll(() => page.evaluate(() => window.__keys)).toEqual([true, true]);
    expect(await menuRows(page)).toBeNull();
  });
});

/* ---------- what a right-click must never do ---------- */

test.describe('a right-click never', () => {
  test('follows an external link or opens a window', async ({ page, context }) => {
    await openMarkdown(page, SAMPLE);
    const url = page.url();
    const requests = [];
    page.on('request', (r) => requests.push(r.url()));
    for (const name of ['external link', 'mail link', 'strong text']) {
      await rightClick(page, view(page).getByRole('link', { name }));
    }
    expect(context.pages()).toHaveLength(1);
    expect(page.url()).toBe(url);
    expect(await page.evaluate(() => [window.__marker, history.length])).toEqual(['same page', await page.evaluate(() => history.length)]);
    expect(requests.filter((u) => !u.startsWith(new URL(url).origin))).toEqual([]);
  });

  test('jumps to an anchor', async ({ page }) => {
    await openMarkdown(page, `[to the end](#the-end)\n\n${Array.from({ length: 150 }, (_, i) => `Line ${i}`).join('\n\n')}\n\n# The end`);
    await rightClick(page, view(page).getByRole('link', { name: 'to the end' }));
    await expect(menu(page)).toBeVisible();
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    expect(page.url()).not.toContain('#');
  });

  test('reports a relative link as not followable (only a click does)', async ({ page }) => {
    await openMarkdown(page, SAMPLE);
    await rightClick(page, view(page).getByRole('link', { name: 'relative link' }));
    expect(await statusText(page)).toBe('');
    // Control: a left click on the same link does report it.
    await page.keyboard.press('Escape');
    await view(page).getByRole('link', { name: 'relative link' }).click();
    await expect(page.locator('#status')).toContainText('cannot be followed');
  });

  test('changes the active tab or closes a tab', async ({ page }) => {
    await openFiles(page, [{ name: 'a.md', content: '# A' }, { name: 'b.md', content: '# B' }, { name: 'c.md', content: '# C' }]);
    for (const target of [tab(page, 'b.md'), tab(page, 'c.md'), page.getByRole('button', { name: 'Close b.md' }),
      page.getByRole('button', { name: 'Close a.md' }), tab(page, 'a.md')]) {
      await rightClick(page, target);
      expect(await tabs(page)).toEqual({ names: ['a.md', 'b.md', 'c.md'], active: 'a.md' });
    }
    await expect(view(page).locator('h1')).toHaveText('A');
  });

  test('opens the File menu, the file picker or an item of the File menu', async ({ page }) => {
    await openMarkdown(page, SAMPLE);
    await rightClick(page, page.locator('#file-menu-btn'));
    await expect(page.locator('#file-menu')).toBeHidden();
    await expect(page.locator('#file-menu-btn')).toHaveAttribute('aria-expanded', 'false');
    expect(await page.evaluate(() => window.__picker)).toBe(0);
  });

  test('ticks a task-list checkbox or changes the document', async ({ page }) => {
    await openMarkdown(page, SAMPLE);
    const html = await view(page).innerHTML();
    await rightClick(page, view(page).locator('li input'));
    await rightClick(page, view(page).locator('img[alt="pixel"]'));
    await rightClick(page, view(page).locator('pre code'));
    await page.keyboard.press('Escape');
    expect(await view(page).innerHTML()).toBe(html);
    await expect(view(page).locator('li input')).not.toBeChecked();
  });

  test('copies anything by itself', async ({ page, context }) => {
    await openMarkdown(page, SAMPLE);
    await useClipboard(page, context);
    await select(page, '#view a');
    await rightClick(page, view(page).getByRole('link', { name: 'external link' }));
    await page.keyboard.press('Escape');
    await rightClick(page, view(page).locator('h1'));
    await rerender(page, () => item(page, 'Reload').click());
    expect(await clipboard(page)).toBe('clipboard untouched');
  });

  test('lets a disabled item do anything when it is clicked', async ({ page }) => {
    await rightClick(page, page.locator('#empty h1'));
    expect(await menuRows(page)).toEqual(DISABLED);
    for (const label of ['Reload', 'Close']) {
      await expect(item(page, label)).toBeDisabled();
      await item(page, label).click({ force: true });
      await expect(menu(page)).toBeVisible();
      expect(await menuRows(page)).toEqual(DISABLED);
    }
    await expect(page.locator('#empty')).toBeVisible();
    expect(await statusText(page)).toBe('');
    expect(await shownFilename(page)).toBe('No file open');
  });

  test('offers anything beyond the designed items, whatever is under the pointer', async ({ page }) => {
    await openFiles(page, [{ name: 'sample.md', content: SAMPLE }, { name: 'second.md', content: '# Second' }]);
    const allowed = new Set(['Copy', 'Copy Link Address', '---', 'Reload', 'Close']);
    const seen = new Set();
    // Sweep the whole window, with and without a selection.
    for (const withSelection of [false, true]) {
      for (let y = 10; y < 700; y += 46) {
        for (let x = 15; x < 1000; x += 140) {
          if (withSelection) await select(page, '#view');
          await rightClickAt(page, x, y);
          const rows = await menuRows(page);
          expect(rows, `at ${x},${y}`).not.toBeNull();
          for (const row of rows) seen.add(row);
          expect(rows.slice(-2), `at ${x},${y}`).toEqual(RELOAD_CLOSE);
          expect(rows.filter((r) => !allowed.has(r)), `at ${x},${y}`).toEqual([]);
          expect(rows.length, `at ${x},${y}`).toBe(new Set(rows).size);
          expect(rows.length > 2 ? rows[rows.length - 3] : '---', `at ${x},${y}`).toBe('---');
          await page.keyboard.press('Escape');
        }
      }
    }
    expect([...seen].sort()).toEqual([...allowed].sort());
    expect(await tabs(page)).toEqual({ names: ['sample.md', 'second.md'], active: 'sample.md' });
  });
});
