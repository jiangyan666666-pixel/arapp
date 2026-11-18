// A pretend native layer for running the pages on the PC (check.html?fake, check2.html?fake).
// It answers every message of docs/protocol.md the way ios/ARApp does, with made-up but plausible
// values, and paints a stand-in for the camera picture with the boxes the page asked for. It proves
// the page's own logic only – nothing about the real app. Loaded by the *-boot.js files before any
// other module, because native.js reads window.__nativeInfo / window.webkit when it is imported.
//
//   ?fake / ?fake=room   a room: camera 1.4 m above the floor, looking ahead and a little down (stage 2)
//   ?fake=desk           a desk: table top at y = 0.75, camera 0.4 m above it looking down ~55° (stage 3)
//   &features=ar         pretend to be the stage-2 app (only these features; stage-3 messages fail)
//   &hand=flat|wave|slide|none   the simulated hand (default flat in the desk scene, none in the room):
//                        flat  = resting flat on the table, palm down, still (for the scan)
//                        wave  = moving over the table, fingers flexing, now and then a pinch
//                        slide = flat, slid 10 cm away from the user every 5 s (0, 10, 20 cm; the
//                                "fingertip on a ruler" step)
//                        none  = no hand in the picture (events still come, with hands: [])
//   &side=left           the simulated hand is a left hand (default right: the phone is in the left)
//   &cam=sweep           the camera moves from 20 to 60 cm from the hand and back (20 s), else still
//   &replay=<name>       play a recording from /__handrec/<name> (src/hand/recorder.js) with its
//                        original timing and its own cameras, instead of the simulated hand; its
//                        native times are moved onto this fake's clock, so latencies stay meaningful
// The hand and camera motions can also be switched in a small fake-only panel at the right edge.
//
// The camera follows ARKit's conventions exactly (protocol §0): camera.transform columns are
// X = screen down, Y = screen right, Z = backwards; intrinsics for the 1920×1440 landscape image;
// display = displayTransform(for: .portrait, viewportSize:); projection / view = the portrait ones
// (Metal depth range, as ARKit's projectionMatrix). They come from src/hand/sim.js (checked against
// real captures of the phone), the same code that makes the simulated hand's 'ar.hands' events.
//
// Where docs/protocol.md is silent this follows what the native layer decided: a joint below
// minJointConfidence keeps x, y, c but its six depth numbers are 0; ar.setLight without `on` is on;
// ar.depth raises its step itself above 49 152 pixels; ar.removeGroup of an unknown id is ok; ar.stop
// removes all groups and the light; ar.start with reset removes all groups; ar.updateGroups with an
// id applies what it can and answers {error: 'N update(s) skipped: …'}; a bad hands config makes
// ar.start / ar.setOptions / ar.hands fail before anything changes; a new orientation without a
// pointTransform takes that orientation's default, pointTransform null goes back to it. The erase
// option (HandEraser.swift) is checked and kept as the app does (also across ar.start, until the
// page goes), but nothing is erased from the stand-in picture; `probe: true` answers with a made-up
// "ar.erase" event. With &features= lacking "erase" the key is ignored, as the stage-3 app does.
//
// Hooks for tests and the hand simulator, on window.__fakeNative:
//   handSource = null | (fake, nowSeconds) => ar.hands event (or null to skip a frame). Called at the
//     hand config's hz while hands are on and the session runs; whatever the source leaves out
//     (type, seq, t, tv0, tv1, tSent, camera, display, viewport, depthSize, window, hands) is filled in.
//     Starts as the simulated hand (simHandSource); a test may replace it.
//   hand = {motion, side, model, noise}, setHand(motion), cameraMotion, setCameraMotion('still' | 'sweep'),
//     simJoints(nowSeconds) – the simulated hand's 21 joint centres (world) at that native time
//   replay = null | {name, events, planes, model, loops}
//   scene, setScene('room' | 'desk'), setCamera(eye, target), camera, viewport, display, view, projection
//   now() – the fake native clock (seconds; deliberately not the page's clock)
//   correct([dx, dy, dz]) – pretend ARKit corrected its map: anchored groups move by this much
//   depthAt(x, y) → {z, conf, person, personZ} – what the "LiDAR" sees at an image point; replace it to
//     add a hand to ar.depth / ar.capture
//   worldToImage(p), worldToScreen(p), imageRay(x, y), groups (Map), planes(), light, handsConfig, log

import {
  makeCamera as simCamera,
  displayFor,
  portraitMatrices as simPortraitMatrices,
  handJoints,
  restingPose,
  handsEvent as simHandsEvent,
  rng,
  IMAGE,
  INTRINSICS,
} from './hand/sim.js';
import { defaultModel } from './hand/model.js';
import { FINGERS } from './hand/joints.js';
import { poseFromJoints, poseBoxes, palmBoxCentre } from './hand/pose.js';
import { quatFromAxisAngle, imageToView } from './hand/geom.js';

const DEPTH_SIZE = [256, 192];
const Z_NEAR = 0.01;
const Z_FAR = 100;
const CLOCK_OFFSET = 3600; // the native clock is not the page's: pages must not mix them
const START_DELAY = 400; // ms before ar.start answers, as the camera takes a moment to come up
const DETECT_AFTER = 1.5; // s after start until the planes are "found" and tracking is normal
const ALL_FEATURES = ['ar', 'hands', 'groups', 'planes', 'depth', 'haptic', 'light', 'erase'];
const ERASE_DEFAULTS = { on: false, mask: 'alpha', dilate: 3, feather: 2, maxDepth: 0, strength: 1, view: 'normal', srcSpace: 'auto', dstSpace: 'auto' };
const ERASE_VIEWS = ['normal', 'mask', 'coverage', 'camera', 'source', 'split'];
const MAX_GROUPS = 64;
const MAX_BOXES = 400;
const MAX_DEPTH_PIXELS = 49152;

const params = new URLSearchParams(location.search);
const FEATURES = params.has('features') ? params.get('features').split(',').filter(Boolean) : ALL_FEATURES;

// --- small math: column-major 4×4 matrices, quaternions [x, y, z, w] ---

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a) => Math.hypot(a[0], a[1], a[2]);
const normalize = (a) => mul(a, 1 / (length(a) || 1));
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const round = (v, k = 1e5) => Math.round(v * k) / k;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isVec = (v, n = 3) => Array.isArray(v) && v.length === n && v.every(isNum);

const transformPoint = (m, p) => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];
const transformDir = (m, d) => [m[0] * d[0] + m[4] * d[1] + m[8] * d[2], m[1] * d[0] + m[5] * d[1] + m[9] * d[2], m[2] * d[0] + m[6] * d[1] + m[10] * d[2]];

/** Inverse of a rotation + translation. */
function invertRigid(m) {
  const t = [m[12], m[13], m[14]];
  const r = [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, 0, 0, 0, 1];
  const ti = transformDir(r, t);
  r[12] = -ti[0];
  r[13] = -ti[1];
  r[14] = -ti[2];
  return r;
}

const quatYaw = (yaw) => [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
const quatMul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
function quatNormalize(q) {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}
function quatRotate(q, v) {
  const [x, y, z, w] = q;
  const u = [x, y, z];
  const t = mul(cross(u, v), 2);
  return add(add(v, mul(t, w)), cross(u, t));
}
/** Pose matrix from a position and a rotation. */
function compose(p, q) {
  const [x, y, z, w] = q;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
    p[0], p[1], p[2], 1,
  ];
}

// --- the camera, in ARKit's conventions (src/hand/sim.js) ---

/**
 * camera.transform for a phone held upright (portrait) at `eye`, looking at `target`.
 * Columns: X = screen down, Y = screen right, Z = backwards (the camera looks along −Z).
 */
const makeCamera = (eye, target) => simCamera({ position: eye, lookAt: target }).transform;

/**
 * The portrait view and projection matrices, as ARKit's viewMatrix(for: .portrait) and
 * projectionMatrix(for: .portrait, viewportSize:, zNear: 0.01, zFar: 100). The 4th argument is the
 * viewport (an older form passed the display transform there; that one is derived from the viewport).
 */
function portraitMatrices(transform, intrinsics = INTRINSICS, image = IMAGE, viewport = fake.viewport) {
  const vp = Array.isArray(viewport) && viewport.length === 2 ? viewport : fake.viewport;
  return simPortraitMatrices({ transform, intrinsics, imageResolution: image }, vp, Z_NEAR, Z_FAR);
}

// --- scenes: what the "camera" looks at ---

