import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';

const CWS_ID = 'mhnplloljgchpfpcpbhmcokmnefodjnh';
const CWS_URL =
  'https://clients2.google.com/service/update2/crx?response=redirect' +
  '&prodversion=133.0.0.0&acceptformat=crx2,crx3' +
  `&x=id%3D${CWS_ID}%26installsource%3DONDemand%26uc`;
const HOSTS = ['pokeidle.io'];
const CACHE_MS = 24 * 60 * 60 * 1000;
const loaded = new WeakSet();
let liveLoads = 0;

function matchesGame(slotUrl) {
  let host;
  try {
    host = new URL(slotUrl).hostname;
  } catch {
    return false;
  }
  return HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

async function freshInfo(markerPath) {
  try {
    const info = JSON.parse(await fs.readFile(markerPath, 'utf8'));
    return typeof info.fetchedAt === 'number' && Date.now() - info.fetchedAt < CACHE_MS;
  } catch {
    return false;
  }
}

async function downloadCrx(destDir, markerPath) {
  const res = await fetch(CWS_URL, { redirect: 'follow' });
  if (!res.ok) throw new Error(`CWS HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  let zipStart = -1;
  if (buf.subarray(0, 4).toString() === 'Cr24') zipStart = 12 + buf.readUInt32LE(8);
  else zipStart = buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  if (zipStart < 0 || buf[zipStart] !== 0x50 || buf[zipStart + 1] !== 0x4b) {
    throw new Error('CRX sem zip embutido');
  }
  const tmpFile = `${destDir}.crx.zip`;
  await fs.mkdir(path.dirname(destDir), { recursive: true });
  await fs.writeFile(tmpFile, buf.subarray(zipStart));
  await fs.rm(destDir, { recursive: true, force: true });
  await fs.mkdir(destDir, { recursive: true });
  const { default: extractZip } = await import('extract-zip');
  await extractZip(tmpFile, { dir: destDir });
  await fs.rm(tmpFile, { force: true });
  await fs.writeFile(markerPath, JSON.stringify({ fetchedAt: Date.now(), crxBytes: buf.length }));
}

async function ensureExtensionDir(destDir, markerPath) {
  if (await freshInfo(markerPath)) return;
  if (liveLoads > 0) {
    try {
      await fs.access(destDir);
      return;
    } catch {
      // sem diretorio e sem cache: precisa baixar mesmo com sessoes vivas (novas)
    }
  }
  if (ensureExtensionDir.pending) return ensureExtensionDir.pending;
  ensureExtensionDir.pending = downloadCrx(destDir, markerPath)
    .finally(() => {
      ensureExtensionDir.pending = null;
    });
  return ensureExtensionDir.pending;
}

export async function installSlotExtensions(session, slotUrl) {
  if (!matchesGame(slotUrl)) return;
  if (loaded.has(session)) return;
  const destDir = path.join(app.getPath('userData'), 'extensions', CWS_ID);
  const markerPath = `${destDir}.info.json`;
  await ensureExtensionDir(destDir, markerPath);
  const ext = await session.loadExtension(destDir, { allowFileAccess: false, hotReload: false });
  loaded.add(session);
  liveLoads += 1;
  console.log(`[extensions] ${ext.name} v${ext.version} carregada`);
}
