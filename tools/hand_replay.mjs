// Replays a hand recording from the phone through the same hand core the page runs
// (web/src/hand/: parseHandsEvent -> HandTracker, and HandScanner over the frames that carry depth
// patches) and prints a short plain-text report. This is where the tracker is tuned against real
// data from this phone: the synthetic tests (tools/hand_test.mjs) prove the geometry, only real
// Vision joints and real near-range LiDAR show how far the assumptions hold.
//
// Run: node tools/hand_replay.mjs <recording.json> [more.json ...] [--method fused|lidar|size]
//        [--predict s] [--compare]
//   --method    the tracker's method for the detailed section (default fused)
//   --predict   the tracker's prediction in seconds (default 0)
//   --compare   also run all three methods over the same frames and print one line each
//
// Input: what web/src/hand/recorder.js uploads (vite.config.js -> notes/handrec/*.json):
//   {recordedAt, appVersion, note, model, seconds, events: [{rt, ev}], statuses: [{rt, ev}],
//    planes: [{rt, ev}]}; rt = ms since the start on the page's clock, ev = the raw native event
//   (ar.hands / ar.status / ar.planes, docs/protocol.md). Also accepted, because the tool gets
//   pointed at whatever came off the phone: a bare list of events or of {rt, ev}, or one event.
//   Anything odd (missing fields, broken rows, no camera, empty lists) is counted and skipped,
//   never fatal: a report with holes beats a stack trace.
//
// Report sections
//   frames    hand events, share with a hand, two-hand frames, Vision's chirality labels (and how
//             often they flip), joint confidence, the LiDAR samples at the joints, patches
//   timing    native clock only (the page's and the PC's clocks drift): Vision ms (tv1 - tv0),
//             event spacing from t (gaps > 100 ms), seq gaps (frames Vision failed on),
//             tSent - t (native processing, split into queue / Vision / after), and the page's
//             delivery jitter (rt against tSent, relative to the fastest event)
//   status    fps, thermal, the native box-update latency (ar.status.latency, camera frame ->
//             box applied), the hand rate and Vision ms the native side reports
//   tracker   solved / held / dropouts and why, palm depth by LiDAR vs by size (difference,
//             spread, how often LiDAR was usable, lidarWeight, by distance), palm-fit
//             reprojection error, how finger roots were picked, joints filled from history,
//             bone lengths of the tracked pose against the model, palm speed and jumps,
//             still-hand jitter (filtered and raw), tracker time on this PC
//   compare   (--compare) one line per method: solved share, held, dropouts, palm depth and how
//             far it is from the size estimate, bone error, still-hand jitter, reprojection,
//             filled joints, jumps, ms per frame (LiDAR vs size itself is the same for all three)
//   scan      HandScanner over the frames with patches (with the latest ar.planes list): issue
//             counts, each finished scan's sizes (hand sizes are not blind), against the
//             recording's model
//
// Still stretches: runs of solved frames (no gap > 0.15 s) 0.5 to 3 s long (a longer still period
// is cut into pieces) in which the tracked palm centre stays within 1 cm of its mean and every
// joint within 2 cm of its mean; the first and last 0.1 s are dropped (the end of a movement).
// Jitter = per joint RMS distance from its mean over the stretch, averaged over the joints (as in
// hand_test.mjs; slow drift within a stretch counts).
//
// BLIND TEST: statuses can carry the furniture's pose; this tool never prints it (nor a size).

import { readFileSync, existsSync, statSync } from 'node:fs';
import { basename } from 'node:path';

import { JOINT_NAMES, PALM_JOINTS, CHAIN, FINGERS, SEGMENT_OF, SEGMENTS } from '../web/src/hand/joints.js';
import { dist } from '../web/src/hand/geom.js';
import { parseHandsEvent } from '../web/src/hand/frame.js';
import { defaultModel, validModel, summaryCm, palmShapeFor } from '../web/src/hand/model.js';
import { HandTracker, TRACKER_DEFAULTS } from '../web/src/hand/tracker.js';
import { HandScanner } from '../web/src/hand/scan.js';

const METHODS = ['fused', 'lidar', 'size'];
const MIN_C = TRACKER_DEFAULTS.minJointConf;
const GAP_MS = 100; // event spacing above this is a gap
const TIPS = [4, 8, 12, 16, 20];
const PALM_PAIRS = [[0, 1], [0, 5], [0, 9], [0, 13], [0, 17], [1, 5], [5, 17]];
// maxS splits a long still period into pieces: bounds the work (the check is quadratic in the
// stretch) and keeps slow drift out of the jitter
const STILL = { minS: 0.5, maxS: 3, palmR: 0.01, jointR: 0.02, maxGapS: 0.15, trimS: 0.1, minSamples: 8 };
const JUMP = { minM: 0.03, minSpeed: 1.5 }; // a jump: > 3 cm between frames at > 1.5 m/s
const DEPTH_BINS = [[0, 0.3, '< 30 cm'], [0.3, 0.5, '30-50 cm'], [0.5, Infinity, '> 50 cm']];

// --- small helpers -----------------------------------------------------------------------------

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const numArr = (a, n) => Array.isArray(a) && a.length === n && a.every(isNum);

/** Count / mean / quantiles of the finite numbers in a list (loops, no spread: lists can be long). */
function summ(list) {
  const a = [];
  for (const v of list) if (isNum(v)) a.push(v);
  a.sort((x, y) => x - y);
  const n = a.length;
  if (!n) return { n: 0, mean: NaN, std: NaN, min: NaN, max: NaN, p10: NaN, p50: NaN, p90: NaN };
  let s = 0;
  for (const v of a) s += v;
  const m = s / n;
  let ss = 0;
  for (const v of a) ss += (v - m) * (v - m);
  const q = (p) => {
    const i = p * (n - 1);
    const lo = Math.floor(i);
    const hi = Math.min(n - 1, lo + 1);
    return a[lo] + (a[hi] - a[lo]) * (i - lo);
  };
  return { n, mean: m, std: n > 1 ? Math.sqrt(ss / (n - 1)) : 0, min: a[0], max: a[n - 1], p10: q(0.1), p50: q(0.5), p90: q(0.9) };
}

const fx = (v, d = 1) => (isNum(v) ? v.toFixed(d) : '-');
const sx = (v, d = 1) => {
  if (!isNum(v)) return '-';
  const s = Math.abs(v).toFixed(d);
  return Number(s) === 0 ? s : `${v > 0 ? '+' : '-'}${s}`; // no "-0.0"
};
const pct = (a, b) => (b > 0 ? `${((100 * a) / b).toFixed(1)}%` : '-');
const counts = (obj) => {
  const e = Object.entries(obj).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  return e.length ? e.map(([k, n]) => `${k} ${n}`).join(', ') : 'none';
};
const bump = (obj, k, n = 1) => (obj[k] = (obj[k] || 0) + n);
const palmCentre = (joints) => {
  const c = [0, 0, 0];
  for (const j of PALM_JOINTS) for (let a = 0; a < 3; a++) c[a] += joints[j][a] / PALM_JOINTS.length;
  return c;
};
const boneName = (finger, s) => SEGMENTS[SEGMENT_OF[finger][s]].id;

