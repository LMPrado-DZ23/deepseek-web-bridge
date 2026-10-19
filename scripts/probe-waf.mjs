/**
 * Sonda descartavel: descobre qual combinacao (headless/headed, UA) passa pelo
 * CloudFront/WAF do chat.deepseek.com. Nao faz login nem envia nada.
 *   node scripts/probe-waf.mjs
 */
import { chromium } from 'playwright-core';
import path from 'node:path';

const PROFILE = path.join(process.env.LOCALAPPDATA, 'dsh-deepseek-web', 'chrome-profile');
const CHROME_VERSION = process.argv[2] || '155.0.0.0';
const UA =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
  `Chrome/${CHROME_VERSION} Safari/537.36`;

const CONFIGS = [
  { label: 'headless + UA real', headless: true, userAgent: UA },
  { label: 'headless sem UA custom', headless: true, userAgent: null },
  { label: 'headed + UA real', headless: false, userAgent: UA },
];

for (const cfg of CONFIGS) {
  let context;
  try {
    context = await chromium.launchPersistentContext(PROFILE, {
      channel: 'chrome',
      headless: cfg.headless,
      locale: 'pt-BR',
      timezoneId: 'America/Sao_Paulo',
      ...(cfg.userAgent ? { userAgent: cfg.userAgent } : {}),
      args: ['--disable-blink-features=AutomationControlled', '--no-first-run'],
    });
    const page = context.pages()[0] || (await context.newPage());
    const resp = await page.goto('https://chat.deepseek.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });
    await page.waitForTimeout(2_500);
    const title = await page.title();
    const url = page.url();
    const body = (await page.evaluate(() => document.body?.innerText || '')).replace(/\s+/g, ' ').slice(0, 160);
    console.log(`\n== ${cfg.label} ==`);
    console.log(`  status: ${resp?.status() ?? '?'}  url: ${url}`);
    console.log(`  title : ${title}`);
    console.log(`  body  : ${body}`);
  } catch (err) {
    console.log(`\n== ${cfg.label} ==\n  ERRO: ${err.message.split('\n')[0]}`);
  } finally {
    await context?.close().catch(() => {});
  }
}
