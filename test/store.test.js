import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  parseState,
  parseSlot,
  parseAutomation,
  defaultState,
  SlotStore,
  sweepOrphanPartitions,
  clampZoom,
  SCHEMA_VERSION,
} from '../src/main/store.js';

const validSlot = {
  id: 'slot-1',
  name: 'Conta 1',
  url: 'https://pokeidle.io/app',
  partition: 'persist:slot-1',
  ratios: { x: 0, y: 0, w: 1, h: 1 },
  muted: false,
  zoomFactor: 1,
};

test('parseState aceita estado valido', () => {
  const res = parseState(JSON.stringify({ schemaVersion: SCHEMA_VERSION, maxSlots: 4, slots: [validSlot] }));
  assert.equal(res.ok, true);
  assert.equal(res.state.slots.length, 1);
  assert.equal(res.state.slots[0].name, 'Conta 1');
  assert.equal(res.state.maxSlots, 4);
});

test('maxSlots padrao e 8 e nunca fica abaixo das sessoes salvas', () => {
  const semLimite = parseState(JSON.stringify({ schemaVersion: SCHEMA_VERSION, slots: [validSlot] }));
  assert.equal(semLimite.state.maxSlots, 8, 'sem maxSlots no arquivo, o padrao e 8');

  const slots = ['1', '2', '3', '4', '5'].map((n) => ({
    ...validSlot,
    id: `slot-${n}`,
    partition: `persist:slot-${n}`,
  }));
  const apertado = parseState(JSON.stringify({ schemaVersion: SCHEMA_VERSION, maxSlots: 2, slots }));
  assert.equal(apertado.state.maxSlots, 5, 'restaurar nao pode descartar sessoes salvas');

  const gigante = parseState(JSON.stringify({ schemaVersion: SCHEMA_VERSION, maxSlots: 999, slots: [validSlot] }));
  assert.equal(gigante.state.maxSlots, 16, 'limite absurdo e contido');

  assert.equal(defaultState().maxSlots, 8);
});

test('parseState recusa json quebrado, versao nova, ids duplicados e partition errada', () => {
  assert.equal(parseState('{nao json').ok, false);
  assert.equal(parseState(JSON.stringify({ schemaVersion: 99, slots: [] })).ok, false);
  assert.equal(parseState(JSON.stringify({ schemaVersion: SCHEMA_VERSION, slots: 'x' })).ok, false);
  assert.equal(
    parseState(JSON.stringify({ schemaVersion: SCHEMA_VERSION, slots: [validSlot, validSlot] })).ok,
    false
  );
  assert.equal(
    parseState(
      JSON.stringify({ schemaVersion: SCHEMA_VERSION, slots: [{ ...validSlot, partition: 'persist:outro' }] })
    ).ok,
    false
  );
});

test('parseState recusa url nao http(s)', () => {
  const res = parseState(
    JSON.stringify({ schemaVersion: SCHEMA_VERSION, slots: [{ ...validSlot, url: 'file:///etc/passwd' }] })
  );
  assert.equal(res.ok, false);
});

test('parseSlot corta nome longo e zera ratios invalidos', () => {
  const res = parseSlot({ ...validSlot, name: 'x'.repeat(80), ratios: { x: 5, y: 0, w: 1, h: 1 } });
  assert.equal(res.ok, true);
  assert.equal(res.slot.name.length, 24);
  assert.equal(res.slot.ratios, null);
});

test('parseSlot: lightMode e por sessao e desligado por padrao', () => {
  assert.equal(parseSlot(validSlot).slot.lightMode, false);
  assert.equal(parseSlot({ ...validSlot, lightMode: true }).slot.lightMode, true);
  assert.equal(parseSlot({ ...validSlot, lightMode: 'sim' }).slot.lightMode, false);
});

test('automacao e opt-in: enabled so com consent', () => {
  assert.equal(parseAutomation(undefined).enabled, false);
  assert.equal(parseAutomation({ enabled: true }).enabled, false);
  assert.equal(parseAutomation({ enabled: true, consent: true }).enabled, true);
  assert.equal(parseAutomation({ enabled: true, consent: true, mode: 'until-catch' }).mode, 'until-catch');
});

test('automacao limita parametros absurdos', () => {
  const a = parseAutomation({ enabled: true, consent: true, intervalMs: 5, jitterMs: 99999, maxPerMin: 5000 });
  assert.equal(a.intervalMs, 500);
  assert.equal(a.jitterMs, 5000);
  assert.equal(a.maxPerMin, 60);
});

test('SlotStore: escrita atomica, backup e leitura', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pokestore-'));
  const file = path.join(dir, 'slots.json');
  const store = new SlotStore(file);
  const state = { ...defaultState(), slots: [validSlot] };
  await store.write(state);
  const read = await store.read();
  assert.equal(read.source, 'primary');
  assert.equal(read.state.slots[0].id, 'slot-1');
  await fs.rm(dir, { recursive: true, force: true });
});