function out(line = '') {
  process.stdout.write(`${line}\n`);
}

// --- arguments ---------------------------------------------------------------------------------

function parseArgs(argv) {
  const a = { files: [], method: 'fused', predict: 0, compare: false, help: false, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    let k = argv[i];
    let val = null;
    const eq = k.indexOf('=');
    if (k.startsWith('--') && eq > 0) {
      val = k.slice(eq + 1);
      k = k.slice(0, eq);
    }
    const next = () => (val !== null ? val : argv[++i]);
    if (k === '--method') {
      const m = next();
      if (METHODS.includes(m)) a.method = m;
      else a.errors.push(`--method takes one of ${METHODS.join(', ')}`);
    } else if (k === '--predict') {
      const v = Number(next());
      if (Number.isFinite(v) && v >= 0 && v <= 1) a.predict = v;
      else a.errors.push('--predict takes seconds, 0 to 1');
    } else if (k === '--compare') a.compare = true;
    else if (k === '-h' || k === '--help') a.help = true;
    else if (k.startsWith('-')) a.errors.push(`unknown option ${k}`);
    else a.files.push(k);
  }
  return a;
}

// --- reading a recording -----------------------------------------------------------------------

function kindOf(ev, fallback) {
  const ty = ev.type;
  if (ty === 'ar.hands') return 'hands';
  if (ty === 'ar.status') return 'status';
  if (ty === 'ar.planes') return 'planes';
  if (typeof ty === 'string') return 'other';
  if (fallback) return fallback; // untyped: trust the list it came from
  if (Array.isArray(ev.hands)) return 'hands';
  if (Array.isArray(ev.planes)) return 'planes';
  return 'other';
}

/** Any accepted shape -> {meta, hands, statuses, planes: [{rt, ev}], other, junk}. */
function normalize(raw) {
  const rec = { meta: isObj(raw) && typeof raw.type !== 'string' ? raw : {}, hands: [], statuses: [], planes: [], other: 0, junk: 0 };
  const take = (list, fallback) => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (!isObj(item)) {
        rec.junk++;
        continue;
      }
      let ev = null;
      if (isObj(item.ev)) ev = item.ev;
      else if (typeof item.type === 'string' || Array.isArray(item.hands)) ev = item; // a bare event
      if (!ev) {
        rec.junk++;
        continue;
      }
      const rt = isNum(Number(item.rt)) && item.rt !== null && item.rt !== '' ? Number(item.rt) : null;
      const kind = kindOf(ev, fallback);
      if (kind === 'hands') rec.hands.push({ rt, ev });
      else if (kind === 'status') rec.statuses.push({ rt, ev });
      else if (kind === 'planes') rec.planes.push({ rt, ev });
      else rec.other++;
    }
  };
  if (Array.isArray(raw)) take(raw, null);
  else if (isObj(raw)) {
    if (typeof raw.type === 'string') take([raw], null); // a single event
    else {
      take(raw.events, 'hands');
      take(raw.statuses, 'status');
      take(raw.planes, 'planes');
    }
  }
  return rec;
}

function cleanCam(c) {
  if (!isObj(c) || !numArr(c.transform, 16) || !numArr(c.intrinsics, 9) || !(c.intrinsics[0] > 0) || !(c.intrinsics[4] > 0)) return null;
  const ir = numArr(c.imageResolution, 2) && c.imageResolution[0] > 0 && c.imageResolution[1] > 0 ? c.imageResolution : [1920, 1440];
  return { transform: c.transform, intrinsics: c.intrinsics, imageResolution: ir };
}

/** A copy of a hands event that parseHandsEvent cannot trip over (broken rows become unseen joints). */
function cleanHandsEvent(ev) {
  const hands = Array.isArray(ev.hands)
    ? // not filtered: a patch names its hand by the index in this list
      ev.hands.map((h) => (isObj(h) ? { ...h, joints: Array.isArray(h.joints) ? h.joints.map((r) => (Array.isArray(r) ? r : [])) : [] } : { joints: [] }))
    : [];
  const depthSize = numArr(ev.depthSize, 2) && ev.depthSize[0] > 0 && ev.depthSize[1] > 0 ? ev.depthSize : null;
  const okPatch = (p) =>
    isObj(p) && numArr(p.rect, 4) && Number.isInteger(p.w) && Number.isInteger(p.h) && p.w > 0 && p.h > 0 && p.w * p.h <= 49152 && isNum(p.step) && p.step >= 1;
  const patches = Array.isArray(ev.patches) ? ev.patches.filter(okPatch) : [];
  return { ...ev, hands, depthSize, patches, display: numArr(ev.display, 6) ? ev.display : null };
}

/**
 * Hand events in arrival order, parsed, with the plane lists merged in by rt:
 * timeline = [{kind: 'planes', planes} | {kind: 'frame', f}], frames = [f], f = {rt, ev, frame}.
 */
function buildTimeline(rec) {
  const notes = { unparseable: 0, badCamera: 0, tFromPage: 0, handsNotAList: 0, brokenJointRows: 0, droppedHands: 0, badPatches: 0 };
  const frames = [];
  let lastRt = 0;
  let lastT = null;
  for (const { rt, ev } of rec.hands) {
    const r = rt ?? lastRt; // no rt: keep the list's order
    lastRt = r;
    const clean = cleanHandsEvent(ev);
    if (ev.hands !== undefined && !Array.isArray(ev.hands)) notes.handsNotAList++;
    for (const h of Array.isArray(ev.hands) ? ev.hands : []) {
      if (isObj(h) && Array.isArray(h.joints)) notes.brokenJointRows += h.joints.filter((row) => !Array.isArray(row)).length;
    }
    let frame;
    try {
      frame = parseHandsEvent(clean);
    } catch {
      notes.unparseable++;
      continue;
    }
    if (!isNum(Number(ev.t)) || ev.t === null || ev.t === '') {
      // no native time: the page clock still orders the frames (only differences matter)
      frame.t = rt !== null ? rt / 1000 : (lastT ?? 0) + 1 / 30;
      notes.tFromPage++;
    }
    frame.cam = cleanCam(ev.camera);
    if (!frame.cam) notes.badCamera++;
    notes.droppedHands += clean.hands.length - frame.hands.length;
    notes.badPatches += (Array.isArray(ev.patches) ? ev.patches.length : 0) - clean.patches.length;
    lastT = frame.t;
    frames.push({ rt, key: r, ev, frame });
  }
  const timeline = [];
  const order = (x) => (x.rt === null ? -Infinity : x.rt); // a plane list without rt counts from the start
  for (const p of rec.planes) timeline.push({ kind: 'planes', key: order(p), planes: Array.isArray(p.ev.planes) ? p.ev.planes.filter(isObj) : null });
  frames.forEach((f) => timeline.push({ kind: 'frame', key: f.key, f }));
  // stable: at equal rt a plane list goes first (it arrived before the frame it describes, or with it)
  timeline.sort((a, b) => a.key - b.key || (a.kind === b.kind ? 0 : a.kind === 'planes' ? -1 : 1));
  return { frames, timeline, notes };
}

