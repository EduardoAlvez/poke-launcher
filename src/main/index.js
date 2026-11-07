import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain, Notification, session } from 'electron';
import { SlotRegistry } from './slots.js';
import { SlotStore, sweepOrphanPartitions, defaultState, buildSnapshot } from './store.js';
import { Notifier, parseGameEvent } from './notifications.js';
import { createTray } from './tray.js';
import { loadPack, buildAddonPreload, applyPackCss, sendPackRules, loadAutomationPack, auditPack, collectSelectors } from './addons.js';
import { AutomationController, RISK_TEXT } from './automation.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const registry = new SlotRegistry();
registry.onPopupChange = () => sendState();
let win = null;
let store = null;
let persisted = defaultState();
let trayHandle = null;
let quitting = false;
let addonPack = null;
let automationPack = null;
const audited = new Set();

const automation = new AutomationController({
  getSlot: (id) => registry.get(id),
  getAllSlots: () => registry.slots,
  persist: () => persist(),
  sendToSlot: (slotId, payload) => {
    const slot = registry.get(slotId);
    if (!slot) return;
    if (slot.view.webContents.isDestroyed()) return;
    slot.view.webContents.send('automation:config', { config: payload.config, pack: automationPack });
  },
});

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

function pushState() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send(
    'launcher:state',
    registry.slots.map((s) => ({
      id: s.id,
      name: s.name,
      url: s.url,
      loggedIn: s.loggedIn === true,
      lightMode: s.lightMode === true,
      lightApplied: s.lightApplied === true,
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
      popups: s.popups.length,
    }))
  );
  const anyAuto = registry.slots.filter((s) => s.automation?.enabled).length;
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
    backgroundColor: '#14161b',
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
  win.webContents.once('did-finish-load', sendState);
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
  app.on('web-contents-created', (_e, contents) => {
    if (contents === win?.webContents) return;
    const apply = () => {
      if (contents.isDestroyed()) return;
      const slot = registry.findByWebContentsId(contents.id);
      const isMainView = slot && slot.view.webContents === contents;
      const url = contents.getURL();
      if (injected.get(contents.id) !== url) {
        injected.set(contents.id, url);
        applyPackCss(contents, addonPack);
        sendPackRules(contents, addonPack);
      }
      if (!isMainView) return;
      if (slot?.automation?.enabled) {
        contents.send('automation:config', { config: slot.automation, pack: automationPack });
      }
      if (!audited.has(contents.id)) {
        audited.add(contents.id);
        setTimeout(() => {
          if (!contents.isDestroyed()) auditPack(contents, addonPack);
        }, 8000).unref?.();
      }
    };
    contents.on('dom-ready', apply);
    contents.on('did-finish-load', apply);
    contents.on('did-navigate-in-page', apply);
    contents.on('destroyed', () => injected.delete(contents.id));
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
}

ipcMain.handle('launcher:add-slot', async (event, payload) => {
  if (!isChrome(event.sender)) return;
  const { url } = payload ?? {};
  const name = String(payload?.name ?? '').slice(0, 24);
  let parsed;
  try {
    parsed = new URL(url || 'https://pokeidle.io/app');
  } catch {
    throw new Error('URL invalida');
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('Somente http(s)');
  if (registry.slots.length >= persisted.maxSlots) {
    throw new Error(`Limite de ${persisted.maxSlots} sessoes no plano atual`);
  }
  await registry.add(name, parsed.href, { maxSlots: persisted.maxSlots });
  await persist();
  sendState();
  return registry.slots.length;
});

ipcMain.handle('launcher:remove-slot', async (event, payload) => {
  if (!isChrome(event.sender)) return;
  registry.remove(payload?.id);
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

ipcMain.handle('launcher:set-layout', (event, payload) => {
  if (!isChrome(event.sender)) return false;
  const cols = payload?.cols;
  if (!Number.isInteger(cols) || cols < 1 || cols > 4) return false;
  registry.cols = cols;
  if (win && !win.isDestroyed()) registry.layout(win);
  return true;
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
    slots[slot.id] = await new Promise((resolve) => {
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
  if (on) await registry.enableLight(slot);
  else await registry.disableLight(slot);
  await persist();
  sendState();
  return { ok: true, lightMode: slot.lightMode === true };
});

ipcMain.handle('automation:set', async (event, payload) => {
  if (!isChrome(event.sender)) return { ok: false, error: 'origem invalida' };
  const res = await automation.setConfig(payload?.id, payload?.config);
  sendState();
  return res;
});

ipcMain.handle('automation:stop-all', async (event) => {
  if (!isChrome(event.sender)) return false;
  await automation.stopAll();
  sendState();
  return true;
});

ipcMain.handle('automation:risk-text', (event) => {
  if (!isChrome(event.sender)) return '';
  return RISK_TEXT;
});

app.whenReady().then(async () => {
  app.setAppUserModelId(app.isPackaged ? 'dev.pokelauncher.app' : process.execPath);
  Notification.handleActivation?.(() => showWindow());
  store = new SlotStore(path.join(app.getPath('userData'), 'slots.json'));
  const loaded = await store.read();
  persisted = loaded.state;
  if (loaded.source !== 'defaults' || loaded.warnings.length === 0) {
    await sweepOrphanPartitions(
      path.join(app.getPath('userData'), 'Partitions'),
      persisted.slots.map((s) => s.partition)
    );
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
  createWindow();
  await restoreSlots();
  trayHandle = createTray({
    iconPath: path.join(dirname, '../../assets/icon.png'),
    onShow: showWindow,
    onToggleMute: (muted) => {
      notifier.muted = muted;
    },
    isMuted: notifier.muted,
    onStopAutomation: () => {
      automation.stopAll();
      sendState();
    },
    onQuit: () => {
      quitting = true;
      app.quit();
    },
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showWindow();
  });
});

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (event, url) => {
    if (contents === win?.webContents && !url.startsWith('file:')) {
      event.preventDefault();
    }
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
        })
        .catch((err) => console.error('[automation] parada pos-captura:', err.message));
    }
  });
});

app.on('before-quit', () => {
  quitting = true;
});

app.on('window-all-closed', () => {
  // app continua vivo na bandeja; a saida acontece pelo menu da bandeja
});
