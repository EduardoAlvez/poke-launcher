export const MAX_BODY_LEN = 140;
export const MAX_TITLE_LEN = 80;
export const MAX_AGE_MS = 10_000;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

export function sanitizeText(raw, maxLen) {
  if (typeof raw !== 'string') return '';
  const cleaned = raw.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, maxLen - 1)}…`;
}

export function parseGameEvent(payload, { now = Date.now(), maxAgeMs = MAX_AGE_MS } = {}) {
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'payload invalido' };
  const { type, title, body, ts } = payload;
  if (typeof type !== 'string' || !/^[a-z0-9-]{1,40}$/i.test(type)) {
    return { ok: false, error: 'type invalido' };
  }
  const cleanBody = sanitizeText(body, MAX_BODY_LEN);
  if (!cleanBody) return { ok: false, error: 'body vazio' };
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return { ok: false, error: 'ts invalido' };
  if (Math.abs(now - tsNum) > maxAgeMs) return { ok: false, error: 'evento expirado' };
  return {
    ok: true,
    event: {
      type,
      title: sanitizeText(title, MAX_TITLE_LEN),
      body: cleanBody,
      ts: tsNum,
    },
  };
}

export class Notifier {
  constructor(options = {}) {
    this.now = options.now ?? (() => Date.now());
    this.cooldownMs = options.cooldownMs ?? 2000;
    this.capacity = options.capacity ?? 5;
    this.refillPerMs = options.refillPerMs ?? 1 / 5000;
    this.quietHours = options.quietHours ?? null;
    this.show = options.show ?? (() => {});
    this.lastByKey = new Map();
    this.buckets = new Map();
    this.muted = false;
  }

  bucket(key) {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.capacity, last: now };
      this.buckets.set(key, bucket);
    }
    const elapsed = now - bucket.last;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerMs);
    bucket.last = now;
    return bucket;
  }

  inQuietHours(date) {
    if (!this.quietHours) return false;
    const { start, end } = this.quietHours;
    const hour = date.getHours();
    if (start === end) return false;
    if (start < end) return hour >= start && hour < end;
    return hour >= start || hour < end;
  }

  notify(slotId, event) {
    if (this.muted) return { shown: false, reason: 'mudo' };
    const now = this.now();
    const key = `${slotId}:${event.type}`;
    const last = this.lastByKey.get(key) ?? 0;
    if (now - last < this.cooldownMs) return { shown: false, reason: 'cooldown' };
    const bucket = this.bucket(slotId);
    if (bucket.tokens < 1) return { shown: false, reason: 'rate-limit' };
    if (this.inQuietHours(new Date(now))) return { shown: false, reason: 'quiet-hours' };
    bucket.tokens -= 1;
    this.lastByKey.set(key, now);
    this.show({ slotId, ...event });
    return { shown: true };
  }
}
