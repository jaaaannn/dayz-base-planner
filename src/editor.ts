import * as THREE from 'three';
import { FlyCam } from './flycam';
import { floorTop, GRID, levelTop, MAX_LEVEL, TERRITORY_RADIUS } from './constants';
import { PARTS, type PartDef } from './data';
import { createGhost, createPartObject, findDoorPivots, setGhostValid, setHighlight, stepDoor } from './meshes';
import { computePlacement, validate, type Cursor, type Placement, type Verdict } from './placement';
import type { Piece, Store } from './store';
import { groundTex } from './textures';

const hasOwn = Object.prototype.hasOwnProperty;
const UP = new THREE.Vector3(0, 1, 0);

export interface EditorEvents {
  onPreview?: (info: { part: string; verdict: Verdict | null; snapped: boolean } | null) => void;
  onSelect?: (piece: Piece | null) => void;
  onHover?: (piece: Piece | null) => void;
  onMoveChange?: (moving: boolean) => void;
  onMoveRejected?: (reason: string) => void;
  onRaidTarget?: (t: { x: number; z: number; l: number }) => void;
  onRaidPick?: (on: boolean) => void;
}

export class Editor {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: FlyCam;
  readonly world = new THREE.Group();
  /** buildings loaded from the game files (see house.ts) */
  readonly sites = new THREE.Group();
  readonly ground: THREE.Mesh;
  private grid: THREE.GridHelper;
  private levelGrid: THREE.GridHelper;
  private sun: THREE.DirectionalLight;
  private ring: THREE.Group;
  private objects = new Map<number, THREE.Group>();
  private raycaster = new THREE.Raycaster();
  private mouse = new THREE.Vector2();
  private mouseInside = false;
  private rect: DOMRect | null = null;
  private down: { x: number; y: number; button: number } | null = null;
  private animating = new Set<THREE.Object3D>();
  private keys = new Set<string>();
  private clock = new THREE.Clock();

  // Reusable scratch objects & caches to avoid per-event / per-frame allocations
  private rayHits: THREE.Intersection[] = [];
  private tmpPt = new THREE.Vector3();
  private tmpNormal = new THREE.Vector3();
  private tmpPlane = new THREE.Plane(UP.clone(), 0);
  private tmpA = new THREE.Vector3();
  private tmpB = new THREE.Vector3();
  private tmpDir = new THREE.Vector3();
  private allPiecesCache: Piece[] = [];
  private movingOthersCache: Piece[] | null = null;
  private plotPole: Piece | null = null;
  private previewDirty = false;
  private hoverDirty = false;

  // Shared raid-path resources (reused to prevent GPU material/geometry leaks)
  private raidLineMat = new THREE.MeshBasicMaterial({ color: 0xff5a4a, transparent: true, opacity: 0.9, depthTest: false });
  private raidMarkMat = new THREE.MeshBasicMaterial({ color: 0xff5a4a, transparent: true, opacity: 0.35, depthTest: false });
  private raidTargetMat = new THREE.MeshBasicMaterial({ color: 0xffd166, depthTest: false });
  private raidCylGeo = new THREE.CylinderGeometry(0.06, 0.06, 1, 6);
  private raidSphereGeo = new THREE.SphereGeometry(0.55, 16, 12);
  private raidTorusGeo = new THREE.TorusGeometry(0.6, 0.07, 8, 32);

  activePart: string | null = null;
  /** piece being dragged to a new spot */
  moving: number | null = null;
  raidPick = false;
  private raidGroup = new THREE.Group();
  private grab: { id: number; x: number; y: number } | null = null;
  private ghost: THREE.Group | null = null;
  placement: Placement | null = null;
  verdict: Verdict | null = null;
  level = 0;
  showAll = true;
  snap = true;
  showTerritory = true;
  rotIndex = 0;
  freeYaw = 0;
  partLimit = 3000;
  selected: number | null = null;
  private hovered: number | null = null;
  /** set by the walk mode while it runs */
  frameHook: ((dt: number) => void) | null = null;

