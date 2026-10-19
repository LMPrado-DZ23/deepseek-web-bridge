# Problemas comuns

## O DSH mostra `MISSING_CREDENTIAL` para a rota `deepseek-web`

O DSH não achou o valor de `apiKeyEnv: DEEPSEEK_WEB_KEY`.

- O valor **não** pode estar só em `%DSH_HOME%\.env` — o app desktop não lê esse
  arquivo para `apiKeyEnv`.
- Grave a referência no cofre (`~/.dsh/.credentials.yaml`):

  ```yaml
  version: 1

  refs:
    DEEPSEEK_WEB_KEY: ponte-local-sem-chave

  records: {}
  ```

  O cofre recarrega sozinho; não precisa reiniciar.
- Alternativa: exportar `DEEPSEEK_WEB_KEY` como variável de ambiente do Windows
  **antes** de abrir o DSH (o snapshot do launcher é congelado no boot).

## `Target page, context or browser has been closed` ou Chrome `exit 21`

Dois processos tentando usar o mesmo perfil. A ponte, o login, `probe`,
`diagnose` e o smoke test **não podem rodar ao mesmo tempo**.

```powershell
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
  Where-Object { $_.CommandLine -like "*dsh-deepseek-web*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

## `COMPOSER_NOT_FOUND` / `site_layout_changed`

O layout do site mudou. Rode:

```powershell
node src/index.mjs diagnose --headed
```

Veja o relatório em `data/diagnose-*.json` (`seletores:` com `OK`/`--`),
atualize `src/selectors.json` e rode `npm test`.

## Login com Google/Apple recusado ("este navegador não é seguro")

Use `login.cmd` (Chrome normal, sem automação). O modo `login --auto` abre o
Chrome controlado por CDP e o Google recusa SSO nele. Se a janela não abrir,
confirme que o Chrome está em `C:\Program Files\Google\Chrome\Application\chrome.exe`.

## Sessão expirou no meio de um turno

```powershell
login.cmd
node src/index.mjs verify --wait
```

Depois reinicie a ponte (`start.cmd`).

## A resposta demora muito ou volta `TIMEOUT_FIRST_TOKEN`

- Confirme que a "Pesquisa inteligente" está desligada (a ponte tenta desligar
  sozinha; veja `--log-level debug`).
- Turnos com prompt gigante (catálogo de ferramentas grande) demoram mais.
- O site pode estar com desafio anti-bot; tente um turno curto com
  `node src/index.mjs probe "oi"`.

## Porta 8787 ocupada

```powershell
.\start.cmd --port 9000
```

E ajuste `baseURL` no provider do DSH para `http://127.0.0.1:9000/v1`.

## O DSH não mostra os modelos novos

O catálogo é montado no boot. **Reinicie o DSH** depois de instalar ou alterar o
provider. Confira o perfil:

```powershell
node src/index.mjs models
Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml" | Select-String deepseek-web
```

## Quero ver o que está acontecendo

```powershell
.\start.cmd --log-level debug
Get-Content .\logs\bridge.log -Tail 40
```

Cada turno registra modelo, tamanho do prompt/resposta, tempo e origem do texto.
