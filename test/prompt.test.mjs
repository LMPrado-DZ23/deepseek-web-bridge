import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPrompt,
  contentToText,
  normalizeMessages,
  parseToolCalls,
  truncateBlocks,
  estimateTokens,
} from '../src/prompt.mjs';

const weatherTool = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Consulta o clima de uma cidade',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
  },
};

test('contentToText: string passa direto', () => {
  assert.equal(contentToText('ola'), 'ola');
});

test('contentToText: partes multimodais viram texto e aviso de imagem', () => {
  const text = contentToText([
    { type: 'text', text: 'descreva' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
  ]);
  assert.match(text, /descreva/);
  assert.match(text, /imagem recebida/);
});

test('normalizeMessages: developer vira system e tool recebe rotulo', () => {
  const blocks = normalizeMessages([
    { role: 'developer', content: 'seja breve' },
    { role: 'tool', name: 'ls', content: 'a.txt' },
  ]);
  assert.deepEqual(blocks.map((b) => b.role), ['system', 'tool']);
  assert.match(blocks[1].text, /Resultado da ferramenta ls/);
});

test('normalizeMessages: tool_calls do assistente sao serializadas no prompt', () => {
  const blocks = normalizeMessages([
    { role: 'user', content: 'clima?' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Recife"}' } }],
    },
  ]);
  assert.match(blocks[1].text, /```tool_calls/);
  assert.match(blocks[1].text, /get_weather/);
});

test('buildPrompt: primeiro turno simples nao e embrulhado', () => {
  const { prompt, lastUserText } = buildPrompt([{ role: 'user', content: 'responda ok' }]);
  assert.equal(prompt, 'responda ok');
  assert.equal(lastUserText, 'responda ok');
});

test('buildPrompt: varios turnos usam rotulos PT-BR', () => {
  const { prompt } = buildPrompt([
    { role: 'system', content: 'voce e um agente' },
    { role: 'user', content: 'primeira' },
    { role: 'assistant', content: 'segunda' },
    { role: 'user', content: 'terceira' },
  ]);
  assert.match(prompt, /### SYSTEM\nvoce e um agente/);
  assert.match(prompt, /### USUARIO\nprimeira/);
  assert.match(prompt, /### ASSISTENTE\nsegunda/);
  assert.match(prompt, /### USUARIO\nterceira/);
});

test('buildPrompt: system + unico usuario concatena sem rotulos', () => {
  const { prompt } = buildPrompt([
    { role: 'system', content: 'instrucao' },
    { role: 'user', content: 'pergunta' },
  ]);
  assert.equal(prompt, 'instrucao\n\npergunta');
});

test('buildPrompt: protocolo de ferramentas injeta catalogo', () => {
  const { prompt } = buildPrompt([{ role: 'user', content: 'veja o clima' }], {
    tools: [weatherTool],
    toolProtocol: true,
  });
  assert.match(prompt, /FERRAMENTAS LOCAIS DISPONIVEIS/);
  assert.match(prompt, /get_weather/);
  assert.match(prompt, /```tool_calls/);
});

test('buildPrompt: toolProtocol desligado nao injeta nada', () => {
  const { prompt } = buildPrompt([{ role: 'user', content: 'oi' }], {
    tools: [weatherTool],
    toolProtocol: false,
  });
  assert.doesNotMatch(prompt, /FERRAMENTAS LOCAIS/);
});

test('truncateBlocks: corta historico antigo e sinaliza com marcador', () => {
  const blocks = [
    { role: 'system', text: 'sys' },
    { role: 'user', text: 'a'.repeat(500) },
    { role: 'assistant', text: 'b'.repeat(500) },
    { role: 'user', text: 'ultima pergunta' },
  ];
  const out = truncateBlocks(blocks, 700);
  assert.equal(out[0].role, 'system');
  assert.equal(out.at(-1).text, 'ultima pergunta');
  assert.equal(out.filter((b) => /Historico anterior truncado/.test(b.text)).length, 1);
  assert.equal(out.some((b) => b.text === 'a'.repeat(500)), false);
});

test('truncateBlocks: sem orcamento devolve a lista intacta', () => {
  const blocks = [{ role: 'user', text: 'oi' }];
  assert.equal(truncateBlocks(blocks, 0), blocks);
});

test('truncateBlocks: quando nem o ultimo bloco cabe, corta o texto pelo fim', () => {
  const blocks = [
    { role: 'system', text: 'sys' },
    { role: 'user', text: 'x'.repeat(5_000) },
  ];
  const out = truncateBlocks(blocks, 1_200);
  assert.equal(out[0].role, 'system');
  const last = out.at(-1);
  assert.equal(last.role, 'user');
  assert.ok(last.text.length <= 1_200);
  assert.ok(last.text.endsWith('x'));
});

test('parseToolCalls: bloco cercado valido vira tool_calls', () => {
  const raw = '```tool_calls\n{"calls":[{"name":"get_weather","arguments":{"city":"Recife"}}]}\n```';
  const { text, toolCalls } = parseToolCalls(raw, [weatherTool]);
  assert.equal(text, '');
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].type, 'function');
  assert.equal(toolCalls[0].function.name, 'get_weather');
  assert.deepEqual(JSON.parse(toolCalls[0].function.arguments), { city: 'Recife' });
});

test('parseToolCalls: nome fora do catalogo e ignorado', () => {
  const raw = '```tool_calls\n{"calls":[{"name":"rm_rf","arguments":{}}]}\n```';
  const { toolCalls } = parseToolCalls(raw, [weatherTool]);
  assert.equal(toolCalls.length, 0);
});

test('parseToolCalls: sem bloco devolve o texto intacto', () => {
  const { text, toolCalls } = parseToolCalls('resposta normal', [weatherTool]);
  assert.equal(text, 'resposta normal');
  assert.equal(toolCalls.length, 0);
});

test('parseToolCalls: JSON invalido nao explode', () => {
  const { text, toolCalls } = parseToolCalls('```tool_calls\n{nao e json}\n```', [weatherTool]);
  assert.equal(toolCalls.length, 0);
  assert.match(text, /nao e json/);
});

test('estimateTokens: proporcional ao tamanho', () => {
  assert.equal(estimateTokens(''), 0);
  assert.ok(estimateTokens('a'.repeat(360)) >= 100);
});
