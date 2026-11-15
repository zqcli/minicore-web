import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import * as MC from '../web/core.js';
import { statusView } from '../web/host-state.js';

// Execute the actual callbacks with small DOM/sheet doubles. Browser integration
// separately covers layout, focus, clipboard and event propagation in Chromium.
const read = name => readFileSync(new URL('../web/' + name, import.meta.url), 'utf8');
const section = (name, start, end) => {
  const source = read(name), from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, name + ' section exists');
  return source.slice(from, to).replace(/\bexport /g, '');
};
const h = (tag, props, ...children) => ({ tag, props: typeof props === 'string' ? { class: props } : props || {}, children: children.flat(Infinity).filter(x => x != null && x !== false), remove() { this.removed = true; } });
const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...(value.children || []).flatMap(nodes)] : [];
const textOf = value => Array.isArray(value) ? value.map(textOf).join('') : value && typeof value === 'object' ? textOf(value.children || []) : value == null || value === false ? '' : String(value);
const button = (tree, label) => nodes(tree).find(n => n.tag === 'button' && textOf(n) === label);
const icon = name => h('svg', { name });
const copyButton = (text, label, props) => h('button', { ...props, copiedText: text }, label);

function errors() {
  const sheets = [], box = { children: [], append(node) { this.children.push(node); }, querySelectorAll() { return this.children.filter(n => !n.removed); } };
  Object.defineProperty(box, 'firstChild', { get: () => box.children.find(n => !n.removed) });
  let closed = 0;
  const context = vm.createContext({ h, icon, copyButton, structuredClone, boundedPreview: MC.boundedPreview,
    $: () => box, setTimeout() {}, sheet: options => sheets.push(options), findSheet: () => ({ close() { closed++; } }),
  });
  vm.runInContext(section('ui.js', 'let recalledError =', 'export const announce'), context);
  context.showError = vm.runInContext('showError', context);
  return { context, sheets, box, last: () => vm.runInContext('lastError()', context), open: () => vm.runInContext('openLastError()', context), closed: () => closed };
}

test('dismissed error recalls its original native identity and complete Fault without a large toast body', () => {
  const { context, sheets, box, last, open, closed } = errors();
  const message = '第一行🙂\n' + '中🙂'.repeat(200000) + '\nOriginal diagnostic tail';
  const record = { text: message, target: { host_id: 'host-a', host_incarnation: 'run-a', agent_id: 'agent-a', session_id: 'session-a' }, operation: { kind: 'session.update', operation_id: 'native-operation' },
    fault: { type: 'TURN_MODEL_UPSTREAM_UNKNOWN', code: 4299, message, details: { http_status: 503, provider_type: 'overloaded', provider_code: 'busy', request_id: 'original-request' }, diagnostic_id: 'diagnostic-a' } };
  context.showError(record);
  assert.ok(textOf(box.children[0]).length < 350);
  assert.match(textOf(box.children[0]), /truncated/);
  assert.match(textOf(box.children[0]), /Session session-/);
  record.target.session_id = 'session-b'; record.fault.details.request_id = 'changed';
  assert.equal(last().target.session_id, 'session-a');
  assert.equal(last().fault.details.request_id, 'original-request');
  nodes(box.children[0]).find(n => n.props['aria-label'] === 'Dismiss').props.onclick();
  assert.ok(box.children[0].removed);
  open();
  const detail = sheets.at(-1), body = detail.body(), copied = JSON.parse(detail.foot().props.copiedText);
  assert.equal(nodes(body).find(n => n.props.class === 'error-message').children[0], message);
  assert.equal(copied.fault.message, message);
  assert.equal(copied.target.session_id, 'session-a');
  assert.equal(copied.operation.operation_id, 'native-operation');
  assert.deepEqual(copied.fault.details, { http_status: 503, provider_type: 'overloaded', provider_code: 'busy', request_id: 'original-request' });
  context.clearLastError();
  assert.equal(last(), null); assert.equal(closed(), 1);
});

