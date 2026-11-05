import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeGrid, popupBounds, TOOLBAR_H } from '../src/main/layout.js';

const bounds = { width: 808, height: 608 };

test('zero slots = nenhuma rect', () => {
  assert.deepEqual(computeGrid(0, bounds, { cols: 2 }), []);
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

test('popupBounds respeita toolbar e margens', () => {
  const p = popupBounds({ width: 800, height: 600 });
  assert.equal(p.x, 8);
  assert.equal(p.y, TOOLBAR_H + 8);
  assert.equal(p.width, 800 - 16);
  assert.equal(p.height, 600 - TOOLBAR_H - 16);
});
