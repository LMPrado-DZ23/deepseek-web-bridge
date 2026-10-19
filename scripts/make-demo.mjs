// Gera assets/demo.gif: uma demonstracao ilustrativa da ponte.
// Os textos sao saidas reais medidas em execucao (log da ponte, resposta do
// chat.deepseek.com), montados em frames estilizados. Nao e' gravacao de tela.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import gifenc from 'gifenc';

const { GIFEncoder, quantize, applyPalette } = gifenc;
const RAIZ = path.resolve(import.meta.dirname, '..');
const SAIDA = path.join(RAIZ, 'assets', 'demo.gif');
const LARG = 960;
const ALT = 600;

const base = `
  html, body { margin: 0; padding: 0; background: #0b0d12; color: #e8eaf0;
    font-family: "Segoe UI", system-ui, sans-serif; width: ${LARG}px; height: ${ALT}px; overflow: hidden; }
  .wrap { padding: 36px 44px; height: 100%; box-sizing: border-box; display: flex; flex-direction: column; }
  h1 { font-size: 44px; margin: 0 0 8px; letter-spacing: -1px; }
  h1 span { color: #8b93a7; }
  .sub { color: #98a1b5; font-size: 19px; margin-bottom: 26px; }
  .chips { display: flex; gap: 12px; margin-top: auto; }
  .chip { border: 1px solid #2a3040; background: #141824; border-radius: 14px; padding: 14px 18px;
    font-size: 16px; display: flex; gap: 10px; align-items: center; }
  .chip b { font-weight: 600; }
  .chip small { color: #8b93a7; display: block; font-size: 12px; }
  .term { background: #0f1320; border: 1px solid #232a3b; border-radius: 14px; padding: 18px 20px;
    font-family: "Cascadia Mono", Consolas, monospace; font-size: 15px; line-height: 1.65; }
  .dim { color: #6f7a92; } .ok { color: #6ee7a8; } .info { color: #7fb3ff; } .warn { color: #ffd479; }
  .acc { color: #b58bff; }
  .row { display: grid; grid-template-columns: 1fr 330px; gap: 22px; flex: 1; min-height: 0; align-items: center; }
  .card { background: #121725; border: 1px solid #232a3b; border-radius: 14px; padding: 16px; }
  .card h3 { margin: 0 0 12px; font-size: 13px; text-transform: uppercase; letter-spacing: 1.5px; color: #8b93a7; }
  .model { display: flex; justify-content: space-between; align-items: center; padding: 10px 12px; border-radius: 10px;
    font-size: 14px; border: 1px solid transparent; }
  .model.sel { background: #1b2236; border-color: #3a4a7a; }
  .model small { color: #8b93a7; }
  .bubble { border-radius: 12px; padding: 12px 16px; margin-bottom: 10px; font-size: 15px; max-width: 92%; }
  .user { background: #1b2438; margin-left: auto; }
  .bot { background: #131a29; border: 1px solid #232a3b; }
  .think { color: #9aa6c2; font-size: 14px; font-family: Consolas, monospace; }
  .foot { color: #6f7a92; font-size: 13px; margin-top: 18px; }
  code { color: #b58bff; }
`;

