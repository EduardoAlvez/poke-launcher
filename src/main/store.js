import fs from 'node:fs/promises';
import path from 'node:path';

export const SCHEMA_VERSION = 1;
export const DEFAULT_MAX_SLOTS = 2;

export function defaultState() {
  return { schemaVersion: SCHEMA_VERSION, maxSlots: DEFAULT_MAX_SLOTS, slots: [] };
}

function isHttpUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    return /^https?:$/.test(new URL(value).protocol);
  } catch {
    return false;
  }
}

function isRatio(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function parseSlot(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'slot nao e objeto' };
  const { id, name, url, partition, ratios, muted, zoomFactor, automation } = raw;
  if (typeof id !== 'string' || !/^slot-[a-z0-9-]+$/i.test(id)) {
    return { ok: false, error: `id invalido: ${JSON.stringify(id)}` };
  }
  if (!isHttpUrl(url)) return { ok: false, error: `url invalida no slot ${id}` };
  if (partition !== `persist:${id}`) {
    return { ok: false, error: `partition invalida no slot ${id}` };
  }
  const nameStr = typeof name === 'string' ? name.slice(0, 24) : id;
  const ratiosOk =
    ratios && typeof ratios === 'object' && isRatio(ratios.x) && isRatio(ratios.y) && isRatio(ratios.w) && isRatio(ratios.h);
  const slot = {
    id,
    name: nameStr,
    url,
    partition,
    ratios: ratiosOk ? { x: ratios.x, y: ratios.y, w: ratios.w, h: ratios.h } : null,
    muted: muted === true,
    zoomFactor: typeof zoomFactor === 'number' && zoomFactor > 0 && zoomFactor <= 3 ? zoomFactor : 1,
    automation: parseAutomation(automation),
  };
  return { ok: true, slot };
}

export function parseAutomation(raw) {
  const base = { enabled: false, consent: false, mode: 'fixed', intervalMs: 2000, jitterMs: 800, maxPerMin: 20 };
  if (!raw || typeof raw !== 'object') return base;
  const mode = raw.mode === 'until-catch' ? 'until-catch' : 'fixed';
  const num = (v, fallback, min, max) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  return {
    enabled: raw.enabled === true && raw.consent === true,
    consent: raw.consent === true,
    mode,
    intervalMs: num(raw.intervalMs, base.intervalMs, 500, 60000),
    jitterMs: num(raw.jitterMs, base.jitterMs, 0, 5000),
    maxPerMin: num(raw.maxPerMin, base.maxPerMin, 1, 60),
  };
}

export function parseState(rawText) {
  let data;
  try {
    data = JSON.parse(rawText);
  } catch (err) {
    return { ok: false, error: `json invalido: ${err.message}` };
  }
  if (!data || typeof data !== 'object') return { ok: false, error: 'raiz nao e objeto' };
  const version = data.schemaVersion;
  if (typeof version !== 'number') return { ok: false, error: 'schemaVersion ausente' };
  if (version > SCHEMA_VERSION) {
    return { ok: false, error: `schemaVersion ${version} mais nova que o suportado (${SCHEMA_VERSION})` };
  }
  if (!Array.isArray(data.slots)) return { ok: false, error: 'slots nao e array' };
  const slots = [];
  const seen = new Set();
  for (const rawSlot of data.slots) {
    const parsed = parseSlot(rawSlot);
    if (!parsed.ok) return parsed;
    if (seen.has(parsed.slot.id)) return { ok: false, error: `id duplicado: ${parsed.slot.id}` };
    seen.add(parsed.slot.id);
    slots.push(parsed.slot);
  }
  const maxSlots = Number.isInteger(data.maxSlots) && data.maxSlots > 0 ? data.maxSlots : DEFAULT_MAX_SLOTS;
  return { ok: true, state: { schemaVersion: SCHEMA_VERSION, maxSlots, slots } };
}

export class SlotStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.backupPath = `${filePath}.bak`;
    this.warnings = [];
  }

  async read() {
    const primary = await this.readFile(this.filePath);
    if (primary.ok) return { state: primary.state, source: 'primary', warnings: [] };
    const backup = await this.readFile(this.backupPath);
    if (backup.ok) {
      const warning = `slots.json invalido (${primary.error}); recuperado do backup`;
      console.error(`[store] ${warning}`);
      return { state: backup.state, source: 'backup', warnings: [warning] };
    }
    const warning = `slots.json invalido (${primary.error}) e backup invalido (${backup.error}); usando padroes`;
    console.error(`[store] ${warning}`);
    return { state: defaultState(), source: 'defaults', warnings: [warning] };
  }

  async readFile(file) {
    try {
      const text = await fs.readFile(file, 'utf8');
      return parseState(text);
    } catch (err) {
      return { ok: false, error: err.code === 'ENOENT' ? 'arquivo inexistente' : err.message };
    }
  }

  async write(state) {
    const payload = JSON.stringify({ ...state, schemaVersion: SCHEMA_VERSION }, null, 2);
    const tmp = `${this.filePath}.tmp`;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      await fs.copyFile(this.filePath, this.backupPath);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    await fs.writeFile(tmp, payload, 'utf8');
    await fs.rename(tmp, this.filePath);
  }
}

export function partitionDirName(partition) {
  return partition.startsWith('persist:') ? partition.slice('persist:'.length) : partition;
}

export async function sweepOrphanPartitions(partitionsRoot, validPartitions, { log = console.error } = {}) {
  let entries;
  try {
    entries = await fs.readdir(partitionsRoot, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return { removed: [], kept: [] };
    throw err;
  }
  const valid = new Set(validPartitions.map(partitionDirName));
  const removed = [];
  const kept = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (valid.has(entry.name)) {
      kept.push(entry.name);
      continue;
    }
    await fs.rm(path.join(partitionsRoot, entry.name), { recursive: true, force: true });
    removed.push(entry.name);
  }
  if (removed.length) log(`[store] particoes orfas removidas: ${removed.join(', ')}`);
  return { removed, kept };
}
