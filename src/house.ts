/**
 * Buildings from the player's own DayZ files, shown in the planner to build
 * in and around. The model is read locally (see odol.ts); only its name and
 * placement are stored in the plan, and the model bytes are cached in this
 * browser's IndexedDB so a reload does not need the file again.
 */
import * as THREE from 'three';
import { lodKind, readOdol, readPboFile, readPboIndex, type OdolLod, type OdolModel, type OdolSection, type PboEntry, type PboIndex } from './odol';
import { paaInfo, readPaa } from './paa';

export interface SiteRef {
  id: string;
  /** PBO file name, e.g. structures_residential.pbo */
  pbo: string;
  /** model path inside the PBO */
  path: string;
  name: string;
  x: number;
  y: number;
  z: number;
  /** degrees, clockwise seen from above like the planner's parts */
  r: number;
  /** footprint for the placeholder while the model is not loaded */
  size: [number, number, number];
  center: [number, number, number];
}

const nameCollator = new Intl.Collator();

export const siteKey = (pbo: string, path: string) => pbo.toLowerCase() + '|' + path.toLowerCase().replace(/\//g, '\\');
export const modelName = (path: string) => (path.split(/[\\/]/).pop() ?? path).replace(/\.p3d$/i, '');

// ---------------------------------------------------------- local cache
const DB = 'abp.houses';
let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((res, rej) => {
      const q = indexedDB.open(DB, 1);
      q.onupgradeneeded = () => {
        if (!q.result.objectStoreNames.contains('models')) {
          q.result.createObjectStore('models');
        }
      };
      q.onsuccess = () => {
        const conn = q.result;
        conn.onclose = () => { dbPromise = null; };
        conn.onversionchange = () => { conn.close(); dbPromise = null; };
        res(conn);
      };
      q.onerror = () => {
        dbPromise = null;
        rej(q.error);
      };
    });
  }
  return dbPromise;
}

async function cacheGet(key: string): Promise<Uint8Array | null> {
  try {
    const d = await db();
    return await new Promise((res) => {
      const q = d.transaction('models').objectStore('models').get(key);
      q.onsuccess = () => res(q.result ? new Uint8Array(q.result as ArrayBuffer) : null);
      q.onerror = () => res(null);
    });
  } catch {
    return null;
  }
}

async function cachePut(key: string, bytes: Uint8Array) {
  try {
    const d = await db();
    const buf =
      bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? bytes.buffer
        : bytes.slice().buffer;
    await new Promise<void>((res) => {
      const tx = d.transaction('models', 'readwrite');
      tx.objectStore('models').put(buf, key);
      tx.oncomplete = () => res();
      tx.onerror = () => res();
      tx.onabort = () => res();
    });
  } catch {
    /* private mode or quota exceeded: just no cache */
  }
}

// --------------------------------------------------------- PBO sessions
interface Lib {
  file: File;
  index: PboIndex;
  /** path prefix of the archive, lower case, no slashes at the ends */
  prefix: string;
  /** prefix with trailing backslash for fast startsWith checks */
  prefixSlash: string;
  byName: Map<string, PboEntry>;
}
/** PBO files the player picked in this session, by lower-case file name. */
const pbos = new Map<string, Lib>();