test('toast Details keeps its captured error while Last error retains the newer one', () => {
  const { context, sheets, box, last, open } = errors();
  context.showError({ text: 'Original A', target: { session_id: 'a' } });
  const details = button(box.children[0], 'Details');
  context.showError({ text: 'Later B', target: { session_id: 'b' } });
  details.props.onclick();
  assert.equal(JSON.parse(sheets.at(-1).foot().props.copiedText).text, 'Original A');
  assert.equal(last().text, 'Later B');
  open();
  assert.equal(JSON.parse(sheets.at(-1).foot().props.copiedText).text, 'Later B');
  assert.equal(nodes(sheets.at(-1).body()).some(n => n.props.class === 'error-fault'), false, 'a string cause does not acquire native Fault fields');
});

test('a delayed owned action failure records its actual operation before its callback while viewing another Session', () => {
  const recorded = [], callbacks = [], S = { sid: 'b', state: { session: { id: 'b', agent_id: 'agent' } }, intents: new Map() };
  const context = vm.createContext({ S, MC, HOST: 'wss://host.example', authSession: 3, app: { navigation: 2 }, on: {},
    rememberError: record => { recorded.push(structuredClone(record)); return recorded.at(-1); },
  });
  vm.runInContext(section('net.js', 'function finish(', 'export function intent('), context);
  const operation = { id: 'local-intent', kind: 'rename_session', endpoint: 'wss://host.example', authSession: 3, target: { host_id: 'host', host_incarnation: 'run', agent_id: 'agent', session_id: 'a' },
    operation: { kind: 'session.update', operation_id: 'actual-wire-operation' }, own: ack => callbacks.push(ack) };
  const fault = { type: 'SESSION_CONFIG_STALE', code: 3102, message: 'Original failure\n原始原因🙂', details: { expected_revision: 3 } };
  context.finish(operation, { ok: false, acceptance: 'rejected', error: fault.message, fault });
  assert.equal(callbacks.length, 1); assert.equal(recorded.length, 1);
  assert.equal(callbacks[0].current, false);
  assert.equal(callbacks[0].errorRecord.target.session_id, 'a');
  assert.equal(callbacks[0].errorRecord.operation.operation_id, 'actual-wire-operation');
  assert.deepEqual(recorded[0].fault, fault);
  context.finish({ ...operation, authSession: 2 }, { ok: false, error: 'Failure from a signed-out connection' });
  assert.equal(callbacks.length, 1); assert.equal(recorded.length, 1);
  context.finish(operation, { ok: false, acceptance: 'unknown', error: 'Socket closed' });
  assert.equal(recorded.at(-1).acceptance, 'unknown');
  assert.match(recorded.at(-1).text, /Not confirmed/);
  assert.equal('fault' in recorded.at(-1), false);
  context.finish({ ...operation, operation: { kind: 'agent.create', operation_id: 'create-operation' }, target: { ...operation.target, load_id: 'old-load' } },
    { ok: false, error: 'Default Session creation failed', receipt: { kind: 'agent.create', host_id: 'host', host_incarnation: 'run', agent_id: 'published-agent', operation_id: 'create-operation', result: {} } });
  assert.equal(recorded.at(-1).target.agent_id, 'published-agent');
  assert.equal('session_id' in recorded.at(-1).target, false); assert.equal('load_id' in recorded.at(-1).target, false);
});

test('sign out clears recalled diagnostics and old operation callbacks without persisting errors', () => {
  const { context, last } = errors(), removed = [], saved = [];
  context.showError({ text: 'Private diagnostic', target: { host_id: 'host' } });
  Object.assign(context, { S: MC.createStore(), MC, authSession: 4, halted: false, retryTimer: 0, HOST: 'wss://host.example', client: { close() {} }, app: { navigation: 1 }, on: {},
    clearTimeout() {}, signin() {}, accessKeyName: endpoint => endpoint, sessionStorage: { removeItem: key => removed.push(key) }, localStorage: { getItem: () => null, setItem: (...args) => saved.push(args) },
  });
  vm.runInContext(section('net.js', 'export function signOut(', 'export function wake('), context);
  context.signOut();
  assert.equal(last(), null); assert.equal(context.authSession, 5);
  assert.deepEqual(removed, ['wss://host.example']); assert.deepEqual(saved, []);
});

