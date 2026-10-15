import { useCallback, useMemo, useRef, useState } from 'react';
import { Html } from '@react-three/drei';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { engine, world } from '../app/simContext';
import { useUI } from '../app/uiStore';
import type { CraneData, DropType, UtilityStructure } from '../world/types';
import { ChunkedInstances } from './ChunkedInstances';
import { Instances } from './Instances';
import { getMaterials } from './materials';
import { padTexture } from './textures';

const unitBox = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
const cylGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 20).translate(0, 0.5, 0);
const discGeo = new THREE.CircleGeometry(1, 36).rotateX(-Math.PI / 2);
const ringBaseGeo = new THREE.CylinderGeometry(1, 1, 0.06, 36);

function click(select: (id: string | null) => void, id: string) {
  return (e: ThreeEvent<MouseEvent>) => {
    if (e.delta > 4) return;
    e.stopPropagation();
    select(id);
  };
}

/** Drop-point marker styles by type (letter, ring, background). */
export const DROP_STYLE: Record<DropType, { letter: string; ring: string; bg: string; text: string; label: string }> = {
  hospital: { letter: 'H', ring: '#ffffff', bg: '#c0262c', text: '#ffffff', label: 'Hospital' },
  clinic: { letter: 'C', ring: '#ffffff', bg: '#d9534f', text: '#ffffff', label: 'Clinic' },
  office: { letter: 'O', ring: '#ffffff', bg: '#2b4a73', text: '#ffffff', label: 'Office' },
  retail: { letter: 'R', ring: '#1f1f1f', bg: '#e0b324', text: '#1f1f1f', label: 'Retail' },
  residential: { letter: 'D', ring: '#ffffff', bg: '#2f8f5b', text: '#ffffff', label: 'Residential' },
  industrial: { letter: 'I', ring: '#1f1f1f', bg: '#9aa3ab', text: '#1f1f1f', label: 'Industrial' },
  campus: { letter: 'U', ring: '#ffffff', bg: '#6d4ea8', text: '#ffffff', label: 'Campus' },
  event: { letter: 'E', ring: '#1f1f1f', bg: '#f08a24', text: '#1f1f1f', label: 'Event venue' },
  park: { letter: 'P', ring: '#ffffff', bg: '#4a8f3f', text: '#ffffff', label: 'Park' },
};

function Chip({ text, y = 7, tone = 'default' }: { text: string; y?: number; tone?: 'default' | 'hub' }) {
  return (
    <Html position={[0, y, 0]} center zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
      <div className={`chip ${tone === 'hub' ? 'chip-hub' : ''}`}>{text}</div>
    </Html>
  );
}

/** Site tags only for sites near the view target — keeps the DOM small on a large map. */
function SiteChips() {
  const controls = useThree((st) => st.controls) as unknown as { target: THREE.Vector3 } | null;
  const all = world.dropPoints;
  const [near, setNear] = useState<typeof all>([]);
  const last = useRef(0);
  const key = useRef('');
  useFrame((s) => {
    if (!controls || s.clock.elapsedTime - last.current < 0.5) return;
    last.current = s.clock.elapsedTime;
    const t = controls.target;
    const list = all.filter((p) => Math.hypot(p.pos.x - t.x, p.pos.z - t.z) < 320).slice(0, 60);
    const k = list.map((p) => p.id).join();
    if (k !== key.current) {
      key.current = k;
      setNear(list);
    }
  });
  return (
    <>
      {near.map((p) => (
        <group key={p.id} position={[p.pos.x, p.pos.y, p.pos.z]}>
          <Chip text={`${p.id} · ${DROP_STYLE[p.type].letter}`} y={5} />
        </group>
      ))}
    </>
  );
}

// -------------------------------------------------------------------------------------------------
// Drop points (instanced per type) + ownership rings
// -------------------------------------------------------------------------------------------------

