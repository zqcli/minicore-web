// The browser's one authenticated Host connection. Business IDs never double as RPC IDs.
export const DEFAULT_TIMEOUT = 30_000;
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
export function newId(random = globalThis.crypto) {
  if (!random?.getRandomValues) throw new Error('Secure random IDs are unavailable');
  const bytes = random.getRandomValues(new Uint8Array(20));
  return Array.from(bytes, value => ALPHABET[value & 31]).join('');
}
export class HostError extends Error {
  constructor(kind, message, detail = {}) { super(message); this.name = 'HostError'; this.kind = kind; Object.assign(this, detail); }
}
export function endpoint(value) {
  const url = new URL(value);
  if (url.protocol !== 'wss:' || url.username || url.password || url.hash || url.search) throw new Error('Host URL must be a wss:// address without credentials, query, or fragment');
  return url.href;
}
export const accessKeyName = url => 'minicore.access:' + endpoint(url);
export async function loadConfig(fetcher = globalThis.fetch) {
  const response = await fetcher('./config.json', { cache: 'no-store', credentials: 'same-origin' });
  if (!response.ok) throw new Error('Could not load config.json');
  const config = await response.json();
  if (typeof config.host_url !== 'string') throw new Error('config.json requires host_url');
  if (config.access_key != null) throw new Error('Access keys must not be stored in public config.json');
  config.host_url = endpoint(config.host_url);
  config.templates ??= [];
  if (!Array.isArray(config.templates) || config.templates.some(t => !t || typeof t.name !== 'string' || typeof t.text !== 'string')) throw new Error('templates must contain name and text strings');
  return config;
}

export class HostConnection {
  constructor(url, { WebSocket = globalThis.WebSocket, timeout = DEFAULT_TIMEOUT, onClose = () => {} } = {}) {
    this.url = endpoint(url); this.WebSocket = WebSocket; this.timeout = timeout; this.onClose = onClose;
    this.pending = new Map(); this.streams = new Map(); this.early = new Map(); this.abandoned = new Set();
    this.serial = 0; this.setups = 0; this.info = null; this.socket = null; this.closed = false;
  }
  get online() { return !!this.info && this.socket?.readyState === 1 && !this.closed; }
  async connect(accessKey) {
    if (this.socket) throw new HostError('protocol', 'This connection has already been initialized');
    const began = performance.now();
    const socket = this.socket = new this.WebSocket(this.url);
    socket.onmessage = event => this.receive(event.data);
    socket.onclose = () => this.end(new HostError('connection', 'Connection lost'));
    socket.onerror = () => this.end(new HostError('connection', 'Could not connect to Host'));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new HostError('timeout', 'Host connection timed out')); this.close(); }, this.timeout);
      this.openReject = error => { clearTimeout(timer); reject(error); };
      socket.onopen = () => { clearTimeout(timer); this.openReject = null; resolve(); };
    });
    try {
      const info = await this.call('initialize', { access_key: accessKey }, { timeout: Math.max(1, Math.ceil(this.timeout - (performance.now() - began))) });
      if (typeof info?.host_id !== 'string' || typeof info?.host_incarnation !== 'string' || typeof info?.can_operate !== 'boolean') throw new HostError('protocol', 'Invalid Host initialization result');
      this.info = info;
      return info;
    } catch (error) { this.close(); throw error; }
  }
  call(method, params = {}, { timeout = this.timeout } = {}) {
    if (!Number.isSafeInteger(timeout) || timeout <= 0) return Promise.reject(new HostError('protocol', 'Call timeout must be positive integer milliseconds'));
    if (this.closed || this.socket?.readyState !== 1) return Promise.reject(new HostError('connection', 'Not connected'));
    if (method !== 'initialize' && !this.info) return Promise.reject(new HostError('protocol', 'Host connection is not initialized'));
    const id = 'rpc-' + ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (method === 'events.subscribe') this.abandoned.add(id);
        reject(new HostError('timeout', 'Host call timed out; accepted work may still continue', { method, sent: true }));
      }, timeout);
      const pending = { resolve, reject, timer, method };
      this.pending.set(id, pending);
      try { this.socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new HostError('connection', 'Request could not be sent', { sent: false })); }
    });
  }
  receive(raw) {
    let frame;
    try { frame = JSON.parse(raw); } catch { this.end(new HostError('protocol', 'Host sent invalid JSON')); this.socket?.close(); return; }
    if (!frame || Array.isArray(frame) || frame.jsonrpc !== '2.0') { this.end(new HostError('protocol', 'Invalid Host JSON-RPC frame')); this.socket?.close(); return; }
    if (Object.hasOwn(frame, 'id')) {
      const pending = this.pending.get(frame.id);
      if (!pending) {
        if (this.abandoned.delete(frame.id) && frame.result?.subscription_id) this.call('events.unsubscribe', { subscription_id: frame.result.subscription_id }).catch(() => {});
        return;
      }
      this.pending.delete(frame.id); clearTimeout(pending.timer);
      if (frame.error) {
        const fault = frame.error.data;
        pending.reject(new HostError(frame.error.code === -32000 ? 'business' : 'protocol', fault?.message || frame.error.message || 'Host request failed', { fault, code: frame.error.code, method: pending.method, sent: true }));
      } else if (Object.hasOwn(frame, 'result')) pending.resolve(frame.result);
      else pending.reject(new HostError('protocol', 'Host response has no result or error', { sent: true }));
      return;
    }
    if (frame.method !== 'events.push' && frame.method !== 'events.resync_required') return;
    const id = frame.params?.subscription_id;
    if (typeof id !== 'string') return;
    const stream = this.streams.get(id);
    if (stream) this.deliver(stream, frame);
    else if (this.setups) {
      if (!this.early.has(id)) this.early.set(id, []);
      this.early.get(id).push(frame);
    }
  }
  deliver(stream, frame) {
    if (stream.ended) return;
    if (frame.method === 'events.resync_required') {
      stream.ended = true; this.streams.delete(stream.id); stream.onResync(frame.params.fault);
    } else stream.onEvent(frame.params.event);
  }
  async subscribe(request, { onEvent = () => {}, onResync = () => {}, onBaseline = () => {} } = {}) {
    this.setups++;
    try {
      const result = await this.call('events.subscribe', request);
      const stream = { id: result.subscription_id, ended: false, onEvent, onResync, result };
      this.streams.set(stream.id, stream);
      // Install the baseline before draining early events, including early resync.
      onBaseline(result);
      const early = this.early.get(stream.id) || []; this.early.delete(stream.id);
      for (const frame of early) this.deliver(stream, frame);
      stream.close = async () => {
        if (stream.ended) return { ended: false };
        stream.ended = true; this.streams.delete(stream.id);
        return this.call('events.unsubscribe', { subscription_id: stream.id });
      };
      return stream;
    } finally { if (!--this.setups) this.early.clear(); }
  }
  end(error) {
    if (this.closed) return;
    this.closed = true; this.info = null; this.openReject?.(error); this.openReject = null;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new HostError(error.kind, error.message, { sent: true })); }
    this.pending.clear();
    for (const stream of this.streams.values()) stream.ended = true;
    this.streams.clear(); this.early.clear(); this.abandoned.clear(); this.onClose(error);
  }
  close() { this.end(new HostError('connection', 'Connection closed')); this.socket?.close(); }
}

