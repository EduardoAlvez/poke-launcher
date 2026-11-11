import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createHuntState,
  loadWelcome,
  applyDelta,
  parsePokedex,
  parseHunts,
  dexProgress,
  huntView,
  currentHunt,
  catalogMissing,
  MAX_HUNTS,
  MAX_SPECIES,
} from '../src/main/hunt-report.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const welcomeReal = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'pokeidle-welcome.sample.json'), 'utf8'));

test('loadWelcome com fixture real: dex, hunts e area atual', () => {
  const state = createHuntState();
  const res = loadWelcome(state, welcomeReal);
  assert.equal(res.ok, true);
  assert.equal(state.huntSlug, 'magma_magcargo');
  assert.equal(Object.keys(state.dex).length, 14);
  assert.equal(state.hunts.length, 3);
  assert.deepEqual(state.dex['2053'], { k: 1234, c: 0, sv: 0, sc: 0 });
});

test('huntView da area atual: o que falta e o que tem (Outland por id bruto)', () => {
  const state = createHuntState();
  loadWelcome(state, welcomeReal);
  const view = huntView(state);
  assert.equal(view.current.slug, 'magma_magcargo');
  assert.equal(view.current.nivel, 150);
  assert.equal(view.faltam.length, 1);
  assert.equal(view.faltam[0].pokeId, 2053);
  assert.equal(view.faltam[0].nome, 'Magma Magcargo');
  assert.equal(view.faltam[0].k, 1234);
  assert.equal(view.tem.length, 0);
  assert.deepEqual(view.progress, { captured: 3, catalogSize: 3 });
  assert.equal(currentHunt(state).area, 'outland');
});

test('welcome sem pokedex (conta nova) segue funcionando com aviso', () => {
  const state = createHuntState();
  const res = loadWelcome(state, { t: 'welcome', hunts: welcomeReal.hunts, estado: { huntSlug: 'caterpie' } });
  assert.equal(res.ok, true);
  assert.deepEqual(state.dex, {});
  assert.match(state.warnings.join(' '), /pokedex ausente/);
  const view = huntView(state);
  assert.equal(view.faltam.length, 1);
  assert.equal(view.faltam[0].nome, 'Caterpie');
  assert.equal(view.progress.captured, 0);
});

test('recusa payload que nao e welcome', () => {
  const state = createHuntState();
  assert.equal(loadWelcome(state, null).ok, false);
  assert.equal(loadWelcome(state, { t: 'estado' }).ok, false);
});

test('delta do wire vem aninhado em estado: a captura chega e o roteiro enxerga', () => {
  const state = createHuntState();
  loadWelcome(state, welcomeReal);
  // Forma REAL da linha do socket: { t: 'estado', estado: { parcial } }
  // (poke-app.js: aplicarEstado(mesclarEstado(m.estado))).
  const frame = { t: 'estado', estado: { level: 121, huntSlug: 'weedle', dexMud: { 2053: { k: 9, c: 1 } } } };
  applyDelta(state, frame);
  assert.equal(state.dex['2053'].c, 1, 'sem o aninhamento a dex congela e a rota nunca avanca');
  assert.equal(state.level, 121);
  assert.equal(state.huntSlug, 'weedle');
});

test('delta dexMud marca captura e muda o painel; dexFora remove', () => {
  const state = createHuntState();
  loadWelcome(state, welcomeReal);
  assert.equal(huntView(state).faltam.length, 1);
  applyDelta(state, { dexMud: { 2053: { k: 40570, c: 1 } } });
  const after = huntView(state);
  assert.equal(after.faltam.length, 0);
  assert.equal(after.tem.length, 1);
  assert.equal(after.tem[0].capturada, true);
  assert.equal(after.progress.captured, 4);
  applyDelta(state, { dexFora: ['2053'] });
  assert.equal(state.dex['2053'], undefined);
});

test('delta troca area e bolas', () => {
  const state = createHuntState();
  loadWelcome(state, welcomeReal);
  applyDelta(state, { huntSlug: 'weedle', balls: { 4: 10 } });
  assert.equal(state.huntSlug, 'weedle');
  assert.deepEqual(state.balls, { 4: 10 });
  assert.equal(currentHunt(state).nome, 'Weedle');
});

