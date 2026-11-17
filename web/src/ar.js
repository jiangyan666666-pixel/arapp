// The page's side of the native AR layer (ios/ARApp/ARController.swift). The native layer only
// shows the camera, the occlusion and the boxes it is told to draw; everything else – where the
// furniture goes, which way it faces, what is switched on – is decided here, so it can change
// without reinstalling the app.
//
// World space: metres, Y up, right-handed. Matrices are 16 numbers, column-major.
// The furniture's own space: origin at the bottom centre, front facing +Z.
// BLIND TEST: never log a width.

import { callNative, onNativeEvent } from './native.js';
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
};

/** Asks for camera permission the first time, so allow a long wait. */
export const start = (options = {}) => callNative('ar.start', { ...DEFAULTS, ...options }, 180000);
export const stop = () => callNative('ar.stop');
export const setOptions = (options) => callNative('ar.setOptions', options);
export const state = () => callNative('ar.state');
export const clearFurniture = () => callNative('ar.clearFurniture');
/** fn({tracking, mapping, camera, projection, view, planes, meshAnchors, hasDepth, person?, furniture?}) */
export const onStatus = (fn) => onNativeEvent('ar.status', fn);
export const onError = (fn) => onNativeEvent('ar.error', fn);
export const onInterrupted = (fn) => onNativeEvent('ar.interrupted', fn);

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
export async function captureToPC(options = {}, extra = {}) {
  const frame = await capture(options);
  const res = await fetch('/__capture', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...frame, ...extra, capturedAt: new Date().toISOString() }),
  });
  return res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
}

// --- small geometry helpers ---

export const cameraPosition = (m) => [m[12], m[13], m[14]];

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
