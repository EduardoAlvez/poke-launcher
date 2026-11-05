import { WebContentsView } from 'electron';
import { computeGrid } from './layout.js';

const DEFAULT_URL = 'https://pokeidle.io/app';

export class SlotRegistry {
  constructor() {
    this.slots = [];
    this.seq = 0;
    this.cols = 2;
    this.win = null;
  }

  attachWindow(win) {
    this.win = win;
  }

  add(name, url = DEFAULT_URL) {
    const id = `slot-${++this.seq}`;
    const view = new WebContentsView({
      webPreferences: {
        partition: `persist:${id}`,
        sandbox: true,
        contextIsolation: true,
        backgroundThrottling: false,
      },
    });
    const slot = { id, name: name || id, url, view };
    view.webContents.on('render-process-gone', () => this.recreate(slot));
    this.slots.push(slot);
    if (this.win && !this.win.isDestroyed()) {
      this.win.contentView.addChildView(view);
      view.webContents.loadURL(url);
      this.layout(this.win);
    }
    return slot;
  }

  recreate(slot) {
    const dead = slot.view;
    if (this.win && !this.win.isDestroyed() && this.win.contentView.children.includes(dead)) {
      this.win.contentView.removeChildView(dead);
    }
    dead.webContents.close();
    const fresh = new WebContentsView({
      webPreferences: {
        partition: `persist:${slot.id}`,
        sandbox: true,
        contextIsolation: true,
        backgroundThrottling: false,
      },
    });
    slot.view = fresh;
    fresh.webContents.on('render-process-gone', () => this.recreate(slot));
    fresh.webContents.loadURL(slot.url);
    if (this.win && !this.win.isDestroyed()) {
      this.win.contentView.addChildView(fresh);
      this.layout(this.win);
    }
    return fresh;
  }

  remove(id) {
    const i = this.slots.findIndex((s) => s.id === id);
    if (i === -1) return false;
    const [slot] = this.slots.splice(i, 1);
    if (this.win && !this.win.isDestroyed() && this.win.contentView.children.includes(slot.view)) {
      this.win.contentView.removeChildView(slot.view);
    }
    slot.view.webContents.close();
    if (this.win && !this.win.isDestroyed()) this.layout(this.win);
    return true;
  }

  destroyAll() {
    for (const slot of this.slots) slot.view.webContents.close();
    this.slots = [];
  }

  get(id) {
    return this.slots.find((s) => s.id === id);
  }

  layout(win) {
    if (win.isDestroyed()) return;
    const [cw, ch] = win.getContentSize();
    const rects = computeGrid(this.slots.length, { width: cw, height: ch }, {
      cols: this.cols,
      topOffset: win.chromeHeight ?? 44,
    });
    this.slots.forEach((slot, i) => {
      const parent = win.contentView.children.includes(slot.view);
      if (!parent) win.contentView.addChildView(slot.view);
      slot.view.setBounds(rects[i]);
    });
  }
}
