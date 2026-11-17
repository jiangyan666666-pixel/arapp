// Binds the hand model to the real hand, frame by frame: Vision's 2D joints + LiDAR depth + the
// known hand size -> 21 joint centres in world space -> a HandPose (pose.js) whose 16 boxes the
// page sends to the native layer. All of it runs in the page, so it can be tuned without
// reinstalling the app; tools/hand_replay.mjs runs the same code over recordings.
//
// API
//   new HandTracker(model, options)
//   setModel(m), setOptions(o), reset()
//   update(frame: HandFrame) -> HandPose | null      (frame from frame.js parseHandsEvent)
//   lastDebug                                         intermediate values of the last update
//   pose.quality = {method, hand, chirality, palmDepthLidar | null, palmDepthSize | null,
//     palmDepth, lidarWeight, lidarJoints, reprojErrPx, filled, noRoot,
//     roots: {lidar, history, bend}, held}
//
// Options (defaults)
//   method: 'fused'      'fused' | 'lidar' | 'size' (how the palm's distance is found, below)
//   minCutoff: 1.0, beta: 50, dCutoff: 1.0      One Euro filter per joint, world metres, so beta
//                        is per m/s; filter: true (false = raw joints, for tests and debugging).
//                        beta 50, not the 0.8 first proposed: in the synthetic tests 0.8 left a
//                        hand moving at 17 cm/s 23 mm behind (pure lag), 50 leaves 3.6 mm while a
//                        still hand's jitter stays 0.7 mm (raw 1.8 mm).
//   predict: 0           seconds: output = filtered + velocity * predict (0 = off)
//   minJointConf: 0.3    Vision confidence below which a joint is "not seen"
//   holdMs: 300          after the hand is lost, the last pose (quality.held) for this long
//   chirality: 'model'   'model' = the hand is the scanned one (use its chirality; prefer the
//                        frame hand Vision labels so); 'any' = take Vision's label
//   lidarTrust: 1        multiplies lidarWeight (0 = never mix LiDAR into 'fused')
//   maxReprojPx: 40      reject a palm fit worse than this (RMS, pixels of 1920x1440)
//   depthRange: [0.1, 1.5]  reject palm depths outside (metres)
//
// How a frame is solved
// 1. Pick the hand: candidates need >= 4 of the 6 palm joints at c >= minJointConf. A
//    candidate within 0.06 (image coords) of the hand tracked last time wins (continuity beats
//    Vision's labels, which flip now and then); else, with chirality 'model' and a left/right
//    model, the candidates Vision labels with that chirality (all of them if none); among
//    those the one nearest the last tracked hand (within 0.2), else the best mean palm-joint
//    confidence.
// 2. Palm, size estimate: Levenberg-Marquardt PnP (6 DOF, reprojection error in pixels) of
//    model.palmShape (mirrored for the other chirality) to the seen palm joints. Starts: the
//    previous pose if < 200 ms old, a rigid fit to the LiDAR centres, and a weak-perspective
//    guess (depth = f * L3D / L2D, smallest over the widest model pairs, which are the least
//    foreshortened). A flat palm has a two-fold tilt ambiguity, so each result is also
//    re-solved from its "tilt flip" (the palm normal mirrored about the line of sight); the
//    choice among near-equal fits scores closeness to the previous pose, agreement with the
//    LiDAR depth pattern, and the error.
//    LiDAR estimate: per palm joint with c >= minJointConf, dHand > 0, nHand >= 3: surface =
//    unproject(x, y, dHand) (the skin facing the camera); joint centre = surface + ray
//    direction * palm.thickness / 2 * k, where k = 1 / cos(angle between the ray and the size
//    fit's palm normal) (a flat palm seen at an angle: the centre is further along the ray than
//    half a thickness; k = 1 edge-on, blended, at most 2). palmDepthLidar = the size fit's
//    palm-centre depth + the median of (LiDAR - fit) joint depths, so both estimates describe
//    the same point.
//    lidarWeight = lidarTrust * share * mean_j(fill_j * (0.3 + 0.7 * hi_j)) * min(1, n / 3), where
//    share = LiDAR joints / seen palm joints, fill = nHand / (half the window), hi = share of
//    "high" LiDAR pixels: near the phone (<0.4 m) LiDAR is mostly "medium", so it gets at most
//    0.3 there until the device shows it deserves more.
//    'fused': palm depth = lidarWeight mix of the two, and the size fit is slid along the ray
//    through the palm centre to that depth. 'lidar': rigid fit of palmShape to the LiDAR
//    centres (twice: the second pass offsets along the first fit's normal); < 3 points ->
//    the size fit. 'size': the size fit only.
// 3. Fingers: base joints (MCPs, thumb CMC) from the palm fit. Each next joint lies on its own
//    image ray at the model's bone length from the previous joint: the two roots of
//    |o + s d - p| = L; no real root -> the closest point on the ray (counted in noRoot).
//    Root choice, in this order: (1) LiDAR rules out (methods 'fused'/'lidar', the joint has
//    dHand > 0 and nHand >= 3): a root more than 1.2 cm in front of the skin LiDAR sees on the
//    joint's ray is impossible — a joint is never in front of its own skin, hidden or not — and
//    often that alone decides. Anatomy rules out too: a root bending backwards (towards the
//    back of the hand, measured as the change of elevation above the palm plane) by more than
//    50 deg at the knuckle, 35 at the later joints, 60 for the thumb, when the other root
//    does not (without this, a 'size' track at 0.6 m drifted onto the bent-back branch and
//    history kept it there: 100 mm errors). (2) History decides when it is clear: the root nearest the
//    joint's position < 150 ms ago, if that one is within 3 cm of it and the other root at
//    least 1 cm further. (3) LiDAR's depth: unless the palm box or a segment placed already
//    explains the reading (it hides the joint, so LiDAR sees it, not the joint), the root
//    lying a quarter to a full finger thickness (+-8 mm) behind the skin, if exactly one does
//    (both: the one nearer dHand + 0.6 thickness). (4) The smaller bend from the previous bone
//    (wrist -> base for the first one), a bend backwards by more than 25 deg (35 for the thumb)
//    counting as worse. History that is not clear is not used: right after a "no root" frame
//    the last position lies between the two new roots, and nearest-wins is a coin flip.
//    This differs from the contract's order (LiDAR depth "closest to dHand + thickness / 2"
//    first, then history, then bend): in the synthetic tests that order picks the wrong root
//    whenever a curling finger hides behind the palm or its own proximal segment, because the
//    joint's depth window then sees the occluder or the knuckle (every frame of a fist seen
//    from behind; 56 mm errors in the moving sequence). Joints with c < minJointConf keep the
//    finger's last seen shape in palm space (a straight finger if none) and count in `filled`.
// 4. One Euro filter per joint in world space (time = frame.t); + velocity * predict; then
//    poseFromJoints.
// 5. Lost or rejected (palm depth outside depthRange, reprojection error > maxReprojPx): the
//    last pose with quality.held = true for holdMs, then null (filters reset).

