// Keyboard gate: the viewer answers to its designed-in keys and suppresses
// (preventDefault) every other keystroke.
//
// What can and cannot be asserted here
// ------------------------------------
// Keys are pressed for real with page.keyboard.press(), so the page sees
// trusted keydown events and Chromium runs their in-page default actions
// (scrolling, focus movement, select all, copy, button activation).
// Browser-level actions - the find bar, the print dialog, zoom, dev tools,
// reloading or leaving the page, history navigation - are NOT triggered by
// synthetic input in headless Chromium, whether or not the page suppresses
// the key. For those keys the assertable thing is therefore whether the
// keydown was defaultPrevented: "not suppressed" for Ctrl+F, Ctrl+P and the
// zoom keys, "suppressed" for everything that is not designed in. The
// negative tests additionally check that nothing observable changed (same
// page, same document, same tabs, same history length, same focus, scroll
// position and selection, no status message), which does catch every
// in-page effect.
//
// F5 and Ctrl+R are defaultPrevented by design: the app handles them itself
// (re-reads the file) and thereby keeps the browser from reloading the page.
// For those the effect is asserted instead.
//
// Ctrl+W, Ctrl+N, Ctrl+T and Alt+F4 never reach a page in a real browser and
// are not part of these tables.
const {
  test, expect, openApp, openFiles, writeFile, rerender, appErrors, view, tabs, tab,
  openFileMenu, fileMenuItem,
} = require('./helpers');

const longDoc = (title) => `# ${title}\n\n${
  Array.from({ length: 120 }, (_, i) => `Paragraph ${i} of ${title}.`).join('\n\n')}\n`;

/* ---------- the tables ---------- */

// Designed-in keys, as page.keyboard.press() names. `combo` is what the app's
// keyCombo() must call the key. `handled` marks the two keys the app itself
// preventDefaults (see above). `effect` is what the key must visibly do when
// pressed with focus on the page body of a long two-tab document that is
// scrolled to the middle.
const ALLOWED = [
  { key: 'F5', combo: 'F5', handled: true, effect: 'reload' },
  { key: 'Control+r', combo: 'Ctrl+r', handled: true, effect: 'reload' },
  { key: 'r', combo: 'r', effect: 'reload' },
  { key: 'o', combo: 'o', effect: 'picker' },
  { key: 'ArrowUp', combo: 'ArrowUp', effect: 'up' },
  { key: 'ArrowDown', combo: 'ArrowDown', effect: 'down' },
  { key: 'ArrowLeft', combo: 'ArrowLeft' },
  { key: 'ArrowRight', combo: 'ArrowRight' },
  { key: 'Enter', combo: 'Enter' },
  { key: 'Escape', combo: 'Escape' },
  { key: 'Tab', combo: 'Tab', effect: 'focus-first' },
  { key: 'Shift+Tab', combo: 'Shift+Tab', effect: 'focus-last' },
  { key: 'PageUp', combo: 'PageUp', effect: 'up' },
  { key: 'PageDown', combo: 'PageDown', effect: 'down' },
  { key: 'Home', combo: 'Home', effect: 'top' },
  { key: 'End', combo: 'End', effect: 'bottom' },
  { key: 'Space', combo: 'Space', effect: 'down' },
  { key: 'Shift+Space', combo: 'Shift+Space', effect: 'up' },
  { key: 'Control+Home', combo: 'Ctrl+Home', effect: 'top' },
  { key: 'Control+End', combo: 'Ctrl+End', effect: 'bottom' },
  { key: 'Control+c', combo: 'Ctrl+c', effect: 'copy' },
  { key: 'Control+a', combo: 'Ctrl+a', effect: 'select-all' },
  { key: 'Control+f', combo: 'Ctrl+f' },
  { key: 'Control+p', combo: 'Ctrl+p' },
  { key: 'Control+Equal', combo: 'Ctrl+=' },
  { key: 'Control+Shift+Equal', combo: 'Ctrl+Shift++' },   // "+" on a US layout
  { key: 'Control+NumpadAdd', combo: 'Ctrl++' },
  { key: 'Control+Minus', combo: 'Ctrl+-' },
  { key: 'Control+NumpadSubtract', combo: 'Ctrl+-' },
  { key: 'Control+0', combo: 'Ctrl+0' },
  // Playwright's Numpad0 is the key with NumLock off (key "Insert").
  { key: 'Control+Numpad0', combo: 'Ctrl+0' },
  // Lone modifiers
  { key: 'Control', combo: 'Ctrl+Control' },
  { key: 'Shift', combo: 'Shift+Shift' },
  { key: 'Alt', combo: 'Alt+Alt' },
  { key: 'Meta', combo: 'Meta+Meta' },
  { key: 'CapsLock', combo: 'CapsLock' },
];

// Allowed only in dev-tools mode.
const DEVTOOLS = ['F12', 'Control+Shift+i', 'Control+Shift+j', 'Control+Shift+c', 'Control+Shift+r', 'Control+F5'];

const letters = (skip) => [...'abcdefghijklmnopqrstuvwxyz'].filter((c) => !skip.includes(c));

