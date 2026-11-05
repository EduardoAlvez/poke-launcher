import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain, Notification, session } from 'electron';
import { SlotRegistry } from './slots.js';
import { SlotStore, sweepOrphanPartitions, defaultState } from './store.js';
import { Notifier, parseGameEvent } from './notifications.js';
import { createTray } from './tray.js';
import { loadPack, buildAddonPreload, applyPackCss, sendPackRules, loadAutomationPack } from './addons.js';
import { AutomationController, RISK_TEXT } from './automation.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const registry = new SlotRegistry();
let win = null;
let store = null;
let persisted = defaultState();
let trayHandle = null;
let quitting = false;
let addonPack = null;
let automationPack = null;

const automation = new AutomationController({
  getSlot: (id) => registry.get(id),
  persist: () => persist(),
  sendToSlot: (slotId, payload) => {
    const slot = registry.get(slotId);
    if (!slot || slot.view.webContents.isDestroyed()) return;
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

function sendState() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send(
    'launcher:state',
    registry.slots.map((s) => ({
      id: s.id,
      name: s.name,
      url: s.url,
      loggedIn: s.loggedIn === true,
      automation: {
        enabled: s.automation?.enabled === true,
        mode: s.automation?.mode ?? 'fixed',
        intervalMs: s.automation?.intervalMs ?? 2000,
        jitterMs: s.automation?.jitterMs ?? 800,
        maxPerMin: s.automation?.maxPerMin ?? 20,
      },
      autoState: s.automationStatus?.state ?? null,
      autoThrows: s.automationStatus?.throws ?? 0,
    }))
  );
}

function isChrome(sender) {
  return !!win && !win.isDestroyed() && sender === win.webContents;
}

function snapshot() {
  return {
    ...persisted,
    slots: registry.slots.map((s) => {
      const prev = persisted.slots.find((p) => p.id === s.id) ?? {};
      return {
        id: s.id,
        name: s.name,
        url: s.url,
        partition: `persist:${s.id}`,
        ratios: prev.ratios ?? null,
        muted: s.muted === true,
        zoomFactor: s.zoomFactor ?? 1,
        automation: prev.automation ?? null,
      };
    }),
  };
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
  app.on('web-contents-created', (_e, contents) => {
    if (contents === win?.webContents) return;
    const apply = () => {
      if (contents.isDestroyed()) return;
      applyPackCss(contents, addonPack);
      sendPackRules(contents, addonPack);
      const slot = registry.findByWebContentsId(contents.id);
      if (slot?.automation?.enabled) {
        contents.send('automation:config', { config: slot.automation, pack: automationPack });
      }
    };
    contents.on('dom-ready', apply);
    contents.on('did-finish-load', apply);
    contents.on('did-navigate-in-page', apply);
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
        if (slot.automation) created.automation = slot.automation;
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
  await sweepOrphanPartitions(
    path.join(app.getPath('userData'), 'Partitions'),
    persisted.slots.map((s) => s.partition)
  );
  try {
    addonPack = await loadPack();
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
  });
});

app.on('before-quit', () => {
  quitting = true;
});

app.on('window-all-closed', () => {
  // app continua vivo na bandeja; a saida acontece pelo menu da bandeja
});