const deg = Math.PI / 180;
const SCENES = {
  room: {
    label: '假画面（房间）',
    eye: [0, 1.4, 0],
    target: [0, 1.4 - Math.tan(15 * deg), -1], // looking ahead, 15° down
    surfaces: [{ y: 0, bounds: [-20, 20, -30, 10] }],
    planes: [plane('fake-floor', 'floor', [0, 0, -2], [4, 5])],
  },
  desk: {
    label: '假画面（桌面）',
    eye: [0, 1.15, 0], // 0.4 m above the table top, over its front edge
    target: [0, 1.15 - Math.sin(55 * deg), -Math.cos(55 * deg)], // looking down 55°
    table: { y: 0.75, centre: [0, -0.3], extent: [1.2, 0.7] },
    surfaces: [
      { y: 0.75, bounds: [-0.6, 0.6, -0.65, 0.05] },
      { y: 0, bounds: [-20, 20, -30, 10] },
    ],
    // like ARKit's: the table's anchor is turned and not at its centre (the extent is turned back
    // by rotationOnYAxis), so pages must not read the extent as an axis-aligned box
    planes: [plane('fake-table', 'table', [0, 0.75, -0.3], [1.2, 0.7], { yaw: 1.2, origin: [0.25, -0.12] }), plane('fake-floor', 'floor', [0, 0, -1.2], [3, 2.5])],
  },
};

/**
 * A horizontal plane whose real outline is the world-axis-aligned w x l rectangle around centre.
 * yaw turns the anchor about +Y; origin = where the anchor sits, relative to the centre (x, z).
 */
function plane(id, cls, centre, [w, l], { yaw = 0, origin = [0, 0] } = {}) {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const O = [centre[0] + origin[0], centre[1], centre[2] + origin[1]];
  // world (x, z) -> anchor (x, z): anchor X = (c, 0, -s), Z = (s, 0, c)
  const local = (x, z) => [round((x - O[0]) * c - (z - O[2]) * s), round((x - O[0]) * s + (z - O[2]) * c)];
  const corners = [[-w / 2, -l / 2], [w / 2, -l / 2], [w / 2, l / 2], [-w / 2, l / 2]].map(([dx, dz]) => local(centre[0] + dx, centre[2] + dz));
  const ctr = local(centre[0], centre[2]);
  return {
    id,
    alignment: 'horizontal',
    class: cls,
    transform: [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, ...O, 1],
    center: [ctr[0], 0, ctr[1]],
    extent: [w, l],
    rotationOnYAxis: round(-yaw),
    boundary: corners,
  };
}

