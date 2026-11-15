import assert from 'node:assert/strict';
import test from 'node:test';
import * as MC from '../web/core.js';
import { HostError } from '../web/host.js';
import { HostApplication } from '../web/host-app.js';
import { SessionObservation } from '../web/host-state.js';

// Explicit scripted RPC/event boundaries exercise client interleavings. These
// tests do not claim a live Host, provider, browser, or reordered Host stream.
const host = { host_id: 'host', host_incarnation: 'incarnation' };
const identity = { ...host, agent_id: 'agent', session_id: 'a' };
const config = { role: { name: 'Assistant', description: '', instructions: '' }, session_defaults: { model: 'fixture', reasoning: 'auto', tools: [], execution: { approval: 'ask' } } };
const summary = (id, patch = {}) => ({ id, agent_id: 'agent', title: 'Original ' + id, config_revision: 1,
  workspace: { path: '/workspace' }, model: 'fixture', reasoning: 'auto', lifecycle: 'open', mode: 'memory', residency: 'loaded', scheduling: 'auto',
  active_turn_id: null, pending_interactions: 0, owned_work: {}, last_activity_at: '2026-11-16T00:00:00Z', ...patch });
const catalog = rows => ({ items: [{ id: 'agent', host_id: 'host', name: 'Agent', config_revision: 1, sessions: rows }] });
const state = (patch = {}) => ({ controller_revision: 10, runner_revision: 20, load_id: 'load', lifecycle: 'open', mode: 'memory', residency: 'loaded', scheduling: 'auto',
  pause_reasons: [], active_turn_id: null, pending_interactions: [], compaction: null, next_step: [], next_turn: [], preparing: false, saving: false, owned_work: {},
  metadata_saving: false, metadata_fault: null, deletion: null, block_reason: null, last_result: null, end_reason: null, ...patch });
const event = (patch = {}, target = identity) => ({ ...target, kind: 'session.state', data: state(patch) });
const info = (id = 'a', patch = {}) => ({ id, agent_id: 'agent', title: 'Original ' + id, config_revision: 1, last_activity_at: '2026-11-16T00:00:00Z',
  config: { model: 'fixture', reasoning: 'auto', workspace: { path: '/workspace' }, execution: { approval: 'ask' }, tools: [] }, ...patch });
const tick = () => new Promise(resolve => setImmediate(resolve));

function setup(reply, rows = [summary('a'), summary('b')]) {
  const store = MC.createStore(), notices = [], calls = [];
  store.state = { host, agents: [], sessions: [], session: null, selected_agent_id: 'agent', agent: { id: 'agent', config }, can_operate: true,
    queue: [], status: {}, background: {}, draft: { agent_id: 'agent', workspace: '/workspace', overrides: {} } };
  const app = new HostApplication(store, (_, fx) => { if (fx.notice) notices.push(fx.notice); });
  const client = { online: true, info: { ...host, can_operate: true }, call(method, params = {}) {
    calls.push({ method, params });
    if (method === 'input.list') return Promise.resolve({ ...identity, session_id: params.target.session_id, controller_revision: 100, next_step: [], next_turn: [] });
    return reply(method, params, calls.filter(call => call.method === method).length);
  } };
  app.client = client; app.config = { templates: [] }; app.installAgents(catalog(rows).items);
  return { app, client, store, notices, calls };
}
function foreground(app, store, target = identity) {
  const obs = app.observation = new SessionObservation(target);
  obs.info = info(target.session_id); obs.state = state();
  store.sid = target.session_id; store.state.session = { ...store.state.sessions.find(row => row.id === target.session_id), ...target };
  app.project(); return obs;
}
function emptyClient(identity_ = host, reply = () => ({ items: [] })) {
  return { online: true, info: { ...identity_, can_operate: true },
    async call(method) {
      if (method === 'host.info') return { ...identity_, version: 'fixture' };
      if (method === 'agent.list') return reply();
      if (method === 'model.list' || method === 'tool.list') return [];
      throw new Error('Unexpected initialization method: ' + method);
    },
    async subscribe() { return { ended: false, async close() {} }; },
  };
}

