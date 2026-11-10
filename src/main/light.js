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
  // Só desfaz o que ainda é nosso: se a página instalou um rAF depois, esse
  // passa por cima do limitador — e o limitador já não está no caminho.
  if (window.requestAnimationFrame === state.wrapped) window.requestAnimationFrame = state.real;
  if (window.cancelAnimationFrame === state.wrappedCaf) window.cancelAnimationFrame = state.realCaf;
  delete window[KEY];
  return 'restored';
})()`;

/** Refaz o patch do zero (a página trocou o rAF depois do nosso). */
export const LIGHT_REAPPLY = `(() => {
  const KEY = '__pokeLauncherLight';
  const state = window[KEY];
  if (!state) return 'absent';
  // Não restaura o rAF antigo: o APPLY seguinte embrulha o rAF que a página
  // está usando agora, e o limitador volta por cima dele.
  if (window.cancelAnimationFrame === state.wrappedCaf) window.cancelAnimationFrame = state.realCaf;
  delete window[KEY];
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
  const visivel = (el) => {
    if (!el || el.disabled) return false;
    const rect = el.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  };
  const eco = !!root?.classList.contains('modo-economia');
  const ultra = !!root?.classList.contains('modo-ultra');
  // O botao do JOGO e quem escreve a preferencia: aplicarEconomia grava sempre
  // (preferencias.mjs). Nao escrevemos nada aqui — o launcher lembra a
  // preferencia do usuario ANTES de clicar e restaura depois.
  if (eco) {
    const btn = doc.querySelector('#eco-sair');
    if (visivel(btn)) {
      btn.click();
      return 'exit-economy';
    }
  }
  if (ultra) {
    const btn = doc.querySelector('#ultra-sair');
    if (visivel(btn)) {
      btn.click();
      return 'exit-ultra';
    }
  }
  return eco || ultra ? 'still-economy' : 'ok';
})()`;

/**
 * A preferencia do usuario, lida da pagina (o jogo guarda em localStorage:
 * '1' = ligado). E o que o launcher guarda ANTES de tirar o jogo do Modo
 * Economia — o botao do jogo zera a chave, e sem esta leitura a restauracao
 * no fim do modo leve nao teria o que restaurar.
 */
export const LIGHT_PREFS_READ = `(() => {
  try {
    return {
      economia: window.localStorage.getItem('${LIGHT_ECONOMY_KEY}') === '1',
      ultra: window.localStorage.getItem('${LIGHT_ULTRA_KEY}') === '1',
    };
  } catch {
    return { economia: false, ultra: false };
  }
})()`;

/**
 * Sai do Modo Economia pelo botao do proprio jogo ("Ligar a cena"), sem
 * reload e sem escrever a preferencia: o clique do jogo ja avisa o servidor
 * (cliente.economia{ativo:false}) e o campo volta. Se o botao nao existir,
 * devolve 'ausente' — quem decide o fallback e o main.
 */
export const LIGHT_SAIR_ECONOMIA = `(() => {
  const btn = document.querySelector('#eco-sair');
  if (!btn) return 'ausente';
  btn.click();
  return 'ok';
})()`;

/**
 * Liga o Modo Economia pelo atalho da cena. O pack de automacao usa a CLASSE
 * (.hunt-eco) e o jogo tambem expoe o ID (#hunt-eco): tenta os dois, porque
 * perder a preferencia do usuario por causa de um seletor e o pior defeito
 * possivel aqui.
 */
export const LIGHT_LIGAR_ECONOMIA = `(() => {
  const btn = document.querySelector('#hunt-eco') || document.querySelector('.hunt-eco');
  if (!btn) return 'ausente';
  btn.click();
  return 'ok';
})()`;

/** Sai do Modo ULTRA pelo botao da propria caixa do ULTRA. */
export const LIGHT_SAIR_ULTRA = `(() => {
  const btn = document.querySelector('#ultra-sair');
  if (!btn) return 'ausente';
  btn.click();
  return 'ok';
})()`;

/**
 * Liga o Modo ULTRA pelo interruptor do painel de Configuracoes. O handler e
 * delegado no container do modal, entao o clique sintetico funciona com o
 * modal fechado.
 */
export const LIGHT_LIGAR_ULTRA = `(() => {
  const btn = document.querySelector('#cfg-ultra');
  if (!btn) return 'ausente';
  btn.click();
  return 'ok';
})()`;

/** O jogo esta no Modo Economia agora? (a classe do proprio jogo) */
export const LIGHT_EM_ECONOMIA = `(() => {
  const root = document.documentElement;
  const eco = !!root?.classList.contains('modo-economia');
  const ultra = !!root?.classList.contains('modo-ultra');
  return eco ? 'economia' : ultra ? 'ultra' : 'nenhum';
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

/**
 * A cena está desenhando? Amostra o canvas da cena várias vezes (mundo
 * principal, para não criar o contexto 2D do jogo no mundo isolado): se a
 * assinatura muda, os pixels mudaram. Um laço de desenho parado deixa as
 * assinaturas iguais.
 */
export const LIGHT_SAMPLE_SCENE = `(async () => {
  const canvas = document.querySelector('#cena');
  if (!canvas || !canvas.width || !canvas.height) return { changed: null, reads: 0, distinct: 0 };
  let ctx = null;
  try {
    ctx = canvas.getContext('2d');
  } catch {
    return { changed: null, reads: 0, distinct: 0 };
  }
  if (!ctx) return { changed: null, reads: 0, distinct: 0 };
  const w = Math.max(1, Math.min(64, Math.floor(canvas.width / 2)));
  const h = Math.max(1, Math.min(64, Math.floor(canvas.height / 2)));
  const x = Math.max(0, Math.floor((canvas.width - w) / 2));
  const y = Math.max(0, Math.floor((canvas.height - h) / 2));
  const sigs = new Set();
  let reads = 0;
  const deadline = Date.now() + 1200;
  do {
    let acc = 0;
    try {
      const data = ctx.getImageData(x, y, w, h).data;
      for (let i = 0; i < data.length; i += 1) acc = (acc * 31 + data[i]) >>> 0;
    } catch (err) {
      return { changed: null, reads, distinct: sigs.size, error: String(err?.message ?? err) };
    }
    sigs.add(String(acc));
    reads += 1;
    if (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
  } while (Date.now() < deadline);
  return { changed: sigs.size > 1, reads, distinct: sigs.size, size: canvas.width + 'x' + canvas.height };
})()`;
