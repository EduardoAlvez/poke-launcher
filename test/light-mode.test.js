import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LightMode, modoLeveAtivo, saidaPermitida } from '../src/main/light-mode.js';

const URL_JOGO = 'https://pokeidle.io/app';

/**
 * webContents falso: roda os scripts do modo leve contra uma `window` falsa,
 * como o navegador faria, e guarda o que foi inserido.
 *
 * A `page` emula o JOGO: as classes do html (modo-economia/modo-ultra), os
 * botoes (#eco-sair, #hunt-eco, #ultra-sair, #cfg-ultra) e o efeito do
 * clique: o jogo real zera a preferencia ao sair do Modo Economia.
 */
function fakeWebContents({
  url = URL_JOGO,
  destroy = false,
  failRaf = false,
  botoes = ['eco-sair', 'hunt-eco', 'ultra-sair', 'cfg-ultra'],
  jogoLimpaPref = true,
} = {}) {
  const classes = new Set();
  const store = new Map([
    ['cfg-economia', '0'],
    ['cfg-ultra', '0'],
  ]);
  const cliques = [];
  const els = new Map();
  for (const id of botoes) {
    els.set(`#${id}`, {
      id,
      disabled: false,
      getBoundingClientRect: () => ({ width: 120, height: 24 }),
      click: () => {
        cliques.push(id);
        if (id === 'eco-sair') {
          classes.delete('modo-economia');
          if (jogoLimpaPref) store.set('cfg-economia', '0');
        }
        if (id === 'hunt-eco') {
          classes.add('modo-economia');
          store.set('cfg-economia', '1');
        }
        if (id === 'ultra-sair') {
          classes.delete('modo-ultra');
          if (jogoLimpaPref) store.set('cfg-ultra', '0');
        }
        if (id === 'cfg-ultra') {
          classes.add('modo-ultra');
          store.set('cfg-ultra', '1');
        }
      },
    });
  }
  const classList = {
    contains: (c) => classes.has(c),
    add: (c) => classes.add(c),
    remove: (c) => classes.delete(c),
  };
  const page = {
    documentElement: { classList },
    querySelector: (sel) => els.get(sel) ?? null,
    body: { textContent: '' },
  };
  const win = {
    document: page,
    requestAnimationFrame: (cb) => {
      win.__frames.push(cb);
      return win.__frames.length;
    },
    cancelAnimationFrame: () => {},
    localStorage: {
      store,
      getItem(k) {
        return this.store.has(k) ? this.store.get(k) : null;
      },
      setItem(k, v) {
        this.store.set(k, String(v));
      },
    },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    __frames: [],
  };
  const state = {
    css: new Map(),
    nextCss: 1,
    reloads: 0,
    destroyed: destroy,
    url,
    classes,
    store,
    cliques,
  };
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
      if (failRaf && code.includes('window.requestAnimationFrame = wrapped')) throw new Error('rAF bloqueado');
      const fn = new Function(
        'window',
        'document',
        'setTimeout',
        'clearTimeout',
        'performance',
        'return ' + code
      );
      return fn(win, page, setTimeout, clearTimeout, performance);
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
    prefsEconomiaDoUsuario: null,
    prefsEconomiaPendente: null,
    ...extra,
  };
}

test('ligar com o jogo em Economia sai pelo botao do jogo, sem recarregar', async () => {
  const { wc, win, state } = fakeWebContents();
  const slot = fakeSlot(wc);
  const light = new LightMode();
  state.classes.add('modo-economia');
  win.localStorage.setItem('cfg-economia', '1');

  const res = await light.enable(slot);
  assert.equal(res.ok, true);
  assert.equal(slot.lightMode, true);
  assert.equal(state.reloads, 0, 'quem esta cacando nao perde a sessao a toa');
  assert.deepEqual(state.cliques, ['eco-sair'], 'saiu pelo botao do proprio jogo');
  assert.equal(state.classes.has('modo-economia'), false);
  assert.equal(slot.prefsEconomiaDoUsuario.economia, true, 'lembrou a preferencia do usuario');
  assert.equal(state.css.size, 1, 'o modo leve foi aplicado na hora');
  assert.ok(win.__pokeLauncherLight, 'o limitador entrou no documento atual');
});

test('ligar fora do Economia nao clica em nada', async () => {
  const { wc, state } = fakeWebContents();
  const slot = fakeSlot(wc);
  const light = new LightMode();
  const res = await light.enable(slot);
  assert.equal(res.ok, true);
  assert.equal(state.reloads, 0);
  assert.deepEqual(state.cliques, [], 'nao mexe no jogo quando nao precisa');
  assert.equal(state.css.size, 1);
});

