/**
 * Radio-shadow-aware ownership, part 1: the learned radio shadow map and the dark-stretch forecast (Decision 22,
 * "planned silence").
 *
 * Every drone samples, every `samplePeriodS` on its own clock, whether it is *dark* where it is: no depot status
 * reached it (directly or relayed by gossip) within `darkWindowS`. That is the condition under which its lease renewals
 * cannot reach the origin depot either. Samples go into a grid of `cellM` cells keyed by `(floor(x / cellM),
 * floor(z / cellM))`.
 *
 * State-based CRDT: per (cell, origin node) two G-counters, `samples` and `dark`, each written only by `origin`. The
 * join is the per-(cell, origin) max of each counter: commutative, associative, idempotent, so any gossip order,
 * duplication or loss converges. A cell's statistics are the sums over origins. Cells with fewer than `minSamples`
 * samples are unknown and never forecast dark.
 *
 * `predictedDarkS(path, speed, map)` walks a planned route and returns the longest contiguous stretch (seconds at
 * `speed`) through dark cells. The owner of a pre-pickup lease uses it to announce, before it goes silent, how long the
 * silence will last (`plannedLeaseS`), so the origin depot does not re-open a job whose owner is alive but shadowed.
 *
 * Deterministic: no clock (the caller passes local times), no randomness, sorted iteration. Imports nothing from the
 * engine, the network model or safety.
 */
import type { NodeId, RadioMapEntry, RadioMapParams } from './contracts';
import type { GossipPiggyback } from './gossip';

export type { RadioMapEntry, RadioMapParams } from './contracts';

export interface XZ {
  x: number;
  z: number;
}

/** Cell key of a position: `"<ix>,<iz>"`. */
export function cellKey(x: number, z: number, cellM: number): string {
  return `${Math.floor(x / cellM)},${Math.floor(z / cellM)}`;
}

const CELL_RE = /^-?\d{1,7},-?\d{1,7}$/;

/** What the forecast needs from a map. */
export interface DarkLookup {
  readonly cellM: number;
  isDark(x: number, z: number): boolean;
}

/**
 * Longest dark stretch along `path` (seconds at `speedMps`). The path is walked segment by segment in steps of at
 * most `cellM / 4`; a step counts as dark when its midpoint lies in a dark cell. A dark run carries across waypoints,
 * and across lit gaps of at most `bridgeM` metres (the gap counts as dark once the run resumes). Pure; 0 for an empty
 * or one-point path or a non-positive speed.
 *
 * Properties (tested): 0 <= result <= length / speed; monotone in the dark set (more dark cells never shorten it);
 * dropping leading waypoints never lengthens it; bridging never shortens it.
 */
export function predictedDarkS(path: readonly XZ[], speedMps: number, map: DarkLookup, bridgeM = 0): number {
  if (path.length < 2 || !(speedMps > 0)) return 0;
  const step = map.cellM / 4;
  let run = 0;
  let gap = 0;
  let best = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (!(len > 0)) continue;
    const n = Math.max(1, Math.ceil(len / step));
    const sub = len / n;
    for (let k = 0; k < n; k++) {
      const f = (k + 0.5) / n;
      if (map.isDark(a.x + (b.x - a.x) * f, a.z + (b.z - a.z) * f)) {
        run += gap + sub;
        gap = 0;
        if (run > best) best = run;
      } else if (run > 0) {
        gap += sub;
        if (gap > bridgeM) {
          run = 0;
          gap = 0;
        }
      }
    }
  }
  return best / speedMps;
}

/**
 * Adaptive lease ("planned silence"): enough to cover a forecast dark stretch plus one renew period and a margin,
 * never below the base lease, never above the cap. `darkS = 0` gives the base lease.
 */
export function plannedLeaseS(baseS: number, capS: number, darkS: number, renewPeriodS: number, marginS: number): number {
  if (!(darkS > 0)) return baseS;
  return Math.min(Math.max(baseS, darkS + renewPeriodS + marginS), Math.max(baseS, capS));
}

// ---- CRDT state ------------------------------------------------------------------------------------------------

/** Pure CRDT state: `"<cell>|<origin>"` -> `[samples, dark]`. */
export type RadioMapState = ReadonlyMap<string, readonly [number, number]>;

