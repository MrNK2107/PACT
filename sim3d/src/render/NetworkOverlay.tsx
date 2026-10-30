import { useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { ONE_WAY_LINK } from '../app/netGraph';
import { currentNetView } from '../app/netView';
import { engine, world } from '../app/simContext';
import { useUI } from '../app/uiStore';
import { P2P_DEFAULTS } from '../p2p/contracts';
import type { NetView } from '../app/netGraph';

/**
 * Network layer (REQ-VIZ-001). With "Comm ranges" on: live links between every network node (drones and depot
 * masts) and the depot masts themselves. With "Network partitions" on: the same links plus a halo per drone, both
 * coloured by radio component (two-way links; one-way links grey), and a ring per open task drop tinted by the
 * ledger owner (grey while unassigned). Topology comes from the memoised `currentNetView` (a few Hz); positions
 * follow the drones every frame.
 */

const LINK = '#0f766e';
const UNOWNED = '#94a3b8';
const MAX_LINKS = 1200;
const MAX_TASKS = 160;
const MAST_M = P2P_DEFAULTS.depotMastM;

export function NetworkOverlay() {
  const showComms = useUI((s) => s.showComms);
  const showP2P = useUI((s) => s.showP2P);
  if (!showComms && !showP2P) return null;
  return <NetworkLayer p2p={showP2P} />;
}

function NetworkLayer({ p2p }: { p2p: boolean }) {
  const camera = useThree((s) => s.camera);
  const mkGeo = () => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6 * MAX_LINKS), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(6 * MAX_LINKS), 3));
    g.setDrawRange(0, 0);
    return g;
  };
  const linkGeo = useMemo(mkGeo, []);
  // depot backhaul links (wired / cellular, not radio): drawn dashed
  const bhGeo = useMemo(mkGeo, []);
  const bhLine = useRef<THREE.LineSegments>(null);
  const haloRef = useRef<THREE.InstancedMesh>(null);
  const haloGeo = useMemo(() => new THREE.RingGeometry(5.2, 6.4, 40).rotateX(-Math.PI / 2), []);
  const haloMat = useMemo(() => new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }), []);
  const ownRef = useRef<THREE.InstancedMesh>(null);
  const ownGeo = useMemo(() => new THREE.RingGeometry(5.0, 6.0, 36).rotateX(-Math.PI / 2), []);
  const ownMat = useMemo(() => new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }), []);
  const mastMats = useRef(new Map<string, THREE.MeshBasicMaterial>());
  const tmp = useMemo(() => new THREE.Object3D(), []);
  const col = useMemo(() => new THREE.Color(), []);
  const last = useRef<{ view: NetView | null; ownAt: number }>({ view: null, ownAt: -Infinity });
  const dropById = useMemo(() => new Map(world.dropPoints.map((d) => [d.id, d])), []);

  useFrame((s) => {
    const view = currentNetView();
    const posOf = new Map<string, { x: number; y: number; z: number }>();
    for (const n of view.nodes) posOf.set(n.id, n.pos);
    // live drone positions (the view's node positions are references to the drone bodies, but a drone added since
    // the last refresh is simply not drawn until the next one)
    const arr = linkGeo.attributes.position.array as Float32Array;
    const carr = linkGeo.attributes.color.array as Float32Array;
    const barr = bhGeo.attributes.position.array as Float32Array;
    const bcarr = bhGeo.attributes.color.array as Float32Array;
    let n = 0;
    let nb = 0;
    for (const l of view.links) {
      const A = posOf.get(l.a);
      const B = posOf.get(l.b);
      if (!A || !B) continue;
      if (!p2p) col.set(LINK);
      else if (!l.both) col.set(ONE_WAY_LINK);
      else col.set(view.colorOf.get(view.comp.get(l.a)!) ?? LINK);
      if (l.backhaul) {
        if (nb >= MAX_LINKS) continue;
        barr.set([A.x, A.y, A.z, B.x, B.y, B.z], nb * 6);
        bcarr.set([col.r, col.g, col.b, col.r, col.g, col.b], nb * 6);
        nb++;
        continue;
      }
      if (n >= MAX_LINKS) continue;
      arr.set([A.x, A.y, A.z, B.x, B.y, B.z], n * 6);
      carr.set([col.r, col.g, col.b, col.r, col.g, col.b], n * 6);
      n++;
    }
    linkGeo.setDrawRange(0, n * 2);
    linkGeo.attributes.position.needsUpdate = true;
    linkGeo.attributes.color.needsUpdate = true;
    bhGeo.setDrawRange(0, nb * 2);
    bhGeo.attributes.position.needsUpdate = true;
    bhGeo.attributes.color.needsUpdate = true;
    if (nb && bhLine.current) bhLine.current.computeLineDistances();

    // depot masts: component colour (partition view) or the link colour
    for (const [id, m] of mastMats.current) {
      const c = p2p ? view.colorOf.get(view.comp.get(id) ?? '') : undefined;
      m.color.set(c ?? LINK);
    }

    const h = haloRef.current;
    if (h) {
      let k = 0;
      if (p2p) {
        for (const a of engine.agents) {
          if (k >= h.instanceMatrix.count) break;
          const root = view.comp.get(a.id);
          if (!root) continue;
          const p = a.body.pos;
          tmp.position.set(p.x, p.y + 0.4, p.z);
          tmp.scale.setScalar(THREE.MathUtils.clamp(camera.position.distanceTo(tmp.position) / 230, 1, 3));
          tmp.updateMatrix();
          h.setMatrixAt(k, tmp.matrix);
          col.set(view.colorOf.get(root)!);
          h.setColorAt(k, col);
          k++;
        }
      }
      h.count = k;
      h.instanceMatrix.needsUpdate = true;
      if (h.instanceColor) h.instanceColor.needsUpdate = true;
    }

    // ledger-owner tints on open task drops: refreshed with the topology, a few times a second
    const o = ownRef.current;
    if (o && (view !== last.current.view || s.clock.elapsedTime - last.current.ownAt > 0.5)) {
      last.current = { view, ownAt: s.clock.elapsedTime };
      let k = 0;
      if (p2p) {
        const colourOf = new Map(engine.agents.map((a) => [a.id, a.color]));
        const seen = new Set<string>();
        for (const t of engine.board.tasks) {
          if (k >= MAX_TASKS) break;
          if (t.state === 'DELIVERED' || t.state === 'ABORTED' || t.state === 'PICKED_UP') continue;
          // one ring per drop point: the first open task (owned beats unowned)
          const d = dropById.get(t.dropId);
          if (!d || (seen.has(d.id) && !t.owner)) continue;
          seen.add(d.id);
          tmp.position.set(d.pos.x, d.pos.y + 0.3, d.pos.z);
          tmp.scale.setScalar(1);
          tmp.updateMatrix();
          o.setMatrixAt(k, tmp.matrix);
          col.set(t.owner ? (colourOf.get(t.owner) ?? UNOWNED) : UNOWNED);
          o.setColorAt(k, col);
          k++;
        }
      }
      o.count = k;
      o.instanceMatrix.needsUpdate = true;
      if (o.instanceColor) o.instanceColor.needsUpdate = true;
    }
  });

  return (
    <group>
      <lineSegments geometry={linkGeo} frustumCulled={false}>
        <lineBasicMaterial vertexColors transparent opacity={0.75} depthWrite={false} />
      </lineSegments>
      <lineSegments ref={bhLine} geometry={bhGeo} frustumCulled={false}>
        <lineDashedMaterial vertexColors transparent opacity={0.85} depthWrite={false} dashSize={40} gapSize={25} />
      </lineSegments>
      {world.depots.map((d) => (
        <group key={d.id} position={[d.pos.x, d.pos.y, d.pos.z]}>
          <mesh position={[0, MAST_M / 2, 0]}>
            <cylinderGeometry args={[0.35, 0.6, MAST_M, 8]} />
            <meshStandardMaterial color="#9aa3ab" roughness={0.6} metalness={0.4} />
          </mesh>
          <mesh position={[0, MAST_M, 0]}>
            <sphereGeometry args={[2.2, 16, 12]} />
            <meshBasicMaterial
              ref={(m: THREE.MeshBasicMaterial | null) => {
                if (m) mastMats.current.set(d.id, m);
                else mastMats.current.delete(d.id);
              }}
              color={LINK}
            />
          </mesh>
        </group>
      ))}
      <instancedMesh ref={haloRef} args={[haloGeo, haloMat, 256]} count={0} frustumCulled={false} renderOrder={6} />
      <instancedMesh ref={ownRef} args={[ownGeo, ownMat, MAX_TASKS]} count={0} frustumCulled={false} renderOrder={4} />
    </group>
  );
}
