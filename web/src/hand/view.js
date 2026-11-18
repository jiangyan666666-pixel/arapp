// Shows the hand model in the AR picture: the 16 boxes of pose.js as a group of boxes the native
// layer draws (docs/protocol.md §5), optionally their shadow on the table under the hand, and
// optionally a drawing on a <canvas> in the web page above the AR picture (the native picture is
// under the transparent page), which the real hand can never hide.
// The group is created once per look; every frame only moves its boxes (one fire-and-forget
// ar.updateGroups per hand event, carrying the frame's time so ar.status.latency can measure
// camera frame -> boxes moved). The hand group is NOT anchored: an anchored group re-anchors on
// every absolute pose, and the hand gets a new absolute pose every frame.
//
// API
//   LOOKS = ['translucent', 'solid', 'edges', 'occluder', 'model', 'off']
//     translucent  light blue, opacity 0.45        solid   opaque light blue
//     edges        the 12 edges of each box (native style 'edges')
//     occluder     invisible boxes that hide virtual things behind them (material 'occlusion')
//                  plus thin edges so the hand model can be seen
//     model        the hand as a thing like the furniture: opaque, the furniture's wood colour and
//                  roughness (furniture-spec.js), the palm a shade darker ("the hand as a model",
//                  layer 1; with a shell over 1 it covers the real hand)
//     off          nothing drawn natively (tracking, the overlay and lastRows still work)
//   Person occlusion is switched off while the look stands in for the real hand ('occluder',
//   'model') or the real hand is erased (the real hand would hide the boxes that stand for it), and
//   restored when that ends.
//   erase = {on, mask?, dilate?, feather?, …}: the native erase option (docs/protocol.md §2,
//   ios/ARApp/HandEraser.swift; layer 2): the real hand erased from the camera picture. Sent only
//   when it changes, and only once it has been on (an app without it never hears of it).
//   SHELLS = [1, 1.15, 1.3]   box size factor (sizes travel with every frame, so no rebuild)
//   OVERLAYS = ['off', 'joints', 'boxes']
//     joints  Vision's 2D joints of the frame, through its display transform
//     boxes   the 16 boxes projected with the frame's own camera
//   new HandView({ar, groupId = 'hand', shadowId = 'hand-shadow', overlayCanvas = null,
//                 personOcclusion = true})
//   init(model) -> Promise     (re)creates the groups; call after every ar.start (a start with
//                              reset removes all groups)
//   setModel(model) -> Promise new sizes (rebuilds once)
//   set({look, shell, overlay, shadow, erase}) -> Promise   changes only what differs; a new look
//                              rebuilds the group once, never per frame; erase: true / false or a
//                              config object (merged into the current one)
//   look, shell, overlay, shadow, erase   current settings
//   personOcclusion            what the page wants while the look does not stand in for the hand
//   show(pose, frameT, frame?) moves the boxes (one ar.updateGroups for hand + shadow); draws the overlay
//   hide(frame?)               hides the groups (one message, only on the change); the overlay
//                              still draws the frame's joints in 'joints' mode
//   setPlanes(planes)          the ar.planes list; the shadow falls on the plane just under the palm
//   lastRows                   the last poseBoxes rows sent (world boxes; e.g. for contact tests)
//   dispose() -> Promise       removes both groups, restores person occlusion, erasing off, clears
//                              the overlay
// Helpers
//   planeUnder(planes, p, {maxBelow = 0.8, margin = 0.1}) -> {id, class, y, p, n} | null
//     the highest horizontal plane below the point p whose extent (grown by margin) contains it
//   rowCorners(row) -> [[x, y, z] x 8]   corners of a poseBoxes row (index bits = +x, +y, +z)
//   rowBox(row) -> {c, x, y, z, h}       centre, unit axes, half sizes

import { CHAIN, FINGERS, PALM_JOINTS } from './joints.js';
import { add, sub, scale, dot, cross, norm, len, quatRotate, quatFromBasis, project, imageToView } from './geom.js';
import { segmentSizes } from './model.js';
import { poseBoxes, palmBoxCentre } from './pose.js';
import { onPlane } from './scan.js';
import { COLORS, ROUGHNESS } from '../furniture-spec.js';

export const LOOKS = ['translucent', 'solid', 'edges', 'occluder', 'model', 'off'];
/** Looks that stand in for the real hand: person occlusion is off while they show. */
const OWN_HAND_LOOKS = ['occluder', 'model'];
const srgb = (hex) => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
export const SHELLS = [1, 1.15, 1.3];
export const OVERLAYS = ['off', 'joints', 'boxes'];

