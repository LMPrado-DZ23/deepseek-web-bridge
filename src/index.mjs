#!/usr/bin/env node
/**
 * CLI da ponte.
 *   node src/index.mjs serve      -> sobe o servidor OpenAI-compativel (padrao)
 *   node src/index.mjs login      -> abre janela para login manual no chat.deepseek.com
 *   node src/index.mjs diagnose   -> inspeciona o DOM e grava relatorio/screenshot
 *   node src/index.mjs probe "oi" -> envia um prompt e imprime a resposta
 *   node src/index.mjs models     -> lista os modelos anunciados
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, loadConfig } from './config.mjs';
import { initLog, log } from './log.mjs';
import { WebTransport } from './web.mjs';
import { startServer } from './server.mjs';
import { SELECTORS } from './dom.mjs';
import { chromeUsingProfile, closeStrayChrome, openNativeChrome, waitProfileFree } from './native-login.mjs';

const argv = process.argv.slice(2);
const wantsHelp = argv.includes('--help') || argv.includes('-h');
const command = wantsHelp ? 'help' : argv[0] && !argv[0].startsWith('-') ? argv[0] : 'serve';
const rest = command === argv[0] ? argv.slice(1) : argv;

function help() {
  console.log(`deepseek-web-bridge

uso:
  node src/index.mjs serve [--port 8787] [--headed] [--log-level debug]
  node src/index.mjs login [--timeout-min 30] [--auto]
  node src/index.mjs verify [--wait] [--timeout-min 30]
  node src/index.mjs diagnose [--headed]
  node src/index.mjs probe "seu prompt" [--mode think] [--headed]
  node src/index.mjs models

variaveis: DSB_PORT DSB_HOST DSB_PROFILE_DIR DSB_BROWSER DSB_HEADLESS DSB_URL
           DSB_REQUEST_TIMEOUT_MS DSB_MAX_PROMPT_CHARS DSB_TOOL_PROTOCOL
           DSB_LOG_LEVEL DSB_LOG_FILE DSB_TOKEN
arquivo:   data/config.json (mesmas chaves dos padroes em src/config.mjs)
`);
}

function flag(name, fallback) {
  const i = rest.indexOf(name);
  if (i === -1) return fallback;
  const value = rest[i + 1];
  return value && !value.startsWith('--') ? value : true;
}

async function cmdServe() {
  const cfg = loadConfig({ argv: rest, env: process.env });
  initLog({ level: cfg.logLevel, file: cfg.logFile });
  const inst = await startServer(cfg);
  console.log(`\n  ponte pronta em ${inst.url}`);
  console.log(`  modelos: ${cfg.models.map((m) => m.id).join(', ')}`);
  console.log(`  health:  ${inst.url}/health`);
  console.log(`  perfil:  ${cfg.profileDir}\n`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    log.info('encerrando...');
    await inst.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await new Promise(() => {});
}

async function cmdLogin() {
  const cfg = loadConfig({ argv: rest, env: process.env });
  initLog({ level: cfg.logLevel, file: cfg.logFile });
  const timeoutMin = Number(flag('--timeout-min', 30)) || 30;
  // Login com Google/Apple e recusado em navegador controlado por automacao.
  // Padrao = Chrome nativo (sem CDP). `--auto` usa o Playwright antigo.
  const automatico = rest.includes('--auto');

  if (!automatico) {
    const mortos = closeStrayChrome(cfg.profileDir);
    if (mortos.length) console.log(`  encerrei ${mortos.length} chrome(s) presos no perfil da ponte.`);
    console.log('\n  Abrindo o Google Chrome normal (sem automacao) no perfil da ponte.');
    console.log('  Faca login no chat.deepseek.com — Google e Apple funcionam aqui.');
    console.log(`  Perfil: ${cfg.profileDir}`);
    console.log('  >>> Quando terminar, FECHE a janela do Chrome para a ponte verificar a sessao.\n');
    const janela = openNativeChrome({ profileDir: cfg.profileDir, url: cfg.chatUrl.replace(/\/?$/, 'sign_in'), chromePath: cfg.chromePath || process.env.CHROME_PATH });
    console.log(`  chrome: ${janela.exe}`);
    await Promise.race([
      janela.exited,
      waitProfileFree(cfg.profileDir, { timeoutMs: timeoutMin * 60_000 }),
    ]);
    console.log('\n  Janela fechada. Verificando a sessao em modo headless...');
  } else {
    const mortos = closeStrayChrome(cfg.profileDir);
    if (mortos.length) console.log(`  encerrei ${mortos.length} chrome(s) presos no perfil da ponte.`);
    const transport = new WebTransport(cfg);
    console.log('\n  Abrindo o Chrome com Playwright. Faca login no chat.deepseek.com na janela que abrir.');
    console.log('  O perfil fica salvo em:');
    console.log(`    ${cfg.profileDir}`);
    console.log('  Aguardando ate', timeoutMin, 'minutos...\n');
    let lastReport = 0;
    const result = await transport.waitForManualLogin({
      timeoutMs: timeoutMin * 60_000,
      onTick: ({ url, elapsedMs }) => {
        if (Date.now() - lastReport > 20_000) {
          lastReport = Date.now();
          console.log(`  [${Math.round(elapsedMs / 1000)}s] url: ${url}`);
        }
      },
    });
    await transport.close();
    if (!result.ok) {
      console.error(`\n  Login nao concluido (url final: ${result.url}).`);
      process.exit(2);
    }
  }

  await verifySession(cfg);
}

/** Reabre o perfil em headless e confirma que o login persistiu. */
async function verifySession(cfg) {
  console.log('\n  Verificando sessao em modo headless...');
  const check = new WebTransport(cfg);
  try {
    await check.start({ headed: false });
    const st = await check.checkLogin();
    if (st.blocked) {
      console.error(`  BLOCKED_BY_EXTERNAL_DEPENDENCY: o site respondeu com bloqueio de borda (${st.error}).`);
      console.error('  Tente de novo em alguns minutos; se o login foi concluido o perfil ja esta logado.');
      process.exit(4);
    }
    console.log(st.loggedIn ? '  OK: sessao persistida. Pode rodar "serve".' : '  ATENCAO: sessao nao persistiu.');
    fs.writeFileSync(
      path.join(DATA_DIR, 'session.json'),
      JSON.stringify({ loggedIn: st.loggedIn, at: new Date().toISOString(), url: st.url }, null, 2),
      'utf8',
    );
    process.exit(st.loggedIn ? 0 : 3);
  } finally {
    await check.close();
  }
}