test('ligar com a view morta nao finge que ligou', async () => {
  const { wc } = fakeWebContents({ destroy: true });
  const slot = fakeSlot(wc);
  const light = new LightMode();
  const res = await light.enable(slot);
  assert.equal(res.ok, false);
  assert.equal(res.motivo, 'sessao-morta');
  assert.equal(slot.lightMode, false);
});

test('ligar sem o botao do jogo usa o ultimo recurso e guarda a preferencia', async () => {
  const { wc, win, state } = fakeWebContents({ botoes: [] });
  const slot = fakeSlot(wc);
  const light = new LightMode();
  state.classes.add('modo-economia');
  win.localStorage.setItem('cfg-economia', '1');

  const res = await light.enable(slot);
  assert.equal(res.ok, true);
  assert.equal(res.motivo, 'fallback-reload');
  assert.equal(state.reloads, 1, 'sem botao do jogo, recarregar e o ultimo recurso');
  assert.equal(win.localStorage.getItem('cfg-economia'), '0');
  assert.equal(slot.prefsEconomiaDoUsuario.economia, true, 'a preferencia do usuario nao se perdeu');
});

test('falha do rAF nao deixa a cena escondida sem economia', async () => {
  const { wc, state } = fakeWebContents({ failRaf: true });
  const slot = fakeSlot(wc, { lightMode: true });
  const light = new LightMode();
  const ok = await light.applyNow(slot);
  assert.equal(ok, false);
  assert.equal(slot.lightFailed, true);
  assert.equal(slot.lightCssKey, null);
  assert.equal(state.css.size, 0, 'o CSS saiu junto: nada de cena escondida a 60 fps');
});

