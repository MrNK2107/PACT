import { P2P_DEFAULTS, type DroneMode, type NodeId, type PeerHealth, type TaskRecord } from '../p2p/contracts';
import { compareTaskKey, taskKey } from '../p2p/replica';
import type { SimulationEngine } from '../sim/SimulationEngine';
import type { Vec3 } from '../world/types';

/**
 * Read-only views of the P2P layer for the viewer (REQ-VIZ-001: partitions highlighted, drone modes, ownership).
 * Everything here only reads engine / node state (no RNG, no writes, no cache of a node touched), so the event log
 * and its hash do not depend on whether the viewer is open.
 */

// -------------------------------------------------------------------------------------------------
// Radio components
// -------------------------------------------------------------------------------------------------

/** Stable component palette (distinct from the drone colours' mid tones, readable on the dark scene). */
export const COMPONENT_PALETTE = ['#22d3ee', '#f472b6', '#a3e635', '#fbbf24', '#c084fc', '#fb923c', '#34d399', '#93c5fd'] as const;
/** Colour of a link that works in one direction only (asymmetric link loss). */
export const ONE_WAY_LINK = '#64748b';

/**
 * Connected components of an undirected graph. Returns node id -> component root, the root being the component's
 * smallest member id (string order), so a component keeps its key while its other members come and go.
 */
export function connectedComponents(ids: readonly string[], edges: Iterable<readonly [string, string]>): Map<string, string> {
  const parent = new Map<string, string>();
  for (const id of ids) parent.set(id, id);
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    // path compression
    let c = x;
    while (c !== r) {
      const n = parent.get(c)!;
      parent.set(c, r);
      c = n;
    }
    return r;
  };
  for (const [a, b] of edges) {
    if (!parent.has(a) || !parent.has(b)) continue;
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) continue;
    // the smaller id becomes the root, so the root is always the component minimum
    if (ra < rb) parent.set(rb, ra);
    else parent.set(ra, rb);
  }
  const out = new Map<string, string>();
  for (const id of ids) out.set(id, find(id));
  return out;
}

function hashId(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Colour per component root: the palette slot is a hash of the root id (so a component keeps its colour across
 * recomputes and splits / heals don't recolour the others); colliding roots take the next free slot, in root order.
 */
export function assignComponentColours(roots: readonly string[], palette: readonly string[] = COMPONENT_PALETTE): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<number>();
  for (const r of [...roots].sort()) {
    let slot = hashId(r) % palette.length;
    for (let k = 0; k < palette.length && used.has(slot); k++) slot = (slot + 1) % palette.length;
    used.add(slot);
    out.set(r, palette[slot]);
  }
  return out;
}

export interface NetNode {
  id: NodeId;
  kind: 'drone' | 'depot';
  /** Radio position: drone body, or the depot mast top (`P2P_DEFAULTS.depotMastM` above the depot). */
  pos: Vec3;
}

export interface NetLink {
  a: NodeId;
  b: NodeId;
  /** Usable both ways (`linkUp(a, b) && linkUp(b, a)`); one-way links do not join components. */
  both: boolean;
  /** Depot <-> depot backhaul (wired / cellular, Decision 20), not a radio link. Drawn dashed. */
  backhaul: boolean;
}

export interface NetView {
  /** Sim time and reset epoch of the engine when computed. */
  time: number;
  epoch: number;
  nodes: NetNode[];
  /** Node id -> component root (smallest member id). */
  comp: Map<NodeId, NodeId>;
  /** Components, largest first (ties by root), members sorted. */
  components: { root: NodeId; color: string; members: NodeId[] }[];
  colorOf: Map<NodeId, string>;
  links: NetLink[];
}

/**
 * Current network graph of drones + depots: a link exists when a message would get through in at least one direction
 * (radio: range with dead-zone factors, partition cut, link_loss; depot pairs: the backhaul while it is up);
 * components are taken over the two-way links only, so they match what the nodes can actually reach.
 */
export function computeNetView(eng: SimulationEngine): NetView {
  const net = eng.net;
  const nodes: NetNode[] = [];
  const agentById = new Map(eng.agents.map((a) => [a.id, a]));
  const depotById = new Map(eng.world.depots.map((d) => [d.id, d]));
  for (const id of net.ids()) {
    const kind = net.kindOf(id);
    if (kind === 'drone') {
      const a = agentById.get(id);
      if (a) nodes.push({ id, kind, pos: a.body.pos });
    } else if (kind === 'depot') {
      const d = depotById.get(id);
      if (d) nodes.push({ id, kind, pos: { x: d.pos.x, y: d.pos.y + P2P_DEFAULTS.depotMastM, z: d.pos.z } });
    }
  }
  const links: NetLink[] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i].id;
      const b = nodes[j].id;
      const ab = net.linkUp(a, b);
      const ba = net.linkUp(b, a);
      if (ab || ba) links.push({ a, b, both: ab && ba, backhaul: net.backhaulUp(a, b) });
    }
  }
  const ids = nodes.map((n) => n.id);
  const comp = connectedComponents(
    ids,
    links.filter((l) => l.both).map((l) => [l.a, l.b] as const),
  );
  const members = new Map<NodeId, NodeId[]>();
  for (const id of ids) {
    const r = comp.get(id)!;
    (members.get(r) ?? members.set(r, []).get(r)!).push(id);
  }
  const colorOf = assignComponentColours([...members.keys()]);
  const components = [...members.entries()]
    .map(([root, m]) => ({ root, color: colorOf.get(root)!, members: m }))
    .sort((x, y) => y.members.length - x.members.length || (x.root < y.root ? -1 : x.root > y.root ? 1 : 0));
  return { time: eng.time, epoch: eng.resetEpoch, nodes, comp, components, colorOf, links };
}

