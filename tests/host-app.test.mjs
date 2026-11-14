import assert from 'node:assert/strict';
import test from 'node:test';
import * as MC from '../web/core.js';
import { HostError } from '../web/host.js';
import { HostApplication } from '../web/host-app.js';
import { SessionObservation } from '../web/host-state.js';

const identity = { host_id: 'host', host_incarnation: 'incarnation', agent_id: 'agent', session_id: 'session' };
const config = { role: { name: 'Assistant', description: '', instructions: '' }, session_defaults: { model: 'fixture', reasoning: 'auto', tools: [], execution: { approval: 'ask' } } };
const agent = id => ({ id, name: id, config, config_revision: 1, sessions: [] });
function setup(call) {
  const store = MC.createStore(), effects = [];
  store.state = { host: identity, can_operate: true, selected_agent_id: 'agent', agent: agent('agent'), agents: [agent('agent')], session: { id: 'session', agent_id: 'agent', title: 'Original', workspace: '/original' },
    sessions: [{ id: 'session', agent_id: 'agent', workspace: '/original', updated_at: '2026-11-14T00:00:00Z' }], draft: { agent_id: 'agent', workspace: '/original', overrides: {} }, queue: [], background: {}, status: {} };
  store.sid = 'session';
  const app = new HostApplication(store, (_, fx) => effects.push(fx));
  app.config = { templates: [] };
  const calls = [], client = { info: { ...identity, can_operate: true }, online: true, call(method, params = {}) { calls.push({ method, params }); return call(method, params); } };
  app.client = client;
  return { app, store, effects, client, calls };
}

test('a mutation waiting for metadata stays on its original connection after reconnect', async () => {
  const gate = Promise.withResolvers(); let ended = false;
  const { app, calls } = setup(async method => {
    if (method === 'session.get') return gate.promise;
    if (ended) throw new HostError('connection', 'Original connection closed', { sent: false });
    throw new Error('Unexpected call');
  });
  const update = app.updateSession(identity, { title: 'Captured edit' });
  const newCalls = [];
  app.client = { info: { ...identity }, online: true, call: (...args) => { newCalls.push(args); throw new Error('Retargeted'); } };
  ended = true; gate.resolve({ config_revision: 7 });
  await assert.rejects(update, /Original connection closed/);
  assert.equal(newCalls.length, 0);
  assert.equal(calls.at(-1).method, 'session.update');
  assert.deepEqual(calls.at(-1).params.target, { agent_id: 'agent', session_id: 'session' });
  assert.equal(calls.at(-1).params.expected_config_revision, 7);
});

test('an accepted receipt remains a success when a later observation read fails', async () => {
  const receipt = { kind: 'session.update', ...identity, operation_id: 'operation', result: { status: 'saving', config_revision: 3 } };
  const { app, effects } = setup(async method => {
    if (method === 'session.update') return receipt;
    throw new HostError('timeout', 'Observation timed out');
  });
  const result = await app.updateSession(identity, { title: 'Accepted edit' }, 3);
  assert.equal(result.receipt, receipt);
  assert.ok(effects.some(fx => fx.notice?.text.includes('returned a receipt')));
});

test('a slower earlier Agent selection cannot replace the newer session draft', async () => {
  const a = Promise.withResolvers(), b = Promise.withResolvers();
  const { app, store } = setup((method, params) => {
    assert.equal(method, 'agent.get'); return params.target.agent_id === 'a' ? a.promise : b.promise;
  });
  const older = MC.intent(store, MC.intents.newSession('/workspace-a', 'a'));
  const p1 = app.execute(older);
  const newer = MC.intent(store, MC.intents.newSession('/workspace-b', 'b'));
  const p2 = app.execute(newer);
  b.resolve(agent('b')); await p2;
  a.resolve(agent('a')); await p1;
  assert.equal(store.state.draft.agent_id, 'b'); assert.equal(store.state.draft.workspace, '/workspace-b');
  assert.equal(store.state.selected_agent_id, 'b'); assert.equal(store.state.session, null);
});

test('direct Agent selection cannot overwrite a newer draft for that same Agent', async () => {
  const gate = Promise.withResolvers();
  const { app, store } = setup(() => gate.promise);
  const selecting = app.selectAgent('agent');
  const newer = MC.intent(store, MC.intents.newSession('/newer', 'agent'));
  await app.execute(newer);
  gate.resolve({ ...agent('agent'), config: { ...config, session_defaults: { ...config.session_defaults, workspace: { path: '/default' } } } });
  await selecting;
  assert.equal(store.state.draft.workspace, '/newer');
});

test('late initialization results cannot overwrite a replacement connection state', async () => {
  const gate = Promise.withResolvers(), { app, store, client } = setup(method => method === 'host.info' ? gate.promise : Promise.resolve(method === 'agent.list' ? { items: [] } : []));
  const initializing = app.initialize(client, { templates: [] });
  const replacement = { marker: 'new connection state' }; store.state = replacement; app.client = { info: { host_id: 'another' } };
  gate.resolve({ ...identity, version: 'fixture' }); await initializing;
  assert.equal(store.state, replacement);
});