function pickModel(rec, frames) {
  const m = rec.meta.model;
  if (m != null && validModel(m)) return { model: m, how: `from the recording (${m.source === 'scan' ? 'scanned' : m.source || 'unknown source'})` };
  const votes = { left: 0, right: 0 };
  for (const { frame } of frames) for (const h of frame.hands) if (h.chirality in votes) votes[h.chirality]++;
  const chir = votes.left > votes.right ? 'left' : 'right';
  const why = m == null ? 'none in the recording' : 'the recording\'s is not valid';
  return { model: defaultModel(chir), how: `default (${why}; ${chir} by Vision's labels ${votes.right} right / ${votes.left} left)` };
}

// --- frames and timing -------------------------------------------------------------------------

function reportFrames(frames, notes) {
  out('== frames');
  const n = frames.length;
  const withHand = frames.filter((f) => f.frame.hands.length > 0).length;
  const two = frames.filter((f) => f.frame.hands.length > 1).length;
  const usable = frames.filter((f) => f.frame.hands.some((h) => PALM_JOINTS.filter((j) => h.joints[j].c >= MIN_C).length >= 4)).length;
  out(`  hand events ${n}; with a hand ${withHand} (${pct(withHand, n)}), two or more ${two}; palm seen (>= 4 palm joints at c >= ${MIN_C}) ${usable} (${pct(usable, n)})`);
  const chir = { left: 0, right: 0, unknown: 0 };
  let flips = 0;
  let prev = null;
  const handConf = [];
  for (const { frame } of frames) {
    for (const h of frame.hands) {
      bump(chir, h.chirality);
      handConf.push(h.confidence);
    }
    if (frame.hands.length === 1) {
      const c = frame.hands[0].chirality;
      if (prev && prev.c !== c && frame.t - prev.t <= 0.3) flips++;
      prev = { c, t: frame.t };
    }
  }
  out(
    `  chirality (all hands): right ${chir.right}, left ${chir.left}, unknown ${chir.unknown}; ` +
      `label flips between one-hand frames ${flips}; hand confidence mean ${fx(summ(handConf).mean, 2)}`,
  );

  const conf = [];
  let seen = 0;
  let total = 0;
  let lidarOn = 0;
  let anyDepth = 0;
  const hiNear = [];
  const hiFar = [];
  const pdDiff = [];
  const dHands = [];
  for (const { frame } of frames) {
    for (const h of frame.hands) {
      for (const j of h.joints) {
        total++;
        conf.push(j.c);
        if (j.c < MIN_C) continue;
        seen++;
        if (j.dAll > 0) anyDepth++;
        if (j.dHand > 0 && j.nHand >= 3) {
          lidarOn++;
          dHands.push(j.dHand);
          (j.dHand < 0.4 ? hiNear : hiFar).push(j.hi);
          if (j.pd > 0) pdDiff.push(Math.abs(j.dHand - j.pd) * 1000);
        }
      }
    }
  }
  if (total) {
    const c = summ(conf);
    out(`  joints: confidence mean ${fx(c.mean, 2)}, seen (c >= ${MIN_C}) ${pct(seen, total)}`);
    const d = summ(dHands);
    out(
      `  LiDAR at seen joints: any depth ${pct(anyDepth, seen)}, on the hand (dHand > 0, nHand >= 3) ${pct(lidarOn, seen)}; ` +
        `dHand ${fx(d.p10 * 100)}..${fx(d.p90 * 100)} cm (p10..p90); "high" share mean ${fx(summ(hiNear).mean, 2)} under 40 cm (n ${hiNear.length}), ` +
        `${fx(summ(hiFar).mean, 2)} beyond (n ${hiFar.length}); |dHand - person depth| median ${fx(summ(pdDiff).p50, 1)} mm`,
    );
  }
  const withPatch = frames.filter((f) => f.frame.hands.some((h) => h.patch)).length;
  if (withPatch) {
    const sizes = [];
    const steps = {};
    for (const { frame } of frames) {
      for (const h of frame.hands) {
        if (!h.patch) continue;
        sizes.push(h.patch.w * h.patch.h);
        bump(steps, `step ${h.patch.step}`);
      }
    }
    const px = summ(sizes);
    out(`  depth patches: ${withPatch} frames (${pct(withPatch, n)}); pixels per patch mean ${fx(px.mean, 0)}, max ${fx(px.max, 0)}; patches by ${counts(steps)}`);
  } else out('  depth patches: none (patchEvery was 0)');
  const odd = Object.entries(notes).filter(([, v]) => v > 0);
  if (odd.length) out(`  odd input: ${odd.map(([k, v]) => `${k} ${v}`).join(', ')}`);
}

