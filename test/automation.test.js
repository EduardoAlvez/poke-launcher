import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AutomationController, canEnable, sanitizeAutomation, RISK_TEXT } from '../src/main/automation.js';
import '../src/shared/engine.js';
import '../src/shared/automation.js';

const { installAutomation, findFirst, isPaused } = globalThis.PokeAutomation;

function stubDoc({ buttons = [], bodyText = '', visible = new Set() } = {}) {
  return {
    body: { textContent: bodyText },
    defaultView: null,
    querySelector: (selector) => {
      const found = buttons.find((b) => b.selector === selector);
      if (!found) return null;
      return { ...found, hidden: visible.has(selector) };
    },
  };
}

test('sanitizeAutomation normaliza e exige consentimento para enabled', () => {
  const cfg = sanitizeAutomation({ enabled: true, consent: false, mode: 'fixed', intervalMs: 10, maxPerMin: 999 });
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.intervalMs, 500);
  assert.equal(cfg.maxPerMin, 60);
  const ok = sanitizeAutomation({ enabled: true, consent: true, mode: 'until-catch' });
  assert.equal(ok.enabled, true);
  assert.equal(ok.mode, 'until-catch');
});

test('canEnable exige consentimento explicito', () => {
  assert.equal(canEnable({ consent: true }), true);
  assert.equal(canEnable({ consent: false }), false);
  assert.equal(canEnable(undefined), false);
});

test('texto de risco menciona ban e ausencia de garantia', () => {
  assert.match(RISK_TEXT, /ban/i);
  assert.match(RISK_TEXT, /Termos/i);
  assert.match(RISK_TEXT, /nao promete/i);
});

test('controller recusa ativar sem consentimento', async () => {
  const slot = { id: 'slot-1', automation: null };
  const sent = [];
  const controller = new AutomationController({
    getSlot: () => slot,
    persist: async () => {},
    sendToSlot: (id, payload) => sent.push([id, payload]),
    log: () => {},
  });
  const res = await controller.setConfig('slot-1', { enabled: true, consent: false });
  assert.equal(res.ok, false);
  assert.equal(sent.length, 0);
});

test('controller ativa com consentimento e envia config para a sessao', async () => {
  const slot = { id: 'slot-1', automation: null };
  const sent = [];
  const controller = new AutomationController({
    getSlot: () => slot,
    persist: async () => {},
    sendToSlot: (id, payload) => sent.push([id, payload]),
    log: () => {},
  });
  const res = await controller.setConfig('slot-1', { enabled: true, consent: true, mode: 'fixed' });
  assert.equal(res.ok, true);
  assert.equal(slot.automation.enabled, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][1].config.enabled, true);
});

test('controller stopAll desliga todas as sessoes ativas', async () => {
  const slots = new Map([
    ['slot-1', { id: 'slot-1', automation: { enabled: true, consent: true, mode: 'fixed' } }],
    ['slot-2', { id: 'slot-2', automation: { enabled: true, consent: true, mode: 'until-catch' } }],
  ]);
  const sent = [];
  const controller = new AutomationController({
    getSlot: (id) => slots.get(id),
    getAllSlots: () => [...slots.values()],
    persist: async () => {},
    sendToSlot: (id, payload) => sent.push([id, payload]),
    log: () => {},
  });
  controller.reportStatus('slot-1', { state: 'clicking', running: true });
  controller.reportStatus('slot-2', { state: 'clicking', running: true });
  assert.deepEqual(controller.runningSlots().sort(), ['slot-1', 'slot-2']);
  await controller.stopAll();
  assert.equal(sent.length, 2);
  assert.equal(sent.every(([, p]) => p.config.enabled === false), true);
  assert.equal([...slots.values()].every((s) => s.automation.enabled === false), true);
});

test('findFirst devolve o primeiro botao visivel', () => {
  const doc = stubDoc({ buttons: [{ selector: '.campo-bola', textContent: '' }] });
  assert.ok(findFirst(doc, ['.campo-bola']));
  assert.equal(findFirst(doc, ['.inexistente']), null);
});

