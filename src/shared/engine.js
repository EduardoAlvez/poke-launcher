(function (root) {
  function textOf(node) {
    if (!node) return '';
    return typeof node.textContent === 'string' ? node.textContent : '';
  }

  function parseCount(text) {
    const match = String(text ?? '').replace(/\./g, '').match(/\d+/);
    return match ? Number(match[0]) : null;
  }

  function ruleMatches(rule, node) {
    const text = textOf(node);
    for (const matcher of rule.matchers ?? []) {
      if (matcher.kind === 'text') {
        const regex = new RegExp(matcher.regex, matcher.flags ?? 'i');
        if (regex.test(text)) return true;
      } else if (matcher.kind === 'selector') {
        if (matcher.selector && typeof node.matches === 'function' && node.matches(matcher.selector)) return true;
      }
    }
    return false;
  }

  function matchRules(rules, node) {
    return (rules ?? [])
      .filter((rule) => rule.kind !== 'counter' && ruleMatches(rule, node))
      .map((rule) => rule.id);
  }

  function checkCounters(rules, doc) {
    const hits = [];
    for (const rule of rules ?? []) {
      if (rule.kind !== 'counter') continue;
      for (const matcher of rule.matchers ?? []) {
        if (!matcher.selector) continue;
        const el = doc.querySelector(matcher.selector);
        if (!el) continue;
        const value = parseCount(textOf(el));
        if (value === null) continue;
        const limit = matcher.max ?? 5;
        if (value < limit) hits.push({ id: rule.id, value, limit });
      }
    }
    return hits;
  }

  function installEngine({ rules, emit, doc = root.document, win = root }) {
    let observer = null;
    let interval = null;
    const lastEmit = new Map();

    const canEmit = (rule, body) => {
      const now = Date.now();
      const debounce = rule.debounceMs ?? 2000;
      const last = lastEmit.get(rule.id) ?? 0;
      if (now - last < debounce) return;
      lastEmit.set(rule.id, now);
      emit({
        type: rule.id,
        title: rule.title ?? rule.id,
        body: String(body ?? '').slice(0, 140),
        ts: now,
        ruleId: rule.id,
      });
    };

    const onMutations = (records) => {
      for (const record of records) {
        for (const node of record.addedNodes ?? []) {
          if (node.nodeType !== 1) continue;
          for (const rule of rules ?? []) {
            if (rule.kind === 'counter') continue;
            if (ruleMatches(rule, node)) {
              canEmit(rule, textOf(node).trim());
            }
          }
        }
      }
    };

    const start = () => {
      if (!doc || !doc.body) return;
      const MutationObserverCtor = win.MutationObserver;
      if (MutationObserverCtor) {
        observer = new MutationObserverCtor(onMutations);
        observer.observe(doc.body, { childList: true, subtree: true });
      }
      const counters = (rules ?? []).filter((r) => r.kind === 'counter');
      if (counters.length) {
        interval = win.setInterval(() => {
          for (const hit of checkCounters(rules, doc)) {
            const rule = counters.find((r) => r.id === hit.id);
            if (rule) canEmit(rule, `${hit.value} restantes (min ${hit.limit})`);
          }
        }, ruleIntervalMs(rules));
      }
    };

    const ruleIntervalMs = (list) => {
      const values = (list ?? []).filter((r) => r.kind === 'counter').map((r) => r.pollMs ?? 5000);
      return values.length ? Math.min(...values) : 5000;
    };

    if (doc && doc.readyState === 'loading') {
      doc.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
      start();
    }

    const handle = {
      stop() {
        observer?.disconnect();
        if (interval && win.clearInterval) win.clearInterval(interval);
        observer = null;
        interval = null;
      },
    };
    root.__addonHandle = handle;
    return handle;
  }

  root.PokeAddonEngine = {
    matchRules,
    ruleMatches,
    checkCounters,
    parseCount,
    installEngine,
    stop: () => root.__addonHandle?.stop?.(),
  };
})(globalThis);