test('catalog callers share one read and await demand received during that read', async () => {
  const first = Promise.withResolvers(), second = Promise.withResolvers();
  const { app, store, calls } = setup((method, _params, count) => {
    assert.equal(method, 'agent.list'); return count === 1 ? first.promise : second.promise;
  });
  const earlier = app.refreshAgents(); await tick();
  const later = app.refreshAgents();
  assert.equal(earlier, later); assert.equal(calls.length, 1);
  first.resolve(catalog([summary('a', { title: 'Older snapshot' }), summary('b')])); await tick();
  assert.equal(calls.length, 2);
  assert.equal(store.state.sessions[0].title, 'Original a', 'superseded snapshot is not installed while a newer read is required');
  second.resolve(catalog([summary('a', { title: 'Committed title', config_revision: 2 }), summary('b')]));
  const result = await earlier; assert.equal(await later, result);
  assert.equal(store.state.sessions[0].title, 'Committed title'); assert.equal(store.state.sessions[0].config_revision, 2);
  assert.equal(app.work.has('catalog'), false);
});

test('an unknown Session during a catalog read requests a second snapshot and retains its native state', async () => {
  const gate = Promise.withResolvers();
  const { app, store, calls } = setup((method, _params, count) => {
    assert.equal(method, 'agent.list');
    return count === 1 ? gate.promise : Promise.resolve(catalog(['a', 'b', 'c', 'd'].map(id => summary(id))));
  });
  app.hostEvent(event({}, { ...identity, session_id: 'c' })); await tick();
  const pending = [{ interaction_id: 'approval', tool_call_id: 'tool', name: 'fixture-tool', request: { kind: 'approval', prompt: 'Proceed?' } }];
  app.hostEvent(event({ active_turn_id: 'turn-d', pending_interactions: pending }, { ...identity, session_id: 'd' }));
  const read = app.work.get('catalog');
  gate.resolve(catalog(['a', 'b', 'c'].map(id => summary(id)))); await read;
  assert.equal(calls.length, 2); assert.deepEqual(store.state.sessions.map(row => row.id), ['a', 'b', 'c', 'd']);
  const row = store.state.sessions.find(row => row.id === 'd');
  assert.equal(row.status, 'approval'); assert.deepEqual(row.state.pending_interactions, pending); assert.equal(store.state.background.approval, 1);
});

test('a refresh arriving as the prior read settles starts a new flight', async () => {
  const gate = Promise.withResolvers();
  const { app, store, calls } = setup((_method, _params, count) => count === 1 ? gate.promise : Promise.resolve(catalog([summary('a', { title: 'Next snapshot', config_revision: 2 })])));
  const first = app.refreshAgents(); await tick();
  let next;
  gate.resolve(catalog([summary('a')]));
  queueMicrotask(() => { next = app.refreshAgents(); });
  await first; await next;
  assert.notEqual(first, next); assert.equal(calls.length, 2); assert.equal(store.state.sessions[0].title, 'Next snapshot');
});

test('an older catalog cannot replace observed running or approval state in either view', async () => {
  const gate = Promise.withResolvers(), { app, store } = setup(method => {
    assert.equal(method, 'agent.list'); return gate.promise;
  });
  foreground(app, store);
  const read = app.refreshAgents(); await tick();
  const pending = [{ interaction_id: 'approval', tool_call_id: 'tool', name: 'fixture-tool', request: { kind: 'approval', prompt: 'Proceed?' } }];
  app.event(event({ active_turn_id: 'turn-a', pending_interactions: pending }));
  app.hostEvent(event({ active_turn_id: 'turn-b' }, { ...identity, session_id: 'b' }));
  gate.resolve(catalog([summary('a'), summary('b')])); await read;
  assert.equal(store.state.status.kind, 'approval'); assert.equal(store.state.session.state.active_turn_id, 'turn-a');
  assert.equal(store.state.sessions[0].status, 'approval'); assert.deepEqual(store.state.sessions[0].state.pending_interactions, pending);
  assert.equal(store.state.sessions[1].status, 'running'); assert.equal(store.state.background.running, 1);
  app.newDraft('/other', 'agent');
  assert.equal(store.state.sessions[0].status, 'approval'); assert.equal(store.state.background.approval, 1);
  assert.equal(store.state.sessions[1].state.active_turn_id, 'turn-b');
});

