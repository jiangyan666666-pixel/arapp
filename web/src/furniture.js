// 1:1 furniture with a parametric *width*. The width is the hidden variable of
// each trial, so it must be settable to the millimetre without any UI showing it.
//
// Two kinds of models:
//   - procedural: rebuilt from boxes at the requested width (shelf, sideboard)
//   - gltf: a CC0 model scaled along X only, about its centre, from its nominal width
//     (a few cm either way is visually acceptable for shelves/cabinets)

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export const MODELS = [
  { id: 'shelf', label: '书架（高 180 · 深 30）', kind: 'procedural', height: 1.8, depth: 0.3 },
  { id: 'sideboard', label: '矮柜（高 80 · 深 40）', kind: 'procedural', height: 0.8, depth: 0.4 },
  // A CC0 glTF goes here (Poly Haven / Sketchfab CC0). Put the file in public/models/.
  // { id: 'ph-shelf', label: 'Poly Haven 书架', kind: 'gltf', url: '/models/shelf.glb', nominalWidth: 0.8 },
];

const WOOD = 0xb08968;
const WOOD_DARK = 0x6e4b2a;

function box(w, h, d, material) {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
}

function buildShelf(w, def, mats) {
  const { height: h, depth: d } = def;
  const t = 0.018;
  const g = new THREE.Group();
  const left = box(t, h, d, mats.wood);
  left.position.set(-(w - t) / 2, h / 2, 0);
  const right = left.clone();
  right.position.x = (w - t) / 2;
  const top = box(w - 2 * t, t, d, mats.wood);
  top.position.set(0, h - t / 2, 0);
  const bottom = top.clone();
  bottom.position.y = 0.06 + t / 2;
  const plinth = box(w - 2 * t, 0.06, d - 0.04, mats.dark);
  plinth.position.set(0, 0.03, -0.02);
  const back = box(w - 2 * t, h - 2 * t, 0.006, mats.dark);
  back.position.set(0, h / 2, -d / 2 + 0.003);
  g.add(left, right, top, bottom, plinth, back);
  const nShelves = Math.max(1, Math.round(h / 0.38) - 1);
  const y0 = 0.06 + t;
  const y1 = h - t;
  for (let i = 1; i <= nShelves; i++) {
    const shelf = box(w - 2 * t, t, d - 0.012, mats.wood);
    shelf.position.set(0, y0 + ((y1 - y0) * i) / (nShelves + 1), 0.006);
    g.add(shelf);
  }
  return g;
}

function buildSideboard(w, def, mats) {
  const { height: h, depth: d } = def;
  const g = new THREE.Group();
  // outer width is exactly w (the hidden trial width): the top is the widest part
  const carcass = box(w - 0.02, h - 0.08, d - 0.02, mats.wood);
  carcass.position.set(0, 0.08 + (h - 0.08) / 2, -0.01);
  const top = box(w, 0.02, d, mats.dark);
  top.position.set(0, h - 0.01, 0);
  g.add(carcass, top);
  for (const sx of [-1, 1]) {
    const door = box(w / 2 - 0.03, h - 0.14, 0.012, mats.dark);
    door.position.set((sx * w) / 4, 0.08 + (h - 0.08) / 2, d / 2 - 0.006);
    g.add(door);
    const leg = box(0.03, 0.08, 0.03, mats.dark);
    leg.position.set(sx * (w / 2 - 0.04), 0.04, d / 2 - 0.04);
    const leg2 = leg.clone();
    leg2.position.z = -d / 2 + 0.04;
    g.add(leg, leg2);
  }
  return g;
}

const BUILDERS = { shelf: buildShelf, sideboard: buildSideboard };

/**
 * A procedural model at an exact outer width (metres), origin at the bottom centre,
 * front facing +Z. No DOM needed, so it also runs in Node (tools/make_usdz.mjs).
 */
