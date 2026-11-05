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
  constructor({ getSlot, persist, sendToSlot, log = console.error } = {}) {
    this.getSlot = getSlot;
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
    slot.automation = next;
    await this.persist();
    this.sendToSlot(slotId, { config: next });
    this.log(`[automation] ${slotId}: ${next.enabled ? `ativado (${next.mode})` : 'desativado'}`);
    return { ok: true, config: next };
  }

  async stopAll() {
    for (const [slotId] of this.status) {
      this.sendToSlot(slotId, { config: { ...this.configFor(slotId), enabled: false } });
    }
    this.status.clear();
    this.log('[automation] parada geral executada');
  }

  reportStatus(slotId, payload) {
    if (!slotId) return;
    this.status.set(slotId, payload);
  }

  runningSlots() {
    return [...this.status.entries()].filter(([, s]) => s?.running).map(([id]) => id);
  }
}
