import * as THREE from 'three';
import { noiseTexture, waterTexture } from './textures';

export interface FacadeOptions {
  /** Metres between window bays / floor height. */
  bay: number;
  floor: number;
  /** Fraction of each bay occupied by glazing. 0 disables windows. */
  winFrac: number;
  glass: string;
  roughness: number;
  metalness: number;
  /** Vertical rib spacing for corrugated cladding (0 = none). */
  ribs?: number;
}

/**
 * Standard PBR material whose fragment shader paints procedural window bays on vertical faces in
 * *world space*, so a single unit box scaled per instance gets correctly proportioned facades.
 * Roof faces get a darker weathered tone.
 */
export function makeFacadeMaterial(o: FacadeOptions): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: o.roughness, metalness: o.metalness });
  const glass = new THREE.Color(o.glass);
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uBay = { value: o.bay };
    shader.uniforms.uFloor = { value: o.floor };
    shader.uniforms.uWin = { value: o.winFrac };
    shader.uniforms.uGlass = { value: glass };
    shader.uniforms.uRibs = { value: o.ribs ?? 0 };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNor;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        #ifdef USE_INSTANCING
          mat4 iM = modelMatrix * instanceMatrix;
        #else
          mat4 iM = modelMatrix;
        #endif
        vWPos = (iM * vec4(transformed, 1.0)).xyz;
        vWNor = normalize(mat3(iM) * objectNormal);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vWPos;
        varying vec3 vWNor;
        uniform float uBay; uniform float uFloor; uniform float uWin; uniform vec3 uGlass; uniform float uRibs;
        float gWin = 0.0;
        float hash21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          vec3 n = normalize(vWNor);
          float side = 1.0 - step(0.5, abs(n.y));
          float top = step(0.5, n.y);
          vec2 tang = vec2(-n.z, n.x);
          float u = dot(vWPos.xz, tang);
          float v = vWPos.y;
          vec2 cell = vec2(u / uBay, v / uFloor);
          vec2 f = fract(cell);
          vec2 id = floor(cell);
          float mx = (1.0 - uWin) * 0.5;
          float my = 0.2;
          float w = step(mx, f.x) * step(f.x, 1.0 - mx) * step(my, f.y) * step(f.y, 1.0 - my * 0.8);
          w *= side * step(0.8, v) * step(0.001, uWin);
          float h = hash21(id + n.xz * 17.0);
          vec3 g = uGlass * (0.8 + 0.45 * h);
          // slab edge / spandrel band
          float band = side * (1.0 - step(0.12, f.y)) * 0.0;
          diffuseColor.rgb = mix(diffuseColor.rgb, g, w);
          if (uRibs > 0.0) {
            float rib = step(0.82, fract(u / uRibs));
            diffuseColor.rgb *= 1.0 - 0.14 * rib * side;
          }
          diffuseColor.rgb *= mix(1.0, 0.72, top);
          float grime = smoothstep(4.0, 0.0, v);
          diffuseColor.rgb *= 1.0 - 0.18 * grime * side;
          gWin = w;
        }`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n roughnessFactor = mix(roughnessFactor, 0.1, gWin);')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n metalnessFactor = mix(metalnessFactor, 0.75, gWin);');
  };
  m.customProgramCacheKey = () => 'facade-v1';
  return m;
}

/**
 * Makes a textured material sample its map in *world space* (metres / `scale` per repeat), so a single
 * unit plane or box scaled per instance tiles correctly. Works with instancing.
 */
export function worldUV(m: THREE.MeshStandardMaterial, scale: number): THREE.MeshStandardMaterial {
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uScale = { value: scale };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', ['#include <common>', 'varying vec3 vWPosUV;'].join('\n'))
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vWPosUV = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
        #else
          vWPosUV = (modelMatrix * vec4(transformed, 1.0)).xyz;
        #endif`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', ['#include <common>', 'varying vec3 vWPosUV;', 'uniform float uScale;'].join('\n'))
      .replace('#include <map_fragment>', ['vec4 sampledDiffuseColor = texture2D( map, vWPosUV.xz / uScale );', 'diffuseColor *= sampledDiffuseColor;'].join('\n'));
  };
  m.customProgramCacheKey = () => `worlduv-${scale}`;
  return m;
}

export interface Mats {
  facade: Record<string, THREE.MeshStandardMaterial>;
  roofTile: THREE.MeshStandardMaterial;
  grass: THREE.MeshStandardMaterial;
  asphalt: THREE.MeshStandardMaterial;
  concrete: THREE.MeshStandardMaterial;
  paving: THREE.MeshStandardMaterial;
  lawn: THREE.MeshStandardMaterial;
  gravel: THREE.MeshStandardMaterial;
  sand: THREE.MeshStandardMaterial;
  turf: THREE.MeshStandardMaterial;
  ballast: THREE.MeshStandardMaterial;
  water: THREE.MeshPhysicalMaterial;
  waterTex: THREE.CanvasTexture;
  riverBed: THREE.MeshStandardMaterial;
  metalGrey: THREE.MeshStandardMaterial;
  metalDark: THREE.MeshStandardMaterial;
  paint: THREE.MeshStandardMaterial;
  yellowPaint: THREE.MeshStandardMaterial;
  trunk: THREE.MeshStandardMaterial;
  foliage: THREE.MeshStandardMaterial;
  carBody: THREE.MeshStandardMaterial;
  carGlass: THREE.MeshStandardMaterial;
  container: THREE.MeshStandardMaterial;
  cardboard: THREE.MeshStandardMaterial;
  craneYellow: THREE.MeshStandardMaterial;
}

