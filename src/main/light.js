/**
 * Modo leve: mantém o campo chegando (o servidor só para de mandar `campo`
 * quando o jogo está em Economia/Ultra) e corta o custo de desenho por fora.
 *
 * O laço da cena reagenda a si mesmo pelo `requestAnimationFrame` global
 * (`campo.mjs`), então limitar o global a poucos quadros por segundo derruba o
 * CPU sem impedir que a lista de caídos continue sendo montada por timer.
 */

export const LIGHT_THROTTLE_MS = 300;
export const LIGHT_ECONOMY_KEY = 'cfg-economia';
export const LIGHT_ULTRA_KEY = 'cfg-ultra';

export const LIGHT_CSS = `
  /* A cena sai do desenho; o resto da tela (incluindo a lista de caídos) fica. */
  #cena { visibility: hidden !important; }
  #palco *, #palco *::before, #palco *::after { animation: none !important; transition: none !important; }
`;

export const LIGHT_APPLY = `(() => {
  const KEY = '__pokeLauncherLight';
  if (window[KEY]) return 'already';
  const real = window.requestAnimationFrame;
  const realCaf = window.cancelAnimationFrame;
  const handled = new Set();
  const wrapped = (cb) => {
    const id = setTimeout(() => {
      handled.delete(id);
      cb(performance.now());
    }, ${LIGHT_THROTTLE_MS});
    handled.add(id);
    return id;
  };
  const wrappedCaf = (id) => {
    if (handled.delete(id)) {
      clearTimeout(id);
      return;
    }
    if (typeof realCaf === 'function') realCaf.call(window, id);
  };
  window[KEY] = { real, realCaf, wrapped, wrappedCaf, handled };
  window.requestAnimationFrame = wrapped;
  window.cancelAnimationFrame = wrappedCaf;
  return 'applied';
})()`;

/**
 * Desfaz o patch. NÃO cancela os quadros pendentes: o laço da cena se
 * reagenda dentro do próprio callback, e descartar esse callback congelaria a
 * cena para sempre. O timeout que sobrou dispara, roda o callback e o laço
 * continua — agora pelo rAF de verdade.
 */
export const LIGHT_RESTORE = `(() => {
  const KEY = '__pokeLauncherLight';
  const state = window[KEY];
  if (!state) return 'absent';
  window.requestAnimationFrame = state.real;
  window.cancelAnimationFrame = state.realCaf;
  delete window[KEY];
  return 'restored';
})()`;

/** Refaz o patch do zero (a página trocou o rAF depois do nosso). */
export const LIGHT_REAPPLY = `(() => {
  const KEY = '__pokeLauncherLight';
  const state = window[KEY];
  if (state) {
    window.requestAnimationFrame = state.real;
    window.cancelAnimationFrame = state.realCaf;
    delete window[KEY];
  }
  return 'reset';
})()`;

export const LIGHT_VERIFY = `(() => {
  const state = window.__pokeLauncherLight;
  return !!state && window.requestAnimationFrame === state.wrapped && window.cancelAnimationFrame === state.wrappedCaf;
})()`;

/**
 * Vigia o modo do jogo em tempo de execução: se ele voltar para Economia/Ultra
 * (pelo menu dele), o servidor para de mandar `campo` e o AUTO fica sem alvo.
 * Sair pela cena é o caminho do próprio jogo — e ele avisa o servidor sozinho.
 */
export const LIGHT_WATCH = `(() => {
  const doc = window.document;
  const root = doc?.documentElement;
  const eco = !!root?.classList.contains('modo-economia');
  const ultra = !!root?.classList.contains('modo-ultra');
  if (eco) {
    const btn = doc.querySelector('#eco-sair');
    if (btn) {
      btn.click();
      return 'exit-economy';
    }
  }
  if (ultra) {
    const btn = doc.querySelector('#ultra-sair');
    if (btn) {
      btn.click();
      return 'exit-ultra';
    }
  }
  return eco || ultra ? 'still-economy' : 'ok';
})()`;

export const LIGHT_PREFS_ON = `(() => {
  try {
    return window.localStorage.getItem('${LIGHT_ECONOMY_KEY}') === '1' || window.localStorage.getItem('${LIGHT_ULTRA_KEY}') === '1';
  } catch {
    return false;
  }
})()`;

export const LIGHT_PREFS_OFF = `(() => {
  try {
    window.localStorage.setItem('${LIGHT_ECONOMY_KEY}', '0');
    window.localStorage.setItem('${LIGHT_ULTRA_KEY}', '0');
    return true;
  } catch {
    return false;
  }
})()`;
