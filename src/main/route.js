/**
 * Controlador da rota "capturar um por um" (Fase 10) no processo principal.
 * Decide QUANDO pode ligar (consentimento explicito + dex lida) e PARA em
 * evento real: o delta da dex (`dexMud` visto pelo hook) confirma a captura do
 * alvo atual — nada de adivinhar por texto. A viagem e os cliques ficam no
 * motor da pagina (`src/shared/route.js`); aqui so fila, gate e verdade.
 */

import { catalogMissing } from './hunt-report.js';
import { buildRoute } from './hunt-route.js';

export const ROUTE_RISK_TEXT = [
  'A rota viaja SOZINHA pelo mapa. No modo normal, tambem arremessa bolas ate capturar cada especie que falta na sua dex; no modo VIP, aguarda a captura feita pelo jogo.',
  'Automatizar viola os Termos de Uso do PokeIdle e pode resultar em ban permanente desta conta.',
  'No modo normal, capturar e caro: a taxa por arremesso e baixa e a rota pode zerar suas bolas.',
  'A rota depende da leitura da dex ligada (extensao local so-leitura) — o queue vem dela.',
].join(' ');

const MAX_SEND_TARGETS = 500;

export class RouteController {
  /**
   * `onChange(slotId)` — o slot que mudou. Quem chama precisa saber qual
   * sessao parou: a rota que acaba sozinha (sem bolas) tambem libera o campo,
   * e a preferencia de Economia/Ultra do usuario pode voltar.
   */
  constructor({ getSlot, getHuntState, sendToSlot, log = console.error, onChange = () => {} } = {}) {
    this.getSlot = getSlot;
    this.getHuntState = getHuntState;
    this.sendToSlot = sendToSlot;
    this.log = log;
    this.onChange = onChange;
    this.active = new Map();
  }

  isActiveRunning(slotId) {
    const run = this.active.get(slotId);
    return Boolean(run?.running);
  }

  publicState(slotId) {
    const run = this.active.get(slotId);
    if (!run) return null;
    return {
      running: run.running,
      state: run.state,
      index: run.index,
      total: run.targets.length,
      targetNome: run.targets[run.index]?.nome ?? null,
      throws: run.throws,
      captured: run.captured,
      balls: run.balls,
      manualCapture: run.manualCapture,
      startedAt: run.startedAt,
    };
  }

  async start(slotId, opts = {}) {
    const slot = this.getSlot(slotId);
    if (!slot) return { ok: false, error: 'sessao inexistente' };
    if (opts.ackRisk !== true) return { ok: false, error: 'confirme o risco para ligar a rota' };
    if (this.isActiveRunning(slotId)) return { ok: false, error: 'a rota ja esta rodando nesta sessao' };
    const st = this.getHuntState(slotId);
    if (!st?.ready || !st.enabled) {
      return { ok: false, error: 'ligue a leitura da dex nesta sessao antes de rodar a rota' };
    }
    const miss = catalogMissing(st, { limit: MAX_SEND_TARGETS, levelCap: opts.levelCap === false ? null : st.level });
    const { targets } = buildRoute(miss.items, { ordem: opts.ordem || 'facil', maxAlvos: opts.maxAlvos || 3 });
    if (!targets.length) return { ok: false, error: 'nada faltando para capturar com esses filtros' };
    const slim = targets.map((t) => ({ pokeId: t.pokeId, slug: t.slug, nome: t.nome }));
    const config = {
      enabled: true,
      targets: slim,
      currentHuntSlug: st.huntSlug || null,
      gerenciaEconomia: opts.gerenciaEconomia === true,
      maxBolas: opts.maxBolas,
      manualCapture: opts.manualCapture === true,
    };
    this.active.set(slotId, {
      running: true,
      state: 'partindo',
      index: 0,
      targets: slim,
      currentHuntSlug: st.huntSlug || null,
      baselineC: this.baselineFor(st, slim[0]),
      // Especies ja confirmadas nesta corrida: as DUAS fontes de confirmacao
      // (evento de captura e delta da dex) podem chegar e nao podem fazer a
      // fila pular dois alvos.
      confirmados: new Set(),
      throws: 0,
      captured: 0,
      manualCapture: opts.manualCapture === true,
      balls: st.balls ? Object.values(st.balls).reduce((s, n) => s + (Number(n) || 0), 0) : null,
      startedAt: Date.now(),
      lastPayload: { config, pack: opts.pack || {} },
    });
    this.sendToSlot(slotId, 'route:config', this.active.get(slotId).lastPayload);
    this.log(`[route] ${slotId}: ligada (${slim.length} alvos, ordem ${opts.ordem || 'facil'}, modo ${opts.manualCapture ? 'VIP' : 'arremesso'})`);
    this.onChange();
    return { ok: true, targets: slim.length };
  }

  /**
   * Reload/SPA-nav apaga a maquina da pagina (o preload re-instala so o motor,
   * nao a corrida): o wireAddonPack chama isto no dom-ready de uma view com
   * rota viva, e o tick continua de onde estava a fila no main.
   */
  resend(slotId) {
    const run = this.active.get(slotId);
    if (!run?.running || !run.lastPayload) return false;
    this.sendToSlot(slotId, 'route:config', run.lastPayload);
    return true;
  }

