// Retained renderer regressions migrated from minicore-tui 0.9.9:
// tests/remote_web.mjs at 2451d7289214385e3d21b46174b36f32a41dce45.
// These cases exercise local presentation helpers, not the retired Phone protocol.
// Transcript fixtures use native identities and omit metadata Host does not report.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import * as MC from '../web/core.js';

const read = name => readFileSync(new URL(`../web/${name}`, import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const live = (id, status, extra = {}) => ({ id, title: id, workspace: '/w', updated_at: '2026-10-25T00:00:00Z', current: false, live: true, status, started_ms: null, unseen: false, ...extra });
const idle = (id, extra = {}) => ({ id, title: id, workspace: '/w', updated_at: '2026-10-24T00:00:00Z', current: false, live: false, ...extra });
const commands = [{ name: 'fix-tests', description: 'Run the tests and fix failures', hint: '[path]' }, { name: 'review', description: 'Review', hint: '' }];
const tool = (tool_call_id, name, extra = {}) => ({ type: 'tool', tool_call_id, name, detail: tool_call_id, input: null, state: 'completed', output_text: '', output_lines: 0, ...extra });
const said = (text, reasoning = '', streaming = false) => ({ type: 'assistant', turn_id: 'turn', response_index: 1, reasoning, text, streaming });
const ask = text => ({ type: 'user', kind: 'message', text, at: 0 });
const end = (turn_id, extra = {}) => ({ type: 'turn_end', turn_id, outcome: 'completed', finished_at: '1970-01-01T00:00:47.000Z', ...extra });


test('markdown tokens keep HTML and unsafe links as plain text', () => {
  const texts = [];
  const walk = v => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    if (v.t === 'text' || (v.t === 'code' && 's' in v)) texts.push(v.s);
    if (v.t === 'code' && 'text' in v) texts.push(v.text);
    assert.notEqual(v.t, 'html');
    if (v.t === 'a') assert.match(v.href, /^https?:\/\//);
    Object.values(v).forEach(walk);
  };
  const src = '<img src=x onerror=alert(1)> and <script>alert(2)</script>\n\n[click](javascript:alert(3)) [ok](https://example.com/a) http://x.test/b.\n\n```html\n<script>bad()</script>\n```';
  const tree = plain(MC.parseMd(src));
  walk(tree);
  const all = texts.join('|');
  assert.ok(all.includes('<img src=x onerror=alert(1)>'));
  assert.ok(all.includes('<script>alert(2)</script>'));
  assert.ok(all.includes('click'));
  assert.ok(!all.includes('javascript:'));
  assert.ok(all.includes('<script>bad()</script>'));
  const links = [];
  const find = v => { if (Array.isArray(v)) v.forEach(find); else if (v && typeof v === 'object') { if (v.t === 'a') links.push(v.href); Object.values(v).forEach(find); } };
  find(tree);
  assert.deepEqual(links, ['https://example.com/a', 'http://x.test/b']);
  for (const src of ['[x](JavaScript:alert(1))', '[x](data:text/html,hi)', '[x]( javascript:void(0) )']) {
    const tokens = plain(MC.inline(src));
    assert.ok(tokens.every(t => t.t === 'text'), src);
    assert.ok(!tokens.map(t => t.s).join('').toLowerCase().includes('javascript:') && !tokens.map(t => t.s).join('').includes('data:'), src);
  }
  const words = '中文👩🏽‍💻 é and ordinary words with h ';
  assert.deepEqual(plain(MC.inline(words + '**bold _nested_** \\*plain\\* [link](https://example.com) ' + words)), [
    { t: 'text', s: words }, { t: 'b', c: [{ t: 'text', s: 'bold ' }, { t: 'i', c: [{ t: 'text', s: 'nested' }] }] },
    { t: 'text', s: ' *plain* ' }, { t: 'a', href: 'https://example.com', c: [{ t: 'text', s: 'link' }] }, { t: 'text', s: ' ' + words },
  ]);
});

test('markdown parses headings nested lists code tables and quotes', () => {
  const tree = plain(MC.parseMd('# Title\n\n- a\n  - b\n- c\n\n3. x\n4. y\n\n```rust\nfn main() {}\n```\n\n| A | B |\n|:--|--:|\n| 1 | **2** |\n\n> quote'));
  assert.deepEqual(tree.map(t => t.t), ['h', 'list', 'list', 'code', 'table', 'quote']);
  assert.equal(tree[1].ord, false);
  assert.equal(tree[1].items.length, 2);
  assert.equal(tree[1].items[0].sub[0].items[0].c[0].s, 'b');
  assert.equal(tree[2].ord, true); assert.equal(tree[2].start, 3);
  assert.deepEqual(tree[3], { t: 'code', lang: 'rust', text: 'fn main() {}' });
  assert.deepEqual(tree[4].align, ['', 'right']);
  assert.equal(tree[4].rows[0][1][0].t, 'b');
  // A streaming list marker without text stays a paragraph until its text arrives.
  assert.equal(plain(MC.parseMd('intro\n- '))[0].t, 'p');
  assert.deepEqual(plain(MC.parseMd('````rust\nordinary code\n~~~\n```short\n```\n  `````  ')), [
    { t: 'code', lang: 'rust', text: 'ordinary code\n~~~\n```short\n```' },
  ]);
});

test('the appearance choice overrides the OS scheme, System follows it, and the bar colours and text size follow along', () => {
  const run = (stored, dark) => {
    const root = { dataset: {}, style: { props: {}, setProperty(k, v) { this.props[k] = v; } } }, metas = { tc: {}, tcd: {} };
    const context = vm.createContext({
      localStorage: { getItem: () => stored },
      matchMedia: () => ({ matches: dark, addEventListener() {} }),
      document: { documentElement: root, getElementById: id => metas[id] },
    });
    vm.runInContext(read('theme.js'), context);
    return { theme: root.dataset.theme, size: root.style.props['--ts'], bars: [metas.tc.content, metas.tcd.content] };
  };
  const light = '#ffffff', dark = '#0e0e10';
  assert.deepEqual(run('{"theme":"light"}', true), { theme: 'light', size: 1, bars: [light, light] });
  assert.deepEqual(run('{"theme":"dark","text":1.2}', false), { theme: 'dark', size: 1.2, bars: [dark, dark] });
  assert.deepEqual(run('{"theme":"system"}', true), { theme: 'dark', size: 1, bars: [light, dark] });
  assert.deepEqual(run('{"theme":"system"}', false), { theme: 'light', size: 1, bars: [light, dark] });
  for (const stored of [null, '{}', '{"theme":"auto"}', '{"theme":"DARK"}']) {
    assert.equal(run(stored, true).theme, 'dark');
    assert.equal(run(stored, false).theme, 'light');
  }
});

test('install help is the browser prompt when offered, the Share hint on iOS until dismissed, and nothing once installed', () => {
  const iphone = 'iPhone Safari', ipad = 'iPad Safari', android = 'Android Chrome';
  assert.equal(MC.installOffer(false, false, iphone, null), 'ios');
  assert.equal(MC.installOffer(false, false, ipad, null), 'ios');
  assert.equal(MC.installOffer(false, false, iphone, '1'), null);
  assert.equal(MC.installOffer(false, true, android, null), 'prompt');
  assert.equal(MC.installOffer(false, false, android, null), null);
  assert.equal(MC.installOffer(true, true, iphone, null), null);
});

test('the session list puts sessions that need you first, then running ones, then one group per workspace by newest session', () => {
  const sessions = [
    idle('old', { workspace: '/home/me/docs', updated_at: '2026-10-01T00:00:00Z' }),
    live('late', 'running', { started_ms: 3000 }),
    live('fg', 'idle', { current: true, workspace: '/home/me/app' }),
    live('ask', 'approval', { started_ms: 5000 }),
    live('early', 'running', { started_ms: 1000 }),
    live('pack', 'compacting'),
    live('done', 'idle', { unseen: true, workspace: '/home/me/app', updated_at: '2026-10-25T01:00:00Z' }),
    idle('mid', { workspace: '/home/me/docs', updated_at: '2026-10-25T00:30:00Z' }),
  ];
  const g = plain(MC.sessionLayout(sessions, '').groups);
  assert.deepEqual(g.map(x => [x.label, x.ws, x.items.map(y => y.id)]), [
    ['Needs you', undefined, ['ask']], ['Running', undefined, ['early', 'late', 'pack']],
    ['app', '/home/me/app', ['done', 'fg']], ['docs', '/home/me/docs', ['mid', 'old']]]);
  // A group's name is the folder's name, also for Windows paths; a search shows the groups that hold a match.
  assert.deepEqual(plain(MC.sessionLayout([idle('a', { workspace: 'C:\\work\\app' }), idle('b', { workspace: 'D:\\' })], '').groups).map(x => x.label), ['app', 'D:']);
  assert.deepEqual(plain(MC.sessionLayout(sessions, 'ear').groups).map(x => x.items.map(y => y.id)), [['early']]);
  assert.deepEqual(plain(MC.sessionLayout(sessions, 'DOCS').groups).map(x => x.items.map(y => y.id)), [['mid', 'old']]);
  // A blank search is no search: every group, in the same order.
  assert.deepEqual(plain(MC.sessionLayout(sessions, '  ').groups), g);
});

test('a workspace group shows five sessions and "Show N more" opens the rest', () => {
  const items = Array.from({ length: 8 }, (_, k) => idle('s' + k));
  assert.deepEqual(plain(MC.groupRows(items, false)), { shown: items.slice(0, 5), hidden: 3 });
  assert.deepEqual(plain(MC.groupRows(items, true)), { shown: items, hidden: 0 });
  assert.deepEqual(plain(MC.groupRows(items.slice(0, 5), false)), { shown: items.slice(0, 5), hidden: 0 });
});

test('an open session list keeps its order while statuses change and puts new sessions on top of their group', () => {
  const first = MC.sessionLayout([live('a', 'running', { started_ms: 1 }), live('b', 'approval'), idle('c')], '');
  const frozen = first.order;
  // b's approval is answered and keeps its place; a starts waiting and surfaces in Needs you; c is gone; d is new and needs you.
  const later = MC.sessionLayout([live('d', 'approval'), live('a', 'approval', { started_ms: 1 }), live('b', 'running', { started_ms: 2 })], '', frozen);
  assert.equal(later.order, frozen);
  assert.deepEqual(plain(later.groups).map(x => [x.label, x.items.map(y => y.id)]), [['Needs you', ['d', 'a', 'b']]]);
  // Opened again: sorted afresh.
  const again = MC.sessionLayout([live('d', 'approval'), live('a', 'approval', { started_ms: 1 }), live('b', 'running', { started_ms: 2 })], '');
  assert.deepEqual(plain(again.groups).map(x => [x.label, x.items.map(y => y.id)]), [['Needs you', ['a', 'd']], ['Running', ['b']]]);
  // A new session tops its workspace group (which moves up with it) while the others keep their places.
  const before = MC.sessionLayout([idle('e', { workspace: '/other' }), idle('c')], '').order;
  const settled = MC.sessionLayout([idle('n', { updated_at: '2026-10-25T05:00:00Z' }), idle('c'), idle('e', { workspace: '/other' })], '', before);
  assert.deepEqual(plain(settled.groups).map(x => [x.label, x.items.map(y => y.id)]), [['w', ['n', 'c']], ['other', ['e']]]);
});

test('an open list moves a session that starts waiting on the user into Needs you from any group and keeps it there', () => {
  const groups = lay => plain(lay.groups).map(x => [x.label, x.items.map(y => y.id)]);
  // A pinned running session: Pinned may be folded, so held in place its approval would be hidden.
  const first = MC.sessionLayout([live('a', 'running', { started_ms: 1 })], '', null, ['a']);
  assert.deepEqual(groups(first), [['Pinned', ['a']]]);
  const asked = MC.sessionLayout([live('a', 'approval', { started_ms: 1 })], '', first.order, ['a']);
  assert.deepEqual(groups(asked), [['Needs you', ['a']]]);
  // Answered while the list is still open, it keeps its new place instead of jumping back; reopening sorts afresh.
  assert.deepEqual(groups(MC.sessionLayout([live('a', 'running', { started_ms: 1 })], '', asked.order, ['a'])), [['Needs you', ['a']]]);
  assert.deepEqual(groups(MC.sessionLayout([live('a', 'running', { started_ms: 1 })], '', null, ['a'])), [['Pinned', ['a']]]);
  // From a workspace group (which may be folded too) it lands on top of the sessions already waiting; other rows hold still.
  const held = () => MC.sessionLayout([live('w', 'approval'), live('b', 'idle'), idle('c')], '').order;
  assert.deepEqual(groups(MC.sessionLayout([live('w', 'approval'), live('b', 'approval'), idle('c')], '', held())), [['Needs you', ['b', 'w']], ['w', ['c']]]);
  // A session that starts running holds its place: only a wait on the user overrides the frozen order.
  assert.deepEqual(groups(MC.sessionLayout([live('w', 'approval'), live('b', 'running', { started_ms: 1 }), idle('c')], '', held())), [['Needs you', ['w']], ['w', ['b', 'c']]]);
});

test('pinned sessions form one group after Needs you, newest pin first, and appear nowhere else', () => {
  const sessions = [idle('a'), live('b', 'running', { started_ms: 1 }), idle('c', { workspace: '/docs' }), live('ask', 'approval'), idle('d')];
  const groups = (pins, query = '', frozen) => plain(MC.sessionLayout(sessions, query, frozen, pins).groups).map(x => [x.label, x.items.map(y => y.id)]);
  assert.deepEqual(groups([]), [['Needs you', ['ask']], ['Running', ['b']], ['w', ['a', 'd']], ['docs', ['c']]]);
  // The newest pin leads; a pinned running session moves out of Running and a pinned approval stays under Needs you.
  assert.deepEqual(groups(['c', 'b', 'ask']), [['Needs you', ['ask']], ['Pinned', ['c', 'b']], ['w', ['a', 'd']]]);
  assert.equal(MC.sessionLayout(sessions, '', null, ['c']).groups[1].ws, MC.PINNED_KEY);
  // A search covers the pinned group too and hides groups without a match.
  assert.deepEqual(groups(['c', 'b'], 'docs'), [['Pinned', ['c']]]);
  assert.deepEqual(groups(['c', 'b'], 'zzz'), []);
  // An open list keeps its rows in place; a row that is pinned (its entry dropped from the frozen order) goes to the top of Pinned.
  const frozen = MC.sessionLayout(sessions, '', null, ['c']).order;
  frozen.delete('d');
  assert.deepEqual(groups(['d', 'c'], '', frozen), [['Needs you', ['ask']], ['Pinned', ['d', 'c']], ['Running', ['b']], ['w', ['a']]]);
});

test('pins outside a complete session list are forgotten without reallocating an unchanged list', () => {
  const some = [idle('a'), idle('b')];
  assert.deepEqual(plain(MC.prunePins(['x', 'b', 'a'], some)), ['b', 'a']);
  const same = ['b', 'a'];
  assert.equal(MC.prunePins(same, some), same);
});

test('relative times respect the supplied clock and local timezone', () => {
  const tz = -480; // UTC+8
  const now = Date.parse('2026-10-25T01:00:00Z'); // 09:00 local
  assert.equal(MC.relTime(now - 30000, now, tz), 'now');
  assert.equal(MC.relTime(now - 5 * 60000, now, tz), '5m');
  assert.equal(MC.relTime(now - 3 * 3600000, now, tz), '3h');
  assert.equal(MC.relTime(Date.parse('2026-10-20T00:00:00Z'), now, tz), '5d');
  assert.equal(MC.relTime(Date.parse('2026-09-01T00:00:00Z'), now, tz), 'Sep 1');
});

test('timestamps read as a clock today and carry the day otherwise', () => {
  const tz = -480, now = Date.parse('2026-10-25T06:00:00Z');
  assert.equal(MC.stamp(Date.parse('2026-10-25T01:05:00Z'), now, tz), '09:05');
  assert.equal(MC.stamp(Date.parse('2026-10-24T01:05:00Z'), now, tz), 'Yesterday 09:05');
  assert.equal(MC.stamp(Date.parse('2026-10-03T01:05:00Z'), now, tz), 'Oct 3, 09:05');
  assert.equal(MC.tilde('/Users/me/Develops/app'), '~/Develops/app');
  assert.equal(MC.tilde('/home/me'), '~');
  assert.equal(MC.tilde('/srv/work'), '/srv/work');
  assert.equal(MC.fmtNum(48610), '48,610');
});

test('diffs parse git hunks with line numbers and apply_patch envelopes without them', () => {
  const git = plain(MC.parseDiff('diff --git a/src/a.rs b/src/a.rs\nindex 1..2 100644\n--- a/src/a.rs\n+++ b/src/a.rs\n@@ -10,3 +10,4 @@ fn main\n ctx\n-old\n+new\n+more\n ctx2\ndiff --git a/b.md b/b.md\n--- /dev/null\n+++ b/b.md\n@@ -0,0 +1 @@\n+# B'));
  assert.deepEqual(git.map(f => [f.path, f.added, f.removed]), [['src/a.rs', 2, 1], ['b.md', 1, 0]]);
  assert.deepEqual(git[0].hunks[0].lines.map(l => [l.t, l.s, l.a, l.b]), [['ctx', 'ctx', 10, 10], ['del', 'old', 11, null], ['add', 'new', null, 11], ['add', 'more', null, 12], ['ctx', 'ctx2', 12, 13]]);
  // A content line that looks like a header inside a counted hunk stays content.
  const tricky = plain(MC.parseDiff('--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n--- not a header\n+++ still content\n same'));
  assert.deepEqual(tricky.map(f => [f.path, f.added, f.removed]), [['x', 1, 1]]);
  const patch = plain(MC.parseDiff('*** Begin Patch\n*** Update File: src/p.rs\n@@ fn split\n-a\n+b\n c\n*** Add File: new.txt\n+hello\n*** End Patch'));
  assert.deepEqual(patch.map(f => [f.path, f.op, f.added, f.removed]), [['src/p.rs', 'update', 1, 1], ['new.txt', 'add', 1, 0]]);
  assert.equal(patch[0].hunks[0].head, 'fn split');
  assert.deepEqual(patch[0].hunks[0].lines.map(l => [l.t, l.a]), [['del', null], ['add', null], ['ctx', null]]);
  assert.deepEqual(plain(MC.parseDiff('just text\nno diff')), []);
  assert.deepEqual(plain(MC.diffStats('*** Update File: a\n@@\n-x\n+y\n+z')), { added: 2, removed: 1 });
});

test('the slash list filters by name with prefix matches first and templates before built-ins', () => {
  const names = text => plain(MC.slashMenu(text, commands)).map(c => c.name);
  assert.deepEqual(names('/').slice(0, 3), ['fix-tests', 'review', 'new']);
  assert.ok(names('/').includes('settings'));
  assert.deepEqual(names('/re'), ['review', 'rename']);
  assert.deepEqual(names('/ss'), ['session', 'sessions']);
  assert.deepEqual(names('/s').slice(0, 3), ['session', 'sessions', 'settings']);
  assert.deepEqual(names('/fix'), ['fix-tests']);
  assert.deepEqual(names('/zzz'), []);
  // Only while the composer holds just the command word.
  assert.equal(MC.slashMenu('/fix-tests src', commands), null);
  assert.equal(MC.slashMenu('hello /fix', commands), null);
  assert.equal(plain(MC.slashMenu('/', commands)).find(c => c.name === 'review').builtin, false);
  // The + sheet offers the same commands: templates first, then the built-ins.
  assert.deepEqual(MC.commandList(commands).map(c => [c.name, c.builtin]).slice(commands.length - 1, commands.length + 1), [[commands.at(-1).name, false], ['new', true]]);
});

test('a slash line is a built-in run here, a template sent as text, or refused as unknown', () => {
  assert.deepEqual(plain(MC.parseSlash('/compact', commands)), { builtin: 'compact', arg: '' });
  assert.deepEqual(plain(MC.parseSlash('  /rename Fix the parser  ', commands)), { builtin: 'rename', arg: 'Fix the parser' });
  assert.deepEqual(plain(MC.parseSlash('/diff', commands)), { builtin: 'changes', arg: '' });
  assert.deepEqual(plain(MC.parseSlash('/fix-tests src/parser', commands)), { template: 'fix-tests', arg: 'src/parser' });
  assert.deepEqual(plain(MC.parseSlash('/nope', commands)), { unknown: 'nope' });
  // Text the host sends as it is: a word with more text, paths, an escaped slash, a lone slash.
  for (const t of ['/nope more text', '/Users/me/app is broken', '/Users/me/app', '//compact', '/ hello']) assert.equal(MC.parseSlash(t, commands), null, t);
  assert.equal(MC.parseSlash('fix the /tmp path', commands), null);
  assert.equal(MC.literal('/fix'), true);
  assert.equal(MC.literal('@src'), true);
  assert.equal(MC.literal('Fix /tmp'), false);
});

test('an @ mention is found at the caret and replaced by the chosen path', () => {
  assert.deepEqual(plain(MC.atToken('see @par', 8)), { start: 4, end: 8, query: 'par' });
  assert.deepEqual(plain(MC.atToken('@', 1)), { start: 0, end: 1, query: '' });
  // The caret inside the word: the whole word is replaced.
  assert.deepEqual(plain(MC.atToken('see @parser now', 6)), { start: 4, end: 11, query: 'p' });
  assert.equal(MC.atToken('mail me@host', 12), null);
  assert.equal(MC.atToken('see @par now', 12), null);
  assert.deepEqual(plain(MC.insertMention('see @par now', { start: 4, end: 8 }, 'src/parser.rs')), { text: 'see @src/parser.rs now', caret: 19 });
  assert.deepEqual(plain(MC.insertMention('@', { start: 0, end: 1 }, 'a.rs')), { text: '@a.rs ', caret: 6 });
});

test('recent prompts keep the newest first without repeats and at most fifty', () => {
  let list = [];
  for (const t of ['a', 'b', 'a', 'c']) list = MC.pushRecent(list, t);
  assert.deepEqual(plain(list), ['c', 'a', 'b']);
  for (let k = 0; k < 60; k++) list = MC.pushRecent(list, 'p' + k);
  assert.equal(list.length, 50);
  assert.equal(list[0], 'p59');
});

const SAMPLES = [
  '# Title\n\nIntro with **bold** and `code`.\n\n- a\n  - b\n- c\n\n3. x\n4. y\n\n```rust\nfn main() {\n\n    println!("hi");\n}\n```\n\n| A | B |\n|:--|--:|\n| 1 | **2** |\n| 3 | 4 |\n\n> quote\n> more\n\n---\n\nThe end.',
  'Para one\nstill one\n\n- item\n\n- loose item\n  continued\n\nafter\n\n```\nunclosed fence\n\nwith blank lines',
  'Text\r\n\r\n- crlf list\r\n- two\r\n\r\n## Heading\r\nbody',
  '1. one\n2. two\n\n   indented para\n\n~~~\ntilde fence\n~~~\n\n- \n- x\n\n> q\n\nplain\n|not|a table\n\n|a|b|\n|-|-|\n|1|2|\n\nend',
  '## Unicode\r\n\r\n中文👩🏽‍💻 é **bold _nested_** \\*plain\\* http://example.com.\r\n\r\n````rust\r\nordinary code\r\n~~~\r\n```short\r\n```\r\n  `````  \r\n\r\nend',
];

test('incremental markdown equals a full parse for random splits and keeps finished blocks', () => {
  let seed = 7;
  const rnd = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (const doc of SAMPLES) {
    for (let run = 0; run < 40; run++) {
      let cache = null, at = 0, kept = 0;
      while (at < doc.length) {
        at = Math.min(doc.length, at + 1 + rnd(run % 3 ? 12 : 3));
        const prev = cache, r = MC.mdInc(cache, doc.slice(0, at));
        assert.deepEqual(plain(r.blocks), plain(MC.parseMd(doc.slice(0, at))), JSON.stringify(doc.slice(0, at)));
        // Blocks frozen earlier are handed back as the same objects.
        if (prev) for (let k = 0; k < prev.head.length; k++) assert.equal(r.blocks[k], prev.head[k]);
        kept = Math.max(kept, r.cache.head.length);
        cache = r.cache;
      }
      assert.ok(kept > 0 || doc.length < 40);
    }
  }
  // A text that is not an extension of the last one starts over.
  const a = MC.mdInc(null, 'one\n\ntwo\n\nthree\n\nfour\n'), b = MC.mdInc(a.cache, 'other\n\ntext');
  assert.deepEqual(plain(b.blocks), plain(MC.parseMd('other\n\ntext')));
});

test('a finished turn folds tools and intermediate thinking before the final answer; the running turn does not', () => {
  const bl = [ask('go'), said('', 'plan'), tool('a', 'bash'), said('checking'), tool('b', 'read', { state: 'failed' }), said(''), { type: 'user', kind: 'steering', text: 'also', at: 0 }, tool('c', 'edit'), said('Done.', 'final thought'), end('t1'),
    ask('next'), tool('d', 'bash'), said('working', '', true)];
  const f = plain(MC.foldTurns(bl, 0, bl.length));
  assert.equal(f.length, 2);
  assert.deepEqual(f[0], { key: 'ft1:1', at: 1, last: 4, hidden: [1, 2, 3, 4], tools: 2, failed: 1, ms: 0, added: null, removed: null });
  assert.deepEqual(f[1], { key: 'ft1:7', at: 7, last: 7, hidden: [7], tools: 1, failed: 0, ms: null, added: null, removed: null });
  assert.equal(MC.foldText(f[1]), 'Worked');
  // No answer after the last tool: everything up to the turn end folds.
  const noAnswer = plain(MC.foldTurns([ask('go'), said('first'), tool('a', 'bash'), end('t2', { changes: null })], 0, 4));
  assert.deepEqual(noAnswer[0].hidden, [1, 2]);
  assert.equal(noAnswer[0].added, null);
  // A turn of only an answer has nothing to fold; a window that starts mid-turn folds from its start.
  assert.deepEqual(plain(MC.foldTurns([ask('hi'), said('hello'), end('t3')], 0, 3)), []);
  assert.deepEqual(plain(MC.foldTurns(bl, 3, 10))[0].hidden, [3, 4]);
});

test('worked segments preserve steers and known timestamps without inventing a total duration', () => {
  const steer = at => ({ type: 'user', kind: 'steering', text: 'change direction', at });
  const bl = [ask('go'), tool('a', 'bash'), steer(10000), tool('b', 'bash', { state: 'failed' }), steer(30000), tool('c', 'bash'), said('answer'), end('seg')];
  const folds = MC.foldTurns(bl, 0, bl.length);
  assert.deepEqual(folds.map(f => [f.hidden, f.tools, f.failed, f.ms]), [[[1], 1, 0, 10000], [[3], 1, 1, 20000], [[5], 1, 0, null]]);
  assert.equal(new Set(folds.map(f => f.key)).size, 3);
  bl.splice(5, 1);
  assert.deepEqual(MC.foldTurns(bl, 0, bl.length).map(f => f.hidden), [[1], [3]]);
  bl[2].at = null;
  assert.deepEqual(MC.foldTurns(bl, 0, bl.length).map(f => f.ms), [null, null]);
  assert.equal(MC.foldTurns([ask('go'), tool('a', 'bash'), said('answer'), end('plain')], 0, 4)[0].ms, null);
});

test('consecutive reads and searches group into one row with a count', () => {
  const bl = [tool('a', 'read'), said(''), tool('b', 'read'), tool('c', 'grep'), tool('d', 'bash'), tool('e', 'read'), tool('f', 'glob'), said('x'), tool('g', 'read'), tool('h', 'read', { state: 'running' }), tool('i', 'grep'), tool('j', 'grep')];
  const g = plain(MC.groupTools(bl, 0, 9));
  assert.deepEqual(g.map(x => [x.key, x.members, x.label]), [['ga', [0, 2, 3], 'Explored 2 files · 1 search'], ['ge', [5, 6], 'Explored 1 file · 1 search']]);
  assert.deepEqual(plain(MC.groupTools(bl, 8, 10)).map(x => [x.label, x.run]), [['Reading 2 files', true]]);
  assert.deepEqual(plain(MC.groupTools(bl, 10, 12)).map(x => x.label), ['Searched 2 times']);
  assert.deepEqual(plain(MC.groupTools([tool('a', 'read')], 0, 1)), []);
});

test('find matches messages, answers, thinking, tool targets and output case-insensitively', () => {
  const bl = [ask('Fix the Parser'), said('The parser is fixed', 'think about PARSER'), tool('a', 'bash', { detail: 'cargo test', output_text: 'parser ok', output_lines: 1 }), end('t')];
  assert.deepEqual(plain(MC.findBlocks(bl, 'parser', 0, 4)), [0, 1, 2]);
  assert.deepEqual(plain(MC.findBlocks(bl, 'cargo', 1, 4)), [2]);
  assert.deepEqual(plain(MC.findBlocks(bl, '', 0, 4)), []);

  const source = read('conversation.js'), opened = new Map(), dirty = new Set(), draws = [];
  const context = { MC, S: { blocks: bl }, finder: { q: 'parser' }, lo: 0, hi: bl.length,
    roles: [null, null, { fold: { key: 'fold' }, group: { key: 'group' } }], opened, dirty,
    isOpen: (key, b) => opened.has(key) ? opened.get(key) : key[0] === 't' && b.state === 'failed',
    flush: () => { draws.push([...dirty]); dirty.clear(); }, paintFind() {}, box: {}, NodeFilter: { SHOW_TEXT: 4 },
    document: { createTreeWalker: () => ({ nextNode: () => false }) },
  };
  vm.runInNewContext(source.slice(source.indexOf('function runFind('), source.indexOf('function findStep(')), context);
  context.runFind();
  assert.deepEqual([...opened], [['fold', true], ['group', true], ['ta', true]]);
  assert.deepEqual(draws.pop(), [2], 'only the hidden match needs its body redrawn');
  context.runFind();
  assert.deepEqual(draws.pop(), [], 'already-visible matches keep their DOM');
  context.roles = []; opened.clear(); bl[2].state = 'failed';
  context.runFind();
  assert.deepEqual(draws.pop(), [], 'a failed tool already shows its output');
  assert.equal(opened.get('ta'), true, 'the search keeps the tool open if its default later changes');
});

test('the composer says what typing does: idle, running with a keyboard, running on touch', () => {
  assert.equal(MC.placeholder(false, true, null), 'Message MiniCore · / for commands');
  assert.equal(MC.placeholder(false, false, null), 'Describe a task to start');
  assert.equal(MC.placeholder(true, true, { send: 'Enter', alt: '⌥' }), 'Enter steers · ⌥Enter queues a follow-up');
  assert.equal(MC.placeholder(true, true, { send: 'Ctrl+Enter', alt: 'Alt+' }), 'Ctrl+Enter steers · Alt+Enter queues a follow-up');
  assert.equal(MC.placeholder(true, true, false), 'Type to steer or queue a follow-up');
});

test('composer keys: Enter and Cmd/Ctrl+Enter steer or send, Alt+Enter queues, Tab and Shift+Enter are left alone', () => {
  const base = { key: 'Enter', shift: false, alt: false, mod: false };
  const ctx = { busy: true, text: 'next', popup: false, enter: true };
  // [name, key, expected as [busy, idle] for "Enter sends" on, then off]
  const table = [
    ['Enter', {}, ['steer', 'send'], [null, null]],
    ['Shift+Enter', { shift: true }, [null, null], [null, null]],
    ['Alt+Enter', { alt: true }, ['queue', null], ['queue', null]],
    ['Cmd/Ctrl+Enter', { mod: true }, ['steer', 'send'], ['steer', 'send']],
    ['Tab', { key: 'Tab' }, [null, null], [null, null]],
    ['Alt+Tab', { key: 'Tab', alt: true }, [null, null], [null, null]],
    ['a', { key: 'a' }, [null, null], [null, null]],
  ];
  for (const [name, mods, on, off] of table) {
    for (const [enter, want] of [[true, on], [false, off]]) {
      for (const [i, busy] of [true, false].entries()) {
        assert.equal(MC.composerKey({ ...base, ...mods }, { ...ctx, busy, enter }), want[i], `${name} busy=${busy} enter=${enter}`);
      }
    }
  }
  // An open list keeps Enter and Alt+Enter for completion; Cmd/Ctrl+Enter still steers or sends.
  for (const [name, mods, want] of [['Enter', {}, null], ['Shift+Enter', { shift: true }, null], ['Alt+Enter', { alt: true }, null],
    ['Tab', { key: 'Tab' }, null], ['Cmd/Ctrl+Enter', { mod: true }, 'steer']]) {
    assert.equal(MC.composerKey({ ...base, ...mods }, { ...ctx, popup: true }), want, name + ' with a list');
  }
  // Nothing typed: there is nothing to queue.
  assert.equal(MC.composerKey({ ...base, alt: true }, { ...ctx, text: '  \n' }), null);
});

test('the primary button is send when idle, stop while working with nothing typed, steer with text typed during a turn', () => {
  const face = (busy, compacting, text, stopping = false) => MC.primaryKind({ busy, compacting, text, stopping });
  // [busy, compacting, text, stopping] -> face
  const table = [
    [false, false, '', false, 'send'], [false, false, 'hi', false, 'send'], [false, false, '  \n', false, 'send'],
    [true, false, '', false, 'stop'], [true, false, '  ', false, 'stop'], [true, false, 'hi', false, 'steer'],
    [false, true, '', false, 'stop'], [false, true, 'hi', false, 'send'],
    [true, false, '', true, 'stopping'], [true, false, 'hi', true, 'stopping'], [false, true, '', true, 'stopping'],
  ];
  for (const [busy, compacting, text, stopping, want] of table) assert.equal(face(busy, compacting, text, stopping), want, JSON.stringify([busy, compacting, text, stopping]));
});

test('a tap on the primary decides from the live text and ignores double taps on Send and scrolls', () => {
  const tap = (c, now = 10000, moved = 0) => MC.primaryTap({ busy: true, compacting: false, text: '', stopping: false, stopAt: 0, ...c }, now, moved);
  assert.equal(tap({}), 'stop');
  assert.equal(tap({ compacting: true, busy: false }), 'stop');
  // The button still shows Stop but text was typed since: the tap steers, it never stops.
  assert.equal(tap({ text: 'next' }), 'steer');
  assert.equal(tap({ text: 'next', busy: false }), 'send');
  assert.equal(tap({ busy: false }), null, 'nothing to send');
  assert.equal(tap({ stopping: true }), null);
  // A tap within 600 ms after the button became Stop is the second half of a double tap on Send.
  assert.equal(tap({ stopAt: 9401 }), null);
  assert.equal(tap({ stopAt: 9400 }), 'stop');
  assert.equal(tap({ stopAt: 9401, text: 'next' }), 'steer', 'the guard only protects Stop');
  // A pointer that travelled over 10 px was a scroll.
  assert.equal(tap({}, 10000, 11), null);
  assert.equal(tap({}, 10000, 10), 'stop');
  assert.equal(tap({ text: 'next' }, 10000, 30), null);
});

test('the tray preserves queue order with separate kind numbering and carries each input identity', () => {
  const q = [
    { id: 'inp_s', kind: 'steer', text: 's' }, { id: 'inp_a', kind: 'follow', text: 'a' },
    { id: 'inp_b', kind: 'follow', text: 'b' }, { id: 'inp_w', kind: 'steer', text: 'waiting' },
    { id: 'inp_d', kind: 'follow', text: 'd' },
  ];
  const v = plain(MC.queueView(q, false));
  assert.deepEqual(v.items.map(x => [x.kind, x.text, x.n]), [['steer', 's', 1], ['follow', 'a', 1], ['follow', 'b', 2]]);
  assert.deepEqual(v.items.map(x => [x.kind, x.id, x.n]), [['steer', 'inp_s', 1], ['follow', 'inp_a', 1], ['follow', 'inp_b', 2]]);
  assert.deepEqual([v.hidden, v.long], [2, true]);
  const all = plain(MC.queueView(q, true));
  assert.deepEqual(all.items.map(x => x.n), [1, 1, 2, 2, 3]);
  assert.deepEqual(all.items.map(x => x.id), q.map(x => x.id));
  assert.deepEqual(all.items.map(x => x.text), q.map(x => x.text));
  assert.deepEqual([all.hidden, all.long], [0, true]);
  assert.deepEqual(plain(MC.queueView(q.slice(0, 3), false)), { items: plain(MC.queueView(q.slice(0, 3), true)).items, hidden: 0, long: false });
  assert.deepEqual(plain(MC.queueView([], false)), { items: [], hidden: 0, long: false });
  const mixed = plain(MC.queueView([{ id: 'x', kind: 'follow', text: 'a' }, { id: 'y', kind: 'steer', text: 'b' }, { id: 'z', kind: 'follow', text: 'c' }], true));
  assert.deepEqual(mixed.items.map(x => [x.kind, x.text, x.n]), [['follow', 'a', 1], ['steer', 'b', 1], ['follow', 'c', 2]]);
  assert.deepEqual(mixed.items.map(x => [x.kind, x.id, x.n]), [['follow', 'x', 1], ['steer', 'y', 1], ['follow', 'z', 2]]);
});

test('the thinking preview is the newest sentence without Markdown markers', () => {
  const p = MC.thinkingPreview;
  assert.equal(p(''), '');
  assert.equal(p('Check the parser'), 'Check the parser');
  assert.equal(p('First line\nSecond line\n\n  \n'), 'Second line');
  // A long paragraph shows its newest sentence, also while that sentence is still being written.
  assert.equal(p('The user reports a bug. I should read the code. Then run the'), 'Then run the');
  assert.equal(p('The user reports a bug. I should read the code.'), 'I should read the code.');
  assert.equal(p('先读代码。然后运行测试'), '然后运行测试');
  assert.equal(p('Does it fail? Yes it does!'), 'Yes it does!');
  // Paths and versions with dots are not sentence ends.
  assert.equal(p('Open src/ui/mod.rs and v1.2.3 now'), 'Open src/ui/mod.rs and v1.2.3 now');
  assert.equal(p('**Considering the fix**'), 'Considering the fix');
  assert.equal(p('# Plan\n- read `split_path` in __main__\n'), 'read split_path in main');
  assert.equal(p('1. Run [the tests](https://x.test/a) first'), 'Run the tests first');
  assert.equal(p('> quoted ~~old~~ idea'), 'quoted old idea');
  assert.equal(p('thinking\n---\n'), '---');
  // Only the tail is read: a huge text costs the same and still ends with the newest line.
  assert.equal(p('x\n'.repeat(100000) + 'last words here'), 'last words here');
});
