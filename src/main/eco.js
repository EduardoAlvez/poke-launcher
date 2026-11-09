/**
 * Modo eco: limita o requestAnimationFrame da pagina a poucos quadros por
 * segundo. Jogos idle calculam progresso por diferenca de tempo real
 * (Date.now), entao o avanco nao se perde — so a frequencia de redesenho cai.
 *
 * O patch e instalado uma vez por documento e expõe `__pokeLauncherEco.set(ms)`
 * para ligar/desligar sem reinjetar. Ele e instalado ANTES do modo leve: o leve
 * embrulha por cima (e ao desligar, devolve o rAF para o eco, nao para o nativo).
 */

export const ECO_ACTIVE_MS = 200;

export function ecoThrottleMs(enabled) {
  return enabled === true ? ECO_ACTIVE_MS : 0;
}

export const ECO_INSTALL = `(() => {
  if (window.__pokeLauncherEco) return 'already';
  const real = window.requestAnimationFrame;
  const realCaf = window.cancelAnimationFrame;
  // Ids proprios ficam acima de qualquer id nativo plausivel: cancelAnimationFrame
  // nunca confunde um timer nosso com um frame nativo (que tambem comeca em 1).
  const BASE = 1000000000;
  const handled = new Map();
  let nextId = BASE + 1;
  let ms = 0;
  const wrapped = (cb) => {
    if (!ms) return real.call(window, cb);
    const wid = nextId++;
    const tid = setTimeout(() => {
      handled.delete(wid);
      cb(performance.now());
    }, ms);
    handled.set(wid, tid);
    return wid;
  };
  const wrappedCaf = (id) => {
    if (handled.has(id)) {
      clearTimeout(handled.get(id));
      handled.delete(id);
      return;
    }
    if (typeof realCaf === 'function') realCaf.call(window, id);
  };
  window.__pokeLauncherEco = {
    set(value) {
      ms = Math.max(0, Number(value) || 0);
      return ms;
    },
    get ms() {
      return ms;
    },
  };
  window.requestAnimationFrame = wrapped;
  window.cancelAnimationFrame = wrappedCaf;
  return 'applied';
})()`;

/** Expressao que ajusta o throttle do patch ja instalado (no-op se ausente). */
export function ecoSetExpr(enabled) {
  return `(window.__pokeLauncherEco && window.__pokeLauncherEco.set(${ecoThrottleMs(enabled)}), true)`;
}
