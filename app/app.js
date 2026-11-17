'use strict';

const view = document.getElementById('view');
const filenameEl = document.getElementById('filename');
const statusEl = document.getElementById('status');
const tabsEl = document.getElementById('tabs');
const emptyEl = document.getElementById('empty');
const fileMenuBtn = document.getElementById('file-menu-btn');
const fileMenu = document.getElementById('file-menu');
const recentBtn = document.getElementById('recent-btn');
const recentMenu = document.getElementById('recent-menu');
const installBtn = document.getElementById('install');
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

const docs = [];            // open documents: { handle, name, source, scroll }
let active = -1;            // index into docs of the one being shown, -1 if none
let renderSeq = 0;          // guards against overlapping async renders

/* ---------- Markdown → HTML ---------- */

const escapeAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  .replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Math is emitted as inert placeholders and typeset by KaTeX only after the
// HTML has been sanitized, so KaTeX markup never has to pass the sanitizer.
const mathPlaceholder = (tex, display) => display
  ? `<div class="math" data-display="1" data-tex="${escapeAttr(tex)}"></div>\n`
  : `<span class="math" data-tex="${escapeAttr(tex)}"></span>`;

marked.use({
  gfm: true,
  extensions: [
    {
      name: 'mathBlock',
      level: 'block',
      start(src) { const i = src.indexOf('$$'); return i < 0 ? undefined : i; },
      tokenizer(src) {
        const m = /^\$\$([\s\S]+?)\$\$[ \t]*(?:\n|$)/.exec(src);
        if (m) return { type: 'mathBlock', raw: m[0], text: m[1].trim() };
      },
      renderer(token) { return mathPlaceholder(token.text, true); },
    },
    {
      name: 'mathInline',
      level: 'inline',
      start(src) { const i = src.indexOf('$'); return i < 0 ? undefined : i; },
      tokenizer(src) {
        let m = /^\$\$([^\n]+?)\$\$/.exec(src);
        if (m) return { type: 'mathInline', raw: m[0], text: m[1].trim(), display: true };
        // Opening $ must be followed by a non-space, closing $ must follow a
        // non-space and not be followed by a digit, so "$5 and $10" stays text.
        m = /^\$((?:\\.|[^\\$\n])+?)\$(?!\d)/.exec(src);
        if (m && !/^\s|\s$/.test(m[1])) {
          return { type: 'mathInline', raw: m[0], text: m[1], display: false };
        }
      },
      renderer(token) { return mathPlaceholder(token.text, token.display); },
    },
  ],
});

function slugify(text, used) {
  const base = text.trim().toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-') || 'section';
  let slug = base;
  for (let n = 1; used.has(slug); n++) slug = `${base}-${n}`;
  used.add(slug);
  return slug;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.append(s);
  });
}

let mermaidLoading = null;
function loadMermaid() {
  mermaidLoading ??= loadScript('vendor/mermaid/mermaid.min.js');
  return mermaidLoading;
}

async function renderMermaid(root, seq) {
  const blocks = root.querySelectorAll('pre > code.language-mermaid');
  if (!blocks.length) return;
  await loadMermaid();
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: darkQuery.matches ? 'dark' : 'default',
  });
  let n = 0;
  for (const code of blocks) {
    if (seq !== renderSeq) return;
    const pre = code.parentElement;
    try {
      const { svg } = await mermaid.render(`mermaid-${seq}-${n++}`, code.textContent);
      const figure = document.createElement('div');
      figure.className = 'mermaid-diagram';
      figure.innerHTML = svg;
      pre.replaceWith(figure);
    } catch (err) {
      const note = document.createElement('p');
      note.className = 'render-error';
      note.textContent = `Mermaid: ${err.message || err}`;
      pre.before(note);
      // Mermaid leaves its error graphic in the document; remove it.
      document.querySelectorAll('body > [id^="dmermaid-"]').forEach((el) => el.remove());
    }
  }
}

