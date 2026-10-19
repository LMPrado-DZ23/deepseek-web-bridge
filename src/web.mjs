/**
 * Transporte "navegador": mantem um Chrome dedicado (perfil proprio), envia um prompt
 * no chat.deepseek.com e devolve o texto da resposta em streaming.
 *
 * Modelo de uso: uma requisicao por vez (fila no servidor). Cada requisicao abre uma
 * conversa nova (equivalente ao "Temporary Chat" do codex-chatgpt-web).
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { DATA_DIR } from './config.mjs';
import {
  SELECTORS,
  anyVisible,
  detectPageError,
  diagnoseDom,
  firstVisible,
  isSignInUrl,
  pageSnippet,
  pageUrl,
  readAssistant,
} from './dom.mjs';
import { parseCompletionBody } from './completion-parse.mjs';
import { closeStrayChrome } from './native-login.mjs';
import { log } from './log.mjs';

export class BridgeError extends Error {
  constructor(code, message, meta = {}) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.meta = meta;
  }
}

const COMPLETION_PATH = '/api/v0/chat/completion';

/** Acha um botao de modo pelo rotulo visivel (seletores medidos). */
async function findToggle(page, labels) {
  for (const label of labels) {
    try {
      const loc = page.locator('div.ds-toggle-button').filter({ hasText: label }).first();
      if ((await loc.count()) > 0 && (await loc.isVisible())) return loc;
    } catch {
      // segue para o proximo rotulo
    }
  }
  return null;
}

/** Estado do botao: aria-pressed/aria-checked quando existem, senao a classe. */
function toggleActive(loc) {
  return loc.evaluate((el) => {
    const aria = el.getAttribute('aria-pressed') || el.getAttribute('aria-checked');
    if (aria === 'true') return true;
    if (aria === 'false') return false;
    return /ds-toggle-button--selected/.test(String(el.className || ''));
  });
}

export class WebTransport {
  constructor(cfg) {
    this.cfg = cfg;
    this.context = null;
    this.page = null;
    this.busy = false;
    this.lastBody = null;
    this.lastStatus = null;
    this.lastUrl = null;
    this.startedAt = null;
    this._starting = null;
  }

  /** Abre o navegador. `headed` forca janela visivel. */
  async start({ headed } = {}) {
    if (this.context) return;
    // warmup() roda em paralelo com os primeiros pedidos: sem esta trava, dois
    // launchPersistentContext simultaneos disputam o mesmo perfil (Chrome exit 21).
    if (!this._starting) {
      this._starting = this._openBrowser({ headed }).finally(() => {
        this._starting = null;
      });
    }
    return this._starting;
  }

  async _openBrowser({ headed } = {}) {
    const headless = headed === undefined ? this.cfg.headless : !headed;
    const args = [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,MediaRouter',
    ];
    log.info(`abrindo ${this.cfg.browserChannel} (${headless ? 'headless' : 'visivel'}) perfil=${this.cfg.profileDir}`);
    this.context = await chromium.launchPersistentContext(this.cfg.profileDir, {
      channel: this.cfg.browserChannel,
      headless,
      viewport: { width: 1360, height: 900 },
      locale: 'pt-BR',
      timezoneId: 'America/Sao_Paulo',
      acceptDownloads: false,
      args,
    });
    await this.context.addInitScript(() => {
      try {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      } catch {
        /* ignora */
      }
    });
    this.page = this.context.pages()[0] || (await this.context.newPage());
    this.page.setDefaultTimeout(20_000);
    this.page.setDefaultNavigationTimeout(this.cfg.navTimeoutMs);
    this.page.on('dialog', (d) => d.dismiss().catch(() => {}));
    this.page.on('crash', () => log.warn('pagina do navegador caiu'));
    this.page.on('response', (resp) => {
      try {
        if (!resp.url().includes(COMPLETION_PATH)) return;
        this.lastStatus = resp.status();
        resp
          .text()
          .then((t) => {
            this.lastBody = t;
          })
          .catch(() => {});
      } catch {
        /* ignora */
      }
    });
    this.startedAt = Date.now();
  }

  async ensurePage() {
    if (!this.context) await this.start();
    if (!this.page || this.page.isClosed()) {
      this.page = await this.context.newPage();
      this.page.setDefaultTimeout(20_000);
      this.page.setDefaultNavigationTimeout(this.cfg.navTimeoutMs);
    }
    return this.page;
  }

