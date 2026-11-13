import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RouteController, ROUTE_RISK_TEXT } from '../src/main/route.js';
import { createHuntState, loadWelcome, applyDelta } from '../src/main/hunt-report.js';
import '../src/shared/engine.js';
import '../src/shared/automation.js';
import '../src/shared/route.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const welcome = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'pokeidle-welcome.sample.json'), 'utf8'));

function estadoPronto() {
  const st = createHuntState();
  st.enabled = true;
  loadWelcome(st, welcome);
  return st;
}

function controllerFake(st) {
  const sent = [];
  const logs = [];
  const mudancas = [];
  const controller = new RouteController({
    getSlot: (id) => (id === 'slot-1' ? { id } : null),
    getHuntState: () => st,
    sendToSlot: (slotId, channel, payload) => sent.push([slotId, channel, payload]),
    log: (m) => logs.push(m),
    onChange: (slotId) => mudancas.push(slotId ?? null),
  });
  return { controller, sent, logs, mudancas };
}

test('a rota avisa QUAL sessao parou (para a preferencia poder voltar)', async () => {
  // A rota que para sozinha (sem bolas) tambem libera o campo: quem decide
  // a volta da preferencia de Economia/Ultra precisa saber qual sessao parou.
  const st = estadoPronto();
  st.balls = { 'ultra': 0 };
  const { controller, mudancas } = controllerFake(st);
  await controller.start('slot-1', { ackRisk: true, maxAlvos: 1 });
  mudancas.length = 0;
  controller.onHuntUpdate('slot-1', st);
  assert.ok(
    mudancas.includes('slot-1'),
    `o onChange precisa levar o slot (veio: ${JSON.stringify(mudancas)})`
  );
  assert.equal(controller.isActiveRunning('slot-1'), false, 'a rota parou por falta de bolas');
});

test('rota recusa sem ack de risco e sem dex lida', async () => {
  const { controller, sent } = controllerFake(estadoPronto());
  assert.equal((await controller.start('slot-1', { ackRisk: false })).ok, false);
  const semDex = controllerFake(null).controller;
  assert.match((await semDex.start('slot-1', { ackRisk: true })).error, /dex/);
  assert.equal(sent.length, 0);
});

test('start monta fila do fixture, envia route:config enxuto e vira running', async () => {
  const { controller, sent } = controllerFake(estadoPronto());
  const res = await controller.start('slot-1', { ackRisk: true, ordem: 'facil', maxAlvos: 2, levelCap: true });
  assert.equal(res.ok, true);
  assert.equal(res.targets, 2);
  const [slotId, channel, payload] = sent[0];
  assert.equal(slotId, 'slot-1');
  assert.equal(channel, 'route:config');
  assert.equal(payload.config.enabled, true);
  assert.equal(payload.config.currentHuntSlug, 'magma_magcargo');
  assert.deepEqual(Object.keys(payload.config.targets[0]).sort(), ['nome', 'pokeId', 'slug']);
  assert.equal(controller.isActiveRunning('slot-1'), true);
  const pub = controller.publicState('slot-1');
  assert.equal(pub.total, 2);
  assert.match(ROUTE_RISK_TEXT, /ban/i);
});

test('confirmacao so vem do delta real da dex; captura avanca e re-baselineia', async () => {
  const st = estadoPronto();
  const { controller, sent } = controllerFake(st);
  await controller.start('slot-1', { ackRisk: true, maxAlvos: 2, levelCap: true });
  const alvoIndex0 = controller.publicState('slot-1');
  assert.equal(alvoIndex0.index, 0);
  const pokeId = 10; // facil nv1: caterpie primeiro
  sent.length = 0;
  controller.onHuntUpdate('slot-1', st); // nada mudou: nenhum comando
  assert.equal(sent.length, 0);
  st.dex[String(pokeId)] = { k: 1, c: 1, sv: 0, sc: 0 };
  controller.onHuntUpdate('slot-1', st);
  assert.deepEqual(sent[0], ['slot-1', 'route:cmd', { action: 'advance', currentHuntSlug: 'magma_magcargo' }]);
  assert.equal(controller.publicState('slot-1').captured, 1);
  sent.length = 0;
  controller.onHuntUpdate('slot-1', st); // c igual ao baseline: nao avanca de novo
  assert.equal(sent.length, 0);
});

test('a captura confirmada no frame real (estado aninhado) avanca a fila', async () => {
  const st = estadoPronto();
  const { controller, sent } = controllerFake(st);
  await controller.start('slot-1', { ackRisk: true, maxAlvos: 2, levelCap: true });
  const pokeId = controller.publicState('slot-1'); // so para garantir a fila montada
  assert.ok(pokeId);
  sent.length = 0;
  // Frame como o servidor manda: o parcial fica DENTRO de `estado`.
  applyDelta(st, { t: 'estado', estado: { dexMud: { 10: { k: 1, c: 1 } } } });
  controller.onHuntUpdate('slot-1', st);
  assert.deepEqual(sent[0], ['slot-1', 'route:cmd', { action: 'advance', currentHuntSlug: 'magma_magcargo' }]);
});

