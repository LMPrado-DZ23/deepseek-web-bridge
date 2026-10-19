/**
 * Captura o comportamento real de streaming do chat.deepseek.com:
 *  - corpo SSE de /api/v0/chat/completion (para validar src/completion-parse.mjs)
 *  - evolucao do DOM durante a resposta (bolha do assistente, botao enviar/parar)
 *
 *   node scripts/inspect-stream.mjs [--headed]
 *
 * Saida: data/inspect-stream-<stamp>.json (+ sse-*.txt)
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, loadConfig } from '../src/config.mjs';
import { initLog } from '../src/log.mjs';
import { WebTransport } from '../src/web.mjs';

const argv = process.argv.slice(2);
const headed = argv.includes('--headed');
const cfg = loadConfig({ argv, env: process.env });
initLog({ level: 'warn', file: cfg.logFile });

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outJson = path.join(DATA_DIR, `inspect-stream-${stamp}.json`);
const outSse = path.join(DATA_DIR, `sse-${stamp}.txt`);

const prompt = 'Escreva um paragrafo de umas 120 palavras sobre o oceano, sem listas.';

const transport = new WebTransport(cfg);
const sseBodies = [];
const amostras = [];

try {
  await transport.start({ headed });
  const page = await transport.ensurePage();

  page.on('response', async (res) => {
    const u = res.url();
    if (!u.includes('/api/v0/chat/completion')) return;
    try {
      const txt = await res.text();
      sseBodies.push({ url: u, status: res.status(), body: txt });
      fs.appendFileSync(outSse, `### ${res.status()} ${u}\n${txt}\n\n`, 'utf8');
    } catch { /* corpo ja consumido */ }
  });

  await page.goto(cfg.chatUrl, { waitUntil: 'domcontentloaded', timeout: cfg.navTimeoutMs });
  await page.waitForTimeout(4_000);

  const composer = page.locator('textarea[placeholder]').first();
  await composer.click();
  await composer.fill(prompt);

  const candidatos = ["div.ds-button--circle", "div.ds-button--primary", "button", "div[role='button']"];
  const antes = await page.evaluate((sels) => {
    const r = {};
    for (const s of sels) {
      r[s] = [...document.querySelectorAll(s)].filter((el) => {
        const b = el.getBoundingClientRect();
        return b.width > 0 && b.height > 0;
      }).map((el) => {
        const b = el.getBoundingClientRect();
        return { cls: el.className, x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), txt: (el.innerText || '').trim().slice(0, 30), aria: el.getAttribute('aria-label') || '' };
      });
    }
    return r;
  }, candidatos);

  await page.keyboard.press('Enter');
  const t0 = Date.now();
  let ultimoTexto = '';
  for (let i = 0; i < 120; i++) {
    await page.waitForTimeout(400);
    const s = await page.evaluate(() => {
      const md = [...document.querySelectorAll('.ds-markdown')];
      const ult = md[md.length - 1];
      const bubble = ult?.closest('.ds-message');
      const circulares = [...document.querySelectorAll("div[class*='ds-button']")].filter((el) => {
        const b = el.getBoundingClientRect();
        return b.width > 0 && b.height > 0;
      }).map((el) => el.className).filter((c) => c.includes('circle'));
      return {
        t: Date.now(),
        nMarkdown: md.length,
        textoUltimo: ult ? ult.innerText.slice(0, 200) : '',
        tamanho: ult ? ult.innerText.length : 0,
        bubbleCls: bubble ? bubble.className : null,
        bubbleAttrs: bubble ? [...bubble.attributes].map((a) => `${a.name}=${String(a.value).slice(0, 60)}`) : [],
        circulares,
        status: bubble ? bubble.getAttribute('data-status') || bubble.getAttribute('data-state') || null : null,
      };
    });
    s.tRel = s.t - t0;
    amostras.push(s);
    if (s.textoUltimo !== ultimoTexto) ultimoTexto = s.textoUltimo;
    // para quando o botao circular de enviar volta a aparecer sozinho
    if (i > 3 && s.circulares.some((c) => c.includes('ds-button--primary')) && s.textoUltimo.endsWith('.')) break;
  }

  const depois = await page.evaluate(() => {
    const md = [...document.querySelectorAll('.ds-markdown')];
    const ult = md[md.length - 1];
    const bubble = ult?.closest('.ds-message');
    return {
      url: location.href,
      nMarkdown: md.length,
      textoFinal: ult ? ult.innerText : '',
      bubbleCls: bubble ? bubble.className : null,
      bubbleAttrs: bubble ? [...bubble.attributes].map((a) => `${a.name}=${String(a.value).slice(0, 80)}`) : [],
      htmlUltimo: ult ? ult.outerHTML.slice(0, 1200) : '',
      bodyTail: document.body.innerText.slice(-600),
    };
  });

  fs.writeFileSync(outJson, JSON.stringify({ stamp, prompt, candidatosAntes: antes, amostras, depois, sse: sseBodies.map((b) => ({ url: b.url, status: b.status, bytes: b.body.length })) }, null, 2), 'utf8');

  console.log(`\n  url final: ${depois.url}`);
  console.log(`  mensagens .ds-markdown: ${depois.nMarkdown}`);
  console.log(`  texto final (${depois.textoFinal.length} chars): ${JSON.stringify(depois.textoFinal.slice(0, 300))}`);
  console.log(`  bubbleCls: ${depois.bubbleCls}`);
  console.log(`  bubbleAttrs: ${depois.bubbleAttrs.join(' | ')}`);
  console.log('\n  --- candidatos de botao ANTES do envio ---');
  for (const [sel, lista] of Object.entries(antes)) {
    console.log(`    ${sel}: ${lista.length}`);
    for (const el of lista.slice(0, 6)) console.log(`      y=${el.y} x=${el.x} w=${el.w} aria=${JSON.stringify(el.aria)} txt=${JSON.stringify(el.txt)} cls=${el.cls.slice(0, 70)}`);
  }
  console.log('\n  --- amostras durante o streaming ---');
  const marcos = [];
  let anterior = -1;
  for (const s of amostras) {
    if (s.tamanho !== anterior) {
      marcos.push(s);
      anterior = s.tamanho;
    }
  }
  for (const s of marcos.slice(0, 8)) console.log(`    +${s.tRel}ms len=${s.tamanho} nMd=${s.nMarkdown} circulares=${JSON.stringify(s.circulares)} txt=${JSON.stringify(s.textoUltimo.slice(0, 60))}`);
  console.log(`    ... total de marcos de crescimento: ${marcos.length}`);
  console.log(`\n  SSE capturado: ${sseBodies.length} resposta(s) -> ${outSse}`);
  console.log(`  relatorio: ${outJson}\n`);
} finally {
  await transport.close();
}