function typesetMath(root) {
  // GitHub also accepts ```math fenced blocks.
  for (const code of root.querySelectorAll('pre > code.language-math')) {
    const div = document.createElement('div');
    div.className = 'math';
    div.dataset.display = '1';
    div.dataset.tex = code.textContent;
    code.parentElement.replaceWith(div);
  }
  for (const el of root.querySelectorAll('.math[data-tex]')) {
    katex.render(el.dataset.tex, el, {
      displayMode: el.dataset.display === '1',
      throwOnError: false,
    });
  }
}

function highlightCode(root) {
  for (const code of root.querySelectorAll('pre > code[class*="language-"]')) {
    const lang = /language-([^\s]+)/.exec(code.className)[1];
    if (lang !== 'mermaid' && hljs.getLanguage(lang)) hljs.highlightElement(code);
  }
}

function fixLinks(root) {
  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (href.startsWith('#')) continue;
    if (/^(https?:|mailto:)/i.test(href)) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    } else {
      // The app only holds a handle to one file, so it cannot follow links to
      // neighbouring files.
      a.classList.add('unresolved');
      a.title = `Relative link (${href}) cannot be followed from the viewer`;
    }
  }
}

async function render(source, scroll = 0) {
  const seq = ++renderSeq;
  const html = DOMPurify.sanitize(marked.parse(source), { FORBID_TAGS: ['style', 'form'] });
  const root = document.createElement('div');
  root.innerHTML = html;

  const used = new Set();
  for (const h of root.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
    if (!h.id) h.id = slugify(h.textContent, used);
  }
  fixLinks(root);
  typesetMath(root);
  highlightCode(root);

  view.replaceChildren(...root.childNodes);
  window.scrollTo(0, scroll);
  await renderMermaid(view, seq);
}

/* ---------- Documents and tabs ---------- */

function setStatus(text) { statusEl.textContent = text; }

function buildTab(doc, i) {
  const tab = document.createElement('div');
  tab.className = 'tab';
  tab.setAttribute('role', 'tab');
  tab.setAttribute('aria-selected', String(i === active));
  tab.tabIndex = 0;
  tab.title = doc.name;
  const label = document.createElement('span');
  label.textContent = doc.name;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'tab-close';
  close.setAttribute('aria-label', `Close ${doc.name}`);
  close.textContent = '×';
  close.addEventListener('click', (e) => { e.stopPropagation(); closeDoc(i); });
  tab.addEventListener('click', () => activate(i));
  tab.addEventListener('auxclick', (e) => { if (e.button === 1) closeDoc(i); });
  tab.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(i); }
  });
  tab.append(label, close);
  return tab;
}

// Brings the page in line with docs/active. The tab bar exists only while
// more than one document is open.
function showActive() {
  const doc = docs[active];
  tabsEl.hidden = docs.length < 2;
  tabsEl.replaceChildren(...docs.map(buildTab));
  filenameEl.hidden = docs.length > 1;
  for (const item of fileMenu.querySelectorAll('[data-needs-doc]')) item.disabled = !doc;
  if (!doc) {
    renderSeq++;
    filenameEl.textContent = 'No file open';
    document.title = 'Markdown Viewer';
    view.replaceChildren(emptyEl);
    return Promise.resolve();
  }
  filenameEl.textContent = doc.name;
  document.title = doc.name;
  return render(doc.source, doc.scroll);
}

function saveScroll() {
  if (docs[active]) docs[active].scroll = window.scrollY;
}

function activate(i) {
  saveScroll();
  active = i;
  return showActive();
}

// Opens each handle in its own tab (re-reading it if it is already open) and
// shows the first one.
async function openHandles(handles) {
  let first = -1;
  setStatus('');
  for (const handle of handles) {
    try {
      let i = -1;
      for (let k = 0; k < docs.length && i < 0; k++) {
        if (await handle.isSameEntry(docs[k].handle)) i = k;
      }
      const file = await handle.getFile();
      const source = await file.text();
      if (i < 0) i = docs.push({ handle, name: file.name, source, scroll: 0 }) - 1;
      else docs[i].source = source;
      await rememberRecent(handle, file.name);
      if (first < 0) first = i;
    } catch (err) {
      setStatus(`Could not read ${handle.name}: ${err.message || err}`);
    }
  }
  if (first >= 0) await activate(first);
}

