// The hand scan: the user lays one hand flat, palm down, on a table for 2-3 s; from Vision's
// joints and the LiDAR depth patches around the hand this measures the hand model (model.js):
// thickness from how far the hand's surface stands above the table, joint centres where the
// joints' rays meet the table plane raised by half a thickness, bone lengths and widths from
// those. Done once; the tracker then only has to find where the known hand is.
// Hand sizes are not blind and may be logged and shown.
//
// API
//   new HandScanner({durationS = 2.5, minFrames = 20, ...tuning (SCAN_DEFAULTS)})
//   push(frame: HandFrame, planes?) -> {state, progress, hint, issues}
//     state 'waiting' | 'collecting' | 'done' | 'failed'; progress 0..1; hint = one short Chinese
//     sentence for the screen; issues = codes for this frame (ISSUE_HINTS keys).
//     planes = the ar.planes list (fallback for the table when LiDAR does not give one).
//     Needs depth patches: the page turns on patchEvery: 1 while scanning (and preferably
//     patchStep: 1 with patchMax ~ 20000, so the mask is not thinned out near the phone).
//   status -> the last push's result (also .still = {residual, shift, limit, shiftLimit} of
//     this frame's stillness test, when it ran)
//   diagnostics() -> {pushes, good, counts {issue: frames}, streaks, bestProgress, still
//     {n, min, p50, p90, max} of the residual, shift {...}, limits} over the whole attempt
//   result() -> {model, measurements} | null (null before minFrames good frames)
//     model.source = 'scan'; measurements = {cm (summaryCm), sources, table {height, normal,
//     rms, source}, frames, spreads (IQR, cm), chirality {vision, geometry}, issues}
//   reset()
//
// Per frame (all must hold, else the frame is bad):
//   exactly one hand (counting hands with >= 10 joints at c >= 0.5); >= 19 of its 21 joints at
//   c >= 0.5 and a patch ('joints-missing'; when a missing joint, extrapolated along its finger,
//   lands outside the image or the screen, the hand is cut off: also 'off-screen', whose hint comes
//   first); every such joint inside the on-screen part of the image; a table plane:
//   the patch's non-person pixels with LiDAR confidence >= 1, unprojected, kept within 2 cm of
//   the most common 1-cm height, fit, drop > 1.5 cm, refit; normal within 15 deg of up, rms
//   < 1 cm, >= 200 points (else a horizontal ar.planes plane under the hand); palm depth
//   0.2-0.6 m; the palm (median height above the table of the person pixels inside the palm
//   polygon) at most 5 cm high (resting on the table, not hovering); flat & open (2D angle
//   between consecutive bones of each finger < 30 deg); still: over the last 0.3 s, each
//   frame's joints are fitted onto the last frame's by a 2D shift, turn and scale (a hand-held
//   phone's shake moves, turns and resizes the whole hand in the image; that is not the hand
//   moving, and each frame is measured with its own camera pose anyway), then the 80th
//   percentile over the joints of their largest distance from their mean < stillMax (0.004 of
//   the image width) — 'moving'; and the whole hand's shift over those 0.3 s < shiftMax (0.03,
//   motion blur) — 'phone-moving'. durationS of continuous good frames (bad frames for more than maxGapS
//   = 0.5 s restart; longer than stillS, so one jolt does not throw the streak away), at least
//   minFrames, end the scan. Frames without a patch neither count nor break it.
//
// Measurements (over the collected frames; medians, spread = IQR):
//   thickness first: palm = median height of the person pixels (confidence >= 1) inside the
//     palm polygon (wrist, thumbCMC, indexMCP .. littleMCP); finger = 80th percentile of the
//     heights in a narrow corridor (half a finger width wide) along the middle segment (thumb:
//     MP->IP) — mask edges mix in table pixels, hence the upper quantile. Only the middle
//     segment: the proximal one rises towards the knuckle (and the little finger's runs beside
//     the palm), so it reads too high. Plausible palm 1.5-4.5 cm, finger 0.8-2.5 cm, else the
//     defaults (2.6 / 1.6 cm, source 'default').
//   joint centres: each joint's ray meets the table plane raised by half the local thickness
//     (palm joints: palm; finger joints: that finger) -> bone lengths, handLength = |middleTip -
//     wrist|, palmLength = |middleMCP - wrist|, palmShape in palm space (+Y = table normal).
//   palm width: the person mask's extent through the midpoint of indexMCP and littleMCP,
//     stepping in 1 mm steps on the raised plane both ways until two samples leave the mask.
//     The line is perpendicular to the palm's axis (wrist -> middleMCP) rather than along the
//     slanted knuckle line: that is the hand breadth as anthropometry defines it and the width
//     of the palm box, which is aligned with that axis. Each edge is then moved to the height
//     LiDAR sees just inside it (the outline is where the camera's ray grazes the hand, which is
//     not at half the thickness: a sharp edge grazes at the top; clamped to 0.25-1.1 of the
//     thickness, as mask edges mix in table depth). On the thumb's side the search stops halfway
//     between indexMCP and where the thumb (MP -> tip) crosses that line, at least 1 cm past
//     indexMCP: a thumb held against the index finger merges with the palm in the mask; then
//     that frame gives no width rather than one that includes the thumb. Fallback: MCP span +
//     mean finger width.
//   finger widths: the mask's extent across the proximal segment (thumb: MP->IP) at 65% of
//     its length (past the web between the fingers, and past the palm's edge for the little
//     finger); each side stops at half the gap to the neighbouring finger (a touching
//     neighbour would otherwise be measured too); one side capped -> twice the other side;
//     both -> no value. Fallback: defaults thumb 2.0, index 1.8, middle 1.8, ring 1.7, little
//     1.5 cm.
//   chirality: majority of Vision's labels and of a geometric check that assumes palm-down
//     (thumb on palm +X = right hand); on disagreement geometry wins and an issue is recorded.

