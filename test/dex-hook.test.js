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

function makeWindow({ flag = '1' } = {}) {
  const win = {};
  const posted = [];
  const sockets = [];
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
    }
    addEventListener(type, cb) {
      (this.listeners[type] = this.listeners[type] || []).push(cb);
      sockets.push(this);
    }
    emitMessage(data) {
      for (const cb of this.listeners.message || []) cb({ data });
    }
    send() {
      throw new Error('hook NAO pode escrever no socket');
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

test('so leitura: nada trafega para fora e payload nao-JSON ou gigante e ignorado', () => {
  const env = makeWindow({ flag: '1' });
  installHook(env);
  const socket = new env.win.WebSocket('wss://pokeidle.io/socket');
  const postedBefore = env.posted.length;
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
