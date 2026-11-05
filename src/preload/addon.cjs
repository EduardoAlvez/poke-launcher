const { ipcRenderer } = require('electron');

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
  });
}

ipcRenderer.on('addon:rules', (_event, payload) => {
  const rules = Array.isArray(payload?.rules) ? payload.rules : [];
  console.log(`[addon] pack v${payload?.version ?? '?'} com ${rules.length} regras`);
  install(rules);
});
