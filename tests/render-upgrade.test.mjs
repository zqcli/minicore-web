import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import * as MC from '../web/core.js';
import { SessionObservation } from '../web/host-state.js';

const session = { host_id: 'host', host_incarnation: 'incarnation', agent_id: 'agent', session_id: 'session' };
const turn = { ...session, turn_id: 'turn', load_id: 'load' };
const state = { session: { title: 'Native transcript', workspace: '/workspace', model: 'provider/model' } };
const history = (items, next_cursor = null) => ({ ...session, data: { items, next_cursor, upper_bound: 20 } });
const source = readFileSync(new URL('../web/conversation.js', import.meta.url), 'utf8');
// Exercise the actual small DOM constructors with a node recorder. Real browser
// interaction, layout and clipboard validation remain the browser suite's work.
const h = (tag, props, ...children) => ({ tag, props: typeof props === 'string' ? { class: props } : props || {}, children: children.flat(Infinity).filter(x => x != null && x !== false) });
const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...tree.children.flatMap(nodes)];
const words = tree => typeof tree === 'string' ? tree : !tree || typeof tree !== 'object' ? '' : tree.children.map(words).join('');
const byClass = (tree, cls) => nodes(tree).find(n => (n.props.class || '').split(' ').includes(cls));

test('bounded previews cap one-line Unicode and many-line text before display without splitting the full body', () => {
  const huge = '界🙂'.repeat(200000);
  for (const tail of [false, true]) {
    const p = MC.boundedPreview(huge, { maxLines: 20, maxChars: 4096, tail });
    assert.equal(p.truncated, true); assert.ok(p.text.length <= 4096);
    assert.equal(p.text.isWellFormed(), true);
    assert.ok(tail ? huge.endsWith(p.text) : huge.startsWith(p.text));
  }
  const lines = Array.from({ length: 10000 }, (_, i) => '第' + i + '行🙂').join('\n');
  assert.equal(MC.boundedPreview(lines, { maxLines: 3, maxChars: 4096 }).text, '第0行🙂\n第1行🙂\n第2行🙂');
  assert.equal(MC.boundedPreview(lines, { maxLines: 3, maxChars: 4096, tail: true }).text, '第9997行🙂\n第9998行🙂\n第9999行🙂');
  assert.deepEqual(MC.boundedPreview('a\n\nb', { maxLines: 3, maxChars: 4 }), { text: 'a\n\nb', truncated: false });
  assert.deepEqual(MC.boundedPreview('🙂', { maxLines: 1, maxChars: 1 }), { text: '', truncated: true });
  assert.deepEqual(MC.boundedPreview('🙂', { maxLines: 1, maxChars: 1, tail: true }), { text: '', truncated: true });
  assert.deepEqual(MC.boundedPreview('', { maxLines: 0, maxChars: 0 }), { text: '', truncated: false });
});

test('native large tool result has a bounded card but complete Open, Copy, Find and Markdown export', () => {
  const text = '界🙂'.repeat(200000), result = Object.freeze({ outcome: 'success', output: Object.freeze({ content: text }) });
  const view = new SessionObservation(session);
  view.historyPage(history([{ kind: 'tool_result', position: 2, turn_id: 'turn', tool_call_id: 'tool', name: 'read', result }]));
  const originalSplit = String.prototype.split;
  let block, card;
  const copied = [], opened = [];
  const ctx = { MC, h, prefs: { wrap: false }, wrapButton: () => h('button', '', 'Wrap'), copyButton: value => { copied.push(value); return h('button', '', 'Copy'); }, icon: () => null, openOutput: value => opened.push(value) };
  vm.runInNewContext(source.slice(source.indexOf('const TAIL ='), source.indexOf('function toolNode(')), ctx);
  try {
    String.prototype.split = function (...args) {
      assert.notEqual(String(this), text, 'projection/card preview must not split the full native output');
      return originalSplit.apply(this, args);
    };
    block = view.render().blocks[0]; card = ctx.toolBody(block, MC.toolInfo(block));
  } finally { String.prototype.split = originalSplit; }
  assert.equal(block.output_text, text); assert.equal(block.output_lines, 1);
  assert.equal(block.result, result); assert.equal(result.output.content, text); assert.equal(block.truncated, false);
  const preview = words(byClass(card, 'out'));
  assert.ok(preview.length <= 4096); assert.equal(preview.isWellFormed(), true); assert.ok(text.endsWith(preview));
  assert.match(words(byClass(card, 'lbl')), /Preview truncated/);
  assert.equal(copied[0], text);
  nodes(card).find(n => n.tag === 'button' && words(n) === 'Open').props.onclick();
  assert.equal(opened[0], block); assert.equal(MC.toolOutput(opened[0]), text);
  assert.deepEqual(MC.findBlocks([block], '界🙂界', 0, 1), [0]);
  assert.ok(MC.exportMd(state, [block]).includes(text));
});