export const sourceKey = source => JSON.stringify([source.host_id, source.host_incarnation, source.agent_id, source.session_id, source.load_id ?? null, source.turn_id, source.tool_call_id ?? null, source.tool_call_id ? null : source.response_index ?? null]);
const encoder = new TextEncoder();
// One exact source/channel. Pending ranges are retained until the gap is explicitly read.
export class OutputBuffer {
  constructor(source, channel, end = 0) { this.source = { ...source }; this.key = sourceKey(source); this.channel = channel; this.end = end; this.position = 0; this.textValue = ''; this.decoder = new TextDecoder('utf-8', { fatal: true }); this.pieces = []; this.completed = false; this.fault = null; }
  add(source, range) {
    if (sourceKey(source) !== this.key || range.channel !== this.channel) throw new HostError('protocol', 'Output source does not match');
    const bytes = encoder.encode(range.text);
    if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end - range.start !== bytes.length) throw new HostError('protocol', 'Output range is not UTF-8 byte aligned');
    this.end = Math.max(this.end, range.end);
    if (range.end <= this.position) return false;
    this.pieces.push({ start: range.start, bytes }); this.pieces.sort((a, b) => a.start - b.start);
    let changed = false;
    while (this.pieces.length && this.pieces[0].start <= this.position) {
      const piece = this.pieces.shift(), overlap = this.position - piece.start;
      if (overlap >= piece.bytes.length) continue;
      const suffix = piece.bytes.subarray(overlap);
      this.textValue += this.decoder.decode(suffix, { stream: true }); this.position += suffix.length; changed = true;
    }
    return changed;
  }
  finish(end) { this.end = Math.max(this.end, end); this.completed = true; }
  get text() { return this.textValue; }
  get complete() { return this.completed && this.position >= this.end; }
  nextRead(max_bytes = 65536) {
    if (this.position >= this.end || this.fault) return null;
    return { channel: this.channel, start: this.position, end: this.pieces.length ? Math.min(this.end, this.pieces[0].start) : this.end, max_bytes };
  }
}
