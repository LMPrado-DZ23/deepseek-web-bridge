/**
 * Inspeciona a pagina de chat ja logada e (opcionalmente) envia um prompt,
 * para calibrar src/selectors.json com dados reais.
 *
 *   node scripts/inspect-chat.mjs            -> so inspeciona a tela inicial
 *   node scripts/inspect-chat.mjs --send     -> envia "responda apenas OK" e
 *                                               inspeciona tambem a resposta
 *   node scripts/inspect-chat.mjs --headed   -> mostra a janela
 *
 * Saida: data/inspect-chat-<stamp>.json + resumo no stdout.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, loadConfig } from '../src/config.mjs';
import { initLog } from '../src/log.mjs';
import { WebTransport } from '../src/web.mjs';

const argv = process.argv.slice(2);
const enviar = argv.includes('--send');
const headed = argv.includes('--headed');
const cfg = loadConfig({ argv, env: process.env });
initLog({ level: 'warn', file: path.join(cfg.logFile) });

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outJson = path.join(DATA_DIR, `inspect-chat-${stamp}.json`);

const coletar = async (page) => {
  const info = await page.evaluate(() => {
    const visivel = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
    };
    const descrever = (el, max = 240) => {
      const attrs = [...el.attributes].map((a) => `${a.name}="${String(a.value).slice(0, 120)}"`).join(' ');
      const cls = typeof el.className === 'string' ? el.className : '';
      const txt = (el.innerText || '').trim().slice(0, max);
      return { tag: el.tagName.toLowerCase(), id: el.id || null, cls: cls.slice(0, 300), attrs, text: txt };
    };
    const textareas = [...document.querySelectorAll('textarea')].map((el) => ({
      ...descrever(el),
      visivel: visivel(el),
      placeholder: el.getAttribute('placeholder'),
      pai: el.parentElement ? descrever(el.parentElement, 120) : null,
      avo: el.parentElement?.parentElement ? descrever(el.parentElement.parentElement, 120) : null,
    }));
    const botoes = [...document.querySelectorAll("button, [role='button'], a")].filter(visivel).slice(0, 200).map((el) => descrever(el, 80));
    const editaveis = [...document.querySelectorAll("[contenteditable='true']")].map((el) => ({ ...descrever(el, 120), visivel: visivel(el) }));
    const principais = [...document.querySelectorAll('main, [class*="chat"], [class*="message"], .ds-markdown')].slice(0, 40).map((el) => ({ ...descrever(el, 120), visivel: visivel(el) }));
    return {
      url: location.href,
      title: document.title,
      bodyText: (document.body.innerText || '').slice(0, 3000),
      textareas,
      editaveis,
      botoes,
      principais,
      totalBotoes: document.querySelectorAll("button, [role='button']").length,
    };
  });
  return info;
};

const transport = new WebTransport(cfg);
try {
  await transport.start({ headed });
  const page = await transport.ensurePage();
  await page.goto(cfg.chatUrl, { waitUntil: 'domcontentloaded', timeout: cfg.navTimeoutMs });
  await page.waitForTimeout(4_000);
  const antes = await coletar(page);
  console.log(`\n  url: ${antes.url}`);
  console.log(`  textareas: ${antes.textareas.length} (visiveis: ${antes.textareas.filter((t) => t.visivel).length})`);
  for (const t of antes.textareas) {
    console.log(`    textarea visivel=${t.visivel} placeholder=${JSON.stringify(t.placeholder)} id=${t.id} cls=${t.cls.slice(0, 120)}`);
    console.log(`      pai: <${t.pai?.tag}> cls=${t.pai?.cls?.slice(0, 160)}`);
  }
  console.log(`  contenteditable visiveis: ${antes.editaveis.filter((e) => e.visivel).length}`);
  console.log(`  botoes/links visiveis: ${antes.botoes.length} (total na pagina: ${antes.totalBotoes})`);
  for (const b of antes.botoes.slice(0, 40)) {
    console.log(`    <${b.tag}> aria=${JSON.stringify(b.attrs.match(/aria-label="[^"]*"/)?.[0] || '')} cls=${b.cls.slice(0, 90)} txt=${JSON.stringify(b.text.slice(0, 40))}`);
  }

  let depois = null;
  if (enviar) {
    console.log('\n  enviando prompt de teste...');
    const composer = page.locator("textarea[placeholder]").first();
    await composer.click();
    await composer.fill('responda apenas OK');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1_200);
    const t0 = Date.now();
    while (Date.now() - t0 < 120_000) {
      const temResposta = await page.evaluate(() => document.body.innerText.includes('OK'));
      if (temResposta) break;
      await page.waitForTimeout(800);
    }
    await page.waitForTimeout(1_500);
    depois = await coletar(page);
    console.log('\n  --- apos a resposta ---');
    console.log(`  bodyText: ${JSON.stringify(depois.bodyText.slice(0, 800))}`);
    console.log(`  botoes visiveis: ${depois.botoes.length}`);
    for (const b of depois.botoes.slice(0, 30)) {
      console.log(`    <${b.tag}> aria=${JSON.stringify(b.attrs.match(/aria-label="[^"]*"/)?.[0] || '')} cls=${b.cls.slice(0, 90)} txt=${JSON.stringify(b.text.slice(0, 40))}`);
    }
    console.log(`  containers principais: ${depois.principais.length}`);
    for (const p of depois.principais.slice(0, 25)) {
      console.log(`    <${p.tag}> cls=${p.cls.slice(0, 140)} txt=${JSON.stringify(p.text.slice(0, 50))}`);
    }
  }

  fs.writeFileSync(outJson, JSON.stringify({ stamp, antes, depois }, null, 2), 'utf8');
  await page.screenshot({ path: outJson.replace(/\.json$/, '.png'), fullPage: false }).catch(() => {});
  console.log(`\n  relatorio: ${outJson}\n`);
} finally {
  await transport.close();
}
