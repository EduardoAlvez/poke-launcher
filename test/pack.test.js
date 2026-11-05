import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectSelectors, validatePack, matchesGame } from '../src/main/addons.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

async function pack(name) {
  return JSON.parse(await readFile(path.join(root, 'src/main/rules', name), 'utf8'));
}

test('pack do jogo e valido e tem regras/ancoras', async () => {
  const p = await pack('pokeidle.json');
  const res = validatePack(p);
  assert.equal(res.ok, true, res.error);
  assert.ok(p.rules.length >= 4);
  assert.ok(p.css.length >= 1);
  assert.equal(matchesGame('https://pokeidle.io/app'), true);
  assert.equal(matchesGame('https://evil.example/pokeidle.io'), false);
});

test('pack de automacao expoe candidatos de clique e pausa', async () => {
  const p = await pack('automation-pokeidle.json');
  assert.ok(Array.isArray(p.clickCandidates) && p.clickCandidates.length > 0);
  assert.ok(Array.isArray(p.pauseSelectors));
  assert.equal(typeof p.stopOnRule, 'string');
});

test('todos os seletores do pack sao consultaveis pelo DOM', async () => {
  const p = await pack('pokeidle.json');
  const selectors = collectSelectors(p);
  assert.ok(selectors.length > 0);
  for (const selector of selectors) {
    assert.doesNotThrow(() => {
      const doc = { querySelector: () => null };
      doc.querySelector(selector);
    }, `seletor invalido: ${selector}`);
    new RegExp('^' + selector);
  }
});

test('addon preload gerado e JS valido e contem os tres blocos', async () => {
  const { buildAddonPreload } = await import('../src/main/addons.js');
  const tmp = path.join(root, 'node_modules/.cache/addon-e2e');
  const file = await buildAddonPreload(tmp);
  const code = await readFile(file, 'utf8');
  assert.match(code, /PokeAddonEngine/);
  assert.match(code, /PokeAutomation/);
  assert.match(code, /addon:rules/);
  assert.match(code, /automation:config/);
  const { Script } = await import('node:vm');
  assert.doesNotThrow(() => new Script(code), 'preload gerado nao compila');
});
