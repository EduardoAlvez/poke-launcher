import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consumirBola, escolherBola, totalBolas } from '../src/shared/balls.js';
import {
  P2Controller,
  P2_RISK_TEXT,
  P2_INTERVALO_MIN_MS,
  planejarArremesso,
} from '../src/main/p2.js';

function slotFake(extra = {}) {
  const wc = { id: 1, isDestroyed: () => false };
  return {
    id: 'slot-1',
    lightMode: false,
    p2Armado: false,
    view: { webContents: wc },
    ...extra,
  };
}

function montar(extra = {}) {
  let relogio = 1_000_000;
  const enviados = [];
  const rollbacks = [];
  const notificacoes = [];
  const controller = new P2Controller({
    send: (slot, cmd) => enviados.push(cmd),
    onRollback: (slot, motivo, resumo) => rollbacks.push({ motivo, resumo }),
    notify: () => notificacoes.push(1),
    now: () => relogio,
    rand: () => 0,
    log: { info() {}, warn() {}, error() {} },
    ...extra,
  });
  return {
    controller,
    enviados,
    rollbacks,
    notificacoes,
    avancar: (ms) => {
      relogio += ms;
    },
    agora: () => relogio,
  };
}

const BOLAS = { 1: 10, 4: 2 };

test('bola: usa a mais fraca com estoque e desce para a proxima ao esgotar', () => {
  assert.equal(escolherBola(BOLAS), 1);
  assert.equal(escolherBola({ 4: 1 }), 4);
  assert.equal(escolherBola({}), null);
  assert.equal(escolherBola({ 9: 5 }), null);
  assert.equal(totalBolas(BOLAS), 12);
  let estoque = { 1: 1, 2: 1 };
  estoque = consumirBola(estoque, 1);
  assert.equal(escolherBola(estoque), 2);
  assert.deepEqual(BOLAS, { 1: 10, 4: 2 }, 'nao pode mutar o estoque recebido');
});

test('planejarArremesso: parado, pendente, limite e sem alvo', () => {
  assert.deepEqual(planejarArremesso(null, 0), { tipo: 'parado' });
  const base = {
    armado: true,
    pendente: null,
    limite: 5,
    gastas: 0,
    campoVisto: true,
    ultimoCampoEm: 1_000_000,
    proximoEm: 0,
    bolas: { 1: 5 },
    mobs: new Map([[7, { s: 7, x: true, expiraEm: 1_000_100 }]]),
  };
  assert.equal(planejarArremesso({ ...base, pendente: {} }, 1_000_000).tipo, 'esperar');
  assert.deepEqual(planejarArremesso({ ...base, gastas: 5 }, 1_000_000), { tipo: 'abortar', motivo: 'limite' });
  // O primeiro frame pode demorar: a carencia conta do ARM, nao do ultimo frame.
  const semCampo = { ...base, campoVisto: false, armadoEm: 1_000_000 };
  assert.notEqual(planejarArremesso(semCampo, 1_000_000).tipo, 'abortar');
  assert.deepEqual(planejarArremesso(semCampo, 1_000_000 + 9_000), {
    tipo: 'abortar',
    motivo: 'campo-parado',
  });
  // Campo velho tambem e campo parado (o servidor parou de mandar).
  assert.deepEqual(planejarArremesso(base, 1_000_000 + 9_000), { tipo: 'abortar', motivo: 'campo-parado' });
  // Entre os vivos, o alvo e o que expira antes.
  assert.deepEqual(
    planejarArremesso(
      {
        ...base,
        mobs: new Map([
          [7, { s: 7, x: true, expiraEm: 1_050_000 }],
          [8, { s: 8, x: true, expiraEm: 1_010_000 }],
        ]),
      },
      1_000_000
    ),
    { tipo: 'arremessar', slot: 8, ballId: 1 }
  );
  assert.deepEqual(
    planejarArremesso({ ...base, mobs: new Map([[7, { s: 7, x: false, expiraEm: 0 }]]) }, 1_000_000),
    { tipo: 'esperar', motivo: 'sem-alvo' }
  );
  // Morto mas ja expirado nao e alvo (o xr do servidor e o prazo).
  assert.deepEqual(
    planejarArremesso(
      { ...base, mobs: new Map([[7, { s: 7, x: true, expiraEm: 999_000 }]]) },
      1_000_000
    ),
    { tipo: 'esperar', motivo: 'sem-alvo' }
  );
  // Id de bola desconhecido para o motor (fail loud, nao chuta numero).
  assert.deepEqual(planejarArremesso({ ...base, bolas: { 9: 3 } }, 1_000_000), {
    tipo: 'abortar',
    motivo: 'bola-desconhecida',
  });
  assert.deepEqual(planejarArremesso({ ...base, bolas: {} }, 1_000_000), {
    tipo: 'abortar',
    motivo: 'sem-bolas',
  });
});

