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
  assert.deepEqual(sent[0], ['slot-1', 'route:cmd', { action: 'advance' }]);
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
  assert.deepEqual(sent[0], ['slot-1', 'route:cmd', { action: 'advance' }]);
});

test('evento de captura confirma na hora e nao duplica quando a dex tambem chega', async () => {
  const st = estadoPronto();
  const { controller, sent } = controllerFake(st);
  await controller.start('slot-1', { ackRisk: true, maxAlvos: 2, levelCap: true });
  sent.length = 0;
  // Evento real do servidor: { k:'capturado', pokemon:{ speciesId } }.
  controller.onCapture('slot-1', { speciesId: 10, nome: 'Caterpie' });
  assert.deepEqual(sent[0], ['slot-1', 'route:cmd', { action: 'advance' }]);
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
  return {
    timers,
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

function fakeDoc({ tabs, markersByTab, hudPokeId, caidos, mapaAberto: aberto = true, fechaAoViajar = false, mapaNaoAbre = false }) {
  const mapaBtn = { textContent: 'Mapa', disabled: false, _clicks: 0 };
  mapaBtn.click = () => {
    mapaBtn._clicks += 1;
    if (!mapaNaoAbre) aberto = true;
  };
  let abaAtual = tabs[0];
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
      if (sel === '#caidos-bolas .caidos-bola.on') return bola;
      const m = /marcador\[data-slug="([^"]+)"\]/.exec(sel);
      if (m) {
        const el = markers[`${abaAtual}|${m[1]}`] ?? null;
        if (el) el.hidden = !aberto; // jogo fecha o mapa mas deixa o DOM montado
        return el;
      }
      return null;
    },
    querySelectorAll: (sel) => {
      if (sel === 'button,[role=button]') return [mapaBtn];
      if (sel === '.mapa-reg-bt') return abas.map((a) => ((a.hidden = !aberto), a));
      if (sel === '#caidos-lista .caido') return caidos?.present ? [caido] : [];
      return [];
    },
    _probe: { mapaBtn, abas, markers, hud, caido, bola, aberto: () => aberto },
  };
  if (fechaAoViajar) {
    // o jogo fecha o mapa ao escolher um destino: a maquina precisa reabrir
    for (const mk of Object.values(markers)) {
      const antes = mk.click;
      mk.click = () => {
        aberto = false;
        antes();
      };
    }
  }
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
  win.flush(); // outland: marcador -> viajando
  assert.deepEqual(states(), ['partindo', 'procurando-regiao', 'viajando']);
  doc._probe.hud.dataset.pokeId = '2053';
  win.flush(); // hunt: arremessa
  assert.ok(states().includes('arremessando'));
  assert.equal(doc._probe.caido._clicks, 1);
  assert.equal(api.advance(), true); // main confirmou por dexMud
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
  globalThis.PokeRoute.installRoute({
    config: { enabled: true, targets: [{ pokeId: 10, slug: 'caterpie', nome: 'Caterpie' }] },
    pack: PACK,
    emit: (e) => emits.push(e),
    doc,
    win,
    now,
  });
  win.flush(); // sem mapa -> abre
  win.flush(); // marcador achado -> viajando
  doc._probe.hud.dataset.pokeId = '10';
  win.flush(); // hunt -> arremessa
  const states = emits.map((e) => e.state);
  assert.ok(states.includes('abrindo-mapa'), states.join(','));
  assert.ok(states.includes('viajando'));
  assert.ok(states.includes('arremessando'));
  assert.equal(doc._probe.mapaBtn._clicks, 1);
  assert.equal(doc._probe.caido._clicks, 1);
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
  win.flush(); // hunt A: um arremesso
  assert.ok(emits.map((e) => e.state).includes('arremessando'));
  assert.equal(win.timers.length, 1);
  api.advance(); // chega ENTRE ticks, com timer pendurado
  assert.equal(win.timers.length, 1, 'uma unica cadeia de tick apos advance');
  win.flush(); // B: marcador -> viajando
  assert.ok(emits.map((e) => e.state).includes('viajando'));
  assert.equal(win.timers.length, 1);
});

test('maquina: marcador .capturado pula sem gastar viagem nem bola', () => {
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
  const states = emits.map((e) => e.state);
  assert.ok(states.includes('skip-capturado'), states.join(','));
  assert.equal(doc._probe.abas[0]._clicks, 0, 'nem trocou de aba');
  assert.equal(api.isRunning(), false);
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
  for (let n = 0; n < 4; n += 1) win.flush(); // 200 s sem captura
  assert.equal(api.getState().index, 0, 'permanece no primeiro alvo');
  assert.equal(api.isRunning(), true, 'espera a confirmação em vez de pular');
  assert.equal(emits.some((e) => e.state === 'skip-tempo'), false);
});

test('maquina: falha ao chegar para no alvo atual sem avançar', () => {
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
  for (let n = 0; n < 5 && api.isRunning(); n += 1) win.flush();
  const final = emits[emits.length - 1];
  assert.equal(final.state, 'falha-chegada');
  assert.equal(final.index, 0);
  assert.equal(final.running, false);
  assert.equal(api.getState().index, 0);
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
    config: { enabled: true, maxBolas: 1, targets: [
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
    fechaAoViajar: true,
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
  win.flush(); // alvo A: marcador visivel -> viajando (mapa fecha)
  assert.equal(doc._probe.aberto(), false);
  doc._probe.hud.dataset.pokeId = '1';
  win.flush(); // hunt A -> avanca via advance do main
  api.advance();
  // alvo B esta em JOHTO, mapa fechou: precisa reabrir (bug o nos prendia aqui)
  for (let n = 0; n < 8; n += 1) win.flush();
  const states = emits.map((e) => e.state);
  assert.ok(states.includes('abrindo-mapa'), states.join(','));
  assert.ok(doc._probe.mapaBtn._clicks >= 1, 'clicou Mapa de novo');
  assert.ok(emits.some((e) => e.state === 'viajando' && e.index === 1), 'reabriu e selecionou o destino B');
  doc._probe.hud.dataset.pokeId = '2';
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
    config: { enabled: true, targets: [{ pokeId: 1, slug: 'a', nome: 'A' }] },
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
