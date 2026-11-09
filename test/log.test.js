import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openLog } from '../src/main/log.js';

test('log cria a pasta, grava e rotaciona por tamanho', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pokolog-'));
  const file = path.join(dir, 'sub', 'launcher.log');
  const log = openLog(file, { maxBytes: 120 });
  log.error('a'.repeat(60));
  log.error('b'.repeat(60));
  assert.equal(fs.existsSync(`${file}.1`), false, 'ainda nao passou do limite');
  log.error('c'.repeat(60));
  assert.equal(fs.existsSync(`${file}.1`), true, 'rotacionou');
  const atual = await fsp.readFile(file, 'utf8');
  assert.match(atual, /c{60}/);
  assert.equal(atual.includes('a'.repeat(60)), false, 'o arquivo atual comecou limpo');
  const anterior = await fsp.readFile(`${file}.1`, 'utf8');
  assert.match(anterior, /a{60}/);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('log nao lanca quando nao consegue gravar', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pokolog-'));
  const arquivo = path.join(dir, 'nao-e-pasta');
  await fsp.writeFile(arquivo, 'x', 'utf8');
  const log = openLog(path.join(arquivo, 'sub', 'launcher.log'));
  assert.doesNotThrow(() => log.error('sem pasta possivel'));
  assert.doesNotThrow(() => log.exception('falha', new Error('teste')));
  await fsp.rm(dir, { recursive: true, force: true });
});

test('formatArgs achata console.* em uma linha com stack', async () => {
  const { formatArgs } = await import('../src/main/log.js');
  const err = new Error('quebrou');
  assert.match(formatArgs(['[x]', 42, { a: 1 }, true]), /^\[x\] 42 \{"a":1\} true$/);
  assert.match(formatArgs([err]), /Error: quebrou/);
  assert.match(formatArgs([err]), /\n\s+at /);
  const circular = {};
  circular.self = circular;
  assert.equal(typeof formatArgs([circular]), 'string');
  assert.equal(formatArgs([]), '');
});