test('evento de captura confirma na hora e nao duplica quando a dex tambem chega', async () => {
  const st = estadoPronto();
  const { controller, sent } = controllerFake(st);
  await controller.start('slot-1', { ackRisk: true, maxAlvos: 2, levelCap: true });
  sent.length = 0;
  // Evento real do servidor: { k:'capturado', pokemon:{ speciesId } }.
  controller.onCapture('slot-1', { speciesId: 10, nome: 'Caterpie' });
  assert.deepEqual(sent[0], ['slot-1', 'route:cmd', { action: 'advance', currentHuntSlug: 'magma_magcargo' }]);
  assert.equal(controller.publicState('slot-1').captured, 1);
  // O delta da dex da MESMA captura nao pode pular outro alvo.
  sent.length = 0;
  applyDelta(st, { t: 'estado', estado: { dexMud: { 10: { k: 1, c: 1 } } } });
  controller.onHuntUpdate('slot-1', st);
  assert.equal(sent.length, 0, 'a mesma captura nao avanca duas vezes');
  // Captura de outra especie nao mexe na fila.
  controller.onCapture('slot-1', { speciesId: 999 });
  assert.equal(sent.length, 0);
});

test('huntSlug confirma chegada na area sem depender do ID principal do HUD', async () => {
  const st = estadoPronto();
  const { controller, sent } = controllerFake(st);
  await controller.start('slot-1', { ackRisk: true, maxAlvos: 1, levelCap: true });
  st.huntSlug = 'caterpie';
  controller.onHuntUpdate('slot-1', st);
  assert.deepEqual(sent[sent.length - 1], ['slot-1', 'route:cmd', { action: 'arrived', slug: 'caterpie' }]);
});

test('bolas zeradas param a rota; texto de pare chega a pagina', async () => {
  const st = estadoPronto();
  const { controller, sent } = controllerFake(st);
  await controller.start('slot-1', { ackRisk: true, maxAlvos: 3, levelCap: true });
  st.balls = { 1: 0, 4: 0 };
  controller.onHuntUpdate('slot-1', st);
  const last = sent[sent.length - 1];
  assert.deepEqual(last[1], 'route:cmd');
  assert.equal(last[2].action, 'stop');
  assert.equal(controller.isActiveRunning('slot-1'), false);
});

test('onStatus espelha index da pagina, re-baselineia e ignora index fora da fila', async () => {
  const st = estadoPronto();
  const { controller } = controllerFake(st);
  await controller.start('slot-1', { ackRisk: true, maxAlvos: 3, levelCap: true });
  controller.onStatus('slot-1', { type: 'route-status', running: true, index: 1, state: 'viajando', throws: 9, captured: 1 });
  const pub = controller.publicState('slot-1');
  assert.equal(pub.index, 1);
  assert.equal(pub.state, 'viajando');
  assert.equal(pub.throws, 9);
  assert.equal(pub.baselineC, undefined, 'baseline nao vaza no estado publico');
  controller.onStatus('slot-1', { index: 99, state: 'x'.repeat(50) });
  assert.equal(controller.publicState('slot-1').index, 1);
  assert.equal(controller.publicState('slot-1').state, 'viajando');
});

test('stop/stopAll/clear', async () => {
  const st = estadoPronto();
  const { controller, sent } = controllerFake(st);
  await controller.start('slot-1', { ackRisk: true, maxAlvos: 1, levelCap: true });
  assert.equal((await controller.stop('slot-1', 'manual')).ok, true);
  assert.equal(sent[sent.length - 1][2].action, 'stop');
  assert.equal((await controller.stop('slot-1')).ok, false);
  await controller.start('slot-1', { ackRisk: true, maxAlvos: 1, levelCap: true });
  await controller.stopAll();
  assert.equal(controller.isActiveRunning('slot-1'), false);
  controller.clear('slot-1');
  assert.equal(controller.publicState('slot-1'), null);
});

// ------- maquina in-page (src/shared/route.js) com DOM fake -------

let nowMs = 1000;
const advanceClock = (ms) => {
  nowMs += ms;
};
const now = () => nowMs;

function fakeWin({ stepMs = 0 } = {}) {
  const timers = [];
  let seq = 0;
  const ls = new Map();
  return {
    timers,
    localStorage: {
      getItem: (k) => (ls.has(k) ? ls.get(k) : null),
      setItem: (k, v) => ls.set(k, String(v)),
      _dump: () => Object.fromEntries(ls),
    },
    setTimeout: (fn) => {
      const id = ++seq;
      timers.push({ id, fn });
      return id;
    },
    clearTimeout: (id) => {
      const at = timers.findIndex((t) => t.id === id);
      if (at >= 0) timers.splice(at, 1);
    },
    flush: () => {
      const t = timers.shift();
      if (!t) return false;
      if (stepMs) advanceClock(stepMs);
      t.fn();
      return true;
    },
  };
}

function markerEl(nome) {
  const el = {
    tag: 'button',
    className: 'marcador',
    dataset: {},
    _clicks: 0,
    textContent: () => nome,
  };
  el.click = () => {
    el._clicks += 1;
  };
  return el;
}