// -------------------------------------------------------------------------------------------------
// Drone mode, peer health and quorum (pact)
// -------------------------------------------------------------------------------------------------

export interface DroneNetInfo {
  /** Mode the drone last published in its own status (null before its first status). */
  mode: DroneMode | null;
  /** Peers it reports UNREACHABLE in its status. */
  suspects: NodeId[];
  /** Peers whose integrated health in its view is not ALIVE. */
  unhealthy: { id: NodeId; health: PeerHealth }[];
  /** Drones (me included) whose status reached its replica within the reach window. */
  reachable: NodeId[];
  /** Known fleet: the configured roster minus the drones it has DECLARED_FAILED, me included (Decision 19). */
  known: NodeId[];
  /** QUORUM test of design section 6: reachable known drones are a strict majority of the known fleet. */
  quorum: boolean;
}

/**
 * Same rules as `P2PNode`'s FleetView (reach window on the node's local clock; known fleet straight from the view, which
 * has no cache), recomputed here so the node's own reachability cache is never touched from the viewer.
 */
export function droneNetInfo(eng: SimulationEngine, id: NodeId): DroneNetInfo | null {
  const node = eng.nodeOf(id);
  if (!node) return null;
  const now = node.now;
  const win = eng.p2pConfig.reachWindowS;
  const isDepot = (x: NodeId) => eng.net.kindOf(x) === 'depot' || eng.depotNodeOf(x) !== undefined || eng.world.depots.some((d) => d.id === x);
  const reachable = [id];
  for (const p of node.replica.statusIdList()) {
    if (p === id || isDepot(p)) continue;
    const seen = node.replica.statusSeenAt(p);
    if (seen !== undefined && now - seen <= win) reachable.push(p);
  }
  reachable.sort();
  const known = [...node.view.knownFleet()];
  const knownSet = new Set(known);
  const n = reachable.filter((x) => knownSet.has(x)).length;
  const st = node.replica.getStatus(id);
  const unhealthy: DroneNetInfo['unhealthy'] = [];
  for (const p of node.fd.knownPeers()) {
    if (p === id || isDepot(p)) continue;
    const h = node.healthOf(p);
    if (h !== 'ALIVE') unhealthy.push({ id: p, health: h });
  }
  return { mode: st?.mode ?? null, suspects: [...(st?.suspects ?? [])], unhealthy, reachable, known, quorum: known.length > 0 && n * 2 > known.length };
}

// -------------------------------------------------------------------------------------------------
// Ledger record and replica divergence (pact)
// -------------------------------------------------------------------------------------------------

export interface TaskLedgerInfo {
  rec: TaskRecord;
  /** Replicas holding the ledger key. */
  agree: NodeId[];
  /** Replicas holding an older key. */
  behind: NodeId[];
  /** Replicas that never saw the task. */
  missing: NodeId[];
  /** Replicas with a newer key than the ledger (should stay empty: the ledger is the join of every write). */
  ahead: NodeId[];
}

export function taskLedgerInfo(eng: SimulationEngine, taskId: string): TaskLedgerInfo | null {
  const rec = eng.ledgerRecord(taskId);
  if (!rec) return null;
  const want = taskKey(rec);
  const out: TaskLedgerInfo = { rec, agree: [], behind: [], missing: [], ahead: [] };
  for (const { id, replica } of eng.replicas()) {
    const r = replica.getTask(taskId);
    if (!r) {
      out.missing.push(id);
      continue;
    }
    const c = compareTaskKey(taskKey(r), want);
    (c === 0 ? out.agree : c < 0 ? out.behind : out.ahead).push(id);
  }
  return out;
}

// -------------------------------------------------------------------------------------------------
// Message load and convergence
// -------------------------------------------------------------------------------------------------

/** AT-11 metric: messages sent by drones per drone per minute, beacons (HEARTBEAT) excluded. */
export function messagesPerDroneMin(eng: SimulationEngine): number | null {
  if (!eng.agents.length || eng.time < 1) return null;
  let n = 0;
  for (const a of eng.agents) {
    const st = eng.net.stats(a.id);
    for (const [type, v] of Object.entries(st.byType)) if (type !== 'HEARTBEAT') n += v!.sent;
  }
  return n / eng.agents.length / (eng.time / 60);
}

/** Latest `replica_converged` event (sim time and seconds after the heal), scanning the log backwards. */
export function lastConverged(eng: SimulationEngine, from = 0): { t: number; elapsed: number } | null {
  const ev = eng.events;
  for (let i = ev.length - 1; i >= from; i--) {
    const e = ev[i];
    if (e.type === 'replica_converged') return { t: e.t, elapsed: Number((e.data as { elapsed_s?: number } | undefined)?.elapsed_s ?? NaN) };
  }
  return null;
}
