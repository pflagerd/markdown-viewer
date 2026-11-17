// The File menu: what is in it, how it opens and closes, and what each item does.
const {
  test, expect, openApp, appErrors, writeFile, removeFile, openFiles, openMarkdown,
  view, rerender, statusText, tabs, shownFilename,
  openFileMenu, fileMenuItem, clickFileMenuItem, openRecentMenu,
} = require('./helpers');

test.beforeEach(async ({ page }) => { await openApp(page); });

// Nothing in this file may raise an error in the page, failures included:
// the app has to report those in its status area instead.
test.afterEach(async ({ page }) => { expect(appErrors(page)).toEqual([]); });

const menuButton = (page) => page.locator('#file-menu-btn').first();
const menu = (page) => page.locator('#file-menu').first();
const submenu = (page) => page.locator('#recent-menu').first();
const heading = (page) => view(page).locator('h1');
const scrollY = (page) => page.evaluate(() => window.scrollY);

const doc = (name, title) => ({ name, content: `# ${title}\n\nBody of ${title}.` });
const longDoc = (title) => `# ${title}\n\n${Array.from({ length: 120 }, (_, i) => `Paragraph ${i + 1}`).join('\n\n')}`;

/**
 * Clicks the middle of an element with the mouse exactly where it is now.
 * Unlike locator.click() this never scrolls the page first: Playwright scrolls
 * an element "into view" before acting on it, and because the page has
 * scroll-padding-top that moves the document even for the toolbar, which is
 * always in view. Tests that look at scroll positions must use this.
 */