import { PALM_JOINTS, CHAIN, FINGERS } from './joints.js';
import {
  add, sub, scale, dot, cross, norm, len, dist, centroid, angle, quatRotate, quatMul, quatConj, quatFromRotVec,
  quatFromTo, quatAngle, quatFromMat4, camToWorld, worldToCam, ray, depthOf, fitRigid, solveLinear, median, mean, clamp,
} from './geom.js';
import { palmShapeFor, restDirection } from './model.js';
import { poseFromJoints, resolveChirality, palmBoxCentre } from './pose.js';
import { OneEuro3 } from './filters.js';

export const TRACKER_DEFAULTS = {
  method: 'fused',
  minCutoff: 1.0,
  beta: 50,
  dCutoff: 1.0,
  filter: true,
  predict: 0,
  minJointConf: 0.3,
  holdMs: 300,
  chirality: 'model',
  lidarTrust: 1,
  maxReprojPx: 40,
  depthRange: [0.1, 1.5],
};

const PRIOR_S = 0.2; // a previous pose younger than this starts the palm fit
const HISTORY_S = 0.15; // a previous joint younger than this picks the finger root
const HISTORY_CLEAR = 0.03; // history decides alone if one root is this close to the last position
const HISTORY_MARGIN = 0.01; // ... and the other root this much further
const LIDAR_TOL_FRONT = 0.012; // LiDAR noise allowed when ruling out a root in front of the skin
const LIDAR_TOL_BAND = 0.008; // ... and around the band a seen joint sits in