  constructor(private host: HTMLElement, private store: Store, private ev: EditorEvents = {}) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    host.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.05, 600);
    this.camera.position.set(22, 18, 26);

    const bg = new THREE.Color(0x0d1214);
    this.scene.background = bg;
    this.scene.fog = new THREE.Fog(bg, 90, 280);

    this.scene.add(new THREE.HemisphereLight(0xb9cddd, 0x2a3236, 1.35));
    this.sun = new THREE.DirectionalLight(0xfff0dc, 2.4);
    this.sun.position.set(35, 55, 20);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -45;
    sc.right = sc.top = 45;
    sc.near = 1;
    sc.far = 160;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun, this.sun.target);

    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(600, 600).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ map: groundTex(), roughness: 1 }),
    );
    const uv = this.ground.geometry.attributes.uv as THREE.BufferAttribute;
    const uvArr = uv.array as Float32Array;
    for (let i = 0; i < uvArr.length; i++) uvArr[i] *= 600;
    uv.needsUpdate = true;
    this.ground.receiveShadow = true;
    this.ground.userData.ground = true;
    this.scene.add(this.ground);

    this.grid = new THREE.GridHelper(GRID * 54, 54, 0x2b3a3f, 0x1d272b);
    this.grid.position.y = 0.01;
    this.scene.add(this.grid);
    this.levelGrid = new THREE.GridHelper(GRID * 14, 14, 0xb98a3e, 0x3a3226);
    (this.levelGrid.material as THREE.Material).transparent = true;
    (this.levelGrid.material as THREE.Material).opacity = 0.35;
    this.levelGrid.visible = false;
    this.scene.add(this.levelGrid);

    this.ring = this.makeRing();
    this.scene.add(this.ring);
    this.scene.add(this.world);
    this.scene.add(this.sites);
    this.scene.add(this.raidGroup);

    this.controls = new FlyCam(this.camera, this.renderer.domElement, this.keys);
    this.controls.lookAt(new THREE.Vector3(0, 1, 0));
    this.controls.leftLooks = () => !this.activePart && this.moving == null && !this.raidPick && !this.frameHook;

    const el = this.renderer.domElement;
    el.addEventListener('pointerenter', () => this.updateRect());
    el.addEventListener('pointermove', (e) => this.onMove(e));
    // capture phase: runs before the camera, so grabbing a part does not turn the view
    el.addEventListener(
      'pointerdown',
      (e) => {
        this.updateRect();
        this.down = { x: e.clientX, y: e.clientY, button: e.button };
        this.grab = null;
        if (e.button === 0 && !this.activePart && !this.frameHook && !this.raidPick) {
          this.ndc(e);
          const id = this.pick();
          if (id != null) {
            this.grab = { id, x: e.clientX, y: e.clientY };
            e.stopImmediatePropagation();
            el.setPointerCapture(e.pointerId);
          }
        }
      },
      { capture: true },
    );
    el.addEventListener('pointerup', (e) => this.onUp(e));
    el.addEventListener('pointerleave', () => {
      this.mouseInside = false;
      this.previewDirty = false;
      this.hoverDirty = false;
      if (this.ghost) this.ghost.visible = false;
      this.setHover(null);
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => {
      if (!(e.target as HTMLElement)?.closest?.('input,textarea,select')) this.keys.add(e.key.toLowerCase());
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());
    window.addEventListener('resize', () => this.updateRect());
    window.addEventListener('scroll', () => this.updateRect(), { passive: true });

    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    store.on(() => this.sync());
    this.sync();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  // ----------------------------------------------------------------- setup
  private makeRing() {
    const g = new THREE.Group();
    const R = TERRITORY_RADIUS;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(R - 0.12, R + 0.12, 160).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xe9a84a, transparent: true, opacity: 0.85, depthWrite: false }),
    );
    const disk = new THREE.Mesh(
      new THREE.CircleGeometry(R, 160).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xe9a84a, transparent: true, opacity: 0.035, depthWrite: false }),
    );
    ring.position.y = 0.04;
    disk.position.y = 0.03;
    g.add(ring, disk);
    g.visible = false;
    return g;
  }

  private updateRect() {
    this.rect = this.renderer.domElement.getBoundingClientRect();
  }

  private resize() {
    const w = this.host.clientWidth || 1;
    const h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.updateRect();
  }

  // ------------------------------------------------------------- syncing
  private sync() {
    const pieces = this.store.pieces;
    this.allPiecesCache = this.store.all();
    this.movingOthersCache = null;
    this.plotPole = null;

    for (const [id, obj] of this.objects) {
      if (!pieces.has(id)) {
        this.world.remove(obj);
        this.objects.delete(id);
        if (this.selected === id) this.select(null);
        if (this.hovered === id) this.setHover(null);
      }
    }
    for (const p of this.allPiecesCache) {
      if (!this.plotPole && hasOwn.call(PARTS, p.t) && PARTS[p.t].kind === 'plotpole') {
        this.plotPole = p;
      }
      const have = this.objects.get(p.id);
      if (have && have.userData.t === p.t) {
        have.position.set(p.x, p.y, p.z);
        have.rotation.y = p.r;
        continue;
      }
      if (have) this.world.remove(have);
      const obj = createPartObject(p.t);
      obj.userData.t = p.t;
      obj.position.set(p.x, p.y, p.z);
      obj.rotation.y = p.r;
      obj.userData.pieceId = p.id;
      obj.traverse((o) => {
        if (o !== obj) o.userData.pieceId = p.id;
      });
      this.objects.set(p.id, obj);
      this.world.add(obj);
    }
    this.applyVisibility();
    this.updateRing();
    this.refreshPreview();
  }

  applyVisibility() {
    for (const [id, obj] of this.objects) {
      const p = this.store.pieces.get(id);
      if (!p) continue;
      obj.visible = (this.showAll || p.l <= this.level) && id !== this.moving;
    }
    this.levelGrid.visible = this.level > 0;
    this.levelGrid.position.y = floorTop(this.level) + 0.01;
  }

  private updateRing() {
    if (this.activePart === 'plot_pole' && this.placement) {
      this.ring.visible = true;
      this.ring.position.set(this.placement.x, 0, this.placement.z);
    } else if (this.plotPole && this.showTerritory) {
      this.ring.visible = true;
      this.ring.position.set(this.plotPole.x, 0, this.plotPole.z);
    } else {
      this.ring.visible = false;
    }
  }

  // ------------------------------------------------------------ public API
  setLevel(l: number) {
    this.level = Math.max(0, Math.min(MAX_LEVEL, l));
    this.applyVisibility();
    this.refreshPreview();
  }

  setShowAll(v: boolean) {
    this.showAll = v;
    this.applyVisibility();
  }

  setActivePart(id: string | null) {
    if (this.moving != null) this.endMove(false);
    if (this.ghost) {
      this.scene.remove(this.ghost);
      this.ghost = null;
    }
    if (id !== this.activePart) this.resetOffset();
    this.activePart = id;
    this.placement = null;
    this.rotIndex = 0;
    if (id) {
      this.select(null);
      this.ghost = createGhost(id);
      this.ghost.visible = false;
      this.scene.add(this.ghost);
    }
    this.refreshPreview();
    this.updateRing();
    if (!id) this.ev.onPreview?.(null);
  }

  rotate(dir: 1 | -1, big = false) {
    this.rotIndex += dir;
    this.freeYaw += dir * (big ? Math.PI / 2 : Math.PI / 12);
    this.refreshPreview();
  }

  toggleSnap() {
    this.snap = !this.snap;
    this.refreshPreview();
    return this.snap;
  }

  setTerritoryVisible(v: boolean) {
    this.showTerritory = v;
    this.updateRing();
  }

  deleteSelected() {
    if (this.selected != null) this.store.remove([this.selected]);
  }

  select(id: number | null) {
    if (this.selected != null) {
      const o = this.objects.get(this.selected);
      if (o) setHighlight(o, false);
    }
    this.selected = id;
    if (id != null) {
      const o = this.objects.get(id);
      if (o) setHighlight(o, true, 0x7a4a00);
    }
    this.ev.onSelect?.(id != null ? this.store.pieces.get(id) ?? null : null);
  }

  /** where the camera looks, on the ground of the active storey */
  focusPoint() {
    return this.controls.focus(levelTop(this.level));
  }

  // ------------------------------------------------------- fine adjustment
  /** extra shift and turn on top of the snapped spot, for the part in hand */
  offset = new THREE.Vector3();
  offsetYaw = 0;

  hasOffset() {
    return this.offset.lengthSq() > 1e-10 || Math.abs(this.offsetYaw) > 1e-6;
  }

  resetOffset() {
    this.offset.set(0, 0, 0);
    this.offsetYaw = 0;
    this.refreshPreview();
  }

  /** World axes closest to the view: forward and right along the ground. */
  viewAxes() {
    const f = this.controls.forward();
    const fwd = Math.abs(f.x) > Math.abs(f.z) ? new THREE.Vector3(Math.sign(f.x), 0, 0) : new THREE.Vector3(0, 0, Math.sign(f.z) || -1);
    const right = new THREE.Vector3().crossVectors(fwd, UP);
    return { fwd, right };
  }

  /** Shift the part in hand, or else the selected part. Returns what moved. */
  nudge(v: THREE.Vector3, yaw = 0): 'hand' | 'piece' | null {
    if (this.activePart || this.moving != null) {
      this.offset.add(v);
      this.offsetYaw += yaw;
      this.refreshPreview();
      return 'hand';
    }
    if (this.selected != null) {
      const p = this.store.pieces.get(this.selected);
      if (!p) return null;
      const r = (n: number) => Math.round(n * 1000) / 1000;
      this.store.update(p.id, { x: r(p.x + v.x), y: r(p.y + v.y), z: r(p.z + v.z), r: p.r + yaw });
      return 'piece';
    }
    return null;
  }

  frameAll() {
    const box = new THREE.Box3();
    for (const o of this.objects.values()) box.expandByObject(o);
    for (const o of this.sites.children) box.expandByObject(o);
    if (box.isEmpty()) {
      this.camera.position.set(22, 18, 26);
      this.controls.lookAt(new THREE.Vector3(0, 1, 0));
      return;
    }
    const c = box.getCenter(new THREE.Vector3());
    const r = Math.max(8, box.getSize(new THREE.Vector3()).length() * 0.75);
    const dir = this.camera.position.clone().sub(this.focusPoint()).normalize();
    if (dir.y < 0.25) dir.setY(0.45).normalize();
    this.camera.position.copy(c).addScaledVector(dir, r * 1.4);
    this.controls.lookAt(c);
  }

  screenshot(): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }

  /** All meshes the walking player collides with. */
  colliders(): THREE.Object3D[] {
    const out: THREE.Object3D[] = [this.ground];
    for (const obj of this.objects.values()) {
      if (!obj.visible) continue;
      obj.traverse((o) => {
        if ((o as THREE.Mesh).isMesh && !o.userData.noCollide) out.push(o);
      });
    }
    if (this.sites.visible) {
      for (const site of this.sites.children) {
        if (!site.visible) continue;
        site.traverse((o) => {
          if ((o as THREE.Mesh).isMesh && !o.userData.noCollide && this.visibleChain(o.parent ?? o)) out.push(o);
        });
      }
    }
    return out;
  }

  toggleDoor(obj: THREE.Object3D) {
    // a door of a building: only that one
    for (let p: THREE.Object3D | null = obj; p; p = p.parent) {
      if (p.userData.houseDoor) {
        p.userData.door.target = p.userData.door.target < 0.5 ? 1 : 0;
        this.animating.add(p);
        return true;
      }
    }
    let root: THREE.Object3D | null = obj;
    while (root && root.parent !== this.world) root = root.parent;
    if (!root) return false;
    const pivots = findDoorPivots(root);
    if (!pivots.length) return false;
    const open = pivots[0].userData.door.target < 0.5;
    for (const p of pivots) {
      p.userData.door.target = open ? 1 : 0;
      this.animating.add(p);
    }
    return true;
  }

  closeAllDoors() {
    for (const p of findDoorPivots(this.sites)) {
      p.userData.door.target = 0;
      this.animating.add(p);
    }
    for (const obj of this.objects.values()) {
      for (const p of findDoorPivots(obj)) {
        p.userData.door.target = 0;
        this.animating.add(p);
      }
    }
  }

  setInteractive(on: boolean) {
    this.controls.enabled = on;
    if (!on && this.ghost) this.ghost.visible = false;
  }

  // ---------------------------------------------------------- interaction
  private ndc(e: PointerEvent) {
    const r = this.rect && this.rect.width > 0 && this.rect.height > 0
      ? this.rect
      : (this.rect = this.renderer.domElement.getBoundingClientRect());
    this.mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  private onMove(e: PointerEvent) {
    if (this.frameHook) return;
    this.ndc(e);
    this.mouseInside = true;
    if (this.grab && this.moving == null && Math.hypot(e.clientX - this.grab.x, e.clientY - this.grab.y) > 5) {
      this.startMove(this.grab.id);
    }
    if (this.activePart || this.moving != null) this.previewDirty = true;
    else if (!this.down) this.hoverDirty = true;
  }

  private onUp(e: PointerEvent) {
    const d = this.down;
    this.down = null;
    const grab = this.grab;
    this.grab = null;
    if (this.moving != null) {
      if (this.previewDirty) this.refreshPreview();
      this.endMove(true);
      return;
    }
    if (this.frameHook || !d || d.button !== e.button) return;
    if (this.raidPick && e.button === 0 && Math.hypot(e.clientX - d.x, e.clientY - d.y) <= 5) {
      this.pickRaidTarget();
      return;
    }
    if (grab && e.button === 0) {
      this.select(grab.id);
      return;
    }
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return;
    if (e.button === 0) {
      if (this.activePart) {
        if (this.previewDirty) this.refreshPreview();
        this.place();
      } else {
        this.select(this.pick());
      }
    } else if (e.button === 2 && this.activePart) {
      this.setActivePart(null);
      this.ev.onPreview?.(null);
    }
  }

  private visibleChain(o: THREE.Object3D) {
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
    return true;
  }

  private isMaterialVisible(o: THREE.Object3D) {
    const mat = (o as THREE.Mesh).material;
    if (!mat) return true;
    if (Array.isArray(mat)) return mat.some((m) => m.visible !== false);
    return mat.visible !== false;
  }

  private pick(): number | null {
    if (this.world.children.length === 0) return null;
    this.raycaster.setFromCamera(this.mouse, this.camera);
    this.rayHits.length = 0;
    this.raycaster.intersectObject(this.world, true, this.rayHits);
    let result: number | null = null;
    for (let i = 0; i < this.rayHits.length; i++) {
      const o = this.rayHits[i].object;
      if (this.isMaterialVisible(o) && this.visibleChain(o)) {
        result = (o.userData.pieceId as number) ?? null;
        break;
      }
    }
    this.rayHits.length = 0;
    return result;
  }

  private setHover(id: number | null) {
    if (id === this.hovered) return;
    if (this.hovered != null && this.hovered !== this.selected) {
      const o = this.objects.get(this.hovered);
      if (o) setHighlight(o, false);
    }
    this.hovered = id;
    if (id != null && id !== this.selected) {
      const o = this.objects.get(id);
      if (o) setHighlight(o, true, 0x2a2010);
    }
    this.renderer.domElement.style.cursor = id != null ? 'pointer' : '';
    this.ev.onHover?.(id != null ? this.store.pieces.get(id) ?? null : null);
  }

  private cursor(def: PartDef): Cursor {
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const planeY = def.kind === 'palisade' || def.kind === 'plotpole' ? 0 : levelTop(this.level);
    this.tmpPlane.constant = -planeY;
    const hitPlane = this.raycaster.ray.intersectPlane(this.tmpPlane, this.tmpPt);

    let bestDist = Infinity;
    let hit: Cursor['hit'] = null;

    const checkHits = (target: THREE.Object3D, recursive: boolean, filter?: (o: THREE.Object3D) => boolean) => {
      this.rayHits.length = 0;
      this.raycaster.intersectObject(target, recursive, this.rayHits);
      for (let i = 0; i < this.rayHits.length; i++) {
        const h = this.rayHits[i];
        if (h.distance >= bestDist) break;
        if (!h.face) continue;
        if (filter && !filter(h.object)) continue;
        this.tmpNormal.copy(h.face.normal).transformDirection(h.object.matrixWorld);
        if (this.tmpNormal.y > 0.6) {
          bestDist = h.distance;
          hit = { x: h.point.x, y: h.point.y, z: h.point.z };
          break;
        }
      }
    };

    if (this.world.children.length > 0) {
      checkHits(this.world, true, (o) => this.isMaterialVisible(o) && this.visibleChain(o));
    }
    if (this.sites.visible && this.sites.children.length > 0) {
      checkHits(this.sites, true, (o) => !o.userData.walkOnly && !o.userData.noCollide && this.visibleChain(o));
    }
    checkHits(this.ground, false);
    this.rayHits.length = 0;

    return { plane: hitPlane ? { x: this.tmpPt.x, z: this.tmpPt.z } : null, hit };
  }

  private previewPart() {
    if (this.moving != null) return this.store.pieces.get(this.moving)?.t ?? null;
    return this.activePart;
  }

  private otherPieces() {
    if (this.moving == null) return this.allPiecesCache;
    if (!this.movingOthersCache) {
      this.movingOthersCache = this.allPiecesCache.filter((p) => p.id !== this.moving);
    }
    return this.movingOthersCache;
  }

  refreshPreview() {
    this.previewDirty = false;
    const part = this.previewPart();
    if (!part || !this.ghost) return;
    const def = hasOwn.call(PARTS, part) ? PARTS[part] : undefined;
    if (!def) return;
    if (!this.mouseInside) {
      this.ghost.visible = false;
      return;
    }
    const others = this.otherPieces();
    let pl = computePlacement(def, this.cursor(def), {
      pieces: others, level: this.level, rotIndex: this.rotIndex, freeYaw: this.freeYaw, snap: this.snap,
    });
    if (pl && this.hasOffset()) {
      const o = this.offset;
      pl = { ...pl, x: pl.x + o.x, y: pl.y + o.y, z: pl.z + o.z, r: pl.r + this.offsetYaw };
    }
    this.placement = pl;
    if (!pl) {
      this.ghost.visible = false;
      this.verdict = null;
      this.ev.onPreview?.({ part, verdict: null, snapped: false });
      this.updateRing();
      return;
    }
    this.ghost.visible = true;
    this.ghost.position.set(pl.x, pl.y, pl.z);
    this.ghost.rotation.y = pl.r;
    this.verdict = validate(def, pl, others, this.partLimit + (this.moving != null ? 1 : 0));
    setGhostValid(this.ghost, this.verdict.ok);
    this.ev.onPreview?.({ part, verdict: this.verdict, snapped: pl.snapped });
    this.updateRing();
  }

  // ---------------------------------------------------------- raid path
  setRaidPick(on: boolean) {
    if (on) this.setActivePart(null);
    this.raidPick = on;
    this.renderer.domElement.style.cursor = on ? 'crosshair' : '';
    this.ev.onRaidPick?.(on);
  }

  private pickRaidTarget() {
    this.raycaster.setFromCamera(this.mouse, this.camera);
    let hit: THREE.Intersection | null = null;
    if (this.world.children.length > 0) {
      this.rayHits.length = 0;
      this.raycaster.intersectObject(this.world, true, this.rayHits);
      for (let i = 0; i < this.rayHits.length; i++) {
        const o = this.rayHits[i].object;
        if (this.isMaterialVisible(o) && this.visibleChain(o)) {
          hit = this.rayHits[i];
          break;
        }
      }
    }
    if (!hit) {
      this.rayHits.length = 0;
      this.raycaster.intersectObject(this.ground, false, this.rayHits);
      hit = this.rayHits[0] ?? null;
    }
    this.rayHits.length = 0;
    if (!hit) return;
    const id = hit.object.userData.pieceId as number | undefined;
    const p = id != null ? this.store.pieces.get(id) : undefined;
    let l = p ? p.l : 0;
    const def = p && hasOwn.call(PARTS, p.t) ? PARTS[p.t] : undefined;
    // clicking the top of a wall or a floor seen from above: use the storey you stand on
    if (p && def?.kind === 'floor' && hit.point.y < p.y - 0.05) l = Math.max(0, p.l - 1);
    this.setRaidPick(false);
    this.ev.onRaidTarget?.({ x: hit.point.x, z: hit.point.z, l });
  }

  showRaidPath(path: { x: number; y: number; z: number }[], target: { x: number; z: number; l: number } | null, marks: number[]) {
    this.clearRaidPath();
    for (let i = 1; i < path.length; i++) {
      this.tmpA.set(path[i - 1].x, path[i - 1].y, path[i - 1].z);
      this.tmpB.set(path[i].x, path[i].y, path[i].z);
      const len = this.tmpA.distanceTo(this.tmpB);
      if (len < 1e-3) continue;
      const seg = new THREE.Mesh(this.raidCylGeo, this.raidLineMat);
      seg.scale.set(1, len, 1);
      seg.position.copy(this.tmpA).add(this.tmpB).multiplyScalar(0.5);
      seg.quaternion.setFromUnitVectors(UP, this.tmpDir.copy(this.tmpB).sub(this.tmpA).normalize());
      seg.renderOrder = 999;
      this.raidGroup.add(seg);
    }
    for (const id of marks) {
      const p = this.store.pieces.get(id);
      if (!p) continue;
      const m = new THREE.Mesh(this.raidSphereGeo, this.raidMarkMat);
      m.position.set(p.x, p.y + 1.2, p.z);
      m.renderOrder = 998;
      this.raidGroup.add(m);
    }
    if (target) {
      const ring = new THREE.Mesh(this.raidTorusGeo, this.raidTargetMat);
      ring.rotation.x = Math.PI / 2;
      ring.position.set(target.x, floorTop(target.l) + 0.05, target.z);
      ring.renderOrder = 999;
      this.raidGroup.add(ring);
    }
  }

  clearRaidPath() {
    this.raidGroup.clear();
  }

  private startMove(id: number) {
    const p = this.store.pieces.get(id);
    if (!p) return;
    const def = hasOwn.call(PARTS, p.t) ? PARTS[p.t] : undefined;
    if (!def) return;
    this.select(null);
    this.setHover(null);
    this.moving = id;
    this.movingOthersCache = null;
    this.rotIndex = 0;
    this.resetOffset();
    this.freeYaw = p.r;
    if (this.level !== p.l && def.kind !== 'palisade' && def.kind !== 'plotpole') this.setLevel(p.l);
    this.ghost = createGhost(p.t);
    this.ghost.visible = false;
    this.scene.add(this.ghost);
    this.applyVisibility();
    this.ev.onMoveChange?.(true);
  }

  /** Finish a drag: commit when the spot is valid, otherwise snap back. */
  endMove(commit: boolean) {
    const id = this.moving;
    if (id == null) return;
    const pl = this.placement;
    const ok = commit && pl && this.verdict?.ok;
    this.moving = null;
    this.movingOthersCache = null;
    if (this.ghost) {
      this.scene.remove(this.ghost);
      this.ghost = null;
    }
    this.placement = null;
    this.applyVisibility();
    if (ok && pl) this.store.update(id, { x: pl.x, y: pl.y, z: pl.z, r: pl.r, l: pl.l });
    else if (commit && this.verdict && !this.verdict.ok) this.ev.onMoveRejected?.(this.verdict.reason ?? '');
    this.select(id);
    this.ev.onMoveChange?.(false);
    this.ev.onPreview?.(null);
  }

  private place() {
    if (!this.activePart || !this.placement || !this.verdict) return;
    if (!this.verdict.ok) return;
    const { x, y, z, r, l } = this.placement;
    this.store.add({ t: this.activePart, x, y, z, r, l });
  }

  // --------------------------------------------------------------- loop
  private frame() {
    const dt = Math.min(0.05, this.clock.getDelta());
    if (this.frameHook) {
      this.frameHook(dt);
    } else {
      const moved = this.controls.update(dt);
      if (this.activePart || this.moving != null) {
        if (moved || this.previewDirty) this.refreshPreview();
      } else if (this.hoverDirty) {
        this.hoverDirty = false;
        if (!this.down) this.setHover(this.pick());
      }
    }
    for (const p of this.animating) if (!stepDoor(p, dt)) this.animating.delete(p);
    const t = this.frameHook ? this.camera.position : this.focusPoint();
    this.sun.position.set(t.x + 35, 55, t.z + 20);
    this.sun.target.position.set(t.x, 0, t.z);
    this.renderer.render(this.scene, this.camera);
  }
}
