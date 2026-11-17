// Several documents in one window: the tab bar.
const {
  test, expect, openApp, appErrors, writeFile, openFiles, openMarkdown,
  view, rerender, statusText, tabs, tab, shownFilename, clickFileMenuItem,
} = require('./helpers');

test.beforeEach(async ({ page }) => { await openApp(page); });

// Failed reads included: they belong in the status area, not in the console.
test.afterEach(async ({ page }) => { expect(appErrors(page)).toEqual([]); });

const tabBar = (page) => page.locator('#tabs').first();
const filename = (page) => page.locator('#filename').first();
const status = (page) => page.locator('#status').first();
const heading = (page) => view(page).locator('h1');
const closeButton = (page, name) => tab(page, name).locator('.tab-close');
const scrollY = (page) => page.evaluate(() => window.scrollY);
const scrollTo = (page, y) => page.evaluate((y) => window.scrollTo(0, y), y);

const doc = (name, title) => ({ name, content: `# ${title}\n\nBody of ${title}.` });
const longDoc = (name, title) => ({
  name,
  content: `# ${title}\n\n${Array.from({ length: 120 }, (_, i) => `${title} paragraph ${i + 1}`).join('\n\n')}`,
});
const ABC = [doc('a.md', 'Alpha'), doc('b.md', 'Beta'), doc('c.md', 'Gamma')];

/**
 * Clicks the middle of an element with the mouse exactly where it is now.
 * Unlike locator.click() this never scrolls the page first: Playwright scrolls
 * an element "into view" before acting on it, and because the page has
 * scroll-padding-top that moves the document even for the toolbar, which is
 * always in view. Tests that look at scroll positions must use this.
 */
async function mouseClick(page, locator, options = {}) {
  const box = await locator.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, options);
}

/** Switches to a tab with a mouse click and waits for its document. */
const switchTo = (page, name) => rerender(page, () => mouseClick(page, tab(page, name)));

/**
 * Opens handles through the app the way a launch does. `specs` is a list of
 * { name, dir?, content?, deleted? }: `deleted` files are removed from disk
 * after their handle was taken, so reading them fails.
 */
async function openHandleSpecs(page, specs) {
  await page.evaluate(async (specs) => {
    const root = await navigator.storage.getDirectory();
    const handles = [];
    for (const spec of specs) {
      const dir = spec.dir ? await root.getDirectoryHandle(spec.dir, { create: true }) : root;
      const handle = await dir.getFileHandle(spec.name, { create: true });
      const w = await handle.createWritable();
      await w.write(spec.content || '');
      await w.close();
      handles.push(handle);
      if (spec.deleted) await dir.removeEntry(spec.name);
    }
    await openHandles(handles);
  }, specs);
}

