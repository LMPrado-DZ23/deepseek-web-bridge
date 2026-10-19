/**
 * Descobre os toggles de modo (Pensamento Profundo / Pesquisa) e captura o SSE
 * com raciocinio habilitado, para calibrar seletores e o parser.
 *
 *   node scripts/inspect-think.mjs [--headed] [--search]
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
const outJson = path.join(DATA_DIR, `inspect-think-${stamp}.json`);
const outSse = path.join(DATA_DIR, `sse-think-${stamp}.txt`);

const transport = new WebTransport(cfg);
const sseBodies = [];

const scanToggles = (page) => page.evaluate(() => {
  const alvo = /pensamento|pensar|think|raciocin|pesquisa|search/i;
  const vistos = [];
  for (const el of document.querySelectorAll('*')) {
    const texto = ((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '') + ' ' + (el.getAttribute('data-testid') || '')).trim();
    if (!texto || !alvo.test(texto)) continue;
    if (texto.length > 120) continue;
    const b = el.getBoundingClientRect();
    if (b.width === 0 || b.height === 0) continue;
    const cls = typeof el.className === 'string' ? el.className : '';
    vistos.push({
      tag: el.tagName.toLowerCase(),
      cls: cls.slice(0, 200),
      aria: el.getAttribute('aria-label') || '',
      title: el.getAttribute('title') || '',
      pressed: el.getAttribute('aria-pressed'),
      selected: el.getAttribute('aria-selected'),
      dataState: el.getAttribute('data-state'),
      texto: (el.innerText || '').trim().slice(0, 60),
      x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height),
      filhos: el.children.length,
    });
  }
  return vistos;
});

try {
  await transport.start({ headed });
  const page = await transport.ensurePage();

  page.on('response', async (res) => {
    if (!res.url().includes('/api/v0/chat/completion')) return;
    try {
      const txt = await res.text();
      sseBodies.push({ status: res.status(), body: txt });
      fs.appendFileSync(outSse, txt + '\n\n', 'utf8');
    } catch { /* ignore */ }
  });

  await page.goto(cfg.chatUrl, { waitUntil: 'domcontentloaded', timeout: cfg.navTimeoutMs });
  await page.waitForTimeout(4_000);

  const candidatos = await scanToggles(page);
  console.log(`\n  candidatos de toggle: ${candidatos.length}`);
  for (const c of candidatos.slice(0, 20)) {
    console.log(`    <${c.tag}> "${c.texto}" aria=${JSON.stringify(c.aria)} title=${JSON.stringify(c.title)} pressed=${c.pressed} estado=${c.dataState} cls=${c.cls.slice(0, 120)}`);
  }

  // tenta ligar o raciocinio: prefere o de menor area com texto de pensamento
  const pensamento = candidatos.filter((c) => /pensamento|pensar|think|raciocin/i.test(c.texto + ' ' + c.aria + ' ' + c.title));
  let alvo = pensamento.sort((a, b) => a.w * a.h - b.w * b.h)[0];
  let clicou = false;
  if (alvo) {
    console.log(`\n  clicando em <${alvo.tag}> "${alvo.texto || alvo.aria || alvo.title}" em (${alvo.x},${alvo.y})`);
    await page.mouse.click(alvo.x + alvo.w / 2, alvo.y + alvo.h / 2);
    await page.waitForTimeout(1_500);
    const depoisClique = await scanToggles(page);
    const mesmo = depoisClique.filter((c) => /pensamento|pensar|think|raciocin/i.test(c.texto + ' ' + c.aria + ' ' + c.title));
    console.log('  estado apos clique:');
    for (const c of mesmo.slice(0, 6)) console.log(`    "${c.texto}" pressed=${c.pressed} estado=${c.dataState} cls=${c.cls.slice(0, 120)}`);
    clicou = true;
  } else {
    console.log('\n  nenhum candidato de pensamento encontrado');
  }

  const composer = page.locator('textarea[placeholder]').first();
  await composer.click();
  await composer.fill('Quanto e 17 * 23? Responda em uma linha mostrando o calculo.');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2_000);
  // espera o fim observando o botao voltar ao estado desabilitado/estavel
  const t0 = Date.now();
  let anterior = '';
  for (let i = 0; i < 150; i++) {
    await page.waitForTimeout(500);
    const s = await page.evaluate(() => {
      const md = [...document.querySelectorAll('.ds-markdown')];
      const ult = md[md.length - 1];
      const think = [...document.querySelectorAll("[class*='think'], [class*='reason']")].filter((el) => {
        const b = el.getBoundingClientRect();
        return b.width > 0 && b.height > 0;
      }).map((el) => ({ cls: String(el.className).slice(0, 140), texto: (el.innerText || '').slice(0, 120) }));
      return { len: ult ? ult.innerText.length : 0, texto: ult ? ult.innerText : '', think, nThink: think.length };
    });
    if (s.texto === anterior && s.len > 0) { console.log(`  estavel apos ~${((Date.now() - t0) / 1000).toFixed(1)}s`); break; }
    anterior = s.texto;
  }

  const final = await page.evaluate(() => {
    const md = [...document.querySelectorAll('.ds-markdown')];
    const ult = md[md.length - 1];
    const blocos = [...document.querySelectorAll("[class*='think'], [class*='reason']")].filter((el) => {
      const b = el.getBoundingClientRect();
      return b.width > 0 && b.height > 0;
    }).map((el) => ({ cls: String(el.className).slice(0, 200), texto: (el.innerText || '').slice(0, 300), html: el.outerHTML.slice(0, 400) }));
    return {
      url: location.href,
      resposta: ult ? ult.innerText.slice(0, 600) : '',
      blocosThink: blocos,
      htmlUltimo: ult ? ult.outerHTML.slice(0, 1500) : '',
      togglesFinais: [...document.querySelectorAll('*')].filter((el) => {
        const t = ((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || '')).trim();
        if (!/pensamento|pensar|think|raciocin/i.test(t) || t.length > 120) return false;
        const b = el.getBoundingClientRect();
        return b.width > 0 && b.height > 0 && el.children.length <= 2;
      }).map((el) => ({ tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 160), aria: el.getAttribute('aria-label') || '', pressed: el.getAttribute('aria-pressed'), txt: (el.innerText || '').trim().slice(0, 40) })),
    };
  });

  // analise do SSE: tipos de fragmento e eventos de pensamento
  const tiposFragmento = new Set();
  const camposP = new Set();
  let temThinkingPatch = false;
  for (const { body } of sseBodies) {
    for (const linha of body.split(/\r?\n/)) {
      const l = linha.trim();
      if (!l.startsWith('data:')) continue;
      try {
        const d = JSON.parse(l.slice(5).trim());
        if (typeof d.p === 'string') camposP.add(d.p);
        const frags = d?.v?.response?.fragments;
        if (Array.isArray(frags)) for (const f of frags) if (f?.type) tiposFragmento.add(f.type);
        if (d.p && /think/i.test(d.p)) temThinkingPatch = true;
      } catch { /* ignore */ }
    }
  }

  fs.writeFileSync(outJson, JSON.stringify({ stamp, candidatos, clicou, alvo, final, sse: sseBodies.map((b) => ({ status: b.status, bytes: b.body.length })), tiposFragmento: [...tiposFragmento], camposP: [...camposP], temThinkingPatch }, null, 2), 'utf8');

  console.log(`\n  resposta final (${final.resposta.length} chars): ${JSON.stringify(final.resposta.slice(0, 200))}`);
  console.log(`  blocos de pensamento visiveis: ${final.blocosThink.length}`);
  for (const b of final.blocosThink.slice(0, 4)) console.log(`    cls=${b.cls} txt=${JSON.stringify(b.texto.slice(0, 100))}`);
  console.log(`  tipos de fragmento no SSE: ${JSON.stringify([...tiposFragmento])}`);
  console.log(`  caminhos p: ${JSON.stringify([...camposP])}`);
  console.log(`  patch de pensamento: ${temThinkingPatch}`);
  console.log(`  SSE: ${outSse}`);
  console.log(`  relatorio: ${outJson}\n`);
} finally {
  await transport.close();
}
