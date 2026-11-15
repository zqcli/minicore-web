import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { browserFixture, login, bootstrap, send, idle, menu } from '../support/browser.mjs';
import { initialAgent } from '../support/host.mjs';

async function renamed(page, text) {
  await menu(page, 'Rename');
  const dialog = page.getByRole('dialog', { name: 'Rename session', exact: true });
  await dialog.getByRole('textbox', { name: 'Session title', exact: true }).fill(text);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await page.waitForFunction(title => document.getElementById('title').textContent === title, text);
}

async function currentId(page) {
  return page.locator('.srow.cur .sid').getAttribute('title');
}

async function captureFailure(f, name, task) {
  try { await task(); assert.deepEqual(f.errors, []); }
  catch (error) {
    error.message += '\nStage: ' + (f.stage || name) + '\nPage errors: ' + JSON.stringify(f.errors) + '\nRecent RPC methods: ' + JSON.stringify(f.methods.slice(-30));
    try { await f.save(name + '-failure', { timeout: 5000 }); }
    catch (captureError) { error.message += '\nFailure screenshot: ' + captureError.message; }
    throw error;
  }
}

test('browser preserves Responses reasoning parts and complete historical upstream errors', { timeout: 90000 }, async t => {
  const f = await browserFixture(t, { api: 'responses' }), { page } = f;
  await captureFailure(f, 'upgrade-reasoning-errors', async () => {
    await login(page, f.url); await bootstrap(page, f.workspace);
    await send(page, 'Check real Responses reasoning boundaries');
    const model = await f.provider.next();
    model.reasoning([['Preparing ', 'verification'], [], ['第二部分🙂']]);
    model.reasoning([['Another ', 'item']]);
    await page.locator('#blocks .tk').click();
    const expected = 'Preparing verification\n第二部分🙂\nAnother item';
    await page.waitForFunction(text => document.querySelector('#blocks .rsn')?.textContent === text, expected);
    model.finish('Reasoning stream complete.'); await idle(page);
    assert.equal(await page.locator('#blocks .rsn').textContent(), expected);
    await f.save('upgrade-reasoning-boundaries');

    await send(page, 'Return a full multi-line upstream failure');
    const cause = '原始上游错误🙂\nThe provider rejected this input.\nOriginal diagnostic tail.';
    (await f.provider.next()).error(cause, { requestId: 'browser-upstream-request' });
    await idle(page);
    await page.locator('#blocks .fail').waitFor();
    const expand = page.getByRole('button', { name: 'Show full message', exact: true });
    if (await expand.isVisible()) await expand.click();
    await page.locator('#blocks').getByText('Original diagnostic tail.', { exact: false }).waitFor();
    await page.reload();
    await page.locator('#app').waitFor({ state: 'visible' });
    await page.locator('#blocks .fail').waitFor();
    if (await expand.isVisible()) await expand.click();
    await page.locator('#blocks').getByText('Original diagnostic tail.', { exact: false }).waitFor();
    const rendered = await page.locator('#blocks').innerText();
    for (const line of cause.split('\n')) assert.ok(rendered.includes(line));
    await page.locator('#blocks .tk').click();
    assert.equal(await page.locator('#blocks .rsn').textContent(), expected);
    assert.equal(f.provider.bodies.length, 2, 'reload does not replay business requests');
    await f.save('upgrade-history-error');
  });
});