const entryKey = (cell: string, origin: NodeId) => `${cell}|${origin}`;

/** Join of two states: per key, the max of each counter. */
export function joinRadioState(a: RadioMapState, b: RadioMapState): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>();
  for (const [k, v] of a) out.set(k, [v[0], v[1]]);
  for (const [k, v] of b) {
    const cur = out.get(k);
    out.set(k, cur ? [Math.max(cur[0], v[0]), Math.max(cur[1], v[1])] : [v[0], v[1]]);
  }
  return out;
}

/** A well-formed wire entry: cell key, non-empty origin, integer counters with 0 <= dark <= samples. */
export function isRadioMapEntry(e: unknown): e is RadioMapEntry {
  if (!Array.isArray(e) || e.length < 4) return false;
  const [cell, origin, n, d] = e as unknown[];
  return (
    typeof cell === 'string' &&
    CELL_RE.test(cell) &&
    typeof origin === 'string' &&
    origin.length > 0 &&
    origin.length <= 64 &&
    !origin.includes('|') &&
    Number.isSafeInteger(n) &&
    Number.isSafeInteger(d) &&
    (d as number) >= 0 &&
    (n as number) >= (d as number)
  );
}

export interface RadioMapCounters {
  /** Own observations recorded. */
  observations: number;
  /** Entries put on the wire. */
  entriesSent: number;
  /** Received entries that raised a counter. */
  entriesMerged: number;
  /** Received entries dropped: malformed, or a new key past `maxEntries`. */
  entriesIgnored: number;
}

/**
 * One node's replica of the radio map. `observe` is the only local write (own origin); `merge` joins entries received
 * by gossip; `take` picks the entries for the next push (changed ones first, then a rotating sweep over every entry for
 * anti-entropy), at most `gossipMaxEntries`.
 */
export class RadioMap implements DarkLookup {
  readonly cellM: number;
  readonly counters: RadioMapCounters = { observations: 0, entriesSent: 0, entriesMerged: 0, entriesIgnored: 0 };
  private readonly entries = new Map<string, [number, number]>();
  /** Per cell: sums over origins (maintained on every change). */
  private readonly cells = new Map<string, [number, number]>();
  private readonly dirty = new Set<string>();
  private sorted: string[] | null = null;
  private cursor = 0;

