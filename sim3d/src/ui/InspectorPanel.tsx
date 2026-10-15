import { engine, world } from '../app/simContext';
import { useSimSnapshot } from '../app/hooks';
import { useUI } from '../app/uiStore';
import type { SimSnapshot } from '../sim/SimulationEngine';
import { shapeBounds } from '../world/NoFly';
import type { BuildingData, ChargerData, DemandCluster, DepotData, DistrictData, DropPointData, NoFlyZone, PadData, RoadData, StationData, ZoneData } from '../world/types';
import { windAt } from '../world/Wind';
import { phaseLabel } from './TelemetryPanel';

type Row = [string, string];

const f = (n: number, d = 1) => n.toFixed(d);
const xyz = (p: { x: number; y: number; z: number }) => `${f(p.x)}, ${f(p.y)}, ${f(p.z)}`;

function describe(id: string, snap: SimSnapshot): { title: string; kind: string; rows: Row[] } | null {
  const e = world.index.get(id);
  if (!e) return null;
  switch (e.type) {
    case 'building': {
      const b = e.data as BuildingData;
      const district = world.blocks.find((bk) => bk.id === b.blockId)?.districtId;
      return {
        title: b.name,
        kind: `Building · ${b.kind}`,
        rows: [
          ['ID', b.id],
          ['Zone / district', `${b.zone} · ${district ?? '—'}`],
          ['Block', b.blockId],
          ['Footprint', `${f(b.w)} × ${f(b.d)} m`],
          ['Height', `${f(b.h)} m (collision top ${f(b.bounds.maxY)} m)`],
          ['Centre (x, z)', `${f(b.cx)}, ${f(b.cz)}`],
          ['Material / roof', `${b.material} · ${b.roof}`],
          ['Rooftop pads', b.rooftopPadIds.join(', ') || 'none'],
        ],
      };
    }
    case 'depot': {
      const h = e.data as DepotData;
      const occupants = snap.drones.filter((d) => h.padIds.includes(d.pad));
      return {
        title: h.name,
        kind: 'Depot · parcel hand-off + charging pads (local resource)',
        rows: [
          ['ID', h.id],
          ['District', h.districtId],
          ['Position', xyz(h.pos)],
          ['Charging pads', `${h.padIds.length} (${h.padIds.join(', ')})`],
          ['Hand-off bays', `${h.handoff.length}`],
          ['Catchment shards', `${h.catchmentShards.length}`],
          ['Drones based here', occupants.length ? occupants.map((d) => `${d.id} (${phaseLabel(d.phase)})`).join(', ') : 'none'],
          ['Charging now', `${occupants.filter((d) => d.phase === 'charging').length}`],
          ['Building', h.buildingId],
        ],
      };
    }
    case 'drop point': {
      const p = e.data as DropPointData;
      const w = windAt(world.wind, p.pos.x, p.pos.z);
      return {
        title: p.name,
        kind: `Drop point · ${p.type}`,
        rows: [
          ['ID', p.id],
          ['Type / zone', `${p.type} · ${p.zone}`],
          ['Cluster', p.clusterId],
          ['Shard', `${p.shard} (depot ${world.shards.depotOf[p.shard] ?? '—'})`],
          ['Nearest depot', p.nearestDepotId],
          ['Position', xyz(p.pos)],
          ['Surface', p.rooftop ? `rooftop (${p.buildingId})` : 'ground level'],
          ['Demand weight', f(p.demand, 2)],
          ['Wind here', `${f(Math.hypot(w.vx, w.vz))} m/s`],
          ['Open / active orders', `${snap.siteLoad[p.id] ?? 0}`],
        ],
      };
    }
    case 'cluster': {
      const c = e.data as DemandCluster;
      return { title: c.id, kind: `Demand cluster · ${c.type}`, rows: [['District', c.districtId], ['Demand', f(c.demand, 2)], ['Drop points', `${c.pointIds.length}`]] };
    }
    case 'district': {
      const d = e.data as DistrictData;
      const blocks = world.blocks.filter((b) => b.districtId === d.id);
      const kinds = [...new Set(blocks.map((b) => b.kind))].join(', ');
      return {
        title: d.name,
        kind: `District · ${d.kind}`,
        rows: [
          ['ID', d.id],
          ['Extent', `${f(d.maxX - d.minX, 0)} × ${f(d.maxZ - d.minZ, 0)} m`],
          ['Centrality', f(d.centrality, 2)],
          ['Blocks', `${blocks.length} (${kinds})`],
          ['Drop points', `${world.dropPoints.filter((p) => world.clusters.find((c) => c.id === p.clusterId)?.districtId === d.id).length}`],
        ],
      };
    }
    case 'pad':
    case 'charger': {
      const p = e.data as PadData | ChargerData;
      return { title: p.id, kind: e.type === 'pad' ? 'Charging / landing pad' : 'Charging station', rows: [['ID', p.id], ['Depot', p.depotId], ['Position', xyz(p.pos)]] };
    }
    case 'no-fly zone': {
      const z = e.data as NoFlyZone;
      const bb = shapeBounds(z.shape);
      return {
        title: z.name,
        kind: `No-fly zone · ${z.shape.type}${z.closable ? ' · closable' : ''}`,
        rows: [
          ['ID', z.id],
          ['Reason', z.reason],
          ['State', z.active ? (z.closedFrom !== undefined ? `closed by fault${z.closedUntil !== undefined ? ` until t=${f(z.closedUntil, 0)} s` : ''}` : 'active') : 'open (inactive)'],
          ['Ceiling', `${z.maxY} m`],
          ['Extent', `x ${f(bb.minX, 0)}…${f(bb.maxX, 0)}, z ${f(bb.minZ, 0)}…${f(bb.maxZ, 0)}`],
          ['Source', z.source],
        ],
      };
    }
    case 'road': {
      const r = e.data as RoadData;
      return { title: r.name, kind: `Road · ${r.kind}`, rows: [['ID', r.id], ['Direction', r.dir === 'EW' ? 'east–west' : 'north–south'], ['Width / lanes', `${r.width} m · ${r.lanes}`], ['Bridges', `${r.bridges?.length ?? 0}`]] };
    }
    case 'station': {
      const s = e.data as StationData;
      return { title: s.name, kind: 'Railway station', rows: [['ID', s.id], ['Platform length', `${s.length} m`]] };
    }
    case 'zone': {
      const z = e.data as ZoneData;
      return { title: z.name, kind: 'Zone', rows: [['ID', z.id], ['Type', z.type]] };
    }
    default:
      return { title: id, kind: e.type, rows: Object.entries(e.data as Record<string, unknown>).filter(([, v]) => typeof v !== 'object').map(([k, v]) => [k, String(v)] as Row) };
  }
}

