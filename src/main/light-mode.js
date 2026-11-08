import {
  LIGHT_APPLY,
  LIGHT_CSS,
  LIGHT_PREFS_OFF,
  LIGHT_PREFS_ON,
  LIGHT_REAPPLY,
  LIGHT_RESTORE,
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
   * Liga o modo leve nesta sessão. Se o jogo estiver em Economia/Ultra (a
   * preferência vive no localStorage), zera e recarrega para ele relembrar a
   * escolha; se já estiver fora, aplica na hora — recarregar sem necessidade
   * só atrapalha quem está caçando. O CSS + o limite de rAF entram no próprio
   * documento ou no próximo `did-finish-load`.
   */
  async enable(slot) {
    return this.queue(slot, async () => {
      const gen = this.begin(slot);
      slot.lightMode = true;
      slot.lightReloadAt = 0;
      const wc = slot.view.webContents;
      if (wc.isDestroyed()) {
        slot.lightMode = false;
        return false;
      }
      if (!/^https?:/i.test(wc.getURL())) return true;
      const dirty = await wc.executeJavaScript(LIGHT_PREFS_ON, true).catch(() => false);
      if (this.stale(slot, wc, gen)) return true;
      if (!dirty) return this.applyNow(slot);
      const off = await wc.executeJavaScript(LIGHT_PREFS_OFF, true).catch(() => false);
      if (this.stale(slot, wc, gen)) return true;
      if (!off) {
        console.error(`[${slot.id}] modo leve: localStorage recusou desligar Economia/Ultra`);
        return false;
      }
      wc.reload();
      return true;
    });
  }

  /** Desliga sem recarregar: devolve o rAF original e remove o CSS injetado. */
  async disable(slot) {
    return this.queue(slot, async () => {
      this.begin(slot);
      slot.lightMode = false;
      slot.lightApplied = false;
      slot.lightFailed = false;
      const wc = slot.view.webContents;
      if (wc.isDestroyed()) {
        slot.lightCssKey = null;
        return true;
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
      return ok;
    });
  }

  /**
   * Reaplica num carregamento novo. Se o jogo voltou para Economia/Ultra (a
   * preferência vive no localStorage), zera e recarrega — com uma trava de
   * 10 s para o caso de o jogo reescrever a preferência em loop. Dentro da
   * trava, sai pela cena (é o jogo que avisa o servidor) e segue aplicando.
   */
  async sync(slot) {
    if (!slot.lightMode) return;
    return this.queue(slot, async () => {
      const gen = slot.lightGen ?? 0;
      const wc = slot.view.webContents;
      if (wc.isDestroyed() || !/^https?:/i.test(wc.getURL())) return;
      const dirty = await wc.executeJavaScript(LIGHT_PREFS_ON, true).catch(() => false);
      if (this.stale(slot, wc, gen)) return;
      if (dirty) {
        const now = Date.now();
        const off = await wc.executeJavaScript(LIGHT_PREFS_OFF, true).catch(() => false);
        if (this.stale(slot, wc, gen)) return;
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
   * o servidor para de mandar `campo` e o AUTO fica sem alvo. A volta é pelo
   * botão da cena — o próprio jogo avisa o servidor quando sai.
   */
  async watch(slot) {
    if (!slot.lightMode) return 'off';
    const wc = slot.view.webContents;
    if (wc.isDestroyed() || !/^https?:/i.test(wc.getURL())) return 'off';
    const res = await wc.executeJavaScript(LIGHT_WATCH, true).catch(() => 'error');
    if (res === 'exit-economy' || res === 'exit-ultra') {
      const nome = res === 'exit-economy' ? 'Modo Economia' : 'Modo ULTRA Economia';
      console.log(`[${slot.id}] modo leve: saiu do ${nome} para o campo continuar chegando`);
    }
    return res;
  }

}
