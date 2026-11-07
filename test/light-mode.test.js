import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LightMode } from '../src/main/light-mode.js';

const URL_JOGO = 'https://pokeidle.io/app';

/**
 * webContents falso: roda os scripts do modo leve contra uma `window` falsa,
 * como o navegador faria, e guarda o que foi inserido.
 */
function fakeWebContents({ url = URL_JOGO, destroy = false } = {}) {
  const win = {
    requestAnimationFrame: (cb) => {
      win.__frames.push(cb);
      return win.__frames.length;
    },
    cancelAnimationFrame: () => {},
    localStorage: {
      store: new Map([
        ['cfg-economia', '0'],
        ['cfg-ultra', '0'],
      ]),
      getItem(k) {
        return this.store.has(k) ? this.store.get(k) : null;
      },
      setItem(k, v) {
        this.store.set(k, String(v));
      },
    },
    document: {
      documentElement: { classList: { contains: () => false } },
      querySelector: () => null,
    },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    __frames: [],
  };
  const state = { css: new Map(), nextCss: 1, reloads: 0, destroyed: destroy, url };
  const wc = {
    isDestroyed: () => state.destroyed,
    getURL: () => state.url,
    reload: () => {
      state.reloads += 1;
    },
    insertCSS: async (css) => {
      const key = `css-${state.nextCss++}`;
      state.css.set(key, css);
      return key;
    },
    removeInsertedCSS: async (key) => {
      if (!state.css.has(key)) throw new Error('chave desconhecida');
      state.css.delete(key);
    },
    executeJavaScript: async (code) => {
      const fn = new Function(
        'window',
        'setTimeout',
        'clearTimeout',
        'performance',
        'return ' + code
      );
      return fn(win, setTimeout, clearTimeout, performance);
    },
  };
  return { wc, win, state };
}

function fakeSlot(wc, extra = {}) {
  return {
    id: 'slot-1',
    view: { webContents: wc },
    lightMode: false,
    lightApplied: false,
    lightFailed: false,
    lightCssKey: null,
    lightGen: 0,
    lightReloadAt: 0,
    lightQueue: Promise.resolve(),
    ...extra,
  };
}

test('ligar zera as preferencias do jogo e recarrega a sessao', async () => {
  const { wc, win, state } = fakeWebContents();
  const slot = fakeSlot(wc);
  const light = new LightMode();
  const applied = await light.enable(slot);
  assert.equal(applied, true);
  assert.equal(slot.lightMode, true);
  assert.equal(state.reloads, 1);
  assert.equal(win.localStorage.getItem('cfg-economia'), '0');
  assert.equal(win.localStorage.getItem('cfg-ultra'), '0');
});

test('ligar com a view morta nao finge que ligou', async () => {
  const { wc } = fakeWebContents({ destroy: true });
  const slot = fakeSlot(wc);
  const light = new LightMode();
  assert.equal(await light.enable(slot), false);
  assert.equal(slot.lightMode, false);
});

test('aplicar esconde a cena e limita o rAF; desligar devolve tudo', async () => {
  const { wc, win, state } = fakeWebContents();
  const slot = fakeSlot(wc, { lightMode: true });
  const light = new LightMode();
  await light.sync(slot);
  assert.equal(slot.lightApplied, true);
  assert.equal(slot.lightFailed, false);
  assert.equal(state.css.size, 1, 'o CSS da cena ficou injetado');
  assert.notEqual(win.requestAnimationFrame, undefined);
  assert.ok(win.__pokeLauncherLight, 'o limitador foi instalado');

  const ok = await light.disable(slot);
  assert.equal(ok, true);
  assert.equal(state.css.size, 0, 'o CSS foi removido');
  assert.equal(slot.lightApplied, false);
  assert.equal(win.__pokeLauncherLight, undefined, 'o limitador foi desfeito');
});

test('desligar durante uma aplicacao nao deixa o modo ligado', async () => {
  const { wc, win, state } = fakeWebContents();
  const slot = fakeSlot(wc, { lightMode: true });
  const light = new LightMode();
  const aplicando = light.sync(slot);
  const desligando = light.disable(slot);
  await Promise.all([aplicando, desligando]);
  assert.equal(slot.lightMode, false);
  assert.equal(state.css.size, 0, 'nenhum CSS sobrou');
  assert.equal(win.__pokeLauncherLight, undefined, 'nenhum limitador sobrou');
});

test('preferencia suja recarrega uma vez e trava por 10 s', async () => {
  const { wc, win, state } = fakeWebContents();
  const slot = fakeSlot(wc, { lightMode: true });
  const light = new LightMode();
  win.localStorage.setItem('cfg-economia', '1');
  await light.sync(slot);
  assert.equal(state.reloads, 1, 'recarregou para o jogo sair de Economia');
  assert.equal(win.localStorage.getItem('cfg-economia'), '0', 'a preferencia ficou zerada');

  // segunda passagem com a preferencia suja de novo: nao recarrega (trava)
  win.localStorage.setItem('cfg-economia', '1');
  await light.sync(slot);
  assert.equal(state.reloads, 1, 'nao entrou em loop de reload');
  assert.equal(slot.lightApplied, true, 'o modo leve continua aplicado');
});

test('a fila serializa as tarefas da sessao', async () => {
  const { wc, state } = fakeWebContents();
  const slot = fakeSlot(wc, { lightMode: true });
  const light = new LightMode();
  const ordem = [];
  const primeira = light.queue(slot, async () => {
    ordem.push('primeira inicio');
    await new Promise((resolve) => setTimeout(resolve, 10));
    ordem.push('primeira fim');
  });
  const segunda = light.queue(slot, async () => {
    ordem.push('segunda');
  });
  await Promise.all([primeira, segunda]);
  assert.deepEqual(ordem, ['primeira inicio', 'primeira fim', 'segunda']);
  assert.equal(state.reloads, 0);
});
