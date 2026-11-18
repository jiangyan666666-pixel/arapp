// Tests for the web hand core (web/src/hand/): conventions against real captures of the phone
// (when notes/captures/ is there), and the tracker and the scanner on synthetic hands (sim.js).
// Run: node tools/hand_test.mjs   (exit code 1 on any failure; plain summary on stdout)
//
// What the synthetic tests can and cannot say: sim.js builds the hand from the same 16 boxes the
// model describes and reports Vision joints as exact projections of the joint centres, so a
// pass means the geometry and the bookkeeping are right. How well real Vision joints and real
// near-range LiDAR fit this picture only the device can tell (tools/hand_replay.mjs).

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JOINT_NAMES, SEGMENTS, FINGERS, CHAIN, PALM_JOINTS, J } from '../web/src/hand/joints.js';
import {
  unproject, project, ray, add, sub, scale, dist, norm, quatFromBasis, quatFromAxisAngle, quatMul, quatRotate,
  fitRigid, fitPlane, imageToView, viewToImage, mean, median, quantile, std, depthOf,
} from '../web/src/hand/geom.js';
import { parseHandsEvent } from '../web/src/hand/frame.js';
import { defaultModel, validModel, summaryCm, segmentSizes, palmShapeFor, cloneModel } from '../web/src/hand/model.js';
import { poseFromJoints, poseBoxes, palmBoxCentre } from '../web/src/hand/pose.js';
import { OneEuro, OneEuro3 } from '../web/src/hand/filters.js';
import { HandTracker } from '../web/src/hand/tracker.js';
import { HandScanner, onPlane } from '../web/src/hand/scan.js';
import { planeUnder, HandView, LOOKS } from '../web/src/hand/view.js';
import { COLORS, ROUGHNESS } from '../web/src/furniture-spec.js';
import { rng, makeCamera, displayFor, portraitMatrices, handJoints, restingPose, handsEvent, INTRINSICS } from '../web/src/hand/sim.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
let failed = 0;
const fails = [];

