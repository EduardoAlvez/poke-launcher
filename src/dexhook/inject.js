/**
 * Hook do painel de caça (Fase 9) e do P2 (Fase 12). MUNDO DA PAGINA,
 * document_start: precisa embrulhar o construtor WebSocket ANTES do primeiro
 * script do jogo rodar — a sessão logada abre o socket antes do load-event.
 *
 * Sem o opt-in (localStorage 'pokeLauncherDex' = '1') este arquivo não faz
 * absolutamente nada — zero pegada quando desligado.
 *
 * Leitura: observa as mensagens RECEBIDAS do socket same-origin do jogo e
 * repassa welcome/estado (painel de caça) e campo/batalha (P2) para a ponte.
 *
 * Escrita (SÓ com o P2 armado por comando do main, nunca por flag): reescreve
 * `cliente.economia{ativo:true}` para `{ativo:false}` — mantém o campo
 * chegando com o jogo no Economia — e envia `ball.throw`. Sem arm, o `send`
 * embrulhado deixa passar o original intacto.
 */
(() => {
  const CHANNEL = 'pokeLauncherDex';
  const FLAG = 'pokeLauncherDex';
  const P2 = 'pokeLauncherP2';

  let enabled = false;
  try {
    enabled = window.localStorage.getItem(FLAG) === '1';
  } catch {
    enabled = false;
  }
  if (!enabled) return;
  if (window.__pokeLauncherDexHook) return;
  // marcador de diagnostico: "instalado" nao prova que o welcome chegou
  window.__pokeLauncherDexHook = { installed: true, welcome: false, frames: 0, lastFrame: null };

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

  const postP2 = (data) => {
    try {
      window.postMessage({ source: P2, t: 'p2state', data }, window.location.origin);
    } catch {
      /* idem */
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

  // ---- P2: estado, relogio do servidor e acao ----
  const p2 = {
    armado: false,
    sockets: new Set(),
    ultimo: null,
    desvio: 0,
    temDesvio: false,
    mobs: new Map(),
    ultimoCampoEm: 0,
    campoVisto: false,
    // o hook ja mentiu ao servidor (reescreveu `cliente.economia`)? o desarme
    // precisa desfazer essa mentira.
    reescreveu: false,
  };

  // O cliente deriva `agora` do relogio do servidor via `m.ts` (campo.mjs):
  // `xr` e relativo a ELE. Usar Date.now() local deslocaria toda expiracao.
  const agoraServidor = () => performance.timeOrigin + performance.now() - p2.desvio;

  const sincronizarRelogio = (ts) => {
    if (!Number.isFinite(ts) || ts <= 0) return;
    const d = Date.now() - ts;
    if (!p2.temDesvio || Math.abs(d - p2.desvio) > 2000) p2.desvio = d;
    else p2.desvio = 0.85 * p2.desvio + 0.15 * d;
    p2.temDesvio = true;
  };

  const aoCampo = (msg) => {
    sincronizarRelogio(msg.ts);
    const agora = agoraServidor();
    const mobs = Array.isArray(msg.mobs) ? msg.mobs : [];
    for (const b of mobs) {
      if (!b || typeof b !== 'object') continue;
      const s = Number(b.s);
      if (!Number.isFinite(s)) continue;
      const antes = p2.mobs.get(s) ?? { s, x: false, expiraEm: 0 };
      const e = { s, x: antes.x, expiraEm: antes.expiraEm };
      if (b.x !== undefined) e.x = b.x === true;
      // So atualiza quando o frame TRAZ `xr` (igual ao campo.mjs: deltas).
      if (b.xr !== undefined && Number.isFinite(Number(b.xr))) e.expiraEm = agora + Number(b.xr);
      p2.mobs.set(s, e);
    }
    for (const s of Array.isArray(msg.fora) ? msg.fora : []) p2.mobs.delete(Number(s));
    p2.ultimoCampoEm = Date.now();
    p2.campoVisto = true;
    // Envia a VIDA RESTANTE, nao o instante absoluto: `expiraEm` esta no
    // relogio do servidor e o main compara com o relogio local. Convertendo
    // aqui (mesma base dos dois lados), nao ha como comparar relogios diferentes.
    const mobs2 = [...p2.mobs.values()].map((m) => ({
      s: m.s,
      x: m.x,
      resta: m.expiraEm > 0 ? Math.max(0, m.expiraEm - agora) : null,
    }));
    postP2({ kind: 'corpos', mobs: mobs2 });
  };

  const aoBatalha = (msg) => {
    const evs = Array.isArray(msg.ev) ? msg.ev : [];
    for (const e of evs) {
      if (!e || typeof e !== 'object') continue;
      if (e.k === 'bola') {
        postP2({ kind: 'bola', slot: e.slot, sucesso: e.sucesso === true, ballId: e.ballId });
      } else if (e.k === 'capturado') {
        const p = e.pokemon && typeof e.pokemon === 'object' ? e.pokemon : null;
        const speciesId = Number(p?.speciesId);
        // A captura e um EVENTO do servidor (com a especie): a rota "um por um"
        // confirma por aqui, sem esperar o delta da dex chegar.
        if (Number.isInteger(speciesId) && speciesId > 0) {
          post('captura', {
            speciesId,
            nome: typeof p?.nome === 'string' ? p.nome.slice(0, 40) : null,
            level: Number.isFinite(Number(p?.level)) ? Number(p.level) : null,
            shiny: p?.shiny === true,
          });
        }
        postP2({
          kind: 'capturado',
          slot: e.slot ?? null,
          pokemon: p
            ? {
                speciesId: Number.isInteger(speciesId) ? speciesId : null,
                nome: p.nome ?? null,
                level: p.level ?? null,
                shiny: p.shiny === true,
              }
            : null,
        });
      }
    }
  };

  const sendReal = RealWS.prototype.send;
  let sendEmbrulhado = false;

  const enviarCru = (socket, obj) => {
    try {
      return sendReal.call(socket, JSON.stringify(obj));
    } catch {
      return null;
    }
  };

  const socketVivo = () => {
    if (p2.ultimo && p2.ultimo.readyState === 1) return p2.ultimo;
    for (const s of p2.sockets) if (s.readyState === 1) return s;
    return null;
  };

  function armar() {
    p2.armado = true;
    p2.mobs.clear();
    p2.ultimoCampoEm = 0;
    // Um novo arm começa sem campo: o `campoVisto` antigo era de outra
    // execucao e nao pode encurtar a carencia do main.
    p2.campoVisto = false;
    p2.reescreveu = false;
    // O servidor ja pode ter parado o campo ANTES do arm (o jogo estava em
    // Economia). Avisa uma vez para ele voltar a mandar.
    const sock = socketVivo();
    if (sock) enviarCru(sock, { t: 'cliente.economia', ativo: false });
    postP2({ kind: 'armado', ok: true, campoVisto: p2.campoVisto });
  }

  function desarmar(motivo) {
    p2.armado = false;
    p2.mobs.clear();
    // Desfaz a MENTIRA contada ao servidor: enquanto o P2 esteve armado, o
    // cliente disse "estou fora do Economia" para o campo continuar chegando.
    // Se a pagina esta de fato no Modo Economia, a verdade volta agora — sem
    // isso o servidor fica achando que ha cena (e o campo nao para).
    if (p2.reescreveu) {
      try {
        if (window.document?.documentElement?.classList?.contains('modo-economia')) {
          const sock = socketVivo();
          if (sock) enviarCru(sock, { t: 'cliente.economia', ativo: true });
        }
      } catch {
        /* sem DOM nao ha o que desfazer */
      }
      p2.reescreveu = false;
    }
    postP2({ kind: 'desarmado', motivo: String(motivo || 'pedido') });
  }

  function arremessar(cmd) {
    if (!p2.armado) {
      postP2({ kind: 'erro', motivo: 'desarmado' });
      return;
    }
    const sock = socketVivo();
    if (!sock) {
      postP2({ kind: 'erro', motivo: 'socket' });
      return;
    }
    const ballId = Number(cmd.ballId);
    const slot = Number(cmd.slot);
    if (!Number.isFinite(ballId) || !Number.isFinite(slot)) {
      postP2({ kind: 'erro', motivo: 'comando' });
      return;
    }
    try {
      sendReal.call(sock, JSON.stringify({ t: 'ball.throw', ballId, slot }));
    } catch {
      postP2({ kind: 'erro', motivo: 'envio' });
    }
  }

  const observe = (socket, url) => {
    if (!isGameSocket(url)) return;
    p2.sockets.add(socket);
    p2.ultimo = socket;
    const esquecer = () => {
      p2.sockets.delete(socket);
      // `ultimo` era o socket vivo do jogo: sem isso, um arremesso miraria
      // numa conexao fechada para sempre.
      if (p2.ultimo === socket) p2.ultimo = [...p2.sockets].at(-1) ?? null;
    };
    socket.addEventListener('close', esquecer);
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
      const hook = window.__pokeLauncherDexHook;
      if (hook) {
        hook.frames += 1;
        hook.lastFrame = t;
      }
      if (t === 'welcome') {
        lastWelcome = msg;
        if (hook) hook.welcome = true;
        post('welcome', msg);
      } else if (t === 'estado') {
        post('estado', msg);
      } else if (t === 'campo') {
        try {
          aoCampo(msg);
        } catch {
          /* observar nunca pode quebrar o socket do jogo */
        }
      } else if (t === 'batalha') {
        try {
          aoBatalha(msg);
        } catch {
          /* idem */
        }
      }
    });
  };

  // Embrulha o `send` do PROTOTIPO (uma vez): as instancias ja criadas e as
  // futuras herdam o embrulho. So reescreve a mensagem com o P2 armado.
  if (!sendEmbrulhado && typeof sendReal === 'function') {
    sendEmbrulhado = true;
    RealWS.prototype.send = function embrulhado(data) {
      let saida = data;
      try {
        if (p2.armado && typeof data === 'string' && data.charCodeAt(0) === 123) {
          const msg = JSON.parse(data);
          if (msg && msg.t === 'cliente.economia' && msg.ativo === true) {
            msg.ativo = false;
            saida = JSON.stringify(msg);
            // marcada a mentira: o desarme precisa desfazer.
            p2.reescreveu = true;
          }
        }
      } catch {
        /* deixa passar o original */
      }
      return sendReal.call(this, saida);
    };
  }

  function HookedWebSocket(url, protocols) {
    // `WebSocket` sem `new` e TypeError no navegador; preserva o contrato.
    if (!new.target) throw new TypeError("Failed to construct 'WebSocket': Please use the 'new' operator");
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
    if (!d) return;
    if (d.source === CHANNEL && d.t === 'get') {
      if (lastWelcome) post('welcome', lastWelcome);
      post('ready', { replayed: Boolean(lastWelcome), armado: p2.armado });
      return;
    }
    if (d.source === P2 && d.t === 'p2cmd') {
      const cmd = d.data && typeof d.data === 'object' ? d.data : {};
      if (cmd.action === 'arm') armar();
      else if (cmd.action === 'disarm') desarmar(cmd.motivo);
      else if (cmd.action === 'throw') arremessar(cmd);
    }
  });

  post('ready', { replayed: false, armado: false });
  // O main escuta o ready no canal do P2: e assim que um arm fantasma (o
  // documento recarregou por fora do launcher) e reconciliado.
  postP2({ kind: 'ready', armado: false });
})();
