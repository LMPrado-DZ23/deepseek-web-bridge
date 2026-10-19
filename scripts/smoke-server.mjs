/**
 * Smoke test ponta a ponta: sobe `serve`, exercita /health, /v1/models,
 * um chat normal e um chat em streaming, e derruba o servidor no final.
 *
 *   node scripts/smoke-server.mjs
 *
 * Exige a sessao ja logada (node src/index.mjs login) e a porta 8787 livre.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'http://127.0.0.1:8787';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealth(timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return await r.json();
      lastErr = new Error(`health HTTP ${r.status}`);
    } catch (err) {
      lastErr = err;
    }
    await sleep(500);
  }
  throw new Error(`health nao respondeu: ${lastErr?.message || 'timeout'}`);
}

const child = spawn(process.execPath, ['src/index.mjs', 'serve'], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (d) => {
  serverLog += String(d);
});
child.stderr.on('data', (d) => {
  serverLog += String(d);
});

function fail(msg) {
  console.error(`FALHOU: ${msg}`);
  process.exitCode = 1;
}

try {
  const health = await waitHealth();
  console.log('health ok:', JSON.stringify(health));

  const models = await (await fetch(`${BASE}/v1/models`)).json();
  const ids = (models.data || []).map((m) => m.id);
  console.log('modelos:', ids.join(', '));
  if (!ids.includes('deepseek-web')) fail('modelo deepseek-web ausente em /v1/models');

  const t0 = Date.now();
  const chatRes = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-web',
      messages: [{ role: 'user', content: 'Responda apenas: ponte ok' }],
      stream: false,
    }),
  });
  const chat = await chatRes.json();
  const answer = chat?.choices?.[0]?.message?.content;
  console.log(`chat nao-stream ${chatRes.status}:`, JSON.stringify(answer), `${Date.now() - t0}ms`);
  if (!answer || !String(answer).trim()) fail('resposta vazia no chat nao-stream');
  if (chatRes.status !== 200) fail(`status ${chatRes.status} no chat nao-stream`);

  const streamRes = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-web-think',
      messages: [{ role: 'user', content: 'Quanto e 17 * 23? Responda em uma linha.' }],
      stream: true,
    }),
  });
  console.log('stream status:', streamRes.status, streamRes.headers.get('content-type'));
  if (streamRes.status !== 200) fail(`status ${streamRes.status} no stream`);
  const reader = streamRes.body.getReader();
  const dec = new TextDecoder();
  let sse = '';
  let chunks = 0;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks += 1;
    sse += dec.decode(value, { stream: true });
    if (sse.includes('[DONE]')) break;
  }
  const deltas = [...sse.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)]
    .map((m) => m[1])
    .join('')
    .replace(/\\n/g, '\n');
  const thinkDeltas = [...sse.matchAll(/"reasoning_content":"((?:[^"\\]|\\.)*)"/g)]
    .map((m) => m[1])
    .join('')
    .replace(/\\n/g, '\n');
  console.log('sse chunks:', chunks, 'bytes:', sse.length, 'tem DONE:', sse.includes('[DONE]'));
  console.log('texto dos deltas:', JSON.stringify(deltas.slice(0, 400)));
  console.log('lixo de raciocinio (deve ser 0):', deltas.includes('THINK') ? 'SIM' : 'nao');
  console.log('raciocinio em reasoning_content:', thinkDeltas.length, 'chars');
  if (!deltas.trim()) fail('nenhum delta de conteudo no streaming');
  if (!sse.includes('[DONE]')) fail('streaming terminou sem [DONE]');
} catch (err) {
  fail(err.message);
} finally {
  child.kill();
  await sleep(2_000);
  try {
    child.kill('SIGKILL');
  } catch {
    /* ignora */
  }
  console.log('--- log do servidor (fim) ---');
  console.log(serverLog.split('\n').filter(Boolean).slice(-15).join('\n'));
}
