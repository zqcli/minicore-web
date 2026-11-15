import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as MC from '../../web/core.js';
import { HostApplication } from '../../web/host-app.js';
import { deadline, hostFixture, initialAgent } from '../support/host.mjs';

function application() {
  const store = MC.createStore(), waiters = new Set(), notices = [];
  const app = new HostApplication(store, (_event, effects) => {
    if (effects.notice) notices.push(effects.notice);
    for (const waiter of waiters) if (waiter.predicate()) { waiters.delete(waiter); waiter.resolve(); }
  });
  return {
    app, store, notices,
    async wait(predicate, label) {
      if (predicate()) return;
      const waiter = { ...Promise.withResolvers(), predicate }; waiters.add(waiter);
      try { await deadline(waiter.promise, label); } finally { waiters.delete(waiter); }
    },
    async execute(spec) {
      const operation = MC.intent(store, spec);
      assert.ok(operation);
      operation.navigation = app.navigation;
      operation.config_revision = store.state.session?.config_revision;
      operation.controller_revision = app.observation?.state?.controller_revision;
      operation.queuedText = store.state.queue.find(q => q.id === spec.input_id)?.text;
      try { return await app.execute(operation); } finally { store.intents.delete(operation.id); }
    },
  };
}

test('Web application actions and workspace projections use actual Host contracts', { timeout: 60000 }, async t => {
  const fixture = await hostFixture(); t.after(() => fixture.close());
  const connection = await fixture.connect();
  const ui = application(), { app, store } = ui;
  const config = { initial_agent: initialAgent(), templates: [{ name: 'review', text: 'Review $1 carefully. $@' }] };
  await app.initialize(connection, config);
  assert.equal(app.operating, true);
  assert.equal(store.state.agents.length, 0);
  // The deployed bootstrap deliberately has local tools and no default workspace.
  await ui.execute(MC.intents.newSession(fixture.workspace, null, config.initial_agent));
  assert.equal(store.state.session.workspace, fixture.workspace);
  assert.equal(store.state.agent.config.session_defaults.workspace.path, fixture.workspace);
  assert.equal(store.state.sessions.length, 1);
  const target = MC.captureTarget(store, {});
  const files = await app.query(MC.queries.files('README'), target);
  assert.deepEqual(files.paths, ['README.md']);
  const context = await app.query(MC.queries.context(), target);
  assert.ok(context.native);
  await writeFile(join(fixture.workspace, 'README.md'), '# Changed workspace\n\nA real diff 🙂\n');
  const changes = await app.query(MC.queries.changes(), target);
  const changed = changes.files.find(file => file.path === 'README.md');
  assert.ok(changed?.change_ref);
  const diff = await app.query({ ...MC.queries.diff('README.md'), change: changed }, target);
  assert.ok(diff.lines.includes('+A real diff 🙂'));
  await ui.execute(MC.intents.renameSession(target.session_id, 'Native Web migration'));
  await ui.wait(() => store.state.session.title === 'Native Web migration', 'saved Session title');
  await ui.execute(MC.intents.setReasoning('high'));
  await ui.wait(() => store.state.session.reasoning === 'high', 'saved Session reasoning');

  await ui.execute(MC.intents.submit('/review "README.md" extra'));
  const model = await fixture.provider.next();
  assert.match(JSON.stringify(model.body.messages), /Review README.md carefully\. README.md extra/);
  model.tools([{ id: 'application-write', name: 'write', arguments: { path: 'app-created.txt', content: 'From the actual tool\n' } }]);
  await ui.wait(() => !!store.state.interaction, 'application approval projection');
  const interaction = store.state.interaction;
  await ui.execute(MC.intents.answer(interaction.turn_id, interaction.id, 'allow_once', interaction.load_id));
  const follow = await fixture.provider.next();
  assert.equal(await readFile(join(fixture.workspace, 'app-created.txt'), 'utf8'), 'From the actual tool\n');
  follow.finish('Application flow complete.');
  await ui.wait(() => !store.state.status.busy && store.blocks.some(block => block.text === 'Application flow complete.'), 'completed application Turn');

  await ui.execute(MC.intents.submit('Hold this Turn while I change the queue'));
  await fixture.provider.next();
  const queued = await ui.execute(MC.intents.queue('Remove this pending follow-up'));
  await ui.wait(() => store.state.queue.some(q => q.id === queued.input_id), 'native next-turn queue');
  await ui.execute(MC.intents.unqueue(queued.input_id));
  await ui.wait(() => !store.state.queue.some(q => q.id === queued.input_id), 'native queue removal');
  await ui.execute(MC.intents.cancel(store.state.status.turn_id));
  await ui.wait(() => !store.state.status.busy, 'native Turn cancellation');

  const second = await fixture.connect(), observer = application();
  await observer.app.initialize(second, config);
  assert.equal(observer.app.operating, false);
  assert.equal(observer.store.state.session.title, 'Native Web migration');
  assert.equal(observer.store.blocks.filter(block => block.text === 'Application flow complete.').length, 1);
  await assert.rejects(observer.execute(MC.intents.submit('Not permitted')), /read-only/);
  connection.close();
  await observer.wait(() => observer.store.state.host.control?.occupied === false, 'operator disconnection');
  assert.equal(observer.app.operating, false);
  assert.ok((await observer.app.query(MC.queries.files('README'), MC.captureTarget(observer.store, {}))).paths.includes('README.md'));
});

