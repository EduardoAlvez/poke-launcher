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
  assert.equal(ok.exitEconomy, true, 'sai do Modo Economia por padrao');
  assert.equal(sanitizeAutomation({ exitEconomy: false }).exitEconomy, false);
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

test('clickTarget dispara sequencia de ponteiro no canvas e click() em botoes', () => {
  const { clickTarget } = globalThis.PokeAutomation;
  const seen = [];
  const canvas = {
    tagName: 'CANVAS',
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 100, height: 50 }),
    dispatchEvent: (ev) => { seen.push(ev.type); return true; },
  };
  assert.equal(clickTarget(canvas, {}), true);
  assert.deepEqual(seen, ['pointermove', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);

  let clicked = false;
  const button = { tagName: 'BUTTON', click: () => { clicked = true; } };
  assert.equal(clickTarget(button, {}), true);
  assert.equal(clicked, true);
  assert.equal(clickTarget(null, {}), false);
});

test('isEconomy detecta o modo economia pelo seletor do pack', () => {
  const { isEconomy } = globalThis.PokeAutomation;
  const doc = { querySelector: (s) => (s === 'html.modo-economia' ? {} : null) };
  assert.equal(isEconomy(doc, { economySelector: 'html.modo-economia' }), true);
  assert.equal(isEconomy(doc, {}), false);
  assert.equal(isEconomy({ querySelector: () => null }, { economySelector: 'html.modo-economia' }), false);
});

test('captura desliga a automacao no main (markStopped)', async () => {
  const slot = { id: 'slot-1', automation: { enabled: true, consent: true, mode: 'until-catch' } };
  const sent = [];
  let persisted = 0;
  const controller = new AutomationController({
    getSlot: () => slot,
    getAllSlots: () => [slot],
    persist: async () => { persisted += 1; },
    sendToSlot: (id, payload) => sent.push([id, payload]),
    log: () => {},
  });
  controller.reportStatus('slot-1', { state: 'captured', running: false, throws: 5 });
  assert.equal(await controller.markStopped('slot-1', 'captured'), true);
  assert.equal(slot.automation.enabled, false);
  assert.equal(slot.automation.consent, false);
  assert.equal(slot.automationStatus.state, 'captured');
  assert.equal(sent.length, 1);
  assert.equal(sent[0][1].config.enabled, false);
  assert.equal(persisted, 1);
  assert.equal(await controller.markStopped('slot-1', 'captured'), false, 'idempotente');
});

test('heartbeat reporta ticks, ultimo tick e alvos', () => {
  const events = [];
  let tickFn = null;
  let beatFn = null;
  const doc = {
    body: { textContent: '' },
    defaultView: null,
    querySelector: () => ({ textContent: '', hidden: false, click: () => {} }),
    querySelectorAll: () => [{}, {}],
  };
  const win = {
    crypto: { getRandomValues: (arr) => { arr[0] = 1; return arr; } },
    setTimeout: (fn) => { tickFn = fn; return 1; },
    clearTimeout: () => {},
    setInterval: (fn) => { beatFn = fn; return 2; },
    clearInterval: () => {},
  };
  const handle = installAutomation({
    config: { enabled: true, mode: 'fixed', intervalMs: 500, jitterMs: 0, maxPerMin: 60 },
    pack: { clickCandidates: ['.x'], countSelector: '.x', pauseSelectors: [], pauseText: [] },
    emit: (e) => events.push(e),
    doc,
    win,
  });
  tickFn();
  assert.equal(handle.getTicks(), 1);
  const last = events.at(-1);
  assert.equal(last.ticks, 1);
  assert.equal(typeof last.lastTickAt, 'number');
  assert.equal(last.caidos, 2);
  beatFn();
  assert.equal(events.at(-1).ticks, 1);
  handle.stop();
});

test('isAccountTaken detecta o aviso de sessao tomada', () => {
  const { isAccountTaken } = globalThis.PokeAutomation;
  const sel = '#sessao-tomada:not(.hidden)';
  assert.equal(isAccountTaken({ querySelector: (s) => (s === sel ? {} : null) }, { accountTakenSelector: sel }), true);
  assert.equal(isAccountTaken({ querySelector: () => null }, { accountTakenSelector: sel }), false);
  assert.equal(isAccountTaken({ querySelector: () => ({}) }, {}), false);
});


