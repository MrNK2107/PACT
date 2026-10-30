import { useEffect, useMemo, useRef } from 'react';
import { Environment, Lightformer, OrbitControls, Sky } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { engine, world } from '../app/simContext';
import { useUI } from '../app/uiStore';
import { CityScene } from './CityScene';
import { DroneLayer } from './DroneLayer';
import { LogisticsScene } from './LogisticsScene';
import { getMaterials } from './materials';
import { buildGroundTiles, hasTerrain } from './terrain';
import { Overlays } from './Overlays';
import { RouteOverlay } from './RouteOverlay';

const SIZE = world.size;
export const HOME_CAMERA = { position: new THREE.Vector3(SIZE * 0.55, SIZE * 0.5, SIZE * 0.55), target: new THREE.Vector3(0, 0, 0) };
const SUN = new THREE.Vector3(-220, 300, 170);
const EXTENT = SIZE * 1.4;

function Lighting() {
  const sun = useRef<THREE.DirectionalLight>(null);
  const controls = useThree((st) => st.controls) as unknown as OrbitControlsImpl | null;
  // keep the shadow frustum centred on whatever the camera is looking at (the map is far larger than one shadow map)
  useFrame(() => {
    const l = sun.current;
    if (!l || !controls) return;
    const t = controls.target;
    l.position.set(t.x + SUN.x, SUN.y, t.z + SUN.z);
    l.target.position.set(t.x, 0, t.z);
    l.target.updateMatrixWorld();
  });
  return (
    <>
      <hemisphereLight args={['#dfe8f2', '#8a8f78', 0.55]} />
      <directionalLight
        ref={sun}
        position={SUN.toArray()}
        intensity={3.2}
        color="#fff4e2"
        castShadow
        shadow-mapSize={[4096, 4096]}
        shadow-camera-left={-350}
        shadow-camera-right={350}
        shadow-camera-top={350}
        shadow-camera-bottom={-350}
        shadow-camera-near={50}
        shadow-camera-far={1200}
        shadow-bias={-0.0004}
        shadow-normalBias={0.4}
      />
      <Sky distance={450000} sunPosition={SUN.toArray()} turbidity={5} rayleigh={1.1} mieCoefficient={0.004} mieDirectionalG={0.8} />
      <Environment resolution={256} environmentIntensity={0.55}>
        <Lightformer form="rect" intensity={2.4} position={[0, 20, -30]} scale={[80, 20, 1]} color="#dfeaf5" />
        <Lightformer form="rect" intensity={1.6} position={[40, 12, 30]} scale={[40, 14, 1]} color="#fff2dc" />
        <Lightformer form="rect" intensity={1.0} position={[-40, 8, 30]} scale={[40, 10, 1]} color="#cfdcec" />
        <Lightformer form="rect" intensity={0.6} position={[0, -5, 0]} rotation-x={Math.PI / 2} scale={[100, 100, 1]} color="#7d8a6a" />
      </Environment>
      <fog attach="fog" args={['#c3d1de', SIZE * 0.9, SIZE * 3.2]} />
    </>
  );
}

