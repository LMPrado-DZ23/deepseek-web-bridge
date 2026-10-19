import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { Bridge } from '../src/server.mjs';
import { BridgeError } from '../src/web.mjs';

const weatherTool = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Consulta o clima',
    parameters: { type: 'object', properties: { city: { type: 'string' } } },
  },
};

function makeCfg(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsb-test-'));
  const cfg = loadConfig({ argv: ['--profile-dir', dir, '--port', '0', '--headless'], env: {} });
  return Object.assign(cfg, extra);
}

function fakeTransport(opts = {}) {
  const {
    text = 'resposta da web',
    chunks = null,
    thinking = '',
    error = null,
    source = 'dom',
    elapsedMs = 12,
  } = opts;
  const t = {
    context: {},
    busy: false,
    last: null,
    async start() {},
    async close() {},
    async checkLogin() {
      return { loggedIn: true, url: 'https://chat.deepseek.com/' };
    },
    async submit({ prompt, mode, onDelta }) {
      t.last = { prompt, mode };
      if (error) throw error;
      const pieces = chunks ?? [text];
      for (const p of pieces) onDelta?.(p);
      return { text, thinking, tokens: 10, status: 'FINISHED', url: 'https://chat.deepseek.com/', elapsedMs, source };
    },
  };
  return t;
}

async function withServer(transport, fn, cfgExtra = {}) {
  const cfg = makeCfg(cfgExtra);
  const bridge = new Bridge(cfg);
  bridge.transport = transport;
  const server = http.createServer();
  bridge.attach(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ base, bridge, cfg, transport });
  } finally {
    if (bridge.idleTimer) clearTimeout(bridge.idleTimer);
    await new Promise((resolve) => server.close(resolve));
  }
}

const post = (base, body, headers = {}) =>
  fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

function parseSse(body) {
  const events = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    if (payload === '[DONE]') {
      events.push({ done: true });
      continue;
    }
    events.push(JSON.parse(payload));
  }
  return events;
}

test('GET /v1/models anuncia os modelos configurados', async () => {
  await withServer(fakeTransport(), async ({ base }) => {
    const res = await fetch(`${base}/v1/models`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.object, 'list');
    const ids = json.data.map((m) => m.id);
    assert.ok(ids.includes('deepseek-web'));
    assert.ok(ids.includes('deepseek-web-think'));
    const model = json.data.find((m) => m.id === 'deepseek-web');
    assert.equal(model.owned_by, 'deepseek-web');
    assert.equal(model.context_window, 131072);
  });
});

test('GET /health responde sem tocar no navegador', async () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  await withServer(fakeTransport(), async ({ base }) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.equal(json.version, pkg.version);
    assert.equal(json.queue.max, 8);
    assert.ok(Array.isArray(json.models));
  });
});

