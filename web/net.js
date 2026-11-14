import * as MC from './core.js';
import { HostConnection, accessKeyName, loadConfig } from './host.js';
import { HostApplication } from './host-app.js';
import { $, closeAll, fill, h, icon, spin, toast } from './ui.js';

export const S = MC.createStore();
export let HOST = '';
const on = {}, app = new HostApplication(S, (event, effects) => on.message?.(event, effects));
let client = null, config = null, halted = false, screen = '', retryTimer = 0, attempt = 0, connecting = false;
export const bind = callbacks => Object.assign(on, callbacks);
export const repaint = () => on.render?.();
export const newDraftVersion = () => MC.newDraftVersion(S);
export const tz = () => new Date().getTimezoneOffset();
export const hostNow = () => Date.now();
export const stampAt = ms => MC.stamp(ms, hostNow(), tz());
export const turnStatus = () => S.state?.status || {};
export const viewed = () => S.state?.session || S.state?.draft || {};
export const online = () => app.online;
export const operating = () => app.operating;
export const isHalted = () => halted;
export const isMain = () => screen === 'main';
export const pendingKind = kind => !!MC.pending(S, kind);
export const sending = () => pendingKind('submit') || pendingKind('queue');
export const pump = () => {};

function run(operation) {
  if (!operation) { toast('Local confirmation buffer is full · resolve or discard an unconfirmed message', 'error'); return false; }
  operation.navigation = app.navigation;
  const session = S.state?.sessions.find(s => s.id === operation.target.session_id && s.agent_id === operation.target.agent_id);
  operation.config_revision = operation.spec.expected_config_revision ?? (S.state?.session?.id === operation.target.session_id ? S.state.session.config_revision : session?.config_revision);
  if (operation.kind === 'update_agent') operation.config_revision = operation.spec.expected_config_revision ?? S.state.agent?.config_revision;
  operation.controller_revision = app.observation?.state?.controller_revision;
  operation.queuedText = S.state?.queue.find(q => q.id === operation.spec.input_id)?.text;
  repaint();
  app.execute(operation).then(result => finish(operation, { ok: result.acceptance !== 'rejected', ...result })).catch(error => {
    const receipt = error.receipt || operation.receipt;
    const acceptance = receipt?.result?.delivery === 'accepted' ? 'accepted' : error.acceptance || (error.kind === 'business' || error.sent === false ? 'rejected' : 'unknown');
    finish(operation, { ok: acceptance === 'accepted', error: error.message, fault: error.fault, receipt, acceptance });
  });
  return true;
}
function finish(operation, result) {
  const current = operation.target.session_id ? S.sid === operation.target.session_id && S.state?.session?.agent_id === operation.target.agent_id
    : operation.navigation === app.navigation || result.receipt?.session_id === S.sid;
  const ack = { ...operation, ...result, current, text: result.text ?? operation.text };
  if (!result.ok && result.acceptance === 'unknown' && operation.text != null) { operation.st = 'unconfirmed'; ack.unconfirmed = true; }
  else S.intents.delete(operation.id);
  if (on.message) on.message(null, { ack, state: true }); else operation.own?.(ack);
}
export function intent(spec, own, draft) {
  if (!online()) { toast('Not connected', 'error'); return false; }
  return run(MC.intent(S, spec, own, draft));
}
export function resend(id) {
  if (!operating() || !confirm('This message may already have arrived. Send it again to its original target, possibly creating a duplicate?')) return;
  run(MC.sendAgain(S, id));
}
export function discard(id) { if (confirm('This message may already have arrived. Discard only its retained local copy?') && MC.discardUnconfirmed(S, id)) repaint(); }
export function ask(spec, callback) {
  const target = structuredClone(spec.target || (spec.source?.session_id && spec.source?.agent_id ? spec.source : MC.captureTarget(S, spec)));
  app.query(spec, target).then(data => callback({ ok: true, data })).catch(error => callback({ ok: false, error: error.message, message: error.message, fault: error.fault }));
}
export function fsCall(spec, callback) {
  app.files(spec).then(result => callback({ ok: true, ...result })).catch(error => callback({ ok: false, error: error.message, message: error.message, fault: error.fault, receipt: error.receipt }));
}
export function recoverObservations() { return app.recover().catch(error => toast(error.message, 'error')); }

