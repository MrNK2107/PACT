import { useSimSnapshot } from '../app/hooks';
import { currentNetView } from '../app/netView';
import { engine } from '../app/simContext';
import { useUI } from '../app/uiStore';
import { fmtTime } from './TelemetryPanel';

/** Open scripted partition of the network (groups and end time), or null. */
export function partitionState(): { groups: readonly (readonly string[])[]; until: number | undefined } | null {
  const groups = engine.net.partitionGroups;
  return groups ? { groups, until: engine.net.partitionUntil } : null;
}

/**
 * Network panel (shown with the "Network partitions" layer, or while a scripted partition is open): the radio
 * components with their colours and members, and the scripted partition with its groups and end time.
 */
export function NetworkPanel() {
  const s = useSimSnapshot();
  const show = useUI((u) => u.showP2P);
  const select = useUI((u) => u.select);
  const part = partitionState();
  if (!show && !part) return null;
  const view = currentNetView();
  const nNodes = view.nodes.length;
  return (
    <section className="panel">
      <h3>
        Network <span className="muted">· {engine.p2p ? `${engine.scenario.policy.partition} policy` : `${engine.system} (no replicas)`}</span>
      </h3>
      {part && (
        <div className="partition">
          <div className="ph-head">
            <b>Scripted partition</b>
            <span>{part.until !== undefined ? `heals at ${fmtTime(part.until)} (in ${fmtTime(Math.max(0, part.until - s.time))})` : 'open-ended'}</span>
          </div>
          {part.groups.map((g, i) => (
            <div key={i} className="ph-group">
              <span className="gi">G{i}</span>
              <span>{i === 0 ? `${g.join(' ')} + unlisted` : g.join(' ')}</span>
            </div>
          ))}
        </div>
      )}
      <div className="comp-head">
        {view.components.length === 1 ? 'One radio component' : `${view.components.length} radio components`} · {nNodes} nodes
      </div>
      <ul className="comps">
        {view.components.slice(0, 12).map((c) => (
          <li key={c.root}>
            <span className="dot" style={{ background: c.color }} />
            <span className="n">{c.members.length}</span>
            <span className="members">
              {c.members.map((m) => (
                <button key={m} className={`link node ${engine.net.kindOf(m) === 'depot' ? 'depot' : ''}`} onClick={() => select(m)}>
                  {m}
                </button>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
