import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import * as MC from '../web/core.js';

// Exercise the actual sheet callbacks without booting its browser/connection imports.
const source = readFileSync(new URL('../web/sessions.js', import.meta.url), 'utf8');
const pickerSource = source.slice(source.indexOf('let picker = null;'), source.indexOf('\nfunction list(')).replace('export function openNew', 'function openNew');
function setup() {
  const actions = [], sheets = [];
  const S = { state: { draft: { workspace: '/work' }, selected_agent_id: null, agents: [], initial_agent: { name: 'First Agent', config: { session_defaults: { model: 'fixture' } } } } };
  const context = vm.createContext({ S, MC, structuredClone, operating: () => true, renderNew() {}, refreshSheets() {}, closeAll() {}, spin() {},
    sheet: options => sheets.push(options), fsCall() {}, h: (tag, props) => ({ tag, props }),
    intent: (spec, callback) => { actions.push({ spec, callback }); return true; },
  });
  vm.runInContext(pickerSource, context);
  const open = () => context.openNew();
  const start = () => sheets.at(-1).foot().props.onclick();
  const picker = () => vm.runInContext('picker', context);
  open();
  return { S, actions, open, start, picker };
}
const partial = {
  kind: 'agent.create', host_id: 'host', host_incarnation: 'incarnation', operation_id: 'create', agent_id: 'published-agent',
  result: { steps: { agent: { status: 'succeeded' }, session: { status: 'failed', error: { message: 'Default Session could not be created' } } } },
};

test('a partial bootstrap retains its published Agent and waits for an explicit next Start', () => {
  const { S, actions, start, picker } = setup();
  start();
  assert.ok(actions[0].spec.bootstrap);
  S.state.agents = [{ id: partial.agent_id, name: 'First Agent' }];
  actions[0].callback({ ok: false, receipt: partial, error: partial.result.steps.session.error });
  assert.equal(picker().bootstrap, null);
  assert.equal(picker().agent_id, partial.agent_id);
  assert.equal(picker().err, 'Default Session could not be created');
  assert.equal(picker().starting, false);
  assert.equal(actions.length, 1, 'partial success does not retry creation or start a Session automatically');
  start();
  assert.equal(actions.length, 2);
  assert.deepEqual(actions[1].spec, MC.intents.newSession('/work', partial.agent_id, null));
});

test('an unconfirmed or unpublished Agent does not become the selected creation source', () => {
  for (const receipt of [undefined, { ...partial, agent_id: undefined }, { ...partial, result: { steps: { agent: { status: 'failed' } } } }]) {
    const { actions, start, picker } = setup();
    start();
    actions[0].callback({ ok: false, receipt, error: 'Creation not confirmed' });
    assert.ok(picker().bootstrap);
    assert.equal(picker().agent_id, null);
    assert.equal(picker().err, 'Creation not confirmed');
    assert.equal(actions.length, 1);
  }
});

test('a late partial-create response cannot change a newer picker', () => {
  const { actions, open, start, picker } = setup();
  start(); open();
  actions[0].callback({ ok: false, receipt: partial, error: 'Earlier creation failed' });
  assert.ok(picker().bootstrap);
  assert.equal(picker().agent_id, null);
  assert.equal(picker().err, '');
  assert.equal(picker().starting, false);
});
