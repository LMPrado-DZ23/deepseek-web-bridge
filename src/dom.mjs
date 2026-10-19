/**
 * Camada DOM: resolve seletores candidatos e extrai o estado da conversa.
 * Nenhuma regra de negocio aqui, apenas leitura/escrita de tela.
 */
import fs from 'node:fs';
import path from 'node:path';

const SEL_FILE = path.join(import.meta.dirname, 'selectors.json');

export function loadSelectors() {
  try {
    return JSON.parse(fs.readFileSync(SEL_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export const SELECTORS = loadSelectors();

/** Retorna o primeiro Locator visivel dentre os candidatos. */
export async function firstVisible(page, key, { timeoutMs = 4_000, selectors = SELECTORS } = {}) {
  const list = selectors[key] || [];
  const deadline = Date.now() + timeoutMs;
  do {
    for (const sel of list) {
      try {
        const loc = page.locator(sel).first();
        if ((await loc.count()) > 0 && (await loc.isVisible())) return loc;
      } catch {
        /* seletor invalido nesta versao do site: ignora */
      }
    }
    if (Date.now() >= deadline) return null;
    await page.waitForTimeout(120);
  } while (Date.now() < deadline);
  return null;
}

export async function anyVisible(page, key, { selectors = SELECTORS } = {}) {
  const list = selectors[key] || [];
  for (const sel of list) {
    try {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0 && (await loc.isVisible())) return true;
    } catch {
      /* ignora */
    }
  }
  return false;
}

/**
 * Le a ultima resposta do assistente e o bloco de raciocinio (se houver).
 * @returns {Promise<{text:string, thinking:string, count:number, source:string|null}>}
 */
export async function readAssistant(page, { selectors = SELECTORS } = {}) {
  return page.evaluate(
    ({ msgSelectors, thinkSelectors }) => {
      const pickVisible = (selectorsList) => {
        for (const sel of selectorsList) {
          let nodes;
          try {
            nodes = Array.from(document.querySelectorAll(sel));
          } catch {
            continue;
          }
          const visible = nodes.filter((n) => {
            const r = n.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });
          if (visible.length > 0) return visible;
        }
        return [];
      };

      const msgNodes = pickVisible(msgSelectors);
      const thinkNodes = pickVisible(thinkSelectors);
      // O bloco de raciocinio tambem usa .ds-markdown internamente: descartar
      // qualquer no que esteja dentro de um bloco de raciocinio.
      const isInsideThink = (n) => {
        try {
          return !!n.closest(thinkSelectors.join(','));
        } catch {
          return false;
        }
      };
      const answerNodes = msgNodes.filter((n) => !isInsideThink(n));
      const answer = answerNodes.length ? answerNodes[answerNodes.length - 1] : null;
      const text = answer ? String(answer.innerText || '') : '';
      const thinking = thinkNodes.length ? String(thinkNodes[thinkNodes.length - 1].innerText || '') : '';
      return { text, thinking, count: answerNodes.length, source: answer ? 'dom' : null };
    },
    { msgSelectors: selectors.assistantMessage || [], thinkSelectors: selectors.thinkingBlock || [] },
  );
}

/** Texto corrido da pagina, para detectar banners de erro/limite. */
export async function pageSnippet(page, maxChars = 600) {
  try {
    const body = await page.evaluate(() => (document.body ? document.body.innerText : ''));
    return String(body || '').replace(/\s+\n/g, '\n').slice(0, maxChars);
  } catch {
    return '';
  }
}

export async function pageUrl(page) {
  try {
    return page.url();
  } catch {
    return '';
  }
}

export function isSignInUrl(url) {
  return /sign[_-]?in|login|entrar|auth/i.test(String(url || ''));
}

const ERROR_PATTERNS = [
  '服务器繁忙',
  '服务繁忙',
  '系统繁忙',
  '请求过于频繁',
  'Too many requests',
  'tente novamente',
  'Tente novamente',
  'algo deu errado',
  'Algo deu errado',
  'network error',
  'Erro de rede',
  'verificação de segurança',
  'Verificação de segurança',
  'unusual activity',
  // Bloqueio de borda (CloudFront/WAF) visto quando o perfil parece robo.
  'ERROR: The request could not be satisfied',
  'The request could not be satisfied',
  'Request blocked',
];

export function detectPageError(snippet) {
  const s = String(snippet || '');
  for (const p of ERROR_PATTERNS) {
    if (s.includes(p)) return p;
  }
  return null;
}

/**
 * Diagnostico: quais candidatos de seletor casam nesta pagina agora.
 * Usado por 'node src/index.mjs diagnose' para calibrar selectors.json.
 */
export async function diagnoseDom(page, { selectors = SELECTORS } = {}) {
  const report = await page.evaluate((sels) => {
    const out = {};
    for (const [key, list] of Object.entries(sels)) {
      if (Array.isArray(list) === false) continue;
      out[key] = [];
      for (const sel of list) {
        let nodes = [];
        try {
          nodes = Array.from(document.querySelectorAll(sel));
        } catch {
          out[key].push({ selector: sel, error: 'seletor invalido' });
          continue;
        }
        const visible = nodes.filter((n) => {
          const r = n.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        out[key].push({
          selector: sel,
          total: nodes.length,
          visible: visible.length,
          sample: visible.length ? String(visible[0].innerText || '').slice(0, 120) : '',
        });
      }
    }
    const interactive = Array.from(document.querySelectorAll('button, [role="button"], a')).slice(0, 80).map((n) => ({
      tag: n.tagName.toLowerCase(),
      role: n.getAttribute('role') || '',
      aria: n.getAttribute('aria-label') || '',
      text: String(n.innerText || '').trim().slice(0, 60),
      cls: String(n.className || '').slice(0, 80),
    }));
    const editables = Array.from(document.querySelectorAll('textarea, [contenteditable="true"]')).map((n) => ({
      tag: n.tagName.toLowerCase(),
      id: n.id || '',
      placeholder: n.getAttribute('placeholder') || '',
      cls: String(n.className || '').slice(0, 80),
    }));
    return {
      url: location.href,
      title: document.title,
      selectors: out,
      editables,
      interactive,
      bodySample: String(document.body ? document.body.innerText : '').slice(0, 1_500),
    };
  }, selectors);
  return report;
}
