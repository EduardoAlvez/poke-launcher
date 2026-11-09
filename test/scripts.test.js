import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scriptAppliesTo,
  scriptsForSlot,
  scopeSummary,
  newScriptId,
  injectScripts,
  hostAllowed,
} from '../src/main/scripts.js';

const base = { id: 'script-1', name: 'Leitor', code: 'console.log(1)', enabled: true, scope: { mode: 'all', slotIds: [] } };

function fakeWc({ url = 'https://pokeidle.io/app', destroy = false, pending = false } = {}) {
  const ran = [];
  return {
    isDestroyed: () => destroy,
    getURL: () => url,
    executeJavaScript: async (code) => {
      if (pending) return new Promise(() => {});
      if (code.includes('BOOM')) throw new Error('boom');
      ran.push(code);
    },
    ran,
  };
}

test('scriptAppliesTo respeita enabled e escopo', () => {
  assert.equal(scriptAppliesTo(base, 'slot-1'), true);
  assert.equal(scriptAppliesTo({ ...base, enabled: false }, 'slot-1'), false);
  assert.equal(scriptAppliesTo({ ...base, scope: { mode: 'slots', slotIds: ['slot-2'] } }, 'slot-1'), false);
  assert.equal(scriptAppliesTo({ ...base, scope: { mode: 'slots', slotIds: ['slot-1'] } }, 'slot-1'), true);
  assert.equal(scriptAppliesTo(null, 'slot-1'), false);
});

test('scriptsForSlot devolve so os que se aplicam', () => {
  const scripts = [
    base,
    { ...base, id: 'script-2', enabled: false },
    { ...base, id: 'script-3', scope: { mode: 'slots', slotIds: ['slot-2'] } },
  ];
  assert.deepEqual(scriptsForSlot(scripts, 'slot-1').map((s) => s.id), ['script-1']);
  assert.deepEqual(scriptsForSlot(scripts, 'slot-2').map((s) => s.id), ['script-1', 'script-3']);
  assert.deepEqual(scriptsForSlot(undefined, 'slot-1'), []);
});

test('scopeSummary descreve o alcance', () => {
  assert.equal(scopeSummary(base), 'todas as sessoes');
  assert.equal(scopeSummary({ scope: { mode: 'slots', slotIds: ['slot-1'] } }), '1 sessao');
  assert.equal(scopeSummary({ scope: { mode: 'slots', slotIds: ['slot-1', 'slot-2'] } }), '2 sessoes');
  assert.equal(scopeSummary({ scope: { mode: 'slots', slotIds: [] } }), '0 sessoes');
});

test('newScriptId gera ids aceitos pelo schema', () => {
  const id = newScriptId(123, 0);
  assert.match(id, /^script-[a-z0-9-]+$/i);
  assert.match(newScriptId(), /^script-/);
});

test('hostAllowed so aceita o host do slot (ou subdominio)', () => {
  assert.equal(hostAllowed('https://pokeidle.io/app', 'https://pokeidle.io/app'), true);
  assert.equal(hostAllowed('https://app.pokeidle.io/x', 'https://pokeidle.io/app'), true);
  assert.equal(hostAllowed('https://accounts.google.com/o/oauth2', 'https://pokeidle.io/app'), false);
  assert.equal(hostAllowed('file:///etc/passwd', 'https://pokeidle.io/app'), false);
  assert.equal(hostAllowed('https://pokeidle.io/app', null), true);
  assert.equal(hostAllowed('nao-e-url', 'https://pokeidle.io'), false);
});

test('injectScripts roda em ordem, ignora desligado e nao para no erro', async () => {
  const wc = fakeWc();
  const logs = [];
  const scripts = [
    { ...base, id: 'script-1', code: 'primeiro()' },
    { ...base, id: 'script-2', code: 'BOOM' },
    { ...base, id: 'script-3', code: 'terceiro()' },
    { ...base, id: 'script-4', code: 'desligado()', enabled: false },
  ];
  const res = await injectScripts(wc, scripts, 'slot-1', { log: (m) => logs.push(m), baseUrl: 'https://pokeidle.io/app' });
  assert.deepEqual(res.ran, ['script-1', 'script-3']);
  assert.deepEqual(res.failed, ['script-2']);
  assert.deepEqual(
    wc.ran.map((code) => code.split('\n')[0]),
    ['primeiro()', 'terceiro()']
  );
  assert.match(logs.join('\n'), /script-2.*boom/);
});

test('injectScripts nao roda fora do host do slot, nem em wc destruido', async () => {
  const file = fakeWc({ url: 'file:///etc/passwd' });
  assert.deepEqual(await injectScripts(file, [base], 'slot-1', { log: () => {} }), { ran: [], failed: [] });
  assert.deepEqual(file.ran, []);

  const oauth = fakeWc({ url: 'https://accounts.google.com/o/oauth2' });
  assert.deepEqual(
    await injectScripts(oauth, [base], 'slot-1', { log: () => {}, baseUrl: 'https://pokeidle.io/app' }),
    { ran: [], failed: [] }
  );
  assert.deepEqual(oauth.ran, []);

  const dead = fakeWc({ destroy: true });
  assert.deepEqual(await injectScripts(dead, [base], 'slot-1', { log: () => {} }), { ran: [], failed: [] });
});

test('script que nao resolve nao trava: estoura o timeout e marca falha', async () => {
  const wc = fakeWc({ pending: true });
  const logs = [];
  const res = await injectScripts(wc, [base], 'slot-1', { log: (m) => logs.push(m), timeoutMs: 20 });
  assert.deepEqual(res.ran, []);
  assert.deepEqual(res.failed, ['script-1']);
  assert.match(logs.join('\n'), /excedeu 20 ms/);
});

test('o codigo injetado descarta o valor de retorno (void 0)', async () => {
  const wc = fakeWc();
  await injectScripts(wc, [base], 'slot-1', { log: () => {} });
  assert.match(wc.ran[0], /;\s*\nvoid 0$/);
});
