// Turns a raw 'ar.hands' event (docs/protocol.md §4) into plain objects the tracker and the
// scanner work on: named joint fields instead of rows, and the depth patch decoded from base64.
// Works in browsers and in Node (atob when present, else Buffer).
//
// API
//   parseHandsEvent(ev) -> HandFrame = {
//     t, seq, tv0, tv1, tSent,            native seconds (device uptime clock)
//     cam: {transform, intrinsics, imageResolution},   the camera of THIS frame
//     display, viewport, depthSize, window,
//     hands: [{index, chirality, confidence,
//              joints: [{x, y, c, dAll, dHand, nHand, nAll, hi, pd} x 21],
//              patch: Patch | null}] }
//   decodePatch(p, depthSize) -> Patch = {
//     hand, rect: [u0, v0, u1, v1] (depth pixels, u1/v1 exclusive), step, w, h, depthSize,
//     depth: Float32Array (metres, 0 = no value), conf: Uint8Array (0 low, 1 medium, 2 high),
//     person: Uint8Array (0/1),
//     xy(i, j) -> [x, y]  image coords of patch pixel (i, j) (its depth pixel's centre),
//     at(x, y) -> k | -1  index of the patch pixel nearest to image point (x, y) }
//   decodeBase64(s) -> Uint8Array

import { FIELD } from './joints.js';

export function decodeBase64(s) {
  if (!s) return new Uint8Array(0);
  if (typeof atob === 'function') {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // eslint-disable-next-line no-undef
  return new Uint8Array(Buffer.from(s, 'base64'));
}

export function decodePatch(p, depthSize = [256, 192]) {
  const [W, H] = depthSize || [256, 192];
  const { rect, step = 1, w, h } = p;
  const n = w * h;
  const raw = decodeBase64(p.depth);
  const info = decodeBase64(p.info);
  const depth = new Float32Array(n);
  const conf = new Uint8Array(n);
  const person = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    // Uint16 little-endian millimetres
    depth[k] = 2 * k + 1 < raw.length ? (raw[2 * k] | (raw[2 * k + 1] << 8)) / 1000 : 0;
    const b = k < info.length ? info[k] : 0;
    conf[k] = b & 3;
    person[k] = (b >> 2) & 1;
  }
  const [u0, v0] = rect;
  return {
    hand: p.hand,
    rect,
    step,
    w,
    h,
    depthSize: [W, H],
    depth,
    conf,
    person,
    xy: (i, j) => [(u0 + i * step + 0.5) / W, (v0 + j * step + 0.5) / H],
    at(x, y) {
      const i = Math.round((x * W - 0.5 - u0) / step);
      const j = Math.round((y * H - 0.5 - v0) / step);
      return i < 0 || j < 0 || i >= w || j >= h ? -1 : j * w + i;
    },
  };
}

const jointOf = (row) => ({
  x: +row[FIELD.x] || 0,
  y: +row[FIELD.y] || 0,
  c: +row[FIELD.c] || 0,
  dAll: +row[FIELD.dAll] || 0,
  dHand: +row[FIELD.dHand] || 0,
  nHand: +row[FIELD.nHand] || 0,
  nAll: +row[FIELD.nAll] || 0,
  hi: +row[FIELD.hi] || 0,
  pd: +row[FIELD.pd] || 0,
});

export function parseHandsEvent(ev) {
  const depthSize = ev.depthSize || null;
  const patches = ev.patches || [];
  const hands = (ev.hands || []).map((h, index) => {
    const p = patches.find((q) => q.hand === index);
    let patch = null;
    if (p && depthSize) {
      try {
        patch = decodePatch(p, depthSize);
      } catch {
        patch = null; // a broken patch must not lose the joints
      }
    }
    return {
      index,
      chirality: h.chirality === 'left' || h.chirality === 'right' ? h.chirality : 'unknown',
      confidence: +h.confidence || 0,
      joints: (h.joints || []).map(jointOf),
      patch,
    };
  });
  return {
    t: +ev.t || 0,
    seq: ev.seq ?? 0,
    tv0: ev.tv0 ?? null,
    tv1: ev.tv1 ?? null,
    tSent: ev.tSent ?? null,
    cam: ev.camera,
    display: ev.display || null,
    viewport: ev.viewport || null,
    depthSize,
    window: ev.window ?? 2,
    hands: hands.filter((h) => h.joints.length === 21),
  };
}