function check(name, ok, detail = '') {
  if (ok) passed++;
  else {
    failed++;
    fails.push(name);
  }
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const note = (s) => console.log(`      ${s}`);
const section = (s) => console.log(`\n== ${s}`);
const mm = (v) => (v * 1000).toFixed(1);
const maxAbsDiff = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

// ---------------------------------------------------------------------------------------------
section('1. conventions against real captures');

const capDir = join(ROOT, 'notes', 'captures');
const caps = existsSync(capDir) ? readdirSync(capDir).filter((d) => existsSync(join(capDir, d, 'meta.json'))) : [];
if (!caps.length) note('no captures in notes/captures - skipped');
for (const d of caps) {
  const dir = join(capDir, d);
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  const c = meta.camera;
  if (!c?.transform || !c.intrinsics) continue;
  const cam = { transform: c.transform, intrinsics: c.intrinsics, imageResolution: c.imageResolution || [1920, 1440] };
  const viewport = c.viewport || [402, 874];

  if (c.displayTransform) {
    check(`${d}: displayFor(viewport) = displayTransform`, maxAbsDiff(displayFor(viewport, cam.imageResolution), c.displayTransform) < 1e-3);
  }
  if (c.viewMatrixPortrait && c.projectionPortrait) {
    const m = portraitMatrices(cam, viewport);
    const dv = maxAbsDiff(m.view, c.viewMatrixPortrait);
    const dp = maxAbsDiff(m.projection, c.projectionPortrait);
    check(`${d}: portraitMatrices = view / projection`, dv < 1e-3 && dp < 1e-3, `max diff view ${dv.toExponential(1)}, projection ${dp.toExponential(1)}`);
  }

  const files = meta.files || {};
  if (!files.depth || !files.confidence || !existsSync(join(dir, files.depth))) continue;
  const W = meta.depth?.width || 256;
  const H = meta.depth?.height || 192;
  const dbuf = readFileSync(join(dir, files.depth));
  const depth = new Float32Array(dbuf.buffer, dbuf.byteOffset, W * H);
  const conf = readFileSync(join(dir, files.confidence));
  const ys = [];
  let rt = 0;
  for (let v = 0; v < H; v++) {
    for (let u = 0; u < W; u++) {
      const k = v * W + u;
      const z = depth[k];
      if (conf[k] !== 2 || !(z > 0)) continue;
      const x = (u + 0.5) / W;
      const y = (v + 0.5) / H;
      const p = unproject(cam, x, y, z);
      ys.push(p[1]);
      if (k % 97 === 0) {
        const q = project(cam, p);
        rt = Math.max(rt, Math.abs(q.x - x) * 1920, Math.abs(q.y - y) * 1440, Math.abs(q.z - z) * 1000);
      }
    }
  }
  // the capture's matrix is rounded to 5 decimals, so its rotation is orthonormal to ~1e-5 only
  check(`${d}: project(unproject(p)) round trip`, rt < 0.05, `max error ${rt.toExponential(1)} px / mm`);
  const planes = (meta.planes || []).filter((p) => p.alignment === 'horizontal');
  if (ys.length < 500 || !planes.length) {
    note(`${d}: too few high-confidence pixels or no horizontal plane - height check skipped`);
    continue;
  }
  const bins = new Map();
  for (const y of ys) bins.set(Math.floor(y / 0.02), (bins.get(Math.floor(y / 0.02)) || 0) + 1);
  const [modeBin, modeCount] = [...bins].reduce((a, b) => (b[1] > a[1] ? b : a));
  const inBin = ys.filter((y) => Math.floor(y / 0.02) === modeBin);
  const modeY = mean(inBin);
  const heights = planes.map((p) => {
    const T = p.transform;
    const cc = p.center || [0, 0, 0];
    return { cls: p.class, y: T[1] * cc[0] + T[9] * cc[2] + T[13] };
  });
  const near = heights.reduce((a, b) => (Math.abs(b.y - modeY) < Math.abs(a.y - modeY) ? b : a));
  check(
    `${d}: most common height (2 cm bins) = an ARKit plane`,
    Math.abs(near.y - modeY) < 0.02,
    `${modeY.toFixed(3)} m (${((100 * modeCount) / ys.length).toFixed(0)}% of ${ys.length} px) vs ${near.cls} ${near.y.toFixed(3)} m`,
  );
}
// the verified example from a real frame (the stage-3 brief), independent of notes/
{
  const cam = {
    transform: [-0.80789, -0.58559, 0.06636, 0, 0.17074, -0.1248, 0.97738, 0, -0.56406, 0.80094, 0.20081, 0, -0.49264, 0.08561, 0.40388, 1],
    intrinsics: [1342.44, 0, 0, 0, 1342.44, 0, 967.97, 718.62, 1],
    imageResolution: [1920, 1440],
  };
  const m = portraitMatrices(cam, [402, 874]);
  const view = [0.17074, 0.80789, -0.56406, 0, -0.1248, 0.58559, 0.80094, 0, 0.97738, -0.06636, 0.20081, 0, -0.29995, 0.37467, -0.42755, 1];
  const proj = [3.04025, 0, 0, 0, 0, 1.39838, 0, 0, -0.002, 0.00882, -1.0001, -1, 0, 0, -0.01, 0];
  check('reference frame: portraitMatrices = viewMatrixPortrait / projectionPortrait', maxAbsDiff(m.view, view) < 1e-3 && maxAbsDiff(m.projection, proj) < 1e-3);
  check('reference frame: displayFor([402, 874])', maxAbsDiff(displayFor([402, 874]), [0, 1, -1.630597, 0, 1.315299, 0]) < 1e-3);
  const [X, Y] = imageToView(displayFor([402, 874]), 0.3, 0.7);
  const [x, y] = viewToImage(displayFor([402, 874]), X, Y);
  check('imageToView / viewToImage round trip', Math.abs(x - 0.3) < 1e-12 && Math.abs(y - 0.7) < 1e-12);
  // makeCamera: phone held portrait, looking down at a table ahead
  const c2 = makeCamera({ position: [0, 1.2, 0.3], lookAt: [0, 0.8, 0] });
  const T = c2.transform;
  const okAxes = T[1] < 0 && Math.abs(T[4] - 1) < 1e-9 && T[9] > 0; // X (screen down) points down, Y (screen right) = +X, Z backwards and up
  check('makeCamera axes: X = screen down, Y = screen right, Z = backwards', okAxes);
  const centre = project(c2, [0, 0.8, 0]);
  check('makeCamera looks at its target', Math.abs(centre.x * 1920 - INTRINSICS[6]) < 1e-6 && Math.abs(centre.y * 1440 - INTRINSICS[7]) < 1e-6);
}

// ---------------------------------------------------------------------------------------------
section('2. building blocks');
{
  check('21 joints, 16 segments', JOINT_NAMES.length === 21 && SEGMENTS.length === 16 && SEGMENTS[0].id === 'palm' && SEGMENTS[15].id === 'little3');
  check('CHAIN / PALM_JOINTS', CHAIN.thumb[0] === J.thumbCMC && CHAIN.little[3] === J.littleTip && PALM_JOINTS.join() === '0,1,5,9,13,17');
  const m = defaultModel();
  check('defaultModel is valid', validModel(m) && validModel(defaultModel('left')));
  const bad = cloneModel(m);
  bad.palm.width = 0.5;
  check('validModel rejects a 50 cm palm', !validModel(bad));
  check('segmentSizes: 16 boxes, palm first', segmentSizes(m).length === 16 && segmentSizes(m, 2)[0][0] === 2 * m.palm.width);
  check('palmShapeFor mirrors for the other hand', palmShapeFor(m, 'left')[1][0] === -m.palmShape[1][0]);
  const s = summaryCm(m);
  check('summaryCm', s.palmWidth === 8.2 && s.fingers.middle[0] === 4.8);

  // rigid fit
  const r = rng(7);
  const src = Array.from({ length: 8 }, () => [r() - 0.5, r() - 0.5, r() - 0.5]);
  const q = quatFromAxisAngle([0.3, 1, -0.2], 1.1);
  const tr = [0.1, -0.2, 0.3];
  const fit = fitRigid(src, src.map((p) => add(quatRotate(q, p), tr)));
  check('fitRigid recovers a rotation + translation', fit.rms < 1e-9 && dist(fit.t, tr) < 1e-9);
  const pl = fitPlane(Array.from({ length: 50 }, () => [r(), 0.75 + 0.001 * (r() - 0.5), r()]));
  check('fitPlane: normal up, rms', pl.n[1] > 0.999 && pl.rms < 0.001 && Math.abs(pl.p[1] - 0.75) < 0.001);

  // filters
  const f1 = new OneEuro({ minCutoff: 1, beta: 0 });
  let v = 0;
  for (let i = 0; i < 300; i++) v = f1.filter(1, i / 30);
  check('OneEuro settles on a constant', Math.abs(v - 1) < 1e-6);
  const f3 = new OneEuro3({ minCutoff: 1, beta: 1, dCutoff: 1 });
  for (let i = 0; i < 120; i++) f3.filter([0.5 * (i / 30), 0, 0], i / 30);
  check('OneEuro3 velocity of a 0.5 m/s ramp', Math.abs(f3.velocity[0] - 0.5) < 0.01, `${f3.velocity[0].toFixed(3)} m/s`);

  // pose and boxes
  const rp = restingPose(m, { table: 0.75 });
  const joints = handJoints(m, rp);
  const pose = poseFromJoints(m, joints, 'right');
  check('poseFromJoints: palm y (back of the hand) is up for a palm-down right hand', pose.palm.y[1] > 0.99);
  check('poseFromJoints: palm z points along the fingers (-Z)', pose.palm.z[2] < -0.99);
  const boxes = poseBoxes(m, pose);
  check('poseBoxes: 16 rows of 11 numbers', boxes.length === 16 && boxes.every((b) => b.length === 11));
  const b5 = boxes[5]; // index2: PIP -> DIP
  const zAxis = quatRotate([b5[4], b5[5], b5[6], b5[7]], [0, 0, 1]);
  const bone = norm(sub(joints[J.indexDIP], joints[J.indexPIP]));
  check('poseBoxes: box z runs along its bone', dist(zAxis, bone) < 1e-4);
  const yAxis = quatRotate([b5[4], b5[5], b5[6], b5[7]], [0, 1, 0]);
  check('poseBoxes: box y towards the back of the hand', yAxis[1] > 0.99);
  const palmC = add(rp.origin, quatRotate(rp.rotation, palmBoxCentre(m, 'right')));
  check('poseBoxes: palm box centre', dist([boxes[0][1], boxes[0][2], boxes[0][3]], palmC) < 1e-4);
  // the left hand is the mirror image: its back is still up when palm-down
  const ml = defaultModel('left');
  const jl = handJoints(ml, restingPose(ml, { table: 0.75 }));
  check('poseFromJoints: left hand palm-down, back up', poseFromJoints(ml, jl, 'left').palm.y[1] > 0.99);

  // event round trip: sim -> parseHandsEvent
  const cam = makeCamera({ position: [0, 1.1, 0.25], lookAt: [0, 0.75, -0.07] });
  const ev = handsEvent({ cam, model: m, joints, table: { height: 0.75 }, patch: true, random: rng(1) });
  const fr = parseHandsEvent(JSON.parse(JSON.stringify(ev)));
  const p0 = fr.hands[0].patch;
  check('parseHandsEvent: one hand, 21 joints, a patch', fr.hands.length === 1 && fr.hands[0].joints.length === 21 && !!p0);
  let personDepthOk = 0;
  let personN = 0;
  for (let jj = 0; jj < p0.h; jj++) {
    for (let ii = 0; ii < p0.w; ii++) {
      const k = jj * p0.w + ii;
      if (!p0.person[k]) continue;
      personN++;
      const [x, y] = p0.xy(ii, jj);
      const P = unproject(cam, x, y, p0.depth[k]);
      if (P[1] > 0.75 + 0.002) personDepthOk++;
    }
  }
  check('decodePatch: person pixels lie above the table', personN > 100 && personDepthOk / personN > 0.98, `${personN} person px`);
  const t0 = performance.now();
  for (let i = 0; i < 30; i++) handsEvent({ cam, model: m, joints, table: { height: 0.75 }, patch: true, random: rng(i), noise: { px: 1.5, depth: 0.005 } });
  const msEv = (performance.now() - t0) / 30;
  check('sim.handsEvent with a patch is fast enough for 30 Hz', msEv < 8, `${msEv.toFixed(2)} ms per event`);
}

// ---------------------------------------------------------------------------------------------
section('3. tracker on synthetic hands');

const TABLE = 0.75;
const METHODS = ['fused', 'lidar', 'size'];

/** A camera `D` metres from the point C, `el` degrees above it, behind the hand (+Z side). */
function cameraAt(C, D, el = 60, side = 0) {
  const e = (el * Math.PI) / 180;
  const s = (side * Math.PI) / 180;
  return makeCamera({ position: add(C, [D * Math.cos(e) * Math.sin(s), D * Math.sin(e), D * Math.cos(e) * Math.cos(s)]), lookAt: C });
}

function errorsOf(pose, truth) {
  return pose.joints.map((p, j) => dist(p, truth[j]));
}

/**
 * Runs frames through a tracker. frames: [{t, joints, cam}]. Returns per-frame max/mean joint
 * error and the poses.
 */
function run(model, frames, trackerOpts, eventOpts = {}) {
  const tr = new HandTracker(model, trackerOpts);
  const out = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const ev = handsEvent({ cam: f.cam, model, joints: f.joints, t: f.t, seq: i, table: f.table === undefined ? { height: TABLE } : f.table, ...eventOpts, random: eventOpts.random || rng(1000 + i) });
    const pose = tr.update(parseHandsEvent(ev));
    if (!pose) {
      out.push({ pose: null, debug: tr.lastDebug });
      continue;
    }
    const e = errorsOf(pose, f.truth || f.joints);
    out.push({ pose, max: Math.max(...e), mean: mean(e), errs: e });
  }
  return out;
}

