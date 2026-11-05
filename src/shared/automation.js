(function (root) {
  function isVisible(el, doc) {
    if (!el) return false;
    if (el.hidden) return false;
    const view = doc.defaultView ?? root;
    if (typeof view.getComputedStyle === 'function') {
      const style = view.getComputedStyle(el);
      if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return false;
    }
    return true;
  }

  function findFirst(doc, selectors) {
    for (const selector of selectors ?? []) {
      let el = null;
      try {
        el = doc.querySelector(selector);
      } catch {
        continue;
      }
      if (el && isVisible(el, doc)) return el;
    }
    return null;
  }

  function isPaused(doc, pack) {
    for (const selector of pack.pauseSelectors ?? []) {
      let el = null;
      try {
        el = doc.querySelector(selector);
      } catch {
        continue;
      }
      if (el && isVisible(el, doc)) return true;
    }
    const bodyText = doc.body?.textContent ?? '';
    for (const phrase of pack.pauseText ?? []) {
      if (bodyText.includes(phrase)) return true;
    }
    return false;
  }

  function installAutomation({ config, pack, emit, doc = root.document, win = root }) {
    let timer = null;
    let throwsInWindow = 0;
    let windowStart = Date.now();
    let total = 0;
    let stopped = false;

    const random = () => (win.crypto?.getRandomValues ? win.crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32 : Math.random());

    const report = (state) => emit?.({ type: 'automation-status', state, throws: total, running: !stopped });

    const tick = () => {
      if (stopped) return;
      const now = Date.now();
      if (now - windowStart >= 60_000) {
        windowStart = now;
        throwsInWindow = 0;
      }
      const limit = Math.max(1, config.maxPerMin ?? 20);
      if (throwsInWindow < limit && !isPaused(doc, pack)) {
        const target = findFirst(doc, pack.clickCandidates);
        if (target) {
          target.click();
          throwsInWindow += 1;
          total += 1;
          report('clicking');
        } else {
          report('waiting-button');
        }
      } else {
        report(throwsInWindow >= limit ? 'rate-limited' : 'paused');
      }
      const interval = Math.max(500, config.intervalMs ?? 2000);
      const jitter = Math.max(0, config.jitterMs ?? 800);
      timer = win.setTimeout(tick, interval + Math.floor(random() * jitter));
    };

    const start = () => {
      stopped = false;
      report('starting');
      tick();
    };

    const stop = (reason = 'stopped') => {
      stopped = true;
      if (timer) win.clearTimeout(timer);
      timer = null;
      report(reason);
    };

    start();

    return {
      stop,
      getTotal: () => total,
      isRunning: () => !stopped,
    };
  }

  root.PokeAutomation = { installAutomation, findFirst, isPaused, isVisible };
})(globalThis);
