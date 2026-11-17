// Small geometry for the hand modules: vectors, quaternions, matrices, the camera of an
// 'ar.hands' event, planes and rigid fits. Pure functions on plain arrays, so the page and the
// Node tools run the same code. Conventions as in docs/protocol.md §0: metres, Y up,
// right-handed; vectors [x, y, z]; quaternions [x, y, z, w]; 4x4 matrices 16 numbers
// column-major (m[12..14] = translation); 3x3 matrices 9 numbers column-major.
//
// API
//   vectors      add(a,b) sub(a,b) scale(a,s) addScaled(a,b,s) (= a + b*s) neg(a) dot(a,b)
//                cross(a,b) len(a) norm(a) lerp(a,b,t) dist(a,b) centroid(points) angle(a,b)
//   matrices     mat4Point(m,p) mat4Dir(m,d) mat4Mul(a,b) mat4InvertRigid(m)
//                mat4FromQuatPos(q,p) quatFromMat4(m) mat3Vec(m3,v) mat3TVec(m3,v)
//   quaternions  quatFromBasis(x,y,z) (unit axes = the columns) quatFromMat3(m3) quatToMat3(q)
//                quatRotate(q,v) quatMul(a,b) quatConj(q) quatNorm(q) quatSlerp(a,b,t)
//                quatFromAxisAngle(axis,angle) quatFromRotVec(w) quatAngle(a,b) quatFromTo(a,b)
//   camera       cam = {transform[16], intrinsics[9], imageResolution[2]} (an event's `camera`)
//                unproject(cam, x, y, z) -> world point (x, y normalized image coords in the
//                  sensor's landscape orientation; z = depth along the viewing axis)
//                ray(cam, x, y) -> {o, d} (d unit, world)
//                project(cam, p) -> {x, y, z} (image coords; z = depth, > 0 in front)
//                camPosition(cam) camForward(cam) worldToCam(cam,p) camToWorld(cam,p)
//                camDirToWorld(cam,d) depthOf(cam,p) pixelScale(cam) -> [IW, IH]
//                imageToView(display, x, y) -> [X, Y] (0..1 of the viewport)
//                viewToImage(display, X, Y) -> [x, y]
//   planes       rayPlane(ray, plane) -> point | null (plane = {p, n}; only in front of o)
//                fitPlane(points) -> {p, n, rms} (n oriented towards +Y)
//   fits         fitRigid(src, dst, weights?) -> {q, t, rms}: dst ~ R(q) src + t (Horn)
//                eigSym(A, n) -> {values, vectors} (Jacobi; A row-major n*n, descending)
//                solveLinear(A, b) -> x | null (A row-major n*n, partial pivoting)
//   numbers      clamp(v,a,b) mean(a) median(a) quantile(a,q) iqr(a) std(a) round(v,digits)

// --- vectors ---

export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const addScaled = (a, b, s) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
export const neg = (a) => [-a[0], -a[1], -a[2]];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export function norm(a) {
  const l = len(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}
export const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export function centroid(points) {
  const c = [0, 0, 0];
  for (const p of points) {
    c[0] += p[0];
    c[1] += p[1];
    c[2] += p[2];
  }
  const n = Math.max(1, points.length);
  return [c[0] / n, c[1] / n, c[2] / n];
}
/** Angle between two vectors, radians (0..pi). */
export function angle(a, b) {
  const la = len(a);
  const lb = len(b);
  if (la < 1e-12 || lb < 1e-12) return 0;
  return Math.atan2(len(cross(a, b)), dot(a, b));
}

// --- matrices ---

export function mat4Point(m, p) {
  const [x, y, z] = p;
  return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
}
export function mat4Dir(m, d) {
  const [x, y, z] = d;
  return [m[0] * x + m[4] * y + m[8] * z, m[1] * x + m[5] * y + m[9] * z, m[2] * x + m[6] * y + m[10] * z];
}
export function mat4Mul(a, b) {
  const out = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}
/** Inverse of a rotation + translation matrix (transpose the rotation). */
export function mat4InvertRigid(m) {
  const t = [m[12], m[13], m[14]];
  const out = [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, 0, 0, 0, 1];
  out[12] = -(out[0] * t[0] + out[4] * t[1] + out[8] * t[2]);
  out[13] = -(out[1] * t[0] + out[5] * t[1] + out[9] * t[2]);
  out[14] = -(out[2] * t[0] + out[6] * t[1] + out[10] * t[2]);
  return out;
}
export function mat4FromQuatPos(q, p) {
  const r = quatToMat3(q);
  return [r[0], r[1], r[2], 0, r[3], r[4], r[5], 0, r[6], r[7], r[8], 0, p[0], p[1], p[2], 1];
}
export const quatFromMat4 = (m) => quatFromMat3([m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]]);
export const mat3Vec = (m, v) => [m[0] * v[0] + m[3] * v[1] + m[6] * v[2], m[1] * v[0] + m[4] * v[1] + m[7] * v[2], m[2] * v[0] + m[5] * v[1] + m[8] * v[2]];
export const mat3TVec = (m, v) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];

