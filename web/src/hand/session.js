// Hand tracking for a page: turns the native layer's Vision hand pose on, runs every 'ar.hands'
// event through the tracker (tracker.js), hands the pose to a view (view.js) and keeps the numbers
// a page shows about it (event rate, Vision time, latency, how often a hand is seen). Also the
// one-time hand scan (scan.js). Pure logic on top of the ar.js module, so the stage-3 check page
// and the stage-4 desk page share it. Hand sizes are not blind and may be logged.
//
// API
//   new HandSession({ar, model, trackerOptions = {}, view = null, onPose = null, onFrame = null,
//                    config = {}})
//     ar              the ar.js module (hands, onHands, onStatus, onPlanes, planes)
//     model           a HandModel (model.js)
//     trackerOptions  HandTracker options (tracker.js); predict: 'auto' | seconds (below)
//     view            a HandView, or anything with show(pose, frameT, frame), hide(frame), setPlanes(list)
//     onPose(pose | null, frame)               after every event
//     onFrame(frame, pose | null, extra)       after every event; extra = {poses, scan, webMs}
//                                              poses = {fused, lidar, size} in compare mode, else null
//     config          the ar.hands config start() sends (HANDS_CONFIG below fills the rest)
//   start() -> Promise<{ok, config, available}>  listen, then ar.hands({on: true, ...config})
//   stop() -> Promise                           ar.hands({on: false}); stop listening
//   running
//   setModel(m)            every tracker gets the new model (and starts over)
//   setOptions(o)          tracker options; o.predict = 'auto' -> latency p50 + one display frame,
//                          clamped 0..0.1 s, updated from every ar.status; a number = seconds
//   setCompare(on)         also run one tracker per method ('fused', 'lidar', 'size'; never
//                          predicting), for pages that compare them -> extra.poses, recent(method)
//   startScan({durationS, minFrames, timeoutS = 0, onProgress}) -> Promise<
//       {ok: true, model, measurements} | {ok: false, reason: 'stopped' | 'failed' | 'timeout', status}>
//                          turns on a depth patch with every event while it runs (patchEvery 1,
//                          patchStep 1, patchMax 20000, hz 15) and feeds a HandScanner with the frames and
//                          the latest ar.planes; ends by itself, then patchEvery 0
//   stopScan()             ends a scan early
//   scanning, scanStatus   the scanner's last {state, progress, hint, issues}
//   window() -> {peek(), stop()} counts events from now on; both return WindowStats =
//       {seconds, events, rate, handShare, poseShare, meanHands, chirality: {left, right, unknown},
//        meanConfidence (Vision's per-hand confidence, mean over the hands seen), visionMs}
//   recent(method = 'main', seconds = 0.3) -> [HandPose] whose frame time is within the last
//                          `seconds` (native clock) of the newest frame; 'main' = the shown pose,
//                          a method name = its compare tracker (compare mode only)
//   stats() -> {running, rate, gaps, handShare, poseShare, chirality, visionMs: {mean, max} | null,
//       webMs: {mean, max} | null, pipeMs (native: frame captured -> event sent, mean) | null,
//       latency (ar.status.latency: {n, mean, p50, p90, max} ms) | null, fps, thermal,
//       nativeRate, predictS, method}       rates over the last second, shares over the last 2 s
//   frame, pose, poses     the last HandFrame, the last shown pose, the last compare poses
//   planes                 the latest ar.planes list (from events; refreshPlanes() asks for it)
//   status                 the latest ar.status
//   predictS               the prediction in use (seconds)
//
// Times: frame.t etc. are on the phone's clock, the page's performance.now() on another one; rates
// and web time are measured with the page clock, latencies only from native times.

import { parseHandsEvent } from './frame.js';
import { HandTracker } from './tracker.js';
import { HandScanner } from './scan.js';
import { clamp } from './geom.js';

export const HANDS_CONFIG = { hz: 30, maxHands: 2, window: 2, patchEvery: 0 };
export const METHODS = ['fused', 'lidar', 'size'];
const DISPLAY_FRAME_S = 1 / 60;
const MAX_PREDICT_S = 0.1;
const HISTORY_S = 2; // poses kept for recent()
// scan.js wants an unthinned mask near the phone. A full patch is ~16k pixels (~64 KB of base64)
// per event; at 30 a second that is ~2 MB/s through the web view, which the phone may not keep up
// with (events would queue, nothing pushes back). A still hand needs no 30 Hz: scan at 15.
const SCAN_PATCH = { patchEvery: 1, patchStep: 1, patchMax: 20000, hz: 15 };

const pageNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function meanMax(list) {
  if (!list.length) return null;
  let s = 0;
  let m = -Infinity;
  for (const v of list) {
    s += v;
    if (v > m) m = v;
  }
  return { mean: Math.round((s / list.length) * 10) / 10, max: Math.round(m * 10) / 10 };
}

/** Event counts over a stretch of time (window()). */
class Tally {
  constructor() {
    this.t0 = pageNow();
    this.events = 0;
    this.withHand = 0;
    this.withPose = 0;
    this.hands = 0;
    this.chirality = { left: 0, right: 0, unknown: 0 };
    this.confSum = 0;
    this.vision = [];
  }

  add(frame, pose) {
    this.events++;
    if (frame.hands.length) this.withHand++;
    if (pose && !pose.quality?.held) this.withPose++;
    this.hands += frame.hands.length;
    for (const h of frame.hands) {
      this.chirality[h.chirality] = (this.chirality[h.chirality] || 0) + 1;
      this.confSum += h.confidence;
    }
    if (frame.tv0 != null && frame.tv1 != null) this.vision.push((frame.tv1 - frame.tv0) * 1000);
  }

  result() {
    const seconds = (pageNow() - this.t0) / 1000;
    const n = this.events;
    const r2 = (v) => Math.round(v * 100) / 100;
    return {
      seconds: Math.round(seconds * 10) / 10,
      events: n,
      rate: seconds > 0 ? Math.round((n / seconds) * 10) / 10 : 0,
      handShare: n ? r2(this.withHand / n) : 0,
      poseShare: n ? r2(this.withPose / n) : 0,
      meanHands: n ? r2(this.hands / n) : 0,
      chirality: { ...this.chirality },
      meanConfidence: this.hands ? r2(this.confSum / this.hands) : null,
      visionMs: meanMax(this.vision),
    };
  }
}

export class HandSession {
  constructor({ ar, model, trackerOptions = {}, view = null, onPose = null, onFrame = null, config = {} }) {
    this.ar = ar;
    this.model = model;
    this.view = view;
    this.onPose = onPose;
    this.onFrame = onFrame;
    this.config = { ...HANDS_CONFIG, ...config };
    const { predict = 0, ...rest } = trackerOptions;
    this.trackerOptions = rest;
    this.predictMode = predict;
    this.predictS = typeof predict === 'number' ? predict : 0;
    this.tracker = new HandTracker(model, { ...rest, predict: this.predictS });
    this.compare = false;
    this.compareTrackers = null;
    this.running = false;
    this.frame = null;
    this.pose = null;
    this.poses = null;
    this.planes = [];
    this.status = null;
    this.scanning = false;
    this.scanStatus = null;
    this._scan = null; // {scanner, resolve, timer, onProgress}
    this._off = [];
    this._history = { main: [] };
    this._recent = []; // {at (page ms), hand, pose, chir: [..], vision, web, pipe, gap}
    this._tallies = new Set();
    this._lastSeq = null;
    // planes and status are useful even before tracking starts (scan fallback, latency)
    this._offAlways = [
      ar.onPlanes((ev) => this._setPlanes(ev.planes)),
      ar.onStatus((s) => this._onStatus(s)),
    ];
  }

  // --- lifecycle ---

  async start() {
    if (!this.running) {
      this._off.push(this.ar.onHands((ev) => this._onEvent(ev)));
      this.running = true;
    }
    this._lastSeq = null;
    try {
      return await this.ar.hands({ on: true, ...this.config, ...(this._scan ? SCAN_PATCH : { patchEvery: this.config.patchEvery }) });
    } catch (e) {
      this._stopListening();
      throw e;
    }
  }

  async stop() {
    if (this._scan) this._endScan({ ok: false, reason: 'stopped', status: this.scanStatus });
    this._stopListening();
    this.tracker.reset();
    if (this.compareTrackers) for (const tr of Object.values(this.compareTrackers)) tr.reset();
    try {
      await this.ar.hands({ on: false });
    } catch {
      // the session may be gone already; nothing to switch off then
    }
  }

  _stopListening() {
    for (const off of this._off) off();
    this._off = [];
    this.running = false;
  }

  /** Stops listening to everything, also planes and status (the page is done with hands). */
  dispose() {
    this._stopListening();
    for (const off of this._offAlways) off();
    this._offAlways = [];
  }