  async close() {
    const ctx = this.context;
    this.context = null;
    this.page = null;
    if (!ctx) return;
    // O close() do Chrome pode travar com conexoes keep-alive abertas do site.
    // Nao deixe isso segurar o processo (CLI) nem o idle-close (serve).
    let timer = null;
    const guard = new Promise((resolve) => {
      timer = setTimeout(() => resolve('timeout'), 20_000);
      timer.unref?.();
    });
    try {
      const outcome = await Promise.race([ctx.close().then(() => 'ok').catch(() => 'erro'), guard]);
      if (outcome === 'timeout') {
        log.warn('fechamento do navegador nao terminou em 20s; encerrando processos do perfil');
        // Sem isso o perfil fica travado e o proximo start() falha.
        try {
          const killed = closeStrayChrome(this.cfg.profileDir);
          if (killed.length) log.warn(`processos encerrados: ${killed.join(', ')}`);
        } catch (err) {
          log.warn(`falha ao encerrar processos do perfil: ${err.message}`);
        }
      }
    } catch {
      /* ignora */
    } finally {
      if (timer) clearTimeout(timer);
    }
    log.info('navegador fechado');
  }

  async isBusy() {
    return this.busy;
  }

  /** Navega para a home do chat (conversa nova) e espera o composer. */
  async openNewChat() {
    const page = await this.ensurePage();
    await page.goto(this.cfg.chatUrl, { waitUntil: 'domcontentloaded', timeout: this.cfg.navTimeoutMs });
    const composer = await firstVisible(page, 'composer', { timeoutMs: 20_000 });
    if (!composer) {
      const url = await pageUrl(page);
      if (isSignInUrl(url)) throw new BridgeError('LOGIN_REQUIRED', `sessao nao autenticada (${url})`);
      const blocked = detectPageError(await pageSnippet(page));
      if (blocked) throw new BridgeError('CHALLENGE', `site bloqueou a requisicao (${blocked})`, { url });
      throw new BridgeError('COMPOSER_NOT_FOUND', 'nao encontrei a caixa de texto do chat.deepseek.com', {
        url,
        snippet: await pageSnippet(page),
      });
    }
    return { page, composer };
  }

  /** Verifica login sem abrir janela nova de forma agressiva. */
  async checkLogin() {
    const page = await this.ensurePage();
    await page.goto(this.cfg.chatUrl, { waitUntil: 'domcontentloaded', timeout: this.cfg.navTimeoutMs });
    const url = await pageUrl(page);
    // Pagina de bloqueio de borda NAO significa login: detecta antes de inferir.
    const blocked = detectPageError(await pageSnippet(page));
    if (blocked) return { loggedIn: false, blocked: true, error: blocked, url };
    if (isSignInUrl(url)) return { loggedIn: false, url };
    const composer = await firstVisible(page, 'composer', { timeoutMs: 12_000 });
    return { loggedIn: Boolean(composer), url };
  }

  /**
   * Abre janela visivel para o usuario fazer login manualmente e espera.
   * @returns {Promise<{ok:boolean, url:string, ms:number}>}
   */
  async waitForManualLogin({ timeoutMs = 30 * 60_000, onTick } = {}) {
    await this.start({ headed: true });
    const page = await this.ensurePage();
    await page.goto(this.cfg.chatUrl, { waitUntil: 'domcontentloaded', timeout: this.cfg.navTimeoutMs });
    const started = Date.now();
    let lastUrl = '';
    while (Date.now() - started < timeoutMs) {
      const url = await pageUrl(page);
      if (url !== lastUrl) {
        lastUrl = url;
        log.info(`url atual: ${url}`);
        onTick?.({ url, elapsedMs: Date.now() - started });
      }
      if (!isSignInUrl(url)) {
        const composer = await firstVisible(page, 'composer', { timeoutMs: 3_000 });
        if (composer) return { ok: true, url, ms: Date.now() - started };
      }
      await page.waitForTimeout(1_500);
    }
    return { ok: false, url: await pageUrl(page), ms: Date.now() - started };
  }

