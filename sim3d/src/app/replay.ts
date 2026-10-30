import type { SimulationEngine, StructuredEvent } from '../sim/SimulationEngine';

/**
 * Replay viewer (TC-13). A run is a pure function of scenario, system and seed (AT-01), so the viewer does not store
 * frames: it re-simulates. Seeking back is reset + start + advance; a loaded `events.jsonl` is checked line by line
 * against the re-simulated log, which both verifies the recording and proves the replay shows the same run.
 */

export interface LoadedLog {
  /** Raw JSONL lines, as exported by `SimulationEngine.exportEventsJsonl`. */
  lines: string[];
  events: StructuredEvent[];
  /** Latest event time (s). Times are not monotonic within a tick, so this is the maximum, not the last line's. */
  endT: number;
  /** From the `sim_started` event, when present. */
  scenario: string | null;
  seed: number | null;
}

export function parseEventLog(text: string): LoadedLog {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const events: StructuredEvent[] = [];
  for (const [i, line] of lines.entries()) {
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      throw new Error(`line ${i + 1} is not JSON`);
    }
    const e = o as Partial<StructuredEvent>;
    if (typeof e.t !== 'number' || typeof e.type !== 'string') throw new Error(`line ${i + 1} is not an event (needs t and type)`);
    events.push({ t: e.t, agent: e.agent ?? null, type: e.type, data: (e.data as Record<string, unknown>) ?? {} });
  }
  const start = events.find((e) => e.type === 'sim_started');
  return {
    lines,
    events,
    endT: events.reduce((m, e) => Math.max(m, e.t), 0),
    scenario: typeof start?.data.scenario === 'string' ? start.data.scenario : null,
    seed: typeof start?.data.seed === 'number' ? start.data.seed : null,
  };
}

export type LogComparison =
  | { match: true; lines: number }
  | { match: false; index: number; t: number | null; expected: string | null; actual: string | null };

/**
 * Compares a recorded log with the engine's log. The log is append-only, so a recording made at any point of the run
 * is a prefix of the full log (the engine may have run further). Times are not monotonic inside a tick (board events
 * carry their own time), which is why this compares by position, not by time window.
 */
export function compareLogs(recorded: string[], simulated: string[]): LogComparison {
  for (let i = 0; i < recorded.length; i++) {
    if (recorded[i] !== simulated[i]) {
      const ref = recorded[i];
      return { match: false, index: i, t: (JSON.parse(ref) as { t: number }).t, expected: ref, actual: simulated[i] ?? null };
    }
  }
  return { match: true, lines: recorded.length };
}

/** Distinct parcels delivered, extra deliveries of an already delivered parcel (I1 breaks), and deliveries after `after` s. */
export function deliveryCounts(events: readonly StructuredEvent[], after = Number.POSITIVE_INFINITY): { delivered: number; duplicates: number; after: number } {
  const seen = new Set<string>();
  let duplicates = 0;
  let late = 0;
  for (const e of events) {
    if (e.type !== 'delivered') continue;
    const task = String(e.data.task);
    if (seen.has(task)) duplicates++;
    else seen.add(task);
    if (e.t >= after) late++;
  }
  return { delivered: seen.size, duplicates, after: late };
}

/** FNV-1a over a JSONL text, the same hash as `SimulationEngine.eventHash`. */
export function hashLog(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Events worth a marker on the timeline: faults, failures, safety and ownership incidents. */
export type MarkerKind = 'fault' | 'failure' | 'recovery' | 'delivery';

const MARKER_TYPES: Record<string, MarkerKind> = {
  partition_end: 'recovery',
  link_loss_end: 'recovery',
  backhaul_restored: 'recovery',
  replica_converged: 'recovery',
  drone_lost_in_flight: 'failure',
  zombie_stop: 'failure',
  lease_expired: 'failure',
  loss_of_separation: 'failure',
  battery_depleted: 'failure',
  structure_hit: 'failure',
  task_reordered: 'recovery',
  delivered: 'delivery',
};

export interface Marker {
  t: number;
  kind: MarkerKind;
  label: string;
}

export function markersOf(events: readonly StructuredEvent[]): Marker[] {
  const out: Marker[] = [];
  for (const e of events) {
    // injected faults log as `fault_<type>` (Faults.ts); failed / unsupported fault definitions are not incidents
    // (the engine's own fault hooks log type `fault` with `data.type`)
    const prefixed = e.type.startsWith('fault_') && e.type !== 'fault_failed' && e.type !== 'fault_unsupported';
    const isFault = prefixed || e.type === 'fault';
    const kind = isFault ? 'fault' : MARKER_TYPES[e.type];
    if (!kind) continue;
    const what = prefixed ? e.type.slice('fault_'.length) : e.type === 'fault' && typeof e.data.type === 'string' ? e.data.type : e.type;
    out.push({ t: e.t, kind, label: `${what}${e.agent ? ` · ${e.agent}` : ''}` });
  }
  return out;
}

/** Next marker strictly after `t` (skipping deliveries, which are frequent), for "jump to next event". */
export function nextIncident(markers: readonly Marker[], t: number): Marker | null {
  return markers.find((m) => m.kind !== 'delivery' && m.t > t + 0.05) ?? null;
}

/**
 * Seeks the engine to `t` by re-simulating, in slices of `slice` steps so the page stays responsive. Seeking forward
 * continues from the current state; seeking back restarts the run. Leaves the engine paused.
 */
export async function seekEngine(engine: SimulationEngine, t: number, onProgress?: (frac: number) => void, slice = 1500): Promise<void> {
  const target = Math.max(0, t);
  if (target < engine.time - 1e-9 || engine.status === 'idle') {
    engine.reset();
    engine.start();
  }
  engine.pause();
  const from = engine.time;
  while (!engine.advanceTo(target, slice)) {
    onProgress?.((engine.time - from) / Math.max(1e-9, target - from));
    await new Promise((r) => setTimeout(r, 0));
  }
  onProgress?.(1);
}

/**
 * Re-simulates far enough to compare a recording: to its latest event time, then on in 1 s steps until the run has
 * produced as many events as the recording (an event can be appended after the tick its time stamp names), within a
 * grace of `graceS` seconds. Then compares line by line.
 */
export async function verifyRecording(engine: SimulationEngine, log: LoadedLog, onProgress?: (frac: number) => void, graceS = 30): Promise<LogComparison> {
  if (engine.time > log.endT + 1e-9) await seekEngine(engine, 0);
  await seekEngine(engine, log.endT, onProgress);
  while (engine.events.length < log.lines.length && engine.time < log.endT + graceS) await seekEngine(engine, engine.time + 1);
  return compareLogs(log.lines, engine.exportEventsJsonl().split('\n'));
}

export function downloadText(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/x-ndjson' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
