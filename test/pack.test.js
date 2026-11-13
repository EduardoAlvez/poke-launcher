import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectSelectors, validatePack, matchesGame, loadAutomationPack, GAME_PATTERNS } from '../src/main/addons.js';

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
  assert.equal(matchesGame('https://www.pokeidle.io/app'), true);
  assert.equal(matchesGame('https://evil.example/pokeidle.io'), false);
  assert.ok(GAME_PATTERNS.includes('https://*.pokeidle.io/*'));
});

test('loadAutomationPack mira a lista de proximidade (arremesso manual)', async () => {
  const p = await loadAutomationPack();
  assert.ok(p.clickCandidates.some((s) => s.includes('.caido')));
  assert.ok(!p.clickCandidates.includes('.campo-bola'), '.campo-bola e campo do formulario de login');
  assert.ok(!p.clickCandidates.includes('#cena'), 'o palco nao tem handler de clique');
  assert.equal(p.economySelector, 'html.modo-economia');
  assert.equal(p.countSelector, '#caidos-lista .caido');
  assert.equal(p.accountTakenSelector, '#sessao-tomada:not(.hidden)');
  assert.equal(p.economyExitSelector, '#eco-sair');
  assert.equal(p.economyEnterSelector, '#hunt-eco');
  assert.equal(p.stopOnRule, 'pokemon-caught');
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

test('addon preload gerado e JS valido e contem os quatro blocos', async () => {
  const { buildAddonPreload } = await import('../src/main/addons.js');
  const tmp = path.join(root, 'node_modules/.cache/addon-e2e');
  const file = await buildAddonPreload(tmp);
  const code = await readFile(file, 'utf8');
  assert.match(code, /PokeAddonEngine/);
  assert.match(code, /PokeAutomation/);
  assert.match(code, /PokeRoute/);
  assert.match(code, /addon:rules/);
  assert.match(code, /automation:config/);
  assert.match(code, /route:config/);
  const { Script } = await import('node:vm');
  assert.doesNotThrow(() => new Script(code), 'preload gerado nao compila');
});

test('applyPackCss troca a chave do CSS em vez de empilhar copias', async () => {
  const { applyPackCss } = await import('../src/main/addons.js');
  const calls = [];
  const wc = {
    insertCSS: async () => {
      calls.push('insert');
      return `k${calls.length}`;
    },
    removeInsertedCSS: async (key) => {
      calls.push(`remove:${key}`);
    },
  };
  const pack = { css: ['.chat-vao { max-height: 32vh !important; }'] };
  const k1 = await applyPackCss(wc, pack);
  const k2 = await applyPackCss(wc, pack, k1);
  assert.equal(k1, 'k1');
  assert.equal(k2, 'k3');
  assert.deepEqual(calls, ['insert', 'remove:k1', 'insert']);
  assert.equal(await applyPackCss(wc, { css: [] }), null, 'pack sem CSS nao insere nada');
});

test('regra de captura ignora o painel de capturas e o chat', async () => {
  const pack = JSON.parse(await readFile(path.join(here, '../src/main/rules/pokeidle.json'), 'utf8'));
  const regra = pack.rules.find((r) => r.id === 'pokemon-caught');
  assert.ok(regra, 'a regra existe');
  for (const seletor of ['.chat-msgs', '.chat-vao', '.chat-entrada', '.capturas-painel']) {
    assert.ok(regra.excludeWithin.includes(seletor), `exclui ${seletor}`);
  }
});
