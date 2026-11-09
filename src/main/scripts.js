/**
 * UserScripts por sessao (estilo Tampermonkey). O codigo roda no mundo
 * principal da pagina do jogo, entao quem injeta e o `webContents` da sessao —
 * nunca a UI do chrome. Aqui fica so a parte testavel: escopo e injeção.
 */

export const INJECT_TIMEOUT_MS = 5000;

export function scriptAppliesTo(script, slotId) {
  if (!script || script.enabled !== true) return false;
  if (script.scope?.mode === 'slots') {
    return Array.isArray(script.scope.slotIds) && script.scope.slotIds.includes(slotId);
  }
  return true;
}

export function scriptsForSlot(scripts, slotId) {
  return (scripts ?? []).filter((script) => scriptAppliesTo(script, slotId));
}

export function scopeSummary(script) {
  if (script?.scope?.mode === 'slots') {
    const n = Array.isArray(script.scope.slotIds) ? script.scope.slotIds.length : 0;
    return n === 1 ? '1 sessao' : `${n} sessoes`;
  }
  return 'todas as sessoes';
}

export function newScriptId(now = Date.now(), random = Math.random()) {
  return `script-${now.toString(36)}-${random.toString(36).slice(2, 6) || '0000'}`;
}

/**
 * A sessao pode ser redirecionada para um provedor OAuth (accounts.google.com,
 * etc.) na mesma aba. Nesse caso os scripts e o eco nao podem rodar la: so no
 * host configurado do slot (ou subdominio dele).
 */
export function hostAllowed(currentUrl, baseUrl) {
  let current;
  try {
    current = new URL(currentUrl);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(current.protocol)) return false;
  if (!baseUrl) return true;
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    return false;
  }
  return current.hostname === base.hostname || current.hostname.endsWith(`.${base.hostname}`);
}

export function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} excedeu ${ms} ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Executa os scripts ligados naquela sessao, em ordem. O `void 0` no fim
 * descarta o valor de retorno: sem ele o Electron esperaria a promise devolvida
 * pelo script (um `new Promise(() => {})` travaria a sessao). Ainda assim cada
 * script tem timeout. Um erro nao impede os outros: vai para o log.
 * Devolve `{ ran, failed }` (ids) para a UI contar certo.
 */
export async function injectScripts(
  webContents,
  scripts,
  slotId,
  { log = console.error, baseUrl = null, timeoutMs = INJECT_TIMEOUT_MS } = {}
) {
  const result = { ran: [], failed: [] };
  if (!webContents || webContents.isDestroyed()) return result;
  if (!hostAllowed(webContents.getURL?.() ?? '', baseUrl)) return result;
  for (const script of scriptsForSlot(scripts, slotId)) {
    // A pagina pode ter navegado durante o await anterior: revalida o host.
    if (webContents.isDestroyed() || !hostAllowed(webContents.getURL?.() ?? '', baseUrl)) break;
    try {
      await withTimeout(webContents.executeJavaScript(`${script.code}\n;\nvoid 0`, false), timeoutMs, 'script');
      result.ran.push(script.id);
    } catch (err) {
      result.failed.push(script.id);
      log(`[scripts] "${script.name}" (${script.id}) falhou em ${slotId}: ${err?.message ?? err}`);
    }
  }
  return result;
}