// Everything else: a large sample of keys and browser shortcuts that are not
// designed in, by group. Includes the dev-tools keys (the default is "off").
const BLOCKED = {
  'function keys': ['F1', 'F2', 'F3', 'F4', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
    'Shift+F5', 'Alt+F5', 'Control+F5', 'Control+Shift+F5', 'Shift+F3', 'Shift+F10', 'Control+F12'],
  'page reload, dev tools and view source': ['Control+Shift+r', 'Control+Shift+i', 'Control+Shift+j',
    'Control+Shift+c', 'Control+u', 'Control+Alt+r', 'Control+Alt+i', 'Control+Shift+m'],
  'browser Ctrl shortcuts': ['Control+s', 'Control+o', 'Control+g', 'Control+h', 'Control+j', 'Control+l',
    'Control+d', 'Control+e', 'Control+k', 'Control+b', 'Control+i', 'Control+m', 'Control+q',
    'Control+Shift+Delete', 'Control+Shift+b', 'Control+Shift+o', 'Control+Shift+a', 'Control+Shift+d',
    'Control+Shift+g', 'Control+Shift+p', 'Control+Shift+f', 'Control+Shift+s', 'Control+Shift+z',
    'Control+Shift+v', 'Control+Tab', 'Control+Shift+Tab', 'Control+PageUp', 'Control+PageDown',
    'Control+1', 'Control+2', 'Control+5', 'Control+9', 'Control+Shift+0', 'Control+Space'],
  'editing': ['Control+x', 'Control+v', 'Control+z', 'Control+y', 'Control+Enter', 'Shift+Enter',
    'Backspace', 'Shift+Backspace', 'Control+Backspace', 'Delete', 'Shift+Delete', 'Control+Delete',
    'Insert', 'Shift+Insert', 'Control+Insert'],
  'history and Alt combinations': ['Alt+ArrowLeft', 'Alt+ArrowRight', 'Alt+ArrowUp', 'Alt+ArrowDown',
    'Alt+Home', 'Alt+Enter', 'Alt+d', 'Alt+e', 'Alt+f', 'Alt+o', 'Alt+r', 'Alt+c', 'Alt+a',
    'Alt+Shift+i', 'Alt+Shift+t', 'Alt+Backspace'],
  'Shift and Ctrl variants of the navigation keys': ['Shift+ArrowUp', 'Shift+ArrowDown', 'Shift+ArrowLeft',
    'Shift+ArrowRight', 'Shift+Home', 'Shift+End', 'Shift+PageUp', 'Shift+PageDown', 'Shift+Escape',
    'Control+ArrowUp', 'Control+ArrowDown', 'Control+ArrowLeft', 'Control+ArrowRight',
    'Control+Shift+ArrowLeft', 'Control+Shift+ArrowRight', 'Control+Shift+Home', 'Control+Shift+End',
    'Control+Escape', 'Control+Shift+Space'],
  'letters other than o and r': [...letters('or'), 'Shift+o', 'Shift+r', 'Shift+a', 'Shift+z'],
  'digits and punctuation': ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'Slash', 'Quote', 'Period',
    'Comma', 'Semicolon', 'Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash', 'Backquote',
    'Shift+Slash', 'Shift+Equal', 'Shift+1', 'NumpadAdd', 'NumpadSubtract', 'Numpad0', 'NumpadMultiply',
    'Control+NumpadMultiply', 'Control+Shift+Numpad0'],
  'Meta combinations and the menu key': ['Meta+a', 'Meta+c', 'Meta+r', 'Meta+o', 'Meta+f', 'Meta+p',
    'Meta+ArrowLeft', 'Meta+Enter', 'Meta+Shift+s', 'Control+Meta+r', 'Meta+Equal', 'ContextMenu'],
};
const ALL_BLOCKED = [...new Set(Object.values(BLOCKED).flat())];

/* ---------- helpers ---------- */

/**
 * Starts observing keydown the way the browser's own default handling sees
 * it: in the bubble phase on window, after every listener of the app.
 * Also marks the page (a reload would lose the mark) and stubs the two things
 * a key must never be able to open for real in a test.
 */
async function instrument(page) {
  await page.evaluate(() => {
    window.__marker = 'same page';
    window.__keylog = [];
    window.addEventListener('keydown', (e) => window.__keylog.push({
      combo: keyCombo(e), key: e.key, code: e.code, prevented: e.defaultPrevented,
    }));
    window.__picker = 0;
    window.showOpenFilePicker = async () => {
      window.__picker++;
      throw new DOMException('cancelled by the test', 'AbortError');
    };
    window.__printed = 0;
    window.print = () => { window.__printed++; };   // Ctrl+P must not be able to hang a test
  });
}

/**
 * Presses a key for real and returns what the page saw for the last keydown
 * of the combination: { combo, key, code, prevented }.
 */
async function press(page, key) {
  const downs = key.split('+').length;   // one keydown per modifier, one for the key
  await page.evaluate(() => { window.__keylog.length = 0; });
  await page.keyboard.press(key);
  await page.waitForFunction((n) => window.__keylog.length >= n, downs);
  return page.evaluate(() => window.__keylog[window.__keylog.length - 1]);
}

/** Everything a stray keystroke could conceivably change. */
function state(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    return {
      marker: window.__marker,
      url: location.href,
      history: history.length,
      title: document.title,
      document: document.querySelector('#view').innerHTML,
      tabs: [...document.querySelectorAll('#tabs [role="tab"]')]
        .map((t) => (t.getAttribute('aria-selected') === 'true' ? '*' : '') + t.querySelector('span').textContent),
      filename: document.querySelector('#filename').textContent,
      status: document.querySelector('#status').textContent,
      fileMenuOpen: !document.querySelector('#file-menu').hidden,
      recentMenuOpen: !document.querySelector('#recent-menu').hidden,
      contextMenuOpen: !document.querySelector('#context-menu').hidden,
      focus: el === document.body ? 'body' : `${el.tagName}#${el.id}[${el.textContent.trim()}]`,
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY),
      selection: String(window.getSelection()),
      pickerCalls: window.__picker,
      printCalls: window.__printed,
      bodyChildren: document.body.children.length,
    };
  });
}

/**
 * Presses every key of `keys` and returns a list of complaints: keys that
 * were not suppressed, and keys after which something had changed.
 * `reset` (optional) restores the starting situation after a key that did
 * change something, so one failure does not cascade.
 */
async function pressAllExpectingNothing(page, keys, reset) {
  const problems = [];
  let before = await state(page);
  for (const key of keys) {
    const seen = await press(page, key);
    if (!seen.prevented) problems.push(`${key} (${seen.combo}) was not suppressed`);
    const after = await state(page);
    const changed = Object.keys(before).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    if (changed.length) {
      problems.push(`${key} (${seen.combo}) changed ${changed.map((k) =>
        (k === 'document' ? k : `${k}: ${JSON.stringify(before[k])} -> ${JSON.stringify(after[k])}`)).join(', ')}`);
      if (reset) await reset();
      before = await state(page);
    }
  }
  return problems;
}

/**
 * Two long documents in two tabs, one.md showing, scrolled to the middle.
 * one.md is then changed on disk, so that any (unwanted) re-read of the file
 * would show up as a different document.
 */
async function openTwoLongDocuments(page) {
  await openFiles(page, [
    { name: 'one.md', content: longDoc('One') },
    { name: 'two.md', content: longDoc('Two') },
  ]);
  await instrument(page);
  // Resolves once the page has been told about the scroll (a frame later).
  await page.evaluate(() => new Promise((resolve) => {
    window.addEventListener('scroll', () => requestAnimationFrame(resolve), { once: true });
    window.scrollTo(0, 1500);
  }));
  expect(await page.evaluate(() => Math.round(window.scrollY))).toBe(1500);
  await writeFile(page, 'one.md', longDoc('Changed'));
}