import { PALM_JOINTS, CHAIN, FINGERS, J } from './joints.js';
import {
  add, sub, scale, dot, cross, norm, dist, angle, ray, rayPlane, unproject, project, depthOf, imageToView, fitPlane,
  median, quantile, iqr, mean,
} from './geom.js';
import { DEFAULT_SIZES, summaryCm, validModel } from './model.js';

export const SCAN_DEFAULTS = {
  durationS: 2.5,
  minFrames: 20,
  maxGapS: 0.5,
  minJointConf: 0.5,
  minGoodJoints: 19,
  depthRange: [0.2, 0.6],
  stillS: 0.3,
  stillMax: 0.004,
  shiftMax: 0.03,
  flatDeg: 30,
  maxPalmHeight: 0.05,
};

export const ISSUE_HINTS = {
  'no-hand': '把手摊平放在桌上',
  'two-hands': '只放一只手',
  'off-screen': '整只手要在屏幕里',
  'joints-missing': '手指伸直分开，光线亮一点',
  'no-table': '没看到桌面',
  'too-close': '太近了，手机抬高一点',
  'too-far': '太远了，手机放低一点',
  'no-palm-depth': '把手摊平放在桌上',
  'not-on-table': '把手摊平放在桌上',
  'fingers-bent': '手指伸直',
  'phone-moving': '手机拿稳，手肘撑在桌上',
  moving: '手别动，再等一下',
  'no-patch': '别动，再等一下',
};
const ISSUE_ORDER = Object.keys(ISSUE_HINTS);
const HINT_COLLECTING = '很好，别动';
const HINT_DONE = '量好了';
const HINT_FAILED = '没量好，再来一次';

const FINGER_OF = {};
for (const f of FINGERS) for (const j of CHAIN[f].slice(1)) FINGER_OF[j] = f;
const PALM_SET = new Set(PALM_JOINTS);
const cm1 = (v) => Math.round(v * 1000) / 10;

function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, k = poly.length - 1; i < poly.length; k = i++) {
    const [xi, yi] = poly[i];
    const [xk, yk] = poly[k];
    if (yi > y !== yk > y && x < ((xk - xi) * (y - yi)) / (yk - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Distance from (x, y) to the segment a-b. */
function segmentDistance(x, y, a, b) {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const l2 = vx * vx + vy * vy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * vx + (y - a[1]) * vy) / l2)) : 0;
  return Math.hypot(x - a[0] - t * vx, y - a[1] - t * vy);
}

/**
 * Is plane-local (x, z) on the plane, allowing `margin` metres beyond its edge? ARKit's boundary
 * polygon is in the anchor's own space (the same as x, z) and exact. Without it, the extent is a
 * rectangle around `center` turned by rotationOnYAxis — real planes are usually turned, and the
 * sign convention is not documented, so the point counts if it is inside either way.
 */
export function onPlane(pl, x, z, margin) {
  const b = pl.boundary;
  if (Array.isArray(b) && b.length >= 3 && b.every((q) => Array.isArray(q) && q.length >= 2)) {
    if (pointInPolygon(x, z, b)) return true;
    for (let i = 0; i < b.length; i++) if (segmentDistance(x, z, b[i], b[(i + 1) % b.length]) <= margin) return true;
    return false;
  }
  const c = pl.center || [0, 0, 0];
  const e = pl.extent || [0, 0];
  const dx = x - c[0];
  const dz = z - c[2];
  const a = Number.isFinite(pl.rotationOnYAxis) ? pl.rotationOnYAxis : 0;
  for (const s of a ? [1, -1] : [1]) {
    const cs = Math.cos(s * a);
    const sn = Math.sin(s * a);
    const u = dx * cs - dz * sn;
    const v = dx * sn + dz * cs;
    if (Math.abs(u) <= e[0] / 2 + margin && Math.abs(v) <= e[1] / 2 + margin) return true;
  }
  return false;
}