/** The plane's outline in world x/z (min x, max x, min z, max z), from its boundary. */
function planeBounds(pl) {
  const T = pl.transform;
  const xs = [];
  const zs = [];
  for (const [x, z] of pl.boundary) {
    xs.push(T[0] * x + T[8] * z + T[12]);
    zs.push(T[2] * x + T[10] * z + T[14]);
  }
  return [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
}

// --- state ---

const HANDS_DEFAULTS = {
  on: false,
  hz: 30,
  maxHands: 2,
  orientation: 'right',
  pointTransform: [0, -1, -1, 0, 1, 1],
  window: 2,
  minJointConfidence: 0,
  patchEvery: 0,
  patchMargin: 12,
  patchStep: 1,
  patchMax: 6000,
};
const POINT_TRANSFORMS = { right: [0, -1, -1, 0, 1, 1], up: [1, 0, 0, -1, 0, 1], left: [0, 1, 1, 0, 0, 0], down: [-1, 0, 0, 1, 1, 0] };

const fake = {
  features: FEATURES,
  scene: SCENES[params.get('fake')] ? params.get('fake') : params.has('replay') ? 'desk' : 'room',
  started: false, // ar.start was called at least once (the native view exists)
  running: false,
  startedAt: 0, // native time
  options: {},
  camera: { transform: null, intrinsics: INTRINSICS, imageResolution: IMAGE },
  viewport: [0, 0],
  display: null,
  view: null,
  projection: null,
  groups: new Map(),
  light: null,
  handsConfig: { ...HANDS_DEFAULTS },
  erase: { ...ERASE_DEFAULTS },
  eraseFrames: 0,
  handSource: null,
  handSeq: 0,
  lastHands: null, // the last hand event
  log: [],
  timers: { status: 0, hands: 0, draw: 0, planes: 0 },
  stats: { hands: [], latency: [] }, // [{at, ms}] over the last second
  planesFound: false,
  planesSentAt: -1e9,
  now: () => performance.now() / 1000 + CLOCK_OFFSET,
  makeCamera,
  displayFor,
  portraitMatrices,
  // the simulated hand (set up below) and a recording to play instead
  hand: null,
  cameraMotion: params.get('cam') === 'sweep' ? 'sweep' : 'still',
  cameraT0: 0,
  replay: null,
  replayPlanes: null,
};
window.__fakeNative = fake; // for tests, the hand simulator and poking at it from the console

function updateCamera(transform = fake.camera.transform, intrinsics = fake.camera.intrinsics || INTRINSICS) {
  fake.camera = { transform, intrinsics: [...intrinsics], imageResolution: IMAGE };
  fake.viewport = [window.innerWidth, window.innerHeight];
  fake.display = displayFor(fake.viewport);
  Object.assign(fake, portraitMatrices(transform, fake.camera.intrinsics, IMAGE, fake.viewport));
}
const scene = () => SCENES[fake.scene];
updateCamera(makeCamera(scene().eye, scene().target), INTRINSICS);
window.addEventListener('resize', () => updateCamera());

fake.setScene = (name) => {
  if (!SCENES[name]) throw new Error(`no fake scene "${name}" (room, desk)`);
  fake.scene = name;
  updateCamera(makeCamera(scene().eye, scene().target));
  if (fake.planesFound) sendPlanes(true);
};
fake.setCamera = (eye, target) => {
  fake.cameraMotion = 'still';
  updateCamera(makeCamera(eye, target));
};
// a replay shows the planes of the recording (the fake scene's would not match its cameras)
fake.planes = () => (fake.replay ? fake.replayPlanes || [] : fake.planesFound ? scene().planes : []);

/** World point → image (x, y) normalized, landscape, and its depth along the viewing axis; null if behind. */
fake.worldToImage = (p) => {
  const local = transformPoint(invertRigid(fake.camera.transform), p);
  const z = -local[2];
  if (z <= 1e-6) return null;
  const [fx, , , , fy, , cx, cy] = INTRINSICS;
  return [(cx + (fx * local[0]) / z) / IMAGE[0], (cy - (fy * local[1]) / z) / IMAGE[1], z];
};
/** World point → CSS pixels on the screen (through view + projection); null if behind the camera. */
fake.worldToScreen = (p) => {
  const e = transformPoint(fake.view, p);
  return e[2] < -1e-6 ? eyeToScreen(e) : null;
};
/** The ray through image point (x, y): origin and direction, scaled so 1 unit = 1 m of depth. */
fake.imageRay = (x, y) => {
  const [fx, , , , fy, , cx, cy] = INTRINSICS;
  const local = [(x * IMAGE[0] - cx) / fx, -(y * IMAGE[1] - cy) / fy, -1];
  return { origin: [fake.camera.transform[12], fake.camera.transform[13], fake.camera.transform[14]], dir: transformDir(fake.camera.transform, local) };
};
function screenToImage(sx, sy) {
  const [a, b, c, d, tx, ty] = fake.display;
  const det = a * d - b * c;
  return [(d * (sx - tx) - c * (sy - ty)) / det, (-b * (sx - tx) + a * (sy - ty)) / det];
}

/** Nearest real surface along a ray: {t (= depth along the viewing axis), point, surface}. */
function castScene({ origin, dir }, surfaces = scene().surfaces) {
  let best = null;
  for (const s of surfaces) {
    if (Math.abs(dir[1]) < 1e-9) continue;
    const t = (s.y - origin[1]) / dir[1];
    if (t <= 0 || (best && t >= best.t)) continue;
    const point = add(origin, mul(dir, t));
    const [x0, x1, z0, z1] = s.bounds;
    if (point[0] < x0 || point[0] > x1 || point[2] < z0 || point[2] > z1) continue;
    best = { t, point, surface: s };
  }
  return best;
}

/** What the "LiDAR" sees at image point (x, y). Replace to add things (a hand) to the depth. */
fake.depthAt = (x, y) => {
  const hit = castScene(fake.imageRay(x, y));
  if (!hit || hit.t > 5) return { z: 0, conf: 0, person: false, personZ: 0 };
  const z = hit.t;
  return { z, conf: z < 0.5 ? 1 : z < 2.5 ? 2 : z < 4 ? 1 : 0, person: false, personZ: 0 };
};

/** Pretend ARKit corrected its map: anchored groups follow the real surroundings by this much. */
fake.correct = (offset = [0.03, 0, -0.02]) => {
  for (const g of fake.groups.values()) {
    if (!g.anchored) continue;
    g.position = add(g.position, offset);
    g.anchorUpdates++;
    g.anchorShift += length(offset);
  }
};

// --- groups ---

function normalizeBox(b) {
  if (!b || !isVec(b.size) || !b.size.every((v) => v > 0) || !isVec(b.position)) return null;
  return {
    size: [...b.size],
    position: [...b.position],
    rotation: isVec(b.rotation, 4) ? quatNormalize(b.rotation) : [0, 0, 0, 1],
    color: isVec(b.color) ? [...b.color] : [0.7, 0.55, 0.4],
    opacity: isNum(b.opacity) ? b.opacity : 1,
    material: ['pbr', 'unlit', 'occlusion'].includes(b.material) ? b.material : 'pbr',
    roughness: isNum(b.roughness) ? b.roughness : 0.8,
    metallic: isNum(b.metallic) ? b.metallic : 0,
    style: b.style === 'edges' ? 'edges' : 'solid',
    edge: isNum(b.edge) ? b.edge : 0.003,
    visible: b.visible !== false,
  };
}

/** Applies position / rotation | yaw from a message; true if the pose was set. */
function applyPose(g, p) {
  let set = false;
  if (isVec(p.position)) {
    g.position = [...p.position];
    set = true;
  }
  if (isVec(p.rotation, 4)) {
    g.rotation = quatNormalize(p.rotation);
    set = true;
  } else if (isNum(p.yaw)) {
    g.rotation = quatYaw(p.yaw);
    set = true;
  }
  if (set && g.anchored) {
    // an absolute pose re-anchors: the corrections so far no longer count
    g.anchorUpdates = 0;
    g.anchorShift = 0;
  }
  return set;
}

function setGroup(p) {
  if (!fake.started) return { error: 'ar-not-started' };
  if (typeof p.id !== 'string' || !p.id) return { error: 'bad-id' };
  if (!Array.isArray(p.boxes)) return { error: 'bad-boxes' };
  if (p.boxes.length > MAX_BOXES) return { error: `too-many-boxes (at most ${MAX_BOXES})` };
  if (!fake.groups.has(p.id) && fake.groups.size >= MAX_GROUPS) return { error: `too-many-groups (at most ${MAX_GROUPS})` };
  const boxes = p.boxes.map(normalizeBox);
  if (boxes.some((b) => !b)) return { error: 'bad-box' };
  const g = { id: p.id, boxes, position: [0, 0, 0], rotation: [0, 0, 0, 1], anchored: Boolean(p.anchored), shadow: Boolean(p.shadow), visible: p.visible !== false, anchorUpdates: 0, anchorShift: 0 };
  applyPose(g, p);
  fake.groups.set(p.id, g);
  return { ok: true, count: boxes.length };
}

/** Applies one box update; returns a reason when it had to be skipped. */
function updateBox(g, u) {
  if (Array.isArray(u)) {
    const b = g.boxes[u[0]];
    if (!b) return `${g.id}: no box ${u[0]}`;
    if ((u.length !== 8 && u.length !== 11) || !u.every(isNum)) return `${g.id}: bad row for box ${u[0]}`;
    if (u.length === 11 && !(u[8] > 0 && u[9] > 0 && u[10] > 0)) return `${g.id}: bad size for box ${u[0]}`;
    b.position = [u[1], u[2], u[3]];
    b.rotation = quatNormalize([u[4], u[5], u[6], u[7]]);
    if (u.length === 11) b.size = [u[8], u[9], u[10]];
    return null;
  }
  const b = u && g.boxes[u.i];
  if (!b) return `${g.id}: no box ${u?.i}`;
  const merged = normalizeBox({ ...b, ...u });
  if (!merged) return `${g.id}: bad update for box ${u.i}`;
  g.boxes[u.i] = merged;
  return null;
}

function updateGroups(p) {
  if (!fake.started || !Array.isArray(p.groups)) return { error: 'bad-groups' };
  // as the app: apply every valid part; with an id, say what was skipped
  const skipped = [];
  for (const u of p.groups) {
    const g = u && fake.groups.get(u.id);
    if (!g) {
      skipped.push(`no group ${u?.id}`);
      continue;
    }
    applyPose(g, u);
    if (typeof u.visible === 'boolean') g.visible = u.visible;
    if (Array.isArray(u.boxes)) {
      for (const bu of u.boxes) {
        const why = updateBox(g, bu);
        if (why) skipped.push(why);
      }
    }
  }
  const now = fake.now();
  if (isNum(p.frameT)) fake.stats.latency.push({ at: now, ms: (now - p.frameT) * 1000 });
  if (skipped.length) return { error: `${skipped.length} update(s) skipped: ${skipped.slice(0, 3).join('; ')}` };
  return { ok: true, now };
}

function moveGroup(p) {
  const g = fake.groups.get(p.id);
  if (!g) return { error: 'no-group' };
  // along the group's own axes from where it is now, then a turn about world Y in place
  const d = [isNum(p.dx) ? p.dx : 0, isNum(p.dy) ? p.dy : 0, isNum(p.dz) ? p.dz : 0];
  g.position = add(g.position, quatRotate(g.rotation, d));
  if (isNum(p.dyaw) && p.dyaw) g.rotation = quatNormalize(quatMul(quatYaw(p.dyaw), g.rotation));
  return { ok: true, transform: compose(g.position, g.rotation) };
}

const groupTransform = (g) => compose(g.position, g.rotation);

// --- events ---

const emit = (event) => window.__nativeEvent?.(event);
const lastSecond = (list, now) => {
  while (list.length && list[0].at < now - 1) list.shift();
  return list;
};
/** Tracking has settled and the planes are found, a moment after the start (as on the phone). */
const settled = () => fake.now() - fake.startedAt >= DETECT_AFTER;

function percentile(sorted, q) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function status() {
  const now = fake.now();
  const handStats = lastSecond(fake.stats.hands, now);
  const lat = lastSecond(fake.stats.latency, now).map((e) => e.ms).sort((a, b) => a - b);
  const groups = {};
  for (const g of fake.groups.values()) {
    if (g.anchored) groups[g.id] = { transform: groupTransform(g), anchorUpdates: g.anchorUpdates, anchorShift: round(g.anchorShift) };
  }
  const furniture = fake.groups.get('furniture');
  const planes = fake.planes();
  const vision = handStats.map((e) => e.ms);
  const lastHands = fake.lastHands?.hands ?? [];
  const depths = lastHands.flatMap((h) => (h.joints || []).map((j) => j[3]).filter((v) => v > 0));
  const stage2 = {
    type: 'ar.status',
    t: now - 0.004,
    tracking: settled() ? 'normal' : 'initializing',
    mapping: settled() ? 'extending' : 'limited',
    camera: fake.camera.transform,
    projection: fake.projection,
    view: fake.view,
    planes: { horizontal: planes.filter((pl) => pl.alignment === 'horizontal').length, vertical: planes.filter((pl) => pl.alignment === 'vertical').length },
    meshAnchors: 12,
    hasDepth: true,
    person: depths.length ? { fraction: round(0.03 * lastHands.length, 1e3), nearest: round(Math.min(...depths)), mean: round(depths.reduce((s, v) => s + v, 0) / depths.length) } : { fraction: 0 },
    ...(furniture ? { furniture: { transform: groupTransform(furniture), anchorUpdates: furniture.anchorUpdates, anchorShift: round(furniture.anchorShift) } } : {}),
  };
  if (!FEATURES.includes('groups')) return stage2; // pretending to be the stage-2 app
  return {
    ...stage2,
    now,
    viewport: fake.viewport,
    display: fake.display,
    fps: 60,
    thermal: 'nominal',
    hands: {
      on: Boolean(fake.handsConfig.on),
      rate: handStats.length,
      visionMs: vision.length ? [round(vision.reduce((s, v) => s + v, 0) / vision.length, 10), round(Math.max(...vision), 10)] : [0, 0],
      hands: lastHands.length,
    },
    // no updates with frameT in the last second: n = 0 and the numbers 0 (the protocol leaves this open)
    latency: lat.length
      ? { n: lat.length, mean: round(lat.reduce((s, v) => s + v, 0) / lat.length, 10), p50: round(percentile(lat, 0.5), 10), p90: round(percentile(lat, 0.9), 10), max: round(lat[lat.length - 1], 10) }
      : { n: 0, mean: 0, p50: 0, p90: 0, max: 0 },
    groups,
  };
}

function restartStatus() {
  clearInterval(fake.timers.status);
  if (!fake.running) return;
  const hz = Math.min(30, Math.max(0.5, Number(fake.options.statusHz) || 4));
  fake.timers.status = setInterval(() => {
    if (!fake.planesFound && settled()) {
      fake.planesFound = true;
      sendPlanes(true);
    }
    emit(status());
  }, 1000 / hz);
}

/** "ar.planes" when the list changed, at most planesHz a second, if planeEvents is on. */
function sendPlanes(changed) {
  if (!changed || fake.options.planeEvents === false || !fake.running) return;
  const hz = Math.max(0.1, Number(fake.options.planesHz) || 2);
  const now = fake.now();
  const wait = fake.planesSentAt + 1 / hz - now;
  clearTimeout(fake.timers.planes);
  if (wait > 0) {
    fake.timers.planes = setTimeout(() => sendPlanes(true), wait * 1000);
    return;
  }
  fake.planesSentAt = now;
  emit({ type: 'ar.planes', planes: fake.planes() });
}

function handEvent(now) {
  let ev;
  try {
    ev = fake.handSource(fake, now);
  } catch (e) {
    console.error('fake-native: handSource failed', e);
    return null;
  }
  if (!ev) return null; // Vision skipped this frame
  // Vision took ~8 ms on a frame captured ~12 ms ago: plausible defaults for the times
  const out = {
    t: now - 0.012,
    tv0: now - 0.009,
    tv1: now - 0.001,
    tSent: now,
    camera: { ...fake.camera },
    display: fake.display,
    viewport: fake.viewport,
    depthSize: DEPTH_SIZE,
    window: fake.handsConfig.window,
    hands: [],
    ...ev,
    type: 'ar.hands',
    seq: ++fake.handSeq,
  };
  fake.lastHands = out;
  fake.stats.hands.push({ at: now, ms: (out.tv1 - out.tv0) * 1000 });
  return out;
}

function restartHands() {
  clearInterval(fake.timers.hands);
  clearTimeout(fake.timers.replay);
  if (!fake.running || !fake.handsConfig.on) return;
  if (fake.replay) {
    startReplay();
    return;
  }
  const hz = Math.min(60, Math.max(1, Number(fake.handsConfig.hz) || 30));
  fake.timers.hands = setInterval(() => {
    if (!fake.handSource) return;
    const ev = handEvent(fake.now());
    if (ev) emit(ev);
  }, 1000 / hz);
}

const isInt = (v, lo, hi = Infinity) => Number.isInteger(v) && v >= lo && v <= hi;

/** Why a hands config is refused, or null. The app refuses the whole message (nothing changes). */
function handsError(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'hands: need an object';
  const bad = {
    on: (v) => typeof v !== 'boolean',
    hz: (v) => !(isNum(v) && v > 0),
    maxHands: (v) => !isInt(v, 1, 10),
    orientation: (v) => !POINT_TRANSFORMS[v],
    pointTransform: (v) => v !== null && !isVec(v, 6),
    window: (v) => !isInt(v, 0, 20),
    minJointConfidence: (v) => !(isNum(v) && v >= 0 && v <= 1),
    patchEvery: (v) => !isInt(v, 0),
    patchMargin: (v) => !isInt(v, 0),
    patchStep: (v) => !isInt(v, 1),
    patchMax: (v) => !isInt(v, 1),
  };
  for (const [k, v] of Object.entries(p)) {
    if (v !== undefined && bad[k] && bad[k](v)) return `hands: bad ${k}`;
  }
  return null;
}

/** Why an erase config is refused, or null (as HandEraser.swift: the whole message is refused). */
function eraseError(p) {
  if (!FEATURES.includes('erase') || p === undefined || p === null) return null;
  if (typeof p !== 'object' || Array.isArray(p)) return 'erase: an object {on, mask, …}';
  const bad = {
    on: (v) => typeof v !== 'boolean',
    mask: (v) => !['alpha', 'depth'].includes(v),
    dilate: (v) => !(isNum(v) && Math.round(v) >= 0 && Math.round(v) <= 16),
    feather: (v) => !(isNum(v) && Math.round(v) >= 0 && Math.round(v) <= 8),
    maxDepth: (v) => !(isNum(v) && v >= 0),
    strength: (v) => !isNum(v),
    view: (v) => !ERASE_VIEWS.includes(v),
    srcSpace: (v) => !['auto', 'linear', 'gamma'].includes(v),
    dstSpace: (v) => !['auto', 'linear', 'gamma'].includes(v),
    probe: (v) => typeof v !== 'boolean',
  };
  for (const [k, v] of Object.entries(p)) {
    if (v !== undefined && v !== null && bad[k] && bad[k](v)) return `erase: bad ${k}`;
  }
  return null;
}

function setErase(p) {
  if (!FEATURES.includes('erase') || !p) return;
  const next = { ...fake.erase };
  for (const [k, v] of Object.entries(p)) {
    if (!(k in ERASE_DEFAULTS) || v === undefined || v === null) continue;
    next[k] = k === 'dilate' || k === 'feather' ? Math.round(v) : k === 'strength' ? Math.min(Math.max(v, 0), 1) : v;
  }
  if (next.on && !fake.erase.on) fake.eraseFrames = 0;
  fake.erase = next;
  if (p.probe === true) {
    setTimeout(() => {
      if (!fake.erase.on || !fake.running) return; // the app probes inside a drawn frame
      const alpha = next.mask === 'alpha';
      emit({
        type: 'ar.erase',
        probe: {
          fake: true,
          seq: (fake.eraseProbes = (fake.eraseProbes || 0) + 1),
          config: { ...fake.erase },
          source: { format: 'bgra8Unorm_srgb', size: [1179, 2556], usage: 23, type: 2, samples: 1 },
          depth: { format: 'depth32Float', size: [1179, 2556], usage: 17, type: 2, samples: 1 },
          target: { format: 'bgra8Unorm_srgb', size: [1179, 2556], usage: 23, type: 2, samples: 1 },
          mainThread: true,
          depthRead: true,
          personMask: true,
          samples: 47376,
          alpha: alpha ? { low: 0.9, mid: 0.01, high: 0.09 } : { low: 0, mid: 0, high: 1 },
          depth: { zero: 0.85, one: 0, other: 0.15 },
          background: { samples: 40270, source: alpha ? [0, 0, 0] : [0.21, 0.19, 0.17], cameraGamma: [0.48, 0.45, 0.42], cameraLinear: [0.2, 0.18, 0.16] },
          srcLinear: true,
          dstLinear: true,
        },
      });
    }, 120);
  }
}

function setHands(p) {
  const was = fake.handsConfig.on;
  const next = { ...fake.handsConfig };
  for (const [k, v] of Object.entries(p || {})) if (k in HANDS_DEFAULTS && v !== undefined) next[k] = v;
  // a new orientation brings its own default transform; null goes back to the orientation's default
  if (p && ((p.orientation && p.pointTransform === undefined) || p.pointTransform === null)) next.pointTransform = POINT_TRANSFORMS[next.orientation] || HANDS_DEFAULTS.pointTransform;
  fake.handsConfig = next;
  if (next.on && !was) fake.handSeq = 0;
  if (!next.on) fake.lastHands = null;
  restartHands();
  return fake.handsConfig;
}

// --- the simulated hand (src/hand/sim.js): the hand the stand-in camera "sees" ---

const HAND_MOTIONS = ['flat', 'wave', 'slide', 'none'];
const CAMERA_MOTIONS = ['still', 'sweep'];
const SKIN = [0.87, 0.67, 0.55];

/** The simulated person's hand: a little bigger and thicker than the default model, so a scan visibly measures it. */
function personHand(side) {
  const m = defaultModel(side);
  const k = 1.05;
  m.palm = { width: 0.087, length: 0.094 * k, thickness: 0.028 };
  for (const f of FINGERS) m.fingers[f].lengths = m.fingers[f].lengths.map((l) => l * k);
  m.palmShape = m.palmShape.map(([x, y, z]) => [x * 1.06, y, z * k]);
  m.handLength = m.palm.length + m.fingers.middle.lengths.reduce((a, b) => a + b, 0);
  return m;
}

const handMotion = params.get('hand');
const handSide = params.get('side') === 'left' ? 'left' : 'right';
fake.hand = {
  motion: HAND_MOTIONS.includes(handMotion) ? handMotion : fake.scene === 'desk' ? 'flat' : 'none',
  side: handSide,
  model: personHand(handSide),
  t0: fake.now(),
  noise: { px: 1, depth: 0.003 }, // Vision joint jitter (pixels of 1920×1440) and LiDAR noise (m)
  random: rng(7),
};

/** Where the hand lies: the table point the desk camera looks at; in the room, 45 cm in front of the camera. */
function handAnchor() {
  const sc = scene();
  if (sc.table) return [0, sc.table.y, -0.28];
  const dir = normalize(sub(sc.target, sc.eye));
  return add(sc.eye, mul(dir, 0.45));
}

/** Palm-down rest pose with the palm's centre at the anchor (+ offset, world x / z). */
function restAt(offset = [0, 0, 0]) {
  const m = fake.hand.model;
  const A = handAnchor();
  const sc = scene();
  const table = sc.table ? sc.table.y : A[1] - m.palm.thickness / 2;
  // fingers pointing up the screen (away from the user), turned a little inwards
  const r = restingPose(m, { table, at: [0, 0], yaw: fake.hand.side === 'left' ? -0.12 : 0.12 });
  const c = add(r.origin, quatRotate(r.rotation, palmBoxCentre(m, fake.hand.side)));
  return { ...r, origin: add(r.origin, [A[0] + offset[0] - c[0], 0, A[2] + offset[2] - c[2]]) };
}

/** 'slide': the palm's z offset (world) over a 15 s cycle: 0, 10, 20 cm away from the user, 4 s each. */
function slideOffset(t) {
  const S = [0.08, -0.02, -0.12];
  const ph = ((t % 15) + 15) % 15;
  const ease = (a, b, u) => a + (b - a) * (0.5 - 0.5 * Math.cos(Math.PI * u));
  if (ph < 4) return S[0];
  if (ph < 5) return ease(S[0], S[1], ph - 4);
  if (ph < 9) return S[1];
  if (ph < 10) return ease(S[1], S[2], ph - 9);
  if (ph < 14) return S[2];
  return ease(S[2], S[0], ph - 14);
}

/** The simulated hand's 21 joint centres (world) at native time `now`, or null when there is no hand. */
function simJoints(now) {
  const h = fake.hand;
  const m = h.model;
  const t = now - h.t0;
  if (h.motion === 'flat') return handJoints(m, restAt());
  if (h.motion === 'slide') return handJoints(m, restAt([0, 0, slideOffset(t)]));
  if (h.motion !== 'wave') return null;
  const r = restAt();
  const s = (f, ph = 0) => Math.sin(2 * Math.PI * f * t + ph);
  // hovering 4-12 cm above the table, drifting around the anchor, tilting a little
  const origin = add(r.origin, [0.06 * s(0.13), 0.08 + 0.04 * s(0.21), 0.05 * s(0.09, 1)]);
  const tilt = quatMul(quatFromAxisAngle([0, 0, 1], 0.35 * s(0.17)), quatFromAxisAngle([1, 0, 0], 0.25 * s(0.11, 0.5)));
  const rotation = quatMul(quatMul(quatFromAxisAngle([0, 1, 0], 0.25 * s(0.07)), r.rotation), tilt);
  // the fingers open and close every 4 s; every 6 s a pinch (thumb and index together) for 1.5 s
  const curl = 0.5 - 0.5 * Math.cos(2 * Math.PI * 0.25 * t);
  const ph = ((t % 6) + 6) % 6;
  const k = ph > 3.5 && ph < 5 ? Math.sin((Math.PI * (ph - 3.5)) / 1.5) : 0;
  const flex = {};
  for (const f of FINGERS) {
    const open = f === 'thumb' ? [0.1 * curl, 0.3 * curl, 0.3 * curl] : [0.9 * curl, 1.1 * curl, 0.6 * curl];
    const pinch = f === 'thumb' ? [0.3, 0.5, 0.3] : f === 'index' ? [0.6, 0.7, 0.4] : [0.25, 0.3, 0.2];
    flex[f] = open.map((v, i) => (1 - k) * v + k * pinch[i]);
  }
  return handJoints(m, { origin, rotation, flex, spread: 0.12 * (1 - curl) });
}
fake.simJoints = simJoints;

/** The default handSource: what Vision and LiDAR would report about the simulated hand. */
function simHandSource(f, now) {
  const h = f.hand;
  const tCap = now - 0.02; // the frame was captured a moment before Vision finished with it
  const joints = h.motion === 'none' ? null : simJoints(tCap);
  if (!joints) return { hands: [] };
  const cfg = f.handsConfig;
  const seq = f.handSeq + 1;
  const sc = scene();
  const ev = simHandsEvent({
    cam: f.camera,
    viewport: f.viewport,
    model: h.model,
    joints,
    chirality: h.side,
    t: tCap,
    seq,
    table: sc.table ? { height: sc.table.y } : null,
    noise: h.noise,
    patch: cfg.patchEvery > 0 && seq % cfg.patchEvery === 0,
    random: h.random,
    window: cfg.window,
    patchMargin: cfg.patchMargin,
    patchMax: cfg.patchMax,
    patchStep: cfg.patchStep,
  });
  // Vision does not report a hand it can hardly see
  ev.hands = ev.hands.filter((hand) => hand.joints.filter((j) => j[2] > 0).length >= 8).slice(0, cfg.maxHands);
  if (!ev.hands.length) delete ev.patches;
  // as the app: a joint below minJointConfidence keeps x, y, c but gets no depth
  const minC = Number(cfg.minJointConfidence) || 0;
  if (minC > 0) for (const hand of ev.hands) for (const j of hand.joints) if (j[2] < minC) j.fill(0, 3);
  delete ev.type;
  delete ev.seq;
  return ev;
}
fake.handSource = simHandSource;

fake.setHand = (motion) => {
  if (!HAND_MOTIONS.includes(motion)) throw new Error(`no hand motion "${motion}" (${HAND_MOTIONS.join(', ')})`);
  fake.hand.motion = motion;
  fake.hand.t0 = fake.now();
  updateSwitch();
};

/** 'sweep': the camera on the line from the hand to the scene's eye, 20 → 60 → 20 cm over 20 s. */
function cameraTick() {
  if (fake.cameraMotion !== 'sweep' || fake.replay) return;
  const A = handAnchor();
  const dir = normalize(sub(scene().eye, A));
  const D = 0.4 - 0.2 * Math.cos((2 * Math.PI * (fake.now() - fake.cameraT0)) / 20);
  updateCamera(makeCamera(add(A, mul(dir, D)), A));
}

fake.setCameraMotion = (m) => {
  if (!CAMERA_MOTIONS.includes(m)) throw new Error(`no camera motion "${m}" (${CAMERA_MOTIONS.join(', ')})`);
  fake.cameraMotion = m;
  fake.cameraT0 = fake.now();
  if (m === 'still') updateCamera(makeCamera(scene().eye, scene().target));
  else cameraTick();
  updateSwitch();
};

// --- replaying a recording (src/hand/recorder.js → notes/handrec/) ---

async function loadReplay(name) {
  try {
    const res = await fetch(`/__handrec/${encodeURIComponent(name)}`);
    const rec = await res.json();
    if (!res.ok || !Array.isArray(rec.events)) throw new Error(rec.error || `HTTP ${res.status}`);
    const byRt = (a, b) => a.rt - b.rt;
    fake.replay = {
      name,
      events: rec.events.filter((e) => e && e.ev && e.ev.type === 'ar.hands').sort(byRt),
      planes: (rec.planes || []).filter((e) => e && e.ev && Array.isArray(e.ev.planes)).sort(byRt),
      model: rec.model ?? null,
      loops: 0,
    };
    console.info(`fake-native: replaying ${name} (${fake.replay.events.length} hand events)`);
  } catch (e) {
    console.warn(`fake-native: could not load the recording "${name}": ${e.message || e}`);
    fake.replay = null;
  }
  updateSwitch();
  restartHands();
}

/** The recorded event, moved onto this fake's clock (its own camera stays), as the next event. */
function emitReplayed(recorded) {
  const out = JSON.parse(JSON.stringify(recorded));
  const base = isNum(out.tSent) ? out.tSent : out.t;
  const dt = fake.now() - base;
  for (const k of ['t', 'tv0', 'tv1', 'tSent']) if (isNum(out[k])) out[k] += dt;
  out.type = 'ar.hands';
  out.seq = ++fake.handSeq;
  if (isVec(out.camera?.transform, 16)) updateCamera(out.camera.transform, isVec(out.camera.intrinsics, 9) ? out.camera.intrinsics : INTRINSICS);
  fake.lastHands = out;
  if (isNum(out.tv0) && isNum(out.tv1)) fake.stats.hands.push({ at: fake.now(), ms: (out.tv1 - out.tv0) * 1000 });
  emit(out);
}

function startReplay() {
  const R = fake.replay;
  if (!R || !R.events.length) return;
  const start = performance.now();
  const rt0 = R.events[0].rt;
  let i = 0;
  let k = 0;
  const step = () => {
    if (!fake.running || !fake.handsConfig.on || fake.replay !== R) return;
    const elapsed = performance.now() - start;
    while (k < R.planes.length && R.planes[k].rt - rt0 <= elapsed) {
      fake.replayPlanes = R.planes[k++].ev.planes;
      emit({ type: 'ar.planes', planes: fake.replayPlanes });
    }
    while (i < R.events.length && R.events[i].rt - rt0 <= elapsed) emitReplayed(R.events[i++].ev);
    if (i >= R.events.length) {
      R.loops++;
      fake.timers.replay = setTimeout(startReplay, 1000); // from the top again, after a second
      return;
    }
    fake.timers.replay = setTimeout(step, Math.max(1, R.events[i].rt - rt0 - elapsed));
  };
  step();
}

if (params.get('replay')) loadReplay(params.get('replay'));

// --- depth ---

function b64(view) {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function depth(p) {
  if (!fake.running) return { error: 'ar-not-running' };
  const [W, H] = DEPTH_SIZE;
  const rect = isVec(p.rect, 4) ? p.rect : [0, 0, 1, 1];
  let step = Math.max(1, Math.round(Number(p.step) || 2));
  const clampU = (v, n) => Math.min(n, Math.max(0, v));
  const u0 = clampU(Math.floor(rect[0] * W), W);
  const v0 = clampU(Math.floor(rect[1] * H), H);
  const u1 = clampU(Math.ceil(rect[2] * W), W);
  const v1 = clampU(Math.ceil(rect[3] * H), H);
  if (u1 <= u0 || v1 <= v0) return { error: 'bad-rect' };
  // as the app: too many pixels raise the step (the reply says which step was used)
  while (Math.ceil((u1 - u0) / step) * Math.ceil((v1 - v0) / step) > MAX_DEPTH_PIXELS) step++;
  const w = Math.ceil((u1 - u0) / step);
  const h = Math.ceil((v1 - v0) / step);
  const mm = new Uint16Array(w * h);
  const info = new Uint8Array(w * h);
  const person = p.personDepth ? new Uint16Array(w * h) : null;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const s = fake.depthAt((u0 + i * step + 0.5) / W, (v0 + j * step + 0.5) / H);
      const k = j * w + i;
      mm[k] = Math.min(65535, Math.round(s.z * 1000));
      info[k] = (s.conf & 3) | (s.person ? 4 : 0);
      if (person) person[k] = s.person ? Math.min(65535, Math.round(s.personZ * 1000)) : 0;
    }
  }
  return {
    ok: true,
    t: fake.now() - 0.004,
    camera: { ...fake.camera },
    display: fake.display,
    viewport: fake.viewport,
    depthSize: DEPTH_SIZE,
    rect: [u0, v0, u1, v1],
    step,
    w,
    h,
    depth: b64(mm),
    info: b64(info),
    ...(person ? { personDepth: b64(person) } : {}),
  };
}

