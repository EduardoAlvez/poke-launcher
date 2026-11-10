/**
 * Painel de caça (Fase 9): lê o `welcome` e os deltas `estado` do WebSocket do
 * jogo e responde, sem tocar no disco nem guardar a dex entre sessoes — a dex
 * mora no servidor; o launcher so espelha o que chegou por socket.
 *
 * Tudo aqui e puro (sem Electron) de proposito: e a borda que recebe um payload
 * de renderer nao-confiavel, entao vale a mesma regra do `parseGameEvent` —
 * parseia com caps e devolve `{ ok, error }` em vez de confiar no que chegou.
 *
 * Chave da dex = pokeId BRUTO, inclusive Outland (recon 2026-11-10 confirmou
 * `2053` direto no `estado.pokedex`; a regra `id % 1000` do piloto esta refutada).
 */

import { sanitizeText } from './notifications.js';

export const MAX_SPECIES = 1300;
export const MAX_HUNTS = 1500;
export const MAX_NAME_LEN = 40;
const toNonNeg = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

// Uma linha de dex aceita pelo jogo: {k,c} e/ou {sv,sc} (shiny visto/capturado).
function parseDexEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const k = toNonNeg(Number(raw.k));
  const c = toNonNeg(Number(raw.c));
  const sv = toNonNeg(Number(raw.sv));
  const sc = toNonNeg(Number(raw.sc));
  return { k, c, sv, sc };
}

function dexKey(raw) {
  // Chave vem como string do JSON; so aceita inteiros na faixa de especie —
  // isso tambem e o que impede pollution: '__proto__'/'constructor' viram NaN
  // e morrem aqui, nunca chegam a virar chave de objeto.
  if (raw === '__proto__' || raw === 'constructor' || raw === 'prototype') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 100000) return null;
  return String(n);
}

export function parsePokedex(raw) {
  const dex = {};
  const warnings = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { dex, warnings: ['pokedex ausente ou invalida; tratada como vazia'] };
  }
  let count = 0;
  for (const [key, entry] of Object.entries(raw)) {
    if (count >= MAX_SPECIES) {
      warnings.push(`dex cortada no limite de ${MAX_SPECIES} especies`);
      break;
    }
    const dk = dexKey(key);
    const parsed = parseDexEntry(entry);
    if (!dk || !parsed) continue;
    dex[dk] = parsed;
    count += 1;
  }
  return { dex, warnings };
}

function parseEspecies(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const e of raw) {
    const id = Number(e?.pokeId);
    if (!Number.isInteger(id) || id <= 0 || id > 100000) continue;
    out.push({
      pokeId: id,
      nome: sanitizeText(e?.nome, MAX_NAME_LEN) || String(id),
      pontos: toNonNeg(Number(e?.pontos)),
    });
    if (out.length >= 16) break;
  }
  return out;
}

export function parseHunts(raw) {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? Object.values(raw) : [];
  const hunts = [];
  const warnings = [];
  for (const h of list) {
    if (hunts.length >= MAX_HUNTS) {
      warnings.push(`catalogo de hunts cortado no limite de ${MAX_HUNTS}`);
      break;
    }
    const slug = sanitizeText(h?.slug, 60);
    const especies = parseEspecies(h?.especies);
    if (!slug || !especies.length) continue;
    hunts.push({
      slug,
      nome: sanitizeText(h?.nome, MAX_NAME_LEN),
      area: sanitizeText(h?.area, 24),
      nivel: toNonNeg(Number(h?.nivel)),
      especies,
      totalSpawns: toNonNeg(Number(h?.totalSpawns)),
    });
  }
  return { hunts, warnings };
}

/**
 * Estado vivo de uma sessao: a dex + o catalogo de hunts + a area atual.
 * `applyDelta` incorpora os deltas `estado` (dexMud/dexFora) sem reparsear tudo.
 */
export function createHuntState() {
  return { enabled: false, level: null, dex: {}, hunts: [], huntSlug: null, outlandTier: 0, balls: {}, ready: false, warnings: [] };
}

export function loadWelcome(state, payload) {
  if (!payload || typeof payload !== 'object' || payload.t !== 'welcome') {
    return { ok: false, error: 'payload nao e welcome' };
  }
  const e = payload.estado && typeof payload.estado === 'object' ? payload.estado : {};
  const { dex, warnings: dexWarnings } = parsePokedex(e.pokedex);
  const { hunts, warnings: huntWarnings } = parseHunts(payload.hunts);
  state.dex = dex;
  state.hunts = hunts;
  state.level = Number.isFinite(Number(e.level)) && Number(e.level) > 0 ? Math.floor(Number(e.level)) : null;
  state.huntSlug = sanitizeText(e.huntSlug, 60) || null;
  state.outlandTier = toNonNeg(Number(e.outlandTier));
  state.balls = parseBalls(e.balls);
  state.ready = true;
  state.warnings = [...dexWarnings, ...huntWarnings];
  return { ok: true, state };
}