/** The table from an ar.planes list: the nearest horizontal plane the palm's ray meets on it. */
function planeFromList(planes, r) {
  let best = null;
  for (const pl of planes || []) {
    if (pl.alignment !== 'horizontal' || pl.class === 'ceiling' || !pl.transform) continue;
    const T = pl.transform;
    const n = norm([T[4], T[5], T[6]]);
    if (n[1] < 0.95) continue;
    const o = [T[12], T[13], T[14]];
    const hit = rayPlane(r, { p: o, n });
    if (!hit) continue;
    const d = sub(hit, o);
    const lx = dot(d, norm([T[0], T[1], T[2]]));
    const lz = dot(d, norm([T[8], T[9], T[10]]));
    if (!onPlane(pl, lx, lz, 0.05)) continue;
    const tHit = dist(hit, r.o);
    if (!best || tHit < best.tHit) best = { p: o, n, rms: null, count: 0, source: 'planes', tHit };
  }
  return best;
}

export class HandScanner {
  constructor(options = {}) {
    this.options = { ...SCAN_DEFAULTS, ...options };
    this.reset();
  }

  reset() {
    this.frames = []; // the current streak of good frames
    this.recent = []; // {t, xy: [[x, y] x 21]} of every frame with one hand, for the stillness check
    this.streakStart = null;
    this.lastGoodT = null;
    this.state = 'waiting';
    this._result = null;
    this.status = { state: 'waiting', progress: 0, hint: ISSUE_HINTS['no-hand'], issues: [] };
    this._still = null;
    this.diag = { pushes: 0, good: 0, counts: {}, streaks: 0, bestProgress: 0, residual: [], shift: [] };
  }

  /** What happened over the whole attempt (for the log when a scan fails or times out). */
  diagnostics() {
    const d = this.diag;
    const r5 = (x) => Math.round(x * 1e5) / 1e5;
    const stats = (v) =>
      v.length
        ? { n: v.length, min: r5(Math.min(...v)), p50: r5(quantile(v, 0.5)), p90: r5(quantile(v, 0.9)), max: r5(Math.max(...v)) }
        : { n: 0 };
    return {
      pushes: d.pushes,
      good: d.good,
      counts: { ...d.counts },
      streaks: d.streaks,
      bestProgress: Math.round(d.bestProgress * 100) / 100,
      still: stats(d.residual),
      shift: stats(d.shift),
      limits: { stillMax: this.options.stillMax, shiftMax: this.options.shiftMax, maxGapS: this.options.maxGapS },
    };
  }

  push(frame, planes = null) {
    if (this.state === 'done' || this.state === 'failed') return this.status;
    const o = this.options;
    const t = frame.t;
    this._still = null;
    const { issues, data } = this._check(frame, planes);
    const d = this.diag;
    d.pushes++;
    for (const k of issues) d.counts[k] = (d.counts[k] || 0) + 1;
    if (this._still) {
      // bounded: ~2 min at 30 Hz
      if (d.residual.length < 4000) d.residual.push(this._still.residual);
      if (d.shift.length < 4000) d.shift.push(this._still.shift);
    }
    if (issues.length === 1 && issues[0] === 'no-patch') {
      // neither good nor bad: the native layer sends patches only every N-th frame
      this.status = { ...this.status, issues, still: this._still };
      return this.status;
    }
    if (!issues.length) {
      d.good++;
      if (this.streakStart === null) {
        this.streakStart = t;
        d.streaks++;
      }
      this.lastGoodT = t;
      this.frames.push(data);
    } else if (this.lastGoodT !== null && t - this.lastGoodT > o.maxGapS) {
      this.frames = [];
      this.streakStart = null;
      this.lastGoodT = null;
    }
    const span = this.streakStart === null ? 0 : this.lastGoodT - this.streakStart;
    const progress = Math.min(1, span / o.durationS);
    d.bestProgress = Math.max(d.bestProgress, progress);
    if (span >= o.durationS && this.frames.length >= o.minFrames) {
      const res = this._compute();
      this._result = res;
      this.state = res && validModel(res.model) ? 'done' : 'failed';
      this.status = { state: this.state, progress: 1, hint: this.state === 'done' ? HINT_DONE : HINT_FAILED, issues, still: this._still };
      return this.status;
    }
    this.state = this.frames.length ? 'collecting' : 'waiting';
    const first = ISSUE_ORDER.find((k) => issues.includes(k));
    this.status = { state: this.state, progress, hint: first ? ISSUE_HINTS[first] : HINT_COLLECTING, issues, still: this._still };
    return this.status;
  }

  result() {
    if (this._result) return this._result;
    if (this.frames.length < this.options.minFrames) return null;
    return this._compute();
  }