  async stop(slotId, reason = 'parado') {
    const run = this.active.get(slotId);
    if (!run?.running) return { ok: false, error: 'sem rota rodando' };
    run.running = false;
    run.state = reason;
    run.lastPayload = null; // dom-ready posterior nao deve reanimar o que foi parado
    this.sendToSlot(slotId, 'route:cmd', { action: 'stop', reason });
    this.log(`[route] ${slotId}: parada (${reason})`);
    this.onChange(slotId);
    return { ok: true };
  }

  async stopAll() {
    for (const slotId of [...this.active.keys()]) {
      if (this.active.get(slotId)?.running) await this.stop(slotId, 'parada-geral');
    }
  }

  clear(slotId) {
    this.active.delete(slotId);
  }

  baselineFor(st, target) {
    return st?.dex?.[String(target?.pokeId)]?.c ?? 0;
  }

  /**
   * Confirma a captura do alvo ATUAL e manda a pagina avancar. Idempotente
   * por especie: quem chama (delta da dex OU evento de captura) pode chamar
   * duas vezes pela MESMA captura — a fila nao pode pular um alvo.
   */
  confirmarCaptura(slotId, run, t) {
    if (!run || !t) return false;
    if (run.confirmados?.has(t.pokeId)) return false;
    if (!run.confirmados) run.confirmados = new Set();
    run.confirmados.add(t.pokeId);
    run.captured += 1;
    const st = this.getHuntState(slotId);
    run.baselineC = this.baselineFor(st, t);
    this.sendToSlot(slotId, 'route:cmd', { action: 'advance', currentHuntSlug: run.currentHuntSlug });
    this.log(`[route] ${slotId}: capturou ${t.nome} (${run.captured}/${run.targets.length})`);
    this.onChange(slotId);
    return true;
  }

  /**
   * Chamado a cada ingestion do hunt:state. Confirma a captura do alvo ATUAL
   * pelo delta real da dex e manda a pagina avancar; no modo de arremesso,
   * para a rota se as bolas zerarem (e fisico, nao escolha).
   */
  onHuntUpdate(slotId, st) {
    const run = this.active.get(slotId);
    if (!run?.running || !st) return;
    run.currentHuntSlug = typeof st.huntSlug === 'string' ? st.huntSlug : null;
    const t = run.targets[run.index];
    if (t) {
      const c = st.dex?.[String(t.pokeId)]?.c ?? 0;
      const confirmado = run.confirmados?.has(t.pokeId);
      if (!confirmado && c > (run.baselineC ?? 0)) {
        this.confirmarCaptura(slotId, run, t);
      } else if (!confirmado && st.huntSlug === t.slug) {
        this.sendToSlot(slotId, 'route:cmd', { action: 'arrived', slug: t.slug });
      }
    }
    const totalBolas = Object.values(st.balls ?? {}).reduce((s, v) => s + (Number(v) || 0), 0);
    if (!run.manualCapture && Object.keys(st.balls ?? {}).length && totalBolas <= 0) {
      this.stop(slotId, 'sem-bolas');
    }
  }

  /**
   * Evento real de captura do servidor (`batalha` -> `capturado`), com a
   * especie. Confirma na hora — sem esperar o delta da dex — e sem pular
   * alvo quando a mesma captura chega pelas DUAS fontes.
   */
  onCapture(slotId, data) {
    const run = this.active.get(slotId);
    if (!run?.running || !data) return;
    const speciesId = Number(data?.speciesId);
    if (!Number.isInteger(speciesId) || speciesId <= 0) return;
    const t = run.targets[run.index];
    if (!t || t.pokeId !== speciesId) return;
    this.confirmarCaptura(slotId, run, t);
  }

  /** Status que vem da pagina (motor route.js). O index da pagina manda. */
  onStatus(slotId, msg) {
    const run = this.active.get(slotId);
    if (!run || !msg || typeof msg !== 'object') return;
    const idx = Number.isInteger(msg.index) ? Math.max(0, Math.min(msg.index, run.targets.length - 1)) : run.index;
    if (idx !== run.index) {
      run.index = idx;
      const st = this.getHuntState(slotId);
      run.baselineC = this.baselineFor(st, run.targets[idx]);
      if (run.currentHuntSlug === run.targets[idx]?.slug) {
        this.sendToSlot(slotId, 'route:cmd', { action: 'arrived', slug: run.targets[idx].slug });
      }
    }
    if (Number.isFinite(msg.throws)) run.throws = msg.throws;
    if (Number.isFinite(msg.captured)) run.captured = msg.captured;
    // o balls vem da PAGINA (le o titulo da bola selecionada no DOM): o
    // espelho do welcome congela porque o jogo nao manda balls nos deltas.
    if (Number.isFinite(msg.balls)) run.balls = msg.balls;
    if (typeof msg.state === 'string' && msg.state.length <= 40) run.state = msg.state;
    if (msg.running === false) {
      // A maquina pode acabar sozinha (falha-chegada, alvo-nao-localizado,
      // limite-arremessos, sem-bolas, fila-completa): sem este log a corrida
      // morria em silencio e o arquivo ficava so com "ligada".
      if (run.running) this.log(`[route] ${slotId}: maquina parou (${msg.state || 'sem-estado'}) no alvo ${run.index + 1}/${run.targets.length}`);
      run.running = false;
    }
    this.onChange(slotId);
  }
}
