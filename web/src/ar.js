// The page's side of the native AR layer (ios/ARApp/ARController.swift). The native layer only
// shows the camera, the occlusion and the boxes it is told to draw; everything else – where the
// furniture goes, which way it faces, what is switched on, the hand model – is decided here, so
// it can change without reinstalling the app. docs/protocol.md is the contract; this file is a
// thin wrapper around it, one function per message.
//
// World space: metres, Y up, right-handed. Matrices are 16 numbers, column-major.
// The furniture's own space: origin at the bottom centre, front facing +Z.
// BLIND TEST: never log a width.
//
// Stage 2 (every app with the 'ar' feature):
//   start(options) stop() setOptions(options) state()              session (§2)
//   onStatus(fn) onError(fn) onInterrupted(fn)                      events (§3)
//   raycast(x, y, allowing, alignment) raycastFloor(x, y)           screen point → world
//   setFurniture(modelId, width, position, yaw, {shadow}) moveFurniture(position, yaw) clearFurniture()
//   capture(options) captureToPC(options, extra)                    one frame of everything
// Stage 3 – check hasFeature(name) from native.js first; the stage-2 app answers these with an error:
//   hands(config) onHands(fn)                                       'hands'   Vision hand pose (§4)
//   setGroup(id, boxes, opts) updateGroups(groups, frameT)          'groups'  boxes the page draws (§5)
//   moveGroup(id, {dx, dy, dz, dyaw}) removeGroup(id) clearGroups() groups()
//   planes() onPlanes(fn)                                           'planes'  detected planes (§6)
//   depth(opts)                                                     'depth'   a piece of the LiDAR map (§7)
//   setLight(opts)                                                  'light'   one directional light (§8)
//   haptic(opts)                                                    'haptic'  works without AR, never rejects (§9)
//   setOptions({erase: {on, mask, dilate, feather, …, probe}}) onErase(fn)   'erase'  the person
//                                    (the real hand) erased from the camera picture (§2); an app
//                                    without the feature ignores the key
// updateGroups() is fire-and-forget (no reply, no promise), because it is sent every frame.
// In the stage-3 app the stage-2 furniture is the group "furniture" (anchored): moveGroup('furniture', …)
// nudges it relative to where ARKit has put it by now.

import { callNative, hasFeature, onNativeEvent, postNative } from './native.js';
import { MODELS, furnitureBoxesForNative } from './furniture-spec.js';

export const DEFAULTS = {
  // what ARKit computes (fixed for a run of the session)
  personSegmentationWithDepth: true, // needed for the hand to hide the furniture
  sceneDepth: true, // LiDAR depth image, for "capture a frame"
  smoothedSceneDepth: false,
  sceneReconstruction: true, // LiDAR mesh, needed for real objects to hide the furniture
  horizontalPlanes: true,
  verticalPlanes: true,
  reset: true,
  // what is drawn (can change any time with setOptions)
  personOcclusion: true, // the hand hides the furniture behind it
  meshOcclusion: true, // real objects (LiDAR mesh) hide the furniture behind them – a feature of the tool (decided 2026-11-17)
  disable: ['motionBlur', 'depthOfField'], // keep the furniture's edges sharp
  debug: [],
  statusHz: 4,
  followAnchor: true,
  // stage 3 (the stage-2 app ignores options it does not know)
  meshReceivesLighting: false, // virtual lights leave the LiDAR mesh alone: no virtual shadows on real things
  planeEvents: true, // send "ar.planes" whenever the detected planes change (onPlanes)
  planesHz: 2, // … at most this often
};

/** Asks for camera permission the first time, so allow a long wait. */
export const start = (options = {}) => callNative('ar.start', { ...DEFAULTS, ...options }, 180000);
export const stop = () => callNative('ar.stop');
export const setOptions = (options) => callNative('ar.setOptions', options);
export const state = () => callNative('ar.state');
export const clearFurniture = () => callNative('ar.clearFurniture');
/**
 * fn({t, tracking, mapping, camera, projection, view, planes, meshAnchors, hasDepth, person?, furniture?,
 *     stage 3: now, viewport, display, fps, thermal, hands: {on, rate, visionMs, hands},
 *              latency: {n, mean, p50, p90, max} (ms), groups: {id: {transform, anchorUpdates, anchorShift}}})
 */
export const onStatus = (fn) => onNativeEvent('ar.status', fn);
export const onError = (fn) => onNativeEvent('ar.error', fn);
export const onInterrupted = (fn) => onNativeEvent('ar.interrupted', fn);
/** fn({probe: {source, depth, target (formats), alpha, depth, background, srcLinear, dstLinear, config, …}}) */
export const onErase = (fn) => onNativeEvent('ar.erase', fn);

