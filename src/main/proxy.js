/**
 * Proxy por sessao (opcional, por slot): cada particion do Electron tem a
 * propria `session`, entao `session.setProxy` isola o IP de saida por conta
 * sem tocar no resto do PC. Este modulo e puro para ser testavel sem
 * Electron: parseia o texto do usuario, normaliza e deriva as duas formas
 * que o Chromium precisa (`proxyRules` sem credenciais + credenciais para o
 * evento `login`).
 */
const ESQUEMAS = new Set(['http', 'https', 'socks', 'socks4', 'socks5']);
const PROXIES_MAX = 300;

function dentroPorta(porta) {
  if (porta === '') return true;
  if (!/^\d{1,5}$/.test(porta)) return false;
  const n = Number(porta);
  return n >= 1 && n <= 65535;
}

/**
 * Aceita `http(s)://` e `socks(4|5)://` com host e porta opcionais
 * (socks exige porta: o Chromium nao tem padrao confiavel para ela) e
 * credenciais `user:pass@` opcionais. Devolve a forma normalizada para
 * guardar no slots.json, ou erro explicavel.
 */
export function parseProxy(value) {
  if (value == null || value === '') return { ok: true, proxy: null };
  if (typeof value !== 'string') return { ok: false, error: 'proxy nao e texto' };
  const texto = value.trim();
  if (!texto) return { ok: true, proxy: null };
  if (texto.length > PROXIES_MAX) return { ok: false, error: `proxy passa de ${PROXIES_MAX} caracteres` };
  if (/\s/.test(texto)) return { ok: false, error: 'proxy nao pode ter espacos' };
  const semEsquema = /^(https?|socks[45]?):\/\//i.test(texto);
  if (!semEsquema) {
    return { ok: false, error: 'comece com http://, https:// ou socks5://' };
  }
  let url;
  try {
    url = new URL(texto);
  } catch {
    return { ok: false, error: 'proxy invalido' };
  }
  const esquema = url.protocol.replace(':', '').toLowerCase();
  if (!ESQUEMAS.has(esquema)) return { ok: false, error: `esquema ${esquema} nao suportado` };
  if (!url.hostname) return { ok: false, error: 'proxy sem host' };
  if (!dentroPorta(url.port)) return { ok: false, error: 'porta do proxy invalida' };
  if ((esquema === 'socks' || esquema === 'socks4' || esquema === 'socks5') && !url.port) {
    return { ok: false, error: 'socks precisa de porta (ex.: socks5://host:1080)' };
  }
  const auth = url.username ? `${url.username}${url.password ? `:${url.password}` : ''}@` : '';
  return { ok: true, proxy: `${esquema}://${auth}${url.hostname}${url.port ? `:${url.port}` : ''}` };
}

/** Regras para `session.setProxy`: SEM credenciais (o Chromium não as usa aqui). */
export function proxyRules(proxy) {
  if (!proxy) return '';
  const url = new URL(proxy);
  return `${url.protocol.replace(':', '')}://${url.hostname}${url.port ? `:${url.port}` : ''}`;
}

/** Credenciais para o evento `login` do app (proxies HTTP/HTTPS autenticados). */
export function proxyAuth(proxy) {
  if (!proxy) return null;
  let url;
  try {
    url = new URL(proxy);
  } catch {
    return null;
  }
  if (!url.username) return null;
  return { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password ?? '') };
}