function fakeDoc({ tabs, markersByTab, hudPokeId, caidos, mapaAberto: aberto = true, mapaNaoAbre = false, modoLista = false, gavetaFechada = false, fichaMovel = false, portaDeTroca = 0 }) {
  const mapaBtn = { textContent: 'Mapa', disabled: false, _clicks: 0, hidden: gavetaFechada };
  // layout movel: o Mapa mora na gaveta 'Menu'; o clique nela destapa o botao
  const gaveta = { textContent: 'Menu', dataset: { aba: 'menu' }, hidden: false, _clicks: 0 };
  gaveta.click = () => {
    gaveta._clicks += 1;
    mapaBtn.hidden = false;
  };
  mapaBtn.click = () => {
    mapaBtn._clicks += 1;
    if (!mapaNaoAbre) aberto = true;
  };
  let abaAtual = tabs[0];
  let emLista = modoLista;
  const mapaModoBts = {
    mapa: { className: 'mapa-modo-bt', dataset: { modo: 'mapa' }, _clicks: 0 },
    lista: { className: 'mapa-modo-bt', dataset: { modo: 'lista' }, _clicks: 0 },
  };
  mapaModoBts.mapa.click = () => {
    mapaModoBts.mapa._clicks += 1;
    emLista = false; // o jogo real: trocarModoMapa('mapa') tira o modo-lista
  };
  mapaModoBts.lista.click = () => {
    mapaModoBts.lista._clicks += 1;
    emLista = true;
  };
  const principal = {
    className: emLista ? 'mapa-principal modo-lista' : 'mapa-principal',
    classList: {
      contains: (c) => emLista && c === 'modo-lista',
    },
  };
  const abas = tabs.map((t) => {
    const el = { dataset: { regiao: t }, className: '', _clicks: 0 };
    el.click = () => {
      el._clicks += 1;
      abaAtual = t;
    };
    return el;
  });
  const markers = {};
  for (const t of tabs)
    for (const slug of Object.keys(markersByTab))
      if (markersByTab[slug].tab === t) {
        const m = markerEl(slug);
        if (markersByTab[slug].capturado) m.className += ' capturado';
        markers[`${t}|${slug}`] = m;
      }
  // O jogo real fecha o modal ao viajar (bug do fogo real 2026-11-10). No
  // movel o toque no marcador so abre a ficha: "Cacar aqui" (.ha-cacar) e
  // quem viaja — e ele que fecha o modal. A porta de troca de hunt recusa
  // os primeiros cliques (o jogo so mostra toast; nem mapa fecha nem ficha).
  let fichaVisivel = false;
  let portaTentativas = portaDeTroca;
  const haCacar = { className: 'ha-cacar', disabled: false, _clicks: 0 };
  haCacar.click = () => {
    if (portaTentativas > 0) portaTentativas -= 1;
    else {
      aberto = false;
      fichaVisivel = false;
    }
    haCacar._clicks += 1;
  };
  for (const mk of Object.values(markers)) {
    const antes = mk.click;
    mk.click = () => {
      // no movel o toque no marcador so abre a ficha: a porta de troca nao o
      // trava — quem cai na porta e o botao da ficha
      if (!fichaMovel && portaTentativas > 0) portaTentativas -= 1;
      else if (fichaMovel) fichaVisivel = true;
      else aberto = false;
      antes();
    };
  }
  const hud = { dataset: { pokeId: hudPokeId } };
  const bola = { className: 'caidos-bola on' };
  bola.getAttribute = () => `Ultra Ball — você tem ${caidos?.bolas ?? 1547}`;
  const caido = { _clicks: 0, querySelector: () => ({ textContent: caidos?.nome || '' }) };
  caido.click = () => {
    caido._clicks += 1;
  };
  const doc = {
    defaultView: null,
    querySelector: (sel) => {
      if (sel === '.mapa-reg-bt.on') {
        // como o jogo real: mapa fechado deixa a aba .on ORFA no DOM, invisivel
        const el = abas.find((a) => a.dataset.regiao === abaAtual);
        if (el) {
          el.className = `mapa-reg-bt on${aberto ? '' : ' oculta'}`;
          el.hidden = !aberto;
        }
        return el || null;
      }
      if (sel === '#hud-hunt') return hud;
      if (sel === '#m-nav button[data-aba="menu"]') return gaveta;
      if (sel === '#mapa-principal') return principal;
      if (sel === '.ha-cacar') return fichaVisivel ? haCacar : null;
      const modo = /\.mapa-modo-bt\[data-modo="([^"]+)"\]/.exec(sel);
      if (modo) {
        const el = mapaModoBts[modo[1]] ?? null;
        if (el) el.hidden = !aberto;
        return el;
      }
      if (sel === '#caidos-bolas .caidos-bola.on') return bola;
      const m = /marcador\[data-slug="([^"]+)"\]/.exec(sel);
      if (m) {
        if (emLista) return null; // modo Lista real: nenhum marcador no DOM
        const el = markers[`${abaAtual}|${m[1]}`] ?? null;
        if (el) el.hidden = !aberto; // jogo fecha o mapa mas deixa o DOM montado
        return el;
      }
      return null;
    },
    querySelectorAll: (sel) => {
      if (sel === 'button,[role=button]') return [mapaBtn, gaveta];
      if (sel === '.mapa-reg-bt') return abas.map((a) => ((a.hidden = !aberto), a));
      if (sel === '#caidos-lista .caido') return caidos?.present ? [caido] : [];
      return [];
    },
    _probe: { mapaBtn, gaveta, abas, markers, hud, caido, bola, aberto: () => aberto, principal, mapaModoBts, emLista: () => emLista, haCacar, ficha: () => fichaVisivel },
  };
  return doc;
}