function DropPoints() {
  const select = useUI((s) => s.select);
  const labels = useUI((s) => s.showLabels);
  const mats = getMaterials();
  const byType = useMemo(() => {
    const m = new Map<DropType, typeof world.dropPoints>();
    for (const d of world.dropPoints) (m.get(d.type) ?? m.set(d.type, []).get(d.type)!).push(d);
    return m;
  }, []);
  const materials = useMemo(() => {
    const m = new Map<DropType, THREE.Material>();
    for (const [t, s] of Object.entries(DROP_STYLE) as [DropType, (typeof DROP_STYLE)[DropType]][]) {
      m.set(t, new THREE.MeshStandardMaterial({ map: padTexture(s.letter, s.ring, s.bg, s.text), roughness: 0.8, transparent: true, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 }));
    }
    return m;
  }, []);
  const baseMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#6e7378', roughness: 0.9 }), []);
  const lockerSetup = useCallback((i: number, o: THREE.Object3D) => {
    const d = world.dropPoints[i];
    o.position.set(d.pos.x + 4.0, d.pos.y - 0.15, d.pos.z + 0.5);
    o.scale.set(0.9, 1.5, 1.4);
  }, []);

  // ownership rings: one ring per drop point with an active task, coloured by the owning drone
  const ringRef = useRef<THREE.InstancedMesh | null>(null);
  const ringMat = useMemo(() => new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }), []);
  const ringGeo = useMemo(() => new THREE.RingGeometry(3.6, 4.3, 36).rotateX(-Math.PI / 2), []);
  const tmp = useMemo(() => new THREE.Object3D(), []);
  const col = useMemo(() => new THREE.Color(), []);
  const byId = useMemo(() => new Map(world.dropPoints.map((d) => [d.id, d])), []);
  useFrame(() => {
    const m = ringRef.current;
    if (!m) return;
    let n = 0;
    for (const a of engine.agents) {
      const tid = a.controller.taskId;
      if (!tid) continue;
      const task = engine.board.get(tid);
      if (!task) continue;
      const d = byId.get(task.dropId);
      if (!d || n >= 64) continue;
      tmp.position.set(d.pos.x, d.pos.y + 0.25, d.pos.z);
      tmp.scale.setScalar(1);
      tmp.updateMatrix();
      m.setMatrixAt(n, tmp.matrix);
      col.set(a.color);
      m.setColorAt(n, col);
      n++;
    }
    m.count = n;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  });

  return (
    <group>
      {[...byType.entries()].map(([t, list]) => (
        <group key={t}>
          <ChunkedInstances count={list.length} positionOf={(i) => [list[i].pos.x, list[i].pos.z]} geometry={discGeo} material={materials.get(t)!} setup={(i, o) => { o.position.set(list[i].pos.x, list[i].pos.y + 0.04, list[i].pos.z); o.scale.set(3, 1, 3); }} receiveShadow renderOrder={2} onPick={(i) => select(list[i].id)} />
          <ChunkedInstances count={list.length} positionOf={(i) => [list[i].pos.x, list[i].pos.z]} geometry={ringBaseGeo} material={baseMat} setup={(i, o) => { o.position.set(list[i].pos.x, list[i].pos.y + 0.01, list[i].pos.z); o.scale.set(3.35, 1, 3.35); }} receiveShadow />
        </group>
      ))}
      <ChunkedInstances count={world.dropPoints.length} positionOf={(i) => [world.dropPoints[i].pos.x, world.dropPoints[i].pos.z]} geometry={unitBox} material={mats.metalGrey} setup={lockerSetup} castShadow lod={900} />
      <instancedMesh ref={ringRef} args={[ringGeo, ringMat, 64]} count={0} frustumCulled={false} renderOrder={4} />
      {labels && <SiteChips />}
    </group>
  );
}

// -------------------------------------------------------------------------------------------------
// Depots: apron, pads, chargers, hand-off bays
// -------------------------------------------------------------------------------------------------

function Pad({ x, y, z, r, tex, onClick }: { x: number; y: number; z: number; r: number; tex: THREE.Texture; onClick: (e: ThreeEvent<MouseEvent>) => void }) {
  return (
    <group position={[x, y, z]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.04, 0]} receiveShadow onClick={onClick} renderOrder={2}>
        <circleGeometry args={[r, 40]} />
        <meshStandardMaterial map={tex} roughness={0.8} transparent polygonOffset polygonOffsetFactor={-6} polygonOffsetUnits={-6} />
      </mesh>
      <mesh position={[0, 0.01, 0]} receiveShadow>
        <cylinderGeometry args={[r + 0.35, r + 0.35, 0.06, 40]} />
        <meshStandardMaterial color="#6e7378" roughness={0.9} />
      </mesh>
    </group>
  );
}

