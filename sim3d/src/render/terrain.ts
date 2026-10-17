import * as THREE from 'three';
import { world } from '../app/simContext';
import { heightAt } from '../world/Terrain';

/**
 * Terrain draping. Scenery that the generators place on a flat datum (roads, lots, trees, props, yards)
 * is lifted onto the ground in the vertex shader by sampling the height field as a texture, so the
 * same instanced geometry works on flat and hilly maps. Two modes:
 *   - 'vertex': every vertex follows the ground (ribbons and slabs that must hug a slope);
 *   - 'rigid' : the whole instance is raised by the ground height at its origin (trees, props, vehicles).
 * Objects whose data already carries an absolute height (buildings, pads, drop points) are NOT draped.
 * On a flat map `drapeMaterial` returns the material unchanged, so nothing changes.
 */

export type DrapeMode = 'vertex' | 'rigid';

export const terrain = world.terrain;
/** Highest ground (0 on a flat map). Flat overlays that must stay visible float above it. */
export const GROUND_TOP = terrain.flat ? 0 : Math.ceil(terrain.maxY);
export const hasTerrain = !terrain.flat;

/** Ground height at (x, z), for CPU-side placement. */
export const groundAt = (x: number, z: number): number => heightAt(terrain, x, z);

interface Uniforms {
  tex: { value: THREE.DataTexture };
  area: { value: THREE.Vector4 };
  dim: { value: THREE.Vector2 };
}

