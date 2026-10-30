import { Canvas } from '@react-three/fiber';
import * as THREE from 'three';
import { useSimSnapshot } from './app/hooks';
import { offline } from './app/offline';
import { deliveryCounts } from './app/replay';
import { engine } from './app/simContext';
import { useUI } from './app/uiStore';
import { EnvironmentScene, HOME_CAMERA } from './render/EnvironmentScene';
import { COMPONENT_PALETTE } from './app/netGraph';
import { InspectorPanel } from './ui/InspectorPanel';
import { NetworkPanel } from './ui/NetworkPanel';
import { LayerPanel, SimulationControls } from './ui/SimulationControls';
import { ReplayBar } from './ui/ReplayBar';
import { TaskBoardPanel } from './ui/TaskBoardPanel';
import { EventLog, FleetPanel, TelemetryPanel } from './ui/TelemetryPanel';

function Legend() {
  const p2p = useUI((s) => s.showP2P);
  const comms = useUI((s) => s.showComms);
  return (
    <div className="legend" aria-label="Map legend">
      <div>
        <i className="sw dashed" /> Planned path
      </div>
      <div>
        <i className="sw solid" /> Active path
      </div>
      <div>
        <i className="sw done" /> Completed route
      </div>
      <div>
        <i className="sw avoid" /> Avoidance manoeuvre
      </div>
      <div>
        <i className="sw nofly" /> No-fly zone
      </div>
      <div>
        <i className="sw hub" /> Depot
        <i className="sw delivery" /> Drop point
        <i className="sw pickup" /> Retail / event drop
      </div>
      {(p2p || comms) && (
        <div>
          <i className="sw mast" /> Depot mast (+25 m network node)
        </div>
      )}
      {p2p && (
        <>
          <div>
            {COMPONENT_PALETTE.slice(0, 4).map((c) => (
              <i key={c} className="sw comp" style={{ background: c }} />
            ))}
            Radio component (halo / link)
          </div>
          <div>
            <i className="sw oneway" /> One-way link
            <i className="sw owner" /> Drop ring: ledger owner (grey: unassigned)
          </div>
        </>
      )}
    </div>
  );
}

/** Film mode lower third (set by `window.pact.caption`). */
function CaptionOverlay() {
  const c = useUI((s) => s.caption);
  if (!c) return null;
  return (
    <div className="caption" key={`${c.tag}|${c.title}|${c.sub}`}>
      {c.tag && <div className="caption-tag">{c.tag}</div>}
      <div className="caption-title">{c.title}</div>
      {c.sub && <div className="caption-sub">{c.sub}</div>}
    </div>
  );
}

const SYSTEM_NAMES: Record<string, string> = {
  pact: 'PACT',
  central_full: 'Central hub (never fails)',
  central_hub_loss: 'Central hub',
  greedy_nearest: 'Greedy nearest',
  cbba_plain: 'Plain auction (unfenced)',
};

/** Film-mode scoreboard (`window.pact.hud(true)`): the numbers a viewer needs to read the shot. */
function Hud() {
  const on = useUI((s) => s.hud);
  const s = useSimSnapshot();
  if (!on) return null;
  const firstFault = s.faultsFired.length ? s.faultsFired[0].t : Number.POSITIVE_INFINITY;
  const c = deliveryCounts(engine.events, firstFault);
  const mm = Math.floor(s.time / 60);
  const ss = String(Math.floor(s.time % 60)).padStart(2, '0');
  return (
    <div className="hud">
      <div className="hud-sys">{SYSTEM_NAMES[engine.system] ?? engine.system}</div>
      <div className="hud-row">
        <span>
          <b className="mono">
            {mm}:{ss}
          </b>
          sim time
        </span>
        <span>
          <b className="mono">{c.delivered}</b>delivered
        </span>
        {isFinite(firstFault) && (
          <span>
            <b className="mono">{c.after}</b>since fault
          </span>
        )}
        <span className={c.duplicates ? 'bad' : ''}>
          <b className="mono">{c.duplicates}</b>duplicates
        </span>
      </div>
    </div>
  );
}

export default function App() {
  const select = useUI((s) => s.select);
  const film = useUI((s) => s.film);
  const replay = useUI((s) => s.showReplay);
  return (
    <div className={`app${film ? ' film' : ''}${offline ? ' offline' : ''}`}>
      <header className="topbar">
        <div className="brand">
          <b>PACT</b>
          <span>Decentralised multi-agent logistics · simulation environment</span>
        </div>
        <SimulationControls />
      </header>

      <aside className="left">
        <LayerPanel />
        <section className="panel note">
          <h3>Scope</h3>
          <p>
            Kinematic simulation of drone coordination. Motion is simplified (no aerodynamics) and the battery model is accelerated for demonstration. Not a flight-readiness model.
          </p>
        </section>
      </aside>

      <main className={`stage${replay && !film ? ' has-replay' : ''}`}>
        <Canvas
          frameloop={offline ? 'never' : 'always'}
          shadows
          dpr={[1, 1.75]}
          camera={{ position: HOME_CAMERA.position.toArray(), fov: 32, near: 1, far: 14000 }}
          gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 0.95 }}
          onPointerMissed={() => select(null)}
        >
          <EnvironmentScene />
        </Canvas>
        {!film && <Legend />}
        <CaptionOverlay />
        <Hud />
        {replay && !film && <ReplayBar />}
      </main>

      <aside className="right">
        <TelemetryPanel />
        <NetworkPanel />
        <InspectorPanel />
        <TaskBoardPanel />
        <FleetPanel />
        <EventLog />
      </aside>
    </div>
  );
}