const scrollY = (page) => page.evaluate(() => Math.round(window.scrollY));
const maxScrollY = (page) => page.evaluate(() =>
  Math.round(document.documentElement.scrollHeight - document.documentElement.clientHeight));

/* ---------- default mode (the test server answers {"devtools":false}) ---------- */

test.describe('designed-in keys', () => {
  test.beforeEach(async ({ page }) => { await openApp(page); });
  test.afterEach(async ({ page }) => { expect(appErrors(page)).toEqual([]); });

  for (const { key, combo, handled, effect } of ALLOWED) {
    const what = {
      reload: 're-reads the changed file without reloading the page',
      picker: 'opens the file picker',
      up: 'scrolls up',
      down: 'scrolls down',
      top: 'scrolls to the top',
      bottom: 'scrolls to the bottom',
      'focus-first': 'moves focus to the first control',
      'focus-last': 'moves focus to the last control',
      copy: 'copies the selection to the clipboard',
      'select-all': 'selects the whole page',
    }[effect];
    const title = handled
      ? `${key} is handled by the app and ${what}`
      : `${key} is not suppressed${what ? ` and ${what}` : ''}`;

    test(title, async ({ page, context }) => {
      await openTwoLongDocuments(page);
      const tabsBefore = await tabs(page);
      if (effect === 'copy') {
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        await page.evaluate(async () => {
          await navigator.clipboard.writeText('not copied yet');
          const range = document.createRange();
          range.selectNodeContents(document.querySelector('#view h1'));
          window.getSelection().removeAllRanges();
          window.getSelection().addRange(range);
        });
      }

      let seen;
      if (effect === 'reload') await rerender(page, async () => { seen = await press(page, key); });
      else seen = await press(page, key);

      expect(seen.combo).toBe(combo);
      // F5 and Ctrl+R: the app prevents the browser's page reload itself.
      expect(seen.prevented).toBe(!!handled);

      if (effect === 'reload') {
        await expect(view(page).locator('h1')).toHaveText('Changed');
      } else if (effect === 'picker') {
        await expect.poll(() => page.evaluate(() => window.__picker)).toBe(1);
      } else if (effect === 'up') {
        await expect.poll(() => scrollY(page)).toBeLessThan(1500);
      } else if (effect === 'down') {
        await expect.poll(() => scrollY(page)).toBeGreaterThan(1500);
      } else if (effect === 'top') {
        await expect.poll(() => scrollY(page)).toBe(0);
      } else if (effect === 'bottom') {
        const max = await maxScrollY(page);
        expect(max).toBeGreaterThan(1500);
        await expect.poll(() => scrollY(page)).toBe(max);
      } else if (effect === 'focus-first') {
        await expect(page.locator('#file-menu-btn')).toBeFocused();
      } else if (effect === 'focus-last') {
        await expect(page.getByRole('button', { name: 'Close two.md' })).toBeFocused();
      } else if (effect === 'copy') {
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('One');
      } else if (effect === 'select-all') {
        await expect.poll(() => page.evaluate(() => String(window.getSelection())))
          .toContain('Paragraph 119 of One.');
      }

      // Whatever the key did, it is still the same page with the same tabs.
      expect(await page.evaluate(() => window.__marker)).toBe('same page');
      expect(await tabs(page)).toEqual(tabsBefore);
      if (effect !== 'reload') await expect(view(page).locator('h1')).toHaveText('One');
      if (effect !== 'picker') expect(await page.evaluate(() => window.__picker)).toBe(0);
    });
  }

  test('with CapsLock on, R still reloads the file and O still opens the picker', async ({ page }) => {
    await openTwoLongDocuments(page);
    // CapsLock cannot be toggled through the test keyboard; this is the event
    // it produces: an upper-case key without Shift.
    const fire = (key) => page.evaluate((key) => document.body.dispatchEvent(new KeyboardEvent('keydown', {
      key, code: `Key${key}`, bubbles: true, cancelable: true,
    })), key);
    expect(await fire('O')).toBe(true);    // dispatchEvent() is true when not prevented
    await expect.poll(() => page.evaluate(() => window.__picker)).toBe(1);
    let notPrevented;
    await rerender(page, async () => { notPrevented = await fire('R'); });
    expect(notPrevented).toBe(true);
    await expect(view(page).locator('h1')).toHaveText('Changed');
  });

  test('Ctrl+mouse wheel (zoom) is not suppressed', async ({ page }) => {
    await openTwoLongDocuments(page);
    await page.evaluate(() => {
      window.__wheels = [];
      window.addEventListener('wheel', (e) => window.__wheels.push({ ctrl: e.ctrlKey, prevented: e.defaultPrevented }));
    });
    await page.mouse.move(400, 400);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -240);
    await page.keyboard.up('Control');
    await expect.poll(() => page.evaluate(() => window.__wheels)).toEqual([{ ctrl: true, prevented: false }]);
  });

  test('the plain mouse wheel is not suppressed and scrolls the document', async ({ page }) => {
    await openTwoLongDocuments(page);
    await page.evaluate(() => {
      window.__wheels = [];
      window.addEventListener('wheel', (e) => window.__wheels.push({ ctrl: e.ctrlKey, prevented: e.defaultPrevented }));
    });
    await page.mouse.move(400, 400);
    await page.mouse.wheel(0, 300);
    await expect.poll(() => scrollY(page)).toBeGreaterThan(1500);
    expect(await page.evaluate(() => window.__wheels)).toEqual([{ ctrl: false, prevented: false }]);
  });

  test('Enter on the focused File button opens the menu, arrows move through it, Escape closes it', async ({ page }) => {
    await openTwoLongDocuments(page);
    await page.locator('#file-menu-btn').focus();
    expect((await press(page, 'Enter')).prevented).toBe(false);
    await expect(page.locator('#file-menu')).toBeVisible();
    await expect(fileMenuItem(page, 'Open…')).toBeFocused();
    await press(page, 'ArrowDown');
    await expect(fileMenuItem(page, 'Recently Viewed')).toBeFocused();
    await press(page, 'ArrowUp');
    await expect(fileMenuItem(page, 'Open…')).toBeFocused();
    await press(page, 'ArrowUp');
    await expect(fileMenuItem(page, 'Exit')).toBeFocused();
    await press(page, 'Escape');
    await expect(page.locator('#file-menu')).toBeHidden();
    await expect(page.locator('#file-menu-btn')).toBeFocused();
  });

  test('Space on the focused File button opens the menu', async ({ page }) => {
    await openTwoLongDocuments(page);
    await page.locator('#file-menu-btn').focus();
    expect((await press(page, 'Space')).prevented).toBe(false);
    await expect(page.locator('#file-menu')).toBeVisible();
    await expect(fileMenuItem(page, 'Open…')).toBeFocused();
  });

  for (const key of ['Enter', 'Space']) {
    test(`opening the File menu with ${key} does not scroll the document`, async ({ page }) => {
      // Regression: focusing a menu item inside the sticky toolbar used to make
      // Chromium scroll the document by several hundred pixels.
      await openTwoLongDocuments(page);
      await page.evaluate(() => {
        window.__scrolls = 0;
        window.addEventListener('scroll', () => { window.__scrolls++; });
      });
      await page.locator('#file-menu-btn').focus();
      await press(page, key);
      await expect(fileMenuItem(page, 'Open…')).toBeFocused();
      await press(page, 'ArrowDown');
      await expect(fileMenuItem(page, 'Recently Viewed')).toBeFocused();
      // Two frames, so that a scroll caused by the focus change would have been reported.
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      expect(await scrollY(page)).toBe(1500);
      expect(await page.evaluate(() => window.__scrolls)).toBe(0);
    });
  }

  test('Enter on a menu item chooses it', async ({ page }) => {
    await openTwoLongDocuments(page);
    await openFileMenu(page);
    await fileMenuItem(page, 'Close').focus();
    await rerender(page, () => press(page, 'Enter'));
    await expect(page.locator('#file-menu')).toBeHidden();
    await expect(view(page).locator('h1')).toHaveText('Two');
  });

  test('ArrowRight opens Recently Viewed from its menu item and ArrowLeft closes it again', async ({ page }) => {
    await openTwoLongDocuments(page);
    await openFileMenu(page);
    await fileMenuItem(page, 'Recently Viewed').focus();
    await press(page, 'ArrowRight');
    await expect(page.locator('#recent-menu')).toBeVisible();
    await expect(page.locator('#recent-menu [role="menuitem"]').first()).toBeFocused();
    await press(page, 'ArrowLeft');
    await expect(page.locator('#recent-menu')).toBeHidden();
    await expect(fileMenuItem(page, 'Recently Viewed')).toBeFocused();
  });

  for (const key of ['Enter', 'Space']) {
    test(`${key} on a focused tab switches to that tab`, async ({ page }) => {
      await openTwoLongDocuments(page);
      await tab(page, 'two.md').focus();
      await rerender(page, () => press(page, key));
      expect(await tabs(page)).toEqual({ names: ['one.md', 'two.md'], active: 'two.md' });
      await expect(view(page).locator('h1')).toHaveText('Two');
    });
  }

  test('Tab and Shift+Tab walk through the toolbar controls in both directions', async ({ page }) => {
    await openTwoLongDocuments(page);
    const focus = () => page.evaluate(() => {
      const el = document.activeElement;
      return el.getAttribute('aria-label') || el.title || el.textContent.trim();
    });
    const order = [];
    for (let i = 0; i < 5; i++) {
      expect((await press(page, 'Tab')).prevented).toBe(false);
      order.push(await focus());
    }
    expect(order).toEqual(['File', 'one.md', 'Close one.md', 'two.md', 'Close two.md']);
    const back = [];
    for (let i = 0; i < 4; i++) {
      expect((await press(page, 'Shift+Tab')).prevented).toBe(false);
      back.push(await focus());
    }
    expect(back).toEqual(['two.md', 'Close one.md', 'one.md', 'File']);
  });

  test('r and o keep working while a toolbar control has focus', async ({ page }) => {
    await openTwoLongDocuments(page);
    await page.locator('#file-menu-btn').focus();
    expect((await press(page, 'o')).prevented).toBe(false);
    await expect.poll(() => page.evaluate(() => window.__picker)).toBe(1);
    await tab(page, 'two.md').focus();
    await rerender(page, () => press(page, 'r'));
    await expect(view(page).locator('h1')).toHaveText('Changed');
    expect(await tabs(page)).toEqual({ names: ['one.md', 'two.md'], active: 'one.md' });
  });

  test('scrolling keys still scroll while a toolbar control has focus', async ({ page }) => {
    await openTwoLongDocuments(page);
    await page.locator('#file-menu-btn').focus();
    expect((await press(page, 'PageDown')).prevented).toBe(false);
    await expect.poll(() => scrollY(page)).toBeGreaterThan(1500);
    expect((await press(page, 'Control+Home')).prevented).toBe(false);
    await expect.poll(() => scrollY(page)).toBe(0);
  });

  test('F5 and Ctrl+R re-read the file while the File menu is open, and never reload the page', async ({ page }) => {
    await openTwoLongDocuments(page);
    await openFileMenu(page);
    let seen;
    await rerender(page, async () => { seen = await press(page, 'F5'); });
    expect(seen.prevented).toBe(true);
    await expect(view(page).locator('h1')).toHaveText('Changed');
    await writeFile(page, 'one.md', longDoc('Changed again'));
    await rerender(page, async () => { seen = await press(page, 'Control+r'); });
    expect(seen.prevented).toBe(true);
    await expect(view(page).locator('h1')).toHaveText('Changed again');
    expect(await page.evaluate(() => window.__marker)).toBe('same page');
  });

  test('reload keys with no file open do nothing and raise no error', async ({ page }) => {
    await instrument(page);
    const before = await state(page);
    expect((await press(page, 'F5')).prevented).toBe(true);
    expect((await press(page, 'Control+r')).prevented).toBe(true);
    expect((await press(page, 'r')).prevented).toBe(false);
    expect(await state(page)).toEqual(before);
  });

  test('the app knows exactly the designed-in keys, no more and no fewer', async ({ page }) => {
    const known = await page.evaluate(() => ({ allowed: [...ALLOWED_KEYS].sort(), devtools: [...DEVTOOLS_KEYS].sort() }));
    expect(known.allowed).toEqual([
      'F5', 'Ctrl+r', 'r', 'o',
      'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Escape', 'Tab', 'Shift+Tab',
      'PageUp', 'PageDown', 'Home', 'End', 'Space', 'Shift+Space', 'Ctrl+Home', 'Ctrl+End',
      'Ctrl+c', 'Ctrl+a', 'Ctrl+f', 'Ctrl+p',
      'Ctrl++', 'Ctrl+Shift++', 'Ctrl+=', 'Ctrl+-', 'Ctrl+0',
    ].sort());
    expect(known.devtools).toEqual(
      ['F12', 'Ctrl+Shift+i', 'Ctrl+Shift+j', 'Ctrl+Shift+c', 'Ctrl+Shift+r', 'Ctrl+F5'].sort());
  });
});