test('isPaused respeita seletores e texto', () => {
  const docSel = stubDoc({ buttons: [{ selector: '.capturas-painel:not(.hidden)' }] });
  assert.equal(isPaused(docSel, { pauseSelectors: ['.capturas-painel:not(.hidden)'] }), true);
  const docTxt = stubDoc({ bodyText: 'sem bolas' });
  assert.equal(isPaused(docTxt, { pauseText: ['sem bolas'] }), true);
  assert.equal(isPaused(stubDoc({}), { pauseText: ['sem bolas'] }), false);
});

test('automacao respeita limite por minuto', async () => {
  let clicks = 0;
  const button = { selector: '.campo-bola', textContent: '' };
  const doc = {
    body: { textContent: '' },
    defaultView: null,
    querySelector: (selector) => {
      if (selector !== '.campo-bola') return null;
      return { ...button, hidden: false, click: () => { clicks += 1; } };
    },
  };
  const win = {
    crypto: { getRandomValues: (arr) => { arr[0] = 1; return arr; } },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
  };
  const handle = installAutomation({
    config: { enabled: true, mode: 'fixed', intervalMs: 500, jitterMs: 0, maxPerMin: 2 },
    pack: { clickCandidates: ['.campo-bola'], pauseSelectors: [], pauseText: [] },
    emit: () => {},
    doc,
    win,
  });
  assert.equal(clicks, 0, 'nao clica imediatamente no start');
  await new Promise((r) => setTimeout(r, 2300));
  handle.stop();
  assert.ok(clicks >= 2, `clica no minimo 2 vezes (${clicks})`);
  assert.ok(clicks <= 3, `respeita o limite de 2/min (${clicks})`);
});

test('kill switch interrompe de fato o loop', async () => {
  let clicks = 0;
  const doc = {
    body: { textContent: '' },
    defaultView: null,
    querySelector: () => ({ textContent: '', hidden: false, click: () => { clicks += 1; } }),
  };
  const win = {
    crypto: { getRandomValues: (arr) => { arr[0] = 1; return arr; } },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
  };
  const handle = installAutomation({
    config: { enabled: true, mode: 'fixed', intervalMs: 500, jitterMs: 0, maxPerMin: 60 },
    pack: { clickCandidates: ['.campo-bola'], pauseSelectors: [], pauseText: [] },
    emit: () => {},
    doc,
    win,
  });
  await new Promise((r) => setTimeout(r, 1300));
  const before = clicks;
  handle.stop();
  assert.ok(before > 0, `loop clicou antes do stop (${before})`);
  assert.equal(handle.isRunning(), false);
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(clicks, before, 'nenhum clique apos o stop');
});

test('erro dentro do tick nao mata o loop', async () => {
  let attempts = 0;
  const doc = {
    body: { textContent: '' },
    defaultView: null,
    querySelector: () => {
      attempts += 1;
      if (attempts === 1) throw new Error('dom quebrado');
      return { textContent: '', hidden: false, click: () => {} };
    },
  };
  const win = {
    crypto: { getRandomValues: (arr) => { arr[0] = 1; return arr; } },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
  };
  const handle = installAutomation({
    config: { enabled: true, mode: 'fixed', intervalMs: 500, jitterMs: 0, maxPerMin: 60 },
    pack: { clickCandidates: ['.campo-bola'], pauseSelectors: [], pauseText: [] },
    emit: () => {},
    doc,
    win,
  });
  await new Promise((r) => setTimeout(r, 1200));
  handle.stop();
  assert.ok(attempts >= 2, `continuou apos o erro (${attempts})`);
});

test('pauseWithin limita a busca de texto e parseCount entende numeros', async () => {
  const { parseCount } = globalThis.PokeAddonEngine;
  assert.equal(parseCount('1.234'), 1234);
  assert.equal(parseCount('1.5'), 1.5);
  assert.equal(parseCount('12 bolas'), 12);
  assert.equal(parseCount('sem numero'), null);
  const doc = {
    body: { textContent: 'sem bolas' },
    defaultView: null,
    querySelector: () => null,
  };
  assert.equal(isPaused(doc, { pauseText: ['sem bolas'] }), true);
  assert.equal(isPaused(doc, { pauseText: ['sem bolas'], pauseWithin: '.nao-existe' }), true);
});