test('committed metadata read during an older catalog request cannot roll back', async () => {
  const gate = Promise.withResolvers();
  const newer = info('a', { title: 'Renamed 中文🙂', config_revision: 2, config: { model: 'new-model', reasoning: 'high', workspace: { path: '/new-workspace' } } });
  const { app, store } = setup(method => {
    if (method === 'agent.list') return gate.promise;
    assert.equal(method, 'session.get'); return Promise.resolve(newer);
  });
  const obs = foreground(app, store), read = app.refreshAgents(); await tick();
  await app.refreshSession(obs);
  gate.resolve(catalog([summary('a'), summary('b')])); await read; app.project();
  for (const row of [store.state.session, store.state.sessions[0]]) {
    assert.equal(row.title, newer.title); assert.equal(row.config_revision, 2); assert.equal(row.workspace, '/new-workspace'); assert.equal(row.model, 'new-model');
  }
});

test('an older session metadata response cannot overwrite a later committed read', async () => {
  const old = Promise.withResolvers(), fresh = Promise.withResolvers();
  const { app, store } = setup((method, _params, count) => {
    assert.equal(method, 'session.get'); return count === 1 ? old.promise : fresh.promise;
  });
  const obs = foreground(app, store), first = app.refreshSession(obs), second = app.refreshSession(obs);
  fresh.resolve(info('a', { title: 'Newest', config_revision: 3 })); await second;
  old.resolve(info('a', { title: 'Earlier', config_revision: 2 })); await first;
  assert.equal(obs.info.config_revision, 3); assert.equal(store.state.session.title, 'Newest'); assert.equal(store.state.sessions[0].title, 'Newest');
});

test('a delayed catalog does not resurrect an owner-deleted Session or leave the unrelated view', async () => {
  const gate = Promise.withResolvers(), { app, store } = setup(() => gate.promise);
  foreground(app, store, { ...identity, session_id: 'b' });
  const read = app.refreshAgents(); await tick();
  app.hostEvent(event({ controller_revision: 11, runner_revision: 21, lifecycle: 'closed', deletion: { operation_id: 'delete-a', data: { status: 'deleted' } } }));
  assert.deepEqual(store.state.sessions.map(row => row.id), ['b']);
  gate.resolve(catalog([summary('a'), summary('b')])); await read;
  assert.deepEqual(store.state.sessions.map(row => row.id), ['b']); assert.equal(store.state.session.id, 'b'); assert.equal(store.sid, 'b');
  app.hostEvent(event({ controller_revision: 10, runner_revision: 20 }));
  assert.deepEqual(store.state.sessions.map(row => row.id), ['b'], 'an older owner snapshot cannot undo confirmed deletion');
});

test('a previous connection cannot install a catalog or clear the replacement read', async () => {
  const old = Promise.withResolvers(), fresh = Promise.withResolvers();
  const { app, store } = setup(() => old.promise);
  app.hostEvent(event({ active_turn_id: 'old-turn' }));
  const first = app.refreshAgents(); await tick();
  const replacement = emptyClient(host, () => fresh.promise), initialize = app.initialize(replacement, { templates: [] }); await tick();
  const replacementRead = app.work.get('catalog');
  assert.equal(app.sessionStates.size, 0); assert.equal(app.observation, null);
  old.resolve(catalog([summary('a', { title: 'Stale connection' })])); await first;
  assert.equal(app.work.get('catalog'), replacementRead); assert.equal(app.catalog.client, replacement);
  assert.notEqual(store.state.sessions[0].title, 'Stale connection');
  fresh.resolve({ items: [] }); await initialize;
  assert.deepEqual(store.state.sessions, []); assert.equal(app.work.has('catalog'), false);
});

