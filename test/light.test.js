import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIGHT_APPLY,
  LIGHT_CSS,
  LIGHT_ECONOMY_KEY,
  LIGHT_PREFS_OFF,
  LIGHT_REAPPLY,
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

function fakeWatchWindow({ eco = false, ultra = false, visible = true } = {}) {
  const state = { eco, ultra, ecoClicks: 0, ultraClicks: 0 };
  const botao = (contador) => ({
    disabled: false,
    getBoundingClientRect: () => ({ width: visible ? 80 : 0, height: visible ? 20 : 0 }),
    click: () => {
      contador();
    },
  });
  const win = {
    localStorage: { setItem: () => {} },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    document: {
      documentElement: { classList: { contains: (c) => (c === 'modo-economia' ? state.eco : state.ultra) } },
      querySelector: (sel) => {
        if (sel === '#eco-sair' && state.eco) return botao(() => { state.ecoClicks += 1; state.eco = false; });
        if (sel === '#ultra-sair' && state.ultra) return botao(() => { state.ultraClicks += 1; state.ultra = false; });
        return null;
      },
    },
  };
  return { win, state };
}

test('a vigia sai do Modo Economia/Ultra quando o jogo volta para eles', () => {
  const { win, state } = fakeWatchWindow({ eco: true });
  assert.equal(run(LIGHT_WATCH, win), 'exit-economy');
  assert.equal(state.ecoClicks, 1);
  assert.equal(run(LIGHT_WATCH, win), 'ok');

  const ultraCase = fakeWatchWindow({ ultra: true });
  assert.equal(run(LIGHT_WATCH, ultraCase.win), 'exit-ultra');
  assert.equal(ultraCase.state.ultraClicks, 1);
  assert.equal(run(LIGHT_WATCH, ultraCase.win), 'ok');
});

test('a vigia nao clica em botao escondido', () => {
  const { win, state } = fakeWatchWindow({ eco: true, visible: false });
  assert.equal(run(LIGHT_WATCH, win), 'still-economy');
  assert.equal(state.ecoClicks, 0);
});

test('reaplicar nao atropela o rAF que a pagina instalou depois', () => {
  const { win } = fakeWindow();
  run(LIGHT_APPLY, win);
  const pagina = (cb) => cb(99);
  win.requestAnimationFrame = pagina;
  assert.equal(run(LIGHT_REAPPLY, win), 'reset');
  assert.equal(win.requestAnimationFrame, pagina, 'o rAF da pagina continua no lugar');
  run(LIGHT_APPLY, win);
  assert.notEqual(win.requestAnimationFrame, pagina, 'o limitador volta por cima do rAF da pagina');
  assert.equal(run(LIGHT_VERIFY, win), true);
});

test('restaurar nao sobrescreve um rAF novo da pagina', () => {
  const { win } = fakeWindow();
  run(LIGHT_APPLY, win);
  const pagina = (cb) => cb(99);
  win.requestAnimationFrame = pagina;
  assert.equal(run(LIGHT_RESTORE, win), 'restored');
  assert.equal(win.requestAnimationFrame, pagina, 'a pagina continua com o rAF dela');
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
