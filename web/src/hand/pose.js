// A hand pose = the 21 joint centres in world space plus the palm's frame, and the 16 boxes of
// the hand model placed on it. The boxes are what the native layer draws (ar.updateGroups) and,
// from stage 4 on, what the physics world collides with — so box sizes come from the model and
// stay fixed; only their poses follow the hand.
//
// API
//   HandPose = {t, chirality, joints: [[x, y, z] x 21] (world, joint centres),
//     palm: {origin (= the wrist joint), rotation (quaternion, palm space -> world),
//            x, y, z (world unit axes; y = back of the hand)},
//     quality: {...} (filled in by the tracker)}
//   poseFromJoints(model, joints, chirality, t = 0) -> HandPose
//     palm axes from the joints: z = wrist -> middleMCP; x towards the thumb side (right hand) or
//     away from it (left hand), from littleMCP -> indexMCP; y = z x x = the back of the hand.
//     chirality 'unknown' -> the model's chirality (or right).
//   poseBoxes(model, pose, {shell = 1, digits = 5} = {})
//     -> [[i, px, py, pz, qx, qy, qz, qw, sx, sy, sz] x 16]  rows for ar.updateGroups (box i =
//     SEGMENTS[i]; the rotation maps box space -> world; box space x = across, y = towards the
//     back of the hand, z = along the bone, from joint `from` to joint `to`). The palm box spans
//     palm z 0..palm.length and is centred across between indexMCP and littleMCP.
//     digits = null keeps full precision.
//   palmBoxCentre(model, chirality) -> palm-space centre of the palm box
//   resolveChirality(chirality, model) -> 'left' | 'right'

import { SEGMENTS } from './joints.js';
import { add, sub, scale, dot, cross, norm, len, lerp, quatFromBasis, quatRotate, round } from './geom.js';
import { segmentSizes, palmShapeFor, sideSign } from './model.js';

export function resolveChirality(chirality, model) {
  if (chirality === 'left' || chirality === 'right') return chirality;
  return model?.chirality === 'left' ? 'left' : 'right';
}

export function poseFromJoints(model, joints, chirality, t = 0) {
  const chir = resolveChirality(chirality, model);
  const s = sideSign(chir);
  const w = joints[0];
  let z = norm(sub(joints[9], w));
  if (len(z) < 0.5) z = norm(sub(joints[13], w));
  // across the knuckles; fall back to other MCP pairs if the hand is seen edge-on
  let y = [0, 0, 0];
  for (const [a, b] of [[5, 17], [5, 13], [9, 17], [1, 17]]) {
    y = cross(z, scale(sub(joints[a], joints[b]), s));
    if (len(y) > 1e-6) break;
  }
  y = norm(y);
  if (len(y) < 0.5) y = norm(cross(z, Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1]));
  const x = cross(y, z);
  return {
    t,
    chirality: chir,
    joints: joints.map((p) => [p[0], p[1], p[2]]),
    palm: { origin: [w[0], w[1], w[2]], rotation: quatFromBasis(x, y, z), x, y, z },
    quality: {},
  };
}

export function palmBoxCentre(model, chirality) {
  const shape = palmShapeFor(model, resolveChirality(chirality, model));
  return [(shape[2][0] + shape[5][0]) / 2, 0, model.palm.length / 2];
}

/** The box frame of a bone from a to b: z along the bone, x as close to the palm's x as possible. */
function boneBasis(a, b, palm) {
  let z = norm(sub(b, a));
  if (len(z) < 0.5) z = palm.z;
  const px = dot(palm.x, z);
  let x;
  let y;
  if (Math.abs(px) < 0.85) {
    x = norm(sub(palm.x, scale(z, px)));
    y = cross(z, x);
  } else {
    // the bone points along the palm's x (a thumb spread far out): keep y towards the back instead
    y = norm(sub(palm.y, scale(z, dot(palm.y, z))));
    x = cross(y, z);
  }
  return quatFromBasis(x, y, z);
}

export function poseBoxes(model, pose, { shell = 1, digits = 5 } = {}) {
  const sizes = segmentSizes(model, shell);
  const r = digits == null ? (v) => v : (v) => round(v, digits);
  const rows = [];
  const c = add(pose.palm.origin, quatRotate(pose.palm.rotation, palmBoxCentre(model, pose.chirality)));
  const q0 = pose.palm.rotation;
  rows.push([0, r(c[0]), r(c[1]), r(c[2]), r(q0[0]), r(q0[1]), r(q0[2]), r(q0[3]), r(sizes[0][0]), r(sizes[0][1]), r(sizes[0][2])]);
  for (let i = 1; i < SEGMENTS.length; i++) {
    const { from, to } = SEGMENTS[i];
    const a = pose.joints[from];
    const b = pose.joints[to];
    const m = lerp(a, b, 0.5);
    const q = boneBasis(a, b, pose.palm);
    const sz = sizes[i];
    rows.push([i, r(m[0]), r(m[1]), r(m[2]), r(q[0]), r(q[1]), r(q[2]), r(q[3]), r(sz[0]), r(sz[1]), r(sz[2])]);
  }
  return rows;
}