const summarize = (res, skip = 0) => {
  const r = res.slice(skip);
  const got = r.filter((x) => x.pose);
  return {
    lost: r.length - got.length,
    mean: got.length ? mean(got.map((x) => x.mean)) : NaN,
    max: got.length ? Math.max(...got.map((x) => x.max)) : NaN,
  };
};

/** Std over time of each joint, averaged over joints (a still hand: pure jitter). */
function jitter(res, skip = 10) {
  const got = res.slice(skip).filter((x) => x.pose);
  if (got.length < 3) return NaN;
  const per = [];
  for (let j = 0; j < 21; j++) {
    const ps = got.map((x) => x.pose.joints[j]);
    const c = [mean(ps.map((p) => p[0])), mean(ps.map((p) => p[1])), mean(ps.map((p) => p[2]))];
    per.push(Math.sqrt(mean(ps.map((p) => dist(p, c) ** 2))));
  }
  return mean(per);
}

const model = defaultModel('right');

function stillFrames(cam, joints, n = 30) {
  return Array.from({ length: n }, (_, i) => ({ t: i / 30, cam, joints }));
}

// a. flat on a table, 0.35 m below the camera
const rest = restingPose(model, { table: TABLE });
const restJoints = handJoints(model, rest);
const palmCentre = add(rest.origin, quatRotate(rest.rotation, palmBoxCentre(model, 'right')));
const camAbove = makeCamera({ position: add(palmCentre, [0, 0.35, 0.12]), lookAt: palmCentre });

