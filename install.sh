#!/usr/bin/env bash
# Instalador da ponte DeepSeek Web para macOS e Linux.
#
# Uso local:
#   bash install.sh
# Uso remoto:
#   curl -fsSL https://raw.githubusercontent.com/LMPrado-DZ23/deepseek-web-bridge/main/install.sh | bash
#
# Opcoes (variaveis de ambiente):
#   PROFILE=desktop      perfil do DSH que recebe o provider
#   PORT=8787            porta loopback da ponte
#   NO_LOGIN=1           pula o login inicial
#   NO_DSH=1             nao mexe no perfil do DSH
#   DSH_HOME=~/.dsh      pasta do harness
#   INSTALL_DIR=...      onde instalar (default: ~/.local/share/deepseek-web-bridge)
set -euo pipefail

REPO="LMPrado-DZ23/deepseek-web-bridge"
BRANCH="main"
PROFILE="${PROFILE:-desktop}"
PORT="${PORT:-8787}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"

info() { printf '[i] %s\n' "$1"; }
ok() { printf '[ok] %s\n' "$1"; }
warn() { printf '[!] %s\n' "$1"; }
fail() { printf '[ERRO] %s\n' "$1" >&2; exit 1; }

# ---------------------------------------------------------------- Node.js
command -v node >/dev/null 2>&1 || fail "Node.js nao encontrado. Instale a versao LTS em https://nodejs.org/ e rode de novo."
NODE_VER="$(node -p 'process.versions.node')"
NODE_MAJOR="${NODE_VER%%.*}"
info "Node.js $NODE_VER"
[ "$NODE_MAJOR" -ge 20 ] || fail "Node.js 20+ e obrigatorio (encontrado $NODE_VER)."

# ---------------------------------------------------------------- projeto
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [ -n "${INSTALL_DIR:-}" ]; then
  DEST="$INSTALL_DIR"
elif [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/package.json" ] && [ -f "$SCRIPT_DIR/src/index.mjs" ]; then
  DEST="$SCRIPT_DIR"
else
  DEST="${XDG_DATA_HOME:-$HOME/.local/share}/deepseek-web-bridge"
fi

if [ ! -f "$DEST/package.json" ] || [ ! -f "$DEST/src/index.mjs" ]; then
  command -v curl >/dev/null 2>&1 || fail "curl nao encontrado (necessario para baixar o projeto)."
  ZIP="$(mktemp -t dwb.XXXXXX).zip"
  info "baixando o projeto de https://codeload.github.com/$REPO/zip/refs/heads/$BRANCH"
  curl -fsSL "https://codeload.github.com/$REPO/zip/refs/heads/$BRANCH" -o "$ZIP" || fail "nao consegui baixar o projeto."
  TMP="$(mktemp -d)"
  if command -v unzip >/dev/null 2>&1; then
    unzip -q "$ZIP" -d "$TMP"
  else
    python3 -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$ZIP" "$TMP" || fail "preciso de unzip ou python3."
  fi
  SRC="$(find "$TMP" -maxdepth 1 -mindepth 1 -type d | head -n 1)"
  mkdir -p "$DEST"
  cp -R "$SRC"/. "$DEST"/
  rm -rf "$TMP" "$ZIP"
  ok "projeto em $DEST"
fi
cd "$DEST"
info "projeto: $DEST"

# ---------------------------------------------------------------- Chrome
case "$(uname -s)" in
  Darwin)
    CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    ;;
  *)
    CHROME="$(command -v google-chrome || command -v google-chrome-stable || command -v chromium || command -v chromium-browser || true)"
    ;;
esac
if [ -n "${CHROME:-}" ] && [ -x "$CHROME" ]; then
  ok "Chrome: $CHROME"
else
  warn "Google Chrome nao encontrado. A ponte usa o Chrome instalado (channel 'chrome')."
fi

# ---------------------------------------------------------------- dependencias
info "instalando dependencias (playwright-core)..."
npm install --no-audit --no-fund
ok "dependencias instaladas"

# ---------------------------------------------------------------- login
if [ "${NO_LOGIN:-0}" != "1" ]; then
  echo
  info "login no chat.deepseek.com: vai abrir o Chrome NORMAL (sem automacao)."
  info "Entre na sua conta (Google/Apple funcionam nessa janela) e FECHE o Chrome."
  node src/index.mjs login || warn "login nao confirmado; rode ./login.sh quando quiser."
fi

# ---------------------------------------------------------------- DSH
if [ "${NO_DSH:-0}" = "1" ]; then
  info "pulando configuracao do DSH (NO_DSH=1); use node scripts/configure-dsh.mjs quando quiser"
else
  node scripts/configure-dsh.mjs --dsh-home "$DSH_HOME" --profile "$PROFILE" --port "$PORT"
fi

chmod +x start.sh login.sh 2>/dev/null || true

echo
ok "instalacao concluida"
echo
echo "Como usar:"
echo "  1. suba a ponte:   $DEST/start.sh"
echo "  2. reinicie o DSH e escolha 'DeepSeek Web (navegador)' ou 'DeepSeek Web Think'."
echo
echo "Aviso: automatizar o chat.deepseek.com com a sua sessao pode contrariar os"
echo "Termos de Uso do servico e ha risco de restricao da conta. Use por sua conta"
echo "e risco; para uso serio prefira a rota oficial autenticada do DSH."
