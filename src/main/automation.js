import { parseAutomation } from './store.js';

export const RISK_TEXT = [
  'Automatizar lancamentos viola os Termos de Uso do PokeIdle e pode resultar em ban permanente desta conta.',
  'O launcher nao promete evitar deteccao: o jitter reduz padroes, mas nao garante nada.',
  'Voce pode perder acesso a contas, itens e progresso. A decisao e sua.',
].join(' ');

export function canEnable(config) {
  return config?.consent === true;
}

export function sanitizeAutomation(raw) {
  return parseAutomation(raw);
}

export class AutomationController {
  constructor({ getSlot, getAllSlots, persist, sendToSlot, log = console.error } = {}) {
    this.getSlot = getSlot;
    this.getAllSlots = getAllSlots;
    this.persist = persist;
    this.sendToSlot = sendToSlot;
    this.log = log;
    this.status = new Map();
  }

  configFor(slotId) {
    const slot = this.getSlot(slotId);
    return slot?.automation ?? parseAutomation(null);
  }

  async setConfig(slotId, raw) {
    const slot = this.getSlot(slotId);
    if (!slot) return { ok: false, error: 'sessao inexistente' };
    if (raw?.enabled === true && raw?.consent !== true) {
      return { ok: false, error: 'e necessario confirmar o risco explicitamente' };
    }
    const next = sanitizeAutomation(raw);
    if (next.enabled && !canEnable(next)) {
      return { ok: false, error: 'e necessario confirmar o risco explicitamente' };
    }
    if (!next.enabled) next.consent = false;
    await this.persistWith(slot, next);
    this.sendToSlot(slotId, { config: next });
    this.log(`[automation] ${slotId}: ${next.enabled ? `ativado (${next.mode})` : 'desativado'}`);
    return { ok: true, config: next };
  }

  async persistWith(slot, config) {
    const previous = slot.automation;
    slot.automation = config;
    try {
      await this.persist();
    } catch (err) {
      slot.automation = previous;
      throw err;
    }
  }

  async stopAll() {
    let changed = false;
    for (const slot of this.allSlots()) {
      if (!slot?.automation?.enabled) continue;
      slot.automation = { ...slot.automation, enabled: false, consent: false };
      slot.automationStatus = null;
      this.sendToSlot(slot.id, { config: slot.automation });
      changed = true;
    }
    this.status.clear();
    if (changed) await this.persist();
    this.log('[automation] parada geral executada');
  }

  async markStopped(slotId, reason = 'stopped') {
    const slot = this.getSlot(slotId);
    if (!slot?.automation?.enabled) return false;
    slot.automation = { ...slot.automation, enabled: false, consent: false };
    slot.automationStatus = { state: reason, running: false, throws: this.status.get(slotId)?.throws ?? 0 };
    this.sendToSlot(slotId, { config: slot.automation });
    this.log(`[automation] ${slotId}: parado (${reason})`);
    await this.persist();
    return true;
  }

  allSlots() {
    return this.getAllSlots ? this.getAllSlots() : [];
  }

  reportStatus(slotId, payload) {
    if (!slotId || !payload || typeof payload !== 'object') return;
    if (typeof payload.state !== 'string' || payload.state.length > 32) return;
    const throws = Number.isFinite(payload.throws) ? Math.max(0, Math.min(payload.throws, 1e7)) : 0;
    const ticks = Number.isFinite(payload.ticks) ? Math.max(0, Math.min(payload.ticks, 1e9)) : 0;
    const lastTickAt = Number.isFinite(payload.lastTickAt) ? payload.lastTickAt : null;
    const caidos = Number.isFinite(payload.caidos) ? Math.max(0, Math.min(payload.caidos, 1e6)) : null;
    this.status.set(slotId, {
      state: payload.state,
      running: payload.running === true,
      throws,
      ticks,
      lastTickAt,
      caidos,
    });
  }

  runningSlots() {
    return [...this.status.entries()].filter(([, s]) => s?.running).map(([id]) => id);
  }
}