test('same-title Sessions keep identities, captured Context status and reactive menus', { timeout: 90000 }, async t => {
  const f = await browserFixture(t), { page } = f;
  await captureFailure(f, 'upgrade-session-identities', async () => {
    await login(page, f.url); await bootstrap(page, f.workspace);
    const title = 'Same title with a very long common prefix — daily project work';
    await renamed(page, title);
    const a = await currentId(page);
    assert.equal(await page.locator('.srow.cur .sid').textContent(), a.slice(0, 8));
    await bootstrap(page, f.workspace);
    await send(page, 'Start the second Session');
    const model = await f.provider.next();
    await renamed(page, title);
    const b = await currentId(page);
    assert.notEqual(a, b);
    assert.equal(await page.locator('.sid').count(), 2);
    assert.equal(await page.locator('.srow').filter({ hasText: title }).count(), 2);

    // A is idle, B is still running. A's panel stays bound to A after navigating to B.
    await page.locator('[data-k="s' + a + '"]').click();
    await menu(page, 'Context');
    const context = page.getByRole('dialog', { name: 'Context', exact: true });
    await context.getByRole('button', { name: 'Compact now', exact: true }).waitFor();
    assert.equal(await context.getByRole('button', { name: 'Compact now', exact: true }).isDisabled(), false);
    await page.locator('[data-k="s' + b + '"]').click();
    assert.equal(await context.getByRole('button', { name: 'Compact now', exact: true }).isDisabled(), false);
    await context.getByRole('button', { name: 'Close', exact: true }).click();
    await page.locator('#moreb').click();
    const sessionMenu = page.getByRole('dialog').last();
    const compact = sessionMenu.getByRole('button', { name: 'Compact now', exact: true });
    assert.equal(await compact.isDisabled(), true);
    await sessionMenu.getByRole('button', { name: 'Rename', exact: true }).focus();
    model.finish('The second Session is now idle.');
    await page.waitForFunction(() => [...document.querySelectorAll('[role="dialog"] button')].some(b => b.textContent.trim() === 'Compact now' && !b.disabled));
    assert.equal(await compact.isDisabled(), false);
    assert.equal(await sessionMenu.getByRole('button', { name: 'Rename', exact: true }).evaluate(button => button === document.activeElement), true);
    await page.keyboard.press('Escape');
    await renamed(page, 'Only Session B renamed');
    assert.equal(await page.locator('[data-k="s' + a + '"]').getAttribute('title'), title);
    assert.equal(await page.locator('[data-k="s' + b + '"] .sid').textContent(), b.slice(0, 8));
    await f.save('upgrade-session-identities-desktop');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#menu').click();
    await page.waitForFunction(() => {
      const nav = document.getElementById('nav');
      return nav.classList.contains('on') && getComputedStyle(nav).transform === 'none';
    });
    const badges = page.locator('#nav .sid');
    assert.equal(await badges.count(), 2);
    for (const badge of await badges.all()) {
      const bounds = await badge.boundingBox();
      const drawer = await page.locator('#nav').evaluate(nav => ({
        bounds: nav.getBoundingClientRect().toJSON(),
        transform: getComputedStyle(nav).transform, viewport: innerWidth
      }));
      assert.ok(bounds && bounds.width > 35 && bounds.x >= 0 && bounds.x + bounds.width <= 390,
        'short ID remains readable inside the settled drawer: ' + JSON.stringify({ bounds, drawer }));
    }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await f.save('upgrade-session-identities-mobile');
    await page.locator('#nav').getByRole('button', { name: 'Close', exact: true }).click();
    await page.locator('#nav').waitFor({ state: 'hidden' });
    await page.setViewportSize({ width: 1440, height: 1000 });

    const readonly = await f.browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    const other = await readonly.newPage(); other.setDefaultTimeout(15000);
    await login(other, f.url);
    await other.locator('#moreb').click();
    assert.equal(await other.getByRole('dialog').last().getByRole('button', { name: 'Compact now', exact: true }).isDisabled(), true);
    await readonly.close();

    await page.locator('#moreb').click();
    assert.equal(await page.getByRole('dialog').last().getByRole('button', { name: 'Compact now', exact: true }).isDisabled(), false);
    f.child.kill('SIGTERM');
    await page.waitForFunction(() => [...document.querySelectorAll('[role="dialog"] button')].some(b => b.textContent.trim() === 'Compact now' && b.disabled));
    await f.save('upgrade-open-menu-disconnected');
  });
});

test('browser IME guard preserves working Turn and existing follow-up/steer keyboard modes', { timeout: 90000 }, async t => {
  const f = await browserFixture(t), { page } = f;
  await captureFailure(f, 'upgrade-ime-keys', async () => {
    await login(page, f.url); await bootstrap(page, f.workspace);
    await send(page, 'Hold the current Turn');
    const first = await f.provider.next(), composer = page.getByRole('textbox', { name: 'Message', exact: true });
    await composer.fill('输入法候选🙂');
    // Synthetic composition flags exercise actual browser event propagation; this
    // is not a claim about a physical keyboard or a specific operating-system IME.
    await composer.dispatchEvent('keydown', { key: 'Escape', isComposing: true, keyCode: 229, bubbles: true });
    await composer.dispatchEvent('keydown', { key: 'Enter', isComposing: true, keyCode: 229, bubbles: true });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(f.requests.filter(r => r.method === 'turn.cancel').length, 0);
    assert.equal(f.requests.filter(r => r.method === 'message.send').length, 1);
    assert.equal(await composer.inputValue(), '输入法候选🙂');

    await composer.fill('Follow-up from Option or Alt Enter');
    await composer.press('Alt+Enter');
    await page.getByText('Follow-up from Option or Alt Enter', { exact: true }).first().waitFor();
    assert.equal(f.requests.filter(r => r.method === 'message.send').at(-1).params.mode, 'follow_up');
    await composer.fill('Steer from Control Enter');
    await composer.press('Control+Enter');
    await page.getByText('Steer from Control Enter', { exact: true }).first().waitFor();
    assert.equal(f.requests.filter(r => r.method === 'message.send').at(-1).params.mode, 'steer');
    first.finish('First response.');
    (await f.provider.next()).finish('Steering consumed.');
    (await f.provider.next()).finish('Follow-up consumed.');
    await idle(page);
    await page.locator('#blocks').getByText('Follow-up consumed.', { exact: true }).waitFor();
    await composer.fill('First line'); await composer.press('Shift+Enter'); await composer.pressSequentially('Second line');
    assert.equal(await composer.inputValue(), 'First line\nSecond line');
    await f.save('upgrade-ime-and-queue');
  });
});

