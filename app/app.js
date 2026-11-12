'use strict';

const view = document.getElementById('view');
const filenameEl = document.getElementById('filename');
const statusEl = document.getElementById('status');
const openBtn = document.getElementById('open');
const reloadBtn = document.getElementById('reload');
const installBtn = document.getElementById('install');
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

let currentHandle = null;   // FileSystemFileHandle of the open document
let currentSource = null;   // its Markdown text
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

async function render(source) {
  const seq = ++renderSeq;
  const scroll = window.scrollY;
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

/* ---------- Files ---------- */

function setStatus(text) { statusEl.textContent = text; }

async function loadFromHandle(handle) {
  try {
    const file = await handle.getFile();
    currentSource = await file.text();
    currentHandle = handle;
    filenameEl.textContent = file.name;
    document.title = `${file.name} – Markdown Viewer`;
    reloadBtn.disabled = false;
    setStatus('');
    await render(currentSource);
  } catch (err) {
    setStatus(`Could not read file: ${err.message || err}`);
  }
}

async function pickFile() {
  let handle;
  try {
    [handle] = await window.showOpenFilePicker({
      types: [{
        description: 'Markdown',
        accept: { 'text/markdown': ['.md', '.markdown', '.mdown', '.mkd'] },
      }],
    });
  } catch (err) {
    if (err.name !== 'AbortError') setStatus(String(err.message || err));
    return;
  }
  window.scrollTo(0, 0);
  await loadFromHandle(handle);
}

// Files arrive here when the installed app is started by the OS file handler
// or by the markdown-viewer launcher (File Handling API).
if ('launchQueue' in window) {
  window.launchQueue.setConsumer((params) => {
    if (params.files && params.files.length) loadFromHandle(params.files[0]);
  });
}

openBtn.addEventListener('click', pickFile);
reloadBtn.addEventListener('click', () => currentHandle && loadFromHandle(currentHandle));

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'o') pickFile();
  else if (e.key === 'r' && currentHandle) loadFromHandle(currentHandle);
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
  if (currentSource !== null) render(currentSource);
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
