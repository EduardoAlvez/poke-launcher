(function (root) {
  function styleOf(el, doc) {
    const view = doc.defaultView ?? root;
    if (!el || typeof view.getComputedStyle !== 'function') return null;
    try {
      return view.getComputedStyle(el);
    } catch {
      return null;
    }
  }

  function isVisible(el, doc) {
    if (!el) return false;
    if (el.hidden) return false;
    const style = styleOf(el, doc);
    if (style) {
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      if (style.pointerEvents === 'none') return false;
    }
    if (typeof el.getBoundingClientRect === 'function') {
      const rect = el.getBoundingClientRect();
      if (rect && rect.width === 0 && rect.height === 0) return false;
    }
    return true;
  }

  function isClickable(el, doc) {
    if (!isVisible(el, doc)) return false;
    if (el.disabled === true) return false;
    if (el.getAttribute?.('aria-disabled') === 'true') return false;
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
      if (el && isClickable(el, doc)) return el;
    }
    return null;
  }

  function textNode(doc, pack) {
    if (pack.pauseWithin) {
      try {
        const scope = doc.querySelector(pack.pauseWithin);
        if (scope) return scope.textContent ?? '';
      } catch {
        /* cai no body */
      }
    }
    return doc.body?.textContent ?? '';
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
    const bodyText = textNode(doc, pack);
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
    let lastState = null;

    const random = () => (win.crypto?.getRandomValues ? win.crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32 : Math.random());

    const report = (state) => {
      if (state === lastState) return;
      lastState = state;
      emit?.({ type: 'automation-status', state, throws: total, running: !stopped });
    };

    const schedule = () => {
      const interval = Math.max(500, config.intervalMs ?? 2000);
      const jitter = Math.max(0, config.jitterMs ?? 800);
      timer = win.setTimeout(tick, interval + Math.floor(random() * jitter));
    };

    function tick() {
      timer = null;
      if (stopped) return;
      try {
        const now = Date.now();
        if (now - windowStart >= 60_000) {
          windowStart = now;
          throwsInWindow = 0;
        }
        const limit = Math.max(1, config.maxPerMin ?? 20);
        if (throwsInWindow >= limit) {
          report('rate-limited');
        } else if (isPaused(doc, pack)) {
          report('paused');
        } else {
          const target = findFirst(doc, pack.clickCandidates);
          if (target) {
            target.click();
            throwsInWindow += 1;
            total += 1;
            report('clicking');
          } else {
            report('waiting-button');
          }
        }
      } catch (err) {
        report('error');
        emit?.({ type: 'automation-status', state: 'error', message: String(err?.message ?? err).slice(0, 120), running: !stopped });
      } finally {
        if (!stopped) schedule();
      }
    }

    const stop = (reason = 'stopped') => {
      if (stopped) return;
      stopped = true;
      if (timer) win.clearTimeout(timer);
      timer = null;
      report(reason);
    };

    report('starting');
    schedule();

    return {
      stop,
      getTotal: () => total,
      isRunning: () => !stopped,
    };
  }

  root.PokeAutomation = { installAutomation, findFirst, isPaused, isVisible, isClickable };
})(globalThis);