  /** Checks one frame; returns the issue codes and, if none, what the measurements need. */
  _check(frame, planes) {
    const o = this.options;
    const issues = [];
    const real = frame.hands.filter((h) => h.joints.filter((j) => j.c >= o.minJointConf).length >= 10);
    if (!real.length) return { issues: ['no-hand'] };
    if (real.length > 1) return { issues: ['two-hands'] };
    const hand = real[0];
    const cam = frame.cam;
    const [IW, IH] = cam.imageResolution || [1920, 1440];
    const good = hand.joints.filter((j) => j.c >= o.minJointConf);

    // stillness needs the recent history, also of bad frames
    // in units of the image width, so x and y count the same
    this.recent.push({ t: frame.t, xy: hand.joints.map((j) => [j.x, (j.y * IH) / IW]), c: hand.joints.map((j) => j.c) });
    while (this.recent.length && this.recent[0].t < frame.t - o.stillS) this.recent.shift();

    if (good.length < o.minGoodJoints) {
      issues.push('joints-missing');
      if (this._cutOff(hand, frame, IW, IH)) issues.push('off-screen');
    }
    if (!issues.includes('off-screen') && frame.display && good.some((j) => {
      const [X, Y] = imageToView(frame.display, j.x, j.y);
      return X < 0 || X > 1 || Y < 0 || Y > 1;
    })) issues.push('off-screen');
    if (issues.length) return { issues };
    const patch = hand.patch;
    if (!patch) return { issues: ['no-patch'] };

    // the patch's pixels in world space
    const n = patch.w * patch.h;
    const pts = new Array(n);
    for (let jj = 0, k = 0; jj < patch.h; jj++) {
      for (let ii = 0; ii < patch.w; ii++, k++) {
        const d = patch.depth[k];
        if (!(d > 0) || patch.conf[k] < 1) continue;
        const [x, y] = patch.xy(ii, jj);
        pts[k] = { x, y, P: unproject(cam, x, y, d), d, person: patch.person[k] === 1 };
      }
    }

    // the table
    const palmXY = PALM_JOINTS.map((j) => [hand.joints[j].x, hand.joints[j].y]);
    const palmRay = ray(cam, mean(palmXY.map((p) => p[0])), mean(palmXY.map((p) => p[1])));
    let plane = this._tablePlane(pts);
    if (!plane) plane = planeFromList(planes, palmRay);
    if (!plane) return { issues: ['no-table'] };

    // palm: height above the table and distance
    const polyPx = palmXY.map(([x, y]) => [x * IW, y * IH]);
    const palmHeights = [];
    const palmDepths = [];
    const heights = new Float32Array(n).fill(NaN);
    for (let k = 0; k < n; k++) {
      const p = pts[k];
      if (!p || !p.person) continue;
      heights[k] = dot(sub(p.P, plane.p), plane.n);
      if (pointInPolygon(p.x * IW, p.y * IH, polyPx)) {
        palmHeights.push(heights[k]);
        palmDepths.push(p.d);
      }
    }
    if (palmHeights.length < 15) return { issues: ['no-palm-depth'] };
    const palmH = median(palmHeights);
    const palmDepth = median(palmDepths);
    if (palmDepth < o.depthRange[0]) issues.push('too-close');
    if (palmDepth > o.depthRange[1]) issues.push('too-far');
    if (palmH > o.maxPalmHeight) issues.push('not-on-table');

    // flat and open: 2D angles between consecutive bones
    const flatRad = (o.flatDeg * Math.PI) / 180;
    for (const f of FINGERS) {
      const c = CHAIN[f].map((j) => [hand.joints[j].x * IW, hand.joints[j].y * IH, 0]);
      for (let s = 0; s < 2; s++) {
        if (angle(sub(c[s + 1], c[s]), sub(c[s + 2], c[s + 1])) > flatRad) {
          issues.push('fingers-bent');
          break;
        }
      }
      if (issues.includes('fingers-bent')) break;
    }

    // still (see the header): the hand's shape must hold; the whole hand may drift a little
    const span = this.recent.length ? frame.t - this.recent[0].t : 0;
    if (span < o.stillS * 0.6) issues.push('moving');
    else {
      const still = this._stillness(o.minJointConf);
      this._still = { residual: still.residual, shift: still.shift, limit: o.stillMax, shiftLimit: o.shiftMax };
      if (still.shift > o.shiftMax) issues.push('phone-moving');
      if (still.residual > o.stillMax) issues.push('moving');
    }
    if (issues.length) return { issues };

    // finger heights in corridors (see the header)
    const fingerH = {};
    for (const f of FINGERS) {
      const chain = CHAIN[f];
      // the middle segment lies flat on the table; the proximal one rises to the knuckle and,
      // for the little finger, runs beside the palm, so it would read too high
      const segs = f === 'thumb' ? [[chain[1], chain[2], 0.2, 0.9]] : [[chain[1], chain[2], 0.1, 0.9]];
      const hs = [];
      for (const [a, b, t0, t1] of segs) {
        const A = [hand.joints[a].x * IW, hand.joints[a].y * IH];
        const B = [hand.joints[b].x * IW, hand.joints[b].y * IH];
        const hitA = rayPlane(ray(cam, hand.joints[a].x, hand.joints[a].y), plane);
        const dA = hitA ? depthOf(cam, hitA) : palmDepth;
        const halfW = (0.25 * DEFAULT_SIZES.fingerWidth[f] * cam.intrinsics[0]) / dA;
        const ab = [B[0] - A[0], B[1] - A[1]];
        const L2 = ab[0] * ab[0] + ab[1] * ab[1];
        if (L2 < 4) continue;
        const Lab = Math.sqrt(L2);
        for (let k = 0; k < n; k++) {
          const p = pts[k];
          if (!p || !p.person) continue;
          const px = p.x * IW - A[0];
          const py = p.y * IH - A[1];
          const tt = (px * ab[0] + py * ab[1]) / L2;
          if (tt < t0 || tt > t1) continue;
          if (Math.abs(px * ab[1] - py * ab[0]) / Lab > halfW) continue;
          hs.push(heights[k]);
        }
      }
      fingerH[f] = hs.length >= 6 ? quantile(hs, 0.8) : null;
    }

    return {
      issues,
      data: {
        t: frame.t,
        cam,
        joints: hand.joints.map((j) => ({ x: j.x, y: j.y, c: j.c })),
        chirality: hand.chirality,
        plane,
        patch,
        palmH,
        palmDepth,
        fingerH,
      },
    };
  }