function capture(p) {
  if (!fake.running) return { error: 'ar-not-running' };
  const [W, H] = DEPTH_SIZE;
  const now = fake.now();
  const out = {
    ok: true,
    timestamp: now,
    tracking: settled() ? 'normal' : 'initializing',
    camera: {
      ...fake.camera,
      viewport: fake.viewport,
      projectionPortrait: fake.projection,
      viewMatrixPortrait: fake.view,
      displayTransform: fake.display,
    },
    planes: fake.planes(),
  };
  const furniture = fake.groups.get('furniture');
  if (furniture) out.furniture = { position: furniture.position, transform: groupTransform(furniture) }; // pose only, never the size
  if (p.depth !== false) {
    const f = new Float32Array(W * H);
    const conf = new Uint8Array(W * H);
    for (let v = 0; v < H; v++) {
      for (let u = 0; u < W; u++) {
        const s = fake.depthAt((u + 0.5) / W, (v + 0.5) / H);
        f[v * W + u] = s.z;
        conf[v * W + u] = s.conf;
      }
    }
    out.depthSource = 'sceneDepth';
    out.depth = { width: W, height: H, format: 'fdep', bytesPerPixel: 4, base64: b64(f) };
    out.confidence = { width: W, height: H, format: 'L008', bytesPerPixel: 1, base64: b64(conf) };
  }
  if (p.mesh) {
    out.meshes = [{ transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], vertexCount: 3, vertexStride: 12, faceCount: 1, indicesPerFace: 3, bytesPerIndex: 4, vertices: b64(new Float32Array(9)), faces: b64(new Uint32Array([0, 1, 2])) }];
  }
  if (p.hands !== false && FEATURES.includes('hands')) {
    const ev = fake.handSource ? handEvent(now) : null;
    out.hands = ev ? ev.hands : [];
    out.handsConfig = { ...fake.handsConfig };
  }
  return out;
}

