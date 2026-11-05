import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGameEvent, sanitizeText, Notifier, MAX_BODY_LEN } from '../src/main/notifications.js';

function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

test('parseGameEvent aceita evento bem formado', () => {
  const now = 1_700_000_000_000;
  const res = parseGameEvent({ type: 'pokemon-caught', title: 'Capturou', body: 'MrMime Comum', ts: now }, { now });
  assert.equal(res.ok, true);
  assert.equal(res.event.type, 'pokemon-caught');
  assert.equal(res.event.body, 'MrMime Comum');
});

test('parseGameEvent recusa payload hostil', () => {
  const now = 1_700_000_000_000;
  assert.equal(parseGameEvent(null, { now }).ok, false);
  assert.equal(parseGameEvent({ type: '', body: 'b', ts: now }, { now }).ok, false);
  assert.equal(parseGameEvent({ type: 'x'.repeat(50), body: 'b', ts: now }, { now }).ok, false);
  assert.equal(parseGameEvent({ type: 'pokemon caught!', body: 'b', ts: now }, { now }).ok, false);
  assert.equal(parseGameEvent({ type: 'ok', body: '', ts: now }, { now }).ok, false);
  assert.equal(parseGameEvent({ type: 'ok', body: 'b', ts: now - 60_000 }, { now }).ok, false);
  assert.equal(parseGameEvent({ type: 'ok', body: 'b', ts: now + 60_000 }, { now }).ok, false);
});

test('body e truncado e control chars removidos', () => {
  const now = 1_700_000_000_000;
  const res = parseGameEvent({ type: 'ok', body: `a\u0000b${'x'.repeat(500)}`, ts: now }, { now });
  assert.equal(res.ok, true);
  assert.ok(res.event.body.length <= MAX_BODY_LEN);
  assert.equal(res.event.body.includes('\u0000'), false);
});

test('sanitizeText normaliza espacos', () => {
  assert.equal(sanitizeText('  a \n b  ', 20), 'a b');
});

test('cooldown barra rajada: 100 eventos iguais -> 1 toast', () => {
  const clock = fakeClock();
  const shown = [];
  const notifier = new Notifier({ now: clock.now, cooldownMs: 2000, show: (e) => shown.push(e) });
  for (let i = 0; i < 100; i++) {
    notifier.notify('slot-1', { type: 'pokemon-caught', body: 'x', ts: clock.now() });
  }
  assert.equal(shown.length, 1);
  clock.advance(2100);
  notifier.notify('slot-1', { type: 'pokemon-caught', body: 'x', ts: clock.now() });
  assert.equal(shown.length, 2);
});

test('rate limit limita rajada entre tipos diferentes', () => {
  const clock = fakeClock();
  const shown = [];
  const notifier = new Notifier({
    now: clock.now,
    cooldownMs: 0,
    capacity: 3,
    refillPerMs: 0,
    show: (e) => shown.push(e),
  });
  for (let i = 0; i < 50; i++) {
    notifier.notify('slot-1', { type: `tipo-${i}`, body: 'x', ts: clock.now() });
  }
  assert.equal(shown.length, 3);
});

test('quiet hours suprime notificacoes', () => {
  const clock = fakeClock(new Date(2026, 0, 1, 23, 30).getTime());
  const shown = [];
  const notifier = new Notifier({
    now: clock.now,
    cooldownMs: 0,
    quietHours: { start: 23, end: 7 },
    show: (e) => shown.push(e),
  });
  const res = notifier.notify('slot-1', { type: 'x', body: 'y', ts: clock.now() });
  assert.equal(res.shown, false);
  assert.equal(res.reason, 'quiet-hours');
  assert.equal(shown.length, 0);
});

test('mute global silencia tudo', () => {
  const clock = fakeClock();
  const shown = [];
  const notifier = new Notifier({ now: clock.now, show: (e) => shown.push(e) });
  notifier.muted = true;
  notifier.notify('slot-1', { type: 'x', body: 'y', ts: clock.now() });
  assert.equal(shown.length, 0);
});
