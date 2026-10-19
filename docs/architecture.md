# Arquitetura

## Visão geral

```
┌──────────────┐   HTTP (loopback)   ┌───────────────────────────┐
│ DeepSeek     │ ──────────────────▶ │ deepseek-web-bridge       │
│ Harness      │  /v1/chat/completions│  server.mjs (fila serial) │
│ (llm-pi-ai)  │ ◀────────────────── │  web.mjs (Playwright)     │
└──────────────┘   SSE / JSON        └───────────┬───────────────┘
                                                 │ CDP
                                     ┌───────────▼───────────────┐
                                     │ Chrome dedicado (perfil)  │
                                     │ chat.deepseek.com         │
                                     └───────────────────────────┘
```

O DSH não precisa de fork: o plugin `@deepseek-ai/dsh-llm-pi-ai` aceita
`providers` arbitrários com `baseURL`. A ponte só precisa falar o dialeto
OpenAI o suficiente para o adapter.

## Módulos

| arquivo | responsabilidade |
| --- | --- |
| `src/index.mjs` | CLI: `serve`, `login`, `verify`, `diagnose`, `probe`, `models` |
| `src/server.mjs` | HTTP, autenticação opcional, fila serial, streaming SSE, mapeamento de erros |
| `src/web.mjs` | ciclo de vida do Chrome, `submit()`, `setModes()`, `streamAnswer()`, leitura da resposta |
| `src/dom.mjs` | seletores medidos, `readAssistant()`, detecção de erro na página |
| `src/completion-parse.mjs` | parser do SSE real do site (fragmentos THINK/RESPONSE, patches) |
| `src/prompt.mjs` | achata as mensagens, serializa ferramentas, protocolo de tool calls, tokens |
| `src/native-login.mjs` | abre o Chrome **normal** para SSO e espera o perfil liberar (CIM) |
| `src/config.mjs` | defaults, `data/config.json`, env `DSB_*`, flags |
| `src/log.mjs` | log em arquivo e console |
| `src/selectors.json` | verdade medida do DOM (composer, botões, mensagens, toggles) |

## Fluxo de um turno

1. `POST /v1/chat/completions` chega; valida modelo e corpo.
2. Entra na **fila serial** (um turno por vez).
3. `openNewChat()` navega para um chat novo.
4. `setModes()` liga/desliga "Pensamento Profundo" e **desliga** "Pesquisa
   inteligente" (medido: `div.ds-toggle-button`, estado em `aria-pressed` e/ou
   classe `ds-toggle-button--selected`).
5. O prompt é inserido no composer e enviado (botão ou Enter).
6. `streamAnswer()` faz polling do DOM e emite deltas de `content`; deltas de
   raciocínio saem em `reasoning_content`. O fim é detectado por:
   - corpo SSE capturado pelo listener de rede **e** botão de parar sumiu; ou
   - estabilização do texto (fallback).
7. A resposta final prefere o **SSE** (`content` concatenado dos fragmentos
   `RESPONSE`) e usa o DOM como fallback; `THINK` nunca entra em `content`.
8. O servidor escreve `finish_reason`, `usage` estimado e `[DONE]`.

## Streaming

Os cabeçalhos SSE só são enviados no **primeiro delta** (até ~90 s). Assim,
falhas de login/fila/credencial ainda retornam status HTTP reais. Depois disso,
erros viram um evento `error` no stream.

## Concorrência

- `WebTransport.start()` usa uma promessa compartilhada: só existe um
  `launchPersistentContext` por vez (senão o Chrome morre com `exit 21`).
- `warmup()`, `health({deep:true})` e `submit()` passam pela mesma fila, para
  nunca haver duas navegações na mesma aba.
- Requisições canceladas pelo cliente são detectadas antes de abrir o navegador
  e registradas como `cancelado`, não como erro.

## Configuração

Prioridade: defaults < `data/config.json` < variáveis `DSB_*` < flags.

Principais: `--port`, `--host`, `--headed`, `--log-level`, `--mode`, `--timeout-min`.
Variáveis: `DSB_PORT`, `DSB_HEADLESS`, `DSB_TOKEN`, `DSB_PROFILE_DIR`,
`DSB_URL`, `DSB_LOG_FILE`, `DSB_TOOL_PROTOCOL`.

## Por que não usar a API oficial

A rota oficial (`deepseek-account` / `deepseek-api-key` no DSH) é melhor em tudo
exceto em uma coisa: **não usa a assinatura/conta web**. Esta ponte existe para
quem quer usar o chat web como modelo local, aceitando latência, fragilidade de
DOM e a ausência de tool-calling nativo.
