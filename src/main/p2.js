import { consumirBola, escolherBola, totalBolas } from '../shared/balls.js';

/**
 * Fase 12 (P2): arremessar bolas pelo socket com o jogo DENTRO do Modo
 * Economia. A fila, a taxa, a escolha da bola e a confirmacao moram aqui, no
 * main; o hook (mundo da pagina) so observa e atua.
 *
 * `planejarArremesso` e pura de proposito: a decisao (esperar / arremessar /
 * abortar) pode ser testada sem timers nem Electron. O controller so faz o IO.
 */
export const P2_RISK_TEXT = [
  'O P2 arremessa bolas pelo proprio socket, COM O JOGO NO MODO ECONOMIA.',
  'Ele manda ao servidor a mesma mensagem que o jogo manda ao sair do Economia — por isso o campo continua chegando com a tela parada.',
  'Isso contraria o que o site espera de um cliente: automatizar viola os Termos de Uso do PokeIdle e pode resultar em ban permanente.',
  'Gasta bolas de verdade: o orcamento e o que voce tinha no login e o motor para quando ele acaba.',
  'Enquanto o P2 estiver armado, a rota e a automacao de lancamentos ficam desligadas.',
].join(' ');

export const P2_TIMEOUT_BOLA_MS = 6_000;
export const P2_TIMEOUT_CAMPO_MS = 8_000;
export const P2_ESPERA_MS = 1_500;
export const P2_INTERVALO_MIN_MS = 2_500;
export const P2_INTERVALO_MAX_MS = 5_000;

export function planejarArremesso(run, agora) {
  if (!run || run.armado !== true) return { tipo: 'parado' };
  if (run.pendente) return { tipo: 'esperar', motivo: 'pendente' };
  if (run.gastas >= run.limite) return { tipo: 'abortar', motivo: 'limite' };
  // O primeiro frame pode levar segundos (o servidor so volta a mandar o campo
  // depois do arm): a carencia conta do ARM, nao do ultimo frame. Depois, o
  // silencio e medido do ultimo frame recebido.
  const referencia = run.campoVisto ? run.ultimoCampoEm : run.armadoEm;
  if (agora - referencia > P2_TIMEOUT_CAMPO_MS) {
    return { tipo: 'abortar', motivo: 'campo-parado' };
  }
  // O que expira antes e o alvo: um corpo que some perde o arremesso.
  let alvo = null;
  for (const m of run.mobs.values()) {
    if (!m || m.x !== true || !(m.expiraEm > agora)) continue;
    if (!alvo || m.expiraEm < alvo.expiraEm) alvo = m;
  }
  if (!alvo) return { tipo: 'esperar', motivo: 'sem-alvo' };
  const bola = escolherBola(run.bolas);
  if (bola === null) {
    return { tipo: 'abortar', motivo: totalBolas(run.bolas) > 0 ? 'bola-desconhecida' : 'sem-bolas' };
  }
  if (agora < (run.proximoEm ?? 0)) return { tipo: 'esperar', motivo: 'intervalo' };
  return { tipo: 'arremessar', slot: alvo.s, ballId: bola };
}

export class P2Controller {
  constructor({
    send = () => {},
    onRollback = () => {},
    notify = () => {},
    now = () => Date.now(),
    rand = Math.random,
    log = console,
  } = {}) {
    this.send = send;
    this.onRollback = onRollback;
    this.notify = notify;
    this.now = now;
    this.rand = rand;
    this.log = log;
    this.runs = new Map();
  }

  run(slot) {
    return slot ? this.runs.get(slot.id) ?? null : null;
  }

  isArmado(slot) {
    return slot?.p2Armado === true;
  }

  /** So o suficiente para o chip da UI; nunca o estoque de bolas. */
  publicState(slot) {
    const run = this.run(slot);
    return {
      armado: slot?.p2Armado === true,
      gastas: run?.gastas ?? 0,
      capturas: run?.capturas ?? 0,
      limite: run?.limite ?? null,
      pendente: Boolean(run?.pendente),
    };
  }