test('manual compaction and draft Session creation preserve native lifecycle results', { timeout: 60000 }, async t => {
  const fixture = await hostFixture(); t.after(() => fixture.close());
  const ui = application(), { app, store } = ui;
  const config = { initial_agent: initialAgent(), templates: [] };
  config.initial_agent.config.session_defaults.execution.compaction.target_percent = 1;
  await app.initialize(await fixture.connect(), config);
  await ui.execute(MC.intents.newSession(fixture.workspace, null, config.initial_agent));
  await ui.execute(MC.intents.submit('Remember this migration decision'));
  const priorAnswer = 'Keep the existing UI and use native Host WSS. '.repeat(3000);
  (await fixture.provider.next()).finish(priorAnswer);
  await ui.wait(() => !store.state.status.busy && store.blocks.some(block => block.text === priorAnswer), 'first completed Turn');
  await ui.execute(MC.intents.submit('Keep the newest Turn available'));
  (await fixture.provider.next()).finish('This newest Turn remains outside the compacted prefix.');
  await ui.wait(() => !store.state.status.busy && store.blocks.some(block => block.text === 'This newest Turn remains outside the compacted prefix.'), 'second history group');
  await ui.execute(MC.intents.compact());
  const compact = await fixture.provider.next().catch(async error => {
    const context = await app.query(MC.queries.context(), MC.captureTarget(store, {}));
    error.message += ': ' + JSON.stringify(context.native.compaction);
    throw error;
  });
  compact.finish('The UI is unchanged; the backend is native Host WSS.');
  await ui.wait(() => !store.state.status.compacting && store.blocks.some(block => block.type === 'compaction'), 'finished manual compaction');
  const agentId = store.state.selected_agent_id, firstId = store.sid;
  await ui.execute(MC.intents.newSession(fixture.workspace, agentId));
  assert.equal(store.state.session, null);
  assert.equal(store.state.sessions.length, 1, 'a local new-session draft has no server side effect');
  await ui.execute(MC.intents.submit('Create the next Session from this draft'));
  (await fixture.provider.next()).finish('The second Session is ready.');
  await ui.wait(() => !store.state.status.busy && store.blocks.some(block => block.text === 'The second Session is ready.'), 'second completed Turn');
  assert.notEqual(store.sid, firstId);
  assert.equal(store.state.sessions.length, 2);
  const secondId = store.sid;
  await ui.execute(MC.intents.deleteSession(secondId));
  await ui.wait(() => !store.state.sessions.some(session => session.id === secondId), 'deleted Session removed from catalog');
  assert.notEqual(store.state.session?.id, secondId, 'the UI cannot keep a deleted Session as an actionable target');
});

test('native upstream error remains complete through live state, fresh history and export', { timeout: 30000 }, async t => {
  const fixture = await hostFixture(); t.after(() => fixture.close());
  const ui = application(), config = { initial_agent: initialAgent(), templates: [] };
  await ui.app.initialize(await fixture.connect(), config);
  await ui.execute(MC.intents.newSession(fixture.workspace, null, config.initial_agent));
  await ui.execute(MC.intents.submit('Return a controlled upstream error'));
  const message = '上游原始错误🙂\nThe requested model is unavailable.\nKeep this final diagnostic line.';
  (await fixture.provider.next()).error(message, { requestId: 'web-failure-request' });
  await ui.wait(() => ui.store.blocks.some(b => b.type === 'turn_end' && b.outcome === 'failed'), 'failed native Turn');
  const live = MC.turnEnd(ui.store.blocks.find(b => b.type === 'turn_end'), null, 0).failure;
  for (const line of message.split('\n')) assert.ok(live.message.includes(line), live.message);
  const turn = [...ui.app.observation.turns.values()].find(turn => turn.fault);
  assert.equal(turn.fault.details.http_status, 400);
  assert.equal(turn.fault.details.provider_type, 'invalid_request_error');
  assert.equal(turn.fault.details.provider_code, 'fixture_error');
  assert.equal(turn.fault.details.request_id, 'web-failure-request');
  const restored = application();
  await restored.app.initialize(await fixture.connect(), config);
  const historical = restored.store.blocks.find(b => b.type === 'turn_end' && b.outcome === 'failed');
  assert.ok(historical?.reason);
  const displayed = MC.turnEnd(historical, null, 0).failure;
  for (const line of message.split('\n')) {
    assert.ok(displayed.message.includes(line), displayed.message);
    assert.ok(MC.exportMd(restored.store.state, restored.store.blocks).includes(line));
  }
  assert.equal(fixture.provider.bodies.length, 1, 'reopening history never resends the failed business input');
});

