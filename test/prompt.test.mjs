import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPrompt,
  contentToText,
  normalizeDsml,
  normalizeMessages,
  parseToolCalls,
  serializeTools,
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

// O chat web imita a sintaxe interna DSML do DeepSeek e o markdown do site
// deforma os pipes com espacos. Amostra real capturada no DSH.
const dsmlMangled = `< | | DSML | | calls> < | | DSML | | invoke name="pwsh"> < | | DSML | | parameter name="command" string="true">Get-Location; Get-ChildItem -Force | Select-Object Mode,LastWriteTime,Length,Name | Format-Table -AutoSize</ | | DSML | | parameter> < | | DSML | | parameter name="description" string="true">Show working directory and contents</ | | DSML | | parameter> </ | | DSML | | invoke> </ | | DSML | | calls>`;
const pwshTool = { type: 'function', function: { name: 'pwsh', description: 'shell', parameters: { type: 'object' } } };

test('normalizeDsml: restaura os pipes deformados pelo markdown', () => {
  const saida = normalizeDsml(dsmlMangled);
  assert.match(saida, /<\|DSML\|calls>/);
  assert.match(saida, /<\|DSML\|invoke name="pwsh">/);
  assert.match(saida, /<\/\|DSML\|invoke>/);
  assert.doesNotMatch(saida, /\| \| DSML/);
});

test('parseToolCalls: DSML deformado vira tool_calls com argumentos string', () => {
  const { text, toolCalls } = parseToolCalls(dsmlMangled, [pwshTool]);
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].function.name, 'pwsh');
  const args = JSON.parse(toolCalls[0].function.arguments);
  assert.match(args.command, /Get-Location/);
  assert.match(args.command, /Select-Object/);
  assert.equal(args.description, 'Show working directory and contents');
  assert.doesNotMatch(text, /DSML/);
});

test('parseToolCalls: varios invokes DSML e parametro JSON', () => {
  const raw = [
    '<|DSML|calls>',
    '<|DSML|invoke name="pwsh">',
    '<|DSML|parameter name="command" string="true">echo 1</|DSML|parameter>',
    '</|DSML|invoke>',
    '<|DSML|invoke name="get_weather">',
    '<|DSML|parameter name="city" string="true">Recife</|DSML|parameter>',
    '<|DSML|parameter name="dias">3</|DSML|parameter>',
    '</|DSML|invoke>',
    '</|DSML|calls>',
  ].join('\n');
  const { toolCalls } = parseToolCalls(raw, [pwshTool, weatherTool]);
  assert.equal(toolCalls.length, 2);
  assert.equal(toolCalls[0].function.name, 'pwsh');
  const clima = toolCalls.find((c) => c.function.name === 'get_weather');
  assert.deepEqual(JSON.parse(clima.function.arguments), { city: 'Recife', dias: 3 });
});

test('parseToolCalls: DSML com ferramenta desconhecida e ignorado', () => {
  const raw = '<|DSML|calls><|DSML|invoke name="rm_rf"><|DSML|parameter name="p" string="true">/</|DSML|parameter></|DSML|invoke></|DSML|calls>';
  const { toolCalls } = parseToolCalls(raw, [weatherTool]);
  assert.equal(toolCalls.length, 0);
});

test('parseToolCalls: bloco cercado tem prioridade sobre DSML', () => {
  const raw = '```tool_calls\n{"calls":[{"name":"get_weather","arguments":{"city":"Recife"}}]}\n```';
  const { toolCalls } = parseToolCalls(raw + '\n' + dsmlMangled, [weatherTool, pwshTool]);
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].function.name, 'get_weather');
});

test('serializeTools: modo compacto reduz o catalogo sem perder o essencial', () => {
  const tool = {
    type: 'function',
    function: {
      name: 'pwsh',
      description: 'd'.repeat(500),
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'e'.repeat(300) },
          timeout: { type: 'number' },
        },
        required: ['command'],
      },
    },
  };
  const compacto = serializeTools([tool], { compact: true });
  const cheio = serializeTools([tool], { compact: false });
  assert.ok(compacto.length * 2 < cheio.length, 'compacto precisa ser bem menor');
  const [fn] = JSON.parse(compacto);
  assert.equal(fn.name, 'pwsh');
  assert.deepEqual(fn.parameters.required, ['command']);
  assert.equal(fn.parameters.properties.command.type, 'string');
  assert.equal(fn.parameters.properties.timeout.type, 'number');
  assert.doesNotMatch(compacto, /eeee/, 'descricao de parametro nao vai no compacto');
  assert.match(cheio, /eeee/);
});

test('buildPrompt: toolCatalogCompact=false injeta o schema completo', () => {
  const grande = {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Consulta clima ' + 'd'.repeat(400),
      parameters: {
        type: 'object',
        properties: { city: { type: 'string', description: 'e'.repeat(300) } },
        required: ['city'],
      },
    },
  };
  const mensagens = [{ role: 'user', content: 'use a ferramenta' }];
  const compacto = buildPrompt(mensagens, { tools: [grande], toolProtocol: true }).prompt;
  const completo = buildPrompt(mensagens, { tools: [grande], toolProtocol: true, toolCatalogCompact: false }).prompt;
  assert.ok(compacto.length < completo.length);
  assert.match(compacto, /get_weather/);
  assert.doesNotMatch(compacto, /eeee/);
  assert.match(completo, /eeee/);
});

test('estimateTokens: proporcional ao tamanho', () => {
  assert.equal(estimateTokens(''), 0);
  assert.ok(estimateTokens('a'.repeat(360)) >= 100);
});