function parseBalls(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [k, v] of Object.entries(raw).slice(0, 32)) {
    const id = Number(k);
    if (!Number.isInteger(id) || id <= 0) continue;
    out[String(id)] = toNonNeg(Number(v));
  }
  return out;
}

// Deltas `estado`: dexMud traz {chave: entrada}; dexFora traz [chaves] removidas.
export function applyDelta(state, delta) {
  if (!delta || typeof delta !== 'object') return state;
  if (delta.level !== undefined && Number.isFinite(Number(delta.level)) && Number(delta.level) > 0) {
    state.level = Math.floor(Number(delta.level));
  }
  if (delta.huntSlug !== undefined) state.huntSlug = sanitizeText(delta.huntSlug, 60) || null;
  if (delta.outlandTier !== undefined) state.outlandTier = toNonNeg(Number(delta.outlandTier));
  if (delta.balls && typeof delta.balls === 'object') state.balls = parseBalls(delta.balls);
  if (delta.dexMud && typeof delta.dexMud === 'object') {
    for (const [key, entry] of Object.entries(delta.dexMud)) {
      const dk = dexKey(key);
      const parsed = parseDexEntry(entry);
      if (dk && parsed) state.dex[dk] = parsed;
    }
  }
  if (Array.isArray(delta.dexFora)) {
    for (const key of delta.dexFora) {
      const dk = dexKey(key);
      if (dk) delete state.dex[dk];
    }
  }
  return state;
}

const dexEntry = (state, pokeId) => state.dex[String(pokeId)];
const capturada = (state, pokeId) => {
  const d = dexEntry(state, pokeId);
  return Boolean(d && d.c > 0);
};

export function dexProgress(state) {
  let captured = 0;
  for (const entry of Object.values(state.dex)) if (entry.c > 0) captured += 1;
  const catalog = new Set();
  for (const h of state.hunts) for (const e of h.especies) catalog.add(e.pokeId);
  return { captured, catalogSize: catalog.size };
}

export function currentHunt(state) {
  if (!state.huntSlug) return null;
  return state.hunts.find((h) => h.slug === state.huntSlug) ?? null;
}

/**
 * O que a conta ainda NAO capturou, somando todas as areas do catalogo. Cada
 * area do pokeidle e mono-especie (recon 2026-11-10), entao "disponivel para
 * capturar" e essencialmente "especies que existem no jogo e faltam na dex".
 * Ordena pela area mais dura primeiro (nivel). `levelCap` (o "ate meu nv") so
 * deixa passar areas cujo nivel cabe no nivel do treinador; sem cap, o catalogo
 * inteiro. Retorna quantos foram cortados pelo teto para a UI ser honesta.
 */
export function catalogMissing(state, { limit = 300, levelCap = null } = {}) {
  const seen = new Set();
  const missing = [];
  const cap = Number.isFinite(levelCap) && levelCap > 0 ? Math.floor(levelCap) : null;
  let cortadosPorNivel = 0;
  for (const hunt of state.hunts) {
    for (const e of hunt.especies) {
      if (seen.has(e.pokeId)) continue;
      seen.add(e.pokeId);
      const d = state.dex[String(e.pokeId)];
      if (d && d.c > 0) continue;
      if (cap !== null && hunt.nivel > cap) {
        cortadosPorNivel += 1;
        continue;
      }
      missing.push({
        pokeId: e.pokeId,
        nome: e.nome,
        area: hunt.area,
        huntNome: hunt.nome || hunt.slug,
        nivel: hunt.nivel,
        pontos: e.pontos,
        tentativas: d ? d.k : 0,
      });
    }
  }
  missing.sort((a, b) => b.nivel - a.nivel || b.pontos - a.pontos);
  return { total: missing.length, items: missing.slice(0, limit), levelCap: cap, cortadosPorNivel };
}

/**
 * Visao do painel: o que a AREA ATUAL oferece e o que a conta ainda nao pegou.
 * "Disponivel para capturar agora" (caidos) vem do DOM (9.10), nao do socket —
 * aqui o socket so diz o que EXISTE na area e o que a dex ja tem.
 */
export function huntView(state) {
  const hunt = currentHunt(state);
  const faltam = [];
  const tem = [];
  if (hunt) {
    for (const e of hunt.especies) {
      const d = dexEntry(state, e.pokeId) ?? { k: 0, c: 0, sv: 0, sc: 0 };
      const item = { pokeId: e.pokeId, nome: e.nome, pontos: e.pontos, k: d.k, c: d.c, capturada: d.c > 0 };
      (d.c > 0 ? tem : faltam).push(item);
    }
  }
  return {
    ready: state.ready,
    huntSlug: state.huntSlug,
    current: hunt
      ? { slug: hunt.slug, nome: hunt.nome, area: hunt.area, nivel: hunt.nivel, totalSpawns: hunt.totalSpawns }
      : null,
    faltam,
    tem,
    progress: dexProgress(state),
    warnings: state.warnings,
  };
}
