// File > Recently Viewed: the list of files opened before, kept in IndexedDB.
const {
  test, expect, openApp, appErrors, writeFile, removeFile, openFiles, openMarkdown,
  view, rerender, statusText, tabs, tab, shownFilename,
  openFileMenu, fileMenuItem, clickFileMenuItem, openRecentMenu, recentItems, clickRecentItem,
} = require('./helpers');

test.beforeEach(async ({ page }) => { await openApp(page); });

test.afterEach(async ({ context }) => {
  for (const p of context.pages()) expect(appErrors(p)).toEqual([]);
});

const menu = (page) => page.locator('#file-menu').first();
const submenu = (page) => page.locator('#recent-menu').first();
const recentButton = (page) => page.locator('#recent-btn').first();
const status = (page) => page.locator('#status').first();
const heading = (page) => view(page).locator('h1');

const doc = (name, title) => ({ name, content: `# ${title}\n\nBody of ${title}.` });
const ABC = [doc('a.md', 'Alpha'), doc('b.md', 'Beta'), doc('c.md', 'Gamma')];

/**
 * The Recently Viewed list as a newly opened menu shows it. The app fills the
 * submenu when the File menu opens, so a menu that is already open is closed
 * first. Leaves the submenu open.
 */
async function freshRecentItems(page) {
  if (await menu(page).isVisible()) {
    await page.locator('#file-menu-btn').first().click();
    await expect(menu(page)).toBeHidden();
  }
  return recentItems(page);
}

/** Everything in the submenu, top to bottom: { tag, text, disabled }. */
const submenuLayout = (page) => submenu(page).evaluate((el) => [...el.children].map((child) => ({
  tag: child.tagName,
  text: child.textContent,
  disabled: child.disabled === true,
})));

/** Opens the files one after the other, as separate launches would. */
async function openOneByOne(page, files) {
  for (const f of files) await openFiles(page, [f]);
}

