import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, session } from 'electron';
import { SlotRegistry } from './slots.js';
import { SlotStore, sweepOrphanPartitions, defaultState, buildSnapshot, clampZoom, parseScript, MAX_SCRIPTS } from './store.js';
import { injectScripts, newScriptId, withTimeout, INJECT_TIMEOUT_MS } from './scripts.js';
import { Notifier, parseGameEvent } from './notifications.js';
import { createTray } from './tray.js';
import { loadPack, buildAddonPreload, applyPackCss, sendPackRules, loadAutomationPack, auditPack, collectSelectors, matchesGame } from './addons.js';
import { LIGHT_EM_ECONOMIA, LIGHT_SAMPLE_SCENE } from './light.js';
import { AutomationController, RISK_TEXT } from './automation.js';
import { RouteController, ROUTE_RISK_TEXT } from './route.js';
import { P2Controller, P2_RISK_TEXT } from './p2.js';
import { modoLeveAtivo } from './light-mode.js';
import { warmExtensionCache } from './extensions.js';
import { buildDexHook, installDexHook, dexFlagExpr } from './dex-hook.js';
import { createHuntState, loadWelcome, applyDelta, huntView, catalogMissing } from './hunt-report.js';
import { openLog, formatArgs } from './log.js';
import { buildSlotMenu } from './slot-menu.js';
import { canReset, RESET_DETAIL } from './reset.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
// Uma instancia so: o dev e o app instalado compartilham o mesmo userData, e
// dois processos escrevendo slots.json/particoes ao mesmo tempo corrompem os
// logins (o Chromium trava o diretorio da particao).
let appLog = null;
function getLog() {
  if (!appLog) appLog = openLog(path.join(app.getPath('userData'), 'launcher.log'));
  return appLog;
}

// No build empacotado o stdout e descartado: espelha o diagnostico do main no
// arquivo para o log nao ficar so com stack trace de excecao.
const fileLog = getLog();
for (const level of ['error', 'warn', 'info']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    fileLog[level](formatArgs(args));
    original(...args);
  };
}
fileLog.info(
  `iniciando v${app.getVersion()} (${app.isPackaged ? 'empacotado' : 'dev'}) em ${app.getPath('userData')}`
);

// Um erro async nao pode sumir sem rastro (e nem derrubar o launcher).
process.on('uncaughtException', (err) => {
  console.error('[app] excecao nao tratada:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[app] promessa rejeitada sem tratamento:', reason);
});
app.on('child-process-gone', (_event, details) => {
  console.error('child-process-gone:', details);
});

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  console.error('[app] outra instancia ja esta rodando; encerrando esta');
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}
const registry = new SlotRegistry();
registry.onPopupChange = () => sendState();
registry.onLightChange = () => sendState();
let win = null;
let store = null;
let persisted = defaultState();
let bootWarnings = [];
let trayHandle = null;
let quitting = false;
let addonPack = null;
let automationPack = null;
const audited = new Set();
// Painel de caça (Fase 9): o caminho hook usa `huntStates` (declarado junto dos
// handlers abaixo). A dex mora no servidor; nunca vai ao slots.json.
let dexHookDir = null;

const automation = new AutomationController({
  getSlot: (id) => registry.get(id),
  getAllSlots: () => registry.slots,
  persist: () => persist(),
  sendToSlot: (slotId, payload) => {
    const slot = registry.get(slotId);
    if (!slot) return;
    if (slot.view.webContents.isDestroyed()) return;
    // Com o modo leve ligado (e realmente aplicado), o launcher e o dono da
    // preferencia de Economia: o AUTO nao a mexe (ver automation.js).
    const config = { ...payload.config, gerenciaEconomia: gerenciaEconomiaDoSlot(slot) };
    slot.view.webContents.send('automation:config', { config, pack: automationPack });
  },
});

// Rota "capturar um por um" (Fase 10): fila/verdade no main, cliques na pagina.
const route = new RouteController({
  getSlot: (id) => registry.get(id),
  getHuntState: (id) => huntStates.get(id),
  sendToSlot: (slotId, channel, payload) => {
    const slot = registry.get(slotId);
    const wc = slot?.view?.webContents;
    if (!wc || wc.isDestroyed()) return;
    wc.send(channel, payload);
  },
  onChange: (slotId) => {
    sendState();
    // A rota que para sozinha (sem bolas) tambem libera o campo: a
    // preferencia de Economia/Ultra do usuario pode voltar.
    if (slotId) restaurarPreferenciaSeParou(slotId).catch(() => {});
  },
});

/**
 * Fase 12 (P2): arremesso pelo socket com o jogo DENTRO do Economia. O motor
 * vive aqui; o hook (mundo da pagina) so observa e atua.
 *
 * INVARIANTE: armado, o jogo nao sai do Economia por iniciativa do launcher.
 * A unica saida e o desarme (quando o motor aborta) — e o desarme NAO mexe no
 * DOM do jogo: o hook desfaz a mentira do `cliente.economia` e o controle
 * volta para o jogo como estava.
 */
// Numero do pedido de arm por slot: cada desarme (botao, "Parar tudo",
// bandeja, desligar a dex, reload) incrementa o numero e cancela os pedidos
// que ainda esperam a fila do modo leve: um arm nao pode vencer um
// consentimento ja revogado.
const p2Pedidos = new Map();
const p2 = new P2Controller({
  send: (slot, cmd) => {
    const wc = slot?.view?.webContents;
    if (!wc || wc.isDestroyed()) return;
    wc.send('p2:cmd', cmd);
  },
  notify: () => sendState(),
  onRollback: (slot, motivo) => {
    rollbackDoP2(slot, motivo).catch((err) =>
      console.error(`[${slot.id}] p2: rollback falhou:`, err?.message ?? err)
    );
  },
});

/**
 * Saida do P2 depois de um aborto. O P2 NAO mexe no DOM nem nas preferencias do
 * jogo: ele so mente com o servidor (o `cliente.economia` reescrito) para o
 * campo continuar chegando. Desarmar ja desfaz a mentira (o hook reenvia o
 * estado real), entao aqui nao ha o que clicar — e clicar seria o pior:
 * tiraria o jogo do Economia e zeraria a preferencia do usuario sem ele pedir.
 *
 * Consequencia intencional: o rollback NAO liga o modo leve (isso persistia
 * `lightMode` em disco, bloqueava o re-arm do P2 e deixava o AUTO sem campo).
 * A preferencia do usuario continua sendo dele.
 */
async function rollbackDoP2(slot, motivo) {
  console.warn(`[${slot.id}] p2: rollback (${motivo}) — o controle volta ao jogo`);
  sendState();
}

/**
 * O launcher e o dono da preferencia de Economia/Ultra so quando o modo leve
 * esta LIGADO E APLICADO. Um modo leve quebrado (o rAF nao pode ser limitado)
 * nao segura a preferencia — e o AUTO volta a cuidar dela como antes. O P2
 * tambem segura: o Economia e o que mantem o campo chegando.
 */
