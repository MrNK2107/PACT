import { useLayoutEffect, useRef, type MutableRefObject } from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';

export type Setup = (i: number, o: THREE.Object3D, c: THREE.Color) => boolean | void;

interface Props {
  count: number;
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  setup: Setup;
  colored?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
  visible?: boolean;
  /** Called with the instance index when an instance is clicked. */
  onPick?: (index: number) => void;
  renderOrder?: number;
  /** Bump to re-run `setup` (for static instance sets that change). */
  version?: number;
  meshRef?: MutableRefObject<THREE.InstancedMesh | null>;
}

const dummy = new THREE.Object3D();
const color = new THREE.Color();

/**
 * Thin wrapper over <instancedMesh>: fills instance matrices/colours once from `setup` (static
 * scenery) and exposes the ref so animated sets can rewrite matrices in useFrame.
 */
export function Instances({ count, geometry, material, setup, colored, castShadow, receiveShadow, visible = true, onPick, renderOrder, version, meshRef }: Props) {
  const local = useRef<THREE.InstancedMesh | null>(null);
  const ref = meshRef ?? local;
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    for (let i = 0; i < count; i++) {
      dummy.position.set(0, 0, 0);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      color.set('#ffffff');
      const keep = setup(i, dummy, color);
      if (keep === false) dummy.scale.set(0, 0, 0);
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
      if (colored) m.setColorAt(i, color);
    }
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.computeBoundingSphere();
    m.computeBoundingBox();
  }, [count, setup, colored, version]);
  return (
    <instancedMesh
      ref={ref}
      args={[geometry, material, Math.max(count, 1)]}
      count={count}
      castShadow={castShadow}
      receiveShadow={receiveShadow}
      visible={visible}
      renderOrder={renderOrder}
      frustumCulled={false}
      onClick={
        onPick
          ? (e: ThreeEvent<MouseEvent>) => {
              if (e.delta > 4 || e.instanceId === undefined) return;
              e.stopPropagation();
              onPick(e.instanceId);
            }
          : undefined
      }
    />
  );
}
