import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionObservation, mergeSessionState, statusView } from '../web/host-state.js';

const session = { host_id: 'host', host_incarnation: 'instance', agent_id: 'agent', session_id: 'session' };
const model = { ...session, turn_id: 'turn', load_id: 'load', response_index: 0 };
const delta = (start, text) => ({ ...model, kind: 'model.output.delta', data: { channel: 'text', start, end: start + new TextEncoder().encode(text).length, text } });
const history = (items, next_cursor = null, upper_bound = 10) => ({ ...session, data: { items, next_cursor, upper_bound } });

test('controller and Runner revisions merge independently within their original Load', () => {
  const current = { controller_revision: 10, runner_revision: 20, load_id: 'one', next_turn: ['latest'], pending_interactions: ['old'], compaction: null };
  const runner = mergeSessionState(current, { ...current, controller_revision: 9, runner_revision: 21, next_turn: ['stale'], pending_interactions: ['new'] });
  assert.deepEqual(runner.next_turn, ['latest']); assert.deepEqual(runner.pending_interactions, ['new']);
  const controller = mergeSessionState(runner, { ...current, controller_revision: 11, runner_revision: 19, next_turn: ['newest'], pending_interactions: ['stale'] });
  assert.deepEqual(controller.next_turn, ['newest']); assert.deepEqual(controller.pending_interactions, ['new']);
  const reloaded = mergeSessionState(controller, { ...current, controller_revision: 12, runner_revision: 1, load_id: 'two', pending_interactions: [] });
  const staleLoad = mergeSessionState(reloaded, { ...current, controller_revision: 11, runner_revision: 1000, pending_interactions: ['wrong Load'] });
  assert.equal(staleLoad.load_id, 'two'); assert.deepEqual(staleLoad.pending_interactions, []); assert.equal(staleLoad.runner_revision, 1);
});

test('canonical history replaces live content once and retains original source identities', () => {
  const view = new SessionObservation(session);
  view.event(delta(0, 'Hello ')); view.render();
  view.event({ ...model, kind: 'model.response.finished', data: { history_position: 1, recorded_at: '2026-11-14T00:00:00Z', result: { content: [{ type: 'text', data: 'Hello 世界' }], usage: { input_tokens: 4 } }, output_positions: [{ channel: 'text', end: 12 }] } });
  view.historyPage(history([{ kind: 'user', position: 0, turn_id: 'turn', text: 'Question', message_id: 'message', received_at: '2026-11-14T00:00:00Z' }, { kind: 'assistant', position: 1, turn_id: 'turn', response_index: 0, response: { content: [{ type: 'text', data: 'Hello 世界' }], usage: { input_tokens: 4 } } }]));
  let rendered = view.render();
  assert.equal(rendered.blocks.filter(b => b.type === 'assistant').length, 1);
  const canonical = rendered.blocks.find(b => b.type === 'assistant');
  assert.equal(canonical.turn_id, 'turn'); assert.equal(canonical.response_index, 0); assert.equal(canonical.load_id, undefined);
  view.event(delta(6, '世界')); rendered = view.render();
  assert.equal(rendered.blocks.find(b => b.type === 'assistant'), canonical); assert.equal(canonical.streaming, false);
  assert.equal(view.event({ ...delta(0, 'wrong'), host_incarnation: 'another' }), false);
});

test('backward pages retain their fixed bound, and anonymous historical responses do not collapse', () => {
  const view = new SessionObservation(session);
  view.historyPage(history([{ position: 4, kind: 'assistant', response: { content: [{ type: 'text', data: 'four' }] } }], 'opaque-cursor', 5));
  assert.throws(() => view.historyPage(history([], null, 6), true), /upper bound/);
  view.historyPage(history([{ position: 2, kind: 'assistant', response: { content: [{ type: 'text', data: 'two' }] } }], null, 5), true);
  assert.deepEqual(view.render().blocks.map(b => b.text), ['two', 'four']);
});

test('streaming updates reuse stable canonical blocks without walking history', () => {
  const view = new SessionObservation(session);
  view.historyPage(history(Array.from({ length: 500 }, (_, position) => ({ kind: 'assistant', position, turn_id: 'old-' + position, response_index: 0, response: { content: [{ type: 'text', data: 'Saved response ' + position }] } }))));
  view.event(delta(0, 'a')); const initial = view.render(); const stable = initial.blocks[0];
  // Any canonical traversal during a steady output delta would now fail this test.
  view.history.values = () => { throw new Error('Streaming traversed canonical history'); };
  for (let i = 1; i < 100; i++) { view.event(delta(i, 'b')); const update = view.render(); assert.deepEqual(update.dirty, [500]); assert.equal(update.blocks[0], stable); }
  assert.equal(view.blocks[500].text.length, 100);
});

test('tool channels use native ToolCall identity even with a response index in state', () => {
  const view = new SessionObservation(session), tool = { ...session, turn_id: 'turn', load_id: 'load', tool_call_id: 'tool' };
  view.event({ ...tool, kind: 'toolcall.state', data: { response_index: 2, name: 'bash', state: 'running', runner_revision: 4 } }); view.render();
  view.event({ ...tool, kind: 'toolcall.output.delta', data: { channel: 'stdout', start: 0, end: 5, text: 'hi🙂'.slice(1) } });
  const block = view.render().blocks[0]; assert.equal(block.output.join('\n'), 'i🙂'); assert.equal(block.tool_call_id, 'tool'); assert.equal(block.response_index, 2);
  assert.equal(statusView({ compaction: { state: { phase: 'finished' } } }).compacting, false);
});
