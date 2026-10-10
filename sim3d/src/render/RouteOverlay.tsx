import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { engine } from '../app/simContext';
import { useUI } from '../app/uiStore';
import type { DroneAgent } from '../sim/DroneAgent';
import type { RouteTrace } from '../sim/SimulationEngine';

/** Route-state colours. Drone colour = planned/active; grey-green = completed; orange = avoidance. */
const COMPLETED = '#7d9a86';
const AVOID = '#ea580c';
const PICKUP = '#e0b324';
const DELIVERY = '#2f8f5b';
const RETURN = '#64748b';

interface Trace {
  planned: Line2;
  active: Line2;
  beam: THREE.Mesh;
  disc: THREE.Mesh;
  version: number;
  start: THREE.Vector3;
}

function makeLine(color: string, width: number, opts: { dashed?: boolean; opacity?: number } = {}): Line2 {
  const mat = new LineMaterial({ color: new THREE.Color(color).getHex(), linewidth: width, transparent: true, opacity: opts.opacity ?? 1, dashed: !!opts.dashed, dashSize: 3.5, gapSize: 2.5, depthWrite: false });
  const line = new Line2(new LineGeometry(), mat);
  line.frustumCulled = false;
  line.visible = false;
  line.renderOrder = 3;
  return line;
}

function setPts(line: Line2, pts: number[], dashed = false) {
  if (pts.length < 6) {
    line.visible = false;
    return;
  }
  line.geometry.setPositions(pts);
  if (dashed) line.computeLineDistances();
  line.visible = true;
}

const beamGeo = new THREE.CylinderGeometry(2.2, 2.2, 1, 20, 1, true).translate(0, 0.5, 0);
const discGeo = new THREE.RingGeometry(2.6, 3.4, 32).rotateX(-Math.PI / 2);
const markerGeo = new THREE.OctahedronGeometry(1.0, 0);