const N = 16;
const SHADOW_LIFT = 0.004; // above the plane: the LiDAR mesh (real-object occlusion) of the table is a few mm noisy
const SHADOW_THICK = 0.001;

function boxLooks(look) {
  switch (look) {
    case 'solid':
      return [{ color: [0.42, 0.66, 0.92], opacity: 1, material: 'pbr', roughness: 0.6 }];
    case 'edges':
      return [{ color: [0.35, 0.9, 1], material: 'unlit', style: 'edges', edge: 0.0015 }];
    case 'occluder':
      return [{ material: 'occlusion' }, { color: [1, 1, 1], material: 'unlit', style: 'edges', edge: 0.001, opacity: 0.9 }];
    case 'model':
      return [{ color: srgb(COLORS.wood), opacity: 1, material: 'pbr', roughness: ROUGHNESS.wood }];
    case 'translucent':
    default:
      return [{ color: [0.55, 0.8, 1], opacity: 0.45, material: 'pbr', roughness: 0.5 }];
  }
}

export function planeUnder(planes, p, { maxBelow = 0.8, margin = 0.1 } = {}) {
  let best = null;
  for (const pl of planes || []) {
    if (pl.alignment !== 'horizontal' || !Array.isArray(pl.transform) || pl.class === 'ceiling') continue;
    const T = pl.transform;
    const n = norm([T[4], T[5], T[6]]);
    if (n[1] < 0.9) continue;
    const o = [T[12], T[13], T[14]];
    const h = dot(sub(p, o), n);
    if (h < -0.02 || h > maxBelow) continue;
    // on the plane (its boundary polygon, else its turned extent; plane space x, z), grown by the margin
    const d = sub(p, o);
    const lx = dot(d, norm([T[0], T[1], T[2]]));
    const lz = dot(d, norm([T[8], T[9], T[10]]));
    if (!onPlane(pl, lx, lz, margin)) continue;
    if (!best || h < best.h) best = { id: pl.id, class: pl.class, y: o[1], p: o, n, h };
  }
  if (!best) return null;
  const { h, ...out } = best;
  return out;
}

export function rowBox(r) {
  const q = [r[4], r[5], r[6], r[7]];
  return {
    c: [r[1], r[2], r[3]],
    x: quatRotate(q, [1, 0, 0]),
    y: quatRotate(q, [0, 1, 0]),
    z: quatRotate(q, [0, 0, 1]),
    h: [r[8] / 2, r[9] / 2, r[10] / 2],
  };
}

export function rowCorners(r) {
  const b = rowBox(r);
  const out = [];
  for (let k = 0; k < 8; k++) {
    const sx = k & 1 ? 1 : -1;
    const sy = k & 2 ? 1 : -1;
    const sz = k & 4 ? 1 : -1;
    out.push(add(b.c, add(add(scale(b.x, sx * b.h[0]), scale(b.y, sy * b.h[1])), scale(b.z, sz * b.h[2]))));
  }
  return out;
}

const EDGES = [];
for (let i = 0; i < 8; i++) for (const bit of [1, 2, 4]) if (!(i & bit)) EDGES.push([i, i | bit]);

/** The flat shadow of a box on a plane straight below it: [px, py, pz, qx, qy, qz, qw, sx, sy, sz]. */
function shadowRow(r, plane) {
  const b = rowBox(r);
  const n = plane.n;
  // the footprint's long direction: the bone's own direction flattened (or its width when the bone stands up)
  let along = sub(b.z, scale(n, dot(b.z, n)));
  if (len(along) < 0.3) along = sub(b.x, scale(n, dot(b.x, n)));
  along = norm(along);
  const across = cross(n, along);
  const extent = (dir) => 2 * (Math.abs(dot(b.x, dir)) * b.h[0] + Math.abs(dot(b.y, dir)) * b.h[1] + Math.abs(dot(b.z, dir)) * b.h[2]);
  const c = add(sub(b.c, scale(n, dot(sub(b.c, plane.p), n))), scale(n, SHADOW_LIFT));
  const q = quatFromBasis(across, n, along);
  return [c[0], c[1], c[2], q[0], q[1], q[2], q[3], extent(across), SHADOW_THICK, extent(along)];
}

export class HandView {
  constructor({ ar, groupId = 'hand', shadowId = 'hand-shadow', overlayCanvas = null, personOcclusion = true }) {
    this.ar = ar;
    this.groupId = groupId;
    this.shadowId = shadowId;
    this.canvas = overlayCanvas;
    this.personOcclusion = personOcclusion;
    this.model = null;
    this.look = 'translucent';
    this.shell = 1;
    this.overlay = 'off';
    this.shadow = true;
    this.planes = [];
    this.lastRows = null;
    this._created = false;
    this._shown = false; // the hand group is visible on the native side
    this._shadowShown = false;
    this._occluding = false; // person occlusion is off because of the look or the erasing
    this.erase = { on: false };
    this._sentErase = null; // the erase config last sent (JSON), null = none since init
    this._overlayDrawn = false;
  }