/** x, y: 0..1 of the screen (left→right, top→bottom). */
export const raycast = (x, y, allowing = 'estimatedPlane', alignment = 'horizontal') =>
  callNative('ar.raycast', { x, y, allowing, alignment });

/**
 * The floor point under a tap: a detected plane if there is one there, otherwise ARKit's
 * estimate from the LiDAR depth, otherwise a detected plane extended beyond its edges.
 * @returns {Promise<null | {position: number[], how: string, plane?: string, camera?: number[]}>}
 */
export async function raycastFloor(x, y) {
  for (const allowing of ['existingPlaneGeometry', 'estimatedPlane', 'existingPlaneInfinite']) {
    const r = await raycast(x, y, allowing, 'horizontal');
    const hit = r.hits?.[0];
    if (hit) return { position: hit.position, how: allowing, plane: hit.plane, camera: r.camera };
  }
  return null;
}

/** Draws the model at this outer width (metres), bottom centre at `position`, turned by `yaw`. */
export function setFurniture(modelId, width, position, yaw, { shadow = true } = {}) {
  return callNative('ar.setFurniture', { boxes: furnitureBoxesForNative(modelId, width), position, yaw, shadow });
}

export const moveFurniture = (position, yaw) => callNative('ar.moveFurniture', { position, yaw });

/** One frame of LiDAR depth, camera pose, picture (and optionally the mesh) – several MB. */
export const capture = (options = {}) => callNative('ar.capture', options, 30000);

/**
 * Captures a frame and sends it to the PC (vite.config.js → notes/captures/<time>/).
 * @returns {Promise<{ok: boolean, dir?: string, summary?: object, error?: string}>}
 */