// b. moving and flexing, hovering 8 cm above the table
const baseRot = rest.rotation;
const movingFrames = [];
for (let i = 0; i < 90; i++) {
  const t = i / 30;
  const w = (f) => 2 * Math.PI * f * t;
  const origin = add(rest.origin, [0.05 * Math.sin(w(0.5)), 0.08 + 0.03 * Math.sin(w(0.7)), 0.04 * Math.sin(w(0.4))]);
  const rot = quatMul(quatFromAxisAngle([1, 0, 0], 0.3 * Math.sin(w(0.3))), quatMul(quatFromAxisAngle([0, 1, 0], 0.4 * Math.sin(w(0.25))), baseRot));
  const flex = {};
  FINGERS.forEach((f, k) => {
    const a = 0.5 * (1 - Math.cos(w(0.5) + k * 0.7));
    flex[f] = f === 'thumb' ? [0.3 * a, 0.4 * a, 0.4 * a] : [0.6 * a, 0.5 * a, 0.3 * a];
  });
  movingFrames.push({ t, joints: handJoints(model, { origin, rotation: rot, flex, spread: 0.1 * Math.sin(w(0.3)) }) });
}
const camMoving = cameraAt(add(palmCentre, [0, 0.08, 0]), 0.4, 60);
movingFrames.forEach((f) => (f.cam = camMoving));
const movingSpeed = mean(movingFrames.slice(1).map((f, i) => dist(f.joints[9], movingFrames[i].joints[9]) * 30));

// c. palm facing the camera, hand upright 0.35 m in front of it
const camFront = makeCamera({ position: [0, 1.1, 0], lookAt: [0, 1.1, -1] });
const faceRot = quatFromBasis([1, 0, 0], [0, 0, -1], [0, 1, 0]);
const faceJoints = handJoints(model, { origin: [0.01, 1.1 - 0.06, -0.35], rotation: faceRot, flex: {}, spread: 0.05 });

movingFrames.forEach((f) => (f.table = null));
const scenarios = [
  { name: 'flat on a table, 0.35 m below the camera', frames: stillFrames(camAbove, restJoints) },
  { name: `moving and flexing (${(movingSpeed * 100).toFixed(0)} cm/s, 0.4 m)`, frames: movingFrames },
  { name: 'palm facing the camera, 0.35 m', frames: stillFrames(camFront, faceJoints).map((f) => ({ ...f, table: null })) },
];
for (const D of [0.25, 0.4, 0.6]) scenarios.push({ name: `flat on a table at ${D} m`, frames: stillFrames(cameraAt(palmCentre, D, 60), restJoints) });

console.log('\n  no noise, filter off: joint error (mean / max, mm)');
for (const sc of scenarios) {
  const cells = [];
  for (const method of METHODS) {
    const s = summarize(run(model, sc.frames, { method, filter: false }));
    cells.push(`${method} ${mm(s.mean)} / ${mm(s.max)}${s.lost ? ` lost ${s.lost}` : ''}`);
    check(`no noise, ${method}: ${sc.name}`, s.lost === 0 && s.max < 0.003, `${mm(s.mean)} / ${mm(s.max)} mm`);
  }
}

console.log('\n  realistic noise (1.5 px joints, 5 mm per depth pixel, LiDAR confidence "medium" near): default filter');
const NOISE = { noise: { px: 1.5, depth: 0.005 } };
for (const method of METHODS) {
  const still = run(model, stillFrames(camAbove, restJoints, 90), { method }, NOISE);
  const s = summarize(still, 10);
  const jit = jitter(still);
  const raw = run(model, stillFrames(camAbove, restJoints, 90), { method, filter: false }, NOISE);
  const sr = summarize(raw, 10);
  const jr = jitter(raw);
  const mov = summarize(run(model, movingFrames, { method }, NOISE), 10);
  const movRaw = summarize(run(model, movingFrames, { method, filter: false }, NOISE), 10);
  note(
    `${method.padEnd(5)}  still: error ${mm(s.mean)} / ${mm(s.max)} mm, jitter ${mm(jit)} mm (raw: ${mm(sr.mean)} / ${mm(sr.max)}, jitter ${mm(jr)})` +
      `   moving: ${mm(mov.mean)} / ${mm(mov.max)} mm (raw ${mm(movRaw.mean)} / ${mm(movRaw.max)})`,
  );
  check(`noise, ${method}: still hand mean error < 15 mm, jitter < 5 mm`, s.lost === 0 && s.mean < 0.015 && jit < 0.005);
  check(`noise, ${method}: moving hand mean error < 25 mm, never lost`, mov.lost === 0 && mov.mean < 0.025);
}
for (const D of [0.25, 0.6]) {
  const cells = METHODS.map((method) => {
    const s = summarize(run(model, stillFrames(cameraAt(palmCentre, D, 60), restJoints, 60), { method }, NOISE), 10);
    return `${method} ${mm(s.mean)} / ${mm(s.max)}`;
  });
  note(`still at ${D} m: ${cells.join(',  ')} mm`);
}