const PACK = {
  route: {
    tickMs: 300,
    travelTimeoutMs: 20000,
    mapLabel: 'Mapa',
    hud: '#hud-hunt',
    hudIdAttr: 'pokeId',
    caidoList: '#caidos-lista .caido',
    caidoNome: '.caido-quem',
    menuAba: '#m-nav button[data-aba="menu"]',
    btCacar: '.ha-cacar',
    mapaPrincipal: '#mapa-principal',
    modoListaClasse: 'modo-lista',
    btModoMapa: '.mapa-modo-bt[data-modo="mapa"]',
    btModoLista: '.mapa-modo-bt[data-modo="lista"]',
  },
};

test('maquina: aba errada -> troca, viaja, arremessa e para quando confirmam', () => {
  const doc = fakeDoc({
    tabs: ['kanto', 'outland'],
    markersByTab: { magma_magcargo: { tab: 'outland' } },
    hudPokeId: '10',
    caidos: { nome: 'Magma Magcargo Nv150', present: true },
  });
  const win = fakeWin();
  const emits = [];
  const api = globalThis.PokeRoute.installRoute({
    config: { enabled: true, targets: [{ pokeId: 2053, slug: 'magma_magcargo', nome: 'Magma Magcargo' }] },
    pack: PACK,
    emit: (e) => emits.push(e),
    doc,
    win,
    now,
  });
  const states = () => emits.filter((e) => e.type === 'route-status').map((e) => e.state);
  win.flush(); // kanto: sem marcador -> procura regiao
  win.flush(); // outland: marcador -> ficha
  win.flush(); // mapa fechou (o jogo viaja no clique) -> viajando
  assert.deepEqual(states(), ['partindo', 'procurando-regiao', 'ficha-hunt', 'viajando']);
  assert.equal(api.arrive('magma_magcargo'), true);
  win.flush(); // hunt: arremessa
  assert.ok(states().includes('arremessando'));
  assert.equal(doc._probe.caido._clicks, 1);
  assert.equal(api.advance('magma_magcargo'), true); // main confirmou por dexMud
  const ultimo = emits[emits.length - 1];
  assert.equal(ultimo.state, 'fila-completa');
  assert.equal(ultimo.running, false);
  assert.equal(api.isRunning(), false);
});

test('maquina: sem mapa aberto, clica o botao Mapa primeiro e so depois viaja', () => {
  const doc = fakeDoc({
    tabs: ['kanto'],
    markersByTab: { caterpie: { tab: 'kanto' } },
    hudPokeId: '99',
    caidos: { nome: 'Caterpie Nv1', present: true },
    mapaAberto: false,
  });
  const win = fakeWin();
  const emits = [];
  const api = globalThis.PokeRoute.installRoute({
    config: { enabled: true, targets: [{ pokeId: 10, slug: 'caterpie', nome: 'Caterpie' }] },
    pack: PACK,
    emit: (e) => emits.push(e),
    doc,
    win,
    now,
  });
  win.flush(); // sem mapa -> abre
  win.flush(); // marcador achado -> ficha
  win.flush(); // mapa fechou -> viajando
  assert.equal(api.arrive('caterpie'), true);
  win.flush(); // hunt -> arremessa
  const states = emits.map((e) => e.state);
  assert.ok(states.includes('abrindo-mapa'), states.join(','));
  assert.ok(states.includes('viajando'));
  assert.ok(states.includes('arremessando'));
  assert.equal(doc._probe.mapaBtn._clicks, 1);
  assert.equal(doc._probe.caido._clicks, 1);
});

test('maquina: mapa em modo Lista nao tem marcador — troca para o modo Mapa antes de viajar', () => {
  const doc = fakeDoc({
    tabs: ['kanto'],
    markersByTab: { caterpie: { tab: 'kanto' } },
    hudPokeId: '99',
    caidos: { nome: 'Caterpie Nv1', present: true },
    modoLista: true,
  });
  const win = fakeWin();
  const emits = [];
  const api = globalThis.PokeRoute.installRoute({
    config: { enabled: true, targets: [{ pokeId: 10, slug: 'caterpie', nome: 'Caterpie' }] },
    pack: PACK,
    emit: (e) => emits.push(e),
    doc,
    win,
    now,
  });
  const states = () => emits.filter((e) => e.type === 'route-status').map((e) => e.state);
  win.flush(); // mapa em Lista: troca o modo em vez de procurar marcador/aba
  assert.ok(states().includes('trocando-modo-mapa'), states().join(','));
  assert.equal(doc._probe.mapaModoBts.mapa._clicks, 1);
  assert.equal(doc._probe.emLista(), false);
  win.flush(); // trocando-modo-mapa
  win.flush(); // marcador achado -> ficha
  win.flush(); // mapa fechou -> viajando
  assert.ok(states().includes('viajando'), states().join(','));
  assert.equal(api.arrive('caterpie'), true);
  win.flush(); // hunt: arremessa
  assert.ok(states().includes('arremessando'), states().join(','));
  assert.equal(doc._probe.caido._clicks, 1);
});