  async refreshPlanes() {
    try {
      const r = await this.ar.planes();
      if (Array.isArray(r.planes)) this._setPlanes(r.planes);
    } catch {
      // no planes feature, or AR not running: keep what we have
    }
    return this.planes;
  }

  _setPlanes(list) {
    if (!Array.isArray(list)) return;
    this.planes = list;
    this.view?.setPlanes?.(list);
  }

  // --- model and options ---

  setModel(m) {
    this.model = m;
    this.tracker.setModel(m);
    if (this.compareTrackers) for (const tr of Object.values(this.compareTrackers)) tr.setModel(m);
    this._history = { main: [] };
  }

  setOptions(o = {}) {
    const { predict, ...rest } = o;
    Object.assign(this.trackerOptions, rest);
    if (predict !== undefined) {
      this.predictMode = predict;
      if (typeof predict === 'number') this.predictS = clamp(predict, 0, 1);
      else if (predict !== 'auto') this.predictS = 0;
      else this._updatePredict();
    }
    this.tracker.setOptions({ ...rest, predict: this.predictS });
    if (this.compareTrackers) {
      // the compare trackers measure where the hand is: never predicting, each its own method
      const { method, ...shared } = rest;
      for (const tr of Object.values(this.compareTrackers)) tr.setOptions(shared);
    }
  }

  setCompare(on) {
    on = Boolean(on);
    if (on === this.compare) return;
    this.compare = on;
    if (on) {
      this.compareTrackers = Object.fromEntries(METHODS.map((m) => [m, new HandTracker(this.model, { ...this.trackerOptions, method: m, predict: 0 })]));
      for (const m of METHODS) this._history[m] = [];
    } else {
      this.compareTrackers = null;
      this.poses = null;
      for (const m of METHODS) delete this._history[m];
    }
  }

  _onStatus(s) {
    this.status = s;
    if (this.predictMode === 'auto') this._updatePredict();
  }

  _updatePredict() {
    const lat = this.status?.latency;
    if (!lat || !(lat.n > 0) || !Number.isFinite(lat.p50)) return; // no samples this second: keep the last value
    const p = clamp(lat.p50 / 1000 + DISPLAY_FRAME_S, 0, MAX_PREDICT_S);
    if (Math.abs(p - this.predictS) < 0.001) return;
    this.predictS = p;
    this.tracker.setOptions({ predict: p });
  }

  // --- the scan ---

  /**
   * Measures the hand lying flat on a table (scan.js). Resolves when the scanner is done or has
   * failed, or when stopScan() / stop() / the timeout ends it.
   */
  startScan({ durationS, minFrames, timeoutS = 0, onProgress = null } = {}) {
    if (this._scan) this._endScan({ ok: false, reason: 'stopped', status: this.scanStatus });
    const opts = {};
    if (durationS != null) opts.durationS = durationS;
    if (minFrames != null) opts.minFrames = minFrames;
    const scanner = new HandScanner(opts);
    this.scanning = true;
    this.scanStatus = scanner.status;
    return new Promise((resolve) => {
      this._scan = { scanner, resolve, onProgress, timer: 0 };
      if (timeoutS > 0) this._scan.timer = setTimeout(() => this._endScan({ ok: false, reason: 'timeout', status: this.scanStatus }), timeoutS * 1000);
      if (this.running) this.ar.hands(SCAN_PATCH).catch(() => {});
      if (!this.planes.length) this.refreshPlanes();
    });
  }

  stopScan() {
    if (this._scan) this._endScan({ ok: false, reason: 'stopped', status: this.scanStatus });
  }

  _endScan(result) {
    const s = this._scan;
    if (!s) return;
    this._scan = null;
    this.scanning = false;
    clearTimeout(s.timer);
    if (this.running) this.ar.hands({ patchEvery: this.config.patchEvery, hz: this.config.hz }).catch(() => {});
    s.resolve(result);
  }

  _feedScan(frame) {
    const s = this._scan;
    const st = s.scanner.push(frame, this.planes);
    this.scanStatus = st;
    try {
      s.onProgress?.(st);
    } catch (e) {
      console.error(e);
    }
    if (st.state === 'done') {
      const r = s.scanner.result();
      this._endScan(r ? { ok: true, model: r.model, measurements: r.measurements } : { ok: false, reason: 'failed', status: st });
    } else if (st.state === 'failed') {
      this._endScan({ ok: false, reason: 'failed', status: st, result: s.scanner.result() });
    }
    return st;
  }