function gerenciaEconomiaDoSlot(slot) {
  // O P2 nao aplica o CSS do P1 (o jogo ja esta no Economia), entao nao ha
  // `lightApplied` — mas a posse da preferencia e dele enquanto armado.
  return modoLeveAtivo(slot) && (slot?.p2Armado === true || slot?.lightApplied === true);
}

/**
 * Quando o AUTO ou a rota param, o campo deixa de ser preciso: e a hora de
 * religar a preferencia de Economia/Ultra que o usuario tinha (se o modo leve
 * guardou alguma). Sem isso, a preferencia ficaria apagada para sempre — o
 * defeito que o modo leve sem reload promete consertar.
 */
async function restaurarPreferenciaSeParou(slotId) {
  const slot = registry.get(slotId);
  if (!slot) return;
  if (slot.automation?.enabled === true || route.isActiveRunning(slotId)) return;
  // Com o modo leve/P2 no comando, religar a preferencia aqui brigaria com a
  // vigia (que sai do Economia em seguida) e zeraria a chave outra vez.
  if (modoLeveAtivo(slot)) return;
  await registry.restaurarPreferenciaDoUsuario(slot).catch((err) => {
    console.error(`[${slotId}] modo leve: restaurar preferencia falhou:`, err.message);
  });
}

const notifier = new Notifier({
  show: ({ slotId, title, body }) => {
    if (!Notification.isSupported()) return;
    const slot = registry.get(slotId);
    const notification = new Notification({
      title: title || slot?.name || 'Poke Launcher',
      body,
      groupId: `slot-${slotId}`,
      silent: false,
    });
    notification.on('click', () => {
      if (win && !win.isDestroyed()) {
        win.show();
        win.focus();
      }
      slot?.view.webContents.focus();
    });
    notification.show();
  },
});

registry.onCrash = (slot, info) => {
  // O renderer da rota morreu com a view: a fila do main morre junto.
  if (route.isActiveRunning(slot.id)) route.stop(slot.id, 'crash').catch(() => {});
  notifier.notify(slot.id, {
    type: 'session-crash',
    title: `${slot.name} caiu`,
    body: `Recarregando em ${Math.round(info.waitMs / 1000)} s`,
    ts: Date.now(),
  });
};

let stateTimer = null;
let statePending = false;

function sendState() {
  if (!win || win.isDestroyed()) return;
  if (stateTimer) {
    statePending = true;
    return;
  }
  pushState();
  stateTimer = setTimeout(() => {
    stateTimer = null;
    if (statePending) {
      statePending = false;
      sendState();
    }
  }, 400);
  stateTimer.unref?.();
}

registry.onFocusChange = () => sendState();

function pushState() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send(
    'launcher:state',
    registry.slots.map((s) => ({
      id: s.id,
      name: s.name,
      focused: registry.focusedSlotId === s.id,
      url: s.url,
      loggedIn: s.loggedIn === true,
      lightMode: s.lightMode === true,
      lightApplied: s.lightApplied === true,
      lightFailed: s.lightFailed === true,
      lightRestauracao: s.lightRestauracao ?? null,
      muted: s.muted === true,
      zoomFactor: s.zoomFactor ?? 1,
      eco: s.eco === true,
      automation: {
        enabled: s.automation?.enabled === true,
        exitEconomy: s.automation?.exitEconomy !== false,
        mode: s.automation?.mode ?? 'fixed',
        intervalMs: s.automation?.intervalMs ?? 2000,
        jitterMs: s.automation?.jitterMs ?? 800,
        maxPerMin: s.automation?.maxPerMin ?? 20,
      },
      autoState: s.automationStatus?.state ?? null,
      autoThrows: s.automationStatus?.throws ?? 0,
      autoTicks: s.automationStatus?.ticks ?? 0,
      autoLastTick: s.automationStatus?.lastTickAt ?? null,
      autoCaidos: s.automationStatus?.caidos ?? null,
      route: route.publicState(s.id),
      p2: p2.publicState(s),
      popups: s.popups.length,
      crashedUntil: s.crashUntil && s.crashUntil > Date.now() ? s.crashUntil : 0,
    }))
  );
  const anyAuto = registry.slots.filter((s) => s.automation?.enabled || route.isActiveRunning(s.id)).length;
  trayHandle?.setAutomationRunning?.(anyAuto);
}

function isChrome(sender) {
  return !!win && !win.isDestroyed() && sender === win.webContents;
}

function snapshot() {
  return buildSnapshot(persisted, registry.slots);
}

async function persist() {
  persisted = snapshot();
  await store.write(persisted);
}

async function refreshLoginBadge(slot) {
  if (!slot || slot.view.webContents.isDestroyed()) return;
  try {
    const cookies = await session.fromPartition(`persist:${slot.id}`).cookies.get({ url: slot.url });
    slot.loggedIn = cookies.length > 0;
  } catch {
    slot.loggedIn = false;
  }
  sendState();
}

