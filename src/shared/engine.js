(function (root) {
  function textOf(node) {
    if (!node) return '';
    return typeof node.textContent === 'string' ? node.textContent : '';
  }

  function parseCount(text) {
    const raw = String(text ?? '').trim();
    const match = raw.match(/\d[\d.,\s]*/);
    if (!match) return null;
    const token = match[0].trim();
    const grouped = /^\d{1,3}([.,\s]\d{3})+$/.test(token);
    let normalized;
    if (grouped) {
      normalized = token.replace(/[.,\s]/g, '');
    } else if (token.includes('.') && token.includes(',')) {
      normalized = token.replace(/\./g, '').replace(',', '.');
    } else {
      normalized = token.replace(',', '.');
    }
    const value = Number(normalized);
    return Number.isFinite(value) ? value : null;
  }

  function excluded(rule, node) {
    if (!rule?.excludeWithin?.length) return false;
    if (typeof node?.closest !== 'function') return false;
    for (const selector of rule.excludeWithin) {
      try {
        if (node.closest(selector)) return true;
      } catch {
        /* seletor invalido: ignora */
      }
    }
    return false;
  }

  function ruleMatches(rule, node) {
    if (excluded(rule, node)) return false;
    const text = textOf(node);
    for (const matcher of rule.matchers ?? []) {
      if (!matcher) continue;
      if (matcher.kind === 'text') {
        let regex;
        try {
          regex = new RegExp(matcher.regex, matcher.flags ?? 'i');
        } catch {
          continue;
        }
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

  function installEngine({ rules, emit, onRule, doc = root.document, win = root }) {
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
      onRule?.(rule.id);
    };

    const emitFor = (node) => {
      for (const rule of rules ?? []) {
        if (rule.kind === 'counter') continue;
        if (ruleMatches(rule, node)) canEmit(rule, textOf(node).trim());
      }
    };

    const onMutations = (records) => {
      for (const record of records) {
        if (record.type === 'characterData') {
          const node = record.target?.parentElement;
          if (node) emitFor(node);
          continue;
        }
        for (const node of record.addedNodes ?? []) {
          if (node.nodeType === 1) {
            emitFor(node);
          } else if (node.nodeType === 3 && node.parentElement) {
            emitFor(node.parentElement);
          }
        }
      }
    };

    const start = () => {
      if (!doc || !doc.body) return;
      const MutationObserverCtor = win.MutationObserver;
      if (MutationObserverCtor) {
        observer = new MutationObserverCtor(onMutations);
        observer.observe(doc.body, { childList: true, subtree: true, characterData: true });
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
