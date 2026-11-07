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

export const LIGHT_RESTORE = `(() => {
  const KEY = '__pokeLauncherLight';
  const state = window[KEY];
  if (!state) return 'absent';
  for (const id of state.handled) clearTimeout(id);
  state.handled.clear();
  window.requestAnimationFrame = state.real;
  window.cancelAnimationFrame = state.realCaf;
  delete window[KEY];
  return 'restored';
})()`;

export const LIGHT_VERIFY = `(() => {
  const state = window.__pokeLauncherLight;
  return !!state && window.requestAnimationFrame === state.wrapped && window.cancelAnimationFrame === state.wrappedCaf;
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