  /** Lida com os botoes de modo (DeepThink / busca) de forma tolerante. */
  async setModes(page, mode) {
    // Medido em 2026-10-19: botoes sao div.ds-toggle-button, o rotulo fica no
    // texto interno e o estado ativo vem de aria-pressed e/ou da classe
    // ds-toggle-button--selected. "Pesquisa inteligente" vem LIGADA por padrao
    // na conta, o que adiciona latencia: sempre desligamos, exceto se pedido.
    const wanted = [
      { key: 'deepThinkToggle', labels: ['Pensamento Profundo', 'Pensamento', 'Raciocinio', 'Think'], desired: mode === 'think' },
      { key: 'searchToggle', labels: ['Pesquisa inteligente', 'Pesquisa', 'Busca', 'Search'], desired: false },
    ];
    for (const spec of wanted) {
      const loc = await findToggle(page, spec.labels);
      if (!loc) {
        if (spec.desired) log.warn(`botao ${spec.key} nao encontrado; seguindo sem ele`);
        continue;
      }
      try {
        if ((await toggleActive(loc)) !== spec.desired) {
          await loc.click({ timeout: 4_000 });
          await page.waitForTimeout(250);
          if ((await toggleActive(loc)) !== spec.desired) {
            await loc.click({ timeout: 4_000 });
            await page.waitForTimeout(250);
          }
        }
        const final = await toggleActive(loc);
        log.debug(`modo ${spec.key}: ${final ? 'ligado' : 'desligado'}`);
        if (final !== spec.desired) log.warn(`modo ${spec.key} nao ficou ${spec.desired ? 'ligado' : 'desligado'}`);
      } catch (err) {
        log.warn(`falha ao ajustar ${spec.key}: ${err.message}`);
      }
    }
  }

  /**
   * Envia um prompt e devolve a resposta.
   * @param {{prompt:string, mode?:'chat'|'think', onDelta?:(chunk:string)=>void, onThinking?:(chunk:string)=>void, signal?:AbortSignal}} req
   */
  async submit({ prompt, mode = 'chat', onDelta, onThinking, signal }) {
    if (this.busy) throw new BridgeError('BUSY', 'a ponte ja esta processando outra requisicao');
    if (!prompt || !String(prompt).trim()) throw new BridgeError('EMPTY_PROMPT', 'prompt vazio');
    if (signal?.aborted) throw new BridgeError('ABORTED', 'requisicao cancelada pelo cliente');
    this.busy = true;
    const started = Date.now();
    try {
      const { page, composer } = await this.openNewChat();
      if (signal?.aborted) throw new BridgeError('ABORTED', 'requisicao cancelada pelo cliente');
      await this.setModes(page, mode);

      this.lastBody = null;
      this.lastStatus = null;

      await composer.click({ timeout: 10_000 });
      try {
        await composer.fill(prompt);
      } catch {
        await composer.click();
        await page.keyboard.insertText(prompt);
      }
      await page.waitForTimeout(150);
      await this.pressSend(page, composer);

      const res = await this.streamAnswer({ page, onDelta, onThinking, signal });
      const domText = String(res.text || '');
      const bodyText = this.lastBody ? parseCompletionBody(this.lastBody) : { content: '', thinking: '', tokens: null };

      // O corpo SSE e autoritativo quando existe: o DOM tambem mostra o bloco
      // de raciocinio (modo think) e pode estar em estado intermediario.
      const fromNetwork = String(bodyText.content || '').trim();
      const text = fromNetwork || domText.trim();
      const thinking = String(bodyText.thinking || res.thinking || '').trim();

      if (!text.trim()) {
        const snippet = await pageSnippet(page);
        const errorHint = detectPageError(snippet);
        if (isSignInUrl(await pageUrl(page))) throw new BridgeError('LOGIN_REQUIRED', 'sessao expirou durante a requisicao');
        throw new BridgeError(errorHint ? 'WEB_ERROR' : 'EMPTY_ANSWER', errorHint ? `site respondeu: ${errorHint}` : 'resposta vazia do chat.deepseek.com', {
          status: this.lastStatus,
          snippet,
        });
      }

      return {
        text: text.trim(),
        thinking,
        tokens: bodyText.tokens ?? Math.max(1, Math.ceil(text.length / 3.6)),
        source: bodyText.content ? 'network+dom' : 'dom',
        status: this.lastStatus,
        url: await pageUrl(page),
        elapsedMs: Date.now() - started,
      };
    } finally {
      this.busy = false;
    }
  }

  async pressSend(page, composer) {
    const btn = await firstVisible(page, 'sendButton', { timeoutMs: 2_500 });
    if (btn) {
      try {
        const disabled = await btn.evaluate((el) => {
          const aria = el.getAttribute('aria-disabled');
          const cls = String(el.className || '');
          return aria === 'true' || /disabled/i.test(cls);
        });
        if (!disabled) {
          await btn.click({ timeout: 5_000 });
          return;
        }
      } catch (err) {
        log.warn(`clique no botao enviar falhou (${err.message}); tentando Enter`);
      }
    }
    await composer.press('Enter');
  }