export async function captureToPC(options = {}, extra = {}, { timeoutMs = 30000 } = {}) {
  const frame = await capture(options);
  // the upload (several MB) gets its own time limit: a PC that is gone would otherwise leave it
  // hanging for minutes
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : 0;
  try {
    const res = await fetch('/__capture', {
      method: 'POST',
      signal: ctl?.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...frame, ...extra, capturedAt: new Date().toISOString() }),
    });
    return await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  } catch (e) {
    return { ok: false, error: e?.name === 'AbortError' ? `电脑 ${Math.round(timeoutMs / 1000)} 秒没回应` : String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

// --- stage 3: hands, groups of boxes, planes, depth, light, haptics (docs/protocol.md §4–§9) ---

/**
 * Configure Vision hand tracking; keys left out stay as they are.
 * @param {{on?: boolean, hz?: number, maxHands?: number, orientation?: string, pointTransform?: number[],
 *          window?: number, minJointConfidence?: number, patchEvery?: number, patchMargin?: number,
 *          patchStep?: number, patchMax?: number}} config
 * @returns {Promise<{ok: boolean, config: object, available: boolean}>}
 */
export const hands = (config = {}) => callNative('ar.hands', config);
/** fn({seq, t, tv0, tv1, tSent, camera, display, viewport, depthSize, window, hands: [{chirality, confidence, joints}], patches?}) */
export const onHands = (fn) => onNativeEvent('ar.hands', fn);

/**
 * Create or replace a group of boxes.
 * @param {string} id
 * @param {object[]} boxes  [{size, position, rotation?, color?, opacity?, material?, roughness?, metallic?, style?, edge?, visible?}]
 * @param {{position?: number[], rotation?: number[], yaw?: number, anchored?: boolean, shadow?: boolean, visible?: boolean}} [opts]
 * @returns {Promise<{ok: boolean, count: number}>}
 */
export const setGroup = (id, boxes, opts = {}) => callNative('ar.setGroup', { ...opts, id, boxes });

/**
 * Move groups and their boxes – fire-and-forget, for every frame. frameT = the native time of the
 * camera frame the poses were worked out from (an "ar.hands" event's t); ar.status.latency then
 * says how long it took from that frame to the boxes being moved.
 * @param {{id: string, position?: number[], rotation?: number[], yaw?: number, visible?: boolean, boxes?: Array}[]} groups
 * @param {number} [frameT]
 * @returns {boolean} whether it was handed to the native layer
 */
export function updateGroups(groups, frameT) {
  return postNative('ar.updateGroups', frameT == null ? { groups } : { groups, frameT });
}

/**
 * Nudge a group from where it is now – after ARKit's corrections, if it is anchored – so a
 * correction is not undone: dx, dy, dz along the group's own axes, then turn by dyaw about world Y.
 * @returns {Promise<{ok: boolean, transform: number[]}>} the group's pose afterwards
 */
export const moveGroup = (id, { dx = 0, dy = 0, dz = 0, dyaw = 0 } = {}) => callNative('ar.moveGroup', { id, dx, dy, dz, dyaw });
export const removeGroup = (id) => callNative('ar.removeGroup', { id });
export const clearGroups = () => callNative('ar.clearGroups');
/** @returns {Promise<{ok: boolean, groups: Object<string, {transform: number[], anchored: boolean, count: number, visible: boolean}>}>} */
export const groups = () => callNative('ar.groups');

/** @returns {Promise<{ok: boolean, planes: {id, alignment, class, transform, center, extent, rotationOnYAxis, boundary}[]}>} */
export const planes = () => callNative('ar.planes');
/** fn({planes}) – the full list, whenever it changes (if planeEvents is on). */
export const onPlanes = (fn) => onNativeEvent('ar.planes', fn);

/**
 * A piece of the LiDAR depth map; rect in image coordinates (sensor landscape, 0..1).
 * @param {{rect?: number[], step?: number, personDepth?: boolean}} [opts]
 * @returns {Promise<{ok, t, camera, display, viewport, depthSize, rect, step, w, h, depth: string, info: string, personDepth?: string}>}
 */
export const depth = (opts = {}) => callNative('ar.depth', opts, 10000);

/** @param {{on: boolean, direction?: number[], intensity?: number, shadow?: boolean, shadowDistance?: number, color?: number[]}} opts */
export const setLight = (opts) => callNative('ar.setLight', opts);

/**
 * A tap of the phone's vibration motor; works without AR. It is only feedback, so it never
 * rejects: an app without haptics, or a plain browser, gets {ok: false, error} back.
 * @param {{kind?: 'impact'|'selection'|'success'|'warning'|'error', style?: 'light'|'medium'|'heavy'|'soft'|'rigid', intensity?: number}} [opts]
 */
export function haptic(opts = {}) {
  if (!hasFeature('haptic')) return Promise.resolve({ ok: false, error: 'no-haptic' });
  return callNative('haptic', opts).catch((e) => ({ ok: false, error: String(e.message || e) }));
}

// --- small geometry helpers ---

export const cameraPosition = (m) => [m[12], m[13], m[14]];

/**
 * The turn about world Y of a pose matrix (the angle its +Z axis makes with world +Z, seen from
 * above) – the inverse of what setFurniture's yaw does. Any small tilt ARKit adds is ignored.
 */
export const yawOf = (m) => Math.atan2(m[8], m[10]);

/** The yaw that turns the furniture's front (+Z) from `from` towards `to`, ignoring height. */
export const yawToFace = (from, to) => Math.atan2(to[0] - from[0], to[2] - from[2]);

/** Move by (dx, dz) metres along the furniture's own right / front axes. */
export function nudged(position, yaw, dx, dz) {
  const s = Math.sin(yaw);
  const c = Math.cos(yaw);
  return [position[0] + dx * c + dz * s, position[1], position[2] - dx * s + dz * c];
}

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function transformPoint(m, p) {
  const [x, y, z] = p;
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
    m[3] * x + m[7] * y + m[11] * z + m[15],
  ];
}

/**
 * How the furniture sits in the picture right now, from an "ar.status" event:
 * how far the camera is from the furniture's centre, and how many of its 8 corners are on screen.
 * @param {object} status   an ar.status event
 * @param {{position: number[], yaw: number, width: number, modelId: string}} placed
 */
export function furnitureInView(status, placed) {
  if (!status?.camera || !status.view || !status.projection || !placed) return null;
  const model = MODELS.find((m) => m.id === placed.modelId);
  const { width: w } = placed;
  const { height: h, depth: d } = model;
  const centre = [placed.position[0], placed.position[1] + h / 2, placed.position[2]];
  let onScreen = 0;
  for (const sx of [-1, 1]) {
    for (const y of [0, h]) {
      for (const sz of [-1, 1]) {
        const base = nudged(placed.position, placed.yaw, (sx * w) / 2, (sz * d) / 2);
        const eye = transformPoint(status.view, [base[0], base[1] + y, base[2]]);
        const clip = transformPoint(status.projection, eye.slice(0, 3));
        if (clip[3] <= 0) continue; // behind the camera
        const nx = clip[0] / clip[3];
        const ny = clip[1] / clip[3];
        if (Math.abs(nx) <= 1 && Math.abs(ny) <= 1) onScreen++;
      }
    }
  }
  return {
    distance_m: Math.round(distance(cameraPosition(status.camera), centre) * 100) / 100,
    cornersOnScreen: onScreen,
  };
}
