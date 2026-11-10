import {
  LIGHT_APPLY,
  LIGHT_CSS,
  LIGHT_EM_ECONOMIA,
  LIGHT_LIGAR_ECONOMIA,
  LIGHT_LIGAR_ULTRA,
  LIGHT_PREFS_OFF,
  LIGHT_PREFS_READ,
  LIGHT_REAPPLY,
  LIGHT_RESTORE,
  LIGHT_SAIR_ECONOMIA,
  LIGHT_SAIR_ULTRA,
  LIGHT_VERIFY,
  LIGHT_WATCH,
} from './light.js';

/**
 * O modo leve de uma sessao, sem dependencia do Electron: assim a logica de
 * fila, geracao e recarga pode ser testada com um webContents falso.
 */
export class LightMode {
  constructor({ onChange = null } = {}) {
    this.onChange = onChange;
  }

  /** Invalida tarefas de modo leve em andamento (religar/desligar/trocar de view). */
  begin(slot) {
    slot.lightGen = (slot.lightGen ?? 0) + 1;
    return slot.lightGen;
  }

  stale(slot, wc, gen) {
    return gen !== (slot.lightGen ?? 0) || slot.view.webContents !== wc || !slot.lightMode;
  }

  /**
   * Serializa as tarefas de modo leve da sessão. Duas aplicações juntas
   * brigariam pela chave do CSS injetado (a segunda apagaria a referência da
   * primeira e a cena ficaria oculta para sempre depois de um OFF).
   */
  queue(slot, fn) {
    const run = (slot.lightQueue ?? Promise.resolve()).then(fn, fn);
    slot.lightQueue = run.catch(() => {});
    return run;
  }

  /**
   * A preferencia do usuario (Economia/Ultra ligada?) ANTES de o launcher
   * mexer no jogo. O botao do jogo zera a chave ao ser clicado — sem esta
   * leitura, a restauracao no fim do modo leve nao teria o que restaurar.
   */
  async lerPreferenciaDoUsuario(slot) {
    const wc = slot.view?.webContents;
    if (!wc || wc.isDestroyed() || !/^https?:/i.test(wc.getURL())) return null;
    const prefs = await wc.executeJavaScript(LIGHT_PREFS_READ, true).catch(() => null);
    if (!prefs || typeof prefs !== 'object') return null;
    return { economia: prefs.economia === true, ultra: prefs.ultra === true };
  }

  /**
   * Tira o jogo do Modo Economia/Ultra pelo botao do PROPRIO JOGO (sem
   * reload e sem escrever a preferencia): o jogo e quem avisa o servidor
   * (cliente.economia{ativo:false}) e o campo volta.
   *
   * O clique pode nao agir (botao desabilitado, handler que nao responde):
   * por isso a saida e CONFIRMADA relendo o estado do jogo. Sem essa
   * checagem, o launcher acreditaria que saiu do Economia — e o campo nunca
   * voltaria, enquanto o AUTO ficaria sem alvo achando que tudo deu certo.
   */
  async sairDoEconomiaPeloJogo(slot) {
    const wc = slot.view?.webContents;
    if (!wc || wc.isDestroyed()) return 'sem-pagina';
    const estado = await wc.executeJavaScript(LIGHT_EM_ECONOMIA, true).catch(() => 'erro');
    if (estado === 'economia') {
      const r = await wc.executeJavaScript(LIGHT_SAIR_ECONOMIA, true).catch(() => 'erro');
      if (r !== 'ok') return 'sem-botao';
      return (await this.confirmouSaida(slot, 'economia')) ? 'saiu-economia' : 'sem-efeito';
    }
    if (estado === 'ultra') {
      const r = await wc.executeJavaScript(LIGHT_SAIR_ULTRA, true).catch(() => 'erro');
      if (r !== 'ok') return 'sem-botao';
      return (await this.confirmouSaida(slot, 'ultra')) ? 'saiu-ultra' : 'sem-efeito';
    }
    return 'ja-fora';
  }