test('maquina: layout movel — o Mapa mora na gaveta, abre o Menu antes', () => {
  const doc = fakeDoc({
    tabs: ['kanto'],
    markersByTab: { caterpie: { tab: 'kanto' } },
    hudPokeId: '99',
    caidos: { nome: 'Caterpie Nv1', present: true },
    mapaAberto: false,
    gavetaFechada: true,
  });
  const win = fakeWin();
  const emits = [];
  const api = globalThis.PokeRoute.installRoute({
    config: { enabled: true, targets: [{ pokeId: 10, slug: 'caterpie', nome: 'Caterpie' }] },
    pack: PACK,
    emit: (e) => emits.push(e),
    doc,
    win,
    now,
  });
  const states = () => emits.filter((e) => e.type === 'route-status').map((e) => e.state);
  win.flush(); // gaveta fechada: clica o Menu, o Mapa ainda esta escondido
  assert.ok(states().includes('abrindo-gaveta'), states().join(','));
  assert.equal(doc._probe.gaveta._clicks, 1);
  assert.equal(doc._probe.mapaBtn._clicks, 0);
  win.flush(); // gaveta aberta: agora clica o Mapa
  assert.equal(doc._probe.mapaBtn._clicks, 1);
  win.flush(); // marcador visivel -> ficha
  win.flush(); // mapa fechou -> viajando
  assert.ok(states().includes('viajando'), states().join(','));
  assert.equal(api.arrive('caterpie'), true);
});

test('maquina: fim da rota devolve o modo Lista do usuario', () => {
  const doc = fakeDoc({
    tabs: ['kanto'],
    markersByTab: { caterpie: { tab: 'kanto' } },
    hudPokeId: '99',
    caidos: { nome: 'Caterpie Nv1', present: true },
    modoLista: true,
  });
  const win = fakeWin();
  const emits = [];
  const api = globalThis.PokeRoute.installRoute({
    config: { enabled: true, targets: [{ pokeId: 10, slug: 'caterpie', nome: 'Caterpie' }] },
    pack: PACK,
    emit: (e) => emits.push(e),
    doc,
    win,
    now,
  });
  win.flush(); // trocando-modo-mapa
  win.flush(); // marcador -> ficha
  win.flush(); // mapa fechou -> viajando
  assert.equal(api.arrive('caterpie'), true);
  assert.equal(api.advance('caterpie'), true); // fila-completa -> finish
  const ultimo = emits[emits.length - 1];
  assert.equal(ultimo.state, 'fila-completa');
  // o mapa ja fechou ao viajar: a volta do modo Lista fica no localStorage
  assert.equal(win.localStorage.getItem('mapaModo'), 'lista', 'preferencia devolvida no localStorage');
  assert.equal(doc._probe.mapaModoBts.lista._clicks, 0, 'mapa fechado: nada a clicar');
});

test('maquina: chave de modo que nunca sai e fuga, nao laco', () => {
  const doc = fakeDoc({
    tabs: ['kanto'],
    markersByTab: {},
    hudPokeId: '99',
    caidos: { present: false },
    modoLista: true,
  });
  // o clique nao tira o modo-lista (o jogo ignoraria a chave)
  doc._probe.mapaModoBts.mapa.click = () => {
    doc._probe.mapaModoBts.mapa._clicks += 1;
  };
  const win = fakeWin();
  const emits = [];
  const api = globalThis.PokeRoute.installRoute({
    config: { enabled: true, targets: [{ pokeId: 10, slug: 'caterpie', nome: 'Caterpie' }] },
    pack: PACK,
    emit: (e) => emits.push(e),
    doc,
    win,
    now,
  });
  for (let n = 0; n < 40 && api.isRunning(); n += 1) win.flush();
  const states = emits.map((e) => e.state);
  assert.ok(states.includes('falha-modo-mapa'), states.join(','));
  assert.equal(api.isRunning(), false);
});

test('maquina: movel — toque no marcador abre a ficha; "Cacar aqui" e quem viaja', () => {
  const doc = fakeDoc({
    tabs: ['kanto'],
    markersByTab: { caterpie: { tab: 'kanto' } },
    hudPokeId: '99',
    caidos: { nome: 'Caterpie Nv1', present: true },
    fichaMovel: true,
  });
  const win = fakeWin();
  const emits = [];
  const api = globalThis.PokeRoute.installRoute({
    config: { enabled: true, targets: [{ pokeId: 10, slug: 'caterpie', nome: 'Caterpie' }] },
    pack: PACK,
    emit: (e) => emits.push(e),
    doc,
    win,
    now,
  });
  const states = () => emits.filter((e) => e.type === 'route-status').map((e) => e.state);
  win.flush(); // marcador -> ficha-hunt (o mapa fica aberto)
  assert.ok(states().includes('ficha-hunt'), states().join(','));
  assert.equal(doc._probe.aberto(), true, 'o toque no marcador so abriu a ficha');
  win.flush(); // "Cacar aqui" -> viajando (o jogo fecha o modal)
  assert.ok(states().includes('viajando'), states().join(','));
  assert.equal(doc._probe.haCacar._clicks, 1);
  assert.equal(doc._probe.aberto(), false);
  assert.equal(api.arrive('caterpie'), true);
  win.flush(); // hunt: arremessa
  assert.ok(states().includes('arremessando'), states().join(','));
  assert.equal(doc._probe.caido._clicks, 1);
});