test('tool export preserves internal blank lines and backtick fences and labels incomplete observations', () => {
  const text = 'before\n\n\n```\ncode\n````\n  after  \n';
  const block = { type: 'tool', name: 'bash', detail: 'printf', state: 'running', output_text: text, output_lines: 9, truncated: true };
  const md = MC.exportMd(state, [block]);
  assert.ok(md.includes('`````\n' + text + '`````'));
  assert.match(md, /Output is incomplete; only the observed text is included/);
  assert.equal(block.output_text, text);
});

test('live native Fault details survive projection while paginated reopened failures use only the real reason', () => {
  const reason = '提供方失败🙂\nfirst detail  \n\nlast detail';
  const fault = { type: 'TURN_MODEL_UPSTREAM_UNKNOWN', code: 4299, message: reason, diagnostic_id: 'diagnostic', details: { http_status: 502, provider_type: 'upstream_failure', provider_code: 'provider-code', request_id: 'request-🙂' } };
  const live = new SessionObservation(session);
  live.event({ ...turn, kind: 'turn.finished', data: { state: 'finished', runner_revision: 4, outcome: 'failed', fault, persistence: 'saved' } });
  const liveBlock = live.render().blocks[0], failure = MC.turnEnd(liveBlock, null, 0).failure;
  assert.equal(failure.message, reason); assert.equal(failure.code, 4299); assert.equal(failure.type, fault.type);
  assert.deepEqual(failure.details, fault.details); assert.equal(failure.diagnostic_id, 'diagnostic');
  assert.equal(Object.hasOwn(failure.details, 'upstream'), false);
  assert.deepEqual(failure.diagnostics, [['HTTP status', '502'], ['Provider type', 'upstream_failure'], ['Provider code', 'provider-code'], ['Request id', 'request-🙂'], ['Diagnostic id', 'diagnostic']]);
  const reopened = new SessionObservation(session);
  reopened.historyPage(history([{ kind: 'user', position: 10, text: 'Later message' }], 'older'));
  reopened.historyPage(history([{ kind: 'turn_finished', position: 2, turn_id: 'turn', outcome: 'failed', reason }]), true);
  const historical = reopened.render().blocks.find(b => b.type === 'turn_end'), shown = MC.turnEnd(historical, null, 0);
  assert.equal(shown.parts[0], 'Failed'); assert.equal(shown.failure.message, reason);
  for (const key of ['code', 'type', 'details', 'diagnostic_id']) assert.equal(Object.hasOwn(shown.failure, key), false, key);
  assert.equal(historical.load_id, undefined); assert.deepEqual(shown.failure.diagnostics, []);
  const exported = MC.exportMd(state, reopened.blocks);
  assert.ok(exported.includes(reason.split('\n').map(line => '> ' + line).join('\n')));
  assert.equal(MC.turnEnd({ type: 'turn_end', outcome: 'cancelled', reason }, null, 0).parts[0], 'Stopped');
  assert.equal(MC.turnEnd({ type: 'turn_end', outcome: 'cancelled', reason }, null, 0).failure, null);
  assert.equal(MC.turnEnd({ type: 'turn_end', outcome: 'cancelled', failure: fault }, null, 0).parts[0], 'Stopped');
});

test('collapsed error DOM uses the bounded message and expanding or Copy preserves all native content', () => {
  const message = '🙂'.repeat(200000) + '\nsecond\nthird\nfourth';
  const f = MC.failureView({ code: 4299, type: 'TURN_MODEL_UPSTREAM_UNKNOWN', message, details: { request_id: 'actual-request' } });
  const copied = [], ctx = { h, MC, isOpen: () => false, copyButton: value => { copied.push(value); return h('button', '', 'Copy'); } };
  vm.runInNewContext(source.slice(source.indexOf('function failureNode('), source.indexOf('function blockNode(')), ctx);
  const collapsed = ctx.failureNode(h('div', '', 'Failed'), f, 0), preview = words(byClass(collapsed, 'fmt'));
  assert.ok(preview.length <= 2048); assert.equal(preview.isWellFormed(), true); assert.ok(message.startsWith(preview));
  assert.match(words(collapsed), /Message preview truncated/);
  assert.equal(nodes(collapsed).find(n => n.props['data-k'] === 'e0').props.hidden, false);
  assert.equal(copied[0], message);
  ctx.isOpen = () => true;
  const expanded = ctx.failureNode(h('div', '', 'Failed'), f, 0);
  assert.equal(words(byClass(expanded, 'fmt')), message);
  assert.match(words(expanded), /actual-request/);
  assert.ok(MC.exportMd(state, [{ type: 'turn_end', outcome: 'failed', failure: f }]).includes('> ' + message.split('\n')[0]));
});