  /**
   * O clique ja foi dado: o jogo saiu do modo? O handler pode ser assincrono,
   * entao da alguns tiques antes de desistir (o jogo roda em 60 fps e o
   * clique entra na proxima volta do event loop).
   */
  async confirmouSaida(slot, modo) {
    const wc = slot.view?.webContents;
    if (!wc || wc.isDestroyed()) return false;
    for (let i = 0; i < 5; i += 1) {
      const estado = await wc.executeJavaScript(LIGHT_EM_ECONOMIA, true).catch(() => 'erro');
      if (estado !== modo) return true;
      await new Promise((r) => setTimeout(r, 300));
    }
    return false;
  }

  /**
   * Junta a preferencia lembrada com a que acabou de ser lida. Uma
   * preferencia lembrada NUNCA volta de '1' para '0': o botao do jogo zera a
   * chave ao sair, e isso nao e escolha do usuario.
   */
  static juntaPreferencias(lembrada, nova) {
    if (!lembrada && !nova) return null;
    const memoria = lembrada ?? {};
    const prefs = {
      economia: memoria.economia === true || nova?.economia === true,
      ultra: memoria.ultra === true || nova?.ultra === true,
    };
    return prefs.economia || prefs.ultra ? prefs : null;
  }

  /**
   * Liga o modo leve nesta sessao SEM recarregar a pagina:
   *  1. lembra a preferencia do usuario (ela vive no localStorage da pagina);
   *  2. se o jogo estiver em Economia/Ultra, sai pelo botao do jogo;
   *  3. aplica o CSS + o limite de rAF na hora.
   *
   * Se o botao nao resolver (sem botao, ou o clique nao agiu), quem decide
   * o fallback (preferencia + reload) e o main — aqui a gente nao finge que
   * ligou: devolve o que aconteceu.
   */
  async enable(slot) {
    return this.queue(slot, async () => {
      const gen = this.begin(slot);
      slot.lightMode = true;
      slot.lightReloadAt = 0;
      const wc = slot.view.webContents;
      if (wc.isDestroyed()) {
        slot.lightMode = false;
        return { ok: false, motivo: 'sessao-morta' };
      }
      if (!/^https?:/i.test(wc.getURL())) return { ok: true, motivo: 'sem-pagina' };

      // 1. preferencia do usuario, lembrada ANTES de qualquer clique
      const prefs = await this.lerPreferenciaDoUsuario(slot);
      if (prefs) {
        slot.prefsEconomiaDoUsuario = LightMode.juntaPreferencias(slot.prefsEconomiaDoUsuario, prefs);
      }

      // 2. sai do Economia/Ultra pelo botao do jogo (sem reload)
      const estado = await wc.executeJavaScript(LIGHT_EM_ECONOMIA, true).catch(() => 'erro');
      if (estado === 'economia' || estado === 'ultra') {
        const saiu = await this.sairDoEconomiaPeloJogo(slot);
        if (this.stale(slot, wc, gen)) return { ok: true, motivo: 'stale' };
        if (saiu !== 'saiu-economia' && saiu !== 'saiu-ultra') {
          // Ultimo recurso: sem o botao do jogo nao ha como pedir o campo de
          // volta sem recarregar. A preferencia do usuario ja esta guardada
          // (passo 1), entao o restore continua funcionando depois.
          const off = await wc.executeJavaScript(LIGHT_PREFS_OFF, true).catch(() => false);
          if (off) {
            slot.lightReloadAt = Date.now();
            wc.reload();
            console.error(
              `[${slot.id}] modo leve: botao do jogo indisponivel (${saiu}); recarregando como ultimo recurso`
            );
            return { ok: true, motivo: 'fallback-reload' };
          }
          console.error(`[${slot.id}] modo leve: nao consegui sair pelo botao do jogo (${saiu})`);
          return { ok: false, motivo: saiu };
        }
        console.info(
          `[${slot.id}] modo leve: saiu do Modo ${estado === 'ultra' ? 'ULTRA' : 'Economia'} pelo botao do jogo (sem recarregar)`
        );
      }

      // 3. aplica o modo leve (CSS + rAF) agora
      const applied = await this.applyNow(slot);
      if (!applied) return { ok: false, motivo: 'rAF-nao-confirmado' };
      return { ok: true, motivo: 'ligado' };
    });
  }