test('desligar limpa o aviso de falha do chip', async () => {
  const { wc, win } = fakeWebContents();
  const slot = fakeSlot(wc, { lightMode: true, lightApplied: false, lightFailed: true });
  const light = new LightMode();
  await light.disable(slot);
  assert.equal(slot.lightFailed, false, 'o chip nao fica vermelho com o modo desligado');
  assert.equal(win.__pokeLauncherLight, undefined);
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

  const res = await light.disable(slot);
  assert.equal(res.ok, true);
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

test('desligar restaura a preferencia do usuario pelo botao do jogo', async () => {
  const { wc, win, state } = fakeWebContents();
  const slot = fakeSlot(wc);
  const light = new LightMode();
  state.classes.add('modo-economia');
  win.localStorage.setItem('cfg-economia', '1');
  await light.enable(slot);
  assert.equal(win.localStorage.getItem('cfg-economia'), '0', 'o jogo zerou a chave ao sair do Economia');

  const res = await light.disable(slot, { campoEmUso: false });
  assert.equal(res.restauracao, 'restaurado');
  assert.deepEqual(state.cliques, ['eco-sair', 'hunt-eco'], 'voltou pelo atalho do jogo');
  assert.equal(win.localStorage.getItem('cfg-economia'), '1', 'a preferencia do usuario voltou');
  assert.equal(slot.prefsEconomiaDoUsuario, null);
});

test('desligar com AUTO/rota rodando adia a restauracao ate parar', async () => {
  const { wc, win, state } = fakeWebContents();
  const slot = fakeSlot(wc);
  const light = new LightMode();
  state.classes.add('modo-economia');
  win.localStorage.setItem('cfg-economia', '1');
  await light.enable(slot);

  const res = await light.disable(slot, { campoEmUso: true });
  assert.equal(res.restauracao, 'adiado');
  assert.equal(state.cliques.includes('hunt-eco'), false, 'nao religa a economia com o AUTO rodando');
  assert.equal(slot.prefsEconomiaPendente.economia, true, 'a restauracao ficou guardada');

  const depois = await light.restaurarPreferenciaAposPararDoAUTO(slot);
  assert.equal(depois, 'restaurado');
  assert.equal(state.cliques.includes('hunt-eco'), true, 'quando o AUTO para, a preferencia volta');
  assert.equal(win.localStorage.getItem('cfg-economia'), '1');
});

test('nao sobrescreve escolha nova do usuario', async () => {
  const { wc, win, state } = fakeWebContents();
  const slot = fakeSlot(wc);
  const light = new LightMode();
  state.classes.add('modo-economia');
  win.localStorage.setItem('cfg-economia', '1');
  await light.enable(slot);

  // o usuario religou a economia durante o modo leve: ja esta ligado, entao
  // nao ha o que restaurar.
  state.classes.add('modo-economia');
  win.localStorage.setItem('cfg-economia', '1');
  const res = await light.disable(slot, { campoEmUso: false });
  assert.equal(res.restauracao, 'restaurado');
  assert.equal(state.cliques.includes('hunt-eco'), false, 'nao clicou por cima da escolha do usuario');
});

test('sync reaplica o modo leve sem recarregar quando o jogo ja esta fora', async () => {
  const { wc, state } = fakeWebContents();
  const slot = fakeSlot(wc, { lightMode: true });
  const light = new LightMode();
  await light.sync(slot);
  assert.equal(state.reloads, 0);
  assert.equal(state.css.size, 1);
  assert.equal(slot.lightApplied, true);
});

test('sync sai pelo botao do jogo quando o Economia volta', async () => {
  const { wc, win, state } = fakeWebContents();
  const slot = fakeSlot(wc, { lightMode: true });
  const light = new LightMode();
  state.classes.add('modo-economia');
  win.localStorage.setItem('cfg-economia', '1');
  await light.sync(slot);
  assert.equal(state.reloads, 0, 'o botao do jogo resolve: sem reload');
  assert.deepEqual(state.cliques, ['eco-sair']);
  assert.equal(state.css.size, 1, 'o modo leve continua aplicado');
});

test('sync sem botao do jogo recarrega uma vez e trava por 10 s', async () => {
  const { wc, win, state } = fakeWebContents({ botoes: [] });
  const slot = fakeSlot(wc, { lightMode: true });
  const light = new LightMode();
  state.classes.add('modo-economia');
  win.localStorage.setItem('cfg-economia', '1');
  await light.sync(slot);
  assert.equal(state.reloads, 1, 'recarregou para o jogo sair de Economia');
  assert.equal(win.localStorage.getItem('cfg-economia'), '0', 'a preferencia ficou zerada');

  // segunda passagem com a preferencia suja de novo: nao recarrega (trava)
  state.classes.add('modo-economia');
  win.localStorage.setItem('cfg-economia', '1');
  await light.sync(slot);
  assert.equal(state.reloads, 1, 'nao entrou em loop de reload');
  assert.equal(slot.lightApplied, true, 'o modo leve continua aplicado');
});

test('watch nao escreve a preferencia do usuario', async () => {
  // o botao do jogo NAO zera a chave aqui: se a preferencia mudar, foi o
  // launcher que escreveu — e ele nao pode.
  const { wc, win, state } = fakeWebContents({ jogoLimpaPref: false });
  const slot = fakeSlot(wc, { lightMode: true });
  const light = new LightMode();
  state.classes.add('modo-economia');
  win.localStorage.setItem('cfg-economia', '1');

  const res = await light.watch(slot);
  assert.equal(res, 'exit-economy');
  assert.deepEqual(state.cliques, ['eco-sair']);
  assert.equal(win.localStorage.getItem('cfg-economia'), '1', 'a vigia nao mexe na preferencia');
});

test('a preferencia lembrada sobrevive a dois ciclos de modo leve', async () => {
  // Cenario que a revisao achou: enable -> disable (AUTO rodando, fica
  // pendente) -> enable de novo -> disable (AUTO rodando). A preferencia do
  // usuario nao pode virar 'false' no meio do caminho.
  const { wc, win, state } = fakeWebContents();
  const slot = fakeSlot(wc);
  const light = new LightMode();
  state.classes.add('modo-economia');
  win.localStorage.setItem('cfg-economia', '1');

  await light.enable(slot);
  assert.equal(slot.prefsEconomiaDoUsuario.economia, true);

  await light.disable(slot, { campoEmUso: true });
  assert.equal(slot.prefsEconomiaPendente.economia, true);

  await light.enable(slot);
  assert.equal(
    slot.prefsEconomiaDoUsuario.economia,
    true,
    'religar o modo leve nao pode apagar a preferencia do usuario'
  );

  await light.disable(slot, { campoEmUso: true });
  assert.equal(slot.prefsEconomiaPendente.economia, true, 'a pendencia nunca e rebaixada');
});

test('com o modo leve ligado a preferencia nao volta (a vigia brigaria)', async () => {
  const { wc, win, state } = fakeWebContents();
  const slot = fakeSlot(wc);
  const light = new LightMode();
  state.classes.add('modo-economia');
  win.localStorage.setItem('cfg-economia', '1');
  await light.enable(slot);
  await light.disable(slot, { campoEmUso: true });
  assert.equal(slot.prefsEconomiaPendente.economia, true);

  // o AUTO parou, mas o modo leve voltou a ser ligado: religar agora seria
  // Fight com a vigia (que sairia de novo em 20 s).
  slot.lightMode = true;
  const res = await light.restaurarPreferenciaAposPararDoAUTO(slot);
  assert.equal(res, 'adiado');
  assert.equal(state.cliques.includes('hunt-eco'), false, 'nao clicou em #hunt-eco');
  assert.equal(slot.prefsEconomiaPendente.economia, true, 'a pendencia continua guardada');
});

test('botao que nao age e tratado como falha (o fallback assume)', async () => {
  // botao presente, mas o clique nao muda nada: o launcher nao pode
  // acreditar que saiu do Economia.
  const { wc, win, state } = fakeWebContents();
  const botoes = win.document.querySelector('#eco-sair');
  botoes.click = () => {
    state.cliques.push('eco-sair');
  };
  const slot = fakeSlot(wc);
  const light = new LightMode();
  state.classes.add('modo-economia');
  win.localStorage.setItem('cfg-economia', '1');

  const res = await light.enable(slot);
  assert.equal(res.ok, true);
  assert.equal(res.motivo, 'fallback-reload', 'sem efeito no clique, o ultimo recurso assume');
  assert.equal(state.reloads, 1);
  assert.equal(slot.prefsEconomiaDoUsuario.economia, true, 'a preferencia continua guardada');
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

// ---- Fase 12: a invariante do P2 em cima do modo leve ----

test('modoLeveAtivo/saidaPermitida: P2 armado conta como posse e proibe a saida', () => {
  assert.equal(modoLeveAtivo(null), false);
  assert.equal(modoLeveAtivo({}), false);
  assert.equal(modoLeveAtivo({ lightMode: true }), true);
  assert.equal(modoLeveAtivo({ p2Armado: true }), true);
  assert.equal(saidaPermitida({ lightMode: true }), true);
  assert.equal(saidaPermitida({ p2Armado: true }), false);
});

test('com o P2 armado o modo leve (P1) nao liga: os dois se excluem', async () => {
  const { wc, state } = fakeWebContents();
  const slot = fakeSlot(wc, { p2Armado: true });
  const light = new LightMode();
  state.classes.add('modo-economia');

  const res = await light.enable(slot);
  assert.deepEqual(res, { ok: false, motivo: 'p2-armado' });
  assert.equal(slot.lightMode, false);
  assert.deepEqual(state.cliques, [], 'nem toca no jogo');
  assert.equal(state.css.size, 0);
});

test('com o P2 armado a vigia NAO clica a saida do Economia', async () => {
  const { wc, state } = fakeWebContents();
  const slot = fakeSlot(wc, { p2Armado: true });
  const light = new LightMode();
  state.classes.add('modo-economia');
  const res = await light.watch(slot);
  assert.equal(res, 'economia', 'so relata o estado, sem efeito');
  assert.deepEqual(state.cliques, [], 'o jogo fica no Economia por invariante');
});

test('com o P2 armado o sync nao clica e nao aplica o CSS do P1', async () => {
  const { wc, state } = fakeWebContents();
  const slot = fakeSlot(wc, { p2Armado: true });
  const light = new LightMode();
  state.classes.add('modo-economia');
  await light.sync(slot);
  assert.deepEqual(state.cliques, []);
  assert.equal(state.reloads, 0);
  // O P2 nao precisa do CSS/rAF (o jogo ja esta no Economia). Aplicar aqui
  // deixaria o CSS orfao depois do desarme.
  assert.equal(slot.lightApplied, false, 'o CSS do P1 nao pode ficar orfao');
  assert.equal(state.css.size, 0);
});

test('armar o P2 entre o portao e a fila do enable nao sai do Economia', async () => {
  const { wc, state } = fakeWebContents();
  const slot = fakeSlot(wc);
  const light = new LightMode();
  state.classes.add('modo-economia');
  // O portao de fora ve `p2Armado:false`; o arm acontece antes da tarefa rodar.
  const promessa = light.enable(slot);
  slot.p2Armado = true;
  const res = await promessa;
  assert.deepEqual(res, { ok: false, motivo: 'p2-armado' });
  assert.deepEqual(state.cliques, [], 'nenhum clique pode tirar o jogo do Economia');
  assert.equal(slot.lightMode, false);
});

test('com o P2 armado desligar o P1 nao restaura a preferencia', async () => {
  const { wc, state } = fakeWebContents();
  const slot = fakeSlot(wc, { lightMode: true, p2Armado: true });
  slot.prefsEconomiaDoUsuario = { economia: true, ultra: false };
  const light = new LightMode();
  const res = await light.disable(slot);
  assert.equal(res.restauracao, 'nada-a-restaurar');
  assert.deepEqual(state.cliques, [], 'nenhum caminho pode tirar o jogo do Economia');
});

test('a pendencia de restauracao espera o P2 desarmar', async () => {
  const { wc, state } = fakeWebContents();
  const slot = fakeSlot(wc, { lightMode: true, p2Armado: true });
  slot.prefsEconomiaPendente = { economia: true, ultra: false };
  const light = new LightMode();
  state.classes.add('modo-economia');
  assert.equal(await light.restaurarPreferenciaAposPararDoAUTO(slot), 'adiado');
  assert.deepEqual(state.cliques, []);
});
