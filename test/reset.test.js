import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canReset, RESET_DETAIL } from '../src/main/reset.js';

test('canReset recusa sessao inexistente e automacao ativa', () => {
  assert.equal(canReset(undefined).ok, false);
  assert.match(canReset(undefined).error, /inexistente/);
  const comAuto = canReset({ id: 'slot-1', automation: { enabled: true } });
  assert.equal(comAuto.ok, false);
  assert.match(comAuto.error, /automacao/);
  assert.equal(canReset({ id: 'slot-1', automation: { enabled: false } }).ok, true);
  assert.equal(canReset({ id: 'slot-1', automation: null }).ok, true);
});

test('texto do reler login diz o que sai e o que fica', () => {
  assert.match(RESET_DETAIL, /cookies/);
  assert.match(RESET_DETAIL, /outras sessoes nao mudam/);
  assert.match(RESET_DETAIL, /Cache/);
});