function reportTiming(frames) {
  out('== timing (native clock, ms)');
  if (!frames.length) {
    out('  no hand events');
    return;
  }
  const t0 = frames[0].frame.t;
  const nat = (v) => (isNum(v) ? v : null);
  const vision = [];
  const queue = [];
  const after = [];
  const sent = [];
  for (const { ev } of frames) {
    const t = nat(ev.t);
    const a = nat(ev.tv0);
    const b = nat(ev.tv1);
    const s = nat(ev.tSent);
    const ok = (v) => v !== null && v >= 0 && v < 10000;
    if (a !== null && b !== null && ok((b - a) * 1000)) vision.push((b - a) * 1000);
    if (t !== null && a !== null && ok((a - t) * 1000)) queue.push((a - t) * 1000);
    if (b !== null && s !== null && ok((s - b) * 1000)) after.push((s - b) * 1000);
    if (t !== null && s !== null && ok((s - t) * 1000)) sent.push((s - t) * 1000);
  }
  const v = summ(vision);
  out(`  Vision (tv1 - tv0): mean ${fx(v.mean)}, p90 ${fx(v.p90)}, max ${fx(v.max)} (n ${v.n})`);

  const dts = [];
  const gaps = [];
  let backwards = 0;
  for (let i = 1; i < frames.length; i++) {
    const dt = (frames[i].frame.t - frames[i - 1].frame.t) * 1000;
    if (!(dt > 0)) {
      backwards++;
      continue;
    }
    dts.push(dt);
    if (dt > GAP_MS) gaps.push({ dt, at: frames[i - 1].frame.t - t0 });
  }
  const d = summ(dts);
  const span = frames[frames.length - 1].frame.t - t0;
  const gapText = gaps.length
    ? `; gaps > ${GAP_MS} ms: ${gaps.length}, ${gaps
        .slice()
        .sort((a, b) => b.dt - a.dt)
        .slice(0, 4)
        .map((g) => `${fx(g.dt, 0)} at ${fx(g.at, 2)} s`)
        .join(', ')}${gaps.length > 4 ? ', ...' : ''}`
    : `; no gaps > ${GAP_MS} ms`;
  if (frames.length < 2) out('  event spacing: needs two events');
  else {
    const rate = span > 0 ? (frames.length - 1) / span : NaN;
    out(`  event spacing (t): mean ${fx(d.mean)}, p90 ${fx(d.p90)}, max ${fx(d.max)}; ${fx(rate)} events/s over ${fx(span, 2)} s${gapText}`);
  }
  if (backwards) out(`  t not increasing: ${backwards} events`);

  let missing = 0;
  let repeats = 0;
  let restarts = 0;
  let seqs = 0;
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1].ev.seq;
    const b = frames[i].ev.seq;
    if (!Number.isInteger(a) || !Number.isInteger(b)) continue;
    seqs++;
    if (b === a) repeats++;
    else if (b < a) restarts++; // hand tracking turned off and on again
    else missing += b - a - 1;
  }
  if (seqs) {
    const extra = [repeats ? `${repeats} repeated` : '', restarts ? `${restarts} restarts` : ''].filter(Boolean).join(', ');
    out(`  seq: ${missing} missing (frames Vision failed on, or not recorded)${extra ? `; ${extra}` : ''}`);
  }

  const st = summ(sent);
  out(
    `  camera frame -> sent (tSent - t): mean ${fx(st.mean)}, p90 ${fx(st.p90)}, max ${fx(st.max)}` +
      ` [queue (tv0 - t) ${fx(summ(queue).mean)}, Vision ${fx(v.mean)}, after (tSent - tv1) ${fx(summ(after).mean)}]`,
  );

  // the page's clock and the phone's drift apart only slowly: over a recording, the spread of
  // (arrival - tSent) is the delivery jitter of the web view
  const deliv = [];
  for (const { rt, ev } of frames) if (isNum(rt) && isNum(ev.tSent)) deliv.push(rt - ev.tSent * 1000);
  if (deliv.length >= 2) {
    const lo = summ(deliv).min;
    const j = summ(deliv.map((x) => x - lo));
    const rtGaps = [];
    for (let i = 1; i < frames.length; i++) if (isNum(frames[i].rt) && isNum(frames[i - 1].rt)) rtGaps.push(frames[i].rt - frames[i - 1].rt);
    const pageGaps = rtGaps.filter((g) => g > GAP_MS).length;
    out(`  page delivery (rt - tSent, above the fastest): p50 ${fx(j.p50)}, p90 ${fx(j.p90)}, max ${fx(j.max)}; page arrival gaps > ${GAP_MS} ms: ${pageGaps}`);
  }
}

function reportStatus(statuses) {
  out(`== status (${statuses.length} statuses)`);
  if (!statuses.length) {
    out('  none recorded');
    return;
  }
  const evs = statuses.map((s) => s.ev);
  const fps = summ(evs.map((e) => e.fps));
  const thermal = {};
  const tracking = {};
  const seq = [];
  for (const e of evs) {
    if (typeof e.thermal === 'string') {
      bump(thermal, e.thermal);
      if (seq[seq.length - 1] !== e.thermal) seq.push(e.thermal);
    }
    if (typeof e.tracking === 'string') bump(tracking, e.tracking);
  }
  const path = seq.length > 6 ? [...seq.slice(0, 3), '...', ...seq.slice(-2)] : seq;
  out(`  fps: mean ${fx(fps.mean)}, min ${fx(fps.min)}, max ${fx(fps.max)} (n ${fps.n}); thermal: ${counts(thermal)}${seq.length > 1 ? ` (${path.join(' -> ')})` : ''}`);
  if (Object.keys(tracking).length) out(`  tracking: ${counts(tracking)}`);
  const hs = evs.map((e) => (isObj(e.hands) ? e.hands : null)).filter(Boolean);
  if (hs.length) {
    const rate = summ(hs.map((h) => h.rate));
    const vm = summ(hs.map((h) => (Array.isArray(h.visionMs) ? h.visionMs[0] : NaN)));
    const vx = summ(hs.map((h) => (Array.isArray(h.visionMs) ? h.visionMs[1] : NaN)));
    out(`  hands (native): on in ${hs.filter((h) => h.on).length} of ${hs.length}; rate mean ${fx(rate.mean)}/s; Vision ms mean ${fx(vm.mean)}, max ${fx(vx.max)}`);
  }
  const lat = evs.map((e) => e.latency).filter((l) => isObj(l));
  const withN = lat.filter((l) => isNum(l.n) && l.n > 0);
  if (!lat.length) out('  box latency: not in the statuses (an app before stage 3)');
  else if (!withN.length) out(`  box latency: no samples in ${lat.length} statuses (no ar.updateGroups with frameT)`);
  else {
    const nTot = withN.reduce((s, l) => s + l.n, 0);
    // the mean over all samples: each second's mean weighted by its count
    const withMean = withN.filter((l) => isNum(l.mean));
    const nMean = withMean.reduce((s, l) => s + l.n, 0);
    const wMean = nMean ? withMean.reduce((s, l) => s + l.mean * l.n, 0) / nMean : NaN;
    const p50 = summ(withN.map((l) => l.p50));
    const p90 = summ(withN.map((l) => l.p90));
    const mx = summ(withN.map((l) => l.max));
    out(
      `  box latency (camera frame -> box applied, ms): ${withN.length} of ${lat.length} statuses with samples (n ${nTot}); ` +
        `mean ${fx(wMean)}, p50 ${fx(p50.p50)}, p90 ${fx(p90.p50)} (worst second ${fx(p90.max)}), max ${fx(mx.max)}`,
    );
  }
}

// --- tracker -----------------------------------------------------------------------------------