test('maquina: ficha bloqueada por combate tenta o mesmo destino novamente', () => {
  nowMs = 1000;
  const doc = fakeDoc({
    tabs: ['kanto'],
    markersByTab: { caterpie: { tab: 'kanto' } },
    hudPokeId: '99',
    caidos: { present: false },
    fichaMovel: true,
  });
  doc._probe.haCacar.disabled = true; // hunt travada: o botao nao clica
  const win = fakeWin({ stepMs: 1200 });
  const emits = [];
  const api = globalThis.PokeRoute.installRoute({
    config: { enabled: true, targets: [{ pokeId: 10, slug: 'caterpie', nome: 'Caterpie' }] },
    pack: PACK,
    emit: (e) => emits.push(e),
    doc,
    win,
    now,
  });
  for (let n = 0; n < 40 && api.isRunning(); n += 1) win.flush();
  const states = emits.map((e) => e.state);
  assert.ok(states.includes('retentando-viagem'), states.join(','));
  assert.ok(doc._probe.markers['kanto|caterpie']._clicks >= 2, 'reattempts the same marker');
  assert.equal(api.getState().index, 0, 'keeps the current target');
  assert.equal(api.isRunning(), true, 'keeps running until arrival or manual stop');
});

test('maquina: porta de troca recusa o marcador — re-clique ate viajar', () => {
  nowMs = 1000;
  const doc = fakeDoc({
    tabs: ['kanto'],
    markersByTab: { caterpie: { tab: 'kanto' } },
    hudPokeId: '99',
    caidos: { present: false },
    portaDeTroca: 2,
  });
  const win = fakeWin({ stepMs: 1200 });
  const emits = [];
  const api = globalThis.PokeRoute.installRoute({
    config: { enabled: true, targets: [{ pokeId: 10, slug: 'caterpie', nome: 'Caterpie' }] },
    pack: PACK,
    emit: (e) => emits.push(e),
    doc,
    win,
    now,
  });
  for (let n = 0; n < 10 && !emits.some((e) => e.state === 'viajando'); n += 1) win.flush();
  const states = emits.map((e) => e.state);
  assert.ok(states.includes('viajando'), states.join(','));
  assert.ok(doc._probe.markers['kanto|caterpie']._clicks >= 3, 're-clicou o marcador ate a porta abrir');
  assert.equal(api.arrive('caterpie'), true);
  assert.equal(api.isRunning(), true);
});

test('maquina: porta recusa o botao da ficha — wait-hud volta e tenta de novo', () => {
  nowMs = 1000;
  const doc = fakeDoc({
    tabs: ['kanto'],
    markersByTab: { caterpie: { tab: 'kanto' } },
    hudPokeId: '99',
    caidos: { present: false },
    fichaMovel: true,
    portaDeTroca: 2,
  });
  const win = fakeWin({ stepMs: 1200 });
  const emits = [];
  const api = globalThis.PokeRoute.installRoute({
    config: { enabled: true, targets: [{ pokeId: 10, slug: 'caterpie', nome: 'Caterpie' }] },
    pack: PACK,
    emit: (e) => emits.push(e),
    doc,
    win,
    now,
  });
  for (let n = 0; n < 14 && !emits.some((e) => e.state === 'aguardando-chegada'); n += 1) win.flush();
  const states = emits.map((e) => e.state);
  assert.ok(states.includes('aguardando-chegada'), states.join(','));
  assert.equal(doc._probe.haCacar._clicks, 3, 're-clicou "Cacar aqui" ate a porta abrir');
  assert.equal(doc._probe.aberto(), false, 'o clique que viajou fechou o modal');
  assert.equal(api.arrive('caterpie'), true);
  assert.equal(api.isRunning(), true);
});

test('maquina: slug invalido nunca vira selector; sem alvos termina na hora', () => {
  const doc = fakeDoc({ tabs: ['kanto'], markersByTab: {}, hudPokeId: '1', caidos: { present: false }, mapaAberto: true });
  const win = fakeWin();
  const emits = [];
  const api = globalThis.PokeRoute.installRoute({
    config: { enabled: true, targets: [{ pokeId: 2, slug: 'x"], [data-y="p', nome: 'X' }] },
    pack: PACK,
    emit: (e) => emits.push(e),
    doc,
    win,
    now,
  });
  for (let n = 0; n < 40 && api.isRunning(); n += 1) win.flush();
  const states = emits.map((e) => e.state);
  assert.ok(states.includes('alvo-nao-localizado'), states.join(','));
  assert.equal(api.isRunning(), false);
  const vazio = globalThis.PokeRoute.installRoute({
    config: { enabled: true, targets: [] },
    pack: PACK,
    emit: (e) => emits.push(e),
    doc,
    win: fakeWin(),
    now,
  });
  assert.equal(vazio.isRunning(), false);
  assert.equal(emits[emits.length - 1].state, 'sem-alvos');
});

test('M1: advance do main entre ticks nao multiplica cadeias de timer', () => {
  nowMs = 1000;
  const doc = fakeDoc({
    tabs: ['kanto'],
    markersByTab: { a: { tab: 'kanto' }, b: { tab: 'kanto' } },
    hudPokeId: '1', // ja estou na area do alvo A
    caidos: { nome: 'A', present: true },
  });
  const win = fakeWin();
  const emits = [];
  const api = globalThis.PokeRoute.installRoute({
    config: { enabled: true, currentHuntSlug: 'a', targets: [
      { pokeId: 1, slug: 'a', nome: 'A' },
      { pokeId: 2, slug: 'b', nome: 'B' },
    ] },
    pack: PACK,
    emit: (e) => emits.push(e),
    doc,
    win,
    now,
  });
  win.flush(); // hunt A: um arremesso
  assert.ok(emits.map((e) => e.state).includes('arremessando'));
  assert.equal(win.timers.length, 1);
  api.advance('a'); // chega ENTRE ticks, com timer pendurado
  assert.equal(win.timers.length, 1, 'uma unica cadeia de tick apos advance');
  win.flush(); // B: marcador -> ficha
  win.flush(); // mapa fechou -> viajando
  assert.ok(emits.map((e) => e.state).includes('viajando'));
  assert.equal(win.timers.length, 1);
});