test('POST /v1/chat/completions (nao-stream) devolve envelope OpenAI', async () => {
  const transport = fakeTransport({ text: 'Ola do navegador', thinking: 'pensei', elapsedMs: 40 });
  await withServer(transport, async ({ base }) => {
    const res = await post(base, {
      model: 'deepseek-web',
      messages: [{ role: 'user', content: 'responda ola' }],
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.object, 'chat.completion');
    assert.equal(json.choices[0].message.role, 'assistant');
    assert.equal(json.choices[0].message.content, 'Ola do navegador');
    assert.equal(json.choices[0].message.reasoning_content, 'pensei');
    assert.equal(json.choices[0].finish_reason, 'stop');
    assert.ok(json.usage.total_tokens > 0);
    assert.equal(transport.last.mode, 'chat');
    assert.match(transport.last.prompt, /responda ola/);
  });
});

test('modelo think e enviado em modo think', async () => {
  const transport = fakeTransport();
  await withServer(transport, async ({ base }) => {
    const res = await post(base, {
      model: 'deepseek-web-think',
      messages: [{ role: 'user', content: 'oi' }],
    });
    assert.equal(res.status, 200);
    assert.equal(transport.last.mode, 'think');
  });
});

test('POST stream entrega deltas e termina com [DONE]', async () => {
  const transport = fakeTransport({ text: 'um dois tres', chunks: ['um ', 'dois ', 'tres'] });
  await withServer(transport, async ({ base }) => {
    const res = await post(base, {
      model: 'deepseek-web',
      stream: true,
      messages: [{ role: 'user', content: 'conte' }],
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const body = await res.text();
    const events = parseSse(body);
    const content = events
      .filter((e) => !e.done && e.choices?.[0]?.delta?.content)
      .map((e) => e.choices[0].delta.content)
      .join('');
    assert.equal(content, 'um dois tres');
    const finish = events.find((e) => !e.done && e.choices?.[0]?.finish_reason === 'stop');
    assert.ok(finish, 'deve haver chunk de finish_reason stop');
    assert.ok(finish.usage.total_tokens > 0);
    assert.equal(events[events.length - 1].done, true);
  });
});

test('tool_calls: bloco na resposta vira finish_reason tool_calls (stream)', async () => {
  const transport = fakeTransport({
    text: '```tool_calls\n{"calls":[{"name":"get_weather","arguments":{"city":"Recife"}}]}\n```',
  });
  await withServer(transport, async ({ base }) => {
    const res = await post(base, {
      model: 'deepseek-web',
      stream: true,
      messages: [{ role: 'user', content: 'clima em recife?' }],
      tools: [weatherTool],
    });
    assert.equal(res.status, 200);
    const events = parseSse(await res.text());
    const callChunk = events.find((e) => !e.done && e.choices?.[0]?.delta?.tool_calls);
    assert.ok(callChunk, 'deve emitir chunk de tool_calls');
    assert.equal(callChunk.choices[0].delta.tool_calls[0].function.name, 'get_weather');
    const finish = events.find((e) => !e.done && e.choices?.[0]?.finish_reason);
    assert.equal(finish.choices[0].finish_reason, 'tool_calls');
  });
});

test('tool_calls: tambem no modo nao-stream', async () => {
  const transport = fakeTransport({
    text: '```tool_calls\n{"calls":[{"name":"get_weather","arguments":{"city":"Natal"}}]}\n```',
  });
  await withServer(transport, async ({ base }) => {
    const res = await post(base, {
      model: 'deepseek-web',
      messages: [{ role: 'user', content: 'clima?' }],
      tools: [weatherTool],
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.choices[0].finish_reason, 'tool_calls');
    assert.equal(json.choices[0].message.tool_calls[0].function.name, 'get_weather');
  });
});

test('tool_calls: sintaxe DSML deformada vira tool_calls e nao aparece no conteudo', async () => {
  const dsml = [
    '< | | DSML | | calls> < | | DSML | | invoke name="get_weather">',
    '< | | DSML | | parameter name="city" string="true">Recife</ | | DSML | | parameter>',
    '</ | | DSML | | invoke> </ | | DSML | | calls>',
  ].join(' ');
  const transport = fakeTransport({ text: dsml, chunks: [dsml] });
  await withServer(transport, async ({ base }) => {
    const res = await post(base, {
      model: 'deepseek-web',
      stream: true,
      messages: [{ role: 'user', content: 'clima?' }],
      tools: [weatherTool],
    });
    assert.equal(res.status, 200);
    const events = parseSse(await res.text());
    const callChunk = events.find((e) => !e.done && e.choices?.[0]?.delta?.tool_calls);
    assert.ok(callChunk, 'deve emitir tool_calls a partir do DSML');
    assert.equal(callChunk.choices[0].delta.tool_calls[0].function.name, 'get_weather');
    const conteudo = events
      .filter((e) => !e.done && typeof e.choices?.[0]?.delta?.content === 'string')
      .map((e) => e.choices[0].delta.content)
      .join('');
    assert.doesNotMatch(conteudo, /DSML/, 'markup de ferramenta nao pode vazar como conteudo');
    const finish = events.find((e) => !e.done && e.choices?.[0]?.finish_reason);
    assert.equal(finish.choices[0].finish_reason, 'tool_calls');
  });
});

test('tool_calls: bloco cercado nao vaza como conteudo no streaming', async () => {
  const bloco = '```tool_calls\n{"calls":[{"name":"get_weather","arguments":{"city":"Natal"}}]}\n```';
  const transport = fakeTransport({ text: bloco, chunks: [bloco.slice(0, 20), bloco.slice(20)] });
  await withServer(transport, async ({ base }) => {
    const res = await post(base, {
      model: 'deepseek-web',
      stream: true,
      messages: [{ role: 'user', content: 'clima?' }],
      tools: [weatherTool],
    });
    assert.equal(res.status, 200);
    const events = parseSse(await res.text());
    const conteudo = events
      .filter((e) => !e.done && typeof e.choices?.[0]?.delta?.content === 'string')
      .map((e) => e.choices[0].delta.content)
      .join('');
    assert.doesNotMatch(conteudo, /```|tool_calls/, 'bloco de ferramenta nao pode virar texto');
    const callChunk = events.find((e) => !e.done && e.choices?.[0]?.delta?.tool_calls);
    assert.ok(callChunk);
  });
});

test('modelo desconhecido devolve 404 model_not_found', async () => {
  await withServer(fakeTransport(), async ({ base }) => {
    const res = await post(base, { model: 'nao-existe', messages: [{ role: 'user', content: 'oi' }] });
    assert.equal(res.status, 404);
    const json = await res.json();
    assert.equal(json.error.code, 'model_not_found');
  });
});

test('messages ausente devolve 400', async () => {
  await withServer(fakeTransport(), async ({ base }) => {
    const res = await post(base, { model: 'deepseek-web' });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'missing_messages');
  });
});

test('JSON invalido devolve 400 bad_json', async () => {
  await withServer(fakeTransport(), async ({ base }) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{nao e json',
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'BAD_JSON');
  });
});

test('erro de login em requisicao nao-stream vira 401', async () => {
  const transport = fakeTransport({ error: new BridgeError('LOGIN_REQUIRED', 'faca login') });
  await withServer(transport, async ({ base }) => {
    const res = await post(base, { model: 'deepseek-web', messages: [{ role: 'user', content: 'oi' }] });
    assert.equal(res.status, 401);
    const json = await res.json();
    assert.equal(json.error.code, 'login_required');
  });
});

test('erro de login em stream tambem devolve 401 (antes do primeiro token)', async () => {
  const transport = fakeTransport({ error: new BridgeError('LOGIN_REQUIRED', 'faca login') });
  await withServer(transport, async ({ base }) => {
    const res = await post(base, {
      model: 'deepseek-web',
      stream: true,
      messages: [{ role: 'user', content: 'oi' }],
    });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'login_required');
  });
});

test('erro WEB_ERROR vira 502', async () => {
  const transport = fakeTransport({ error: new BridgeError('WEB_ERROR', 'site recusou') });
  await withServer(transport, async ({ base }) => {
    const res = await post(base, { model: 'deepseek-web', messages: [{ role: 'user', content: 'oi' }] });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error.code, 'upstream_error');
  });
});

test('fila cheia responde 429 queue_full', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const transport = fakeTransport();
  transport.submit = async () => {
    await gate;
    return { text: 'ok', thinking: '', tokens: 1, status: 'FINISHED', elapsedMs: 1, source: 'dom' };
  };
  await withServer(
    transport,
    async ({ base }) => {
      const first = post(base, { model: 'deepseek-web', messages: [{ role: 'user', content: '1' }] });
      await new Promise((r) => setTimeout(r, 100));
      const second = await post(base, { model: 'deepseek-web', messages: [{ role: 'user', content: '2' }] });
      assert.equal(second.status, 429);
      assert.equal((await second.json()).error.code, 'queue_full');
      release();
      const firstRes = await first;
      assert.equal(firstRes.status, 200);
    },
    { maxQueue: 1 },
  );
});

test('rota desconhecida devolve 404', async () => {
  await withServer(fakeTransport(), async ({ base }) => {
    const res = await fetch(`${base}/nada`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, 'not_found');
  });
});

test('token opcional protege as rotas da API', async () => {
  await withServer(
    fakeTransport(),
    async ({ base }) => {
      const semToken = await fetch(`${base}/v1/models`);
      assert.equal(semToken.status, 401);
      assert.equal((await semToken.json()).error.code, 'unauthorized');

      const comToken = await fetch(`${base}/v1/models`, {
        headers: { Authorization: 'Bearer segredo-local' },
      });
      assert.equal(comToken.status, 200);

      const health = await fetch(`${base}/health`);
      assert.equal(health.status, 200);
    },
    { token: 'segredo-local' },
  );
});

test('OPTIONS responde CORS 204', async () => {
  await withServer(fakeTransport(), async ({ base }) => {
    const res = await fetch(`${base}/v1/chat/completions`, { method: 'OPTIONS' });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });
});
