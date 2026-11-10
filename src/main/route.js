/**
 * Controlador da rota "capturar um por um" (Fase 10) no processo principal.
 * Decide QUANDO pode ligar (consentimento explicito + dex lida) e PARA em
 * evento real: o delta da dex (`dexMud` visto pelo hook) confirma a captura do
 * alvo atual — nada de adivinhar por texto. A EXECUCAO (cliques) fica no
 * motor da pagina (`src/shared/route.js`); aqui so fila, gate e verdade.
 */

import { catalogMissing } from './hunt-report.js';
import { buildRoute } from './hunt-route.js';

export const ROUTE_RISK_TEXT = [
  'A rota viaja SOZINHA pelo mapa e arremessa bolas ate capturar cada especie que falta na sua dex.',
  'Automatizar viola os Termos de Uso do PokeIdle e pode resultar em ban permanente desta conta.',
  'Capturar e caro: a taxa por arremesso e baixa e, sem teto, a rota pode zerar suas bolas.',
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
      maxTempoMs: opts.maxTempoMs,
      maxBolas: opts.maxBolas,
    };
    this.active.set(slotId, {
      running: true,
      state: 'partindo',
      index: 0,
      targets: slim,
      baselineC: this.baselineFor(st, slim[0]),
      throws: 0,
      captured: 0,
      balls: st.balls ? Object.values(st.balls).reduce((s, n) => s + (Number(n) || 0), 0) : null,
      startedAt: Date.now(),
      lastPayload: { config, pack: opts.pack || {} },
    });
    this.sendToSlot(slotId, 'route:config', this.active.get(slotId).lastPayload);
    this.log(`[route] ${slotId}: ligada (${slim.length} alvos, ordem ${opts.ordem || 'facil'})`);
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
   * Chamado a cada ingestion do hunt:state. Confirma a captura do alvo ATUAL
   * pelo delta real da dex e manda a pagina avancar; para a rota se as bolas
   * zerarem (e fisico, nao escolha).
   */
  onHuntUpdate(slotId, st) {
    const run = this.active.get(slotId);
    if (!run?.running || !st) return;
    const t = run.targets[run.index];
    if (t) {
      const c = st.dex?.[String(t.pokeId)]?.c ?? 0;
      if (c > (run.baselineC ?? 0)) {
        run.captured += 1;
        run.baselineC = c;
        this.sendToSlot(slotId, 'route:cmd', { action: 'advance' });
        this.log(`[route] ${slotId}: capturou ${t.nome} (${run.captured}/${run.targets.length})`);
        // o proximo alvo ganha baseline quando a pagina reportar o novo index
        this.onChange(slotId);
      }
    }
    const totalBolas = Object.values(st.balls ?? {}).reduce((s, v) => s + (Number(v) || 0), 0);
    if (Object.keys(st.balls ?? {}).length && totalBolas <= 0) {
      this.stop(slotId, 'sem-bolas');
    }
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
    }
    if (Number.isFinite(msg.throws)) run.throws = msg.throws;
    if (Number.isFinite(msg.captured)) run.captured = msg.captured;
    // o balls vem da PAGINA (le o titulo da bola selecionada no DOM): o
    // espelho do welcome congela porque o jogo nao manda balls nos deltas.
    if (Number.isFinite(msg.balls)) run.balls = msg.balls;
    if (typeof msg.state === 'string' && msg.state.length <= 40) run.state = msg.state;
    if (msg.running === false) run.running = false;
    this.onChange(slotId);
  }
}
