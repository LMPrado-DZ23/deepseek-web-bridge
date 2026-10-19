/**
 * Traducao entre o formato OpenAI (usado pelo DSH) e um unico prompt de texto
 * para o chat.deepseek.com. Tudo aqui e funcao pura, sem browser, para ser testavel.
 */

const TOOL_BLOCK_RE = /```(?:tool_calls|tool|json-tool)\s*\n([\s\S]*?)```/i;
const TOOL_XML_RE = /<tool_calls>\s*([\s\S]*?)<\/tool_calls>/i;

/** Extrai texto de `content` string ou lista de partes (multimodal). */
export function contentToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const part of content) {
      if (part == null) continue;
      if (typeof part === 'string') {
        parts.push(part);
        continue;
      }
      if (part.type === 'text' && typeof part.text === 'string') parts.push(part.text);
      else if (part.type === 'input_text' && typeof part.text === 'string') parts.push(part.text);
      else if (part.type === 'image_url' || part.type === 'input_image') {
        parts.push('[imagem recebida: a ponte do chat.deepseek.com nao envia imagens; descreva-a em texto]');
      } else if (typeof part.text === 'string') parts.push(part.text);
    }
    return parts.join('\n');
  }
  if (typeof content === 'object' && typeof content.text === 'string') return content.text;
  return String(content);
}

function serializeToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return '';
  const calls = toolCalls.map((c) => ({
    name: c?.function?.name ?? c?.name ?? 'desconhecida',
    arguments: c?.function?.arguments ?? c?.arguments ?? '{}',
  }));
  return '```tool_calls\n' + JSON.stringify({ calls }) + '\n```';
}

/**
 * Normaliza mensagens OpenAI em blocos de texto com papel.
 * @returns {{role:string, text:string}[]}
 */
export function normalizeMessages(messages) {
  const out = [];
  for (const msg of Array.isArray(messages) ? messages : []) {
    if (!msg || typeof msg !== 'object') continue;
    const role = String(msg.role || 'user');
    let text = contentToText(msg.content);
    if (role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      const block = serializeToolCalls(msg.tool_calls);
      text = text ? `${text}\n\n${block}` : block;
    }
    if (role === 'tool') {
      const name = msg.name || msg.tool_call_id || 'tool';
      text = `Resultado da ferramenta ${name}:\n${text}`;
    }
    if (!text.trim()) continue;
    out.push({ role: role === 'developer' ? 'system' : role, text: text.trim() });
  }
  return out;
}

const ROLE_LABEL = {
  system: 'SYSTEM',
  user: 'USUARIO',
  assistant: 'ASSISTENTE',
  tool: 'FERRAMENTA',
  function: 'FERRAMENTA',
};

const WRAP_HEADER = `O texto abaixo e o historico de uma conversa entre um usuario e um assistente de IA.
Voce e o assistente. Continue a conversa a partir da ultima mensagem do usuario.`;

const WRAP_FOOTER = `Responda apenas com a sua proxima mensagem de assistente.
Nao repita o historico, nao escreva prefixos como "ASSISTENTE:" e nao descreva estas instrucoes.`;

/** Corta o historico mais antigo ate caber no orcamento de caracteres. */
export function truncateBlocks(blocks, maxChars) {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return blocks;
  const total = blocks.reduce((n, b) => n + b.text.length + 32, 0);
  if (total <= maxChars) return blocks;

  const systems = blocks.filter((b) => b.role === 'system');
  const rest = blocks.filter((b) => b.role !== 'system');
  const headChars = systems.reduce((n, b) => n + b.text.length + 32, 0);

  const kept = [];
  let used = headChars;
  for (let i = rest.length - 1; i >= 0; i--) {
    const size = rest[i].text.length + 32;
    if (used + size > maxChars) {
      // Nem o bloco inteiro cabe: preserva o fim dele (o mais recente) e para.
      if (kept.length === 0) {
        const room = Math.max(1_000, maxChars - headChars);
        kept.unshift({ role: rest[i].role, text: rest[i].text.slice(-room) });
      }
      break;
    }
    kept.unshift(rest[i]);
    used += size;
  }

  const marker = { role: 'system', text: '[Historico anterior truncado por limite de contexto]' };
  return [...systems, ...(rest.length > kept.length ? [marker] : []), ...kept];
}