function createWindow() {
  win = new BrowserWindow({
    title: 'Poke Launcher',
    width: 1400,
    height: 900,
    minWidth: 720,
    minHeight: 420,
    backgroundColor: '#eef3f2',
    webPreferences: {
      preload: path.join(dirname, '../preload/chrome.cjs'),
      sandbox: true,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });
  win.loadFile(path.join(dirname, '../renderer/chrome.html'));
  registry.attachWindow(win);
  win.on('resize', () => registry.layout(win));
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });
  win.on('closed', () => {
    registry.destroyAll();
    win = null;
  });
  win.webContents.on('did-finish-load', () => {
    // Se o chrome recarregar/crashar com um modal aberto, as views nativas
    // ficariam escondidas sem caminho de volta ate outro modal.
    registry.setViewsVisible(true);
    sendState();
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[chrome] renderer caiu: ${details?.reason ?? 'desconhecido'}`);
    registry.setViewsVisible(true);
    if (!win || win.isDestroyed()) return;
    // Sem UI nao ha como reabrir um modal ou clicar em "Fechar": recarrega.
    setTimeout(() => {
      if (win && !win.isDestroyed()) win.webContents.reload();
    }, 1000);
  });
  const selfTestHide = Number(process.env.POKE_SELFTEST_HIDE);
  if (selfTestHide > 0) {
    setTimeout(() => win?.close(), selfTestHide * 1000);
  }
  const selfTestNotify = Number(process.env.POKE_SELFTEST_NOTIFY);
  if (selfTestNotify > 0) {
    setTimeout(() => {
      const slotId = registry.slots[0]?.id;
      if (!slotId) return;
      notifier.notify(slotId, { type: 'selftest', title: 'Poke Launcher', body: 'Toast de teste', ts: Date.now() });
    }, selfTestNotify * 1000);
  }
}

function showWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function wireAddonPack() {
  if (!addonPack) return;
  const injected = new Map();
  const cssKeys = new Map();
  app.on('web-contents-created', (_e, contents) => {
    if (contents === win?.webContents) return;
    const apply = () => {
      if (contents.isDestroyed()) return;
      const slot = registry.findByWebContentsId(contents.id);
      const isMainView = slot && slot.view.webContents === contents;
      const url = contents.getURL();
      if (!/^https?:/i.test(url)) return;
      if (injected.get(contents.id) !== url) {
        injected.set(contents.id, url);
        applyPackCss(contents, addonPack, cssKeys.get(contents.id) ?? null).then((key) => {
          if (key) cssKeys.set(contents.id, key);
          else cssKeys.delete(contents.id);
        });
        sendPackRules(contents, addonPack);
      }
      if (!isMainView) return;
      if (slot?.automation?.enabled) {
        contents.send('automation:config', {
          config: { ...slot.automation, gerenciaEconomia: gerenciaEconomiaDoSlot(slot) },
          pack: automationPack,
        });
      }
      if (route.isActiveRunning(slot.id)) {
        // a maquina da rota morreu junto com o documento anterior: reenvia a fila
        route.resend(slot.id);
      }
      if (!audited.has(contents.id)) {
        audited.add(contents.id);
        setTimeout(() => {
          if (!contents.isDestroyed()) auditPack(contents, addonPack);
        }, 8000).unref?.();
      }
    };
    // Reload na MESMA url apaga o CSS e o documento, mas nao muda a chave do
    // cache: sem limpar aqui, o apply de dom-ready acha que ja injetou e o
    // pack nunca volta (bug pego no aceite 5.6 de 2026-11-10).
    contents.on('did-start-loading', () => {
      injected.delete(contents.id);
      cssKeys.delete(contents.id);
      audited.delete(contents.id);
      // Documento novo = hook novo, sem arm. O motor precisa morrer junto: um
      // run orfao continuaria arremessando por cima de um campo que nao ve.
      const slot = registry.findByWebContentsId(contents.id);
      if (slot && slot.view.webContents === contents && p2.run(slot)) {
        p2Pedidos.set(slot.id, (p2Pedidos.get(slot.id) ?? 0) + 1);
        p2.desarmar(slot, 'recarregou');
      }
    });
    contents.on('dom-ready', apply);
    contents.on('did-finish-load', apply);
    contents.on('did-navigate-in-page', apply);
    contents.on('destroyed', () => {
      injected.delete(contents.id);
      cssKeys.delete(contents.id);
      audited.delete(contents.id);
    });
  });
}

async function restoreSlots() {
  const toRestore = [...persisted.slots];
  if (toRestore.length === 0) {
    try {
      await registry.add('Conta 1', 'https://pokeidle.io/app', { maxSlots: persisted.maxSlots });
      await persist();
    } catch (err) {
      console.error('[restore] slot padrao:', err.message);
    }
  }
  for (const slot of toRestore) {
    try {
      await registry.add(slot.name, slot.url, { id: slot.id, maxSlots: persisted.maxSlots });
      const created = registry.get(slot.id);
      if (created) {
        created.muted = slot.muted;
        created.zoomFactor = slot.zoomFactor;
        created.lightMode = slot.lightMode === true;
        created.eco = slot.eco === true;
        created.dexWatch = slot.dexWatch === true;
        // a preferencia lembrada volta com o launcher (modo leve pode ter
        // ficado ligado na sessao anterior).
        created.prefsEconomiaDoUsuario = slot.prefsEconomia ? { ...slot.prefsEconomia } : null;
        created.prefsEconomiaPendente = slot.prefsEconomiaPendente ? { ...slot.prefsEconomiaPendente } : null;
        registry.applySlotPrefs(created);
        if (slot.automation) {
          created.automation = { ...slot.automation, enabled: false };
        }
      }
    } catch (err) {
      console.error(`[restore] slot ${slot.id}:`, err.message);
    }
  }
  sendState();
  for (const slot of registry.slots) {
    setTimeout(() => refreshLoginBadge(slot), 4000);
  }
  // A preferencia de Economia/Ultra que ficou PENDENTE (o modo leve desligou
  // com AUTO/rota rodando) precisa voltar em algum momento — inclusive
  // depois de um reinicio do launcher. Sem o modo leve ligado, o campo nao
  // esta em uso: a volta pode acontecer assim que a pagina carregar.
  for (const slot of registry.slots) {
    if (!slot.prefsEconomiaPendente) continue;
    setTimeout(() => {
      if (modoLeveAtivo(slot)) return; // com o modo leve ligado, a vigia briga com o restauro
      restaurarPreferenciaSeParou(slot.id).catch((err) => {
        console.error(`[restore] slot ${slot.id}: preferencia pendente:`, err.message);
      });
    }, 6000);
  }
}

/**
 * Nome padrao quando ninguem digita nada: "Conta 1", "Conta 2"... sequencial e
 * sem colidir com as contas ja abertas. A UI ja preenche o campo; isto cobre
 * o resto dos caminhos (e o botao de criar conta em modo rapido).
 */
function nomePadraoConta() {
  const usados = new Set(registry.slots.map((s) => (s.name || '').trim().toLowerCase()));
  let maior = 0;
  for (const s of registry.slots) {
    const m = /^conta\s*(\d+)$/i.exec((s.name || '').trim());
    if (m) maior = Math.max(maior, Number(m[1]));
  }
  let n = maior + 1;
  while (usados.has(`conta ${n}`)) n += 1;
  return `Conta ${n}`;
}

ipcMain.handle('launcher:add-slot', async (event, payload) => {
  if (!isChrome(event.sender)) return;
  const { url } = payload ?? {};
  const name = String(payload?.name ?? '').trim().slice(0, 24) || nomePadraoConta();
  let parsed;
  try {
    parsed = new URL(url || 'https://pokeidle.io/app');
  } catch {
    throw new Error('URL invalida');
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('Somente http(s)');
  if (registry.slots.length >= persisted.maxSlots) {
    throw new Error(`Limite de ${persisted.maxSlots} sessoes`);
  }
  await registry.add(name, parsed.href, { maxSlots: persisted.maxSlots });
  await persist();
  sendState();
  return registry.slots.length;
});

ipcMain.handle('launcher:remove-slot', async (event, payload) => {
  if (!isChrome(event.sender)) return;
  registry.remove(payload?.id);
  huntStates.delete(payload?.id);
  huntRate.delete(payload?.id);
  route.clear(payload?.id);
  await persist();
  sendState();
});

ipcMain.handle('launcher:rename-slot', async (event, payload) => {
  if (!isChrome(event.sender)) return;
  const slot = registry.get(payload?.id);
  if (!slot) return false;
  slot.name = String(payload?.name ?? slot.name).slice(0, 24) || slot.id;
  await persist();
  sendState();
  return true;
});

async function setSlotMuted(slot, muted) {
  slot.muted = muted === true;
  registry.applySlotPrefs(slot);
  await persist();
  sendState();
}

async function setSlotZoom(slot, factor) {
  slot.zoomFactor = clampZoom(factor, { min: 0.5, max: 2 });
  registry.applySlotPrefs(slot);
  await persist();
  sendState();
}

async function setSlotEco(slot, on) {
  slot.eco = on === true;
  // Persistir primeiro: numa sessao com CPU saturada o executeJavaScript pode
  // demorar e o menu nao pode parecer travado esperando o patch.
  await persist();
  sendState();
  registry.applyEcoPrefs(slot).catch((err) => console.error(`[${slot.id}] modo eco:`, err?.message ?? err));
}

async function resetSlot(slot) {
  const permitido = canReset(registry.get(slot?.id));
  if (!permitido.ok) return permitido;
  if (!win || win.isDestroyed()) return { ok: false, error: 'sem janela' };
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Cancelar', 'Limpar e recarregar'],
    defaultId: 0,
    cancelId: 0,
    title: 'Reler login',
    message: `Limpar os dados de ${slot.name}?`,
    detail: RESET_DETAIL,
  });
  if (response !== 1) return { ok: false, error: 'cancelado' };
  const wc = slot.view.webContents;
  const voltar = async () => {
    if (wc.isDestroyed()) return;
    wc.once('did-finish-load', () => refreshLoginBadge(slot));
    await wc.loadURL(slot.url);
  };
  try {
    for (const popup of [...slot.popups]) registry.closePopup(slot, popup);
    // Rota em andamento morreria no meio da viagem com o reset: para limpo.
    if (route.isActiveRunning(slot.id)) await route.stop(slot.id, 'reler-login');
    // Sair da pagina antes de limpar: requisicao ou WebSocket em voo pode
    // regravar o cookie de sessao depois do clearStorageData.
    if (!wc.isDestroyed()) await wc.loadURL('about:blank');
    await session.fromPartition(`persist:${slot.id}`).clearStorageData();
    // O clearStorageData apaga o flag do dex-hook na particao. Sem limpar o
    // espelho, o painel seguiria mostrando a dex da conta ANTIGA como se fosse
    // da nova (o replay do get nem roda: ready continua true).
    huntStates.delete(slot.id);
    huntRate.delete(slot.id);
    route.clear(slot.id);
    slot.loggedIn = false;
    await voltar();
    sendState();
    return { ok: true };
  } catch (err) {
    console.error('[reset] reler login falhou:', err);
    sendState();
    // Nao deixar a sessao parada em about:blank: tenta voltar ao jogo.
    await voltar().catch((e) => console.error('[reset] voltar ao jogo falhou:', e));
    await dialog.showMessageBox(win, {
      type: 'error',
      buttons: ['OK'],
      message: 'Nao consegui reler o login',
      detail: `${err.message}

Se o problema repetir, feche o launcher e apague a pasta Partitions\${slot.id}.`,
    });
    return { ok: false, error: err.message };
  }
}

ipcMain.handle('launcher:slot-menu', (event, payload) => {
  if (!isChrome(event.sender)) return false;
  const slot = registry.get(payload?.id);
  if (!slot || !win || win.isDestroyed()) return false;
  const run = (p) => Promise.resolve(p).catch((err) => console.error(`[slot-menu] ${slot.id}:`, err?.message ?? err));
  const menu = Menu.buildFromTemplate(
    buildSlotMenu(slot, {
      onMute: (muted) => run(setSlotMuted(slot, muted)),
      onZoom: (factor) => run(setSlotZoom(slot, factor)),
      onEco: (on) => run(setSlotEco(slot, on)),
      onRename: () => win.webContents.send('launcher:rename-request', { id: slot.id }),
      onReset: () => run(resetSlot(slot)),
    })
  );
  menu.popup({ window: win });
  return true;
});

ipcMain.handle('launcher:scripts', (event) => {
  if (!isChrome(event.sender)) return { scripts: [], warnings: [] };
  return { scripts: persisted.scripts ?? [], warnings: bootWarnings };
});

ipcMain.handle('launcher:script-save', async (event, payload) => {
  if (!isChrome(event.sender)) return { ok: false, error: 'origem invalida' };
  const input = payload?.script ?? {};
  const existing = persisted.scripts ?? [];
  let id = input.id;
  if (!id) {
    do {
      id = newScriptId();
    } while (existing.some((s) => s.id === id));
  }
  const parsed = parseScript({ ...input, id });
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const scripts = [...existing];
  const i = scripts.findIndex((s) => s.id === parsed.script.id);
  if (i === -1 && scripts.length >= MAX_SCRIPTS) {
    return { ok: false, error: `Limite de ${MAX_SCRIPTS} scripts` };
  }
  if (i === -1) scripts.push(parsed.script);
  else scripts[i] = parsed.script;
  persisted.scripts = scripts;
  await persist();
  sendState();
  return { ok: true, script: parsed.script };
});

ipcMain.handle('launcher:script-delete', async (event, payload) => {
  if (!isChrome(event.sender)) return { ok: false, error: 'origem invalida' };
  const id = String(payload?.id ?? '');
  persisted.scripts = (persisted.scripts ?? []).filter((s) => s.id !== id);
  await persist();
  sendState();
  return { ok: true };
});

ipcMain.handle('launcher:script-run', async (event, payload) => {
  if (!isChrome(event.sender)) return { ok: false, error: 'origem invalida' };
  const slot = payload?.id ? registry.get(payload.id) : null;
  if (payload?.id && !slot) return { ok: false, error: 'sessao inexistente' };
  const targets = slot ? [slot] : registry.slots;
  let sessions = 0;
  let executions = 0;
  let failures = 0;
  for (const target of targets) {
    const res = await injectScripts(target.view.webContents, persisted.scripts ?? [], target.id, {
      log: console.error,
      baseUrl: target.url,
    });
    if (res.ran.length || res.failed.length) sessions += 1;
    executions += res.ran.length;
    failures += res.failed.length;
  }
  return { ok: true, sessions, executions, failures };
});

ipcMain.handle('launcher:set-layout', (event, payload) => {
  if (!isChrome(event.sender)) return false;
  const cols = payload?.cols;
  if (!Number.isInteger(cols) || cols < 1 || cols > 4) return false;
  registry.cols = cols;
  if (win && !win.isDestroyed()) registry.layout(win);
  return true;
});

ipcMain.handle('launcher:set-toolbar-collapsed', (event, payload) => {
  if (!isChrome(event.sender)) return false;
  return registry.setToolbarCollapsed(payload?.collapsed);
});

ipcMain.handle('launcher:set-focus', (event, payload) => {
  if (!isChrome(event.sender)) return { ok: false, error: 'origem invalida' };
  const id = payload?.id;
  if (id !== null && (typeof id !== 'string' || !registry.get(id))) {
    return { ok: false, error: 'sessao inexistente' };
  }
  if (!registry.setFocusedSlot(id)) return { ok: false, error: 'sessao inexistente' };
  return { ok: true, focusedSlotId: id };
});

ipcMain.on('launcher:focus-slot', (event, payload) => {
  if (!isChrome(event.sender)) return;
  const slot = registry.get(payload?.id);
  slot?.view.webContents.focus();
});

const reconWaiters = new Map();

ipcMain.on('addon:recon-result', (event, report) => {
  const resolve = reconWaiters.get(event.sender.id);
  if (!resolve) return;
  reconWaiters.delete(event.sender.id);
  resolve(report);
});

ipcMain.on('launcher:views-visible', (event, visible) => {
  if (!isChrome(event.sender)) return;
  registry.setViewsVisible(visible === true);
});

// ---- Painel de caça (Fase 9) ----
// 'hunt:state' chega pelo preload do addon (mundo isolado da SESSÃO do jogo).
// O payload veio de uma pagina NAO-CONFIÁVEL: quem ingere so depois de (1)
// confirmar que o sender e a view principal de uma sessao E está no host do
// jogo agora — senão um popup ou uma aba em OAuth forjaria dados —, (2) checar
// que aquele slot tem o opt-in LIGADO no main (a verdade do opt-in mora só no
// main: a pagina so decide embrulhar o socket, quem decide guardar e aqui), e
// (3) passar por um token-bucket (a ponte e um relay ilimitado de JS da pagina
// para o IPC do main; um loop hostil ou uma CDN comprometida nao pode arrastar
// o processo principal). O conteudo ainda e re-parseado com caps (hunt-report.js).
const huntStates = new Map();
const huntRate = new Map();
const HUNT_BURST = 60;
const HUNT_REFILL_PER_MS = 60 / 60_000;

function huntAllowed(slotId, now) {
  let bucket = huntRate.get(slotId);
  if (!bucket) {
    bucket = { tokens: HUNT_BURST, last: now };
    huntRate.set(slotId, bucket);
  }
  bucket.tokens = Math.min(HUNT_BURST, bucket.tokens + (now - bucket.last) * HUNT_REFILL_PER_MS);
  bucket.last = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

ipcMain.on('hunt:state', (event, msg) => {
  const slot = registry.findByWebContentsId(event.sender.id);
  if (!slot) return;
  if (event.sender !== slot.view?.webContents) return;
  if (!matchesGame(event.sender.getURL())) return;
  const st = huntStates.get(slot.id);
  if (!st?.enabled) return;
  if (!huntAllowed(slot.id, Date.now())) return;
  if (msg?.t === 'welcome') loadWelcome(st, msg.data);
  else if (msg?.t === 'estado') applyDelta(st, msg.data);
  else if (msg?.t === 'captura') {
    // Evento real de captura (com a especie): a fila "um por um" confirma
    // por aqui e nao espera o delta da dex.
    route.onCapture(slot.id, msg.data);
    return;
  }
  route.onHuntUpdate(slot.id, st);
});

ipcMain.handle('launcher:hunt', async (event, payload) => {
  if (!isChrome(event.sender)) return { ok: false, error: 'origem invalida' };
  const slot = registry.get(payload?.id);
  if (!slot) return { ok: false, error: 'sessao inexistente' };
  let st = huntStates.get(slot.id);
  const wc = slot.view?.webContents;
  // Sem estado (app recem-aberto, ou sessao recriada): pergunta a PAGINA se o
  // opt-in esta ligado — o flag vive no localStorage da particao, e o hook de la
  // ja esta embrulhando o socket. Sem esta adocao, o launcher diria "desligado"
  // e ainda poria fora o welcome que o hook mandasse.
  if (!st && wc && !wc.isDestroyed() && matchesGame(wc.getURL())) {
    const ligado = await withTimeout(
      wc.executeJavaScript(
        `(() => { try { return localStorage.getItem('pokeLauncherDex') === '1'; } catch (e) { return false; } })()`,
        false
      ),
      3000,
      'dex-flag'
    ).catch(() => false);
    if (ligado === true) {
      st = createHuntState();
      st.enabled = true;
      huntStates.set(slot.id, st);
    }
  }
  const enabled = Boolean(st?.enabled);
  // Ligado mas sem snapshot (ex.: painel aberto antes de o main ver o welcome):
  // pede ao hook para reenviar o ultimo que a pagina ja tem.
  if (enabled && !st.ready && wc && !wc.isDestroyed() && matchesGame(wc.getURL())) {
    try {
      wc.send('dex:get');
    } catch {
      /* ponte ausente: o proximo poll tenta de novo */
    }
  }
  if (!enabled || !st.ready) {
    return { ok: true, enabled, ready: false, view: null, missing: null, p2: p2.publicState(slot) };
  }
  // `ate meu nv`: a UI pede levelCap=true e o teto vira o nivel do treinador.
  const levelCap = payload?.levelCap === true ? st.level ?? null : null;
  return {
    ok: true,
    enabled: true,
    ready: true,
    trainerLevel: st.level,
    view: huntView(st),
    missing: catalogMissing(st, { limit: 300, levelCap }),
    p2: p2.publicState(slot),
  };
});

ipcMain.handle('launcher:dex-set', async (event, payload) => {
  if (!isChrome(event.sender)) return { ok: false, error: 'origem invalida' };
  const slot = registry.get(payload?.id);
  if (!slot) return { ok: false, error: 'sessao inexistente' };
  const on = payload?.on === true;
  const wc = slot.view?.webContents;
  if (!wc || wc.isDestroyed() || !matchesGame(slot.url)) return { ok: false, error: 'sessao nao-e-jogo' };
  // O flag vive no localStorage DA ORIGEM do jogo; se a aba estiver num provedor
  // OAuth, nao e o lugar certo — espera voltar.
  if (!matchesGame(wc.getURL())) return { ok: false, error: 'a sessao nao esta no jogo agora' };
  // Ligar so funciona se o hook estiver instalado naquela sessao. Um slot criado
  // em URL nao-jogo nunca recebeu a extensao; instala aqui (WeakSet = idempotente).
  if (on) {
    if (!dexHookDir) return { ok: false, error: 'extensao do painel indisponivel' };
    await installDexHook(wc.session, dexHookDir).catch((err) => console.error(`[${slot.id}] dex-hook:`, err.message));
  }
  try {
    await withTimeout(wc.executeJavaScript(dexFlagExpr(on), false), INJECT_TIMEOUT_MS, 'dex-opt-in');
  } catch (err) {
    return { ok: false, error: err?.message ?? 'a pagina nao respondeu' };
  }
  // O estado do main passa a ser a autoridade do opt-in: ao desligar, o gate do
  // 'hunt:state' ignoras os deltas que o hook ainda mandar deste documento —
  // desligar desliga de verdade, sem esperar recarga.
  if (!on) {
    route.stop(slot.id, 'dex-desligada').catch(() => {});
    // Sem a leitura da dex o orcamento de bolas (o `welcome`) morre junto:
    // manter o P2 armado sem fonte de estoque e arremessar no escuro.
    p2Pedidos.set(slot.id, (p2Pedidos.get(slot.id) ?? 0) + 1);
    p2.desarmar(slot, 'dex-desligada');
  }
  slot.dexWatch = on;
  await persist().catch((err) => console.error('[dex] nao consegui gravar o opt-in:', err.message));
  const st = createHuntState();
  st.enabled = on;
  huntStates.set(slot.id, st);
  if (on) {
    try {
      wc.reload();
    } catch (err) {
      console.error(`[${slot.id}] recarga para ativar a leitura falhou:`, err.message);
    }
  }
  sendState();
  return { ok: true, on };
});

ipcMain.handle('launcher:route-set', async (event, payload) => {
  if (!isChrome(event.sender)) return { ok: false, error: 'origem invalida' };
  const slot = registry.get(payload?.id);
  if (!slot) return { ok: false, error: 'sessao inexistente' };
  if (payload?.on === true) {
    if (slot.p2Armado === true) {
      return { ok: false, error: 'o P2 esta armado: a rota precisa do campo e do lancamento do AUTO' };
    }
    const maxAlvos = Number(payload?.maxAlvos);
    return route.start(slot.id, {
      ackRisk: payload?.ackRisk === true,
      ordem: ['facil', 'xp', 'regiao'].includes(payload?.ordem) ? payload.ordem : 'facil',
      maxAlvos: Number.isInteger(maxAlvos) && maxAlvos >= 1 && maxAlvos <= 500 ? maxAlvos : 3,
      levelCap: payload?.levelCap !== false,
      manualCapture: payload?.manualCapture === true,
      gerenciaEconomia: gerenciaEconomiaDoSlot(slot),
      maxBolas: Number.isFinite(payload?.maxBolas) && payload.maxBolas > 0 ? Math.floor(payload.maxBolas) : null,
      pack: automationPack,
    });
  }
  const res = await route.stop(slot.id, 'desligada');
  // a rota parou: se o AUTO tambem parou, o campo nao e mais preciso e a
  // preferencia de Economia/Ultra do usuario volta.
  await restaurarPreferenciaSeParou(slot.id);
  return res;
});

ipcMain.handle('route:risk-text', (event) => {
  if (!isChrome(event.sender)) return '';
  return ROUTE_RISK_TEXT;
});

ipcMain.handle('diagnostics:collect', async (event) => {
  if (!isChrome(event.sender)) return { ok: false };
  const selectors = [
    ...collectSelectors(addonPack),
    ...(automationPack?.clickCandidates ?? []),
    ...(automationPack?.pauseSelectors ?? []),
  ];
  const slots = {};
  for (const slot of registry.slots) {
    const wc = slot.view.webContents;
    if (wc.isDestroyed()) continue;
    const recon = new Promise((resolve) => {
      const timer = setTimeout(() => {
        reconWaiters.delete(wc.id);
        resolve({ ok: false, error: 'timeout' });
      }, 4000);
      reconWaiters.set(wc.id, (report) => {
        clearTimeout(timer);
        resolve({ ok: true, report });
      });
      wc.send('addon:recon', {
        selectors,
        probes: ['.palco', '.palco.hunt-ativa', '.hud-hunt', '.campo-bola', '.caidos-bolas', '.caidos-bola', '.hunt-saida', '#cena'],
      });
    });
    // A amostra da cena roda no mundo principal (o do jogo): no mundo isolado
    // ela criaria o contexto 2D do canvas com atributos padrao.
    const scene = wc
      .executeJavaScript(LIGHT_SAMPLE_SCENE, true)
      .catch((err) => ({ changed: null, error: String(err?.message ?? err) }));
    const [result, sceneReport] = await Promise.all([recon, scene]);
    slots[slot.id] = { ...result, scene: sceneReport };
  }
  const file = path.join(app.getPath('userData'), 'diagnostico.json');
  await fs.writeFile(file, JSON.stringify({ at: new Date().toISOString(), selectors, slots }, null, 2), 'utf8');
  return { ok: true, file, slots: Object.keys(slots).length };
});

ipcMain.handle('launcher:close-popups', (event) => {
  if (!isChrome(event.sender)) return 0;
  const count = registry.closeAllPopups();
  sendState();
  return count;
});

ipcMain.handle('launcher:set-light', async (event, payload) => {
  if (!isChrome(event.sender)) return { ok: false, error: 'origem invalida' };
  const slot = registry.get(payload?.id);
  if (!slot) return { ok: false, error: 'sessao inexistente' };
  const on = payload?.on === true;
  // O P2 exige o Economia; o P1 sai dele. Os dois nao podem coexistir.
  if (on && slot.p2Armado === true) {
    return { ok: false, error: 'o P2 esta armado: desarme antes de ligar o modo leve' };
  }
  // Com AUTO ou rota rodando, o campo ainda e preciso: a preferencia do usuario
  // (Economia/Ultra) fica PENDENTE de restaurar, nao e esquecida.
  const campoEmUso = slot.automation?.enabled === true || route.isActiveRunning(slot.id);
  const res = on ? await registry.enableLight(slot) : await registry.disableLight(slot, { campoEmUso });
  // O AUTO rodando precisa saber de quem e a preferencia de Economia agora.
  // Mando um canal proprio (nao a config inteira): reenviar a config reinicia
  // o motor e zera a cota de arremessos do minuto.
  if (slot.automation?.enabled === true) {
    const wc = slot.view?.webContents;
    if (wc && !wc.isDestroyed()) wc.send('automation:gerencia', gerenciaEconomiaDoSlot(slot));
  }
  await persist();
  sendState();
  return {
    ok: res?.ok !== false,
    lightMode: slot.lightMode === true,
    aplicado: res?.ok === true,
    restauracao: res?.restauracao ?? null,
    motivo: res?.motivo ?? null,
  };
});

ipcMain.handle('launcher:p2-set', async (event, payload) => {
  if (!isChrome(event.sender)) return { ok: false, error: 'origem invalida' };
  const slot = registry.get(payload?.id);
  if (!slot) return { ok: false, error: 'sessao inexistente' };
  if (payload?.on !== true) {
    // Revoga o pedido: um arm que ainda espera a fila nao pode acontecer.
    p2Pedidos.set(slot.id, (p2Pedidos.get(slot.id) ?? 0) + 1);
    const res = p2.desarmar(slot, 'pedido');
    sendState();
    return res;
  }
  if (payload?.ackRisk !== true) return { ok: false, error: 'risco nao aceito' };
  if (slot.dexWatch !== true) {
    return { ok: false, error: 'ligue a leitura da dex: e dela que vem o estoque de bolas do login' };
  }
  if (slot.automation?.enabled === true) return { ok: false, error: 'pare a automacao antes de armar o P2' };
  if (route.isActiveRunning(slot.id)) return { ok: false, error: 'pare a rota antes de armar o P2' };
  const maxBolas = Number(payload?.maxBolas);
  // Numero do pedido: se um desarme chegar enquanto esta tarefa espera a
  // fila, o pedido antigo nao pode armar por cima do consentimento revogado.
  const pedido = (p2Pedidos.get(slot.id) ?? 0) + 1;
  p2Pedidos.set(slot.id, pedido);
  // Passa pela fila do modo leve: armar no meio de um toggle/sync daria dois
  // donos ao estado do jogo no mesmo instante (a corrida do M1).
  const res = await registry.lightMode.queue(slot, async () => {
    // Re-checa DENTRO da fila (mesmo padrao do `enable` do P1): entre o
    // portao acima e a vez desta tarefa o consentimento pode ter sido
    // revogado (desarme, "Parar tudo", desligar a dex, reload).
    if (p2Pedidos.get(slot.id) !== pedido) return { ok: false, error: 'o pedido de armar foi cancelado' };
    if (slot.p2Armado === true) return { ok: false, error: 'o P2 ja esta armado' };
    if (slot.dexWatch !== true) return { ok: false, error: 'a leitura da dex foi desligada' };
    if (slot.automation?.enabled === true) return { ok: false, error: 'a automacao foi ligada' };
    if (route.isActiveRunning(slot.id)) return { ok: false, error: 'a rota foi ligada' };
    if (slot.lightMode === true) {
      return { ok: false, error: 'o modo leve (P1) esta ligado: desligue antes de armar o P2' };
    }
    // O P2 e o "arremessar com o jogo NO Modo Economia": fora dele (ou no
    // ULTRA) o cliente desenha a cena e o ganho do modoEconomia nao existe.
    const wc = slot.view?.webContents;
    if (!wc || wc.isDestroyed()) return { ok: false, error: 'a sessao nao esta viva' };
    const estado = await wc.executeJavaScript(LIGHT_EM_ECONOMIA, true).catch(() => 'erro');
    if (estado !== 'economia') {
      return { ok: false, error: 'o jogo precisa estar no Modo Economia (e nao no ULTRA) para armar o P2' };
    }
    return p2.armar(slot, {
      consent: true,
      bolas: huntStates.get(slot.id)?.balls ?? {},
      maxBolas: Number.isFinite(maxBolas) && maxBolas > 0 ? Math.floor(maxBolas) : null,
    });
  });
  sendState();
  return res;
});

ipcMain.handle('p2:risk-text', (event) => {
  if (!isChrome(event.sender)) return '';
  return P2_RISK_TEXT;
});

// Relatorio do hook (mundo da pagina). Como todo evento que sobe da pagina,
// e dado NAO-confiavel: o controller so le campos que ele mesmo normaliza.
const P2_REPORTES_POR_SEGUNDO = 40;
// Mensagens de CONTROLE (confirmacao do arremesso, erro, desarme, ready) tem
// cota propria e mais alta: um `campo` em rajada nao pode derrubar o `bola`
// que fecha o pendente (senao o motor aborta sem necessidade).
const P2_CONTROLES_POR_SEGUNDO = 120;
const p2Reportes = new Map();
function p2ReportePermitido(slotId, kind) {
  const agora = Date.now();
  const controle = kind === 'bola' || kind === 'erro' || kind === 'desarmado'
    || kind === 'ready' || kind === 'armado' || kind === 'capturado';
  const teto = controle ? P2_CONTROLES_POR_SEGUNDO : P2_REPORTES_POR_SEGUNDO;
  const atual = p2Reportes.get(slotId);
  if (!atual || agora - atual.janela >= 1000) {
    p2Reportes.set(slotId, { janela: agora, n: 1, controle: controle ? 1 : 0 });
    return true;
  }
  if (controle) {
    atual.controle += 1;
    return atual.controle <= teto;
  }
  atual.n += 1;
  return atual.n <= teto;
}

ipcMain.on('p2:report', (event, data) => {
  if (!data || typeof data !== 'object') return;
  const slot = registry.findByWebContentsId(event.sender.id);
  if (!slot || slot.view.webContents !== event.sender) return;
  // A pagina so manda relatorio quando esta no jogo; um provedor OAuth no
  // mesmo webContents nao fala P2.
  if (!matchesGame(event.sender.getURL())) return;
  // O preload do addon roda no frame principal: nada de iframe da pagina
  // comandando o motor.
  if (event.senderFrame && event.senderFrame !== event.sender.mainFrame) return;
  if (!p2ReportePermitido(slot.id, data.kind)) return;
  p2.onReport(slot, data);
});

ipcMain.handle('automation:set', async (event, payload) => {
  if (!isChrome(event.sender)) return { ok: false, error: 'origem invalida' };
  const slot = registry.get(payload?.id);
  if (!slot) return { ok: false, error: 'sessao inexistente' };
  // O AUTO sai do Economia para clicar nos mobs; o P2 precisa que o jogo FIQUE
  // nele. Ligar o AUTO com o P2 armado quebraria a invariante.
  if (payload?.config?.enabled === true && slot.p2Armado === true) {
    return { ok: false, error: 'o P2 esta armado: desarme antes de ligar a automacao' };
  }
  const res = await automation.setConfig(payload?.id, payload?.config);
  // o AUTO pode ter parado aqui: a preferencia de Economia/Ultra volta se o
  // campo deixar de ser preciso.
  if (payload?.config?.enabled !== true) await restaurarPreferenciaSeParou(payload?.id);
  sendState();
  return res;
});

ipcMain.handle('automation:stop-all', async (event) => {
  if (!isChrome(event.sender)) return false;
  for (const slot of registry.slots) {
    p2Pedidos.set(slot.id, (p2Pedidos.get(slot.id) ?? 0) + 1);
    p2.desarmar(slot, 'parar-tudo');
  }
  await automation.stopAll();
  await route.stopAll();
  for (const slot of registry.slots) await restaurarPreferenciaSeParou(slot.id);
  sendState();
  return true;
});

ipcMain.handle('automation:risk-text', (event) => {
  if (!isChrome(event.sender)) return '';
  return RISK_TEXT;
});

app.whenReady().then(async () => {
  if (!singleInstance) return;
  Menu.setApplicationMenu(null);
  app.setAppUserModelId(app.isPackaged ? 'dev.pokelauncher.app' : process.execPath);
  Notification.handleActivation?.(() => showWindow());
  // A janela vem antes de qualquer trabalho de disco: uma falha de FS aqui
  // nao pode deixar o processo vivo, sem UI e segurando o lock de instancia
  // unica (reabrir cairia em second-instance -> showWindow() sem janela).
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showWindow();
  });

  store = new SlotStore(path.join(app.getPath('userData'), 'slots.json'));
  let stateReadable = true;
  try {
    const loaded = await store.read();
    bootWarnings = loaded.warnings ?? [];
    for (const warning of bootWarnings) console.error(`[store] ${warning}`);
    if (loaded.source === 'defaults' && loaded.warnings.length > 0) {
      stateReadable = false;
      // Nao sobrescrever um estado ilegivel: guarda o arquivo para recuperacao
      // manual antes que o restore crie uma sessao nova por cima.
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const kept = `${store.filePath}.corrupt-${stamp}`;
      await fs.rename(store.filePath, kept).catch(() => {});
      console.error(`[store] slots.json ilegivel preservado em ${kept}`);
    }
    persisted = loaded.state;
  } catch (err) {
    stateReadable = false;
    console.error('[boot] estado indisponivel:', err);
  }
  if (!persisted) persisted = defaultState();

  if (stateReadable) {
    await sweepOrphanPartitions(
      path.join(app.getPath('userData'), 'Partitions'),
      persisted.slots.map((s) => s.partition)
    ).catch((err) => console.error('[boot] sweep de particoes falhou:', err));
  } else {
    console.error('[store] estado ilegivel: sweep de particoes adiado para nao apagar logins');
  }

  try {
    addonPack = await loadPack();
    automationPack = await loadAutomationPack();
    const preloadPath = await buildAddonPreload(path.join(app.getPath('userData'), 'preload'));
    registry.setAddonPreloadPath(preloadPath);
    wireAddonPack();
  } catch (err) {
    console.error('[addons] pack/preload indisponivel:', err.message);
  }
  try {
    dexHookDir = await buildDexHook(path.join(app.getPath('userData'), 'dexhook'));
    registry.dexHookDir = dexHookDir;
  } catch (err) {
    console.error('[dexhook] extensao do painel de caca indisponivel:', err.message);
  }
  warmExtensionCache().catch((err) =>
    console.error('[extensions] download em segundo plano:', err.message)
  );
  registry.scriptRunner = (slot, wc = slot.view.webContents) =>
    injectScripts(wc, persisted.scripts ?? [], slot.id, { log: console.error, baseUrl: slot.url });
  await restoreSlots().catch((err) => console.error('[boot] restaurar sessoes falhou:', err));

  const lightWatch = setInterval(() => {
    for (const slot of registry.slots) {
      if (!modoLeveAtivo(slot)) continue;
      registry.watchLight(slot).catch(() => {});
    }
  }, 20_000);
  lightWatch.unref?.();

  try {
    trayHandle = createTray({
      iconPath: path.join(dirname, '../../assets/icon.png'),
      onShow: showWindow,
      onToggleMute: (muted) => {
        notifier.muted = muted;
      },
      isMuted: notifier.muted,
      onStopAutomation: () => {
        // promessa flutuante vira unhandledRejection se a persistencia falhar
        for (const s of registry.slots) {
          p2Pedidos.set(s.id, (p2Pedidos.get(s.id) ?? 0) + 1);
          p2.desarmar(s, 'bandeja');
        }
        Promise.all([automation.stopAll(), route.stopAll()])
          .then(() => Promise.all(registry.slots.map((s) => restaurarPreferenciaSeParou(s.id))))
          .catch((err) => console.error('[bandeja] parar automacoes:', err?.message ?? err))
          .finally(() => sendState());
      },
      onQuit: () => {
        quitting = true;
        app.quit();
      },
    });
  } catch (err) {
    console.error('[boot] bandeja indisponivel:', err);
  }
});

// Pipes por webContents: eventos que sobem da pagina do jogo para o main. O
// sender e sempre uma pagina NAO-confiavel — cada payload e re-parseado com
// caps antes de tocar em estado/notificacao. Restaurado apos f3ff7f2 ter
// derrubado estes listeners sem querer (toasts de captura e status do AUTO
// ficaram mudos); o `route:status` e o `hunt:state` entraram ja no mesmo padrao.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (event, url) => {
    if (contents === win?.webContents && !url.startsWith('file:')) event.preventDefault();
  });
  const isSlotView = (id) => {
    const slot = registry.findByWebContentsId(id);
    return slot && slot.view.webContents === contents ? slot : null;
  };
  /**
   * O opt-in da leitura vive em DOIS lugares: no main (slots.json, `dexWatch`)
   * e no localStorage da pagina (o hook so pode ler isso no document_start).
   * Uma escrita perdida (crash/kill forcado) deixaria o hook desligado e o
   * launcher sem dados. Aqui reasseguramos o flag a cada carga e, se o hook
   * mesmo assim nao viu o welcome (porque faltou no document_start), recarrega
   * UMA vez — com o flag ja no lugar, a carga seguinte pega o welcome.
   */
  const dexSelfHeal = new Set();
  contents.on('dom-ready', () => {
    const slot = isSlotView(contents.id);
    if (!slot || slot.dexWatch !== true) return;
    if (!matchesGame(contents.getURL())) return;
    const st = huntStates.get(slot.id) ?? createHuntState();
    st.enabled = true;
    huntStates.set(slot.id, st);
    contents
      .executeJavaScript(dexFlagExpr(true), false)
      .then(() => {
        contents.send('dex:get'); // o hook devolve o ultimo welcome que ele viu
        setTimeout(() => {
          const cur = huntStates.get(slot.id);
          if (cur?.ready || dexSelfHeal.has(slot.id)) return;
          contents
            .executeJavaScript(`!!document.querySelector('#hud-hunt')`, false)
            .then((logado) => {
              // so recarrega se a conta esta logada (ou seja: DEVERIA ter vindo welcome)
              if (!logado || dexSelfHeal.has(slot.id)) return;
              dexSelfHeal.add(slot.id);
              console.error(`[dex] ${slot.id}: hook nao viu o welcome; recarregando uma vez`);
              contents.reload();
            })
            .catch(() => {});
        }, 4000);
      })
      .catch(() => {});
  });
  contents.ipc?.on('game-event', (_event, payload) => {
    const slot = registry.findByWebContentsId(contents.id);
    if (!slot) return;
    const parsed = parseGameEvent(payload);
    if (!parsed.ok) return;
    notifier.notify(slot.id, parsed.event);
  });
  contents.ipc?.on('automation:status', (_event, payload) => {
    const slot = registry.findByWebContentsId(contents.id);
    if (!slot) return;
    automation.reportStatus(slot.id, payload);
    slot.automationStatus = payload;
    sendState();
    if (payload?.running === false && payload?.state === 'captured') {
      automation
        .markStopped(slot.id, 'captured')
        .then((changed) => {
          if (changed) sendState();
          // o AUTO parou: o campo pode deixar de ser preciso, entao a
          // preferencia de Economia/Ultra do usuario volta.
          return restaurarPreferenciaSeParou(slot.id);
        })
        .catch((err) => console.error('[automation] parada pos-captura:', err.message));
    }
  });
  contents.ipc?.on('route:status', (_event, payload) => {
    const slot = isSlotView(contents.id);
    if (!slot) return;
    route.onStatus(slot.id, payload);
    sendState();
  });
});
