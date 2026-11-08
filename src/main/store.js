import fs from 'node:fs/promises';
import path from 'node:path';

export const SCHEMA_VERSION = 1;
export const DEFAULT_MAX_SLOTS = 8;
export const MAX_SLOTS_LIMIT = 16;

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
  const { id, name, url, partition, ratios, muted, zoomFactor, automation, lightMode } = raw;
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
    lightMode: lightMode === true,
    automation: parseAutomation(automation),
  };
  return { ok: true, slot };
}

export function parseAutomation(raw) {
  const base = { enabled: false, consent: false, exitEconomy: true, mode: 'fixed', intervalMs: 2000, jitterMs: 800, maxPerMin: 20 };
  if (!raw || typeof raw !== 'object') return base;
  const mode = raw.mode === 'until-catch' ? 'until-catch' : 'fixed';
  const num = (v, fallback, min, max) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  return {
    enabled: raw.enabled === true && raw.consent === true,
    consent: raw.consent === true,
    exitEconomy: raw.exitEconomy !== false,
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
  // O limite nunca fica abaixo das sessoes ja salvas: restaurar acima do
  // limite descartaria a sessao (e a particao dela seria varrida depois).
  const stored = Number.isInteger(data.maxSlots) && data.maxSlots > 0 ? data.maxSlots : DEFAULT_MAX_SLOTS;
  const maxSlots = Math.max(Math.min(MAX_SLOTS_LIMIT, stored), slots.length);
  return { ok: true, state: { schemaVersion: SCHEMA_VERSION, maxSlots, slots } };
}

export function buildSnapshot(previous, slots) {
  return {
    ...previous,
    slots: (slots ?? []).map((s) => {
      const prev = previous?.slots?.find((p) => p.id === s.id) ?? {};
      return {
        id: s.id,
        name: s.name,
        url: s.url,
        partition: `persist:${s.id}`,
        ratios: s.ratios ?? prev.ratios ?? null,
        muted: s.muted === true,
        zoomFactor: s.zoomFactor ?? 1,
        lightMode: s.lightMode === true,
        automation: s.automation ?? null,
      };
    }),
  };
}

export class SlotStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.backupPath = `${filePath}.bak`;
    this.warnings = [];
    this.queue = Promise.resolve();
    this.writeSeq = 0;
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
    if (primary.error === 'arquivo inexistente') {
      return { state: defaultState(), source: 'defaults', warnings: [] };
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

  write(state) {
    const run = this.queue.then(() => this.writeNow(state));
    this.queue = run.catch(() => {});
    return run;
  }

  async writeNow(state) {
    const payload = JSON.stringify({ ...state, schemaVersion: SCHEMA_VERSION }, null, 2);
    const tmp = `${this.filePath}.${process.pid}.${++this.writeSeq}.tmp`;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      await fs.copyFile(this.filePath, this.backupPath);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    try {
      await fs.writeFile(tmp, payload, 'utf8');
      await fs.rename(tmp, this.filePath);
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
  }
}

export function partitionDirName(partition) {
  return partition.startsWith('persist:') ? partition.slice('persist:'.length) : partition;
}

/**
 * Particoes fora do estado vao para a QUARENTENA em vez de serem apagadas: um
 * clique errado no "x", um slots.json ilegivel ou uma restauracao parcial nao
 * podem custar o login de uma conta. A quarentena e limpa por idade.
 */
export async function sweepOrphanPartitions(
  partitionsRoot,
  validPartitions,
  { log = console.error, trashRoot = `${partitionsRoot}-trash`, maxAgeDays = 14, now = Date.now() } = {}
) {
  const removed = [];
  const kept = [];
  const failed = [];
  const purge = async () => {
    let entries;
    try {
      entries = await fs.readdir(trashRoot, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    const maxAge = maxAgeDays * 24 * 60 * 60 * 1000;
    for (const entry of entries) {
      const target = path.join(trashRoot, entry.name);
      try {
        const st = await fs.stat(target);
        if (now - st.mtimeMs > maxAge) {
          await fs.rm(target, { recursive: true, force: true });
          log(`[store] quarentena expirada removida: ${entry.name}`);
        }
      } catch {
        /* sumiu no meio do caminho */
      }
    }
  };
  await purge();
  let entries;
  try {
    entries = await fs.readdir(partitionsRoot, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return { removed, kept, failed };
    throw err;
  }
  const valid = new Set(validPartitions.map(partitionDirName));
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (valid.has(entry.name)) {
      kept.push(entry.name);
      continue;
    }
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
    const target = path.join(trashRoot, `${entry.name}.${stamp}`);
    try {
      await fs.mkdir(trashRoot, { recursive: true });
      await fs.rename(path.join(partitionsRoot, entry.name), target);
      await fs.utimes(target, new Date(now), new Date(now)).catch(() => {});
      removed.push(entry.name);
    } catch (err) {
      failed.push(entry.name);
      log(`[store] nao consegui mover ${entry.name} para a quarentena: ${err.message}`);
    }
  }
  if (removed.length) log(`[store] particoes orfas em quarentena (${trashRoot}): ${removed.join(', ')}`);
  return { removed, kept, failed };
}