test('reasoning stream and canonical history preserve Host line boundaries without per-delta separators', () => {
  const view = new SessionObservation(session), chunks = ['主题🙂\npart ', 'one\r', '\n\n第二部分', '\nend'];
  let start = 0, full = '';
  for (const text of chunks) {
    const end = start + new TextEncoder().encode(text).length;
    view.event({ ...turn, response_index: 0, kind: 'model.output.delta', data: { channel: 'reasoning', start, end, text } });
    full += text; assert.equal(view.render().blocks[0].reasoning, full); start = end;
  }
  const record = { kind: 'assistant', position: 1, turn_id: 'turn', response_index: 0, response: { content: [{ type: 'reasoning', data: { text: full } }, { type: 'text', data: '  answer\n\n\nbody  ' }] } };
  view.historyPage(history([record]));
  const canonical = view.render().blocks[0];
  assert.equal(canonical.reasoning, full); assert.equal(canonical.text, '  answer\n\n\nbody  '); assert.equal(canonical.streaming, false);
  const reopened = new SessionObservation(session); reopened.historyPage(history([record]));
  assert.equal(reopened.render().blocks[0].reasoning, full);
});

test('empty tool-only and whitespace assistant records stay canonical and quiet while partial and recovery notices remain visible', () => {
  const view = new SessionObservation(session);
  view.historyPage(history([{ kind: 'assistant', position: 1, turn_id: 'turn', response_index: 0, response: { content: [{ type: 'tool_call', data: { tool_call_id: 'tool', name: 'read', arguments: { path: '/file' } } }] } }]));
  const blocks = view.render().blocks, empty = blocks[0];
  assert.equal(blocks.length, 2); assert.equal(empty.history_position, 1); assert.equal(empty.response_index, 0); assert.equal(MC.quiet(empty), true);
  const whitespace = { ...empty, text: ' \n\t', reasoning: '\r\n  ' };
  assert.equal(MC.quiet(whitespace), true);
  for (const extra of [{ partial: true }, { recovery: { status: 'unavailable', reason: 'Source released' } }]) {
    const visible = { ...whitespace, ...extra };
    assert.equal(MC.quiet(visible), false); assert.ok(MC.projectionLabels(visible).length > 0);
    const finished = [blocks[1], visible, { type: 'turn_end', turn_id: 'turn', outcome: 'failed' }];
    assert.deepEqual(MC.foldTurns(finished, 0, finished.length).flatMap(fold => fold.hidden), [0], 'automatic folding must leave the notice visible');
  }
  const tools = [{ ...blocks[1], tool_call_id: 'one' }, whitespace, { ...blocks[1], tool_call_id: 'two' }];
  assert.deepEqual(MC.groupTools(tools, 0, 3)[0].members, [0, 2]);
  tools[1] = { ...whitespace, partial: true };
  assert.deepEqual(MC.groupTools(tools, 0, 3), []);
  const actual = { ...empty, text: 'before\n\n\nafter  ' };
  assert.equal(MC.quiet(actual), false); assert.ok(MC.exportMd(state, [actual]).includes(actual.text));
});

test('Context shows actual failed manual compaction cause without treating other results as failures', () => {
  const native = { model: 'provider/model', config_revision: 2, compaction_settings: { enabled: false }, compaction: { source: { kind: 'manual', operation_id: 'compact-a' }, state: { phase: 'finished', result: { outcome: 'failed', fault: { message: '压缩失败🙂\nfull reason' } } } } };
  assert.equal(MC.contextView({ native }).failure, '压缩失败🙂\nfull reason');
  for (const outcome of ['compacted', 'unchanged', 'cancelled']) {
    const next = structuredClone(native); next.compaction.state.result = { outcome };
    assert.equal(MC.contextView({ native: next }).failure, '');
  }
  const pending = structuredClone(native); pending.compaction.state = { phase: 'summarizing' };
  assert.equal(MC.contextView({ native: pending }).failure, '');
  const blocked = { ...native, block_reason: { message: 'Actual current block' } };
  assert.equal(MC.contextView({ native: blocked }).failure, 'Actual current block');
});
