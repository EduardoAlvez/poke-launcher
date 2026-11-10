/**
 * Hook do painel de caça (Fase 9). MUNDO DA PAGINA, document_start: precisa
 * embrulhar o construtor WebSocket ANTES do primeiro script do jogo rodar —
 * a sessão logada abre o socket antes do load-event (recon 2026-11-10).
 *
 * Só leitura: observa as mensagens RECEBIDAS do socket same-origin do jogo e
 * repassa welcome/estado para a ponte isolada. Nunca toca no envio, nunca
 * persiste nada, e sem o opt-in (localStorage 'pokeLauncherDex' = '1') este
 * arquivo não faz absolutamente nada — zero pegada quando desligado.
 */
(() => {
  const CHANNEL = 'pokeLauncherDex';
  const FLAG = 'pokeLauncherDex';

  let enabled = false;
  try {
    enabled = window.localStorage.getItem(FLAG) === '1';
  } catch {
    enabled = false;
  }
  if (!enabled) return;
  if (window.__pokeLauncherDexHook) return;
  window.__pokeLauncherDexHook = true;

  const RealWS = window.WebSocket;
  if (!RealWS) return;

  let lastWelcome = null;

  const post = (t, data) => {
    try {
      window.postMessage({ source: CHANNEL, t, data }, window.location.origin);
    } catch {
      /* mensagem grande demais nao deveria chegar aqui; ignora com seguranca */
    }
  };

  const isGameSocket = (raw) => {
    try {
      const host = new URL(String(raw), window.location.href).hostname.toLowerCase();
      return host === 'pokeidle.io' || host.endsWith('.pokeidle.io');
    } catch {
      return false;
    }
  };

  const observe = (socket, url) => {
    if (!isGameSocket(url)) return;
    socket.addEventListener('message', (ev) => {
      const data = ev && ev.data;
      if (typeof data !== 'string' || data.length > 4_000_000) return;
      if (data.charCodeAt(0) !== 123) return;
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      const t = msg && typeof msg.t === 'string' ? msg.t : null;
      if (t === 'welcome') {
        lastWelcome = msg;
        post('welcome', msg);
      } else if (t === 'estado') {
        post('estado', msg);
      }
    });
  };

  function HookedWebSocket(url, protocols) {
    const socket = protocols === undefined ? new RealWS(url) : new RealWS(url, protocols);
    try {
      observe(socket, url);
    } catch {
      /* observar nunca pode quebrar o socket do jogo */
    }
    return socket;
  }
  HookedWebSocket.prototype = RealWS.prototype;
  try {
    Object.defineProperty(HookedWebSocket, 'name', { value: 'WebSocket', configurable: true });
  } catch {
    /* nome e cosmetico */
  }
  for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) {
    try {
      Object.defineProperty(HookedWebSocket, key, { value: RealWS[key] });
    } catch {
      /* constantes estaticas sao bonus de aparencia */
    }
  }
  window.WebSocket = HookedWebSocket;

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.source !== CHANNEL || d.t !== 'get') return;
    if (lastWelcome) post('welcome', lastWelcome);
    post('ready', { replayed: Boolean(lastWelcome) });
  });

  post('ready', { replayed: false });
})();