test('a late recovery subscription cannot publish into or replace a newer connection', async () => {
  const gate = Promise.withResolvers(), { app, client, store } = setup(() => { throw new Error('Unexpected RPC'); });
  let handlers, closed = false;
  client.subscribe = async (_request, callbacks) => { handlers = callbacks; return gate.promise; };
  app.hostStream = { ended: true };
  const recovering = app.recover(), replacementStream = { ended: false };
  app.client = emptyClient(); app.hostStream = replacementStream;
  handlers.onEvent(event({ active_turn_id: 'old-connection-turn' }));
  gate.resolve({ async close() { closed = true; } }); await recovering;
  assert.equal(closed, true); assert.equal(app.hostStream, replacementStream); assert.equal(store.state.sessions[0].status, 'idle');
});

test('a catalog read failure only follows up when another read was requested', async () => {
  const failed = Promise.withResolvers();
  const { app, store, calls } = setup((method, _params, count) => {
    assert.equal(method, 'agent.list'); return count === 1 ? failed.promise : Promise.resolve(catalog([summary('a', { title: 'Fresh after demand' })]));
  });
  const first = app.refreshAgents(); await tick(); const second = app.refreshAgents();
  failed.reject(new HostError('timeout', 'First observation timed out')); await second; await first;
  assert.equal(calls.length, 2); assert.equal(store.state.sessions[0].title, 'Fresh after demand');

  const fault = { type: 'SESSION_NOT_FOUND', code: 3601, message: 'Catalog unavailable\n中文🙂' };
  const another = setup(async () => { throw new HostError('business', fault.message, { fault }); });
  await assert.rejects(another.app.requestCatalog(), /Catalog unavailable/); await tick();
  assert.equal(another.calls.length, 1); assert.equal(another.notices.length, 1); assert.deepEqual(another.notices[0].fault, fault);
  assert.deepEqual(another.notices[0].target, host);
  await assert.rejects(another.app.requestCatalog(), /Catalog unavailable/); await tick();
  assert.equal(another.calls.length, 2); assert.equal(another.notices.length, 2);
});

test('accepted manual compaction reports its actual failed operation once after navigating away', async () => {
  const fault = { type: 'SESSION_COMPACTION_FAILED', code: 3702, message: 'Provider rejected compaction\n完整原因🙂',
    details: { http_status: 429, provider_type: 'quota', provider_code: 'limit', request_id: 'native-request' } };
  const { app, store, notices, calls } = setup(async (method, params) => {
    assert.equal(method, 'session.compact');
    return { ...identity, kind: method, operation_id: params.operation_id, result: { state: { phase: 'preparing' }, controller_revision: 10, cancellation_requested: false } };
  });
  foreground(app, store);
  const operation = MC.intent(store, MC.intents.compact()), result = await app.execute(operation);
  assert.equal(result.receipt.result.state.phase, 'preparing'); assert.equal(notices.length, 0);
  app.newDraft('/elsewhere', 'agent'); foreground(app, store, { ...identity, session_id: 'b' });
  const source = { kind: 'manual', operation_id: result.receipt.operation_id };
  app.hostEvent(event({ compaction: { source, state: { phase: 'summarizing' } } }));
  const finished = event({ controller_revision: 11, runner_revision: 21, compaction: { source, state: { phase: 'finished', result: { outcome: 'failed', fault } } } });
  app.hostEvent(finished); app.hostEvent(finished); app.observeSessionState(finished);
  assert.equal(notices.length, 1); assert.deepEqual(notices[0].target, identity);
  assert.deepEqual(notices[0].operation, operation.operation); assert.deepEqual(notices[0].fault, fault); assert.ok(notices[0].text.includes(fault.message));
  assert.equal(store.state.session.id, 'b'); assert.equal(store.state.sessions.find(row => row.id === 'a').status, 'idle');
  assert.equal(calls.filter(call => call.method === 'session.compact').length, 1, 'observing a failure does not retry the business write');
});

