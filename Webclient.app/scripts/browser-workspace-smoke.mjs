// Isolated CSS/DOM fixture smoke only; this does not certify real ArcGIS SDK flows or screen-reader behavior.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const findBrowser = () => {
  for (const executable of [process.env.CHROME_BIN, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (executable && existsSync(executable)) return executable;
  }
  throw new Error('Chromium/Chrome is required for the workspace browser smoke test.');
};
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const waitFor = async (check, label, timeout = 15000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await check();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

const css = (path) => readFileSync(join(root, path), 'utf8');
const cards = Array.from({ length: 30 }, (_, index) => `<li class="kr-fast-query__item"><span aria-hidden="true">●</span><div class="kr-fast-query__copy"><h3>Uzun park adı ${index + 1} / mahalle ve cadde</h3><p>Adres ve konum bilgisi</p></div><div class="kr-fast-query__actions"><button>Haritada göster</button><button>Detay</button></div></li>`).join('');
const html = `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>
:root { --exp-font-sans:system-ui; --exp-text:#172332; --exp-text-muted:#526174; --exp-text-soft:#526174; --exp-surface:#fff; --exp-surface-2:#f2f6f9; --exp-border:#b0beca; --exp-border-strong:#657789; --exp-accent:#006f99; --exp-bg:#e8edf1; }
*,*::before,*::after{box-sizing:border-box}
</style><style>${css('src/Components/Query/_Common/ManagedFastAccessQueryWindow.css')}\n${css('src/experience/workspaceUsability.css')}</style></head><body><main id="app-shell"><section class="sidebar-container kr-fast-query" aria-label="Parklar sonuçları" aria-hidden="false"><header class="kr-fast-query__header"><button class="kr-fast-query__back" aria-label="Geri">←</button><h2>Parklar ve yeşil alanlar</h2><button class="kr-fast-query__minimize" aria-label="Küçült">−</button><button class="kr-fast-query__close" aria-label="Kapat">×</button></header><div class="kr-fast-query__toolbar"><span class="kr-fast-query__count">30 sonuç</span></div><div class="kr-fast-query__filter"><label for="park-filter">Park ara</label><input id="park-filter" placeholder="Park ara"></div><ol class="kr-fast-query__results">${cards}</ol><footer class="kr-fast-query__paging"><p class="kr-fast-query__range">1–30 / 300</p><div class="kr-fast-query__paging-actions"><button class="kr-fast-query__more">Önceki</button><button class="kr-fast-query__more">Sonraki</button></div></footer></section></main></body></html>`;

const dir = mkdtempSync(join(tmpdir(), 'kr-browser-smoke-'));

const browser = spawn(findBrowser(), ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' });
let socket;
try {
  const portFile = join(dir, 'DevToolsActivePort');
  const port = await waitFor(() => existsSync(portFile) && Number(readFileSync(portFile, 'utf8').split('\n')[0]), 'Chromium debugger');
  const targets = await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`);
      return (await response.json()).find((target) => target.type === 'page');
    } catch { return null; }
  }, 'Chromium page');
  socket = new WebSocket(targets.webSocketDebuggerUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener('open', resolveOpen, { once: true });
    socket.addEventListener('error', rejectOpen, { once: true });
  });
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  });
  const command = (method, params = {}) => new Promise((resolveCommand, rejectCommand) => {
    const currentId = ++id;
    pending.set(currentId, { resolve: resolveCommand, reject: rejectCommand });
    socket.send(JSON.stringify({ id: currentId, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  await command('Page.enable');
  await command('Runtime.enable');
  for (const { width, height, forced = false } of [
    { width: 320, height: 568 }, { width: 390, height: 844 },
    { width: 568, height: 320 }, { width: 800, height: 450 },
    { width: 1280, height: 800 }, { width: 320, height: 568, forced: true },
  ]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 800 });
    await command('Emulation.setTouchEmulationEnabled', { enabled: width < 800 });
    await command('Emulation.setEmulatedMedia', { features: [
      { name: 'forced-colors', value: forced ? 'active' : 'none' },
      { name: 'prefers-reduced-motion', value: 'reduce' },
    ] });
    await command('Page.navigate', { url: 'about:blank' });
    await evaluate('document.open(); document.write(' + JSON.stringify(html) + '); document.close(); true');
    await waitFor(async () => evaluate('document.readyState === "complete" && !!document.querySelector(".kr-fast-query__close")'), 'workspace fixture');
    const metrics = await evaluate(`(() => {
      const panel = document.querySelector('.kr-fast-query');
      const paging = document.querySelector('.kr-fast-query__paging');
      const rect = (node) => { const r = node.getBoundingClientRect(); return { left:r.left, top:r.top, right:r.right, bottom:r.bottom, width:r.width, height:r.height }; };
      panel.scrollTop = panel.scrollHeight;
      return { viewport:[innerWidth,innerHeight], documentWidth:document.documentElement.scrollWidth,
        panel:rect(panel), paging:rect(paging), buttons:[...panel.querySelectorAll('button')].map((button) => ({ name:button.textContent, ...rect(button) })),
        forced:matchMedia('(forced-colors: active)').matches, reduced:matchMedia('(prefers-reduced-motion: reduce)').matches,
        cssLoaded:getComputedStyle(panel).position === 'absolute' && getComputedStyle(paging).position === 'sticky' };
    })()`);
    assert.deepEqual(metrics.viewport, [width, height], 'emulated viewport');
    assert.equal(metrics.cssLoaded, true, 'real workspace CSS must load');
    assert.equal(metrics.forced, forced, 'forced-colors emulation');
    assert.equal(metrics.reduced, true, 'reduced motion emulation');
    assert.ok(metrics.panel.left >= -1 && metrics.panel.right <= width + 1, `panel horizontal bounds ${width}x${height}`);
    assert.ok(metrics.panel.top >= -1 && metrics.panel.bottom <= height + 1, `panel vertical bounds ${width}x${height}`);
    assert.ok(metrics.documentWidth <= width + 1, `no horizontal page overflow ${width}x${height}`);
    assert.ok(metrics.paging.bottom <= metrics.panel.bottom + 1, `paging remains inside panel ${width}x${height}`);
    for (const button of metrics.buttons) {
      assert.ok(button.height >= 44, `touch target ${button.name} at ${width}x${height}: ${button.height}`);
      assert.ok(button.left >= metrics.panel.left - 1 && button.right <= metrics.panel.right + 1, `button horizontal bounds ${button.name}`);
    }
    console.log(`PASS ${width}x${height} forced=${forced} panel=${Math.round(metrics.panel.width)}x${Math.round(metrics.panel.height)} targets=${metrics.buttons.length}`);
  }
} finally {
  socket?.close();
  browser.kill('SIGTERM');
  await Promise.race([new Promise((done) => browser.once('exit', done)), delay(1500)]);
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }); } catch { /* Chromium may still be releasing its profile. */ }
}
