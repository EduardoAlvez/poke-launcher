/**
 * Maquina da rota "capturar um por um" (Fase 10). Roda no addon preload da
 * SESSAO (mundo isolado), como o motor de automacao: decide e CLICA — Mapa,
 * aba de regiao, marcador, caido. NUNCA toca no WebSocket; a confirmacao de
 * captura vem do MAIN (que ve o delta `dexMud` pela ponte do dex-hook) pelo
 * comando `advance`.
 *
 * Estados por alvo: travel (abrir mapa/achar marcador) -> wait-hud (chegou?)
 * -> hunt (clicar cada caido da especie ate o main confirmar) -> proximo.
 * Sem caido na area o laço espera (spawn e do jogo). Falhas de viagem param
 * no alvo atual; somente captura confirmada ou marcador capturado avanca.
 */
(function (root) {
  const PA = root.PokeAutomation; // reusa isVisible/clickTarget/findFirst do motor
  const SLUG_OK = /^[a-z0-9_-]{1,40}$/i;

  function textOf(el) {
    return (el && (el.textContent || '')).replace(/\s+/g, ' ').trim();
  }

  function installRoute({ config, pack, emit, doc = root.document, win = root, now = Date.now }) {
    const clock = typeof now === 'function' ? now : Date.now;
    const targets = Array.isArray(config.targets) ? config.targets : [];
    const r = pack.route || {};
    const intervalMs = Math.max(300, r.tickMs || 1200);
    const travelTimeoutMs = Math.max(3000, r.travelTimeoutMs || 20000);
    const maxBolas = Number.isFinite(config.maxBolas) && config.maxBolas > 0 ? Math.floor(config.maxBolas) : null;

    let i = 0;
    let phase = 'travel';
    let phaseStart = clock();
    let tabTries = 0;
    let throwsTarget = 0;
    let throwsTotal = 0;
    let captured = 0;
    let stopped = false;
    let timer = null;
    let lastEmit = '';
    let bolas = null; // lido do DOM em tempo real: o espelho estado.balls NAO chega nos deltas

    const target = () => targets[i] || null;

    // O jogo mostra a bola selecionada como "… voce tem 1.547". Ler daqui e o
    // unico termometro honesto do gasto: o welcome traz balls mas o jogo nao o
    // reenvia nos deltas de estado (confirmado no fogo real 2026-11-10), entao
    // o espelho do main congela. Sem isto, "parar quando zerar" nao funciona.
    const lerBolas = () => {
      try {
        const el =
          doc.querySelector(r.ballSelected || '#caidos-bolas .caidos-bola.on') ||
          doc.querySelector('.caidos-bola.on');
        if (!el) return bolas;
        const bruto = String(el.getAttribute?.('title') || '');
        const m = /([\d.]+)\s*$/.exec(bruto.trim());
        if (!m) return bolas;
        const n = Number(m[1].replace(/\./g, ''));
        return Number.isFinite(n) && n >= 0 ? Math.floor(n) : bolas;
      } catch {
        return bolas;
      }
    };

    const emitStatus = (state) => {
      const key = `${state}|${i}|${throwsTotal}|${captured}`;
      if (key === lastEmit) return;
      lastEmit = key;
      emit?.({
        type: 'route-status',
        state,
        running: !stopped,
        index: i,
        total: targets.length,
        target: target()?.nome || null,
        throws: throwsTotal,
        captured,
        balls: bolas,
      });
    };

    const nextTarget = (state) => {
      emitStatus(state);
      i += 1;
      phase = 'travel';
      phaseStart = clock();
      tabTries = 0;
      throwsTarget = 0;
      if (i >= targets.length) finish('fila-completa');
      else schedule();
    };

    const finish = (reason) => {
      if (stopped) return;
      stopped = true;
      if (timer) win.clearTimeout(timer);
      timer = null;
      emit?.({
        type: 'route-status',
        state: reason,
        running: false,
        index: Math.min(i, targets.length - 1),
        total: targets.length,
        target: targets[i]?.nome || null,
        throws: throwsTotal,
        captured,
        balls: bolas,
      });
    };

    const schedule = () => {
      if (stopped) return;
      // advance() chega do main ENTRE ticks e chama nextTarget->schedule com um
      // timer ja pendurado: sem limpar, cada captura confirmada deixa uma
      // segunda cadeia de tick rodando e a cadencia de clique multiplica.
      if (timer) win.clearTimeout(timer);
      timer = null;
      const jitter = Math.floor(Math.random() * 400);
      timer = win.setTimeout(tick, intervalMs + jitter);
    };

    const mapaAberto = () => {
      try {
        const ativa = doc.querySelector('.mapa-reg-bt.on');
        // mapa FECHADO deixa a ultima aba com `.on` no DOM (retangulo zero):
        // sem checar visibilidade, a maquina achava que o mapa estava aberto,
        // nunca o reabria e travava em 'procurando-regiao' para sempre.
        return Boolean(ativa && (!PA || PA.isClickable(ativa, doc)));
      } catch {
        return false;
      }
    };

    const abrirMapa = () => {
      const label = r.mapLabel || 'Mapa';
      try {
        for (const b of doc.querySelectorAll('button,[role=button]')) {
          if (textOf(b) === label && (!PA || PA.isClickable(b, doc))) {
            b.click();
            return true;
          }
        }
      } catch {
        /* DOM mudou: o proximo tick tenta de novo */
      }
      return false;
    };

    const acharMarcador = (slug) => {
      if (!slug || !SLUG_OK.test(slug)) return null;
      try {
        const el = doc.querySelector(`button.marcador[data-slug="${slug}"], .marcador[data-slug="${slug}"]`);
        // mapa fechado deixa DOM oculto para tras: so um marcador VISIVEL vale
        if (!el || (PA && PA.isClickable && !PA.isClickable(el, doc))) return null;
        return el;
      } catch {
        return null;
      }
    };

    const marcadorCapturado = (el) => /(?:^|\s)capturado(?:\s|$)/.test(String(el?.className || ''));

    const trocarAba = () => {
      // SEMPRE conta a tentativa, inclusive quando nao ha aba clicavel: e
      // justamente o caso (mapa fechado, abas invisiveis) que nao pode virar
      // laco sem saida — o tabTries>24 e a unica fuga do ramo travel.
      tabTries += 1;
      try {
        const tabs = [...doc.querySelectorAll('.mapa-reg-bt')].filter((t) => !PA || PA.isClickable(t, doc));
        if (!tabs.length) return false;
        const atual = tabs.findIndex((t) => t.className.includes('on'));
        const prox = tabs[(Math.max(atual, 0) + 1) % tabs.length];
        prox.click();
        return true;
      } catch {
        return false;
      }
    };

    const hudEhDoAlvo = (pokeId) => {
      try {
        const hud = doc.querySelector(r.hud || '#hud-hunt');
        if (!hud) return false;
        const attr = r.hudIdAttr || 'pokeId';
        return Number(hud.dataset[attr]) === Number(pokeId);
      } catch {
        return false;
      }
    };

    const caidoDoAlvo = (nome) => {
      try {
        const alvo = String(nome || '').toLowerCase();
        for (const el of doc.querySelectorAll(r.caidoList || '#caidos-lista .caido')) {
          const quem = textOf(el.querySelector(r.caidoNome || '.caido-quem')).toLowerCase();
          if (quem.includes(alvo) && PA && PA.isClickable(el, doc)) return el;
        }
      } catch {
        /* sem lista agora */
      }
      return null;
    };

    function tick() {
      timer = null;
      if (stopped) return;
      try {
        const t = target();
        if (!t) return finish('fila-completa');
        const agora = clock();

        if (hudEhDoAlvo(t.pokeId)) {
          if (phase !== 'hunt') {
            phase = 'hunt';
            phaseStart = agora;
            throwsTarget = 0;
          }
          bolas = lerBolas();
          const caido = caidoDoAlvo(t.nome);
          if (caido) {
            if (bolas === 0) {
              emitStatus('sem-bolas');
              return finish('sem-bolas');
            }
            if (maxBolas !== null && throwsTarget >= maxBolas) {
              return finish('limite-arremessos');
            }
            if (PA && PA.clickTarget(caido, doc)) {
              throwsTarget += 1;
              throwsTotal += 1;
            }
            emitStatus('arremessando');
          } else {
            emitStatus('esperando-caido');
          }
          return schedule();
        }

        // Depois de chegar ao ponto do mapa, espera o HUD confirmar a area.
        // Nao repete cliques nem troca de alvo se o jogo nao concluir a viagem.
        if (phase === 'wait-hud') {
          if (agora - phaseStart > travelTimeoutMs) return finish('falha-chegada');
          emitStatus('aguardando-chegada');
          return schedule();
        }

        // O HUD pode oscilar durante uma batalha. Permanece no alvo ate ele
        // voltar ou o servidor confirmar a captura; nao inicia outra viagem.
        if (phase === 'hunt') {
          emitStatus('aguardando-alvo');
          return schedule();
        }

        if (tabTries > 24) {
          return finish('alvo-nao-localizado');
        }

        const marcador = acharMarcador(t.slug);
        if (marcador) {
          // classe do proprio jogo: a especie ja esta na dex — nao gasta viagem
          // nem bolas (complementa o baseline do main, que ve o delta real)
          if (marcadorCapturado(marcador)) return nextTarget('skip-capturado');
          if (PA && PA.clickTarget(marcador, doc)) {
            phase = 'wait-hud';
            phaseStart = agora;
            tabTries = 0;
            emitStatus('viajando');
          }
          return schedule();
        }
        if (!mapaAberto()) {
          tabTries += 1; // abrir mapa que falha (botao sumiu) tambem tem de ter fuga
          abrirMapa();
          emitStatus('abrindo-mapa');
          return schedule();
        }
        trocarAba();
        emitStatus('procurando-regiao');
        return schedule();
      } catch {
        emitStatus('erro');
        return schedule();
      }
    }

    const api = {
      stop: (reason = 'parado') => finish(reason),
      /**
       * O main confirmou a captura do alvo atual por delta real da dex
       * (`dexMud` com c>0) — unica fonte honesta de "capturou".
       */
      advance: () => {
        if (stopped) return false;
        const t = target();
        if (!t) return false;
        captured += 1;
        nextTarget('capturado');
        return true;
      },
      isRunning: () => !stopped,
      getState: () => ({ phase, index: i, throwsTotal, captured }),
    };

    if (!targets.length) {
      finish('sem-alvos');
      return api;
    }
    emitStatus('partindo');
    schedule();
    return api;
  }

  root.PokeRoute = { installRoute };
})(globalThis);