test('delta de bolas substitui o espelho (o inventario do servidor e a verdade)', () => {
  const state = createHuntState();
  loadWelcome(state, welcomeReal);
  applyDelta(state, { balls: { 4: 2 } });
  assert.deepEqual(state.balls, { 4: 2 });
});

test('pokedex hostil: chaves ruins descartados, limites aplicados com aviso', () => {
  const hostile = {
    '10': { k: 5, c: 2 },
    abc: { k: 1, c: 1 },
    '-3': { k: 1, c: 1 },
    '0': { k: 1, c: 1 },
    '99999999999': { k: 1, c: 1 },
    '11': 'nao-objeto',
    '12': { k: NaN, c: '7' },
    '13': { k: -5, c: Infinity },
  };
  for (let i = 100; i < 100 + MAX_SPECIES + 50; i += 1) hostile[String(i)] = { k: 1, c: 1 };
  const { dex, warnings } = parsePokedex(hostile);
  assert.equal(dex['10'].c, 2);
  assert.equal(dex['12'].k, 0);
  assert.equal(dex['12'].c, 7);
  assert.equal(dex['13'].k, 0);
  assert.equal(dex['13'].c, 0);
  assert.equal(dex.abc, undefined);
  assert.equal(dex['-3'], undefined);
  assert.equal(Object.keys(dex).length, MAX_SPECIES);
  assert.match(warnings.join(' '), /limite/);
});

test('hunts hostil: nome sanitizado, sem slug ou sem especie e fora', () => {
  const longNome = 'x'.repeat(500);
  const huntsIn = [
    { slug: 'ok', nome: longNome, area: 'kanto', nivel: 3, totalSpawns: 15, especies: [{ pokeId: 10, nome: 'Caterpie', pontos: 15 }] },
    { slug: '', nome: 'sem-slug', especies: [{ pokeId: 1, nome: 'A', pontos: 1 }] },
    { slug: 'sem-especie', especies: [] },
    { slug: 'pokeid-ruim', especies: [{ pokeId: 'abc', nome: 'X', pontos: 1 }, { pokeId: 1.5, nome: 'Y', pontos: 2 }] },
    { slug: 'muitas', especies: Array.from({ length: 40 }, (_, i) => ({ pokeId: 300 + i, nome: `S${i}`, pontos: 1 })) },
  ];
  const { hunts } = parseHunts(huntsIn);
  assert.deepEqual(hunts.map((h) => h.slug), ['ok', 'muitas']);
  assert.equal(hunts[0].nome.length, 40);
  assert.equal(hunts[1].especies.length, 16);
});

test('parseHunts aceita o objeto indexado que o jogo tambem manda', () => {
  const asObject = { 0: welcomeReal.hunts[0], 1: welcomeReal.hunts[1] };
  const { hunts } = parseHunts(asObject);
  assert.equal(hunts.length, 2);
});

test('corte de hunts acima do limite com aviso', () => {
  const many = Array.from({ length: MAX_HUNTS + 10 }, (_, i) => ({
    slug: `area-${i}`,
    nome: `A${i}`,
    especies: [{ pokeId: 10 + (i % 900), nome: 'S', pontos: 1 }],
  }));
  const { hunts, warnings } = parseHunts(many);
  assert.equal(hunts.length, MAX_HUNTS);
  assert.match(warnings.join(' '), /limite/);
});

test('chaves de pollution (__proto__/constructor/prototype) nunca viram chave de dex', () => {
  const raw = JSON.parse(
    '{"__proto__":{"polluted":1},"constructor":{"x":1},"prototype":{"y":2},"10":{"k":1,"c":1}}'
  );
  const { dex } = parsePokedex(raw);
  assert.equal(Object.getPrototypeOf({}), Object.prototype);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(Object.keys(dex), ['10']);
  // e via delta, que faz merge direto no state.dex existente
  const state = createHuntState();
  loadWelcome(state, { t: 'welcome', estado: { pokedex: {} }, hunts: [] });
  applyDelta(state, JSON.parse('{"dexMud":{"__proto__":{"k":9,"c":9},"7":{"k":1,"c":2}}}'));
  assert.equal({}.k, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(state.dex, '__proto__'), false);
  assert.deepEqual(Object.keys(state.dex), ['7']);
});

