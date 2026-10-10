import { memo, useMemo, useRef } from 'react';
import { Html } from '@react-three/drei';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { engine } from '../app/simContext';
import { useFleetVersion } from '../app/hooks';
import { useUI } from '../app/uiStore';
import { SIM } from '../sim/config';
import type { DroneAgent } from '../sim/DroneAgent';

/**
 * Delivery quadcopter: X-frame with carbon-tube arms, motor pods with two-blade props (swapped for
 * blur discs while spinning), rounded fuselage with a coloured canopy, battery pack, GPS puck, forward
 * camera gimbal, twin skids, aviation lights (red port / green starboard / white strobe / beacon) and a
 * parcel in the belly clamp while carrying. Real-scale geometry (~0.9 m motor to motor) scaled up by
 * `SIM.droneVisualScale` so it stays legible at city scale.
 */
const G = {
  body: new RoundedBoxGeometry(0.42, 0.11, 0.3, 3, 0.03),
  canopy: new RoundedBoxGeometry(0.3, 0.06, 0.22, 3, 0.025),
  battery: new RoundedBoxGeometry(0.24, 0.05, 0.14, 2, 0.015),
  gps: new THREE.CylinderGeometry(0.035, 0.035, 0.014, 16),
  antenna: new THREE.CylinderGeometry(0.004, 0.004, 0.12, 6).translate(0, 0.06, 0),
  arm: new THREE.CylinderGeometry(0.014, 0.014, 0.34, 10).rotateZ(Math.PI / 2).translate(0.17, 0, 0),
  armRoot: new THREE.CylinderGeometry(0.022, 0.026, 0.05, 10).rotateZ(Math.PI / 2),
  mount: new THREE.CylinderGeometry(0.034, 0.038, 0.03, 14),
  motor: new THREE.CylinderGeometry(0.027, 0.03, 0.036, 14),
  hub: new THREE.CylinderGeometry(0.012, 0.012, 0.018, 10),
  blade: new THREE.BoxGeometry(0.27, 0.004, 0.028),
  disc: new THREE.CircleGeometry(0.145, 28).rotateX(-Math.PI / 2),
  skid: new THREE.CylinderGeometry(0.011, 0.011, 0.36, 8).rotateX(Math.PI / 2),
  leg: new THREE.CylinderGeometry(0.009, 0.009, 0.11, 6),
  gimbal: new THREE.SphereGeometry(0.042, 14, 10),
  lens: new THREE.CylinderGeometry(0.016, 0.02, 0.03, 12).rotateX(Math.PI / 2),
  clamp: new THREE.BoxGeometry(0.02, 0.05, 0.1),
  pkg: new RoundedBoxGeometry(0.2, 0.15, 0.18, 2, 0.01),
  strap: new THREE.BoxGeometry(0.21, 0.152, 0.02),
  light: new THREE.SphereGeometry(0.012, 8, 6),
  beacon: new THREE.SphereGeometry(0.016, 8, 6),
  ring: new THREE.TorusGeometry(0.62, 0.012, 6, 36),
  unit: new THREE.BoxGeometry(1, 1, 1),
  hit: new THREE.SphereGeometry(0.9, 8, 6),
};
const M = {
  carbon: new THREE.MeshStandardMaterial({ color: '#23272b', roughness: 0.45, metalness: 0.35 }),
  dark: new THREE.MeshStandardMaterial({ color: '#15181b', roughness: 0.6, metalness: 0.2 }),
  grey: new THREE.MeshStandardMaterial({ color: '#8d9298', roughness: 0.5, metalness: 0.4 }),
  white: new THREE.MeshStandardMaterial({ color: '#e8e9e6', roughness: 0.5 }),
  battery: new THREE.MeshStandardMaterial({ color: '#2f3e4e', roughness: 0.5, metalness: 0.3 }),
  glass: new THREE.MeshStandardMaterial({ color: '#1c2a36', roughness: 0.15, metalness: 0.6 }),
  disc: new THREE.MeshBasicMaterial({ color: '#9aa3ab', transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide }),
  blade: new THREE.MeshStandardMaterial({ color: '#1a1d20', roughness: 0.6 }),
  pkg: new THREE.MeshStandardMaterial({ color: '#b08a57', roughness: 0.9 }),
  strap: new THREE.MeshStandardMaterial({ color: '#3a3f44', roughness: 0.8 }),
  red: new THREE.MeshBasicMaterial({ color: '#ff2d2d' }),
  green: new THREE.MeshBasicMaterial({ color: '#2dff6a' }),
  strobe: new THREE.MeshBasicMaterial({ color: '#ffffff' }),
  beacon: new THREE.MeshBasicMaterial({ color: '#ff8a1f' }),
  urgent: new THREE.MeshBasicMaterial({ color: '#ff1f1f' }),
  avoid: new THREE.MeshBasicMaterial({ color: '#ea580c' }),
  hit: new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
};