// prediction: the shown hand appears on screen some time after the camera saw it (the native
// latency). Predicting by that time should put it closer to where the hand IS when it is shown,
// so compare against the hand 50 ms later.
{
  const at = (t) => handJoints(model, { origin: add(rest.origin, [-0.15 + 0.3 * t * 0.5, 0.08, 0]), rotation: baseRot });
  const lin = Array.from({ length: 60 }, (_, i) => {
    const t = i / 30;
    return { t, cam: camMoving, joints: at(t), truth: at(t + 0.05), table: null };
  });
  const lag = summarize(run(model, lin, { method: 'size' }), 20);
  const pred = summarize(run(model, lin, { method: 'size', predict: 0.05 }), 20);
  note(`0.15 m/s straight move, size: vs the hand 50 ms later — no predict ${mm(lag.mean)} mm, predict 50 ms ${mm(pred.mean)} mm`);
  check('predict brings the shown hand closer to where the hand is 50 ms later', pred.mean < lag.mean / 2);
}

// picking the hand and losing it
{
  const left = defaultModel('left');
  const lj = handJoints(left, restingPose(left, { table: TABLE, at: [0.12, 0] }));
  const rj = handJoints(model, restingPose(model, { table: TABLE, at: [-0.05, 0] }));
  const cam = cameraAt([0.03, TABLE, -0.07], 0.45, 60);
  const tr = new HandTracker(model, { filter: false });
  const ev = handsEvent({ cam, hands: [{ model: left, joints: lj, chirality: 'left' }, { model, joints: rj, chirality: 'right' }], table: { height: TABLE } });
  const pose = tr.update(parseHandsEvent(ev));
  check('two hands: picks the one with the model\'s chirality', pose && pose.quality.hand === 1 && dist(pose.joints[9], rj[9]) < 0.005);
  // Vision mislabels the tracked hand for one frame: continuity keeps it
  const ev2 = handsEvent({ cam, t: 1 / 30, hands: [{ model: left, joints: lj, chirality: 'right' }, { model, joints: rj, chirality: 'left' }], table: { height: TABLE } });
  const p2 = tr.update(parseHandsEvent(ev2));
  check('two hands: a label flip does not switch hands', p2 && p2.quality.hand === 1 && dist(p2.joints[9], rj[9]) < 0.005);
  const none = (t) => tr.update(parseHandsEvent(handsEvent({ cam, t, joints: null, model })));
  const h1 = none(0.2);
  const h2 = none(0.4);
  check('lost hand: held for holdMs, then null', h1?.quality.held === true && h2 === null);

  // joints Vision does not see keep the finger's last shape
  const tr2 = new HandTracker(model, { filter: false });
  tr2.update(parseHandsEvent(handsEvent({ cam: camAbove, joints: restJoints, model, table: { height: TABLE } })));
  const ev3 = handsEvent({ cam: camAbove, t: 1 / 30, joints: restJoints, model, table: { height: TABLE } });
  for (const j of [J.indexDIP, J.indexTip]) ev3.hands[0].joints[j][2] = 0.1;
  const p3 = tr2.update(parseHandsEvent(ev3));
  const e3 = Math.max(dist(p3.joints[J.indexDIP], restJoints[J.indexDIP]), dist(p3.joints[J.indexTip], restJoints[J.indexTip]));
  check('unseen joints are filled from the last frame', p3.quality.filled === 2 && e3 < 0.003, `${mm(e3)} mm`);
}

// ---------------------------------------------------------------------------------------------
section('4. finger root choice');
{
  // fingers curling while the hand stays put, seen from above; no LiDAR at all
  const curl = Array.from({ length: 40 }, (_, i) => {
    const a = Math.min(1, i / 30);
    const flex = Object.fromEntries(FINGERS.map((f) => [f, f === 'thumb' ? [0.2 * a, 0.5 * a, 0.5 * a] : [0.9 * a, 0.9 * a, 0.5 * a]]));
    const origin = add(rest.origin, [0, 0.06, 0]);
    return { t: i / 30, cam: camMoving, joints: handJoints(model, { origin, rotation: baseRot, flex }), table: null };
  });
  for (const method of ['fused', 'size']) {
    const s = summarize(run(model, curl, { method, filter: false }, { depth: false }));
    check(`no LiDAR, with history (${method}): curling fingers follow`, s.lost === 0 && s.max < 0.003, `${mm(s.mean)} / ${mm(s.max)} mm`);
  }
  // the same frames one by one (no history): the bend rule alone
  let wrong = 0;
  let wrongL = 0;
  for (const f of curl.slice(20)) {
    const one = run(model, [{ ...f, t: 0 }], { method: 'fused', filter: false }, { depth: false })[0];
    if (!one.pose || one.max > 0.003) wrong++;
    const withL = run(model, [{ ...f, t: 0 }], { method: 'fused', filter: false })[0];
    if (!withL.pose || withL.max > 0.003) wrongL++;
  }
  note(`single frames of a strongly curled hand: without LiDAR or history ${wrong} of 20 off by > 3 mm; with LiDAR ${wrongL} of 20`);
  check('single frames with LiDAR: the root nearest the measured depth is right', wrongL === 0);
}

// ---------------------------------------------------------------------------------------------
section('5. scanner on synthetic flat hands');