  /**
   * Arma com consentimento POR EXECUCAO (nunca persistido). O orcamento de
   * bolas vem do `welcome` (unica fonte): em Economia o seletor de bola nao e
   * renderizado, entao nao ha leitura viva do estoque.
   */
  armar(slot, { consent = false, bolas = null, maxBolas = null } = {}) {
    if (!slot) return { ok: false, error: 'sessao inexistente' };
    if (consent !== true) return { ok: false, error: 'consentimento ausente' };
    if (slot.p2Armado === true) return { ok: true, armado: true, jaArmado: true };
    if (slot.lightMode === true) {
      return { ok: false, error: 'o modo leve (P1) esta ligado: desligue antes de armar o P2' };
    }
    const estoque = { ...(bolas ?? {}) };
    const total = totalBolas(estoque);
    if (total <= 0) return { ok: false, error: 'sem bolas no login para usar como orcamento' };
    const limite = Number.isFinite(maxBolas) && maxBolas > 0
      ? Math.min(Math.floor(maxBolas), total)
      : total;
    const run = {
      slotId: slot.id,
      // A sessao pode trocar de documento no meio: o run morre com o dono.
      wcId: slot.view?.webContents?.id ?? null,
      armado: true,
      bolas: estoque,
      limite,
      gastas: 0,
      capturas: 0,
      mobs: new Map(),
      campoVisto: false,
      ultimoCampoEm: 0,
      armadoEm: this.now(),
      pendente: null,
      proximoEm: 0,
      timer: null,
      timeouts: new Set(),
    };
    this.runs.set(slot.id, run);
    slot.p2Armado = true;
    try {
      this.send(slot, { action: 'arm' });
    } catch (err) {
      this.log.error?.(`[${slot.id}] p2: arm nao chegou ao hook:`, err?.message ?? err);
      this.desarmar(slot, 'hook-inacessivel');
      return { ok: false, error: 'nao consegui falar com o hook desta sessao' };
    }
    this.notify(slot);
    this.passos(slot);
    this.log.info?.(`[${slot.id}] p2: armado com ${limite} arremessos (${total} bolas no login)`);
    return { ok: true, armado: true, total, limite };
  }

  desarmar(slot, motivo = 'pedido') {
    if (!slot) return { ok: true, gastas: 0, capturas: 0 };
    const run = this.runs.get(slot.id);
    slot.p2Armado = false;
    if (!run) return { ok: true, motivo, gastas: 0, capturas: 0 };
    run.armado = false;
    clearTimeout(run.timer);
    for (const t of run.timeouts) clearTimeout(t);
    run.timeouts.clear();
    run.pendente = null;
    this.runs.delete(slot.id);
    // Cleanup nunca pode falhar por causa do mesmo canal que ja falhou.
    try {
      this.send(slot, { action: 'disarm' });
    } catch {
      /* a view ja se foi */
    }
    this.notify(slot);
    return { ok: true, motivo, gastas: run.gastas, capturas: run.capturas };
  }

  /** O run so vale no documento em que foi armado (reload cria outro). */
  encaixaNoDocumento(slot, run) {
    const wc = slot?.view?.webContents;
    if (!wc || wc.isDestroyed()) return false;
    return run.wcId === null || wc.id === run.wcId;
  }

