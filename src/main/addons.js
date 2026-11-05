import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_PATH = path.join(dirname, '../shared/engine.js');
const GLUE_PATH = path.join(dirname, '../preload/addon.cjs');
const PACK_PATH = path.join(dirname, 'rules/pokeidle.json');

export const GAME_HOSTS = ['pokeidle.io'];

export function matchesGame(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return GAME_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

export function validatePack(pack) {
  if (!pack || typeof pack !== 'object') return { ok: false, error: 'pack nao e objeto' };
  if (!Array.isArray(pack.rules)) return { ok: false, error: 'rules nao e array' };
  for (const rule of pack.rules) {
    if (!rule || typeof rule.id !== 'string' || !/^[a-z0-9-]{1,40}$/i.test(rule.id)) {
      return { ok: false, error: `rule sem id valido` };
    }
    if (!Array.isArray(rule.matchers) || rule.matchers.length === 0) {
      return { ok: false, error: `rule ${rule.id} sem matchers` };
    }
    for (const matcher of rule.matchers) {
      if (matcher.kind === 'text') {
        try {
          new RegExp(matcher.regex, matcher.flags ?? 'i');
        } catch (err) {
          return { ok: false, error: `regex invalida em ${rule.id}: ${err.message}` };
        }
      } else if (matcher.kind === 'selector') {
        if (typeof matcher.selector !== 'string' || !matcher.selector) {
          return { ok: false, error: `selector invalido em ${rule.id}` };
        }
      } else {
        return { ok: false, error: `kind desconhecido em ${rule.id}` };
      }
    }
  }
  if (pack.css !== undefined && !Array.isArray(pack.css)) return { ok: false, error: 'css nao e array' };
  return { ok: true, pack };
}

export async function loadPack() {
  const raw = await fs.readFile(PACK_PATH, 'utf8');
  const pack = JSON.parse(raw);
  const validated = validatePack(pack);
  if (!validated.ok) throw new Error(`pack de regras invalido: ${validated.error}`);
  return validated.pack;
}

export async function buildAddonPreload(targetDir) {
  const [engine, glue] = await Promise.all([
    fs.readFile(ENGINE_PATH, 'utf8'),
    fs.readFile(GLUE_PATH, 'utf8'),
  ]);
  await fs.mkdir(targetDir, { recursive: true });
  const file = path.join(targetDir, 'addon.cjs');
  await fs.writeFile(file, `${engine}\n${glue}`, 'utf8');
  return file;
}

export async function registerAddonPreload(session, preloadPath, url) {
  if (!matchesGame(url)) return null;
  return session.registerPreloadScript({
    type: 'frame',
    filePath: preloadPath,
    matches: GAME_HOSTS.map((h) => `https://${h}/*`),
  });
}

export function applyPackCss(webContents, pack) {
  const css = (pack.css ?? []).join('\n');
  if (!css.trim()) return Promise.resolve(false);
  return webContents.insertCSS(css, { cssOrigin: 'user' }).then(
    () => true,
    (err) => {
      console.error('[addons] CSS nao aplicado:', err.message);
      return false;
    }
  );
}

export function sendPackRules(webContents, pack) {
  webContents.send('addon:rules', { version: pack.version, rules: pack.rules });
}