test('Responses reasoning boundaries survive real WSS streaming and canonical history', { timeout: 30000 }, async t => {
  const fixture = await hostFixture({ api: 'responses' }); t.after(() => fixture.close());
  const ui = application(), config = { initial_agent: initialAgent(), templates: [] };
  await ui.app.initialize(await fixture.connect(), config);
  await ui.execute(MC.intents.newSession(fixture.workspace, null, config.initial_agent));
  await ui.execute(MC.intents.submit('Stream distinct reasoning parts'));
  const model = await fixture.provider.next();
  model.reasoning([['Preparing ', 'verification'], [], ['第二部分🙂']]);
  model.reasoning([['Third ', 'item']]);
  const expected = 'Preparing verification\n第二部分🙂\nThird item';
  await ui.wait(() => ui.store.blocks.some(b => b.reasoning === expected), 'live reasoning boundaries');
  model.finish('The visible answer is complete.');
  await ui.wait(() => !ui.store.state.status.busy && ui.store.blocks.some(b => b.text === 'The visible answer is complete.'), 'Responses Turn completion');
  const restored = application();
  await restored.app.initialize(await fixture.connect(), config);
  assert.equal(restored.store.blocks.find(b => b.type === 'assistant' && b.reasoning)?.reasoning, expected);
  assert.equal(fixture.provider.bodies.length, 1);
});

test('failed manual compaction is reported once for its background Session and in Context', { timeout: 60000 }, async t => {
  const agent = initialAgent(); agent.config.session_defaults.execution.compaction.target_percent = 1;
  const fixture = await hostFixture({ agent }); t.after(() => fixture.close());
  const ui = application(), config = { initial_agent: agent, templates: [] };
  const connection = await fixture.connect();
  await ui.app.initialize(connection, config);
  await ui.execute(MC.intents.newSession(fixture.workspace, null, agent));
  const a = MC.captureTarget(ui.store, {});
  await ui.execute(MC.intents.submit('Retain the older history group'));
  const longAnswer = 'Keep this older record for compaction. '.repeat(3000);
  (await fixture.provider.next()).finish(longAnswer);
  await ui.wait(() => !ui.store.state.status.busy && ui.store.blocks.some(b => b.text === longAnswer), 'older history');
  await ui.execute(MC.intents.submit('Keep this newer group intact'));
  (await fixture.provider.next()).finish('Newer record.');
  await ui.wait(() => !ui.store.state.status.busy && ui.store.blocks.some(b => b.text === 'Newer record.'), 'newer history');
  await ui.execute(MC.intents.newSession(fixture.workspace, a.agent_id));
  await ui.execute(MC.intents.submit('Create a separate viewed Session'));
  (await fixture.provider.next()).finish('Session B.');
  await ui.wait(() => !ui.store.state.status.busy && ui.store.blocks.some(b => b.text === 'Session B.'), 'Session B ready');
  const b = MC.captureTarget(ui.store, {});
  await ui.app.openSession(a);
  const accepted = await ui.execute(MC.intents.compact());
  const model = await fixture.provider.next();
  await ui.app.openSession(b);
  const message = 'Compaction provider refused the request.\n保留完整压缩错误🙂';
  model.error(message, { requestId: 'web-compaction-request' });
  await ui.wait(() => ui.notices.some(n => n.operation?.kind === 'session.compact' && n.target?.session_id === a.session_id), 'background compaction failure');
  const failures = () => ui.notices.filter(n => n.operation?.kind === 'session.compact');
  assert.equal(failures().length, 1);
  const failure = failures()[0];
  assert.equal(failure.target.agent_id, a.agent_id);
  assert.equal(failure.target.host_incarnation, connection.info.host_incarnation);
  assert.equal(failure.operation.operation_id, accepted.receipt.operation_id);
  for (const line of message.split('\n')) assert.ok(failure.fault.message.includes(line), failure.fault.message);
  assert.equal(ui.store.sid, b.session_id);
  const snapshot = await connection.call('session.state', { target: { agent_id: a.agent_id, session_id: a.session_id } });
  ui.app.hostEvent({ ...snapshot, kind: 'session.state' });
  ui.app.hostEvent({ ...snapshot, kind: 'session.state' });
  assert.equal(failures().length, 1, 'repeat native state reads cannot repeat the same failure notification');
  const context = await ui.app.query(MC.queries.context(), a);
  for (const line of message.split('\n')) assert.ok(context.failure.includes(line), context.failure);
  assert.equal(context.compacting, false);
});
