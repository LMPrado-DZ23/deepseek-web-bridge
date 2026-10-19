#!/usr/bin/env node
/**
 * Configura o provider deepseek-web no perfil do DeepSeek Harness.
 *
 * Faz duas coisas, de forma idempotente e com backup:
 *   1. acrescenta a rota `deepseek-web` ao patch do `llm-pi-ai` do perfil;
 *   2. grava a credencial de referencia DEEPSEEK_WEB_KEY no cofre local
 *      (~/.dsh/.credentials.yaml), porque o app desktop nao le `.env`.
 *
 * Uso:
 *   node scripts/configure-dsh.mjs [--dsh-home <dir>] [--profile desktop] [--port 8787]
 *
 * Sem `--dsh-home`, usa DSH_HOME ou ~/.dsh.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function flag(nome, padrao) {
  const i = process.argv.indexOf(`--${nome}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : padrao;
}

const dshHome = path.resolve(flag('dsh-home', process.env.DSH_HOME || path.join(os.homedir(), '.dsh')));
const profile = flag('profile', 'desktop');
const port = Number(flag('port', '8787')) || 8787;
const KEY = 'DEEPSEEK_WEB_KEY';

function info(msg) {
  console.log(`[i] ${msg}`);
}
function ok(msg) {
  console.log(`[ok] ${msg}`);
}
function warn(msg) {
  console.log(`[!] ${msg}`);
}

function backup(file) {
  const destino = `${file}.bak-ponte`;
  fs.copyFileSync(file, destino);
  return destino;
}

const patchEntry = `- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      deepseek-web:
        displayName: DeepSeek Web (navegador)
        api: openai-completions
        apiKeyEnv: ${KEY}
        baseURL: http://127.0.0.1:${port}/v1
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
`;

// ---------------------------------------------------------------- patch do perfil
const profileDir = path.join(dshHome, 'profiles', profile);
if (!fs.existsSync(profileDir)) {
  warn(`perfil '${profile}' nao existe em ${profileDir}; pulei o patch do DSH`);
} else {
  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  if (fs.existsSync(patchFile) && fs.readFileSync(patchFile, 'utf8').includes('deepseek-web:')) {
    ok(`provider deepseek-web ja esta no perfil ${profile}`);
  } else if (fs.existsSync(patchFile)) {
    const bak = backup(patchFile);
    fs.appendFileSync(patchFile, `\n${patchEntry}`, 'utf8');
    ok(`provider adicionado em ${patchFile} (backup ${path.basename(bak)})`);
  } else {
    fs.writeFileSync(patchFile, patchEntry, 'utf8');
    ok(`patch do provider criado em ${patchFile}`);
  }
}

// ---------------------------------------------------------------- credencial
const credFile = path.join(dshHome, '.credentials.yaml');
if (fs.existsSync(credFile)) {
  const texto = fs.readFileSync(credFile, 'utf8');
  if (new RegExp(`^\\s{2}${KEY}\\s*:`, 'm').test(texto)) {
    ok(`credencial ${KEY} ja existe no cofre`);
  } else {
    const linhas = texto.split(/\r?\n/);
    const saida = [];
    let inserido = false;
    for (const linha of linhas) {
      saida.push(linha);
      if (!inserido && linha.trim() === 'refs:') {
        saida.push(`  ${KEY}: ponte-local-sem-chave`);
        inserido = true;
      }
    }
    if (!inserido) {
      saida.push('refs:', `  ${KEY}: ponte-local-sem-chave`);
    }
    backup(credFile);
    fs.writeFileSync(credFile, saida.join('\n'), 'utf8');
    ok(`credencial ${KEY} gravada no cofre (backup .bak-ponte)`);
  }
} else {
  const doc = `version: 1\n\nrefs:\n  ${KEY}: ponte-local-sem-chave\n\nrecords: {}\n`;
  fs.mkdirSync(path.dirname(credFile), { recursive: true });
  fs.writeFileSync(credFile, doc, 'utf8');
  ok(`cofre criado com a credencial ${KEY}`);
}

info('reinicie o DSH para o novo provider entrar no catalogo');
