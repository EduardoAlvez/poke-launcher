/**
 * Fila da rota "capturar um por um" (Fase 10). Puro: recebe o que falta na dex
 * (catalogMissing) e devolve a ordem de viagem. Quem EXECUTA a viagem é a
 * maquina de estados (via cliques no DOM — Mapa, aba de regiao, marcador); o
 * socket continua intocavel.
 *
 *Politicas de ordem:
 * - facil (padrao): cacada de menor nivel primeiro — captura mais barata em
 *   bolas e morre menos o time;
 * - xp: maior nivel primeiro (rendimento);
 * - regiao: agrupa por macro-area do welcome (kanto/outland/orre) e depois por
 *   nivel — menos trocas de aba; a aba EXATA do mapa e resolvida na execucao
 *   (area 'orre' agrupa Hoenn/Sinnoh/... na prática — recon 2026-11-10).
 */

const COMPARATORS = {
  facil: (a, b) => a.nivel - b.nivel || b.pontos - a.pontos,
  xp: (a, b) => b.nivel - a.nivel || b.pontos - a.pontos,
};

const REGIAORDEM = { kanto: 0, outland: 1, orre: 2 };

export const MAX_ROUTE_TARGETS = 500;

export function buildRoute(missing, { ordem = 'facil', maxAlvos = 50 } = {}) {
  const itens = Array.isArray(missing) ? missing : [];
  const alvo = Math.max(1, Math.min(Math.floor(maxAlvos) || 1, MAX_ROUTE_TARGETS));
  const unicos = new Map();
  for (const it of itens) {
    if (!it || !Number.isInteger(it.pokeId) || typeof it.slug !== 'string' || !it.slug) continue;
    if (!unicos.has(it.pokeId)) unicos.set(it.pokeId, it);
  }
  let fila = [...unicos.values()];
  if (ordem === 'regiao') {
    fila = fila.sort(
      (a, b) =>
        (REGIAORDEM[a.area] ?? 9) - (REGIAORDEM[b.area] ?? 9) ||
        a.nivel - b.nivel ||
        b.pontos - a.pontos
    );
  } else {
    fila = fila.sort(COMPARATORS[ordem] || COMPARATORS.facil);
  }
  return { targets: fila.slice(0, alvo), ordem: COMPARATORS[ordem] ? ordem : 'facil' };
}
