<#
.SYNOPSIS
  Faz a ponte DeepSeek Web subir junto com o Windows (sem janela visivel).

.DESCRIPTION
  Cria (ou remove) um atalho na pasta Inicializar do usuario apontando para
  start-hidden.vbs. Assim o modelo "DeepSeek Web" do DSH nao depende de voce
  abrir terminal: se a ponte nao estiver no ar, o DSH mostra "Connection error".

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File autostart.ps1
  powershell -ExecutionPolicy Bypass -File autostart.ps1 -Remove

.NOTES
  Para desfazer: rode com -Remove ou apague o atalho em
  %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup.
#>
[CmdletBinding()]
param(
  [switch]$Remove,
  [string]$InstallDir
)

$ErrorActionPreference = 'Stop'
$dir = if ($InstallDir) { $InstallDir } else { $PSScriptRoot }
$pastaInicializar = [Environment]::GetFolderPath('Startup')
$atalho = Join-Path $pastaInicializar 'DeepSeek Web Bridge.lnk'

if ($Remove) {
  if (Test-Path -LiteralPath $atalho) {
    Remove-Item -LiteralPath $atalho -Force
    Write-Host "[ok] atalho removido: $atalho"
  } else {
    Write-Host "[i] nao havia atalho para remover"
  }
  exit 0
}

$vbs = Join-Path $dir 'start-hidden.vbs'
if (-not (Test-Path -LiteralPath $vbs)) { throw "start-hidden.vbs nao encontrado em $dir" }
if (-not (Test-Path -LiteralPath (Join-Path $dir 'start.cmd'))) { throw "start.cmd nao encontrado em $dir" }

$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($atalho)
$link.TargetPath = 'wscript.exe'
$link.Arguments = '"' + $vbs + '"'
$link.WorkingDirectory = $dir
$link.WindowStyle = 7
$link.Description = 'Ponte DeepSeek Web para o DeepSeek Harness (loopback 8787)'
$link.Save()

Write-Host "[ok] autostart criado: $atalho"
Write-Host "     comando: wscript.exe `"$vbs`""
Write-Host "     para desfazer: powershell -ExecutionPolicy Bypass -File `"$(Join-Path $dir 'autostart.ps1')`" -Remove"
exit 0
