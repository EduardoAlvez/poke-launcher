const { ipcRenderer } = require('electron');

let automationHandle = null;
let lastRulesJson = null;
let lastAutomationJson = null;
let lastAutomationConfig = null;

// ---- Ponte do painel de caça (Fase 9) ----
// O hook roda no MUNDO DA PAGINA (extensao dexhook) e fala com a gente por
// postMessage. Quem manda 'welcome'/'estado' adiante e o MAIN (processo), que
// re-parsa tudo com caps: esta ponte NUNCA e fonte de verdade, sao dados de
// uma pagina nao-confiavel chegando por um canal que a propria pagina sabe o
// nome. Sem o opt-in ligado o hook nem instala, entao aqui fica silencioso.
const DEX_CHANNEL = 'pokeLauncherDex';

window.addEventListener('message', (ev) => {
  const d = ev && ev.data;
  if (!d || d.source !== DEX_CHANNEL) return;
  const t = typeof d.t === 'string' ? d.t : '';
  if (t !== 'welcome' && t !== 'estado' && t !== 'ready') return;
  ipcRenderer.send('hunt:state', { t, data: d.data ?? null });
});

ipcRenderer.on('dex:get', () => {
  try {
    window.postMessage({ source: DEX_CHANNEL, t: 'get' }, window.location.origin);
  } catch (err) {
    console.error('[dex] pedido de snapshot falhou:', err && err.message);
  }
});

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
      globalThis.PokeAutomationHandle?.onRule?.(ruleId);
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
  ipcRenderer.send('addon:recon-result', {
    href: location.href,
    title: document.title,
    ready: document.readyState,
    economy: document.documentElement.classList.contains('modo-economia'),
    visibility: document.visibilityState,
    focus: document.hasFocus(),
    sessionTaken: Boolean(document.querySelector('#sessao-tomada:not(.hidden)')),
    caidosCount: document.querySelectorAll('#caidos-lista .caido').length,
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
  // O motor le a config a cada tique: guardar a referencia permite mudar uma
  // flag sem reinstalar o motor (reinstalar zeraria a cota de arremessos).
  lastAutomationConfig = config;

  const automation = globalThis.PokeAutomation;
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

// O modo leve liga/desliga muda QUEM e o dono da preferencia de Economia
// (o launcher passa a guardar e devolver). Mudo a flag no objeto da config:
// o motor le a config a cada tique, e reinstala-lo zeraria a cota de
// arremessos do minuto — um efeito colateral invisivel para o usuario.
ipcRenderer.on('automation:gerencia', (_event, gerencia) => {
  if (!lastAutomationConfig) return;
  lastAutomationConfig.gerenciaEconomia = gerencia === true;
  console.log(`[automation] preferencia de Economia agora e do ${gerencia === true ? 'launcher' : 'AUTO'}`);
});

// ---- Rota "capturar um por um" (Fase 10) ----
// A maquina (src/shared/route.js) clica: Mapa, aba de regiao, marcador, caido.
// Quem diZ "capturou" e o MAIN (delta real da dex visto pelo hook) — por isso
// existe o canal route:cmd/advance. A pagina nunca decide a verdade.
let routeHandle = null;

ipcRenderer.on('route:config', (_event, payload) => {
  routeHandle?.stop?.('reconfigurado');
  routeHandle = null;
  const config = payload?.config ?? null;
  if (!config?.enabled) {
    console.log('[route] desativada');
    return;
  }
  const route = globalThis.PokeRoute;
  if (!route || typeof route.installRoute !== 'function') {
    console.error('[route] motor ausente no preload');
    return;
  }
  console.log(`[route] iniciando fila de ${config.targets?.length ?? 0} alvos`);
  routeHandle = route.installRoute({
    config,
    pack: payload?.pack ?? {},
    emit: (evt) => ipcRenderer.send('route:status', evt),
  });
});

ipcRenderer.on('route:cmd', (_event, cmd) => {
  if (cmd?.action === 'advance') {
    routeHandle?.advance?.();
  } else if (cmd?.action === 'stop') {
    routeHandle?.stop?.('parado');
    routeHandle = null;
  }
});