  async init(model) {
    if (model) this.model = model;
    this._created = false;
    this._occluding = null; // a new session: send person occlusion once whatever it was before
    this._sentErase = null; // … and the erase config, if it is on
    this._shown = false;
    this._shadowShown = false;
    await this._build();
  }

  async setModel(model) {
    this.model = model;
    if (this._created) await this._build();
  }

  async set({ look, shell, overlay, shadow, erase } = {}) {
    let rebuild = false;
    if (look !== undefined && look !== this.look && LOOKS.includes(look)) {
      this.look = look;
      rebuild = true;
    }
    if (shell !== undefined && Number.isFinite(shell) && shell > 0) this.shell = shell; // sizes go with every frame
    if (overlay !== undefined && OVERLAYS.includes(overlay) && overlay !== this.overlay) {
      this.overlay = overlay;
      this._clearOverlay();
    }
    if (shadow !== undefined && Boolean(shadow) !== this.shadow) {
      this.shadow = Boolean(shadow);
      if (!this.shadow && this._shadowShown) {
        this._shadowShown = false;
        this.ar.updateGroups([{ id: this.shadowId, visible: false }]);
      }
    }
    if (erase !== undefined && erase !== null) {
      const next = typeof erase === 'object' ? { ...this.erase, ...erase } : { ...this.erase, on: Boolean(erase) };
      next.on = Boolean(next.on);
      delete next.probe; // one-shot: the page asks for a probe itself
      this.erase = next;
    }
    await this._syncNative();
    if (rebuild && this._created) await this._build();
  }

  /**
   * Person occlusion off while the look stands in for the real hand or the real hand is erased
   * (else the real hand hides its own model), back after; the erase config when it changed.
   */
  async _syncNative(look = this.look, erase = this.erase) {
    const opts = {};
    const off = OWN_HAND_LOOKS.includes(look) || Boolean(erase.on);
    if (off !== this._occluding) {
      this._occluding = off;
      opts.personOcclusion = off ? false : this.personOcclusion;
    }
    const e = JSON.stringify(erase);
    if (e !== this._sentErase && (erase.on || this._sentErase !== null)) opts.erase = erase;
    if (!Object.keys(opts).length) return;
    try {
      await this.ar.setOptions(opts);
      if (opts.erase) this._sentErase = e;
    } catch {
      // AR not running: the page sets these again when it starts (init)
    }
  }

  async _build() {
    if (!this.model) return;
    const sizes = segmentSizes(this.model, this.shell);
    const looks = boxLooks(this.look);
    const rows = this.lastRows;
    const boxes = [];
    for (const lk of looks) {
      for (let i = 0; i < N; i++) {
        const r = rows?.[i];
        boxes.push({
          size: r ? [r[8], r[9], r[10]] : sizes[i],
          position: r ? [r[1], r[2], r[3]] : [0, -10, 0],
          rotation: r ? [r[4], r[5], r[6], r[7]] : [0, 0, 0, 1],
          ...lk,
          ...(i === 0 && lk.color && lk.material !== 'unlit' ? { color: lk.color.map((v) => v * 0.85) } : {}),
        });
      }
    }
    const visible = this.look !== 'off' && this._shown;
    // setGroup is posted now, before the await: every update show() sends from here on reaches
    // the native layer after it, so it must already carry the new number of layers
    this._layers = looks.length;
    await this.ar.setGroup(this.groupId, boxes, { visible });
    const shadowBoxes = Array.from({ length: N }, () => ({ size: [0.01, SHADOW_THICK, 0.01], position: [0, -10, 0], color: [0, 0, 0], opacity: 0.3, material: 'unlit' }));
    await this.ar.setGroup(this.shadowId, shadowBoxes, { visible: false });
    this._shadowShown = false;
    this._created = true;
    await this._syncNative();
  }

  setPlanes(planes) {
    if (Array.isArray(planes)) this.planes = planes;
  }