let cache: Mats | null = null;

export function getMaterials(): Mats {
  if (cache) return cache;
  const asphaltTex = noiseTexture('#3b3d40', 26, { seed: 3, blotch: 60, cracks: 18 });
  const concreteTex = noiseTexture('#bdbcb6', 14, { seed: 5, blotch: 50, cracks: 10 });
  const grassTex = noiseTexture('#5d7544', 26, { seed: 9, blotch: 90 });
  const lawnTex = noiseTexture('#6c8650', 22, { seed: 11, blotch: 70 });
  const pavingTex = noiseTexture('#b0afa9', 10, { seed: 13, blotch: 30, cracks: 6 });
  const gravelTex = noiseTexture('#9c9a90', 30, { seed: 17, blotch: 40 });
  const sandTex = noiseTexture('#d6c9a3', 16, { seed: 19, blotch: 40 });
  const turfTex = noiseTexture('#5f8f4c', 14, { seed: 23, blotch: 30 });
  const ballastTex = noiseTexture('#6f6a63', 34, { seed: 29, blotch: 50 });
  const waterTex = waterTexture();
  waterTex.repeat.set(3, 300);

  const mk = (o: FacadeOptions) => makeFacadeMaterial(o);
  cache = {
    facade: {
      plaster: mk({ bay: 3.2, floor: 3.2, winFrac: 0.5, glass: '#5b7080', roughness: 0.9, metalness: 0 }),
      brick: mk({ bay: 3.0, floor: 3.0, winFrac: 0.42, glass: '#566a78', roughness: 0.95, metalness: 0 }),
      concrete: mk({ bay: 3.6, floor: 3.2, winFrac: 0.7, glass: '#4d6272', roughness: 0.85, metalness: 0.02 }),
      glass: mk({ bay: 2.4, floor: 3.2, winFrac: 0.92, glass: '#3e5668', roughness: 0.35, metalness: 0.45 }),
      metal: mk({ bay: 8, floor: 6, winFrac: 0, glass: '#444', roughness: 0.55, metalness: 0.5, ribs: 1.2 }),
      corrugated: mk({ bay: 8, floor: 6, winFrac: 0, glass: '#444', roughness: 0.6, metalness: 0.45, ribs: 0.9 }),
    },
    roofTile: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0 }),
    grass: worldUV(new THREE.MeshStandardMaterial({ map: grassTex, roughness: 1 }), 26),
    asphalt: worldUV(new THREE.MeshStandardMaterial({ map: asphaltTex, roughness: 0.92, metalness: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }), 10),
    concrete: worldUV(new THREE.MeshStandardMaterial({ map: concreteTex, roughness: 0.9 }), 8),
    paving: worldUV(new THREE.MeshStandardMaterial({ map: pavingTex, roughness: 0.88 }), 7),
    lawn: worldUV(new THREE.MeshStandardMaterial({ map: lawnTex, roughness: 1 }), 14),
    gravel: worldUV(new THREE.MeshStandardMaterial({ map: gravelTex, roughness: 1 }), 9),
    sand: worldUV(new THREE.MeshStandardMaterial({ map: sandTex, roughness: 1 }), 12),
    turf: worldUV(new THREE.MeshStandardMaterial({ map: turfTex, roughness: 1 }), 10),
    ballast: worldUV(new THREE.MeshStandardMaterial({ map: ballastTex, roughness: 1 }), 5),
    water: new THREE.MeshPhysicalMaterial({ map: waterTex, color: '#9bb7c4', roughness: 0.12, metalness: 0.05, clearcoat: 0.6, clearcoatRoughness: 0.2, transparent: true, opacity: 0.93 }),
    waterTex,
    riverBed: new THREE.MeshStandardMaterial({ color: '#4f5a55', roughness: 1 }),
    metalGrey: new THREE.MeshStandardMaterial({ color: '#8d9298', roughness: 0.5, metalness: 0.7 }),
    metalDark: new THREE.MeshStandardMaterial({ color: '#2d3136', roughness: 0.6, metalness: 0.5 }),
    paint: new THREE.MeshStandardMaterial({ color: '#e9e9e4', roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }),
    yellowPaint: new THREE.MeshStandardMaterial({ color: '#d9b43a', roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }),
    trunk: new THREE.MeshStandardMaterial({ color: '#5c4733', roughness: 1 }),
    foliage: new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.95, flatShading: true }),
    carBody: new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.35, metalness: 0.55 }),
    carGlass: new THREE.MeshStandardMaterial({ color: '#1d2830', roughness: 0.1, metalness: 0.8 }),
    container: new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.6, metalness: 0.35 }),
    cardboard: new THREE.MeshStandardMaterial({ color: '#b08a57', roughness: 0.9 }),
    craneYellow: new THREE.MeshStandardMaterial({ color: '#d8a31f', roughness: 0.55, metalness: 0.3 }),
  };
  return cache;
}
