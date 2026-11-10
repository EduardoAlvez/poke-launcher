import { WebContentsView } from 'electron';
import { computeGrid, popupBounds, TOOLBAR_H } from './layout.js';
import { installSlotExtensions } from './extensions.js';
import { installDexHook } from './dex-hook.js';
import { registerAddonPreload, matchesGame } from './addons.js';
import { LightMode } from './light-mode.js';
import { ECO_INSTALL, ecoSetExpr } from './eco.js';
import { hostAllowed, withTimeout, INJECT_TIMEOUT_MS } from './scripts.js';

const DEFAULT_URL = 'https://pokeidle.io/app';
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2;
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
    this.onLightChange = null;
    this.onCrash = null;
    this.scriptRunner = null;
    this.dexHookDir = null;
    this.disposed = false;
    this.lightMode = new LightMode({ onChange: (slot) => this.onLightChange?.(slot) });
  }

  attachWindow(win) {
    this.win = win;
  }

  /**
   * Mudo e zoom moram no slot (slots.json) mas quem obedece e o webContents:
   * isto e chamado ao criar, ao restaurar e quando o usuario muda no menu.
   */
  applySlotPrefs(slot) {
    const wc = slot?.view?.webContents;
    if (!wc || wc.isDestroyed()) return;
    wc.setAudioMuted(slot.muted === true);
    const zoom = Number(slot.zoomFactor);
    const factor = Number.isFinite(zoom) ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)) : 1;
    wc.setZoomFactor(factor);
  }

  setAddonPreloadPath(preloadPath) {
    this.addonPreloadPath = preloadPath;
  }

  /**
   * Aplica o modo eco no documento atual. O patch e instalado primeiro; se a
   * pagina ainda nao o tem (early return do install), o SET seguinte e no-op e
   * o valor inicial volta a ser aplicado no proximo carregamento.
   */
  async applyEcoPrefs(slot, wc = slot?.view?.webContents) {
    if (!wc || wc.isDestroyed() || !hostAllowed(wc.getURL?.() ?? '', slot?.url)) return false;
    try {
      await withTimeout(
        wc.executeJavaScript(`${ECO_INSTALL}; ${ecoSetExpr(slot.eco === true)}`, true),
        INJECT_TIMEOUT_MS,
        'eco'
      );
      return true;
    } catch (err) {
      console.error(`[${slot?.id ?? '?'}] modo eco:`, err?.message ?? err);
      return false;
    }
  }

  /**
   * A `view` de um slot pode ser recriada (crash) ou a pagina pode navegar no
   * meio de um `await`: sem essa checagem o script/leve agiria na view errada.
   */
  alive(slot, wc = null, gen = null) {
    if (this.disposed || slot.removed || !this.slots.includes(slot)) return false;
    if (wc && slot.view.webContents !== wc) return false;
    if (gen !== null && slot.loadGen !== gen) return false;
    return true;
  }

  /**
   * Ordem: eco → scripts → leve. O eco vem primeiro para ser a base do rAF; os
   * scripts vêm antes do leve porque um script pode embrulhar o rAF — se o leve
   * estivesse por baixo, desligá-lo não conseguiria mais restaurar o original.
   * O custo é o leve esperar os scripts; cada script tem timeout, então um
   * script travado atrasa o remédio de CPU no máximo alguns segundos.
   */
  async afterLoad(slot) {
    if (!this.alive(slot)) return;
    const wc = slot.view.webContents;
    const gen = (slot.loadGen = (slot.loadGen ?? 0) + 1);
    await this.applyEcoPrefs(slot, wc);
    if (!this.alive(slot, wc, gen)) return;
    try {
      await this.scriptRunner?.(slot, wc);
    } catch (err) {
      console.error(`[${slot.id}] scripts:`, err?.message ?? err);
    }
    if (!this.alive(slot, wc, gen)) return;
    this.lightMode.sync(slot).catch((err) => console.error(`[${slot.id}] modo leve:`, err?.message ?? err));
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
      eco: false,
      lightApplied: false,
      lightFailed: false,
      lightCssKey: null,
      lightGen: 0,
      lightReloadAt: 0,
      lightQueue: Promise.resolve(),
    };
    view.webContents.on('render-process-gone', () => this.recreate(slot));
    view.webContents.on('did-finish-load', () =>
      this.afterLoad(slot).catch((err) => console.error(`[${slot.id}] afterLoad:`, err?.message ?? err))
    );
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
    if (this.dexHookDir && matchesGame(url)) {
      await installDexHook(view.webContents.session, this.dexHookDir).catch((err) =>
        console.error(`[${slotId}] dex-hook:`, err.message)
      );
    }
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

  enableLight(slot) {
    return this.lightMode.enable(slot);
  }

  disableLight(slot) {
    return this.lightMode.disable(slot);
  }

  syncLight(slot) {
    return this.lightMode.sync(slot);
  }

  watchLight(slot) {
    return this.lightMode.watch(slot);
  }

  setViewsVisible(visible) {
    for (const slot of this.slots) {
      if (!slot.view.webContents.isDestroyed()) slot.view.setVisible(visible);
      for (const popup of slot.popups) {
        if (!popup.webContents.isDestroyed()) popup.setVisible(visible);
      }
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
    if (this.disposed || slot.removed || !this.slots.includes(slot)) return;
    const now = Date.now();
    slot.crashes = slot.crashes.filter((t) => now - t < 60_000);
    slot.crashes.push(now);
    if (slot.crashes.length >= 3) {
      if (slot.crashUntil && now < slot.crashUntil) return;
      const waitMs = 30_000;
      slot.crashUntil = now + waitMs;
      console.error(`[${slot.id}] 3 quedas em 60s — nova tentativa em ${waitMs / 1000}s`);
      this.onCrash?.(slot, { attempt: slot.crashes.length, waitMs });
      setTimeout(() => {
        if (this.disposed || slot.removed || !this.slots.includes(slot)) return;
        slot.crashUntil = 0;
        slot.crashes = [];
        this.recreateNow(slot);
      }, waitMs);
    } else {
      this.recreateNow(slot);
    }
  }

  recreateNow(slot) {
    if (this.disposed || slot.removed || !this.slots.includes(slot) || !this.win || this.win.isDestroyed()) return;
    const dead = slot.view;
    if (this.win.contentView.children.includes(dead)) this.win.contentView.removeChildView(dead);
    if (!dead.webContents.isDestroyed()) dead.webContents.close();
    const fresh = makeView(slot.id);
    slot.view = fresh;
    this.applySlotPrefs(slot);
    slot.lightApplied = false;
    slot.lightCssKey = null;
    slot.lightGen += 1;
    slot.lightReloadAt = 0;
    fresh.webContents.on('render-process-gone', () => this.recreate(slot));
    fresh.webContents.on('did-finish-load', () => {
      this.applySlotPrefs(slot);
      this.afterLoad(slot).catch((err) => console.error(`[${slot.id}] afterLoad:`, err?.message ?? err));
    });
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
    slot.removed = true;
    for (const popup of [...slot.popups]) this.closePopup(slot, popup);
    if (this.win && !this.win.isDestroyed() && this.win.contentView.children.includes(slot.view)) {
      this.win.contentView.removeChildView(slot.view);
    }
    if (!slot.view.webContents.isDestroyed()) slot.view.webContents.close();
    if (this.win && !this.win.isDestroyed()) this.layout(this.win);
    return true;
  }

  destroyAll() {
    this.disposed = true;
    for (const slot of this.slots) {
      slot.removed = true;
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
