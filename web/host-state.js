import { OutputBuffer, sourceKey } from './host.js';

export const sessionKey = s => JSON.stringify([s.host_id, s.host_incarnation, s.agent_id, s.session_id]);
export const sessionTarget = s => ({ agent_id: s.agent_id, session_id: s.session_id });
const source = s => Object.fromEntries(['host_id', 'host_incarnation', 'agent_id', 'session_id', 'turn_id', 'load_id', 'response_index', 'tool_call_id'].filter(k => s[k] != null).map(k => [k, s[k]]));
const modelKey = s => 'model:' + s.turn_id + ':' + s.response_index;
const toolKey = s => 'tool:' + s.turn_id + ':' + s.tool_call_id;
const time = value => value == null ? null : Date.parse(value);
export const faultText = value => value?.message || 'Host request failed';
const faultView = fault => fault && ({ title: 'Failed', code: fault.code, type: fault.type, message: fault.message, hint: '' });
export function usageView(usage) {
  return usage && { input: usage.input_tokens, output: usage.output_tokens, cached: usage.cache_read_tokens, reasoning: usage.reasoning_tokens };
}
export function sessionView(info, state, agent) {
  const config = info.config || {}, workspace = config.workspace ?? info.workspace;
  return { ...info, agent_id: info.agent_id, session_id: info.id, title: info.title || '', workspace: workspace?.path || '', model: config.model ?? info.model,
    reasoning: config.reasoning ?? info.reasoning, execution: config.execution, role: config.role, profile: agent?.name || '', config, load_id: state?.load_id,
    allowed: [], usage: null, branch: null, updated_at: info.last_activity_at, live: info.lifecycle !== 'closed',
    status: state ? statusView(state).kind : info.pending_interactions ? 'approval' : info.owned_work?.compaction ? 'compacting' : info.active_turn_id ? 'running' : 'idle',
    unseen: false, current: false };
}
export function statusView(data = {}, turn) {
  const compact = data.compaction && data.compaction.state?.phase !== 'finished';
  const pending = data.pending_interactions || [], busy = !!data.active_turn_id;
  const label = data.block_reason?.message || (pending.length ? 'Needs your answer' : compact ? 'Compacting context' : data.preparing ? 'Preparing' : turn?.phase === 'tools' ? 'Using tools' : busy ? 'Working' : data.scheduling === 'paused' ? 'Paused' : 'Ready');
  return { busy, compacting: !!compact, loading: data.residency === 'loading', interrupting: turn?.state === 'cancelling', label,
    kind: pending.length ? 'approval' : compact ? 'compacting' : busy ? 'running' : 'idle', block_reason: data.block_reason,
    turn_id: data.active_turn_id, operation_id: data.compaction?.source?.kind === 'manual' ? data.compaction.source.operation_id : null,
    started_ms: null, ...(['closing', 'closed'].includes(data.lifecycle) && { label: data.lifecycle }) };
}
export function interactionView(pending, state, tool) {
  if (!pending || !state?.active_turn_id || !state.load_id) return null;
  const request = pending.request, approval = request.kind === 'approval', input = request.request;
  return { id: pending.interaction_id, turn_id: state.active_turn_id, load_id: state.load_id, tool_call_id: pending.tool_call_id,
    kind: approval ? 'approval' : input.answer_kind === 'text' ? 'text' : 'select', tool: pending.name,
    detail: tool?.detail || '', input: tool?.input || '', prompt: approval ? request.prompt : input.prompt,
    options: approval ? ['Allow once', 'Deny'] : input.choices, risk: request.risk };
}
function toolBlock(s, name, arguments_ = {}) {
  const input = typeof arguments_ === 'string' ? arguments_ : arguments_.command || arguments_.patch || arguments_.content || JSON.stringify(arguments_, null, 2);
  const detail = arguments_.path || arguments_.file_path || arguments_.command || arguments_.query || arguments_.url || '';
  return { ...source(s), type: 'tool', name, input, arguments: arguments_, detail, state: 'pending', output: [], output_dropped: 0 };
}
function assistantBlock(s, content, streaming = false) {
  return { ...source(s), type: 'assistant', text: content.filter(p => p.type === 'text').map(p => p.data).join(''),
    reasoning: content.filter(p => p.type === 'reasoning').map(p => p.data.text || p.data.summary || '').join('\n'), streaming };
}
const toolOutcome = result => ['success', 'input_provided'].includes(result.outcome) ? 'completed' : result.outcome === 'cancelled' ? 'cancelled' : result.outcome === 'denied' ? 'denied' : 'failed';
function resultTool(block, result) { const text = result.output.content; return { ...block, state: toolOutcome(result), output: text ? text.split('\n') : [], output_lines: text ? text.split('\n').length : 0, result }; }
const RUNNER_FIELDS = new Set(['runner_revision', 'pending_interactions', 'compaction']);

