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

  function clickTarget(el, doc) {
    if (!el) return false;
    if (el.tagName === 'CANVAS' && typeof el.getBoundingClientRect === 'function') {
      const rect = el.getBoundingClientRect();
      const x = Math.round(rect.left + rect.width / 2);
      const y = Math.round(rect.top + rect.height / 2);
      const view = doc?.defaultView ?? root;
      const Ctor = view.MouseEvent;
      for (const type of ['pointermove', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        try {
          el.dispatchEvent(Ctor ? new Ctor(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }) : { type });
        } catch {
          /* evento indisponivel */
        }
      }
      return true;
    }
    if (typeof el.click === 'function') {
      el.click();
      return true;
    }
    return false;
  }

  function isEconomy(doc, pack) {
    if (!pack?.economySelector) return false;
    try {
      return Boolean(doc.querySelector(pack.economySelector));
    } catch {
      return false;
    }
  }

  function isAccountTaken(doc, pack) {
    if (!pack?.accountTakenSelector) return false;
    let el = null;
    try {
      el = doc.querySelector(pack.accountTakenSelector);
    } catch {
      return false;
    }
    return Boolean(el && isVisible(el, doc));
  }

  function installAutomation({ config, pack, emit, doc = root.document, win = root }) {
    let timer = null;
    let heartbeat = null;
    let throwsInWindow = 0;
    let windowStart = Date.now();
    let total = 0;
    let ticks = 0;
    let lastTickAt = null;
    let lastThrowAt = null;
    let stopped = false;
    let economyExited = false;
    let lastState = null;

    const random = () => (win.crypto?.getRandomValues ? win.crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32 : Math.random());

    const countTargets = () => {
      if (!pack?.countSelector) return null;
      try {
        return typeof doc.querySelectorAll === 'function' ? doc.querySelectorAll(pack.countSelector).length : null;
      } catch {
        return null;
      }
    };

    const emitStatus = (state) =>
      emit?.({ type: 'automation-status', state, throws: total, running: !stopped, ticks, lastTickAt, caidos: countTargets() });

    const report = (state) => {
      if (state === lastState) return;
      lastState = state;
      emitStatus(state);
    };

    const schedule = () => {
      const interval = Math.max(500, config.intervalMs ?? 2000);
      const jitter = Math.max(0, config.jitterMs ?? 800);
      timer = win.setTimeout(tick, interval + Math.floor(random() * jitter));
    };

    function tick() {
      timer = null;
      if (stopped) return;
      ticks += 1;
      lastTickAt = Date.now();
      try {
        const now = lastTickAt;
        if (now - windowStart >= 60_000) {
          windowStart = now;
          throwsInWindow = 0;
        }
        const limit = Math.max(1, config.maxPerMin ?? 20);
        if (isEconomy(doc, pack)) {
          const exit = config.exitEconomy !== false && pack?.economyExitSelector
            ? findFirst(doc, [pack.economyExitSelector])
            : null;
          if (exit) {
            clickTarget(exit, doc);
            economyExited = true;
            report('exiting-economy');
          } else {
            report('economy-mode');
          }
        } else if (isAccountTaken(doc, pack)) {
          report('session-taken');
        } else if (throwsInWindow >= limit) {
          report('rate-limited');
        } else if (isPaused(doc, pack)) {
          report('paused');
        } else {
          const target = findFirst(doc, pack.clickCandidates);
          if (target) {
            clickTarget(target, doc);
            throwsInWindow += 1;
            total += 1;
            lastThrowAt = Date.now();
            report('clicking');
          } else {
            report('waiting-button');
          }
        }
      } catch {
        report('error');
      } finally {
        if (!stopped) schedule();
      }
    }

    const stop = (reason = 'stopped') => {
      if (stopped) return;
      stopped = true;
      if (timer) win.clearTimeout(timer);
      timer = null;
      if (heartbeat && typeof win.clearInterval === 'function') win.clearInterval(heartbeat);
      heartbeat = null;
      if (economyExited && reason !== 'reconfigurado' && pack?.economyEnterSelector) {
        const enter = findFirst(doc, [pack.economyEnterSelector]);
        if (enter) clickTarget(enter, doc);
      }
      economyExited = false;
      report(reason);
    };

    report('starting');
    if (typeof win.setInterval === 'function') {
      heartbeat = win.setInterval(() => {
        if (!stopped) emitStatus(lastState ?? 'idle');
      }, 10000);
    }
    schedule();

    /**
     * "Capturou" tambem aparece em outros paineis, entao o modo ate-capturar
     * so aceita a regra quando ela chega logo depois de um arremesso nosso.
     */
    const onRule = (ruleId) => {
      if (stopped || config.mode !== 'until-catch' || !pack?.stopOnRule) return false;
      if (ruleId !== pack.stopOnRule) return false;
      const windowMs = Math.max(1000, config.captureWindowMs ?? 20_000);
      if (lastThrowAt === null || Date.now() - lastThrowAt > windowMs) return false;
      stop('captured');
      return true;
    };

    return {
      stop,
      onRule,
      getTotal: () => total,
      getTicks: () => ticks,
      isRunning: () => !stopped,
    };
  }

  root.PokeAutomation = { installAutomation, findFirst, isPaused, isVisible, isClickable, clickTarget, isEconomy, isAccountTaken };
})(globalThis);
