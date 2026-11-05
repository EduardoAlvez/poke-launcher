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

ipcRenderer.on('addon:recon', (_event, payload) => {
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
  ipcRenderer.send('addon:recon-result', {
    href: location.href,
    title: document.title,
    ready: document.readyState,
    found,
    discovered,
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