test.describe('the list', () => {
  test('with nothing viewed yet the submenu shows a disabled placeholder and a disabled Clear', async ({ page }) => {
    expect(await recentItems(page)).toEqual([]);
    expect(await submenuLayout(page)).toEqual([
      { tag: 'BUTTON', text: 'No recent files', disabled: true },
      { tag: 'HR', text: '', disabled: false },
      { tag: 'BUTTON', text: 'Clear', disabled: true },
    ]);
    for (const item of await submenu(page).getByRole('menuitem', { includeHidden: false, disabled: true }).all()) {
      await expect(item).toBeVisible();
    }
  });

  test('clicking the placeholder or the disabled Clear does nothing', async ({ page }) => {
    await openRecentMenu(page);
    for (const item of await submenu(page).locator('button').all()) await item.click({ force: true });
    await expect(submenu(page)).toBeVisible();
    await expect(menu(page)).toBeVisible();
    expect(await statusText(page)).toBe('');
    expect(await shownFilename(page)).toBe('No file open');
  });

  test('a viewed file is listed, followed by a separator line and an enabled Clear as the last item', async ({ page }) => {
    await openMarkdown(page, '# One', 'one.md');
    expect(await recentItems(page)).toEqual(['one.md']);
    expect(await submenuLayout(page)).toEqual([
      { tag: 'BUTTON', text: 'one.md', disabled: false },
      { tag: 'HR', text: '', disabled: false },
      { tag: 'BUTTON', text: 'Clear', disabled: false },
    ]);
    const hr = submenu(page).locator('hr');
    await expect(hr).toBeVisible();
    expect((await hr.boundingBox()).height).toBeGreaterThan(0);
    // The line lies between the last file and Clear.
    const fileBox = await submenu(page).locator('button').first().boundingBox();
    const hrBox = await hr.boundingBox();
    const clearBox = await submenu(page).locator('button').last().boundingBox();
    expect(hrBox.y).toBeGreaterThanOrEqual(fileBox.y + fileBox.height);
    expect(clearBox.y).toBeGreaterThanOrEqual(hrBox.y + hrBox.height);
  });

  test('files viewed one after the other are listed newest first', async ({ page }) => {
    await openOneByOne(page, ABC);
    expect(await recentItems(page)).toEqual(['c.md', 'b.md', 'a.md']);
  });

  test('files opened in one go are all listed, the last of them on top', async ({ page }) => {
    await openFiles(page, ABC);
    expect(await recentItems(page)).toEqual(['c.md', 'b.md', 'a.md']);
  });

  test('there is exactly one separator and one Clear however many files are listed', async ({ page }) => {
    await openFiles(page, ABC);
    await openRecentMenu(page);
    const layout = await submenuLayout(page);
    expect(layout.map((x) => x.tag)).toEqual(['BUTTON', 'BUTTON', 'BUTTON', 'HR', 'BUTTON']);
    expect(layout.at(-1)).toEqual({ tag: 'BUTTON', text: 'Clear', disabled: false });
    expect(layout.filter((x) => x.text === 'Clear')).toHaveLength(1);
    expect(layout.some((x) => x.text === 'No recent files')).toBe(false);
  });

  test('opening a file again moves it to the top without listing it twice', async ({ page }) => {
    await openOneByOne(page, ABC);
    await openFiles(page, [doc('a.md', 'Alpha')]);
    expect(await recentItems(page)).toEqual(['a.md', 'c.md', 'b.md']);
    await openFiles(page, [doc('c.md', 'Gamma')]);
    expect(await freshRecentItems(page)).toEqual(['c.md', 'a.md', 'b.md']);
  });

  test('opening the newest file again leaves the list as it was', async ({ page }) => {
    await openOneByOne(page, ABC);
    await openFiles(page, [doc('c.md', 'Gamma')]);
    expect(await recentItems(page)).toEqual(['c.md', 'b.md', 'a.md']);
  });

  test('at most ten files are kept: of twelve, the ten newest', async ({ page }) => {
    const twelve = Array.from({ length: 12 }, (_, i) => doc(`f${String(i + 1).padStart(2, '0')}.md`, `File ${i + 1}`));
    await openOneByOne(page, twelve);
    expect(await recentItems(page)).toEqual([
      'f12.md', 'f11.md', 'f10.md', 'f09.md', 'f08.md', 'f07.md', 'f06.md', 'f05.md', 'f04.md', 'f03.md',
    ]);
    await expect(submenu(page).locator('button')).toHaveCount(11);   // ten files and Clear
  });

  test('the limit of ten also holds for twelve files opened in one go', async ({ page }) => {
    const twelve = Array.from({ length: 12 }, (_, i) => doc(`f${String(i + 1).padStart(2, '0')}.md`, `File ${i + 1}`));
    await openFiles(page, twelve);
    const listed = await recentItems(page);
    expect(listed).toHaveLength(10);
    expect(listed).toEqual(twelve.slice(2).map((f) => f.name).reverse());
    expect((await tabs(page)).names).toHaveLength(12);   // the limit is on the list, not on tabs
  });

  test('re-opening an old file when the list is full keeps ten entries and drops none of the others', async ({ page }) => {
    const ten = Array.from({ length: 10 }, (_, i) => doc(`f${String(i + 1).padStart(2, '0')}.md`, `File ${i + 1}`));
    await openFiles(page, ten);
    await openFiles(page, [ten[0]]);
    expect(await recentItems(page)).toEqual([
      'f01.md', 'f10.md', 'f09.md', 'f08.md', 'f07.md', 'f06.md', 'f05.md', 'f04.md', 'f03.md', 'f02.md',
    ]);
  });

  test('two different files with the same name are both listed', async ({ page }) => {
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const handles = [];
      for (const dirName of ['one', 'two']) {
        const dir = await root.getDirectoryHandle(dirName, { create: true });
        const handle = await dir.getFileHandle('notes.md', { create: true });
        const w = await handle.createWritable();
        await w.write(`# Notes from ${dirName}`);
        await w.close();
        handles.push(handle);
      }
      await openHandles(handles);
    });
    expect(await recentItems(page)).toEqual(['notes.md', 'notes.md']);
    // The upper one is the one opened last.
    await clickFileMenuItem(page, 'Close All');
    await expect(heading(page)).toHaveText('Markdown Viewer');
    await openRecentMenu(page);
    await submenu(page).locator('button').first().click();
    await expect(heading(page)).toHaveText('Notes from two');
  });

  test('a file name that looks like HTML is listed as text', async ({ page }) => {
    const odd = '<b>bold</b> & "quoted" <img src=x onerror=alert(1)>.md'.replace('/', '');   // no "/" in file names
    await openMarkdown(page, '# Odd', odd);
    expect(await recentItems(page)).toEqual([odd]);
    await expect(submenu(page).locator('b, img')).toHaveCount(0);
  });

  test('Reload does not reorder the list', async ({ page }) => {
    await openFiles(page, ABC);   // a.md is showing, c.md is on top of the list
    await rerender(page, () => clickFileMenuItem(page, 'Reload'));
    expect(await recentItems(page)).toEqual(['c.md', 'b.md', 'a.md']);
  });

  test('switching tabs does not reorder the list', async ({ page }) => {
    await openFiles(page, ABC);
    await rerender(page, () => tab(page, 'b.md').click());
    expect(await recentItems(page)).toEqual(['c.md', 'b.md', 'a.md']);
  });

  test('closing files does not remove them from the list', async ({ page }) => {
    await openFiles(page, ABC);
    await rerender(page, () => clickFileMenuItem(page, 'Close'));
    expect(await recentItems(page)).toEqual(['c.md', 'b.md', 'a.md']);
    await clickFileMenuItem(page, 'Close All');
    await expect(heading(page)).toHaveText('Markdown Viewer');
    expect(await freshRecentItems(page)).toEqual(['c.md', 'b.md', 'a.md']);
  });

  test('closing a tab with its × does not remove the file from the list', async ({ page }) => {
    await openFiles(page, ABC);
    await rerender(page, () => tab(page, 'b.md').locator('.tab-close').click());
    expect(await recentItems(page)).toEqual(['c.md', 'b.md', 'a.md']);
  });

  test('a file that could not be read is not added to the list', async ({ page }) => {
    await writeFile(page, 'fine.md', '# Fine');
    await page.evaluate(async () => {
      const dir = await navigator.storage.getDirectory();
      const gone = await dir.getFileHandle('gone.md', { create: true });
      await dir.removeEntry('gone.md');
      await openHandles([gone, await dir.getFileHandle('fine.md')]);
    });
    await expect(status(page)).toHaveText(/Could not read gone\.md/);
    expect(await recentItems(page)).toEqual(['fine.md']);
  });
});