test('huntView sem dados: pronto=false e listas vazias', () => {
  const view = huntView(createHuntState());
  assert.equal(view.ready, false);
  assert.equal(view.current, null);
  assert.deepEqual(view.faltam, []);
  assert.deepEqual(view.progress, { captured: 0, catalogSize: 0 });
});

test('catalogMissing: o que falta no catalogo, mais duro primeiro, sem duplicar', () => {
  const state = createHuntState();
  loadWelcome(state, welcomeReal);
  const m = catalogMissing(state, { limit: 300 });
  // O fixture tem 3 especies (2053, 10, 13); Magcargo (2053, nv150) nao pego,
  // Caterpie (10, nv1) e Weedle (13, nv1) nunca aparecem na dex -> tambem faltam.
  assert.equal(m.total, 3);
  assert.equal(m.items[0].pokeId, 2053);
  assert.equal(m.items[0].nivel, 150);
  assert.equal(m.items[0].tentativas, 1234);
  // captura um -> sai da lista; total cai
  applyDelta(state, { dexMud: { 2053: { k: 1, c: 1 } } });
  const after = catalogMissing(state, { limit: 300 });
  assert.equal(after.total, 2);
  assert.equal(after.items.find((x) => x.pokeId === 2053), undefined);
});

test('loadWelcome guarda o nivel do treinador (e rejeita lixo)', () => {
  const state = createHuntState();
  loadWelcome(state, welcomeReal);
  assert.equal(state.level, 120);
  const bad = createHuntState();
  loadWelcome(bad, { t: 'welcome', estado: { level: 'abc', pokedex: {} }, hunts: [] });
  assert.equal(bad.level, null);
});

test('catalogMissing com levelCap so deixa areas que cabem no nivel, e conta os cortados', () => {
  const state = createHuntState();
  loadWelcome(state, welcomeReal); // level 120; caterpie nv1, weedle nv1, magcargo nv150
  const m = catalogMissing(state, { limit: 300, levelCap: 120 });
  assert.equal(m.levelCap, 120);
  assert.equal(m.total, 2); // magcargo (nv150) ficou de fora
  assert.equal(m.cortadosPorNivel, 1);
  assert.deepEqual(m.items.map((x) => x.pokeId).sort((a, b) => a - b), [10, 13]);
  // sem cap, tudo volta
  const all = catalogMissing(state, { limit: 300, levelCap: null });
  assert.equal(all.total, 3);
  assert.equal(all.cortadosPorNivel, 0);
});

test('levelCap ausente ou invalido nao filtra (e nao crasha com level null)', () => {
  const state = createHuntState();
  loadWelcome(state, { t: 'welcome', estado: { pokedex: {}, huntSlug: 'a' }, hunts: welcomeReal.hunts });
  assert.equal(state.level, null);
  const m = catalogMissing(state, { limit: 300, levelCap: 'nope' });
  assert.equal(m.levelCap, null);
  assert.equal(m.total, 3);
});

test('catalogMissing nao lista especies de areas repetidas duas vezes', () => {
  const state = createHuntState();
  const dup = {
    t: 'welcome',
    estado: { huntSlug: 'a', pokedex: {} },
    hunts: [
      { slug: 'a', nome: 'A', area: 'kanto', nivel: 5, especies: [{ pokeId: 7, nome: 'Z', pontos: 10 }] },
      { slug: 'b', nome: 'B', area: 'johto', nivel: 9, especies: [{ pokeId: 7, nome: 'Z', pontos: 4 }] },
    ],
  };
  loadWelcome(state, dup);
  const m = catalogMissing(state, { limit: 10 });
  assert.equal(m.total, 1);
  assert.equal(m.items[0].pokeId, 7);
  // fica a primeira area que lista a especie (a, nivel 5); a segunda e ignorada
  assert.equal(m.items[0].nivel, 5);
});
