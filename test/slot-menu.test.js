import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSlotMenu, ZOOM_STEPS } from '../src/main/slot-menu.js';

test('menu do chip reflete mudo e zoom e chama as acoes', () => {
  const chamadas = [];
  const slot = { id: 'slot-1', name: 'Conta 1', muted: true, zoomFactor: 1.25, eco: true, automation: { enabled: false } };
  const menu = buildSlotMenu(slot, {
    onMute: (m) => chamadas.push(['mute', m]),
    onZoom: (z) => chamadas.push(['zoom', z]),
    onEco: (on) => chamadas.push(['eco', on]),
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

test('menu do chip alterna o modo eco', () => {
  const chamadas = [];
  const ligado = buildSlotMenu({ name: 'Conta', eco: true }, { onEco: (on) => chamadas.push(on) });
  const item = ligado.find((i) => i.label === 'Modo eco (reduz CPU)');
  assert.equal(item.type, 'checkbox');
  assert.equal(item.checked, true);
  item.click();
  assert.deepEqual(chamadas, [false]);

  const desligado = buildSlotMenu({ name: 'Conta' }, { onEco: (on) => chamadas.push(on) });
  const item2 = desligado.find((i) => i.label === 'Modo eco (reduz CPU)');
  assert.equal(item2.checked, false);
  item2.click();
  assert.deepEqual(chamadas, [false, true]);
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

test('menu oferece definir proxy e, com proxy, trocar e remover', () => {
  const chamadas = [];
  const semProxy = buildSlotMenu({ name: 'Conta 4' }, { onProxy: () => chamadas.push('definir') });
  const itemDefinir = semProxy.find((i) => i.label === 'Definir proxy…');
  assert.ok(itemDefinir);
  itemDefinir.click();
  assert.deepEqual(chamadas, ['definir']);
  assert.equal(semProxy.some((i) => i.label?.startsWith('Remover proxy')), false, 'sem proxy nao ha remover');

  const comProxy = buildSlotMenu(
    { name: 'Conta 4', proxy: 'socks5://1.2.3.4:1080', exitIp: '5.6.7.8' },
    { onProxy: () => chamadas.push('trocar'), onProxyClear: () => chamadas.push('remover') }
  );
  const itemTrocar = comProxy.find((i) => i.label === 'Trocar proxy…');
  assert.ok(itemTrocar);
  const itemRemover = comProxy.find((i) => i.label?.startsWith('Remover proxy'));
  assert.match(itemRemover.label, /5\.6\.7\.8/);
  itemTrocar.click();
  itemRemover.click();
  assert.deepEqual(chamadas, ['definir', 'trocar', 'remover']);
});
