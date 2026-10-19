/**
 * Inspeciona a tela de login: o que o site mostra, erros de console e
 * requisicoes que falharam. Nao digita nada, nao envia nada.
 *   node scripts/inspect-signin.mjs [--headed]
 */
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';

const headed = process.argv.includes('--headed');
const PROFILE = path.join(process.env.LOCALAPPDATA, 'dsh-deepseek-web', 'chrome-profile');
const OUT = path.join(process.cwd(), 'data');
fs.mkdirSync(OUT, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

const context = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome',
  headless: !headed,
  locale: 'pt-BR',
  viewport: { width: 1360, height: 900 },
  args: ['--disable-blink-features=AutomationControlled'],
});
const page = context.pages()[0] || (await context.newPage());

const consoleMsgs = [];
const failed = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') consoleMsgs.push(`${m.type()}: ${m.text().slice(0, 300)}`);
});
page.on('requestfailed', (r) =>
  failed.push(`${r.method()} ${r.url().slice(0, 160)} -> ${r.failure()?.errorText}`),
);
page.on('response', (r) => {
  if (r.status() >= 400) failed.push(`HTTP ${r.status()} ${r.url().slice(0, 160)}`);
});

const resp = await page.goto('https://chat.deepseek.com/sign_in', {
  waitUntil: 'domcontentloaded',
  timeout: 45_000,
});
await page.waitForTimeout(5_000);

const info = {
  stamp,
  status: resp?.status() ?? null,
  url: page.url(),
  title: await page.title(),
  bodyText: (await page.evaluate(() => document.body?.innerText || '')).slice(0, 4_000),
  console: consoleMsgs.slice(0, 40),
  networkProblems: failed.slice(0, 40),
  hasPasswordInput: await page.locator('input[type=password]').count(),
  buttons: await page.evaluate(() =>
    Array.from(document.querySelectorAll('button, [role=button], a')).slice(0, 40).map((el) => (el.innerText || '').trim().slice(0, 60)),
  ),
};

fs.writeFileSync(path.join(OUT, `signin-${stamp}.json`), JSON.stringify(info, null, 2), 'utf8');
await page.screenshot({ path: path.join(OUT, `signin-${stamp}.png`), fullPage: false });
await context.close();

console.log(JSON.stringify(info, null, 2));