const ARM_ANGLES = [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4];

interface DroneRig {
  root: THREE.Group;
  tilt: THREE.Group;
  hubs: THREE.Object3D[];
  blades: THREE.Object3D[];
  discs: THREE.Object3D[];
  pkg: THREE.Object3D;
  avoid: THREE.Object3D;
  drop: THREE.Mesh;
  ring: THREE.Mesh;
  strobes: THREE.Object3D[];
  beacon: THREE.Mesh;
  gimbal: THREE.Object3D;
}

const DroneModel = memo(function DroneModel({ agent, rigs }: { agent: DroneAgent; rigs: React.MutableRefObject<Map<string, DroneRig>> }) {
  const color = useMemo(() => new THREE.Color(agent.color), [agent.color]);
  const canopyMat = useMemo(() => new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.25 }), [color]);
  const dropMat = useMemo(() => new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, depthWrite: false }), [color]);
  const ringMat = useMemo(() => new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthTest: false }), []);
  const select = useUI((s) => s.select);

  const reg = (root: THREE.Group | null) => {
    if (!root) {
      rigs.current.delete(agent.id);
      return;
    }
    const tilt = root.getObjectByName('tilt') as THREE.Group;
    tilt.rotation.order = 'YXZ';
    const hubs: THREE.Object3D[] = [];
    const blades: THREE.Object3D[] = [];
    const discs: THREE.Object3D[] = [];
    const strobes: THREE.Object3D[] = [];
    root.traverse((o) => {
      if (o.name === 'hub') hubs.push(o);
      if (o.name === 'blades') blades.push(o);
      if (o.name === 'disc') discs.push(o);
      if (o.name === 'strobe') strobes.push(o);
    });
    rigs.current.set(agent.id, {
      root,
      tilt,
      hubs,
      blades,
      discs,
      strobes,
      beacon: root.getObjectByName('beacon') as THREE.Mesh,
      gimbal: root.getObjectByName('gimbal')!,
      pkg: root.getObjectByName('pkg')!,
      avoid: root.getObjectByName('avoid')!,
      drop: root.getObjectByName('drop') as THREE.Mesh,
      ring: root.getObjectByName('ring') as THREE.Mesh,
    });
  };

  const onClick = (e: ThreeEvent<MouseEvent>) => {
    if (e.delta > 4) return;
    e.stopPropagation();
    select(agent.id);
  };

  return (
    <group ref={reg} position={[agent.body.pos.x, agent.body.pos.y, agent.body.pos.z]}>
      <group name="tilt" scale={SIM.droneVisualScale}>
        {/* fuselage */}
        <mesh geometry={G.body} material={M.carbon} position={[0, 0.11, 0]} castShadow />
        <mesh geometry={G.canopy} material={canopyMat} position={[0, 0.19, 0.01]} castShadow />
        <mesh geometry={G.battery} material={M.battery} position={[0, 0.035, -0.02]} castShadow />
        <mesh geometry={G.gps} material={M.white} position={[0.06, 0.23, -0.06]} />
        <mesh geometry={G.antenna} material={M.dark} position={[-0.12, 0.2, -0.1]} rotation={[0.35, 0, 0.2]} />
        <mesh geometry={G.antenna} material={M.dark} position={[-0.14, 0.2, -0.06]} rotation={[0.25, 0, 0.35]} />
        {/* camera gimbal */}
        <group name="gimbal" position={[0, 0.05, 0.16]}>
          <mesh geometry={G.gimbal} material={M.dark} />
          <mesh geometry={G.lens} material={M.glass} position={[0, -0.01, 0.045]} rotation={[-0.3, 0, 0]} />
        </group>
        {/* arms + motor pods */}
        {ARM_ANGLES.map((a, i) => (
          <group key={i} rotation={[0, a, 0]} position={[0, 0.12, 0]}>
            <mesh geometry={G.armRoot} material={M.carbon} position={[0.17, 0, 0]} />
            <mesh geometry={G.arm} material={M.carbon} position={[0.14, 0, 0]} castShadow />
            <group position={[0.46, 0, 0]}>
              <mesh geometry={G.mount} material={M.carbon} position={[0, 0.01, 0]} castShadow />
              <mesh geometry={G.motor} material={M.dark} position={[0, 0.045, 0]} castShadow />
              <group name="hub" position={[0, 0.072, 0]}>
                <mesh geometry={G.hub} material={M.grey} />
                <group name="blades">
                  <mesh geometry={G.blade} material={M.blade} position={[0, 0.01, 0]} rotation={[0.18, 0, 0]} />
                </group>
                <mesh name="disc" geometry={G.disc} material={M.disc} position={[0, 0.012, 0]} />
              </group>
              {/* nav lights: red on the port (left-front / left-rear) arms, green starboard; strobes at the rear */}
              <mesh geometry={G.light} material={i === 0 || i === 3 ? M.green : M.red} position={[0.02, -0.01, 0]} />
              {(i === 1 || i === 2) && <mesh name="strobe" geometry={G.light} material={M.strobe} position={[0.03, 0.03, 0]} />}
            </group>
          </group>
        ))}
        {/* landing skids */}
        {[-0.11, 0.11].map((x) => (
          <group key={x} position={[x, -0.02, 0]}>
            <mesh geometry={G.skid} material={M.carbon} position={[0, 0, 0]} castShadow />
            <mesh geometry={G.leg} material={M.carbon} position={[-x * 0.25, 0.05, 0.11]} rotation={[0, 0, x > 0 ? -0.45 : 0.45]} />
            <mesh geometry={G.leg} material={M.carbon} position={[-x * 0.25, 0.05, -0.11]} rotation={[0, 0, x > 0 ? -0.45 : 0.45]} />
          </group>
        ))}
        {/* belly clamp + parcel */}
        <mesh geometry={G.clamp} material={M.grey} position={[-0.1, 0.03, 0]} />
        <mesh geometry={G.clamp} material={M.grey} position={[0.1, 0.03, 0]} />
        <group name="pkg" position={[0, -0.07, 0]} visible={false}>
          <mesh geometry={G.pkg} material={M.pkg} castShadow />
          <mesh geometry={G.strap} material={M.strap} position={[0, 0, 0.05]} />
          <mesh geometry={G.strap} material={M.strap} position={[0, 0, -0.05]} />
        </group>
        <mesh name="beacon" geometry={G.beacon} material={M.beacon} position={[0, -0.0, -0.12]} />
        <mesh name="avoid" geometry={G.ring} material={M.avoid} rotation={[Math.PI / 2, 0, 0]} position={[0, 0.1, 0]} visible={false} />
      </group>
      <mesh geometry={G.hit} material={M.hit} scale={SIM.droneVisualScale} onClick={onClick} />
      <mesh name="drop" geometry={G.unit} material={dropMat} scale={[0.12, 1, 0.12]} />
      <mesh name="ring" rotation={[-Math.PI / 2, 0, 0]} visible={false} material={ringMat} renderOrder={5}>
        <ringGeometry args={[3.4, 3.9, 40]} />
      </mesh>
      <DroneChip id={agent.id} />
    </group>
  );
});

