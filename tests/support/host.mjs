// Real Host process, storage, tools and TLS. Only model replies are controlled here.
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import WebSocket from 'ws';
import { HostConnection } from '../../web/host.js';
import { startServer } from '../../scripts/serve.mjs';

export const HOST_KEY = 'web-integration-network-fixture';
const MODEL_KEY = 'web-integration-model-fixture';
export const MODEL = 'fixture/chat';

function deadline(promise, label, milliseconds = 15_000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), milliseconds);
  })]).finally(() => clearTimeout(timer));
}

export class ModelFixture {
  constructor(api = 'chat_completions') { this.api = api; this.requests = []; this.waiters = []; this.responses = new Set(); this.bodies = []; }
  async start() {
    const path = this.api === 'responses' ? '/v1/responses' : '/v1/chat/completions';
    this.server = createServer(async (request, response) => {
      try {
        if (request.method !== 'POST' || request.url !== path) {
          response.writeHead(404).end(); return;
        }
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks));
        this.bodies.push(body);
        this.responses.add(response);
        response.on('close', () => this.responses.delete(response));
        const modelRequest = this.request(body, response);
        const waiter = this.waiters.shift();
        if (waiter) waiter.resolve(modelRequest); else this.requests.push(modelRequest);
      } catch (error) { response.writeHead(500).end(String(error)); }
    });
    await new Promise(resolve => this.server.listen(0, '127.0.0.1', resolve));
    this.endpoint = `http://127.0.0.1:${this.server.address().port}${path}`;
    return this;
  }
  request(body, response) {
    let started = false;
    const frame = value => {
      if (!started) { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); started = true; }
      response.write(`data: ${JSON.stringify(value)}\n\n`);
    };
    const error = (message, { status = 400, type = 'invalid_request_error', code = 'fixture_error', requestId = 'fixture-request' } = {}) => {
      if (started) throw new Error('HTTP error fixture must precede streaming');
      started = true;
      response.writeHead(status, { 'Content-Type': 'application/json', 'x-request-id': requestId });
      response.end(JSON.stringify({ error: { message, type, code } }));
    };
    if (this.api === 'responses') {
      let sequence = 0, created = false;
      const output = [];
      const event = value => frame({ ...value, sequence_number: sequence++ });
      const begin = () => {
        if (created) return;
        created = true;
        event({ type: 'response.created', response: { id: 'resp_fixture', status: 'in_progress', output: [] } });
      };
      return {
        body, error,
        reasoning(parts) {
          begin();
          const index = output.length, id = 'reasoning_' + index, summary = [];
          event({ type: 'response.output_item.added', output_index: index, item: { id, type: 'reasoning', summary: [] } });
          for (const [summary_index, deltas] of parts.entries()) {
            const source = { output_index: index, item_id: id, summary_index }, text = deltas.join('');
            event({ type: 'response.reasoning_summary_part.added', ...source, part: { type: 'summary_text', text: '' } });
            for (const delta of deltas) event({ type: 'response.reasoning_summary_text.delta', ...source, delta });
            event({ type: 'response.reasoning_summary_text.done', ...source, text });
            const part = { type: 'summary_text', text }; summary.push(part);
            event({ type: 'response.reasoning_summary_part.done', ...source, part });
          }
          const item = { id, type: 'reasoning', status: 'completed', summary, encrypted_content: 'fixture-cipher-' + index };
          event({ type: 'response.output_item.done', output_index: index, item }); output.push(item);
        },
        finish(text = '') {
          begin();
          if (text) {
            const index = output.length, id = 'message_' + index;
            const source = { output_index: index, item_id: id, content_index: 0 };
            event({ type: 'response.output_item.added', output_index: index, item: { id, type: 'message', role: 'assistant', status: 'in_progress', content: [] } });
            event({ type: 'response.content_part.added', ...source, part: { type: 'output_text', text: '' } });
            event({ type: 'response.output_text.delta', ...source, delta: text });
            event({ type: 'response.output_text.done', ...source, text });
            const part = { type: 'output_text', text };
            event({ type: 'response.content_part.done', ...source, part });
            const item = { id, type: 'message', role: 'assistant', status: 'completed', content: [part] };
            event({ type: 'response.output_item.done', output_index: index, item }); output.push(item);
          }
          event({ type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output,
            usage: { input_tokens: 32, output_tokens: 8, total_tokens: 40 } } });
          response.end();
        },
      };
    }
    return {
      body, error,
      delta(text, channel = 'content') { frame({ choices: [{ index: 0, delta: { [channel]: text }, finish_reason: null }] }); },
      finish(text = '') {
        frame({ choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 32, completion_tokens: 8, total_tokens: 40 } });
        response.end('data: [DONE]\n\n');
      },
      tools(calls) {
        frame({ choices: [{ index: 0, delta: { tool_calls: calls.map((call, index) => ({
          index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })) }, finish_reason: null }] });
        frame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
        response.end('data: [DONE]\n\n');
      },
    };
  }
  async next() {
    if (this.requests.length) return this.requests.shift();
    const waiter = Promise.withResolvers();
    this.waiters.push(waiter);
    try { return await deadline(waiter.promise, 'model request'); }
    finally { const i = this.waiters.indexOf(waiter); if (i >= 0) this.waiters.splice(i, 1); }
  }
  async close() {
    for (const response of this.responses) response.destroy();
    for (const waiter of this.waiters) waiter.reject(new Error('Model fixture closed'));
    this.waiters.length = 0;
    this.server.closeAllConnections();
    await new Promise(resolve => this.server.close(resolve));
  }
}