async function mouseClick(page, locator) {
  const box = await locator.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

// Fixed app bug, kept as regression tests below: the page had
// `html { scroll-padding-top: 5rem }` and the toolbar is sticky at the top,
// i.e. inside that padding. Whenever the app focuses something in the toolbar
// with a plain .focus() - the first menu item when the File menu opens, the
// File button on Escape - Chrome scrolls the document up by several hundred
// pixels to "reveal" it. So merely opening the File menu moves a scrolled
// document, and File > Reload then "keeps" the wrong position.

/** What the user can see of the app's state, for "nothing changed" checks. */
async function snapshot(page) {
  return {
    tabs: await tabs(page),
    filename: await shownFilename(page),
    title: await page.title(),
    status: await statusText(page),
    text: await view(page).innerText(),
  };
}

/**
 * Replaces the native file picker, which a test cannot drive. `behaviour` is
 * { files: [names in the private file system] } or { reject: { name, message } }.
 * Every call is recorded in window.__pickerCalls.
 */
async function stubPicker(page, behaviour) {
  await page.evaluate(async (b) => {
    const dir = await navigator.storage.getDirectory();
    const handles = [];
    for (const name of b.files || []) handles.push(await dir.getFileHandle(name));
    window.__pickerCalls = [];
    window.showOpenFilePicker = async (options) => {
      window.__pickerCalls.push(options);
      if (b.reject) throw new DOMException(b.reject.message, b.reject.name);
      return handles;
    };
  }, behaviour);
}
const pickerCalls = (page) => page.evaluate(() => window.__pickerCalls);

/** Counts calls of the app's reloadActive() in window.__reloads, still running it. */
async function spyOnReload(page) {
  await page.evaluate(() => {
    const original = window.reloadActive;
    if (typeof original !== 'function') throw new Error('the app has no global reloadActive()');
    window.__reloads = 0;
    window.reloadActive = (...args) => { window.__reloads++; return original(...args); };
  });
}
const reloads = (page) => page.evaluate(() => window.__reloads);

/** Replaces window.close() so that Exit cannot really close the test page. */
async function spyOnWindowClose(page) {
  await page.evaluate(() => {
    window.__closeCalls = 0;
    window.close = () => { window.__closeCalls++; };
  });
}
const closeCalls = (page) => page.evaluate(() => window.__closeCalls);

test.describe('toolbar and menu contents', () => {
  test('the toolbar has a File button and no Open or Reload button', async ({ page }) => {
    await expect(menuButton(page)).toBeVisible();
    await expect(menuButton(page)).toHaveText('File');
    const visibleButtons = await page.locator('#toolbar button').evaluateAll((all) => all
      .filter((b) => b.getClientRects().length).map((b) => b.textContent.trim()));
    expect(visibleButtons).toContain('File');
    expect(visibleButtons.filter((t) => /open|reload/i.test(t))).toEqual([]);
    await expect(page.getByRole('button', { name: /open|reload/i })).toHaveCount(0);
  });

  test('there is still no Open or Reload button in the toolbar once a file is open', async ({ page }) => {
    await openFiles(page, [doc('a.md', 'Alpha'), doc('b.md', 'Beta')]);
    // Tab close buttons are called "Close <name>"; nothing is called Open or Reload.
    await expect(page.getByRole('button', { name: /open|reload/i })).toHaveCount(0);
    const direct = await page.locator('#toolbar > button').evaluateAll((all) => all
      .filter((b) => b.getClientRects().length).map((b) => b.textContent.trim()));
    expect(direct.filter((t) => /open|reload/i.test(t))).toEqual([]);
  });

  test('the File menu holds Open…, Recently Viewed, Reload, Close, Close All and Exit in that order, with separators between the groups', async ({ page }) => {
    await openFileMenu(page);
    const layout = await menu(page).evaluate((el) => [...el.children].map((child) => {
      if (child.tagName === 'HR') return '---';
      const item = child.matches('[role="menuitem"]') ? child : child.querySelector('[role="menuitem"]');
      const copy = item.cloneNode(true);
      copy.querySelectorAll('kbd, .arrow').forEach((hint) => hint.remove());
      return copy.textContent.trim();
    }));
    expect(layout).toEqual([
      'Open…', '---', 'Recently Viewed', '---', 'Reload', '---', 'Close', 'Close All', '---', 'Exit',
    ]);
  });

  test('every separator in the File menu is visible', async ({ page }) => {
    await openFileMenu(page);
    const separators = menu(page).locator('> hr');
    await expect(separators).toHaveCount(4);
    for (const hr of await separators.all()) {
      await expect(hr).toBeVisible();
      expect((await hr.boundingBox()).height).toBeGreaterThan(0);
    }
  });

  test('the menu shows the shortcut O next to Open… and F5 next to Reload', async ({ page }) => {
    await openFileMenu(page);
    await expect(fileMenuItem(page, 'Open…').locator('kbd')).toHaveText('O');
    await expect(fileMenuItem(page, 'Reload').locator('kbd')).toHaveText('F5');
  });

  test('with no file open Reload, Close and Close All are disabled and the other items enabled', async ({ page }) => {
    await openFileMenu(page);
    for (const label of ['Reload', 'Close', 'Close All']) await expect(fileMenuItem(page, label)).toBeDisabled();
    for (const label of ['Open…', 'Recently Viewed', 'Exit']) await expect(fileMenuItem(page, label)).toBeEnabled();
  });

  test('with a file open every item is enabled', async ({ page }) => {
    await openMarkdown(page, '# One');
    await openFileMenu(page);
    for (const label of ['Open…', 'Recently Viewed', 'Reload', 'Close', 'Close All', 'Exit']) {
      await expect(fileMenuItem(page, label)).toBeEnabled();
    }
  });

  test('Reload, Close and Close All become disabled again after the last file is closed', async ({ page }) => {
    await openMarkdown(page, '# One');
    await clickFileMenuItem(page, 'Close');
    await expect(heading(page)).toHaveText('Markdown Viewer');
    await openFileMenu(page);
    for (const label of ['Reload', 'Close', 'Close All']) await expect(fileMenuItem(page, label)).toBeDisabled();
  });

  test('clicking a disabled item does nothing and leaves the menu open', async ({ page }) => {
    await spyOnReload(page);
    await openFileMenu(page);
    for (const label of ['Reload', 'Close', 'Close All']) {
      await fileMenuItem(page, label).click({ force: true });
      await expect(menu(page)).toBeVisible();
    }
    expect(await reloads(page)).toBe(0);
    expect(await shownFilename(page)).toBe('No file open');
    expect(await statusText(page)).toBe('');
  });
});

test.describe('opening and closing the menu', () => {
  test('the menu is closed when the app starts', async ({ page }) => {
    await expect(menu(page)).toBeHidden();
    await expect(submenu(page)).toBeHidden();
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(menuButton(page)).toHaveAttribute('aria-haspopup', 'menu');
  });

  test('a click on File opens the menu and a second click closes it', async ({ page }) => {
    await menuButton(page).click();
    await expect(menu(page)).toBeVisible();
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'true');
    await menuButton(page).click();
    await expect(menu(page)).toBeHidden();
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'false');
  });

  test('the menu can be opened again after it was closed', async ({ page }) => {
    for (let round = 0; round < 3; round++) {
      await menuButton(page).click();
      await expect(menu(page)).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(menu(page)).toBeHidden();
    }
  });

  test('opening the menu does not open the Recently Viewed submenu', async ({ page }) => {
    await openFileMenu(page);
    await expect(submenu(page)).toBeHidden();
    await expect(fileMenuItem(page, 'Recently Viewed')).toHaveAttribute('aria-expanded', 'false');
  });

  test('Escape closes the menu and returns focus to the File button', async ({ page }) => {
    await openFileMenu(page);
    await page.keyboard.press('Escape');
    await expect(menu(page)).toBeHidden();
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(menuButton(page)).toBeFocused();
  });

  test('a click outside the menu closes it', async ({ page }) => {
    await openMarkdown(page, '# One\n\nSome text.');
    await openFileMenu(page);
    await view(page).locator('p').click();
    await expect(menu(page)).toBeHidden();
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(heading(page)).toHaveText('One');
  });

  test('a click outside also closes an open Recently Viewed submenu', async ({ page }) => {
    await openMarkdown(page, '# One\n\nSome text.');
    await openRecentMenu(page);
    await view(page).locator('p').click();
    await expect(menu(page)).toBeHidden();
    await expect(submenu(page)).toBeHidden();
    await openFileMenu(page);
    await expect(submenu(page)).toBeHidden();
  });

  test('a click on a separator inside the menu does not close it', async ({ page }) => {
    await openFileMenu(page);
    await menu(page).locator('> hr').first().click({ force: true });
    await expect(menu(page)).toBeVisible();
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'true');
  });

  test('the menu closes when the window loses focus', async ({ page }) => {
    await openRecentMenu(page);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await expect(menu(page)).toBeHidden();
    await expect(submenu(page)).toBeHidden();
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'false');
  });

  test('the menu closes after an item has been chosen', async ({ page }) => {
    await openMarkdown(page, '# One');
    await clickFileMenuItem(page, 'Reload');
    await expect(menu(page)).toBeHidden();
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'false');
  });

  test('opening the menu with the mouse does not scroll the document', async ({ page }) => {
    // Regression: focusing a toolbar element used to scroll the document.
    await openMarkdown(page, longDoc('Long'));
    await page.evaluate(() => window.scrollTo(0, 900));
    await mouseClick(page, menuButton(page));
    await expect(menu(page)).toBeVisible();
    await expect(fileMenuItem(page, 'Open…')).toBeFocused();
    expect(await scrollY(page)).toBe(900);
  });

  test('closing the menu with Escape does not scroll the document', async ({ page }) => {
    // Regression: focusing a toolbar element used to scroll the document.
    await openMarkdown(page, longDoc('Long'));
    await page.evaluate(() => window.scrollTo(0, 900));
    await mouseClick(page, menuButton(page));
    await expect(menu(page)).toBeVisible();
    // Whatever opening did (see the previous test), Escape must not move it further.
    await page.evaluate(() => window.scrollTo(0, 900));
    await page.keyboard.press('Escape');
    await expect(menu(page)).toBeHidden();
    expect(await scrollY(page)).toBe(900);
  });

  test('closing the menu with a click outside does not scroll the document', async ({ page }) => {
    await openMarkdown(page, longDoc('Long'));
    await mouseClick(page, menuButton(page));
    await expect(menu(page)).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 900));
    await page.mouse.click(700, 500);
    await expect(menu(page)).toBeHidden();
    expect(await scrollY(page)).toBe(900);
  });

  test('the open menu lies on top of the document and inside the window', async ({ page }) => {
    await openMarkdown(page, longDoc('Long'));
    await openFileMenu(page);
    const box = await menu(page).boundingBox();
    const viewport = page.viewportSize();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    // The element under the middle of the Exit item is that item, not the document.
    const exit = await fileMenuItem(page, 'Exit').boundingBox();
    const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y).closest('[role="menuitem"]')?.dataset.action,
      [exit.x + exit.width / 2, exit.y + exit.height / 2]);
    expect(hit).toBe('exit');
  });
});

