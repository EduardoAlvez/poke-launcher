import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHuntState, loadWelcome, catalogMissing } from '../src/main/hunt-report.js';
import { buildRoute, MAX_ROUTE_TARGETS } from '../src/main/hunt-route.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const welcome = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'pokeidle-welcome.sample.json'), 'utf8'));

function stateComFaltas() {
  const st = createHuntState();
  loadWelcome(st, welcome);
  return st;
}

test('buildRoute facil: menor nivel primeiro, maior pontos desempata, com slug pra viajar', () => {
  const fila = [
    { pokeId: 2053, slug: 'magma_magcargo', nome: 'Magma Magcargo', area: 'outland', nivel: 150, pontos: 15 },
    { pokeId: 13, slug: 'weedle', nome: 'Weedle', area: 'kanto', nivel: 1, pontos: 15 },
    { pokeId: 10, slug: 'caterpie', nome: 'Caterpie', area: 'kanto', nivel: 1, pontos: 20 },
  ];
  const { targets, ordem } = buildRoute(fila, { ordem: 'facil' });
  assert.equal(ordem, 'facil');
  assert.deepEqual(targets.map((t) => t.pokeId), [10, 13, 2053]);
  assert.equal(targets[0].slug, 'caterpie');
});

test('buildRoute xp: maior nivel primeiro', () => {
  const fila = [
    { pokeId: 10, slug: 'a', nome: 'A', area: 'kanto', nivel: 1, pontos: 1 },
    { pokeId: 2053, slug: 'b', nome: 'B', area: 'outland', nivel: 150, pontos: 1 },
  ];
  const { targets } = buildRoute(fila, { ordem: 'xp' });
  assert.deepEqual(targets.map((t) => t.pokeId), [2053, 10]);
});

test('buildRoute regiao: agrupa kanto < outland < orre e corta em maxAlvos', () => {
  const fila = [
    { pokeId: 1, slug: 'x1', nome: 'X1', area: 'orre', nivel: 500, pontos: 1 },
    { pokeId: 2, slug: 'x2', nome: 'X2', area: 'outland', nivel: 150, pontos: 1 },
    { pokeId: 3, slug: 'x3', nome: 'X3', area: 'kanto', nivel: 470, pontos: 1 },
    { pokeId: 4, slug: 'x4', nome: 'X4', area: 'kanto', nivel: 5, pontos: 1 },
  ];
  const { targets } = buildRoute(fila, { ordem: 'regiao', maxAlvos: 3 });
  assert.deepEqual(targets.map((t) => t.area), ['kanto', 'kanto', 'outland']);
  assert.equal(targets.length, 3);
});

test('buildRoute dedup por pokeId e rejeita item sem slug/peekId ruim', () => {
  const fila = [
    { pokeId: 10, slug: 'caterpie', nome: 'C', area: 'kanto', nivel: 1, pontos: 1 },
    { pokeId: 10, slug: 'caterpie', nome: 'C dup', area: 'kanto', nivel: 1, pontos: 1 },
    { pokeId: 11, nome: 'sem-slug', nivel: 2 },
    { pokeId: 'abc', slug: 'x', nivel: 3 },
  ];
  const { targets } = buildRoute(fila, {});
  assert.deepEqual(targets.map((t) => t.pokeId), [10]);
});

test('buildRoute com entrada lixo nao explode', () => {
  assert.deepEqual(buildRoute(null).targets, []);
  assert.deepEqual(buildRoute([null, 3, 'x']).targets, []);
});

test('maxAlvos fora da faixa e capped', () => {
  const fila = Array.from({ length: MAX_ROUTE_TARGETS + 10 }, (_, i) => ({
    pokeId: 100 + i,
    slug: `s${i}`,
    nome: `S${i}`,
    area: 'kanto',
    nivel: i,
    pontos: 1,
  }));
  const { targets } = buildRoute(fila, { maxAlvos: 1e9 });
  assert.equal(targets.length, MAX_ROUTE_TARGETS);
  assert.equal(buildRoute(fila, { maxAlvos: -5 }).targets.length, 1);
});

test('fila real do fixture: faltantes viram rota com slug', () => {
  const st = stateComFaltas();
  const miss = catalogMissing(st, { limit: 300, levelCap: st.level });
  const { targets } = buildRoute(miss.items, { ordem: 'facil', maxAlvos: 50 });
  assert.equal(targets.length, miss.total);
  assert.equal(targets[0].nivel, 1);
  // Magcargo nv150 fica FORA: o levelCap 120 do fixture o cortou no catalogMissing
  assert.equal(targets.find((t) => t.pokeId === 2053), undefined);
  assert.deepEqual(targets.map((t) => t.pokeId).sort((a, b) => a - b), [10, 13]);
});

