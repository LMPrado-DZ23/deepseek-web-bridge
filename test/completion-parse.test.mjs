import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseCompletionBody, isFinishedStatus, bestText } from '../src/completion-parse.mjs';

const DATA = path.join(import.meta.dirname, '..', 'data');
const fixture = (name) => fs.readFileSync(path.join(DATA, name), 'utf8');
const sse = (events) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');

test('parseCompletionBody: eventos de patch APPEND concatenam', () => {
  const body = sse([
    { p: 'response/content', o: 'APPEND', v: 'Ola' },
    { p: 'response/content', o: 'APPEND', v: ', mundo' },
    { p: 'response/status', v: 'FINISHED' },
  ]);
  const out = parseCompletionBody(body);
  assert.equal(out.content, 'Ola, mundo');
  assert.equal(out.status, 'FINISHED');
  assert.equal(out.events, 3);
});

test('parseCompletionBody: op SET substitui o conteudo', () => {
  const body = sse([
    { p: 'response/content', v: 'rascunho' },
    { p: 'response/content', o: 'SET', v: 'final' },
  ]);
  assert.equal(parseCompletionBody(body).content, 'final');
});

test('parseCompletionBody: thinking_content separado', () => {
  const body = sse([
    { p: 'response/thinking_content', o: 'APPEND', v: 'pensando...' },
    { p: 'response/content', o: 'APPEND', v: 'resposta' },
  ]);
  const out = parseCompletionBody(body);
  assert.equal(out.thinking, 'pensando...');
  assert.equal(out.content, 'resposta');
});

test('parseCompletionBody: envelope com snapshot completo', () => {
  const body = sse([
    { v: { response: { content: 'parcial', thinking_content: 'hmm', status: 'WIP' } } },
    {
      v: {
        response: { content: 'parcial completa', thinking_content: 'hmm', status: 'FINISHED', accumulated_token_usage: 42 },
      },
    },
  ]);
  const out = parseCompletionBody(body);
  assert.equal(out.content, 'parcial completa');
  assert.equal(out.thinking, 'hmm');
  assert.equal(out.status, 'FINISHED');
  assert.equal(out.tokens, 42);
});

test('parseCompletionBody: formato real - snapshot de fragmentos + delta solto', () => {
  const body = sse([
    { v: { response: { status: 'WIP', fragments: [{ id: 2, type: 'THINK', content: 'We' }] } } },
    { v: ' need' },
    { p: 'response/fragments/-1/content', o: 'APPEND', v: ' answer' },
    { p: 'response/fragments', o: 'APPEND', v: [{ id: 3, type: 'RESPONSE', content: '17' }] },
    { v: ' x 23' },
    { p: 'response/fragments/-1/elapsed_secs', o: 'SET', v: 0.84 },
    { p: 'response/status', o: 'SET', v: 'FINISHED' },
  ]);
  const out = parseCompletionBody(body);
  assert.equal(out.thinking, 'We need answer');
  assert.equal(out.content, '17 x 23');
  assert.equal(out.fragments.length, 2);
  assert.deepEqual(out.fragments.map((f) => f.type), ['THINK', 'RESPONSE']);
  assert.equal(out.status, 'FINISHED');
});

test('parseCompletionBody: snapshot nunca encurta texto ja recebido', () => {
  const body = sse([
    { v: { response: { fragments: [{ id: 2, type: 'RESPONSE', content: 'texto longo' }] } } },
    { v: { response: { fragments: [{ id: 2, type: 'RESPONSE', content: 'texto' }] } } },
  ]);
  assert.equal(parseCompletionBody(body).content, 'texto longo');
});

test('parseCompletionBody: BATCH aplica patches internos (tokens e quasi_status)', () => {
  const body = sse([
    { p: 'response', o: 'BATCH', v: [{ p: 'accumulated_token_usage', v: 108 }, { p: 'quasi_status', v: 'FINISHED' }] },
  ]);
  const out = parseCompletionBody(body);
  assert.equal(out.tokens, 108);
  assert.equal(out.quasiStatus, 'FINISHED');
});

test('parseCompletionBody: fallback OpenAI choices/delta', () => {
  const body = sse([
    { choices: [{ delta: { content: 'oi ' } }] },
    { choices: [{ delta: { content: 'tudo bem' }, finish_reason: 'stop' }], usage: { total_tokens: 7 } },
  ]);
  const out = parseCompletionBody(body);
  assert.equal(out.content, 'oi tudo bem');
  assert.equal(out.status, 'FINISHED');
  assert.equal(out.tokens, 7);
});

test('parseCompletionBody: ignora [DONE], linhas vazias e JSON quebrado', () => {
  const body = 'data: [DONE]\n\ndata: {quebrado\n\ndata: {"p":"response/content","v":"ok"}\n\n';
  const out = parseCompletionBody(body);
  assert.equal(out.content, 'ok');
  assert.equal(out.events, 1);
});

test('parseCompletionBody: corpo vazio devolve zeros', () => {
  const out = parseCompletionBody('');
  assert.equal(out.content, '');
  assert.equal(out.thinking, '');
  assert.equal(out.status, null);
  assert.equal(out.tokens, null);
  assert.equal(out.events, 0);
  assert.deepEqual(out.fragments, []);
});

test('parseCompletionBody: fixture real sem raciocinio (capturada do site)', () => {
  const file = 'sse-2026-10-19T02-59-48-516Z.txt';
  if (!fs.existsSync(path.join(DATA, file))) return; // fixture opcional
  const out = parseCompletionBody(fixture(file));
  assert.equal(out.status, 'FINISHED');
  assert.equal(out.quasiStatus, 'FINISHED');
  assert.equal(out.tokens, 273);
  assert.equal(out.thinking, '');
  assert.deepEqual(out.fragments.map((f) => f.type), ['RESPONSE']);
  assert.match(out.content, /^O oceano cobre mais de setenta por cento/);
  assert.match(out.content, /formas de vida na Terra\.$/);
  assert.ok(out.content.length > 700);
});

test('parseCompletionBody: fixture real com raciocinio (THINK + RESPONSE)', () => {
  const file = 'sse-think-2026-10-19T03-04-49-452Z.txt';
  if (!fs.existsSync(path.join(DATA, file))) return; // fixture opcional
  const out = parseCompletionBody(fixture(file));
  assert.equal(out.status, 'FINISHED');
  assert.equal(out.tokens, 108);
  assert.deepEqual(out.fragments.map((f) => f.type), ['THINK', 'RESPONSE']);
  assert.equal(out.content, '17 × 23 = 17 × 20 + 17 × 3 = 340 + 51 = 391.');
  assert.match(out.thinking, /^We need answer in Portuguese/);
  // o raciocinio nunca pode vazar para a resposta
  assert.equal(out.content.includes('We need'), false);
});

test('isFinishedStatus: reconhece status finais', () => {
  for (const s of ['FINISHED', 'finished', 'COMPLETED', 'DONE', 'SUCCESS']) assert.equal(isFinishedStatus(s), true);
  for (const s of ['WIP', 'GENERATING', null, '']) assert.equal(isFinishedStatus(s), false);
});

test('bestText: escolhe a leitura mais completa', () => {
  assert.equal(bestText('curto', 'texto bem maior'), 'texto bem maior');
  assert.equal(bestText('texto bem maior', 'curto'), 'texto bem maior');
  assert.equal(bestText('', 'corpo'), 'corpo');
  assert.equal(bestText('dom', ''), 'dom');
  assert.equal(bestText('', ''), '');
});
