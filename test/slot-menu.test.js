import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSlotMenu, ZOOM_STEPS } from '../src/main/slot-menu.js';

test('menu do chip reflete mudo e zoom e chama as acoes', () => {
  const chamadas = [];
  const slot = { id: 'slot-1', name: 'Conta 1', muted: true, zoomFactor: 1.25, automation: { enabled: false } };
  const menu = buildSlotMenu(slot, {
    onMute: (m) => chamadas.push(['mute', m]),
    onZoom: (z) => chamadas.push(['zoom', z]),
    onRename: () => chamadas.push(['rename']),
    onReset: () => chamadas.push(['reset']),
  });

  const mute = menu.find((i) => i.label === 'Silenciar');
  assert.equal(mute.type, 'checkbox');
  assert.equal(mute.checked, true);
  mute.click();
  assert.deepEqual(chamadas.at(-1), ['mute', false]);

  const zoom = menu.find((i) => i.label === 'Zoom');
  assert.equal(zoom.submenu.length, ZOOM_STEPS.length);
  const marcados = zoom.submenu.filter((i) => i.checked);
  assert.equal(marcados.length, 1, 'so um passo marcado');
  assert.equal(marcados[0].label, '125%');
  zoom.submenu[0].click();
  assert.deepEqual(chamadas.at(-1), ['zoom', 0.75]);

  menu.find((i) => i.label === 'Renomear…').click();
  assert.deepEqual(chamadas.at(-1), ['rename']);
  menu.find((i) => i.label?.startsWith('Reler login')).click();
  assert.deepEqual(chamadas.at(-1), ['reset']);
});

test('menu desabilita reler login com automacao ativa', () => {
  const menu = buildSlotMenu({ name: 'Conta 2', automation: { enabled: true } });
  const item = menu.find((i) => i.label?.startsWith('Reler login'));
  assert.equal(item.enabled, false);
  assert.match(item.label, /pare a automacao/);
  assert.doesNotThrow(() => item.click());
});

test('menu sem zoom definido marca 100%', () => {
  const menu = buildSlotMenu({ name: 'Conta 3' });
  const zoom = menu.find((i) => i.label === 'Zoom');
  assert.equal(zoom.submenu.filter((i) => i.checked).length, 1);
  assert.equal(zoom.submenu.find((i) => i.checked).label, '100%');
  const mute = menu.find((i) => i.label === 'Silenciar');
  assert.equal(mute.checked, false);
});