/** Ground plane, sea beyond the coastline (with a beach strip) and the river ribbon. */
function Terrain() {
  const mats = getMaterials();
  const coast = world.coast;
  // hilly maps draw the ground as a height-field mesh (the flat plane stays underneath as the horizon)
  const groundTiles = useMemo(() => (hasTerrain ? buildGroundTiles(4) : []), []);
  const sea = useMemo(() => {
    if (!coast) return null;
    const pts = coast.shore;
    const shape = new THREE.Shape();
    shape.moveTo(pts[0].x, -pts[0].z);
    for (const p of pts) shape.lineTo(p.x, -p.z);
    shape.lineTo(EXTENT, -pts[pts.length - 1].z);
    shape.lineTo(EXTENT, EXTENT);
    shape.lineTo(EXTENT, -EXTENT);
    shape.lineTo(EXTENT, -pts[0].z);
    shape.closePath();
    const g = new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2);
    // beach: ribbon 30 m wide landward of the shore
    const beach: number[] = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      beach.push(a.x - 32, 0.05, a.z, a.x + 6, 0.05, a.z, b.x + 6, 0.05, b.z, a.x - 32, 0.05, a.z, b.x + 6, 0.05, b.z, b.x - 32, 0.05, b.z);
    }
    const bg = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(beach, 3));
    bg.computeVertexNormals();
    return { water: g, beach: bg };
  }, [coast]);
  const river = useMemo(() => {
    const out: { water: THREE.BufferGeometry; bank: THREE.BufferGeometry }[] = [];
    for (const r of world.rivers) {
      const pts = r.points;
      const w = r.width;
      const water: number[] = [];
      const bank: number[] = [];
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        const hw = w / 2;
        water.push(a.x - hw, 0.07, a.z, a.x + hw, 0.07, a.z, b.x + hw, 0.07, b.z, a.x - hw, 0.07, a.z, b.x + hw, 0.07, b.z, b.x - hw, 0.07, b.z);
        const bw = hw + 9;
        bank.push(a.x - bw, 0.05, a.z, a.x + bw, 0.05, a.z, b.x + bw, 0.05, b.z, a.x - bw, 0.05, a.z, b.x + bw, 0.05, b.z, b.x - bw, 0.05, b.z);
      }
      const wg = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(water, 3));
      wg.computeVertexNormals();
      const bg = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(bank, 3));
      bg.computeVertexNormals();
      out.push({ water: wg, bank: bg });
    }
    return out;
  }, []);
  const seaMat = useMemo(() => {
    const m = mats.water.clone();
    m.opacity = 1;
    m.transparent = false;
    m.color = new THREE.Color('#7fa9bd');
    return m;
  }, [mats]);
  const riverMat = useMemo(() => {
    const m = mats.water.clone();
    m.color = new THREE.Color('#8fb1c0');
    return m;
  }, [mats]);
  useFrame((_, dt) => {
    if (engine.status !== 'paused') mats.waterTex.offset.y += dt * 0.006;
  });
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, hasTerrain ? -0.06 : 0, 0]} receiveShadow material={mats.grass}>
        <planeGeometry args={[EXTENT * 2, EXTENT * 2]} />
      </mesh>
      {groundTiles.map((g, i) => (
        <mesh key={i} geometry={g} material={mats.grass} receiveShadow />
      ))}
      {world.openWater && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.05, 0]} material={seaMat}>
          <planeGeometry args={[EXTENT * 2, EXTENT * 2]} />
        </mesh>
      )}
      {sea && (
        <>
          <mesh geometry={sea.beach} material={mats.sand} receiveShadow />
          <mesh geometry={sea.water} material={seaMat} position={[0, 0.08, 0]} receiveShadow renderOrder={1} />
        </>
      )}
      {river.map((r, i) => (
        <group key={i}>
          <mesh geometry={r.bank} material={mats.sand} receiveShadow />
          <mesh geometry={r.water} material={riverMat} receiveShadow renderOrder={1} />
        </group>
      ))}
    </group>
  );
}

/** Drives the fixed-step simulation from the render loop. */
function SimDriver() {
  useFrame((_, dt) => engine.update(dt));
  return null;
}

function entityPosition(id: string): THREE.Vector3 | null {
  const a = engine.agents.find((x) => x.id === id);
  if (a) return new THREE.Vector3(a.body.pos.x, a.body.pos.y, a.body.pos.z);
  const e = world.index.get(id);
  if (!e) return null;
  const d = e.data as Record<string, unknown>;
  if (e.type === 'building') {
    const b = d as unknown as { cx: number; cz: number; h: number; baseY: number };
    return new THREE.Vector3(b.cx, b.baseY + b.h / 2, b.cz);
  }
  if (e.type === 'district') {
    const b = d as unknown as { minX: number; maxX: number; minZ: number; maxZ: number };
    return new THREE.Vector3((b.minX + b.maxX) / 2, 0, (b.minZ + b.maxZ) / 2);
  }
  const p = d.pos as { x: number; y: number; z: number } | undefined;
  if (p) return new THREE.Vector3(p.x, p.y, p.z);
  if (typeof d.cx === 'number' && typeof d.cz === 'number') return new THREE.Vector3(d.cx as number, 0, d.cz as number);
  if (typeof d.x === 'number' && typeof d.z === 'number') return new THREE.Vector3(d.x as number, 0, d.z as number);
  return null;
}