  /**
   * Desliga sem recarregar: devolve o rAF original, remove o CSS injetado e
   * **restaura a preferencia do usuario** (Economia/Ultra) — mas so quando
   * ninguem mais precisa do campo, isto e, quando nao ha AUTO nem rota rodando.
   * Com AUTO/rota no meio, a restauracao fica **pendente** (nao e esquecida):
   * quem consome e o stop() do AUTO/rota.
   *
   * Devolve 'restaurado' | 'adiado' | 'nada-a-restaurar' | 'falhou' — nao um
   * booleano que mentiria sobre o que aconteceu com a configuracao do usuario.
   */
  async disable(slot, { campoEmUso = false } = {}) {
    return this.queue(slot, async () => {
      this.begin(slot);
      slot.lightMode = false;
      slot.lightApplied = false;
      slot.lightFailed = false;
      const wc = slot.view.webContents;
      if (wc.isDestroyed()) {
        slot.lightCssKey = null;
        return { ok: true, restauracao: 'nada-a-restaurar' };
      }
      const key = slot.lightCssKey;
      slot.lightCssKey = null;
      let ok = true;
      if (key) {
        try {
          await wc.removeInsertedCSS(key);
        } catch (err) {
          ok = false;
          console.error(`[${slot.id}] modo leve: nao consegui remover o CSS:`, err.message);
        }
      }
      try {
        await wc.executeJavaScript(LIGHT_RESTORE, true);
      } catch (err) {
        ok = false;
        console.error(`[${slot.id}] modo leve: nao consegui restaurar o rAF:`, err.message);
      }
      this.onChange?.(slot);
      if (!ok) {
        // A limpeza falhou: a preferencia do usuario nao pode ser perdida
        // junto. Fica PENDENTE para o proximo momento em que o campo nao for
        // preciso (mesmo caminho do AUTO/rota rodando).
        slot.prefsEconomiaPendente = LightMode.juntaPreferencias(
          slot.prefsEconomiaPendente,
          slot.prefsEconomiaDoUsuario
        );
        return { ok: false, restauracao: 'adiado' };
      }
      const restauracao = await this.restaurarPreferenciaDoUsuario(slot, { adiar: campoEmUso });
      slot.lightRestauracao = restauracao;
      this.onChange?.(slot);
      return { ok: true, restauracao };
    });
  }

  /**
   * Religa a preferencia que o usuario tinha (Economia/Ultra) depois que o
   * modo leve acabou. Com AUTO/rota rodando o campo ainda e preciso: a
   * restauracao fica pendente e quem a faz e o stop() do AUTO/rota.
   *
   * Nao sobrescreve uma escolha mais nova do usuario: se a pagina ja esta com
   * a preferencia ligada, nao ha o que restaurar.
   *
   * CHAMADA DE DENTRO DA FILA (o disable ja e serializado): nao enfileira
   * aqui, senao a fila esperaria por ela mesma.
   */
  async restaurarPreferenciaDoUsuario(slot, { adiar = false } = {}) {
    const prefs = LightMode.juntaPreferencias(slot.prefsEconomiaDoUsuario, slot.prefsEconomiaPendente);
    if (!prefs) return 'nada-a-restaurar';
    if (adiar) {
      // pendente nunca e rebaixada: so Some quando ela for restaurada
      slot.prefsEconomiaPendente = LightMode.juntaPreferencias(slot.prefsEconomiaPendente, prefs);
      console.info(
        `[${slot.id}] modo leve: preferencia do usuario guardada para restaurar quando o AUTO/rota pararem`
      );
      return 'adiado';
    }
    const wc = slot.view?.webContents;
    if (!wc || wc.isDestroyed() || !/^https?:/i.test(wc.getURL())) return 'falhou';
    const atual = await wc.executeJavaScript(LIGHT_PREFS_READ, true).catch(() => null);
    if (!atual) return 'falhou';
    let feito = true;
    if (prefs.economia && atual.economia !== true) {
      const r = await wc.executeJavaScript(LIGHT_LIGAR_ECONOMIA, true).catch(() => 'erro');
      if (r !== 'ok') feito = false;
    }
    if (prefs.ultra && atual.ultra !== true) {
      const r = await wc.executeJavaScript(LIGHT_LIGAR_ULTRA, true).catch(() => 'erro');
      if (r !== 'ok') feito = false;
    }
    if (!feito) {
      console.error(`[${slot.id}] modo leve: nao consegui religar a preferencia do usuario`);
      slot.prefsEconomiaPendente = LightMode.juntaPreferencias(slot.prefsEconomiaPendente, prefs);
      return 'falhou';
    }
    // confirma: a preferencia realmente voltou? (o clique pode nao agir)
    const depois = await wc.executeJavaScript(LIGHT_PREFS_READ, true).catch(() => null);
    if (depois && ((prefs.economia && !depois.economia) || (prefs.ultra && !depois.ultra))) {
      console.error(`[${slot.id}] modo leve: o clique nao religou a preferencia do usuario`);
      slot.prefsEconomiaPendente = LightMode.juntaPreferencias(slot.prefsEconomiaPendente, prefs);
      return 'falhou';
    }
    slot.prefsEconomiaDoUsuario = null;
    slot.prefsEconomiaPendente = null;
    console.info(`[${slot.id}] modo leve: preferencia do usuario restaurada`);
    return 'restaurado';
  }

