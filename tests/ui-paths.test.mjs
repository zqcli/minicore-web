import test from 'node:test';
import assert from 'node:assert/strict';
import { crumbs, isDrive, splitPath, within } from '../web/core.js';

const drive = String.raw`C:\work`;
const extended = String.raw`\\?\C:\work\trailing.\child `;
test('breadcrumbs match a safe ordinary root while preserving verbatim child targets', () => {
  assert.equal(within(extended, drive), true);
  assert.deepEqual(crumbs(extended, [{ name: 'Work', path: drive }]), [
    { name: 'Work', path: drive },
    { name: 'trailing.', path: String.raw`\\?\C:\work\trailing.` },
    { name: 'child ', path: extended },
  ]);
  assert.equal(within(String.raw`\\?\C:\work-old\child`, drive), false);
  assert.equal(isDrive('\\\\?\\C:\\'), true);
});

test('UNC comparison preserves the native prefix and never exposes incomplete prefix crumbs', () => {
  const root = String.raw`\\server\share\work`, path = String.raw`\\?\UNC\server\share\work\tail.`;
  assert.equal(within(path, root), true);
  assert.deepEqual(crumbs(path, [{ name: 'Work', path: root }]), [
    { name: 'Work', path: root }, { name: 'tail.', path },
  ]);
  assert.deepEqual(splitPath(String.raw`\\?\UNC\server\share\folder`), [
    { name: 'share', path: String.raw`\\?\UNC\server\share` },
    { name: 'folder', path: String.raw`\\?\UNC\server\share\folder` },
  ]);
});

test('verbatim volume roots and POSIX backslash names retain their exact targets', () => {
  const root = '\\\\?\\Volume{fixture}\\', path = root + 'folder';
  assert.deepEqual(splitPath(path), [{ name: 'Volume{fixture}', path: root }, { name: 'folder', path }]);
  assert.deepEqual(crumbs(path, [{ name: 'Volume', path: root }]), [{ name: 'Volume', path: root }, { name: 'folder', path }]);
  assert.equal(within(path, 'C:\\'), false);
  assert.deepEqual(splitPath('/work/back\\slash'), [
    { name: '/', path: '/' }, { name: 'work', path: '/work' }, { name: 'back\\slash', path: '/work/back\\slash' },
  ]);
});
