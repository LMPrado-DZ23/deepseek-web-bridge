/**
 * Configuracao da ponte. Precedencia: padroes < data/config.json < variaveis de ambiente < argumentos CLI.
 * Nada aqui contem segredo: a ponte nao usa chave de API real, apenas uma referencia falsa
 * exigida pelo DSH (apiKeyEnv) e ignorada pelo servidor.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const LOG_DIR = path.join(ROOT, 'logs');

const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

export const DEFAULTS = {
  host: '127.0.0.1',
  port: 8787,
  chatUrl: 'https://chat.deepseek.com/',
  // Perfil dedicado do navegador: NAO usa o perfil pessoal do Chrome do usuario.
  profileDir: path.join(LOCALAPPDATA, 'dsh-deepseek-web', 'chrome-profile'),
  browserChannel: 'chrome', // 'chrome' | 'msedge' | 'chromium'
  headless: true,
  navTimeoutMs: 60_000,
  firstTokenTimeoutMs: 90_000,
  requestTimeoutMs: 300_000,
  settleMs: 1_200,
  pollMs: 180,
  idleCloseMs: 900_000,
  maxQueue: 8,
  maxPromptChars: 380_000,
  toolProtocol: true,
  logLevel: 'info',
  logFile: path.join(LOG_DIR, 'bridge.log'),
  // Token opcional: vazio = sem autenticacao (aceitavel porque escuta so em loopback).
  token: '',
  // Modelos anunciados em /v1/models e usados pelo bloco do DSH.
  models: [
    {
      id: 'deepseek-web',
      name: 'DeepSeek Web (navegador)',
      mode: 'chat',
      contextWindow: 131_072,
      maxTokens: 8_192,
    },
    {
      id: 'deepseek-web-think',
      name: 'DeepSeek Web Think (navegador)',
      mode: 'think',
      contextWindow: 131_072,
      maxTokens: 32_768,
    },
  ],
};

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function bool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const v = String(value).trim().toLowerCase();
  if (['1', 'true', 'sim', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'nao', 'no', 'off'].includes(v)) return false;
  return fallback;
}

function int(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * @param {{argv?: string[], env?: NodeJS.ProcessEnv}} [opts]
 */
export function loadConfig(opts = {}) {
  const env = opts.env || process.env;
  const argv = opts.argv || [];
  const fileCfg = readJsonSafe(path.join(DATA_DIR, 'config.json')) || {};
  const cfg = { ...DEFAULTS, ...fileCfg };

  // ambiente
  if (env.DSB_PORT) cfg.port = int(env.DSB_PORT, cfg.port);
  if (env.DSB_HOST) cfg.host = env.DSB_HOST;
  if (env.DSB_PROFILE_DIR) cfg.profileDir = env.DSB_PROFILE_DIR;
  if (env.DSB_BROWSER) cfg.browserChannel = env.DSB_BROWSER;
  if (env.DSB_HEADLESS !== undefined) cfg.headless = bool(env.DSB_HEADLESS, cfg.headless);
  if (env.DSB_REQUEST_TIMEOUT_MS) cfg.requestTimeoutMs = int(env.DSB_REQUEST_TIMEOUT_MS, cfg.requestTimeoutMs);
  if (env.DSB_MAX_PROMPT_CHARS) cfg.maxPromptChars = int(env.DSB_MAX_PROMPT_CHARS, cfg.maxPromptChars);
  if (env.DSB_TOOL_PROTOCOL !== undefined) cfg.toolProtocol = bool(env.DSB_TOOL_PROTOCOL, cfg.toolProtocol);
  if (env.DSB_LOG_LEVEL) cfg.logLevel = env.DSB_LOG_LEVEL;
  if (env.DSB_LOG_FILE) cfg.logFile = env.DSB_LOG_FILE;
  if (env.DSB_URL) cfg.chatUrl = env.DSB_URL;
  if (env.DSB_TOKEN) cfg.token = env.DSB_TOKEN;

  // argumentos
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--port') cfg.port = int(next(), cfg.port);
    else if (a === '--host') cfg.host = String(next());
    else if (a === '--profile-dir') cfg.profileDir = String(next());
    else if (a === '--headed') cfg.headless = false;
    else if (a === '--headless') cfg.headless = true;
    else if (a === '--browser') cfg.browserChannel = String(next());
    else if (a === '--timeout') cfg.requestTimeoutMs = int(next(), cfg.requestTimeoutMs);
    else if (a === '--no-tool-protocol') cfg.toolProtocol = false;
    else if (a === '--log-level') cfg.logLevel = String(next());
  }

  cfg.port = int(cfg.port, DEFAULTS.port);
  cfg.profileDir = path.resolve(cfg.profileDir);
  fs.mkdirSync(cfg.profileDir, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
  return cfg;
}

export function modelById(cfg, id) {
  const key = String(id || '').trim();
  return cfg.models.find((m) => m.id === key) || null;
}