/** A hand clearly different from the default one, so the scan cannot just return defaults. */
function knownModel() {
  const m = defaultModel('right');
  m.palm = { width: 0.077, length: 0.088, thickness: 0.023 };
  const k = 0.93;
  for (const f of FINGERS) {
    m.fingers[f].lengths = m.fingers[f].lengths.map((l) => l * k);
    m.fingers[f].thickness -= 0.001;
  }
  m.fingers.thumb.thickness = 0.019;
  m.palmShape = m.palmShape.map(([x, y, z]) => [x * 0.94, y, z * (0.088 / 0.094)]);
  m.handLength = m.palm.length + m.fingers.middle.lengths.reduce((a, b) => a + b, 0);
  return m;
}

/**
 * shake = amplitude (m) of a hand-held phone's wobble: the camera moves by up to `shake` and
 * turns by up to ~2 * shake / D rad, at 0.7-1.9 Hz (each axis its own frequency).
 */
function scan(m, D, { noise = null, frames = 120, chirality, el = 65, planes = null, table = { height: TABLE }, seed = 1, shake = 0, wiggle = 0 } = {}) {
  const rp = restingPose(m, { table: TABLE });
  const joints = handJoints(m, rp);
  const C = add(rp.origin, quatRotate(rp.rotation, palmBoxCentre(m, m.chirality)));
  const target = [C[0], TABLE, C[2]];
  const cam0 = cameraAt(target, D, el);
  const sc = new HandScanner();
  const r = rng(seed);
  let st = null;
  let last = null;
  for (let i = 0; i < frames; i++) {
    const t = i / 30;
    const w = (f, ph) => shake * Math.sin(2 * Math.PI * f * t + ph);
    const cam = shake
      ? makeCamera({
          position: add(cam0.position || [cam0.transform[12], cam0.transform[13], cam0.transform[14]], [w(1.3, 0), w(0.7, 1), w(1.9, 2)]),
          lookAt: add(target, [2 * w(0.9, 3), 0, 2 * w(1.1, 4)]),
        })
      : cam0;
    // wiggle: the fingers fidget sideways on the table (amplitude in rad, 3 Hz)
    const jt = wiggle ? handJoints(m, { ...rp, spread: wiggle * Math.sin(2 * Math.PI * 3 * t) }) : joints;
    const ev = handsEvent({ cam, model: m, joints: jt, chirality: chirality || m.chirality, t, seq: i, table, patch: true, patchMax: 20000, random: r, ...(noise ? { noise } : {}) });
    st = sc.push(parseHandsEvent(ev), planes);
    last = st;
    if (st.state === 'done' || st.state === 'failed') break;
  }
  return { st: last, res: sc.result(), joints, cam: cam0, diag: sc.diagnostics() };
}

function scanErrors(res, m) {
  const out = { bones: 0, handLength: 0, palmLength: 0, palmT: 0, fingerT: 0, palmW: 0, fingerW: 0 };
  for (const f of FINGERS) {
    for (let s = 0; s < 3; s++) out.bones = Math.max(out.bones, Math.abs(res.model.fingers[f].lengths[s] - m.fingers[f].lengths[s]));
    out.fingerT = Math.max(out.fingerT, Math.abs(res.model.fingers[f].thickness - m.fingers[f].thickness));
    out.fingerW = Math.max(out.fingerW, Math.abs(res.model.fingers[f].width - m.fingers[f].width));
  }
  out.handLength = Math.abs(res.model.handLength - m.handLength);
  out.palmLength = Math.abs(res.model.palm.length - m.palm.length);
  out.palmT = Math.abs(res.model.palm.thickness - m.palm.thickness);
  out.palmW = Math.abs(res.model.palm.width - m.palm.width);
  return out;
}
const fmtErr = (e) =>
  `bones ${mm(e.bones)}, hand length ${mm(e.handLength)}, palm length ${mm(e.palmLength)}, palm thickness ${mm(e.palmT)}, finger thickness ${mm(e.fingerT)}, palm width ${mm(e.palmW)}, finger width ${mm(e.fingerW)} (max abs, mm)`;

