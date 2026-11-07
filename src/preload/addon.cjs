const { ipcRenderer } = require('electron');

let automationHandle = null;
let lastRulesJson = null;
let lastAutomationJson = null;

function install(rules) {
  const engine = globalThis.PokeAddonEngine;
  if (!engine || typeof engine.installEngine !== 'function') {
    console.error('[addon] motor de regras ausente no preload');
    return;
  }
  engine.stop?.();
  engine.installEngine({
    rules,
    emit: (evt) => ipcRenderer.send('game-event', evt),
    onRule: (ruleId) => {
      const cfg = globalThis.PokeAutomationConfig;
      if (cfg?.enabled && cfg.mode === 'until-catch' && ruleId === globalThis.PokeAutomationPack?.stopOnRule) {
        globalThis.PokeAutomationHandle?.stop('captured');
      }
    },
  });
}

/**
 * A cena esta viva? Amostra o canvas da cena varias vezes: se o desenho
 * continua, a assinatura muda. Serve para pegar um laco de desenho parado
 * (e nao a cena escondida, que continua desenhando por baixo do CSS).
 */
async function sampleScene(windowMs = 1200) {
  const canvas = document.querySelector('#cena');
  if (!canvas || typeof canvas.getContext !== 'function') return { alive: null, samples: 0 };
  let ctx = null;
  try {
    ctx = canvas.getContext('2d');
  } catch {
    return { alive: null, samples: 0 };
  }
  if (!ctx) return { alive: null, samples: 0 };
  const w = Math.max(1, Math.min(64, Math.floor(canvas.width / 2)));
  const h = Math.max(1, Math.min(64, Math.floor(canvas.height / 2)));
  const x = Math.floor((canvas.width - w) / 2);
  const y = Math.floor((canvas.height - h) / 2);
  const sigs = [];
  const deadline = Date.now() + windowMs;
  do {
    let sig;
    try {
      const data = ctx.getImageData(x, y, w, h).data;
      let acc = 0;
      for (let i = 0; i < data.length; i += 1) acc = (acc * 31 + data[i]) >>> 0;
      sig = String(acc);
    } catch (err) {
      return { alive: null, samples: sigs.length, error: String(err?.message ?? err) };
    }
    if (!sigs.includes(sig)) sigs.push(sig);
    if (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
  } while (Date.now() < deadline);
  return { alive: sigs.length > 1, samples: sigs.length, size: `${canvas.width}x${canvas.height}` };
}

ipcRenderer.on('addon:recon', async (_event, payload) => {
  const selectors = Array.isArray(payload?.selectors) ? payload.selectors.slice(0, 80) : [];
  const describe = (el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      cls: typeof el.className === 'string' ? el.className.slice(0, 120) : null,
      role: el.getAttribute?.('role') || null,
      type: el.getAttribute?.('type') || null,
      disabled: el.disabled === true || el.getAttribute?.('aria-disabled') === 'true',
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      visible: rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden',
      text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
    };
  };
  const found = {};
  for (const selector of selectors) {
    try {
      const el = document.querySelector(selector);
      found[selector] = el ? describe(el) : null;
    } catch (err) {
      found[selector] = { error: String(err?.message ?? err) };
    }
  }
  const discovered = [];
  for (const el of document.querySelectorAll('[class]')) {
    const cls = typeof el.className === 'string' ? el.className : '';
    if (!/bola|captur|hunt|boss|selvagem|arena|pokemon|time/i.test(cls)) continue;
    discovered.push(describe(el));
    if (discovered.length >= 80) break;
  }
  const probe = {};
  for (const selector of Array.isArray(payload?.probes) ? payload.probes.slice(0, 30) : []) {
    try {
      const el = document.querySelector(selector);
      if (!el) {
        probe[selector] = null;
        continue;
      }
      const chain = [];
      let node = el;
      for (let i = 0; i < 6 && node; i += 1, node = node.parentElement) {
        const cls = typeof node.className === 'string' && node.className ? `.${node.className.split(/\s+/).join('.')}` : '';
        chain.push(`${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}${cls}`);
      }
      probe[selector] = {
        ...describe(el),
        cursor: getComputedStyle(el).cursor,
        html: el.outerHTML.slice(0, 300),
        chain,
        attrs: [...el.attributes].slice(0, 12).map((a) => `${a.name}=${String(a.value).slice(0, 60)}`),
      };
    } catch (err) {
      probe[selector] = { error: String(err?.message ?? err) };
    }
  }
  const palco = document.querySelector('#palco');
  const interactive = [];
  if (palco) {
    for (const el of palco.querySelectorAll('button, [role="button"], canvas, a, input[type="button"]')) {
      interactive.push(describe(el));
      if (interactive.length >= 40) break;
    }
  }
  const scene = await sampleScene();
  ipcRenderer.send('addon:recon-result', {
    href: location.href,
    title: document.title,
    ready: document.readyState,
    economy: document.documentElement.classList.contains('modo-economia'),
    visibility: document.visibilityState,
    focus: document.hasFocus(),
    sessionTaken: Boolean(document.querySelector('#sessao-tomada:not(.hidden)')),
    caidosCount: document.querySelectorAll('#caidos-lista .caido').length,
    scene,
    found,
    discovered,
    probe,
    palcoHtml: palco ? palco.outerHTML.slice(0, 4000) : null,
    interactive,
  });
});

ipcRenderer.on('addon:rules', (_event, payload) => {
  const rules = Array.isArray(payload?.rules) ? payload.rules : [];
  const key = JSON.stringify(rules);
  if (key === lastRulesJson) return;
  lastRulesJson = key;
  console.log(`[addon] pack v${payload?.version ?? '?'} com ${rules.length} regras`);
  install(rules);
});

ipcRenderer.on('automation:config', (_event, payload) => {
  const config = payload?.config ?? null;
  const key = JSON.stringify(config);
  if (key === lastAutomationJson) return;
  lastAutomationJson = key;

  const automation = globalThis.PokeAutomation;
  globalThis.PokeAutomationConfig = config;
  globalThis.PokeAutomationPack = payload?.pack ?? null;
  globalThis.PokeAutomationHandle?.stop?.('reconfigurado');
  globalThis.PokeAutomationHandle = null;
  if (!config?.enabled) {
    console.log('[automation] desativado por configuracao');
    return;
  }
  if (!automation || typeof automation.installAutomation !== 'function') {
    console.error('[automation] motor ausente no preload');
    return;
  }
  console.log(`[automation] iniciando modo ${config.mode} a cada ${config.intervalMs}ms`);
  globalThis.PokeAutomationHandle = automation.installAutomation({
    config,
    pack: payload?.pack ?? { clickCandidates: [], pauseSelectors: [], pauseText: [] },
    emit: (evt) => ipcRenderer.send('automation:status', evt),
  });
});