// --- the palm fit, in camera space (x = sensor right, y = sensor up, looking along -z) ---

function projLocal(K, X) {
  const z = -X[2];
  return [K[6] + (K[0] * X[0]) / z, K[7] - (K[4] * X[1]) / z];
}

function reprojCost(obs, K, q, t) {
  let s = 0;
  for (const o of obs) {
    const X = add(quatRotate(q, o.P), t);
    if (-X[2] < 0.02) return Infinity;
    const p = projLocal(K, X);
    s += (p[0] - o.u) ** 2 + (p[1] - o.v) ** 2;
  }
  return s;
}

/** Levenberg-Marquardt over rotation (left increment) and translation. */
function pnp(obs, K, init, maxIter = 30) {
  let { q, t } = init;
  let c = reprojCost(obs, K, q, t);
  if (!Number.isFinite(c)) return null;
  let lambda = 1e-3;
  const fx = K[0];
  const fy = K[4];
  for (let it = 0; it < maxIter; it++) {
    const Hm = new Array(36).fill(0);
    const g = new Array(6).fill(0);
    for (const o of obs) {
      const qp = quatRotate(q, o.P);
      const X = add(qp, t);
      const z = -X[2];
      const p = projLocal(K, X);
      const ru = p[0] - o.u;
      const rv = p[1] - o.v;
      const ju = [fx / z, 0, (fx * X[0]) / (z * z)];
      const jv = [0, -fy / z, (-fy * X[1]) / (z * z)];
      const Ju = [...cross(qp, ju), ...ju];
      const Jv = [...cross(qp, jv), ...jv];
      for (let a = 0; a < 6; a++) {
        g[a] += Ju[a] * ru + Jv[a] * rv;
        for (let b = 0; b < 6; b++) Hm[a * 6 + b] += Ju[a] * Ju[b] + Jv[a] * Jv[b];
      }
    }
    let improved = false;
    for (let tries = 0; tries < 8 && !improved; tries++) {
      const A = Hm.slice();
      for (let a = 0; a < 6; a++) A[a * 6 + a] += lambda * Hm[a * 6 + a] + 1e-9;
      const d = solveLinear(A, g.map((v) => -v));
      if (!d) {
        lambda *= 10;
        continue;
      }
      const q2 = quatMul(quatFromRotVec([d[0], d[1], d[2]]), q);
      const t2 = [t[0] + d[3], t[1] + d[4], t[2] + d[5]];
      const c2 = reprojCost(obs, K, q2, t2);
      if (c2 < c) {
        const gain = c - c2;
        q = q2;
        t = t2;
        c = c2;
        lambda = Math.max(1e-7, lambda / 3);
        improved = true;
        if (gain < 1e-9 * (1 + c) || Math.hypot(d[0], d[1], d[2]) + Math.hypot(d[3], d[4], d[5]) < 1e-8) it = maxIter;
      } else {
        lambda *= 5;
      }
    }
    if (!improved) break;
  }
  return { q, t, err: Math.sqrt(c / obs.length) };
}

function weakInit(obs, K) {
  const f = (K[0] + K[4]) / 2;
  const pairs = [];
  for (let a = 0; a < obs.length; a++) {
    for (let b = a + 1; b < obs.length; b++) {
      const L3 = dist(obs[a].P, obs[b].P);
      const L2 = Math.hypot(obs[a].u - obs[b].u, obs[a].v - obs[b].v);
      if (L3 > 0.02 && L2 > 2) pairs.push({ L3, z: (f * L3) / L2 });
    }
  }
  if (!pairs.length) return null;
  pairs.sort((p, q) => q.L3 - p.L3);
  const z0 = Math.min(...pairs.slice(0, 4).map((p) => p.z));
  const pts = obs.map((o) => [((o.u - K[6]) / K[0]) * z0, (-(o.v - K[7]) / K[4]) * z0, -z0]);
  const fit = fitRigid(obs.map((o) => o.P), pts);
  return { q: fit.q, t: fit.t };
}