test.describe('opening files', () => {
  test('several files opened in one go become one tab each, in the given order, with the first one showing', async ({ page }) => {
    await openFiles(page, ABC);
    expect(await tabs(page)).toEqual({ names: ['a.md', 'b.md', 'c.md'], active: 'a.md' });
    await expect(heading(page)).toHaveText('Alpha');
    await expect(page).toHaveTitle('a.md');
    await expect(tabBar(page)).toBeVisible();
    await expect(tabBar(page).getByRole('tab')).toHaveCount(3);
  });

  test('the order of the tabs follows the order the files were given in, not their names', async ({ page }) => {
    await openFiles(page, [doc('zebra.md', 'Zebra'), doc('apple.md', 'Apple'), doc('mango.md', 'Mango')]);
    expect(await tabs(page)).toEqual({ names: ['zebra.md', 'apple.md', 'mango.md'], active: 'zebra.md' });
    await expect(heading(page)).toHaveText('Zebra');
  });

  test('exactly one tab is marked as selected', async ({ page }) => {
    await openFiles(page, ABC);
    await expect(tabBar(page).locator('[role="tab"][aria-selected="true"]')).toHaveCount(1);
    await expect(tabBar(page).locator('[role="tab"][aria-selected="false"]')).toHaveCount(2);
    await expect(tabBar(page)).toHaveAttribute('role', 'tablist');
  });

  test('with exactly one file there is no tab bar and the file name is shown in the toolbar', async ({ page }) => {
    await openMarkdown(page, '# Solo', 'solo.md');
    await expect(tabBar(page)).toBeHidden();
    await expect(filename(page)).toBeVisible();
    await expect(filename(page)).toHaveText('solo.md');
    expect(await tabs(page)).toEqual({ names: [], active: null });
    expect(await shownFilename(page)).toBe('solo.md');
    await expect(page).toHaveTitle('solo.md');
  });

  test('with no file open there is no tab bar', async ({ page }) => {
    await expect(tabBar(page)).toBeHidden();
    await expect(filename(page)).toHaveText('No file open');
    await expect(page).toHaveTitle('Markdown Viewer');
  });

  test('with two or more files the file name is not shown next to the menu, only in the tabs', async ({ page }) => {
    await openFiles(page, ABC);
    await expect(filename(page)).toBeHidden();
    expect(await shownFilename(page)).toBeNull();
  });

  test('the tab bar appears when a second file is opened, and the new file is the one showing', async ({ page }) => {
    await openMarkdown(page, '# First', 'first.md');
    await expect(tabBar(page)).toBeHidden();
    await openFiles(page, [doc('second.md', 'Second')]);
    await expect(tabBar(page)).toBeVisible();
    expect(await tabs(page)).toEqual({ names: ['first.md', 'second.md'], active: 'second.md' });
    await expect(heading(page)).toHaveText('Second');
    await expect(filename(page)).toBeHidden();
  });

  test('the tab bar disappears again when closing back down to one file', async ({ page }) => {
    await openFiles(page, ABC);
    await rerender(page, () => closeButton(page, 'a.md').click());
    await expect(tabBar(page)).toBeVisible();
    await rerender(page, () => closeButton(page, 'b.md').click());
    await expect(tabBar(page)).toBeHidden();
    await expect(filename(page)).toBeVisible();
    await expect(filename(page)).toHaveText('c.md');
    await expect(heading(page)).toHaveText('Gamma');
    await expect(page).toHaveTitle('c.md');
  });

  test('files opened later are added after the existing tabs', async ({ page }) => {
    await openFiles(page, [doc('a.md', 'Alpha'), doc('b.md', 'Beta')]);
    await openFiles(page, [doc('c.md', 'Gamma'), doc('d.md', 'Delta')]);
    expect(await tabs(page)).toEqual({ names: ['a.md', 'b.md', 'c.md', 'd.md'], active: 'c.md' });
    await expect(heading(page)).toHaveText('Gamma');
  });

  test('opening a file that is already open switches to it instead of adding a second tab', async ({ page }) => {
    await openFiles(page, ABC);
    await openFiles(page, [doc('c.md', 'Gamma')]);
    expect(await tabs(page)).toEqual({ names: ['a.md', 'b.md', 'c.md'], active: 'c.md' });
    await expect(heading(page)).toHaveText('Gamma');
    await expect(page).toHaveTitle('c.md');
  });

  test('opening a file that is already open reads it from disk again', async ({ page }) => {
    await openFiles(page, ABC);
    await openFiles(page, [{ name: 'b.md', content: '# Beta, second edition' }]);
    expect(await tabs(page)).toEqual({ names: ['a.md', 'b.md', 'c.md'], active: 'b.md' });
    await expect(heading(page)).toHaveText('Beta, second edition');
  });

  test('opening the only open file again keeps a single document without a tab bar', async ({ page }) => {
    await openMarkdown(page, '# Solo', 'solo.md');
    await openFiles(page, [{ name: 'solo.md', content: '# Solo again' }]);
    await expect(tabBar(page)).toBeHidden();
    expect(await shownFilename(page)).toBe('solo.md');
    await expect(heading(page)).toHaveText('Solo again');
  });

  test('the same file given twice in one go opens one tab', async ({ page }) => {
    await openHandleSpecs(page, [
      { name: 'twice.md', content: '# Twice' },
      { name: 'twice.md', content: '# Twice' },
      { name: 'other.md', content: '# Other' },
    ]);
    expect(await tabs(page)).toEqual({ names: ['twice.md', 'other.md'], active: 'twice.md' });
  });

  test('two different files with the same content are two tabs', async ({ page }) => {
    await openFiles(page, [
      { name: 'copy-1.md', content: '# Same\n\nidentical' },
      { name: 'copy-2.md', content: '# Same\n\nidentical' },
    ]);
    expect(await tabs(page)).toEqual({ names: ['copy-1.md', 'copy-2.md'], active: 'copy-1.md' });
    await switchTo(page, 'copy-2.md');
    await expect(page).toHaveTitle('copy-2.md');
    await expect(heading(page)).toHaveText('Same');
  });

  test('two different files with the same name in different directories are two tabs', async ({ page }) => {
    await openHandleSpecs(page, [
      { dir: 'one', name: 'notes.md', content: '# Notes from one' },
      { dir: 'two', name: 'notes.md', content: '# Notes from two' },
    ]);
    await expect(heading(page)).toHaveText('Notes from one');
    const bar = await tabs(page);
    expect(bar.names).toEqual(['notes.md', 'notes.md']);
    await rerender(page, () => tabBar(page).getByRole('tab').nth(1).click());
    await expect(heading(page)).toHaveText('Notes from two');
    await expect(tabBar(page).getByRole('tab').nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(tabBar(page).getByRole('tab').nth(0)).toHaveAttribute('aria-selected', 'false');
  });

  test('a file name with spaces, dots, brackets and punctuation is shown unchanged on its tab', async ({ page }) => {
    const odd = "Overview 2026 v1.2 (final) & it's draft.md";
    await openFiles(page, [doc('a.md', 'Alpha'), doc(odd, 'Overview')]);
    expect(await tabs(page)).toEqual({ names: ['a.md', odd], active: 'a.md' });
    await switchTo(page, odd);
    await expect(page).toHaveTitle(odd);
    await expect(tab(page, odd)).toHaveAttribute('title', odd);
  });

  test('a file name that looks like HTML is shown as text on its tab', async ({ page }) => {
    const evil = '<img src=x onerror=alert(1)>.md';
    await openFiles(page, [doc('a.md', 'Alpha'), doc(evil, 'Evil name')]);
    expect((await tabs(page)).names).toEqual(['a.md', evil]);
    await expect(tabBar(page).locator('img')).toHaveCount(0);
  });
});

test.describe('opening files: what must not happen', () => {
  test('opening zero files changes nothing when no file is open', async ({ page }) => {
    await page.evaluate(() => openHandles([]));
    await expect(tabBar(page)).toBeHidden();
    await expect(filename(page)).toHaveText('No file open');
    await expect(heading(page)).toHaveText('Markdown Viewer');
    await expect(page).toHaveTitle('Markdown Viewer');
    expect(await statusText(page)).toBe('');
  });

  test('opening zero files changes nothing when files are open', async ({ page }) => {
    await openFiles(page, [longDoc('a.md', 'Alpha'), doc('b.md', 'Beta')]);
    await switchTo(page, 'b.md');
    await switchTo(page, 'a.md');
    await scrollTo(page, 500);
    await page.evaluate(() => openHandles([]));
    expect(await tabs(page)).toEqual({ names: ['a.md', 'b.md'], active: 'a.md' });
    await expect(heading(page)).toHaveText('Alpha');
    await expect(page).toHaveTitle('a.md');
    expect(await scrollY(page)).toBe(500);
    expect(await statusText(page)).toBe('');
  });

  test('a file that cannot be read is reported and gets no tab, while the others in the same batch open', async ({ page }) => {
    await openHandleSpecs(page, [
      { name: 'a.md', content: '# Alpha' },
      { name: 'gone.md', content: '# Gone', deleted: true },
      { name: 'c.md', content: '# Gamma' },
    ]);
    await expect(status(page)).toHaveText(/Could not read gone\.md/);
    expect(await tabs(page)).toEqual({ names: ['a.md', 'c.md'], active: 'a.md' });
    await expect(heading(page)).toHaveText('Alpha');
    await switchTo(page, 'c.md');
    await expect(heading(page)).toHaveText('Gamma');
  });

  test('when the first file of a batch cannot be read the next one is shown', async ({ page }) => {
    await openHandleSpecs(page, [
      { name: 'gone.md', content: '# Gone', deleted: true },
      { name: 'b.md', content: '# Beta' },
      { name: 'c.md', content: '# Gamma' },
    ]);
    await expect(status(page)).toHaveText(/Could not read gone\.md/);
    expect(await tabs(page)).toEqual({ names: ['b.md', 'c.md'], active: 'b.md' });
    await expect(heading(page)).toHaveText('Beta');
    await expect(page).toHaveTitle('b.md');
  });

  test('a single file that cannot be read is reported and the empty state stays', async ({ page }) => {
    await openHandleSpecs(page, [{ name: 'gone.md', content: '# Gone', deleted: true }]);
    await expect(status(page)).toHaveText(/Could not read gone\.md/);
    await expect(tabBar(page)).toBeHidden();
    await expect(filename(page)).toHaveText('No file open');
    await expect(heading(page)).toHaveText('Markdown Viewer');
    await expect(page).toHaveTitle('Markdown Viewer');
  });

  test('a file that cannot be read leaves the documents that are already open alone', async ({ page }) => {
    await openFiles(page, [doc('a.md', 'Alpha'), doc('b.md', 'Beta')]);
    await switchTo(page, 'b.md');
    await openHandleSpecs(page, [{ name: 'gone.md', content: '# Gone', deleted: true }]);
    await expect(status(page)).toHaveText(/Could not read gone\.md/);
    expect(await tabs(page)).toEqual({ names: ['a.md', 'b.md'], active: 'b.md' });
    await expect(heading(page)).toHaveText('Beta');
  });

  test('the message about an unreadable file goes away with the next successful open', async ({ page }) => {
    await openHandleSpecs(page, [{ name: 'gone.md', content: '# Gone', deleted: true }]);
    await expect(status(page)).toHaveText(/Could not read gone\.md/);
    await openFiles(page, [doc('fine.md', 'Fine')]);
    await expect(heading(page)).toHaveText('Fine');
    expect(await statusText(page)).toBe('');
  });

  test('an empty file opens as an empty document with its own tab', async ({ page }) => {
    await openFiles(page, [doc('a.md', 'Alpha'), { name: 'empty.md', content: '' }]);
    expect(await tabs(page)).toEqual({ names: ['a.md', 'empty.md'], active: 'a.md' });
    await tab(page, 'empty.md').click();
    await expect(tab(page, 'empty.md')).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveTitle('empty.md');
    await expect(view(page)).toBeEmpty();
    expect(await statusText(page)).toBe('');
  });
});

test.describe('switching', () => {
  test('clicking a tab shows that document, selects the tab and sets the window title', async ({ page }) => {
    await openFiles(page, ABC);
    await switchTo(page, 'b.md');
    await expect(heading(page)).toHaveText('Beta');
    await expect(view(page).locator('p')).toHaveText('Body of Beta.');
    await expect(page).toHaveTitle('b.md');
    await expect(tab(page, 'b.md')).toHaveAttribute('aria-selected', 'true');
    await expect(tab(page, 'a.md')).toHaveAttribute('aria-selected', 'false');
    await expect(tab(page, 'c.md')).toHaveAttribute('aria-selected', 'false');
    expect(await tabs(page)).toEqual({ names: ['a.md', 'b.md', 'c.md'], active: 'b.md' });

    await switchTo(page, 'c.md');
    await expect(heading(page)).toHaveText('Gamma');
    await expect(page).toHaveTitle('c.md');
    await switchTo(page, 'a.md');
    await expect(heading(page)).toHaveText('Alpha');
    await expect(page).toHaveTitle('a.md');
  });

  test('switching shows only the chosen document, nothing of the previous one', async ({ page }) => {
    await openFiles(page, ABC);
    await switchTo(page, 'b.md');
    await expect(view(page).locator('h1')).toHaveCount(1);
    await expect(view(page)).not.toContainText('Alpha');
    await expect(view(page)).not.toContainText('Gamma');
  });

  test('switching tabs does not change their order or number', async ({ page }) => {
    await openFiles(page, ABC);
    for (const name of ['c.md', 'a.md', 'b.md', 'c.md']) {
      await switchTo(page, name);
      expect(await tabs(page)).toEqual({ names: ['a.md', 'b.md', 'c.md'], active: name });
    }
  });

  test('clicking the tab that is already showing keeps it showing', async ({ page }) => {
    await openFiles(page, ABC);
    await tab(page, 'a.md').click();
    await expect(heading(page)).toHaveText('Alpha');
    expect(await tabs(page)).toEqual({ names: ['a.md', 'b.md', 'c.md'], active: 'a.md' });
  });

  test('each tab remembers its own scroll position', async ({ page }) => {
    await openFiles(page, [longDoc('a.md', 'Alpha'), longDoc('b.md', 'Beta'), doc('c.md', 'Gamma')]);
    await scrollTo(page, 300);
    await switchTo(page, 'b.md');
    expect(await scrollY(page)).toBe(0);     // a new tab starts at the top
    await scrollTo(page, 750);
    await switchTo(page, 'a.md');
    expect(await scrollY(page)).toBe(300);
    await switchTo(page, 'b.md');
    expect(await scrollY(page)).toBe(750);
    await switchTo(page, 'c.md');
    expect(await scrollY(page)).toBe(0);
    await switchTo(page, 'a.md');
    expect(await scrollY(page)).toBe(300);
  });

  test('the tab bar stays visible when the document is scrolled', async ({ page }) => {
    await openFiles(page, [longDoc('a.md', 'Alpha'), doc('b.md', 'Beta')]);
    await scrollTo(page, 2000);
    await expect(tab(page, 'b.md')).toBeInViewport();
    await switchTo(page, 'b.md');
    await expect(heading(page)).toHaveText('Beta');
  });

  test('Enter on a focused tab shows that document', async ({ page }) => {
    await openFiles(page, ABC);
    await tab(page, 'b.md').focus();
    await rerender(page, () => page.keyboard.press('Enter'));
    await expect(heading(page)).toHaveText('Beta');
    expect(await tabs(page)).toEqual({ names: ['a.md', 'b.md', 'c.md'], active: 'b.md' });
    await expect(page).toHaveTitle('b.md');
  });

  test('Space on a focused tab shows that document and does not scroll the page', async ({ page }) => {
    await openFiles(page, [longDoc('a.md', 'Alpha'), longDoc('b.md', 'Beta'), doc('c.md', 'Gamma')]);
    await tab(page, 'b.md').focus();
    await rerender(page, () => page.keyboard.press('Space'));
    await expect(heading(page)).toHaveText('Beta');
    expect(await tabs(page)).toEqual({ names: ['a.md', 'b.md', 'c.md'], active: 'b.md' });
    expect(await scrollY(page)).toBe(0);
  });

  test('a middle-click on a tab of a scrolled document closes it without moving the document', async ({ page }) => {
    await openFiles(page, [longDoc('a.md', 'Alpha'), doc('b.md', 'Beta'), doc('c.md', 'Gamma')]);
    await scrollTo(page, 555);
    await rerender(page, () => mouseClick(page, tab(page, 'b.md'), { button: 'middle' }));
    expect(await tabs(page)).toEqual({ names: ['a.md', 'c.md'], active: 'a.md' });
    expect(await scrollY(page)).toBe(555);
  });

  test('moving the keyboard focus onto a tab does not scroll the document', async ({ page }) => {
    // APP BUG (same cause as the File menu one in file-menu.spec.js): the page
    // has `html { scroll-padding-top: 5rem }` and the toolbar is sticky at the
    // top, i.e. inside that padding, so whenever something in the toolbar gets
    // the focus Chrome scrolls the document up by several hundred pixels to
    // "reveal" it. (Fixed; kept as a regression test.)
    // Regression: focusing a toolbar element used to scroll the document.
    await openFiles(page, [longDoc('a.md', 'Alpha'), doc('b.md', 'Beta')]);
    await scrollTo(page, 900);
    await page.keyboard.press('Tab');
    await expect(page.locator('#toolbar :focus')).toHaveCount(1);
    expect(await scrollY(page)).toBe(900);
  });

  test('tabs can be reached with the Tab key', async ({ page }) => {
    await openFiles(page, ABC);
    for (const t of await tabBar(page).getByRole('tab').all()) {
      expect(await t.evaluate((el) => el.tabIndex)).toBe(0);
    }
    await tab(page, 'a.md').focus();
    await page.keyboard.press('Tab');   // a.md's close button
    await expect(closeButton(page, 'a.md')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(tab(page, 'b.md')).toBeFocused();
  });

  test('other keys on a focused tab do not switch documents', async ({ page }) => {
    await openFiles(page, ABC);
    await tab(page, 'b.md').focus();
    for (const key of ['x', 'ArrowRight', 'ArrowLeft', 'Escape', 'Shift+Tab']) await page.keyboard.press(key);
    expect(await tabs(page)).toEqual({ names: ['a.md', 'b.md', 'c.md'], active: 'a.md' });
    await expect(heading(page)).toHaveText('Alpha');
  });
});

test.describe('closing', () => {
  test('every tab has a close button named after its file', async ({ page }) => {
    await openFiles(page, ABC);
    for (const name of ['a.md', 'b.md', 'c.md']) {
      await expect(closeButton(page, name)).toBeVisible();
      await expect(closeButton(page, name)).toHaveText('×');
      await expect(closeButton(page, name)).toHaveAttribute('aria-label', `Close ${name}`);
    }
  });

  test('the × of a tab that is not showing closes that tab without showing it first', async ({ page }) => {
    await openFiles(page, ABC);
    // Had b.md been shown, even for a moment, the title would have changed.
    await page.evaluate(() => {
      window.__titles = [];
      new MutationObserver(() => window.__titles.push(document.title))
        .observe(document.querySelector('title'), { childList: true, characterData: true, subtree: true });
    });
    await rerender(page, () => closeButton(page, 'b.md').click());
    expect(await tabs(page)).toEqual({ names: ['a.md', 'c.md'], active: 'a.md' });
    await expect(heading(page)).toHaveText('Alpha');
    await expect(page).toHaveTitle('a.md');
    expect(await page.evaluate(() => window.__titles.filter((t) => t !== 'a.md'))).toEqual([]);
  });

  test('a middle-click on a tab closes it', async ({ page }) => {
    await openFiles(page, ABC);
    await rerender(page, () => tab(page, 'b.md').click({ button: 'middle' }));
    expect(await tabs(page)).toEqual({ names: ['a.md', 'c.md'], active: 'a.md' });
    await expect(heading(page)).toHaveText('Alpha');
  });

  test('a middle-click on the tab that is showing closes it and shows a neighbour', async ({ page }) => {
    await openFiles(page, ABC);
    await rerender(page, () => tab(page, 'a.md').click({ button: 'middle' }));
    expect(await tabs(page)).toEqual({ names: ['b.md', 'c.md'], active: 'b.md' });
    await expect(heading(page)).toHaveText('Beta');
  });

  test('a right-click on a tab neither closes nor switches', async ({ page }) => {
    await openFiles(page, ABC);
    await tab(page, 'b.md').click({ button: 'right' });
    await expect(page.locator('#context-menu').first()).toBeVisible();
    expect(await tabs(page)).toEqual({ names: ['a.md', 'b.md', 'c.md'], active: 'a.md' });
    await expect(heading(page)).toHaveText('Alpha');
    await page.keyboard.press('Escape');
  });

  test('closing the showing tab in the middle shows the tab that followed it', async ({ page }) => {
    await openFiles(page, ABC);
    await switchTo(page, 'b.md');
    await rerender(page, () => closeButton(page, 'b.md').click());
    expect(await tabs(page)).toEqual({ names: ['a.md', 'c.md'], active: 'c.md' });
    await expect(heading(page)).toHaveText('Gamma');
    await expect(page).toHaveTitle('c.md');
  });

  test('closing the showing tab at the end shows the tab before it', async ({ page }) => {
    await openFiles(page, ABC);
    await switchTo(page, 'c.md');
    await rerender(page, () => closeButton(page, 'c.md').click());
    expect(await tabs(page)).toEqual({ names: ['a.md', 'b.md'], active: 'b.md' });
    await expect(heading(page)).toHaveText('Beta');
    await expect(page).toHaveTitle('b.md');
  });

  test('closing a tab before the showing one keeps the same document showing, at the same scroll position', async ({ page }) => {
    await openFiles(page, [doc('a.md', 'Alpha'), doc('b.md', 'Beta'), longDoc('c.md', 'Gamma')]);
    await switchTo(page, 'c.md');
    await scrollTo(page, 640);
    await rerender(page, () => mouseClick(page, closeButton(page, 'a.md')));
    expect(await tabs(page)).toEqual({ names: ['b.md', 'c.md'], active: 'c.md' });
    await expect(heading(page)).toHaveText('Gamma');
    await expect(page).toHaveTitle('c.md');
    expect(await scrollY(page)).toBe(640);
  });

  test('closing a tab after the showing one keeps the same document showing', async ({ page }) => {
    await openFiles(page, ABC);
    await switchTo(page, 'b.md');
    await rerender(page, () => closeButton(page, 'c.md').click());
    expect(await tabs(page)).toEqual({ names: ['a.md', 'b.md'], active: 'b.md' });
    await expect(heading(page)).toHaveText('Beta');
  });

  test('closing a tab keeps the scroll positions the other tabs remembered', async ({ page }) => {
    await openFiles(page, [longDoc('a.md', 'Alpha'), doc('b.md', 'Beta'), longDoc('c.md', 'Gamma')]);
    await scrollTo(page, 420);
    await switchTo(page, 'c.md');
    await scrollTo(page, 810);
    await switchTo(page, 'b.md');
    await rerender(page, () => mouseClick(page, closeButton(page, 'b.md')));
    expect(await tabs(page)).toEqual({ names: ['a.md', 'c.md'], active: 'c.md' });
    expect(await scrollY(page)).toBe(810);
    await switchTo(page, 'a.md');
    expect(await scrollY(page)).toBe(420);
  });

  test('closing tabs one after the other ends in the empty state', async ({ page }) => {
    await openFiles(page, ABC);
    await rerender(page, () => closeButton(page, 'a.md').click());
    await rerender(page, () => closeButton(page, 'b.md').click());
    expect(await shownFilename(page)).toBe('c.md');
    await clickFileMenuItem(page, 'Close');
    await expect(heading(page)).toHaveText('Markdown Viewer');
    await expect(filename(page)).toHaveText('No file open');
    await expect(page).toHaveTitle('Markdown Viewer');
    await expect(tabBar(page)).toBeHidden();
  });

  test('a closed file can be opened again and goes to the end of the tab bar', async ({ page }) => {
    await openFiles(page, ABC);
    await rerender(page, () => closeButton(page, 'a.md').click());
    await openFiles(page, [doc('a.md', 'Alpha')]);
    expect(await tabs(page)).toEqual({ names: ['b.md', 'c.md', 'a.md'], active: 'a.md' });
    await expect(heading(page)).toHaveText('Alpha');
  });

  test('closing a tab does not close a different file with the same content', async ({ page }) => {
    await openFiles(page, [
      { name: 'copy-1.md', content: '# Same' },
      { name: 'copy-2.md', content: '# Same' },
      doc('c.md', 'Gamma'),
    ]);
    await rerender(page, () => closeButton(page, 'copy-1.md').click());
    expect(await tabs(page)).toEqual({ names: ['copy-2.md', 'c.md'], active: 'copy-2.md' });
  });
});

test.describe('many tabs', () => {
  const many = Array.from({ length: 15 }, (_, i) => doc(`document-number-${String(i + 1).padStart(2, '0')}.md`, `Doc ${i + 1}`));

  test('fifteen files open as fifteen tabs in order', async ({ page }) => {
    await openFiles(page, many);
    expect(await tabs(page)).toEqual({ names: many.map((f) => f.name), active: many[0].name });
    await expect(heading(page)).toHaveText('Doc 1');
  });

  test('fifteen tabs do not make the page wider than the window', async ({ page }) => {
    await openFiles(page, many);
    const m = await page.evaluate(() => {
      const toolbar = document.querySelector('#toolbar').getBoundingClientRect();
      const bar = document.querySelector('#tabs').getBoundingClientRect();
      return {
        pageWidth: document.documentElement.scrollWidth,
        windowWidth: document.documentElement.clientWidth,
        toolbarLeft: toolbar.left, toolbarRight: toolbar.right,
        barLeft: bar.left, barRight: bar.right,
      };
    });
    expect(m.pageWidth).toBeLessThanOrEqual(m.windowWidth);          // no horizontal page scrollbar
    expect(m.toolbarLeft).toBeGreaterThanOrEqual(0);
    expect(m.toolbarRight).toBeLessThanOrEqual(m.windowWidth);
    expect(m.barLeft).toBeGreaterThanOrEqual(0);
    expect(m.barRight).toBeLessThanOrEqual(m.windowWidth);
    // The page itself cannot be scrolled sideways.
    await page.evaluate(() => window.scrollTo(500, 0));
    expect(await page.evaluate(() => window.scrollX)).toBe(0);
  });

  test('with fifteen tabs the File menu and the tabs stay on one line each', async ({ page }) => {
    await openFiles(page, many);
    const tops = await tabBar(page).getByRole('tab').evaluateAll((all) => [...new Set(all.map((t) => Math.round(t.getBoundingClientRect().top)))]);
    expect(tops).toHaveLength(1);
    const menuButton = await page.locator('#file-menu-btn').first().boundingBox();
    expect(menuButton.y + menuButton.height).toBeLessThanOrEqual(tops[0]);
    await expect(page.locator('#file-menu-btn').first()).toBeInViewport();
  });

  test('with fifteen tabs the last one can still be reached, shown and closed', async ({ page }) => {
    await openFiles(page, many);
    const last = many[14].name;
    await rerender(page, () => tab(page, last).click());
    await expect(heading(page)).toHaveText('Doc 15');
    await expect(page).toHaveTitle(last);
    await expect(tab(page, last)).toBeInViewport();
    await rerender(page, () => closeButton(page, last).click());
    const bar = await tabs(page);
    expect(bar.names).toEqual(many.slice(0, 14).map((f) => f.name));
    expect(bar.active).toBe(many[13].name);
  });

  test('very long file names do not make the page wider than the window', async ({ page }) => {
    const longName = (n) => `${'a-very-long-file-name-'.repeat(8)}${n}.md`;
    await openFiles(page, [doc(longName(1), 'One'), doc(longName(2), 'Two'), doc(longName(3), 'Three')]);
    expect((await tabs(page)).names).toEqual([longName(1), longName(2), longName(3)]);
    const m = await page.evaluate(() => ({
      pageWidth: document.documentElement.scrollWidth,
      windowWidth: document.documentElement.clientWidth,
    }));
    expect(m.pageWidth).toBeLessThanOrEqual(m.windowWidth);
    // The full name is still available as a tooltip.
    await expect(tabBar(page).getByRole('tab').first()).toHaveAttribute('title', longName(1));
  });

  test('a single file with a very long name does not make the page wider than the window', async ({ page }) => {
    const name = `${'a-very-long-file-name-'.repeat(12)}.md`;
    await openMarkdown(page, '# Long name', name);
    expect(await shownFilename(page)).toBe(name);
    const m = await page.evaluate(() => ({
      pageWidth: document.documentElement.scrollWidth,
      windowWidth: document.documentElement.clientWidth,
    }));
    expect(m.pageWidth).toBeLessThanOrEqual(m.windowWidth);
    await expect(page.locator('#file-menu-btn').first()).toBeInViewport();
  });
});