  /**
   * Are joints missing because the hand runs out of the picture? Each missing joint is
   * extrapolated along its finger from the last two good joints before it (bone by bone, as long
   * as the last good bone; from wrist -> root at half its length per bone when only the root is
   * good; a missing root from the next two joints; a missing wrist from the middle finger's first
   * bone, twice); if one lands outside the image, or outside the screen when
   * the frame has a display transform, the hand is cut off. Joints with no two good neighbours to
   * go by are not counted either way.
   */
  _cutOff(hand, frame, IW, IH) {
    const minC = this.options.minJointConf;
    const J2 = hand.joints;
    const good = (k) => J2[k] && J2[k].c >= minC;
    const outside = (x, y) => {
      if (x < 0 || x > 1 || y < 0 || y > 1) return true;
      if (!frame.display) return false;
      const [X, Y] = imageToView(frame.display, x, y);
      return X < 0 || X > 1 || Y < 0 || Y > 1;
    };
    const beyond = (a, b, k) => outside(J2[b].x + (J2[b].x - J2[a].x) * k, J2[b].y + (J2[b].y - J2[a].y) * k);
    for (const f of FINGERS) {
      const c = CHAIN[f];
      for (let k = 0; k < 4; k++) {
        if (good(c[k])) continue;
        if (k === 0) {
          if (good(c[1]) && good(c[2]) && beyond(c[2], c[1], 1)) return true;
          continue;
        }
        let g = k - 1;
        while (g >= 1 && !good(c[g])) g--;
        if (g >= 1 && good(c[g]) && good(c[g - 1])) {
          if (beyond(c[g - 1], c[g], k - g)) return true;
        } else if (good(c[0]) && good(J.wrist)) {
          // only the root is good: along wrist -> root, at about half the palm per bone
          const x = J2[c[0]].x + (J2[c[0]].x - J2[J.wrist].x) * 0.5 * k;
          const y = J2[c[0]].y + (J2[c[0]].y - J2[J.wrist].y) * 0.5 * k;
          if (outside(x, y)) return true;
        }
      }
    }
    if (!good(J.wrist) && good(J.middleMCP) && good(J.middlePIP) && beyond(J.middlePIP, J.middleMCP, 2)) return true;
    return false;
  }

  /**
   * Over this.recent (joints good in every frame): shift = the largest distance of a frame's
   * centroid from the mean centroid; residual = 80th percentile over the joints of their largest
   * distance from their mean, after each frame is fitted onto the last one by a 2D similarity
   * (shift, turn, scale; least squares).
   */
  _stillness(minConf) {
    const R = this.recent;
    let use = [];
    for (let j = 0; j < 21; j++) if (R.every((r) => r.c[j] >= minConf)) use.push(j);
    if (use.length < 5) use = [...Array(21).keys()];
    const centre = R.map((r) => [mean(use.map((j) => r.xy[j][0])), mean(use.map((j) => r.xy[j][1]))]);
    const cx = mean(centre.map((p) => p[0]));
    const cy = mean(centre.map((p) => p[1]));
    const shift = Math.max(...centre.map((p) => Math.hypot(p[0] - cx, p[1] - cy)));
    const centred = R.map((r, i) => use.map((j) => [r.xy[j][0] - centre[i][0], r.xy[j][1] - centre[i][1]]));
    const ref = centred[centred.length - 1];
    const aligned = centred.map((P) => {
      // p -> [a -b; b a] p minimising |that - ref|^2
      let pp = 0;
      let pq = 0;
      let px = 0;
      for (let k = 0; k < P.length; k++) {
        pp += P[k][0] * P[k][0] + P[k][1] * P[k][1];
        pq += P[k][0] * ref[k][0] + P[k][1] * ref[k][1];
        px += P[k][0] * ref[k][1] - P[k][1] * ref[k][0];
      }
      if (!(pp > 0)) return P;
      const a = pq / pp;
      const b = px / pp;
      return P.map(([x, y]) => [a * x - b * y, b * x + a * y]);
    });
    const ranges = [];
    for (let k = 0; k < use.length; k++) {
      const xs = aligned.map((P) => P[k]);
      const mx = mean(xs.map((p) => p[0]));
      const my = mean(xs.map((p) => p[1]));
      ranges.push(Math.max(...xs.map((p) => Math.hypot(p[0] - mx, p[1] - my))));
    }
    return { residual: quantile(ranges, 0.8), shift };
  }