export function buildFurnitureGroup(modelId, width) {
  const model = MODELS.find((m) => m.id === modelId && m.kind === 'procedural');
  if (!model) throw new Error(`no procedural model "${modelId}"`);
  const mats = {
    wood: new THREE.MeshStandardMaterial({ color: WOOD, roughness: 0.8, metalness: 0 }),
    dark: new THREE.MeshStandardMaterial({ color: WOOD_DARK, roughness: 0.85, metalness: 0 }),
  };
  return BUILDERS[model.id](width, model, mats);
}

function blobShadowTexture() {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(0,0,0,0.5)');
  grad.addColorStop(0.55, 'rgba(0,0,0,0.3)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function disposeTree(obj) {
  obj.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
  });
}

export class Furniture {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'furniture';
    this.group.visible = false;
    this.inner = new THREE.Group();
    this.group.add(this.inner);
    this.mats = {
      wood: new THREE.MeshStandardMaterial({ color: WOOD, roughness: 0.8, metalness: 0 }),
      dark: new THREE.MeshStandardMaterial({ color: WOOD_DARK, roughness: 0.85, metalness: 0 }),
    };
    this.lineMaterial = new THREE.LineBasicMaterial({ color: 0x24150a });
    this.shadowMaterial = new THREE.MeshBasicMaterial({ map: blobShadowTexture(), transparent: true, depthWrite: false });
    this.edges = null;
    this.shadow = null;
    this.model = null;
    this.gltfScene = null;
    this.nominalWidth = 1;
    this.width = 0;
    this.height = 0;
    this.depth = 0;
    this.yaw = 0;
    this._v = new THREE.Vector3();
    this._box = new THREE.Box3();
  }

  async load(model) {
    this.model = model;
    this.gltfScene = null;
    if (model.kind === 'gltf') {
      const gltf = await new GLTFLoader().loadAsync(model.url);
      const sceneRoot = gltf.scene;
      const bb = this._box.setFromObject(sceneRoot);
      const size = bb.getSize(new THREE.Vector3());
      const center = bb.getCenter(new THREE.Vector3());
      // centre in x/z, bottom on y = 0, so scaling X keeps the centre fixed
      sceneRoot.position.set(-center.x, -bb.min.y, -center.z);
      const holder = new THREE.Group();
      holder.add(sceneRoot);
      this.gltfScene = holder;
      this.nominalWidth = model.nominalWidth || size.x;
      this.height = size.y;
      this.depth = size.z;
    } else {
      this.height = model.height;
      this.depth = model.depth;
    }
  }

  /** @param {number} metres hidden trial width */
  setWidth(metres) {
    this.width = metres;
    disposeTree(this.inner);
    this.inner.clear();
    if (this.gltfScene) {
      this.gltfScene.scale.set(metres / this.nominalWidth, 1, 1);
      this.inner.add(this.gltfScene);
    } else {
      this.inner.add(BUILDERS[this.model.id](metres, this.model, this.mats));
    }
    this.rebuildExtras();
  }

  rebuildExtras() {
    if (this.edges) {
      this.group.remove(this.edges, this.shadow);
      this.edges.geometry.dispose();
      this.shadow.geometry.dispose();
    }
    const w = this.width;
    const h = this.height;
    const d = this.depth;
    const outline = new THREE.BoxGeometry(w, h, d).translate(0, h / 2, 0);
    this.edges = new THREE.LineSegments(new THREE.EdgesGeometry(outline), this.lineMaterial);
    outline.dispose();
    const sg = new THREE.PlaneGeometry(w * 1.5, d * 1.8).rotateX(-Math.PI / 2).translate(0, 0.01, 0);
    this.shadow = new THREE.Mesh(sg, this.shadowMaterial);
    this.group.add(this.edges, this.shadow);
  }

  placeAt(position) {
    this.group.position.copy(position);
    this.group.visible = true;
  }

  setYaw(rad) {
    this.yaw = rad;
    this.group.rotation.set(0, rad, 0);
  }

  nudge(vec) {
    this.group.position.add(vec);
  }

  center(target = this._v) {
    return target.copy(this.group.position).setY(this.group.position.y + this.height / 2);
  }

  pose() {
    const p = this.group.position;
    return { x: p.x, y: p.y, z: p.z, yaw_deg: THREE.MathUtils.radToDeg(this.yaw) };
  }
}