async function cmdVerify() {
  const cfg = loadConfig({ argv: rest, env: process.env });
  initLog({ level: cfg.logLevel, file: cfg.logFile });
  const esperar = rest.includes('--wait');
  const timeoutMin = Number(flag('--timeout-min', 30)) || 30;
  if (esperar) {
    const emUso = chromeUsingProfile(cfg.profileDir);
    if (emUso.length) {
      console.log(`  janela de login aberta (${emUso.length} processo(s)).`);
      console.log('  faca login e FECHE a janela; a verificacao roda sozinha em seguida.');
      const livre = await waitProfileFree(cfg.profileDir, { timeoutMs: timeoutMin * 60_000 });
      if (!livre.ok) {
        console.error(`\n  Tempo esgotado (${timeoutMin} min) esperando a janela do Chrome fechar.`);
        process.exit(5);
      }
      console.log(`  janela fechada apos ${Math.round(livre.ms / 1000)}s.`);
    } else {
      console.log('  nenhuma janela de login aberta; verificando direto.');
    }
  }
  await verifySession(cfg);
}

async function cmdDiagnose() {
  const cfg = loadConfig({ argv: rest, env: process.env });
  initLog({ level: cfg.logLevel, file: cfg.logFile });
  const headed = rest.includes('--headed');
  const transport = new WebTransport(cfg);
  try {
    await transport.start({ headed });
    const out = await transport.diagnose();
    const r = out.report;
    console.log(`\n  url: ${r.url}`);
    console.log(`  titulo: ${r.title}`);
    console.log(`  login: ${out.loggedIn ? 'sim' : 'nao'}`);
    console.log('\n  seletores:');
    for (const [key, info] of Object.entries(r.selectors || {})) {
      const mark = info.found ? 'OK ' : '-- ';
      console.log(`    ${mark}${key}${info.found ? ` (${info.count} no, ${info.visible} visiveis)` : ''}`);
    }
    console.log(`\n  textareas/contenteditable visiveis: ${(r.editables || []).filter((e) => e.visible).length}`);
    for (const el of (r.editables || []).filter((e) => e.visible).slice(0, 5)) {
      console.log(`    <${el.tag}> id=${el.id || '-'} placeholder=${el.placeholder || '-'}`);
    }
    console.log('\n  sugestoes de ajuste:', suggestSelectors(r));
    console.log(`\n  relatorio: ${out.jsonFile}`);
    console.log(`  screenshot: ${out.screenshot}\n`);
  } finally {
    await transport.close();
  }
}

