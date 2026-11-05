import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain } from 'electron';
import { SlotRegistry } from './slots.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const registry = new SlotRegistry();
let win = null;

function sendState() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send(
    'launcher:state',
    registry.slots.map((s) => ({ id: s.id, name: s.name, url: s.url }))
  );
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
      preload: path.join(dirname, '../preload/chrome.js'),
      sandbox: true,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });
  win.loadFile(path.join(dirname, '../renderer/chrome.html'));
  registry.attachWindow(win);
  win.on('resize', () => registry.layout(win));
  win.on('closed', () => {
    registry.destroyAll();
    win = null;
  });

  registry.add('Conta 1');
  registry.add('Conta 2');
  win.webContents.once('did-finish-load', sendState);
}

ipcMain.handle('launcher:add-slot', (_e, payload) => {
  const { name, url } = payload ?? {};
  let parsed;
  try {
    parsed = new URL(url || 'https://pokeidle.io/app');
  } catch {
    throw new Error('URL invalida');
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('Somente http(s)');
  registry.add(name, parsed.href);
  sendState();
  return registry.slots.length;
});

ipcMain.handle('launcher:remove-slot', (_e, payload) => {
  registry.remove(payload?.id);
  sendState();
});

ipcMain.handle('launcher:set-layout', (_e, payload) => {
  const cols = payload?.cols;
  if (!Number.isInteger(cols) || cols < 1 || cols > 4) return false;
  registry.cols = cols;
  if (win && !win.isDestroyed()) registry.layout(win);
  return true;
});

ipcMain.on('launcher:focus-slot', (_e, payload) => {
  const slot = registry.get(payload?.id);
  slot?.view.webContents.focus();
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