async function reloadActive() {
  const doc = docs[active];
  if (!doc) return;
  try {
    doc.source = await (await doc.handle.getFile()).text();
    setStatus('');
  } catch (err) {
    setStatus(`Could not read ${doc.name}: ${err.message || err}`);
    return;
  }
  saveScroll();
  await showActive();
}

function closeDoc(i) {
  if (!docs[i]) return;
  saveScroll();
  docs.splice(i, 1);
  if (i < active) active--;
  else if (i === active) active = Math.min(i, docs.length - 1);
  return showActive();
}

function closeAll() {
  docs.length = 0;
  active = -1;
  return showActive();
}

async function pickFile() {
  let handles;
  try {
    handles = await window.showOpenFilePicker({
      multiple: true,
      types: [{
        description: 'Markdown',
        accept: { 'text/markdown': ['.md', '.markdown', '.mdown', '.mkd'] },
      }],
    });
  } catch (err) {
    if (err.name !== 'AbortError') setStatus(String(err.message || err));
    return;
  }
  await openHandles(handles);
}

// Files arrive here when the installed app is started by the OS file handler
// or by the markdown-viewer launcher (File Handling API): one tab per file.
if ('launchQueue' in window) {
  window.launchQueue.setConsumer((params) => {
    if (params.files && params.files.length) openHandles([...params.files]);
  });
}

/* ---------- Recently viewed ---------- */

// File handles can be stored in IndexedDB, which is what lets a file be opened
// again later without the file picker.
const RECENT_MAX = 10;