function track(frames, model, opts) {
  const tr = new HandTracker(model, opts);
  const recs = [];
  for (const { frame } of frames) {
    const a = performance.now();
    let pose = null;
    let err = null;
    try {
      pose = tr.update(frame);
    } catch (e) {
      err = e; // update() guards its solve; this is a bug elsewhere, keep going
    }
    const ms = performance.now() - a;
    const held = Boolean(pose?.quality?.held);
    const solved = Boolean(pose) && !held && Array.isArray(pose.joints) && pose.joints.length === 21;
    const dbg = tr.lastDebug;
    recs.push({
      t: frame.t,
      frame,
      pose: solved || held ? pose : null,
      held,
      solved,
      reason: solved ? null : err ? `error: ${err.message}` : dbg?.rejected || 'unknown',
      raw: solved && Array.isArray(dbg?.raw) && dbg.t === frame.t ? dbg.raw : null,
      ms,
      hasHand: frame.hands.length > 0,
    });
  }
  return recs;
}

/** Still stretches as [first, last] indices into `s` (solved samples, see the header). */
function stillStretches(s) {
  const isStill = (i, j) => {
    const n = j - i + 1;
    const pc = [0, 0, 0];
    for (let k = i; k <= j; k++) for (let a = 0; a < 3; a++) pc[a] += s[k].pc[a] / n;
    for (let k = i; k <= j; k++) if (dist(s[k].pc, pc) > STILL.palmR) return false;
    for (let jt = 0; jt < 21; jt++) {
      const c = [0, 0, 0];
      for (let k = i; k <= j; k++) for (let a = 0; a < 3; a++) c[a] += s[k].joints[jt][a] / n;
      for (let k = i; k <= j; k++) if (dist(s[k].joints[jt], c) > STILL.jointR) return false;
    }
    return true;
  };
  const found = [];
  let i = 0;
  while (i < s.length) {
    let j = i;
    while (j + 1 < s.length && s[j + 1].t > s[j].t && s[j + 1].t - s[j].t <= STILL.maxGapS && s[j + 1].t - s[i].t <= STILL.maxS && isStill(i, j + 1)) j++;
    if (s[j].t - s[i].t >= STILL.minS && j - i + 1 >= STILL.minSamples) {
      found.push([i, j]);
      i = j + 1;
    } else i++;
  }
  return found;
}

/** Mean over the given joints of each joint's RMS distance from its mean over the samples. */
function jitterOf(samples, key, jointIdx) {
  const per = [];
  for (const jt of jointIdx) {
    const ps = samples.map((x) => x[key][jt]);
    const c = [0, 0, 0];
    for (const p of ps) for (let a = 0; a < 3; a++) c[a] += p[a] / ps.length;
    let ss = 0;
    for (const p of ps) ss += dist(p, c) ** 2;
    per.push(Math.sqrt(ss / ps.length));
  }
  return summ(per).mean;
}

function analyze(recs, model) {
  const r = { frames: recs.length };
  r.handFrames = recs.filter((x) => x.hasHand).length;
  const solved = recs.filter((x) => x.solved);
  r.solved = solved.length;
  r.held = recs.filter((x) => x.held).length;
  r.reasons = {};
  for (const x of recs) if (!x.solved) bump(r.reasons, x.held ? `${x.reason} (held)` : x.reason);
  r.used = {};
  for (const x of solved) bump(r.used, x.pose.quality?.method ?? '?');

  // dropouts: from the last frame with a pose (or held) to the next one
  r.drops = [];
  let lastGood = null;
  let inDrop = null;
  let firstHandT = null;
  r.firstPoseAfter = NaN;
  for (const x of recs) {
    if (x.hasHand && firstHandT === null) firstHandT = x.t;
    if (x.pose) {
      if (!isNum(r.firstPoseAfter) && firstHandT !== null) r.firstPoseAfter = x.t - firstHandT;
      if (inDrop) {
        inDrop.dur = x.t - inDrop.from;
        r.drops.push(inDrop);
        inDrop = null;
      }
      lastGood = x;
    } else if (lastGood) {
      if (!inDrop) inDrop = { from: lastGood.t, at: lastGood.t, seen: false, dur: NaN, open: false };
      if (x.hasHand) inDrop.seen = true;
    }
  }
  if (inDrop) {
    inDrop.dur = recs[recs.length - 1].t - inDrop.from;
    inDrop.open = true;
    r.drops.push(inDrop);
  }

  const q = solved.map((x) => x.pose.quality || {});
  r.depth = summ(q.map((x) => x.palmDepth));
  const lid = q.filter((x) => isNum(x.palmDepthLidar) && isNum(x.palmDepthSize));
  r.lidarUsable = lid.length;
  r.lidarDiff = summ(lid.map((x) => (x.palmDepthLidar - x.palmDepthSize) * 1000));
  r.lidarWeight = summ(q.map((x) => x.lidarWeight));
  // how far this method's palm depth is from the size estimate ('size': 0; the methods differ here)
  r.vsSize = summ(q.map((x) => (x.palmDepth - x.palmDepthSize) * 1000));
  r.lidarWeightUsable = summ(lid.map((x) => x.lidarWeight));
  r.lidarJoints = summ(q.map((x) => x.lidarJoints));
  r.bins = DEPTH_BINS.map(([lo, hi, label]) => {
    const inBin = lid.filter((x) => x.palmDepthSize >= lo && x.palmDepthSize < hi);
    const all = q.filter((x) => isNum(x.palmDepthSize) && x.palmDepthSize >= lo && x.palmDepthSize < hi);
    return {
      label,
      n: all.length,
      usable: inBin.length,
      diff: summ(inBin.map((x) => (x.palmDepthLidar - x.palmDepthSize) * 1000)),
      weight: summ(inBin.map((x) => x.lidarWeight)),
    };
  });
  r.reproj = summ(q.map((x) => x.reprojErrPx));
  r.roots = { lidar: 0, history: 0, bend: 0 };
  r.noRoot = 0;
  for (const x of q) {
    if (isObj(x.roots)) for (const k of Object.keys(r.roots)) r.roots[k] += x.roots[k] || 0;
    r.noRoot += x.noRoot || 0;
  }
  r.filled = summ(q.map((x) => x.filled));
  r.filledFrames = q.filter((x) => x.filled > 0).length;
  r.filledJoints = {};
  for (const x of solved) {
    const h = x.frame.hands[x.pose.quality?.hand];
    if (!h) continue;
    h.joints.forEach((j, k) => {
      if (j.c < MIN_C) bump(r.filledJoints, JOINT_NAMES[k]);
    });
  }

  // bone lengths of the output pose against the model
  const boneErr = [];
  const boneLens = {};
  let worst = { e: -1 };
  const palmErr = [];
  for (const x of solved) {
    const J = x.pose.joints;
    for (const f of FINGERS) {
      const c = CHAIN[f];
      for (let s = 0; s < 3; s++) {
        const L = dist(J[c[s]], J[c[s + 1]]);
        const e = Math.abs(L - model.fingers[f].lengths[s]) * 1000;
        boneErr.push(e);
        (boneLens[boneName(f, s)] ||= []).push(L * 1000);
        if (e > worst.e) worst = { e, bone: boneName(f, s), t: x.t };
      }
    }
    const shape = palmShapeFor(model, x.pose.chirality);
    for (const [a, b] of PALM_PAIRS) {
      const ka = PALM_JOINTS.indexOf(a);
      const kb = PALM_JOINTS.indexOf(b);
      palmErr.push(Math.abs(dist(J[a], J[b]) - dist(shape[ka], shape[kb])) * 1000);
    }
  }
  r.boneErr = summ(boneErr);
  r.boneWorst = worst;
  r.palmErr = summ(palmErr);
  r.boneWobble = summ(Object.values(boneLens).map((l) => summ(l).std));

  // palm speed and jumps (output pose)
  const samples = solved.map((x) => ({ t: x.t, joints: x.pose.joints, raw: x.raw, pc: palmCentre(x.pose.joints) }));
  const speeds = [];
  r.jumps = [];
  for (let i = 1; i < samples.length; i++) {
    const dt = samples[i].t - samples[i - 1].t;
    if (!(dt > 0 && dt <= 0.1)) continue;
    const d = dist(samples[i].pc, samples[i - 1].pc);
    speeds.push((d / dt) * 100);
    if (d > JUMP.minM && d / dt > JUMP.minSpeed) r.jumps.push({ mm: d * 1000, at: samples[i].t });
  }
  r.speed = summ(speeds);

  // still-hand jitter
  r.still = { n: 0, seconds: 0, all: NaN, raw: NaN, palm: NaN, palmRaw: NaN, tips: NaN, tipsRaw: NaN, step: NaN };
  const stretches = stillStretches(samples)
    .map(([i, j]) => samples.slice(i, j + 1).filter((x) => x.t >= samples[i].t + STILL.trimS && x.t <= samples[j].t - STILL.trimS))
    .filter((s) => s.length >= STILL.minSamples);
  if (stretches.length) {
    const all21 = [...Array(21).keys()];
    const wavg = (fn) => {
      let s = 0;
      let w = 0;
      for (const st of stretches) {
        const v = fn(st);
        if (isNum(v)) {
          s += v * st.length;
          w += st.length;
        }
      }
      return w ? s / w : NaN;
    };
    const withRaw = (fn) => (st) => (st.every((x) => x.raw) ? fn(st) : NaN);
    const steps = [];
    for (const st of stretches) {
      for (let i = 1; i < st.length; i++) for (let jt = 0; jt < 21; jt++) steps.push(dist(st[i].joints[jt], st[i - 1].joints[jt]) * 1000);
    }
    r.still = {
      n: stretches.length,
      seconds: stretches.reduce((s, st) => s + (st[st.length - 1].t - st[0].t), 0),
      all: wavg((st) => jitterOf(st, 'joints', all21) * 1000),
      raw: wavg(withRaw((st) => jitterOf(st, 'raw', all21) * 1000)),
      palm: wavg((st) => jitterOf(st, 'joints', PALM_JOINTS) * 1000),
      palmRaw: wavg(withRaw((st) => jitterOf(st, 'raw', PALM_JOINTS) * 1000)),
      tips: wavg((st) => jitterOf(st, 'joints', TIPS) * 1000),
      tipsRaw: wavg(withRaw((st) => jitterOf(st, 'raw', TIPS) * 1000)),
      step: summ(steps).p50,
    };
  }
  r.ms = summ(recs.map((x) => x.ms));
  return r;
}

