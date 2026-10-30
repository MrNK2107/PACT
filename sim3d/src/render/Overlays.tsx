import { useEffect, useMemo, useRef, useState } from 'react';
import { Html } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { engine, world } from '../app/simContext';
import { useUI } from '../app/uiStore';
import { SIM } from '../sim/config';
import { shapeBounds } from '../world/NoFly';
import { shardPolygon } from '../world/Shards';
import type { BuildingData, DepotData, DistrictData, NoFlyZone, RadioZone, StaticObstacle } from '../world/types';
import { windAt } from '../world/Wind';
import { ChunkedInstances } from './ChunkedInstances';
import { NetworkOverlay } from './NetworkOverlay';
import { hatchTexture } from './textures';
import { GROUND_TOP } from './terrain';

const NOFLY = '#dc2626';
const CLOSED = '#f59e0b';
const INACTIVE = '#8a96a6';
const RADIO = '#7c3aed';

function useTarget(): THREE.Vector3 {
  const controls = useThree((st) => st.controls) as unknown as { target: THREE.Vector3 } | null;
  const camera = useThree((st) => st.camera);
  return controls?.target ?? camera.position;
}

// -------------------------------------------------------------------------------------------------
// Navigation grid, flight-envelope boundary and planner occupancy
// -------------------------------------------------------------------------------------------------

function NavGrid() {
  const show = useUI((s) => s.showGrid);
  const b = world.bounds;
  const { minor, major } = useMemo(() => {
    const minorP: number[] = [];
    const majorP: number[] = [];
    for (let x = Math.ceil(b.minX / 100) * 100; x <= b.maxX; x += 100) (x % 500 === 0 ? majorP : minorP).push(x, 0.5 + GROUND_TOP, b.minZ, x, 0.5 + GROUND_TOP, b.maxZ);
    for (let z = Math.ceil(b.minZ / 100) * 100; z <= b.maxZ; z += 100) (z % 500 === 0 ? majorP : minorP).push(b.minX, 0.5 + GROUND_TOP, z, b.maxX, 0.5 + GROUND_TOP, z);
    const mk = (p: number[]) => new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    return { minor: mk(minorP), major: mk(majorP) };
  }, [b]);
  const edges = useMemo(() => new THREE.EdgesGeometry(new THREE.BoxGeometry(b.maxX - b.minX, b.maxY, b.maxZ - b.minZ)), [b]);

  if (!show) return null;
  const ticks: number[] = [];
  for (let t = Math.ceil(b.minX / 1000) * 1000; t <= b.maxX; t += 1000) ticks.push(t);
  return (
    <group>
      <lineSegments geometry={minor}>
        <lineBasicMaterial color="#334155" transparent opacity={0.28} depthWrite={false} />
      </lineSegments>
      <lineSegments geometry={major}>
        <lineBasicMaterial color="#1e3a5f" transparent opacity={0.7} depthWrite={false} />
      </lineSegments>
      <lineSegments geometry={edges} position={[(b.minX + b.maxX) / 2, b.maxY / 2, (b.minZ + b.maxZ) / 2]}>
        <lineBasicMaterial color="#2563eb" transparent opacity={0.45} />
      </lineSegments>
      {ticks.map((t) => (
        <group key={t}>
          <group position={[t, 0.5 + GROUND_TOP, b.maxZ + 30]}>
            <Html center style={{ pointerEvents: 'none' }}>
              <div className="axis-chip">x {t}</div>
            </Html>
          </group>
          <group position={[b.minX - 40, 0.5 + GROUND_TOP, t]}>
            <Html center style={{ pointerEvents: 'none' }}>
              <div className="axis-chip">z {t}</div>
            </Html>
          </group>
        </group>
      ))}
      <OccupancyLayer />
    </group>
  );
}