test.describe('keyboard in the menu', () => {
  test('opening the menu puts the focus on its first item', async ({ page }) => {
    await openFileMenu(page);
    await expect(fileMenuItem(page, 'Open…')).toBeFocused();
  });

  test('ArrowDown walks through the enabled items, skips the disabled ones and wraps around', async ({ page }) => {
    await openFileMenu(page);   // no file: Reload, Close, Close All are disabled
    for (const label of ['Recently Viewed', 'Exit', 'Open…', 'Recently Viewed']) {
      await page.keyboard.press('ArrowDown');
      await expect(fileMenuItem(page, label)).toBeFocused();
    }
    await expect(menu(page)).toBeVisible();
  });

  test('ArrowUp walks backwards, skips the disabled items and wraps around', async ({ page }) => {
    await openFileMenu(page);
    for (const label of ['Exit', 'Recently Viewed', 'Open…', 'Exit']) {
      await page.keyboard.press('ArrowUp');
      await expect(fileMenuItem(page, label)).toBeFocused();
    }
  });

  test('with a file open ArrowDown visits all six items in order', async ({ page }) => {
    await openMarkdown(page, '# One');
    await openFileMenu(page);
    for (const label of ['Recently Viewed', 'Reload', 'Close', 'Close All', 'Exit', 'Open…']) {
      await page.keyboard.press('ArrowDown');
      await expect(fileMenuItem(page, label)).toBeFocused();
    }
  });

  test('the arrow keys do not scroll the document while the menu is open', async ({ page }) => {
    await openMarkdown(page, longDoc('Long'));
    await openFileMenu(page);
    for (const key of ['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowUp']) await page.keyboard.press(key);
    await expect(fileMenuItem(page, 'Reload')).toBeFocused();
    expect(await scrollY(page)).toBe(0);
  });

  test('ArrowRight on Recently Viewed enters the submenu and ArrowLeft leaves it', async ({ page }) => {
    await openFiles(page, [doc('a.md', 'Alpha'), doc('b.md', 'Beta')]);
    await openFileMenu(page);
    await page.keyboard.press('ArrowDown');
    await expect(fileMenuItem(page, 'Recently Viewed')).toBeFocused();
    await expect(submenu(page)).toBeHidden();

    await page.keyboard.press('ArrowRight');
    await expect(submenu(page)).toBeVisible();
    await expect(fileMenuItem(page, 'Recently Viewed')).toHaveAttribute('aria-expanded', 'true');
    await expect(submenu(page).getByRole('menuitem').first()).toBeFocused();
    await expect(submenu(page).getByRole('menuitem').first()).toHaveText('b.md');

    await page.keyboard.press('ArrowLeft');
    await expect(submenu(page)).toBeHidden();
    await expect(fileMenuItem(page, 'Recently Viewed')).toHaveAttribute('aria-expanded', 'false');
    await expect(fileMenuItem(page, 'Recently Viewed')).toBeFocused();
    await expect(menu(page)).toBeVisible();
  });

  test('ArrowDown and ArrowUp inside the submenu stay in the submenu and wrap around', async ({ page }) => {
    await openFiles(page, [doc('a.md', 'Alpha'), doc('b.md', 'Beta')]);
    await openFileMenu(page);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowRight');
    const items = submenu(page).getByRole('menuitem');
    await expect(items).toHaveText(['b.md', 'a.md', 'Clear']);
    for (const index of [1, 2, 0]) {
      await page.keyboard.press('ArrowDown');
      await expect(items.nth(index)).toBeFocused();
    }
    for (const index of [2, 1]) {
      await page.keyboard.press('ArrowUp');
      await expect(items.nth(index)).toBeFocused();
    }
    await expect(submenu(page)).toBeVisible();
  });

  test('Escape in the submenu closes only the submenu, a second Escape closes the menu and focuses File', async ({ page }) => {
    await openMarkdown(page, '# One');
    await openFileMenu(page);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowRight');
    await expect(submenu(page).getByRole('menuitem').first()).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(submenu(page)).toBeHidden();
    await expect(menu(page)).toBeVisible();
    await expect(fileMenuItem(page, 'Recently Viewed')).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(menu(page)).toBeHidden();
    await expect(menuButton(page)).toBeFocused();
  });

  test('ArrowRight on an item other than Recently Viewed does not open the submenu', async ({ page }) => {
    await openMarkdown(page, '# One');
    await openFileMenu(page);
    await expect(fileMenuItem(page, 'Open…')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(submenu(page)).toBeHidden();
    await expect(fileMenuItem(page, 'Open…')).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(menu(page)).toBeVisible();
    await expect(fileMenuItem(page, 'Open…')).toBeFocused();
  });

  test('Enter on the focused item chooses it', async ({ page }) => {
    await openFiles(page, [doc('a.md', 'Alpha'), doc('b.md', 'Beta')]);
    await openFileMenu(page);
    for (const label of ['Recently Viewed', 'Reload', 'Close']) {
      await page.keyboard.press('ArrowDown');
      await expect(fileMenuItem(page, label)).toBeFocused();
    }
    await page.keyboard.press('Enter');
    await expect(menu(page)).toBeHidden();
    await expect(heading(page)).toHaveText('Beta');
    expect(await shownFilename(page)).toBe('b.md');
  });

  test('Enter on a Recently Viewed entry reached with the keyboard opens that file', async ({ page }) => {
    await openFiles(page, [doc('a.md', 'Alpha'), doc('b.md', 'Beta')]);
    await clickFileMenuItem(page, 'Close All');
    await expect(heading(page)).toHaveText('Markdown Viewer');
    await openFileMenu(page);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    await expect(submenu(page).getByRole('menuitem').nth(1)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(heading(page)).toHaveText('Alpha');
    await expect(menu(page)).toBeHidden();
    expect(await shownFilename(page)).toBe('a.md');
  });
});

test.describe('Open…', () => {
  test('Open… asks the file picker for several Markdown files and opens what it returns as tabs', async ({ page }) => {
    await writeFile(page, 'a.md', '# Alpha');
    await writeFile(page, 'b.md', '# Beta');
    await stubPicker(page, { files: ['a.md', 'b.md'] });
    await clickFileMenuItem(page, 'Open…');
    await expect(heading(page)).toHaveText('Alpha');
    await expect(menu(page)).toBeHidden();
    expect(await tabs(page)).toEqual({ names: ['a.md', 'b.md'], active: 'a.md' });

    const calls = await pickerCalls(page);
    expect(calls).toHaveLength(1);
    expect(calls[0].multiple).toBe(true);
    expect(calls[0].types).toHaveLength(1);
    expect(calls[0].types[0].description).toMatch(/markdown/i);
    const extensions = Object.values(calls[0].types[0].accept).flat();
    expect(extensions).toEqual(expect.arrayContaining(['.md', '.markdown']));
    expect(Object.keys(calls[0].types[0].accept)).toContain('text/markdown');
  });

  test('Open… with one file picked shows it without a tab bar', async ({ page }) => {
    await writeFile(page, 'solo.md', '# Solo');
    await stubPicker(page, { files: ['solo.md'] });
    await clickFileMenuItem(page, 'Open…');
    await expect(heading(page)).toHaveText('Solo');
    expect(await shownFilename(page)).toBe('solo.md');
    expect(await tabs(page)).toEqual({ names: [], active: null });
  });

  test('Open… adds the picked file as a new tab next to the files already open and shows it', async ({ page }) => {
    await openMarkdown(page, '# First', 'first.md');
    await writeFile(page, 'second.md', '# Second');
    await stubPicker(page, { files: ['second.md'] });
    await clickFileMenuItem(page, 'Open…');
    await expect(heading(page)).toHaveText('Second');
    expect(await tabs(page)).toEqual({ names: ['first.md', 'second.md'], active: 'second.md' });
  });

  test('cancelling the file picker leaves the app unchanged and shows no message', async ({ page }) => {
    await openFiles(page, [doc('a.md', 'Alpha'), doc('b.md', 'Beta')]);
    const before = await snapshot(page);
    await stubPicker(page, { reject: { name: 'AbortError', message: 'The user aborted a request.' } });
    await clickFileMenuItem(page, 'Open…');
    await expect.poll(() => pickerCalls(page)).toHaveLength(1);
    await expect(menu(page)).toBeHidden();
    expect(await snapshot(page)).toEqual(before);
    expect(before.status).toBe('');
  });

  test('cancelling the file picker with no file open keeps the empty state and shows no message', async ({ page }) => {
    await stubPicker(page, { reject: { name: 'AbortError', message: 'The user aborted a request.' } });
    await clickFileMenuItem(page, 'Open…');
    await expect.poll(() => pickerCalls(page)).toHaveLength(1);
    expect(await statusText(page)).toBe('');
    expect(await shownFilename(page)).toBe('No file open');
    await expect(heading(page)).toHaveText('Markdown Viewer');
  });

  test('a file picker that fails is reported in the status area and the app keeps working', async ({ page }) => {
    await openMarkdown(page, '# Kept', 'kept.md');
    await stubPicker(page, { reject: { name: 'SecurityError', message: 'Picker exploded for the test' } });
    await clickFileMenuItem(page, 'Open…');
    await expect(page.locator('#status').first()).toHaveText(/Picker exploded for the test/);
    await expect(heading(page)).toHaveText('Kept');
    expect(await shownFilename(page)).toBe('kept.md');

    // Still usable: the next successful Open works and clears the message.
    await writeFile(page, 'next.md', '# Next');
    await stubPicker(page, { files: ['next.md'] });
    await clickFileMenuItem(page, 'Open…');
    await expect(heading(page)).toHaveText('Next');
    expect(await statusText(page)).toBe('');
    expect(await tabs(page)).toEqual({ names: ['kept.md', 'next.md'], active: 'next.md' });
  });

  test('a file picker that returns no files changes nothing', async ({ page }) => {
    await openMarkdown(page, '# Kept', 'kept.md');
    const before = await snapshot(page);
    await stubPicker(page, { files: [] });
    await clickFileMenuItem(page, 'Open…');
    await expect.poll(() => pickerCalls(page)).toHaveLength(1);
    expect(await snapshot(page)).toEqual(before);
  });

  test('the o key opens the file picker', async ({ page }) => {
    await writeFile(page, 'keyed.md', '# Keyed');
    await stubPicker(page, { files: ['keyed.md'] });
    await page.keyboard.press('o');
    await expect(heading(page)).toHaveText('Keyed');
    expect(await pickerCalls(page)).toHaveLength(1);
    await expect(menu(page)).toBeHidden();
  });

  test('the o key does not open the file picker while the menu is open', async ({ page }) => {
    await writeFile(page, 'keyed.md', '# Keyed');
    await stubPicker(page, { files: ['keyed.md'] });
    await openFileMenu(page);
    await page.keyboard.press('o');
    expect(await pickerCalls(page)).toHaveLength(0);
    await expect(menu(page)).toBeVisible();
    await expect(fileMenuItem(page, 'Open…')).toBeFocused();
    // Control: with the menu closed the same key does reach the picker.
    await page.keyboard.press('Escape');
    await page.keyboard.press('o');
    await expect(heading(page)).toHaveText('Keyed');
    expect(await pickerCalls(page)).toHaveLength(1);
  });

  test('Ctrl+O, Alt+O and Shift+O do not open the file picker', async ({ page }) => {
    await stubPicker(page, { files: [] });
    for (const combo of ['Control+o', 'Alt+o', 'Shift+O']) await page.keyboard.press(combo);
    expect(await pickerCalls(page)).toHaveLength(0);
    await page.keyboard.press('o');   // control
    expect(await pickerCalls(page)).toHaveLength(1);
  });
});

test.describe('Reload', () => {
  test('Reload shows what is now in the file on disk', async ({ page }) => {
    await openMarkdown(page, '# Before\n\nold text', 'note.md');
    await writeFile(page, 'note.md', '# After\n\nnew text');
    await expect(heading(page)).toHaveText('Before');   // not watched: nothing happens by itself
    await rerender(page, () => clickFileMenuItem(page, 'Reload'));
    await expect(heading(page)).toHaveText('After');
    await expect(view(page).locator('p')).toHaveText('new text');
    expect(await shownFilename(page)).toBe('note.md');
    await expect(page).toHaveTitle('note.md');
    expect(await statusText(page)).toBe('');
  });

  test('Reload with the r key keeps the scroll position', async ({ page }) => {
    await openMarkdown(page, longDoc('Before'), 'long.md');
    await page.evaluate(() => window.scrollTo(0, 900));
    expect(await scrollY(page)).toBe(900);
    await writeFile(page, 'long.md', longDoc('After'));
    await rerender(page, () => page.keyboard.press('r'));
    await expect(heading(page)).toHaveText('After');
    expect(await scrollY(page)).toBe(900);
  });

  test('Reload keeps the scroll position when the file became shorter than the old position allows', async ({ page }) => {
    await openMarkdown(page, longDoc('Before'), 'long.md');
    await page.evaluate(() => window.scrollTo(0, 900));
    await writeFile(page, 'long.md', '# Short now');
    await rerender(page, () => page.keyboard.press('r'));
    await expect(heading(page)).toHaveText('Short now');
    await expect(heading(page)).toBeInViewport();
    expect(await statusText(page)).toBe('');
  });

  test('Reload from the File menu keeps the scroll position', async ({ page }) => {
    // Regression: focusing a toolbar element used to scroll the document.
    await openMarkdown(page, longDoc('Before'), 'long.md');
    await page.evaluate(() => window.scrollTo(0, 900));
    await writeFile(page, 'long.md', longDoc('After'));
    await rerender(page, async () => {
      await mouseClick(page, menuButton(page));
      await expect(menu(page)).toBeVisible();
      await mouseClick(page, fileMenuItem(page, 'Reload'));
    });
    await expect(heading(page)).toHaveText('After');
    expect(await scrollY(page)).toBe(900);
  });

  test('Reload re-reads only the current file and keeps the other tabs', async ({ page }) => {
    await openFiles(page, [doc('a.md', 'Alpha'), doc('b.md', 'Beta'), doc('c.md', 'Gamma')]);
    await rerender(page, () => page.locator('#tabs [role="tab"]').nth(1).click());
    await expect(heading(page)).toHaveText('Beta');
    await writeFile(page, 'a.md', '# Alpha changed');
    await writeFile(page, 'b.md', '# Beta changed');
    await rerender(page, () => clickFileMenuItem(page, 'Reload'));
    await expect(heading(page)).toHaveText('Beta changed');
    expect(await tabs(page)).toEqual({ names: ['a.md', 'b.md', 'c.md'], active: 'b.md' });
    // a.md changed on disk too, but it was not the current file.
    await rerender(page, () => page.locator('#tabs [role="tab"]').nth(0).click());
    await expect(heading(page)).toHaveText('Alpha');
  });

  test('Reload of a file that was deleted from disk shows a message and keeps the old content', async ({ page }) => {
    await openMarkdown(page, '# Still here\n\nold text', 'gone.md');
    await removeFile(page, 'gone.md');
    await clickFileMenuItem(page, 'Reload');
    await expect(page.locator('#status').first()).toHaveText(/Could not read gone\.md/);
    await expect(heading(page)).toHaveText('Still here');
    await expect(view(page).locator('p')).toHaveText('old text');
    expect(await shownFilename(page)).toBe('gone.md');
    await expect(menu(page)).toBeHidden();
  });

  test('after a failed Reload the app keeps working and a later successful Reload clears the message', async ({ page }) => {
    await openFiles(page, [doc('gone.md', 'Doomed'), doc('other.md', 'Other')]);
    await removeFile(page, 'gone.md');
    await clickFileMenuItem(page, 'Reload');
    await expect(page.locator('#status').first()).toHaveText(/Could not read gone\.md/);
    expect(await tabs(page)).toEqual({ names: ['gone.md', 'other.md'], active: 'gone.md' });

    await writeFile(page, 'gone.md', '# Back again');
    await rerender(page, () => clickFileMenuItem(page, 'Reload'));
    await expect(heading(page)).toHaveText('Back again');
    expect(await statusText(page)).toBe('');
  });

  test('the r key reloads the current file', async ({ page }) => {
    await openMarkdown(page, '# Before', 'note.md');
    await writeFile(page, 'note.md', '# After');
    await rerender(page, () => page.keyboard.press('r'));
    await expect(heading(page)).toHaveText('After');
  });

  test('the r key does nothing while the menu is open', async ({ page }) => {
    await openMarkdown(page, '# Before', 'note.md');
    await writeFile(page, 'note.md', '# After');
    await spyOnReload(page);
    await openFileMenu(page);
    await page.keyboard.press('r');
    expect(await reloads(page)).toBe(0);
    await expect(menu(page)).toBeVisible();
    await expect(heading(page)).toHaveText('Before');
    // Control: with the menu closed the same key does reload.
    await page.keyboard.press('Escape');
    await rerender(page, () => page.keyboard.press('r'));
    expect(await reloads(page)).toBe(1);
    await expect(heading(page)).toHaveText('After');
  });

  test('the r key with no file open does nothing', async ({ page }) => {
    await page.keyboard.press('r');
    expect(await statusText(page)).toBe('');
    expect(await shownFilename(page)).toBe('No file open');
    await expect(heading(page)).toHaveText('Markdown Viewer');
  });

  test('Shift+R and Alt+R do not reload', async ({ page }) => {
    await openMarkdown(page, '# Before', 'note.md');
    await spyOnReload(page);
    for (const combo of ['Shift+R', 'Alt+r']) await page.keyboard.press(combo);
    expect(await reloads(page)).toBe(0);
    await page.keyboard.press('r');   // control
    expect(await reloads(page)).toBe(1);
  });
});

test.describe('Close and Close All', () => {
  test('Close closes the only file and returns to the empty state', async ({ page }) => {
    await openMarkdown(page, '# One', 'one.md');
    await expect(page).toHaveTitle('one.md');
    await clickFileMenuItem(page, 'Close');
    await expect(heading(page)).toHaveText('Markdown Viewer');
    expect(await shownFilename(page)).toBe('No file open');
    await expect(page).toHaveTitle('Markdown Viewer');
    expect(await tabs(page)).toEqual({ names: [], active: null });
    await expect(view(page)).not.toContainText('One');
  });

  test('Close closes only the current file and keeps the others', async ({ page }) => {
    await openFiles(page, [doc('a.md', 'Alpha'), doc('b.md', 'Beta'), doc('c.md', 'Gamma')]);
    await rerender(page, () => page.locator('#tabs [role="tab"]').nth(1).click());
    await rerender(page, () => clickFileMenuItem(page, 'Close'));
    expect(await tabs(page)).toEqual({ names: ['a.md', 'c.md'], active: 'c.md' });
    await expect(heading(page)).toHaveText('Gamma');
    await expect(page).toHaveTitle('c.md');
  });

  test('Close does not delete or change the file on disk', async ({ page }) => {
    await openMarkdown(page, '# One', 'one.md');
    await clickFileMenuItem(page, 'Close');
    await expect(heading(page)).toHaveText('Markdown Viewer');
    const onDisk = await page.evaluate(async () => {
      const dir = await navigator.storage.getDirectory();
      return (await (await dir.getFileHandle('one.md')).getFile()).text();
    });
    expect(onDisk).toBe('# One');
  });

  test('Close All closes every file and returns to the empty state', async ({ page }) => {
    await openFiles(page, [doc('a.md', 'Alpha'), doc('b.md', 'Beta'), doc('c.md', 'Gamma')]);
    await clickFileMenuItem(page, 'Close All');
    await expect(heading(page)).toHaveText('Markdown Viewer');
    expect(await shownFilename(page)).toBe('No file open');
    await expect(page).toHaveTitle('Markdown Viewer');
    expect(await tabs(page)).toEqual({ names: [], active: null });
    await expect(page.locator('#tabs').first()).toBeHidden();
    await expect(page.locator('#tabs [role="tab"]')).toHaveCount(0);
    await expect(view(page)).not.toContainText('Alpha');
  });

  test('a file can be opened again after Close All', async ({ page }) => {
    await openFiles(page, [doc('a.md', 'Alpha'), doc('b.md', 'Beta')]);
    await clickFileMenuItem(page, 'Close All');
    await expect(heading(page)).toHaveText('Markdown Viewer');
    await openFiles(page, [doc('b.md', 'Beta')]);
    await expect(heading(page)).toHaveText('Beta');
    expect(await shownFilename(page)).toBe('b.md');
    expect(await tabs(page)).toEqual({ names: [], active: null });
  });

  test('Close All scrolls nowhere strange: the empty state starts at the top', async ({ page }) => {
    await openMarkdown(page, longDoc('Long'), 'long.md');
    await page.evaluate(() => window.scrollTo(0, 900));
    await clickFileMenuItem(page, 'Close All');
    await expect(heading(page)).toHaveText('Markdown Viewer');
    await expect(heading(page)).toBeInViewport();
  });
});

test.describe('Exit', () => {
  test('Exit asks the window to close', async ({ page }) => {
    await spyOnWindowClose(page);
    await clickFileMenuItem(page, 'Exit');
    await expect.poll(() => closeCalls(page)).toBe(1);
    await expect(menu(page)).toBeHidden();
  });

  test('Exit works with files open and tells the user when the window could not be closed', async ({ page }) => {
    await openFiles(page, [doc('a.md', 'Alpha'), doc('b.md', 'Beta')]);
    await spyOnWindowClose(page);
    await clickFileMenuItem(page, 'Exit');
    await expect.poll(() => closeCalls(page)).toBe(1);
    // The spy never closes the window, which is what Chrome does for a window
    // script may not close; the app must say so rather than do nothing.
    await expect(page.locator('#status').first()).toHaveText(/cannot be closed/);
    expect(await tabs(page)).toEqual({ names: ['a.md', 'b.md'], active: 'a.md' });
  });

  test('no other menu item and no shortcut closes the window', async ({ page }) => {
    await openFiles(page, [doc('a.md', 'Alpha'), doc('b.md', 'Beta')]);
    await writeFile(page, 'c.md', '# Gamma');
    await stubPicker(page, { files: ['c.md'] });
    await spyOnWindowClose(page);
    await clickFileMenuItem(page, 'Open…');
    await expect(heading(page)).toHaveText('Gamma');
    await rerender(page, () => clickFileMenuItem(page, 'Reload'));
    await rerender(page, () => clickFileMenuItem(page, 'Close'));
    await clickFileMenuItem(page, 'Close All');
    await expect(heading(page)).toHaveText('Markdown Viewer');
    await openFileMenu(page);
    await page.keyboard.press('Escape');
    for (const key of ['r', 'x', 'q', 'Escape']) await page.keyboard.press(key);
    expect(await closeCalls(page)).toBe(0);
  });
});