  constructor(
    readonly self: NodeId,
    readonly p: RadioMapParams,
  ) {
    this.cellM = p.cellM;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Record one own observation at (x, z). */
  observe(x: number, z: number, dark: boolean): void {
    const k = entryKey(cellKey(x, z, this.cellM), this.self);
    const cur = this.entries.get(k);
    if (!cur && this.entries.size >= this.p.maxEntries) return;
    this.set(k, cur ? cur[0] + 1 : 1, (cur ? cur[1] : 0) + (dark ? 1 : 0));
    this.counters.observations++;
  }

  /** Join received wire entries (malformed ones ignored). Returns how many raised a counter. */
  merge(entries: unknown): number {
    if (!Array.isArray(entries)) return 0;
    let changed = 0;
    for (const e of entries) {
      if (!isRadioMapEntry(e)) {
        this.counters.entriesIgnored++;
        continue;
      }
      const [cell, origin, n, d] = e;
      const k = entryKey(cell, origin);
      const cur = this.entries.get(k);
      if (!cur && this.entries.size >= this.p.maxEntries) {
        this.counters.entriesIgnored++;
        continue;
      }
      const nn = cur ? Math.max(cur[0], n) : n;
      const nd = cur ? Math.max(cur[1], d) : d;
      if (cur && nn === cur[0] && nd === cur[1]) continue;
      this.set(k, nn, nd);
      changed++;
    }
    this.counters.entriesMerged += changed;
    return changed;
  }

  /** Entries for the next push, or null when there is nothing to send. Deterministic (sorted keys, rotating cursor). */
  take(): RadioMapEntry[] | null {
    if (!this.entries.size) return null;
    const max = Math.max(0, this.p.gossipMaxEntries);
    const sweep = Math.min(max, Math.max(0, this.p.gossipSweepEntries));
    const keys: string[] = [];
    const picked = new Set<string>();
    for (const k of [...this.dirty].sort()) {
      if (keys.length >= max - sweep) break;
      keys.push(k);
      picked.add(k);
    }
    // anti-entropy sweep: the next `sweep` entries after the cursor (a peer that missed a change gets it eventually)
    const all = this.sortedKeys();
    let scanned = 0;
    let swept = 0;
    while (scanned < all.length && swept < sweep && keys.length < max) {
      const k = all[(this.cursor + scanned) % all.length];
      scanned++;
      if (picked.has(k)) continue;
      keys.push(k);
      picked.add(k);
      swept++;
    }
    this.cursor = (this.cursor + scanned) % all.length;
    for (const k of keys) this.dirty.delete(k);
    if (!keys.length) return null;
    const out: RadioMapEntry[] = keys.map((k) => {
      const bar = k.lastIndexOf('|');
      const v = this.entries.get(k)!;
      return [k.slice(0, bar), k.slice(bar + 1), v[0], v[1]];
    });
    this.counters.entriesSent += out.length;
    return out;
  }

  /** Samples and dark samples of a cell, over every origin. */
  cellStats(cell: string): { samples: number; dark: number } {
    const c = this.cells.get(cell);
    return c ? { samples: c[0], dark: c[1] } : { samples: 0, dark: 0 };
  }

  /**
   * Dark fraction of the cell at (x, z): its own statistics once it has `minSamples` samples, else (with
   * `poolNeighbours`) the pooled statistics of its 3 x 3 neighbourhood, else null (unknown).
   */
  darkFraction(x: number, z: number): number | null {
    const ix = Math.floor(x / this.cellM);
    const iz = Math.floor(z / this.cellM);
    const c = this.cells.get(`${ix},${iz}`);
    if (c && c[0] >= this.p.minSamples) return c[1] / c[0];
    if (!this.p.poolNeighbours) return null;
    let n = 0;
    let d = 0;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const q = this.cells.get(`${ix + dx},${iz + dz}`);
        if (q) {
          n += q[0];
          d += q[1];
        }
      }
    }
    return n >= this.p.minSamples ? d / n : null;
  }

  isDark(x: number, z: number): boolean {
    const f = this.darkFraction(x, z);
    return f !== null && f >= this.p.darkThreshold;
  }

  /** Forecast along a path at `speedMps` (default the configured cruise speed). */
  predictedDarkS(path: readonly XZ[], speedMps = this.p.cruiseSpeedMps): number {
    return predictedDarkS(path, speedMps, this, this.p.bridgeM);
  }

  /** The CRDT state (a copy, sorted by key). */
  state(): Map<string, [number, number]> {
    const out = new Map<string, [number, number]>();
    for (const k of this.sortedKeys()) {
      const v = this.entries.get(k)!;
      out.set(k, [v[0], v[1]]);
    }
    return out;
  }

  /** Cells known with at least `minSamples` samples, sorted, with their statistics (viewer / reports). */
  knownCells(): { cell: string; samples: number; dark: number }[] {
    return [...this.cells.keys()]
      .sort()
      .map((cell) => ({ cell, samples: this.cells.get(cell)![0], dark: this.cells.get(cell)![1] }))
      .filter((c) => c.samples >= this.p.minSamples);
  }

  private set(k: string, n: number, d: number): void {
    const cur = this.entries.get(k);
    if (!cur) this.sorted = null;
    const cell = k.slice(0, k.lastIndexOf('|'));
    const agg = this.cells.get(cell) ?? [0, 0];
    agg[0] += n - (cur ? cur[0] : 0);
    agg[1] += d - (cur ? cur[1] : 0);
    this.cells.set(cell, agg);
    this.entries.set(k, [n, d]);
    this.dirty.add(k);
  }

  private sortedKeys(): string[] {
    if (!this.sorted) this.sorted = [...this.entries.keys()].sort();
    return this.sorted;
  }
}

/** Gossip piggyback of a radio map: its next entries on each push, every received `radio` field merged. */
export function radioPiggyback(rm: RadioMap): GossipPiggyback {
  return {
    take: () => {
      const radio = rm.take();
      return radio ? { radio } : null;
    },
    accept: (payload) => {
      if (payload.radio !== undefined) rm.merge(payload.radio);
    },
  };
}