function reportTracker(r, method, predict, modelHow) {
  out(`== tracker: ${method}, predict ${predict} s; model ${modelHow}`);
  out(
    `  solved ${r.solved} of ${r.handFrames} frames with a hand (${pct(r.solved, r.handFrames)}), held ${r.held}; ` +
      `not solved: ${counts(r.reasons)}`,
  );
  out(`  palm method used: ${counts(r.used)}`);
  const seenDrops = r.drops.filter((d) => d.seen);
  const longest = r.drops.reduce((a, b) => (b.dur > (a?.dur ?? -1) ? b : a), null);
  out(
    `  dropouts (pose -> nothing): ${r.drops.length}, ${seenDrops.length} with a hand still in the picture` +
      (longest ? `; longest ${fx(longest.dur, 2)} s from ${fx(longest.at - (r.t0 ?? 0), 2)} s${longest.open ? ' (not back by the end)' : ''}` : '') +
      `; first pose ${fx(r.firstPoseAfter * 1000, 0)} ms after the first hand`,
  );
  if (!r.solved) return;
  out(`  palm depth: mean ${fx(r.depth.mean * 100)} cm (${fx(r.depth.min * 100)} .. ${fx(r.depth.max * 100)})`);
  out(
    `  LiDAR vs size (palm depth): LiDAR usable in ${r.lidarUsable} of ${r.solved} (${pct(r.lidarUsable, r.solved)}); ` +
      `LiDAR - size mean ${sx(r.lidarDiff.mean)} mm, median ${sx(r.lidarDiff.p50)}, spread (std) ${fx(r.lidarDiff.std)}, p10 ${sx(r.lidarDiff.p10)}, p90 ${sx(r.lidarDiff.p90)}`,
  );
  const bins = r.bins.filter((b) => b.n > 0);
  if (bins.length > 1 || (bins.length === 1 && bins[0].usable)) {
    const cell = (b) => `${b.label}: n ${b.n}, LiDAR ${b.usable}, diff ${sx(b.diff.mean)} mm (sd ${fx(b.diff.std)}), weight ${fx(b.weight.mean, 2)}`;
    out(`    by distance: ${bins.map(cell).join(' | ')}`);
  }
  out(`  lidarWeight: mean ${fx(r.lidarWeight.mean, 2)} (where usable ${fx(r.lidarWeightUsable.mean, 2)}); LiDAR palm joints per frame ${fx(r.lidarJoints.mean)}`);
  out(`  palm fit reprojection px (1920x1440): mean ${fx(r.reproj.mean)}, p90 ${fx(r.reproj.p90)}, max ${fx(r.reproj.max)}`);
  out(`  finger roots picked by: lidar ${r.roots.lidar}, history ${r.roots.history}, bend ${r.roots.bend}; no root (closest point) ${r.noRoot}`);
  const topFilled = Object.entries(r.filledJoints).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k} ${n}`).join(', ');
  out(`  joints filled from history: ${fx(r.filled.mean, 2)} per frame, in ${pct(r.filledFrames, r.solved)} of frames${topFilled ? `; most: ${topFilled}` : ''}`);
  out(
    `  bone lengths vs model: finger bones mean |diff| ${fx(r.boneErr.mean)} mm, p90 ${fx(r.boneErr.p90)}, max ${fx(r.boneErr.max)}` +
      (r.boneWorst.bone ? ` (${r.boneWorst.bone} at ${fx(r.boneWorst.t - (r.t0 ?? 0), 2)} s)` : '') +
      `; palm pairs mean ${fx(r.palmErr.mean)} mm; length wobble over time (std per bone, mean) ${fx(r.boneWobble.mean)} mm`,
  );
  const jumpText = r.jumps.length
    ? `${r.jumps.length}, largest ${fx(summ(r.jumps.map((j) => j.mm)).max, 0)} mm`
    : 'none';
  out(`  palm speed cm/s: median ${fx(r.speed.p50)}, p90 ${fx(r.speed.p90)}; jumps (> ${JUMP.minM * 100} cm between frames at > ${JUMP.minSpeed} m/s): ${jumpText}`);
  if (r.still.n) {
    const s = r.still;
    out(
      `  still hand: ${s.n} stretch${s.n > 1 ? 'es' : ''}, ${fx(s.seconds)} s; jitter mm (RMS about the mean) all ${fx(s.all, 2)} (raw ${fx(s.raw, 2)}), ` +
        `palm ${fx(s.palm, 2)} (raw ${fx(s.palmRaw, 2)}), tips ${fx(s.tips, 2)} (raw ${fx(s.tipsRaw, 2)}); frame-to-frame step median ${fx(s.step, 2)} mm`,
    );
  } else out(`  still hand: no stretch found (>= ${STILL.minS} s with the palm within ${STILL.palmR * 100} cm)`);
  out(`  tracker time on this PC ms/frame: mean ${fx(r.ms.mean, 2)}, p90 ${fx(r.ms.p90, 2)}, max ${fx(r.ms.max, 2)}`);
}

function compareLine(method, r) {
  const longest = r.drops.reduce((a, b) => Math.max(a, isNum(b.dur) ? b.dur : 0), 0);
  const cells = [
    method.padEnd(6),
    pct(r.solved, r.handFrames).padStart(7),
    String(r.held).padStart(5),
    `${r.drops.length}/${fx(longest, 2)}`.padStart(9),
    fx(r.depth.mean * 100).padStart(8),
    `${sx(r.vsSize.mean)} (${fx(r.vsSize.std)})`.padStart(14),
    fx(r.boneErr.mean).padStart(7),
    `${fx(r.still.all, 2)} (${fx(r.still.raw, 2)})`.padStart(13),
    fx(r.reproj.mean).padStart(7),
    fx(r.filled.mean, 2).padStart(7),
    String(r.jumps.length).padStart(5),
    fx(r.ms.mean, 2).padStart(6),
  ];
  return `  ${cells.join(' ')}`;
}

const COMPARE_HEAD =
  '  method  solved  held drops/s  depth cm  -size mm (sd) bone mm  jitter (raw)  reproj  filled jumps     ms';

// --- scan --------------------------------------------------------------------------------------

function reportScan(timeline, frames, recModel) {
  const withPatch = frames.filter((f) => f.frame.cam && f.frame.hands.some((h) => h.patch));
  out(`== scan (frames with depth patches: ${withPatch.length} of ${frames.length})`);
  if (!withPatch.length) {
    out('  nothing to scan (the page turns on patchEvery while scanning)');
    return;
  }
  const t0 = frames[0].frame.t;
  let sc = new HandScanner();
  let planes = null;
  let pushed = 0;
  let good = 0;
  let errors = 0;
  let maxProgress = 0;
  let last = null;
  const issues = {};
  const results = [];
  for (const item of timeline) {
    if (item.kind === 'planes') {
      if (item.planes) planes = item.planes;
      continue;
    }
    const { frame } = item.f;
    if (!frame.cam || !frame.hands.some((h) => h.patch)) continue;
    let st;
    try {
      st = sc.push(frame, planes);
    } catch (e) {
      errors++;
      if (errors === 1) out(`  scanner error at ${fx(frame.t - t0, 2)} s: ${e.message}`);
      sc = new HandScanner(); // its state may be half-updated
      continue;
    }
    pushed++;
    last = st;
    if (!st.issues.length) good++;
    for (const k of st.issues) bump(issues, k);
    if (isNum(st.progress)) maxProgress = Math.max(maxProgress, st.progress);
    if (st.state === 'done' || st.state === 'failed') {
      let res = null;
      try {
        res = sc.result();
      } catch (e) {
        res = { error: e.message };
      }
      results.push({ state: st.state, at: frame.t - t0, res });
      sc.reset(); // look for another scan in the same recording
    }
  }
  out(`  pushed ${pushed}, good ${good}; issues: ${counts(issues)}${errors ? `; scanner errors ${errors}` : ''}`);
  if (!results.length) {
    out(`  no scan finished; best progress ${fx(maxProgress * 100, 0)}%${last ? `, last state ${last.state}` : ''}`);
    return;
  }
  // the first scan in detail; further ones (the user scanned again) one line each, and how well
  // they agree with each other
  const usable = (x) => x.res && !x.res.error && x.res.model?.palm && x.res.model?.fingers;
  results.forEach((x, k) => {
    const res = x.res;
    const head = `  scan ${k + 1}: ${x.state} at ${fx(x.at, 2)} s${res?.measurements ? `, ${res.measurements.frames} frames (${res.measurements.framesUsed} used)` : ''}`;
    if (res?.error) {
      out(`${head}; result() failed: ${res.error}`);
      return;
    }
    if (!usable(x)) {
      out(`${head}; no model (too few usable frames)`);
      return;
    }
    const m = res.model;
    const cm = summaryCm(m);
    if (k > 0) {
      const issues = (res.measurements?.issues || []).join(', ') || 'none';
      if (k <= 5) out(`${head}; hand ${fx(cm.handLength)}, palm ${fx(cm.palmWidth)} x ${fx(cm.palmLength)}, thickness ${fx(cm.thickness)} cm; issues: ${issues}`);
      else if (k === 6) out(`  ... ${results.length - 6} more`);
      return;
    }
    out(head);
    const me = res.measurements || {};
    const src = me.sources || {};
    out(
      `    palm ${fx(cm.palmWidth)} wide x ${fx(cm.palmLength)} long x ${fx(cm.thickness)} thick cm, hand length ${fx(cm.handLength)} cm; ` +
        `chirality ${m.chirality} (${src.chirality ?? '?'})`,
    );
    out(`    finger lengths cm: ${FINGERS.map((f) => `${f} ${cm.fingers[f].map((v) => fx(v)).join('/')}`).join(', ')}`);
    out(`    widths cm: ${FINGERS.map((f) => `${f} ${fx(cm.fingerWidths[f])}`).join(', ')}; thickness cm: ${FINGERS.map((f) => `${f} ${fx(cm.fingerThickness[f])}`).join(', ')}`);
    const defaults = [
      ...Object.entries(src.fingerWidth || {}).filter(([, v]) => v !== 'mask').map(([f]) => `${f} width`),
      ...Object.entries(src.fingerThickness || {}).filter(([, v]) => v !== 'mask').map(([f]) => `${f} thickness`),
    ];
    out(`    sources: palm width ${src.palmWidth ?? '?'}, palm thickness ${src.palmThickness ?? '?'}${defaults.length ? `; defaults for ${defaults.join(', ')}` : ''}`);
    const tb = me.table || {};
    const sp = me.spreads || {};
    out(
      `    table ${tb.source ?? '?'} at ${fx(tb.height, 3)} m, rms ${isNum(tb.rms) ? fx(tb.rms * 1000) : '-'} mm; ` +
        `spreads (IQR cm): hand length ${fx(sp.handLength)}, palm width ${fx(sp.palmWidth)}, palm thickness ${fx(sp.palmThickness)}`,
    );
    const ch = me.chirality || {};
    out(`    Vision labels ${counts(ch.vision || {})}; geometry ${counts(ch.geometry || {})}; issues: ${(me.issues || []).join(', ') || 'none'}`);
    if (recModel && validModel(recModel)) {
      const rc = summaryCm(recModel);
      out(
        `    vs the recording's model (${recModel.source}): hand length ${sx(cm.handLength - rc.handLength)} cm, palm width ${sx(cm.palmWidth - rc.palmWidth)}, ` +
          `palm length ${sx(cm.palmLength - rc.palmLength)}, thickness ${sx(cm.thickness - rc.thickness)}`,
      );
    }
  });
  const ok = results.filter(usable).map((x) => summaryCm(x.res.model));
  if (ok.length > 1) {
    const range = (key) => {
      const v = summ(ok.map((c) => c[key]));
      return `${fx(v.p50)} (${fx(v.min)}..${fx(v.max)})`;
    };
    out(
      `  ${ok.length} scans agree within (cm, median (min..max)): hand length ${range('handLength')}, palm width ${range('palmWidth')}, ` +
        `palm length ${range('palmLength')}, thickness ${range('thickness')}`,
    );
  }
}