  /** Laco de streaming: le o DOM, emite deltas e detecta o fim. */
  async streamAnswer({ page, onDelta, onThinking, signal }) {
    const cfg = this.cfg;
    const startedAt = Date.now();
    const deadline = Date.now() + cfg.requestTimeoutMs;
    let firstTokenDeadline = Date.now() + cfg.firstTokenTimeoutMs;

    let emitted = 0;
    let emittedThinking = 0;
    let lastText = '';
    let thinking = '';
    let sawGeneration = false;
    let lastChange = Date.now();
    let resent = false;
    let breakReason = '';

    while (Date.now() < deadline) {
      if (signal?.aborted) throw new BridgeError('ABORTED', 'requisicao cancelada pelo cliente');

      const state = await readAssistant(page);
      const text = state.text;
      if (state.thinking) {
        thinking = state.thinking;
        // Raciocinio tambem e streamado, mas em campo separado: o cliente nunca
        // deve receber THINK como se fosse a resposta.
        if (onThinking && thinking.length > emittedThinking) {
          onThinking(thinking.slice(emittedThinking));
          emittedThinking = thinking.length;
        }
        sawGeneration = true;
        lastChange = Date.now();
      }

      if (text.length > emitted) {
        onDelta?.(text.slice(emitted));
        emitted = text.length;
        lastText = text;
        sawGeneration = true;
        lastChange = Date.now();
      }

      const stopVisible = await anyVisible(page, 'stopButton');
      if (stopVisible) sawGeneration = true;

      // Sinal definitivo de fim: o corpo do SSE foi capturado pelo listener.
      const networkDone = this.lastBody !== null && this.lastStatus !== null;
      if (sawGeneration && networkDone && !stopVisible) {
        breakReason = 'network';
        break;
      }

      // Fim por estabilizacao: so vale se ja houver texto de resposta (no modo
      // think o DOM pode ficar parado no raciocinio antes da resposta comecar).
      if (sawGeneration && !networkDone && !stopVisible && text.trim() && Date.now() - lastChange >= cfg.settleMs) {
        breakReason = 'settle';
        break;
      }

      if (!sawGeneration && Date.now() > firstTokenDeadline) {
        const snippet = await pageSnippet(page, 400);
        const hint = detectPageError(snippet);
        if (hint) throw new BridgeError('WEB_ERROR', `site respondeu: ${hint}`, { snippet });
        if (!resent) {
          log.warn('nenhuma geracao detectada; tentando enviar novamente com Enter');
          resent = true;
          await page.keyboard.press('Enter');
          firstTokenDeadline = Date.now() + cfg.firstTokenTimeoutMs;
          continue;
        }
        throw new BridgeError('TIMEOUT_FIRST_TOKEN', `o site nao comecou a responder em ${cfg.firstTokenTimeoutMs} ms`, { snippet });
      }

      await page.waitForTimeout(cfg.pollMs);
    }

    if (!sawGeneration) {
      const snippet = await pageSnippet(page, 400);
      throw new BridgeError('TIMEOUT', `sem resposta em ${cfg.requestTimeoutMs} ms`, { snippet });
    }

    log.debug(
      `loop terminou motivo=${breakReason || 'deadline'} em ${Date.now() - startedAt}ms ` +
        `texto=${lastText.length}ch raciocinio=${thinking.length}ch rede=${this.lastBody !== null}`,
    );

    // Ultima leitura para pegar o texto final consolidado.
    const finalState = await readAssistant(page);
    const finalText = finalState.text.length >= lastText.length ? finalState.text : lastText;
    if (finalState.thinking) thinking = finalState.thinking;
    // Da tempo do listener de rede guardar o corpo final.
    await page.waitForTimeout(250);
    return { text: finalText, thinking };
  }

  async diagnose() {    const page = await this.ensurePage();
    await page.goto(this.cfg.chatUrl, { waitUntil: 'domcontentloaded', timeout: this.cfg.navTimeoutMs });
    await page.waitForTimeout(2_500);
    const report = await diagnoseDom(page, { selectors: SELECTORS });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const shot = path.join(DATA_DIR, `diagnose-${stamp}.png`);
    try {
      await page.screenshot({ path: shot, fullPage: false });
    } catch (err) {
      log.warn(`screenshot falhou: ${err.message}`);
    }
    const jsonFile = path.join(DATA_DIR, `diagnose-${stamp}.json`);
    fs.writeFileSync(jsonFile, JSON.stringify(report, null, 2), 'utf8');
    return { report, screenshot: shot, jsonFile, loggedIn: !isSignInUrl(report.url) };
  }
}

