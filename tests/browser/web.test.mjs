import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { HOST_KEY, hostFixture } from '../support/host.mjs';

async function browserFixture(t, mobile = false) {
  const host = await hostFixture();
  let browser;
  t.after(async () => { await browser?.close(); await host.close(); });
  browser = await chromium.launch({ headless: true,
    ...(process.env.MINICORE_CHROMIUM_PATH && { executablePath: process.env.MINICORE_CHROMIUM_PATH }) });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, reducedMotion: 'reduce',
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    isMobile: mobile, hasTouch: mobile });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [], methods = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => socket.on('framesent', frame => {
    const value = JSON.parse(String(frame.payload));
    if (value.method) methods.push(value.method);
  }));
  async function save(name) {
    await mkdir('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/' + name + '.png', fullPage: true });
  }
  return { ...host, browser, context, page, errors, methods, save };
}
async function login(page, url) {
  await page.goto(url);
  await page.getByPlaceholder('Host access key').fill(HOST_KEY);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.locator('#app').waitFor({ state: 'visible' });
}
async function bootstrap(page, workspace) {
  await page.locator('#newb').click();
  const sheet = page.getByRole('dialog', { name: 'New session', exact: true });
  await sheet.locator('button[data-k="n' + workspace + '"]').click();
  await sheet.getByRole('button', { name: 'Start in workspace', exact: true }).click();
  await sheet.waitFor({ state: 'detached' });
  await page.locator('#sub').getByText('workspace', { exact: true }).waitFor();
}
async function send(page, text) {
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}
async function idle(page) { await page.locator('#pri[aria-label="Send"]').waitFor(); }
async function menu(page, name) {
  await page.locator('#moreb').click();
  await page.getByRole('dialog').last().getByRole('button', { name, exact: true }).click();
}

test('desktop UI bootstraps, streams, approves real tools, renames and restores read-only history', { timeout: 90000 }, async t => {
  const f = await browserFixture(t), { page } = f;
  try {
    await login(page, f.url);
    await bootstrap(page, f.workspace);
    await send(page, 'Show a greeting with Markdown');
    const model = await f.provider.next();
    model.delta('Checking the request', 'reasoning_content');
    model.delta('## Migrated UI\n\n你好🙂');
    await page.locator('#blocks').getByText('你好🙂', { exact: true }).waitFor();
    model.finish('\n\n- Native WSS\n- Existing styles\n');
    await idle(page);
    assert.equal(await page.locator('#blocks h2').filter({ hasText: 'Migrated UI' }).count(), 1);
    await f.save('desktop-stream');

    await send(page, 'Write created.txt after asking me');
    const write = await f.provider.next();
    write.tools([{ id: 'browser-write', name: 'write', arguments: { path: 'created.txt', content: '真实浏览器审批🙂\n' } }]);
    await page.locator('[data-k="allow_once"]').click();
    const result = await f.provider.next();
    assert.equal(await readFile(join(f.workspace, 'created.txt'), 'utf8'), '真实浏览器审批🙂\n');
    result.finish('The approved file was written.');
    await page.locator('#blocks').getByText('The approved file was written.', { exact: true }).waitFor();
    await idle(page);
    await menu(page, 'Changes');
    const changes = page.getByRole('dialog', { name: /^Changes/ });
    await changes.getByRole('button', { name: /created\.txt/ }).waitFor();
    await changes.getByRole('button', { name: 'Close', exact: true }).click();
    await menu(page, 'Context');
    const contextSheet = page.getByRole('dialog', { name: 'Context', exact: true });
    await contextSheet.locator('dl').waitFor();
    await contextSheet.getByRole('button', { name: 'Close', exact: true }).click();

    await menu(page, 'Rename');
    await page.getByRole('textbox', { name: 'Session title', exact: true }).fill('Browser migration verified');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.locator('#title').getByText('Browser migration verified', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Approvals', exact: true }).click();
    const policy = page.getByRole('dialog', { name: 'Future turn approval', exact: true });
    await policy.getByRole('radio', { name: 'Automatic', exact: true }).click();
    await policy.getByRole('button', { name: 'Save policy', exact: true }).click();
    await policy.waitFor({ state: 'detached' });

    const readonly = await f.browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    const other = await readonly.newPage(); other.setDefaultTimeout(15000);
    await login(other, f.url);
    await other.locator('#blocks').getByText('The approved file was written.', { exact: true }).waitFor();
    assert.equal(await other.locator('#blocks').getByText('你好🙂', { exact: true }).count(), 1);
    await other.getByRole('textbox', { name: 'Message', exact: true }).fill('A local observer draft');
    assert.equal(await other.getByRole('button', { name: 'Send', exact: true }).isDisabled(), true);
    await readonly.close();

    await page.reload();
    await page.locator('#app').waitFor({ state: 'visible' });
    await page.locator('#blocks').getByText('The approved file was written.', { exact: true }).waitFor();
    assert.equal(await page.locator('#blocks').getByText('你好🙂', { exact: true }).count(), 1);
    assert.equal(await page.locator('#title').textContent(), 'Browser migration verified');
    assert.ok(f.methods.includes('initialize') && f.methods.includes('agent.create') && f.methods.includes('interaction.answer'));
    assert.ok(f.methods.every(method => method === 'initialize' || method.includes('.')));
    assert.deepEqual(f.errors, []);
    await f.save('desktop-restored');
  } catch (error) { await f.save('desktop-failure'); throw error; }
});

test('mobile layout keeps directory creation, streaming and drawer controls usable', { timeout: 60000 }, async t => {
  const f = await browserFixture(t, true), { page } = f;
  try {
    await login(page, f.url);
    await page.locator('#newb').click();
    const picker = page.getByRole('dialog', { name: 'New session', exact: true });
    await picker.locator('button[data-k="n' + f.workspace + '"]').click();
    await picker.getByRole('button', { name: 'New folder', exact: true }).click();
    await picker.getByRole('textbox', { name: 'New folder name', exact: true }).fill('mobile-project');
    await picker.getByRole('button', { name: 'Create', exact: true }).click();
    await picker.getByRole('button', { name: 'Start in mobile-project', exact: true }).click();
    await picker.waitFor({ state: 'detached' });
    assert.ok((await stat(join(f.workspace, 'mobile-project'))).isDirectory());
    await send(page, '/review "a mobile file.md"');
    const model = await f.provider.next();
    assert.match(JSON.stringify(model.body.messages), /Review a mobile file\.md carefully/);
    model.delta('手机端迁移成功🙂');
    await page.locator('#blocks').getByText('手机端迁移成功🙂', { exact: true }).waitFor();
    model.finish();
    await idle(page);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    await page.locator('#menu').click();
    await page.getByRole('searchbox', { name: 'Search sessions', exact: true }).fill('review');
    await f.save('mobile-drawer');
    await page.locator('#nav').getByRole('button', { name: 'Close', exact: true }).click();
    await f.save('mobile-conversation');
    assert.deepEqual(f.errors, []);
  } catch (error) { await f.save('mobile-failure'); throw error; }
});