// --- raycast ---

function raycast(p) {
  if (!fake.running) return { error: 'ar-not-running' };
  const camera = fake.camera.transform;
  if (p.alignment === 'vertical') return { ok: true, hits: [], camera }; // no walls in the fake scenes
  const [x, y] = screenToImage(isNum(p.x) ? p.x : 0.5, isNum(p.y) ? p.y : 0.5);
  const ray = fake.imageRay(x, y);
  const hits = [];
  if (p.allowing === 'existingPlaneGeometry' || p.allowing === 'existingPlaneInfinite') {
    for (const pl of fake.planes()) {
      const [w, l] = pl.extent || [0, 0];
      const o = [pl.transform[12], pl.transform[14]];
      const bounds =
        p.allowing === 'existingPlaneInfinite'
          ? [-1e6, 1e6, -1e6, 1e6]
          : Array.isArray(pl.boundary) && pl.boundary.length >= 3
            ? planeBounds(pl) // exact for the fake's planes; a box around a recorded, turned one
            : [o[0] - w / 2, o[0] + w / 2, o[1] - l / 2, o[1] + l / 2];
      const hit = castScene(ray, [{ y: pl.transform[13], bounds }]);
      if (hit) hits.push({ t: hit.t, point: hit.point, plane: pl.class });
    }
  } else {
    const hit = castScene(ray); // estimatedPlane: what the LiDAR sees, planes found or not
    if (hit) hits.push({ t: hit.t, point: hit.point });
  }
  hits.sort((a, b) => a.t - b.t);
  return {
    ok: true,
    hits: hits.slice(0, 6).map((h) => ({
      position: h.point.map((v) => round(v)),
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, ...h.point, 1],
      alignment: 'horizontal',
      ...(h.plane ? { plane: h.plane } : {}),
    })),
    camera,
  };
}

