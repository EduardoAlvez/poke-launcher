import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDexHook, dexFlagExpr } from '../src/main/dex-hook.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const INJECT_SRC = await fs.readFile(path.join(root, 'src', 'dexhook', 'inject.js'), 'utf8');
const welcomeFixture = JSON.parse(
  await fs.readFile(path.join(here, 'fixtures', 'pokeidle-welcome.sample.json'), 'utf8')
);

function makeWindow({ flag = '1', economia = false } = {}) {
  const win = {};
  const posted = [];
  const sockets = [];
  const classes = new Set(economia ? ['modo-economia'] : []);
  win.document = {
    documentElement: { classList: { contains: (c) => classes.has(c) } },
  };
  win.localStorage = {
    getItem: (k) => (k === 'pokeLauncherDex' && flag === '1' ? '1' : null),
    setItem() {},
    removeItem() {},
  };
  win.location = { href: 'https://pokeidle.io/app', origin: 'https://pokeidle.io' };
  win.messageListeners = [];
  win.addEventListener = (type, cb) => {
    if (type === 'message') win.messageListeners.push(cb);
  };
  win.postMessage = (msg, origin) => posted.push({ msg, origin });
  class FakeWS {
    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      this.listeners = {};
      this.readyState = 1;
    }
    addEventListener(type, cb) {
      (this.listeners[type] = this.listeners[type] || []).push(cb);
      sockets.push(this);
    }
    emitMessage(data) {
      for (const cb of this.listeners.message || []) cb({ data });
    }
    send(data) {
      this.sent = this.sent || [];
      this.sent.push(data);
    }
  }
  FakeWS.CONNECTING = 0;
  FakeWS.OPEN = 1;
  FakeWS.CLOSING = 2;
  FakeWS.CLOSED = 3;
  win.WebSocket = FakeWS;
  win.FakeWS = FakeWS;
  const fire = (ev) => win.messageListeners.forEach((cb) => cb(ev));
  return { win, posted, sockets, fire, RealWS: FakeWS };
}

function installHook(env) {
  const fn = new Function('window', 'URL', INJECT_SRC);
  fn(env.win, URL);
}

