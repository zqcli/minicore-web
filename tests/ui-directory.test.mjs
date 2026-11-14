import test from 'node:test';
import assert from 'node:assert/strict';

// ui.js binds browser listeners on import; this test exercises its pure page composition helper.
const names = ['navigator', 'document', 'matchMedia', 'localStorage', 'addEventListener'];
const original = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
Object.defineProperties(globalThis, {
  navigator: { configurable: true, value: { userAgent: '', maxTouchPoints: 0 } },
  document: { configurable: true, value: { getElementById: () => ({ addEventListener() {} }) } },
  matchMedia: { configurable: true, value: () => ({ matches: false, addEventListener() {} }) },
  localStorage: { configurable: true, value: { getItem: () => null } },
  addEventListener: { configurable: true, value: () => {} },
});
const { appendDirectoryPage } = await import('../web/ui.js');
for (const name of names) {
  const descriptor = original.get(name);
  if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
}

test('directory continuation preserves every listed folder and passes the opaque cursor through', () => {
  const first = { path: '/workspace', parent: null, entries: Array.from({ length: 1000 }, (_, i) => ({ name: String(i), path: '/workspace/' + i })), next_cursor: { scope: 'opaque-1', after_name: '999' } };
  const cursor = { scope: 'opaque-2', after_name: 'next' };
  const next = { path: '/workspace', parent: null, entries: [{ name: '.hidden', path: '/workspace/.hidden' }, { name: 'next', path: '/workspace/next' }], next_cursor: cursor };
  const joined = appendDirectoryPage(first, next);
  assert.equal(joined.entries.length, 1002);
  assert.deepEqual(joined.entries.slice(-2), next.entries);
  assert.equal(joined.next_cursor, cursor);
  assert.equal(first.entries.length, 1000);
  assert.equal(appendDirectoryPage(joined, { ...next, entries: [], next_cursor: null }).next_cursor, null);
});

test('a directory continuation cannot append entries to another folder', () => {
  assert.throws(() => appendDirectoryPage({ path: '/one', entries: [] }, { path: '/two', entries: [] }), /does not match/);
});
