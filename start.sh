#!/usr/bin/env bash
# Sobe a ponte DeepSeek Web (macOS/Linux). Deixe esta janela aberta.
# Uso: ./start.sh [--port 8787] [--headed] [--log-level debug]
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]:-$0}")"

command -v node >/dev/null 2>&1 || { echo "[ERRO] Node.js nao encontrado. Rode ./install.sh primeiro." >&2; exit 1; }
[ -d node_modules/playwright-core ] || { echo "[ERRO] Dependencias ausentes. Rode ./install.sh primeiro." >&2; exit 1; }

echo "Iniciando a ponte DeepSeek Web em http://127.0.0.1:8787 ..."
echo "Feche esta janela ou pressione Ctrl+C para encerrar."
echo
exec node src/index.mjs serve "$@"