function recentStore(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('markdown-viewer', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('kv', mode);
      const req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => { db.close(); resolve(req.result); };
      tx.onabort = tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
}
const getRecent = async () => (await recentStore('readonly', (st) => st.get('recent'))) || [];
const setRecent = (list) => recentStore('readwrite', (st) => st.put(list, 'recent'));

async function rememberRecent(handle, name) {
  try {
    const kept = [];
    for (const entry of await getRecent()) {
      if (!(await handle.isSameEntry(entry.handle))) kept.push(entry);
    }
    await setRecent([{ name, handle }, ...kept].slice(0, RECENT_MAX));
  } catch (err) {
    console.warn('Could not update the recently viewed list', err);
  }
}

async function openRecent(handle) {
  try {
    // Permission to read a stored handle may have lapsed; asking again needs
    // the user gesture this menu click provides.
    if ((await handle.queryPermission({ mode: 'read' })) !== 'granted'
        && (await handle.requestPermission({ mode: 'read' })) !== 'granted') {
      setStatus('Permission to read the file was not granted');
      return;
    }
  } catch (err) {
    setStatus(`Could not read file: ${err.message || err}`);
    return;
  }
  await openHandles([handle]);
}

async function fillRecentMenu() {
  let list = [];
  try { list = await getRecent(); } catch (err) { console.warn(err); }
  const items = list.map((entry) => {
    const b = menuItem(entry.name);
    b.addEventListener('click', () => { closeMenu(); openRecent(entry.handle); });
    return b;
  });
  if (!items.length) {
    const none = menuItem('No recent files');
    none.disabled = true;
    items.push(none);
  }
  const clear = menuItem('Clear');
  clear.disabled = !list.length;
  clear.addEventListener('click', async () => { closeMenu(); await setRecent([]); });
  recentMenu.replaceChildren(...items, document.createElement('hr'), clear);
}

/* ---------- File menu ---------- */

function menuItem(label) {
  const b = document.createElement('button');
  b.type = 'button';
  b.setAttribute('role', 'menuitem');
  b.textContent = label;
  return b;
}

const enabledItems = (menu) =>
  [...menu.querySelectorAll('[role="menuitem"]')]
    .filter((el) => !el.disabled && el.closest('.menu') === menu);

function openSubmenu(focusFirst) {
  recentMenu.hidden = false;
  recentBtn.setAttribute('aria-expanded', 'true');
  if (focusFirst) enabledItems(recentMenu)[0]?.focus();
}
function closeSubmenu() {
  recentMenu.hidden = true;
  recentBtn.setAttribute('aria-expanded', 'false');
}
async function openMenu() {
  await fillRecentMenu();
  fileMenu.hidden = false;
  fileMenuBtn.setAttribute('aria-expanded', 'true');
  enabledItems(fileMenu)[0]?.focus();
}
function closeMenu() {
  closeSubmenu();
  fileMenu.hidden = true;
  fileMenuBtn.setAttribute('aria-expanded', 'false');
}

function exitApp() {
  window.close();
  // Chrome refuses to close some windows from script (for example an ordinary
  // browser tab with history); say so instead of doing nothing.
  setTimeout(() => setStatus('This window cannot be closed by the app; use the window\'s close button'), 300);
}

const actions = {
  open: pickFile,
  reload: reloadActive,
  close: () => closeDoc(active),
  closeAll,
  exit: exitApp,
};

fileMenuBtn.addEventListener('click', () => (fileMenu.hidden ? openMenu() : closeMenu()));

fileMenu.addEventListener('click', (e) => {
  const item = e.target.closest('[data-action]');
  if (!item || item.disabled) return;
  closeMenu();
  actions[item.dataset.action]();
});

recentBtn.addEventListener('click', () => (recentMenu.hidden ? openSubmenu(true) : closeSubmenu()));
// With a mouse the submenu follows the pointer, like a desktop menu.
fileMenu.addEventListener('mouseover', (e) => {
  const item = e.target.closest('[role="menuitem"]');
  if (!item) return;
  if (item === recentBtn) openSubmenu(false);
  else if (item.closest('.menu') === fileMenu) closeSubmenu();
});

document.addEventListener('mousedown', (e) => {
  if (!fileMenu.hidden && !e.target.closest('#menubar')) closeMenu();
});
window.addEventListener('blur', closeMenu);

// F5 and Ctrl+R would reload the page, which forgets the open files; make them
// re-read the current file instead. Ctrl+Shift+R and Ctrl+F5 still reload the
// page itself.
document.addEventListener('keydown', (e) => {
  const key = e.key.toLowerCase();
  if (e.shiftKey || e.altKey || e.metaKey) return;
  if ((key === 'f5' && !e.ctrlKey) || (key === 'r' && e.ctrlKey)) {
    e.preventDefault();
    reloadActive();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (fileMenu.hidden) {
    if (e.key === 'o') pickFile();
    else if (e.key === 'r') reloadActive();
    return;
  }
  const inSub = !recentMenu.hidden && recentMenu.contains(document.activeElement);
  const items = enabledItems(inSub ? recentMenu : fileMenu);
  const at = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') items[(at + 1) % items.length]?.focus();
  else if (e.key === 'ArrowUp') items[(at - 1 + items.length) % items.length]?.focus();
  else if (e.key === 'ArrowRight' && document.activeElement === recentBtn) openSubmenu(true);
  else if (e.key === 'ArrowLeft' && inSub) { closeSubmenu(); recentBtn.focus(); }
  else if (e.key === 'Escape') {
    if (inSub) { closeSubmenu(); recentBtn.focus(); } else { closeMenu(); fileMenuBtn.focus(); }
  } else return;
  e.preventDefault();
});

view.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (!a) return;
  const href = a.getAttribute('href');
  if (href.startsWith('#')) {
    e.preventDefault();
    let id = href.slice(1);
    try { id = decodeURIComponent(id); } catch { /* keep raw */ }
    (document.getElementById(id) || document.body).scrollIntoView();
  } else if (a.classList.contains('unresolved')) {
    e.preventDefault();
    setStatus(a.title);
  }
});

// Diagrams and code colours follow the OS colour scheme.
darkQuery.addEventListener('change', () => {
  if (docs[active]) { saveScroll(); showActive(); }
});

/* ---------- PWA plumbing ---------- */

const standalone = window.matchMedia('(display-mode: standalone)').matches;
if (!standalone) document.getElementById('install-hint').hidden = false;

let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  installBtn.hidden = false;
});
installBtn.addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  installBtn.hidden = true;
});
window.addEventListener('appinstalled', () => {
  installBtn.hidden = true;
  document.getElementById('install-hint').hidden = true;
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((err) => {
    console.warn('Service worker registration failed', err);
  });
}