// Controller and Runner clocks have different scopes. A newer Runner cannot roll back
// controller fields, and an old Load cannot supply the current Runner's interaction.
export function mergeSessionState(current, incoming) {
  if (!current) return structuredClone(incoming);
  const out = { ...current };
  if (incoming.controller_revision >= current.controller_revision) {
    for (const [key, value] of Object.entries(incoming)) if (!RUNNER_FIELDS.has(key)) out[key] = value;
  }
  if (incoming.load_id === out.load_id && (incoming.load_id !== current.load_id || incoming.runner_revision >= current.runner_revision)) {
    for (const key of RUNNER_FIELDS) out[key] = incoming[key];
  } else if (out.load_id !== current.load_id) {
    out.runner_revision = incoming.runner_revision; out.pending_interactions = incoming.pending_interactions; out.compaction = incoming.compaction;
  }
  return out;
}

export class SessionObservation {
  constructor(identity) {
    this.identity = source(identity); this.key = sessionKey(identity); this.state = null; this.info = null;
    this.history = new Map(); this.models = new Map(); this.tools = new Map(); this.turns = new Map(); this.messages = new Map();
    this.outputs = new Map(); this.outputSources = new Map(); this.liveOrder = new Map(); this.ordinal = 0; this.nextCursor = null; this.upperBound = null; this.historyReady = false;
    this.queue = []; this.blocks = []; this.blockCache = new Map(); this.blockIndex = new Map(); this.structureDirty = true; this.dirtyKeys = new Set(); this.recordCache = new Map();
  }
  matches(value) { return this.key === sessionKey(value); }
  stateSnapshot(snapshot) { if (!this.matches(snapshot)) return false; this.state = mergeSessionState(this.state, snapshot.data); return true; }
  buffer(s, channel, end = 0) {
    const key = sourceKey(s) + ':' + channel;
    if (!this.outputs.has(key)) {
      const buffer = new OutputBuffer(source(s), channel, end); this.outputs.set(key, buffer);
      if (!this.outputSources.has(buffer.key)) this.outputSources.set(buffer.key, new Map());
      this.outputSources.get(buffer.key).set(channel, buffer);
    }
    const value = this.outputs.get(key); value.end = Math.max(value.end, end); return value;
  }
  baseline(result) {
    for (const event of result.initial_states) this.event(event);
    for (const position of result.output_positions) if (this.matches(position)) {
      this.buffer(position, position.channel, position.end);
      if (position.kind === 'model' && !this.models.has(modelKey(position))) { this.models.set(modelKey(position), assistantBlock(position, [], true)); this.stampOrder(modelKey(position)); }
    }
  }
  historyPage(snapshot, older = false) {
    if (!this.matches(snapshot)) return false;
    if (older && this.upperBound != null && snapshot.data.upper_bound !== this.upperBound) throw new Error('History page changed its captured upper bound');
    if (!older) { this.historyReady = true; this.upperBound = snapshot.data.upper_bound; }
    for (const item of snapshot.data.items) this.history.set(item.position, item);
    this.structureDirty = true;
    this.nextCursor = snapshot.data.next_cursor;
    return true;
  }
  queueSnapshot(snapshot) {
    if (!this.matches(snapshot) || (this.state && snapshot.controller_revision < this.state.controller_revision)) return false;
    this.queue = [...snapshot.next_step, ...snapshot.next_turn].map(q => ({ id: q.input.message_id, kind: q.queue === 'next-step' ? 'steer' : 'follow', text: q.input.text, order: q.order, input: q.input }));
    return true;
  }
  stampOrder(key) { if (!this.liveOrder.has(key)) { this.liveOrder.set(key, ++this.ordinal); this.structureDirty = true; } this.dirtyKeys.add(key); }
  event(event) {
    if (!this.matches(event)) return false;
    const d = event.data, s = source(event);
    if (['message.bound', 'model.response.finished', 'toolcall.finished', 'turn.finished'].includes(event.kind)) this.structureDirty = true;
    if (event.kind === 'session.state' || event.kind === 'session.closed') return this.stateSnapshot(event);
    if (event.kind === 'turn.state' || event.kind === 'turn.finished') {
      const old = this.turns.get(event.turn_id);
      if (!old || old.load_id !== event.load_id || d.runner_revision >= old.runner_revision) this.turns.set(event.turn_id, { ...s, ...d });
      if (event.kind === 'turn.finished') {
        if (d.history_position != null) this.history.set(d.history_position, { ...d, kind: 'turn_finished', position: d.history_position, turn_id: event.turn_id });
        this.stampOrder('end:' + event.turn_id);
        for (const [key, model] of this.models) if (model.turn_id === event.turn_id) this.models.set(key, { ...model, streaming: false });
      }
    } else if (event.kind === 'message.bound') {
      if (d.history_position != null) this.history.set(d.history_position, { kind: 'user', position: d.history_position, turn_id: event.turn_id, message_id: event.message_id, ...d });
    } else if (event.kind === 'message.accepted') {
      this.messages.set(event.message_id, { ...d, message_id: event.message_id });
    } else if (event.kind === 'model.output.delta') {
      this.buffer(s, d.channel).add(s, d); const key = modelKey(s);
      if (!this.models.has(key)) this.models.set(key, assistantBlock(s, [], true)); this.stampOrder(key);
    } else if (event.kind === 'model.response.finished') {
      this.history.set(d.history_position, { position: d.history_position, recorded_at: d.recorded_at, turn_id: event.turn_id, response_index: event.response_index, kind: 'assistant', response: d.result });
      for (const p of d.output_positions) this.buffer(s, p.channel, p.end).finish(p.end);
    } else if (event.kind === 'toolcall.started') {
      const key = toolKey(s), old = this.tools.get(key);
      this.tools.set(key, { ...toolBlock(s, d.name, d.arguments), ...old, ...s, input: toolBlock(s, d.name, d.arguments).input, detail: toolBlock(s, d.name, d.arguments).detail, state: old?.state || 'running' }); this.stampOrder(key);
    } else if (event.kind === 'toolcall.state') {
      const key = toolKey(s), old = this.tools.get(key);
      if (!old || old.load_id !== s.load_id || d.runner_revision >= (old.runner_revision ?? -1)) this.tools.set(key, { ...toolBlock(s, d.name), ...old, ...s, runner_revision: d.runner_revision, response_index: d.response_index, state: d.state === 'finished' ? (d.outcome === 'success' ? 'completed' : d.outcome || 'finished') : d.state, progress: d.progress });
      this.stampOrder(key);
    } else if (event.kind === 'toolcall.output.delta') {
      this.buffer(s, d.channel).add(s, d); this.stampOrder(toolKey(s));
    } else if (event.kind === 'toolcall.finished') {
      const key = toolKey(s), old = this.tools.get(key);
      if (old) this.tools.set(key, resultTool(old, d.result));
      this.history.set(d.history_position, { position: d.history_position, recorded_at: d.recorded_at, turn_id: event.turn_id, kind: 'tool_result', tool_call_id: event.tool_call_id, name: old?.name || '', result: d.result });
      for (const p of d.output_positions) this.buffer(s, p.channel, p.end).finish(p.end);
    }
    return true;
  }
  toolSnapshot(snapshot) {
    if (!this.matches(snapshot)) return false;
    const key = toolKey(snapshot), old = this.tools.get(key), d = snapshot.data;
    if (old && old.load_id === snapshot.load_id && old.runner_revision > d.runner_revision) return false;
    let block = { ...toolBlock(snapshot, d.name, d.arguments), ...d, ...source(snapshot) };
    if (d.result) block = resultTool(block, d.result);
    this.tools.set(key, block); this.stampOrder(key); return true;
  }
  outputBlock(key, original) {
    const native = original.type === 'tool' ? this.tools.get(key) : this.models.get(key);
    let block = native ? { ...original, ...native } : original;
    const matching = [...(this.outputSources.get(sourceKey(block))?.values() || [])];
    for (const buffer of matching) {
      if (block.type === 'assistant') {
        if (buffer.channel === 'text') block = { ...block, text: buffer.text };
        else if (buffer.channel === 'reasoning') block = { ...block, reasoning: buffer.text };
      }
      if (buffer.fault) block = { ...block, recovery: { status: 'unavailable', reason: faultText(buffer.fault) } };
    }
    if (block.type === 'tool' && !block.result && matching.length) {
      const text = matching.map(buffer => matching.length > 1 ? '[' + buffer.channel + ']\n' + buffer.text : buffer.text).join('\n');
      if (text !== block.output_text) block = { ...block, output_text: text, output: text ? text.split('\n') : [], truncated: matching.some(b => b.position < b.end) };
    }
    return block;
  }
  render() {
    // Output/state notifications normally touch one existing live row. Stable history,
    // its ordering, token trees and DOM anchors are not traversed for each delta.
    if (!this.structureDirty) {
      const dirty = [];
      for (const key of this.dirtyKeys) {
        const index = this.blockIndex.get(key);
        if (index == null) continue;
        const before = this.blocks[index];
        if (this.canonicalKeys?.has(key) && before.type === 'assistant') continue;
        const after = this.outputBlock(key, before);
        if (!sameBlock(before, after)) { this.blocks[index] = after; dirty.push(index); }
      }
      this.dirtyKeys.clear(); return { blocks: this.blocks, dirty };
    }

    const list = [], used = new Set(), toolAt = new Map();
    const add = (key, block) => { used.add(key); list.push([key, block]); return list.length - 1; };
    for (const record of [...this.history.values()].sort((a, b) => a.position - b.position)) {
      const s = { ...this.identity, ...source(record) }, common = { ...s, history_position: record.position, at: time(record.received_at || record.recorded_at) };
      if (record.kind === 'user') add('history:' + record.position, { ...common, type: 'user', text: record.text, kind: record.mode === 'steer' ? 'steering' : 'message', message_id: record.message_id });
      else if (record.kind === 'assistant' || record.kind === 'partial') {
        const response = record.response || record.partial, key = s.turn_id != null && s.response_index != null ? modelKey(s) : 'history:' + record.position;
        let cached = this.recordCache.get(record.position);
        if (!cached || cached.record !== record) { cached = { record, block: { ...assistantBlock(common, response.content), ...common, usage: usageView(response.usage), partial: record.kind === 'partial' } }; this.recordCache.set(record.position, cached); }
        add(key, cached.block);
        for (const p of response.content) if (p.type === 'tool_call') {
          const call = p.data, ts = { ...s, tool_call_id: call.tool_call_id }, tk = toolKey(ts);
          toolAt.set(tk, add(tk, { ...toolBlock(ts, call.name, call.arguments), ...this.tools.get(tk) }));
        }
      } else if (record.kind === 'tool_result') {
        const key = toolKey(record), at = toolAt.get(key), block = resultTool(at == null ? toolBlock({ ...s, tool_call_id: record.tool_call_id }, record.name) : list[at][1], record.result);
        if (at == null) toolAt.set(key, add(key, { ...block, history_position: record.position })); else list[at][1] = { ...block, history_position: record.position };
      } else if (record.kind === 'turn_finished') {
        const turn = this.turns.get(record.turn_id), fault = turn?.fault;
        add('end:' + record.turn_id, { ...common, type: 'turn_end', finished_at: record.finished_at, outcome: record.outcome, failure: faultView(fault), reason: record.reason, saving: turn?.persistence });
      } else if (record.kind === 'summary' || record.kind === 'compaction') add('history:' + record.position, { ...common, type: 'compaction', summary: record.text });
    }
    this.canonicalKeys = new Set(used);
    const live = [...this.models].map(([key, block]) => [key, { ...block }]).concat([...this.tools].map(([key, block]) => [key, { ...block }]));
    for (const [key, block] of live.sort((a, b) => (this.liveOrder.get(a[0]) || 0) - (this.liveOrder.get(b[0]) || 0))) {
      if (used.has(key)) continue;
      add(key, this.outputBlock(key, block));
    }
    for (const [turn_id, turn] of this.turns) if (turn.state === 'finished' && !used.has('end:' + turn_id)) add('end:' + turn_id, { ...source(turn), type: 'turn_end', finished_at: turn.finished_at, outcome: turn.outcome, failure: faultView(turn.fault), saving: turn.persistence });
    if (this.nextCursor) list.unshift(['earlier', { type: 'earlier', hidden_items: null }]);
    const dirty = [], nextCache = new Map();
    const blocks = list.map(([key, block], index) => {
      const cached = this.blockCache.get(key);
      const value = cached && sameBlock(cached.block, block) ? cached.block : block;
      if (value !== this.blocks[index]) dirty.push(index);
      nextCache.set(key, { block: value }); return value;
    });
    this.blockCache = nextCache; this.blocks = blocks; this.blockIndex = new Map(list.map(([key], index) => [key, index])); this.structureDirty = false; this.dirtyKeys.clear();
    return { blocks, dirty };
  }
}

function sameBlock(a, b) {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every(key => a[key] === b[key] || (key === 'output' && a.output_text != null && a.output_text === b.output_text));
}
