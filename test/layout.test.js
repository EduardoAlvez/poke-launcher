import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeGrid, computeFocusBounds, isSlotVisible, popupBounds, COLLAPSED_TOOLBAR_H, TOOLBAR_H } from '../src/main/layout.js';

const bounds = { width: 808, height: 608 };

test('zero slots = nenhuma rect', () => {
  assert.deepEqual(computeGrid(0, bounds, { cols: 2 }), []);
});

test('modo foco usa toda a area abaixo da toolbar', () => {
  assert.deepEqual(computeFocusBounds(bounds), {
    x: 0,
    y: TOOLBAR_H,
    width: bounds.width,
    height: bounds.height - TOOLBAR_H,
  });
});

test('barra recolhida libera altura para a grade e o modo foco', () => {
  const [grid] = computeGrid(1, bounds, { cols: 1, topOffset: COLLAPSED_TOOLBAR_H });
  const focus = computeFocusBounds(bounds, { topOffset: COLLAPSED_TOOLBAR_H });

  assert.equal(grid.y, COLLAPSED_TOOLBAR_H + 8);
  assert.equal(focus.y, COLLAPSED_TOOLBAR_H);
  assert.equal(focus.height, bounds.height - COLLAPSED_TOOLBAR_H);
  assert.equal(TOOLBAR_H - COLLAPSED_TOOLBAR_H, 34);
});

test('modo foco retorna vazio quando nao ha area util', () => {
  assert.equal(computeFocusBounds({ width: 0, height: 608 }), null);
  assert.equal(computeFocusBounds({ width: 808, height: TOOLBAR_H }), null);
});

test('visibilidade combina modo foco com ocultacao temporaria', () => {
  assert.equal(isSlotVisible('a', null, true), true);
  assert.equal(isSlotVisible('b', 'a', true), false);
  assert.equal(isSlotVisible('a', 'a', true), true);
  assert.equal(isSlotVisible('a', 'a', false), false);
});

test('1 slot ocupa 100% menos margens', () => {
  const [r] = computeGrid(1, bounds, { cols: 2, gap: 8, topOffset: 44 });
  assert.equal(r.x, 8);
  assert.equal(r.y, 52);
  assert.equal(r.width, 808 - 16);
  assert.equal(r.height, 608 - 44 - 16);
});

test('2 slots em 2 colunas: iguais e sem overlap', () => {
  const rects = computeGrid(2, bounds, { cols: 2, gap: 8, topOffset: 44 });
  assert.equal(rects.length, 2);
  assert.equal(rects[0].width, rects[1].width);
  assert.equal(rects[1].x, rects[0].x + rects[0].width + 8);
  assert.ok(rects[1].x + rects[1].width <= 808 - 8);
});

test('3 slots em 2 colunas: ultima linha estica inteira', () => {
  const rects = computeGrid(3, bounds, { cols: 2, gap: 8, topOffset: 44 });
  assert.equal(rects[2].x, 8);
  assert.equal(rects[2].width, 808 - 16);
  assert.equal(rects[2].y, rects[0].y + rects[0].height + 8);
});

test('4 slots em 3 colunas: 3 na primeira linha, ultimo estica', () => {
  const rects = computeGrid(4, bounds, { cols: 3, gap: 8, topOffset: 44 });
  assert.equal(rects[0].width, rects[1].width);
  assert.equal(rects[1].width, rects[2].width);
  assert.equal(rects[3].x, 8);
  assert.equal(rects[3].width, 808 - 16);
});

test('todos os rects dentro do conteudo e com gap minimo', () => {
  for (const cols of [1, 2, 3, 4]) {
    for (const n of [1, 2, 3, 5, 7]) {
      const rects = computeGrid(n, bounds, { cols, gap: 8, topOffset: 44 });
      assert.equal(rects.length, n);
      for (const r of rects) {
        assert.ok(r.x >= 8 && r.y >= 52, `x/y >= margem (cols=${cols}, n=${n})`);
        assert.ok(r.x + r.width <= 808, `dentro da largura (cols=${cols}, n=${n})`);
        assert.ok(r.y + r.height <= 608, `dentro da altura (cols=${cols}, n=${n})`);
      }
    }
  }
});

test('area minuscula retorna vazio em vez de rect negativa', () => {
  assert.deepEqual(computeGrid(2, { width: 10, height: 10 }, { cols: 2 }), []);
});

test('popupBounds fica centralizado, abaixo da toolbar e limitado', () => {
  const p = popupBounds({ width: 1600, height: 1000 });
  assert.ok(p.y >= TOOLBAR_H);
  assert.ok(p.width <= 720);
  assert.ok(p.height <= 820);
  assert.equal(p.x, Math.round((1600 - p.width) / 2));
  assert.ok(p.x >= 0);
});

test('popupBounds nao estoura janela pequena', () => {
  const p = popupBounds({ width: 400, height: 300 });
  assert.ok(p.x >= 0 && p.y >= TOOLBAR_H);
  assert.ok(p.x + p.width <= 400);
  assert.ok(p.y + p.height <= 300);
});

test('popupBounds acompanha o topo da toolbar recolhida', () => {
  const p = popupBounds(bounds, { topOffset: COLLAPSED_TOOLBAR_H });
  assert.equal(p.y, COLLAPSED_TOOLBAR_H + 8);
  assert.ok(p.y + p.height <= bounds.height);
});