const km = knownModel();
for (const D of [0.3, 0.4, 0.5]) {
  const { st, res } = scan(km, D);
  const ok = st.state === 'done' && res;
  if (!ok) {
    check(`scan at ${D} m finishes`, false, JSON.stringify(st));
    continue;
  }
  const e = scanErrors(res, km);
  note(`${D} m, no noise: ${fmtErr(e)}; ${res.measurements.frames} frames`);
  check(`scan at ${D} m, no noise: bones and hand length within 3 mm`, e.bones < 0.003 && e.handLength < 0.003 && e.palmLength < 0.003);
  check(`scan at ${D} m, no noise: thickness within 3 mm`, e.palmT < 0.003 && e.fingerT < 0.003);
  check(`scan at ${D} m, no noise: palm width within 5 mm`, e.palmW < 0.005);
  check(`scan at ${D} m: chirality right, sources measured`, res.model.chirality === 'right' && res.measurements.sources.palmWidth === 'mask' && res.measurements.sources.palmThickness === 'mask');
}
for (const D of [0.3, 0.4, 0.5]) {
  const { st, res } = scan(km, D, { noise: { px: 1.5, depth: 0.005 }, frames: 240, seed: 3 });
  if (st.state !== 'done' || !res) {
    note(`${D} m, noise: scan did not finish (${st.state}, ${st.hint}, ${st.issues.join(' ')})`);
    check(`scan at ${D} m with noise finishes`, false);
    continue;
  }
  note(`${D} m, noise 1.5 px / 5 mm: ${fmtErr(scanErrors(res, km))}`);
  check(`scan at ${D} m with noise finishes with a valid model`, validModel(res.model));
}
{
  const left = defaultModel('left');
  const { res } = scan(left, 0.4);
  check('scan: a left hand is found to be left', res?.model.chirality === 'left' && res.model.palmShape[1][0] < 0);
  const { res: r2 } = scan(model, 0.4, { chirality: 'left' });
  check('scan: Vision says left, geometry says right -> right, with an issue', r2?.model.chirality === 'right' && r2.measurements.issues.includes('chirality-vision-disagrees'));
  // no LiDAR table: the ar.planes table under the hand is used instead
  const planes = [{ id: 't', alignment: 'horizontal', class: 'table', transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, TABLE, 0, 1], center: [0, 0, 0], extent: [1, 1] }];
  const { st: st3, res: r3 } = scan(model, 0.4, { table: null, planes });
  check('scan: falls back to the ar.planes table', st3.state === 'done' && r3?.measurements.table.source === 'planes', r3 ? `palm thickness ${mm(r3.model.palm.thickness)} mm` : st3.hint);
  {
    // a long narrow table turned 90 degrees: the extent alone (unturned) would miss the point
    const turned = { extent: [1.0, 0.2], center: [0, 0, 0], rotationOnYAxis: Math.PI / 2 };
    const square = [[-0.5, -0.1], [0.5, -0.1], [0.5, 0.1], [-0.5, 0.1]].map(([x, z]) => [-z, x]); // the same turned rectangle as a boundary
    check('plane test: a turned extent counts the point along its long side', onPlane(turned, 0, 0.4, 0) && !onPlane({ ...turned, rotationOnYAxis: 0 }, 0, 0.4, 0));
    check('plane test: the boundary polygon decides when present', onPlane({ boundary: square }, 0, 0.4, 0) && !onPlane({ boundary: square }, 0.4, 0, 0.05) && onPlane({ boundary: square }, 0.13, 0, 0.05));
    // view.js planeUnder on an ARKit-like table: anchor turned 1.2 rad and off the table's centre
    // (as fake-native.js builds it); real outline x -0.6..0.6, z -0.65..0.05 at y 0.75
    const yaw = 1.2;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const O = [0.25, 0.75, -0.42];
    const local = (x, z) => [(x - O[0]) * c - (z - O[2]) * s, (x - O[0]) * s + (z - O[2]) * c];
    const corners = [[-0.6, -0.65], [0.6, -0.65], [0.6, 0.05], [-0.6, 0.05]].map(([x, z]) => local(x, z));
    const ctr = local(0, -0.3);
    const desk = { id: 'desk', alignment: 'horizontal', class: 'table', transform: [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, ...O, 1], center: [ctr[0], 0, ctr[1]], extent: [1.2, 0.7], rotationOnYAxis: -yaw };
    const floor = { id: 'floor', alignment: 'horizontal', class: 'floor', transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -1.2, 1], center: [0, 0, 0], extent: [3, 2.5] };
    const near = [-0.55, 0.78, -0.6]; // over the table's far left corner
    const off = [0.75, 0.78, -0.3]; // beside the table, over the floor
    check(
      'planeUnder: a turned, off-centre table is found under a hand near its corner (boundary and extent alike)',
      planeUnder([desk, floor], near, { maxBelow: 0.15 })?.id === 'desk' && planeUnder([{ ...desk, boundary: corners }, floor], near, { maxBelow: 0.15 })?.id === 'desk',
    );
    check('planeUnder: beside the table, maxBelow 0.15 -> no plane (not the floor)', planeUnder([{ ...desk, boundary: corners }, floor], off, { maxBelow: 0.15, margin: 0.05 }) === null);
  }
  {
    // a hand-held phone: the whole hand wobbles in the image, its shape does not
    const { st: s7, res: r7, diag: d7 } = scan(km, 0.35, { shake: 0.004, frames: 240, noise: { px: 1.0, depth: 0.003 }, seed: 5 });
    note(`shaking phone (4 mm): ${s7.state}, ${d7.pushes} frames, stillness residual p50 ${d7.still.p50} / p90 ${d7.still.p90}, shift p90 ${d7.shift.p90}, issues ${JSON.stringify(d7.counts)}`);
    check('scan: a shaking hand-held phone (4 mm) still finishes', s7.state === 'done' && validModel(r7?.model), `${s7.hint} ${s7.issues.join(' ')}`);
    const { diag: d8 } = scan(km, 0.35, { shake: 0.03, frames: 60, seed: 5 });
    check('scan: a phone swinging 3 cm -> phone-moving', (d8.counts['phone-moving'] || 0) > 0, JSON.stringify(d8.counts));
    const { st: s9, diag: d9 } = scan(km, 0.35, { wiggle: 0.08, frames: 90, seed: 5 });
    check('scan: fingers fidgeting on the table (phone still) -> moving, no result', s9.state !== 'done' && (d9.counts.moving || 0) > 30, JSON.stringify(d9.counts));
  }
  {
    // joints missing because the hand runs out of the picture -> 整只手要在屏幕里; missing in the
    // middle of the picture -> the fingers / light hint
    const rp = restingPose(model, { table: TABLE });
    const joints = handJoints(model, rp);
    const along = norm(sub(joints[J.middleTip], joints[J.wrist]));
    const across = [along[2], 0, -along[0]];
    const C = add(rp.origin, quatRotate(rp.rotation, palmBoxCentre(model, model.chirality)));
    const frameAt = (ax, aim, D) =>
      parseHandsEvent(handsEvent({ cam: cameraAt(add([C[0], TABLE, C[2]], scale(ax, aim)), D, 65), model, joints, chirality: model.chirality, t: 0, seq: 0, table: { height: TABLE }, patch: true, patchMax: 20000 }));
    // the camera aimed off the hand: past the image's long side (screen top / bottom) at either
    // end of the hand, and past the cropped short side (screen left / right) at either side
    const CUT = [['wrist end', along, 0.2, 0.25], ['fingertip end', along, -0.2, 0.25], ['one side', across, -0.12, 0.25], ['other side', across, 0.12, 0.25], ['other side', across, 0.16, 0.3]];
    for (const [name, ax, aim, D] of CUT) {
      const f = frameAt(ax, aim, D);
      const missing = f.hands[0].joints.filter((j) => !(j.c >= 0.5)).length;
      const st = new HandScanner().push(f);
      check(`scan hint: hand cut off at the ${name} (${D} m; ${missing} joints missing) -> 整只手要在屏幕里`, missing > 2 && st.hint === '整只手要在屏幕里', `${st.hint} (${st.issues.join(' ')})`);
    }
    const f = frameAt(along, 0, 0.4);
    for (const j of [J.indexPIP, J.indexDIP, J.middlePIP]) f.hands[0].joints[j].c = 0;
    const st = new HandScanner().push(f);
    check('scan hint: joints missing mid-picture -> 手指伸直分开，光线亮一点', st.hint === '手指伸直分开，光线亮一点' && !st.issues.includes('off-screen'), `${st.hint} (${st.issues.join(' ')})`);
  }
  const { st: st4 } = scan(model, 0.4, { table: null, frames: 5 });
  check('scan: no table -> hint 没看到桌面', st4.hint === '没看到桌面', st4.hint);
  const { st: st5 } = scan(model, 0.17, { frames: 5 });
  check('scan: too close -> hint to lift the phone', st5.issues.includes('too-close') || st5.issues.includes('off-screen'), `${st5.hint} (${st5.issues.join(' ')})`);
  const { st: st6 } = scan(model, 0.75, { frames: 5, el: 75 });
  check('scan: too far -> hint to lower the phone', st6.issues.includes('too-far'), st6.hint);
}

