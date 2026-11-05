import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePack, loadPack, matchesGame } from '../src/main/addons.js';
import '../src/shared/engine.js';

const { matchRules, ruleMatches, checkCounters, parseCount } = globalThis.PokeAddonEngine;

const dirname = path.dirname(fileURLToPath(import.meta.url));
const engineSrc = await fs.readFile(path.join(dirname, '../src/shared/engine.js'), 'utf8');

test('engine carrega e expoe a API', () => {
  assert.equal(typeof globalThis.PokeAddonEngine, 'object');
  assert.equal(typeof globalThis.PokeAddonEngine.matchRules, 'function');
});

test('parseCount extrai numeros com separador de milhar', () => {
  assert.equal(parseCount('12'), 12);
  assert.equal(parseCount('1.500'), 1500);
  assert.equal(parseCount('sem numero'), null);
});

test('matchRules casa por regex de texto', () => {
  const rules = [
    { id: 'pokemon-caught', kind: 'event', matchers: [{ kind: 'text', regex: 'captur(ou|ado)', flags: 'i' }] },
  ];
  const node = { nodeType: 1, textContent: 'Voce capturou MrMime!' };
  assert.deepEqual(matchRules(rules, node), ['pokemon-caught']);
  const nada = { nodeType: 1, textContent: 'nada a ver' };
  assert.deepEqual(matchRules(rules, nada), []);
});

test('matchRules casa por selector', () => {
  const rules = [{ id: 'x', kind: 'event', matchers: [{ kind: 'selector', selector: '.campo-bola' }] }];
  const node = { nodeType: 1, textContent: '', matches: (sel) => sel === '.campo-bola' };
  assert.deepEqual(matchRules(rules, node), ['x']);
});

test('checkCounters respeita limite minimo', () => {
  const rules = [
    { id: 'balls-low', kind: 'counter', matchers: [{ kind: 'selector', selector: '.cb-quantos', max: 5 }] },
  ];
  const doc = { querySelector: () => ({ textContent: '3' }) };
  assert.deepEqual(checkCounters(rules, doc), [{ id: 'balls-low', value: 3, limit: 5 }]);
  const docOk = { querySelector: () => ({ textContent: '12' }) };
  assert.deepEqual(checkCounters(rules, docOk), []);
  const docNone = { querySelector: () => null };
  assert.deepEqual(checkCounters(rules, docNone), []);
});

test('ruleMatches ignora rule de counter em evento', () => {
  const rules = [{ id: 'balls-low', kind: 'counter', matchers: [{ kind: 'text', regex: 'x' }] }];
  const node = { nodeType: 1, textContent: 'x' };
  assert.deepEqual(matchRules(rules, node), []);
  assert.equal(ruleMatches(rules[0], node), true);
});

test('pack do pokeidle e valido', async () => {
  const pack = await loadPack();
  const res = validatePack(pack);
  assert.equal(res.ok, true);
  assert.ok(pack.rules.length >= 3);
  assert.ok(pack.css.length >= 1);
});

test('validatePack recusa pack quebrado', () => {
  assert.equal(validatePack(null).ok, false);
  assert.equal(validatePack({ rules: 'x' }).ok, false);
  assert.equal(validatePack({ rules: [{ id: 'ok', matchers: [] }] }).ok, false);
  assert.equal(validatePack({ rules: [{ id: 'ok', matchers: [{ kind: 'text', regex: '([' }] }] }).ok, false);
  assert.equal(validatePack({ rules: [{ id: 'ok', matchers: [{ kind: 'zzz' }] }] }).ok, false);
});

test('matchesGame so aceita host do pokeidle', () => {
  assert.equal(matchesGame('https://pokeidle.io/app'), true);
  assert.equal(matchesGame('https://www.pokeidle.io/app'), true);
  assert.equal(matchesGame('https://pokeidle.io.evil.com/app'), false);
  assert.equal(matchesGame('https://outro.com'), false);
});