function Depots() {
  const select = useUI((s) => s.select);
  const labels = useUI((s) => s.showLabels);
  const mats = getMaterials();
  const padTex = useMemo(() => padTexture('D', '#ffffff', '#2b4a73'), []);
  const chargers = world.chargers;
  const lightRef = useRef<THREE.InstancedMesh | null>(null);
  const col = useMemo(() => new THREE.Color(), []);
  const lightMat = useMemo(() => new THREE.MeshBasicMaterial({ color: '#ffffff' }), []);

  const setCharger = useCallback((i: number, o: THREE.Object3D) => { o.position.set(chargers[i].pos.x, chargers[i].pos.y, chargers[i].pos.z); o.scale.set(0.9, 1.5, 0.7); }, [chargers]);
  const setLight = useCallback((i: number, o: THREE.Object3D) => { o.position.set(chargers[i].pos.x, chargers[i].pos.y + 1.55, chargers[i].pos.z + 0.38); o.scale.set(0.5, 0.16, 0.05); }, [chargers]);

  useFrame(() => {
    const m = lightRef.current;
    if (!m) return;
    for (let i = 0; i < chargers.length; i++) {
      const ch = chargers[i];
      const charging = engine.agents.some((a) => a.controller.padId === ch.padId && a.controller.phase === 'charging');
      const occupied = engine.agents.some((a) => a.controller.padId === ch.padId && !a.airborne);
      col.set(!engine.pads.isEnabled(ch.padId) ? '#ef4444' : charging ? '#22c55e' : occupied ? '#f59e0b' : '#64748b');
      m.setColorAt(i, col);
    }
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  });

  // apron slabs + yellow boundary lines + hand-off bays with parcel stacks
  const aprons = useMemo(() => world.depots.map((d) => d.apron), []);
  const lines = useMemo(() => aprons.flatMap((a) => [
    { x: (a.minX + a.maxX) / 2, z: a.minZ, sx: a.maxX - a.minX, sz: 0.35 },
    { x: (a.minX + a.maxX) / 2, z: a.maxZ, sx: a.maxX - a.minX, sz: 0.35 },
    { x: a.minX, z: (a.minZ + a.maxZ) / 2, sx: 0.35, sz: a.maxZ - a.minZ },
    { x: a.maxX, z: (a.minZ + a.maxZ) / 2, sx: 0.35, sz: a.maxZ - a.minZ },
  ]), [aprons]);
  const bays = useMemo(() => world.depots.flatMap((d) => d.handoff), []);
  const parcels = useMemo(() => bays.flatMap((b) => [0, 1, 2].map((k) => ({ x: b.x + (k === 2 ? 0.4 : k * 1.3) + 3.4, y: b.y, z: b.z - 0.6 + (k === 2 ? 0.6 : 0), tall: k === 2 }))), [bays]);

  return (
    <group>
      {aprons.map((a, i) => (
        <mesh key={i} geometry={unitBox} material={mats.asphalt} position={[(a.minX + a.maxX) / 2, 0.3, (a.minZ + a.maxZ) / 2]} scale={[a.maxX - a.minX, 0.04, a.maxZ - a.minZ]} receiveShadow />
      ))}
      <Instances count={lines.length} geometry={unitBox} material={mats.yellowPaint} setup={(i, o) => { o.position.set(lines[i].x, 0.33, lines[i].z); o.scale.set(lines[i].sx, 0.03, lines[i].sz); }} />
      {world.pads.map((p) => (
        <Pad key={p.id} x={p.pos.x} y={p.pos.y} z={p.pos.z} r={p.radius} tex={padTex} onClick={click(select, p.depotId || p.id)} />
      ))}
      <Instances count={chargers.length} geometry={unitBox} material={mats.metalDark} setup={setCharger} castShadow />
      <Instances meshRef={lightRef} count={chargers.length} geometry={unitBox} material={lightMat} setup={(i, o, c) => { setLight(i, o); c.set('#64748b'); }} colored />
      <Instances count={bays.length} geometry={unitBox} material={mats.yellowPaint} setup={(i, o) => { o.position.set(bays[i].x, bays[i].y + 0.01, bays[i].z); o.scale.set(5, 0.03, 5); }} />
      <Instances count={bays.length} geometry={unitBox} material={mats.asphalt} setup={(i, o) => { o.position.set(bays[i].x, bays[i].y + 0.02, bays[i].z); o.scale.set(4.4, 0.03, 4.4); }} />
      <Instances count={parcels.length} geometry={unitBox} material={mats.cardboard} setup={(i, o, c) => { const p = parcels[i]; o.position.set(p.x, p.y, p.z); o.scale.set(1.1, p.tall ? 2 : 1, 1.1); c.set(['#b08a57', '#c29b64', '#a67c4a'][i % 3]); }} colored castShadow />
      {labels &&
        world.depots.map((h) => (
          <group key={h.id} position={[h.pos.x, h.pos.y, h.pos.z]}>
            <Chip text={`Depot ${h.id}`} y={22} tone="hub" />
          </group>
        ))}
    </group>
  );
}

// -------------------------------------------------------------------------------------------------
// Industrial furniture: containers, parking, loading bays
// -------------------------------------------------------------------------------------------------

const carBodyGeo = new THREE.BoxGeometry(4.3, 0.8, 1.85).translate(0, 0.55, 0);
const carCabinGeo = new THREE.BoxGeometry(2.4, 0.7, 1.65).translate(-0.2, 1.3, 0);
const trailerGeo = new THREE.BoxGeometry(13.5, 2.8, 2.5).translate(0, 1.9, 0);

