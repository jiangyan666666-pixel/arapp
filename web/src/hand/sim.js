// Synthetic hands with the real conventions (docs/protocol.md §0, checked against captures of
// the phone): a camera like ARKit's, the screen like the phone's, a hand made of the model's 16
// boxes, and 'ar.hands' events exactly like the native layer's. Used by the fake native layer on
// the PC (30 Hz, so an event with a patch takes a few ms) and by tools/hand_test.mjs.
// It proves the page's logic only: real Vision joints and real LiDAR are noisier and biased in
// ways this does not model.
//
// API
//   rng(seed) -> () => [0, 1)          deterministic (mulberry32)
//   gauss(random) -> standard normal
//   INTRINSICS  [1342.44,0,0, 0,1342.44,0, 967.97,718.62,1] (1920x1440; typical of the phone)
//   IMAGE       [1920, 1440]
//   makeCamera({position, lookAt, roll = 0, intrinsics, imageResolution}) -> cam
//       ARKit's convention: transform columns X = screen down, Y = screen right, Z = backwards;
//       phone held portrait with screen up = world up projected (world -Z when looking straight
//       down); roll turns the phone about the viewing axis, + = counter-clockwise as the user
//       sees the screen.
//   displayFor(viewport, imageResolution = IMAGE) -> [6] (aspect fill, portrait)
//   portraitMatrices(cam, viewport, zNear = 0.01, zFar = 100) -> {view, projection} like
//       ar.status (ARKit's projection: Metal clip depth 0..1, principal point at +0.5 px)
//   handJoints(model, {origin, rotation, flex = {}, spread = 0}) -> [[x, y, z] x 21]
//       origin = wrist position; rotation = quaternion palm space -> world; flex[finger] =
//       [a1, a2, a3] radians bending towards the palm (-Y of palm space); spread (radians)
//       fans the fingers out (thumb most, middle not at all).
//   restingPose(model, {table = 0.75, at = [0, 0], yaw = 0}) -> {origin, rotation, flex}
//       the hand palm-down on a table at height `table`, wrist at (x, z) = at, fingers towards
//       -Z turned by yaw about +Y; flex lowers the fingers onto the table (finger joints at half
//       a finger thickness above it, palm joints at half the palm thickness).
//   handsEvent({cam, viewport = [402, 874], model, joints, chirality, t = 0, seq = 0,
//       table: {height} | null, noise: {px: 0, depth: 0}, patch: false, random = Math.random,
//       window = 2, patchMargin = 12, patchMax = 6000, patchStep = 1,
//       depth = true, confidence = 0.9, hands = null}) -> an 'ar.hands' event
//       Depth: a 256x192 depth grid ray-cast against the hand's 16 boxes (poseBoxes of
//       poseFromJoints) and the table plane (only around the hands, where it is used); person =
//       the ray hit a hand box; LiDAR confidence 2 when depth > 0.4 m, else 1; joints behind the
//       camera or outside the image get c = 0. noise.px = std of the joints' image position in
//       pixels, noise.depth = std of each depth pixel in metres. depth: false = no LiDAR at all
//       (depthSize null). hands: [{model, joints, chirality}] for more than one hand.
//       forearm = true adds a 22 cm forearm box behind the wrist to the depth and person mask
//       (the phone sees the arm; it is not one of the model's boxes).

import { PALM_JOINTS, CHAIN, FINGERS } from './joints.js';
import { sub, scale, dot, cross, norm, len, add, quatRotate, quatToMat3, quatFromBasis, mat4InvertRigid, project, round } from './geom.js';
import { poseFromJoints, poseBoxes } from './pose.js';