test('buildDexHook copia os dois arquivos para fora do asar e o manifest e valido', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dexhook-'));
  const target = path.join(dir, 'dexhook');
  const out = await buildDexHook(target);
  const manifest = JSON.parse(await fs.readFile(path.join(out, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  const cs = manifest.content_scripts[0];
  assert.equal(cs.world, 'MAIN');
  assert.equal(cs.run_at, 'document_start');
  assert.ok(cs.matches.includes('https://pokeidle.io/*'));
  assert.ok(cs.matches.includes('https://*.pokeidle.io/*'));
  // o inject copiado e o que roda: mesmo byte-length do fonte
  const inject = await fs.readFile(path.join(out, 'inject.js'), 'utf8');
  assert.equal(inject, INJECT_SRC);
  await fs.rm(dir, { recursive: true, force: true });
});

test('dexFlagExpr set/remove no localStorage', () => {
  assert.match(dexFlagExpr(true), /setItem\('pokeLauncherDex', '1'\)/);
  assert.match(dexFlagExpr(false), /removeItem\('pokeLauncherDex'\)/);
});

test('sem opt-in (flag off): hook e zero — WebSocket nao e embrulado', () => {
  const env = makeWindow({ flag: '0' });
  installHook(env);
  assert.equal(env.win.WebSocket, env.RealWS);
  assert.equal(env.posted.length, 0);
});

test('com opt-in, o WebSocket do jogo e embrulado e o welcome chega na ponte isolada', () => {
  const env = makeWindow({ flag: '1' });
  installHook(env);
  assert.notEqual(env.win.WebSocket, env.RealWS);
  assert.equal(env.win.__pokeLauncherDexHook.installed, true);
  const ready = env.posted.find((p) => p.msg.t === 'ready');
  assert.ok(ready, 'anuncia ready ao instalar');
  const socket = new env.win.WebSocket('wss://pokeidle.io/socket');
  socket.emitMessage(JSON.stringify(welcomeFixture));
  const wel = env.posted.find((p) => p.msg.t === 'welcome');
  assert.ok(wel, 'welcome reencaminhado');
  assert.equal(wel.msg.data.t, 'welcome');
  assert.equal(wel.origin, 'https://pokeidle.io');
  // o marcador de diagnostico prova que o hook VIU o frame (e nao so instalou)
  assert.equal(env.win.__pokeLauncherDexHook.welcome, true);
  assert.equal(env.win.__pokeLauncherDexHook.frames, 1);
});

test('so observa socket do proprio jogo; socket estranho passa batido', () => {
  const env = makeWindow({ flag: '1' });
  installHook(env);
  const foreign = new env.win.WebSocket('wss://evil.example.com/x');
  foreign.emitMessage(JSON.stringify({ t: 'welcome', hunt: 'plantar-fake' }));
  assert.equal(env.posted.filter((p) => p.msg.t === 'welcome').length, 0);
});

test('sufixo malicioso pokeidle.io.attacker.com NAO e aceito como jogo', () => {
  const env = makeWindow({ flag: '1' });
  installHook(env);
  const trick = new env.win.WebSocket('wss://pokeidle.io.attacker.com/ws');
  trick.emitMessage(JSON.stringify(welcomeFixture));
  assert.equal(env.posted.filter((p) => p.msg.t === 'welcome').length, 0, 'prefix-confusion rejeitada');
  // mas o subdominio legitimo e aceito
  const ok = new env.win.WebSocket('wss://app.pokeidle.io/ws');
  ok.emitMessage(JSON.stringify(welcomeFixture));
  assert.equal(env.posted.filter((p) => p.msg.t === 'welcome').length, 1);
});

test('welcome malicioso nao polui o prototype nem via ponte', () => {
  const env = makeWindow({ flag: '1' });
  installHook(env);
  const socket = new env.win.WebSocket('wss://pokeidle.io/s');
  socket.emitMessage('{"t":"welcome","estado":{"__proto__":{"polluted":1},"pokedex":{"10":{"k":1,"c":1}},"huntSlug":"a"},"hunts":[]}');
  const wel = env.posted.find((p) => p.msg.t === 'welcome');
  assert.ok(wel);
  assert.equal({}.polluted, undefined);
});

test('passivo: sem arm, o send do jogo passa intacto e nada e injetado', () => {
  const env = makeWindow({ flag: '1' });
  installHook(env);
  const socket = new env.win.WebSocket('wss://pokeidle.io/socket');
  const postedBefore = env.posted.length;
  socket.send(JSON.stringify({ t: 'cliente.economia', ativo: true }));
  assert.deepEqual(socket.sent, [JSON.stringify({ t: 'cliente.economia', ativo: true })]);
  socket.emitMessage('nao-json');
  socket.emitMessage('{"t":"chat","m":"oi"}');
  socket.emitMessage('x'.repeat(4_000_001));
  assert.equal(env.posted.length, postedBefore, 'so welcome/estado atravessam');
});

test('delta estado e reencaminhado; get replaya o ultimo welcome', () => {
  const env = makeWindow({ flag: '1' });
  installHook(env);
  const socket = new env.win.WebSocket('wss://pokeidle.io/socket');
  socket.emitMessage(JSON.stringify({ t: 'estado', dexMud: { 2053: { k: 1, c: 1 } } }));
  assert.ok(env.posted.find((p) => p.msg.t === 'estado'), 'delta estado passa');
  socket.emitMessage(JSON.stringify(welcomeFixture));
  env.fire({ source: env.win, data: { source: 'pokeLauncherDex', t: 'get' } });
  const replays = env.posted.filter((p) => p.msg.t === 'welcome');
  assert.equal(replays.length, 2, 'welcome original + replay do get');
  const ready = env.posted.filter((p) => p.msg.t === 'ready');
  assert.equal(ready[ready.length - 1].msg.data.replayed, true);
});

test('segunda instalacao nao embrula por cima (guarda __pokeLauncherDexHook)', () => {
  const env = makeWindow({ flag: '1' });
  installHook(env);
  const FirstHook = env.win.WebSocket;
  installHook(env);
  assert.equal(env.win.WebSocket, FirstHook);
});

test('evento de outra origem (frame estranho) nao dispara replay', () => {
  const env = makeWindow({ flag: '1' });
  installHook(env);
  const socket = new env.win.WebSocket('wss://pokeidle.io/socket');
  socket.emitMessage(JSON.stringify(welcomeFixture));
  const before = env.posted.filter((p) => p.msg.t === 'welcome').length;
  env.fire({ source: {}, data: { source: 'pokeLauncherDex', t: 'get' } });
  assert.equal(env.posted.filter((p) => p.msg.t === 'welcome').length, before, 'fonte errada ignorada');
});

// ---- Fase 12: o atuador do P2 no hook ----

const P2 = 'pokeLauncherP2';

function armar(env) {
  env.fire({
    source: env.win,
    data: { source: P2, t: 'p2cmd', data: { action: 'arm' } },
  });
}

function p2posts(env) {
  return env.posted.filter((p) => p.msg.source === P2 && p.msg.t === 'p2state').map((p) => p.msg.data);
}

test('p2: armar reabre o campo uma vez e avisa o main', () => {
  const env = makeWindow({ flag: '1' });
  installHook(env);
  const socket = new env.win.WebSocket('wss://pokeidle.io/socket');
  armar(env);
  assert.deepEqual(
    socket.sent.map((s) => JSON.parse(s)),
    [{ t: 'cliente.economia', ativo: false }],
    'o servidor precisa voltar a mandar o campo'
  );
  const estados = p2posts(env);
  assert.ok(estados.some((e) => e.kind === 'armado'), 'o main precisa saber que o arm chegou');
  // O hook anuncia o documento novo no canal do P2 (reconcilia arm fantasma).
  assert.equal(estados[0].kind, 'ready');
});

test('p2: armado, o cliente.economia do jogo vira ativo:false (fica no Economia)', () => {
  const env = makeWindow({ flag: '1' });
  installHook(env);
  const socket = new env.win.WebSocket('wss://pokeidle.io/socket');
  armar(env);
  socket.send(JSON.stringify({ t: 'cliente.economia', ativo: true }));
  const ultimo = JSON.parse(socket.sent.at(-1));
  assert.deepEqual(ultimo, { t: 'cliente.economia', ativo: false });
  // outras mensagens do jogo passam intactas
  const chat = JSON.stringify({ t: 'chat', m: 'oi' });
  socket.send(chat);
  assert.equal(socket.sent.at(-1), chat);
  // e desarmado volta a passar como veio
  env.fire({ source: env.win, data: { source: P2, t: 'p2cmd', data: { action: 'disarm' } } });
  socket.send(JSON.stringify({ t: 'cliente.economia', ativo: true }));
  assert.deepEqual(JSON.parse(socket.sent.at(-1)), { t: 'cliente.economia', ativo: true });
});

test('p2: arremesso so sai com o arm; comando sem arm vira erro', () => {
  const env = makeWindow({ flag: '1' });
  installHook(env);
  const socket = new env.win.WebSocket('wss://pokeidle.io/socket');
  env.fire({ source: env.win, data: { source: P2, t: 'p2cmd', data: { action: 'throw', slot: 7, ballId: 1 } } });
  assert.equal(socket.sent, undefined, 'sem arm, nada e enviado');
  assert.equal(p2posts(env).at(-1).kind, 'erro');

  armar(env);
  socket.sent = [];
  env.fire({ source: env.win, data: { source: P2, t: 'p2cmd', data: { action: 'throw', slot: 7, ballId: 4 } } });
  assert.deepEqual(JSON.parse(socket.sent.at(-1)), { t: 'ball.throw', ballId: 4, slot: 7 });
  // comando invalido nao vai para o socket
  socket.sent = [];
  env.fire({ source: env.win, data: { source: P2, t: 'p2cmd', data: { action: 'throw', slot: 'x' } } });
  assert.equal(socket.sent.length, 0);
});

test('p2: campo vira corpos com expiracao no relogio do SERVIDOR', () => {
  const env = makeWindow({ flag: '1' });
  installHook(env);
  const socket = new env.win.WebSocket('wss://pokeidle.io/socket');
  armar(env);
  const ts = Date.now();
  socket.emitMessage(
    JSON.stringify({
      t: 'campo',
      ts,
      mobs: [
        { s: 7, n: 'Mew', nv: 5, sh: false, x: true, xr: 4000 },
        { s: 8, n: 'Mewtwo', nv: 70, x: false },
      ],
      fora: [],
    })
  );
  const corpo = p2posts(env).at(-1);
  assert.equal(corpo.kind, 'corpos');
  const vivo = corpo.mobs.find((m) => m.s === 8);
  const morto = corpo.mobs.find((m) => m.s === 7);
  assert.equal(vivo.x, false);
  assert.equal(morto.x, true);
  // `xr` e relativo ao `ts` do servidor: o hook manda a VIDA RESTANTE para o
  // main nao ter que comparar relogios.
  assert.ok(Math.abs(morto.resta - 4000) < 5000, `resta ${morto.resta} vs 4000`);
  assert.equal(vivo.resta, null, 'sem xr nao ha prazo');
  // `fora` remove o mob do mapa (o proximo frame nao o traz de volta)
  socket.emitMessage(JSON.stringify({ t: 'campo', ts, mobs: [], fora: [7, 8] }));
  assert.deepEqual(p2posts(env).at(-1).mobs, []);
});

test('p2: desarmar desfaz a mentira do cliente.economia (se a pagina esta no Economia)', () => {
  const env = makeWindow({ flag: '1', economia: true });
  installHook(env);
  const socket = new env.win.WebSocket('wss://pokeidle.io/socket');
  armar(env);
  // O jogo avisa que esta no Economia; o hook mente para o campo continuar.
  socket.send(JSON.stringify({ t: 'cliente.economia', ativo: true }));
  assert.deepEqual(JSON.parse(socket.sent.at(-1)), { t: 'cliente.economia', ativo: false });
  env.fire({ source: env.win, data: { source: P2, t: 'p2cmd', data: { action: 'disarm' } } });
  // A verdade volta: o servidor para de mandar o campo de novo.
  assert.deepEqual(JSON.parse(socket.sent.at(-1)), { t: 'cliente.economia', ativo: true });
});

test('p2: desarmar fora do Economia nao inventa estado (nao mente ao servidor)', () => {
  const env = makeWindow({ flag: '1', economia: false });
  installHook(env);
  const socket = new env.win.WebSocket('wss://pokeidle.io/socket');
  armar(env);
  socket.send(JSON.stringify({ t: 'cliente.economia', ativo: true }));
  const antes = socket.sent.length;
  env.fire({ source: env.win, data: { source: P2, t: 'p2cmd', data: { action: 'disarm' } } });
  assert.equal(socket.sent.length, antes, 'so se desfaz a mentira que o hook contou');
});

test('p2: batalha confirma o arremesso e a captura', () => {
  const env = makeWindow({ flag: '1' });
  installHook(env);
  const socket = new env.win.WebSocket('wss://pokeidle.io/socket');
  armar(env);
  socket.emitMessage(
    JSON.stringify({
      t: 'batalha',
      ev: [
        { k: 'bola', slot: 7, sucesso: false, ballId: 1 },
        { k: 'capturado', slot: 7, pokemon: { speciesId: 150, nome: 'Mew', level: 5, shiny: true } },
        { k: 'ruido', slot: 7 },
      ],
    })
  );
  const kinds = p2posts(env).filter((p) => p.kind === 'bola' || p.kind === 'capturado');
  assert.deepEqual(kinds[0], { kind: 'bola', slot: 7, sucesso: false, ballId: 1 });
  assert.deepEqual(kinds[1], {
    kind: 'capturado',
    slot: 7,
    pokemon: { speciesId: 150, nome: 'Mew', level: 5, shiny: true },
  });
  // A captura tambem avisa o canal da dex (a fila "um por um" confirma por ai).
  const capturas = env.posted.filter((p) => p.msg.source === 'pokeLauncherDex' && p.msg.t === 'captura');
  assert.equal(capturas.length, 1);
  assert.deepEqual(capturas[0].msg.data, { speciesId: 150, nome: 'Mew', level: 5, shiny: true });
});