test('manual compaction outcome distinguishes successful, unchanged, cancelled, automatic and separate failed operations', () => {
  const { app, notices } = setup(() => { throw new Error('Unexpected RPC'); });
  const fault = { type: 'SESSION_COMPACTION_FAILED', code: 3702, message: 'Actual failure' };
  let revision = 10;
  for (const outcome of ['compacted', 'unchanged', 'cancelled']) {
    const result = outcome === 'compacted' ? { outcome, change: { source_position: 8, covered_items: 4, before_tokens: 100, after_tokens: 50 }, persistence: 'not_applicable' } : { outcome };
    app.hostEvent(event({ controller_revision: revision, runner_revision: revision++, compaction: { source: { kind: 'manual', operation_id: outcome }, state: { phase: 'finished', result } } }));
  }
  app.hostEvent(event({ controller_revision: revision, runner_revision: revision++, compaction: { source: { kind: 'automatic', turn_id: 'turn', load_id: 'load', response_index: 0 }, state: { phase: 'finished', result: { outcome: 'failed', fault } } } }));
  assert.equal(notices.length, 0);
  for (const operation_id of ['failed-one', 'failed-two']) {
    const failed = event({ controller_revision: revision, runner_revision: revision++, compaction: { source: { kind: 'manual', operation_id }, state: { phase: 'finished', result: { outcome: 'failed', fault } } } });
    app.hostEvent(failed); app.hostEvent(failed);
  }
  assert.equal(notices.length, 2); assert.deepEqual(notices.map(notice => notice.operation.operation_id), ['failed-one', 'failed-two']);
});

test('a snapshot from an old Load cannot finish or report failure for the current compaction', () => {
  const { app, store, notices } = setup(() => { throw new Error('Unexpected RPC'); });
  const current = { source: { kind: 'manual', operation_id: 'current-operation' }, state: { phase: 'summarizing' } };
  app.hostEvent(event({ controller_revision: 20, runner_revision: 2, load_id: 'new-load', compaction: current }));
  app.hostEvent(event({ controller_revision: 10, runner_revision: 30, load_id: 'old-load', compaction: { source: { kind: 'manual', operation_id: 'old-operation' },
    state: { phase: 'finished', result: { outcome: 'failed', fault: { message: 'Old failure' } } } } }));
  assert.equal(notices.length, 0); assert.equal(store.state.sessions[0].status, 'compacting');
  assert.equal(store.state.sessions[0].state.compaction.source.operation_id, 'current-operation'); assert.equal(store.state.sessions[0].state.load_id, 'new-load');
});

test('manual compaction failure dedupe survives the same incarnation reconnect and resets for a new origin', async () => {
  const { app, notices } = setup(async () => ({ items: [] }));
  const failed = event({ compaction: { source: { kind: 'manual', operation_id: 'operation' }, state: { phase: 'finished', result: { outcome: 'failed', fault: { message: 'Failed once' } } } } });
  app.hostEvent(failed); assert.equal(notices.length, 1);
  await app.initialize(emptyClient(), { templates: [] });
  app.hostEvent(failed); await app.work.get('catalog'); assert.equal(notices.length, 1);
  const nextHost = { ...host, host_incarnation: 'new-incarnation' };
  await app.initialize(emptyClient(nextHost), { templates: [] });
  app.hostEvent(failed); assert.equal(notices.length, 1, 'the old incarnation is ignored');
  app.hostEvent({ ...failed, ...nextHost }); await app.work.get('catalog'); assert.equal(notices.length, 2);
  app.client = null; // The existing sign-out path drops the application client.
  await app.initialize(emptyClient(nextHost), { templates: [] });
  app.hostEvent({ ...failed, ...nextHost }); await app.work.get('catalog'); assert.equal(notices.length, 3);
});

