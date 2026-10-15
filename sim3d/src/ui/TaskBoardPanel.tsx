import { engine, map, scenario } from '../app/simContext';
import { useSimSnapshot } from '../app/hooks';
import { useUI } from '../app/uiStore';
import { fmtTime } from './TelemetryPanel';

const PRI = { 1: 'P1 urgent', 2: 'P2', 3: 'P3 low' } as const;

/** Order board: PRD task states, priority mix, on-time rate, upcoming deadlines, faults. */
export function TaskBoardPanel() {
  const s = useSimSnapshot();
  const select = useUI((u) => u.select);
  const st = s.tasks;
  const onTimePct = st.delivered ? Math.round((100 * st.onTime) / st.delivered) : null;
  return (
    <section className="panel">
      <h3>
        Order board <span className="muted">· {map.name} / {scenario.name}</span>
      </h3>
      <div className="metrics">
        <div className="metric">
          <div className="mv">{st.byState.UNASSIGNED}</div>
          <div className="ml">Unassigned</div>
          <div className="ms">{st.byState.CLAIMED + st.byState.COMMITTED} claimed · {st.byState.PICKED_UP} in flight</div>
        </div>
        <div className="metric">
          <div className="mv">{onTimePct === null ? '—' : `${onTimePct}%`}</div>
          <div className="ml">On time</div>
          <div className="ms">{st.delivered} delivered · {st.late} late</div>
        </div>
        <div className="metric">
          <div className="mv">{st.overdueOpen}</div>
          <div className="ml">Overdue open</div>
          <div className="ms">{st.reordered ? `${st.reordered} re-ordered` : `p95 lateness ${st.p95Lateness.toFixed(0)} s`}</div>
        </div>
      </div>
      <div className="pri-row">
        {([1, 2, 3] as const).map((p) => (
          <span key={p} className={`pri pri-${p}`} title={`${PRI[p]}: ${st.byPriority[p].onTime}/${st.byPriority[p].delivered} on time`}>
            {PRI[p]} · {st.byPriority[p].total}
          </span>
        ))}
        {s.faultsPending > 0 && <span className="pri fault">{s.faultsPending} fault{s.faultsPending > 1 ? 's' : ''} pending</span>}
        {s.closedZones.length > 0 && <span className="pri fault">closed: {s.closedZones.join(', ')}</span>}
        {s.padOutages.length > 0 && <span className="pri fault">pads out: {s.padOutages.join(', ')}</span>}
      </div>
      <ul className="tasks">
        {s.openTasks.slice(0, 8).map((t) => {
          const left = t.deadline - s.time;
          const owner = s.drones.find((d) => d.id === t.owner);
          return (
            <li key={t.id} className={left < 0 ? 'overdue' : left < 120 ? 'soon' : ''} onClick={() => select(t.owner ?? t.drop)} title={`${t.id} → ${t.drop} (${t.type}) from ${t.depot}`}>
              <span className={`pri pri-${t.priority}`}>P{t.priority}</span>
              <code>{t.id.split(':').slice(0, 1)}·{t.drop}</code>
              <span className="state">{t.state.toLowerCase().replace('_', ' ')}</span>
              {owner && <span className="dot" style={{ background: owner.color }} />}
              <span className={`due ${left < 0 ? 'bad' : ''}`}>{left < 0 ? `-${fmtTime(-left)}` : fmtTime(left)}</span>
            </li>
          );
        })}
        {!s.openTasks.length && <li className="empty">No open tasks{engine.status === 'idle' ? ' — press Start' : ''}.</li>}
      </ul>
    </section>
  );
}
