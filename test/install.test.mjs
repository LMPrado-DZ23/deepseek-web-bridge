// Testes do configurador do DSH (usado pelos instaladores Windows/macOS/Linux).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const RAIZ = path.resolve(import.meta.dirname, '..');
const SCRIPT = path.join(RAIZ, 'scripts', 'configure-dsh.mjs');

function novoHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwb-dsh-'));
  fs.mkdirSync(path.join(dir, 'profiles', 'desktop'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'profiles', 'desktop', 'cordis.patch.yml'),
    "- id: llm-pi-ai\n  name: '@deepseek-ai/dsh-llm-pi-ai'\n",
    'utf8',
  );
  fs.writeFileSync(path.join(dir, '.credentials.yaml'), 'version: 1\n\nrefs:\n  OUTRA_CHAVE: valor\n\nrecords: {}\n', 'utf8');
  return dir;
}

function rodar(home) {
  return execFileSync(process.execPath, [SCRIPT, '--dsh-home', home, '--profile', 'desktop', '--port', '8877'], {
    cwd: RAIZ,
    encoding: 'utf8',
  });
}

test('configure-dsh grava provider e credencial, e e idempotente', () => {
  const home = novoHome();
  try {
    const saida = rodar(home);
    assert.match(saida, /provider adicionado/);

    const patch = fs.readFileSync(path.join(home, 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8');
    assert.match(patch, /deepseek-web:/);
    assert.match(patch, /baseURL: http:\/\/127\.0\.0\.1:8877\/v1/);
    assert.match(patch, /apiKeyEnv: DEEPSEEK_WEB_KEY/);
    assert.ok(fs.existsSync(path.join(home, 'profiles', 'desktop', 'cordis.patch.yml.bak-ponte')));

    const cred = fs.readFileSync(path.join(home, '.credentials.yaml'), 'utf8');
    assert.match(cred, /^\s{2}DEEPSEEK_WEB_KEY: ponte-local-sem-chave/m);
    assert.match(cred, /OUTRA_CHAVE: valor/, 'nao pode perder credenciais existentes');
    assert.match(cred, /^records: \{\}$/m);

    const segunda = rodar(home);
    assert.match(segunda, /ja esta no perfil/);
    assert.match(segunda, /ja existe no cofre/);

    const patch2 = fs.readFileSync(path.join(home, 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8');
    assert.equal(patch2, patch, 'segunda execucao nao pode duplicar o provider');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('configure-dsh cria cofre quando nao existe', () => {
  const home = novoHome();
  fs.rmSync(path.join(home, '.credentials.yaml'));
  try {
    const saida = rodar(home);
    assert.match(saida, /cofre criado/);
    const cred = fs.readFileSync(path.join(home, '.credentials.yaml'), 'utf8');
    assert.match(cred, /^version: 1$/m);
    assert.match(cred, /DEEPSEEK_WEB_KEY: ponte-local-sem-chave/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('perfil inexistente nao impede a credencial', () => {
  const home = novoHome();
  try {
    const saida = execFileSync(process.execPath, [SCRIPT, '--dsh-home', home, '--profile', 'inexistente'], {
      cwd: RAIZ,
      encoding: 'utf8',
    });
    assert.match(saida, /nao existe/);
    assert.match(fs.readFileSync(path.join(home, '.credentials.yaml'), 'utf8'), /DEEPSEEK_WEB_KEY/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('defaultProfileDir fica sob a pasta de dados do usuario', async () => {
  const { defaultProfileDir } = await import('../src/config.mjs');
  const dir = defaultProfileDir();
  assert.match(dir, /dsh-deepseek-web[\\/]chrome-profile$/);
  assert.ok(path.isAbsolute(dir));
});
