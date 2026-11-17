// The hand model: the sizes of one person's hand, measured once by the scan (scan.js) and then
// used every frame to bind 16 boxes to the real hand (tracker.js, pose.js). Hand sizes are not
// blind and may be logged and shown.
//
// Metres. Palm space: origin = wrist joint, +Z towards the middle finger's MCP, +Y = the back of
// the hand, +X = Y x Z. So for a right hand the thumb is on +X, for a left hand on -X;
// `palmShape` is stored for the model's own chirality ('unknown' is treated as right).
//
// API
//   HandModel = {version: 1, source: 'scan' | 'default', chirality: 'left' | 'right' | 'unknown',
//     createdAt (ISO), palm: {width, length, thickness},
//     fingers: {thumb|index|middle|ring|little: {lengths: [3], width, thickness}},
//     handLength, palmShape: [[x, y, z] x 6] (PALM_JOINTS order, palm space), measured?: {...}}
//   finger lengths are joint centre to joint centre: thumb CMC->MP, MP->IP, IP->Tip; the others
//   MCP->PIP, PIP->DIP, DIP->Tip.
//   defaultModel(chirality = 'right')  a plausible adult hand
//   validModel(m) -> bool              structure and plausible ranges
//   cloneModel(m)
//   saveModel(m) / loadModel() -> m | null / clearModel()   localStorage 'arapp/hand-model/v1'
//                                      (no-ops in Node)
//   summaryCm(m) -> {palmWidth, palmLength, handLength, thickness,
//                    fingers: {thumb: [cm x3], ...}, fingerWidths: {...}, fingerThickness: {...}}
//                    (0.1 cm)
//   segmentSizes(m, shell = 1) -> [[w, h, d] x 16] box sizes (box i = SEGMENTS[i]); box space
//                    x = across, y = thickness (towards the back of the hand), z = along the bone;
//                    palm = [palm.width, palm.thickness, palm.length]; shell scales all three
//   sideSign(chirality, model?) -> +1 if the thumb is on palm +X for this chirality, else -1
//   palmShapeFor(model, chirality) -> palmShape mirrored (x -> -x) when the chirality differs
//                    from the model's
//   restDirection(model, finger, chirality) -> palm-space unit direction of a straight finger
//                    (index..little: +Z; thumb: from the wrist towards its CMC, flattened)

import { FINGERS, SEGMENTS } from './joints.js';

export const STORAGE_KEY = 'arapp/hand-model/v1';

const DEFAULT_PALM_SHAPE_RIGHT = [
  [0, 0, 0], // wrist
  [0.026, 0, 0.022], // thumbCMC
  [0.024, 0, 0.088], // indexMCP
  [0, 0, 0.094], // middleMCP
  [-0.02, 0, 0.088], // ringMCP
  [-0.038, 0, 0.077], // littleMCP
];

const DEFAULT_FINGERS = {
  thumb: { lengths: [0.042, 0.032, 0.028], width: 0.02, thickness: 0.018 },
  index: { lengths: [0.044, 0.025, 0.021], width: 0.018, thickness: 0.016 },
  middle: { lengths: [0.048, 0.029, 0.022], width: 0.018, thickness: 0.016 },
  ring: { lengths: [0.045, 0.028, 0.022], width: 0.017, thickness: 0.015 },
  little: { lengths: [0.035, 0.021, 0.02], width: 0.015, thickness: 0.014 },
};

/** Defaults the scan falls back to when a measurement is not usable. */
export const DEFAULT_SIZES = {
  palmThickness: 0.026,
  fingerThickness: 0.016,
  fingerWidth: { thumb: 0.02, index: 0.018, middle: 0.018, ring: 0.017, little: 0.015 },
};

export function sideSign(chirality, model = null) {
  const c = chirality === 'left' || chirality === 'right' ? chirality : model?.chirality === 'left' ? 'left' : 'right';
  return c === 'left' ? -1 : 1;
}