/** Planner occupancy around the view target for the selected drone's cruise layer (default 37 m). */
function OccupancyLayer() {
  const [alt, setAlt] = useState(37);
  const planner = engine.planner;
  const target = useTarget();
  const meshRef = useRef<THREE.Mesh>(null);
  const last = useRef(0);
  const lastAt = useRef({ x: NaN, z: NaN, alt: 0, v: -1 });
  const W = 600;
  const canvas = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = Math.ceil(W / planner.cell);
    c.height = Math.ceil(W / planner.cell);
    return c;
  }, [planner]);
  const tex = useMemo(() => {
    const t = new THREE.CanvasTexture(canvas);
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestFilter;
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, [canvas]);

  useFrame((s) => {
    if (s.clock.elapsedTime - last.current < 0.4) return;
    last.current = s.clock.elapsedTime;
    const sel = useUI.getState().selection?.id;
    const a = sel ? engine.agents.find((x) => x.id === sel) : undefined;
    const want = a && a.controller.cruiseAlt ? Math.round(a.controller.cruiseAlt) : 37;
    setAlt((cur) => (cur === want ? cur : want));
    const m = meshRef.current;
    if (!m) return;
    const cx = Math.round(target.x / 50) * 50;
    const cz = Math.round(target.z / 50) * 50;
    const L = lastAt.current;
    if (L.x === cx && L.z === cz && L.alt === want && L.v === engine.obstacles.zoneVersion) return;
    lastAt.current = { x: cx, z: cz, alt: want, v: engine.obstacles.zoneVersion };
    const w = planner.blockedArea(want, cx - W / 2, cx + W / 2, cz - W / 2, cz + W / 2);
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(w.nx, w.nz);
    for (let i = 0; i < w.grid.length; i++) {
      img.data[i * 4] = 220;
      img.data[i * 4 + 1] = 70;
      img.data[i * 4 + 2] = 40;
      img.data[i * 4 + 3] = w.grid[i] ? 120 : 0;
    }
    canvas.width = w.nx;
    canvas.height = w.nz;
    ctx.putImageData(img, 0, 0);
    tex.needsUpdate = true;
    const [x0, z0] = planner.centre(w.i0, w.j0);
    m.position.set(x0 - planner.cell / 2 + (w.nx * planner.cell) / 2, 0.55 + GROUND_TOP, z0 - planner.cell / 2 + (w.nz * planner.cell) / 2);
    m.scale.set(w.nx * planner.cell, w.nz * planner.cell, 1);
  });

  return (
    <group>
      <mesh ref={meshRef} rotation={[-Math.PI / 2, 0, 0]} renderOrder={2}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial map={tex} transparent depthWrite={false} />
      </mesh>
      <group position={[world.bounds.minX + 60, 0.6 + GROUND_TOP, world.bounds.minZ + 6]}>
        <Html center style={{ pointerEvents: 'none' }}>
          <div className="axis-chip">planner occupancy @ {alt} m (around view)</div>
        </Html>
      </group>
    </group>
  );
}

// -------------------------------------------------------------------------------------------------
// No-fly zones (circle / box / polygon; active, closable-inactive, fault-closed)
// -------------------------------------------------------------------------------------------------

function zoneColour(z: NoFlyZone): string {
  if (!z.active) return INACTIVE;
  if (z.source === 'fault' || z.closedFrom !== undefined) return CLOSED;
  return NOFLY;
}

function NoFlyZone({ z, hatch, labels }: { z: NoFlyZone; hatch: THREE.Texture; labels: boolean }) {
  const cap = (z.minY ?? 0) > 0;
  const y0 = cap ? z.minY! : 0;
  const H = Math.min(60, z.maxY);
  const colour = zoneColour(z);
  const { floor, volume, edges, cx, cz, label } = useMemo(() => {
    const s = z.shape;
    const bb = shapeBounds(s);
    const cx = (bb.minX + bb.maxX) / 2;
    const cz = (bb.minZ + bb.maxZ) / 2;
    const tex = hatch.clone();
    tex.needsUpdate = true;
    let floor: THREE.BufferGeometry;
    let volume: THREE.BufferGeometry;
    if (s.type === 'circle') {
      tex.repeat.set(s.r / 4, s.r / 4);
      floor = new THREE.CircleGeometry(s.r, 48).rotateX(-Math.PI / 2);
      volume = new THREE.CylinderGeometry(s.r, s.r, H, 48, 1, true).translate(0, H / 2, 0);
    } else if (s.type === 'box') {
      const w = s.maxX - s.minX;
      const d = s.maxZ - s.minZ;
      tex.repeat.set(w / 8, d / 8);
      floor = new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2);
      volume = new THREE.BoxGeometry(w, H, d).translate(0, H / 2, 0);
    } else {
      const shape = new THREE.Shape(s.points.map((p) => new THREE.Vector2(p.x - cx, -(p.z - cz))));
      tex.repeat.set((bb.maxX - bb.minX) / 8, (bb.maxZ - bb.minZ) / 8);
      floor = new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2);
      volume = new THREE.ExtrudeGeometry(shape, { depth: H, bevelEnabled: false }).rotateX(-Math.PI / 2);
    }
    return { floor, volume, edges: new THREE.EdgesGeometry(volume, 30), cx, cz, label: cap ? `${z.id} · ceiling ${y0} m` : `${z.id} · ${z.active ? (z.closedFrom !== undefined ? 'closed' : 'no-fly') : 'open (closable)'}` };
  }, [z, hatch, H, z.active, z.closedFrom]);
  const floorMat = useMemo(() => new THREE.MeshBasicMaterial({ map: hatch, transparent: true, opacity: z.active ? 0.55 : 0.18, depthWrite: false, color: colour }), [hatch, z.active, colour]);
  return (
    <group position={[cx, 0, cz]}>
      <mesh geometry={floor} position={[0, y0 + 0.6 + (cap ? 0 : GROUND_TOP), 0]} renderOrder={2} material={floorMat} />
      {z.active && !cap && (
        <mesh geometry={volume}>
          <meshBasicMaterial color={colour} transparent opacity={0.09} depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
      )}
      {!cap && (
        <lineSegments geometry={edges}>
          <lineBasicMaterial color={colour} transparent opacity={z.active ? 0.55 : 0.35} />
        </lineSegments>
      )}
      {labels && (
        <group position={[0, (cap ? y0 : H) + 3, 0]}>
          <Html center style={{ pointerEvents: 'none' }}>
            <div className="chip chip-nofly" style={{ background: z.active ? undefined : 'rgba(60,70,80,.8)' }}>{label}</div>
          </Html>
        </group>
      )}
    </group>
  );
}

