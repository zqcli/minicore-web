import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { HOST_KEY, hostFixture } from './host.mjs';

export async function browserFixture(t, { mobile = false, ...hostOptions } = {}) {
  const host = await hostFixture(hostOptions);
  let browser;
  t.after(async () => { await browser?.close(); await host.close(); });
  browser = await chromium.launch({ headless: true,
    ...(process.env.MINICORE_CHROMIUM_PATH && { executablePath: process.env.MINICORE_CHROMIUM_PATH }) });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, reducedMotion: 'reduce',
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    isMobile: mobile, hasTouch: mobile });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [], methods = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => socket.on('framesent', frame => {
    const value = JSON.parse(String(frame.payload));
    if (value.method) { methods.push(value.method); requests.push(value); }
  }));
  async function save(name, { timeout = 15000 } = {}) {
    await mkdir('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/' + name + '.png', fullPage: true, animations: 'disabled', timeout });
  }
  return { ...host, browser, context, page, errors, methods, requests, save };
}
export async function login(page, url) {
  await page.goto(url);
  await page.getByPlaceholder('Host access key').fill(HOST_KEY);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.locator('#app').waitFor({ state: 'visible' });
}
export async function bootstrap(page, workspace) {
  await page.locator('#newb').click();
  const sheet = page.getByRole('dialog', { name: 'New session', exact: true });
  if (await sheet.locator('button[data-k="start"]').isDisabled()) {
    await sheet.locator('button[data-k="n' + workspace + '"]').click();
  }
  await sheet.getByRole('button', { name: 'Start in workspace', exact: true }).click();
  await sheet.waitFor({ state: 'detached' });
  await page.locator('#sub').getByText('workspace', { exact: true }).waitFor();
}
export async function send(page, text) {
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}
export async function idle(page) { await page.locator('#pri[aria-label="Send"]').waitFor(); }
export async function menu(page, name) {
  await page.locator('#moreb').click();
  await page.getByRole('dialog').last().getByRole('button', { name, exact: true }).click();
}