test('planejarArremesso: respeita o intervalo entre arremessos', () => {
  const run = {
    armado: true,
    pendente: null,
    limite: 5,
    gastas: 1,
    campoVisto: true,
    ultimoCampoEm: 1_000_000,
    proximoEm: 1_000_000 + P2_INTERVALO_MIN_MS,
    bolas: { 1: 5 },
    mobs: new Map([[7, { s: 7, x: true, expiraEm: 1_060_000 }]]),
  };
  assert.deepEqual(planejarArremesso(run, 1_000_000), { tipo: 'esperar', motivo: 'intervalo' });
  assert.deepEqual(planejarArremesso(run, 1_000_000 + P2_INTERVALO_MIN_MS), {
    tipo: 'arremessar',
    slot: 7,
    ballId: 1,
  });
});

test('armar exige consentimento, sessao livre (P1 desligado) e bolas no login', () => {
  const { controller } = montar();
  const slot = slotFake();
  assert.match(controller.armar(slot).error, /consentimento/);
  assert.match(controller.armar(slot, { consent: true, bolas: {} }).error, /bolas/);
  const slotLeve = slotFake({ lightMode: true });
  assert.match(
    controller.armar(slotLeve, { consent: true, bolas: BOLAS }).error,
    /modo leve/
  );
  assert.equal(slot.p2Armado, false);
  const ok = controller.armar(slot, { consent: true, bolas: BOLAS, maxBolas: 3 });
  assert.equal(ok.ok, true);
  assert.equal(ok.limite, 3);
  assert.equal(slot.p2Armado, true);
  assert.equal(controller.run(slot).limite, 3);
  assert.deepEqual(controller.publicState(slot), {
    armado: true,
    gastas: 0,
    capturas: 0,
    limite: 3,
    pendente: false,
  });
  // Armar de novo e idempotente (nao reinicia o orcamento).
  assert.equal(controller.armar(slot, { consent: true, bolas: BOLAS }).jaArmado, true);
  controller.desarmar(slot);
});