/** The other solution of a nearly flat target: its normal mirrored about the line of sight. */
function tiltFlip(sol, centreP) {
  const C = add(quatRotate(sol.q, centreP), sol.t);
  const v = norm(C);
  const n = quatRotate(sol.q, [0, 1, 0]);
  const n2 = sub(scale(v, 2 * dot(n, v)), n);
  const q = quatMul(quatFromTo(n, n2), sol.q);
  return { q, t: sub(C, quatRotate(q, centreP)) };
}

const sameSolution = (a, b) => quatAngle(a.q, b.q) < 0.07 && dist(a.t, b.t) < 0.005;

/**
 * LiDAR joint centres: half a thickness behind the seen skin, along the joint's own ray (the 2D
 * joint is the centre's image, so the centre is on that ray). With a palm normal, the distance
 * along the ray is half / cos(angle between the ray and the normal), which is exact for a flat
 * palm seen at an angle; edge-on (cos < 0.2) the camera sees the palm's rounded side, so plain
 * `half`, with a linear blend between 0.2 and 0.5 so the result does not jump.
 */
function obliqueFactor(c) {
  const a = Math.abs(c);
  if (a >= 0.5) return 1 / a;
  if (a <= 0.2) return 1;
  return 1 + ((a - 0.2) / 0.3) * (2 - 1);
}

function lidarCentres(samples, half, normal) {
  return samples.map((s) => add(s.surface, scale(s.dir, half * (normal ? obliqueFactor(dot(normal, s.dir)) : 1))));
}

/** A box as {c, x, y, z (unit axes), h (half sizes)}. */
function boxFromFrame(c, x, y, z, size) {
  return { c, x, y, z, h: [size[0] / 2, size[1] / 2, size[2] / 2] };
}

/** The box of a finger segment from a to b (x as close to the palm's x as possible). */
function segmentBox(a, b, width, thickness, palmX, palmY) {
  let z = norm(sub(b, a));
  if (len(z) < 0.5) z = palmY;
  const px = dot(palmX, z);
  let x;
  if (Math.abs(px) < 0.85) x = norm(sub(palmX, scale(z, px)));
  else x = cross(norm(sub(palmY, scale(z, dot(palmY, z)))), z);
  const y = cross(z, x);
  return boxFromFrame(scale(add(a, b), 0.5), x, y, z, [width, thickness, dist(a, b)]);
}

/** Distance along the ray r (unit d) to the first of these boxes, or null. */
function firstHit(r, boxes) {
  let best = null;
  for (const bx of boxes) {
    const rel = sub(r.o, bx.c);
    const o = [dot(rel, bx.x), dot(rel, bx.y), dot(rel, bx.z)];
    const d = [dot(r.d, bx.x), dot(r.d, bx.y), dot(r.d, bx.z)];
    let t0 = 0;
    let t1 = Infinity;
    let hit = true;
    for (let k = 0; k < 3 && hit; k++) {
      if (Math.abs(d[k]) < 1e-12) {
        if (Math.abs(o[k]) > bx.h[k]) hit = false;
        continue;
      }
      let a = (-bx.h[k] - o[k]) / d[k];
      let b = (bx.h[k] - o[k]) / d[k];
      if (a > b) [a, b] = [b, a];
      t0 = Math.max(t0, a);
      t1 = Math.min(t1, b);
      if (t0 > t1) hit = false;
    }
    if (hit && t0 > 0 && (best === null || t0 < best)) best = t0;
  }
  return best;
}

/** Roots LiDAR allows: a joint is never in front of the skin LiDAR sees on its own ray (true even when hidden). */
function lidarAllowed(cam, opts, dHand) {
  const ok = opts.filter((p) => depthOf(cam, p) >= dHand - LIDAR_TOL_FRONT);
  return ok.length ? ok : opts;
}

