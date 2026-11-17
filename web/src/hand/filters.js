// One Euro filter (Casiez et al. 2012): a low-pass whose cutoff rises with speed, so a still hand
// stops shaking while a moving hand does not lag much. Times in seconds; the units of the values
// are the caller's (the tracker filters metres, so `beta` is per m/s).
// The speed is the low-passed difference of the RAW samples (as in the authors' C++ version),
// not of the filtered output: the latter adds lag / dt to it, which would make `velocity` useless
// for prediction.
//
// API
//   new OneEuro({minCutoff = 1, beta = 0, dCutoff = 1})    scalar
//     filter(v, t) -> filtered v; velocity (per second); reset()
//   new OneEuro3({minCutoff = 1, beta = 0, dCutoff = 1})   [x, y, z]; the cutoff follows the
//     speed |v'| (one cutoff for all three axes, so a straight move is not bent)
//     filter(v, t) -> [3]; velocity -> [3] per second; reset(); setParams({minCutoff, beta, dCutoff})
// A repeated or older t returns the last output unchanged.

const alpha = (cutoff, dt) => {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
};

export class OneEuro {
  constructor({ minCutoff = 1, beta = 0, dCutoff = 1 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.reset();
  }

  reset() {
    this.x = null;
    this.raw = null;
    this.dx = 0;
    this.t = null;
    this.velocity = 0;
  }

  filter(v, t) {
    if (this.x === null) {
      this.x = v;
      this.raw = v;
      this.t = t;
      this.dx = 0;
      this.velocity = 0;
      return v;
    }
    const dt = t - this.t;
    if (!(dt > 0)) return this.x;
    this.dx += alpha(this.dCutoff, dt) * ((v - this.raw) / dt - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += alpha(cutoff, dt) * (v - this.x);
    this.raw = v;
    this.t = t;
    this.velocity = this.dx;
    return this.x;
  }
}

export class OneEuro3 {
  constructor({ minCutoff = 1, beta = 0, dCutoff = 1 } = {}) {
    this.setParams({ minCutoff, beta, dCutoff });
    this.reset();
  }

  setParams({ minCutoff = this.minCutoff, beta = this.beta, dCutoff = this.dCutoff } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }

  reset() {
    this.x = null;
    this.raw = null;
    this.dx = [0, 0, 0];
    this.t = null;
  }

  get velocity() {
    return [this.dx[0], this.dx[1], this.dx[2]];
  }

  filter(v, t) {
    if (this.x === null) {
      this.x = [v[0], v[1], v[2]];
      this.raw = [v[0], v[1], v[2]];
      this.t = t;
      this.dx = [0, 0, 0];
      return [v[0], v[1], v[2]];
    }
    const dt = t - this.t;
    if (!(dt > 0)) return [this.x[0], this.x[1], this.x[2]];
    const ad = alpha(this.dCutoff, dt);
    for (let k = 0; k < 3; k++) this.dx[k] += ad * ((v[k] - this.raw[k]) / dt - this.dx[k]);
    const speed = Math.hypot(this.dx[0], this.dx[1], this.dx[2]);
    const a = alpha(this.minCutoff + this.beta * speed, dt);
    for (let k = 0; k < 3; k++) {
      this.x[k] += a * (v[k] - this.x[k]);
      this.raw[k] = v[k];
    }
    this.t = t;
    return [this.x[0], this.x[1], this.x[2]];
  }
}