test('SlotStore: corrupcao primaria cai no .bak', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pokestore-'));
  const file = path.join(dir, 'slots.json');
  const store = new SlotStore(file);
  await store.write({ ...defaultState(), slots: [validSlot] });
  await store.write({ ...defaultState(), slots: [validSlot, { ...validSlot, id: 'slot-2' }] });
  await fs.writeFile(file, '{quebrado', 'utf8');
  const read = await store.read();
  assert.equal(read.source, 'backup');
  assert.equal(read.state.slots.length, 1);
  assert.equal(read.warnings.length, 1);
  await fs.rm(dir, { recursive: true, force: true });
});

test('SlotStore: primaria e backup invalidos caem em defaults com aviso', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pokestore-'));
  const file = path.join(dir, 'slots.json');
  const store = new SlotStore(file);
  await fs.writeFile(file, '{lixo', 'utf8');
  await fs.writeFile(`${file}.bak`, '{tambem lixo', 'utf8');
  const read = await store.read();
  assert.equal(read.source, 'defaults');
  assert.equal(read.state.slots.length, 0);
  assert.equal(read.warnings.length, 1);
  await fs.rm(dir, { recursive: true, force: true });
});

test('sweepOrphanPartitions move particoes orfas para a quarentena', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pokopart-'));
  const trash = `${dir}-trash`;
  await fs.mkdir(path.join(dir, 'slot-1'), { recursive: true });
  await fs.mkdir(path.join(dir, 'slot-9'), { recursive: true });
  await fs.writeFile(path.join(dir, 'nao-e-pasta'), 'x');
  const res = await sweepOrphanPartitions(dir, ['persist:slot-1'], { log: () => {} });
  assert.deepEqual(res.removed, ['slot-9']);
  assert.deepEqual(res.kept, ['slot-1']);
  assert.deepEqual(res.failed, []);
  assert.equal(await fs.stat(path.join(dir, 'slot-1')).then(() => true), true);
  assert.equal(await fs.stat(path.join(dir, 'slot-9')).then(() => true, () => false), false, 'saiu das particoes');
  const guardadas = await fs.readdir(trash);
  assert.equal(guardadas.length, 1, 'a particao foi guardada, nao apagada');
  assert.ok(guardadas[0].startsWith('slot-9.'), 'nome guarda o slot e a data');
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(trash, { recursive: true, force: true });
});

test('quarentena expirada e apagada depois do prazo', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pokopart-'));
  const trash = `${dir}-trash`;
  const velha = path.join(trash, 'slot-9.2020-01-01T00-00-00-000Z');
  await fs.mkdir(velha, { recursive: true });
  const antiga = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
  await fs.utimes(velha, antiga, antiga);
  const res = await sweepOrphanPartitions(dir, [], { log: () => {} });
  assert.deepEqual(res.removed, []);
  assert.deepEqual(await fs.readdir(trash), []);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(trash, { recursive: true, force: true });
});

test('sweepOrphanPartitions tolera raiz inexistente', async () => {
  const res = await sweepOrphanPartitions(path.join(os.tmpdir(), 'nao-existe-pokolauncher'), [], { log: () => {} });
  assert.deepEqual(res.removed, []);
});

test('buildSnapshot persiste a automacao do slot vivo, nao a anterior', async () => {
  const { buildSnapshot } = await import('../src/main/store.js');
  const previous = {
    schemaVersion: 1,
    maxSlots: 2,
    slots: [{ id: 'slot-1', name: 'A', url: 'https://pokeidle.io/app', partition: 'persist:slot-1', automation: { enabled: true, consent: true, mode: 'fixed', intervalMs: 2000, jitterMs: 800, maxPerMin: 20 } }],
  };
  const live = [{ id: 'slot-1', name: 'A', url: 'https://pokeidle.io/app', automation: { enabled: false, consent: false, mode: 'fixed', intervalMs: 3000, jitterMs: 0, maxPerMin: 5 } }];
  const snap = buildSnapshot(previous, live);
  assert.equal(snap.slots[0].automation.enabled, false);
  assert.equal(snap.slots[0].automation.intervalMs, 3000);
  assert.equal(snap.slots[0].partition, 'persist:slot-1');
});

test('clampZoom prende entre 50% e 200% e ignora lixo', () => {
  assert.equal(clampZoom(1.5), 1.5);
  assert.equal(clampZoom(0.1), 0.5);
  assert.equal(clampZoom(9), 2);
  assert.equal(clampZoom(1.333), 1.33);
  assert.equal(clampZoom('x'), 1);
  assert.equal(clampZoom(NaN), 1);
});

test('sweep nao lanca quando a pasta de particoes esta inacessivel', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'poke-part-'));
  const partitionsRoot = path.join(dir, 'Partitions');
  await fs.writeFile(partitionsRoot, 'nao e pasta', 'utf8');
  const avisos = [];
  const res = await sweepOrphanPartitions(partitionsRoot, ['persist:slot-1'], {
    log: (m) => avisos.push(m),
  });
  assert.deepEqual(res.removed, []);
  assert.deepEqual(res.kept, []);
  assert.deepEqual(res.failed, ['Partitions']);
  assert.match(avisos.join('\n'), /ilegiveis/);
  await fs.rm(dir, { recursive: true, force: true });
});