test('an observed failed Turn is recalled with its exact event identity and Fault', () => {
  const recorded = [], context = vm.createContext({ handshake: () => true, rememberError: record => recorded.push(record), renderState() {} });
  vm.runInContext(section('main.js', 'function onMessage(', 'function onAck('), context);
  const fault = { type: 'TURN_MODEL_UPSTREAM_UNKNOWN', code: 4299, message: 'Complete cause\n中文🙂', details: { request_id: 'provider-request' } };
  context.onMessage({ kind: 'turn.finished', host_id: 'host', host_incarnation: 'original-run', agent_id: 'agent-a', session_id: 'session-a', load_id: 'load-a', turn_id: 'turn-a', data: { outcome: 'failed', fault } }, { state: true });
  assert.equal(recorded.length, 1); assert.equal(recorded[0].target.session_id, 'session-a');
  assert.equal(recorded[0].target.host_incarnation, 'original-run'); assert.equal(recorded[0].target.turn_id, 'turn-a');
  assert.deepEqual(recorded[0].fault, fault); assert.equal('operation' in recorded[0], false);
  context.onMessage({ kind: 'turn.finished', data: { outcome: 'cancelled' } }, {});
  context.onMessage(null, { state: true });
  assert.equal(recorded.length, 1, 'success, cancellation and history render do not invent new failures');
});

const identity = { host_id: 'host', host_incarnation: 'run', agent_id: 'agent' };
const state = (id, active_turn_id = null) => ({ id, agent_id: 'agent', title: 'Same title', workspace: '/work', state: { controller_revision: 1, runner_revision: 1, load_id: 'load-' + id, active_turn_id, pending_interactions: [], compaction: null } });
function sessionContext(extra = {}) {
  const a = state('session-a'), b = state('session-b', 'turn-b');
  const S = { state: { host: { host_id: 'host', host_incarnation: 'run' }, sessions: [a, b], session: a, status: { busy: false, compacting: false } } };
  const context = vm.createContext({ S, MC, h, icon, statusView, ...extra });
  vm.runInContext('const turnStatus = () => S.state.status;', context);
  vm.runInContext(section('net.js', 'export function targetSession(', 'export const viewed'), context);
  vm.runInContext(section('sessions.js', 'function sessionTarget(', 'const approvalModes'), context);
  return { context, S, a, b };
}

test('captured Context depends on its own native Session across navigation, rights and compaction changes', () => {
  const sheets = [], queries = [], rights = { online: true, operating: true };
  const { context, S, a, b } = sessionContext({
    online: () => rights.online, operating: () => rights.operating, spin: () => h('span', 'spin'), loading: text => h('p', '', text), errBox: text => h('p', '', text),
    ask: (spec, callback) => queries.push({ spec, callback }), sheet: options => { sheets.push(options); return { refresh() {} }; }, compactNow() {},
  });
  vm.runInContext(section('sessions.js', 'export function openContext(', 'export function openOutput('), context);
  context.openContext();
  const panel = sheets[0];
  assert.equal(queries[0].spec.target.session_id, a.id);
  queries[0].callback({ ok: true, data: { tokens: 3 } });
  S.state.session = b; S.state.status = { busy: true, compacting: false };
  assert.equal(panel.foot().props.disabled, false, 'B running cannot disable idle A');
  const before = JSON.stringify(panel.deps());
  a.state = { ...a.state, runner_revision: 2, compaction: { source: { kind: 'manual', operation_id: 'compact-a' }, state: { phase: 'preparing' } } };
  assert.notEqual(JSON.stringify(panel.deps()), before);
  assert.equal(panel.foot().props.disabled, true);
  assert.equal(textOf(panel.foot()), 'Compacting…');
  panel.after();
  assert.equal(queries.length, 2); assert.equal(queries[1].spec.target.session_id, a.id);
  queries[1].callback({ ok: true, data: { tokens: 2 } });
  b.state.runner_revision++; panel.after();
  assert.equal(queries.length, 2, 'B state changes do not reload A context');
  a.state.compaction = null; rights.operating = false;
  assert.equal(panel.foot().props.disabled, true);
  assert.equal(context.sessionStatus({ ...identity, session_id: a.id, host_incarnation: 'old-run' }).available, false);
  assert.equal(context.sessionStatus({ ...identity, session_id: a.id, agent_id: 'different-agent' }).available, false);
});