function YardDetails() {
  const mats = getMaterials();
  const stacks = useMemo(() => {
    const out: { x: number; y: number; z: number; rot: number; color: string }[] = [];
    for (const c of world.containers) for (let k = 0; k < c.stack; k++) out.push({ x: c.x, y: 0.3 + k * 2.6, z: c.z, rot: c.rot, color: c.color });
    return out;
  }, []);
  const parking = world.parking;
  const cars = useMemo(() => parking.filter((p, i) => p.d < 10 && (i * 7) % 10 < 6), [parking]);
  const trailers = useMemo(() => parking.filter((p, i) => p.d >= 10 && (i * 7) % 10 < 7), [parking]);
  const bays = world.loadingBays;
  return (
    <group>
      <ChunkedInstances count={stacks.length} positionOf={(i) => [stacks[i].x, stacks[i].z]} geometry={unitBox} material={mats.container} setup={(i, o, c) => { const s = stacks[i]; o.position.set(s.x, s.y, s.z); o.rotation.y = s.rot; o.scale.set(6.1, 2.55, 2.45); c.set(s.color); }} colored castShadow receiveShadow lod={2500} shadowLod={600} />
      <ChunkedInstances count={parking.length} positionOf={(i) => [parking[i].x, parking[i].z]} geometry={unitBox} material={mats.paint} setup={(i, o) => { const p = parking[i]; o.position.set(p.x, 0.31, p.z); o.rotation.y = p.rot; o.scale.set(0.12, 0.02, p.d); o.translateX(-p.w / 2); }} lod={700} />
      <ChunkedInstances count={cars.length} positionOf={(i) => [cars[i].x, cars[i].z]} geometry={carBodyGeo} material={mats.carBody} setup={(i, o, c) => { const p = cars[i]; o.position.set(p.x, 0.3, p.z); o.rotation.y = p.rot + Math.PI / 2; c.set(['#d8d8d4', '#2d3640', '#7d8791', '#9c3a35', '#355c8a', '#b8b49a'][i % 6]); }} colored castShadow lod={1000} shadowLod={400} />
      <ChunkedInstances count={cars.length} positionOf={(i) => [cars[i].x, cars[i].z]} geometry={carCabinGeo} material={mats.carGlass} setup={(i, o) => { const p = cars[i]; o.position.set(p.x, 0.3, p.z); o.rotation.y = p.rot + Math.PI / 2; }} lod={1000} />
      <ChunkedInstances count={trailers.length} positionOf={(i) => [trailers[i].x, trailers[i].z]} geometry={trailerGeo} material={mats.carBody} setup={(i, o, c) => { const p = trailers[i]; o.position.set(p.x, 0.3, p.z); o.rotation.y = p.rot + Math.PI / 2; c.set(['#e8e8e4', '#b9bcc0', '#2c5f8a', '#c8392f'][i % 4]); }} colored castShadow lod={1500} shadowLod={500} />
      <ChunkedInstances count={bays.length} positionOf={(i) => [bays[i].x, bays[i].z]} geometry={unitBox} material={mats.metalDark} setup={(i, o) => { const b = bays[i]; o.position.set(b.x, 0.3, b.z); o.rotation.y = b.rot; o.scale.set(3.6, 4.2, 0.3); o.translateZ(0.15); }} castShadow lod={900} />
      <ChunkedInstances count={bays.length} positionOf={(i) => [bays[i].x, bays[i].z]} geometry={unitBox} material={mats.yellowPaint} setup={(i, o) => { const b = bays[i]; o.position.set(b.x, 0.3, b.z); o.rotation.y = b.rot; o.scale.set(3.6, 1.2, 2.0); o.translateZ(1.2); }} lod={900} />
    </group>
  );
}

// -------------------------------------------------------------------------------------------------
// Cranes (instanced parts; tower cranes slew, gantry trolleys travel)
// -------------------------------------------------------------------------------------------------