function NoFlyZones() {
  const show = useUI((s) => s.showNoFly);
  const labels = useUI((s) => s.showLabels);
  const hatch = useMemo(() => hatchTexture('#ffffff'), []);
  // re-render when a zone changes state
  const [, setV] = useState(0);
  useFrame(() => {
    setV((v) => (v === engine.obstacles.zoneVersion ? v : engine.obstacles.zoneVersion));
  });
  if (!show) return null;
  return (
    <group>
      {world.noFlyZones.map((z) => (
        <NoFlyZone key={`${z.id}:${z.active}:${z.closedFrom ?? ''}`} z={z} hatch={hatch} labels={labels} />
      ))}
    </group>
  );
}

// -------------------------------------------------------------------------------------------------
// Radio dead zones: hatched ground patches plus a faint ceiling at the zone's altitude limit
// -------------------------------------------------------------------------------------------------

function RadioZoneMesh({ z, hatch, labels }: { z: RadioZone; hatch: THREE.Texture; labels: boolean }) {
  const H = Math.min(60, z.maxY);
  const { floor, edges, cx, cz } = useMemo(() => {
    const s = z.shape;
    const bb = shapeBounds(s);
    const cx = (bb.minX + bb.maxX) / 2;
    const cz = (bb.minZ + bb.maxZ) / 2;
    let floor: THREE.BufferGeometry;
    let volume: THREE.BufferGeometry;
    if (s.type === 'circle') {
      floor = new THREE.CircleGeometry(s.r, 48).rotateX(-Math.PI / 2);
      volume = new THREE.CylinderGeometry(s.r, s.r, H, 48, 1, true).translate(0, H / 2, 0);
    } else if (s.type === 'box') {
      floor = new THREE.PlaneGeometry(s.maxX - s.minX, s.maxZ - s.minZ).rotateX(-Math.PI / 2);
      volume = new THREE.BoxGeometry(s.maxX - s.minX, H, s.maxZ - s.minZ).translate(0, H / 2, 0);
    } else {
      const shape = new THREE.Shape(s.points.map((p) => new THREE.Vector2(p.x - cx, -(p.z - cz))));
      floor = new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2);
      volume = new THREE.ExtrudeGeometry(shape, { depth: H, bevelEnabled: false }).rotateX(-Math.PI / 2);
    }
    return { floor, edges: new THREE.EdgesGeometry(volume, 30), cx, cz };
  }, [z, H]);
  const mat = useMemo(() => new THREE.MeshBasicMaterial({ map: hatch, transparent: true, opacity: 0.4, depthWrite: false, color: RADIO }), [hatch]);
  const label = `${z.id} · radio ×${z.rangeFactor.toFixed(2)}${z.lossAdd > 0 ? ` · loss +${Math.round(z.lossAdd * 100)}%` : ''}`;
  return (
    <group position={[cx, 0, cz]}>
      <mesh geometry={floor} position={[0, 0.7 + GROUND_TOP, 0]} renderOrder={2} material={mat} />
      <lineSegments geometry={edges}>
        <lineBasicMaterial color={RADIO} transparent opacity={0.45} />
      </lineSegments>
      {labels && (
        <group position={[0, H + 3, 0]}>
          <Html center style={{ pointerEvents: 'none' }}>
            <div className="chip chip-nofly" style={{ background: 'rgba(91,33,182,.85)' }}>{label}</div>
          </Html>
        </group>
      )}
    </group>
  );
}

