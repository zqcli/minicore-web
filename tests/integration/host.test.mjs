import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { newId } from '../../web/host.js';
import { SessionObservation, interactionView } from '../../web/host-state.js';
import { deadline, hostFixture, initialAgent } from '../support/host.mjs';

function eventLog(project) {
  const events = [], waiters = new Set();
  return {
    events,
    push(event) {
      project.event(event); events.push(event);
      for (const waiter of waiters) if (waiter.predicate(event)) { waiters.delete(waiter); waiter.resolve(event); }
    },
    async wait(predicate) {
      const present = events.find(predicate);
      if (present) return present;
      const waiter = { ...Promise.withResolvers(), predicate };
      waiters.add(waiter);
      try { return await deadline(waiter.promise, 'actual Host event'); }
      finally { waiters.delete(waiter); }
    },
  };
}
const targetOf = value => ({ agent_id: value.agent_id, session_id: value.session_id });
const send = (connection, target, text) => connection.call('message.send', {
  message_id: newId(), target: { kind: 'session', ...target }, mode: 'steer', text,
});
const history = (connection, target, cursor = null, limit = 100) => connection.call('session.history.read', {
  target, request: { cursor, limit, direction: 'backward' },
});

test('real WSS directory picker preserves scope, pagination and operation rights', { timeout: 30000 }, async t => {
  const fixture = await hostFixture(); t.after(() => fixture.close());
  const operator = await fixture.connect(), observer = await fixture.connect();
  assert.equal(operator.info.can_operate, true);
  assert.equal(observer.info.can_operate, false);
  const roots = await operator.call('workspace.roots');
  assert.equal(roots.roots[0].path, fixture.workspace);
  const created = await operator.call('workspace.mkdir', { operation_id: newId(), parent: fixture.workspace, name: 'created' });
  assert.equal(created.result.status, 'created');
  assert.ok((await stat(created.result.path)).isDirectory());
  await assert.rejects(observer.call('workspace.mkdir', { operation_id: newId(), parent: fixture.workspace, name: 'forbidden' }), error => error.kind === 'business');
  await assert.rejects(stat(join(fixture.workspace, 'forbidden')), { code: 'ENOENT' });
  const first = await observer.call('workspace.list', { path: fixture.workspace, limit: 1 });
  assert.equal(first.entries.length, 1);
  assert.ok(first.next_cursor);
  const second = await observer.call('workspace.list', { path: fixture.workspace, limit: 1, cursor: first.next_cursor });
  assert.notEqual(first.entries[0].path, second.entries[0].path);
  assert.equal(second.next_cursor, null);
  await assert.rejects(observer.call('workspace.list', { path: fixture.directory, limit: 10 }), error => error.kind === 'business');
});

test('native live output, approvals, tools and canonical history project through real WSS', { timeout: 60000 }, async t => {
  const fixture = await hostFixture(); t.after(() => fixture.close());
  const connection = await fixture.connect();
  const initial = initialAgent();
  initial.config.session_defaults.workspace = { path: fixture.workspace };
  const created = await connection.call('agent.create', { ...initial, operation_id: newId(),
    default_session: { overrides: { workspace: { path: fixture.workspace } } } });
  assert.ok(created.agent_id && created.session_id);
  const target = targetOf(created), identity = { ...connection.info, ...target };
  const project = new SessionObservation(identity), log = eventLog(project);
  await connection.subscribe({ scope: { kind: 'session', ...target }, categories: ['state', 'output', 'completion', 'message', 'interaction'] }, {
    onBaseline: baseline => project.baseline(baseline), onEvent: event => log.push(event),
  });
  project.historyPage(await history(connection, target));
  await send(connection, target, 'Stream a greeting');
  const greeting = await fixture.provider.next();
  greeting.delta('先检查', 'reasoning_content');
  greeting.delta('你好');
  const firstDelta = await log.wait(event => event.kind === 'model.output.delta' && event.data.text === '你好');
  assert.equal(firstDelta.data.end - firstDelta.data.start, 6);
  assert.equal(project.render().blocks.find(block => block.type === 'assistant')?.text, '你好');
  greeting.finish('🙂');
  const firstEnd = await log.wait(event => event.kind === 'turn.finished');
  project.historyPage(await history(connection, target));
  assert.equal(project.render().blocks.filter(block => block.type === 'assistant' && block.text === '你好🙂').length, 1);

  await send(connection, target, 'Write a real file with approval');
  const write = await fixture.provider.next();
  write.tools([{ id: 'fixture-write', name: 'write', arguments: { path: 'created.txt', content: '工具实际写入🙂\n' } }]);
  const approval = await log.wait(event => event.kind === 'interaction.requested');
  const state = await connection.call('session.state', { target });
  project.stateSnapshot(state);
  const pending = state.data.pending_interactions[0];
  const prompt = interactionView(pending, state.data, project.render().blocks.find(block => block.type === 'tool'));
  assert.equal(prompt.kind, 'approval');
  assert.ok(prompt.prompt);
  await connection.call('interaction.answer', { target, request: {
    operation_id: newId(), turn_id: approval.turn_id, load_id: approval.load_id,
    interaction_id: approval.interaction_id, answer: { kind: 'approval', decision: 'allow_once' },
  } });
  const result = await fixture.provider.next();
  assert.equal(result.body.messages.filter(message => message.role === 'tool' && message.tool_call_id === 'fixture-write').length, 1);
  assert.equal(await readFile(join(fixture.workspace, 'created.txt'), 'utf8'), '工具实际写入🙂\n');
  result.finish('File written.');
  await log.wait(event => event.kind === 'turn.finished' && event.turn_id !== firstEnd.turn_id);
  const full = await history(connection, target);
  project.historyPage(full);
  const blocks = project.render().blocks;
  assert.equal(blocks.filter(block => block.type === 'tool' && block.tool_call_id === 'fixture-write').length, 1);
  assert.equal(blocks.filter(block => block.type === 'assistant' && block.text === 'File written.').length, 1);

  const observer = await fixture.connect();
  assert.equal(observer.info.can_operate, false);
  const restored = new SessionObservation({ ...observer.info, ...target });
  const page = await history(observer, target, null, 2);
  restored.historyPage(page);
  assert.ok(page.data.next_cursor);
  const older = await history(observer, target, page.data.next_cursor, 2);
  restored.historyPage(older, true);
  assert.equal(page.data.upper_bound, older.data.upper_bound);
  assert.equal(new Set([...page.data.items, ...older.data.items].map(record => record.position)).size, page.data.items.length + older.data.items.length);
  restored.historyPage(full);
  assert.equal(restored.render().blocks.filter(block => block.type === 'assistant' && block.text === '你好🙂').length, 1);
});