export function rng(seed = 1) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gauss(random = Math.random) {
  const u = Math.max(1e-12, random());
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export const INTRINSICS = [1342.44, 0, 0, 0, 1342.44, 0, 967.97, 718.62, 1];
export const IMAGE = [1920, 1440];

export function makeCamera({ position, lookAt, roll = 0, intrinsics = INTRINSICS, imageResolution = IMAGE }) {
  const f = norm(sub(lookAt, position));
  let u = sub([0, 1, 0], scale(f, f[1]));
  if (len(u) < 1e-6) u = sub([0, 0, -1], scale(f, -f[2]));
  u = norm(u);
  let r = cross(f, u);
  if (roll) {
    const c = Math.cos(roll);
    const s = Math.sin(roll);
    const u2 = sub(scale(u, c), scale(r, s));
    r = add(scale(r, c), scale(u, s));
    u = u2;
  }
  // columns: X = screen down, Y = screen right, Z = backwards
  return {
    transform: [-u[0], -u[1], -u[2], 0, r[0], r[1], r[2], 0, -f[0], -f[1], -f[2], 0, position[0], position[1], position[2], 1],
    intrinsics: [...intrinsics],
    imageResolution: [...imageResolution],
  };
}

export function displayFor(viewport, imageResolution = IMAGE) {
  const [W, H] = viewport;
  const [IW, IH] = imageResolution;
  // portrait: the image's long side runs down the screen; aspect fill crops the other side
  if (W / H <= IH / IW) {
    const k = (H * IH) / (W * IW);
    return [0, 1, -k, 0, (1 + k) / 2, 0];
  }
  const k = (W * IW) / (H * IH);
  return [0, k, -1, 0, 1, (1 - k) / 2];
}

export function portraitMatrices(cam, viewport, zNear = 0.01, zFar = 100) {
  const T = cam.transform;
  // portrait camera: x = screen right (sensor Y), y = screen up (-sensor X), z = backwards
  const portrait = [T[4], T[5], T[6], 0, -T[0], -T[1], -T[2], 0, T[8], T[9], T[10], 0, T[12], T[13], T[14], 1];
  const view = mat4InvertRigid(portrait);
  const K = cam.intrinsics;
  const [IW, IH] = cam.imageResolution || IMAGE;
  const D = displayFor(viewport, [IW, IH]);
  const fx = K[0];
  const fy = K[4];
  // ARKit puts the principal point at pixel centre +0.5 (matches the captures to 1e-5)
  const cx = K[6] + 0.5;
  const cy = K[7] + 0.5;
  const xpp = D[0] * (cx / IW) + D[2] * (cy / IH) + D[4];
  const ypp = D[1] * (cx / IW) + D[3] * (cy / IH) + D[5];
  const projection = new Array(16).fill(0);
  projection[0] = (-2 * D[2] * fy) / IH;
  projection[4] = (-2 * D[0] * fx) / IW;
  projection[8] = 1 - 2 * xpp;
  projection[1] = (2 * D[3] * fy) / IH;
  projection[5] = (2 * D[1] * fx) / IW;
  projection[9] = 2 * ypp - 1;
  projection[10] = -zFar / (zFar - zNear);
  projection[11] = -1;
  projection[14] = (-zFar * zNear) / (zFar - zNear);
  return { view, projection };
}

const REST_DEG = { thumb: 42, index: 6, middle: 0, ring: -6, little: -15 };
const SPREAD_K = { thumb: 1, index: 0.5, middle: 0, ring: -0.5, little: -1 };

export function handJoints(model, { origin, rotation, flex = {}, spread = 0 }) {
  const shape = model.palmShape;
  const side = shape[1][0] >= 0 ? 1 : -1;
  const out = new Array(21);
  const toWorld = (p) => add(origin, quatRotate(rotation, p));
  PALM_JOINTS.forEach((j, k) => (out[j] = toWorld(shape[k])));
  for (const finger of FINGERS) {
    const chain = CHAIN[finger];
    const a = side * ((REST_DEG[finger] * Math.PI) / 180 + SPREAD_K[finger] * spread);
    const d0 = [Math.sin(a), 0, Math.cos(a)];
    const down = [0, -1, 0]; // = (Y x d0) x d0: the palm side, perpendicular to d0
    const fl = flex[finger] || [0, 0, 0];
    let p = shape[PALM_JOINTS.indexOf(chain[0])];
    let ang = 0;
    for (let s = 0; s < 3; s++) {
      ang += fl[s] || 0;
      const dir = add(scale(d0, Math.cos(ang)), scale(down, Math.sin(ang)));
      p = add(p, scale(dir, model.fingers[finger].lengths[s]));
      out[chain[s + 1]] = toWorld(p);
    }
  }
  return out;
}

export function restingPose(model, { table = 0.75, at = [0, 0], yaw = 0 } = {}) {
  const y = [0, 1, 0];
  const z = [-Math.sin(yaw), 0, -Math.cos(yaw)];
  const x = cross(y, z);
  const flex = {};
  for (const f of FINGERS) {
    const g = model.fingers[f];
    const drop = Math.max(0, (model.palm.thickness - g.thickness) / 2);
    const a = Math.asin(Math.min(0.9, drop / g.lengths[0]));
    flex[f] = [a, -a, 0];
  }
  return { origin: [at[0], table + model.palm.thickness / 2, at[1]], rotation: quatFromBasis(x, y, z), flex };
}

// --- the event ---

function toBase64(bytes) {
  // eslint-disable-next-line no-undef
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function medianOf(arr, n) {
  if (!n) return 0;
  const s = arr.slice(0, n).sort((a, b) => a - b);
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/**
 * The boxes of a hand as {c, M (box axes, column-major 3x3), h (half sizes)}: the model's 16
 * plus a forearm (LiDAR and the person mask see the arm too; without it the wrist joint's depth
 * window would look past the end of the palm box).
 */
function handBoxes(model, joints, chirality, forearm) {
  const pose = poseFromJoints(model, joints, chirality);
  const rows = poseBoxes(model, pose, { digits: null });
  const boxes = rows.map((r) => ({ c: [r[1], r[2], r[3]], M: quatToMat3([r[4], r[5], r[6], r[7]]), h: [r[8] / 2, r[9] / 2, r[10] / 2] }));
  if (forearm) {
    const L = 0.22;
    boxes.push({
      c: add(pose.palm.origin, quatRotate(pose.palm.rotation, [0, 0, -L / 2])),
      M: quatToMat3(pose.palm.rotation),
      h: [0.35 * model.palm.width, model.palm.thickness / 2, L / 2],
    });
  }
  return boxes;
}

export function handsEvent({
  cam,
  viewport = [402, 874],
  model,
  joints,
  chirality,
  t = 0,
  seq = 0,
  table = null,
  noise = {},
  patch = false,
  random = Math.random,
  window: r = 2,
  patchMargin = 12,
  patchMax = 6000,
  patchStep = 1,
  depth = true,
  confidence = 0.9,
  hands = null,
  forearm = true,
}) {
  const [IW, IH] = cam.imageResolution || IMAGE;
  const K = cam.intrinsics;
  const T = cam.transform;
  const W = 256;
  const H = 192;
  const npx = noise.px || 0;
  const nd = noise.depth || 0;
  const list = hands || (joints ? [{ model, joints, chirality: chirality ?? model?.chirality ?? 'right' }] : []);

  // 2D joints as Vision would report them (the projection of the joint centres, plus noise)
  const outHands = list.map((h) => {
    const rows = h.joints.map((p) => {
      const q = project(cam, p);
      const x = q.x + (npx ? (gauss(random) * npx) / IW : 0);
      const y = q.y + (npx ? (gauss(random) * npx) / IH : 0);
      const ok = q.z > 0.02 && x >= 0 && x <= 1 && y >= 0 && y <= 1;
      return ok ? [x, y, confidence, 0, 0, 0, 0, 0, 0] : [0, 0, 0, 0, 0, 0, 0, 0, 0];
    });
    return { chirality: h.chirality ?? h.model?.chirality ?? 'right', confidence, joints: rows, model: h.model || model, world: h.joints };
  });

  const patches = [];
  if (depth && outHands.length) {
    // the region where depth is needed: each hand's joint box grown by the patch margin
    const margin = Math.max(patchMargin, r);
    const rects = outHands.map((h) => {
      let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
      for (const j of h.joints) {
        if (j[2] <= 0.1) continue;
        const u = Math.floor(j[0] * W);
        const v = Math.floor(j[1] * H);
        u0 = Math.min(u0, u); v0 = Math.min(v0, v); u1 = Math.max(u1, u + 1); v1 = Math.max(v1, v + 1);
      }
      if (!Number.isFinite(u0)) return null;
      return [Math.max(0, u0 - patchMargin), Math.max(0, v0 - patchMargin), Math.min(W, u1 + patchMargin), Math.min(H, v1 + patchMargin),
        Math.max(0, u0 - margin), Math.max(0, v0 - margin), Math.min(W, u1 + margin), Math.min(H, v1 + margin)];
    });
    const valid = rects.filter(Boolean);
    const dmap = new Float32Array(W * H);
    const cmap = new Uint8Array(W * H);
    const pmap = new Uint8Array(W * H);
    if (valid.length) {
      const R0 = Math.min(...valid.map((q) => q[4]));
      const R1 = Math.min(...valid.map((q) => q[5]));
      const R2 = Math.max(...valid.map((q) => q[6]));
      const R3 = Math.max(...valid.map((q) => q[7]));
      const o = [T[12], T[13], T[14]];
      // ray of depth pixel (u, v), not normalised: o + t*d has depth t
      const ax = (u) => (((u + 0.5) / W) * IW - K[6]) / K[0];
      const ay = (v) => -(((v + 0.5) / H) * IH - K[7]) / K[4];
      const best = new Float32Array(W * H).fill(Infinity);
      if (table) {
        for (let v = R1; v < R3; v++) {
          const yv = ay(v);
          for (let u = R0; u < R2; u++) {
            const xu = ax(u);
            const dy = T[1] * xu + T[5] * yv - T[9];
            const tt = (table.height - o[1]) / dy;
            if (tt > 0) best[v * W + u] = tt;
          }
        }
      }
      for (const h of outHands) {
        for (const b of handBoxes(h.model, h.world, h.chirality, forearm)) {
          // ray in box space: ob + t * (A ax + B ay - C), with A, B, C = box axes^T * camera axes
          const Mb = b.M;
          const rel = sub(o, b.c);
          const ob = [Mb[0] * rel[0] + Mb[1] * rel[1] + Mb[2] * rel[2], Mb[3] * rel[0] + Mb[4] * rel[1] + Mb[5] * rel[2], Mb[6] * rel[0] + Mb[7] * rel[1] + Mb[8] * rel[2]];
          const cA = [T[0], T[1], T[2]];
          const cB = [T[4], T[5], T[6]];
          const cC = [T[8], T[9], T[10]];
          const bx = [Mb[0], Mb[1], Mb[2]];
          const by = [Mb[3], Mb[4], Mb[5]];
          const bz = [Mb[6], Mb[7], Mb[8]];
          const A = [dot(bx, cA), dot(by, cA), dot(bz, cA)];
          const B = [dot(bx, cB), dot(by, cB), dot(bz, cB)];
          const C = [dot(bx, cC), dot(by, cC), dot(bz, cC)];
          // the pixels this box can cover: the bounding box of its projected corners
          let pu0 = Infinity, pv0 = Infinity, pu1 = -Infinity, pv1 = -Infinity;
          let behind = false;
          for (let k = 0; k < 8; k++) {
            const lc = [k & 1 ? b.h[0] : -b.h[0], k & 2 ? b.h[1] : -b.h[1], k & 4 ? b.h[2] : -b.h[2]];
            const wc = add(b.c, add(add(scale(bx, lc[0]), scale(by, lc[1])), scale(bz, lc[2])));
            const q = project(cam, wc);
            if (q.z < 0.01) {
              behind = true;
              break;
            }
            pu0 = Math.min(pu0, q.x * W); pu1 = Math.max(pu1, q.x * W); pv0 = Math.min(pv0, q.y * H); pv1 = Math.max(pv1, q.y * H);
          }
          const U0 = behind ? R0 : Math.max(R0, Math.floor(pu0) - 1);
          const U1 = behind ? R2 : Math.min(R2, Math.ceil(pu1) + 1);
          const V0 = behind ? R1 : Math.max(R1, Math.floor(pv0) - 1);
          const V1 = behind ? R3 : Math.min(R3, Math.ceil(pv1) + 1);
          for (let v = V0; v < V1; v++) {
            const yv = ay(v);
            for (let u = U0; u < U1; u++) {
              const xu = ax(u);
              let tmin = 0;
              let tmax = Infinity;
              let hit = true;
              for (let k = 0; k < 3; k++) {
                const dk = A[k] * xu + B[k] * yv - C[k];
                if (Math.abs(dk) < 1e-12) {
                  if (Math.abs(ob[k]) > b.h[k]) { hit = false; break; }
                  continue;
                }
                let t1 = (-b.h[k] - ob[k]) / dk;
                let t2 = (b.h[k] - ob[k]) / dk;
                if (t1 > t2) [t1, t2] = [t2, t1];
                if (t1 > tmin) tmin = t1;
                if (t2 < tmax) tmax = t2;
                if (tmin > tmax) { hit = false; break; }
              }
              if (!hit || tmin <= 0) continue;
              const idx = v * W + u;
              if (tmin < best[idx]) {
                best[idx] = tmin;
                pmap[idx] = 1;
              }
            }
          }
        }
      }
      // (the table went in first, so a box only became "person" where it is in front of it)
      for (let v = R1; v < R3; v++) {
        for (let u = R0; u < R2; u++) {
          const idx = v * W + u;
          const d = best[idx];
          if (!Number.isFinite(d)) continue;
          const dn = nd ? Math.max(0.01, d + gauss(random) * nd) : d;
          dmap[idx] = dn;
          cmap[idx] = dn > 0.4 ? 2 : 1;
        }
      }
    }

    // per-joint window statistics, as the native layer computes them
    const buf = new Float64Array((2 * r + 1) ** 2);
    const bufP = new Float64Array((2 * r + 1) ** 2);
    for (const h of outHands) {
      for (const j of h.joints) {
        if (j[2] <= 0) continue;
        const u = Math.min(W - 1, Math.floor(j[0] * W));
        const v = Math.min(H - 1, Math.floor(j[1] * H));
        let nAll = 0, nHand = 0, nHi = 0, nWin = 0;
        for (let dv = -r; dv <= r; dv++) {
          for (let du = -r; du <= r; du++) {
            const uu = u + du;
            const vv = v + dv;
            if (uu < 0 || vv < 0 || uu >= W || vv >= H) continue;
            nWin++;
            const idx = vv * W + uu;
            const d = dmap[idx];
            if (cmap[idx] === 2) nHi++;
            if (!(d > 0)) continue;
            buf[nAll++] = d;
            if (pmap[idx]) bufP[nHand++] = d;
          }
        }
        const dHand = medianOf(bufP, nHand);
        j[3] = round(medianOf(buf, nAll), 4);
        j[4] = round(dHand, 4);
        j[5] = nHand;
        j[6] = nAll;
        j[7] = round(nWin ? nHi / nWin : 0, 5);
        j[8] = round(dHand, 4); // person depth agrees with LiDAR within millimetres on the phone
      }
    }

    if (patch) {
      outHands.forEach((h, hi) => {
        const q = rects[hi];
        if (!q) return;
        const [u0, v0, u1, v1] = q;
        let step = Math.max(1, patchStep);
        while (Math.ceil((u1 - u0) / step) * Math.ceil((v1 - v0) / step) > patchMax) step++;
        const w = Math.ceil((u1 - u0) / step);
        const hh = Math.ceil((v1 - v0) / step);
        const dep = new Uint8Array(w * hh * 2);
        const info = new Uint8Array(w * hh);
        for (let jj = 0; jj < hh; jj++) {
          for (let ii = 0; ii < w; ii++) {
            const idx = (v0 + jj * step) * W + (u0 + ii * step);
            const k = jj * w + ii;
            const mm = Math.min(65535, Math.round(dmap[idx] * 1000));
            dep[2 * k] = mm & 255;
            dep[2 * k + 1] = mm >> 8;
            info[k] = (cmap[idx] & 3) | (pmap[idx] ? 4 : 0);
          }
        }
        patches.push({ hand: hi, rect: [u0, v0, u1, v1], step, w, h: hh, depth: toBase64(dep), info: toBase64(info) });
      });
    }
  }

  const tv0 = t + 0.003;
  const tv1 = tv0 + 0.012 + 0.004 * random();
  const ev = {
    type: 'ar.hands',
    seq,
    t: round(t, 5),
    tv0: round(tv0, 5),
    tv1: round(tv1, 5),
    tSent: round(tv1 + 0.001, 5),
    camera: { transform: [...T], intrinsics: [...K], imageResolution: [IW, IH] },
    display: displayFor(viewport, [IW, IH]),
    viewport: [...viewport],
    depthSize: depth ? [W, H] : null,
    window: r,
    hands: outHands.map((h) => ({
      chirality: h.chirality,
      confidence: h.confidence,
      joints: h.joints.map((j) => [round(j[0], 5), round(j[1], 5), round(j[2], 5), j[3], j[4], j[5], j[6], j[7], j[8]]),
    })),
  };
  if (patch && patches.length) ev.patches = patches;
  return ev;
}
