import { engine, map, scenario } from '../app/simContext';
import { useSimSnapshot } from '../app/hooks';
import { useUI, type ToggleKey } from '../app/uiStore';
import { MAPS } from '../map/registry';
import { SCENARIOS, VISIBLE_MAP_IDS, scenariosForMap, tierOf } from '../scenario/registry';
import { SYSTEM_IDS, type SystemId } from '../sim/systems';

const SYSTEM_LABELS: Record<SystemId, string> = {
  pact: 'PACT',
  central_full: 'Central hub',
  central_hub_loss: 'Central, hub can fail',
  greedy_nearest: 'Greedy nearest',
  cbba_plain: 'Plain CBBA (unfenced)',
};

function navigate(params: Record<string, string>) {
  const u = new URL(location.href);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  location.href = u.toString();
}

const SPEEDS = [0.5, 1, 2, 4, 8];

export function SimulationControls() {
  const s = useSimSnapshot();
  const resetCamera = useUI((u) => u.resetCamera);
  const focus = useUI((u) => u.focusSelection);
  const selection = useUI((u) => u.selection);
  const select = useUI((u) => u.select);

  const primaryLabel = s.status === 'idle' ? 'Start' : s.status === 'running' ? 'Pause' : 'Resume';
  const onPrimary = () => {
    if (s.status === 'idle') engine.start();
    else if (s.status === 'running') engine.pause();
    else engine.resume();
  };
  const selectedIsDrone = !!selection && s.drones.some((d) => d.id === selection.id);

  return (
    <div className="toolbar">
      <div className="group" title={map.description}>
        <span className="lbl">Map</span>
        <select
          className="select"
          value={map.id}
          onChange={(e) => {
            // switching map drops the scenario so the map's first scenario is used
            const u = new URL(location.href);
            u.searchParams.set('map', e.target.value);
            u.searchParams.delete('scenario');
            location.href = u.toString();
          }}
        >
          {(VISIBLE_MAP_IDS.includes(map.id) ? VISIBLE_MAP_IDS : [map.id, ...VISIBLE_MAP_IDS]).map((id) => (
            <option key={id} value={id} title={MAPS[id].description}>
              {MAPS[id].name} · {MAPS[id].tier}
            </option>
          ))}
        </select>
      </div>
      <div className="group" title={scenario.description}>
        <span className="lbl">Scenario</span>
        <select className="select" value={scenario.name} onChange={(e) => navigate({ map: map.id, scenario: e.target.value })}>
          {scenariosForMap(map.id).map((s) => (
            <option key={s.name} value={s.name} title={SCENARIOS[s.name].description}>
              {s.name} · {tierOf(s)}
            </option>
          ))}
        </select>
      </div>
      <div className="group" title="System under test: PACT or a benchmark baseline">
        <span className="lbl">System</span>
        <select className="select" value={engine.system} onChange={(e) => navigate({ map: map.id, scenario: scenario.name, system: e.target.value })}>
          {SYSTEM_IDS.map((id) => (
            <option key={id} value={id}>
              {SYSTEM_LABELS[id]}
            </option>
          ))}
        </select>
      </div>
      <div className="group">
        <button className={`btn primary ${s.status === 'running' ? 'on' : ''}`} onClick={onPrimary}>
          {primaryLabel}
        </button>
        <button
          className="btn"
          onClick={() => {
            engine.reset();
            select(null);
          }}
        >
          Reset
        </button>
      </div>

      <div className="group" role="group" aria-label="Simulation speed">
        <span className="lbl">Speed</span>
        <div className="seg">
          {SPEEDS.map((v) => (
            <button key={v} className={`segbtn ${s.speed === v ? 'on' : ''}`} onClick={() => engine.setSpeed(v)}>
              {v}×
            </button>
          ))}
        </div>
      </div>

      <div className="group">
        <span className="lbl">Drones</span>
        <button className="btn sq" disabled={s.fleet === 0} onClick={() => engine.removeDrone(selectedIsDrone ? selection!.id : undefined)} title={selectedIsDrone ? `Remove ${selection!.id}` : 'Remove last drone'}>
          −
        </button>
        <span className="count">{s.fleet}</span>
        <button className="btn sq" disabled={!s.canAddDrone} onClick={() => engine.addDrone()} title={s.canAddDrone ? 'Add a drone at a free pad' : 'No free pads / fleet limit reached'}>
          +
        </button>
      </div>

      <div className="group">
        <button className="btn" onClick={resetCamera}>
          Reset view
        </button>
        <button className="btn" disabled={!selection} onClick={focus} title="Centre the camera on the selection">
          Focus
        </button>
      </div>
    </div>
  );
}

const LAYERS: { key: ToggleKey; label: string; hint: string }[] = [
  { key: 'showBuildings', label: 'Buildings', hint: 'Hide buildings and rooftop equipment' },
  { key: 'showGrid', label: 'Navigation grid', hint: '20 m grid, flight boundary, planner occupancy layer' },
  { key: 'showRoutes', label: 'Routes', hint: 'Planned, active, completed and avoidance paths' },
  { key: 'showWaypoints', label: 'Waypoints', hint: 'Remaining waypoints of each route' },
  { key: 'showNoFly', label: 'No-fly zones', hint: 'Restricted airspace' },
  { key: 'showObstacles', label: 'Obstacle volumes', hint: 'Collision volumes used by the planner + moving-obstacle safety bubbles' },
  { key: 'showComms', label: 'Comm ranges', hint: 'Radio range rings and live links between drones' },
  { key: 'showRadio', label: 'Radio dead zones', hint: 'Areas where the radio range shrinks and packets are lost' },
  { key: 'showLabels', label: 'Labels', hint: 'Depot, drop-point, shard and drone tags' },
  { key: 'showWind', label: 'Wind field', hint: 'Wind vectors on the 100 m grid (affects energy use)' },
  { key: 'showShards', label: 'Shards', hint: '500 m hex shards coloured by depot catchment' },
];

export function LayerPanel() {
  const ui = useUI();
  return (
    <section className="panel">
      <h3>Layers</h3>
      <ul className="layers">
        {LAYERS.map((l) => (
          <li key={l.key}>
            <label title={l.hint}>
              <input type="checkbox" checked={ui[l.key]} onChange={() => ui.toggle(l.key)} />
              <span>{l.label}</span>
            </label>
          </li>
        ))}
      </ul>
    </section>
  );
}