function RadioZones() {
  const show = useUI((s) => s.showRadio);
  const labels = useUI((s) => s.showLabels);
  const hatch = useMemo(() => hatchTexture('#ffffff'), []);
  const [, setV] = useState(0);
  useFrame(() => {
    setV((v) => (v === engine.radio.version ? v : engine.radio.version));
  });
  if (!show || !engine.radio.hasZones) return null;
  return (
    <group>
      {engine.radio.zones.filter((z) => z.active).map((z) => (
        <RadioZoneMesh key={`${z.id}:${z.rangeFactor}`} z={z} hatch={hatch} labels={labels} />
      ))}
    </group>
  );
}

// -------------------------------------------------------------------------------------------------
// Obstacle volumes near the view (what the ObstacleManager / PathPlanner actually see)
// -------------------------------------------------------------------------------------------------

function boxEdges(o: StaticObstacle, out: number[]) {
  const b = o.bounds;
  const c: [number, number, number][] = [
    [b.minX, b.minY, b.minZ], [b.maxX, b.minY, b.minZ], [b.maxX, b.minY, b.maxZ], [b.minX, b.minY, b.maxZ],
    [b.minX, b.maxY, b.minZ], [b.maxX, b.maxY, b.minZ], [b.maxX, b.maxY, b.maxZ], [b.minX, b.maxY, b.maxZ],
  ];
  const e = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  for (const [i, j] of e) out.push(...c[i], ...c[j]);
}

function cylEdges(o: StaticObstacle, out: number[]) {
  const n = 16;
  for (let k = 0; k < n; k++) {
    const a0 = (k / n) * Math.PI * 2;
    const a1 = ((k + 1) / n) * Math.PI * 2;
    for (const y of [o.bounds.minY, o.bounds.maxY]) out.push(o.cx + o.r * Math.cos(a0), y, o.cz + o.r * Math.sin(a0), o.cx + o.r * Math.cos(a1), y, o.cz + o.r * Math.sin(a1));
  }
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2;
    out.push(o.cx + o.r * Math.cos(a), o.bounds.minY, o.cz + o.r * Math.sin(a), o.cx + o.r * Math.cos(a), o.bounds.maxY, o.cz + o.r * Math.sin(a));
  }
}

function ObstacleVolumes() {
  const show = useUI((s) => s.showObstacles);
  const target = useTarget();
  const ref = useRef<THREE.LineSegments>(null);
  const last = useRef({ x: NaN, z: NaN });
  const scratch = useMemo<StaticObstacle[]>(() => [], []);
  useFrame(() => {
    const ls = ref.current;
    if (!ls || !show) return;
    const cx = Math.round(target.x / 100) * 100;
    const cz = Math.round(target.z / 100) * 100;
    if (last.current.x === cx && last.current.z === cz) return;
    last.current = { x: cx, z: cz };
    const p: number[] = [];
    for (const o of engine.obstacles.queryAABB(cx - 700, cx + 700, cz - 700, cz + 700, scratch)) {
      if (o.category === 'tree') continue;
      if (o.shape === 'box') boxEdges(o, p);
      else cylEdges(o, p);
    }
    ls.geometry.dispose();
    ls.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  });
  if (!show) return null;
  return (
    <lineSegments ref={ref} frustumCulled={false}>
      <bufferGeometry />
      <lineBasicMaterial color="#d97706" transparent opacity={0.55} depthWrite={false} />
    </lineSegments>
  );
}

// -------------------------------------------------------------------------------------------------
// Wind field + shard grid
// -------------------------------------------------------------------------------------------------