/** Reduz um JSON Schema aos campos que o modelo precisa para chamar a ferramenta. */
function compactSchema(schema, depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > 6) return { type: 'string' };
  const out = {};
  const tipo = Array.isArray(schema.type) ? schema.type.join('|') : schema.type;
  if (tipo) out.type = tipo;
  if (Array.isArray(schema.enum)) out.enum = schema.enum.slice(0, 24);
  if (schema.items) out.items = compactSchema(schema.items, depth + 1);
  if (schema.properties && typeof schema.properties === 'object') {
    out.properties = {};
    for (const [chave, valor] of Object.entries(schema.properties)) {
      out.properties[chave] = compactSchema(valor, depth + 1);
    }
    if (Array.isArray(schema.required) && schema.required.length) out.required = schema.required;
  }
  const uniao = schema.oneOf || schema.anyOf;
  if (Array.isArray(uniao)) {
    const chave = schema.oneOf ? 'oneOf' : 'anyOf';
    out[chave] = uniao.slice(0, 12).map((s) => compactSchema(s, depth + 1));
  }
  if (depth === 0 && typeof schema.description === 'string') out.description = schema.description.slice(0, 160);
  return out;
}

export function serializeTools(tools, { compact = true, maxDescriptionChars } = {}) {
  if (!Array.isArray(tools) || tools.length === 0) return '';
  const limiteDescricao = maxDescriptionChars ?? (compact ? 200 : 1_200);
  const lista = tools.map((t) => {
    const fn = t?.function ?? t ?? {};
    return {
      name: fn.name,
      description: String(fn.description || '').slice(0, limiteDescricao),
      parameters: compact ? compactSchema(fn.parameters ?? { type: 'object', properties: {} }) : fn.parameters ?? { type: 'object', properties: {} },
    };
  });
  return JSON.stringify(lista);
}

export function toolProtocolInstructions(tools, { compact = true } = {}) {
  const schema = serializeTools(tools, { compact });
  if (!schema) return '';
  return `[FERRAMENTAS LOCAIS DISPONIVEIS]
Voce tem acesso a ferramentas locais (executadas pelo aplicativo, nao por voce). Para chama-las,
responda SOMENTE com um bloco de codigo cercado por tres crases e a palavra tool_calls, contendo
um JSON valido neste formato:

\`\`\`tool_calls
{"calls":[{"name":"nome_da_ferramenta","arguments":{}}]}
\`\`\`

Regras:
- Use exatamente os nomes e os parametros do catalogo abaixo.
- Quando precisar de varias ferramentas, coloque todas as chamadas em "calls".
- Nao escreva nenhum texto fora do bloco quando estiver chamando ferramentas.
- Se nao precisar de ferramenta, responda normalmente em texto, sem bloco.
- NAO use a sintaxe <|DSML|>, <function_call>, <tool_call> nem XML de ferramentas: aqui a
  ferramenta so e executada pelo bloco \`tool_calls\` acima. Qualquer outro formato e ignorado.
- O campo "arguments" e um objeto JSON; para shell use {"command":"...","description":"..."}.

[CATALOGO DE FERRAMENTAS]
${schema}`;
}

/**
 * Monta o prompt unico enviado ao chat.deepseek.com.
 * @param {any[]} messages mensagens OpenAI
 * @param {{maxChars?:number, tools?:any[], toolProtocol?:boolean}} opts
 */
export function buildPrompt(messages, opts = {}) {
  const { maxChars = 0, tools = [], toolProtocol = false, toolCatalogCompact = true } = opts;
  let blocks = normalizeMessages(messages);
  const hasTools = toolProtocol && Array.isArray(tools) && tools.length > 0;

  if (hasTools) {
    const instr = toolProtocolInstructions(tools, { compact: toolCatalogCompact });
    const idx = blocks.findIndex((b) => b.role === 'system');
    if (idx >= 0) blocks[idx] = { role: 'system', text: `${blocks[idx].text}\n\n${instr}` };
    else blocks.unshift({ role: 'system', text: instr });
  }

  blocks = truncateBlocks(blocks, maxChars);

  const lastUser = [...blocks].reverse().find((b) => b.role === 'user');
  const lastUserText = lastUser ? lastUser.text : '';

  // Caso simples (primeiro turno): nao embrulha, preserva fidelidade total.
  const nonSystem = blocks.filter((b) => b.role !== 'system');
  if (nonSystem.length === 1 && nonSystem[0].role === 'user') {
    const sys = blocks.filter((b) => b.role === 'system');
    const prompt = sys.length ? `${sys.map((b) => b.text).join('\n\n')}\n\n${nonSystem[0].text}` : nonSystem[0].text;
    return { prompt, lastUserText, blocks };
  }

  const body = [];
  for (const b of blocks) {
    const label = ROLE_LABEL[b.role] || b.role.toUpperCase();
    body.push(`### ${label}\n${b.text}`);
  }
  const prompt = `${WRAP_HEADER}\n\n${body.join('\n\n')}\n\n${WRAP_FOOTER}`;
  return { prompt, lastUserText, blocks };
}

