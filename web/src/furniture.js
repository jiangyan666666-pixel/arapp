// 1:1 furniture with a parametric *width*. The width is the hidden variable of
// each trial, so it must be settable to the millimetre without any UI showing it.
//
// Two kinds of models:
//   - procedural: rebuilt from boxes at the requested width (shelf, sideboard); the numbers
//     live in furniture-spec.js, shared with the native AR layer
//   - gltf: a CC0 model scaled along X only, about its centre, from its nominal width
//     (a few cm either way is visually acceptable for shelves/cabinets)

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { COLORS, MODELS, ROUGHNESS, furnitureBoxes } from './furniture-spec.js';

export { MODELS };

const WOOD = COLORS.wood;
const WOOD_DARK = COLORS.dark;

/** The boxes of furniture-spec.js as three.js meshes. mats: {wood, dark}. */
function buildGroup(modelId, width, mats) {
  const g = new THREE.Group();
  for (const b of furnitureBoxes(modelId, width)) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...b.size), mats[b.material]);
    mesh.position.set(...b.position);
    g.add(mesh);
  }
  return g;
}

/**
 * A procedural model at an exact outer width (metres), origin at the bottom centre,
 * front facing +Z. No DOM needed, so it also runs in Node (tools/make_usdz.mjs).
 */
export function buildFurnitureGroup(modelId, width) {
  const mats = {
    wood: new THREE.MeshStandardMaterial({ color: WOOD, roughness: ROUGHNESS.wood, metalness: 0 }),
    dark: new THREE.MeshStandardMaterial({ color: WOOD_DARK, roughness: ROUGHNESS.dark, metalness: 0 }),
  };
  return buildGroup(modelId, width, mats);
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
      this.inner.add(buildGroup(this.model.id, metres, this.mats));
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