function CameraRig() {
  const controls = useRef<OrbitControlsImpl>(null);
  const { camera } = useThree();
  const resetNonce = useUI((s) => s.cameraResetNonce);
  const focusNonce = useUI((s) => s.focusNonce);
  const goal = useRef<{ target: THREE.Vector3; dist: number } | null>(null);
  // scripted move (film mode / window.pact.shot): eased from the current view to the shot over `seconds`
  const shot = useUI((s) => s.shot);
  const move = useRef<{ p0: THREE.Vector3; t0: THREE.Vector3; p1: THREE.Vector3; t1: THREE.Vector3; dur: number; age: number } | null>(null);
  useEffect(() => {
    const c = controls.current;
    if (!shot || !c) return;
    goal.current = null;
    move.current = {
      p0: camera.position.clone(),
      t0: c.target.clone(),
      p1: new THREE.Vector3(...shot.position),
      t1: new THREE.Vector3(...shot.target),
      dur: Math.max(0, shot.seconds),
      age: 0,
    };
  }, [shot, camera]);

  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    // home: looking at the most central depot (`?view=overview` frames the whole map instead;
    // `?cam=px,py,pz,tx,ty,tz` places the camera explicitly)
    const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
    const cam = params?.get('cam')?.split(',').map(Number);
    if (cam && cam.length === 6 && cam.every((n) => isFinite(n))) {
      camera.position.set(cam[0], cam[1], cam[2]);
      c.target.set(cam[3], cam[4], cam[5]);
      c.update();
      return;
    }
    const overview = params?.get('view') === 'overview';
    const d0 = world.depots[0];
    const t = overview || !d0 ? HOME_CAMERA.target.clone() : new THREE.Vector3(d0.pos.x, d0.pos.y, d0.pos.z);
    if (overview) camera.position.set(SIZE * 0.42, SIZE * 0.3 + world.terrain.maxY, SIZE * 0.42);
    else camera.position.copy(t).add(new THREE.Vector3(520, 420, 520));
    c.target.copy(t);
    c.update();
  }, [camera, resetNonce]);

  useEffect(() => {
    if (!focusNonce) return;
    const id = useUI.getState().selection?.id;
    const p = id ? entityPosition(id) : null;
    if (p) goal.current = { target: p, dist: id && engine.agents.some((a) => a.id === id) ? 90 : world.index.get(id!)?.type === 'district' ? 700 : 140 };
  }, [focusNonce]);

  // WASD / arrow keys pan across the ground plane (Shift = fast)
  const keys = useRef(new Set<string>());
  useEffect(() => {
    const dn = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'SELECT') return;
      keys.current.add(e.key.toLowerCase());
    };
    const up = (e: KeyboardEvent) => keys.current.delete(e.key.toLowerCase());
    window.addEventListener('keydown', dn);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', dn);
      window.removeEventListener('keyup', up);
    };
  }, []);

  useFrame((_, dt) => {
    const c = controls.current;
    if (c && keys.current.size) {
      const k = keys.current;
      const fx = (k.has('w') || k.has('arrowup') ? 1 : 0) - (k.has('s') || k.has('arrowdown') ? 1 : 0);
      const rx = (k.has('d') || k.has('arrowright') ? 1 : 0) - (k.has('a') || k.has('arrowleft') ? 1 : 0);
      if (fx || rx) {
        goal.current = null;
        const fwd = c.target.clone().sub(camera.position).setY(0).normalize();
        const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
        const speed = Math.max(40, camera.position.distanceTo(c.target)) * (k.has('shift') ? 1.4 : 0.45) * dt;
        const d = fwd.multiplyScalar(fx * speed).add(right.multiplyScalar(rx * speed));
        c.target.add(d);
        camera.position.add(d);
      }
    }
    if (c) {
      const b = world.bounds;
      const m = SIZE * 0.12;
      const cx = THREE.MathUtils.clamp(c.target.x, b.minX - m, b.maxX + m);
      const cz = THREE.MathUtils.clamp(c.target.z, b.minZ - m, b.maxZ + m);
      if (cx !== c.target.x || cz !== c.target.z) {
        camera.position.x += cx - c.target.x;
        camera.position.z += cz - c.target.z;
        c.target.x = cx;
        c.target.z = cz;
      }
    }
    const mv = move.current;
    if (c && mv) {
      mv.age += dt;
      const u = mv.dur > 0 ? Math.min(1, mv.age / mv.dur) : 1;
      const k = u * u * (3 - 2 * u); // smoothstep: ease in and out
      camera.position.lerpVectors(mv.p0, mv.p1, k);
      c.target.lerpVectors(mv.t0, mv.t1, k);
      c.update();
      if (u >= 1) move.current = null;
      return;
    }
    const g = goal.current;
    if (!c || !g) return;
    const id = useUI.getState().selection?.id;
    const live = id ? entityPosition(id) : null;
    if (live) g.target.copy(live);
    const dir = camera.position.clone().sub(c.target).normalize();
    const wantPos = g.target.clone().add(dir.multiplyScalar(g.dist));
    c.target.lerp(g.target, 0.12);
    camera.position.lerp(wantPos, 0.12);
    if (c.target.distanceTo(g.target) < 0.5 && camera.position.distanceTo(wantPos) < 1) goal.current = null;
    c.update();
  });

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping
      dampingFactor={0.1}
      screenSpacePanning={false}
      panSpeed={1.4}
      minDistance={15}
      maxDistance={SIZE * 1.8}
      maxPolarAngle={Math.PI / 2 - 0.03}
      mouseButtons={{ LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE }}
      touches={{ ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE }}
      onStart={() => {
        goal.current = null;
        move.current = null;
      }}
    />
  );
}

export function EnvironmentScene() {
  const mats = useMemo(() => getMaterials(), []);
  void mats;
  return (
    <>
      <Lighting />
      <Terrain />
      <CityScene />
      <LogisticsScene />
      <Overlays />
      <RouteOverlay />
      <DroneLayer />
      <CameraRig />
      <SimDriver />
    </>
  );
}