/** The root LiDAR's depth points to, or null when it does not decide (see the header, step 3). */
function lidarBand(cam, r, opts, dHand, thick, occluders) {
  // the palm or a placed segment explains the reading: LiDAR sees that, not this joint
  const occ = firstHit(r, occluders);
  if (occ !== null && depthOf(cam, add(r.o, scale(r.d, occ))) < dHand + LIDAR_TOL_BAND) return null;
  // a seen joint sits a quarter to a full thickness behind its skin
  const lo = dHand + 0.25 * thick - LIDAR_TOL_BAND;
  const hi = dHand + thick + LIDAR_TOL_BAND;
  const inBand = opts.filter((p) => {
    const d = depthOf(cam, p);
    return d >= lo && d <= hi;
  });
  if (inBand.length === 1) return inBand[0];
  if (inBand.length === 2) {
    const target = dHand + 0.6 * thick;
    return inBand.reduce((a, b) => (Math.abs(depthOf(cam, b) - target) < Math.abs(depthOf(cam, a) - target) ? b : a));
  }
  return null;
}

function emptyRoots() {
  return { lidar: 0, history: 0, bend: 0 };
}

export class HandTracker {
  constructor(model, options = {}) {
    this.model = model;
    this.options = { ...TRACKER_DEFAULTS, ...options };
    this.filters = Array.from({ length: 21 }, () => new OneEuro3(this._filterParams()));
    this.lastDebug = null;
    this.reset();
  }

  _filterParams() {
    const { minCutoff, beta, dCutoff } = this.options;
    return { minCutoff, beta, dCutoff };
  }

  setModel(m) {
    this.model = m;
    this.reset();
  }

  setOptions(o) {
    Object.assign(this.options, o);
    for (const f of this.filters) f.setParams(this._filterParams());
  }

  reset() {
    this.last = null; // last good output pose
    this.lastT = -Infinity;
    this.prevRaw = null; // {t, joints} unfiltered, for the finger roots
    this.prevPalm = null; // {t, q, origin} world, unfiltered, for the palm fit's start
    this.prevImg = null; // {t, c: [x, y]} image centre of the tracked palm
    this.memory = Object.fromEntries(FINGERS.map((f) => [f, [null, null, null]]));
    for (const f of this.filters) f.reset();
  }

  update(frame) {
    const o = this.options;
    const t = frame.t;
    let res;
    try {
      res = frame.cam ? this._solve(frame) : { reason: 'no-camera' };
    } catch (e) {
      res = { reason: `error: ${e.message}` };
    }
    if (res.pose) {
      this.last = res.pose;
      this.lastT = t;
      return res.pose;
    }
    if (this.lastDebug) this.lastDebug.rejected = res.reason;
    else this.lastDebug = { t, rejected: res.reason };
    if (this.last && (t - this.lastT) * 1000 <= o.holdMs) {
      return { ...this.last, quality: { ...this.last.quality, held: true } };
    }
    if (this.last || this.prevRaw) this.reset();
    return null;
  }

  _pickHand(frame) {
    const o = this.options;
    const cands = [];
    for (const h of frame.hands) {
      const palm = PALM_JOINTS.map((j) => h.joints[j]);
      const seen = palm.filter((j) => j.c >= o.minJointConf);
      if (seen.length < 4) continue;
      const c = [mean(seen.map((j) => j.x)), mean(seen.map((j) => j.y))];
      cands.push({ h, c, conf: mean(palm.map((j) => j.c)) });
    }
    if (!cands.length) return null;
    const recent = this.prevImg && (frame.t - this.prevImg.t) * 1000 <= o.holdMs;
    const d = (k) => (recent ? Math.hypot(k.c[0] - this.prevImg.c[0], k.c[1] - this.prevImg.c[1]) : Infinity);
    const nearest = (list) => list.reduce((a, b) => (d(b) < d(a) ? b : a));
    if (recent) {
      const n = nearest(cands);
      if (d(n) < 0.06) return n;
    }
    let pool = cands;
    const mc = this.model.chirality;
    if (o.chirality === 'model' && (mc === 'left' || mc === 'right')) {
      const match = cands.filter((k) => k.h.chirality === mc);
      if (match.length) pool = match;
    }
    if (recent) {
      const n = nearest(pool);
      if (d(n) < 0.2) return n;
    }
    return pool.reduce((a, b) => (b.conf > a.conf ? b : a));
  }

