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

function isChrome(sender) {
  return !!win && !win.isDestroyed() && sender === win.webContents;
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
  win.on('closed', () => {
    registry.destroyAll();
    win = null;
  });

  registry.add('Conta 1').catch((err) => console.error('add Conta 1:', err.message));
  registry.add('Conta 2').catch((err) => console.error('add Conta 2:', err.message));
  win.webContents.once('did-finish-load', sendState);
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
  await registry.add(name, parsed.href);
  sendState();
  return registry.slots.length;
});

ipcMain.handle('launcher:remove-slot', (event, payload) => {
  if (!isChrome(event.sender)) return;
  registry.remove(payload?.id);
  sendState();
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

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (event, url) => {
    if (contents === win?.webContents && !url.startsWith('file:')) {
      event.preventDefault();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
