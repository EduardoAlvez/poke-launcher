/**
 * Regras do "reler login". O resto do fluxo (sair da pagina, limpar a
 * particao, recarregar) depende do Electron e vive no index; isto aqui e a
 * parte que pode ser testada sem subir o app.
 */
export function canReset(slot) {
  if (!slot) return { ok: false, error: 'sessao inexistente' };
  if (slot.automation?.enabled) return { ok: false, error: 'pare a automacao antes' };
  return { ok: true };
}

export const RESET_DETAIL =
  'Sai desta conta: cookies, armazenamento local, IndexedDB e service workers. ' +
  'Cache e permissoes do Windows continuam. As outras sessoes nao mudam.';
