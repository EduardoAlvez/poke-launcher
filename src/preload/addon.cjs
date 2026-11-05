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
