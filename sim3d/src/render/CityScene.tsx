import { useCallback, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { engine, world } from '../app/simContext';
import { useUI } from '../app/uiStore';
import { gableRise } from '../world/BuildContext';
import type { BuildingData, PropData, RoadKind, VehicleRoute } from '../world/types';
import { ChunkedInstances } from './ChunkedInstances';
import { getMaterials } from './materials';

const unitBox = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
const centredBox = new THREE.BoxGeometry(1, 1, 1);
const flatPlane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
const unitCyl = new THREE.CylinderGeometry(0.5, 0.5, 1, 14).translate(0, 0.5, 0);

/** Triangular prism, ridge along X, unit footprint, unit rise. */
function makeGableGeometry(ridge = 0.5): THREE.BufferGeometry {
  const r = ridge - 0.5; // ridge z position in [-0.5, 0.5]
  const p = [
    [-0.5, 0, 0.5], [0.5, 0, 0.5], [0.5, 1, r], [-0.5, 0, 0.5], [0.5, 1, r], [-0.5, 1, r],
    [0.5, 0, -0.5], [-0.5, 0, -0.5], [-0.5, 1, r], [0.5, 0, -0.5], [-0.5, 1, r], [0.5, 1, r],
    [-0.5, 0, -0.5], [-0.5, 0, 0.5], [-0.5, 1, r],
    [0.5, 0, 0.5], [0.5, 0, -0.5], [0.5, 1, r],
    [-0.5, 0, 0.5], [-0.5, 0, -0.5], [0.5, 0, -0.5], [-0.5, 0, 0.5], [0.5, 0, -0.5], [0.5, 0, 0.5],
  ].flat();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.computeVertexNormals();
  return g;
}

/** Hip roof: ridge along X shortened by 0.5 of the depth at each end. */
function makeHipGeometry(): THREE.BufferGeometry {
  const k = 0.25; // ridge inset from each gable end (in unit length)
  const a = [-0.5, 0, 0.5];
  const b = [0.5, 0, 0.5];
  const c = [0.5, 0, -0.5];
  const d = [-0.5, 0, -0.5];
  const e = [-0.5 + k, 1, 0];
  const f = [0.5 - k, 1, 0];
  const tri = (...v: number[][]) => v.flat();
  const p = [
    ...tri(a, b, f), ...tri(a, f, e), // front slope
    ...tri(c, d, e), ...tri(c, e, f), // back slope
    ...tri(d, a, e), // left hip
    ...tri(b, c, f), // right hip
    ...tri(a, d, c), ...tri(a, c, b), // underside
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.computeVertexNormals();
  return g;
}

/** Half-cylinder vault, axis along X, unit footprint (z -0.5..0.5), unit rise. */
function makeBarrelGeometry(): THREE.BufferGeometry {
  const n = 12;
  const pos: number[] = [];
  const ring = (x: number) => Array.from({ length: n + 1 }, (_, k) => [x, Math.sin((Math.PI * k) / n), -0.5 * Math.cos((Math.PI * k) / n)]);
  const A = ring(-0.5);
  const B = ring(0.5);
  for (let k = 0; k < n; k++) pos.push(...A[k], ...B[k], ...B[k + 1], ...A[k], ...B[k + 1], ...A[k + 1]);
  for (let k = 0; k < n; k++) {
    pos.push(-0.5, 0, 0, ...A[k + 1], ...A[k]);
    pos.push(0.5, 0, 0, ...B[k], ...B[k + 1]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

const gableGeo = makeGableGeometry();
const sawGeo = makeGableGeometry(0.28);
const hipGeo = makeHipGeometry();
const barrelGeo = makeBarrelGeometry();

function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10000) / 10000;
}

const ROAD_TINT: Record<RoadKind, number> = { motorway: 0.78, arterial: 0.9, collector: 1.0, local: 1.08, service: 1.15 };

// -------------------------------------------------------------------------------------------------
// Roads, junctions, markings, bridges, rail
// -------------------------------------------------------------------------------------------------

function Roads() {
  const mats = getMaterials();
  const roads = world.roads;
  const junctions = world.junctions;
  const setRoad = useCallback(
    (i: number, o: THREE.Object3D, c: THREE.Color) => {
      const r = roads[i];
      const len = r.b - r.a;
      o.position.set(r.dir === 'EW' ? (r.a + r.b) / 2 : r.c, 0.02 + (i % 3) * 0.002, r.dir === 'EW' ? r.c : (r.a + r.b) / 2);
      o.rotation.y = r.dir === 'EW' ? 0 : Math.PI / 2;
      o.scale.set(len, 1, r.width);
      c.setScalar(ROAD_TINT[r.kind]);
    },
    [roads],
  );
  const roadPos = useCallback((i: number): [number, number] => (roads[i].dir === 'EW' ? [(roads[i].a + roads[i].b) / 2, roads[i].c] : [roads[i].c, (roads[i].a + roads[i].b) / 2]), [roads]);
  const setJunction = useCallback(
    (i: number, o: THREE.Object3D, c: THREE.Color) => {
      const j = junctions[i];
      o.position.set(j.x, 0.03, j.z);
      o.scale.set(j.wNS, 1, j.wEW);
      c.setScalar(ROAD_TINT[j.kind]);
    },
    [junctions],
  );
  const junctionPos = useCallback((i: number): [number, number] => [junctions[i].x, junctions[i].z], [junctions]);

  // centre-line dashes (collector and up), crosswalk stripes at arterial / collector junctions
  const dashes = useMemo(() => {
    const out: { x: number; z: number; ew: boolean }[] = [];
    const jOn = new Map<string, number[]>();
    for (const j of junctions) {
      (jOn.get(`EW:${j.z}`) ?? jOn.set(`EW:${j.z}`, []).get(`EW:${j.z}`)!).push(j.x);
      (jOn.get(`NS:${j.x}`) ?? jOn.set(`NS:${j.x}`, []).get(`NS:${j.x}`)!).push(j.z);
    }
    for (const r of roads) {
      if (r.kind === 'local' || r.kind === 'service') continue;
      const cross = jOn.get(`${r.dir}:${r.c}`) ?? [];
      for (let t = r.a + 6; t < r.b - 4; t += 12) {
        if (cross.some((c) => Math.abs(c - t) < r.width / 2 + 8)) continue;
        if (r.kind === 'motorway') {
          out.push(r.dir === 'EW' ? { x: t, z: r.c - r.width / 4, ew: true } : { x: r.c - r.width / 4, z: t, ew: false });
          out.push(r.dir === 'EW' ? { x: t, z: r.c + r.width / 4, ew: true } : { x: r.c + r.width / 4, z: t, ew: false });
        } else out.push(r.dir === 'EW' ? { x: t, z: r.c, ew: true } : { x: r.c, z: t, ew: false });
      }
    }
    return out;
  }, [roads, junctions]);
  const crosswalks = useMemo(() => {
    const out: { x: number; z: number; ew: boolean }[] = [];
    for (const j of junctions) {
      if (j.kind === 'local' || j.kind === 'motorway') continue;
      const legs: [number, number, boolean][] = [[1, 0, true], [-1, 0, true], [0, 1, false], [0, -1, false]];
      for (const [dx, dz, alongX] of legs) {
        const cx = j.x + dx * (j.wNS / 2 + 3);
        const cz = j.z + dz * (j.wEW / 2 + 3);
        const n = Math.max(3, Math.floor((alongX ? j.wEW : j.wNS) / 1.3));
        for (let k = 0; k < n; k++) {
          const t = (k - (n - 1) / 2) * 1.3;
          out.push(alongX ? { x: cx, z: cz + t, ew: true } : { x: cx + t, z: cz, ew: false });
        }
      }
    }
    return out;
  }, [junctions]);
  const setDash = useCallback(
    (i: number, o: THREE.Object3D) => {
      const d = dashes[i];
      o.position.set(d.x, 0.045, d.z);
      o.rotation.y = d.ew ? 0 : Math.PI / 2;
      o.scale.set(4, 1, 0.18);
    },
    [dashes],
  );
  const setCross = useCallback(
    (i: number, o: THREE.Object3D) => {
      const d = crosswalks[i];
      o.position.set(d.x, 0.046, d.z);
      o.rotation.y = d.ew ? 0 : Math.PI / 2;
      o.scale.set(3, 1, 0.6);
    },
    [crosswalks],
  );

  // bridges
  const bridges = useMemo(() => {
    const out: { x: number; z: number; len: number; w: number; ew: boolean }[] = [];
    for (const r of world.roads) for (const b of r.bridges ?? []) out.push({ x: r.dir === 'EW' ? (b.a + b.b) / 2 : r.c, z: r.dir === 'EW' ? r.c : (b.a + b.b) / 2, len: b.b - b.a, w: r.width + 3, ew: r.dir === 'EW' });
    for (const r of world.rails) for (const b of r.bridges ?? []) out.push({ x: r.dir === 'EW' ? (b.a + b.b) / 2 : r.c, z: r.dir === 'EW' ? r.c : (b.a + b.b) / 2, len: b.b - b.a, w: r.width + 2, ew: r.dir === 'EW' });
    return out;
  }, []);
  const setDeck = useCallback(
    (i: number, o: THREE.Object3D) => {
      const b = bridges[i];
      o.position.set(b.x, -0.9, b.z);
      o.rotation.y = b.ew ? 0 : Math.PI / 2;
      o.scale.set(b.len, 1.3, b.w);
    },
    [bridges],
  );
  const setRail = useCallback(
    (i: number, o: THREE.Object3D) => {
      const b = bridges[Math.floor(i / 2)];
      const s = i % 2 ? 1 : -1;
      o.position.set(b.x + (b.ew ? 0 : s * (b.w / 2 - 0.3)), 0.4, b.z + (b.ew ? s * (b.w / 2 - 0.3) : 0));
      o.rotation.y = b.ew ? 0 : Math.PI / 2;
      o.scale.set(b.len, 1.1, 0.35);
    },
    [bridges],
  );
  const setPier = useCallback(
    (i: number, o: THREE.Object3D) => {
      const b = bridges[Math.floor(i / 2)];
      const s = i % 2 ? 1 : -1;
      const t = s * Math.min(b.len * 0.3, 20);
      o.position.set(b.x + (b.ew ? t : 0), -6, b.z + (b.ew ? 0 : t));
      o.rotation.y = b.ew ? 0 : Math.PI / 2;
      o.scale.set(2.2, 5.5, b.w - 1);
    },
    [bridges],
  );

  // rail ballast, rails and sleepers
  const rails = world.rails;
  const sleepers = useMemo(() => {
    const out: { x: number; z: number; ew: boolean }[] = [];
    for (const r of rails) for (let t = r.a + 1; t < r.b; t += 2.2) out.push(r.dir === 'EW' ? { x: t, z: r.c, ew: true } : { x: r.c, z: t, ew: false });
    return out;
  }, [rails]);

  return (
    <group>
      <ChunkedInstances count={roads.length} positionOf={roadPos} geometry={flatPlane} material={mats.asphalt} setup={setRoad} colored receiveShadow chunk={1500} />
      <ChunkedInstances count={junctions.length} positionOf={junctionPos} geometry={flatPlane} material={mats.asphalt} setup={setJunction} colored receiveShadow chunk={600} />
      <ChunkedInstances count={dashes.length} positionOf={(i) => [dashes[i].x, dashes[i].z]} geometry={flatPlane} material={mats.paint} setup={setDash} lod={900} />
      <ChunkedInstances count={crosswalks.length} positionOf={(i) => [crosswalks[i].x, crosswalks[i].z]} geometry={flatPlane} material={mats.paint} setup={setCross} lod={600} />
      <ChunkedInstances count={bridges.length} positionOf={(i) => [bridges[i].x, bridges[i].z]} geometry={unitBox} material={mats.concrete} setup={setDeck} castShadow receiveShadow chunk={2000} />
      <ChunkedInstances count={bridges.length * 2} positionOf={(i) => [bridges[Math.floor(i / 2)].x, bridges[Math.floor(i / 2)].z]} geometry={unitBox} material={mats.concrete} setup={setRail} castShadow chunk={2000} />
      <ChunkedInstances count={bridges.length * 2} positionOf={(i) => [bridges[Math.floor(i / 2)].x, bridges[Math.floor(i / 2)].z]} geometry={unitBox} material={mats.concrete} setup={setPier} castShadow chunk={2000} />
      {rails.map((r) => (
        <group key={r.id} position={[r.dir === 'EW' ? (r.a + r.b) / 2 : r.c, 0, r.dir === 'EW' ? r.c : (r.a + r.b) / 2]} rotation={[0, r.dir === 'EW' ? 0 : Math.PI / 2, 0]}>
          <mesh geometry={unitBox} material={mats.ballast} scale={[r.b - r.a, 0.35, r.width]} receiveShadow />
          {[-0.75, 0.75].map((s) => (
            <mesh key={s} geometry={unitBox} material={mats.metalDark} position={[0, 0.42, s]} scale={[r.b - r.a, 0.12, 0.12]} />
          ))}
        </group>
      ))}
      <ChunkedInstances count={sleepers.length} positionOf={(i) => [sleepers[i].x, sleepers[i].z]} geometry={unitBox} material={mats.trunk} setup={(i, o) => { o.position.set(sleepers[i].x, 0.33, sleepers[i].z); o.rotation.y = sleepers[i].ew ? 0 : Math.PI / 2; o.scale.set(0.3, 0.12, 2.4); }} lod={500} />
      {world.stations.map((s) => (
        <group key={s.id} position={[s.x, 0, s.z]}>
          {[-1, 1].map((side) => (
            <group key={side}>
              <mesh geometry={unitBox} material={mats.paving} position={[0, 0, side * 10.5]} scale={[s.length, 1.0, 5]} castShadow receiveShadow />
              <mesh geometry={unitBox} material={mats.metalGrey} position={[0, 4.2, side * 10.5]} scale={[s.length * 0.7, 0.25, 5.5]} castShadow />
              {[-0.4, 0.4].map((u) => (
                <mesh key={u} geometry={unitBox} material={mats.metalDark} position={[u * s.length * 0.7, 1, side * 10.5]} scale={[0.3, 3.2, 0.3]} />
              ))}
            </group>
          ))}
        </group>
      ))}
    </group>
  );
}

// -------------------------------------------------------------------------------------------------
// Blocks (sidewalk slab + inner lot)
// -------------------------------------------------------------------------------------------------

const SURFACES = ['lawn', 'paving', 'gravel', 'asphalt', 'sand', 'turf'] as const;

function Blocks() {
  const mats = getMaterials();
  const blocks = world.blocks;
  const groups = useMemo(() => {
    const m = new Map<string, typeof blocks>();
    for (const s of SURFACES) m.set(s, []);
    for (const b of blocks) m.get(b.surface)!.push(b);
    return m;
  }, [blocks]);
  const setWalk = useCallback(
    (i: number, o: THREE.Object3D) => {
      o.position.set(blocks[i].cx, 0, blocks[i].cz);
      o.scale.set(blocks[i].w + 3, 0.22, blocks[i].d + 3);
    },
    [blocks],
  );
  const lotSetter = (list: typeof blocks) => (i: number, o: THREE.Object3D, c: THREE.Color) => {
    const b = list[i];
    o.position.set(b.cx, 0, b.cz);
    o.scale.set(b.w - 1, 0.3, b.d - 1);
    c.set(b.lotColor).lerp(new THREE.Color('#ffffff'), 0.45);
  };
  const matFor: Record<(typeof SURFACES)[number], THREE.Material> = { lawn: mats.lawn, paving: mats.paving, gravel: mats.gravel, asphalt: mats.asphalt, sand: mats.sand, turf: mats.turf };
  return (
    <group>
      <ChunkedInstances count={blocks.length} positionOf={(i) => [blocks[i].cx, blocks[i].cz]} geometry={unitBox} material={mats.concrete} setup={setWalk} receiveShadow chunk={600} />
      {SURFACES.map((s) => {
        const list = groups.get(s)!;
        return <ChunkedInstances key={s} count={list.length} positionOf={(i) => [list[i].cx, list[i].cz]} geometry={unitBox} material={matFor[s]} setup={lotSetter(list)} colored receiveShadow chunk={600} />;
      })}
    </group>
  );
}

// -------------------------------------------------------------------------------------------------
// Buildings
// -------------------------------------------------------------------------------------------------

const MATERIAL_KEYS = ['plaster', 'brick', 'concrete', 'glass', 'metal', 'corrugated', 'stone', 'panel'] as const;

function Buildings() {
  const mats = getMaterials();
  const visible = useUI((s) => s.showBuildings);
  const select = useUI((s) => s.select);
  const facadeMat = (k: (typeof MATERIAL_KEYS)[number]) => mats.facade[k === 'stone' ? 'brick' : k === 'panel' ? 'concrete' : k];

  const groups = useMemo(() => {
    const m = new Map<string, BuildingData[]>();
    for (const k of MATERIAL_KEYS) m.set(k, []);
    for (const b of world.buildings) m.get(b.material)!.push(b);
    return m;
  }, []);
  const gables = useMemo(() => world.buildings.filter((b) => b.roof === 'gable'), []);
  const hips = useMemo(() => world.buildings.filter((b) => b.roof === 'hip'), []);
  const barrels = useMemo(() => world.buildings.filter((b) => b.roof === 'barrel'), []);
  const teeth = useMemo(() => {
    const out: { b: BuildingData; k: number; n: number }[] = [];
    for (const b of world.buildings) {
      if (b.roof !== 'sawtooth') continue;
      const n = Math.max(1, Math.floor(b.w / 6));
      for (let k = 0; k < n; k++) out.push({ b, k, n });
    }
    return out;
  }, []);
  const stadiums = useMemo(() => world.buildings.filter((b) => b.kind === 'stadium'), []);
  const spires = useMemo(() => world.buildings.filter((b) => b.kind === 'spire'), []);
  const hvac = useMemo(() => world.equipment.filter((e) => e.type === 'hvac' || e.type === 'stairhead' || e.type === 'skylight'), []);
  const tanks = useMemo(() => world.equipment.filter((e) => e.type === 'tank'), []);
  const masts = useMemo(() => world.equipment.filter((e) => e.type === 'mast'), []);
  const solar = useMemo(() => world.equipment.filter((e) => e.type === 'solar'), []);
  const balconies = world.balconies;
  const solarMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#1d2b3a', roughness: 0.25, metalness: 0.6 }), []);

  const roofSetter = (list: BuildingData[]) => (i: number, o: THREE.Object3D, c: THREE.Color) => {
    const b = list[i];
    const rise = gableRise(b.w, b.d);
    o.position.set(b.cx, b.baseY + b.h, b.cz);
    o.rotation.y = b.rot ?? 0;
    if (b.w >= b.d) o.scale.set(b.w + 0.9, rise, b.d + 0.9);
    else {
      o.rotation.y += Math.PI / 2;
      o.scale.set(b.d + 0.9, rise, b.w + 0.9);
    }
    c.set(b.color);
  };
  const setBarrel = useCallback(
    (i: number, o: THREE.Object3D, c: THREE.Color) => {
      const b = barrels[i];
      o.position.set(b.cx, b.baseY + b.h, b.cz);
      const rise = Math.min(b.w, b.d) * 0.22;
      if (b.w >= b.d) o.scale.set(b.w + 0.4, rise, b.d + 0.4);
      else {
        o.rotation.y = Math.PI / 2;
        o.scale.set(b.d + 0.4, rise, b.w + 0.4);
      }
      c.set(b.color).lerp(new THREE.Color('#ffffff'), 0.1);
    },
    [barrels],
  );
  const setTooth = useCallback(
    (i: number, o: THREE.Object3D, c: THREE.Color) => {
      const { b, k, n } = teeth[i];
      const pitch = b.w / n;
      o.position.set(b.cx - b.w / 2 + pitch * (k + 0.5), b.baseY + b.h, b.cz);
      o.rotation.y = Math.PI / 2; // teeth run along z
      o.scale.set(b.d + 0.4, 2.5, pitch);
      c.set('#8a8d90');
    },
    [teeth],
  );

  return (
    <group visible={visible}>
      {MATERIAL_KEYS.map((k) => {
        const list = groups.get(k)!;
        return (
          <ChunkedInstances
            key={k}
            count={list.length}
            positionOf={(i) => [list[i].cx, list[i].cz]}
            geometry={unitBox}
            material={facadeMat(k)}
            colored
            castShadow
            receiveShadow
            visible={visible}
            shadowLod={900}
            onPick={(i) => select(list[i].id)}
            setup={(i, o, c) => {
              const b = list[i];
              o.position.set(b.cx, b.baseY, b.cz);
              o.rotation.y = b.rot ?? 0;
              o.scale.set(b.w, b.h, b.d);
              c.set(b.color);
              if (b.roof === 'gable' || b.roof === 'hip') c.set(b.material === 'brick' ? '#b0705a' : b.material === 'stone' ? '#a9a398' : '#e2dccb');
              if (b.kind === 'parking') c.set('#b5b5b0');
            }}
          />
        );
      })}
      <ChunkedInstances count={gables.length} positionOf={(i) => [gables[i].cx, gables[i].cz]} geometry={gableGeo} material={mats.roofTile} setup={roofSetter(gables)} colored castShadow receiveShadow visible={visible} shadowLod={700} onPick={(i) => select(gables[i].id)} />
      <ChunkedInstances count={hips.length} positionOf={(i) => [hips[i].cx, hips[i].cz]} geometry={hipGeo} material={mats.roofTile} setup={roofSetter(hips)} colored castShadow receiveShadow visible={visible} shadowLod={700} onPick={(i) => select(hips[i].id)} />
      <ChunkedInstances count={barrels.length} positionOf={(i) => [barrels[i].cx, barrels[i].cz]} geometry={barrelGeo} material={mats.metalGrey} setup={setBarrel} colored castShadow visible={visible} />
      <ChunkedInstances count={teeth.length} positionOf={(i) => [teeth[i].b.cx, teeth[i].b.cz]} geometry={sawGeo} material={mats.metalGrey} setup={setTooth} colored castShadow visible={visible} lod={1500} />
      {stadiums.map((b) => (
        <group key={b.id} position={[b.cx, b.baseY, b.cz]}>
          <mesh position={[0, b.h * 0.55, 0]} scale={[b.w / 2, b.h * 0.55, b.d / 2]} castShadow receiveShadow onClick={(e) => { e.stopPropagation(); select(b.id); }}>
            <cylinderGeometry args={[1, 0.86, 1, 40, 1, true]} />
            <meshStandardMaterial color={b.color} roughness={0.6} side={THREE.DoubleSide} />
          </mesh>
          <mesh position={[0, b.h * 0.9, 0]} rotation={[-Math.PI / 2, 0, 0]} scale={[b.w / 2, b.d / 2, 1]}>
            <ringGeometry args={[0.55, 1.02, 40]} />
            <meshStandardMaterial color="#dfe3e6" roughness={0.5} side={THREE.DoubleSide} />
          </mesh>
          <mesh position={[0, 0.4, 0]} rotation={[-Math.PI / 2, 0, 0]} scale={[b.w * 0.3, b.d * 0.3, 1]} material={mats.turf}>
            <planeGeometry args={[1, 1]} />
          </mesh>
        </group>
      ))}
      {spires.map((b) => (
        <mesh key={b.id} position={[b.cx, b.baseY + b.h + 5, b.cz]} castShadow>
          <coneGeometry args={[Math.min(b.w, b.d) / 2 + 0.3, 10, 4]} />
          <meshStandardMaterial color="#4f5256" roughness={0.6} />
        </mesh>
      ))}
      <ChunkedInstances count={hvac.length} positionOf={(i) => [hvac[i].x, hvac[i].z]} geometry={unitBox} material={mats.metalGrey} setup={(i, o, c) => { const e = hvac[i]; o.position.set(e.x, e.y, e.z); o.scale.set(e.sx, e.sy, e.sz); c.setHSL(0.58, 0.03, 0.45 + hash01(e.buildingId + i) * 0.25); }} colored castShadow visible={visible} lod={900} />
      <ChunkedInstances count={tanks.length} positionOf={(i) => [tanks[i].x, tanks[i].z]} geometry={unitCyl} material={mats.metalGrey} setup={(i, o, c) => { const e = tanks[i]; o.position.set(e.x, e.y, e.z); o.scale.set(e.sx * 1.6, e.sy, e.sz * 1.6); c.set('#9aa0a4'); }} colored castShadow visible={visible} lod={900} />
      <ChunkedInstances count={masts.length} positionOf={(i) => [masts[i].x, masts[i].z]} geometry={unitCyl} material={mats.metalGrey} setup={(i, o, c) => { const e = masts[i]; o.position.set(e.x, e.y, e.z); o.scale.set(0.35, e.sy, 0.35); c.set('#b8bcc0'); }} colored castShadow visible={visible} lod={1500} />
      <ChunkedInstances count={solar.length} positionOf={(i) => [solar[i].x, solar[i].z]} geometry={centredBox} material={solarMat} setup={(i, o) => { const e = solar[i]; o.position.set(e.x, e.y + 0.6, e.z); o.rotation.x = -0.25; o.scale.set(e.sx, 0.08, e.sz); }} visible={visible} lod={1200} />
      <ChunkedInstances count={balconies.length} positionOf={(i) => [balconies[i].x, balconies[i].z]} geometry={unitBox} material={mats.concrete} setup={(i, o) => { const b = balconies[i]; o.position.set(b.x, b.y, b.z); o.rotation.y = b.rot; o.scale.set(b.sx, 0.22, b.sz); }} castShadow visible={visible} lod={700} />
    </group>
  );
}

// -------------------------------------------------------------------------------------------------
// Vegetation, street furniture, props
// -------------------------------------------------------------------------------------------------

function Vegetation() {
  const mats = getMaterials();
  const trees = world.trees;
  const trunkGeo = useMemo(() => new THREE.CylinderGeometry(0.16, 0.26, 1, 6).translate(0, 0.5, 0), []);
  const broadGeo = useMemo(() => new THREE.IcosahedronGeometry(1, 1), []);
  const coniferGeo = useMemo(() => new THREE.ConeGeometry(1, 2, 7).translate(0, 1, 0), []);
  const palmGeo = useMemo(() => new THREE.IcosahedronGeometry(1, 0).scale(1, 0.45, 1), []);
  const broad = useMemo(() => trees.filter((t) => t.species === 'broadleaf'), [trees]);
  const conifers = useMemo(() => trees.filter((t) => t.species === 'conifer' || t.species === 'cypress'), [trees]);
  const palms = useMemo(() => trees.filter((t) => t.species === 'palm'), [trees]);
  return (
    <group>
      <ChunkedInstances count={trees.length} positionOf={(i) => [trees[i].x, trees[i].z]} geometry={trunkGeo} material={mats.trunk} setup={(i, o) => { const t = trees[i]; o.position.set(t.x, 0.2, t.z); const tall = t.species === 'palm' ? 0.85 : t.species === 'conifer' || t.species === 'cypress' ? 0.35 : 0.5; o.scale.set(t.radius * 0.3 + 0.5, t.height * tall, t.radius * 0.3 + 0.5); }} castShadow lod={1300} shadowLod={500} />
      <ChunkedInstances count={broad.length} positionOf={(i) => [broad[i].x, broad[i].z]} geometry={broadGeo} material={mats.foliage} setup={(i, o, c) => { const t = broad[i]; o.position.set(t.x, t.height * 0.62, t.z); o.scale.set(t.radius, t.radius * 0.9, t.radius); o.rotation.y = hash01(t.id) * 6; c.setHSL(0.22 + hash01(t.id) * 0.08, 0.34, 0.25 * t.shade); }} colored castShadow receiveShadow lod={2600} shadowLod={500} />
      <ChunkedInstances count={conifers.length} positionOf={(i) => [conifers[i].x, conifers[i].z]} geometry={coniferGeo} material={mats.foliage} setup={(i, o, c) => { const t = conifers[i]; const slim = t.species === 'cypress' ? 0.5 : 0.85; o.position.set(t.x, t.height * 0.25, t.z); o.scale.set(t.radius * slim, t.height * 0.5, t.radius * slim); c.setHSL(0.38, 0.32, 0.16 * t.shade); }} colored castShadow lod={2600} shadowLod={500} />
      <ChunkedInstances count={palms.length} positionOf={(i) => [palms[i].x, palms[i].z]} geometry={palmGeo} material={mats.foliage} setup={(i, o, c) => { const t = palms[i]; o.position.set(t.x, t.height * 0.85, t.z); o.scale.set(t.radius * 1.3, t.radius * 1.3, t.radius * 1.3); o.rotation.y = hash01(t.id) * 6; c.setHSL(0.26, 0.45, 0.28 * t.shade); }} colored castShadow lod={2600} shadowLod={500} />
    </group>
  );
}

function Streetlights() {
  const mats = getMaterials();
  const lights = world.streetlights;
  const pole = useMemo(() => new THREE.CylinderGeometry(0.09, 0.14, 8, 6).translate(0, 4, 0), []);
  const arm = useMemo(() => new THREE.BoxGeometry(2.2, 0.1, 0.1).translate(1.0, 0, 0), []);
  const head = useMemo(() => new THREE.BoxGeometry(0.8, 0.14, 0.34).translate(2.0, 0, 0), []);
  const lampMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#dedcd2', emissive: '#fff1c8', emissiveIntensity: 0.15, roughness: 0.4 }), []);
  const pos = useCallback((i: number): [number, number] => [lights[i].x, lights[i].z], [lights]);
  const setPole = useCallback((i: number, o: THREE.Object3D) => { o.position.set(lights[i].x, 0.22, lights[i].z); }, [lights]);
  const setArm = useCallback((i: number, o: THREE.Object3D) => { o.position.set(lights[i].x, 7.9, lights[i].z); o.rotation.y = lights[i].rot; }, [lights]);
  return (
    <group>
      <ChunkedInstances count={lights.length} positionOf={pos} geometry={pole} material={mats.metalDark} setup={setPole} castShadow lod={800} shadowLod={300} />
      <ChunkedInstances count={lights.length} positionOf={pos} geometry={arm} material={mats.metalDark} setup={setArm} lod={800} />
      <ChunkedInstances count={lights.length} positionOf={pos} geometry={head} material={lampMat} setup={setArm} lod={800} />
    </group>
  );
}

interface PropStyle {
  geo: THREE.BufferGeometry;
  mat: THREE.Material;
  place: (p: PropData, o: THREE.Object3D, c: THREE.Color) => void;
  lod?: number;
  colored?: boolean;
  castShadow?: boolean;
  /** Extra sub-parts of the same prop (posts, water, …). */
  parts?: number;
}

function Props() {
  const mats = getMaterials();
  const props = world.props;
  const styles = useMemo((): Record<string, PropStyle[]> => {
    const wood = new THREE.MeshStandardMaterial({ color: '#7a5a3c', roughness: 0.9 });
    const dark = mats.metalDark;
    const glass = new THREE.MeshStandardMaterial({ color: '#9fb6c3', roughness: 0.2, metalness: 0.4, transparent: true, opacity: 0.6 });
    const white = new THREE.MeshStandardMaterial({ color: '#f0efe9', roughness: 0.6 });
    const red = new THREE.MeshStandardMaterial({ color: '#d8343a', roughness: 0.6 });
    const water = new THREE.MeshStandardMaterial({ color: '#5a93a8', roughness: 0.15, metalness: 0.1 });
    const hedge = new THREE.MeshStandardMaterial({ color: '#4d6b3a', roughness: 1 });
    const playMat = new THREE.MeshStandardMaterial({ color: '#d9a13a', roughness: 0.7 });
    const solarMat = new THREE.MeshStandardMaterial({ color: '#1d2b3a', roughness: 0.25, metalness: 0.6 });
    const lineMat = mats.paint;
    const flat = (p: PropData, o: THREE.Object3D, y: number, sy = 0.06) => {
      o.position.set(p.x, y, p.z);
      o.rotation.y = p.rot;
      o.scale.set(p.sx, sy, p.sz);
    };
    return {
      bench: [{ geo: unitBox, mat: wood, place: (p, o) => flat(p, o, 0.32, 0.45), lod: 500 }],
      bin: [{ geo: unitCyl, mat: dark, place: (p, o) => { o.position.set(p.x, 0.32, p.z); o.scale.set(0.6, 1, 0.6); }, lod: 400 }],
      busstop: [
        { geo: unitBox, mat: dark, place: (p, o) => { o.position.set(p.x, 2.6, p.z); o.rotation.y = p.rot; o.scale.set(p.sx, 0.12, p.sz + 0.4); }, lod: 700, castShadow: true },
        { geo: unitBox, mat: glass, place: (p, o) => { o.position.set(p.x - Math.sin(p.rot) * 0, 0.32, p.z); o.rotation.y = p.rot; o.scale.set(p.sx, 2.3, 0.08); o.translateZ(-p.sz / 2); }, lod: 700 },
      ],
      billboard: [
        { geo: centredBox, mat: white, place: (p, o, c) => { o.position.set(p.x, 7.5, p.z); o.rotation.y = p.rot; o.scale.set(p.sx, 4, 0.3); c.setHSL(hash01(`${p.x},${p.z}`), 0.5, 0.55); }, lod: 1500, colored: true, castShadow: true },
        { geo: unitCyl, mat: dark, place: (p, o) => { o.position.set(p.x, 0.3, p.z); o.scale.set(0.5, 5.6, 0.5); }, lod: 1500 },
      ],
      fountain: [
        { geo: unitCyl, mat: mats.concrete, place: (p, o) => { o.position.set(p.x, 0.32, p.z); o.scale.set(p.sx, 0.7, p.sz); }, lod: 1500 },
        { geo: unitCyl, mat: water, place: (p, o) => { o.position.set(p.x, 0.32, p.z); o.scale.set(p.sx * 0.9, 0.62, p.sz * 0.9); }, lod: 1500 },
        { geo: unitCyl, mat: mats.concrete, place: (p, o) => { o.position.set(p.x, 0.32, p.z); o.scale.set(p.sx * 0.2, 3, p.sz * 0.2); }, lod: 1500, castShadow: true },
      ],
      playground: [
        { geo: unitBox, mat: mats.sand, place: (p, o) => flat(p, o, 0.3, 0.12), lod: 1000 },
        { geo: unitBox, mat: playMat, place: (p, o) => { o.position.set(p.x - p.sx / 4, 0.4, p.z); o.scale.set(2.2, 2.6, 2.2); }, lod: 700, castShadow: true },
        { geo: unitBox, mat: red, place: (p, o) => { o.position.set(p.x + p.sx / 4, 0.4, p.z + p.sz / 5); o.rotation.y = p.rot; o.scale.set(3.2, 0.3, 0.5); o.translateY(1.2); }, lod: 700 },
      ],
      pool: [{ geo: unitBox, mat: water, place: (p, o) => flat(p, o, 0.22, 0.14), lod: undefined }],
      pitch: [
        { geo: flatPlane, mat: mats.turf, place: (p, o) => { o.position.set(p.x, 0.34, p.z); o.rotation.y = p.rot; o.scale.set(p.sx, 1, p.sz); } },
        { geo: unitBox, mat: lineMat, place: (p, o) => { o.position.set(p.x, 0.35, p.z); o.rotation.y = p.rot; o.scale.set(p.sx * 0.9, 0.02, 0.25); }, lod: 1200 },
        { geo: unitBox, mat: lineMat, place: (p, o) => { o.position.set(p.x, 0.35, p.z); o.rotation.y = p.rot; o.scale.set(0.25, 0.02, p.sz * 0.9); }, lod: 1200 },
      ],
      court: [
        { geo: flatPlane, mat: new THREE.MeshStandardMaterial({ color: '#5a7f8f', roughness: 0.9 }), place: (p, o) => { o.position.set(p.x, 0.34, p.z); o.rotation.y = p.rot; o.scale.set(p.sx, 1, p.sz); } },
        { geo: unitBox, mat: lineMat, place: (p, o) => { o.position.set(p.x, 0.35, p.z); o.rotation.y = p.rot; o.scale.set(p.sx * 0.92, 0.02, 0.2); }, lod: 900 },
      ],
      solarfarm: [{ geo: centredBox, mat: solarMat, place: (p, o) => { o.position.set(p.x, 1.3, p.z); o.rotation.x = -0.35; o.scale.set(p.sx, 0.08, p.sz); }, lod: 2500, castShadow: true }],
      runway: [
        { geo: flatPlane, mat: new THREE.MeshStandardMaterial({ color: '#4a4c4f', roughness: 0.95 }), place: (p, o) => { o.position.set(p.x, 0.36, p.z); o.scale.set(p.sx, 1, p.sz); } },
        { geo: unitBox, mat: lineMat, place: (p, o) => { o.position.set(p.x, 0.37, p.z); o.scale.set(p.sx * 0.9, 0.02, 1.2); }, lod: 3000 },
      ],
      taxiway: [{ geo: flatPlane, mat: new THREE.MeshStandardMaterial({ color: '#5c5e61', roughness: 0.95 }), place: (p, o) => { o.position.set(p.x, 0.355, p.z); o.scale.set(p.sx, 1, p.sz); } }],
      helipad: [
        { geo: unitCyl, mat: white, place: (p, o) => { const y = Number(p.color) || 0.3; o.position.set(p.x, y, p.z); o.scale.set(p.sx, 0.15, p.sz); }, lod: 2500 },
        { geo: unitCyl, mat: red, place: (p, o) => { const y = Number(p.color) || 0.3; o.position.set(p.x, y + 0.15, p.z); o.scale.set(p.sx * 0.75, 0.05, p.sz * 0.75); }, lod: 2500 },
      ],
      boat: [
        { geo: unitBox, mat: white, place: (p, o, c) => { o.position.set(p.x, -0.5, p.z); o.rotation.y = p.rot; o.scale.set(p.sx, 1.6, p.sz); c.set(p.color ?? '#ffffff'); }, lod: 3000, colored: true, castShadow: true },
        { geo: unitBox, mat: white, place: (p, o) => { o.position.set(p.x, 1.1, p.z); o.rotation.y = p.rot; o.scale.set(p.sx * 0.35, p.sz * 0.35 + 0.8, p.sz * 0.7); o.translateX(-p.sx * 0.2); }, lod: 3000, castShadow: true },
      ],
      fence: [{ geo: unitBox, mat: dark, place: (p, o) => flat(p, o, 0.3, 1.6), lod: 500 }],
      hedge: [{ geo: unitBox, mat: hedge, place: (p, o) => flat(p, o, 0.3, 1.1), lod: 600 }],
      planter: [{ geo: unitBox, mat: hedge, place: (p, o) => flat(p, o, 0.3, 0.8), lod: 500 }],
      platform: [{ geo: unitBox, mat: mats.paving, place: (p, o, c) => { flat(p, o, 0.3, 0.12); c.set(p.color ?? '#b0afa9'); }, lod: 2500, colored: true }],
      canopy: [
        { geo: unitBox, mat: white, place: (p, o, c) => { if (p.color === 'apron') { o.scale.set(0, 0, 0); return; } o.position.set(p.x, 4.6, p.z); o.rotation.y = p.rot; o.scale.set(p.sx, 0.3, p.sz); c.set(p.color ?? '#f0efe9'); }, lod: 1200, colored: true, castShadow: true },
        { geo: unitCyl, mat: dark, place: (p, o) => { if (p.color === 'apron') { o.scale.set(0, 0, 0); return; } o.position.set(p.x - p.sx / 2 + 1, 0.3, p.z); o.scale.set(0.4, 4.4, 0.4); }, lod: 1200 },
        { geo: unitCyl, mat: dark, place: (p, o) => { if (p.color === 'apron') { o.scale.set(0, 0, 0); return; } o.position.set(p.x + p.sx / 2 - 1, 0.3, p.z); o.scale.set(0.4, 4.4, 0.4); }, lod: 1200 },
      ],
      pumps: [
        { geo: unitBox, mat: white, place: (p, o) => { o.position.set(p.x - 3, 0.32, p.z); o.scale.set(1.2, 1.8, 0.8); }, lod: 600 },
        { geo: unitBox, mat: white, place: (p, o) => { o.position.set(p.x + 3, 0.32, p.z); o.scale.set(1.2, 1.8, 0.8); }, lod: 600 },
      ],
      grave: [{ geo: unitBox, mat: mats.concrete, place: (p, o) => flat(p, o, 0.3, 0.9), lod: 400 }],
    };
  }, [mats]);

  const byType = useMemo(() => {
    const m = new Map<string, PropData[]>();
    for (const p of props) (m.get(p.type) ?? m.set(p.type, []).get(p.type)!).push(p);
    return m;
  }, [props]);

  return (
    <group>
      {[...byType.entries()].map(([type, list]) => {
        const st = styles[type];
        if (!st) return null;
        return st.map((s, k) => (
          <ChunkedInstances key={`${type}-${k}`} count={list.length} positionOf={(i) => [list[i].x, list[i].z]} geometry={s.geo} material={s.mat} setup={(i, o, c) => s.place(list[i], o, c)} colored={s.colored} castShadow={s.castShadow} lod={s.lod} shadowLod={400} />
        ));
      })}
    </group>
  );
}

// -------------------------------------------------------------------------------------------------
// Ground traffic (purely environmental — vehicles are not obstacles for drones)
// -------------------------------------------------------------------------------------------------

const carBodyGeo = new THREE.BoxGeometry(4.3, 0.8, 1.85).translate(0, 0.55, 0);
const carCabinGeo = new THREE.BoxGeometry(2.4, 0.7, 1.65).translate(-0.2, 1.3, 0);
const truckCargoGeo = new THREE.BoxGeometry(8.6, 2.8, 2.5).translate(-0.8, 2.0, 0);
const truckCabGeo = new THREE.BoxGeometry(2.2, 2.2, 2.4).translate(3.9, 1.6, 0);
const busGeo = new THREE.BoxGeometry(11, 3, 2.5).translate(0, 1.8, 0);

const tmp = new THREE.Object3D();
const zero = new THREE.Matrix4().makeScale(0, 0, 0);

function poseVehicle(v: VehicleRoute, T: number, o: THREE.Object3D) {
  const len = v.b - v.a;
  const s = (v.phase + v.speed * T) % len;
  const coord = v.a + (v.lane > 0 ? s : len - s);
  if (v.dir === 'EW') {
    o.position.set(coord, 0.04, v.c + v.laneOffset);
    o.rotation.y = v.lane > 0 ? 0 : Math.PI;
  } else {
    o.position.set(v.c + v.laneOffset, 0.04, coord);
    o.rotation.y = v.lane > 0 ? -Math.PI / 2 : Math.PI / 2;
  }
}

function Traffic() {
  const mats = getMaterials();
  const cars = useMemo(() => world.vehicles.filter((v) => v.type === 'car' || v.type === 'van'), []);
  const trucks = useMemo(() => world.vehicles.filter((v) => v.type === 'truck'), []);
  const buses = useMemo(() => world.vehicles.filter((v) => v.type === 'bus'), []);
  const refs = useRef<Record<string, THREE.InstancedMesh | null>>({});
  const near = useRef({ cars: new Uint8Array(cars.length), trucks: new Uint8Array(trucks.length), buses: new Uint8Array(buses.length) });
  const clock = useRef(0);
  const lastGate = useRef(-10);
  const controls = useThree((s) => s.controls) as unknown as { target: THREE.Vector3 } | null;
  const camera = useThree((s) => s.camera);
  const col = useMemo(() => new THREE.Color(), []);

  useFrame((s, dt) => {
    const st = engine.status;
    clock.current += dt * (st === 'paused' ? 0 : st === 'running' ? engine.speed : 1);
    const T = clock.current;
    const t = controls?.target ?? camera.position;
    const gate = Math.max(1200, Math.min(4000, camera.position.distanceTo(t) * 1.2));
    const regate = s.clock.elapsedTime - lastGate.current > 1;
    if (regate) lastGate.current = s.clock.elapsedTime;
    const update = (list: VehicleRoute[], flags: Uint8Array, meshes: (THREE.InstancedMesh | null)[], cabinScale?: (v: VehicleRoute) => [number, number, number] | null) => {
      if (meshes.some((m) => !m)) return;
      list.forEach((v, i) => {
        poseVehicle(v, T, tmp);
        if (regate) flags[i] = Math.hypot(tmp.position.x - t.x, tmp.position.z - t.z) < gate ? 1 : 0;
        if (!flags[i]) {
          if (regate) meshes.forEach((m) => m!.setMatrixAt(i, zero));
          return;
        }
        tmp.scale.set(1, 1, 1);
        tmp.updateMatrix();
        meshes[0]!.setMatrixAt(i, tmp.matrix);
        if (meshes[1]) {
          const cs = cabinScale ? cabinScale(v) : [1, 1, 1];
          if (cs) tmp.scale.set(cs[0], cs[1], cs[2]);
          else tmp.scale.set(0, 0, 0);
          tmp.updateMatrix();
          meshes[1]!.setMatrixAt(i, tmp.matrix);
        }
      });
      meshes.forEach((m) => (m!.instanceMatrix.needsUpdate = true));
    };
    update(cars, near.current.cars, [refs.current.carBody ?? null, refs.current.carCabin ?? null], (v) => (v.type === 'van' ? null : [1, 1, 1]));
    update(trucks, near.current.trucks, [refs.current.truckCargo ?? null, refs.current.truckCab ?? null]);
    update(buses, near.current.buses, [refs.current.bus ?? null]);
  });

  const colorSetup = (list: VehicleRoute[]) => (i: number, _o: THREE.Object3D, c: THREE.Color) => {
    c.set(list[i].color);
  };
  const vanSetup = (i: number, o: THREE.Object3D, c: THREE.Color) => {
    const v = cars[i];
    c.set(v.color);
    if (v.type === 'van') o.scale.set(1.2, 1.9, 1.1);
  };
  void col;
  const reg = (k: string) => (el: THREE.InstancedMesh | null) => {
    refs.current[k] = el;
  };
  return (
    <group>
      <instancedMesh ref={reg('carBody')} args={[carBodyGeo, mats.carBody, Math.max(1, cars.length)]} count={cars.length} castShadow frustumCulled={false} onUpdate={(m) => { cars.forEach((_, i) => { vanSetup(i, tmp, col); m.setColorAt(i, col); }); if (m.instanceColor) m.instanceColor.needsUpdate = true; }} />
      <instancedMesh ref={reg('carCabin')} args={[carCabinGeo, mats.carGlass, Math.max(1, cars.length)]} count={cars.length} castShadow frustumCulled={false} />
      <instancedMesh ref={reg('truckCargo')} args={[truckCargoGeo, mats.carBody, Math.max(1, trucks.length)]} count={trucks.length} castShadow frustumCulled={false} onUpdate={(m) => { trucks.forEach((_, i) => { colorSetup(trucks)(i, tmp, col); m.setColorAt(i, col); }); if (m.instanceColor) m.instanceColor.needsUpdate = true; }} />
      <instancedMesh ref={reg('truckCab')} args={[truckCabGeo, mats.carBody, Math.max(1, trucks.length)]} count={trucks.length} castShadow frustumCulled={false} onUpdate={(m) => { trucks.forEach((_, i) => { col.set('#cfd3d6'); m.setColorAt(i, col); }); if (m.instanceColor) m.instanceColor.needsUpdate = true; }} />
      <instancedMesh ref={reg('bus')} args={[busGeo, mats.carBody, Math.max(1, buses.length)]} count={buses.length} castShadow frustumCulled={false} onUpdate={(m) => { buses.forEach((_, i) => { col.set('#d9b43a'); m.setColorAt(i, col); }); if (m.instanceColor) m.instanceColor.needsUpdate = true; }} />
    </group>
  );
}

export function CityScene() {
  return (
    <group>
      <Roads />
      <Blocks />
      <Buildings />
      <Vegetation />
      <Streetlights />
      <Props />
      <Traffic />
    </group>
  );
}