// --- the stand-in for the camera picture ---

let canvas = null;
let marker = null;
const NEAR_CLIP = 0.02;

function eyeToScreen(e) {
  const P = fake.projection;
  const cx = P[0] * e[0] + P[4] * e[1] + P[8] * e[2] + P[12];
  const cy = P[1] * e[0] + P[5] * e[1] + P[9] * e[2] + P[13];
  const cw = P[3] * e[0] + P[7] * e[1] + P[11] * e[2] + P[15];
  return [((cx / cw + 1) / 2) * fake.viewport[0], ((1 - cy / cw) / 2) * fake.viewport[1]];
}

/** World polygon → screen polygon, clipped at the near plane; null if nothing is left. */
function screenPolygon(points) {
  const eye = points.map((p) => transformPoint(fake.view, p));
  const out = [];
  for (let i = 0; i < eye.length; i++) {
    const a = eye[i];
    const b = eye[(i + 1) % eye.length];
    const ina = a[2] <= -NEAR_CLIP;
    const inb = b[2] <= -NEAR_CLIP;
    if (ina) out.push(a);
    if (ina !== inb) out.push(lerp(a, b, (-NEAR_CLIP - a[2]) / (b[2] - a[2])));
  }
  return out.length >= 3 ? out.map(eyeToScreen) : null;
}

function screenSegment(p, q) {
  let a = transformPoint(fake.view, p);
  let b = transformPoint(fake.view, q);
  const ina = a[2] <= -NEAR_CLIP;
  const inb = b[2] <= -NEAR_CLIP;
  if (!ina && !inb) return null;
  if (!ina) a = lerp(a, b, (-NEAR_CLIP - a[2]) / (b[2] - a[2]));
  if (!inb) b = lerp(b, a, (-NEAR_CLIP - b[2]) / (a[2] - b[2]));
  return [eyeToScreen(a), eyeToScreen(b)];
}

function fillPolygon(ctx, points, style) {
  const s = screenPolygon(points);
  if (!s) return;
  ctx.beginPath();
  ctx.moveTo(...s[0]);
  for (const p of s.slice(1)) ctx.lineTo(...p);
  ctx.closePath();
  ctx.fillStyle = style;
  ctx.fill();
}

function gridLines(ctx, y, [x0, x1, z0, z1], step, style, width = 1) {
  ctx.strokeStyle = style;
  ctx.lineWidth = width;
  ctx.beginPath();
  for (let x = Math.ceil(x0 / step) * step; x <= x1 + 1e-9; x += step) {
    const s = screenSegment([x, y, z0], [x, y, z1]);
    if (s) ctx.moveTo(...s[0]), ctx.lineTo(...s[1]);
  }
  for (let z = Math.ceil(z0 / step) * step; z <= z1 + 1e-9; z += step) {
    const s = screenSegment([x0, y, z], [x1, y, z]);
    if (s) ctx.moveTo(...s[0]), ctx.lineTo(...s[1]);
  }
  ctx.stroke();
}

const quad = (y, [x0, x1, z0, z1]) => [[x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1]];

function drawScene(ctx, w, h) {
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#59636d');
  sky.addColorStop(1, '#868a8e');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);
  const floor = [-20, 20, -30, 10];
  fillPolygon(ctx, quad(0, floor), '#6d5c4a');
  gridLines(ctx, 0, [-10, 10, -15, 5], 0.5, 'rgba(255, 255, 255, 0.16)');
  const table = scene().table;
  if (table) {
    const [cx, cz] = table.centre;
    const [tw, tl] = table.extent;
    const b = [cx - tw / 2, cx + tw / 2, cz - tl / 2, cz + tl / 2];
    // the front edge of the board first (it is below the top), then the top with a 5 cm / 10 cm grid
    fillPolygon(ctx, [[b[0], table.y, b[3]], [b[1], table.y, b[3]], [b[1], table.y - 0.03, b[3]], [b[0], table.y - 0.03, b[3]]], '#7d6a52');
    fillPolygon(ctx, quad(table.y, b), '#b9a78e');
    gridLines(ctx, table.y, b, 0.05, 'rgba(70, 50, 30, 0.22)');
    gridLines(ctx, table.y, b, 0.1, 'rgba(70, 50, 30, 0.45)', 1.5);
  }
}

