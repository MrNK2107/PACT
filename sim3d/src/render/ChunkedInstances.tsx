import { useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { world } from '../app/simContext';

/** Chunk sizes are specified for a 4 km map and grow with the world so draw calls stay bounded. */
const CHUNK_SCALE = Math.min(3, Math.max(1, world.size / 4000));

export type ChunkSetup = (i: number, o: THREE.Object3D, c: THREE.Color) => boolean | void;

interface Props {
  count: number;
  /** World XZ of item i (used only to assign chunks). */
  positionOf: (i: number) => [number, number];
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  setup: ChunkSetup;
  colored?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
  visible?: boolean;
  /** Chunk edge length (m). */
  chunk?: number;
  /** Hide chunks whose centre is farther than this from the camera target (m). */
  lod?: number;
  /** Only chunks closer than this cast shadows (m). */
  shadowLod?: number;
  onPick?: (index: number) => void;
  renderOrder?: number;
  version?: number;
}

const dummy = new THREE.Object3D();
const color = new THREE.Color();

interface Chunk {
  cx: number;
  cz: number;
  ids: number[];
}

/**
 * Instanced rendering of a large static set, split into square chunks so that frustum culling and
 * distance-based level of detail work per chunk instead of per draw call. One InstancedMesh per chunk.
 */
export function ChunkedInstances({ count, positionOf, geometry, material, setup, colored, castShadow, receiveShadow, visible = true, chunk: chunkBase = 400, lod, shadowLod = 700, onPick, renderOrder, version }: Props) {
  const chunk = chunkBase * CHUNK_SCALE;
  const chunks = useMemo(() => {
    const map = new Map<string, Chunk>();
    for (let i = 0; i < count; i++) {
      const [x, z] = positionOf(i);
      const ci = Math.floor(x / chunk);
      const cj = Math.floor(z / chunk);
      const k = `${ci}:${cj}`;
      let c = map.get(k);
      if (!c) map.set(k, (c = { cx: (ci + 0.5) * chunk, cz: (cj + 0.5) * chunk, ids: [] }));
      c.ids.push(i);
    }
    return [...map.values()];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, chunk, version]);
  const meshes = useRef<(THREE.InstancedMesh | null)[]>([]);
  const controls = useThree((s) => s.controls) as unknown as { target: THREE.Vector3 } | null;
  const camera = useThree((s) => s.camera);
  const last = useRef(-1);

  useLayoutEffect(() => {
    chunks.forEach((c, k) => {
      const m = meshes.current[k];
      if (!m) return;
      c.ids.forEach((i, j) => {
        dummy.position.set(0, 0, 0);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(1, 1, 1);
        color.set('#ffffff');
        const keep = setup(i, dummy, color);
        if (keep === false) dummy.scale.set(0, 0, 0);
        dummy.updateMatrix();
        m.setMatrixAt(j, dummy.matrix);
        if (colored) m.setColorAt(j, color);
      });
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      m.computeBoundingSphere();
      m.computeBoundingBox();
    });
  }, [chunks, setup, colored]);

  useFrame((s) => {
    if (s.clock.elapsedTime - last.current < 0.25) return;
    last.current = s.clock.elapsedTime;
    const t = controls?.target ?? camera.position;
    const camDist = camera.position.distanceTo(t);
    chunks.forEach((c, k) => {
      const m = meshes.current[k];
      if (!m) return;
      const d = Math.hypot(c.cx - t.x, c.cz - t.z);
      // when zoomed far out everything is small anyway: fade detail with camera height too
      m.visible = visible && (lod === undefined || (d < lod && camDist < lod * 2.2));
      if (castShadow) m.castShadow = d < shadowLod;
    });
  });

  return (
    <group>
      {chunks.map((c, k) => (
        <instancedMesh
          key={`${c.cx}:${c.cz}:${c.ids.length}`}
          ref={(el) => {
            meshes.current[k] = el;
          }}
          args={[geometry, material, c.ids.length]}
          count={c.ids.length}
          castShadow={castShadow}
          receiveShadow={receiveShadow}
          visible={visible}
          renderOrder={renderOrder}
          frustumCulled
          onClick={
            onPick
              ? (e: ThreeEvent<MouseEvent>) => {
                  if (e.delta > 4 || e.instanceId === undefined) return;
                  e.stopPropagation();
                  onPick(c.ids[e.instanceId]);
                }
              : undefined
          }
        />
      ))}
    </group>
  );
}
