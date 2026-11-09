import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ECO_INSTALL, ecoSetExpr, ecoThrottleMs, ECO_ACTIVE_MS } from '../src/main/eco.js';
import { LIGHT_APPLY, LIGHT_RESTORE } from '../src/main/light.js';

function makeEnv() {
  const frames = [];
  const timers = new Map();
  const cancelled = [];
  let nextTimer = 1;
  const realRaf = (cb) => {
    frames.push(cb);
    return 100 + frames.length;
  };
  const realCaf = (id) => cancelled.push(id);
  return {
    window: { requestAnimationFrame: realRaf, cancelAnimationFrame: realCaf },
    realRaf,
    realCaf,
    frames,
    timers,
    cancelled,
    setTimeout: (fn, ms) => {
      const id = nextTimer++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    performance: { now: () => 12345 },
  };
}

function install(env) {
  const fn = new Function('window', 'setTimeout', 'clearTimeout', 'performance', 'return ' + ECO_INSTALL);
  return fn(env.window, env.setTimeout, env.clearTimeout, env.performance);
}

function run(env, code) {
  const fn = new Function('window', 'setTimeout', 'clearTimeout', 'performance', 'return ' + code);
  return fn(env.window, env.setTimeout, env.clearTimeout, env.performance);
}

function set(env, enabled) {
  return run(env, ecoSetExpr(enabled));
}

function fireAll(env) {
  for (const [id, timer] of [...env.timers]) {
    env.timers.delete(id);
    timer.fn();
  }
}

test('ecoThrottleMs: ligado usa o intervalo ativo, desligado zera', () => {
  assert.equal(ecoThrottleMs(true), ECO_ACTIVE_MS);
  assert.equal(ecoThrottleMs(false), 0);
  assert.equal(ecoThrottleMs('sim'), 0);
});

test('patch do eco instala uma vez e some na segunda', () => {
  const env = makeEnv();
  assert.equal(install(env), 'applied');
  assert.notEqual(env.window.requestAnimationFrame, env.realRaf);
  assert.equal(install(env), 'already');
});

test('com eco ligado o rAF e agendado por setTimeout', () => {
  const env = makeEnv();
  install(env);
  assert.equal(set(env, true), true);
  let got = null;
  env.window.requestAnimationFrame((t) => {
    got = t;
  });
  assert.equal(env.timers.size, 1);
  const [timer] = [...env.timers.values()];
  assert.equal(timer.ms, ECO_ACTIVE_MS);
  fireAll(env);
  assert.equal(got, 12345);
});

test('com eco desligado volta a delegar ao rAF nativo', () => {
  const env = makeEnv();
  install(env);
  set(env, true);
  set(env, false);
  env.window.requestAnimationFrame(() => {});
  assert.equal(env.timers.size, 0);
  assert.equal(env.frames.length, 1);
});

test('cancelar um id nativo nao cancela um timer do eco', () => {
  const env = makeEnv();
  install(env);
  set(env, true);
  const wid = env.window.requestAnimationFrame(() => {});
  env.window.cancelAnimationFrame(1);
  assert.equal(env.timers.size, 1);
  assert.deepEqual(env.cancelled, [1]);
  env.window.cancelAnimationFrame(wid);
  assert.equal(env.timers.size, 0);
  assert.deepEqual(env.cancelled, [1]);
});

test('eco antes do leve: desligar o leve devolve ao eco, nao ao nativo', () => {
  const env = makeEnv();
  install(env);
  set(env, true);
  const ecoWrapped = env.window.requestAnimationFrame;
  assert.equal(run(env, LIGHT_APPLY), 'applied');
  const lightWrapped = env.window.requestAnimationFrame;
  assert.notEqual(lightWrapped, ecoWrapped);
  assert.equal(run(env, LIGHT_RESTORE), 'restored');
  assert.equal(env.window.requestAnimationFrame, ecoWrapped);
  env.window.requestAnimationFrame(() => {});
  assert.equal(env.timers.size, 1);
  assert.equal(env.frames.length, 0);
  set(env, false);
  env.window.requestAnimationFrame(() => {});
  assert.equal(env.frames.length, 1);
});

test('ecoSetExpr nao quebra quando o patch nao foi instalado', () => {
  const env = makeEnv();
  assert.doesNotThrow(() => set(env, true));
});
