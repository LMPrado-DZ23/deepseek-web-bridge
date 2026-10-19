@echo off
rem ===========================================================================
rem  Login unico no chat.deepseek.com.
rem  Abre o Google Chrome NORMAL (sem automacao) no perfil exclusivo da ponte:
rem  e por isso que "Entrar com Google" e "Entrar com Apple" funcionam aqui.
rem  Depois de entrar, FECHE a janela do Chrome: a ponte confere a sessao.
rem
rem  Uso: login.cmd
rem       login.cmd --auto     (abre o Chrome automatizado; pior para Google)
rem       login.cmd --help
rem ===========================================================================
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERRO] Node.js nao encontrado no PATH. Rode instalar.cmd primeiro.
  pause
  exit /b 1
)

node src\index.mjs login %*
set "CODIGO=%ERRORLEVEL%"
if not "%CODIGO%"=="0" pause
exit /b %CODIGO%