function Cranes() {
  const mats = getMaterials();
  const towers = useMemo(() => world.cranes.filter((c) => c.kind === 'tower'), []);
  const gantries = useMemo(() => world.cranes.filter((c) => c.kind !== 'tower'), []);
  const braces = useMemo(() => towers.flatMap((c) => Array.from({ length: Math.floor(c.mastHeight / 3) }, (_, i) => ({ c, y: 1.5 + i * 3 }))), [towers]);
  const slewRefs = useRef<(THREE.InstancedMesh | null)[]>([]);
  const trolleyRef = useRef<THREE.InstancedMesh | null>(null);
  const t = useRef(0);
  const tmp = useMemo(() => new THREE.Object3D(), []);
  const redMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#a8362e', roughness: 0.55, metalness: 0.35 }), []);

  // slewing parts: [cab, jib, counter-jib, counterweight, apex, hook cable, hook]
  type SlewPart = { dx: (L: number) => number; dy: number; dz: number; sx: (L: number) => number; sy: number; sz: number; mat: THREE.Material };
  const SLEW = useMemo((): SlewPart[] => [
    { dx: () => 0, dy: 0, dz: 0, sx: () => 1.8, sy: 2.4, sz: 1.8, mat: mats.craneYellow },
    { dx: (L) => L / 2 - 4, dy: 2.0, dz: 0, sx: (L) => L + 8, sy: 0.9, sz: 0.9, mat: mats.craneYellow },
    { dx: (L) => -L * 0.12 - 2, dy: 0.55, dz: 0, sx: (L) => L * 0.3, sy: 0.8, sz: 0.8, mat: mats.craneYellow },
    { dx: (L) => -L * 0.3, dy: -0.3, dz: 0, sx: () => 3, sy: 2, sz: 2.2, mat: mats.concrete },
    { dx: () => 0, dy: 2.4, dz: 0, sx: () => 0.8, sy: 5, sz: 0.8, mat: mats.craneYellow },
    { dx: (L) => L * 0.65, dy: -11, dz: 0, sx: () => 0.08, sy: 13, sz: 0.08, mat: mats.metalDark },
    { dx: (L) => L * 0.65, dy: -11.6, dz: 0, sx: () => 0.8, sy: 0.6, sz: 0.8, mat: mats.metalDark },
  ], [mats]);

  useFrame((_, dt) => {
    if (engine.status !== 'paused') t.current += dt;
    SLEW.forEach((p, k) => {
      const m = slewRefs.current[k];
      if (!m) return;
      towers.forEach((c, i) => {
        const a = c.jibAngle + t.current * 0.04;
        tmp.position.set(c.x, c.mastHeight, c.z);
        tmp.rotation.set(0, a, 0);
        tmp.scale.setScalar(1);
        tmp.updateMatrix();
        const local = new THREE.Matrix4().makeTranslation(p.dx(c.jibLength), p.dy, p.dz).multiply(new THREE.Matrix4().makeScale(p.sx(c.jibLength), p.sy, p.sz));
        tmp.matrix.multiply(local);
        m.setMatrixAt(i, tmp.matrix);
      });
      m.instanceMatrix.needsUpdate = true;
    });
    const tr = trolleyRef.current;
    if (tr) {
      gantries.forEach((c, i) => {
        const alongX = c.kind === 'quay' ? true : Math.abs(Math.cos(c.jibAngle)) > 0.5;
        const s = c.kind === 'quay' ? c.jibLength * 0.5 + Math.sin(t.current * 0.25) * c.jibLength * 0.4 : Math.sin(t.current * 0.25) * 9;
        tmp.position.set(c.x + (alongX ? s : 0), c.mastHeight - (c.kind === 'quay' ? 2 : 4.2), c.z + (alongX ? 0 : s));
        tmp.rotation.set(0, 0, 0);
        tmp.scale.set(3.2, 1.4, 3);
        tmp.updateMatrix();
        tr.setMatrixAt(i, tmp.matrix);
      });
      tr.instanceMatrix.needsUpdate = true;
    }
  });

  const gantryParts = useMemo(() => {
    const out: { x: number; y: number; z: number; sx: number; sy: number; sz: number; rot: number; red: boolean }[] = [];
    for (const c of gantries) {
      const H = c.mastHeight;
      if (c.kind === 'quay') {
        for (const [ox, oz] of [[-6, -6], [6, -6], [-6, 6], [6, 6]]) out.push({ x: c.x + ox, y: 0.3, z: c.z + oz, sx: 1.4, sy: H, sz: 1.4, rot: 0, red: false });
        out.push({ x: c.x, y: H - 2, z: c.z, sx: 14, sy: 3, sz: 14, rot: 0, red: false });
        out.push({ x: c.x + c.jibLength / 2 - 6, y: H, z: c.z, sx: c.jibLength + 12, sy: 2.2, sz: 3, rot: 0, red: false });
        out.push({ x: c.x, y: H + 3, z: c.z, sx: 1.2, sy: 14, sz: 1.2, rot: 0, red: false });
      } else {
        const alongX = Math.abs(Math.cos(c.jibAngle)) > 0.5;
        for (const s of [-10, 10]) {
          for (const w of [-1.4, 1.4]) out.push({ x: c.x + (alongX ? s : w), y: 0.3, z: c.z + (alongX ? w : s), sx: 1.2, sy: H, sz: 1.2, rot: 0, red: true });
          out.push({ x: c.x + (alongX ? s : 0), y: 0.3, z: c.z + (alongX ? 0 : s), sx: alongX ? 2 : 4.4, sy: 1, sz: alongX ? 4.4 : 2, rot: 0, red: false });
        }
        out.push({ x: c.x, y: H - 3, z: c.z, sx: alongX ? 28 : 5, sy: 3, sz: alongX ? 5 : 28, rot: 0, red: true });
      }
    }
    return out;
  }, [gantries]);

  return (
    <group>
      <ChunkedInstances count={towers.length * 4} positionOf={(i) => [towers[Math.floor(i / 4)].x, towers[Math.floor(i / 4)].z]} geometry={unitBox} material={mats.craneYellow} setup={(i, o) => { const c = towers[Math.floor(i / 4)]; const k = i % 4; o.position.set(c.x + (k % 2 ? 0.7 : -0.7), 0.3, c.z + (k < 2 ? -0.7 : 0.7)); o.scale.set(0.22, c.mastHeight, 0.22); }} castShadow />
      <ChunkedInstances count={braces.length * 2} positionOf={(i) => [braces[Math.floor(i / 2)].c.x, braces[Math.floor(i / 2)].c.z]} geometry={unitBox} material={mats.craneYellow} setup={(i, o) => { const b = braces[Math.floor(i / 2)]; o.position.set(b.c.x, b.y, b.c.z); o.rotation.y = i % 2 ? Math.PI / 2 : 0; o.scale.set(1.5, 0.1, 0.1); }} lod={1500} />
      <ChunkedInstances count={towers.length} positionOf={(i) => [towers[i].x, towers[i].z]} geometry={unitBox} material={mats.concrete} setup={(i, o) => { o.position.set(towers[i].x, 0.3, towers[i].z); o.scale.set(5, 1.2, 5); }} castShadow />
      {SLEW.map((p, k) => (
        <instancedMesh key={k} ref={(el) => { slewRefs.current[k] = el; }} args={[unitBox, p.mat, Math.max(1, towers.length)]} count={towers.length} castShadow frustumCulled={false} />
      ))}
      <ChunkedInstances count={gantryParts.length} positionOf={(i) => [gantryParts[i].x, gantryParts[i].z]} geometry={unitBox} material={redMat} setup={(i, o, c) => { const p = gantryParts[i]; o.position.set(p.x, p.y, p.z); o.scale.set(p.sx, p.sy, p.sz); c.set(p.red ? '#a8362e' : '#5d6b7a'); }} colored castShadow />
      <instancedMesh ref={trolleyRef} args={[unitBox, mats.metalDark, Math.max(1, gantries.length)]} count={gantries.length} castShadow frustumCulled={false} />
    </group>
  );
}