// --- quaternions ---

/** Rotation whose matrix columns are the (unit, orthogonal) axes x, y, z. */
export const quatFromBasis = (x, y, z) => quatFromMat3([x[0], x[1], x[2], y[0], y[1], y[2], z[0], z[1], z[2]]);

export function quatFromMat3(m) {
  // column-major: m[c*3 + r]
  const m00 = m[0], m10 = m[1], m20 = m[2], m01 = m[3], m11 = m[4], m21 = m[5], m02 = m[6], m12 = m[7], m22 = m[8];
  const tr = m00 + m11 + m22;
  let q;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s];
  }
  return quatNorm(q);
}

export function quatToMat3(q) {
  const [x, y, z, w] = q;
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  return [
    1 - 2 * (yy + zz), 2 * (xy + wz), 2 * (xz - wy),
    2 * (xy - wz), 1 - 2 * (xx + zz), 2 * (yz + wx),
    2 * (xz + wy), 2 * (yz - wx), 1 - 2 * (xx + yy),
  ];
}

export function quatRotate(q, v) {
  const [qx, qy, qz, qw] = q;
  const [vx, vy, vz] = v;
  // t = 2 * cross(q.xyz, v); v' = v + w t + cross(q.xyz, t)
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return [vx + qw * tx + (qy * tz - qz * ty), vy + qw * ty + (qz * tx - qx * tz), vz + qw * tz + (qx * ty - qy * tx)];
}

export function quatMul(a, b) {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}
export const quatConj = (q) => [-q[0], -q[1], -q[2], q[3]];
export function quatNorm(q) {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}
export function quatSlerp(a, b, t) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bb = b;
  if (d < 0) {
    d = -d;
    bb = [-b[0], -b[1], -b[2], -b[3]];
  }
  if (d > 0.9995) return quatNorm([a[0] + (bb[0] - a[0]) * t, a[1] + (bb[1] - a[1]) * t, a[2] + (bb[2] - a[2]) * t, a[3] + (bb[3] - a[3]) * t]);
  const th = Math.acos(Math.min(1, d));
  const s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s;
  const wb = Math.sin(t * th) / s;
  return [a[0] * wa + bb[0] * wb, a[1] * wa + bb[1] * wb, a[2] * wa + bb[2] * wb, a[3] * wa + bb[3] * wb];
}
export function quatFromAxisAngle(axis, a) {
  const n = norm(axis);
  const s = Math.sin(a / 2);
  return [n[0] * s, n[1] * s, n[2] * s, Math.cos(a / 2)];
}
/** Rotation vector (axis * angle) -> quaternion. */
export function quatFromRotVec(w) {
  const a = len(w);
  if (a < 1e-12) return quatNorm([w[0] / 2, w[1] / 2, w[2] / 2, 1]);
  return quatFromAxisAngle(w, a);
}
/** Angle of the rotation between two orientations, radians (0..pi). */
export function quatAngle(a, b) {
  const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return 2 * Math.acos(Math.min(1, d));
}
/** The smallest rotation taking direction a to direction b. */
export function quatFromTo(a, b) {
  const u = norm(a);
  const v = norm(b);
  const d = dot(u, v);
  if (d < -0.999999) {
    const ax = Math.abs(u[0]) < 0.9 ? cross(u, [1, 0, 0]) : cross(u, [0, 1, 0]);
    return quatFromAxisAngle(ax, Math.PI);
  }
  const c = cross(u, v);
  return quatNorm([c[0], c[1], c[2], 1 + d]);
}

// --- the camera of an 'ar.hands' event (docs/protocol.md §0) ---