test('o relatorio do hook alimenta o motor sem confiar nos campos', () => {
  const { controller, enviados } = montar();
  const slot = slotFake();
  controller.armar(slot, { consent: true, bolas: BOLAS });
  assert.deepEqual(enviados[0], { action: 'arm' });

  // Sem campo, o tick NAO aborta de imediato: o servidor pode levar segundos
  // para reabrir o campo. A carencia e o que evita abortar no primeiro tick.
  controller.tick(slot);
  assert.equal(slot.p2Armado, true);

  const outro = slotFake();
  const segundo = montar();
  segundo.controller.armar(outro, { consent: true, bolas: BOLAS });
  segundo.controller.onReport(outro, {
    kind: 'corpos',
    mobs: [
      // `resta` e a vida restante no relogio do servidor (ms).
      { s: '7', x: true, resta: 5_000 },
      { s: 'lixo', x: true },
      null,
    ],
  });
  assert.equal(segundo.controller.run(outro).mobs.size, 1);
  segundo.controller.tick(outro);
  const arremesso = segundo.enviados.find((c) => c.action === 'throw');
  assert.deepEqual(arremesso, { action: 'throw', slot: 7, ballId: 1 });
  assert.equal(segundo.controller.run(outro).pendente.slot, 7);

  // Evento `bola` de outro slot nao fecha o pendente.
  segundo.controller.onReport(outro, { kind: 'bola', slot: 99, sucesso: true });
  assert.equal(segundo.controller.run(outro).pendente.slot, 7);
  // Nem um `bola` sem slot: fail closed (nao confirma nada).
  segundo.controller.onReport(outro, { kind: 'bola', sucesso: true });
  assert.equal(segundo.controller.run(outro).pendente.slot, 7);
  // Nem de outra bola.
  segundo.controller.onReport(outro, { kind: 'bola', slot: 7, ballId: 4, sucesso: true });
  assert.equal(segundo.controller.run(outro).pendente.slot, 7);
  segundo.controller.onReport(outro, { kind: 'bola', slot: 7, ballId: 1, sucesso: false });
  assert.equal(segundo.controller.run(outro).pendente, null);
  assert.equal(segundo.controller.run(outro).gastas, 1);
  // Bola consumida mesmo com o arremesso falho: o servidor recebeu o pedido.
  assert.equal(segundo.controller.run(outro).bolas[1], 9);

  segundo.controller.onReport(outro, { kind: 'capturado', slot: 7 });
  assert.equal(segundo.controller.run(outro).capturas, 1);
  segundo.controller.desarmar(outro);
});

test('ready do hook desarma o arm fantasma e o corpos de outro documento nao vale', () => {
  const { controller } = montar();
  const slot = slotFake();
  controller.armar(slot, { consent: true, bolas: BOLAS });
  // O documento trocou (wc id novo): o run nao pertence mais a ele.
  slot.view.webContents = { id: 2, isDestroyed: () => false };
  controller.onReport(slot, { kind: 'corpos', mobs: [{ s: 7, x: true, resta: 5_000 }] });
  assert.equal(slot.p2Armado, false);
  assert.equal(controller.run(slot), null);
});

test('arm fantasma: `ready` de documento novo desarma em vez de rearmar', () => {
  const { controller, rollbacks } = montar();
  const slot = slotFake();
  controller.armar(slot, { consent: true, bolas: BOLAS });
  controller.onReport(slot, { kind: 'ready', armado: false });
  assert.equal(slot.p2Armado, false);
  assert.equal(rollbacks.length, 1);
  assert.equal(rollbacks[0].motivo, 'hook-ressincronizado');
});

test('campo parado aborta e chama o rollback UMA vez', () => {
  const { controller, rollbacks, avancar } = montar();
  const slot = slotFake();
  controller.armar(slot, { consent: true, bolas: BOLAS });
  controller.onReport(slot, {
    kind: 'corpos',
    mobs: [{ s: 7, x: true, resta: 10_000 }],
  });
  avancar(9_000);
  controller.tick(slot);
  assert.equal(slot.p2Armado, false);
  assert.equal(rollbacks.length, 1);
  assert.equal(rollbacks[0].motivo, 'campo-parado');
  // Segundo tick depois do aborto nao pode chamar o rollback de novo.
  controller.tick(slot);
  assert.equal(rollbacks.length, 1);
});

test('se o arm nao chega ao hook, o slot nao fica armado (sem estado fantasma)', () => {
  const { controller } = montar({
    send: () => {
      throw new Error('view destruida');
    },
  });
  const slot = slotFake();
  const res = controller.armar(slot, { consent: true, bolas: BOLAS });
  assert.equal(res.ok, false);
  assert.match(res.error, /hook/);
  assert.equal(slot.p2Armado, false);
  assert.equal(controller.run(slot), null);
});