const norm = (p: string) => p.trim().replace(/\//g, '\\').replace(/^\\+/, '').toLowerCase();

export async function openPbo(file: File) {
  const index = await readPboIndex(file);
  const byName = new Map<string, PboEntry>();
  for (const e of index.entries) byName.set(e.name.toLowerCase(), e);
  const prefix = norm(index.prefix).replace(/\\+$/, '');
  pbos.set(file.name.toLowerCase(), {
    file,
    index,
    prefix,
    prefixSlash: prefix ? prefix + '\\' : '',
    byName,
  });
  return index;
}

/** Open every .pbo among the files (e.g. a picked Addons folder). */
export async function openPbos(files: File[], onProgress?: (done: number, total: number) => void) {
  const list = files.filter((f) => /\.pbo$/i.test(f.name));
  let done = 0;
  let failed = 0;
  let next = 0;
  const concurrency = Math.min(6, list.length);
  const worker = async () => {
    while (next < list.length) {
      const f = list[next++];
      try {
        await openPbo(f);
      } catch {
        failed++;
      }
      onProgress?.(++done, list.length);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  retryTextures();
  return { opened: list.length - failed, failed };
}

export function openedPbos() {
  return [...pbos.entries()].map(([key, l]) => ({ key, name: l.file.name, index: l.index }));
}

export function pboModels(index: PboIndex) {
  return index.entries
    .filter((e) => /\.p3d$/i.test(e.name) && !/(^|\\)proxy(\\|$)|\\proxies?\\/i.test(e.name))
    .sort((a, b) => nameCollator.compare(a.name, b.name));
}

/** The archive and entry holding a game path like dz\structures\data\roof\x.paa. */
function resolvePath(path: string): { lib: Lib; entry: PboEntry } | null {
  const p = norm(path);
  let best: { lib: Lib; entry: PboEntry } | null = null;
  let bestLen = -1;
  for (const lib of pbos.values()) {
    if (!lib.prefixSlash || lib.prefix.length <= bestLen || !p.startsWith(lib.prefixSlash)) continue;
    const entry = lib.byName.get(p.slice(lib.prefixSlash.length));
    if (entry) {
      best = { lib, entry };
      bestLen = lib.prefix.length;
    }
  }
  return best;
}

const built = new Map<string, Promise<THREE.Group | null>>();

/** The model for a site, from the cache or an opened PBO; null if neither has it. */
export function loadModel(pbo: string, path: string): Promise<THREE.Group | null> {
  const key = siteKey(pbo, path);
  const have = built.get(key);
  if (have) return have;

  const job = (async (): Promise<THREE.Group | null> => {
    let bytes = await cacheGet(key);
    const fromCache = bytes !== null;
    if (!bytes) {
      const src = pbos.get(pbo.toLowerCase());
      if (!src) return null;
      const e = src.byName.get(path.toLowerCase().replace(/\//g, '\\'));
      if (!e) throw new Error('Modell nicht in der PBO gefunden');
      bytes = await readPboFile(src.file, e);
    }
    const model = readOdol(bytes, (res) => res < 1000 || lodKind(res) === 'memory' || lodKind(res) === 'roadway');
    const g = buildHouse(model);
    if (!fromCache) void cachePut(key, bytes);
    return g;
  })();

  built.set(key, job);
  job.then(
    (g) => { if (!g) built.delete(key); },
    () => { built.delete(key); },
  );
  return job;
}

// ------------------------------------------------------------ geometry
/** model space (left-handed, z forward) to planner space */
const P = (pts: Float32Array, i: number, ground: number) => new THREE.Vector3(pts[i * 3], pts[i * 3 + 1] - ground, -pts[i * 3 + 2]);

const ROADWAY_MAT = new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide });
const PLACEHOLDER_FILL_MAT = new THREE.MeshBasicMaterial({ color: 0xe9a84a, transparent: true, opacity: 0.08, depthWrite: false });
const PLACEHOLDER_EDGE_MAT = new THREE.LineBasicMaterial({ color: 0xe9a84a });

interface Look {
  color: number;
  glass?: boolean;
  roughness?: number;
  /** colour texture of the face */
  map?: string;
  /** texture with cut-out alpha (fences, leaves, frames) */
  cutout?: boolean;
  /** multi-material: four tiling layers mixed by a mask, plus macro and ambient-shadow maps */
  multi?: MultiSpec;
}

interface Stage {
  tex: string;
  /** 0: first UV set (tiling), 1: second UV set (unique layout) */
  set: number;
  /** u' = dot((u, v, 1), tu), v' = dot((u, v, 1), tv) */
  tu: [number, number, number];
  tv: [number, number, number];
}
/** layers 1-4, mask, macro, ambient shadow */
type MultiSpec = Stage[];

const lookKey = (l: Look) =>
  [l.color, l.glass ? 1 : 0, l.roughness ?? 0.9, l.map ?? '', l.cutout ? 1 : 0, (l.multi ?? []).map((s) => [s.tex, s.set, ...s.tu, ...s.tv].join(',')).join(';')].join('|');

const DEFAULT_LOOK: Look = { color: 0xaaa290 };
const DEFAULT_LOOK_KEY = lookKey(DEFAULT_LOOK);

function colourGuess(s: string): Look {
  if (/roof|strecha|tiles?_|ceramic|tile_roof/.test(s)) return { color: 0x7a4a3c };
  if (/metal|iron|steel|plech|tin|zinc/.test(s)) return { color: 0x7b8086, roughness: 0.6 };
  if (/wood|drev|plank|door|dvere|prkn/.test(s)) return { color: 0x7a5c40 };
  if (/brick|cihl/.test(s)) return { color: 0x8a5a46 };
  if (/floor|podlah|parket|linoleum|tile/.test(s)) return { color: 0xa39582 };
  if (/concrete|beton|panel/.test(s)) return { color: 0x8f8b84 };
  if (/int_|interior|wall_int|omitka_in/.test(s)) return { color: 0xc4bcae };
  if (/plaster|omitka|wall/.test(s)) return { color: 0xb3a994 };
  return DEFAULT_LOOK;
}

function lookFor(sec: OdolSection): Look {
  const { texture, material } = sec;
  const s = (texture + ' ' + material).toLowerCase();
  const glass = /glass|okno|window_glass|sklo/.test(s);
  const guess = colourGuess(s);
  if (/\.(paa|tga|png)$/i.test(texture)) {
    return { color: glass ? 0x9fb8c4 : guess.color, glass, map: texture, cutout: !glass && /_ca\.paa$/i.test(texture), roughness: glass ? 0.1 : guess.roughness };
  }
  const proc = /color\(([\d.]+),([\d.]+),([\d.]+)/.exec(texture);
  if (proc) return { color: new THREE.Color(+proc[1], +proc[2], +proc[3]).getHex(), glass };
  if (glass) return { color: 0x9fb8c4, glass: true };
  // multi-materials: stages 1-4 are the layers, 5 the mask, 10 the macro map, 11 the ambient shadow
  const mt = sec.mat;
  const st = sec.stages;
  if (mt && st.length >= 5 && /_mask\.paa$/i.test(st[4]) && st.slice(0, 4).every((x) => /\.paa$/i.test(x) || /color\(/.test(x))) {
    const stage = (i: number, fallback: string): Stage => {
      const tex = st[i] && (/\.paa$/i.test(st[i]) || /color\(/.test(st[i])) ? st[i] : fallback;
      const g = mt.uvTransforms[mt.texGens[i] ?? -1];
      const m = g?.m ?? [1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0];
      return { tex, set: g && g.source === 5 ? 1 : 0, tu: [m[0], m[3], m[9]], tv: [m[1], m[4], m[10]] };
    };
    const multi = [0, 1, 2, 3, 4].map((i) => stage(i, ''));
    multi.push(/_mc\.paa$|,mc\)/i.test(st[9] ?? '') ? stage(9, '') : { ...multi[4], tex: '#(argb,8,8,3)color(0,0,0,0,mc)' });
    multi.push(/_a?d?s\.paa$|,as\)/i.test(st[10] ?? '') ? stage(10, '') : { ...multi[4], tex: '#(argb,8,8,3)color(1,1,1,1,as)' });
    return { ...guess, multi };
  }
  return guess;
}

const matCache = new Map<string, THREE.MeshStandardMaterial>();
function materialFor(look: Look, key = lookKey(look)) {
  let m = matCache.get(key);
  if (!m) {
    m = look.glass
      ? new THREE.MeshStandardMaterial({ color: look.color, transparent: true, opacity: 0.28, roughness: 0.1, depthWrite: false, side: THREE.DoubleSide })
      : new THREE.MeshStandardMaterial({ color: look.color, roughness: look.roughness ?? 0.9, side: THREE.DoubleSide });
    m.userData.look = look;
    matCache.set(key, m);
    void texturize(m);
  }
  return m;
}

// ------------------------------------------------------------ textures
/** paths whose texture was not found in any opened PBO */
export const missingTextures = new Set<string>();
const texBytesJobs = new Map<string, Promise<Uint8Array | null>>();

async function textureBytes(path: string): Promise<Uint8Array | null> {
  const nPath = norm(path);
  const key = 'tex|' + nPath;
  const have = texBytesJobs.get(key);
  if (have) return have;
  const job = (async () => {
    const cached = await cacheGet(key);
    if (cached) return cached;
    const hit = resolvePath(path);
    if (!hit) return null;
    const b = await readPboFile(hit.lib.file, hit.entry);
    void cachePut(key, b);
    return b;
  })();
  texBytesJobs.set(key, job);
  const b = await job.catch(() => null);
  if (!b) {
    texBytesJobs.delete(key); // try again once more PBOs are open
    missingTextures.add(nPath);
  } else {
    missingTextures.delete(nPath);
  }
  return b;
}

const texJobs = new Map<string, Promise<THREE.Texture | null>>();
let decodeTail: Promise<unknown> = Promise.resolve();

/** Decode one .paa texture per macrotask so the 3D view stays responsive. */
function decodePaaQueued(bytes: Uint8Array, maxDim: number) {
  const run = decodeTail.then(
    () =>
      new Promise<ReturnType<typeof readPaa>>((res, rej) => {
        setTimeout(() => {
          try {
            res(readPaa(bytes, maxDim));
          } catch (e) {
            rej(e);
          }
        }, 0);
      }),
  );
  decodeTail = run.catch(() => {});
  return run;
}

function loadTexture(path: string, srgb = true): Promise<THREE.Texture | null> {
  const key = norm(path) + (srgb ? '' : '|raw');
  const have = texJobs.get(key);
  if (have) return have;
  const job = (async () => {
    const proc = /color\(([\d.]+),([\d.]+),([\d.]+),([\d.]+)/.exec(path);
    if (proc) {
      const px = new Uint8Array(4);
      for (let i = 0; i < 4; i++) px[i] = Math.max(0, Math.min(255, Math.round(+proc[i + 1] * 255)));
      const t = new THREE.DataTexture(px, 1, 1, THREE.RGBAFormat);
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      t.needsUpdate = true;
      return t;
    }
    const b = await textureBytes(path);
    if (!b) return null;
    const img = await decodePaaQueued(b, 1024);
    const tex = new THREE.DataTexture(img.rgba, img.width, img.height, THREE.RGBAFormat);
    if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    return tex;
  })();
  texJobs.set(key, job);
  job.then(
    (t) => { if (!t) texJobs.delete(key); },
    () => texJobs.delete(key),
  );
  return job.catch(() => null);
}

async function averageOf(path: string): Promise<THREE.Color | null> {
  const proc = /color\(([\d.]+),([\d.]+),([\d.]+)/.exec(path);
  if (proc) return new THREE.Color(+proc[1], +proc[2], +proc[3]);
  const b = await textureBytes(path);
  const avg = b ? paaInfo(b).avg : null;
  return avg ? new THREE.Color().setRGB(avg[0], avg[1], avg[2], THREE.SRGBColorSpace) : null;
}

let pboVersion = 0;

async function texturize(m: THREE.MeshStandardMaterial) {
  if (m.userData.textured || m.userData.texturizing) return;
  m.userData.texturizing = true;
  const startedVersion = pboVersion;
  try {
    const look = m.userData.look as Look;
    if (look.map) {
      const tex = await loadTexture(look.map);
      if (!tex) return;
      m.map = tex;
      m.color.set(0xffffff);
      if (look.glass) m.opacity = /_ca\.paa$/i.test(look.map) ? 1 : 0.45;
      if (look.cutout) {
        m.alphaTest = 0.5;
        m.transparent = false;
      }
      m.userData.textured = true;
      m.needsUpdate = true;
    } else if (look.multi) {
      const spec = look.multi;
      if (!m.userData.averaged) {
        // quick stand-in: the layers' average colours, weighted by the mask
        const cols = await Promise.all(spec.slice(0, 4).map((s) => averageOf(s.tex)));
        const mk = await averageOf(spec[4].tex);
        if (mk && cols.every((c) => c)) {
          const w = [Math.max(0, 1 - mk.r - mk.g - mk.b), mk.r, mk.g, mk.b];
          const sum = w[0] + w[1] + w[2] + w[3] || 1;
          const c = new THREE.Color(0, 0, 0);
          for (let i = 0; i < 4; i++) {
            const col = cols[i]!;
            const k = w[i] / sum;
            c.r += col.r * k;
            c.g += col.g * k;
            c.b += col.b * k;
          }
          m.color.copy(c);
          m.userData.averaged = true;
        }
      }
      const texs = await Promise.all(spec.map((s, i) => loadTexture(s.tex, i < 4)));
      if (texs.some((x) => !x)) return;
      useMultiShader(m, spec, texs as THREE.Texture[]);
      m.color.set(0xffffff);
      m.userData.textured = true;
      m.needsUpdate = true;
    }
  } finally {
    m.userData.texturizing = false;
    if (!m.userData.textured && pboVersion !== startedVersion) {
      void texturize(m);
    }
  }
}

/**
 * DayZ multi-material, simplified: four tiling layers chosen by the mask
 * (black = layer 1, red = 2, green = 3, blue = 4), the macro map laid over as
 * an overlay (grey is neutral) and the ambient-shadow map darkening corners.
 * Normal, specular and detail maps are left out.
 */
function useMultiShader(m: THREE.MeshStandardMaterial, spec: MultiSpec, texs: THREE.Texture[]) {
  const uniforms = {
    mL0: { value: texs[0] },
    mL1: { value: texs[1] },
    mL2: { value: texs[2] },
    mL3: { value: texs[3] },
    mMask: { value: texs[4] },
    mMacro: { value: texs[5] },
    mShadow: { value: texs[6] },
    mTU: { value: spec.map((s) => new THREE.Vector3(...s.tu)) },
    mTV: { value: spec.map((s) => new THREE.Vector3(...s.tv)) },
    mSet: { value: spec.map((s) => s.set) },
  };
  m.customProgramCacheKey = () => 'dayz-multi';
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 uvA;\nattribute vec2 uvB;\nvarying vec2 vUvA;\nvarying vec2 vUvB;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvUvA = uvA;\nvUvB = uvB;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec2 vUvA;
varying vec2 vUvB;
uniform sampler2D mL0, mL1, mL2, mL3, mMask, mMacro, mShadow;
uniform vec3 mTU[7];
uniform vec3 mTV[7];
uniform float mSet[7];
vec2 mUv(int i) {
  vec3 b = vec3(mSet[i] > 0.5 ? vUvB : vUvA, 1.0);
  return vec2(dot(b, mTU[i]), dot(b, mTV[i]));
}`,
      )
      .replace(
        '#include <map_fragment>',
        `vec4 mk = texture2D(mMask, mUv(4));
float w1 = mk.r, w2 = mk.g, w3 = mk.b;
float w0 = clamp(1.0 - w1 - w2 - w3, 0.0, 1.0);
vec3 mcol = (texture2D(mL0, mUv(0)).rgb * w0 + texture2D(mL1, mUv(1)).rgb * w1
  + texture2D(mL2, mUv(2)).rgb * w2 + texture2D(mL3, mUv(3)).rgb * w3) / max(w0 + w1 + w2 + w3, 1e-3);
vec4 mc = texture2D(mMacro, mUv(5));
mcol = mix(mcol, mcol * mc.rgb * 2.0, mc.a);
mcol *= mix(0.5, 1.0, texture2D(mShadow, mUv(6)).g);
diffuseColor.rgb *= mcol;`,
      );
  };
}

/** After more PBOs were opened: fill in textures that were missing. */
export function retryTextures() {
  pboVersion++;
  for (const m of matCache.values()) if (!m.userData.textured) void texturize(m);
}

interface PreparedLod {
  lod: OdolLod;
  sectionOf: Int32Array;
  sectionLooks: ({ look: Look; key: string } | null)[];
  vertCount: number;
}

/** Precompute section-to-face mapping and look specs once per LOD (not once per face/door). */
function prepareLod(lod: OdolLod): PreparedLod {
  const faceCount = lod.faces.length;
  const sectionOf = new Int32Array(faceCount).fill(-1);
  const sectionLooks: ({ look: Look; key: string } | null)[] = new Array(lod.sections.length);
  for (let i = 0; i < lod.sections.length; i++) {
    const s = lod.sections[i];
    const to = Math.min(s.to, faceCount);
    for (let f = Math.max(0, s.from); f < to; f++) sectionOf[f] = i;
    if (!s.texture && !s.material) {
      sectionLooks[i] = null; // proxy markers and hidden faces
    } else {
      const look = lookFor(s);
      sectionLooks[i] = { look, key: lookKey(look) };
    }
  }
  return { lod, sectionOf, sectionLooks, vertCount: Math.floor(lod.points.length / 3) };
}

/** Triangles of the given faces, grouped by look, as one geometry with groups. */
function meshOf(prep: PreparedLod, faceIds: number[], ground: number, ox = 0, oy = 0, oz = 0): THREE.Mesh | null {
  const { lod, sectionOf, sectionLooks, vertCount } = prep;
  const byLook = new Map<string, { look: Look; key: string; tris: number[] }>();

  for (let i = 0; i < faceIds.length; i++) {
    const f = faceIds[i];
    if (f < 0 || f >= lod.faces.length) continue;
    const secIdx = sectionOf[f];
    let look: Look;
    let k: string;
    if (secIdx >= 0) {
      const sl = sectionLooks[secIdx];
      if (!sl) continue; // proxy markers and hidden faces
      look = sl.look;
      k = sl.key;
    } else {
      look = DEFAULT_LOOK;
      k = DEFAULT_LOOK_KEY;
    }
    const v = lod.faces[f];
    if (v.length < 3) continue;
    const v0 = v[0], v1 = v[1], v2 = v[2];
    if (v0 < 0 || v1 < 0 || v2 < 0 || v0 >= vertCount || v1 >= vertCount || v2 >= vertCount) continue;
    let g = byLook.get(k);
    if (!g) {
      g = { look, key: k, tris: [] };
      byLook.set(k, g);
    }
    // faces are clockwise in the model's left-handed space; mirroring z keeps
    // them counter-clockwise from the front in three.js
    g.tris.push(v0, v1, v2);
    if (v.length >= 4) {
      const v3 = v[3];
      if (v3 >= 0 && v3 < vertCount) g.tris.push(v0, v2, v3);
    }
  }
  if (!byLook.size) return null;

  const used = new Int32Array(vertCount).fill(-1);
  const pts = lod.points;
  const uvSrc = lod.uv;
  const setB = lod.uvSets[1] ?? uvSrc;
  const pos: number[] = [];
  const uv: number[] = [];
  const uvB: number[] = [];
  const index: number[] = [];
  const groups: { start: number; count: number; mat: THREE.Material }[] = [];

  for (const { look, key, tris } of byLook.values()) {
    const start = index.length;
    for (let i = 0; i < tris.length; i++) {
      const vi = tris[i];
      let k = used[vi];
      if (k === -1) {
        k = pos.length / 3;
        const b3 = vi * 3;
        pos.push(pts[b3] - ox, pts[b3 + 1] - ground - oy, -pts[b3 + 2] - oz);
        if (uvSrc) uv.push(uvSrc[vi * 2], uvSrc[vi * 2 + 1]);
        if (setB) uvB.push(setB[vi * 2], setB[vi * 2 + 1]);
        used[vi] = k;
      }
      index.push(k);
    }
    groups.push({ start, count: index.length - start, mat: materialFor(look, key) });
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  if (uv.length) {
    const uvAttr = new THREE.Float32BufferAttribute(uv, 2);
    geo.setAttribute('uv', uvAttr);
    geo.setAttribute('uvA', uvAttr);
  }
  if (uvB.length) geo.setAttribute('uvB', new THREE.Float32BufferAttribute(uvB, 2));
  geo.setIndex(index);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();

  const mats: THREE.Material[] = [];
  for (const g of groups) {
    geo.addGroup(g.start, g.count, mats.length);
    mats.push(g.mat);
  }
  const mesh = new THREE.Mesh(geo, mats);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** Invisible collision mesh for the roadway LOD without triggering material/texture loads. */
function roadwayMeshOf(lod: OdolLod, ground: number): THREE.Mesh | null {
  const faceCount = lod.faces.length;
  const vertCount = Math.floor(lod.points.length / 3);
  if (!faceCount || !vertCount) return null;

  const hidden = new Uint8Array(faceCount);
  for (const s of lod.sections) {
    if (!s.texture && !s.material) {
      const to = Math.min(s.to, faceCount);
      for (let f = Math.max(0, s.from); f < to; f++) hidden[f] = 1;
    }
  }

  const used = new Int32Array(vertCount).fill(-1);
  const pts = lod.points;
  const pos: number[] = [];
  const index: number[] = [];

  const emit = (vi: number) => {
    let k = used[vi];
    if (k === -1) {
      k = pos.length / 3;
      const b3 = vi * 3;
      pos.push(pts[b3], pts[b3 + 1] - ground, -pts[b3 + 2]);
      used[vi] = k;
    }
    index.push(k);
  };

  for (let f = 0; f < faceCount; f++) {
    if (hidden[f]) continue;
    const v = lod.faces[f];
    if (v.length < 3) continue;
    const v0 = v[0], v1 = v[1], v2 = v[2];
    if (v0 < 0 || v1 < 0 || v2 < 0 || v0 >= vertCount || v1 >= vertCount || v2 >= vertCount) continue;
    emit(v0); emit(v1); emit(v2);
    if (v.length >= 4) {
      const v3 = v[3];
      if (v3 >= 0 && v3 < vertCount) {
        emit(v0); emit(v2); emit(v3);
      }
    }
  }
  if (!index.length) return null;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(index);
  geo.computeBoundingSphere();

  const mesh = new THREE.Mesh(geo, ROADWAY_MAT);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.userData.walkOnly = true;
  return mesh;
}

function buildHouse(model: OdolModel): THREE.Group {
  const visIdx = model.resolutions.findIndex((r, i) => r < 1000 && model.lods[i]);
  if (visIdx < 0) throw new Error('Modell hat keine sichtbare Detailstufe');
  const vis = model.lods[visIdx]!;
  const memory = model.lods.find((l, i) => l && lodKind(model.resolutions[i]) === 'memory') ?? null;
  const roadway = model.lods.find((l, i) => l && lodKind(model.resolutions[i]) === 'roadway') ?? null;

  // ground: the lowest walkable surface when there is one, else the model's bottom
  const minY = (l: OdolLod) => {
    let m = Infinity;
    for (let i = 1; i < l.points.length; i += 3) if (l.points[i] < m) m = l.points[i];
    return m;
  };
  const ground = roadway && roadway.points.length ? minY(roadway) : minY(vis);

  const root = new THREE.Group();
  root.userData.house = true;

  const prepVis = prepareLod(vis);

  // doors: faces of the visual "doorsN" selections, turned about the memory
  // LOD's "doorsN_axis" points
  const doorFaces = new Uint8Array(vis.faces.length);
  if (memory) {
    const memByName = new Map(memory.selections.map((s) => [s.name.toLowerCase(), s]));
    const memVertCount = Math.floor(memory.points.length / 3);
    for (const sel of vis.selections) {
      if (!/^doors?(twin)?\d+$/i.test(sel.name) || !sel.faces.length) continue;
      const ax = memByName.get(sel.name.toLowerCase() + '_axis');
      if (!ax || ax.vertices.length < 2) continue;
      const vi0 = ax.vertices[0], vi1 = ax.vertices[1];
      if (vi0 < 0 || vi1 < 0 || vi0 >= memVertCount || vi1 >= memVertCount) continue;
      const a = P(memory.points, vi0, ground);
      const b = P(memory.points, vi1, ground);
      const mesh = meshOf(prepVis, sel.faces, ground, a.x, a.y, a.z);
      if (!mesh) continue;
      for (const f of sel.faces) if (f >= 0 && f < doorFaces.length) doorFaces[f] = 1;
      const pivot = new THREE.Group();
      pivot.position.copy(a);
      const axis = b.sub(a).normalize();
      pivot.userData.door = { t: 0, target: 0, mode: 'axis', axis: [axis.x, axis.y, axis.z], baseY: 0, h: 0 };
      pivot.userData.houseDoor = true;
      pivot.add(mesh);
      root.add(pivot);
    }
  }

  const rest: number[] = [];
  for (let f = 0; f < vis.faces.length; f++) if (!doorFaces[f]) rest.push(f);
  const body = meshOf(prepVis, rest, ground);
  if (body) root.add(body);

  // the roadway LOD is the walkable surface (stairs as ramps): invisible, for walk mode
  if (roadway && roadway.faces.length) {
    const rw = roadwayMeshOf(roadway, ground);
    if (rw) root.add(rw);
  }
  const box = new THREE.Box3().setFromObject(root);
  root.userData.size = box.getSize(new THREE.Vector3()).toArray();
  root.userData.center = box.getCenter(new THREE.Vector3()).toArray();
  return root;
}

/** Wire-box stand-in while a site's model is not available. */
export function placeholder(ref: SiteRef): THREE.Group {
  const g = new THREE.Group();
  const [w, h, d] = ref.size;
  const geo = new THREE.BoxGeometry(Math.max(w, 0.5), Math.max(h, 0.5), Math.max(d, 0.5));
  const box = new THREE.Mesh(geo, PLACEHOLDER_FILL_MAT);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), PLACEHOLDER_EDGE_MAT);
  box.position.fromArray(ref.center);
  edges.position.fromArray(ref.center);
  box.userData.noCollide = true;
  g.add(box, edges);
  g.userData.placeholder = true;
  return g;
}

export function instance(template: THREE.Group): THREE.Group {
  const g = template.clone(true);
  g.traverse((o) => {
    if (o.userData.door) o.userData.door = { ...o.userData.door, t: 0, target: 0 };
  });
  return g;
}

export function placeSite(obj: THREE.Object3D, ref: SiteRef) {
  obj.position.set(ref.x, ref.y, ref.z);
  obj.rotation.y = -THREE.MathUtils.degToRad(ref.r);
}

export function sanitizeSites(raw: unknown): SiteRef[] {
  if (!Array.isArray(raw)) return [];
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const clampSize = (v: unknown) => Math.max(0, Math.min(500, n(v)));
  const v3 = (v: unknown): [number, number, number] => (Array.isArray(v) && v.length === 3 ? [n(v[0]), n(v[1]), n(v[2])] : [8, 6, 8]);
  const size3 = (v: unknown): [number, number, number] => (Array.isArray(v) && v.length === 3 ? [clampSize(v[0]), clampSize(v[1]), clampSize(v[2])] : [8, 6, 8]);
  return raw
    .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object' && typeof (s as Record<string, unknown>).pbo === 'string' && typeof (s as Record<string, unknown>).path === 'string' && /\.p3d$/i.test((s as Record<string, unknown>).path as string))
    .slice(0, 50)
    .map((s) => {
      const path = String(s.path).slice(0, 260);
      const rawName = typeof s.name === 'string' && s.name.trim() ? s.name : modelName(path);
      return {
        id: typeof s.id === 'string' ? s.id.slice(0, 16) : Math.random().toString(36).slice(2, 10),
        pbo: String(s.pbo).slice(0, 120),
        path,
        name: rawName.slice(0, 80),
        x: n(s.x),
        y: n(s.y),
        z: n(s.z),
        r: n(s.r),
        size: size3(s.size),
        center: v3(s.center),
      };
    });
}
