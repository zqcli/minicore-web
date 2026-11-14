import * as MC from './core.js';
import { HostError, newId, sourceKey } from './host.js';
import { SessionObservation, sessionTarget, sessionView, statusView, interactionView, faultText } from './host-state.js';

const clone = value => value == null ? value : structuredClone(value);
const categories = ['state', 'output', 'completion', 'message', 'interaction'];
const rejected = message => new HostError('business', message);
const EMPTY_STATUS = { busy: false, compacting: false, label: 'Ready', started_ms: null };

// Application commands address captured native owners. This is presentation state,
// not a replicated scheduler; execution is observed only through Host facts.
export class HostApplication {
  constructor(store, emit = () => {}) {
    this.S = store; this.emit = emit; this.client = null; this.config = null; this.observation = null;
    this.stream = null; this.hostStream = null; this.navigation = 0; this.work = new Map(); this.changes = new Map();
  }
  notify(fx = {}, event = null) { MC.syncReply(this.S); this.emit(event, { state: true, ...fx }); }
  get online() { return !!this.client?.online; }
  get operating() { return this.online && !!this.S.state?.can_operate; }
  requireTarget(target, client = this.client) {
    if (target.host_incarnation && target.host_incarnation !== client.info?.host_incarnation || target.host_id && target.host_id !== client.info?.host_id) throw rejected('The original Host incarnation has ended; reopen this session before acting');
    if (!target.agent_id || !target.session_id) throw rejected('Choose a session first');
    return sessionTarget(target);
  }
  async initialize(client, config) {
    this.client = client; this.config = config; this.work.clear();
    const previous = this.S.state?.session;
    const [host, agents, models, tools] = await Promise.all([client.call('host.info'), client.call('agent.list', {}), client.call('model.list'), client.call('tool.list')]);
    if (this.client !== client) return;
    const selected = [this.S.state?.selected_agent_id, previous?.agent_id, agents.items[0]?.id].find(id => agents.items.some(agent => agent.id === id));
    this.S.version = host.version;
    this.S.state = { host, can_operate: client.info.can_operate, agents: agents.items, selected_agent_id: selected || null, agent: null,
      models: models.map(m => ({ ...m, id: m.model, name: m.model, reasoning: m.supported_reasoning })), tools,
      initial_agent: clone(config.initial_agent || null), profiles: [], commands: config.templates.map(t => ({ name: t.name, description: t.description || '', hint: '[args]' })),
      sessions: [], session: null, draft: { agent_id: selected, workspace: '', model: '', reasoning: 'auto', overrides: {} },
      status: { ...EMPTY_STATUS }, queue: [], interaction: null, background: { approval: 0, running: 0 }, observation_error: null };
    this.installAgents(agents.items);
    this.hostStream = await client.subscribe({ scope: { kind: 'host', host_id: host.host_id }, categories: ['state'] }, {
      onBaseline: baseline => { if (this.client === client) for (const event of baseline.initial_states) this.hostEvent(event); },
      onEvent: event => { if (this.client === client) this.hostEvent(event); }, onResync: fault => { if (this.client !== client) return; this.S.state.observation_error = faultText(fault); this.notify({ notice: { level: 'error', text: 'Host observation needs recovery: ' + faultText(fault) } }); },
    });
    if (this.client !== client) return;
    if (selected) await this.selectAgent(selected, false, client);
    if (this.client !== client) return;
    const existing = previous && this.S.state.sessions.find(s => s.id === previous.id && s.agent_id === previous.agent_id);
    const first = existing || this.S.state.sessions.find(s => s.agent_id === selected && s.id === this.S.state.agent?.default_session_id) || this.S.state.sessions[0];
    if (first) await this.openSession({ ...first, session_id: first.id, ...client.info });
    else { this.S.sid = null; this.S.blocks = []; this.notify({ snapshot: true, newSession: true }); }
  }
  installAgents(agents) {
    const state = this.S.state, previous = new Map(state.sessions.map(s => [s.agent_id + ':' + s.id, s]));
    state.agents = agents;
    state.sessions = agents.flatMap(agent => agent.sessions.map(info => ({ ...sessionView(info, null, agent), host_id: state.host.host_id, host_incarnation: state.host.host_incarnation,
      metadata_saving: previous.get(info.agent_id + ':' + info.id)?.metadata_saving, current: state.session?.id === info.id && state.session?.agent_id === info.agent_id, unseen: previous.get(info.agent_id + ':' + info.id)?.unseen || false })));
    this.background();
    if (state.session && !state.sessions.some(row => row.id === state.session.id && row.agent_id === state.session.agent_id)) this.newDraft(state.session.workspace, state.selected_agent_id);
  }
  background() {
    const rows = this.S.state.sessions.filter(s => !s.current);
    this.S.state.background = { approval: rows.filter(s => s.status === 'approval').length, running: rows.filter(s => s.status === 'running').length };
  }
  async refreshAgents(client = this.client) { const result = await client.call('agent.list', {}); if (this.client === client) { this.installAgents(result.items); this.notify(); } return result; }
  async agentDetails(agent_id, client = this.client) {
    const info = await client.call('agent.get', { target: { host_id: client.info.host_id, agent_id } });
    if (this.client === client && this.S.state.selected_agent_id === agent_id) this.S.state.agent = info;
    return info;
  }
  async selectAgent(agent_id, draft = true, client = this.client) {
    if (this.client !== client) return;
    const navigation = draft ? ++this.navigation : this.navigation;
    this.S.state.selected_agent_id = agent_id;
    const info = await this.agentDetails(agent_id, client);
    if (this.client !== client || this.navigation !== navigation || this.S.state.selected_agent_id !== agent_id) return info;
    if (draft) this.newDraft(info.config.session_defaults.workspace?.path || '', agent_id);
    else this.setDraftDefaults(info);
    this.notify(); return info;
  }
  setDraftDefaults(agent) {
    const d = agent.config.session_defaults;
    this.S.state.draft = { agent_id: agent.id, workspace: d.workspace?.path || '', model: d.model, reasoning: d.reasoning, role: clone(agent.config.role), execution: clone(d.execution), tools: clone(d.tools), overrides: {} };
  }
  newDraft(workspace, agent_id) {
    this.navigation++; this.stream?.close().catch(() => {}); this.stream = null; this.observation = null;
    const state = this.S.state, agent = state.agent;
    if (agent && agent.id === agent_id) this.setDraftDefaults(agent);
    state.draft = { ...state.draft, agent_id, workspace: workspace ?? state.draft.workspace, overrides: { ...state.draft.overrides, ...(workspace !== undefined && { workspace: workspace ? { path: workspace } : null }) } };
    state.session = null; state.queue = []; state.interaction = null; state.status = { ...EMPTY_STATUS }; this.S.sid = null; this.S.blocks = [];
    state.sessions = state.sessions.map(s => ({ ...s, current: false })); this.background(); this.notify({ snapshot: true, newSession: true, dirty: [] });
  }
  hostEvent(event) {
    const state = this.S.state;
    if (!state || event.host_id !== state.host.host_id || event.host_incarnation !== state.host.host_incarnation) return;
    if (event.kind === 'host.state') { state.host = { ...state.host, ...event.data }; this.notify({}, event); return; }
    if (event.kind !== 'session.state') return;
    if (['deleted', 'reclaimed'].includes(event.data.deletion?.data?.status)) {
      state.sessions = state.sessions.filter(row => row.id !== event.session_id || row.agent_id !== event.agent_id);
      if (state.session?.id === event.session_id && state.session?.agent_id === event.agent_id) this.newDraft(state.session.workspace, state.selected_agent_id);
      else { this.background(); this.notify({}, event); }
      return;
    }
    const row = state.sessions.find(s => s.agent_id === event.agent_id && s.id === event.session_id);
    const freshController = row?.controller_revision == null || event.data.controller_revision >= row.controller_revision;
    const metadataCommitted = freshController && row?.metadata_saving && !event.data.metadata_saving;
    const metadataFault = event.data.metadata_fault, deletionFault = event.data.deletion?.data?.status === 'failed' && event.data.deletion.data.error;
    const changedFault = (before, after) => after && JSON.stringify(before) !== JSON.stringify(after);
    if (freshController && changedFault(row?.metadata_fault, metadataFault)) this.notify({ notice: { level: 'error', text: 'Session metadata save failed: ' + faultText(metadataFault) } }, event);
    if (freshController && changedFault(row?.deletion?.data?.error, deletionFault)) this.notify({ notice: { level: 'error', text: 'Session deletion failed: ' + faultText(deletionFault) } }, event);
    if (row && (row.controller_revision == null || event.data.controller_revision >= row.controller_revision)) {
      const before = row.status;
      Object.assign(row, { ...event.data, status: statusView(event.data).kind, live: event.data.lifecycle !== 'closed', current: state.session?.id === row.id && state.session?.agent_id === row.agent_id });
      if (before === 'running' && row.status === 'idle' && !row.current) row.unseen = true;
      this.background();
    }
    if (metadataCommitted) this.once('catalog', () => this.refreshAgents());
    if (!row) this.once('catalog', () => this.refreshAgents());
    if (this.observation?.matches(event)) this.event(event);
    else this.notify({}, event);
  }
  once(key, action) {
    if (this.work.has(key)) return this.work.get(key);
    const promise = Promise.resolve().then(action).catch(error => { if (this.online) this.notify({ notice: { level: 'error', text: error.message } }); }).finally(() => { if (this.work.get(key) === promise) this.work.delete(key); });
    this.work.set(key, promise); return promise;
  }
  event(event) {
    const obs = this.observation, wasMetadataSaving = obs?.state?.metadata_saving, previousCompaction = obs?.state?.compaction;
    if (!obs?.event(event)) return;
    this.project(event);
    if (event.kind === 'session.state' && obs.historyReady && event.data.compaction?.state?.phase === 'finished' && previousCompaction?.state?.phase !== 'finished') this.once('history:' + obs.key, () => this.refreshHistory(obs));
    if (/^(session.state|message.accepted|message.bound)$/.test(event.kind)) this.refreshQueue(obs);
    if (event.kind === 'session.state' && !event.data.metadata_saving && wasMetadataSaving) this.once('metadata:' + obs.key, () => this.refreshSession(obs));
    if (event.kind === 'toolcall.state' || event.kind === 'interaction.requested') this.once('tool:' + sourceKey(event), () => this.readTool(event, obs));
    if (/output.delta$/.test(event.kind)) this.repairOutputs(obs, event);
  }
  refreshQueue(obs) {
    const client = this.client;
    obs.queueAgain = true;
    return this.once('queue:' + obs.key, async () => {
      do {
        obs.queueAgain = false;
        const queue = await client.call('input.list', { target: sessionTarget(obs.identity) });
        if (this.client !== client) return;
        obs.queueSnapshot(queue);
        if (obs === this.observation) this.project();
      } while (obs.queueAgain && obs === this.observation && this.online);
    });
  }
  project(event = null) {
    const obs = this.observation;
    if (!obs) return;
    const state = this.S.state, projected = obs.render(); this.S.blocks = projected.blocks;
    if (event && /output.delta$/.test(event.kind)) { this.notify({ dirty: projected.dirty, state: false }, event); return; }
    if (obs.info) state.session = { ...sessionView(obs.info, obs.state, state.agents.find(a => a.id === obs.identity.agent_id)), ...obs.identity, id: obs.identity.session_id, metadata_saving: obs.state?.metadata_saving, metadata_fault: obs.state?.metadata_fault, deletion: obs.state?.deletion };
    state.status = statusView(obs.state, obs.turns.get(obs.state?.active_turn_id)); state.queue = obs.queue;
    const pending = obs.state?.pending_interactions?.[0], tool = pending && [...obs.tools.values()].find(t => t.tool_call_id === pending.tool_call_id && t.turn_id === obs.state.active_turn_id);
    state.interaction = interactionView(pending, obs.state, tool);
    state.sessions = state.sessions.map(s => ({ ...s, current: s.id === obs.identity.session_id && s.agent_id === obs.identity.agent_id })); this.background();
    this.notify({ dirty: projected.dirty }, event);
  }
  async refreshHistory(obs = this.observation, client = this.client) {
    if (!obs) return;
    const page = await client.call('session.history.read', { target: sessionTarget(obs.identity), request: { cursor: null, limit: 120, direction: 'backward' } });
    if (this.client !== client) return;
    obs.historyPage(page);
    if (obs === this.observation) this.project();
  }
  async refreshSession(obs = this.observation, client = this.client) {
    if (!obs) return;
    const info = await client.call('session.get', { target: sessionTarget(obs.identity) });
    if (this.client !== client) return info;
    obs.info = info;
    const row = this.S.state.sessions.find(session => session.id === info.id && session.agent_id === info.agent_id);
    if (row) Object.assign(row, sessionView(info, obs.state, this.S.state.agents.find(agent => agent.id === info.agent_id)), { current: obs === this.observation });
    if (obs === this.observation) this.project(); return obs.info;
  }
  async openSession(target) {
    const client = this.client, ref = this.requireTarget(target, client), token = ++this.navigation;
    const identity = { host_id: client.info.host_id, host_incarnation: client.info.host_incarnation, ...ref };
    const previous = this.stream; this.stream = null; previous?.close().catch(() => {});
    const sameView = this.S.sid === ref.session_id && this.observation?.matches(identity);
    const obs = sameView ? this.observation : new SessionObservation(identity); this.observation = obs;
    this.S.state.session = { ...this.S.state.sessions.find(s => s.id === ref.session_id && s.agent_id === ref.agent_id), ...identity, id: ref.session_id, workspace: '', title: '' };
    this.S.state.selected_agent_id = ref.agent_id;
    this.S.state.status = { ...EMPTY_STATUS, loading: true }; this.S.sid = ref.session_id; this.S.blocks = sameView ? obs.blocks : [];
    this.notify({ newSession: !sameView, snapshot: true, dirty: [] });
    const stream = await client.subscribe({ scope: { kind: 'session', ...ref }, categories }, {
      onBaseline: result => { obs.baseline(result); if (client === this.client && obs === this.observation) this.project(); },
      onEvent: event => { if (client === this.client && obs === this.observation) this.event(event); },
      onResync: fault => { if (client === this.client && obs === this.observation) { this.S.state.observation_error = faultText(fault); this.notify({ notice: { level: 'error', text: 'Session observation ended: ' + faultText(fault) } }); } },
    });
    if (client !== this.client || token !== this.navigation) { await stream.close(); return; }
    this.stream = stream;
    const [info, history, queue, agent] = await Promise.all([
      client.call('session.get', { target: ref }),
      client.call('session.history.read', { target: ref, request: { cursor: null, limit: 120, direction: 'backward' } }),
      client.call('input.list', { target: ref }),
      this.S.state.agent?.id === ref.agent_id ? Promise.resolve(this.S.state.agent) : client.call('agent.get', { target: { host_id: client.info.host_id, agent_id: ref.agent_id } }),
    ]);
    if (client !== this.client || token !== this.navigation) return;
    this.S.state.agent = agent; obs.info = info; obs.historyPage(history); obs.queueSnapshot(queue); this.S.state.selected_agent_id = ref.agent_id;
    this.project(); this.notify({ snapshot: true });
    this.repairOutputs(obs);
    for (const tool of obs.tools.values()) this.once('tool:' + sourceKey(tool), () => this.readTool(tool, obs));
  }
  async recover() {
    if (!this.online) return;
    const s = this.S.state.session;
    if (s && (!this.stream || this.stream.ended)) await this.openSession({ ...s, session_id: s.id });
    if (this.hostStream?.ended) {
      this.hostStream = await this.client.subscribe({ scope: { kind: 'host', host_id: this.S.state.host.host_id }, categories: ['state'] }, { onBaseline: b => b.initial_states.forEach(e => this.hostEvent(e)), onEvent: e => this.hostEvent(e), onResync: f => { this.S.state.observation_error = faultText(f); this.notify(); } });
      await this.refreshAgents();
    }
    this.S.state.observation_error = null; this.notify();
  }
  async readTool(source, obs) {
    const client = this.client;
    const result = await client.call('toolcall.get', { target: sessionTarget(source), tool: { turn_id: source.turn_id, tool_call_id: source.tool_call_id } });
    if (this.client !== client) return;
    obs.toolSnapshot(result); if (obs === this.observation) this.project();
  }
  repairOutputs(obs, changedSource) {
    const client = this.client;
    const buffers = changedSource ? obs.outputSources.get(sourceKey(changedSource))?.values() || [] : obs.outputs.values();
    for (const buffer of buffers) if (buffer.nextRead()) this.once('output:' + buffer.key + ':' + buffer.channel, async () => {
      let request;
      while (this.client === client && this.online && obs === this.observation && (request = buffer.nextRead())) {
        const s = buffer.source;
        try {
          const result = await client.call(s.tool_call_id ? 'toolcall.output.read' : 'turn.output.read', {
            target: sessionTarget(s), ...(s.tool_call_id ? { tool: { turn_id: s.turn_id, tool_call_id: s.tool_call_id } } : { turn_id: s.turn_id, response_index: s.response_index }), request,
          });
          const previous = buffer.position; buffer.add(result, result.data); obs.dirtyKeys.add(s.tool_call_id ? 'tool:' + s.turn_id + ':' + s.tool_call_id : 'model:' + s.turn_id + ':' + s.response_index);
          if (buffer.position === previous) throw new Error('Host output read did not advance');
          this.project();
        } catch (error) { if (this.client !== client || error.kind === 'connection') return; buffer.fault = error.fault || { message: error.message }; this.project(); break; }
      }
    });
  }
  expand(text) {
    const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
    const template = match && this.config.templates.find(t => t.name === match[1]);
    return template ? expandTemplate(template.text, match[2] || '') : text;
  }
  async execute(operation) {
    const client = this.client;
    const { spec, target } = operation, kind = spec.kind, state = this.S.state;
    if (!this.online) throw new HostError('connection', 'Not connected', { sent: false });
    if (!['open_session', 'new_session', 'select_agent', 'load_older'].includes(kind) && !this.operating) throw rejected('This connection is read-only');
    if (kind === 'open_session') { await this.openSession(target); return {}; }
    if (kind === 'select_agent') { await this.selectAgent(spec.agent_id); return {}; }
    if (kind === 'new_session' && !spec.bootstrap) {
      const id = spec.agent_id || state.selected_agent_id, navigation = ++this.navigation;
      if (id && id !== state.agent?.id) await this.selectAgent(id, false, client);
      if (this.client !== client || navigation !== this.navigation) return {};
      this.newDraft(spec.workspace, id); return {};
    }
    if (kind === 'load_older') {
      const obs = this.observation;
      if (!obs?.nextCursor) return {};
      const page = await client.call('session.history.read', { target: this.requireTarget(target), request: { cursor: obs.nextCursor, limit: 120, direction: 'backward' } });
      obs.historyPage(page, true); if (obs === this.observation) this.project(); return {};
    }
    if (kind === 'set_model' || kind === 'set_reasoning') {
      const patch = kind === 'set_model' ? { model: spec.model } : { reasoning: spec.level };
      if (!target.session_id) { Object.assign(state.draft, patch); Object.assign(state.draft.overrides, patch); this.notify(); return {}; }
      return this.updateSession(target, { config: patch }, operation.config_revision, client);
    }
    if (kind === 'create_agent' || kind === 'new_session' && spec.bootstrap) {
      if (!this.operating) throw rejected('This connection is read-only');
      const request = { ...clone(spec.bootstrap), operation_id: newId() };
      if (spec.workspace) request.config.session_defaults.workspace = { path: spec.workspace };
      if (spec.workspace !== undefined) request.default_session = { ...request.default_session, overrides: { ...request.default_session?.overrides, workspace: spec.workspace ? { path: spec.workspace } : null } };
      const receipt = operation.receipt = await client.call('agent.create', request);
      await this.afterCreate(receipt, operation, client); return { receipt, ...receipt.result };
    }
    if (kind === 'submit' || kind === 'queue') {
      const message = { message_id: newId(), mode: kind === 'queue' ? 'follow_up' : 'steer', text: this.expand(spec.text) };
      let receipt;
      if (target.session_id) receipt = await client.call('message.send', { ...message, target: { kind: 'session', ...this.requireTarget(target) } });
      else {
        if (!target.agent_id) throw rejected('Create or select an Agent first');
        this.checkHost(target);
        receipt = operation.receipt = await client.call('session.create', { operation_id: newId(), target: { host_id: state.host.host_id, agent_id: target.agent_id }, overrides: clone(operation.draftConfig.overrides || {}), initial_message: message });
        await this.afterCreate(receipt, operation, client);
      }
      return { receipt, acceptance: receipt.result.delivery === 'accepted' ? 'accepted' : 'rejected', input_id: receipt.message_id, start_error: receipt.result.start_error };
    }
    if (kind === 'update_agent') {
      this.checkHost(target);
      const detail = target.agent_id === state.agent?.id ? state.agent : await this.agentDetails(target.agent_id, client);
      const receipt = await client.call('agent.update', { target: { host_id: state.host.host_id, agent_id: target.agent_id }, operation_id: newId(), expected_config_revision: spec.expected_config_revision ?? operation.config_revision ?? detail.config_revision, changes: spec.changes });
      await this.observeAfter(async () => { await this.agentDetails(target.agent_id, client); await this.refreshAgents(client); }, client); return { receipt };
    }
    if (kind === 'rename_session' || kind === 'update_session') return this.updateSession(target, kind === 'rename_session' ? { title: spec.title || null } : spec.changes, spec.expected_config_revision ?? operation.config_revision, client);
    const ref = this.requireTarget(target), operation_id = newId();
    if (kind === 'unqueue') {
      const receipt = await client.call('input.remove', { target: ref, operation_id, message_id: spec.input_id });
      return { receipt, input_id: spec.input_id, text: operation.queuedText };
    }
    if (kind === 'answer') {
      const choice = spec.choice, answer = typeof choice === 'number' ? { kind: 'tool_input', answer: { kind: 'choice', data: { index: choice } } }
        : choice && typeof choice === 'object' ? { kind: 'tool_input', answer: { kind: 'text', data: choice.text } } : { kind: 'approval', decision: choice };
      const receipt = await client.call('interaction.answer', { target: ref, request: { operation_id, turn_id: spec.turn_id, load_id: spec.load_id || target.load_id, interaction_id: spec.interaction_id, answer } });
      return { receipt };
    }
    if (kind === 'cancel') {
      const method = spec.turn_id ? 'turn.cancel' : spec.operation_id ? 'session.compact.cancel' : 'session.cancel';
      return { receipt: await client.call(method, { target: ref, operation_id, ...(spec.turn_id ? { turn_id: spec.turn_id, keep_inbox: true } : spec.operation_id ? { target_operation_id: spec.operation_id } : { keep_inbox: true }) }) };
    }
    if (kind === 'compact') return { receipt: await client.call('session.compact', { target: ref, operation_id }) };
    if (kind === 'delete_session') {
      const receipt = await client.call('session.delete', { target: ref, operation_id, close: true });
      await this.observeAfter(() => this.refreshAgents(client), client); return { receipt };
    }
    throw rejected('Unsupported local action: ' + kind);
  }
  checkHost(target) { if (target.host_incarnation && target.host_incarnation !== this.client.info.host_incarnation || target.host_id && target.host_id !== this.client.info.host_id) throw rejected('The original Host incarnation has ended'); }
  async observeAfter(action, client = this.client) {
    if (this.client !== client) return;
    try { await action(); }
    catch (error) { if (this.client === client) this.notify({ notice: { level: 'error', text: 'The Host returned a receipt, but refreshing the view failed: ' + error.message } }); }
  }
  async afterCreate(receipt, operation, client = this.client) {
    await this.observeAfter(async () => {
      await this.refreshAgents(client);
      if (this.client !== client) return;
      if (receipt.agent_id && operation.navigation === this.navigation) await this.selectAgent(receipt.agent_id, false, client);
      if (this.client === client && receipt.session_id && operation.navigation === this.navigation) await this.openSession(receipt);
    }, client);
    const failure = Object.values(receipt.result.steps).find(step => step?.status === 'failed');
    if (failure) throw new HostError('business', failure.error.message, { receipt, fault: failure.error, acceptance: receipt.result.delivery === 'accepted' ? 'accepted' : 'rejected' });
  }
  async updateSession(target, changes, revision, client = this.client) {
    const ref = this.requireTarget(target, client);
    if (revision == null) revision = (await client.call('session.get', { target: ref })).config_revision;
    const receipt = await client.call('session.update', { target: ref, operation_id: newId(), expected_config_revision: revision, changes });
    await this.observeAfter(async () => {
      if (this.observation?.matches({ ...client.info, ...ref })) await this.refreshSession(this.observation, client);
      await this.refreshAgents(client);
    }, client);
    return { receipt };
  }
  async query(spec, target) {
    const client = this.client, observation = this.observation;
    if (spec.kind === 'agent') return this.agentDetails(spec.agent_id);
    const ref = this.requireTarget(spec.target || target);
    if (spec.kind === 'context') {
      const value = await client.call('session.context', { target: ref }), d = value.data;
      return { native: d, tokens: null, window: d.active_turn?.model.context_window, percent: null, compacting: !!d.compaction && d.compaction.state.phase !== 'finished', failure: d.block_reason?.message || '' };
    }
    if (spec.kind === 'files') {
      const value = await client.call('workspace.files', { target: ref, request: { directory: '', recursive: true, query: spec.query || null, cursor: spec.cursor || null, limit: 50 } });
      return { paths: value.data.entries.filter(e => e.kind !== 'directory').map(e => e.path), truncated: value.data.truncated, next_cursor: value.data.next_cursor };
    }
    if (spec.kind === 'changes') {
      const records = []; let cursor = null;
      do { const page = await client.call('changes.list', { target: ref, request: { scope: { kind: 'workspace' }, cursor, limit: 200 } }); records.push(...page.data.records); cursor = page.data.next_cursor; } while (cursor);
      const files = records.map(record => ({ ...record, status: record.kind }));
      if (this.client === client) this.changes.set(JSON.stringify(ref), files);
      return { files, branch: null };
    }
    if (spec.kind === 'diff') {
      const file = spec.change || (spec.source?.change_ref && spec.source) || this.changes.get(JSON.stringify(ref))?.find(f => f.path === spec.path);
      if (!file?.change_ref) throw rejected('Refresh changes before opening this diff');
      const lines = ['--- a/' + file.path, '+++ b/' + file.path]; let cursor = null, latest;
      do {
        const result = await client.call('changes.diff', { target: ref, request: { change_ref: file.change_ref, comparison: file.change_ref.kind === 'tool' ? 'tool_before_after' : 'head_to_worktree', context_lines: 3, max_bytes: 131072, cursor } }); latest = result.data;
        for (const hunk of latest.hunks) { lines.push(`@@ -${hunk.old_start},${hunk.old_count} +${hunk.new_start},${hunk.new_count} @@`); for (const line of hunk.lines) lines.push(({ added: '+', removed: '-', context: ' ' }[line.kind]) + line.text.replace(/\n$/, '')); }
        cursor = latest.next_cursor;
      } while (cursor);
      return { ...latest, lines, truncated: !latest.complete, added: lines.filter(l => l[0] === '+' && !l.startsWith('+++')).length, removed: lines.filter(l => l[0] === '-' && !l.startsWith('---')).length };
    }
    if (spec.kind === 'tool_output') {
      const s = spec.source || this.S.blocks.find(b => b.tool_call_id === spec.tool_call_id && b.session_id === ref.session_id);
      if (!s?.turn_id) throw rejected('The original tool source is unavailable');
      this.checkHost(s);
      const tool = { turn_id: s.turn_id, tool_call_id: spec.tool_call_id };
      const detail = await client.call('toolcall.get', { target: ref, tool });
      const text = detail.data.result?.output.content;
      if (text != null) { const lines = text.split('\n'); const bytes = new TextEncoder().encode(text), start = spec.offset || 0; return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start)), next_offset: bytes.length, eof: true, total: lines.length }; }
      const channels = [...(observation?.outputSources.get(sourceKey(s))?.values() || [])].map(buffer => ({ channel: buffer.channel, end: buffer.end }));
      if (!channels.length) throw rejected('Tool output has no observed byte boundary yet');
      const pieces = [];
      for (const { channel, end } of channels) {
        let start = 0, text = '';
        while (start < end) {
          const page = await client.call('toolcall.output.read', { target: ref, tool, request: { channel, start, end, max_bytes: 65536 } });
          if (sourceKey(page) !== sourceKey(s)) throw rejected('Tool output came from a different source');
          if (page.data.end <= start) throw rejected('Tool output read did not advance');
          text += page.data.text; start = page.data.end;
        }
        pieces.push(channels.length > 1 ? '[' + channel + ']\n' + text : text);
      }
      const fullText = pieces.join('\n'); return { text: fullText, next_offset: new TextEncoder().encode(fullText).length, eof: true, total: fullText.split('\n').length };
    }
    throw rejected('Unsupported local query: ' + spec.kind);
  }
  async files(spec) {
    const client = this.client;
    if (spec.kind === 'roots') return { roots: (await client.call('workspace.roots')).roots };
    if (spec.kind === 'list') return { listing: await client.call('workspace.list', { path: spec.path, hidden: spec.hidden, limit: 200, ...(spec.cursor && { cursor: spec.cursor }) }) };
    if (spec.kind === 'mkdir') {
      if (!this.operating) throw rejected('This connection is read-only');
      const receipt = await client.call('workspace.mkdir', { operation_id: newId(), parent: spec.parent, name: spec.name });
      if (receipt.result.status === 'failed') throw new HostError('business', receipt.result.error.message, { fault: receipt.result.error, receipt });
      return { created: receipt.result.path, receipt };
    }
    throw rejected('Unsupported folder action');
  }
}

// Same prompt-template substitutions as the TUI: quoted positional arguments,
// $@/$ARGUMENTS, and ${1:-default}. This performs no shell evaluation.
export function expandTemplate(body, input) {
  const args = []; let token = '', quote = null, started = false;
  for (const char of input) {
    if (quote) { if (char === quote) quote = null; else token += char; }
    else if (char === "'" || char === '"') { quote = char; started = true; }
    else if (/\s/u.test(char)) { if (started) { args.push(token); token = ''; started = false; } }
    else { token += char; started = true; }
  }
  if (started) args.push(token);
  const lookup = key => key === '@' ? args.join(' ') : /^\d+$/.test(key) ? args[Number(key) - 1] || '' : null;
  return body.trimEnd().replace(/\$\{([^}]*)\}|\$ARGUMENTS|\$@|\$\d+/g, (match, inner) => {
    if (match === '$ARGUMENTS' || match === '$@') return args.join(' ');
    if (inner !== undefined) { const at = inner.indexOf(':-'), key = at < 0 ? inner : inner.slice(0, at), value = lookup(key); return value === null ? match : value || (at < 0 ? '' : inner.slice(at + 2)); }
    return lookup(match.slice(1)) ?? match;
  });
}