  // --- every event ---

  _onEvent(ev) {
    const t0 = pageNow();
    let frame;
    try {
      frame = parseHandsEvent(ev);
    } catch (e) {
      console.error('hand session: bad ar.hands event', e);
      return;
    }
    let pose = null;
    try {
      pose = this.tracker.update(frame);
    } catch (e) {
      console.error('hand session: tracker failed', e);
    }
    let poses = null;
    if (this.compareTrackers) {
      poses = {};
      for (const m of METHODS) {
        try {
          poses[m] = this.compareTrackers[m].update(frame);
        } catch {
          poses[m] = null;
        }
      }
    }
    this.frame = frame;
    this.pose = pose;
    this.poses = poses;
    this._remember('main', frame.t, pose);
    if (poses) for (const m of METHODS) this._remember(m, frame.t, poses[m]);

    let scan = null;
    if (this._scan) scan = this._feedScan(frame);

    if (this.view) {
      try {
        if (pose) this.view.show(pose, frame.t, frame);
        else this.view.hide(frame);
      } catch (e) {
        console.error('hand session: view failed', e);
      }
    }
    const webMs = pageNow() - t0;
    this._count(frame, pose, webMs);
    try {
      this.onPose?.(pose, frame);
      this.onFrame?.(frame, pose, { poses, scan, webMs });
    } catch (e) {
      console.error(e);
    }
  }

  _remember(key, t, pose) {
    const list = this._history[key];
    if (!list) return;
    if (pose && !pose.quality?.held) list.push({ t, pose });
    while (list.length && list[0].t < t - HISTORY_S) list.shift();
  }

  _count(frame, pose, webMs) {
    const at = pageNow();
    const seq = Number(frame.seq);
    const gap = this._lastSeq != null && Number.isFinite(seq) && seq > this._lastSeq + 1 ? seq - this._lastSeq - 1 : 0;
    if (Number.isFinite(seq)) this._lastSeq = seq;
    this._recent.push({
      at,
      hand: frame.hands.length > 0,
      pose: Boolean(pose && !pose.quality?.held),
      chir: frame.hands.map((h) => h.chirality),
      vision: frame.tv0 != null && frame.tv1 != null ? (frame.tv1 - frame.tv0) * 1000 : null,
      pipe: frame.tSent != null ? (frame.tSent - frame.t) * 1000 : null,
      web: webMs,
      gap,
    });
    while (this._recent.length && this._recent[0].at < at - 2000) this._recent.shift();
    for (const w of this._tallies) w.add(frame, pose);
  }

  // --- numbers ---

  window() {
    const tally = new Tally();
    this._tallies.add(tally);
    return {
      peek: () => tally.result(),
      stop: () => {
        this._tallies.delete(tally);
        return tally.result();
      },
    };
  }

  recent(method = 'main', seconds = 0.3) {
    const list = this._history[method] || [];
    if (!list.length) return [];
    const tEnd = list[list.length - 1].t;
    return list.filter((e) => e.t >= tEnd - seconds).map((e) => e.pose);
  }

  stats() {
    const now = pageNow();
    const last1 = this._recent.filter((e) => e.at >= now - 1000);
    const last2 = this._recent.filter((e) => e.at >= now - 2000);
    const chirality = { left: 0, right: 0, unknown: 0 };
    for (const e of last2) for (const c of e.chir) chirality[c] = (chirality[c] || 0) + 1;
    const share = (k) => (last2.length ? Math.round((last2.filter((e) => e[k]).length / last2.length) * 100) / 100 : 0);
    const s = this.status;
    const pipe = meanMax(last1.map((e) => e.pipe).filter((v) => v != null));
    return {
      running: this.running,
      rate: last1.length,
      gaps: last1.reduce((a, e) => a + e.gap, 0),
      handShare: share('hand'),
      poseShare: share('pose'),
      chirality,
      visionMs: meanMax(last1.map((e) => e.vision).filter((v) => v != null)),
      webMs: meanMax(last1.map((e) => e.web)),
      pipeMs: pipe ? pipe.mean : null,
      latency: s?.latency ?? null,
      fps: s?.fps ?? null,
      thermal: s?.thermal ?? null,
      nativeRate: s?.hands?.rate ?? null,
      predictS: this.predictS,
      method: this.tracker.options.method,
    };
  }
}