test('sai do Modo Economia para lancar e volta ao parar', () => {
  let eco = true;
  let exits = 0;
  let enters = 0;
  const doc = {
    body: { textContent: '' },
    defaultView: null,
    querySelector: (sel) => {
      if (sel === 'html.modo-economia') return eco ? {} : null;
      if (sel === '#eco-sair') return eco ? { textContent: '', hidden: false, click: () => { eco = false; exits += 1; } } : null;
      if (sel === '.hunt-eco') return eco ? null : { textContent: '', hidden: false, click: () => { enters += 1; } };
      return null;
    },
  };
  const events = [];
  let tickFn = null;
  const win = {
    crypto: { getRandomValues: (arr) => { arr[0] = 1; return arr; } },
    setTimeout: (fn) => { tickFn = fn; return 1; },
    clearTimeout: () => {},
    setInterval: () => 2,
    clearInterval: () => {},
  };
  const handle = installAutomation({
    config: { enabled: true, exitEconomy: true, intervalMs: 500, jitterMs: 0, maxPerMin: 60 },
    pack: {
      clickCandidates: ['#caidos-lista .caido'],
      economySelector: 'html.modo-economia',
      economyExitSelector: '#eco-sair',
      economyEnterSelector: '.hunt-eco',
      pauseSelectors: [],
      pauseText: [],
    },
    emit: (e) => events.push(e),
    doc,
    win,
  });
  tickFn();
  assert.equal(exits, 1);
  assert.equal(eco, false);
  assert.equal(events.at(-1).state, 'exiting-economy');
  handle.stop('captured');
  assert.equal(enters, 1, 'volta ao Modo Economia ao parar');
});

test('exitEconomy=false nao mexe no Modo Economia', () => {
  let exits = 0;
  const doc = {
    body: { textContent: '' },
    defaultView: null,
    querySelector: (sel) => {
      if (sel === 'html.modo-economia') return {};
      if (sel === '#eco-sair') return { textContent: '', hidden: false, click: () => { exits += 1; } };
      return null;
    },
  };
  let tickFn = null;
  const win = {
    crypto: { getRandomValues: (arr) => { arr[0] = 1; return arr; } },
    setTimeout: (fn) => { tickFn = fn; return 1; },
    clearTimeout: () => {},
    setInterval: () => 2,
    clearInterval: () => {},
  };
  const events = [];
  const handle = installAutomation({
    config: { enabled: true, exitEconomy: false, intervalMs: 500, jitterMs: 0, maxPerMin: 60 },
    pack: { clickCandidates: ['.x'], economySelector: 'html.modo-economia', economyExitSelector: '#eco-sair', pauseSelectors: [], pauseText: [] },
    emit: (e) => events.push(e),
    doc,
    win,
  });
  tickFn();
  assert.equal(exits, 0);
  assert.equal(events.at(-1).state, 'economy-mode');
  handle.stop();
});

test('until-catch so para perto de um arremesso', async () => {
  let clicks = 0;
  const doc = {
    body: { textContent: '' },
    defaultView: null,
    querySelector: (selector) =>
      selector === '.caido' ? { textContent: '', hidden: false, click: () => { clicks += 1; } } : null,
  };
  const win = {
    crypto: { getRandomValues: (arr) => { arr[0] = 1; return arr; } },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
  };
  const estados = [];
  const handle = installAutomation({
    config: { enabled: true, mode: 'until-catch', intervalMs: 500, jitterMs: 0, maxPerMin: 60 },
    pack: { clickCandidates: ['.caido'], pauseSelectors: [], pauseText: [], stopOnRule: 'pokemon-caught' },
    emit: (evt) => estados.push(evt.state),
    doc,
    win,
  });
  assert.equal(handle.onRule('pokemon-caught'), false, 'sem arremesso recente nao para');
  assert.equal(handle.isRunning(), true);
  await new Promise((r) => setTimeout(r, 700));
  assert.ok(clicks > 0, `arremessou antes do evento (${clicks})`);
  assert.equal(handle.onRule('outra-regra'), false, 'regra que nao e a de captura nao para');
  assert.equal(handle.onRule('pokemon-caught'), true, 'parou logo apos o arremesso');
  assert.equal(handle.isRunning(), false);
  assert.equal(estados.at(-1), 'captured');
  handle.stop();
});

test('until-catch nao para com evento de captura atrasado', async () => {
  const doc = {
    body: { textContent: '' },
    defaultView: null,
    querySelector: () => null,
  };
  const win = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) };
  const handle = installAutomation({
    config: { enabled: true, mode: 'until-catch', intervalMs: 500, jitterMs: 0, maxPerMin: 60 },
    pack: { clickCandidates: ['.caido'], pauseSelectors: [], pauseText: [], stopOnRule: 'pokemon-caught' },
    emit: () => {},
    doc,
    win,
  });
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(handle.onRule('pokemon-caught'), false, 'nunca arremessou: nao ha captura nossa');
  handle.stop();
});