test('maquina: marcador .capturado nao pula especie faltante da mesma area', () => {
  nowMs = 1000;
  const doc = fakeDoc({
    tabs: ['kanto'],
    markersByTab: { drowzee: { tab: 'kanto', capturado: true } },
    hudPokeId: '99',
    caidos: { present: false },
  });
  const win = fakeWin();
  const emits = [];
  const api = globalThis.PokeRoute.installRoute({
    config: { enabled: true, targets: [{ pokeId: 96, slug: 'drowzee', nome: 'Drowzee' }] },
    pack: PACK,
    emit: (e) => emits.push(e),
    doc,
    win,
    now,
  });
  win.flush();
  assert.equal(doc._probe.markers['kanto|drowzee']._clicks, 1, 'viaja mesmo com o anel dourado');
  assert.equal(api.arrive('drowzee'), true);
  win.flush();
  const states = emits.map((e) => e.state);
  assert.equal(states.includes('skip-capturado'), false);
  assert.equal(api.getState().index, 0, 'mantem o alvo ate a captura exata');
  assert.equal(api.isRunning(), true);
});

test('maquina: captura varias especies da mesma area sem viajar de novo', () => {
  nowMs = 1000;
  const caidos = { nome: 'Primeiro', present: true };
  const doc = fakeDoc({
    tabs: ['kanto'],
    markersByTab: { mesma_area: { tab: 'kanto' } },
    hudPokeId: '99',
    caidos,
  });
  const win = fakeWin();
  const emits = [];
  const api = globalThis.PokeRoute.installRoute({
    config: { enabled: true, currentHuntSlug: 'mesma_area', targets: [
      { pokeId: 1, slug: 'mesma_area', nome: 'Primeiro' },
      { pokeId: 2, slug: 'mesma_area', nome: 'Segundo' },
    ] },
    pack: PACK,
    emit: (e) => emits.push(e),
    doc,
    win,
    now,
  });
  win.flush();
  assert.equal(doc._probe.caido._clicks, 1);
  caidos.nome = 'Segundo';
  assert.equal(api.advance('mesma_area'), true);
  assert.equal(api.getState().phase, 'hunt');
  win.flush();
  assert.equal(doc._probe.caido._clicks, 2);
  assert.equal(api.getState().index, 1);
  assert.equal(emits.some((e) => e.state === 'viajando'), false);
});

test('maquina: continua no alvo depois de dois minutos sem captura', () => {
  nowMs = 1000;
  const doc = fakeDoc({
    tabs: ['kanto'],
    markersByTab: { z: { tab: 'kanto' }, q: { tab: 'kanto' } },
    hudPokeId: '5',
    caidos: { nome: 'Z', present: true },
  });
  const win = fakeWin({ stepMs: 50_000 }); // cada tick "passa" 50 s
  const emits = [];
  const api = globalThis.PokeRoute.installRoute({
    config: { enabled: true, currentHuntSlug: 'z', targets: [
      { pokeId: 5, slug: 'z', nome: 'Z' },
      { pokeId: 6, slug: 'q', nome: 'Q' },
    ] },
    pack: PACK,
    emit: (e) => emits.push(e),
    doc,
    win,
    now,
  });
  for (let n = 0; n < 4; n += 1) win.flush(); // 200 s sem captura
  assert.equal(api.getState().index, 0, 'permanece no primeiro alvo');
  assert.equal(api.isRunning(), true, 'espera a confirmação em vez de pular');
  assert.equal(emits.some((e) => e.state === 'skip-tempo'), false);
});

test('maquina: chegada nao confirmada reabre o mapa e tenta o destino novamente', () => {
  nowMs = 1000;
  const doc = fakeDoc({
    tabs: ['kanto'],
    markersByTab: { z: { tab: 'kanto' }, q: { tab: 'kanto' } },
    hudPokeId: '99',
    caidos: { present: false },
  });
  const win = fakeWin({ stepMs: 10_000 });
  const emits = [];
  const api = globalThis.PokeRoute.installRoute({
    config: { enabled: true, targets: [
      { pokeId: 5, slug: 'z', nome: 'Z' },
      { pokeId: 6, slug: 'q', nome: 'Q' },
    ] },
    pack: PACK,
    emit: (e) => emits.push(e),
    doc,
    win,
    now,
  });
  for (let n = 0; n < 7 && api.isRunning(); n += 1) win.flush();
  const states = emits.map((e) => e.state);
  assert.ok(states.includes('retentando-viagem'), states.join(','));
  assert.ok(doc._probe.markers['kanto|z']._clicks >= 2, 'reopens and clicks the same destination again');
  assert.equal(api.getState().index, 0);
  assert.equal(api.isRunning(), true);
});