  onReport(slot, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.kind === 'ready') {
      // Documento novo: o arm do hook morreu junto. Se o main ainda acha que
      // esta armado, e um arm fantasma — desarma (nunca rearma sozinho).
      if (slot?.p2Armado === true && msg.armado !== true) this.abortar(slot, 'hook-ressincronizado');
      return;
    }
    const run = this.run(slot);
    if (!run || run.armado !== true) return;
    if (!this.encaixaNoDocumento(slot, run)) {
      this.desarmar(slot, 'documento-novo');
      return;
    }
    if (msg.kind === 'armado') {
      // ja havia campo antes do arm: nao ha porque esperar a carencia
      if (msg.campoVisto === true && run.campoVisto !== true) {
        run.campoVisto = true;
        run.ultimoCampoEm = this.now();
      }
      return;
    }
    if (msg.kind === 'erro') {
      // O hook recusou um comando (socket fechado, arm ausente): insistir so
      // gasta tempo — o portao devolve o Economia ao jogo.
      this.abortar(slot, `hook-erro:${String(msg.motivo || 'desconhecido').slice(0, 40)}`);
      return;
    }
    if (msg.kind === 'corpos') {
      run.campoVisto = true;
      run.ultimoCampoEm = this.now();
      const agora = this.now();
      const mobs = new Map();
      for (const m of Array.isArray(msg.mobs) ? msg.mobs : []) {
        const s = Number(m?.s);
        if (!m || !Number.isInteger(s)) continue;
        // `resta` vem em ms do relogio do SERVIDOR (o hook converteu o `xr`):
        // somar no relogio local evita comparar duas bases diferentes.
        const resta = Number(m.resta);
        mobs.set(s, {
          s,
          x: m.x === true,
          expiraEm: Number.isFinite(resta) ? agora + Math.max(0, resta) : 0,
        });
      }
      run.mobs = mobs;
      this.passos(slot);
      return;
    }
    if (msg.kind === 'bola') {
      if (!run.pendente) return;
      // Fail loud: sem `slot`/`ballId` a mensagem nao confirma NADA. Aceitar
      // um `bola` anonimo gastaria o orcamento por um evento de outro slot.
      const s = Number(msg.slot);
      if (!Number.isInteger(s) || s !== run.pendente.slot) return;
      const b = Number(msg.ballId);
      if (!Number.isInteger(b) || b !== run.pendente.ballId) return;
      const bola = run.pendente.ballId;
      run.pendente = null;
      // A bola sai do inventario do servidor no ARREMESSO, com ou sem acerto:
      // o desconto e por pedido confirmado, nao por sucesso.
      run.bolas = consumirBola(run.bolas, bola);
      run.gastas += 1;
      this.notify(slot);
      this.passos(slot);
      return;
    }
    if (msg.kind === 'capturado') {
      run.capturas += 1;
      this.notify(slot);
      this.passos(slot);
      return;
    }
    if (msg.kind === 'desarmado' && slot?.p2Armado === true) {
      this.abortar(slot, msg.motivo || 'desarmado-no-hook');
    }
  }

  passos(slot) {
    const run = this.run(slot);
    if (!run || run.armado !== true) return;
    clearTimeout(run.timer);
    run.timer = setTimeout(() => this.tick(slot), 600);
    run.timer.unref?.();
  }

  tick(slot) {
    const run = this.run(slot);
    if (!run || run.armado !== true) return;
    // O consentimento vive no SLOT (e cai no reload, no stop-all e no chip).
    // Um run que sobreviveu ao flag e orfao: nunca pode arremessar sozinho.
    if (slot?.p2Armado !== true) {
      this.desarmar(slot, 'documento-novo');
      return;
    }
    if (!this.encaixaNoDocumento(slot, run)) {
      this.desarmar(slot, 'documento-novo');
      return;
    }
    const agora = this.now();
    const plano = planejarArremesso(run, agora);
    if (plano.tipo === 'abortar') {
      this.abortar(slot, plano.motivo);
      return;
    }
    if (plano.tipo !== 'arremessar') {
      const espera = plano.motivo === 'sem-alvo' ? P2_ESPERA_MS : 800;
      run.timer = setTimeout(() => this.tick(slot), espera);
      run.timer.unref?.();
      return;
    }
    run.pendente = { slot: plano.slot, ballId: plano.ballId, at: agora };
    try {
      this.send(slot, { action: 'throw', slot: plano.slot, ballId: plano.ballId });
    } catch (err) {
      run.pendente = null;
      this.abortar(slot, `hook-erro:${String(err?.message ?? err).slice(0, 40)}`);
      return;
    }
    run.proximoEm = agora + P2_INTERVALO_MIN_MS
      + Math.floor(this.rand() * (P2_INTERVALO_MAX_MS - P2_INTERVALO_MIN_MS));
    const t = setTimeout(() => {
      run.timeouts.delete(t);
      if (!run.armado || !run.pendente || run.pendente.at !== agora) return;
      // Documento novo no meio do arremesso: nao ha o que confirmar e a pagina
      // nova nao esta no Economia por nossa causa — desarma sem rollback.
      if (slot?.p2Armado !== true || !this.encaixaNoDocumento(slot, run)) {
        this.desarmar(slot, 'documento-novo');
        return;
      }
      // Nenhum evento `bola` voltou: o servidor nao aceitou o arremesso.
      this.abortar(slot, 'arremesso-mudo');
    }, P2_TIMEOUT_BOLA_MS);
    t.unref?.();
    run.timeouts.add(t);
  }

  abortar(slot, motivo) {
    // Idempotente: sem run nao ha o que abortar (e o rollback nao pode
    // disparar duas vezes pelo mesmo gatilho).
    if (!this.runs.has(slot.id)) return;
    const resumo = this.desarmar(slot, motivo);
    this.log.error?.(
      `[${slot.id}] p2: abortado (${motivo}) apos ${resumo.gastas ?? 0} arremessos e ${resumo.capturas ?? 0} capturas`
    );
    try {
      this.onRollback(slot, motivo, resumo);
    } catch (err) {
      this.log.error?.(`[${slot.id}] p2: rollback falhou:`, err?.message ?? err);
    }
  }
}
