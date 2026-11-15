'use strict';
// Cache only this application's public assets. Host credentials and arbitrary requests never enter it.
const PREFIX = 'minicore-web-';
const CACHE = PREFIX + '0.1.1';
const BASE = new URL('./', self.location.href);
const SHELL = [
  './', './index.html', './app.css', './theme.js', './main.js', './core.js', './ui.js', './net.js', './host.js', './host-state.js', './host-app.js',
  './sessions.js', './conversation.js', './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png', './icon-maskable.png', './apple-touch-icon.png',
].map(path => new URL(path, BASE).href);
const ASSETS = new Set(SHELL);

addEventListener('install', e => {
  skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(url => new Request(url, { credentials: 'omit' })))));
});
addEventListener('activate', e => e.waitUntil(caches.keys()
  .then(keys => Promise.all(keys.filter(k => k.startsWith(PREFIX) && k !== CACHE).map(k => caches.delete(k))))
  .then(() => clients.claim())));
addEventListener('fetch', e => {
  const request = e.request, url = new URL(request.url);
  if (request.method !== 'GET' || url.search || !ASSETS.has(url.href) || request.headers.has('Authorization')) return;
  const cached = () => caches.open(CACHE).then(c => c.match(url.href));
  e.respondWith(fetch(new Request(request, { credentials: 'omit' })).then(r => {
    // Redirects and proxy error pages must never replace an application asset.
    if (r.ok && !r.redirected && r.type !== 'opaque') {
      const copy = r.clone();
      e.waitUntil(caches.open(CACHE).then(c => c.put(url.href, copy)));
    }
    if (r.status < 500) return r;
    return cached().then(c => c || r);
  }, () => cached().then(c => c || Response.error())));
});
addEventListener('notificationclick', e => {
  e.notification.close();
  const id = e.notification.data && e.notification.data.session;
  e.waitUntil(clients.matchAll({ type: 'window' }).then(list => {
    const c = list.find(client => client.url.startsWith(BASE.href));
    if (!c) return clients.openWindow(BASE.href);
    c.postMessage({ open: id });
    return c.focus();
  }));
});
