import { useSimSnapshot } from '../app/hooks';
import { useUI } from '../app/uiStore';
import type { DroneSummary } from '../sim/SimulationEngine';

export function fmtTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const PHASE: Record<string, string> = {
  idle: 'Idle',
  claiming: 'Bidding',
  to_pickup: 'To pickup',
  loading: 'Loading',
  to_delivery: 'To delivery',
  unloading: 'Unloading',
  returning: 'Returning',
  charging: 'Charging',
};
export const phaseLabel = (p: string) => PHASE[p] ?? p;

function Metric({ label, value, sub, tone }: { label: string; value: string | number; sub?: string; tone?: 'warn' | 'ok' }) {
  return (
    <div className={`metric ${tone ?? ''}`}>
      <div className="mv">{value}</div>
      <div className="ml">{label}</div>
      {sub && <div className="ms">{sub}</div>}
    </div>
  );
}

export function TelemetryPanel() {
  const s = useSimSnapshot();
  return (
    <section className="panel">
      <h3>
        Telemetry
        <span className={`status ${s.status}`}>{s.status === 'idle' ? 'Ready' : s.status === 'running' ? 'Running' : 'Paused'}</span>
      </h3>
      <div className="metrics">
        <Metric label="Sim time" value={fmtTime(s.time)} sub={`${s.speed}× speed`} />
        <Metric label="Active drones" value={s.airborne} sub={`of ${s.fleet} in fleet`} />
        <Metric label="Pending deliveries" value={s.pending} sub={`${s.open} unassigned`} />
        <Metric label="Completed" value={s.completed} />
        <Metric label="Avoidance events" value={s.activeConflicts} sub={`${s.totalConflicts} total`} tone={s.activeConflicts ? 'warn' : undefined} />
        <Metric label="Charging" value={s.charging} />
      </div>
      <div className="safety">
        <span title="Smallest centre-to-centre distance between two airborne drones so far">
          Min separation <b>{s.minSeparation === null ? '—' : `${s.minSeparation.toFixed(1)} m`}</b>
        </span>
        <span className={s.collisions ? 'bad' : ''} title="Pairs that came closer than the contact distance">
          Separation losses <b>{s.collisions}</b>
        </span>
        <span className={s.structureHits ? 'bad' : ''} title="Samples where an airborne drone was inside a building volume">
          Structure hits <b>{s.structureHits}</b>
        </span>
      </div>
    </section>
  );
}

function BatteryBar({ v }: { v: number }) {
  const tone = v < 25 ? 'low' : v < 50 ? 'mid' : 'ok';
  return (
    <span className="bat" title={`${v.toFixed(0)}%`}>
      <i className={tone} style={{ width: `${Math.max(2, v)}%` }} />
    </span>
  );
}

export function FleetPanel() {
  const s = useSimSnapshot();
  const sel = useUI((u) => u.selection?.id);
  const select = useUI((u) => u.select);
  return (
    <section className="panel">
      <h3>Fleet</h3>
      <div className="fleet">
        {s.drones.map((d: DroneSummary) => (
          <button key={d.id} className={`row ${sel === d.id ? 'sel' : ''}`} onClick={() => select(d.id)}>
            <span className="dot" style={{ background: d.color }} />
            <span className="id">{d.id}</span>
            <span className="ph">{d.avoiding ? 'Avoiding' : d.holdReason ? 'Holding' : phaseLabel(d.phase)}</span>
            <BatteryBar v={d.battery} />
            <span className="alt">{d.altitude.toFixed(0)} m</span>
          </button>
        ))}
        {s.drones.length === 0 && <div className="empty">No drones in the fleet.</div>}
      </div>
    </section>
  );
}

export function EventLog() {
  const s = useSimSnapshot();
  return (
    <section className="panel grow">
      <h3>Event log</h3>
      <ul className="log">
        {s.events.map((e, i) => (
          <li key={`${e.t}-${i}`} className={e.kind}>
            <time>{fmtTime(e.t)}</time>
            <span>{e.text}</span>
          </li>
        ))}
        {s.events.length === 0 && <li className="empty">Press Start to begin.</li>}
      </ul>
    </section>
  );
}
