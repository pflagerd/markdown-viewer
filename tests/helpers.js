// Shared conventions for every spec file.
//
//   const { test, expect, openApp, openFiles, ... } = require('./helpers');
//
// IMPORTANT: import `test` from here, NOT from '@playwright/test'.
//
// Why: the app keeps FileSystemFileHandle objects in IndexedDB (Recently
// Viewed). Playwright's normal `context` fixture is an off-the-record
// (incognito-like) browser context, and in Chromium 1243 reading a file handle
// back out of IndexedDB in such a context kills the whole browser process
// (SIGTRAP; "Target page, context or browser has been closed") - headless
// shell, new headless and headed alike. In a regular profile the same code
// works. So the `context`/`page` fixtures below start a *persistent* context
// on a brand-new, empty profile directory for every test. That is the real
// app code against the real IndexedDB, nothing is stubbed, and every test
// still starts with empty storage (no IndexedDB, no private file system, no
// service worker, no caches).
//
// What tests cannot do: drive the native file picker (File > Open...) or the
// File Handling API launch queue. Files are created in the origin private file
// system instead and handed to the app's own openHandles(), which is exactly
// what the picker and the launch queue call. Handles from the private file
// system never need a permission prompt, so the permission branch of
// "Recently Viewed" is not exercised.

const base = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const expect = base.expect;

const test = base.test.extend({
  context: async ({ playwright, browserName, launchOptions, headless, channel, baseURL,
    viewport, colorScheme, locale, timezoneId }, use) => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'markdown-viewer-test-'));
    const context = await playwright[browserName].launchPersistentContext(profile, {
      ...launchOptions,
      headless,
      channel,
      baseURL,
      viewport,
      colorScheme,
      locale,
      timezoneId,
    });
    await use(context);
    await context.close();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  },
  page: async ({ context }, use) => {
    await use(context.pages()[0] || await context.newPage());
  },
});

/* ---------- starting the app, collecting errors ---------- */

const errorLogs = new WeakMap();   // page -> [{ text, url }]

// Errors that are expected in every test and say nothing about the app.
const ALWAYS_IGNORED = [
  // GET /api/config exists only on the project's own server.js; a plain static
  // server answers 404, which the app must tolerate.
  (e) => /Failed to load resource/.test(e.text) && /\/api\/config(\?|$)/.test(e.url),
];

/**
 * Loads the app and waits until its scripts have run.
 * Starts recording uncaught exceptions and console errors; read them with
 * appErrors(page).
 */
async function openApp(page) {
  if (!errorLogs.has(page)) {
    const log = [];
    errorLogs.set(page, log);
    page.on('pageerror', (err) => log.push({ text: `pageerror: ${err.message}`, url: '' }));
    page.on('console', (msg) => {
      if (msg.type() === 'error') log.push({ text: msg.text(), url: msg.location().url || '' });
    });
  }
  await page.goto('/');
  // app.js is the last script and declares openHandles at top level; the
  // vendored libraries it needs are loaded before it.
  await page.waitForFunction(() => typeof openHandles === 'function'
    && [typeof marked, typeof DOMPurify, typeof hljs, typeof katex].every((t) => t !== 'undefined'));
}

/**
 * Uncaught exceptions and console errors seen since openApp(), as strings.
 * `ignore` lists what the test itself provokes on purpose, as RegExps matched
 * against "<message> <url>", e.g. appErrors(page, [/\/missing\.png$/]) for an
 * image that is meant not to load, or [/Content Security Policy/].
 * Typical use: expect(appErrors(page)).toEqual([]);
 */
function appErrors(page, ignore = []) {
  return (errorLogs.get(page) || [])
    .filter((e) => !ALWAYS_IGNORED.some((fn) => fn(e)))
    .map((e) => (e.url ? `${e.text} ${e.url}` : e.text))
    .filter((line) => !ignore.some((re) => re.test(line)));
}

/* ---------- files ---------- */

/**
 * Creates or overwrites a file "on disk" (the origin private file system).
 * The app does not notice by itself; use File > Reload.
 */
async function writeFile(page, name, content) {
  await page.evaluate(async ([name, content]) => {
    const dir = await navigator.storage.getDirectory();
    const handle = await dir.getFileHandle(name, { create: true });
    const w = await handle.createWritable();
    await w.write(content);
    await w.close();
  }, [name, content]);
}

/** Deletes a file "on disk", e.g. to test a file that vanished. */
async function removeFile(page, name) {
  await page.evaluate(async (name) => {
    await (await navigator.storage.getDirectory()).removeEntry(name);
  }, name);
}

/**
 * Writes the files and opens them the way a launch with those files does:
 * one document per file, in order, the first one showing.
 * `files` is an ordered list of { name, content }. Resolves when the visible
 * document has been rendered completely, Mermaid diagrams included
 * (openHandles() awaits the whole render).
 */
async function openFiles(page, files) {
  for (const f of files) await writeFile(page, f.name, f.content);
  await page.evaluate(async (names) => {
    const dir = await navigator.storage.getDirectory();
    const handles = [];
    for (const name of names) handles.push(await dir.getFileHandle(name));
    await openHandles(handles);
  }, files.map((f) => f.name));
  await waitForRendered(page);
}

