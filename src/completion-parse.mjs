/**
 * Interpreta o corpo SSE do endpoint /api/v0/chat/completion do chat.deepseek.com.
 *
 * O site NAO usa o SSE da API oficial. O dialeto real (capturado em 2026-10-19) e:
 *
 *   event: ready
 *   data: {"request_message_id":1,"response_message_id":2,"model_type":"default"}
 *
 *   data: {"v":{"response":{ ..., "fragments":[{"id":2,"type":"THINK","content":"We"}] }}}
 *   data: {"p":"response/fragments/-1/content","o":"APPEND","v":" need"}
 *   data: {"v":" answer"}                        <-- delta "solto" vai para o ultimo fragmento
 *   data: {"p":"response/fragments","o":"APPEND","v":[{"id":3,"type":"RESPONSE","content":"17"}]}
 *   data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":108},
 *                                          {"p":"quasi_status","v":"FINISHED"}]}
 *   data: {"p":"response/status","o":"SET","v":"FINISHED"}
 *   event: close
 *
 * Regras implementadas:
 *  - `v` string sem `p` ............ append no conteudo do ULTIMO fragmento;
 *  - `p: response/fragments` ....... append de novos fragmentos (lista);
 *  - `p: response/fragments/N/campo` aplica em fragmento N (aceita indice negativo);
 *  - `p: response` com `o: BATCH` .. aplica os patches internos relativos a `response`;
 *  - snapshot `v.response` ......... reconcilia fragmentos/status/tokens (nunca encurta texto);
 *  - formato OpenAI (choices[].delta) como fallback.
 *
 * Funcao pura, para poder ser testada sem navegador.
 */

const KNOWN_FINISH = new Set(['FINISHED', 'COMPLETED', 'DONE', 'SUCCESS', 'FAILED', 'CANCELED', 'CANCELLED']);
const THINK_TYPES = new Set(['THINK', 'THINKING', 'REASONING']);

/** @typedef {{type:string, content:string}} Fragment */

function newState() {
  return { fragments: /** @type {Fragment[]} */ ([]), status: null, quasiStatus: null, tokens: null, events: 0 };
}

function lastFragment(state) {
  return state.fragments.length ? state.fragments[state.fragments.length - 1] : null;
}

function ensureLastFragment(state, type = 'RESPONSE') {
  const frag = lastFragment(state);
  if (frag) return frag;
  const created = { type, content: '' };
  state.fragments.push(created);
  return created;
}

/** Ultimo fragmento do tipo pedido ou um novo no fim (usado no dialeto antigo). */
function ensureTypedFragment(state, type) {
  for (let i = state.fragments.length - 1; i >= 0; i--) {
    if (state.fragments[i].type === type) return state.fragments[i];
  }
  const created = { type, content: '' };
  state.fragments.push(created);
  return created;
}

/** APPEND/SET em um fragmento do tipo pedido (dialeto antigo, sem fragmentos). */
function applyTypedContent(state, type, op, value) {
  const frag = ensureTypedFragment(state, type);
  const str = String(value ?? '');
  if (String(op || 'APPEND').toUpperCase() === 'SET') frag.content = str;
  else frag.content += str;
}
/** Aplica APPEND/SET de `value` no campo `field` de um fragmento. */
function applyFragmentPatch(state, index, field, op, value) {
  if (typeof value !== 'string' && typeof value !== 'number') return;
  const frags = state.fragments;
  let target = null;
  if (index === -1 || index === '-1') target = frags.length ? frags[frags.length - 1] : null;
  else if (/^-?\d+$/.test(String(index))) {
    const i = Number(index);
    target = i < 0 ? frags[frags.length + i] || null : frags[i] || null;
  } else {
    return;
  }
  if (!target) return;
  if (field === 'content') {
    const str = String(value);
    if (op === 'SET') target.content = str;
    else target.content += str;
  }
}

/** Fragmentos vindos de um snapshot/append (lista de {type, content}). */
function mergeFragmentList(state, list, { append }) {
  if (!Array.isArray(list)) return;
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!item || typeof item !== 'object') continue;
    const type = String(item.type || 'RESPONSE').toUpperCase();
    const content = typeof item.content === 'string' ? item.content : '';
    if (append) {
      state.fragments.push({ type, content });
      continue;
    }
    const current = state.fragments[i];
    if (!current) {
      state.fragments.push({ type, content });
      continue;
    }
    // Snapshot NUNCA encurta: so aceita se for mais completo.
    if (content.length >= current.content.length) current.content = content;
    if (type) current.type = type;
  }
}

