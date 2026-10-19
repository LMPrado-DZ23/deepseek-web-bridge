# Modelo de segurança

## Superfície

A ponte abre **um servidor HTTP em loopback** (`127.0.0.1:8787` por padrão) e
controla **um Chrome dedicado** com um perfil próprio. Não abre portas públicas,
não faz túnel e não envia dados para terceiros.

```
cliente local (DSH) ──▶ 127.0.0.1:8787 ──▶ Chrome dedicado ──▶ chat.deepseek.com
```

## O que fica no disco

| caminho | conteúdo | cuidado |
| --- | --- | --- |
| `%LOCALAPPDATA%\dsh-deepseek-web\chrome-profile` | cookies/sessão da conta DeepSeek | **é credencial**: não copie, não versione, não compartilhe |
| `logs\bridge.log` | prompts, tamanhos, tempos, erros | pode conter texto de conversa em mensagens de erro |
| `data\` | capturas de SSE, relatórios de diagnóstico | contém conversas reais; não versionar |
| `~/.dsh/.credentials.yaml` | marcador `DEEPSEEK_WEB_KEY` | **não é segredo** (valor fixo), mas o arquivo guarda outras chaves reais |

O `.gitignore` do projeto exclui `node_modules`, `logs`, `data` e `session.json`.
Nunca faça commit do perfil do Chrome.

## Autenticação da ponte

- Por padrão **não há token**: o limite é o loopback. Qualquer processo do mesmo
  usuário consegue chamar a ponte.
- Para exigir token, defina `DSB_TOKEN` (ou `--token`) e envie
  `Authorization: Bearer <token>`. O endpoint `/health` continua aberto.
- O token da ponte **não** é o token do DeepSeek; a sessão do site fica só nos
  cookies do perfil do Chrome.

## Credencial do DSH

O DSH exige que `apiKeyEnv` resolva para algum valor. `DEEPSEEK_WEB_KEY` é um
marcador fixo (`ponte-local-sem-chave`) guardado em `refs:` do cofre local. A
ponte ignora o header `Authorization`; não existe chave de API do DeepSeek
envolvida.

## Riscos conhecidos

1. **Termos de Uso.** Automatizar o `chat.deepseek.com` com a própria sessão pode
   violar os Termos de Uso e levar a restrição da conta. O projeto não contorna
   desafios anti-bot de forma deliberada; se o site bloquear, a ponte devolve erro.
2. **Sessão no disco.** Quem tiver acesso ao seu usuário do Windows pode ler o
   perfil do Chrome. Use a conta do SO protegida por senha.
3. **Prompt injection via página.** O conteúdo lido do site é tratado como dado;
   ainda assim, um site comprometido poderia devolver texto malicioso que o
   modelo do DSH venha a seguir. Mantenha as permissões do agente conscientes.
4. **Vazamento em logs.** `--log-level debug` grava mais detalhes; em máquinas
   compartilhadas prefira o nível `info` e apague `logs\` ao terminar.

## Reportar vulnerabilidades

Abra uma issue privada (Security → Report a vulnerability) ou descreva o caso
sem dados sensíveis. Não inclua cookies, tokens ou trechos de conversa.
