import { WebContentsView } from 'electron';
import {
  computeGrid,
  computeFocusBounds,
  FOCUS_CONTEXT_H,
  isSlotVisible,
  popupBounds,
  COLLAPSED_TOOLBAR_H,
  TOOLBAR_H,
} from './layout.js';
import { installSlotExtensions } from './extensions.js';
import { installDexHook } from './dex-hook.js';
import { registerAddonPreload, matchesGame } from './addons.js';
import { proxyRules } from './proxy.js';
import { LightMode } from './light-mode.js';
import { ECO_INSTALL, ecoSetExpr, ecoThrottleMs } from './eco.js';
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
    this.toolbarHeight = TOOLBAR_H;
    this.focusedSlotId = null;
    this.viewsVisible = true;
    this.win = null;
    this.addonPreloadPath = null;
    this.closingPopups = new WeakSet();
    this.onPopupChange = null;
    this.onFocusChange = null;
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

  bindFocusShortcut(slot, view = slot.view) {
    view.webContents.on('before-input-event', (event, input) => {
      if (
        this.focusedSlotId !== slot.id ||
        !this.viewsVisible ||
        input.type !== 'keyDown' ||
        input.key !== 'Escape' ||
        input.isAutoRepeat
      ) return;
      event.preventDefault();
      this.setFocusedSlot(null);
      if (this.win && !this.win.isDestroyed()) this.win.webContents.focus();
    });
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
   * Proxy por slot: a session e por particao, entao o setProxy vale para a
   * view, os popups e TODO request daquela conta — e para ninguem mais.
   * Precisa terminar ANTES do primeiro request (loadURL) para o primeiro
   * pacote nao escapar pela rede local.
   */
  async applyProxy(slot) {
    const ses = slot?.view?.webContents?.session;
    if (!ses || ses.isDestroyed()) return false;
    try {
      if (slot.proxy) {
        await ses.setProxy({ proxyRules: proxyRules(slot.proxy) });
      } else {
        await ses.setProxy({ mode: 'system' });
      }
      slot.proxyErro = null;
      return true;
    } catch (err) {
      // Proxy rejeitado pelo Chromium (host inalcancavel na sintaxe, DNS do
      // resolver, etc.): marca no slot — a UI mostra, e a rede volta ao
      // padrao do sistema no proximo applyProxy com proxy vazio.
      slot.proxyErro = String(err?.message ?? err).slice(0, 160);
      console.error(`[${slot?.id ?? '?'}] proxy:`, slot.proxyErro);
      return false;
    }
  }

  /**
   * Aplica o modo eco no documento atual. O patch e instalado primeiro; se a
   * pagina ainda nao o tem (early return do install), o SET seguinte e no-op e
   * o valor inicial volta a ser aplicado no proximo carregamento.
   */
  async applyEcoPrefs(slot, wc = slot?.view?.webContents) {
    if (!wc || wc.isDestroyed() || wc.isLoading?.() || !hostAllowed(wc.getURL?.() ?? '', slot?.url)) return false;
    const grid = this.viewsVisible && this.focusedSlotId == null && this.slots.length > 1;
    slot.renderThrottleMs = ecoThrottleMs(slot.eco === true, slot.viewVisible !== false, grid);
    try {
      await withTimeout(
        wc.executeJavaScript(`${ECO_INSTALL}; ${ecoSetExpr(slot.eco === true, slot.viewVisible !== false, grid)}`, true),
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

  async add(name, url = DEFAULT_URL, { id, maxSlots = MAX_SLOTS, proxy = null } = {}) {
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
      viewVisible: null,
      renderThrottleMs: null,
      lightMode: false,
      eco: false,
      dexWatch: false,
      proxy: null,
      exitIp: null,
      exitIpErro: null,
      proxyErro: null,
      // P2: consentimento de escrita POR EXECUCAO — em memoria, nunca no
      // slots.json (store.js nao o lista, entao o snapshot o descarta).
      p2Armado: false,
      lightApplied: false,
      lightFailed: false,
      lightCssKey: null,
      lightGen: 0,
      lightReloadAt: 0,
      lightQueue: Promise.resolve(),
      // preferencia de Economia/ULTRA que o usuario tinha antes do modo leve
      prefsEconomiaDoUsuario: null,
      prefsEconomiaPendente: null,
    };
    this.bindFocusShortcut(slot, view);
    view.webContents.on('render-process-gone', () => this.recreate(slot));
    // Reload na MESMA url nao recria a view: o arm do hook morre com o
    // documento antigo, entao o consentimento em memoria tem de cair junto.
    view.webContents.on('did-start-loading', () => {
      slot.p2Armado = false;
    });
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
    slot.proxy = proxy ?? null;
    // Antes do primeiro request: o loadURL de baixo nao pode escapar pelo IP local.
    await this.applyProxy(slot);
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

  disableLight(slot, opts) {
    return this.lightMode.disable(slot, opts);
  }

  syncLight(slot) {
    return this.lightMode.sync(slot);
  }

  watchLight(slot) {
    return this.lightMode.watch(slot);
  }

  /**
   * Consome a restauracao pendente da preferencia do usuario: chamada quando
   * o AUTO ou a rota param e o campo deixa de ser preciso.
   */
  restaurarPreferenciaDoUsuario(slot) {
    return this.lightMode.restaurarPreferenciaAposPararDoAUTO(slot);
  }

  setViewsVisible(visible) {
    this.viewsVisible = visible === true;
    this.syncViewVisibility();
  }

  setToolbarCollapsed(collapsed) {
    if (typeof collapsed !== 'boolean') return false;
    this.toolbarHeight = collapsed ? COLLAPSED_TOOLBAR_H : TOOLBAR_H;
    if (this.win && !this.win.isDestroyed()) this.layout(this.win);
    return true;
  }

  setFocusedSlot(id) {
    if (id !== null && !this.get(id)) return false;
    const changed = this.focusedSlotId !== id;
    this.focusedSlotId = id;
    if (this.win && !this.win.isDestroyed()) this.layout(this.win);
    else this.syncViewVisibility();
    if (changed) this.onFocusChange?.(id);
    return true;
  }

  syncViewVisibility() {
    for (const slot of this.slots) {
      const visible = isSlotVisible(slot.id, this.focusedSlotId, this.viewsVisible);
      if (!slot.view.webContents.isDestroyed()) {
        slot.view.setVisible(visible);
        // Smaller grid tiles need fewer scene frames; focus restores the selected view.
        const grid = this.viewsVisible && this.focusedSlotId == null && this.slots.length > 1;
        const throttleMs = ecoThrottleMs(slot.eco === true, visible, grid);
        if (slot.viewVisible !== visible || slot.renderThrottleMs !== throttleMs) {
          slot.viewVisible = visible;
          slot.renderThrottleMs = throttleMs;
          this.applyEcoPrefs(slot).catch((err) => console.error(`[${slot.id}] limite de desenho:`, err?.message ?? err));
        }
      }
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
    this.bindFocusShortcut(slot, fresh);
    this.applySlotPrefs(slot);
    slot.lightApplied = false;
    slot.lightCssKey = null;
    slot.lightGen += 1;
    slot.lightReloadAt = 0;
    // O documento novo nao tem arm: o hook morreu junto com ele.
    slot.p2Armado = false;
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
    const wasFocused = this.focusedSlotId === id;
    if (wasFocused) this.focusedSlotId = null;
    const [slot] = this.slots.splice(i, 1);
    slot.removed = true;
    for (const popup of [...slot.popups]) this.closePopup(slot, popup);
    if (this.win && !this.win.isDestroyed() && this.win.contentView.children.includes(slot.view)) {
      this.win.contentView.removeChildView(slot.view);
    }
    if (!slot.view.webContents.isDestroyed()) slot.view.webContents.close();
    if (this.win && !this.win.isDestroyed()) this.layout(this.win);
    if (wasFocused) this.onFocusChange?.(null);
    return true;
  }

  destroyAll() {
    this.disposed = true;
    this.focusedSlotId = null;
    this.viewsVisible = true;
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
    const bounds = { width: cw, height: ch };
    if (this.focusedSlotId && !this.get(this.focusedSlotId)) {
      this.focusedSlotId = null;
      this.onFocusChange?.(null);
    }
    const focusBounds = this.focusedSlotId
      ? computeFocusBounds(bounds, { topOffset: this.toolbarHeight + FOCUS_CONTEXT_H })
      : null;
    const rects = computeGrid(this.slots.length, bounds, {
      cols: this.cols,
      topOffset: this.toolbarHeight,
    });
    const gridIsValid = rects.length === this.slots.length;
    this.slots.forEach((slot, i) => {
      if (!win.contentView.children.includes(slot.view)) win.contentView.addChildView(slot.view);
      const rect = slot.id === this.focusedSlotId ? focusBounds : gridIsValid ? rects[i] : null;
      if (rect) slot.view.setBounds(rect);
    });
    const pRect = popupBounds(bounds, { topOffset: this.toolbarHeight });
    for (const slot of this.slots) {
      for (const popup of slot.popups) {
        if (!win.contentView.children.includes(popup)) win.contentView.addChildView(popup);
        popup.setBounds(pRect);
      }
    }
    this.syncViewVisibility();
  }
}