  _tablePlane(pts) {
    const ys = [];
    const cand = [];
    for (const p of pts) {
      if (!p || p.person) continue;
      cand.push(p.P);
      ys.push(p.P[1]);
    }
    if (cand.length < 200) return null;
    // the most common 1 cm height
    const bins = new Map();
    for (const y of ys) {
      const b = Math.floor(y / 0.01);
      bins.set(b, (bins.get(b) || 0) + 1);
    }
    let mode = null;
    let best = -1;
    for (const [b, c] of bins) {
      // a bin and its neighbours, so a plane on a bin boundary is not split
      const s = c + (bins.get(b - 1) || 0) + (bins.get(b + 1) || 0);
      if (s > best) {
        best = s;
        mode = b;
      }
    }
    const y0 = (mode + 0.5) * 0.01;
    let sel = cand.filter((P) => Math.abs(P[1] - y0) < 0.02);
    if (sel.length < 200) return null;
    let fit = fitPlane(sel);
    for (let it = 0; it < 2; it++) {
      const keep = sel.filter((P) => Math.abs(dot(sub(P, fit.p), fit.n)) < 0.015);
      if (keep.length < 200) return null;
      fit = fitPlane(keep);
      sel = keep;
    }
    if (Math.acos(Math.min(1, fit.n[1])) > (15 * Math.PI) / 180 || fit.rms > 0.01) return null;
    return { p: fit.p, n: fit.n, rms: fit.rms, count: sel.length, source: 'lidar' };
  }

