'use strict';

// Bump when the list of files changes, so stale caches are dropped.
const CACHE = 'markdown-viewer-v1';

const ASSETS = [
  './',
  'style.css',
  'app.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'vendor/marked/marked.umd.js',
  'vendor/dompurify/purify.min.js',
  'vendor/highlight/highlight.min.js',
  'vendor/highlight/github.min.css',
  'vendor/highlight/github-dark.min.css',
  'vendor/katex/katex.min.js',
  'vendor/katex/katex.min.css',
  'vendor/mermaid/mermaid.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ASSETS.map((u) => new Request(u, { cache: 'no-cache' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network first, so edits to the app show up immediately while the local
// server runs; cache fallback, so the installed app still starts without it.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(req, { cache: 'no-cache' });
      if (res.ok) cache.put(req, res.clone());   // also picks up KaTeX fonts on first use
      return res;
    } catch (err) {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});