  /**
   * Consome a restauracao pendente — chamado quando o AUTO/rota param e o
   * campo deixa de ser preciso. Passa pela fila da sessao: mexer no jogo
   * enquanto um toggle esta em andamento seria mexer em dois estados.
   */
  async restaurarPreferenciaAposPararDoAUTO(slot) {
    if (!slot.prefsEconomiaPendente) return 'nada-a-restaurar';
    // Com o modo leve LIGADO, o jogo esta fora do Economia de proposito:
    // religar agora brigaria com a vigia (que sairia de novo em 20 s) e o
    // botao do jogo zeraria a preferencia de novo. A pendencia espera.
    if (slot.lightMode === true) return 'adiado';
    return this.queue(slot, async () => {
      if (!slot.prefsEconomiaPendente) return 'nada-a-restaurar';
      slot.prefsEconomiaDoUsuario = LightMode.juntaPreferencias(
        slot.prefsEconomiaDoUsuario,
        slot.prefsEconomiaPendente
      );
      return this.restaurarPreferenciaDoUsuario(slot, { adiar: false });
    });
  }

  /**
   * Reaplica num carregamento novo (o CSS e o patch de rAF sao por documento).
   * Se o jogo voltou para Economia/Ultra, sai pelo botao do jogo — sem
   * recarregar. O reload com preferencia zerada e o ultimo recurso (com trava
   * de 10 s para o caso de o jogo reescrever a preferencia em loop).
   */
  async sync(slot) {
    if (!slot.lightMode) return;
    return this.queue(slot, async () => {
      const gen = slot.lightGen ?? 0;
      const wc = slot.view.webContents;
      if (wc.isDestroyed() || !/^https?:/i.test(wc.getURL())) return;
      const estado = await wc.executeJavaScript(LIGHT_EM_ECONOMIA, true).catch(() => 'erro');
      if (this.stale(slot, wc, gen)) return;
      if (estado === 'economia' || estado === 'ultra') {
        // primeira vez que esta sessao e tocada com o modo leve ligado (o
        // launcher pode ter reiniciado): guarda a preferencia do usuario antes
        // de o jogo zera a chave. Uma preferencia ja lembrada NUNCA volta de
        // '1' para '0' — religar a economia e escolha do usuario.
        const prefs = await this.lerPreferenciaDoUsuario(slot);
        if (prefs) {
          slot.prefsEconomiaDoUsuario = LightMode.juntaPreferencias(slot.prefsEconomiaDoUsuario, prefs);
        }
        const saiu = await this.sairDoEconomiaPeloJogo(slot);
        if (this.stale(slot, wc, gen)) return;
        if (saiu !== 'saiu-economia' && saiu !== 'saiu-ultra') {
          // ultimo recurso: preferencia zerada + reload (com trava de 10 s)
          const now = Date.now();
          const off = await wc.executeJavaScript(LIGHT_PREFS_OFF, true).catch(() => false);
          if (!off) {
            console.error(`[${slot.id}] modo leve: localStorage recusou desligar Economia/Ultra`);
          } else if (!slot.lightReloadAt || now - slot.lightReloadAt >= 10_000) {
            slot.lightReloadAt = now;
            wc.reload();
            return;
          } else {
            console.error(`[${slot.id}] modo leve: Economia/Ultra voltou; modo mantido e a vigia sai pela cena`);
          }
        }
      }
      await this.applyNow(slot);
    });
  }