test('reconnect ignores a deleted prior Agent instead of requesting a nonexistent owner', async () => {
  const { app, store, client, calls } = setup(async method => {
    if (method === 'host.info') return { ...identity, version: 'fixture' };
    if (method === 'agent.list') return { items: [] };
    if (method === 'model.list' || method === 'tool.list') return [];
    throw new Error('Requested deleted Agent');
  });
  client.subscribe = async () => ({ ended: false, close: async () => ({ ended: true }) });
  await app.initialize(client, { templates: [] });
  assert.equal(store.state.selected_agent_id, null); assert.equal(store.state.session, null);
  assert.equal(calls.some(call => call.method === 'agent.get'), false);
});

test('queue removal names the original MessageId without an unrelated controller CAS', async () => {
  const { app, store, calls } = setup(async () => ({ result: { controller_revision: 51 } }));
  const operation = MC.intent(store, MC.intents.unqueue('original-message', true)); operation.controller_revision = 49; operation.queuedText = 'Original text';
  const result = await app.execute(operation);
  assert.equal(result.text, 'Original text'); assert.equal(calls[0].params.message_id, 'original-message');
  assert.equal(Object.hasOwn(calls[0].params, 'expected_controller_revision'), false);
});

test('only the owner-confirmed deletion clears the displayed session', () => {
  const { app, store } = setup(async () => ({}));
  app.hostEvent({ ...identity, kind: 'session.state', data: { controller_revision: 1, lifecycle: 'closing', deletion: { data: { status: 'pending' } } } });
  assert.equal(store.state.session.id, 'session');
  app.hostEvent({ ...identity, kind: 'session.state', data: { controller_revision: 2, lifecycle: 'closed', deletion: { data: { status: 'deleted' } } } });
  assert.equal(store.state.session, null); assert.equal(store.state.draft.workspace, '/original');
  assert.equal(store.state.sessions.length, 0);
});

test('background metadata completion refreshes the catalog and later faults remain visible', async () => {
  const { app, store, effects, calls } = setup(async method => {
    assert.equal(method, 'agent.list');
    return { items: [{ ...agent('agent'), sessions: [{ id: 'session', agent_id: 'agent', title: 'Saved background title', workspace: { path: '/original' }, config_revision: 2, last_activity_at: '2026-11-14T00:00:00Z', lifecycle: 'open' }] }] };
  });
  store.state.session = null; store.sid = null;
  app.hostEvent({ ...identity, kind: 'session.state', data: { controller_revision: 1, metadata_saving: true } });
  app.hostEvent({ ...identity, kind: 'session.state', data: { controller_revision: 2, metadata_saving: false } });
  await app.work.get('catalog');
  assert.equal(calls.filter(call => call.method === 'agent.list').length, 1);
  assert.equal(store.state.sessions[0].title, 'Saved background title');
  assert.equal(store.state.sessions[0].config_revision, 2);
  app.hostEvent({ ...identity, kind: 'session.state', data: { controller_revision: 3, metadata_fault: { type: 'SAVE', code: 1, message: 'Storage is unavailable' }, deletion: { data: { status: 'failed', error: { message: 'Delete failed after partial removal' } } } } });
  assert.ok(effects.some(fx => fx.notice?.text.includes('Storage is unavailable')));
  assert.ok(effects.some(fx => fx.notice?.text.includes('Delete failed after partial removal')));
  const count = effects.filter(fx => fx.notice).length;
  app.hostEvent({ ...identity, kind: 'session.state', data: { controller_revision: 2, metadata_fault: { message: 'Stale failure' } } });
  assert.equal(effects.filter(fx => fx.notice).length, count);
});

test('a tool output query retains its original source and fixed channel boundary across navigation', async () => {
  const detail = Promise.withResolvers(), tool = { ...identity, turn_id: 'turn', load_id: 'load', tool_call_id: 'call' };
  const { app, calls } = setup(async (method, params) => {
    if (method === 'toolcall.get') return detail.promise;
    assert.equal(method, 'toolcall.output.read'); assert.equal(params.request.channel, 'stdout'); assert.equal(params.request.end, 6);
    return { ...tool, data: { channel: 'stdout', start: 0, end: 6, text: 'a🙂b', has_more: false } };
  });
  const observation = app.observation = new SessionObservation(identity);
  observation.buffer(tool, 'stdout', 6);
  const reading = app.query(MC.queries.toolOutput('call', 0, tool), identity);
  app.observation = new SessionObservation({ ...identity, session_id: 'different-session' });
  detail.resolve({ ...tool, data: { result: null } });
  const result = await reading;
  assert.equal(result.text, 'a🙂b'); assert.equal(result.next_offset, 6);
  assert.equal(calls.at(-1).params.target.session_id, 'session');
});