/** Aplica um patch {"p":..,"o":..,"v":..} cujo caminho e absoluto ou relativo a `base`. */
function applyPatch(state, patch, base = '') {
  if (!patch || typeof patch !== 'object') return;

  // Delta solto: {"v":"pedaco"} (o site manda isso para o fragmento corrente).
  if (typeof patch.p !== 'string') {
    if (typeof patch.v === 'string') {
      ensureLastFragment(state).content += patch.v;
    }
    return;
  }

  const full = base ? joinPath(base, patch.p) : patch.p;
  const parts = full.split('/').filter(Boolean);
  const op = String(patch.o || 'APPEND').toUpperCase();
  const value = patch.v;

  // response/fragments[.N].campo
  if (parts[0] === 'response' && parts[1] === 'fragments') {
    if (parts.length === 2) {
      mergeFragmentList(state, value, { append: op === 'APPEND' || op === 'INSERT' });
      return;
    }
    applyFragmentPatch(state, parts[2], parts[3], op, value);
    return;
  }

  // response/<campo> (ex.: response/status, response/accumulated_token_usage)
  if (parts[0] === 'response' && parts.length >= 2 && parts[1] !== undefined) {
    const field = parts[1];
    if (op === 'BATCH' || field === 'BATCH') {
      if (Array.isArray(value)) for (const inner of value) applyPatch(state, inner, base ? joinPath(base, 'response') : 'response');
      return;
    }
    if (field === 'status' && typeof value === 'string') state.status = value;
    else if (field === 'quasi_status' && typeof value === 'string') state.quasiStatus = value;
    else if (field === 'accumulated_token_usage' && Number.isFinite(value)) state.tokens = value;
    else if (field === 'content') applyTypedContent(state, 'RESPONSE', op, value);
    else if (field === 'thinking_content') applyTypedContent(state, 'THINK', op, value);
    return;
  }

  // response com BATCH: {"p":"response","o":"BATCH","v":[{...}]}
  if (parts[0] === 'response' && parts.length === 1) {
    if (Array.isArray(value)) for (const inner of value) applyPatch(state, inner, 'response');
    else if (value && typeof value === 'object' && typeof value.status === 'string') state.status = value.status;
    return;
  }

  // Caminhos legados sem o prefixo "response".
  if (Array.isArray(parts) && parts.length) {
    const last = parts[parts.length - 1];
    if (last === 'content') applyTypedContent(state, 'RESPONSE', op, value);
    else if (last === 'thinking_content') applyTypedContent(state, 'THINK', op, value);
    else if (last === 'status' && typeof value === 'string') state.status = value;
    else if (last === 'accumulated_token_usage' && Number.isFinite(value)) state.tokens = value;
  }
}

function joinPath(base, rel) {
  return rel.startsWith('response') ? rel : `${base}/${rel}`;
}

function applyEvent(state, data) {
  if (!data || typeof data !== 'object') return;

  // ---- formato OpenAI (fallback) ----
  const choice = Array.isArray(data.choices) ? data.choices[0] : null;
  if (choice) {
    const delta = choice.delta || choice.message || {};
    if (typeof delta.content === 'string' && delta.content) {
      ensureTypedFragment(state, 'RESPONSE').content += delta.content;
    }
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      ensureTypedFragment(state, 'THINK').content += delta.reasoning_content;
    }
    if (choice.finish_reason) state.status = 'FINISHED';
    if (data.usage && Number.isFinite(data.usage.total_tokens)) state.tokens = data.usage.total_tokens;
    return;
  }

  // ---- patch ----
  if (typeof data.p === 'string') {
    applyPatch(state, data);
    return;
  }

  // ---- delta solto ----
  if (typeof data.v === 'string') {
    ensureLastFragment(state).content += data.v;
    return;
  }

  // ---- snapshot ----
  const payload = data.v && typeof data.v === 'object' ? data.v : null;
  if (!payload) return;
  const resp = payload.response || (payload.message && typeof payload.message === 'object' ? payload.message : null);
  if (!resp) return;

  if (Array.isArray(resp.fragments)) mergeFragmentList(state, resp.fragments, { append: false });
  if (typeof resp.content === 'string') {
    // formatos antigos trazem o texto direto no response
    const cur = ensureTypedFragment(state, 'RESPONSE');
    if (resp.content.length >= cur.content.length) cur.content = resp.content;
  }
  if (typeof resp.thinking_content === 'string') {
    const cur = ensureTypedFragment(state, 'THINK');
    if (resp.thinking_content.length >= cur.content.length) cur.content = resp.thinking_content;
  }
  if (typeof resp.status === 'string') state.status = resp.status;
  if (typeof resp.quasi_status === 'string') state.quasiStatus = resp.quasi_status;
  if (Number.isFinite(resp.accumulated_token_usage)) state.tokens = resp.accumulated_token_usage;
}

/** Junta os fragmentos em texto de resposta e de raciocinio. */
function collect(state) {
  const content = state.fragments
    .filter((f) => !THINK_TYPES.has(String(f.type || '').toUpperCase()))
    .map((f) => String(f.content || ''))
    .join('');
  const thinking = state.fragments
    .filter((f) => THINK_TYPES.has(String(f.type || '').toUpperCase()))
    .map((f) => String(f.content || ''))
    .join('');
  return { content, thinking };
}

/**
 * @param {string} body corpo bruto SSE da resposta
 * @returns {{content:string, thinking:string, status:string|null, quasiStatus:string|null,
 *            tokens:number|null, events:number, fragments:{type:string,content:string}[]}}
 */
export function parseCompletionBody(body) {
  const state = newState();
  const text = String(body || '');
  if (!text) return { ...collect(state), status: null, quasiStatus: null, tokens: null, events: 0, fragments: [] };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let data;
    try {
      data = JSON.parse(payload);
    } catch {
      continue;
    }
    state.events++;
    applyEvent(state, data);
  }

  const { content, thinking } = collect(state);
  return {
    content,
    thinking,
    status: state.status,
    quasiStatus: state.quasiStatus,
    tokens: state.tokens,
    events: state.events,
    fragments: state.fragments,
  };
}

export function isFinishedStatus(status) {
  return status != null && KNOWN_FINISH.has(String(status).toUpperCase());
}

/** Junta duas leituras (DOM em streaming x corpo final) escolhendo a mais completa. */
export function bestText(domText, bodyText) {
  const dom = String(domText || '').trim();
  const body = String(bodyText || '').trim();
  if (!body) return dom;
  if (!dom) return body;
  return body.length >= dom.length ? body : dom;
}