export function InspectorPanel() {
  const snap = useSimSnapshot();
  const sel = useUI((u) => u.selection?.id);
  const select = useUI((u) => u.select);
  const focus = useUI((u) => u.focusSelection);

  if (!sel) {
    return (
      <section className="panel">
        <h3>Inspector</h3>
        <p className="hint">Click a drone, building, depot or drop point in the scene, or choose a drone from the fleet list.</p>
      </section>
    );
  }

  const d = snap.drones.find((x) => x.id === sel);
  if (d) {
    const rows: Row[] = [
      ['State', d.avoiding ? `${phaseLabel(d.phase)} · avoiding ${d.conflictWith.join(', ')}` : d.holdReason ? `${phaseLabel(d.phase)} · ${d.holdReason}` : phaseLabel(d.phase)],
      ['Task', d.taskId ? `${d.taskId}  ${d.pickup} → ${d.delivery}${d.carrying ? ` (carrying ${f(d.payloadKg, 2)} kg)` : ''}` : '—'],
      ['Task state', d.taskId ? `${d.taskState} · P${d.taskPriority} · epoch ${d.taskEpoch} · due ${d.taskDeadline !== null ? `${f(d.taskDeadline, 0)} s${snap.time > d.taskDeadline ? ' (overdue)' : ''}` : '—'}` : '—'],
      ['Destination', d.destination ?? '—'],
      ['Battery', `${f(d.battery, 0)} %`],
      ['Position', xyz(d.pos)],
      ['Altitude', `${f(d.altitude)} m (cruise layer ${d.cruiseAlt ? f(d.cruiseAlt, 0) : '—'} m)`],
      ['Speed / heading', `${f(d.speed)} m/s · ${f(d.heading, 0)}°`],
      ['Route progress', `${d.routeProgress[0]} / ${d.routeProgress[1]} waypoints`],
      ['Neighbours in radio range', `${d.neighbors}`],
      ['Priority tier', `${d.priority}`],
      ['Home pad', d.homePad],
      ['Deliveries', `${d.delivered}`],
      ['Distance flown', `${f(d.distance / 1000, 2)} km`],
    ];
    return (
      <section className="panel">
        <h3>
          <span className="dot" style={{ background: d.color }} /> Drone {d.id}
          <button className="link" onClick={() => select(null)}>
            Clear
          </button>
        </h3>
        <dl className="kv">
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <div className="actions">
          <button className="btn" onClick={focus}>
            Focus camera
          </button>
          <button className="btn" onClick={() => engine.removeDrone(d.id)}>
            Remove drone
          </button>
        </div>
      </section>
    );
  }

  const info = describe(sel, snap);
  if (!info) return null;
  return (
    <section className="panel">
      <h3>
        {info.title}
        <button className="link" onClick={() => select(null)}>
          Clear
        </button>
      </h3>
      <div className="kind">{info.kind}</div>
      <dl className="kv">
        {info.rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <div className="actions">
        <button className="btn" onClick={focus}>
          Focus camera
        </button>
      </div>
    </section>
  );
}