// -------------------------------------------------------------------------------------------------
// Utility structures + power lines
// -------------------------------------------------------------------------------------------------

function Utilities() {
  const mats = getMaterials();
  const tankMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#d9dcdc', roughness: 0.45, metalness: 0.25 }), []);
  const redMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#c8392f', roughness: 0.6 }), []);
  const whiteMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#e8e8e4', roughness: 0.6 }), []);
  const by = (k: UtilityStructure['kind']) => world.utilities.filter((u) => u.kind === k);
  const tanks = useMemo(() => by('tank'), []);
  const stacks = useMemo(() => by('stack'), []);
  const pylons = useMemo(() => by('pylon'), []);
  const silos = useMemo(() => by('silo'), []);
  const towersW = useMemo(() => by('watertower'), []);
  const turbines = useMemo(() => by('turbine'), []);
  const sphereGeo = useMemo(() => new THREE.SphereGeometry(1, 20, 8, 0, Math.PI * 2, 0, Math.PI / 2), []);
  const coneGeo = useMemo(() => new THREE.ConeGeometry(1, 1, 16).translate(0, 0.5, 0), []);
  const pylonGeo = useMemo(() => new THREE.CylinderGeometry(0.35, 1.7, 1, 4).translate(0, 0.5, 0).rotateY(Math.PI / 4), []);
  const bladeRef = useRef<THREE.InstancedMesh | null>(null);
  const tmp = useMemo(() => new THREE.Object3D(), []);
  const spin = useRef(0);
  useFrame((_, dt) => {
    const m = bladeRef.current;
    if (!m) return;
    if (engine.status !== 'paused') spin.current += dt * 0.9;
    turbines.forEach((u, i) => {
      for (let k = 0; k < 3; k++) {
        tmp.position.set(u.x, u.height, u.z + 2.5);
        tmp.rotation.set(0, 0, spin.current + (k * Math.PI * 2) / 3);
        tmp.scale.set(1.2, u.radius * 8, 0.3);
        tmp.updateMatrix();
        m.setMatrixAt(i * 3 + k, tmp.matrix);
      }
    });
    m.instanceMatrix.needsUpdate = true;
  });

  const lines = useMemo(() => {
    const byId = new Map(world.utilities.map((u) => [u.id, u]));
    const geos: THREE.BufferGeometry[] = [];
    for (const pl of world.powerLines) {
      for (let k = 0; k + 1 < pl.pylonIds.length; k++) {
        const a = byId.get(pl.pylonIds[k]);
        const b = byId.get(pl.pylonIds[k + 1]);
        if (!a || !b) continue;
        for (const f of [0.8, 0.66]) {
          for (const ax of [-4.5, 0, 4.5]) {
            const pts: THREE.Vector3[] = [];
            for (let s = 0; s <= 16; s++) {
              const u = s / 16;
              pts.push(new THREE.Vector3(a.x + (b.x - a.x) * u + ax, a.height * f - Math.sin(u * Math.PI) * 5, a.z + (b.z - a.z) * u));
            }
            geos.push(new THREE.BufferGeometry().setFromPoints(pts));
          }
        }
      }
    }
    return geos;
  }, []);
  const lineMat = useMemo(() => new THREE.LineBasicMaterial({ color: '#2a2d30' }), []);

  return (
    <group>
      <ChunkedInstances count={tanks.length} positionOf={(i) => [tanks[i].x, tanks[i].z]} geometry={cylGeo} material={tankMat} setup={(i, o) => { const u = tanks[i]; o.position.set(u.x, 0.3, u.z); o.scale.set(u.radius * 2, u.height, u.radius * 2); }} castShadow receiveShadow />
      <ChunkedInstances count={tanks.length} positionOf={(i) => [tanks[i].x, tanks[i].z]} geometry={sphereGeo} material={tankMat} setup={(i, o) => { const u = tanks[i]; o.position.set(u.x, 0.3 + u.height, u.z); o.scale.set(u.radius, u.radius * 0.6, u.radius); }} castShadow />
      <ChunkedInstances count={stacks.length} positionOf={(i) => [stacks[i].x, stacks[i].z]} geometry={cylGeo} material={whiteMat} setup={(i, o) => { const u = stacks[i]; o.position.set(u.x, 0.3, u.z); o.scale.set(u.radius * 2, u.height * 0.7, u.radius * 2); }} castShadow />
      <ChunkedInstances count={stacks.length} positionOf={(i) => [stacks[i].x, stacks[i].z]} geometry={cylGeo} material={redMat} setup={(i, o) => { const u = stacks[i]; o.position.set(u.x, 0.3 + u.height * 0.7, u.z); o.scale.set(u.radius * 1.8, u.height * 0.3, u.radius * 1.8); }} castShadow />
      <ChunkedInstances count={pylons.length} positionOf={(i) => [pylons[i].x, pylons[i].z]} geometry={pylonGeo} material={mats.metalGrey} setup={(i, o) => { const u = pylons[i]; o.position.set(u.x, 0.3, u.z); o.scale.set(1, u.height, 1); }} castShadow />
      <ChunkedInstances count={pylons.length * 2} positionOf={(i) => [pylons[Math.floor(i / 2)].x, pylons[Math.floor(i / 2)].z]} geometry={unitBox} material={mats.metalGrey} setup={(i, o) => { const u = pylons[Math.floor(i / 2)]; o.position.set(u.x, u.height * (i % 2 ? 0.66 : 0.8), u.z); o.scale.set(11, 0.35, 0.35); }} castShadow />
      <ChunkedInstances count={silos.length} positionOf={(i) => [silos[i].x, silos[i].z]} geometry={cylGeo} material={tankMat} setup={(i, o) => { const u = silos[i]; o.position.set(u.x, 0.3, u.z); o.scale.set(u.radius * 2, u.height, u.radius * 2); }} castShadow />
      <ChunkedInstances count={silos.length} positionOf={(i) => [silos[i].x, silos[i].z]} geometry={coneGeo} material={mats.metalGrey} setup={(i, o) => { const u = silos[i]; o.position.set(u.x, 0.3 + u.height, u.z); o.scale.set(u.radius, u.radius * 0.8, u.radius); }} castShadow />
      <ChunkedInstances count={towersW.length} positionOf={(i) => [towersW[i].x, towersW[i].z]} geometry={cylGeo} material={mats.concrete} setup={(i, o) => { const u = towersW[i]; o.position.set(u.x, 0.3, u.z); o.scale.set(3.2, u.height, 3.2); }} castShadow />
      <ChunkedInstances count={towersW.length} positionOf={(i) => [towersW[i].x, towersW[i].z]} geometry={cylGeo} material={tankMat} setup={(i, o) => { const u = towersW[i]; o.position.set(u.x, 0.3 + u.height, u.z); o.scale.set(u.radius * 2, 6, u.radius * 2); }} castShadow />
      <ChunkedInstances count={turbines.length} positionOf={(i) => [turbines[i].x, turbines[i].z]} geometry={cylGeo} material={whiteMat} setup={(i, o) => { const u = turbines[i]; o.position.set(u.x, 0.3, u.z); o.scale.set(u.radius * 1.4, u.height, u.radius * 1.4); }} castShadow />
      <ChunkedInstances count={turbines.length} positionOf={(i) => [turbines[i].x, turbines[i].z]} geometry={unitBox} material={whiteMat} setup={(i, o) => { const u = turbines[i]; o.position.set(u.x, u.height - 1.5, u.z); o.scale.set(3, 3, 7); }} castShadow />
      <instancedMesh ref={bladeRef} args={[unitBox, whiteMat, Math.max(1, turbines.length * 3)]} count={turbines.length * 3} castShadow frustumCulled={false} />
      {lines.map((g, i) => (
        <primitive key={i} object={new THREE.Line(g, lineMat)} />
      ))}
    </group>
  );
}