test.describe('every other keystroke', () => {
  test.beforeEach(async ({ page }) => { await openApp(page); });
  test.afterEach(async ({ page }) => { expect(appErrors(page)).toEqual([]); });

  for (const [group, keys] of Object.entries(BLOCKED)) {
    test(`${group} are suppressed and leave page, document, tabs and history untouched (${keys.length} keys)`, async ({ page, context }) => {
      await openTwoLongDocuments(page);
      // A selection that Shift+arrows would extend and Delete/Ctrl+X would act on.
      await page.evaluate(() => {
        const range = document.createRange();
        range.selectNodeContents(document.querySelector('#view h1'));
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
      });
      expect(await pressAllExpectingNothing(page, keys)).toEqual([]);
      // No window or tab was opened either.
      expect(context.pages()).toHaveLength(1);
      // The file changed on disk was never re-read.
      await expect(view(page).locator('h1')).toHaveText('One');
      expect(await tabs(page)).toEqual({ names: ['one.md', 'two.md'], active: 'one.md' });
    });
  }

  test('suppressed keys are suppressed before any file is open', async ({ page, context }) => {
    await instrument(page);
    await expect(page.locator('#empty')).toBeVisible();
    expect(await pressAllExpectingNothing(page, ALL_BLOCKED)).toEqual([]);
    await expect(page.locator('#empty')).toBeVisible();
    expect(context.pages()).toHaveLength(1);
  });

  test('designed-in keys are let through before any file is open', async ({ page }) => {
    await instrument(page);
    const wrong = [];
    for (const { key, combo, handled } of ALLOWED) {
      const seen = await press(page, key);
      if (seen.combo !== combo || seen.prevented !== !!handled) wrong.push(`${key}: ${JSON.stringify(seen)}`);
    }
    expect(wrong).toEqual([]);
    expect(await page.evaluate(() => window.__marker)).toBe('same page');
  });

  test('suppressed keys are suppressed while the File button has focus', async ({ page }) => {
    await openTwoLongDocuments(page);
    const fileButton = page.locator('#file-menu-btn');
    await fileButton.focus();
    expect(await pressAllExpectingNothing(page, ALL_BLOCKED, () => fileButton.focus())).toEqual([]);
    // In particular Ctrl+Enter, Shift+Enter and Ctrl+Space did not press the button.
    await expect(page.locator('#file-menu')).toBeHidden();
  });

  // Keys that the app's own listeners act on although the gate suppresses
  // them: the gate only cancels the browser's default action, the event still
  // reaches the tab's and the menus' keydown handlers, and those do not look
  // at the modifiers they should. See the regression tests below.
  const ENTER_VARIANTS = ['Control+Enter', 'Shift+Enter', 'Alt+Enter', 'Meta+Enter', 'Control+Space', 'Control+Shift+Space'];
  const MENU_VARIANTS = ['Shift+ArrowUp', 'Shift+ArrowDown', 'Shift+Escape'];

  test('suppressed keys are suppressed while a tab has focus', async ({ page }) => {
    await openTwoLongDocuments(page);
    const other = tab(page, 'two.md');
    await other.focus();
    const keys = ALL_BLOCKED.filter((k) => !ENTER_VARIANTS.includes(k));
    expect(await pressAllExpectingNothing(page, keys, () => other.focus())).toEqual([]);
    expect(await tabs(page)).toEqual({ names: ['one.md', 'two.md'], active: 'one.md' });
  });

  test('modified Enter and Space on a focused tab are suppressed', async ({ page }) => {
    await openTwoLongDocuments(page);
    await tab(page, 'two.md').focus();
    for (const key of ENTER_VARIANTS) expect((await press(page, key)).prevented, key).toBe(true);
  });

  test('modified Enter and Space on a focused tab do not switch tabs', async ({ page }) => {
    // APP BUG: the tab's keydown handler activates the tab for any Enter or
    // Space, whatever the modifiers, so Ctrl+Enter, Shift+Enter, Alt+Enter,
    // Meta+Enter, Ctrl+Space and Ctrl+Shift+Space - none of them designed-in
    // keys - switch tabs.
    // Regression test for a fixed app bug.
    await openTwoLongDocuments(page);
    const acted = [];
    for (const key of ENTER_VARIANTS) {
      await page.evaluate(() => activate(0));
      await expect.poll(async () => (await tabs(page)).active).toBe('one.md');
      await tab(page, 'two.md').focus();
      await press(page, key);
      if ((await tabs(page)).active !== 'one.md') acted.push(key);
    }
    expect(acted).toEqual([]);
  });

  test('suppressed keys are suppressed inside the open File menu and leave it open', async ({ page }) => {
    await openTwoLongDocuments(page);
    await openFileMenu(page);
    await expect(fileMenuItem(page, 'Open…')).toBeFocused();
    const keys = ALL_BLOCKED.filter((k) => !MENU_VARIANTS.includes(k));
    const reset = async () => { await openFileMenu(page); await fileMenuItem(page, 'Open…').focus(); };
    expect(await pressAllExpectingNothing(page, keys, reset)).toEqual([]);
    await expect(page.locator('#file-menu')).toBeVisible();
    await expect(fileMenuItem(page, 'Open…')).toBeFocused();
    // Ctrl+Enter and Shift+Enter did not choose "Open…".
    expect(await page.evaluate(() => window.__picker)).toBe(0);
  });

  test('Shift+Arrow and Shift+Escape inside the open File menu are suppressed', async ({ page }) => {
    await openTwoLongDocuments(page);
    for (const key of MENU_VARIANTS) {
      await openFileMenu(page);
      expect((await press(page, key)).prevented, key).toBe(true);
    }
  });

  test('Shift+Arrow and Shift+Escape do not operate the open File menu', async ({ page }) => {
    // APP BUG: the menu keydown handler ignores Ctrl/Alt/Meta combinations but
    // not Shift, so Shift+ArrowDown/Up move through the menu and Shift+Escape
    // closes it, although none of them is a designed-in key.
    // Regression test for a fixed app bug.
    await openTwoLongDocuments(page);
    const acted = [];
    for (const key of MENU_VARIANTS) {
      await openFileMenu(page);
      await fileMenuItem(page, 'Open…').focus();
      await press(page, key);
      const open = await page.locator('#file-menu').isVisible();
      const onFirst = open && await fileMenuItem(page, 'Open…').evaluate((el) => el === document.activeElement);
      if (!open || !onFirst) acted.push(key);
    }
    expect(acted).toEqual([]);
  });

  test('r and o typed inside the open File menu neither reload nor open the picker', async ({ page }) => {
    await openTwoLongDocuments(page);
    await openFileMenu(page);
    const before = await state(page);
    await press(page, 'r');
    await press(page, 'o');
    expect(await state(page)).toEqual(before);
  });

  test('typing a sentence puts no text anywhere and shows no status message', async ({ page }) => {
    await openTwoLongDocuments(page);
    const before = await state(page);
    const text = await page.evaluate(() => document.body.innerText);
    // No "o" and no "r": those are shortcuts.
    await page.keyboard.type('The quick, lazy fat cat sat with 123 ducks!?');
    await page.waitForFunction(() => window.__keylog.some((k) => k.key === '?'));
    const log = await page.evaluate(() => window.__keylog.filter((k) => k.key !== 'Shift'));
    expect(log.filter((k) => !k.prevented && k.key !== ' ').map((k) => k.key)).toEqual([]);
    // Space is a scrolling key, so only the scroll position may differ.
    const after = await state(page);
    expect({ ...after, scrollY: 0 }).toEqual({ ...before, scrollY: 0 });
    expect(await page.evaluate(() => document.body.innerText)).toBe(text);
    expect(await page.locator('input, textarea, [contenteditable]').count()).toBe(0);
  });

  // An independent statement of the rule, checked against far more
  // combinations than can be pressed one by one: every combination of the
  // four modifiers with every key below, as keydown events dispatched in the
  // page (isTrusted does not matter to the gate).
  test('exactly the designed-in combinations pass the gate, over all modifier combinations of 169 keys', async ({ page }) => {
    await instrument(page);
    const mismatches = await page.evaluate(() => {
      const designed = new Set([
        'F5', 'Ctrl+r', 'r', 'o',
        'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Escape', 'Tab', 'Shift+Tab',
        'PageUp', 'PageDown', 'Home', 'End', 'Space', 'Shift+Space', 'Ctrl+Home', 'Ctrl+End',
        'Ctrl+c', 'Ctrl+a', 'Ctrl+f', 'Ctrl+p',
        'Ctrl++', 'Ctrl+Shift++', 'Ctrl+=', 'Ctrl+-', 'Ctrl+0',
      ]);
      // The app itself cancels these two (it re-reads the file instead).
      const handled = new Set(['F5', 'Ctrl+r']);
      const keys = [
        ...'abcdefghijklmnopqrstuvwxyz', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', ...'0123456789',
        ...'`~!@#$%^&*()-_=+[]{}\\|;:\'",<.>/?', ' ', 'é', 'ß', 'я',
        ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
        'Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown',
        'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ContextMenu', 'PrintScreen', 'Pause', 'Help',
        'Clear', 'Cancel', 'Copy', 'Cut', 'Paste', 'Undo', 'Redo', 'Find', 'Print', 'Save', 'Open', 'Close',
        'New', 'ZoomIn', 'ZoomOut', 'BrowserBack', 'BrowserForward', 'BrowserRefresh', 'BrowserStop',
        'BrowserHome', 'BrowserSearch', 'BrowserFavorites', 'LaunchMail', 'LaunchApplication1',
        'MediaPlayPause', 'AudioVolumeMute', 'Dead', 'Process', 'Unidentified',
      ];
      const out = [];
      let count = 0;
      for (const key of keys) {
        for (let m = 0; m < 16; m++) {
          const ctrlKey = !!(m & 1), altKey = !!(m & 2), shiftKey = !!(m & 4), metaKey = !!(m & 8);
          const name = (ctrlKey ? 'Ctrl+' : '') + (altKey ? 'Alt+' : '') + (shiftKey ? 'Shift+' : '')
            + (metaKey ? 'Meta+' : '') + (key === ' ' ? 'Space' : key.length === 1 ? key.toLowerCase() : key);
          const e = new KeyboardEvent('keydown', {
            key, ctrlKey, altKey, shiftKey, metaKey, bubbles: true, cancelable: true,
          });
          document.body.dispatchEvent(e);
          count++;
          const allowed = designed.has(name);
          if (isAllowedKey(e) !== allowed) out.push(`isAllowedKey(${name}) is ${!allowed}`);
          if (keyCombo(e) !== name) out.push(`keyCombo gives ${keyCombo(e)} for ${name}`);
          const prevented = !allowed || handled.has(name);
          if (e.defaultPrevented !== prevented) out.push(`${name}: defaultPrevented is ${e.defaultPrevented}`);
        }
      }
      return { count, out };
    });
    expect(mismatches.out).toEqual([]);
    expect(mismatches.count).toBe(169 * 16);
    expect(await page.evaluate(() => window.__marker)).toBe('same page');
  });

  test('the numeric keypad zooms with Ctrl whatever NumLock makes the keys produce, and only with Ctrl alone', async ({ page }) => {
    const result = await page.evaluate(() => {
      const fire = (init) => {
        const e = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true });
        document.body.dispatchEvent(e);
        return e.defaultPrevented;
      };
      const table = [
        // [event, suppressed?]
        [{ code: 'NumpadAdd', key: '+', ctrlKey: true }, false],
        [{ code: 'NumpadSubtract', key: '-', ctrlKey: true }, false],
        [{ code: 'Numpad0', key: '0', ctrlKey: true }, false],
        [{ code: 'Numpad0', key: 'Insert', ctrlKey: true }, false],      // NumLock off
        [{ code: 'Numpad0', key: 'Insert' }, true],
        [{ code: 'Numpad0', key: '0' }, true],
        [{ code: 'NumpadAdd', key: '+' }, true],
        [{ code: 'NumpadSubtract', key: '-' }, true],
        [{ code: 'Numpad0', key: 'Insert', ctrlKey: true, shiftKey: true }, true],
        [{ code: 'Numpad0', key: '0', ctrlKey: true, altKey: true }, true],
        [{ code: 'NumpadAdd', key: '+', ctrlKey: true, altKey: true }, true],
        [{ code: 'NumpadSubtract', key: '-', ctrlKey: true, metaKey: true }, true],
        [{ code: 'NumpadMultiply', key: '*', ctrlKey: true }, true],
        [{ code: 'NumpadDivide', key: '/', ctrlKey: true }, true],
        [{ code: 'NumpadDecimal', key: 'Delete', ctrlKey: true }, true],
        [{ code: 'Numpad1', key: 'End', ctrlKey: true }, false],         // that is Ctrl+End
        [{ code: 'Numpad1', key: '1', ctrlKey: true }, true],
        [{ code: 'Numpad5', key: 'Clear', ctrlKey: true }, true],
      ];
      return table.filter(([init, suppressed]) => fire(init) !== suppressed).map(([init]) => JSON.stringify(init));
    });
    expect(result).toEqual([]);
  });

  test('modifier and lock keys pressed on their own are never suppressed, whatever else is held', async ({ page }) => {
    const suppressed = await page.evaluate(() => {
      const out = [];
      for (const key of ['Control', 'Shift', 'Alt', 'AltGraph', 'Meta', 'OS', 'CapsLock', 'NumLock',
        'ScrollLock', 'Fn', 'FnLock', 'Hyper', 'Super', 'Symbol', 'SymbolLock']) {
        for (let m = 0; m < 16; m++) {
          const e = new KeyboardEvent('keydown', {
            key, ctrlKey: !!(m & 1), altKey: !!(m & 2), shiftKey: !!(m & 4), metaKey: !!(m & 8),
            bubbles: true, cancelable: true,
          });
          document.body.dispatchEvent(e);
          if (e.defaultPrevented) out.push(`${key} with modifier mask ${m}`);
        }
      }
      return out;
    });
    expect(suppressed).toEqual([]);
  });

  test('a suppressed key is suppressed wherever in the page it is aimed', async ({ page }) => {
    await openFiles(page, [
      { name: 'one.md', content: '# One\n\n[link](https://example.com/)\n\n```js\nlet x = 1;\n```\n\n- [ ] task\n' },
      { name: 'two.md', content: '# Two' },
    ]);
    const notSuppressed = await page.evaluate(() => {
      const out = [];
      for (const selector of ['html', 'body', '#toolbar', '#file-menu-btn', '#file-menu', '#filename', '#status',
        '#tabs', '#tabs [role="tab"]', '#tabs .tab-close', '#view', '#view h1', '#view a', '#view pre code',
        '#view input', '#context-menu']) {
        const el = document.querySelector(selector);
        for (const init of [{ key: 'F1' }, { key: 's', ctrlKey: true }, { key: 'x' }, { key: 'Backspace' }]) {
          const e = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true });
          el.dispatchEvent(e);
          if (!e.defaultPrevented) out.push(`${JSON.stringify(init)} on ${selector}`);
        }
      }
      // Not even a listener that stops the event early can get in before the gate.
      const e = new KeyboardEvent('keydown', { key: 'F1', cancelable: true });
      window.dispatchEvent(e);
      if (!e.defaultPrevented) out.push('F1 on window');
      return out;
    });
    expect(notSuppressed).toEqual([]);
  });
});