function suggestSelectors(report) {
  const missing = Object.entries(report.selectors || {})
    .filter(([, v]) => !v.found)
    .map(([k]) => k);
  if (!missing.length) return 'nenhuma (todos os seletores acharam algo)';
  return `sem correspondencia: ${missing.join(', ')}`;
}

async function cmdProbe() {
  const cfg = loadConfig({ argv: rest, env: process.env });
  initLog({ level: cfg.logLevel, file: cfg.logFile });
  const headed = rest.includes('--headed');
  const modeIdx = rest.indexOf('--mode');
  const mode = modeIdx !== -1 ? rest[modeIdx + 1] : 'chat';
  const positional = rest.filter((a, i) => !a.startsWith('--') && rest[i - 1] !== '--mode');
  const prompt = positional.join(' ').trim() || 'Responda apenas: ponte ok';
  console.log(`\n  modo: ${mode}`);
  console.log(`  prompt: ${prompt}\n`);
  const transport = new WebTransport(cfg);
  try {
    await transport.start({ headed });
    const st = await transport.checkLogin();
    if (!st.loggedIn) {
      console.error(`  Sem login (${st.url}). Rode primeiro: node src/index.mjs login`);
      process.exit(4);
    }
    let first = true;
    const started = Date.now();
    const result = await transport.submit({
      prompt,
      mode: mode === 'think' ? 'think' : 'chat',
      onDelta: (piece) => {
        if (first) {
          first = false;
          console.log('  --- resposta ---');
        }
        process.stdout.write(piece);
      },
    });
    console.log(`\n  --- fim (${result.source}, ${Math.round((Date.now() - started) / 1000)}s) ---`);
    if (result.thinking) {
      console.log(`\n  raciocinio (${result.thinking.length} chars):`);
      console.log(`    ${result.thinking.slice(0, 600).replace(/\n/g, '\n    ')}`);
    }
    console.log(`\n  tokens estimados: ${result.tokens}\n`);
  } finally {
    await transport.close();
  }
}

function cmdModels() {
  const cfg = loadConfig({ argv: rest, env: process.env });
  console.log(`\n  ${'id'.padEnd(22)} ${'modo'.padEnd(6)} contexto  max`);
  for (const m of cfg.models) {
    console.log(`  ${m.id.padEnd(22)} ${m.mode.padEnd(6)} ${String(m.contextWindow).padStart(8)}  ${m.maxTokens}`);
  }
  console.log(`\n  total de seletores DOM: ${Object.keys(SELECTORS).length}\n`);
}

const commands = {
  serve: cmdServe,
  login: cmdLogin,
  verify: cmdVerify,
  diagnose: cmdDiagnose,
  probe: cmdProbe,
  models: cmdModels,
  help: async () => help(),
  '--help': async () => help(),
  '-h': async () => help(),
};

const fn = commands[command];
if (!fn) {
  console.error(`comando desconhecido: ${command}\n`);
  help();
  process.exit(64);
}

Promise.resolve()
  .then(() => fn())
  .catch((err) => {
    log.error(err?.stack || err?.message || String(err));
    console.error(`\n  erro: ${err?.message || err}\n`);
    process.exit(1);
  });