// -------------------------------------------------------------------------------------------------
// Moving obstacles (balloons / blimps / helicopters) — positions come straight from the ObstacleManager
// -------------------------------------------------------------------------------------------------

function MovingObstacles() {
  const refs = useRef<(THREE.Group | null)[]>([]);
  const rotors = useRef<(THREE.Mesh | null)[]>([]);
  const showObs = useUI((s) => s.showObstacles);
  useFrame((_, dt) => {
    engine.obstacles.dynamics.forEach((d, i) => {
      const g = refs.current[i];
      if (!g) return;
      g.position.set(d.pos.x, d.pos.y, d.pos.z);
      g.rotation.y = Math.atan2(-d.vel.z, d.vel.x);
      const r = rotors.current[i];
      if (r && engine.status !== 'paused') r.rotation.y += dt * 25;
    });
  });
  return (
    <group>
      {engine.obstacles.dynamics.map((d, i) => (
        <group key={d.id} ref={(el) => { refs.current[i] = el; }}>
          {d.def.kind === 'helicopter' ? (
            <group>
              <mesh castShadow scale={[2.6, 1.3, 1.3]}>
                <sphereGeometry args={[1.6, 16, 10]} />
                <meshStandardMaterial color="#2f3a46" roughness={0.5} />
              </mesh>
              <mesh position={[-4.5, 0.4, 0]} castShadow>
                <boxGeometry args={[6, 0.5, 0.5]} />
                <meshStandardMaterial color="#2f3a46" roughness={0.5} />
              </mesh>
              <mesh position={[-7.4, 1.2, 0]}>
                <boxGeometry args={[0.3, 1.6, 0.2]} />
                <meshStandardMaterial color="#c8392f" roughness={0.5} />
              </mesh>
              <mesh ref={(el) => { rotors.current[i] = el; }} position={[0, 1.9, 0]}>
                <boxGeometry args={[11, 0.08, 0.5]} />
                <meshStandardMaterial color="#1a1d20" roughness={0.6} />
              </mesh>
              <mesh position={[0, -1.6, 0]}>
                <boxGeometry args={[3.4, 0.12, 2.6]} />
                <meshStandardMaterial color="#1a1d20" roughness={0.6} />
              </mesh>
            </group>
          ) : (
            <group>
              <mesh castShadow scale={[d.def.kind === 'blimp' ? 2.6 : 1, d.def.kind === 'blimp' ? 0.8 : 1, d.def.kind === 'blimp' ? 0.9 : 1]}>
                <sphereGeometry args={[d.radius, 24, 16]} />
                <meshStandardMaterial color={d.def.kind === 'blimp' ? '#d9d4c6' : '#cfd6dc'} roughness={0.55} />
              </mesh>
              {d.def.kind === 'blimp' && [0, 1].map((k) => (
                <mesh key={k} position={[-d.radius * 2.3, 0, 0]} rotation={[k ? Math.PI / 2 : 0, 0, 0]}>
                  <boxGeometry args={[2.5, 4, 0.2]} />
                  <meshStandardMaterial color="#b8482f" roughness={0.6} />
                </mesh>
              ))}
              <mesh position={[0, -d.radius * 0.95, 0]} castShadow>
                <boxGeometry args={[d.def.kind === 'blimp' ? 4 : 1.6, 0.9, 1.4]} />
                <meshStandardMaterial color="#6b5a45" roughness={0.9} />
              </mesh>
            </group>
          )}
          {showObs && (
            <mesh>
              <sphereGeometry args={[d.radius + 10, 20, 12]} />
              <meshBasicMaterial color="#f59e0b" wireframe transparent opacity={0.25} />
            </mesh>
          )}
        </group>
      ))}
    </group>
  );
}

export function LogisticsScene() {
  return (
    <group>
      <Depots />
      <DropPoints />
      <YardDetails />
      <Cranes />
      <Utilities />
      <MovingObstacles />
    </group>
  );
}

export type { CraneData };
