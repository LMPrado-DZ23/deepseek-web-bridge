// Diagnostico temporario: confere se setModes liga/desliga os botoes medidos.
import { loadConfig } from '../src/config.mjs';
import { initLog, log } from '../src/log.mjs';
import { WebTransport } from '../src/web.mjs';

const cfg = loadConfig({ argv: process.argv.slice(2), env: process.env });
initLog({ level: cfg.logLevel, file: cfg.logFile });

async function snapshot(page, label) {
  const toggles = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('div.ds-toggle-button')).map((el) => ({
      text: String(el.innerText || '').trim().slice(0, 40),
      aria: el.getAttribute('aria-pressed') || el.getAttribute('aria-checked'),
      selected: /ds-toggle-button--selected/.test(String(el.className || '')),
    }));
  });
  console.log(`${label}: ${JSON.stringify(toggles)}`);
  return toggles;
}

const transport = new WebTransport(cfg);
try {
  await transport.start({ headed: false });
  const st = await transport.checkLogin();
  if (!st.loggedIn) {
    console.error(`sem login: ${st.url}`);
    process.exitCode = 4;
  } else {
    await transport.openNewChat();
    const page = transport.page;
    await snapshot(page, 'inicial');
    await transport.setModes(page, 'chat');
    await snapshot(page, 'modo chat');
    await transport.setModes(page, 'think');
    await snapshot(page, 'modo think');
    await transport.setModes(page, 'chat');
    await snapshot(page, 'volta chat');
  }
} catch (err) {
  console.error(`ERRO: ${err.message}`);
  process.exitCode = 1;
} finally {
  await transport.close();
}
log.info('diagnostico de modos concluido');