test('large native tool result has a bounded preview with complete explicit Open and Copy', { timeout: 90000 }, async t => {
  const agent = initialAgent(); agent.config.session_defaults.execution.approval = 'auto';
  // This case measures full tool data and its display copy, independent of an
  // automatic summary request triggered by the intentionally oversized output.
  agent.config.session_defaults.execution.compaction.enabled = false;
  const f = await browserFixture(t, { agent }), { page } = f;
  await captureFailure(f, 'upgrade-tool-preview', async () => {
    const original = '中🙂'.repeat(200000);
    await writeFile(join(f.workspace, 'large-output.txt'), original);
    await login(page, f.url); await bootstrap(page, f.workspace);
    await send(page, 'Read the complete large single line');
    (await f.provider.next()).tools([{ id: 'large-preview', name: 'read', arguments: { path: 'large-output.txt', limit: 1 } }]);
    const afterTool = await f.provider.next();
    assert.ok(afterTool.body.messages.some(m => m.role === 'tool' && m.content.includes(original)), 'actual tool body reaches Host/model in full');
    afterTool.finish('Large output preserved.'); await idle(page);
    const row = page.locator('[data-k="tlarge-preview"]');
    if (!await row.isVisible()) await page.locator('#blocks .fold[aria-expanded="false"]').click();
    await row.click();
    const tool = page.locator('.tl').filter({ has: page.locator('[data-k="tlarge-preview"]') });
    const preview = tool.locator('pre.out');
    assert.ok((await preview.textContent()).length <= 16384, 'card DOM contains a bounded display copy');
    assert.ok((await tool.innerText()).toLowerCase().includes('truncat'));
    await f.save('upgrade-large-preview');
    f.stage = 'open complete tool output';
    await tool.getByRole('button', { name: 'Open', exact: true }).click();
    f.stage = 'read complete tool output DOM';
    const output = page.getByRole('dialog').last();
    assert.ok((await output.locator('pre').textContent()).includes(original));
    f.stage = 'copy complete tool output';
    await f.context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await output.getByRole('button', { name: 'Copy', exact: true }).click();
    await output.locator('button.done').waitFor();
    f.stage = 'verify complete clipboard text';
    assert.ok((await page.evaluate(() => navigator.clipboard.readText())).includes(original));
    f.stage = 'capture complete tool output panel';
    await f.save('upgrade-large-output-open');
  });
});

test('background compaction failure retains original target in recalled error details and Copy', { timeout: 120000 }, async t => {
  const agent = initialAgent(); agent.config.session_defaults.execution.compaction.target_percent = 1;
  const f = await browserFixture(t, { agent }), { page } = f;
  await captureFailure(f, 'upgrade-compaction-recall', async () => {
    await login(page, f.url); await bootstrap(page, f.workspace);
    await renamed(page, 'Compaction Session A');
    const a = await currentId(page);
    await send(page, 'Create the earlier large history group');
    (await f.provider.next()).finish('Keep this older record for compaction. '.repeat(3000)); await idle(page);
    await send(page, 'Retain the newer group');
    (await f.provider.next()).finish('Newer history group.'); await idle(page);
    await bootstrap(page, f.workspace); await send(page, 'Create Session B');
    (await f.provider.next()).finish('Session B ready.'); await idle(page);
    await renamed(page, 'Viewed Session B');
    const b = await currentId(page);
    await page.locator('[data-k="s' + a + '"]').click();
    await menu(page, 'Compact now');
    await page.getByRole('dialog', { name: 'Compact the context now?', exact: true }).getByRole('button', { name: 'Compact', exact: true }).click();
    const compact = await f.provider.next();
    await page.locator('[data-k="s' + b + '"]').click();
    await page.waitForFunction(() => document.getElementById('title').textContent === 'Viewed Session B');
    const cause = 'Background compaction failed.\n原始压缩错误🙂\nDiagnostic tail is retained.';
    compact.error(cause, { requestId: 'browser-compaction-request' });
    const toast = page.locator('#toasts .toast.error').filter({ hasText: 'compaction' });
    await toast.waitFor();
    assert.equal(await page.locator('#title').textContent(), 'Viewed Session B');
    await toast.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await page.locator('#nav').getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('dialog', { name: 'Settings', exact: true }).getByRole('button', { name: /Last error/ }).click();
    const details = page.getByRole('dialog', { name: 'Last error', exact: true });
    const detailText = await details.innerText();
    assert.ok(detailText.includes(a));
    for (const line of cause.split('\n')) assert.ok(detailText.includes(line));
    await f.context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await details.getByRole('button', { name: 'Copy error', exact: true }).click();
    await details.locator('button.done').waitFor();
    const copied = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
    assert.equal(copied.target.session_id, a);
    assert.equal(copied.operation.kind, 'session.compact');
    assert.ok(copied.fault.message.includes(cause));
    await f.save('upgrade-compaction-error-recall');
  });
});