function pagina(corpo) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><style>${base}</style></head><body><div class="wrap">${corpo}</div></body></html>`;
}

const frames = [
  {
    dur: 1500,
    html: pagina(`
      <div class="dim" style="letter-spacing:6px;font-size:13px;margin-bottom:18px">DEEPSEEK WEB PARA O DEEPSEEK HARNESS</div>
      <h1>Seu chat web.<br><span>Dentro do harness.</span></h1>
      <div class="sub">chat.deepseek.com como modelo OpenAI-compativel, sem chave de API.</div>
      <div class="chips">
        <div class="chip"><b>Windows</b><small>install.cmd</small></div>
        <div class="chip"><b>macOS</b><small>install.sh</small></div>
        <div class="chip"><b>Linux</b><small>install.sh</small></div>
      </div>
    `),
  },
  {
    dur: 1200,
    html: pagina(`
      <div class="row">
        <div>
          <div class="term">
            <div class="dim">PS&gt; install.cmd</div>
            <div class="ok">[ok] dependencias instaladas</div>
            <div class="ok">[ok] provider adicionado no perfil desktop</div>
            <div class="ok">[ok] credencial DEEPSEEK_WEB_KEY gravada no cofre</div>
            <div class="info">[i] reinicie o DSH para o novo provider entrar no catalogo</div>
            <div style="height:10px"></div>
            <div class="dim">PS&gt; start.cmd</div>
            <div class="info">INFO ponte ouvindo em http://127.0.0.1:8787</div>
            <div class="info">INFO abrindo chrome (headless)</div>
            <div class="ok">INFO sessao do chat.deepseek.com ativa</div>
          </div>
          <div class="foot">instalador em um comando &middot; login unico no Chrome normal</div>
        </div>
        <div class="card">
          <h3>Modelos no DSH</h3>
          <div class="model"><span>DeepSeek Web</span><small>chat</small></div>
          <div class="model sel"><span>DeepSeek Web Think</span><small>raciocinio</small></div>
          <div class="model dim"><span>deepseek-v4.1-flash</span><small>nuvem</small></div>
          <div class="model dim"><span>qwen2.5:7b</span><small>local</small></div>
        </div>
      </div>
    `),
  },
  {
    dur: 1200,
    html: pagina(`
      <div class="row">
        <div>
          <div class="bubble user">Quanto e 17 * 23? Responda so o numero.</div>
          <div class="bubble bot think">raciocinio &middot; 17*23 = 17*20 + 17*3 = 340 + 51 ...</div>
          <div class="bubble bot"></div>
        </div>
        <div class="card">
          <h3>Streaming</h3>
          <div class="term" style="border:0;background:transparent;padding:0;font-size:13px">
            <div class="dim">reasoning_content:</div>
            <div class="think">"17*23 = 17*20 + 17*3"</div>
            <div class="dim" style="margin-top:10px">content:</div>
            <div class="ok">""</div>
          </div>
        </div>
      </div>
      <div class="foot">raciocinio e resposta em campos separados &mdash; nunca se misturam</div>
    `),
  },
  {
    dur: 1400,
    html: pagina(`
      <div class="row">
        <div>
          <div class="bubble user">Quanto e 17 * 23? Responda so o numero.</div>
          <div class="bubble bot think">raciocinio &middot; 17*23 = 17*20 + 17*3 = 340 + 51 = 391.</div>
          <div class="bubble bot" style="font-size:30px;font-weight:700;color:#6ee7a8">391</div>
        </div>
        <div class="card">
          <h3>Log da ponte</h3>
          <div class="term" style="border:0;background:transparent;padding:0;font-size:12.5px">
            <div class="info">stream inicio modelo=deepseek-web-think</div>
            <div class="dim">modo deepThinkToggle: ligado</div>
            <div class="dim">modo searchToggle: desligado</div>
            <div class="ok">turno resposta=3ch thinking=... 5045ms</div>
            <div class="ok">stream ok 5053ms</div>
          </div>
        </div>
      </div>
      <div class="foot">um turno por vez &middot; "Pesquisa inteligente" desligada para nao atrasar</div>
    `),
  },
  {
    dur: 2200,
    html: pagina(`
      <h1 style="font-size:38px">Pronto. <span>Sem chave de API.</span></h1>
      <div class="sub">O DSH passa a ter o chat.deepseek.com no seletor de modelos.</div>
      <div class="term" style="max-width:860px">
        <div class="dim">instalar (Windows):</div>
        <div class="acc">irm https://raw.githubusercontent.com/LMPrado-DZ23/deepseek-web-bridge/main/install.ps1 | iex</div>
        <div style="height:10px"></div>
        <div class="dim">macOS / Linux:</div>
        <div class="acc">curl -fsSL https://raw.githubusercontent.com/LMPrado-DZ23/deepseek-web-bridge/main/install.sh | bash</div>
      </div>
      <div class="chips">
        <div class="chip"><b>github.com/LMPrado-DZ23/deepseek-web-bridge</b></div>
      </div>
    `),
  },
];

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: LARG, height: ALT }, deviceScaleFactor: 1 });
const gif = GIFEncoder();

for (let i = 0; i < frames.length; i++) {
  const frame = frames[i];
  await page.setContent(frame.html, { waitUntil: 'load' });
  await page.waitForTimeout(120);
  const png = await page.screenshot({ type: 'png' });
  // Decodifica o PNG com o proprio Chrome para pegar RGBA.
  const rgba = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const dados = ctx.getImageData(0, 0, img.width, img.height).data;
    return Array.from(dados);
  }, png.toString('base64'));

  const palette = quantize(Uint8Array.from(rgba), 256);
  const index = applyPalette(Uint8Array.from(rgba), palette);
  gif.writeFrame(index, LARG, ALT, { palette, delay: frame.dur });
  if (process.env.PREVIEW_DIR) {
    fs.mkdirSync(process.env.PREVIEW_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.PREVIEW_DIR, `frame-${i + 1}.png`), png);
  }
  console.log(`frame ${i + 1}/${frames.length}`);
}

gif.finish();
fs.mkdirSync(path.dirname(SAIDA), { recursive: true });
fs.writeFileSync(SAIDA, Buffer.from(gif.bytes()));
await browser.close();
const kb = (fs.statSync(SAIDA).size / 1024).toFixed(0);
console.log(`GIF: ${SAIDA} (${kb} KB)`);
