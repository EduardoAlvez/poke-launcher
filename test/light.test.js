import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIGHT_APPLY,
  LIGHT_CSS,
  LIGHT_ECONOMY_KEY,
  LIGHT_PREFS_OFF,
  LIGHT_PREFS_ON,
  LIGHT_RESTORE,
  LIGHT_THROTTLE_MS,
  LIGHT_ULTRA_KEY,
} from '../src/main/light.js';

function run(script, win, { setT = setTimeout, perf = performance } = {}) {
  return new Function('window', 'setTimeout', 'performance', `return ${script}`)(win, setT, perf);
}

function fakeWindow() {
  const calls = [];
  const real = (cb) => {
    calls.push(cb);
    return calls.length;
  };
  return { win: { requestAnimationFrame: real }, real, calls };
}

test('limita o rAF uma vez e restaura o original', () => {
  const { win, real } = fakeWindow();
  assert.equal(run(LIGHT_APPLY, win), 'applied');
  assert.notEqual(win.requestAnimationFrame, real);
  assert.equal(run(LIGHT_APPLY, win), 'already');
  assert.equal(run(LIGHT_RESTORE, win), 'restored');
  assert.equal(win.requestAnimationFrame, real);
  assert.equal(run(LIGHT_RESTORE, win), 'absent');
});

test('o rAF limitado agenda por timeout e entrega o relogio de performance', () => {
  const { win } = fakeWindow();
  const scheduled = [];
  run(LIGHT_APPLY, win, {
    setT: (cb, ms) => {
      scheduled.push({ cb, ms });
      return 7;
    },
    perf: { now: () => 1234 },
  });
  let received = null;
  win.requestAnimationFrame((t) => {
    received = t;
  });
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].ms, LIGHT_THROTTLE_MS);
  scheduled[0].cb();
  assert.equal(received, 1234);
});

test('preferencias do jogo viram 0 e o estado sujo e detectavel', () => {
  const store = new Map([
    [LIGHT_ECONOMY_KEY, '1'],
    [LIGHT_ULTRA_KEY, '0'],
  ]);
  const win = {
    localStorage: {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => store.set(k, v),
    },
  };
  assert.equal(run(LIGHT_PREFS_ON, win), true);
  assert.equal(run(LIGHT_PREFS_OFF, win), true);
  assert.equal(store.get(LIGHT_ECONOMY_KEY), '0');
  assert.equal(store.get(LIGHT_ULTRA_KEY), '0');
  assert.equal(run(LIGHT_PREFS_ON, win), false);
});

test('o CSS esconde a cena sem esconder a lista de caidos', () => {
  assert.match(LIGHT_CSS, /#cena/);
  assert.doesNotMatch(LIGHT_CSS, /#caidos/);
});