// box corners: index bits = (+x, +y, +z); faces as corner lists with their outward normal
const FACES = [
  { n: [1, 0, 0], c: [1, 3, 7, 5] },
  { n: [-1, 0, 0], c: [0, 4, 6, 2] },
  { n: [0, 1, 0], c: [2, 6, 7, 3] },
  { n: [0, -1, 0], c: [0, 1, 5, 4] },
  { n: [0, 0, 1], c: [4, 5, 7, 6] },
  { n: [0, 0, -1], c: [0, 2, 3, 1] },
];
const EDGES = [];
for (let i = 0; i < 8; i++) for (const bit of [1, 2, 4]) if (!(i & bit)) EDGES.push([i, i | bit]);

function boxItems(g, b, eye, light) {
  const q = quatMul(g.rotation, b.rotation);
  const centre = add(g.position, quatRotate(g.rotation, b.position));
  const corners = [];
  for (let i = 0; i < 8; i++) {
    const local = [((i & 1 ? 1 : -1) * b.size[0]) / 2, ((i & 2 ? 1 : -1) * b.size[1]) / 2, ((i & 4 ? 1 : -1) * b.size[2]) / 2];
    corners.push(add(centre, quatRotate(q, local)));
  }
  const rgb = (f) => `rgb(${b.color.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255 * f)).join(', ')})`;
  if (b.style === 'edges') {
    const distance = length(sub(centre, eye));
    const pxPerMetre = (fake.projection[5] * fake.viewport[1]) / 2 / Math.max(distance, 0.05);
    return [
      {
        depth: distance,
        draw(ctx) {
          ctx.globalAlpha = b.opacity;
          ctx.strokeStyle = rgb(1);
          ctx.lineWidth = Math.max(1, b.edge * pxPerMetre);
          ctx.beginPath();
          for (const [i, j] of EDGES) {
            const s = screenSegment(corners[i], corners[j]);
            if (s) ctx.moveTo(...s[0]), ctx.lineTo(...s[1]);
          }
          ctx.stroke();
        },
      },
    ];
  }
  const items = [];
  for (const face of FACES) {
    const points = face.c.map((i) => corners[i]);
    const mid = mul(points.reduce(add, [0, 0, 0]), 0.25);
    const n = quatRotate(q, face.n);
    if (dot(n, sub(mid, eye)) >= 0) continue; // facing away
    const f = b.material === 'unlit' ? 1 : 0.5 + 0.5 * Math.max(0, -dot(n, light));
    items.push({
      depth: length(sub(mid, eye)),
      draw(ctx) {
        const s = screenPolygon(points);
        if (!s) return;
        ctx.globalAlpha = b.opacity;
        ctx.beginPath();
        ctx.moveTo(...s[0]);
        for (const p of s.slice(1)) ctx.lineTo(...p);
        ctx.closePath();
        ctx.fillStyle = rgb(f);
        ctx.fill();
      },
    });
  }
  return items;
}

const IDENTITY_GROUP = { position: [0, 0, 0], rotation: [0, 0, 0, 1] };

/** The simulated real hand as skin-coloured boxes (its 16 + the forearm), drawn as part of the picture. */
function drawRealHand(ctx, eye, light) {
  if (fake.replay || fake.hand.motion === 'none') return;
  const joints = simJoints(fake.now());
  if (!joints) return;
  const m = fake.hand.model;
  const pose = poseFromJoints(m, joints, fake.hand.side);
  const skin = (size, position, rotation) => ({ size, position, rotation, color: SKIN, opacity: 1, material: 'pbr', style: 'solid', visible: true });
  const boxes = poseBoxes(m, pose, { digits: null }).map((r) => skin([r[8], r[9], r[10]], [r[1], r[2], r[3]], [r[4], r[5], r[6], r[7]]));
  const q = pose.palm.rotation;
  boxes.push(skin([0.7 * m.palm.width, m.palm.thickness, 0.22], add(pose.palm.origin, quatRotate(q, [0, 0, -0.11])), q));
  const items = boxes.flatMap((b) => boxItems(IDENTITY_GROUP, b, eye, light));
  items.sort((a, b) => b.depth - a.depth);
  for (const it of items) it.draw(ctx);
  ctx.globalAlpha = 1;
}

/** A replay: a plain picture with the recorded planes' outlines and Vision's joints of the last event. */
function drawReplay(ctx, w, h) {
  ctx.fillStyle = '#4d555c';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.lineWidth = 1;
  for (const pl of fake.planes()) {
    if (!Array.isArray(pl.boundary) || pl.boundary.length < 3 || !isVec(pl.transform, 16)) continue;
    const s = screenPolygon(pl.boundary.map(([x, z]) => transformPoint(pl.transform, [x, 0, z])));
    if (!s) continue;
    ctx.beginPath();
    ctx.moveTo(...s[0]);
    for (const p of s.slice(1)) ctx.lineTo(...p);
    ctx.closePath();
    ctx.stroke();
  }
  const ev = fake.lastHands;
  if (!ev?.display) return;
  ctx.fillStyle = `rgb(${SKIN.map((v) => Math.round(v * 255)).join(', ')})`;
  for (const hand of ev.hands || []) {
    for (const j of hand.joints || []) {
      if (!(j[2] > 0.1)) continue;
      const [X, Y] = imageToView(ev.display, j[0], j[1]);
      ctx.beginPath();
      ctx.arc(X * w, Y * h, 5, 0, 2 * Math.PI);
      ctx.fill();
    }
  }
}

function draw() {
  if (!canvas) return;
  cameraTick();
  const [w, h] = fake.viewport;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = 1;
  const eye = [fake.camera.transform[12], fake.camera.transform[13], fake.camera.transform[14]];
  const light = normalize(fake.light?.on && isVec(fake.light.direction) ? fake.light.direction : [0.3, -1, -0.2]);
  if (fake.replay) drawReplay(ctx, w, h);
  else {
    drawScene(ctx, w, h);
    drawRealHand(ctx, eye, light); // part of the "camera picture": under every virtual box
  }
  const items = [];
  for (const g of fake.groups.values()) {
    if (!g.visible) continue;
    for (const b of g.boxes) if (b.visible && b.material !== 'occlusion') items.push(...boxItems(g, b, eye, light));
  }
  items.sort((a, b) => b.depth - a.depth); // painter: far first
  for (const it of items) it.draw(ctx);
  ctx.globalAlpha = 0.7;
  ctx.fillStyle = '#fff';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(fake.replay ? `回放 ${fake.replay.name}` : scene().label, w - 8, h - 8);
  ctx.globalAlpha = 1;
}
fake.draw = draw;

// --- the fake-only switch (right edge): which hand motion, which camera motion ---

let switchBox = null;

function updateSwitch() {
  if (!switchBox) return;
  for (const el of switchBox.querySelectorAll('[data-hand]')) el.style.cssText = chipStyle(!fake.replay && fake.hand.motion === el.dataset.hand);
  for (const el of switchBox.querySelectorAll('[data-cam]')) el.style.cssText = chipStyle(fake.cameraMotion === el.dataset.cam);
  const r = switchBox.querySelector('[data-replay]');
  if (r) r.textContent = fake.replay ? `回放 ${fake.replay.events.length} 帧` : '';
}

// spans, not buttons: the pages style every <button> as a big full-width one
const chipStyle = (on) =>
  `display: inline-block; padding: 3px 6px; margin: 1px; border-radius: 5px; cursor: pointer; border: 1px solid ${on ? '#ffb454' : '#888'}; background: ${on ? '#ffb454' : 'transparent'}; color: ${on ? '#000' : '#fff'};`;

function showSwitch(on) {
  if (on && !switchBox) {
    switchBox = document.createElement('div');
    switchBox.id = 'fake-switch';
    switchBox.style.cssText =
      'position: fixed; right: 3px; top: 26%; z-index: 2147483646; max-width: 112px; padding: 4px; border-radius: 7px; background: rgba(0, 0, 0, 0.6); color: #fff; font: 11px/1.3 system-ui, sans-serif; -webkit-user-select: none; user-select: none;';
    const row = (label, items) => {
      const d = document.createElement('div');
      d.style.cssText = 'margin-bottom: 3px;';
      d.append(Object.assign(document.createElement('div'), { textContent: label }));
      for (const it of items) d.append(it);
      return d;
    };
    const chip = (text, data, fn) => {
      const s = document.createElement('span');
      s.textContent = text;
      Object.assign(s.dataset, data);
      s.addEventListener('click', (e) => {
        e.stopPropagation();
        fn();
      });
      return s;
    };
    const hands = { flat: '平放', wave: '动', slide: '滑', none: '没有' };
    const replayLine = document.createElement('div');
    replayLine.dataset.replay = '';
    switchBox.append(
      row('假手', Object.entries(hands).map(([k, v]) => chip(v, { hand: k }, () => fake.setHand(k)))),
      row('假相机', [chip('不动', { cam: 'still' }, () => fake.setCameraMotion('still')), chip('远近', { cam: 'sweep' }, () => fake.setCameraMotion('sweep'))]),
      replayLine,
    );
    document.body.append(switchBox);
    updateSwitch();
  }
  if (switchBox) switchBox.style.display = on ? 'block' : 'none';
}

