<#
.SYNOPSIS
  Instalador da ponte DeepSeek Web (chat.deepseek.com como modelo no DeepSeek Harness).

.DESCRIPTION
  Faz tudo em um comando:
    1. confere Node.js 20+ e Google Chrome;
    2. baixa (se preciso) e instala as dependencias do projeto;
    3. opcionalmente faz o login inicial no chat.deepseek.com;
    4. registra o provider "deepseek-web" no perfil do DSH e grava a credencial
       de referencia (DEEPSEEK_WEB_KEY) no cofre local.

  Uso local:
    powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1

  Uso remoto (uma linha):
    irm https://raw.githubusercontent.com/LMPrado-DZ23/deepseek-web-bridge/main/install.ps1 | iex

.PARAMETER DshHome
  Pasta do harness (default: $env:USERPROFILE\.dsh).

.PARAMETER Profile
  Perfil do DSH que recebe o provider (default: desktop).

.PARAMETER Port
  Porta loopback da ponte (default: 8787).

.PARAMETER NoLogin
  Nao abre a janela de login agora (faca depois com login.cmd).

.PARAMETER NoDsh
  Nao mexe no perfil do DSH; so instala a ponte e mostra o trecho para colar.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install.ps1 -Profile desktop
#>
[CmdletBinding()]
param(
  [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'),
  [string]$Profile = 'desktop',
  [int]$Port = 8787,
  [switch]$NoLogin,
  [switch]$NoDsh,
  [string]$InstallDir
)

$ErrorActionPreference = 'Stop'
$repo = 'LMPrado-DZ23/deepseek-web-bridge'
$branch = 'main'

function Info($m) { Write-Host "[i] $m" }
function Ok($m) { Write-Host "[ok] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[!] $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "[ERRO] $m" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------- 1. Node.js
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail 'Node.js nao encontrado. Instale a versao LTS em https://nodejs.org/ e rode de novo.' }
$nodeVersion = (& node -p "process.versions.node").Trim()
$nodeMajor = [int]($nodeVersion.Split('.')[0])
Info "Node.js $nodeVersion"
if ($nodeMajor -lt 20) { Fail "Node.js 20+ e obrigatorio (encontrado $nodeVersion)." }

# ---------------------------------------------------------------- 2. projeto
function Test-Projeto([string]$dir) {
  return (Test-Path -LiteralPath (Join-Path $dir 'package.json')) -and
         (Test-Path -LiteralPath (Join-Path $dir 'src\index.mjs'))
}

if (-not $InstallDir) {
  if ($PSScriptRoot -and (Test-Projeto $PSScriptRoot)) {
    $InstallDir = $PSScriptRoot
  } else {
    $InstallDir = Join-Path $env:LOCALAPPDATA 'deepseek-web-bridge'
  }
}

if (-not (Test-Projeto $InstallDir)) {
  $zip = Join-Path $env:TEMP 'deepseek-web-bridge.zip'
  $url = "https://codeload.github.com/$repo/zip/refs/heads/$branch"
  Info "baixando o projeto de $url"
  try {
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
  } catch {
    Fail "nao consegui baixar o projeto: $($_.Exception.Message)"
  }
  $tmp = Join-Path $env:TEMP ("dwb-" + [guid]::NewGuid().ToString('n'))
  Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
  $src = Get-ChildItem -LiteralPath $tmp -Directory | Select-Object -First 1
  if (-not $src) { Fail 'zip do projeto veio vazio.' }
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  Copy-Item -Path (Join-Path $src.FullName '*') -Destination $InstallDir -Recurse -Force
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Ok "projeto em $InstallDir"
}
Set-Location -LiteralPath $InstallDir
Info "projeto: $InstallDir"

# ---------------------------------------------------------------- 3. Chrome
$chromePaths = @(
  (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
  (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
if ($chromePaths.Count -eq 0) {
  Warn 'Google Chrome nao encontrado nos caminhos padrao. A ponte usa o Chrome instalado; instale-o antes de rodar.'
} else {
  Ok "Chrome: $(@($chromePaths)[0])"
}

# ---------------------------------------------------------------- 4. dependencias
Info 'instalando dependencias (playwright-core)...'
& npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Fail 'npm install falhou.' }
Ok 'dependencias instaladas'

# ---------------------------------------------------------------- 5. login
if (-not $NoLogin) {
  Write-Host ''
  Info 'login no chat.deepseek.com: vai abrir o Chrome NORMAL (sem automacao).'
  Info 'Entre na sua conta (Google/Apple funcionam nessa janela) e FECHE o Chrome.'
  & node src\index.mjs login
  if ($LASTEXITCODE -ne 0) { Warn 'login nao confirmado; rode login.cmd quando quiser.' }
}

# ---------------------------------------------------------------- 6. DSH
$patchEntry = @"
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      deepseek-web:
        displayName: DeepSeek Web (navegador)
        api: openai-completions
        apiKeyEnv: DEEPSEEK_WEB_KEY
        baseURL: http://127.0.0.1:$Port/v1
        defaultContextWindow: 131072
        defaultMaxTokens: 8192
        models:
          - id: deepseek-web
            name: DeepSeek Web (chat no site)
            contextWindow: 131072
            maxTokens: 8192
          - id: deepseek-web-think
            name: DeepSeek Web Think (raciocinio no site)
            contextWindow: 131072
            maxTokens: 32768
        compat:
          supportsDeveloperRole: false
          supportsUsageInStreaming: false
"@

if ($NoDsh) {
  Write-Host ''
  Info 'trecho para colar no seu perfil do DSH (patches do llm-pi-ai):'
  Write-Host $patchEntry
} else {
  $profileDir = Join-Path $DshHome "profiles\$Profile"
  $patchFile = Join-Path $profileDir 'cordis.patch.yml'
  if (-not (Test-Path -LiteralPath $profileDir)) {
    Warn "perfil '$Profile' nao existe em $profileDir; pulei a configuracao do DSH."
  } elseif ((Test-Path -LiteralPath $patchFile) -and (Select-String -LiteralPath $patchFile -Pattern 'deepseek-web:' -Quiet)) {
    Ok "provider deepseek-web ja esta no perfil $Profile"
  } else {
    if (Test-Path -LiteralPath $patchFile) {
      Copy-Item -LiteralPath $patchFile -Destination "$patchFile.bak-ponte" -Force
      [System.IO.File]::AppendAllText($patchFile, "`r`n$patchEntry", (New-Object System.Text.UTF8Encoding($false)))
      Ok "provider adicionado em $patchFile (backup .bak-ponte)"
    } else {
      [System.IO.File]::WriteAllText($patchFile, $patchEntry, (New-Object System.Text.UTF8Encoding($false)))
      Ok "patch do provider criado em $patchFile"
    }
  }

  # Credencial de referencia: o DSH exige apiKeyEnv resolvivel, mas o valor e
  # um marcador local (a ponte ignora o header Authorization).
  $credFile = Join-Path $DshHome '.credentials.yaml'
  $marker = 'DEEPSEEK_WEB_KEY'
  if ((Test-Path -LiteralPath $credFile) -and (Select-String -LiteralPath $credFile -Pattern "^  $marker\s*:" -Quiet)) {
    Ok "credencial $marker ja existe no cofre"
  } elseif (Test-Path -LiteralPath $credFile) {
    Copy-Item -LiteralPath $credFile -Destination "$credFile.bak-ponte" -Force
    $lines = [System.IO.File]::ReadAllLines($credFile)
    $out = New-Object System.Collections.Generic.List[string]
    $inserted = $false
    foreach ($line in $lines) {
      $out.Add($line)
      if (-not $inserted -and $line.Trim() -eq 'refs:') {
        $out.Add("  ${marker}: ponte-local-sem-chave")
        $inserted = $true
      }
    }
    if (-not $inserted) { $out.Add('refs:'); $out.Add("  ${marker}: ponte-local-sem-chave") }
    [System.IO.File]::WriteAllLines($credFile, $out, (New-Object System.Text.UTF8Encoding($false)))
    Ok "credencial $marker gravada no cofre (backup .bak-ponte)"
  } else {
    $doc = "version: 1`n`nrefs:`n  ${marker}: ponte-local-sem-chave`n`nrecords: {}`n"
    [System.IO.File]::WriteAllText($credFile, $doc, (New-Object System.Text.UTF8Encoding($false)))
    Ok "cofre criado com a credencial $marker"
  }
}

# ---------------------------------------------------------------- 7. resumo
Write-Host ''
Ok 'instalacao concluida'
Write-Host ''
Write-Host 'Como usar:'
Write-Host "  1. suba a ponte:   $(Join-Path $InstallDir 'start.cmd')"
Write-Host "  2. reinicie o DSH e escolha o modelo 'DeepSeek Web (navegador)' ou 'DeepSeek Web Think'."
Write-Host ''
Write-Host 'Aviso: automatizar o chat.deepseek.com com a sua sessao pode contrariar os'
Write-Host 'Termos de Uso do servico e ha risco de restricao da conta. Use por sua conta'
Write-Host 'e risco; para uso serio prefira a rota oficial autenticada do DSH.'
