import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_PATH = path.join(dirname, '../shared/engine.js');
const AUTOMATION_PATH = path.join(dirname, '../shared/automation.js');
const ROUTE_PATH = path.join(dirname, '../shared/route.js');
const GLUE_PATH = path.join(dirname, '../preload/addon.cjs');
const PACK_PATH = path.join(dirname, 'rules/pokeidle.json');
const AUTOMATION_PACK_PATH = path.join(dirname, 'rules/automation-pokeidle.json');

export const GAME_HOSTS = ['pokeidle.io'];
export const GAME_PATTERNS = ['https://pokeidle.io/*', 'https://*.pokeidle.io/*'];
const MAX_REGEX_LEN = 400;

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
      if (!matcher || typeof matcher !== 'object') return { ok: false, error: `matcher invalido em ${rule.id}` };
      if (matcher.kind === 'text') {
        if (typeof matcher.regex !== 'string' || !matcher.regex || matcher.regex.length > MAX_REGEX_LEN) {
          return { ok: false, error: `regex invalida em ${rule.id}` };
        }
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

export async function loadAutomationPack() {
  const raw = await fs.readFile(AUTOMATION_PACK_PATH, 'utf8');
  const pack = JSON.parse(raw);
  if (!Array.isArray(pack.clickCandidates) || !pack.clickCandidates.length) {
    throw new Error('pack de automacao sem candidatos de clique');
  }
  return pack;
}

export function collectSelectors(pack) {
  const selectors = new Set();
  for (const rule of pack?.rules ?? []) {
    for (const matcher of rule.matchers ?? []) {
      if (matcher.kind === 'selector' && typeof matcher.selector === 'string') {
        selectors.add(matcher.selector);
      }
    }
  }
  for (const entry of pack?.css ?? []) {
    if (typeof entry === 'string') {
      const match = entry.trim().match(/^([^{]+)\{/);
      if (match) selectors.add(match[1].trim());
    } else if (entry && Array.isArray(entry.selectors)) {
      for (const selector of entry.selectors) {
        if (typeof selector === 'string') selectors.add(selector);
      }
    }
  }
  return [...selectors].filter((s) => s.length <= 200);
}

export async function auditPack(contents, pack, { warn = console.warn } = {}) {
  const selectors = collectSelectors(pack);
  if (!selectors.length) return [];
  if (contents.isDestroyed()) return [];
  if (!matchesGame(contents.getURL())) return [];
  let missing = [];
  try {
    missing = await contents.executeJavaScript(
      `(() => {
        const sels = ${JSON.stringify(selectors)};
        return sels.filter((s) => {
          try { return !document.querySelector(s); } catch { return true; }
        });
      })()`,
      true
    );
  } catch (err) {
    warn('[addon] auditoria do pack falhou:', err?.message ?? err);
    return [];
  }
  if (missing.length) {
    warn(`[addon] ${missing.length} seletor(es) sem correspondencia no DOM:`, missing.join(', '));
  }
  return missing;
}

export async function buildAddonPreload(targetDir) {
  const [engine, automation, route, glue] = await Promise.all([
    fs.readFile(ENGINE_PATH, 'utf8'),
    fs.readFile(AUTOMATION_PATH, 'utf8'),
    fs.readFile(ROUTE_PATH, 'utf8'),
    fs.readFile(GLUE_PATH, 'utf8'),
  ]);
  await fs.mkdir(targetDir, { recursive: true });
  const file = path.join(targetDir, 'addon.cjs');
  await fs.writeFile(file, `${engine}\n${automation}\n${route}\n${glue}`, 'utf8');
  return file;
}

export async function registerAddonPreload(session, preloadPath, url) {
  if (!matchesGame(url)) return null;
  return session.registerPreloadScript({
    type: 'frame',
    filePath: preloadPath,
    matches: GAME_PATTERNS,
  });
}

/**
 * Insere o CSS do pack e devolve a chave, para a proxima navegacao no mesmo
 * documento (SPA) remover o anterior em vez de empilhar copias.
 */
export async function applyPackCss(webContents, pack, previousKey = null) {
  const css = (pack.css ?? []).join('\n');
  if (!css.trim()) return null;
  if (previousKey) {
    try {
      await webContents.removeInsertedCSS(previousKey);
    } catch {
      /* o documento anterior ja saiu */
    }
  }
  try {
    return await webContents.insertCSS(css, { cssOrigin: 'user' });
  } catch (err) {
    console.error('[addons] CSS nao aplicado:', err.message);
    return null;
  }
}

export function sendPackRules(webContents, pack) {
  webContents.send('addon:rules', { version: pack.version, rules: pack.rules });
}
