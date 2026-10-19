@echo off
rem ===========================================================================
rem  Ponte DeepSeek Web - sobe o servidor local (loopback) usado pelo DSH.
rem  Deixe esta janela aberta enquanto quiser usar o modelo no harness.
rem  Uso: start.cmd            (porta 8787)
rem       start.cmd --port 9000
rem       start.cmd --help
rem ===========================================================================
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERRO] Node.js nao encontrado no PATH. Rode instalar.cmd primeiro.
  pause
  exit /b 1
)

if not exist "node_modules\playwright-core" (
  echo [ERRO] Dependencias ausentes. Rode instalar.cmd primeiro.
  pause
  exit /b 1
)

echo Iniciando a ponte DeepSeek Web em http://127.0.0.1:8787 ...
echo Feche esta janela ou pressione Ctrl+C para encerrar.
echo.
node src\index.mjs serve %*
set "CODIGO=%ERRORLEVEL%"
echo.
echo Ponte encerrada ^(codigo %CODIGO%^).
if not "%CODIGO%"=="0" pause
exit /b %CODIGO%
