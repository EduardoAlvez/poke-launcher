import { WebContentsView } from 'electron';
import { computeGrid, popupBounds, TOOLBAR_H } from './layout.js';
import { installSlotExtensions } from './extensions.js';
import { registerAddonPreload } from './addons.js';
import { LIGHT_APPLY, LIGHT_CSS, LIGHT_PREFS_OFF, LIGHT_PREFS_ON, LIGHT_RESTORE } from './light.js';

const DEFAULT_URL = 'https://pokeidle.io/app';
const MAX_SLOTS = 8;

function makeView(partitionId) {
  return new WebContentsView({
    webPreferences: {
      partition: `persist:${partitionId}`,
      sandbox: true,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });
}

export class SlotRegistry {
  constructor() {
    this.slots = [];
    this.seq = 0;
    this.cols = 2;
    this.win = null;
    this.addonPreloadPath = null;
    this.closingPopups = new WeakSet();
    this.onPopupChange = null;
  }

  attachWindow(win) {
    this.win = win;
  }

  setAddonPreloadPath(preloadPath) {
    this.addonPreloadPath = preloadPath;
  }

  async add(name, url = DEFAULT_URL, { id, maxSlots = MAX_SLOTS } = {}) {
    if (this.slots.length >= maxSlots) throw new Error(`Limite de ${maxSlots} sessoes`);
    const slotId = id || `slot-${++this.seq}`;
    if (id) {
      const n = Number(id.replace('slot-', ''));
      if (Number.isFinite(n) && n > this.seq) this.seq = n;
    }
    const view = makeView(slotId);
    const slot = {
      id: slotId,
      name: name || slotId,
      url,
      view,
      popups: [],
      crashes: [],
      lightMode: false,
      lightApplied: false,
      lightCssKey: null,
    };
    view.webContents.on('render-process-gone', () => this.recreate(slot));
    view.webContents.on('did-finish-load', () => this.syncLight(slot));
    this.bindOpenHandler(slot, view);
    this.slots.push(slot);
    if (this.addonPreloadPath) {
      await registerAddonPreload(view.webContents.session, this.addonPreloadPath, url).catch((err) =>
        console.error(`[${slotId}] preload de addon:`, err.message)
      );
    }
    await installSlotExtensions(view.webContents.session, url).catch((err) =>
      console.error(`[${slotId}] extensao indisponivel:`, err.message)
    );
    if (!this.slots.includes(slot)) return slot;
    if (this.win && !this.win.isDestroyed()) {
      this.win.contentView.addChildView(view);
      view.webContents.loadURL(url);
      this.layout(this.win);
    }
    return slot;
  }

  bindOpenHandler(slot, view = slot.view) {
    view.webContents.setWindowOpenHandler(({ url }) => {
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        return { action: 'deny' };
      }
      if (!/^https?:$/.test(parsed.protocol)) return { action: 'deny' };
      if (!this.win || this.win.isDestroyed()) return { action: 'deny' };
      if (slot.popups.length >= 3) return { action: 'deny' };
      const popup = makeView(slot.id);
      slot.popups.push(popup);
      popup.webContents.on('render-process-gone', () => this.closePopup(slot, popup));
      popup.webContents.on('close', () => this.closePopup(slot, popup));
      popup.webContents.once('destroyed', () => this.closePopup(slot, popup));
      popup.webContents.on('before-input-event', (event, input) => {
        if (input.type === 'keyDown' && input.key === 'Escape') {
          event.preventDefault();
          this.closePopup(slot, popup);
        }
      });
      this.bindOpenHandler(slot, popup);
      this.win.contentView.addChildView(popup);
      popup.webContents.loadURL(parsed.href);
      this.layout(this.win);
      this.onPopupChange?.(slot);
      return { action: 'deny' };
    });
  }

  closePopup(slot, popup) {
    if (!popup || this.closingPopups.has(popup)) return;
    this.closingPopups.add(popup);
    const i = slot.popups.indexOf(popup);
    if (i !== -1) slot.popups.splice(i, 1);
    if (this.win && !this.win.isDestroyed() && this.win.contentView.children.includes(popup)) {
      this.win.contentView.removeChildView(popup);
    }
    if (!popup.webContents.isDestroyed()) popup.webContents.close();
    if (this.win && !this.win.isDestroyed()) this.layout(this.win);
    this.onPopupChange?.(slot);
  }

  /**
   * Liga o modo leve nesta sessão: tira o jogo de Economia/Ultra (senão o
   * servidor para de mandar `campo`) e recarrega para ele relembrar a escolha.
   * O CSS + o limite de rAF entram no próximo `did-finish-load`.
   */
  async enableLight(slot) {
    slot.lightMode = true;
    const wc = slot.view.webContents;
    if (wc.isDestroyed()) return false;
    if (/^https?:/i.test(wc.getURL())) {
      await wc.executeJavaScript(LIGHT_PREFS_OFF, true).catch(() => {});
      wc.reload();
      return true;
    }
    return false;
  }

  /** Desliga sem recarregar: devolve o rAF original e remove o CSS injetado. */
  async disableLight(slot) {
    slot.lightMode = false;
    slot.lightApplied = false;
    const wc = slot.view.webContents;
    if (wc.isDestroyed()) return;
    if (slot.lightCssKey) {
      await wc.removeInsertedCSS(slot.lightCssKey).catch(() => {});
      slot.lightCssKey = null;
    }
    await wc.executeJavaScript(LIGHT_RESTORE, true).catch(() => {});
  }

  /**
   * Reaplica num carregamento novo. Se o jogo voltou para Economia/Ultra (a
   * preferência vive no localStorage), zera e recarrega uma vez — o que também
   * descarta a cena antiga.
   */
  async syncLight(slot) {
    if (!slot.lightMode) return;
    const wc = slot.view.webContents;
    if (wc.isDestroyed() || !/^https?:/i.test(wc.getURL())) return;
    const dirty = await wc.executeJavaScript(LIGHT_PREFS_ON, true).catch(() => false);
    if (dirty) {
      await wc.executeJavaScript(LIGHT_PREFS_OFF, true).catch(() => {});
      wc.reload();
      return;
    }
    await this.applyLight(slot);
  }

  async applyLight(slot) {
    const wc = slot.view.webContents;
    if (wc.isDestroyed()) return false;
    if (slot.lightCssKey) {
      await wc.removeInsertedCSS(slot.lightCssKey).catch(() => {});
      slot.lightCssKey = null;
    }
    try {
      slot.lightCssKey = await wc.insertCSS(LIGHT_CSS, { cssOrigin: 'user' });
    } catch (err) {
      console.error(`[${slot.id}] modo leve css:`, err.message);
    }
    try {
      await wc.executeJavaScript(LIGHT_APPLY, true);
      slot.lightApplied = true;
    } catch (err) {
      console.error(`[${slot.id}] modo leve rAF:`, err.message);
      slot.lightApplied = false;
    }
    return slot.lightApplied;
  }

  setViewsVisible(visible) {
    for (const slot of this.slots) {
      slot.view.setVisible(visible);
      for (const popup of slot.popups) popup.setVisible(visible);
    }
  }

  closeAllPopups() {
    let count = 0;
    for (const slot of this.slots) {
      for (const popup of [...slot.popups]) {
        this.closePopup(slot, popup);
        count += 1;
      }
    }
    return count;
  }

  recreate(slot) {
    if (!this.slots.includes(slot)) return;
    const now = Date.now();
    slot.crashes = slot.crashes.filter((t) => now - t < 60_000);
    slot.crashes.push(now);
    if (slot.crashes.length >= 3) {
      if (slot.cooldownAt && now < slot.cooldownAt) return;
      slot.cooldownAt = now + 30_000;
      console.error(`[${slot.id}] 3 quedas em 60s — nova tentativa em 30s`);
      setTimeout(() => {
        slot.cooldownAt = 0;
        this.recreate(slot);
      }, 30_000);
    } else {
      this.recreateNow(slot);
    }
  }

  recreateNow(slot) {
    if (!this.slots.includes(slot) || !this.win || this.win.isDestroyed()) return;
    const dead = slot.view;
    if (this.win.contentView.children.includes(dead)) this.win.contentView.removeChildView(dead);
    if (!dead.webContents.isDestroyed()) dead.webContents.close();
    const fresh = makeView(slot.id);
    slot.view = fresh;
    slot.lightApplied = false;
    slot.lightCssKey = null;
    fresh.webContents.on('render-process-gone', () => this.recreate(slot));
    fresh.webContents.on('did-finish-load', () => this.syncLight(slot));
    this.bindOpenHandler(slot, fresh);
    this.win.contentView.addChildView(fresh);
    fresh.webContents.loadURL(slot.url);
    this.layout(this.win);
  }

  get(id) {
    return this.slots.find((s) => s.id === id);
  }

  findByWebContentsId(webContentsId) {
    for (const slot of this.slots) {
      if (slot.view.webContents.id === webContentsId) return slot;
      for (const popup of slot.popups) {
        if (popup.webContents.id === webContentsId) return slot;
      }
    }
    return null;
  }

  remove(id) {
    const i = this.slots.findIndex((s) => s.id === id);
    if (i === -1) return false;
    const [slot] = this.slots.splice(i, 1);
    for (const popup of [...slot.popups]) this.closePopup(slot, popup);
    if (this.win && !this.win.isDestroyed() && this.win.contentView.children.includes(slot.view)) {
      this.win.contentView.removeChildView(slot.view);
    }
    if (!slot.view.webContents.isDestroyed()) slot.view.webContents.close();
    if (this.win && !this.win.isDestroyed()) this.layout(this.win);
    return true;
  }

  destroyAll() {
    for (const slot of this.slots) {
      for (const popup of [...slot.popups]) this.closePopup(slot, popup);
      if (!slot.view.webContents.isDestroyed()) slot.view.webContents.close();
    }
    this.slots = [];
  }

  layout(win) {
    if (win.isDestroyed()) return;
    const [cw, ch] = win.getContentSize();
    const rects = computeGrid(this.slots.length, { width: cw, height: ch }, {
      cols: this.cols,
      topOffset: TOOLBAR_H,
    });
    if (rects.length === this.slots.length) {
      this.slots.forEach((slot, i) => {
        if (!win.contentView.children.includes(slot.view)) win.contentView.addChildView(slot.view);
        slot.view.setBounds(rects[i]);
      });
    }
    const pRect = popupBounds({ width: cw, height: ch });
    for (const slot of this.slots) {
      for (const popup of slot.popups) {
        if (!win.contentView.children.includes(popup)) win.contentView.addChildView(popup);
        popup.setBounds(pRect);
      }
    }
  }
}
