import { Canvas } from '@react-three/fiber';
import * as THREE from 'three';
import { useUI } from './app/uiStore';
import { EnvironmentScene, HOME_CAMERA } from './render/EnvironmentScene';
import { InspectorPanel } from './ui/InspectorPanel';
import { LayerPanel, SimulationControls } from './ui/SimulationControls';
import { TaskBoardPanel } from './ui/TaskBoardPanel';
import { EventLog, FleetPanel, TelemetryPanel } from './ui/TelemetryPanel';

function Legend() {
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
    </div>
  );
}

export default function App() {
  const select = useUI((s) => s.select);
  return (
    <div className="app">
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

      <main className="stage">
        <Canvas
          shadows
          dpr={[1, 1.75]}
          camera={{ position: HOME_CAMERA.position.toArray(), fov: 32, near: 1, far: 14000 }}
          gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 0.95 }}
          onPointerMissed={() => select(null)}
        >
          <EnvironmentScene />
        </Canvas>
        <Legend />
      </main>

      <aside className="right">
        <TelemetryPanel />
        <InspectorPanel />
        <TaskBoardPanel />
        <FleetPanel />
        <EventLog />
      </aside>
    </div>
  );
}