  _solve(frame) {
    const o = this.options;
    const model = this.model;
    const cam = frame.cam;
    const K = cam.intrinsics;
    const [IW, IH] = cam.imageResolution || [1920, 1440];
    const t = frame.t;
    const debug = { t, rejected: null };
    this.lastDebug = debug;

    const pick = this._pickHand(frame);
    if (!pick) return { reason: frame.hands.length ? 'palm-not-seen' : 'no-hand' };
    const hand = pick.h;
    debug.hand = hand.index;
    const mc = model.chirality;
    const chir =
      o.chirality === 'model' && (mc === 'left' || mc === 'right') ? mc : hand.chirality !== 'unknown' ? hand.chirality : resolveChirality(null, model);
    debug.chirality = chir;
    const shape = palmShapeFor(model, chir);
    const centreP = centroid(shape);
    const qCam = quatFromMat4(cam.transform);
    const halfPalm = model.palm.thickness / 2;

    // seen palm joints, and their LiDAR samples
    const obs = [];
    const samples = [];
    PALM_JOINTS.forEach((j, k) => {
      const jt = hand.joints[j];
      if (jt.c < o.minJointConf) return;
      const u = jt.x * IW;
      const v = jt.y * IH;
      const ob = { k, u, v, P: shape[k] };
      obs.push(ob);
      if (jt.dHand > 0 && jt.nHand >= 3) {
        const a = (u - K[6]) / K[0];
        const b = -(v - K[7]) / K[4];
        samples.push({ k, P: shape[k], jt, surface: [a * jt.dHand, b * jt.dHand, -jt.dHand], dir: norm([a, b, -1]) });
      }
    });

    // starts for the size fit
    const starts = [];
    if (this.prevPalm && t - this.prevPalm.t < PRIOR_S && t >= this.prevPalm.t) {
      starts.push({ q: quatMul(quatConj(qCam), this.prevPalm.q), t: worldToCam(cam, this.prevPalm.origin), prior: true });
    }
    if (samples.length >= 3) {
      const fit = fitRigid(samples.map((s) => s.P), lidarCentres(samples, halfPalm, null));
      starts.push({ q: fit.q, t: fit.t });
    }
    const wi = weakInit(obs, K);
    if (wi) starts.push(wi);
    const sols = [];
    for (const s of starts) {
      const a = pnp(obs, K, s);
      if (!a) continue;
      const b = pnp(obs, K, tiltFlip(a, centreP));
      for (const x of b ? [a, b] : [a]) if (!sols.some((y) => sameSolution(x, y))) sols.push(x);
    }
    if (!sols.length) return { reason: 'fit-failed' };
    const minErr = Math.min(...sols.map((s) => s.err));
    const prior = starts.find((s) => s.prior);
    const scored = sols
      .filter((s) => s.err <= minErr * 1.5 + 1.5)
      .map((s) => {
        let score = s.err / 20;
        if (prior) score += quatAngle(s.q, prior.q);
        if (samples.length >= 3) {
          const diffs = samples.map((x) => -lidarCentres([x], halfPalm, null)[0][2] - -add(quatRotate(s.q, x.P), s.t)[2]);
          const m = median(diffs);
          score += Math.sqrt(mean(diffs.map((d) => (d - m) ** 2))) / 0.02;
        }
        return { ...s, score };
      })
      .sort((a, b) => a.score - b.score);
    const size = scored[0];
    debug.candidates = scored.map((s) => ({ err: s.err, score: s.score, depth: -add(quatRotate(s.q, centreP), s.t)[2] }));

    const Cs = add(quatRotate(size.q, centreP), size.t);
    const palmDepthSize = -Cs[2];
    let palmDepthLidar = null;
    let lidarWeight = 0;
    let centres = null;
    if (samples.length) {
      centres = lidarCentres(samples, halfPalm, quatRotate(size.q, [0, 1, 0]));
      const diffs = samples.map((s, i) => -centres[i][2] - -add(quatRotate(size.q, s.P), size.t)[2]);
      palmDepthLidar = palmDepthSize + median(diffs);
      const win = (2 * (frame.window ?? 2) + 1) ** 2;
      const q = mean(samples.map((s) => clamp(s.jt.nHand / (0.5 * win), 0, 1) * (0.3 + 0.7 * clamp(s.jt.hi, 0, 1))));
      lidarWeight = clamp(o.lidarTrust * (samples.length / obs.length) * q * Math.min(1, samples.length / 3), 0, 1);
    }
    debug.lidarCentres = centres ? centres.map((c) => camToWorld(cam, c)) : [];

    let qL = size.q;
    let tL = size.t;
    let palmDepth = palmDepthSize;
    let used = 'size';
    if (o.method === 'fused' && palmDepthLidar !== null) {
      palmDepth = lidarWeight * palmDepthLidar + (1 - lidarWeight) * palmDepthSize;
      tL = add(size.t, scale(Cs, palmDepth / palmDepthSize - 1));
      used = 'fused';
    } else if (o.method === 'lidar' && samples.length >= 3) {
      let fit = fitRigid(samples.map((s) => s.P), lidarCentres(samples, halfPalm, null));
      fit = fitRigid(samples.map((s) => s.P), lidarCentres(samples, halfPalm, quatRotate(fit.q, [0, 1, 0])));
      qL = fit.q;
      tL = fit.t;
      palmDepth = -add(quatRotate(qL, centreP), tL)[2];
      used = 'lidar';
    }
    const reprojErrPx = Math.sqrt(reprojCost(obs, K, qL, tL) / obs.length);
    debug.palmDepth = palmDepth;
    if (!(palmDepth >= o.depthRange[0] && palmDepth <= o.depthRange[1])) return { reason: 'depth-range' };
    if (!(reprojErrPx <= o.maxReprojPx)) return { reason: 'reprojection' };

    // palm joints in world
    const raw = new Array(21);
    PALM_JOINTS.forEach((j, k) => (raw[j] = camToWorld(cam, add(quatRotate(qL, shape[k]), tL))));
    const qPalm = quatMul(qCam, qL);
    const palmY = quatRotate(qPalm, [0, 1, 0]);
    let filled = PALM_JOINTS.filter((j) => hand.joints[j].c < o.minJointConf).length;

    // fingers along their rays
    const useLidar = o.method !== 'size';
    const history = this.prevRaw && t - this.prevRaw.t < HISTORY_S && t >= this.prevRaw.t ? this.prevRaw.joints : null;
    const roots = emptyRoots();
    let noRoot = 0;
    const toPalm = (d) => quatRotate(quatConj(qPalm), d);
    const fromPalm = (d) => quatRotate(qPalm, d);
    const palmX = quatRotate(qPalm, [1, 0, 0]);
    const palmZ = quatRotate(qPalm, [0, 0, 1]);
    // what is already placed and could hide a joint from the camera (and from LiDAR)
    const occluders = [boxFromFrame(add(raw[0], quatRotate(qPalm, palmBoxCentre(model, chir))), palmX, palmY, palmZ, [model.palm.width, model.palm.thickness, model.palm.length])];
    for (const finger of FINGERS) {
      const chain = CHAIN[finger];
      const g = model.fingers[finger];
      let prev = raw[chain[0]];
      let prevDir = norm(sub(prev, raw[0]));
      let prevPalmDir = restDirection(model, finger, chir);
      const hyper = ((finger === 'thumb' ? 35 : 25) * Math.PI) / 180;
      for (let s = 0; s < 3; s++) {
        const j = chain[s + 1];
        const L = g.lengths[s];
        const jt = hand.joints[j];
        let p;
        if (jt.c >= o.minJointConf) {
          const r = ray(cam, jt.x, jt.y);
          const rel = sub(prev, r.o);
          const b = dot(r.d, rel);
          const disc = b * b - (dot(rel, rel) - L * L);
          let opts = disc < 0 ? [] : [b - Math.sqrt(disc), b + Math.sqrt(disc)].filter((x) => x > 0.02).map((x) => add(r.o, scale(r.d, x)));
          if (!opts.length) {
            p = add(r.o, scale(r.d, Math.max(0.02, b)));
            noRoot++;
          } else if (opts.length === 1) {
            p = opts[0];
          } else {
            let how = null;
            const lidarOk = useLidar && jt.dHand > 0 && jt.nHand >= 3;
            if (lidarOk) {
              const allowed = lidarAllowed(cam, opts, jt.dHand);
              if (allowed.length === 1) {
                p = allowed[0];
                how = 'lidar';
              }
              opts = allowed;
            }
            // a finger does not bend far backwards (towards the back of the hand)
            const backBend = (x) => Math.asin(clamp(dot(norm(sub(x, prev)), palmY), -1, 1)) - Math.asin(clamp(dot(prevDir, palmY), -1, 1));
            if (!how && opts.length === 2) {
              const limit = ((finger === 'thumb' ? 60 : s === 0 ? 50 : 35) * Math.PI) / 180;
              const anat = opts.filter((x) => backBend(x) <= limit);
              if (anat.length === 1) {
                p = anat[0];
                how = 'bend';
              }
            }
            const hp = history ? history[j] : null;
            const near = hp ? opts.reduce((a2, b2) => (dist(b2, hp) < dist(a2, hp) ? b2 : a2)) : null;
            if (!how && hp) {
              // history decides when it is clear: one root close to where the joint just was
              const far = opts.find((x) => x !== near);
              if (dist(near, hp) < HISTORY_CLEAR && dist(far, hp) - dist(near, hp) > HISTORY_MARGIN) {
                p = near;
                how = 'history';
              }
            }
            if (!how && lidarOk) {
              const q = lidarBand(cam, r, opts, jt.dHand, g.thickness, occluders);
              if (q) {
                p = q;
                how = 'lidar';
              }
            }
            if (!how) {
              const cost = (x) => angle(prevDir, norm(sub(x, prev))) + (backBend(x) > hyper ? Math.PI / 2 : 0);
              p = opts.reduce((a2, b2) => (cost(b2) < cost(a2) ? b2 : a2));
              how = 'bend';
            }
            roots[how]++;
          }
          this.memory[finger][s] = toPalm(norm(sub(p, prev)));
        } else {
          filled++;
          const dPalm = this.memory[finger][s] || prevPalmDir;
          p = add(prev, scale(fromPalm(dPalm), L));
        }
        raw[j] = p;
        occluders.push(segmentBox(prev, p, g.width, g.thickness, palmX, palmY));
        prevDir = norm(sub(p, prev));
        prevPalmDir = toPalm(prevDir);
        prev = p;
      }
    }

    // filter, predict, pose
    let out = raw;
    if (o.filter) {
      out = raw.map((p, j) => {
        const f = this.filters[j].filter(p, t);
        return o.predict ? add(f, scale(this.filters[j].velocity, o.predict)) : f;
      });
    }
    const pose = poseFromJoints(model, out, chir, t);
    pose.quality = {
      method: used,
      hand: hand.index,
      chirality: chir,
      palmDepthLidar,
      palmDepthSize,
      palmDepth,
      lidarWeight,
      lidarJoints: samples.length,
      reprojErrPx,
      filled,
      noRoot,
      roots,
      held: false,
    };
    debug.roots = roots;
    debug.raw = raw;

    this.prevRaw = { t, joints: raw };
    this.prevPalm = { t, q: qPalm, origin: raw[0] };
    this.prevImg = { t, c: pick.c };
    return { pose };
  }
}

// exported for the tests and the replay tool
export const _internals = { pnp, weakInit, tiltFlip, lidarCentres, len };