test('already-open Session menus refresh target busy and connection rights while keeping the compact target', () => {
  const sheets = [], compacted = [], rights = { online: true, operating: true };
  const { context, S, a, b } = sessionContext({
    online: () => rights.online, operating: () => rights.operating, sheet: options => sheets.push(options),
    menuRow: (_m, _icon, label, onclick, options = {}) => h('button', { ...options, onclick }, label), pinRow: () => null,
    rename() {}, openChanges() {}, openContext() {}, actions: { find() {} }, openInfo() {}, copyText() {}, exportSession() {}, remove() {},
    compactNow: (_done, target) => compacted.push(target),
  });
  vm.runInContext(section('sessions.js', 'export function openSessionMenu(', 'export function openInfo('), context);
  context.openSessionMenu();
  const menu = sheets[0], original = JSON.stringify(menu.deps());
  assert.equal(button(menu.body(), 'Compact now').props.disabled, false);
  a.state.active_turn_id = 'turn-a';
  assert.notEqual(JSON.stringify(menu.deps()), original);
  assert.equal(button(menu.body(), 'Compact now').props.disabled, true);
  a.state.active_turn_id = null; S.state.session = b;
  const compact = button(menu.body(), 'Compact now');
  assert.equal(compact.props.disabled, false);
  compact.props.onclick(); assert.equal(compacted[0].session_id, a.id);
  rights.operating = false;
  assert.equal(button(menu.body(), 'Rename').props.disabled, true);
  assert.equal(button(menu.body(), 'Delete session').props.disabled, true);
  rights.online = false;
  assert.equal(button(menu.body(), 'Context').props.disabled, true);
});

test('Session row identities survive equal titles, active status and rename', () => {
  const context = vm.createContext({ MC, h, icon, pendingRow: null, spin: () => h('span', 'spin'), rowText: title => h('span', 'rt', title) });
  vm.runInContext(section('sessions.js', 'function sessionRow(', '\n(() => {'), context);
  for (const status of ['idle', 'running', 'approval', 'compacting']) {
    for (const title of ['A very long common title', 'Renamed']) {
      const id = 'a1b2c3d4-native-session', row = context.sessionRow([id, title, '/work', false, status, false, 'now', false, false, 'native-agent'], false, false);
      const badge = nodes(row).find(n => n.props.class === 'sid'), open = nodes(row).find(n => n.props.class === 'sopen');
      assert.equal(textOf(badge), 'a1b2c3d4'); assert.equal(badge.props.title, id);
      assert.match(open.props['aria-label'], /Session a1b2c3d4-native-session, Agent native-agent/);
      assert.equal(open.props['data-k'], 's' + id); assert.equal(open.props.title, title);
    }
  }
});

