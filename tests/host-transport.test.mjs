import assert from 'node:assert/strict';
import test from 'node:test';
import { HostConnection, OutputBuffer, accessKeyName, endpoint, loadConfig, newId } from '../web/host.js';

class Socket {
  static instances = [];
  constructor() { this.readyState = 0; this.sent = []; Socket.instances.push(this); queueMicrotask(() => { this.readyState = 1; this.onopen?.(); }); }
  send(value) { this.sent.push(JSON.parse(value)); this.onSend?.(this.sent.at(-1)); }
  push(frame) { this.onmessage({ data: JSON.stringify({ jsonrpc: '2.0', ...frame }) }); }
  close() { this.readyState = 3; this.onclose?.(); }
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const identity = { host_id: 'host', host_incarnation: 'incarnation', agent_id: 'agent', session_id: 'session', turn_id: 'turn', load_id: 'load', response_index: 0 };
async function connected(timeout = 1000) {
  const connection = new HostConnection('wss://host.test/ws', { WebSocket: Socket, timeout });
  const promise = connection.connect('private test key'); await tick();
  const socket = Socket.instances.at(-1), initialize = socket.sent[0];
  assert.equal(initialize.method, 'initialize'); assert.deepEqual(initialize.params, { access_key: 'private test key' });
  socket.push({ id: initialize.id, result: { host_id: 'host', host_incarnation: 'incarnation', can_operate: true, control: { occupied: true, revision: 1 } } });
  await promise; return { connection, socket };
}

test('only secure endpoints and endpoint-scoped session keys are accepted', async () => {
  assert.equal(endpoint('wss://host.test:443/ws'), 'wss://host.test/ws');
  for (const url of ['ws://localhost/ws', 'wss://user:secret@host/ws', 'wss://host/ws?key=secret', 'wss://host/ws#secret']) assert.throws(() => endpoint(url));
  assert.notEqual(accessKeyName('wss://a.test'), accessKeyName('wss://b.test'));
  await assert.rejects(loadConfig(async () => ({ ok: true, json: async () => ({ host_url: 'wss://host.test', access_key: 'never public' }) })), /must not/);
  assert.match(newId(), /^[0123456789abcdefghjkmnpqrstvwxyz]{20}$/);
  assert.equal(new Set(Array.from({ length: 100 }, () => newId())).size, 100);
});

test('concurrent responses, unknown faults and one timed-out call preserve the connection', async t => {
  const { connection, socket } = await connected(); t.after(() => connection.close());
  const first = connection.call('model.list'), second = connection.call('tool.list');
  const [a, b] = socket.sent.slice(-2);
  socket.push({ id: b.id, result: ['tool'] }); socket.push({ id: a.id, result: ['model'] });
  assert.deepEqual(await first, ['model']); assert.deepEqual(await second, ['tool']);
  const denied = connection.call('message.send', {}), call = socket.sent.at(-1);
  const fault = { type: 'FUTURE_UNKNOWN', code: 9999, message: 'Future business rule', details: { retained: ['opaque'] } };
  socket.push({ id: call.id, error: { code: -32000, message: 'Business failure', data: fault } });
  await assert.rejects(denied, error => error.kind === 'business' && JSON.stringify(error.fault) === JSON.stringify(fault));
  const timedOut = connection.call('session.compact', { operation_id: newId() }, { timeout: 5 });
  const late = socket.sent.at(-1);
  await assert.rejects(timedOut, error => error.kind === 'timeout' && error.sent);
  socket.push({ id: late.id, result: { accepted: true } });
  assert.equal(connection.online, true); assert.equal(socket.sent.filter(x => x.method === 'session.compact').length, 1);
  assert.equal(connection.pending.size, 0);
});

test('subscription baseline precedes early events; resync ends only its own stream', async t => {
  const { connection, socket } = await connected(15); t.after(() => connection.close());
  const seen = [];
  const pending = connection.subscribe({ scope: { kind: 'host', host_id: 'host' }, categories: ['state'] }, {
    onBaseline: () => seen.push('baseline'), onEvent: event => seen.push(event.kind), onResync: () => seen.push('resync'),
  });
  const call = socket.sent.at(-1);
  socket.push({ method: 'events.push', params: { subscription_id: 'sub-one', event: { kind: 'host.state' } } });
  socket.push({ method: 'events.resync_required', params: { subscription_id: 'sub-one', fault: { message: 'Lost baseline' } } });
  socket.push({ id: call.id, result: { subscription_id: 'sub-one', initial_states: [], output_positions: [] } });
  const stream = await pending;
  assert.deepEqual(seen, ['baseline', 'host.state', 'resync']); assert.equal(stream.ended, true); assert.equal(connection.online, true);
  const second = connection.subscribe({ scope: { kind: 'host', host_id: 'host' }, categories: ['state'] }, { onEvent: event => seen.push(event.kind) });
  socket.push({ id: socket.sent.at(-1).id, result: { subscription_id: 'sub-two', initial_states: [], output_positions: [] } });
  const active = await second;
  await new Promise(resolve => setTimeout(resolve, 25));
  socket.push({ method: 'events.push', params: { subscription_id: 'sub-two', event: { kind: 'still-live' } } });
  assert.equal(active.ended, false); assert.equal(seen.at(-1), 'still-live');
});

test('late subscribe result cleans up only the abandoned registration', async t => {
  const { connection, socket } = await connected(10); t.after(() => connection.close());
  const setup = connection.subscribe({ scope: { kind: 'host', host_id: 'host' }, categories: ['state'] });
  const request = socket.sent.at(-1);
  await assert.rejects(setup, /timed out/);
  socket.push({ id: request.id, result: { subscription_id: 'late-registration', initial_states: [], output_positions: [] } });
  const cleanup = socket.sent.at(-1);
  assert.equal(cleanup.method, 'events.unsubscribe'); assert.deepEqual(cleanup.params, { subscription_id: 'late-registration' });
  socket.push({ id: cleanup.id, result: { ended: true } });
  assert.equal(connection.online, true);
});

test('UTF-8 output retains gaps, merges overlaps once, and keeps completion separate from content', () => {
  const buffer = new OutputBuffer(identity, 'text', 10);
  buffer.add(identity, { channel: 'text', start: 5, end: 10, text: '中xy' });
  buffer.finish(10);
  assert.equal(buffer.complete, false); assert.deepEqual(buffer.nextRead(3), { channel: 'text', start: 0, end: 5, max_bytes: 3 });
  buffer.add(identity, { channel: 'text', start: 0, end: 5, text: 'a🙂' });
  assert.equal(buffer.text, 'a🙂中xy'); assert.equal(buffer.position, 10); assert.equal(buffer.complete, true);
  buffer.add(identity, { channel: 'text', start: 1, end: 8, text: '🙂中' });
  assert.equal(buffer.text, 'a🙂中xy');
  assert.throws(() => buffer.add({ ...identity, turn_id: 'another' }, { channel: 'text', start: 10, end: 11, text: '!' }), /source/);
  assert.throws(() => buffer.add(identity, { channel: 'text', start: 10, end: 11, text: '🙂' }), /UTF-8/);
  buffer.fault = { message: 'Source reclaimed' }; assert.equal(buffer.text, 'a🙂中xy');
});