// --- one recording -----------------------------------------------------------------------------

function modelLine(m) {
  const c = summaryCm(m);
  return `${m.chirality}, palm ${fx(c.palmWidth)} x ${fx(c.palmLength)} cm, thickness ${fx(c.thickness)} cm, hand ${fx(c.handLength)} cm`;
}

function replay(path, args) {
  out(`hand_replay  ${basename(path)}`);
  let raw;
  try {
    const st = statSync(path);
    if (!st.isFile()) throw new Error('not a file');
    let text = readFileSync(path, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    raw = JSON.parse(text);
  } catch (e) {
    out(`  cannot read: ${e.message}`);
    return false;
  }
  const rec = normalize(raw);
  const meta = rec.meta;
  const head = [
    typeof meta.recordedAt === 'string' ? `recorded ${meta.recordedAt}` : null,
    meta.appVersion != null ? `app ${meta.appVersion}` : null,
    typeof meta.note === 'string' && meta.note ? `note "${meta.note}"` : null,
    isNum(meta.seconds) ? `${fx(meta.seconds)} s${meta.rolling > 0 && isNum(meta.attemptSeconds) && meta.attemptSeconds > meta.rolling ? ` (the last ${fx(meta.rolling)} s of ${fx(meta.attemptSeconds)} s)` : ''}` : null,
  ].filter(Boolean);
  if (head.length) out(`  ${head.join(', ')}`);
  out(
    `  ${rec.hands.length} hand events, ${rec.statuses.length} statuses, ${rec.planes.length} plane lists` +
      (rec.other ? `, ${rec.other} other events` : '') +
      (rec.junk ? `, ${rec.junk} unreadable entries` : ''),
  );

  const { frames, timeline, notes } = buildTimeline(rec);
  const { model, how } = pickModel(rec, frames);
  out(`  model: ${modelLine(model)} - ${how}`);
  if (Array.isArray(rec.planes) && rec.planes.length) {
    const lastList = rec.planes[rec.planes.length - 1].ev.planes;
    if (Array.isArray(lastList)) {
      const cls = {};
      for (const p of lastList) if (isObj(p)) bump(cls, `${p.alignment ?? '?'} ${p.class ?? '?'}`);
      const n = lastList.filter(isObj).length;
      out(`  planes (last list): ${n}${n ? ` - ${counts(cls)}` : ''}`);
    }
  }

  const sections = [
    () => reportFrames(frames, notes),
    () => reportTiming(frames),
    () => reportStatus(rec.statuses),
    () => {
      if (!frames.length) {
        out('== tracker');
        out('  no hand events to track');
        return;
      }
      const t0 = frames[0].frame.t;
      const opts = { method: args.method, predict: args.predict };
      const r = analyze(track(frames, model, opts), model);
      r.t0 = t0;
      reportTracker(r, args.method, args.predict, how.startsWith('default') ? 'default' : `${model.source ?? 'recorded'}`);
      if (args.compare) {
        out(`== compare (same frames, predict ${args.predict} s; drops = count/longest s; -size = palm depth minus the size estimate; jitter = still hand, mm)`);
        out(COMPARE_HEAD);
        for (const m of METHODS) {
          const rm = m === args.method ? r : analyze(track(frames, model, { method: m, predict: args.predict }), model);
          out(compareLine(m, rm));
        }
      }
    },
    () => reportScan(timeline, frames, meta.model),
  ];
  for (const s of sections) {
    try {
      s();
    } catch (e) {
      out(`  (this section failed: ${e.message})`);
    }
  }
  return true;
}

// --- main --------------------------------------------------------------------------------------

// exit codes: 0 = all reports printed, 1 = a file could not be read, 2 = bad arguments. Set as
// process.exitCode, not process.exit(): that could cut off output still queued for a pipe.
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.files.length && !args.errors.length)) {
    out('usage: node tools/hand_replay.mjs <recording.json> [more.json ...] [--method fused|lidar|size] [--predict s] [--compare]');
    return args.help ? 0 : 2;
  }
  if (args.errors.length) {
    for (const e of args.errors) out(`error: ${e}`);
    return 2;
  }
  let ok = true;
  args.files.forEach((f, i) => {
    if (i) out();
    if (!existsSync(f)) {
      out(`hand_replay  ${f}`);
      out('  no such file');
      ok = false;
      return;
    }
    ok = replay(f, args) && ok;
  });
  return ok ? 0 : 1;
}

process.exitCode = main();