function show(name) {
  screen = name; $('signin').hidden = name !== 'signin'; $('gate').hidden = name !== 'gate'; $('app').hidden = name !== 'main';
  if (name !== 'main') closeAll();
}
function signinError(message) {
  const error = $('serr'); error.hidden = !message; $('pwf').classList.toggle('bad', !!message);
  fill(error, message && icon('warn', 'sm'), h('span', '', message || ''));
}
function signinBusy(busy) { const button = $('sgo'); button.firstChild.hidden = !busy; button.lastChild.textContent = busy ? 'Connecting…' : 'Connect'; button.disabled = busy; $('pw').readOnly = busy; }
function signin(notice, error) {
  show('signin'); $('shost').textContent = HOST; $('snote').hidden = !notice;
  if (notice) $('snote').lastChild.textContent = notice;
  signinBusy(false); signinError(error); $('pw').focus({ preventScroll: true });
}
function gate(message, retry = false) {
  fill($('gate'), h('div', 'col', h('img', { class: 'appicon', src: './icon.svg', alt: '' }), h('h1', '', retry ? 'Connection unavailable' : 'Connecting…'), h('p', 'sub', message),
    retry ? h('div', 'gate-acts', h('button', { class: 'btn primary', onclick: () => { halted = false; connect(); } }, 'Retry'), h('button', { class: 'btn ghost', onclick: signOut }, 'Use another access key')) : spin()));
  show('gate');
}
function lost(connection) {
  if (client !== connection) return;
  MC.disconnect(S); on.lost?.();
  if (!halted && !connecting) {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => connect(), MC.backoff(attempt++));
  }
}
async function connect(key, login = false) {
  if (connecting || halted || !config) return;
  key ||= sessionStorage.getItem(accessKeyName(HOST));
  if (!key) return signin();
  clearTimeout(retryTimer); connecting = true;
  if (!S.state) gate(HOST);
  const connection = new HostConnection(HOST, { onClose: () => lost(connection) });
  client = connection;
  try {
    await connection.connect(key);
    await app.initialize(connection, config);
    if (client !== connection) return;
    sessionStorage.setItem(accessKeyName(HOST), key);
    $('pw').value = ''; signinBusy(false); show('main'); attempt = 0;
    on.message?.(null, { welcome: true, snapshot: true, state: true });
  } catch (error) {
    if (client !== connection) return;
    if (login || error.kind === 'business' || error.kind === 'protocol') { halted = true; signin(null, error.message); }
    else { if (!S.state) gate(error.message, true); retryTimer = setTimeout(() => connect(), MC.backoff(attempt++)); }
  } finally { connecting = false; repaint(); }
}
function doLogin() {
  const key = $('pw').value;
  if (!key.trim()) { signinError('Enter the Host access key.'); return; }
  halted = false; signinError(''); signinBusy(true); connect(key, true);
}
$('sf').addEventListener('submit', event => { event.preventDefault(); doLogin(); });
$('pw').addEventListener('input', () => signinError(''));
$('pweye').addEventListener('click', () => {
  const pw = $('pw'), button = $('pweye'), visible = pw.type === 'password'; pw.type = visible ? 'text' : 'password';
  button.setAttribute('aria-pressed', String(visible)); button.setAttribute('aria-label', visible ? 'Hide access key' : 'Show access key');
  button.firstChild.firstChild.setAttribute('href', visible ? '#i-eyeoff' : '#i-eye');
});
export function signOut() {
  halted = true; clearTimeout(retryTimer);
  if (HOST) sessionStorage.removeItem(accessKeyName(HOST));
  const previous = client; client = null; previous?.close(); app.client = null; app.navigation++;
  Object.assign(S, MC.createStore(), { nid: S.nid }); on.reset?.(); signin('Signed out. Enter the Host access key to connect again.');
}
export function wake() {
  if (halted || !config || screen === 'signin') return;
  // Background/foreground changes do not close a healthy operator connection.
  if (online()) { if (app.stream?.ended || app.hostStream?.ended) recoverObservations(); return; }
  clearTimeout(retryTimer); connect();
}
export function handshake(fx) { if (fx.snapshot && S.state && screen !== 'main') show('main'); return true; }
export async function boot() {
  try { config = await loadConfig(); HOST = config.host_url; if (sessionStorage.getItem(accessKeyName(HOST))) await connect(); else signin(); }
  catch (error) { halted = true; gate(error.message, true); }
}