/* ---------- dev-tools mode ---------- */

test.describe('dev-tools mode', () => {
  test.afterEach(async ({ page }) => { expect(appErrors(page)).toEqual([]); });

  /**
   * Answers GET /api/config with `answer(route)` and opens the app.
   * Also lets the test wait, with configSettled(), until the app has dealt
   * with the answer: the page's fetch is wrapped (the app is untouched) so
   * that a promise resolves one task after the config response, or its JSON
   * body, or the failure, has been delivered - by then the app's own promise
   * callbacks, which are microtasks, have run.
   */
  async function openAppWithConfig(page, answer) {
    await page.addInitScript(() => {
      const realFetch = window.fetch;
      window.__configSettled = new Promise((resolve) => {
        const done = () => setTimeout(resolve, 0);
        window.fetch = function fetch(...args) {
          const response = realFetch.apply(this, args);
          if (!String(args[0]).includes('/api/config')) return response;
          return response.then((res) => {
            const realJson = res.json.bind(res);
            res.json = () => { const body = realJson(); body.then(done, done); return body; };
            if (!res.ok) done();
            return res;
          }, (err) => { done(); throw err; });
        };
      });
    });
    await page.route('**/api/config', answer);
    await openApp(page);
    await instrument(page);
  }
  const configSettled = (page) => page.evaluate(() => window.__configSettled);
  const enabled = (page) => page.evaluate(() => devtoolsEnabled);

  async function suppressedOf(page, keys) {
    const out = [];
    for (const key of keys) if ((await press(page, key)).prevented) out.push(key);
    return out;
  }

  test('with {"devtools":true} exactly the six dev-tools keys are let through as well', async ({ page }) => {
    await openAppWithConfig(page, (route) => route.fulfill({ json: { devtools: true } }));
    await configSettled(page);
    expect(await enabled(page)).toBe(true);
    await openTwoLongDocuments(page);

    expect(await suppressedOf(page, DEVTOOLS)).toEqual([]);
    // Ctrl+F5 and Ctrl+Shift+R are let through to the browser; they are not
    // turned into "re-read the file".
    await expect(view(page).locator('h1')).toHaveText('One');

    const others = ALL_BLOCKED.filter((k) => !DEVTOOLS.includes(k));
    expect(others.length).toBe(ALL_BLOCKED.length - 6);
    expect(await pressAllExpectingNothing(page, others)).toEqual([]);
  });

  test('with {"devtools":true} the designed-in keys keep working', async ({ page }) => {
    await openAppWithConfig(page, (route) => route.fulfill({ json: { devtools: true } }));
    await configSettled(page);
    const wrong = [];
    for (const { key, combo, handled } of ALLOWED) {
      const seen = await press(page, key);
      if (seen.combo !== combo || seen.prevented !== !!handled) wrong.push(`${key}: ${JSON.stringify(seen)}`);
    }
    expect(wrong).toEqual([]);
    await openTwoLongDocuments(page);
    await rerender(page, () => press(page, 'F5'));
    await expect(view(page).locator('h1')).toHaveText('Changed');
  });

  test('in dev-tools mode the gate still follows the rule over all modifier combinations', async ({ page }) => {
    await openAppWithConfig(page, (route) => route.fulfill({ json: { devtools: true } }));
    await configSettled(page);
    const result = await page.evaluate(() => {
      const extra = new Set(['F12', 'Ctrl+Shift+i', 'Ctrl+Shift+j', 'Ctrl+Shift+c', 'Ctrl+Shift+r', 'Ctrl+F5']);
      const let_through = [];
      for (const key of ['F12', 'F5', 'F11', 'i', 'j', 'c', 'r', 'I', 'J', 'C', 'R', 'u', 'k', 'm']) {
        for (let m = 0; m < 16; m++) {
          const ctrlKey = !!(m & 1), altKey = !!(m & 2), shiftKey = !!(m & 4), metaKey = !!(m & 8);
          const name = (ctrlKey ? 'Ctrl+' : '') + (altKey ? 'Alt+' : '') + (shiftKey ? 'Shift+' : '')
            + (metaKey ? 'Meta+' : '') + (key.length === 1 ? key.toLowerCase() : key);
          const e = new KeyboardEvent('keydown', {
            key, ctrlKey, altKey, shiftKey, metaKey, bubbles: true, cancelable: true,
          });
          document.body.dispatchEvent(e);
          if (!e.defaultPrevented && extra.has(name)) let_through.push(name);
          else if (!e.defaultPrevented && !['r', 'Ctrl+c'].includes(name)) let_through.push(`UNEXPECTED ${name}`);
        }
      }
      return [...new Set(let_through)].sort();
    });
    expect(result).toEqual(['Ctrl+F5', 'Ctrl+Shift+c', 'Ctrl+Shift+i', 'Ctrl+Shift+j', 'Ctrl+Shift+r', 'F12']);
  });

  test('the real server\'s answer {"devtools":false} keeps the dev-tools keys suppressed', async ({ page }) => {
    // Not routed: this is the test server (node server.js --headless) answering.
    let body = null;
    page.on('response', async (res) => {
      if (res.url().endsWith('/api/config')) body = await res.json().catch(() => 'unreadable');
    });
    await openApp(page);
    await expect.poll(() => body).toEqual({ devtools: false });
    await instrument(page);
    expect(await enabled(page)).toBe(false);
    expect(await suppressedOf(page, DEVTOOLS)).toEqual(DEVTOOLS);
  });

  const NOT_ENABLING = {
    '{"devtools":false}': (route) => route.fulfill({ json: { devtools: false } }),
    'a request that fails': (route) => route.abort(),
    'a request that is refused': (route) => route.abort('connectionrefused'),
    '404 Not Found': (route) => route.fulfill({ status: 404, contentType: 'text/plain', body: '404 Not Found\n' }),
    '404 with a body saying {"devtools":true}': (route) => route.fulfill({ status: 404, json: { devtools: true } }),
    '500 with a body saying {"devtools":true}': (route) => route.fulfill({ status: 500, json: { devtools: true } }),
    'invalid JSON': (route) => route.fulfill({ contentType: 'application/json', body: '{"devtools":tru' }),
    'an empty body': (route) => route.fulfill({ contentType: 'application/json', body: '' }),
    'an HTML page': (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><p>devtools: true' }),
    '{"devtools":"yes"}': (route) => route.fulfill({ json: { devtools: 'yes' } }),
    '{"devtools":"true"}': (route) => route.fulfill({ json: { devtools: 'true' } }),
    '{"devtools":1}': (route) => route.fulfill({ json: { devtools: 1 } }),
    '{"devtools":{}}': (route) => route.fulfill({ json: { devtools: {} } }),
    '{"devtools":[true]}': (route) => route.fulfill({ json: { devtools: [true] } }),
    '{"devtools":null}': (route) => route.fulfill({ json: { devtools: null } }),
    '{"DevTools":true}': (route) => route.fulfill({ json: { DevTools: true } }),
    '{}': (route) => route.fulfill({ json: {} }),
    'null': (route) => route.fulfill({ contentType: 'application/json', body: 'null' }),
    'true': (route) => route.fulfill({ contentType: 'application/json', body: 'true' }),
    '[{"devtools":true}]': (route) => route.fulfill({ json: [{ devtools: true }] }),
  };
  for (const [name, answer] of Object.entries(NOT_ENABLING)) {
    test(`/api/config answering ${name} leaves the dev-tools keys suppressed`, async ({ page }) => {
      await openAppWithConfig(page, answer);
      await configSettled(page);
      expect(await enabled(page)).toBe(false);
      expect(await suppressedOf(page, DEVTOOLS)).toEqual(DEVTOOLS);
      // ... and the designed-in keys are unaffected by the odd answer.
      expect(await suppressedOf(page, ['r', 'o', 'Tab', 'Control+a', 'Control+f', 'PageDown'])).toEqual([]);
    });
  }

  test('until /api/config has answered the dev-tools keys are suppressed, afterwards they are not', async ({ page }) => {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    let asked = false;
    await openAppWithConfig(page, async (route) => {
      asked = true;
      await held;
      await route.fulfill({ json: { devtools: true } });
    });
    // The app is up and has asked, but has no answer yet.
    expect(asked).toBe(true);
    expect(await enabled(page)).toBe(false);
    expect(await suppressedOf(page, DEVTOOLS)).toEqual(DEVTOOLS);
    expect(await suppressedOf(page, ['r', 'Tab', 'Control+f'])).toEqual([]);

    release();
    await configSettled(page);
    expect(await enabled(page)).toBe(true);
    expect(await suppressedOf(page, DEVTOOLS)).toEqual([]);
  });

  test('the app asks for /api/config exactly once, with a GET', async ({ page }) => {
    const requests = [];
    await openAppWithConfig(page, (route) => {
      requests.push(route.request());
      return route.fulfill({ json: { devtools: false } });
    });
    await configSettled(page);
    expect(requests).toHaveLength(1);
    expect(requests[0].method()).toBe('GET');
  });
});