/** Shorthand: open one document called doc.md with this Markdown. */
async function openMarkdown(page, content, name = 'doc.md') {
  await openFiles(page, [{ name, content }]);
}

/* ---------- rendering ---------- */

/** The rendered document root. */
function view(page) { return page.locator('#view'); }

/**
 * Waits until no Mermaid block is still waiting to be drawn: every
 * ```mermaid block has either become a diagram or has an error note above it.
 * Returns at once for documents without Mermaid.
 */
async function waitForRendered(page) {
  await page.waitForFunction(() =>
    [...document.querySelectorAll('#view pre > code.language-mermaid')]
      .every((code) => code.parentElement.previousElementSibling?.classList.contains('render-error')));
}

/**
 * Runs `action` (something that makes the app render the document again:
 * Reload, switching tabs, changing the colour scheme, ...) and waits until the
 * old rendering has been replaced and the new one is complete.
 */
async function rerender(page, action) {
  await page.evaluate(() => {
    window.__staleRender = document.querySelector('#view').firstElementChild;
  });
  await action();
  await page.waitForFunction(() => !window.__staleRender || !window.__staleRender.isConnected);
  await waitForRendered(page);
}

/** Text of the status area in the toolbar ('' when there is no message). */
async function statusText(page) {
  return (await page.locator('#status').textContent()).trim();
}

/* ---------- tabs ---------- */

/**
 * { names, active }: labels of the tabs in the tab bar, in order, and the
 * label of the selected one. The tab bar is only shown for two or more
 * documents; when it is hidden this returns { names: [], active: null }.
 * For the single-document case use shownFilename(page).
 */
async function tabs(page) {
  return page.evaluate(() => {
    const bar = document.querySelector('#tabs');
    if (!bar || bar.hidden || !bar.getClientRects().length) return { names: [], active: null };
    const all = [...bar.querySelectorAll('[role="tab"]')];
    const label = (t) => (t.querySelector('span') || t).textContent;
    const sel = all.find((t) => t.getAttribute('aria-selected') === 'true');
    return { names: all.map(label), active: sel ? label(sel) : null };
  });
}

/** Locator of the tab with this label. */
function tab(page, name) {
  return page.locator('#tabs [role="tab"]').filter({ has: page.getByText(name, { exact: true }) });
}

/** File name shown in the toolbar when there is no tab bar, else null. */
async function shownFilename(page) {
  const el = page.locator('#filename');
  return (await el.isVisible()) ? (await el.textContent()).trim() : null;
}

/* ---------- File menu ---------- */

const fileMenu = (page) => page.locator('#file-menu');

/** Opens the File menu (no-op when it is already open). */
async function openFileMenu(page) {
  if (!(await fileMenu(page).isVisible())) await page.locator('#file-menu-btn').click();
  await expect(fileMenu(page)).toBeVisible();
}

/**
 * Locator of a top-level File menu item by its label, without the shortcut
 * hint: fileMenuItem(page, 'Reload'), 'Open…', 'Close', 'Close All', 'Exit',
 * 'Recently Viewed'.
 */
function fileMenuItem(page, label) {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The label is followed by an optional shortcut (<kbd>) or submenu arrow.
  return page.locator('#file-menu > [role="menuitem"], #recent-btn')
    .filter({ hasText: new RegExp(`^\\s*${esc}\\s*(F5|O|▸)?\\s*$`) });
}

/** Opens the File menu if necessary and clicks the item with this label. */
async function clickFileMenuItem(page, label) {
  await openFileMenu(page);
  await fileMenuItem(page, label).click();
}

/** Opens File > Recently Viewed and leaves it open. */
async function openRecentMenu(page) {
  await openFileMenu(page);
  const sub = page.locator('#recent-menu');
  if (!(await sub.isVisible())) await page.locator('#recent-btn').click();
  await expect(sub).toBeVisible();
}

/**
 * File names listed under File > Recently Viewed, newest first ([] when the
 * list is empty). Leaves the submenu open so an entry can be clicked next.
 */
async function recentItems(page) {
  await openRecentMenu(page);
  // Entries come first, then a separator, then "Clear".
  return page.locator('#recent-menu').evaluate((menu) => {
    const names = [];
    for (const el of menu.children) {
      if (el.tagName === 'HR') break;
      if (!el.disabled) names.push(el.textContent);   // disabled = "No recent files"
    }
    return names;
  });
}

/** Opens File > Recently Viewed and clicks the entry with this file name. */
async function clickRecentItem(page, name) {
  await openRecentMenu(page);
  await page.locator('#recent-menu [role="menuitem"]').filter({ hasText: name }).first().click();
}

module.exports = {
  test, expect,
  openApp, appErrors,
  writeFile, removeFile, openFiles, openMarkdown,
  view, waitForRendered, rerender, statusText,
  tabs, tab, shownFilename,
  openFileMenu, fileMenuItem, clickFileMenuItem, openRecentMenu, recentItems, clickRecentItem,
};