  _compute() {
    const frames = this.frames;
    if (frames.length < 1) return null;
    const issues = [];
    const sources = { fingerThickness: {}, fingerWidth: {} };

    // thickness first
    let palmT = median(frames.map((f) => f.palmH));
    sources.palmThickness = 'mask';
    if (!(palmT >= 0.015 && palmT <= 0.045)) {
      issues.push('palm-thickness-default');
      palmT = DEFAULT_SIZES.palmThickness;
      sources.palmThickness = 'default';
    }
    const fingerT = {};
    for (const f of FINGERS) {
      const v = frames.map((fr) => fr.fingerH[f]).filter((x) => x !== null && Number.isFinite(x));
      const m = v.length >= Math.max(3, frames.length * 0.3) ? median(v) : NaN;
      if (m >= 0.008 && m <= 0.025) {
        fingerT[f] = m;
        sources.fingerThickness[f] = 'mask';
      } else {
        fingerT[f] = DEFAULT_SIZES.fingerThickness;
        sources.fingerThickness[f] = 'default';
        issues.push(`${f}-thickness-default`);
      }
    }

    // joint centres per frame, and what follows from them
    const per = [];
    for (const fr of frames) {
      const C = new Array(21);
      let ok = true;
      for (let j = 0; j < 21; j++) {
        const half = PALM_SET.has(j) ? palmT / 2 : fingerT[FINGER_OF[j]] / 2;
        const raised = { p: add(fr.plane.p, scale(fr.plane.n, half)), n: fr.plane.n };
        const hit = rayPlane(ray(fr.cam, fr.joints[j].x, fr.joints[j].y), raised);
        if (!hit) {
          ok = false;
          break;
        }
        C[j] = hit;
      }
      if (!ok) continue;
      const Y = fr.plane.n;
      const zRaw = sub(C[J.middleMCP], C[J.wrist]);
      const Z = norm(sub(zRaw, scale(Y, dot(zRaw, Y))));
      const X = cross(Y, Z);
      const toPalm = (p) => {
        const d = sub(p, C[J.wrist]);
        return [dot(d, X), dot(d, Y), dot(d, Z)];
      };
      const bones = Object.fromEntries(FINGERS.map((f) => [f, [0, 1, 2].map((s) => dist(C[CHAIN[f][s]], C[CHAIN[f][s + 1]]))]));
      const thumbX = mean([J.thumbMP, J.thumbIP, J.thumbTip].map((j) => toPalm(C[j])[0]));
      per.push({
        fr,
        C,
        X,
        Y,
        Z,
        bones,
        handLength: dist(C[J.middleTip], C[J.wrist]),
        palmLength: dist(C[J.middleMCP], C[J.wrist]),
        shape: PALM_JOINTS.map((j) => toPalm(C[j])),
        geom: thumbX >= 0 ? 'right' : 'left',
      });
    }
    if (per.length < Math.max(3, frames.length * 0.5)) return null;

    // chirality
    const vision = { left: 0, right: 0, unknown: 0 };
    for (const fr of frames) vision[fr.chirality] = (vision[fr.chirality] || 0) + 1;
    const geometry = { left: 0, right: 0 };
    for (const p of per) geometry[p.geom]++;
    const geomChir = geometry.right >= geometry.left ? 'right' : 'left';
    const visChir = vision.right === vision.left ? null : vision.right > vision.left ? 'right' : 'left';
    const chirality = geomChir;
    sources.chirality = visChir === null ? 'geometry' : visChir === geomChir ? 'both' : 'geometry';
    if (visChir && visChir !== geomChir) issues.push('chirality-vision-disagrees');

    // widths from the person mask
    const personAt = (fr, P) => {
      const q = project(fr.cam, P);
      if (!(q.z > 0)) return -1;
      const k = fr.patch.at(q.x, q.y);
      return k < 0 ? -1 : fr.patch.person[k];
    };
    /** Median height above the table of the person pixels around the image point of P (3x3). */
    const surfaceHeight = (fr, P) => {
      const q = project(fr.cam, P);
      const k = fr.patch.at(q.x, q.y);
      if (k < 0) return null;
      const { w, h } = fr.patch;
      const i0 = k % w;
      const j0 = (k - i0) / w;
      const hs = [];
      for (let j = Math.max(0, j0 - 1); j <= Math.min(h - 1, j0 + 1); j++) {
        for (let i = Math.max(0, i0 - 1); i <= Math.min(w - 1, i0 + 1); i++) {
          const kk = j * w + i;
          if (!fr.patch.person[kk] || !(fr.patch.depth[kk] > 0) || fr.patch.conf[kk] < 1) continue;
          const [x, y] = fr.patch.xy(i, j);
          hs.push(dot(sub(unproject(fr.cam, x, y, fr.patch.depth[kk]), fr.plane.p), fr.plane.n));
        }
      }
      return hs.length ? median(hs) : null;
    };
    /**
     * Distance from P (on the plane raised by half the local thickness T) along dir (in that
     * plane) to the edge of the person mask: step until two samples miss, then move the edge to
     * the height LiDAR sees just inside it (see the header). Null at the cap or the patch's edge.
     */
    const extent = (fr, P, dir, cap, T, step = 0.0005) => {
      let lastIn = 0;
      let misses = 0;
      for (let s = step; s <= cap; s += step) {
        const v = personAt(fr, add(P, scale(dir, s)));
        if (v < 0) return null;
        if (v === 1) {
          lastIn = s;
          misses = 0;
        } else if (++misses >= 2) {
          const sEdge = lastIn + step / 2;
          let hgt = surfaceHeight(fr, add(P, scale(dir, lastIn)));
          if (hgt === null) return sEdge;
          hgt = Math.min(1.1 * T, Math.max(0.25 * T, hgt));
          const q = project(fr.cam, add(P, scale(dir, sEdge)));
          const hit = rayPlane(ray(fr.cam, q.x, q.y), { p: add(fr.plane.p, scale(fr.plane.n, hgt)), n: fr.plane.n });
          return hit ? dot(sub(hit, P), dir) : sEdge;
        }
      }
      return null;
    };

    const palmWidths = [];
    const fingerWidths = Object.fromEntries(FINGERS.map((f) => [f, []]));
    for (const p of per) {
      const { fr, C, X, Y } = p;
      const M = scale(add(C[J.indexMCP], C[J.littleMCP]), 0.5);
      const Zp = norm(cross(X, Y));
      const palmCap = (sgn) => {
        // the thumb, if it crosses the line through M on this side (see the header)
        const xI = dot(sub(C[J.indexMCP], M), X) * sgn;
        if (xI <= 0) return 0.1;
        let xT = Infinity;
        const chain = [C[J.thumbMP], C[J.thumbIP], C[J.thumbTip]];
        for (let s = 0; s < 2; s++) {
          for (let k = 0; k <= 10; k++) {
            const q = add(chain[s], scale(sub(chain[s + 1], chain[s]), k / 10));
            const d = dot(sub(q, M), X) * sgn;
            if (d > xI && Math.abs(dot(sub(q, M), Zp)) < 0.012) xT = Math.min(xT, d);
          }
        }
        return Number.isFinite(xT) ? Math.min(0.1, xI + Math.max(0.01, (xT - xI) / 2)) : 0.1;
      };
      const a = extent(fr, M, X, palmCap(1), palmT, 0.001);
      const b = extent(fr, M, scale(X, -1), palmCap(-1), palmT, 0.001);
      if (a !== null && b !== null) palmWidths.push(a + b);

      // proximal segments as 2D lines on the table, for the gaps between fingers
      const segOf = (f) => (f === 'thumb' ? [C[J.thumbMP], C[J.thumbIP]] : [C[CHAIN[f][0]], C[CHAIN[f][1]]]);
      for (const f of FINGERS) {
        const [A, B] = segOf(f);
        // past the web between the fingers (and, for the little finger, past the palm's edge)
        const mid = add(A, scale(sub(B, A), 0.65));
        const along = norm(sub(B, A));
        const perp = norm(cross(Y, along));
        const caps = [1, -1].map((sgn) => {
          let cap = 0.03;
          for (const g of FINGERS) {
            if (g === f) continue;
            const [A2, B2] = segOf(g);
            // where the neighbour's segment crosses the line through mid along sgn * perp
            for (let k = 0; k <= 10; k++) {
              const q = add(A2, scale(sub(B2, A2), k / 10));
              const d = dot(sub(q, mid), scale(perp, sgn));
              const off = Math.abs(dot(sub(q, mid), along));
              if (d > 0 && off < 0.012) cap = Math.min(cap, d / 2);
            }
          }
          return cap;
        });
        const e1 = extent(fr, mid, perp, caps[0], fingerT[f]);
        const e2 = extent(fr, mid, scale(perp, -1), caps[1], fingerT[f]);
        if (e1 !== null && e2 !== null) fingerWidths[f].push(e1 + e2);
        else if (e1 !== null) fingerWidths[f].push(2 * e1);
        else if (e2 !== null) fingerWidths[f].push(2 * e2);
      }
    }

    const fingers = {};
    const boneSpread = {};
    for (const f of FINGERS) {
      const lengths = [0, 1, 2].map((s) => median(per.map((p) => p.bones[f][s])));
      boneSpread[f] = [0, 1, 2].map((s) => cm1(iqr(per.map((p) => p.bones[f][s]))));
      let width = fingerWidths[f].length >= Math.max(3, per.length * 0.3) ? median(fingerWidths[f]) : NaN;
      sources.fingerWidth[f] = 'mask';
      if (!(width >= 0.008 && width <= 0.03)) {
        width = DEFAULT_SIZES.fingerWidth[f];
        sources.fingerWidth[f] = 'default';
        issues.push(`${f}-width-default`);
      }
      fingers[f] = { lengths, width, thickness: fingerT[f] };
    }

    let palmWidth = palmWidths.length >= Math.max(3, per.length * 0.3) ? median(palmWidths) : NaN;
    sources.palmWidth = 'mask';
    if (!(palmWidth >= 0.05 && palmWidth <= 0.13)) {
      const span = median(per.map((p) => Math.abs(dot(sub(p.C[J.indexMCP], p.C[J.littleMCP]), p.X))));
      palmWidth = span + (fingers.index.width + fingers.little.width) / 2;
      sources.palmWidth = 'span';
      issues.push('palm-width-span');
    }

    const palmShape = [0, 1, 2, 3, 4, 5].map((k) => [0, 1, 2].map((a) => median(per.map((p) => p.shape[k][a]))));
    palmShape[0] = [0, 0, 0];
    const handLength = median(per.map((p) => p.handLength));
    const palmLength = median(per.map((p) => p.palmLength));
    if (iqr(per.map((p) => p.handLength)) > 0.01) issues.push('unsteady');

    const planes = frames.map((f) => f.plane);
    const nMean = norm([mean(planes.map((q) => q.n[0])), mean(planes.map((q) => q.n[1])), mean(planes.map((q) => q.n[2]))]);
    const srcCount = planes.filter((q) => q.source === 'lidar').length;
    const rmsList = planes.map((q) => q.rms).filter((v) => v !== null);
    const table = {
      height: median(planes.map((q) => q.p[1])),
      normal: nMean,
      rms: rmsList.length ? median(rmsList) : null,
      source: srcCount >= planes.length / 2 ? 'lidar' : 'planes',
    };

    const model = {
      version: 1,
      source: 'scan',
      chirality,
      createdAt: new Date().toISOString(),
      palm: { width: palmWidth, length: palmLength, thickness: palmT },
      fingers,
      handLength,
      palmShape,
    };
    const spreads = {
      bones: boneSpread,
      handLength: cm1(iqr(per.map((p) => p.handLength))),
      palmLength: cm1(iqr(per.map((p) => p.palmLength))),
      palmWidth: palmWidths.length ? cm1(iqr(palmWidths)) : null,
      palmThickness: cm1(iqr(frames.map((f) => f.palmH))),
      fingerWidths: Object.fromEntries(FINGERS.map((f) => [f, fingerWidths[f].length ? cm1(iqr(fingerWidths[f])) : null])),
    };
    const measurements = {
      cm: summaryCm(model),
      sources,
      table,
      frames: frames.length,
      framesUsed: per.length,
      spreads,
      chirality: { vision, geometry },
      issues,
    };
    model.measured = { frames: frames.length, sources, spreads, table, issues };
    if (!validModel(model)) issues.push('implausible');
    return { model, measurements };
  }
}

// helpers the tests use
export const _internals = { pointInPolygon, planeFromList };
