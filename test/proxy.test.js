import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProxy, proxyRules, proxyAuth } from '../src/main/proxy.js';

test('parseProxy aceita os esquemas suportados e normaliza', () => {
  for (const [entrada, esperado] of [
    ['http://1.2.3.4:8080', 'http://1.2.3.4:8080'],
    // A porta padrao do esquema some (o Chromium aplica a mesma); o host vem
    // em minusculas, como o parser de URL normaliza.
    [' https://Proxy.Exemplo.com:443 ', 'https://proxy.exemplo.com'],
    ['socks5://10.0.0.1:1080', 'socks5://10.0.0.1:1080'],
    ['http://user:pass@host:3128', 'http://user:pass@host:3128'],
    ['HTTP://Host:8080', 'http://host:8080'],
  ]) {
    const parsed = parseProxy(entrada);
    assert.equal(parsed.ok, true, entrada);
    assert.equal(parsed.proxy, esperado, entrada);
  }
});

test('parseProxy devolve null para vazio e mantem a saida sem proxy', () => {
  for (const vazio of [null, undefined, '', '   ']) {
    const parsed = parseProxy(vazio);
    assert.deepEqual(parsed, { ok: true, proxy: null });
  }
});

test('parseProxy recusa o que o Chromium nao entende', () => {
  for (const [entrada, parte] of [
    ['1.2.3.4:8080', 'comece com'],
    ['ftp://host:21', 'comece com'],
    ['ws://host:8080', 'comece com'],
    ['http://', 'proxy invalido'],
    ['http://:8080', 'proxy invalido'],
    // Porta fora de faixa o parser de URL ja rejeita antes do nosso guard.
    ['http://host:99999', 'proxy invalido'],
    ['http://host:abc', 'proxy invalido'],
    ['socks5://host', 'porta'],
    [42, 'texto'],
    ['http://ho st:8080', 'espacos'],
  ]) {
    const parsed = parseProxy(entrada);
    assert.equal(parsed.ok, false, String(entrada));
    assert.match(parsed.error, new RegExp(parte, 'i'), String(entrada));
  }
});

test('proxyRules tira as credenciais (o Chromium nao as usa em proxyRules)', () => {
  assert.equal(proxyRules('http://user:pass@host:3128'), 'http://host:3128');
  assert.equal(proxyRules('socks5://10.0.0.1:1080'), 'socks5://10.0.0.1:1080');
});

test('proxyAuth devolve as credenciais decodificadas para o evento login', () => {
  const auth = proxyAuth('http://us%40er:s3nh%3A@host:3128');
  assert.deepEqual(auth, { user: 'us@er', pass: 's3nh:' });
  assert.equal(proxyAuth('http://host:3128'), null);
  assert.equal(proxyAuth(null), null);
});

test('socks com credenciais parseia, mas o auth pode existir para proxy HTTP', () => {
  const parsed = parseProxy('socks5://user:pass@host:1080');
  assert.equal(parsed.ok, true);
  assert.deepEqual(proxyAuth(parsed.proxy), { user: 'user', pass: 'pass' });
});