export const pixelScale = (cam) => cam.imageResolution || [1920, 1440];
export const camPosition = (cam) => [cam.transform[12], cam.transform[13], cam.transform[14]];
/** The way the camera looks (-Z column). */
export const camForward = (cam) => [-cam.transform[8], -cam.transform[9], -cam.transform[10]];

export function unproject(cam, x, y, z) {
  const T = cam.transform;
  const K = cam.intrinsics;
  const R = cam.imageResolution || [1920, 1440];
  const lx = ((x * R[0] - K[6]) / K[0]) * z;
  const ly = (-(y * R[1] - K[7]) / K[4]) * z;
  const lz = -z;
  return [T[0] * lx + T[4] * ly + T[8] * lz + T[12], T[1] * lx + T[5] * ly + T[9] * lz + T[13], T[2] * lx + T[6] * ly + T[10] * lz + T[14]];
}

export function ray(cam, x, y) {
  const T = cam.transform;
  const K = cam.intrinsics;
  const R = cam.imageResolution || [1920, 1440];
  const lx = (x * R[0] - K[6]) / K[0];
  const ly = -(y * R[1] - K[7]) / K[4];
  const d = norm([T[0] * lx + T[4] * ly - T[8], T[1] * lx + T[5] * ly - T[9], T[2] * lx + T[6] * ly - T[10]]);
  return { o: [T[12], T[13], T[14]], d };
}

/** World point -> camera space (x = sensor right, y = sensor up, looking along -z). */
export function worldToCam(cam, p) {
  const T = cam.transform;
  const dx = p[0] - T[12];
  const dy = p[1] - T[13];
  const dz = p[2] - T[14];
  return [T[0] * dx + T[1] * dy + T[2] * dz, T[4] * dx + T[5] * dy + T[6] * dz, T[8] * dx + T[9] * dy + T[10] * dz];
}
export const camToWorld = (cam, p) => mat4Point(cam.transform, p);
export const camDirToWorld = (cam, d) => mat4Dir(cam.transform, d);
/** Depth of a world point along the viewing axis (> 0 in front). */
export function depthOf(cam, p) {
  const T = cam.transform;
  return -(T[8] * (p[0] - T[12]) + T[9] * (p[1] - T[13]) + T[10] * (p[2] - T[14]));
}

export function project(cam, p) {
  const K = cam.intrinsics;
  const R = cam.imageResolution || [1920, 1440];
  const l = worldToCam(cam, p);
  const z = -l[2];
  const px = K[6] + (K[0] * l[0]) / z;
  const py = K[7] - (K[4] * l[1]) / z;
  return { x: px / R[0], y: py / R[1], z };
}

/** Image (x, y) -> view (0..1 of the viewport) with an 'ar.status' / 'ar.hands' `display`. */
export const imageToView = (D, x, y) => [D[0] * x + D[2] * y + D[4], D[1] * x + D[3] * y + D[5]];
export function viewToImage(D, X, Y) {
  const det = D[0] * D[3] - D[1] * D[2];
  const u = X - D[4];
  const v = Y - D[5];
  return [(D[3] * u - D[2] * v) / det, (-D[1] * u + D[0] * v) / det];
}

// --- planes ---

export function rayPlane(r, plane) {
  const den = dot(r.d, plane.n);
  if (Math.abs(den) < 1e-9) return null;
  const t = dot(sub(plane.p, r.o), plane.n) / den;
  if (t < 0) return null;
  return addScaled(r.o, r.d, t);
}

export function fitPlane(points) {
  const c = centroid(points);
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (const p of points) {
    const x = p[0] - c[0], y = p[1] - c[1], z = p[2] - c[2];
    xx += x * x; xy += x * y; xz += x * z; yy += y * y; yz += y * z; zz += z * z;
  }
  const { vectors } = eigSym([xx, xy, xz, xy, yy, yz, xz, yz, zz], 3);
  let n = norm(vectors[2]);
  if (n[1] < 0) n = neg(n);
  let s = 0;
  for (const p of points) {
    const d = (p[0] - c[0]) * n[0] + (p[1] - c[1]) * n[1] + (p[2] - c[2]) * n[2];
    s += d * d;
  }
  return { p: c, n, rms: Math.sqrt(s / Math.max(1, points.length)) };
}

// --- fits ---