test('erro do hook aborta com rollback em vez de insistir num socket morto', () => {
  const { controller, rollbacks } = montar();
  const slot = slotFake();
  controller.armar(slot, { consent: true, bolas: BOLAS });
  controller.onReport(slot, { kind: 'erro', motivo: 'socket' });
  assert.equal(slot.p2Armado, false);
  assert.equal(rollbacks.length, 1);
  assert.match(rollbacks[0].motivo, /hook-erro:socket/);
});

test('bola sem ballId nao confirma o pendente (fail closed)', () => {
  const { controller, avancar, agora } = montar();
  const slot = slotFake();
  controller.armar(slot, { consent: true, bolas: BOLAS });
  controller.onReport(slot, { kind: 'corpos', mobs: [{ s: 7, x: true, resta: 5_000 }] });
  controller.tick(slot);
  assert.ok(controller.run(slot).pendente);
  controller.onReport(slot, { kind: 'bola', slot: 7, sucesso: true });
  assert.ok(controller.run(slot).pendente, 'sem ballId nao fecha o pendente');
  controller.onReport(slot, { kind: 'bola', slot: 7, ballId: 1, sucesso: true });
  assert.equal(controller.run(slot).pendente, null);
  assert.equal(controller.run(slot).gastas, 1);
});

test('abortar sem run nao chama o rollback (idempotente)', () => {
  const { controller, rollbacks } = montar();
  const slot = slotFake();
  controller.abortar(slot, 'motivo');
  assert.equal(rollbacks.length, 0);
  controller.armar(slot, { consent: true, bolas: BOLAS });
  controller.abortar(slot, 'campo-parado');
  controller.abortar(slot, 'campo-parado');
  assert.equal(rollbacks.length, 1, 'o rollback nao pode duplicar');
});

test('o rollback nao liga o modo leve nem mexe no jogo (a preferencia e do usuario)', () => {
  const { controller, rollbacks } = montar();
  const slot = slotFake();
  controller.armar(slot, { consent: true, bolas: BOLAS });
  controller.onReport(slot, { kind: 'erro', motivo: 'socket' });
  assert.equal(slot.p2Armado, false);
  assert.equal(slot.lightMode, false, 'o rollback nao pode ligar o P1 por conta propria');
  assert.equal(rollbacks.length, 1);
});

test('desarmar e idempotente e limpa o run', () => {
  const { controller, enviados } = montar();
  const slot = slotFake();
  controller.armar(slot, { consent: true, bolas: BOLAS });
  const primeiro = controller.desarmar(slot, 'pedido');
  assert.equal(primeiro.ok, true);
  assert.equal(controller.run(slot), null);
  assert.deepEqual(enviados.at(-1), { action: 'disarm' });
  assert.deepEqual(controller.desarmar(slot, 'pedido'), { ok: true, motivo: 'pedido', gastas: 0, capturas: 0 });
  assert.equal(enviados.filter((c) => c.action === 'disarm').length, 1);
});

test('o texto de risco nomeia a escrita no socket (nao promete so leitura)', () => {
  assert.match(P2_RISK_TEXT, /socket/);
  assert.match(P2_RISK_TEXT, /Termos de Uso/);
});

test('run orfao (flag do slot caiu no reload) nunca arremessa sozinho', () => {
  const { controller, enviados, rollbacks } = montar();
  const slot = slotFake();
  controller.armar(slot, { consent: true, bolas: BOLAS });
  controller.onReport(slot, { kind: 'corpos', mobs: [{ s: 7, x: true, expiraEm: 10_000_000 }] });
  // did-start-loading limpa o flag do slot, mas o timer do run ainda pode
  // disparar um tique: ele tem de morrer aqui, sem tocar no jogo.
  slot.p2Armado = false;
  enviados.length = 0;
  controller.tick(slot);
  assert.equal(enviados.some((c) => c.action === 'throw'), false);
  assert.equal(controller.run(slot), null);
  assert.equal(rollbacks.length, 0, 'documento novo nao e aborto: sem rollback');
});