  show(pose, frameT, frame = null) {
    if (!this.model || !pose) return this.hide(frame);
    const rows = poseBoxes(this.model, pose, { shell: this.shell });
    this.lastRows = rows;
    const updates = [];
    if (this._created && this.look !== 'off') {
      let boxes = rows;
      if (this._layers > 1) {
        // the 'occluder' look: the same 16 boxes twice (occlusion, then edges)
        boxes = rows.concat(rows.map((r) => [r[0] + N, ...r.slice(1)]));
      }
      updates.push({ id: this.groupId, visible: true, boxes });
      this._shown = true;
    }
    if (this._created) {
      const plane = this.shadow && this.look !== 'off' ? this._planeUnderPalm(pose) : null;
      if (plane) {
        updates.push({ id: this.shadowId, visible: true, boxes: rows.map((r) => [r[0], ...shadowRow(r, plane)]) });
        this._shadowShown = true;
      } else if (this._shadowShown) {
        updates.push({ id: this.shadowId, visible: false });
        this._shadowShown = false;
      }
    }
    if (updates.length) this.ar.updateGroups(updates, frameT);
    this._drawOverlay(frame, rows, pose);
  }

  hide(frame = null) {
    const updates = [];
    if (this._shown) updates.push({ id: this.groupId, visible: false });
    if (this._shadowShown) updates.push({ id: this.shadowId, visible: false });
    this._shown = false;
    this._shadowShown = false;
    if (updates.length && this._created) this.ar.updateGroups(updates);
    this._drawOverlay(frame, null, null);
  }

  _planeUnderPalm(pose) {
    if (!this.planes.length) return null;
    const c = add(pose.palm.origin, quatRotate(pose.palm.rotation, palmBoxCentre(this.model, pose.chirality)));
    return planeUnder(this.planes, c);
  }

  async dispose() {
    this._created = false;
    this._shown = false;
    this._clearOverlay();
    this.erase = { ...this.erase, on: false };
    await this._syncNative('off', this.erase);
    for (const id of [this.groupId, this.shadowId]) {
      try {
        await this.ar.removeGroup(id);
      } catch {
        // gone already
      }
    }
  }

  // --- the web-layer overlay ---

  _ctx() {
    const c = this.canvas;
    if (!c || typeof window === 'undefined') return null;
    const w = c.clientWidth || window.innerWidth;
    const h = c.clientHeight || window.innerHeight;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }

  _clearOverlay() {
    if (!this._overlayDrawn) return;
    const g = this._ctx();
    if (g) g.ctx.clearRect(0, 0, g.w, g.h);
    this._overlayDrawn = false;
  }

  _drawOverlay(frame, rows, pose) {
    if (this.overlay === 'off' || !this.canvas) return this._clearOverlay();
    const g = this._ctx();
    if (!g) return;
    const { ctx, w, h } = g;
    ctx.clearRect(0, 0, w, h);
    this._overlayDrawn = true;
    if (!frame?.display) return;
    const toScreen = (x, y) => {
      const [X, Y] = imageToView(frame.display, x, y);
      return [X * w, Y * h];
    };
    if (this.overlay === 'joints') {
      for (const hand of frame.hands) {
        const mine = pose && pose.quality?.hand === hand.index;
        const seen = (j) => hand.joints[j].c >= 0.3;
        const pt = (j) => toScreen(hand.joints[j].x, hand.joints[j].y);
        ctx.lineWidth = 2;
        ctx.strokeStyle = mine ? 'rgba(90, 220, 255, 0.9)' : 'rgba(255, 180, 80, 0.85)';
        ctx.beginPath();
        for (const f of FINGERS) {
          const chain = [0, ...CHAIN[f]];
          for (let s = 0; s + 1 < chain.length; s++) {
            if (!seen(chain[s]) || !seen(chain[s + 1])) continue;
            ctx.moveTo(...pt(chain[s]));
            ctx.lineTo(...pt(chain[s + 1]));
          }
        }
        ctx.stroke();
        for (let j = 0; j < 21; j++) {
          if (!seen(j)) continue;
          const [x, y] = pt(j);
          ctx.fillStyle = PALM_JOINTS.includes(j) ? '#ffffff' : mine ? '#5adcff' : '#ffb450';
          ctx.beginPath();
          ctx.arc(x, y, 3.2, 0, 2 * Math.PI);
          ctx.fill();
        }
      }
      return;
    }
    // 'boxes': the boxes as the frame's camera saw them
    if (!rows || !frame.cam) return;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(120, 255, 170, 0.95)';
    ctx.beginPath();
    for (const r of rows) {
      const pts = rowCorners(r).map((p) => project(frame.cam, p));
      if (pts.some((q) => !(q.z > 0.02))) continue;
      const s = pts.map((q) => toScreen(q.x, q.y));
      for (const [a, b] of EDGES) {
        ctx.moveTo(...s[a]);
        ctx.lineTo(...s[b]);
      }
    }
    ctx.stroke();
  }
}