export function defaultModel(chirality = 'right') {
  const s = chirality === 'left' ? -1 : 1;
  const middle = DEFAULT_FINGERS.middle.lengths;
  return {
    version: 1,
    source: 'default',
    chirality: chirality === 'left' || chirality === 'right' ? chirality : 'unknown',
    createdAt: new Date().toISOString(),
    palm: { width: 0.082, length: 0.094, thickness: 0.026 },
    fingers: Object.fromEntries(FINGERS.map((f) => [f, { ...DEFAULT_FINGERS[f], lengths: [...DEFAULT_FINGERS[f].lengths] }])),
    handLength: 0.094 + middle[0] + middle[1] + middle[2],
    palmShape: DEFAULT_PALM_SHAPE_RIGHT.map(([x, y, z]) => [s * x, y, z]),
  };
}

export const cloneModel = (m) => JSON.parse(JSON.stringify(m));

const isNum = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

export function validModel(m) {
  if (!m || typeof m !== 'object' || m.version !== 1) return false;
  if (!['left', 'right', 'unknown'].includes(m.chirality)) return false;
  const p = m.palm;
  if (!p || !isNum(p.width, 0.04, 0.14) || !isNum(p.length, 0.05, 0.15) || !isNum(p.thickness, 0.008, 0.06)) return false;
  if (!m.fingers) return false;
  for (const f of FINGERS) {
    const g = m.fingers[f];
    if (!g || !Array.isArray(g.lengths) || g.lengths.length !== 3) return false;
    if (!g.lengths.every((l) => isNum(l, 0.008, 0.09))) return false;
    if (!isNum(g.width, 0.006, 0.035) || !isNum(g.thickness, 0.005, 0.035)) return false;
  }
  if (!isNum(m.handLength, 0.1, 0.3)) return false;
  if (!Array.isArray(m.palmShape) || m.palmShape.length !== 6) return false;
  if (!m.palmShape.every((q) => Array.isArray(q) && q.length === 3 && q.every((v) => isNum(v, -0.2, 0.2)))) return false;
  return true;
}

const hasStorage = () => {
  try {
    return typeof localStorage !== 'undefined' && localStorage !== null;
  } catch {
    return false; // some embedded views throw on access
  }
};

export function saveModel(m) {
  if (!hasStorage() || !validModel(m)) return false;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(m));
    return true;
  } catch {
    return false;
  }
}

export function loadModel() {
  if (!hasStorage()) return null;
  try {
    const m = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    return validModel(m) ? m : null;
  } catch {
    return null;
  }
}

export function clearModel() {
  if (!hasStorage()) return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // nothing to do
  }
}

const cm = (v) => Math.round(v * 1000) / 10;

export function summaryCm(m) {
  return {
    palmWidth: cm(m.palm.width),
    palmLength: cm(m.palm.length),
    handLength: cm(m.handLength),
    thickness: cm(m.palm.thickness),
    fingers: Object.fromEntries(FINGERS.map((f) => [f, m.fingers[f].lengths.map(cm)])),
    fingerWidths: Object.fromEntries(FINGERS.map((f) => [f, cm(m.fingers[f].width)])),
    fingerThickness: Object.fromEntries(FINGERS.map((f) => [f, cm(m.fingers[f].thickness)])),
  };
}

export function segmentSizes(m, shell = 1) {
  return SEGMENTS.map((seg, i) => {
    if (i === 0) return [m.palm.width * shell, m.palm.thickness * shell, m.palm.length * shell];
    const g = m.fingers[seg.finger];
    const k = (i - 1) % 3;
    return [g.width * shell, g.thickness * shell, g.lengths[k] * shell];
  });
}

export function palmShapeFor(model, chirality) {
  const own = sideSign(model.chirality);
  const want = sideSign(chirality, model);
  return own === want ? model.palmShape : model.palmShape.map(([x, y, z]) => [-x, y, z]);
}

export function restDirection(model, finger, chirality = model.chirality) {
  if (finger !== 'thumb') return [0, 0, 1];
  const c = palmShapeFor(model, chirality)[1];
  const l = Math.hypot(c[0], c[2]);
  return l > 1e-6 ? [c[0] / l, 0, c[2] / l] : [sideSign(chirality, model) * 0.7071, 0, 0.7071];
}
