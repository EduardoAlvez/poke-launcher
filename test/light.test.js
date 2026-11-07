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
  LIGHT_VERIFY,
  LIGHT_WATCH,
} from '../src/main/light.js';

function run(script, win, { setT = setTimeout, clearT = clearTimeout, perf = performance } = {}) {
  return new Function('window', 'setTimeout', 'clearTimeout', 'performance', `return ${script}`)(
    win,
    setT,
    clearT,
    perf
  );
}

function fakeWindow() {
  const calls = [];
  const real = (cb) => {
    calls.push(cb);
    return calls.length;
  };
  const realCaf = () => {};
  return { win: { requestAnimationFrame: real, cancelAnimationFrame: realCaf }, real, realCaf, calls };
}

test('limita o rAF uma vez, confirma e restaura o original', () => {
  const { win, real, realCaf } = fakeWindow();
  assert.equal(run(LIGHT_VERIFY, win), false);
  assert.equal(run(LIGHT_APPLY, win), 'applied');
  assert.notEqual(win.requestAnimationFrame, real);
  assert.notEqual(win.cancelAnimationFrame, realCaf);
  assert.equal(run(LIGHT_VERIFY, win), true);
  assert.equal(run(LIGHT_APPLY, win), 'already');
  assert.equal(run(LIGHT_RESTORE, win), 'restored');
  assert.equal(win.requestAnimationFrame, real);
  assert.equal(win.cancelAnimationFrame, realCaf);
  assert.equal(run(LIGHT_VERIFY, win), false);
  assert.equal(run(LIGHT_RESTORE, win), 'absent');
});

test('cancelar um frame nosso limpa o timeout em vez de vazar', () => {
  const { win } = fakeWindow();
  const cleared = [];
  run(LIGHT_APPLY, win, {
    setT: () => 41,
    clearT: (id) => cleared.push(id),
  });
  const handle = win.requestAnimationFrame(() => {});
  assert.equal(handle, 41);
  win.cancelAnimationFrame(handle);
  assert.deepEqual(cleared, [41]);
  assert.equal(win.__pokeLauncherLight.handled.has(41), false);
});

test('restaurar nao descarta o quadro pendente: o laco do jogo continua', () => {
  const { win } = fakeWindow();
  const pending = [];
  run(LIGHT_APPLY, win, {
    setT: (cb) => {
      pending.push(cb);
      return pending.length;
    },
  });
  let chamadas = 0;
  win.requestAnimationFrame(() => {
    chamadas += 1;
  });
  assert.equal(run(LIGHT_RESTORE, win), 'restored');
  pending[0]();
  assert.equal(chamadas, 1, 'o callback pendente ainda roda (a cena nao congela)');
});

test('a vigia sai do Modo Economia/Ultra quando o jogo volta para eles', () => {
  let eco = true;
  let ultra = false;
  let ecoClicks = 0;
  let ultraClicks = 0;
  const win = {
    document: {
      documentElement: { classList: { contains: (c) => (c === 'modo-economia' ? eco : ultra) } },
      querySelector: (sel) => {
        if (sel === '#eco-sair' && eco) return { click: () => { ecoClicks += 1; eco = false; } };
        if (sel === '#ultra-sair' && ultra) return { click: () => { ultraClicks += 1; ultra = false; } };
        return null;
      },
    },
  };
  assert.equal(run(LIGHT_WATCH, win), 'exit-economy');
  assert.equal(ecoClicks, 1);
  assert.equal(run(LIGHT_WATCH, win), 'ok');
  eco = false;
  ultra = true;
  assert.equal(run(LIGHT_WATCH, win), 'exit-ultra');
  assert.equal(ultraClicks, 1);
  assert.equal(run(LIGHT_WATCH, win), 'ok');
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
  assert.match(LIGHT_CSS, /#palco \*/);
  assert.doesNotMatch(LIGHT_CSS, /^\s*\*/m);
});