test.describe('the submenu', () => {
  test('hovering Recently Viewed opens the submenu', async ({ page }) => {
    await openMarkdown(page, '# One', 'one.md');
    await openFileMenu(page);
    await expect(submenu(page)).toBeHidden();
    await recentButton(page).hover();
    await expect(submenu(page)).toBeVisible();
    await expect(recentButton(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(recentButton(page)).toHaveAttribute('aria-haspopup', 'menu');
  });

  test('clicking Recently Viewed after hovering it leaves the submenu open', async ({ page }) => {
    await openMarkdown(page, '# One', 'one.md');
    await openFileMenu(page);
    await recentButton(page).hover();
    await expect(submenu(page)).toBeVisible();
    await recentButton(page).click();
    await expect(submenu(page)).toBeVisible();
    await expect(menu(page)).toBeVisible();
    await expect(recentButton(page)).toHaveAttribute('aria-expanded', 'true');
    // Never a toggle: a further click does not shut it either.
    await recentButton(page).click();
    await expect(submenu(page)).toBeVisible();
    await expect(recentButton(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(submenu(page).getByRole('menuitem').first()).toHaveText('one.md');
  });

  test('clicking Recently Viewed opens the submenu when the pointer has not hovered it', async ({ page }) => {
    await openMarkdown(page, '# One', 'one.md');
    await openFileMenu(page);
    await recentButton(page).dispatchEvent('click');   // a click without any pointer movement
    await expect(submenu(page)).toBeVisible();
    await expect(menu(page)).toBeVisible();
  });

  test('clicking Recently Viewed does not open or close any document', async ({ page }) => {
    await openFiles(page, ABC);
    await openRecentMenu(page);
    await recentButton(page).click();
    await expect(menu(page)).toBeVisible();
    expect(await tabs(page)).toEqual({ names: ['a.md', 'b.md', 'c.md'], active: 'a.md' });
    await expect(heading(page)).toHaveText('Alpha');
  });

  test('moving the pointer to another File menu item closes the submenu but not the menu', async ({ page }) => {
    await openMarkdown(page, '# One', 'one.md');
    await openRecentMenu(page);
    await fileMenuItem(page, 'Exit').hover();
    await expect(submenu(page)).toBeHidden();
    await expect(recentButton(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(menu(page)).toBeVisible();
  });

  test('moving the pointer from Recently Viewed into the submenu keeps it open', async ({ page }) => {
    await openFiles(page, ABC);
    await openRecentMenu(page);
    await submenu(page).getByRole('menuitem').nth(1).hover();
    await expect(submenu(page)).toBeVisible();
    await submenu(page).getByRole('menuitem', { name: 'Clear' }).hover();
    await expect(submenu(page)).toBeVisible();
  });

  test('the submenu opens beside the File menu, inside the window', async ({ page }) => {
    await openFiles(page, ABC);
    await openRecentMenu(page);
    const main = await menu(page).boundingBox();
    const sub = await submenu(page).boundingBox();
    expect(sub.x).toBeGreaterThanOrEqual(main.x + main.width - 2);
    expect(sub.x + sub.width).toBeLessThanOrEqual(page.viewportSize().width);
    expect(sub.y + sub.height).toBeLessThanOrEqual(page.viewportSize().height);
  });

  test('a full list with long file names stays inside the window', async ({ page }) => {
    const ten = Array.from({ length: 10 }, (_, i) => doc(`${'a-very-long-file-name-'.repeat(6)}${i}.md`, `File ${i}`));
    await openFiles(page, ten);
    await openRecentMenu(page);
    const sub = await submenu(page).boundingBox();
    expect(sub.x + sub.width).toBeLessThanOrEqual(page.viewportSize().width);
    expect(sub.y + sub.height).toBeLessThanOrEqual(page.viewportSize().height);
    await expect(submenu(page).getByRole('menuitem', { name: 'Clear' })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });

  test('the list shown is the current one each time the menu is opened', async ({ page }) => {
    await openMarkdown(page, '# One', 'one.md');
    expect(await recentItems(page)).toEqual(['one.md']);
    await page.keyboard.press('Escape');
    await openFiles(page, [doc('two.md', 'Two')]);
    expect(await freshRecentItems(page)).toEqual(['two.md', 'one.md']);
  });
});

test.describe('choosing an entry', () => {
  test('choosing an entry opens that file and closes the menu', async ({ page }) => {
    await openFiles(page, ABC);
    await clickFileMenuItem(page, 'Close All');
    await expect(heading(page)).toHaveText('Markdown Viewer');
    await clickRecentItem(page, 'b.md');
    await expect(heading(page)).toHaveText('Beta');
    await expect(menu(page)).toBeHidden();
    await expect(submenu(page)).toBeHidden();
    await expect(page.locator('#file-menu-btn').first()).toHaveAttribute('aria-expanded', 'false');
    expect(await shownFilename(page)).toBe('b.md');
    await expect(page).toHaveTitle('b.md');
    expect(await statusText(page)).toBe('');
  });

  test('choosing an entry opens the file as a new tab next to the ones already open', async ({ page }) => {
    await openFiles(page, [doc('a.md', 'Alpha'), doc('b.md', 'Beta')]);
    await clickFileMenuItem(page, 'Close All');
    await expect(heading(page)).toHaveText('Markdown Viewer');
    await openFiles(page, [doc('c.md', 'Gamma')]);
    await rerender(page, () => clickRecentItem(page, 'a.md'));
    await expect(heading(page)).toHaveText('Alpha');
    expect(await tabs(page)).toEqual({ names: ['c.md', 'a.md'], active: 'a.md' });
  });

  test('choosing an entry that is already open switches to its tab without duplicating it', async ({ page }) => {
    await openFiles(page, ABC);
    await rerender(page, () => clickRecentItem(page, 'c.md'));
    await expect(heading(page)).toHaveText('Gamma');
    expect(await tabs(page)).toEqual({ names: ['a.md', 'b.md', 'c.md'], active: 'c.md' });
    await expect(page).toHaveTitle('c.md');
  });

  test('choosing the entry of the file that is showing keeps it showing, once', async ({ page }) => {
    await openFiles(page, ABC);
    await rerender(page, () => clickRecentItem(page, 'a.md'));
    await expect(heading(page)).toHaveText('Alpha');
    expect(await tabs(page)).toEqual({ names: ['a.md', 'b.md', 'c.md'], active: 'a.md' });
  });

  test('choosing an entry reads the file as it is on disk now', async ({ page }) => {
    await openMarkdown(page, '# Old text', 'note.md');
    await clickFileMenuItem(page, 'Close');
    await expect(heading(page)).toHaveText('Markdown Viewer');
    await writeFile(page, 'note.md', '# New text');
    await clickRecentItem(page, 'note.md');
    await expect(heading(page)).toHaveText('New text');
  });

  test('choosing an entry moves it to the top of the list', async ({ page }) => {
    await openFiles(page, ABC);
    await rerender(page, () => clickRecentItem(page, 'a.md'));
    expect(await freshRecentItems(page)).toEqual(['a.md', 'c.md', 'b.md']);
  });

  test('an entry whose file was deleted shows a message, opens no tab and leaves the app working', async ({ page }) => {
    await openFiles(page, [doc('gone.md', 'Gone'), doc('kept.md', 'Kept')]);
    await clickFileMenuItem(page, 'Close All');
    await expect(heading(page)).toHaveText('Markdown Viewer');
    await removeFile(page, 'gone.md');

    await clickRecentItem(page, 'gone.md');
    await expect(status(page)).toHaveText(/Could not read/);
    await expect(status(page)).toHaveText(/gone\.md/);
    await expect(menu(page)).toBeHidden();
    expect(await tabs(page)).toEqual({ names: [], active: null });
    expect(await shownFilename(page)).toBe('No file open');
    await expect(heading(page)).toHaveText('Markdown Viewer');
    await expect(page).toHaveTitle('Markdown Viewer');

    // Still working: another entry opens and the message goes away.
    await clickRecentItem(page, 'kept.md');
    await expect(heading(page)).toHaveText('Kept');
    expect(await statusText(page)).toBe('');
    expect(await shownFilename(page)).toBe('kept.md');
  });

  test('a deleted entry chosen while other files are open leaves those open and showing', async ({ page }) => {
    await openFiles(page, [doc('gone.md', 'Gone'), doc('a.md', 'Alpha'), doc('b.md', 'Beta')]);
    await rerender(page, () => tab(page, 'gone.md').locator('.tab-close').click());
    await removeFile(page, 'gone.md');
    await clickRecentItem(page, 'gone.md');
    await expect(status(page)).toHaveText(/Could not read/);
    expect(await tabs(page)).toEqual({ names: ['a.md', 'b.md'], active: 'a.md' });
    await expect(heading(page)).toHaveText('Alpha');
  });
});

test.describe('Clear', () => {
  test('Clear empties the list and closes the menu', async ({ page }) => {
    await openFiles(page, ABC);
    await openRecentMenu(page);
    await submenu(page).getByRole('menuitem', { name: 'Clear' }).click();
    await expect(menu(page)).toBeHidden();
    await expect.poll(() => freshRecentItems(page)).toEqual([]);
    expect(await submenuLayout(page)).toEqual([
      { tag: 'BUTTON', text: 'No recent files', disabled: true },
      { tag: 'HR', text: '', disabled: false },
      { tag: 'BUTTON', text: 'Clear', disabled: true },
    ]);
  });

  test('Clear does not close the open documents', async ({ page }) => {
    await openFiles(page, ABC);
    await rerender(page, () => tab(page, 'b.md').click());
    await openRecentMenu(page);
    await submenu(page).getByRole('menuitem', { name: 'Clear' }).click();
    await expect.poll(() => freshRecentItems(page)).toEqual([]);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    expect(await tabs(page)).toEqual({ names: ['a.md', 'b.md', 'c.md'], active: 'b.md' });
    await expect(heading(page)).toHaveText('Beta');
    await expect(page).toHaveTitle('b.md');
    expect(await statusText(page)).toBe('');
  });

  test('Clear does not delete the files from disk', async ({ page }) => {
    await openFiles(page, ABC);
    await openRecentMenu(page);
    await submenu(page).getByRole('menuitem', { name: 'Clear' }).click();
    await expect.poll(() => freshRecentItems(page)).toEqual([]);
    const onDisk = await page.evaluate(async () => {
      const names = [];
      for await (const name of (await navigator.storage.getDirectory()).keys()) names.push(name);
      return names.sort();
    });
    expect(onDisk).toEqual(['a.md', 'b.md', 'c.md']);
  });

  test('files viewed after Clear are listed again', async ({ page }) => {
    await openFiles(page, ABC);
    await openRecentMenu(page);
    await submenu(page).getByRole('menuitem', { name: 'Clear' }).click();
    await expect.poll(() => freshRecentItems(page)).toEqual([]);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await openFiles(page, [doc('b.md', 'Beta')]);
    expect(await freshRecentItems(page)).toEqual(['b.md']);
    await expect(submenu(page).getByRole('menuitem', { name: 'Clear' })).toBeEnabled();
  });

  test('a file named Clear is listed as a file, above the separator, and opens when chosen', async ({ page }) => {
    await openFiles(page, [{ name: 'Clear', content: '# A file called Clear' }, doc('b.md', 'Beta')]);
    await clickFileMenuItem(page, 'Close All');
    await expect(heading(page)).toHaveText('Markdown Viewer');
    expect(await recentItems(page)).toEqual(['b.md', 'Clear']);
    await submenu(page).locator('button').nth(1).click();   // the file, not the command
    await expect(heading(page)).toHaveText('A file called Clear');
    expect(await freshRecentItems(page)).toEqual(['Clear', 'b.md']);
  });
});

test.describe('persistence and other windows', () => {
  test('the list survives a reload of the page, the open documents do not', async ({ page }) => {
    await openOneByOne(page, ABC);
    await page.reload();
    await page.waitForFunction(() => typeof openHandles === 'function');
    await expect(heading(page)).toHaveText('Markdown Viewer');
    expect(await shownFilename(page)).toBe('No file open');
    expect(await recentItems(page)).toEqual(['c.md', 'b.md', 'a.md']);
  });

  test('after a reload of the page an entry still opens its file', async ({ page }) => {
    await openOneByOne(page, ABC);
    await page.reload();
    await page.waitForFunction(() => typeof openHandles === 'function');
    await clickRecentItem(page, 'a.md');
    await expect(heading(page)).toHaveText('Alpha');
    expect(await shownFilename(page)).toBe('a.md');
    expect(await statusText(page)).toBe('');
    expect(await freshRecentItems(page)).toEqual(['a.md', 'c.md', 'b.md']);
  });

  test('a cleared list is still empty after a reload of the page', async ({ page }) => {
    await openFiles(page, ABC);
    await openRecentMenu(page);
    await submenu(page).getByRole('menuitem', { name: 'Clear' }).click();
    await expect.poll(() => freshRecentItems(page)).toEqual([]);
    await page.reload();
    await page.waitForFunction(() => typeof openHandles === 'function');
    expect(await recentItems(page)).toEqual([]);
  });

  test('a second window of the app shows the same list', async ({ page, context }) => {
    await openOneByOne(page, ABC);
    const second = await context.newPage();
    await openApp(second);
    expect(await recentItems(second)).toEqual(['c.md', 'b.md', 'a.md']);
    // Having the list does not open anything in the second window.
    expect(await shownFilename(second)).toBe('No file open');
  });

  test('an entry chosen in a second window opens there and not in the first', async ({ page, context }) => {
    await openFiles(page, [doc('a.md', 'Alpha'), doc('b.md', 'Beta')]);
    const second = await context.newPage();
    await openApp(second);
    await clickRecentItem(second, 'b.md');
    await expect(view(second).locator('h1')).toHaveText('Beta');
    expect(await shownFilename(second)).toBe('b.md');
    expect(await tabs(page)).toEqual({ names: ['a.md', 'b.md'], active: 'a.md' });
    await expect(heading(page)).toHaveText('Alpha');
  });

  test('a file viewed in one window is listed in the other the next time its menu opens', async ({ page, context }) => {
    await openMarkdown(page, '# One', 'one.md');
    const second = await context.newPage();
    await openApp(second);
    expect(await recentItems(second)).toEqual(['one.md']);
    await openFiles(page, [doc('two.md', 'Two')]);
    expect(await freshRecentItems(second)).toEqual(['two.md', 'one.md']);
    expect(await freshRecentItems(page)).toEqual(['two.md', 'one.md']);
  });

  test('Clear in one window is seen by the other the next time its menu opens', async ({ page, context }) => {
    await openFiles(page, ABC);
    const second = await context.newPage();
    await openApp(second);
    await openFiles(second, [doc('d.md', 'Delta')]);
    expect(await freshRecentItems(second)).toEqual(['d.md', 'c.md', 'b.md', 'a.md']);
    await second.keyboard.press('Escape');
    await second.keyboard.press('Escape');

    await openRecentMenu(page);
    await submenu(page).getByRole('menuitem', { name: 'Clear' }).click();
    await expect(menu(page)).toBeHidden();

    await expect.poll(() => freshRecentItems(second)).toEqual([]);
    await expect(submenu(second).getByRole('menuitem', { name: 'Clear' })).toBeDisabled();
    // Clearing closed nothing, in either window.
    expect(await shownFilename(second)).toBe('d.md');
    expect(await tabs(page)).toEqual({ names: ['a.md', 'b.md', 'c.md'], active: 'a.md' });
  });
});
