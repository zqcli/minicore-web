import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../web/sw.js', import.meta.url), 'utf8');
function worker() {
  const listeners = new Map(), deleted = [], installed = [], written = [], fetched = [];
  const cache = {
    addAll: async requests => installed.push(...requests),
    put: async (url, response) => written.push([url, await response.text()]),
    match: async () => new Response('cached asset'),
  };
  vm.runInNewContext(source, {
    URL, Request, Response, Set, Promise,
    self: { location: { href: 'https://static.example/app/sw.js' } },
    addEventListener: (name, listener) => listeners.set(name, listener),
    skipWaiting() {},
    clients: { claim: async () => {}, matchAll: async () => [] },
    caches: {
      open: async () => cache,
      keys: async () => ['unrelated-app', 'minicore-29', 'minicore-web-0.0.1', 'minicore-web-0.1.0'],
      delete: async name => deleted.push(name),
    },
    fetch: async request => { fetched.push(request); return new Response('fresh asset'); },
  });
  async function dispatch(name, request) {
    const waits = [];
    let response;
    listeners.get(name)({ request, waitUntil: promise => waits.push(promise), respondWith: promise => { response = promise; } });
    const value = await response;
    await Promise.all(waits);
    return value;
  }
  return { dispatch, deleted, installed, written, fetched };
}

test('installation uses only public assets beneath the application scope and omits credentials', async () => {
  const w = worker();
  await w.dispatch('install');
  assert.ok(w.installed.some(request => request.url.endsWith('/host.js')));
  assert.ok(w.installed.some(request => request.url.endsWith('/host-state.js')));
  assert.ok(w.installed.every(request => request.url.startsWith('https://static.example/app/') && request.credentials === 'omit'));
  assert.ok(w.installed.every(request => !request.url.endsWith('/config.json')));
});

test('activation removes only obsolete caches owned by MiniCore Web', async () => {
  const w = worker();
  await w.dispatch('activate');
  assert.deepEqual(w.deleted, ['minicore-web-0.0.1']);
});

test('nonassets, authorization, query strings, other origins and mutations bypass the cache handler', async () => {
  const w = worker();
  for (const request of [
    new Request('https://static.example/app/config.json'),
    new Request('https://static.example/app/private-data'),
    new Request('https://static.example/app/main.js?access_key=must-not-cache'),
    new Request('https://host.example/app/main.js'),
    new Request('https://static.example/app/main.js', { headers: { Authorization: 'Bearer fixture' } }),
    new Request('https://static.example/app/main.js', { method: 'POST', body: 'fixture' }),
  ]) assert.equal(await w.dispatch('fetch', request), undefined);
  assert.equal(w.fetched.length, 0);
  assert.equal(w.written.length, 0);
});

test('a known asset refreshes its scoped cache with credentials omitted', async () => {
  const w = worker(), url = 'https://static.example/app/main.js';
  const response = await w.dispatch('fetch', new Request(url));
  assert.equal(await response.text(), 'fresh asset');
  assert.equal(w.fetched[0].credentials, 'omit');
  assert.deepEqual(w.written, [[url, 'fresh asset']]);
});
