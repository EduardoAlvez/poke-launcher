/**
 * Maquina da rota "capturar um por um" (Fase 10). Roda no addon preload da
 * SESSAO (mundo isolado), como o motor de automacao: decide e CLICA — Mapa,
 * aba de regiao, marcador, caido. NUNCA toca no WebSocket; a confirmacao de
 * captura vem do MAIN (que ve o delta `dexMud` pela ponte do dex-hook) pelo
 * comando `advance`.
 *
 * Estados por alvo: travel (abrir mapa/achar marcador) -> ficha (no movel o
 * toque no marcador so abre a ficha; "Cacar aqui" e quem viaja) -> wait-hud
 * (chegou?) -> hunt (arremessar ou aguardar VIP ate o main confirmar) ->
 * proximo.
 * Sem caido na area o laço espera (spawn e do jogo). Falhas de viagem param
 * no alvo atual; somente captura confirmada avanca.
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
    const manualCapture = config.manualCapture === true;
    const gerenciaEconomia = config.gerenciaEconomia === true;

    let i = 0;
    let phase = config.currentHuntSlug === targets[0]?.slug ? 'hunt' : 'travel';
    let phaseStart = clock();
    let tabTries = 0;
    let throwsTarget = 0;
    let throwsTotal = 0;
    let captured = 0;
    let stopped = false;
    let timer = null;
    let lastEmit = '';
    let bolas = null; // lido do DOM em tempo real: o espelho estado.balls NAO chega nos deltas
    let economyExited = false;
    let modoTrocou = false; // a rota ligou o modo Mapa (o usuario estava em Lista)
    let modoTries = 0;
    let marcadorAlvo = null; // o marcador tocado: o re-clique da porta de troca usa
    let fichaInicio = 0; // entrada na fase ficha: o orcamento de 15 s nao zera nos vaivens

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
        manualCapture,
      });
    };

    const nextTarget = (state, currentHuntSlug = null) => {
      emitStatus(state);
      i += 1;
      phase = target() && currentHuntSlug && currentHuntSlug === target().slug ? 'hunt' : 'travel';
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
      if (modoTrocou) {
        // Devolve o modo Lista do usuario: o clique grava `mapaModo` no
        // localStorage do jogo (e so visivel com o mapa aberto); fechado, o
        // localStorage garante a volta na proxima abertura.
        if (mapaAberto()) trocarModoMapa(true);
        try {
          win.localStorage && win.localStorage.setItem('mapaModo', 'lista');
        } catch {
          /* modo privado */
        }
      }
      if (economyExited && reason !== 'reconfigurado' && !gerenciaEconomia && pack?.economyEnterSelector && PA) {
        const enter = PA.findFirst(doc, [pack.economyEnterSelector]);
        if (enter) PA.clickTarget(enter, doc);
      }
      economyExited = false;
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
        const bts = [...doc.querySelectorAll('button,[role=button]')].filter((b) => textOf(b) === label);
        // Janela estreita = layout movel do jogo: o Mapa mora na gaveta
        // 'Menu' (`.m-pane[data-aba="menu"]`), fechada a cada carga. Botao
        // existe mas invisivel -> abre a gaveta e deixa o clique do Mapa
        // para o proximo tick, quando a pane termina de subir.
        const bt = bts.find((b) => !PA || PA.isClickable(b, doc)) || bts[0];
        if (bt && (!PA || PA.isClickable(bt, doc))) {
          bt.click();
          return true;
        }
        if (bt) {
          const gaveta = doc.querySelector(r.menuAba || '#m-nav button[data-aba="menu"]');
          if (gaveta && (!PA || PA.isClickable(gaveta, doc))) {
            gaveta.click();
            emitStatus('abrindo-gaveta');
          }
          return false;
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

    // O Mapa do jogo tem dois desenhos: modo Mapa (o mundi com marcadores
    // `button.marcador[data-slug]`) e modo Lista (linhas de texto, SEM
    // marcador nenhum — confirmado no fogo real 2026-11-12: conta em Lista
    // deixava a maquina num laco de aba ate o tabTries estourar com
    // 'alvo-nao-localizado'). O modo vem do localStorage do jogo
    // (`mapaModo`), conta por conta: um slot em Lista bastava para a rota
    // parar.
    const mapaEmLista = () => {
      try {
        // o pack pode ser antigo (sem as chaves de modo): os padroes valem sozinhos
        const p = doc.querySelector(r.mapaPrincipal || '#mapa-principal');
        return Boolean(p && p.classList.contains(r.modoListaClasse || 'modo-lista'));
      } catch {
        return false;
      }
    };

    const trocarModoMapa = (paraLista) => {
      const sel = paraLista
        ? r.btModoLista || '.mapa-modo-bt[data-modo="lista"]'
        : r.btModoMapa || '.mapa-modo-bt[data-modo="mapa"]';
      try {
        const bt = doc.querySelector(sel);
        if (bt && (!PA || PA.isClickable(bt, doc))) {
          bt.click();
          return true;
        }
      } catch {
        /* DOM mudou: o proximo tick tenta de novo */
      }
      return false;
    };

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

        if (PA?.isEconomy?.(doc, pack)) {
          const exit = !gerenciaEconomia && pack?.economyExitSelector && PA.findFirst(doc, [pack.economyExitSelector]);
          if (exit && PA.clickTarget(exit, doc)) {
            economyExited = true;
            emitStatus('saindo-economia');
          } else {
            emitStatus('modo-economia');
          }
          return schedule();
        }

        if (phase === 'hunt') {
          if (manualCapture) {
            emitStatus('aguardando-vip');
          } else {
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
              PA?.openMobileCapturePanel?.(doc, pack);
              emitStatus('esperando-caido');
            }
          }
          return schedule();
        }

        // A chegada e confirmada pelo huntSlug recebido no processo principal.
        // Nao repete cliques nem troca de alvo enquanto o servidor nao confirmar.
        if (phase === 'wait-hud') {
          if (agora - phaseStart > travelTimeoutMs) return finish('falha-chegada');
          if (mapaAberto()) {
            // o modal ainda esta em pe: a viagem NAO aconteceu — a porta de
            // troca de hunt recusou o clique da ficha. Volta para a ficha,
            // que re-clica o botao (movel) ou o marcador (desktop).
            phase = 'ficha';
            emitStatus('ficha-hunt');
            return schedule();
          }
          emitStatus('aguardando-chegada');
          return schedule();
        }

        if (phase === 'ficha') {
          if (!mapaAberto()) {
            // desktop: o clique no marcador ja viajou — o jogo fecha o modal
            phase = 'wait-hud';
            phaseStart = agora;
            emitStatus('viajando');
            return schedule();
          }
          const btCacar = doc.querySelector(r.btCacar || '.ha-cacar');
          // isClickable antes do clique: o botao nasce `disabled` quando a hunt
          // esta travada, e o clickTarget do motor clica sem conferir.
          if (btCacar && (!PA || (PA.isClickable(btCacar, doc) && PA.clickTarget(btCacar, doc)))) {
            // movel: a ficha abriu com o toque no marcador; este botao e quem viaja
            phase = 'wait-hud';
            phaseStart = agora;
            emitStatus('viajando');
            return schedule();
          }
          // Porta de troca de hunt: ao entrar numa hunt o servidor impoe uma
          // espera (~10 s) e a tela RECUSA a troca com toast, sem viajar e
          // sem fechar o mapa. Re-clique a cada tick (marcador no desktop,
          // onde o clique e a viagem; botao da ficha no movel, que acabou de
          // ser recusado) ate a porta abrir — 15 s cobrem a porta com folga.
          if (agora - fichaInicio > 15000) return finish('falha-ficha');
          if (!btCacar && marcadorAlvo && PA) PA.clickTarget(marcadorAlvo, doc);
          emitStatus('ficha-hunt');
          return schedule();
        }

        if (tabTries > 24) {
          return finish('alvo-nao-localizado');
        }

        const marcador = acharMarcador(t.slug);
        if (marcador) {
          if (PA && PA.clickTarget(marcador, doc)) {
            // O toque no marcador so VIAJA no desktop; no movel ele abre a
            // ficha e quem viaja e o botao "Cacar aqui" dela (a ficha so
            // existe no movel). A fase 'ficha' decide no tick seguinte.
            marcadorAlvo = marcador;
            fichaInicio = agora;
            phase = 'ficha';
            phaseStart = agora;
            tabTries = 0;
            emitStatus('ficha-hunt');
          }
          return schedule();
        }
        if (!mapaAberto()) {
          tabTries += 1; // abrir mapa que falha (botao sumiu) tambem tem de ter fuga
          abrirMapa();
          emitStatus('abrindo-mapa');
          return schedule();
        }
        if (mapaEmLista()) {
          modoTrocou = true;
          modoTries += 1; // conta mesmo com clique "bem-sucedido": classe que nao sai tambem trava
          trocarModoMapa(false);
          if (modoTries > 8) return finish('falha-modo-mapa');
          emitStatus('trocando-modo-mapa');
          return schedule(); // os marcadores so existem no tick seguinte
        }
        modoTries = 0;
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
      arrive: (slug) => {
        if (stopped) return false;
        const t = target();
        if (!t || t.slug !== slug) return false;
        if (phase === 'hunt') return true;
        phase = 'hunt';
        phaseStart = clock();
        tabTries = 0;
        throwsTarget = 0;
        emitStatus(manualCapture ? 'aguardando-vip' : 'esperando-caido');
        schedule();
        return true;
      },
      advance: (currentHuntSlug = null) => {
        if (stopped) return false;
        const t = target();
        if (!t) return false;
        captured += 1;
        nextTarget('capturado', currentHuntSlug);
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