test('global shortcuts ignore composing Escape, Enter and navigation keys with either composition marker', () => {
  const seen = { stop: 0, plus: 0 }, listeners = [];
  const context = vm.createContext({ document: { addEventListener: (_name, listener) => listeners.push(listener) }, isMain: () => true, topModal: () => null, topPanel: () => null,
    $: () => null, MC: { canStop: () => true }, turnStatus: () => ({ busy: true }), stop: () => seen.stop++, openPlus: () => seen.plus++,
  });
  vm.runInContext(section('main.js', "document.addEventListener('keydown'", '// ---- lifecycle ----'), context);
  const keydown = listeners[0], event = (key, extra = {}) => ({ key, preventDefault() { this.prevented = true; }, ...extra });
  for (const marker of [{ isComposing: true }, { keyCode: 229 }]) {
    for (const key of ['Escape', 'Enter', 'k', 'ArrowUp']) {
      const e = event(key, { ctrlKey: true, altKey: true, ...marker }); keydown(e); assert.equal(e.prevented, undefined);
    }
  }
  assert.deepEqual(seen, { stop: 0, plus: 0 });
  keydown(event('Escape')); keydown(event('k', { ctrlKey: true }));
  assert.deepEqual(seen, { stop: 1, plus: 1 });
});

test('first Agent preview renders configured Agent and Role instructions independently', () => {
  const sheets = [], context = vm.createContext({ h, sheet: options => sheets.push(options), approvalModes: [['Ask', 'ask']] });
  vm.runInContext(section('sessions.js', 'function reviewInitialAgent(', '// ---- sessions ----'), context);
  const initial = { name: 'First', mode: 'persistent', config: { instructions: 'Agent-only instructions\n中文🙂', role: { name: 'Role', instructions: 'Role-only instructions' }, session_defaults: { model: 'model', reasoning: 'auto', tools: [], execution: { approval: 'ask' } } } };
  context.reviewInitialAgent(initial);
  const body = sheets.at(-1).body();
  assert.ok(textOf(body).includes(initial.config.instructions)); assert.ok(textOf(body).includes(initial.config.role.instructions));
  delete initial.config.instructions; context.reviewInitialAgent(initial);
  assert.equal(textOf(sheets.at(-1).body()).includes('Agent instructions'), false);
});

test('explicit output opens and copies the full native string without preview truncation', () => {
  const sheets = [], context = vm.createContext({ h, MC, copyButton, icon, prefs: { wrap: true }, sheet: options => sheets.push(options), spin() {}, errBox() {}, loadFull() {} });
  vm.runInContext(section('sessions.js', 'export function openOutput(', 'function loadFull('), context);
  const text = '中🙂'.repeat(200000);
  context.openOutput({ name: 'read', detail: '/work/large', state: 'completed', output_text: text, output_lines: 1, output_dropped: 0 });
  const detail = sheets[0];
  assert.equal(nodes(detail.body()).find(n => n.tag === 'pre').children[0], text);
  assert.equal(button(detail.foot(), 'Copy').props.copiedText, text);
  assert.equal(button(detail.foot(), 'Load full output'), undefined);
});

test('loading full native output retains final newline and updates its actual line count', () => {
  const sheets = [], reads = [], context = vm.createContext({ h, MC, copyButton, icon, prefs: { wrap: true }, spin() {}, errBox() {},
    ask: (spec, callback) => reads.push({ spec, callback }), sheet: options => { sheets.push(options); return { refresh() {} }; },
  });
  vm.runInContext(section('sessions.js', 'export function openOutput(', 'export function compactNow('), context);
  context.openOutput({ name: 'read', detail: '/work/partial', state: 'completed', tool_call_id: 'tool-a', output_text: 'partial', output_lines: 1, truncated: true });
  const detail = sheets[0];
  button(detail.foot(), 'Load full output').props.onclick();
  reads[0].callback({ ok: true, data: { text: 'whole\nresult\n', next_offset: 13, eof: true, total: 3 } });
  assert.equal(nodes(detail.body()).find(n => n.tag === 'pre').children[0], 'whole\nresult\n');
  assert.equal(button(detail.foot(), 'Copy').props.copiedText, 'whole\nresult\n');
  assert.match(textOf(detail.head('heading')), /3 lines/);
  assert.equal(button(detail.foot(), 'Load full output'), undefined);
});