export function RouteOverlay() {
  const group = useRef<THREE.Group>(null);
  const completed = useRef<THREE.Group>(null);
  const avoid = useRef<THREE.Group>(null);
  const markers = useRef<THREE.InstancedMesh>(null);
  const traces = useRef(new Map<string, Trace>());
  const seen = useRef({ completed: -1, avoid: -1, epoch: -1 });
  const frame = useRef(0);
  const { size } = useThree();
  const col = useMemo(() => new THREE.Color(), []);
  const mtx = useMemo(() => new THREE.Matrix4(), []);
  const markerMat = useMemo(() => new THREE.MeshBasicMaterial({ color: '#ffffff' }), []);

  useEffect(() => {
    const t = traces.current;
    return () => {
      for (const tr of t.values()) {
        tr.planned.geometry.dispose();
        tr.active.geometry.dispose();
      }
      t.clear();
    };
  }, []);

  const rebuildTraceGroup = (g: THREE.Group, list: RouteTrace[], color: string | null, width: number, opacity: number) => {
    for (const ch of [...g.children]) {
      g.remove(ch);
      const l = ch as Line2;
      l.geometry.dispose();
      (l.material as LineMaterial).dispose();
    }
    for (const t of list) {
      const line = makeLine(color ?? t.color, width, { opacity });
      setPts(line, t.points);
      g.add(line);
    }
  };

  useFrame(() => {
    const ui = useUI.getState();
    const g = group.current;
    if (!g || !completed.current || !avoid.current || !markers.current) return;
    frame.current++;
    const visible = ui.showRoutes;
    g.visible = visible;
    completed.current.visible = visible;
    avoid.current.visible = visible;
    markers.current.visible = ui.showWaypoints;

    if (seen.current.completed !== engine.completedVersion || seen.current.epoch !== engine.resetEpoch) {
      seen.current.completed = engine.completedVersion;
      rebuildTraceGroup(completed.current, engine.completedRoutes, COMPLETED, 1.6, 0.6);
    }
    if (seen.current.avoid !== engine.avoidVersion || seen.current.epoch !== engine.resetEpoch) {
      seen.current.avoid = engine.avoidVersion;
      rebuildTraceGroup(avoid.current, engine.avoidSegments, AVOID, 3.2, 0.95);
    }
    seen.current.epoch = engine.resetEpoch;

    // sync per-drone traces with fleet
    const live = new Set(engine.agents.map((a) => a.id));
    for (const [id, tr] of traces.current) {
      if (!live.has(id)) {
        g.remove(tr.planned, tr.active, tr.beam, tr.disc);
        tr.planned.geometry.dispose();
        tr.active.geometry.dispose();
        traces.current.delete(id);
      }
    }
    for (const a of engine.agents) {
      let tr = traces.current.get(a.id);
      if (!tr) {
        const beam = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({ color: a.color, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide }));
        const disc = new THREE.Mesh(discGeo, new THREE.MeshBasicMaterial({ color: a.color, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide }));
        beam.visible = disc.visible = false;
        tr = { planned: makeLine(a.color, 1.6, { dashed: true, opacity: 0.5 }), active: makeLine(a.color, 3, { opacity: 0.95 }), beam, disc, version: -1, start: new THREE.Vector3() };
        g.add(tr.planned, tr.active, beam, disc);
        traces.current.set(a.id, tr);
      }
      updateTrace(a, tr, frame.current);
      (tr.planned.material as LineMaterial).resolution.set(size.width, size.height);
      (tr.active.material as LineMaterial).resolution.set(size.width, size.height);
    }
    for (const l of completed.current.children) (l as Line2).material && ((l as Line2).material as LineMaterial).resolution.set(size.width, size.height);
    for (const l of avoid.current.children) ((l as Line2).material as LineMaterial).resolution.set(size.width, size.height);

    // waypoint markers (remaining waypoints of every drone, drone-coloured)
    if (ui.showWaypoints && frame.current % 4 === 0) {
      const m = markers.current;
      let n = 0;
      for (const a of engine.agents) {
        const c = a.controller;
        for (let i = c.routeIndex; i < c.route.length && n < 600; i++) {
          const w = c.route[i];
          const dest = w.kind === 'land';
          mtx.makeScale(dest ? 1.7 : 0.9, dest ? 1.7 : 0.9, dest ? 1.7 : 0.9);
          mtx.setPosition(w.pos.x, w.pos.y, w.pos.z);
          m.setMatrixAt(n, mtx);
          col.set(a.color);
          m.setColorAt(n, col);
          n++;
        }
      }
      m.count = n;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  });

  const updateTrace = (a: DroneAgent, tr: Trace, f: number) => {
    const c = a.controller;
    const route = c.route;
    const hasRoute = route.length > 0 && (c.phase === 'to_pickup' || c.phase === 'to_delivery' || c.phase === 'returning' || c.phase === 'loading' || c.phase === 'unloading');
    if (tr.version !== c.routeVersion) {
      tr.version = c.routeVersion;
      tr.start.set(a.body.pos.x, a.body.pos.y, a.body.pos.z);
      if (route.length) {
        const pts = [tr.start.x, tr.start.y, tr.start.z];
        for (const w of route) pts.push(w.pos.x, w.pos.y, w.pos.z);
        setPts(tr.planned, pts, true);
      } else tr.planned.visible = false;
    }
    if (!hasRoute) {
      tr.planned.visible = false;
      tr.active.visible = false;
    } else {
      tr.planned.visible = true;
      if (f % 3 === 0) {
        const pts = [a.body.pos.x, a.body.pos.y, a.body.pos.z];
        for (let i = Math.min(c.routeIndex, route.length - 1); i < route.length; i++) pts.push(route[i].pos.x, route[i].pos.y, route[i].pos.z);
        setPts(tr.active, pts);
      }
    }
    // destination indicator
    const dest = c.destination;
    const showDest = !!dest && (c.phase === 'to_pickup' || c.phase === 'to_delivery' || c.phase === 'returning');
    tr.beam.visible = tr.disc.visible = showDest;
    if (showDest && dest) {
      tr.beam.position.set(dest.x, dest.y, dest.z);
      tr.beam.scale.set(1, 26, 1);
      tr.disc.position.set(dest.x, dest.y + 0.35, dest.z);
      const tone = c.phase === 'to_pickup' ? PICKUP : c.phase === 'to_delivery' ? DELIVERY : RETURN;
      (tr.disc.material as THREE.MeshBasicMaterial).color.set(tone);
    }
  };

  return (
    <group>
      <group ref={group} />
      <group ref={completed} />
      <group ref={avoid} />
      <instancedMesh ref={markers} args={[markerGeo, markerMat, 600]} count={0} frustumCulled={false} renderOrder={4} />
    </group>
  );
}
