@echo off
rem Atalho para o instalador em PowerShell (Windows).
rem Uso: install.cmd  [--args extras sao repassados ao install.ps1]
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set "CODIGO=%ERRORLEVEL%"
if not "%CODIGO%"=="0" pause
exit /b %CODIGO%