function DroneChip({ id }: { id: string }) {
  const labels = useUI((s) => s.showLabels);
  const selected = useUI((s) => s.selection?.id === id);
  if (!labels && !selected) return null;
  return (
    <Html position={[0, 5.5, 0]} center zIndexRange={[30, 0]} style={{ pointerEvents: 'none' }}>
      <div className={`chip chip-drone ${selected ? 'chip-selected' : ''}`}>{id}</div>
    </Html>
  );
}

export function DroneLayer() {
  useFleetVersion();
  const agents = engine.agents;
  const rigs = useRef(new Map<string, DroneRig>());
  const spin = useRef(0);
  const camera = useThree((s) => s.camera);

  useFrame((state, dt) => {
    const sel = useUI.getState().selection?.id;
    const running = engine.status === 'running';
    spin.current += dt * 70;
    const T = state.clock.elapsedTime;
    for (const a of engine.agents) {
      const r = rigs.current.get(a.id);
      if (!r) continue;
      const b = a.body;
      const airborne = b.pos.y > a.pad.pos.y + 0.6 || a.airborne;
      // subtle hover bob while airborne
      r.root.position.set(b.pos.x, b.pos.y + (airborne ? Math.sin(T * 2.1 + a.index) * 0.05 : 0), b.pos.z);
      // visual-only: grow the model with camera distance so drones stay legible at overview zoom
      const k = THREE.MathUtils.clamp(camera.position.distanceTo(r.root.position) / 230, 1, 3);
      r.tilt.scale.setScalar(SIM.droneVisualScale * k);
      r.tilt.rotation.y = b.heading;
      const sh = Math.sin(b.heading);
      const ch = Math.cos(b.heading);
      const vf = b.vel.x * sh + b.vel.z * ch;
      const vs = b.vel.x * ch - b.vel.z * sh;
      r.tilt.rotation.x = THREE.MathUtils.lerp(r.tilt.rotation.x, vf * 0.022, 0.15);
      r.tilt.rotation.z = THREE.MathUtils.lerp(r.tilt.rotation.z, -vs * 0.022, 0.15);
      const spinning = running && airborne;
      r.hubs.forEach((h, i) => {
        h.rotation.y = spinning ? spin.current * (i % 2 ? -1 : 1) + i : i * 0.7;
      });
      for (const bl of r.blades) bl.visible = !spinning;
      for (const d of r.discs) d.visible = spinning;
      // lights: white strobes double-flash every 1.2 s, beacon pulses (faster and red for priority-1 parcels)
      const strobeOn = (T + a.index * 0.37) % 1.2 < 0.08 || ((T + a.index * 0.37) % 1.2 > 0.16 && (T + a.index * 0.37) % 1.2 < 0.24);
      for (const s of r.strobes) s.visible = strobeOn;
      const task = a.controller.taskId ? engine.board.get(a.controller.taskId) : undefined;
      const urgent = task?.priority === 1;
      r.beacon.material = urgent ? M.urgent : M.beacon;
      r.beacon.visible = (T * (urgent ? 4 : 1.6) + a.index) % 1 < (urgent ? 0.5 : 0.35);
      // gimbal looks down-forward in flight, level on the ground
      r.gimbal.rotation.x = THREE.MathUtils.lerp(r.gimbal.rotation.x, airborne ? 0.6 : 0, 0.08);
      r.pkg.visible = a.controller.carrying;
      r.avoid.visible = a.controller.avoiding;
      const alt = Math.max(0.01, b.pos.y);
      r.drop.scale.y = alt;
      r.drop.position.y = -alt / 2;
      r.ring.visible = sel === a.id;
      r.ring.position.y = -b.pos.y + 0.6;
    }
  });

  return (
    <group>
      {agents.map((a) => (
        <DroneModel key={a.id} agent={a} rigs={rigs} />
      ))}
    </group>
  );
}