function showPicture(on) {
  if (on && !canvas) {
    canvas = document.createElement('canvas');
    canvas.id = 'fake-camera';
    canvas.style.cssText = 'position: fixed; left: 0; top: 0; width: 100vw; height: 100vh; z-index: -1; pointer-events: none;';
    document.body.prepend(canvas);
  }
  if (canvas) canvas.style.display = on ? 'block' : 'none';
  showSwitch(on && FEATURES.includes('hands'));
  clearInterval(fake.timers.draw);
  if (on) {
    draw();
    fake.timers.draw = setInterval(draw, 33);
  }
}

function buzz() {
  if (!marker) {
    marker = document.createElement('div');
    marker.id = 'fake-haptic';
    marker.textContent = '（震）';
    marker.style.cssText =
      'position: fixed; left: 50%; top: 40%; transform: translateX(-50%); z-index: 2147483647; pointer-events: none; padding: 4px 10px; border-radius: 8px; background: rgba(0,0,0,0.7); color: #ffb454; font: 600 18px system-ui, sans-serif;';
    document.body.append(marker);
  }
  marker.style.display = 'block';
  clearTimeout(marker.timer);
  marker.timer = setTimeout(() => (marker.style.display = 'none'), 300);
}

// --- messages ---

function state() {
  return {
    ok: true,
    running: fake.running,
    meshOcclusion: Boolean(fake.options.meshOcclusion),
    personOcclusion: fake.options.personOcclusion !== false,
    hasFurniture: fake.groups.has('furniture'),
    hands: { ...fake.handsConfig },
    ...(FEATURES.includes('erase')
      ? { erase: { ...fake.erase, frames: fake.erase.on ? Math.round((fake.now() - fake.startedAt) * 60) : 0, failures: 0, lastFailure: '', background: fake.erase.on && fake.erase.mask === 'alpha' ? 'clear' : 'camera', attached: fake.erase.on } }
      : {}),
  };
}

function applyOptions(p) {
  const { erase, ...rest } = p;
  Object.assign(fake.options, rest);
  if (p.hands && typeof p.hands === 'object') setHands(p.hands);
  if (erase && typeof erase === 'object') setErase(erase);
  restartStatus();
}

const handlers = {
  ping: (p) => ({ type: 'pong', echo: p, nativeTime: Date.now() }),
  status: () => ({ server: location.origin, startupLog: '电脑收到了', startupLogOK: true, logPending: 0, version: 'fake', buildTime: 'fake' }),
  openSettings: () => ({ ok: true }),
  'ar.start': (p) => {
    // as the app: a bad hands config fails the start before the camera or the session is touched
    const bad = (FEATURES.includes('hands') && p.hands !== undefined ? handsError(p.hands) : null) || eraseError(p.erase);
    if (bad) return { error: bad };
    fake.started = true;
    fake.running = true;
    fake.startedAt = fake.now();
    fake.options = {};
    if (p.reset !== false) fake.groups.clear();
    fake.planesFound = false;
    fake.planesSentAt = -1e9;
    fake.stats = { hands: [], latency: [] };
    updateCamera();
    applyOptions(p);
    restartHands();
    showPicture(true);
    return {
      ok: true,
      support: { sceneReconstruction: true, personSegmentationWithDepth: true, sceneDepth: true, smoothedSceneDepth: true },
      frameSemantics: ['personSegmentationWithDepth', 'sceneDepth'],
      skippedSemantics: [],
      sceneReconstruction: true,
      viewport: fake.viewport,
      ...(FEATURES.includes('hands') ? { vision: { handPose: true } } : {}),
    };
  },
  'ar.stop': () => {
    const wasRunning = fake.running;
    fake.running = false;
    for (const t of Object.values(fake.timers)) clearTimeout(t); // clears intervals too (one id space)
    if (FEATURES.includes('groups')) {
      // the stage-3 app removes every group and the light; pages re-create what they need after a start
      fake.groups.clear();
      fake.light = null;
    } else {
      fake.groups.delete('furniture'); // as the stage-2 app does
    }
    showPicture(false);
    return { ok: true, wasRunning };
  },
  'ar.setOptions': (p) => {
    if (!fake.started) return { error: 'ar-not-started' };
    const bad = (FEATURES.includes('hands') && p.hands !== undefined ? handsError(p.hands) : null) || eraseError(p.erase);
    if (bad) return { error: bad }; // the whole call is refused: nothing changes
    applyOptions(p);
    return state();
  },
  'ar.state': () => state(),
  'ar.raycast': raycast,
  'ar.capture': capture,
  // stage 2's furniture = the anchored group "furniture"
  'ar.setFurniture': (p) => {
    if (!Array.isArray(p.boxes) || !p.boxes.length) return { error: 'bad-boxes' };
    const r = setGroup({ id: 'furniture', boxes: p.boxes, position: p.position, yaw: isNum(p.yaw) ? p.yaw : 0, anchored: true, shadow: p.shadow !== false });
    return r.error ? r : { ok: true };
  },
  'ar.moveFurniture': (p) => {
    const g = fake.groups.get('furniture');
    if (!g) return { error: 'no-furniture' };
    if (!isVec(p.position)) return { error: 'bad-position' };
    applyPose(g, { position: p.position, yaw: isNum(p.yaw) ? p.yaw : 0 });
    return { ok: true };
  },
  'ar.clearFurniture': () => {
    fake.groups.delete('furniture');
    return { ok: true };
  },
  // stage 3
  'ar.hands': (p) => {
    const bad = handsError(p);
    return bad ? { error: bad } : { ok: true, config: { ...setHands(p) }, available: true };
  },
  'ar.setGroup': setGroup,
  'ar.updateGroups': updateGroups,
  'ar.moveGroup': moveGroup,
  'ar.removeGroup': (p) => {
    fake.groups.delete(p.id); // as the app: removing a group that is not there is fine
    return { ok: true };
  },
  'ar.clearGroups': () => {
    fake.groups.clear();
    return { ok: true };
  },
  'ar.groups': () => {
    const groups = {};
    for (const g of fake.groups.values()) groups[g.id] = { transform: groupTransform(g), anchored: g.anchored, count: g.boxes.length, visible: g.visible };
    return { ok: true, groups };
  },
  'ar.planes': () => ({ ok: true, planes: fake.planes() }),
  'ar.depth': depth,
  'ar.setLight': (p) => {
    // as the app: without `on` the light is on; on: false removes it
    if (p.on === false) {
      fake.light = null;
      return { ok: true };
    }
    fake.light = { on: true, direction: isVec(p.direction) ? p.direction : [0.3, -1, -0.2], intensity: isNum(p.intensity) ? p.intensity : 2000, shadow: p.shadow !== false, shadowDistance: isNum(p.shadowDistance) ? p.shadowDistance : 2, color: isVec(p.color) ? p.color : [1, 1, 1] };
    return { ok: true };
  },
  haptic: () => {
    buzz();
    return { ok: true };
  },
};

// which feature each stage-3 message needs (the stage-2 app does not know them at all)
const NEEDS = {
  'ar.hands': 'hands',
  'ar.setGroup': 'groups',
  'ar.updateGroups': 'groups',
  'ar.moveGroup': 'groups',
  'ar.removeGroup': 'groups',
  'ar.clearGroups': 'groups',
  'ar.groups': 'groups',
  'ar.planes': 'planes',
  'ar.depth': 'depth',
  'ar.setLight': 'light',
  haptic: 'haptic',
};

window.__nativeInfo = { version: 'fake', buildTime: 'fake', label: '版本 fake（电脑上的假原生层）', ios: '0', model: 'PC', features: FEATURES };
window.webkit = {
  messageHandlers: {
    native: {
      postMessage({ type, id, payload }) {
        fake.log.push({ type, payload });
        if (fake.log.length > 500) fake.log.splice(0, fake.log.length - 500);
        const handler = handlers[type];
        let out;
        if (!handler || (NEEDS[type] && !FEATURES.includes(NEEDS[type]))) out = { error: `unknown message type: ${type}` };
        else {
          try {
            out = handler(payload || {});
          } catch (e) {
            out = { error: `fake-native: ${e.message || e}` };
          }
        }
        if (id == null) return; // fire-and-forget (protocol §1): no reply
        setTimeout(() => window.__fromNative?.({ id, ...out }), type === 'ar.start' ? START_DELAY : 5);
      },
    },
  },
};