  async applyNow(slot) {
    const gen = slot.lightGen ?? 0;
    const wc = slot.view.webContents;
    if (wc.isDestroyed() || !slot.lightMode) return false;
    const oldKey = slot.lightCssKey;
    slot.lightCssKey = null;
    if (oldKey) {
      try {
        await wc.removeInsertedCSS(oldKey);
      } catch (err) {
        console.error(`[${slot.id}] modo leve: nao consegui remover o CSS anterior:`, err.message);
      }
    }
    if (this.stale(slot, wc, gen)) return false;
    let cssKey = null;
    try {
      cssKey = await wc.insertCSS(LIGHT_CSS, { cssOrigin: 'user' });
      if (this.stale(slot, wc, gen)) {
        await wc.removeInsertedCSS(cssKey).catch(() => {});
        return false;
      }
      slot.lightCssKey = cssKey;
    } catch (err) {
      console.error(`[${slot.id}] modo leve css:`, err.message);
    }
    try {
      let res = await wc.executeJavaScript(LIGHT_APPLY, true);
      let ok = await wc.executeJavaScript(LIGHT_VERIFY, true).catch(() => false);
      if (ok !== true) {
        await wc.executeJavaScript(LIGHT_REAPPLY, true).catch(() => {});
        res = await wc.executeJavaScript(LIGHT_APPLY, true);
        ok = await wc.executeJavaScript(LIGHT_VERIFY, true).catch(() => false);
      }
      if (this.stale(slot, wc, gen)) return false;
      slot.lightApplied = ok === true;
      slot.lightFailed = !slot.lightApplied;
      if (!slot.lightApplied) {
        console.error(`[${slot.id}] modo leve: rAF nao confirmado (${res})`);
      }
    } catch (err) {
      console.error(`[${slot.id}] modo leve rAF:`, err.message);
      slot.lightApplied = false;
      slot.lightFailed = true;
    }
    if (!slot.lightApplied && cssKey) {
      // Sem limitar o rAF, esconder a cena só tira o feedback e deixa o custo
      // de desenho: desfaz o CSS para não ficar no pior dos dois mundos.
      await wc.removeInsertedCSS(cssKey).catch(() => {});
      if (slot.lightCssKey === cssKey) slot.lightCssKey = null;
    }
    this.onChange?.(slot);
    return slot.lightApplied;
  }

  /**
   * Vigia o modo do jogo: se ele voltar para Economia/Ultra pelo menu dele,
   * o servidor para de mandar `campo` e o AUTO fica sem alvo. A volta e pelo
   * botao da cena — o proprio jogo avisa o servidor quando sai. De quebra
   * confere se o patch de rAF ainda e o nosso (a remontagem da cena nao o
   * quebra; um reload sim, e o sync cobre isso).
   */
  async watch(slot) {
    if (!slot.lightMode) return 'off';
    const wc = slot.view.webContents;
    if (wc.isDestroyed() || !/^https?:/i.test(wc.getURL())) return 'off';
    // pela fila: a reaplicacao do CSS/rAF nao pode correr ao lado de um
    // toggle (duas aplicacoes brigariam pela chave do CSS injetado).
    return this.queue(slot, async () => {
      if (!slot.lightMode) return 'off';
      const gen = slot.lightGen ?? 0;
      const res = await wc.executeJavaScript(LIGHT_WATCH, true).catch(() => 'error');
      if (res === 'exit-economy' || res === 'exit-ultra') {
        const nome = res === 'exit-economy' ? 'Modo Economia' : 'Modo ULTRA Economia';
        console.info(`[${slot.id}] modo leve: saiu do ${nome} para o campo continuar chegando`);
      }
      if (res !== 'error' && !this.stale(slot, wc, gen)) {
        const ok = await wc.executeJavaScript(LIGHT_VERIFY, true).catch(() => false);
        if (ok !== true && !this.stale(slot, wc, gen)) {
          await this.applyNow(slot);
        }
      }
      return res;
    });
  }

}