test('maquina: limite de arremessos para a rota no alvo sem pular', () => {
  nowMs = 1000;
  const doc = fakeDoc({
    tabs: ['kanto'],
    markersByTab: { z: { tab: 'kanto' }, q: { tab: 'kanto' } },
    hudPokeId: '5',
    caidos: { nome: 'Z', present: true },
  });
  const win = fakeWin();
  const emits = [];
  const api = globalThis.PokeRoute.installRoute({
    config: { enabled: true, maxBolas: 1, currentHuntSlug: 'z', targets: [
      { pokeId: 5, slug: 'z', nome: 'Z' },
      { pokeId: 6, slug: 'q', nome: 'Q' },
    ] },
    pack: PACK,
    emit: (e) => emits.push(e),
    doc,
    win,
    now,
  });
  win.flush(); // primeiro arremesso
  win.flush(); // o teto e atingido antes de tentar outro
  const final = emits[emits.length - 1];
  assert.equal(final.state, 'limite-arremessos');
  assert.equal(final.index, 0);
  assert.equal(final.running, false);
  assert.equal(api.getState().index, 0);
});

// O bug do primeiro fogo real (2026-11-10): o jogo fecha o mapa ao viajar mas
// deixa a ultima aba `.on` no DOM. mapaAberto() que so olha presenca achava
// que o mapa estava aberto, nunca reabria e travava em 'procurando-regiao'.
test('maquina: mapa fechou com aba .on ORFA -> reabre sozinho e segue (bug do fogo real)', () => {
  nowMs = 1000;
  const doc = fakeDoc({
    tabs: ['kanto', 'johto'],
    markersByTab: { a: { tab: 'kanto' }, b: { tab: 'johto' } },
    hudPokeId: '99',
    caidos: { nome: 'B', present: true },
  });
  const win = fakeWin();
  const emits = [];
  const api = globalThis.PokeRoute.installRoute({
    config: {
      enabled: true,
      targets: [
        { pokeId: 1, slug: 'a', nome: 'A' },
        { pokeId: 2, slug: 'b', nome: 'B' },
      ],
    },
    pack: PACK,
    emit: (e) => emits.push(e),
    doc,
    win,
    now,
  });
  win.flush(); // alvo A: marcador visivel -> ficha
  assert.equal(doc._probe.aberto(), false);
  assert.equal(api.arrive('a'), true);
  win.flush(); // hunt A -> avanca via advance do main
  api.advance('a');
  // alvo B esta em JOHTO, mapa fechou: precisa reabrir (bug o nos prendia aqui)
  for (let n = 0; n < 8; n += 1) win.flush();
  const states = emits.map((e) => e.state);
  assert.ok(states.includes('abrindo-mapa'), states.join(','));
  assert.ok(doc._probe.mapaBtn._clicks >= 1, 'clicou Mapa de novo');
  assert.ok(emits.some((e) => e.state === 'viajando' && e.index === 1), 'reabriu e selecionou o destino B');
  assert.equal(api.arrive('b'), true);
  for (let n = 0; n < 4; n += 1) win.flush();
  assert.ok(emits.some((e) => e.state === 'arremessando' && e.index === 1), 'chegou e arremessou no B');
  assert.equal(api.isRunning(), true);
});

test('maquina: sem conseguir abrir o mapa, para no alvo sem pular a fila', () => {
  nowMs = 1000;
  const doc = fakeDoc({
    tabs: ['kanto', 'johto'],
    markersByTab: { a: { tab: 'johto' } },
    hudPokeId: '99',
    caidos: { present: false },
    mapaAberto: false,
    mapaNaoAbre: true,
  });
  const win = fakeWin();
  const emits = [];
  const api = globalThis.PokeRoute.installRoute({
    config: { enabled: true, targets: [
      { pokeId: 1, slug: 'a', nome: 'A' },
      { pokeId: 2, slug: 'b', nome: 'B' },
    ] },
    pack: PACK,
    emit: (e) => emits.push(e),
    doc,
    win,
    now,
  });
  for (let n = 0; n < 60 && api.isRunning(); n += 1) win.flush();
  const states = emits.map((e) => e.state);
  assert.ok(states.includes('alvo-nao-localizado'), states.join(','));
  assert.equal(states.includes('skip-marcador'), false);
  const final = emits[emits.length - 1];
  assert.equal(final.index, 0);
  assert.equal(final.state, 'alvo-nao-localizado');
  assert.equal(api.isRunning(), false);
  assert.ok(doc._probe.mapaBtn._clicks < 60, 'nao clicou Mapa para sempre');
});

test('maquina: bolas zero no DOM param a rota na hora (espelho do welcome nao vale)', () => {
  nowMs = 1000;
  const doc = fakeDoc({
    tabs: ['kanto'],
    markersByTab: { a: { tab: 'kanto' } },
    hudPokeId: '1', // ja na area do alvo
    caidos: { nome: 'A', present: true, bolas: 0 },
  });
  const win = fakeWin();
  const emits = [];
  const api = globalThis.PokeRoute.installRoute({
    config: { enabled: true, currentHuntSlug: 'a', targets: [{ pokeId: 1, slug: 'a', nome: 'A' }] },
    pack: PACK,
    emit: (e) => emits.push(e),
    doc,
    win,
    now,
  });
  win.flush(); // hunt: le bolas do titulo da bola e ve 0 -> para tudo
  const ultimo = emits[emits.length - 1];
  assert.equal(ultimo.state, 'sem-bolas');
  assert.equal(ultimo.running, false);
  assert.equal(ultimo.balls, 0, 'status carrega o balls lido do DOM');
  assert.equal(doc._probe.caido._clicks, 0, 'nao gastou o ultimo arremesso');
  assert.equal(api.isRunning(), false);
});
