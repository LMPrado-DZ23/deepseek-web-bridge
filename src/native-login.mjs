/**
 * Login "nativo": abre o Chrome de verdade no perfil da ponte, sem Playwright.
 *
 * Motivo: o Google recusa OAuth em navegador controlado por automacao
 * ("este navegador ou app pode nao ser seguro"). Fora do CDP o login funciona
 * normalmente, inclusive com Google/Apple. Depois de fechar a janela, o perfil
 * com os cookies fica pronto para uso headless pela ponte.
 *
 * Windows, macOS e Linux: o perfil e' localizado por linha de comando
 * (`--user-data-dir`), que e' a fonte autoritativa em todos os sistemas.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();

const CHROME_POR_SO = {
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    path.join(HOME, 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/var/lib/flatpak/exports/bin/com.google.Chrome',
  ],
};

/** Caminho do Chrome instalado (o mesmo que o Playwright usa via channel: 'chrome'). */
export function resolveChromePath(explicit) {
  const candidates = [explicit, process.env.CHROME_PATH, ...(CHROME_POR_SO[process.platform] || [])].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* tenta o proximo */
    }
  }
  throw new Error(
    'Chrome nao encontrado. Instale o Google Chrome ou defina CHROME_PATH com o caminho do executavel.',
  );
}

/** PIDs de Chrome usando este perfil. Windows via CIM; macOS/Linux via ps. */
export function chromeUsingProfile(profileDir) {
  const alvo = String(profileDir);
  if (process.platform === 'win32') {
    const needle = alvo.replace(/'/g, "''");
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

  // macOS/Linux: ps mostra a linha de comando completa; filtra pelo perfil.
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: 15_000 });
    return out
      .split(/\r?\n/)
      .map((linha) => {
        const m = linha.trim().match(/^(\d+)\s+(.*)$/);
        if (!m) return 0;
        return m[2].includes(alvo) ? Number(m[1]) : 0;
      })
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

/** Encerra apenas processos Chrome cujo --user-data-dir seja o perfil da ponte.
 * Evita "profile in use" quando uma execucao anterior ficou aberta.
 */
export function closeStrayChrome(profileDir) {
  const pids = chromeUsingProfile(profileDir);
  const mortos = [];
  for (const pid of pids) {
    try {
      if (process.platform === 'win32') {
        execFileSync(
          'powershell',
          ['-NoProfile', '-NonInteractive', '-Command', `Stop-Process -Id ${pid} -Force -ErrorAction Stop`],
          { timeout: 15_000 },
        );
      } else {
        process.kill(pid, 'SIGTERM');
      }
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
 * Espera o perfil ficar livre. A checagem autoritativa e' "existe processo
 * Chrome com este --user-data-dir?" em todos os sistemas (no Windows o Chrome
 * nao deixa SingletonLock; no macOS/Linux o lock pode ficar obsoleto).
 * Exige alguns segundos de folga para o processo gravar cookies antes de
 * reabrir o mesmo perfil com CDP.
 */
export async function waitProfileFree(profileDir, { timeoutMs = 30 * 60_000, pollMs = 2_000, graceMs = 4_000 } = {}) {
  const livre = () => chromeUsingProfile(profileDir).length === 0;
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