export function initialAgent(model = MODEL) {
  return {
    name: 'Browser fixture', mode: 'persistent',
    config: {
      role: { name: 'assistant', description: '', instructions: '' },
      session_defaults: {
        model, reasoning: 'auto', tools: ['read', 'write', 'edit', 'apply_patch', 'bash', 'agent'].map(name => ({ name })),
        execution: {
          approval: 'ask', prompt_timeout_ms: 30000, model_timeout_ms: 30000,
          policy_timeout_ms: 30000, tool_timeout_ms: 30000,
          model_retry_attempts: 1, model_retry_base_delay_ms: 100,
          compaction: { enabled: true, trigger_percent: 95, target_percent: 50 },
        },
      },
    },
  };
}

export async function hostFixture({ binary = process.env.MINICORE_HOST_BIN, directories = true, api = 'chat_completions', agent = initialAgent() } = {}) {
  if (!binary) throw new Error('Set MINICORE_HOST_BIN to the compiled minicore-host executable');
  const directory = await mkdtemp(join(tmpdir(), 'minicore-web-'));
  const workspace = join(directory, 'workspace');
  await mkdir(workspace);
  await mkdir(join(workspace, 'subdirectory'));
  await mkdir(join(workspace, '.hidden'));
  await writeFile(join(workspace, 'README.md'), '# Real workspace\n\n你好🙂\n');
  execFileSync('git', ['init', '-q', workspace]);
  execFileSync('git', ['-C', workspace, 'add', 'README.md']);
  execFileSync('git', ['-C', workspace, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  const cert = join(directory, 'cert.pem'), key = join(directory, 'key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', key, '-out', cert], { stdio: 'ignore' });
  const provider = await new ModelFixture(api).start();
  const config = {
    name: 'Web integration fixture', framework_instructions: '',
    models: [{ model: MODEL, api, endpoint: provider.endpoint,
      provider_model: 'controlled-local-fixture', api_key_env: 'MINICORE_WEB_TEST_MODEL_KEY',
      context_window: 128000, supported_reasoning: ['auto', 'high'], supports_tools: true, request_timeout_ms: 30000 }],
    tools: initialAgent().config.session_defaults.tools,
    ...(directories ? { workspace_roots: [workspace] } : {}),
    network: { listen: '127.0.0.1:0', access_key_env: 'MINICORE_WEB_TEST_HOST_KEY' },
    logging: { level: 'info', output: { kind: 'stderr' } },
  };
  const configDirectory = join(directory, 'config');
  await mkdir(configDirectory);
  const configPath = join(configDirectory, 'host.json');
  await writeFile(configPath, JSON.stringify(config));
  const child = spawn(resolve(binary), ['--data-root', join(directory, 'data'), '--config-dir', configDirectory,
    '--tls-cert', cert, '--tls-key', key], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, MINICORE_WEB_TEST_MODEL_KEY: MODEL_KEY, MINICORE_WEB_TEST_HOST_KEY: HOST_KEY },
  });
  const started = Promise.withResolvers();
  const diagnostics = [];
  const lines = createInterface({ input: child.stderr });
  child.once('error', error => started.reject(error));
  child.once('exit', code => started.reject(new Error(`Host exited ${code}: ${diagnostics.slice(-8).join('\n')}`)));
  lines.on('line', line => {
    diagnostics.push(line);
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event.component === 'host.process' && event.event === 'host.started') started.resolve(event.attributes.listen_port);
  });
  let site;
  const clients = new Set();
  const fixture = {
    directory, workspace, provider, child, diagnostics,
    async connect() {
      const ca = await readFile(cert);
      class TrustedSocket extends WebSocket { constructor(url) { super(url, { ca }); } }
      const connection = new HostConnection(fixture.hostUrl, { WebSocket: TrustedSocket, timeout: 10000 });
      await connection.connect(HOST_KEY);
      clients.add(connection);
      return connection;
    },
    async close() {
      for (const client of clients) client.close();
      if (site) { site.closeAllConnections(); await new Promise(resolve => site.close(resolve)); }
      await provider.close();
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        try { await deadline(exited, 'test Host shutdown', 5000); }
        catch { child.kill('SIGKILL'); await exited; }
      }
      lines.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
  try {
    const port = await deadline(started.promise, 'Host WSS startup');
    fixture.hostUrl = `wss://localhost:${port}/`;
    site = await startServer({ port: 0, config: {
      host_url: fixture.hostUrl,
      templates: [{ name: 'review', description: 'Review a file', hint: '[path]', text: 'Review $1 carefully. $@' }],
      initial_agent: agent,
    } });
    fixture.url = `http://127.0.0.1:${site.address().port}/`;
    return fixture;
  } catch (error) { await fixture.close(); throw error; }
}

export { deadline };
