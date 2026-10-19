/** Logger minimalista com timestamp, nivel e arquivo opcional. */
import fs from 'node:fs';
import path from 'node:path';
import { LOG_DIR } from './config.mjs';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };

let logFile = null;
let minLevel = LEVELS.info;

export function initLog({ level = 'info', file = null } = {}) {
  minLevel = LEVELS[String(level).toLowerCase()] ?? LEVELS.info;
  if (file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    logFile = file;
  }
}

function stamp() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

function write(level, args) {
  if ((LEVELS[level] ?? 9) > minLevel) return;
  const line = `${stamp()} ${level.toUpperCase().padEnd(5)} ${args
    .map((a) => (typeof a === 'string' ? a : safeJson(a)))
    .join(' ')}`;
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  out.write(line + '\n');
  if (logFile) {
    try {
      fs.appendFileSync(logFile, line + '\n');
    } catch {
      /* nunca falhar por causa de log */
    }
  }
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const log = {
  error: (...a) => write('error', a),
  warn: (...a) => write('warn', a),
  info: (...a) => write('info', a),
  debug: (...a) => write('debug', a),
  trace: (...a) => write('trace', a),
};

export function defaultLogFile() {
  const day = new Date().toISOString().slice(0, 10);
  return path.join(LOG_DIR, `bridge-${day}.log`);
}
