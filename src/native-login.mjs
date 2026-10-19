/**
 * Login "nativo": abre o Chrome de verdade no perfil da ponte, sem Playwright.
 *
 * Motivo: o Google recusa OAuth em navegador controlado por automacao
 * ("este navegador ou app pode nao ser seguro"). Fora do CDP o login funciona
 * normalmente, inclusive com Google/Apple. Depois de fechar a janela, o perfil
 * com os cookies fica pronto para uso headless pela ponte.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
];

/** Caminho do Chrome instalado (o mesmo que o Playwright usa via channel: 'chrome'). */
export function resolveChromePath(explicit) {
  const candidates = [explicit, process.env.CHROME_PATH, ...DEFAULT_CHROME].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* tenta o proximo */
    }
  }
  throw new Error('Chrome nao encontrado. Instale o Google Chrome ou defina CHROME_PATH.');
}

/** Lista PIDs de chrome.exe usando este perfil (Windows); [] nos demais SOs. */
export function chromeUsingProfile(profileDir) {
  if (process.platform !== 'win32') return [];
  const needle = String(profileDir).replace(/'/g, "''");
  const script = [
    "$alvo = '" + needle + "';",
    "$p = Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" |",
    '  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($alvo) };',
    '$p | ForEach-Object { $_.ProcessId }',
  ].join(' ');
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    return out
      .split(/\r?\n/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

/** Encerra apenas processos chrome.exe cujo --user-data-dir seja o perfil da ponte.
 * Evita "profile in use" quando uma execucao anterior ficou aberta.
 */
export function closeStrayChrome(profileDir) {
  const pids = chromeUsingProfile(profileDir);
  const mortos = [];
  for (const pid of pids) {
    try {
      execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `Stop-Process -Id ${pid} -Force -ErrorAction Stop`], { timeout: 15_000 });
      mortos.push(pid);
    } catch {
      /* ja saiu */
    }
  }
  return mortos;
}

/** Abre o Chrome nativo no perfil da ponte. Resolve quando a janela fecha. */
export function openNativeChrome({ profileDir, url, chromePath }) {
  const exe = resolveChromePath(chromePath);
  fs.mkdirSync(profileDir, { recursive: true });
  const args = [
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate',
    url,
  ];
  const child = spawn(exe, args, { stdio: 'ignore' });
  const exited = new Promise((resolve) => {
    child.once('exit', (code) => resolve({ code, sinal: null }));
    child.once('error', (err) => resolve({ code: -1, error: err.message }));
  });
  return { exe, child, exited };
}

/**
 * Espera o perfil ficar livre. No Windows o Chrome nao deixa `SingletonLock`,
 * entao a checagem util e' "existe chrome.exe com este --user-data-dir?".
 * Exige alguns segundos de folga para o processo gravar cookies antes de
 * reabrir o mesmo perfil com CDP.
 */
export async function waitProfileFree(profileDir, { timeoutMs = 30 * 60_000, pollMs = 2_000, graceMs = 4_000 } = {}) {
  const lockPosix = path.join(profileDir, 'SingletonLock');
  const livre = () => (process.platform === 'win32' ? chromeUsingProfile(profileDir).length === 0 : !fs.existsSync(lockPosix));
  const started = Date.now();
  let livreDesde = 0;
  while (Date.now() - started < timeoutMs) {
    if (livre()) {
      livreDesde ||= Date.now();
      if (Date.now() - livreDesde >= graceMs) return { ok: true, ms: Date.now() - started };
    } else {
      livreDesde = 0;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { ok: false, ms: Date.now() - started };
}