/** Symmetric eigen-decomposition (cyclic Jacobi). Eigenvectors sorted by descending value. */
export function eigSym(A, n) {
  const a = A.slice();
  const v = new Array(n * n).fill(0);
  for (let i = 0; i < n; i++) v[i * n + i] = 1;
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p * n + q] * a[p * n + q];
    if (off < 1e-30) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p * n + q];
        if (Math.abs(apq) < 1e-300) continue;
        const th = (a[q * n + q] - a[p * n + p]) / (2 * apq);
        const t = (th >= 0 ? 1 : -1) / (Math.abs(th) + Math.sqrt(th * th + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k * n + p], akq = a[k * n + q];
          a[k * n + p] = c * akp - s * akq;
          a[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p * n + k], aqk = a[q * n + k];
          a[p * n + k] = c * apk - s * aqk;
          a[q * n + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k * n + p], vkq = v[k * n + q];
          v[k * n + p] = c * vkp - s * vkq;
          v[k * n + q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const order = [...Array(n).keys()].sort((i, j) => a[j * n + j] - a[i * n + i]);
  return { values: order.map((i) => a[i * n + i]), vectors: order.map((i) => [...Array(n).keys()].map((k) => v[k * n + i])) };
}

/**
 * The rotation + translation that best maps the points `src` onto `dst` (least squares; Horn's
 * quaternion method, so it never returns a reflection).
 */
export function fitRigid(src, dst, weights = null) {
  const n = src.length;
  let W = 0;
  const cs = [0, 0, 0];
  const cd = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const w = weights ? weights[i] : 1;
    W += w;
    for (let k = 0; k < 3; k++) {
      cs[k] += w * src[i][k];
      cd[k] += w * dst[i][k];
    }
  }
  for (let k = 0; k < 3; k++) {
    cs[k] /= W;
    cd[k] /= W;
  }
  const S = new Array(9).fill(0); // S[a*3+b] = sum w * s_a * d_b
  for (let i = 0; i < n; i++) {
    const w = weights ? weights[i] : 1;
    const s = sub(src[i], cs);
    const d = sub(dst[i], cd);
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) S[a * 3 + b] += w * s[a] * d[b];
  }
  const [Sxx, Sxy, Sxz, Syx, Syy, Syz, Szx, Szy, Szz] = S;
  const N = [
    Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx,
    Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz,
    Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy,
    Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz,
  ];
  const e = eigSym(N, 4).vectors[0]; // (w, x, y, z)
  const q = quatNorm([e[1], e[2], e[3], e[0]]);
  const t = sub(cd, quatRotate(q, cs));
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const r = sub(add(quatRotate(q, src[i]), t), dst[i]);
    s2 += (weights ? weights[i] : 1) * dot(r, r);
  }
  return { q, t, rms: Math.sqrt(s2 / W) };
}

/** Solves A x = b (A row-major n*n). Null if singular. */
export function solveLinear(A, b) {
  const n = b.length;
  const M = A.slice();
  const x = b.slice();
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r * n + c]) > Math.abs(M[p * n + c])) p = r;
    if (Math.abs(M[p * n + c]) < 1e-14) return null;
    if (p !== c) {
      for (let k = 0; k < n; k++) [M[c * n + k], M[p * n + k]] = [M[p * n + k], M[c * n + k]];
      [x[c], x[p]] = [x[p], x[c]];
    }
    for (let r = c + 1; r < n; r++) {
      const f = M[r * n + c] / M[c * n + c];
      if (f === 0) continue;
      for (let k = c; k < n; k++) M[r * n + k] -= f * M[c * n + k];
      x[r] -= f * x[c];
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = x[r];
    for (let k = r + 1; k < n; k++) s -= M[r * n + k] * x[k];
    x[r] = s / M[r * n + r];
  }
  return x;
}

// --- numbers ---

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
export function quantile(a, q) {
  if (!a.length) return NaN;
  const s = Float64Array.from(a).sort();
  const i = clamp(q, 0, 1) * (s.length - 1);
  const lo = Math.floor(i);
  const hi = Math.min(s.length - 1, lo + 1);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}
export const median = (a) => quantile(a, 0.5);
export const iqr = (a) => quantile(a, 0.75) - quantile(a, 0.25);
export function std(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / (a.length - 1));
}
export function round(v, digits = 5) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
