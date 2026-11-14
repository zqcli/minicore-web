import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as MC from '../../web/core.js';
import { HostApplication } from '../../web/host-app.js';
import { deadline, hostFixture, initialAgent } from '../support/host.mjs';

function application() {
  const store = MC.createStore(), waiters = new Set();
  const app = new HostApplication(store, () => {
    for (const waiter of waiters) if (waiter.predicate()) { waiters.delete(waiter); waiter.resolve(); }
  });
  return {
    app, store,
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