function WindArrows() {
  const show = useUI((s) => s.showWind);
  // weather fronts and storm cells rebuild the field; re-draw when it changes
  const [wv, setWv] = useState(0);
  useFrame(() => {
    setWv((v) => (v === engine.windVersion ? v : engine.windVersion));
  });
  const f = world.wind;
  const n = f.nx * f.nz;
  const geo = useMemo(() => {
    const shaft = new THREE.BoxGeometry(1, 0.25, 0.25).translate(0.5, 0, 0);
    const head = new THREE.ConeGeometry(0.6, 1.2, 6).rotateZ(-Math.PI / 2).translate(1.2, 0, 0);
    const g = new THREE.BufferGeometry();
    const a = shaft.toNonIndexed();
    const b = head.toNonIndexed();
    const pos = new Float32Array(a.attributes.position.count * 3 + b.attributes.position.count * 3);
    pos.set(a.attributes.position.array as Float32Array, 0);
    pos.set(b.attributes.position.array as Float32Array, a.attributes.position.count * 3);
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.computeVertexNormals();
    return g;
  }, []);
  const mat = useMemo(() => new THREE.MeshBasicMaterial({ color: '#38bdf8', transparent: true, opacity: 0.75, depthWrite: false }), []);
  if (!show) return null;
  return (
    <ChunkedInstances
      count={n}
      positionOf={(i) => [f.originX + (i % f.nx) * f.cell, f.originZ + Math.floor(i / f.nx) * f.cell]}
      geometry={geo}
      material={mat}
      setup={(i, o) => {
        const x = f.originX + (i % f.nx) * f.cell;
        const z = f.originZ + Math.floor(i / f.nx) * f.cell;
        const w = windAt(f, x, z);
        const sp = Math.hypot(w.vx, w.vz);
        o.position.set(x, 24 + GROUND_TOP, z);
        o.rotation.y = -Math.atan2(w.vz, w.vx);
        o.scale.set(4 + sp * 3, 2, 2);
      }}
      lod={3500}
      chunk={1000}
      version={wv}
    />
  );
}

function ShardGrid() {
  const show = useUI((s) => s.showShards);
  const labels = useUI((s) => s.showLabels);
  const target = useTarget();
  const [near, setNear] = useState<string[]>([]);
  const lastKey = useRef('');
  const colours = useMemo(() => {
    const m = new Map<string, THREE.Color>();
    world.depots.forEach((d, i) => m.set(d.id, new THREE.Color().setHSL((i * 0.137) % 1, 0.55, 0.55)));
    return m;
  }, []);
  const geo = useMemo(() => {
    const pos: number[] = [];
    const col: number[] = [];
    for (const id of world.shards.ids) {
      const poly = shardPolygon(world.shards, id);
      const c = colours.get(world.shards.depotOf[id]) ?? new THREE.Color('#94a3b8');
      for (let k = 0; k < 6; k++) {
        const a = poly[k];
        const b = poly[(k + 1) % 6];
        pos.push(a.x, 1.2, a.z, b.x, 1.2, b.z);
        col.push(c.r, c.g, c.b, c.r, c.g, c.b);
      }
    }
    return new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)).setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  }, [colours]);
  useFrame((s) => {
    if (!show || !labels || s.clock.elapsedTime % 0.5 > 0.05) return;
    const list = world.shards.ids.filter((id) => {
      const p = shardPolygon(world.shards, id);
      const cx = (p[0].x + p[3].x) / 2;
      const cz = (p[0].z + p[3].z) / 2;
      return Math.hypot(cx - target.x, cz - target.z) < 900;
    }).slice(0, 40);
    const k = list.join();
    if (k !== lastKey.current) {
      lastKey.current = k;
      setNear(list);
    }
  });
  if (!show) return null;
  return (
    <group>
      <lineSegments geometry={geo} frustumCulled={false}>
        <lineBasicMaterial vertexColors transparent opacity={0.8} depthWrite={false} />
      </lineSegments>
      {labels &&
        near.map((id) => {
          const p = shardPolygon(world.shards, id);
          return (
            <group key={id} position={[(p[0].x + p[3].x) / 2, 6, (p[0].z + p[3].z) / 2]}>
              <Html center style={{ pointerEvents: 'none' }}>
                <div className="axis-chip">{id} · {world.shards.depotOf[id]}</div>
              </Html>
            </group>
          );
        })}
    </group>
  );
}

// -------------------------------------------------------------------------------------------------
// Communication ranges + links
// -------------------------------------------------------------------------------------------------