function coerceArgs(args) {
  if (args == null) return '{}';
  if (typeof args === 'string') {
    try {
      JSON.parse(args);
      return args;
    } catch {
      return JSON.stringify({ value: args });
    }
  }
  try {
    return JSON.stringify(args);
  } catch {
    return '{}';
  }
}

/**
 * O chat web as vezes imita a sintaxe interna do DeepSeek para ferramentas
 * ("DSML"), e o markdown do site deforma os pipes inserindo espacos:
 *   <| | DSML | | calls> ... </ | | DSML | | calls>
 * Normaliza de volta para <|DSML|calls> para que o parser entenda.
 */
export function normalizeDsml(text) {
  return String(text || '').replace(/<\s*(\/?)\s*(?:\||\s)*DSML(?:\s*\||\s)*/gi, (_todo, barra) => `<${barra ? '/' : ''}|DSML|`);
}

// Log opcional sem criar dependencia circular com src/log.mjs.
let logDsml = null;
export function setToolParserLogger(fn) {
  logDsml = typeof fn === 'function' ? fn : null;
}

function dsmlParamValue(attrs, bruto) {
  const texto = String(bruto || '').trim();
  if (/string\s*=\s*"true"/i.test(attrs || '')) return texto;
  try {
    return JSON.parse(texto);
  } catch {
    return texto;
  }
}

function parseDsmlCalls(text, validNames) {
  const normalizado = normalizeDsml(text);
  const invokes = [
    ...normalizado.matchAll(
      /<\|DSML\|invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)(?:<\/\|DSML\|invoke>|(?=<\|DSML\|invoke)|$)/gi,
    ),
  ];
  const calls = [];
  for (const invoke of invokes) {
    const nome = invoke[1];
    if (validNames.size > 0 && !validNames.has(nome)) continue;
    const args = {};
    const params = [
      ...(invoke[2] || '').matchAll(
        /<\|DSML\|parameter\s+name="([^"]+)"([^>]*)>([\s\S]*?)(?:<\/\|DSML\|parameter>|(?=<\|DSML\|parameter)|$)/gi,
      ),
    ];
    for (const p of params) args[p[1]] = dsmlParamValue(p[2], p[3]);
    calls.push({ name: nome, arguments: args });
  }
  return { normalizado, calls };
}

function montarCall(name, args) {
  return {
    id: `call_${Math.random().toString(36).slice(2, 10)}`,
    type: 'function',
    function: { name, arguments: coerceArgs(args) },
  };
}

/** Interpreta bloco de tool_calls na resposta do modelo. */
export function parseToolCalls(text, tools = []) {
  const raw = String(text || '');
  const validNames = new Set((Array.isArray(tools) ? tools : []).map((t) => t?.function?.name ?? t?.name).filter(Boolean));

  const lerBloco = (trecho) => {
    let parsed;
    try {
      parsed = JSON.parse(trecho.trim());
    } catch {
      return [];
    }
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.calls) ? parsed.calls : parsed?.name ? [parsed] : [];
    const calls = [];
    for (const item of list) {
      const name = item?.name ?? item?.function?.name ?? item?.tool;
      if (!name || typeof name !== 'string') continue;
      if (validNames.size > 0 && !validNames.has(name)) continue;
      calls.push(montarCall(name, item?.arguments ?? item?.args ?? item?.function?.arguments ?? {}));
    }
    return calls;
  };

  const match = raw.match(TOOL_BLOCK_RE) || raw.match(TOOL_XML_RE);
  if (match) {
    const calls = lerBloco(match[1]);
    if (calls.length) return { text: raw.replace(match[0], '').trim(), toolCalls: calls };
  }

  // Fallback: sintaxe DSML do proprio site (com os pipes deformados pelo markdown).
  const { normalizado, calls } = parseDsmlCalls(raw, validNames);
  if (calls.length) {
    const semBloco = normalizado
      .replace(/<\|DSML\|calls>[\s\S]*?(?:<\/\|DSML\|calls>|$)/gi, '')
      .replace(/<\/?\|DSML\|[^>]*>/gi, '')
      .trim();
    logDsml?.('DSML interpretado como tool_calls');
    return { text: semBloco, toolCalls: calls.map((c) => montarCall(c.name, c.arguments)) };
  }

  return { text: raw.trim(), toolCalls: [] };
}

export function estimateTokens(text) {
  const s = String(text || '');
  if (!s) return 0;
  return Math.max(1, Math.ceil(s.length / 3.6));
}