// ---------------------------------------------------------------------------------------------
// view.js: the wooden 'model' look, and person occlusion / erase sent to the native layer
{
  const calls = [];
  const ar = {
    setOptions: async (o) => calls.push(['setOptions', JSON.parse(JSON.stringify(o))]),
    setGroup: async (id, boxes, opts) => calls.push(['setGroup', id, boxes, opts]),
    updateGroups: (g) => calls.push(['updateGroups', g]),
    removeGroup: async (id) => calls.push(['removeGroup', id]),
  };
  const opts = () => calls.filter((c) => c[0] === 'setOptions').map((c) => c[1]);
  const v = new HandView({ ar, personOcclusion: true });
  await v.init(defaultModel('right'));
  calls.length = 0;
  await v.set({ look: 'model', shell: 1.15 });
  const g = calls.find((c) => c[0] === 'setGroup' && c[1] === 'hand');
  const wood = [((COLORS.wood >> 16) & 255) / 255, ((COLORS.wood >> 8) & 255) / 255, (COLORS.wood & 255) / 255];
  const b = g?.[2] || [];
  check(
    "view: look 'model' = 16 opaque pbr boxes in the furniture's wood, its roughness, the palm darker",
    LOOKS.includes('model') && b.length === 16 && b.slice(1).every((x) => x.material === 'pbr' && x.opacity === 1 && x.roughness === ROUGHNESS.wood && x.color.every((c, i) => Math.abs(c - wood[i]) < 1e-9)) && Math.abs(b[0].color[0] - wood[0] * 0.85) < 1e-9,
  );
  check("view: look 'model' switches person occlusion off, and no erase key is sent while erasing was never on", opts().length === 1 && opts()[0].personOcclusion === false && !('erase' in opts()[0]), JSON.stringify(opts()));
  calls.length = 0;
  await v.set({ look: 'edges' });
  check('view: back to edges -> person occlusion on again', opts().length === 1 && opts()[0].personOcclusion === true, JSON.stringify(opts()));
  calls.length = 0;
  await v.set({ erase: { on: true, dilate: 5, probe: true } });
  check('view: erase on -> one setOptions with the erase config (no probe) and person occlusion off', opts().length === 1 && opts()[0].personOcclusion === false && opts()[0].erase?.on === true && opts()[0].erase.dilate === 5 && !('probe' in opts()[0].erase), JSON.stringify(opts()));
  calls.length = 0;
  await v.set({ erase: { on: true, dilate: 5 } });
  check('view: the same erase config again -> nothing sent', opts().length === 0, JSON.stringify(opts()));
  await v.init(defaultModel('right'));
  check('view: init (a new AR session) sends the erase config again', opts().some((o) => o.erase?.on === true && o.erase.dilate === 5), JSON.stringify(opts()));
  calls.length = 0;
  await v.set({ erase: false });
  check('view: erase false -> erase {on: false} sent (settings kept), person occlusion back on', opts().length === 1 && opts()[0].erase?.on === false && opts()[0].erase.dilate === 5 && opts()[0].personOcclusion === true, JSON.stringify(opts()));
  calls.length = 0;
  await v.set({ look: 'model', erase: true });
  await v.dispose();
  const last = opts().at(-1);
  check('view: dispose -> erasing off and person occlusion restored', last?.erase?.on === false && last.personOcclusion === true, JSON.stringify(opts()));
}

// ---------------------------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed${failed ? `: ${fails.join('; ')}` : ''}`);
process.exit(failed ? 1 : 0);