/** Radio range rings per drone; links and depot masts are drawn by `NetworkOverlay`. */
function CommsOverlay() {
  const group = useRef<THREE.Group>(null);
  const rings = useRef(new Map<string, THREE.LineLoop>());
  const ringGeo = useMemo(() => {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < 72; i++) pts.push(new THREE.Vector3(Math.cos((i / 72) * Math.PI * 2) * SIM.commRange, 0, Math.sin((i / 72) * Math.PI * 2) * SIM.commRange));
    return new THREE.BufferGeometry().setFromPoints(pts);
  }, []);

  useFrame(() => {
    const g = group.current;
    if (!g) return;
    const show = useUI.getState().showComms;
    g.visible = show;
    if (!show) return;
    const live = new Set(engine.agents.map((a) => a.id));
    for (const [id, r] of rings.current) {
      if (!live.has(id)) {
        g.remove(r);
        (r.material as THREE.Material).dispose();
        rings.current.delete(id);
      }
    }
    for (const a of engine.agents) {
      let r = rings.current.get(a.id);
      if (!r) {
        r = new THREE.LineLoop(ringGeo, new THREE.LineBasicMaterial({ color: a.color, transparent: true, opacity: 0.45, depthWrite: false }));
        r.frustumCulled = false;
        g.add(r);
        rings.current.set(a.id, r);
      }
      r.position.set(a.body.pos.x, a.body.pos.y, a.body.pos.z);
    }
  });

  return <group ref={group} visible={false} />;
}

// -------------------------------------------------------------------------------------------------
// Selection highlight
// -------------------------------------------------------------------------------------------------

function SelectionHighlight() {
  const sel = useUI((s) => s.selection?.id);
  const entry = sel ? world.index.get(sel) : undefined;
  const boxGeo = useMemo(() => new THREE.BoxGeometry(1, 1, 1), []);
  const edge = useMemo(() => new THREE.EdgesGeometry(boxGeo), [boxGeo]);
  if (!entry) return null;
  const mat = <lineBasicMaterial color="#2563eb" depthTest={false} transparent opacity={0.95} />;
  switch (entry.type) {
    case 'building': {
      const b = entry.data as BuildingData;
      const h = b.bounds.maxY - b.bounds.minY;
      return (
        <lineSegments geometry={edge} position={[b.cx, b.bounds.minY + h / 2, b.cz]} scale={[b.w + 0.6, h + 0.6, b.d + 0.6]} renderOrder={10}>
          {mat}
        </lineSegments>
      );
    }
    case 'district': {
      const d = entry.data as DistrictData;
      return (
        <lineSegments geometry={edge} position={[(d.minX + d.maxX) / 2, 2, (d.minZ + d.maxZ) / 2]} scale={[d.maxX - d.minX, 4, d.maxZ - d.minZ]} renderOrder={10}>
          {mat}
        </lineSegments>
      );
    }
    case 'depot': {
      const h = entry.data as DepotData;
      const pads = world.pads.filter((p) => p.depotId === h.id);
      return (
        <group>
          <lineSegments geometry={edge} position={[(h.apron.minX + h.apron.maxX) / 2, 1, (h.apron.minZ + h.apron.maxZ) / 2]} scale={[h.apron.maxX - h.apron.minX, 2, h.apron.maxZ - h.apron.minZ]} renderOrder={10}>
            {mat}
          </lineSegments>
          {pads.map((p) => (
            <mesh key={p.id} position={[p.pos.x, p.pos.y + 0.2, p.pos.z]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={10}>
              <ringGeometry args={[p.radius + 0.6, p.radius + 1.1, 40]} />
              <meshBasicMaterial color="#2563eb" depthTest={false} transparent opacity={0.95} />
            </mesh>
          ))}
        </group>
      );
    }
    case 'drop point':
    case 'charger':
    case 'pad': {
      const p = (entry.data as { pos: { x: number; y: number; z: number } }).pos;
      return (
        <group position={[p.x, p.y + 0.2, p.z]}>
          <mesh rotation={[-Math.PI / 2, 0, 0]} renderOrder={10}>
            <ringGeometry args={[4, 4.7, 40]} />
            <meshBasicMaterial color="#2563eb" depthTest={false} transparent opacity={0.95} />
          </mesh>
          <mesh position={[0, 12, 0]}>
            <cylinderGeometry args={[0.08, 0.08, 24, 6]} />
            <meshBasicMaterial color="#2563eb" transparent opacity={0.6} />
          </mesh>
        </group>
      );
    }
    default:
      return null;
  }
}

export function Overlays() {
  return (
    <group>
      <NavGrid />
      <NoFlyZones />
      <RadioZones />
      <ObstacleVolumes />
      <WindArrows />
      <ShardGrid />
      <CommsOverlay />
      <NetworkOverlay />
      <SelectionHighlight />
    </group>
  );
}

export type { NoFlyZone as NoFlyZoneData };
