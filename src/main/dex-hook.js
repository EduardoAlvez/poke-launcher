import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * O painel de caça (Fase 9) precisa de codigo no MUNDO DA PAGINA, antes do
 * primeiro script do jogo — e a unica forma de fazer isso no Electron e uma
 * extensao com content_scripts world:"MAIN" + run_at:"document_start"
 * (registerPreloadScript nao expoe o mundo main no E45; validado no recon).
 *
 * A extensao e nossa, minuscula e sem permissoes. Como loadExtension nao le de
 * dentro do asar, os dois arquivos sao copiados para o userData (mesmo padrao
 * do preload do addon) e entao carregados na sessao de cada slot de jogo.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = path.join(dirname, '../dexhook/manifest.json');
const INJECT_PATH = path.join(dirname, '../dexhook/inject.js');

export const DEX_FLAG_KEY = 'pokeLauncherDex';

/** Expressao MAIN-world para ligar/desligar o opt-in na particao do slot. */
export function dexFlagExpr(on) {
  const call = on
    ? `setItem('${DEX_FLAG_KEY}', '1')`
    : `removeItem('${DEX_FLAG_KEY}')`;
  return `try { window.localStorage.${call}; } catch (e) {} true`;
}

/**
 * Copia a extensao para fora do asar. Devolve o caminho do diretorio. Reescreve
 * sempre: o boot e barato e garante que update do app atualiza o hook tambem.
 */
export async function buildDexHook(targetDir) {
  const [manifest, inject] = await Promise.all([fs.readFile(MANIFEST_PATH, 'utf8'), fs.readFile(INJECT_PATH, 'utf8')]);
  JSON.parse(manifest);
  await fs.mkdir(targetDir, { recursive: true });
  await fs.writeFile(path.join(targetDir, 'manifest.json'), manifest, 'utf8');
  await fs.writeFile(path.join(targetDir, 'inject.js'), inject, 'utf8');
  return targetDir;
}

const loaded = new WeakSet();

export async function installDexHook(session, dexHookDir) {
  if (!dexHookDir || loaded.has(session)) return null;
  const ext = await session.loadExtension(dexHookDir, { allowFileAccess: false, hotReload: false });
  loaded.add(session);
  console.log(`[dexhook] ${ext.name} carregada`);
  return ext;
}
