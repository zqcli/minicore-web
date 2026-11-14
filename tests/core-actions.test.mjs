import assert from 'node:assert/strict';
import test from 'node:test';
import * as MC from '../web/core.js';
import { expandTemplate } from '../web/host-app.js';

test('unconfirmed message keeps its original target and draft through navigation and explicit resend', () => {
  const store = MC.createStore();
  store.state = { host: { host_id: 'host', host_incarnation: 'incarnation' }, session: { id: 'first', agent_id: 'agent', load_id: 'load' }, sessions: [], draft: { agent_id: 'agent', overrides: { workspace: { path: '/original' } } } };
  const pending = MC.intent(store, MC.intents.submit('Original message'), undefined, { key: 'original draft', version: 'one' });
  MC.disconnect(store);
  store.state.session = { id: 'second', agent_id: 'other', load_id: 'new-load' };
  const retry = MC.sendAgain(store, pending.id);
  assert.deepEqual(retry.target, { host_id: 'host', host_incarnation: 'incarnation', agent_id: 'agent', session_id: 'first', load_id: 'load' });
  assert.equal(retry.text, 'Original message'); assert.equal(retry.draft.key, 'original draft'); assert.notEqual(retry.id, pending.id);
  assert.equal(store.intents.has(pending.id), false);
});

test('Host approval options and text answers preserve the exact pending Load and Turn', () => {
  assert.deepEqual(MC.approvalOptions({ kind: 'approval', options: ['Allow once', 'Deny'] }).map(x => x.choice), ['allow_once', 'deny']);
  assert.equal(MC.approvalKey({ kind: 'approval' }, 'a', false, 0, 1000, false), null);
  const store = MC.createStore(); store.state = { host: { host_incarnation: 'inc' }, session: { agent_id: 'a', id: 's', load_id: 'l' }, interaction: { kind: 'text', turn_id: 't', load_id: 'l', id: 'question' } };
  MC.syncReply(store); store.reply.text = '你好🙂';
  assert.deepEqual(MC.textAnswer(store), { kind: 'answer', turn_id: 't', interaction_id: 'question', choice: { text: '你好🙂' }, load_id: undefined });
  store.state.interaction.load_id = 'other'; MC.syncReply(store); assert.equal(store.reply.text, '');
  assert.equal(MC.validAnswerText('a\nline'), false);
});

test('prompt templates preserve quoted arguments, defaults and literal unknown dollar names', () => {
  assert.equal(expandTemplate('fix $1 then $2; all: $@ / $ARGUMENTS; cost $5 \\$', 'a "b c" d'), 'fix a then b c; all: a b c d / a b c d; cost  \\$');
  assert.equal(expandTemplate('Focus on ${1:-correctness, safety} and ${2:-tests}.', "'' docs"), 'Focus on correctness, safety and docs.');
  assert.equal(expandTemplate('all: ${@:-none}', ''), 'all: none');
  assert.equal(expandTemplate('price $ 5, ${x}, $HOME, $', 'a'), 'price $ 5, ${x}, $HOME, $');
});

test('unreported context counts stay unknown and provider usage is labelled as historical', () => {
  const view = MC.contextView({ native: { model: 'provider/model', config_revision: 3, history_loaded: true, compaction_settings: { enabled: true, trigger_percent: 95, target_percent: 50 }, history: { raw_items: 4, effective_items: 4, latest_response: { usage: { input_tokens: 20 } } } } });
  assert.equal(view.percent, null); assert.match(view.used, /not reported/); assert.ok(view.rows.some(([label, value]) => label === 'Last response usage' && value === '20 input'));
});
