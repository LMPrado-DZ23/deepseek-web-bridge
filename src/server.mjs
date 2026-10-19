/**
 * Servidor HTTP local OpenAI-compativel.
 * Rotas: GET /health, GET /v1/models, POST /v1/chat/completions (stream e nao-stream).
 * Escuta apenas em loopback por padrao.
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { BridgeError, WebTransport } from './web.mjs';
import { buildPrompt, parseToolCalls } from './prompt.mjs';
import { modelById } from './config.mjs';
import { log } from './log.mjs';

const VERSION = '0.1.0';

class SerialQueue {
  constructor(max) {
    this.max = max;
    this.pending = [];
    this.active = false;
    this.waiters = [];
  }

  get size() {
    return this.pending.length + (this.active ? 1 : 0);
  }

  run(fn) {
    if (this.size >= this.max) {
      return Promise.reject(new BridgeError('QUEUE_FULL', `fila cheia (${this.size} requisicoes)`));
    }
    return new Promise((resolve, reject) => {
      this.pending.push({ fn, resolve, reject });
      this.#tick();
    });
  }

  #tick() {
    if (this.active) return;
    const item = this.pending.shift();
    if (!item) return;
    this.active = true;
    Promise.resolve()
      .then(item.fn)
      .then(item.resolve, item.reject)
      .finally(() => {
        this.active = false;
        this.#tick();
      });
  }
}

function writeJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function apiError(res, status, message, code = 'bad_request', type = 'invalid_request_error') {
  writeJson(res, status, { error: { message, type, code, param: null } });
}

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > limitBytes) {
        reject(new BridgeError('PAYLOAD_TOO_LARGE', 'corpo da requisicao grande demais'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new BridgeError('BAD_JSON', `JSON invalido: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-api-key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function usageFrom(text, promptText) {
  const prompt = Math.max(1, Math.ceil(String(promptText || '').length / 3.6));
  const completion = Math.max(1, Math.ceil(String(text || '').length / 3.6));
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

export class Bridge {
  constructor(cfg) {
    this.cfg = cfg;
    this.transport = new WebTransport(cfg);
    this.queue = new SerialQueue(cfg.maxQueue);
    this.startedAt = Date.now();
    this.lastLogin = { loggedIn: null, at: null, url: null };
    this.idleTimer = null;
    this.server = null;
  }

  tokenFrom(req) {
    const expected = this.cfg.token || process.env.DSB_TOKEN;
    if (!expected) return true;
    const auth = String(req.headers.authorization || '');
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const header = String(req.headers['x-bridge-token'] || '').trim();
    return bearer === expected || header === expected;
  }

  touch() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (!this.cfg.idleCloseMs || this.cfg.idleCloseMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      if (!this.transport.busy) this.transport.close().catch(() => {});
    }, this.cfg.idleCloseMs);
    this.idleTimer.unref?.();
  }

  async warmup() {
    try {
      // Entra na fila serial: sem isso o goto do checkLogin corre em paralelo com
      // o goto do primeiro turno na mesma aba e o Chrome aborta uma das navegacoes.
      const st = await this.queue.run(async () => {
        await this.transport.start();
        return this.transport.checkLogin();
      });
      this.lastLogin = { loggedIn: st.loggedIn, at: Date.now(), url: st.url };
      if (st.loggedIn) log.info('sessao do chat.deepseek.com ativa');
      else log.warn(`sem login no chat.deepseek.com (${st.url}). Rode: node src/index.mjs login`);
    } catch (err) {
      log.error(`warmup falhou: ${err.message}`);
    }
    this.touch();
  }

  async health({ deep = false } = {}) {
    if (deep && !this.transport.busy && this.queue.size === 0) {
      try {
        const st = await this.queue.run(() => this.transport.checkLogin());
        this.lastLogin = { loggedIn: st.loggedIn, at: Date.now(), url: st.url };
      } catch (err) {
        log.debug(`checkLogin no health falhou: ${err.message}`);
      }
    }
    return {
      ok: true,
      version: VERSION,
      pid: process.pid,
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      browser: {
        started: Boolean(this.transport.context),
        busy: this.transport.busy,
        profileDir: this.cfg.profileDir,
      },
      login: this.lastLogin,
      queue: { size: this.queue.size, max: this.cfg.maxQueue },
      models: this.cfg.models.map((m) => m.id),
    };
  }

  modelsPayload() {
    const created = Math.floor(this.startedAt / 1000);
    return {
      object: 'list',
      data: this.cfg.models.map((m) => ({
        id: m.id,
        object: 'model',
        created,
        owned_by: 'deepseek-web',
        context_window: m.contextWindow,
        max_tokens: m.maxTokens,
      })),
    };
  }

  /**
   * Executa um turno: monta prompt, chama o navegador, aplica protocolo de ferramentas.
   * @returns {Promise<{text:string, thinking:string, toolCalls:any[], usage:any, elapsedMs:number}>}
   */
  async turn(body, { onDelta, onThinking, signal } = {}) {
    const modelId = String(body.model || this.cfg.models[0].id);
    const model = modelById(this.cfg, modelId);
    if (!model) throw new BridgeError('MODEL_NOT_FOUND', `modelo desconhecido: ${modelId}`);
    // O cliente pode desistir antes de a vez chegar na fila. Nao vale abrir o
    // navegador e gastar um turno do site para um pedido que ja morreu.
    if (signal?.aborted) throw new BridgeError('ABORTED', 'requisicao cancelada pelo cliente');

    const { prompt } = buildPrompt(body.messages, {
      maxChars: this.cfg.maxPromptChars,
      tools: body.tools,
      toolProtocol: this.cfg.toolProtocol,
    });

    const result = await this.queue.run(() =>
      this.transport.submit({
        prompt,
        mode: model.mode,
        onDelta,
        onThinking,
        signal,
      }),
    );

    let text = String(result.text || '').trim();
    let toolCalls = [];
    if (this.cfg.toolProtocol && Array.isArray(body.tools) && body.tools.length > 0) {
      const parsed = parseToolCalls(text, body.tools);
      if (parsed.toolCalls.length) {
        toolCalls = parsed.toolCalls;
        text = parsed.text;
      }
    }

    // Trilha de auditoria: quem chamou, qual modelo, quanto tempo e de onde veio
    // o texto (network+dom). Sem isso nao da para diferenciar "DSH nao chamou a
    // ponte" de "a ponte respondeu vazio".
    log.info(
      `turno modelo=${model.id} prompt=${prompt.length}ch resposta=${text.length}ch ` +
        `thinking=${String(result.thinking || '').length}ch ferramentas=${toolCalls.length} ` +
        `fonte=${result.source || '?'} ${Number(result.elapsedMs || 0)}ms`,
    );

    return {
      text,
      thinking: String(result.thinking || '').trim(),
      toolCalls,
      usage: usageFrom(text, prompt),
      elapsedMs: result.elapsedMs,
      source: result.source,
    };
  }

  async handleChat(req, res) {
    let body;
    try {
      body = await readBody(req, 64 * 1024 * 1024);
    } catch (err) {
      return apiError(res, err.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400, err.message, err.code || 'bad_request');
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return apiError(res, 400, 'messages[] e obrigatorio', 'missing_messages');
    }

    const modelId = String(body.model || this.cfg.models[0].id);
    if (!modelById(this.cfg, modelId)) {
      return apiError(res, 404, `modelo desconhecido: ${modelId}`, 'model_not_found');
    }

    const stream = body.stream === true;
    const ac = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) ac.abort();
    });

    if (!stream) {
      try {
        this.touch();
        const turn = await this.turn(body, { signal: ac.signal });
        const message = { role: 'assistant', content: turn.text };
        if (turn.thinking) message.reasoning_content = turn.thinking;
        if (turn.toolCalls.length) message.tool_calls = turn.toolCalls;
        return writeJson(res, 200, {
          id: `chatcmpl-${randomUUID()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: modelId,
          choices: [
            {
              index: 0,
              message,
              finish_reason: turn.toolCalls.length ? 'tool_calls' : 'stop',
            },
          ],
          usage: turn.usage,
        });
      } catch (err) {
        const { status, code } = mapError(err);
        const logFn = String(code).toLowerCase() === 'aborted' ? log.info : log.error;
        logFn(`completion ${String(code).toLowerCase() === 'aborted' ? 'cancelado' : 'falhou'} [${code}]: ${err.message}`);
        return apiError(res, status, err.message, code, status >= 500 ? 'api_error' : 'invalid_request_error');
      }
    }

    // ---- streaming ----
    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const streamStartedAt = Date.now();
    let started = false;
    let closed = false;
    let sentChars = 0;
    let sentThink = 0;
    log.info(`stream inicio modelo=${modelId} mensagens=${body.messages.length} ferramentas=${Array.isArray(body.tools) ? body.tools.length : 0}`);

    const chunk = (delta, finishReason = null, extra = {}) => ({
      id,
      object: 'chat.completion.chunk',
      created,
      model: modelId,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      ...extra,
    });

    const writeEvent = (payload) => {
      if (closed) return;
      try {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch {
        closed = true;
      }
    };

    const ensureStream = () => {
      if (started || closed) return;
      started = true;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      writeEvent(chunk({ role: 'assistant', content: '' }));
      const keepAlive = setInterval(() => {
        if (started && !closed) {
          try {
            res.write(': keep-alive\n\n');
          } catch {
            closed = true;
          }
        }
      }, 15_000);
      keepAlive.unref?.();
      res.on('close', () => clearInterval(keepAlive));
    };

    try {
      this.touch();
      const turn = await this.turn(body, {
        signal: ac.signal,
        onThinking: (piece) => {
          if (!piece) return;
          sentThink += piece.length;
          ensureStream();
          writeEvent(chunk({ reasoning_content: piece }));
        },
        onDelta: (piece) => {
          if (!piece) return;
          sentChars += piece.length;
          ensureStream();
          writeEvent(chunk({ content: piece }));
        },
      });
      ensureStream();
      if (!turn.text && !turn.toolCalls.length && !turn.thinking) {
        throw new BridgeError('EMPTY_ANSWER', 'o modelo nao retornou texto');
      }
      if (turn.toolCalls.length) {
        for (let i = 0; i < turn.toolCalls.length; i++) {
          const call = turn.toolCalls[i];
          writeEvent(
            chunk({
              tool_calls: [
                {
                  index: i,
                  id: call.id,
                  type: 'function',
                  function: { name: call.function.name, arguments: call.function.arguments },
                },
              ],
            }),
          );
        }
      }
      writeEvent(chunk({}, turn.toolCalls.length ? 'tool_calls' : 'stop', { usage: turn.usage }));
      if (!closed) {
        res.write('data: [DONE]\n\n');
        res.end();
      }
      log.info(
        `stream ok ${Date.now() - streamStartedAt}ms conteudo=${sentChars}ch raciocinio=${sentThink}ch ` +
          `ferramentas=${turn.toolCalls.length}`,
      );
    } catch (err) {
      const { status, code } = mapError(err);
      // Cancelamento do cliente (fechou a aba, desistiu, DSH cancelou a sonda) e
      // fluxo normal, nao defeito: registra como aviso para nao poluir o log.
      const logFn = String(code).toLowerCase() === 'aborted' ? log.info : log.error;
      logFn(
        `stream ${String(code).toLowerCase() === 'aborted' ? 'cancelado' : 'falhou'} [${code}] apos ${Date.now() - streamStartedAt}ms ` +
          `(conteudo=${sentChars}ch raciocinio=${sentThink}ch): ${err.message}`,
      );
      if (!started) {
        return apiError(res, status, err.message, code, status >= 500 ? 'api_error' : 'invalid_request_error');
      }
      // Cabecalhos ja enviados: sinaliza erro no proprio evento e encerra.
      writeEvent({ error: { message: err.message, type: 'api_error', code } });
      writeEvent(chunk({}, 'stop', { usage: usageFrom('', '') }));
      if (!closed) {
        res.write('data: [DONE]\n\n');
        res.end();
      }
    }
  }

  attach(server) {
    this.server = server;
    server.on('request', async (req, res) => {
      cors(res);
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
      }
      let url;
      try {
        url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
      } catch {
        return apiError(res, 400, 'url invalida');
      }

      if (!this.tokenFrom(req) && !url.pathname.startsWith('/health')) {
        return apiError(res, 401, 'token da ponte invalido', 'unauthorized', 'authentication_error');
      }

      try {
        if (req.method === 'GET' && url.pathname === '/health') {
          const deep = url.searchParams.get('deep') === '1';
          return writeJson(res, 200, await this.health({ deep }));
        }
        if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
          return writeJson(res, 200, this.modelsPayload());
        }
        if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')) {
          return await this.handleChat(req, res);
        }
        if (req.method === 'GET' && url.pathname === '/') {
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end(`deepseek-web-bridge ${VERSION}\nrotas: /health /v1/models /v1/chat/completions\n`);
        }
        return apiError(res, 404, `rota nao encontrada: ${req.method} ${url.pathname}`, 'not_found');
      } catch (err) {
        log.error(`erro nao tratado: ${err.stack || err.message}`);
        if (!res.headersSent) return apiError(res, 500, err.message, 'internal_error', 'api_error');
        try {
          res.end();
        } catch {
          /* ignora */
        }
      }
    });
  }
}

function mapError(err) {
  const code = err?.code || '';
  switch (code) {
    case 'LOGIN_REQUIRED':
      return { status: 401, code: 'login_required' };
    case 'CHALLENGE':
      return { status: 429, code: 'challenge_required' };
    case 'COMPOSER_NOT_FOUND':
      return { status: 503, code: 'site_layout_changed' };
    case 'BUSY':
      return { status: 429, code: 'bridge_busy' };
    case 'QUEUE_FULL':
      return { status: 429, code: 'queue_full' };
    case 'ABORTED':
      return { status: 499, code: 'aborted' };
    case 'TIMEOUT':
    case 'TIMEOUT_FIRST_TOKEN':
      return { status: 504, code: 'upstream_timeout' };
    case 'WEB_ERROR':
      return { status: 502, code: 'upstream_error' };
    case 'EMPTY_ANSWER':
      return { status: 502, code: 'empty_answer' };
    case 'MODEL_NOT_FOUND':
      return { status: 404, code: 'model_not_found' };
    default:
      return { status: 500, code: 'internal_error' };
  }
}

export async function startServer(cfg) {
  const bridge = new Bridge(cfg);
  const server = http.createServer();
  server.requestTimeout = 120_000;
  server.headersTimeout = 120_000;
  server.keepAliveTimeout = 70_000;
  bridge.attach(server);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, cfg.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const url = `http://${cfg.host}:${cfg.port}`;
  log.info(`ponte ouvindo em ${url}`);
  bridge.warmup().catch(() => {});

  return {
    bridge,
    server,
    url,
    async close() {
      try {
        await bridge.transport.close();
      } catch {
        /* ignora */
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