test('Context preserves the actual failed manual compaction cause without inventing diagnostic fields', async () => {
  const native = { block_reason: null, history_save: null, compaction: { source: { kind: 'manual', operation_id: 'operation' },
    state: { phase: 'finished', result: { outcome: 'failed', fault: { message: 'Multiline cause\n中文🙂' } } } } };
  const { app, calls } = setup(async method => {
    assert.equal(method, 'session.context'); return { ...identity, data: native };
  });
  const result = await app.query({ kind: 'context' }, identity);
  assert.equal(result.failure, native.compaction.state.result.fault.message); assert.equal(result.compacting, false); assert.equal(result.native, native);
  assert.deepEqual(result.native.compaction.state.result.fault, { message: 'Multiline cause\n中文🙂' });
  assert.deepEqual(calls[0].params.target, { agent_id: 'agent', session_id: 'a' });
});

test('metadata and deletion failure notices retain their original native target and complete faults', () => {
  const { app, store, notices } = setup(() => { throw new Error('Unexpected RPC'); });
  foreground(app, store, { ...identity, session_id: 'b' });
  const metadata = { type: 'STORE_WRITE', code: 4102, message: 'Metadata failed\n中文🙂', details: { request_id: 'actual-only' } };
  const deletion = { type: 'STORE_DELETE', code: 4103, message: 'Delete failed\npartial removal' };
  const failed = event({ metadata_fault: metadata, deletion: { operation_id: 'actual-delete', data: { status: 'failed', error: deletion } } });
  app.hostEvent(failed); app.hostEvent(failed);
  assert.equal(notices.length, 2); assert.equal(store.state.session.id, 'b');
  for (const notice of notices) assert.deepEqual(notice.target, identity);
  assert.deepEqual(notices[0].fault, metadata); assert.deepEqual(notices[0].operation, { kind: 'session.update' });
  assert.deepEqual(notices[1].fault, deletion); assert.deepEqual(notices[1].operation, { kind: 'session.delete', operation_id: 'actual-delete' });
});

test('an observation failure after a receipt retains actual target and operation without retrying the write', async () => {
  const fault = { type: 'HOST_STOPPING', code: 3201, message: 'Read failed after acceptance\n中文🙂' };
  const { app, store, notices, calls } = setup(async (method, params) => {
    if (method === 'session.update') return { ...identity, kind: method, operation_id: params.operation_id, result: { status: 'saving', config_revision: 2 } };
    assert.equal(method, 'agent.list'); throw new HostError('business', fault.message, { fault });
  });
  store.state.session = { ...store.state.sessions[1] };
  const operation = { spec: { kind: 'rename_session', title: 'New title' }, target: identity, config_revision: 1 };
  const result = await app.execute(operation);
  assert.equal(result.receipt.result.status, 'saving'); assert.equal(notices.length, 1);
  assert.deepEqual(notices[0].target, identity); assert.deepEqual(notices[0].fault, fault); assert.deepEqual(notices[0].operation, operation.operation);
  assert.equal(notices[0].operation.operation_id, calls[0].params.operation_id);
  assert.equal(calls.filter(call => call.method === 'session.update').length, 1); assert.equal(store.state.session.id, 'b');
});

test('a rejected mutation keeps the actual submitted operation identifier and is never retried', async () => {
  const fault = { type: 'CONFIG_CONFLICT', code: 3301, message: 'Actual revision conflict' };
  const { app, calls } = setup(async () => { throw new HostError('business', fault.message, { fault }); });
  const operation = { spec: { kind: 'rename_session', title: 'Attempted title' }, target: identity, config_revision: 1 };
  await assert.rejects(app.execute(operation), /Actual revision conflict/);
  assert.equal(calls.length, 1); assert.equal(calls[0].method, 'session.update');
  assert.deepEqual(operation.operation, { kind: 'session.update', operation_id: calls[0].params.operation_id });
});