let shared: Uniforms | null = null;
function uniforms(): Uniforms {
  if (shared) return shared;
  const { nx, nz, h, originX, originZ, cell } = terrain;
  const data = new Uint16Array(nx * nz);
  for (let i = 0; i < data.length; i++) data[i] = THREE.DataUtils.toHalfFloat(h[i]);
  const tex = new THREE.DataTexture(data, nx, nz, THREE.RedFormat, THREE.HalfFloatType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  shared = { tex: { value: tex }, area: { value: new THREE.Vector4(originX, originZ, 1 / cell, 1 / cell) }, dim: { value: new THREE.Vector2(nx, nz) } };
  return shared;
}

const COMMON = `
uniform sampler2D uTerrainTex;
uniform vec4 uTerrainArea;
uniform vec2 uTerrainDim;
uniform float uTerrainLift;
float terrainH(vec2 xz) {
  vec2 g = (xz - uTerrainArea.xy) * uTerrainArea.zw;
  vec2 uv = (clamp(g, vec2(0.0), uTerrainDim - 1.001) + 0.5) / uTerrainDim;
  return texture2D(uTerrainTex, uv).r;
}`;

function projectVertex(mode: DrapeMode): string {
  const origin =
    mode === 'rigid'
      ? `
  vec4 tOrigin = vec4(0.0, 0.0, 0.0, 1.0);
  #ifdef USE_INSTANCING
    tOrigin = instanceMatrix * tOrigin;
  #endif
  tOrigin = modelMatrix * tOrigin;
  tWorld.y += terrainH(tOrigin.xz) + uTerrainLift;`
      : `
  tWorld.y += terrainH(tWorld.xz) + uTerrainLift;`;
  return `
vec4 mvPosition = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
#endif
vec4 tWorld = modelMatrix * mvPosition;${origin}
mvPosition = viewMatrix * tWorld;
gl_Position = projectionMatrix * mvPosition;`;
}

type Shader = { uniforms: Record<string, { value: unknown }>; vertexShader: string };

function inject(shader: Shader, mode: DrapeMode, lift: number): void {
  const u = uniforms();
  shader.uniforms.uTerrainTex = u.tex;
  shader.uniforms.uTerrainArea = u.area;
  shader.uniforms.uTerrainDim = u.dim;
  shader.uniforms.uTerrainLift = { value: lift };
  shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>${COMMON}`).replace('#include <project_vertex>', projectVertex(mode));
}

const cache = new WeakMap<THREE.Material, Map<string, THREE.Material>>();

/** A draped copy of a material (cached per mode and lift). Returns the material itself on a flat map. */
export function drapeMaterial<T extends THREE.Material>(source: T, mode: DrapeMode, lift = 0): T {
  if (!hasTerrain) return source;
  let byKey = cache.get(source);
  if (!byKey) cache.set(source, (byKey = new Map()));
  const key = `${mode}:${lift}`;
  const hit = byKey.get(key);
  if (hit) return hit as T;
  const m = source.clone() as T;
  const original = source.onBeforeCompile;
  const originalKey = source.customProgramCacheKey.bind(source);
  m.onBeforeCompile = (shader, renderer) => {
    original.call(m, shader, renderer);
    inject(shader as unknown as Shader, mode, lift);
  };
  m.customProgramCacheKey = () => `${originalKey()}|drape-${mode}`;
  byKey.set(key, m);
  return m;
}

const depthCache = new Map<string, THREE.MeshDepthMaterial>();

/** Shadow-pass material that drapes exactly like `drapeMaterial`, so shadows land on the ground. */
export function drapeDepth(mode: DrapeMode, lift = 0): THREE.MeshDepthMaterial | undefined {
  if (!hasTerrain) return undefined;
  const key = `${mode}:${lift}`;
  let m = depthCache.get(key);
  if (!m) {
    m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    m.onBeforeCompile = (shader) => inject(shader as unknown as Shader, mode, lift);
    m.customProgramCacheKey = () => `depth-drape-${mode}`;
    depthCache.set(key, m);
  }
  return m;
}

/**
 * The ground as a mesh: one vertex per height-field sample (a coarser step on very large maps), with
 * normals from the field so hills are lit. Drawn in tiles so frustum culling works.
 */
export function buildGroundTiles(tilesPerSide = 4): THREE.BufferGeometry[] {
  const { nx, nz, h, originX, originZ, cell } = terrain;
  const step = nx > 450 ? 2 : 1; // 12 km maps: every other sample
  const cols = Math.floor((nx - 1) / step);
  const rows = Math.floor((nz - 1) / step);
  const out: THREE.BufferGeometry[] = [];
  const tc = Math.ceil(cols / tilesPerSide);
  const tr = Math.ceil(rows / tilesPerSide);
  for (let ty = 0; ty < tilesPerSide; ty++) {
    for (let tx = 0; tx < tilesPerSide; tx++) {
      const c0 = tx * tc;
      const r0 = ty * tr;
      const c1 = Math.min(cols, c0 + tc);
      const r1 = Math.min(rows, r0 + tr);
      if (c1 <= c0 || r1 <= r0) continue;
      const w = c1 - c0 + 1;
      const hh = r1 - r0 + 1;
      const pos = new Float32Array(w * hh * 3);
      const nor = new Float32Array(w * hh * 3);
      const at = (i: number, j: number) => h[Math.max(0, Math.min(nz - 1, j * step)) * nx + Math.max(0, Math.min(nx - 1, i * step))];
      for (let j = 0; j < hh; j++) {
        for (let i = 0; i < w; i++) {
          const gi = c0 + i;
          const gj = r0 + j;
          const k = (j * w + i) * 3;
          pos[k] = originX + gi * step * cell;
          pos[k + 1] = at(gi, gj);
          pos[k + 2] = originZ + gj * step * cell;
          const dx = at(gi + 1, gj) - at(gi - 1, gj);
          const dz = at(gi, gj + 1) - at(gi, gj - 1);
          const sx = 2 * step * cell;
          const nxv = -dx / sx;
          const nzv = -dz / sx;
          const l = Math.hypot(nxv, 1, nzv);
          nor[k] = nxv / l;
          nor[k + 1] = 1 / l;
          nor[k + 2] = nzv / l;
        }
      }
      const idx = new Uint32Array((w - 1) * (hh - 1) * 6);
      let p = 0;
      for (let j = 0; j < hh - 1; j++) {
        for (let i = 0; i < w - 1; i++) {
          const a = j * w + i;
          const b = a + 1;
          const c = a + w;
          const d = c + 1;
          idx[p++] = a;
          idx[p++] = c;
          idx[p++] = b;
          idx[p++] = b;
          idx[p++] = c;
          idx[p++] = d;
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      g.computeBoundingSphere();
      g.computeBoundingBox();
      out.push(g);
    }
  }
  return out;
}
