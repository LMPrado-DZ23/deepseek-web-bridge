#!/usr/bin/env bash
# Login unico no chat.deepseek.com (macOS/Linux).
# Abre o Google Chrome NORMAL (sem automacao) no perfil da ponte; e por isso que
# "Entrar com Google"/"Entrar com Apple" funcionam aqui.
# Depois de entrar, FECHE a janela: a ponte confere a sessao.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]:-$0}")"

command -v node >/dev/null 2>&1 || { echo "[ERRO] Node.js nao encontrado. Rode ./install.sh primeiro." >&2; exit 1; }
exec node src/index.mjs login "$@"
