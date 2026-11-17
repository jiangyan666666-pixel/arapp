// Stage 3 on-device check: "the hand enters the AR picture". A step-by-step guide on top of the
// live AR picture, with the same look and mechanics as the stage-2 check (check2.js):
//   0 准备            which hand holds the phone; a link to the stage-2 check
//   1 用尺子量手      palm width, hand length, palm thickness of the other hand (cm)
//   2 扫描手          the scan (hand/scan.js via HandSession.startScan), scanned vs ruler
//   3 认得出手吗      six 5-s sub-steps: how often Vision sees a hand (also when there is none)
//   4 远近准吗        hand flat on the table, phone 20 → 60 cm: back-of-hand height per method
//   5 位置准吗        index fingertip on a ruler at 0 / 10 / 20 cm: distances per method
//   6 跟得上吗        the model with every look / switch; latency, Vision time, rate, heat; 5-s recording
//   7 实物挡家具      a 25 cm shelf on the table: does the hand hide it; touch -> vibrate + tint
//   8 后台 1 分钟      does the page survive the app being in the background
//   9 结果            every answer; "did the hand enter the picture?"; then a free mode
// The tool shows its own facts; there is no pass / fail verdict on screen – the user decides.
// Every answer is saved on the phone (localStorage 'arapp/stage3-check/v1', so a reload resumes)
// and sent to the PC as the log line "stage3-check". The scanned hand model is saved (hand/model.js)
// and logged. Hand sizes are not blind. This is a check, not a trial: no trial furniture is shown.
// The page needs the stage-3 app (features 'hands' and 'groups'); with an older app it says so and
// does nothing else.

import { callNative, hasAR, hasFeature, hasNative, nativeInfo, versionLabel } from './native.js';
import { forwardErrors, log } from './log.js';
import * as AR from './ar.js';
import { furnitureBoxesForNative } from './furniture-spec.js';
import { HandSession, METHODS } from './hand/session.js';
import { HandView, LOOKS, SHELLS, planeUnder, rowBox } from './hand/view.js';
import { HandRecorder } from './hand/recorder.js';
import { defaultModel, loadModel, saveModel, summaryCm } from './hand/model.js';
import { J } from './hand/joints.js';
import { add, sub, scale, dot, cross, len, norm, dist, mean, quatRotate, camPosition } from './hand/geom.js';
import { palmBoxCentre } from './hand/pose.js';

forwardErrors();

const $ = (id) => document.getElementById(id);
const KEY = 'arapp/stage3-check/v1';
/** Different on every load of the page: step 8 tells "the page stayed" from "the page was reloaded". */
const LOAD_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const HANDS = hasFeature('hands') && hasFeature('groups');

const SHELF_ID = 'small-shelf';
const SHELF_K = 0.3125; // the stage-2 shelf (80 cm wide) scaled down uniformly: 25 cm wide
const SHELF_SIZE = [0.8 * SHELF_K, 1.8 * SHELF_K, 0.3 * SHELF_K];
const SHELF_BOXES = furnitureBoxesForNative('shelf', 0.8).map((b) => ({ ...b, size: b.size.map((v) => v * SHELF_K), position: b.position.map((v) => v * SHELF_K) }));
const TOUCH_TINT = [0.92, 0.32, 0.26];
const BUZZ_EVERY_MS = 400;

const DEFAULT_SETTINGS = { look: 'translucent', shell: 1, overlay: 'off', shadow: true, method: 'fused', predict: 'auto' };

/** h('button', {class: 'primary', onclick: fn}, 'text', child…) */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}
const p = (...c) => h('p', {}, ...c);
const line = (text, cls = '') => h('div', { class: `line ${cls}` }, text);
const q = (text) => h('div', { class: 'q' }, text);
const row = (...c) => h('div', { class: 'row' }, ...c);
function table(head, rows) {
  return h('table', {}, h('tr', {}, ...head.map((x) => h('th', {}, x))), ...rows.map((r) => h('tr', {}, ...r.map((x) => h('td', {}, x ?? '—')))));
}

// numbers on screen: cm with one decimal
const cm = (m) => (m == null || !Number.isFinite(m) ? '—' : (m * 100).toFixed(1));
/** One decimal with its sign; a value that rounds to zero is plain 0.0. */
function signed1(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  const s = Math.abs(v).toFixed(1);
  return s === '0.0' ? s : `${v > 0 ? '+' : '−'}${s}`;
}
const signedCm = (m) => (m == null || !Number.isFinite(m) ? '—' : signed1(m * 100));
const pct = (v) => (v == null || !Number.isFinite(v) ? '—' : `${Math.round(v * 100)}%`);
const r1 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
const r3 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000);

const HAND_NAME = { left: '左手', right: '右手' };
const METHOD_NAME = { lidar: 'LiDAR', size: '大小', fused: '合起来' };
const METHODS_SHOWN = ['lidar', 'size', 'fused'];
const LOOK_NAME = { translucent: '半透明', solid: '实心', edges: '线框', occluder: '当遮挡', off: '不显示' };
const THERMAL = { nominal: '正常', fair: '有点热', serious: '热', critical: '很热' };

// --- state: what survives a reload (st) and what does not (rt) ---

function loadState() {
  const fresh = { step: 0, answers: {}, startedAt: new Date().toISOString(), phoneHand: null, ruler: null, scan: null, detect: {}, depth: null, marks: {}, bg: null, recordings: [], settings: { ...DEFAULT_SETTINGS } };
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s && typeof s === 'object' && s.answers) return { ...fresh, ...s, settings: { ...DEFAULT_SETTINGS, ...(s.settings || {}) } };
  } catch {
    /* nothing saved, or storage blocked */
  }
  return fresh;
}
const st = loadState();
function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(st));
  } catch {
    /* storage blocked: the answers still go to the PC */
  }
}

/** The hand that is measured: the one that does not hold the phone. */
const scanHand = () => (st.phoneHand === 'right' ? 'left' : 'right');

const rt = {
  arOn: false,
  starting: false,
  startError: '',
  handsError: '',
  startInfo: null,
  status: null,
  meshOcclusion: true, // real objects hide the furniture: part of the tool since stage 2
  drafts: {}, // text typed into inputs, so a re-render keeps it
  prep: null,
  scanning: false,
  scanFail: '',
  detectIdx: null,
  detectRun: null, // {id, phase: 'ready' | 'measure', until, win, timers}
  depthRec: null, // {samples: [{d, h: {method: height}}]}
  shelf: null, // {position, yaw}
  placing: false,
  busy: false,
  touchOn: false,
  touching: false,
  lastBuzz: 0,
  recorder: null,
  recording: false,
  recLine: '',
  recOk: false,
  sendLine: '',
  interruptions: 0,
  bgBusy: false,
};
if (st.ruler) for (const k of ['palmWidth', 'handLength', 'thickness']) if (st.ruler[k] != null) rt.drafts[`ruler:${k}`] = String(st.ruler[k]);

// --- the hand: model, view, session ---

let model = loadModel() || defaultModel(scanHand());
const view = new HandView({ ar: AR, overlayCanvas: $('overlay'), personOcclusion: true });
const session = new HandSession({
  ar: AR,
  model,
  view,
  trackerOptions: { method: st.settings.method, predict: st.settings.predict === 'auto' ? 'auto' : 0 },
  onFrame,
});

function modelSummary() {
  return { source: model.source, chirality: model.chirality, cm: summaryCm(model) };
}

async function useModel(m) {
  model = m;
  session.setModel(m);
  await view.setModel(m);
}

/** What the view shows in this step (the user's choices, except where the step needs otherwise). */
function wantedView() {
  const s = step();
  const set = st.settings;
  if (s.id === 'scan' && (rt.scanning || !st.scan)) return { look: 'off', overlay: 'joints', shadow: false, shell: set.shell };
  if (s.id === 'occl') return { look: 'off', overlay: 'off', shadow: false, shell: 1 };
  return { look: set.look, shell: set.shell, overlay: set.overlay, shadow: set.shadow };
}

async function applyView() {
  session.setCompare(['depth', 'pos'].includes(step().id));
  if (!rt.arOn) return;
  try {
    await view.set(wantedView());
  } catch (e) {
    toast(String(e.message || e));
  }
}

async function setSetting(o) {
  Object.assign(st.settings, o);
  save();
  session.setOptions({ method: st.settings.method, predict: st.settings.predict === 'auto' ? 'auto' : 0 });
  await applyView();
  log('stage3: settings', { ...st.settings });
  render();
}

// --- AR ---

const TRACKING = {
  normal: '跟踪正常',
  initializing: '正在初始化：慢慢移动手机',
  excessiveMotion: '动得太快了',
  insufficientFeatures: '看不清：太暗，或画面太空',
  relocalizing: '正在重新定位',
  notAvailable: '跟踪不可用',
  limited: '跟踪受限',
};
const START_ERRORS = {
  'camera-denied': '相机权限没有打开。到 iPhone 的「设置 → App → ARApp」里打开「相机」，回到这里再点一次。',
  'ar-unsupported': '这台设备不支持 AR。',
};

async function ensureAR() {
  if (rt.arOn || rt.starting) return rt.arOn;
  if (!HANDS) return false;
  rt.starting = true;
  rt.startError = '';
  rt.handsError = '';
  render();
  try {
    const info = await AR.start({ meshOcclusion: rt.meshOcclusion, personOcclusion: true });
    rt.arOn = true;
    rt.startInfo = info;
    rt.shelf = null; // a start with reset removes every group
    rt.touching = false;
    document.documentElement.classList.add('ar');
    log('stage3: ar started', info);
  } catch (e) {
    const code = String(e.message || e);
    rt.startError = START_ERRORS[code] || code;
    log('stage3: ar start failed', { error: code }, 'error');
  }
  if (rt.arOn) {
    // groups only after the start has resolved; then hand tracking
    try {
      view.personOcclusion = true;
      await view.init(model);
      await applyView();
      const r = await session.start();
      log('stage3: hands on', { config: r.config, available: r.available });
      if (r.available === false) rt.handsError = '这台手机上认手用不了（Vision 不可用）。';
      session.refreshPlanes();
    } catch (e) {
      rt.handsError = `认手打不开：${e.message || e}`;
      log('stage3: hands failed', { error: String(e.message || e) }, 'error');
    }
  }
  rt.starting = false;
  if (step().id === 'occl' && !rt.shelf) rt.placing = true;
  render();
  return rt.arOn;
}

AR.onStatus((s) => {
  rt.status = s;
  updateHud();
});
AR.onError((e) => {
  rt.arOn = false;
  document.documentElement.classList.remove('ar');
  rt.startError = `AR 出错了：${e.message}（${e.code}）`;
  render();
});
AR.onInterrupted((e) => {
  if (e.interrupted) rt.interruptions++;
  toast(e.interrupted ? 'AR 暂停了（app 不在前台）' : 'AR 继续', 2000);
});

let toastTimer = 0;
function toast(text, ms = 3000) {
  $('toast').textContent = text;
  $('toast').classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.add('hidden'), ms);
}

function updateHud() {
  const on = rt.arOn;
  for (const id of ['hud-track', 'hud-hand', 'hud-occ']) $(id).classList.toggle('hidden', !on);
  if (!on) return;
  const s = rt.status;
  $('hud-track').textContent = s ? TRACKING[s.tracking] || s.tracking : '等相机…';
  $('hud-track').classList.toggle('warn', Boolean(s) && s.tracking !== 'normal');
  const pose = session.pose;
  const seen = session.frame?.hands?.length > 0;
  const fresh = session.stats().rate > 0;
  const hand = $('hud-hand');
  if (!session.running || !fresh) hand.textContent = '手：没在认';
  else if (pose && !pose.quality?.held) hand.textContent = `手：认到了`;
  else hand.textContent = seen ? '手：看到了，没对上' : '手：没看到';
  hand.classList.toggle('good', Boolean(fresh && pose && !pose.quality?.held));
  hand.classList.toggle('warn', !(fresh && pose && !pose.quality?.held));
  $('hud-occ').textContent = `实物挡家具：${rt.meshOcclusion ? '开' : '关'}`;
  $('hud-occ').classList.toggle('on', rt.meshOcclusion);
}

async function setMeshOcclusion(on) {
  rt.meshOcclusion = on;
  try {
    await AR.setOptions({ meshOcclusion: on });
    log('stage3: mesh occlusion', { on });
  } catch (e) {
    toast(String(e.message || e));
  }
  render();
}

// --- every hand event (after the session has tracked it) ---

function palmCentre(pose) {
  return add(pose.palm.origin, quatRotate(pose.palm.rotation, palmBoxCentre(model, pose.chirality)));
}

/** Height of the back of the hand (over the palm's centre) above the plane. */
function backHeight(pose, plane) {
  const top = add(palmCentre(pose), scale(pose.palm.y, model.palm.thickness / 2));
  return dot(sub(top, plane.p), plane.n);
}

function onFrame(frame, pose, extra) {
  const id = step().id;
  if (id === 'depth' && rt.depthRec && extra.poses) sampleDepth(frame, extra.poses);
  if (id === 'occl' && rt.touchOn) checkTouch(pose);
}

// --- answers ---

/** What the app saw at the moment of an answer – evidence to go with it. */
function context() {
  const s = rt.status;
  const k = session.stats();
  return {
    tracking: s?.tracking ?? null,
    thermal: s?.thermal ?? null,
    fps: s?.fps ?? null,
    meshOcclusion: rt.meshOcclusion,
    settings: { ...st.settings },
    hands: { rate: k.rate, handShare: k.handShare, poseShare: k.poseShare, visionMs: k.visionMs, webMs: k.webMs, latency: k.latency, predictS: r3(k.predictS) },
  };
}

function report() {
  return log('stage3-check', {
    answers: st.answers,
    phoneHand: st.phoneHand,
    ruler: st.ruler,
    scan: st.scan,
    model: modelSummary(),
    detect: st.detect,
    depth: st.depth,
    marks: st.marks,
    distances: markDistances(),
    recordings: st.recordings,
    bg: st.bg,
    settings: st.settings,
    startedAt: st.startedAt,
    start: rt.startInfo,
    native: nativeInfo,
    ua: navigator.userAgent,
  });
}

function answer(id, value, { stay = false, extra = {} } = {}) {
  const note = (rt.drafts[`note:${id}`] || '').trim();
  st.answers[id] = { value, at: new Date().toISOString(), ...(note ? { note } : {}), ...extra, ...(rt.arOn ? context() : {}) };
  save();
  report();
  if (stay) render();
  else go(st.step + 1);
}

function choices(id, options, opts) {
  const current = st.answers[id]?.value;
  return options.map(([value, label]) => h('button', { class: current === value ? 'chosen' : '', onclick: () => answer(id, value, opts) }, label));
}

function input(key, attrs, oninput) {
  const el = h('input', {
    ...attrs,
    oninput: () => {
      rt.drafts[key] = el.value;
      oninput?.();
    },
  });
  el.value = rt.drafts[key] ?? '';
  return el;
}
const noteInput = (id) => input(`note:${id}`, { type: 'text', placeholder: '备注（可不填。先写，再点答案）' });
const num = (key) => {
  const v = parseFloat(rt.drafts[key]);
  return Number.isFinite(v) ? v : null;
};

/** A switch: a small label, then its choices in one row. */
function seg(label, options, current, onpick) {
  return h(
    'div',
    { class: 'seg' },
    h('div', { class: 'seg-label' }, label),
    h('div', { class: 'row' }, ...options.map(([v, text]) => h('button', { class: v === current ? 'chosen' : '', onclick: () => onpick(v) }, text))),
  );
}

/** The step-6 switches (also in the free mode of step 9). */
function switches() {
  const set = st.settings;
  return [
    seg('样子', LOOKS.map((l) => [l, LOOK_NAME[l]]), set.look, (v) => setSetting({ look: v })),
    seg('壳（模型放大）', SHELLS.map((s) => [s, s === 1 ? '1.0' : String(s)]), set.shell, (v) => setSetting({ shell: v })),
    seg('画在网页层', [['off', '不画'], ['joints', '关节'], ['boxes', '方块']], set.overlay, (v) => setSetting({ overlay: v })),
    seg('影子', [[true, '开'], [false, '关']], set.shadow, (v) => setSetting({ shadow: v })),
    seg('定远近', [['fused', '合起来'], ['lidar', 'LiDAR'], ['size', '大小']], set.method, (v) => setSetting({ method: v })),
    seg('预测', [['off', '关'], ['auto', '按延迟']], set.predict, (v) => setSetting({ predict: v })),
  ];
}

// --- step 2: the scan ---

async function startScan() {
  if (!rt.arOn || rt.scanning) return;
  rt.scanning = true;
  rt.scanFail = '';
  await applyView();
  render();
  log('stage3: scan started', { hand: scanHand() });
  const r = await session.startScan({ timeoutS: 60 });
  rt.scanning = false;
  if (r.ok) {
    const saved = saveModel(r.model);
    await useModel(r.model);
    const m = r.measurements;
    st.scan = { at: new Date().toISOString(), cm: summaryCm(r.model), chirality: r.model.chirality, sources: m.sources, issues: m.issues, table: m.table, frames: m.frames, spreads: m.spreads };
    save();
    log('stage3: hand scanned', { model: r.model, measurements: m, saved });
    toast('量好了');
  } else {
    rt.scanFail = r.reason === 'stopped' ? '' : r.reason === 'timeout' ? '一分钟还没扫好' : r.status?.hint || '没量好';
    log('stage3: scan ended', { reason: r.reason, status: r.status ?? null });
  }
  await applyView();
  render();
}

/** Which numbers of the scan are estimates (not measured), in words. */
function estimatedWords(sources) {
  if (!sources) return [];
  const F = { thumb: '拇指', index: '食指', middle: '中指', ring: '无名指', little: '小指' };
  const out = [];
  if (sources.palmWidth && sources.palmWidth !== 'mask') out.push('手掌宽（按指根估的）');
  if (sources.palmThickness === 'default') out.push('手掌厚');
  const ft = Object.entries(sources.fingerThickness || {}).filter(([, v]) => v === 'default').map(([f]) => F[f]);
  const fw = Object.entries(sources.fingerWidth || {}).filter(([, v]) => v === 'default').map(([f]) => F[f]);
  if (ft.length) out.push(`${ft.join('、')}的厚`);
  if (fw.length) out.push(`${fw.join('、')}的宽`);
  return out;
}

const RULER_ROWS = [
  ['palmWidth', '手掌宽'],
  ['handLength', '手长'],
  ['thickness', '手掌厚'],
];

/** Scanned minus ruler, cm (one decimal). */
function scanDiff() {
  if (!st.scan || !st.ruler) return null;
  return Object.fromEntries(RULER_ROWS.map(([k]) => [k, st.ruler[k] == null ? null : r1(st.scan.cm[k] - st.ruler[k])]));
}

function scanResult() {
  const s = st.scan.cm;
  const r = st.ruler || {};
  const est = estimatedWords(st.scan.sources);
  return [
    table(
      ['', '扫描', '尺子', '差'],
      RULER_ROWS.map(([k, name]) => [name, s[k].toFixed(1), r[k] == null ? '—' : Number(r[k]).toFixed(1), r[k] == null ? '—' : signed1(s[k] - r[k])]),
    ),
    line('单位 cm。差 = 扫描 − 尺子。', 'muted'),
    line(est.length ? `这些是估的（没量到，用的常见值）：${est.join('；')}` : '全部是量出来的，没有估的。', est.length ? 'warnc' : 'okc'),
    line(`扫到的是${HAND_NAME[st.scan.chirality] || '?'}${st.scan.chirality !== scanHand() ? `（你说扫的是${HAND_NAME[scanHand()]}）` : ''}`, st.scan.chirality !== scanHand() ? 'badc' : ''),
  ];
}

// --- step 3: does it see a hand ---

const SUBS = [
  { id: 'in', short: '伸进', label: '手伸进画面', how: '把手伸到手机前面，随便动一动。' },
  { id: 'out', short: '拿开', label: '手拿开', how: '手放到画面外面，只拍桌子。' },
  { id: 'legs', short: '腿脚', label: '低头让腿脚进画面', how: '手机朝下拍自己的腿和脚，手不要进画面。' },
  { id: 'pinch', short: '捏', label: '捏', how: '大拇指和食指捏在一起，再松开，反复做。' },
  { id: 'push', short: '推', label: '推（手掌朝前）', how: '手掌朝着手机，像推门一样，前后动。' },
  { id: 'flat', short: '摊平', label: '摊平', how: '手平放在桌上，手心朝下，别动。' },
];
const READY_MS = 2000;
const MEASURE_MS = 5000;

function cancelDetect() {
  const d = rt.detectRun;
  if (!d) return;
  for (const t of d.timers) clearTimeout(t);
  d.win?.stop();
  rt.detectRun = null;
}

function runDetect(sub) {
  if (rt.detectRun || !rt.arOn) return;
  const d = { id: sub.id, phase: 'ready', until: performance.now() + READY_MS, win: null, timers: [] };
  rt.detectRun = d;
  d.timers.push(
    setTimeout(() => {
      d.phase = 'measure';
      d.until = performance.now() + MEASURE_MS;
      d.win = session.window();
      updateLive();
    }, READY_MS),
    setTimeout(() => {
      const res = d.win.stop();
      st.detect[sub.id] = { ...res, at: new Date().toISOString() };
      save();
      log('stage3: detect', { id: sub.id, ...res });
      rt.detectRun = null;
      const next = SUBS.findIndex((s) => !st.detect[s.id]);
      rt.detectIdx = next >= 0 ? next : SUBS.indexOf(sub);
      render();
    }, READY_MS + MEASURE_MS),
  );
  render();
}

function detectTable() {
  return table(
    ['', '认到手', '对上', '左 / 右', '把握'],
    SUBS.map((s) => {
      const r = st.detect[s.id];
      if (!r) return [s.label, '—', '—', '—', '—'];
      return [s.label, pct(r.handShare), pct(r.poseShare), `${r.chirality.left} / ${r.chirality.right}`, pct(r.meanConfidence)];
    }),
  );
}

// --- step 4: distance ---

const BINS = [
  [0.2, 0.3],
  [0.3, 0.4],
  [0.4, 0.5],
  [0.5, 0.6],
];

/** The live numbers of step 4 from the latest compare poses, or null without a hand. */
function depthLive() {
  const P = session.poses;
  const frame = session.frame;
  if (!P?.fused || P.fused.quality?.held || !frame?.cam) return null;
  const c = palmCentre(P.fused);
  const plane = planeUnder(session.planes, c);
  const out = { distance: dist(camPosition(frame.cam), c), plane, h: {} };
  if (plane) for (const m of METHODS) if (P[m] && !P[m].quality?.held) out.h[m] = backHeight(P[m], plane);
  return out;
}

function sampleDepth(frame, P) {
  if (!P.fused || P.fused.quality?.held || !frame.cam) return;
  const c = palmCentre(P.fused);
  const plane = planeUnder(session.planes, c);
  if (!plane) return;
  const h = {};
  for (const m of METHODS) if (P[m] && !P[m].quality?.held) h[m] = backHeight(P[m], plane);
  rt.depthRec.samples.push({ d: dist(camPosition(frame.cam), c), h });
}

function binOf(d) {
  return BINS.findIndex(([a, b]) => d >= a && d < b);
}

function toggleDepthRec() {
  if (!rt.depthRec) {
    rt.depthRec = { samples: [], at: new Date().toISOString() };
    render();
    return;
  }
  const samples = rt.depthRec.samples;
  rt.depthRec = null;
  const T = model.palm.thickness;
  const bins = BINS.map(([a, b]) => {
    const inBin = samples.filter((s) => s.d >= a && s.d < b);
    const per = {};
    for (const m of METHODS) {
      const v = inBin.map((s) => s.h[m]).filter((x) => x != null).map((x) => x - T);
      per[m] = v.length ? { mean: r1(mean(v) * 100), min: r1(Math.min(...v) * 100), max: r1(Math.max(...v) * 100), n: v.length } : null;
    }
    return { from: Math.round(a * 100), to: Math.round(b * 100), n: inBin.length, ...per };
  });
  st.depth = { at: new Date().toISOString(), thickness_cm: r1(T * 100), thicknessFrom: model.source, samples: samples.length, bins };
  save();
  log('stage3: depth bins', st.depth);
  render();
}

function depthTable(d) {
  const cell = (c) => (c ? h('div', {}, h('div', {}, signed1(c.mean)), h('div', { class: 'muted' }, `${signed1(c.min)}…${signed1(c.max)}`)) : '—');
  return [
    table(['离手', ...METHODS_SHOWN.map((m) => METHOD_NAME[m])], d.bins.map((b) => [`${b.from}–${b.to}`, ...METHODS_SHOWN.map((m) => cell(b[m]))])),
    line(`手背高 − 手厚（${d.thickness_cm} cm），单位 cm：平均，下面是最小…最大。应该接近 0。`, 'muted'),
  ];
}

// --- step 5: positions on a ruler ---

const MARKS = [0, 10, 20];

function mark(v) {
  const entry = { at: new Date().toISOString() };
  let any = false;
  for (const m of METHODS) {
    const tips = session.recent(m, 0.3).map((pose) => pose.joints[J.indexTip]);
    if (!tips.length) {
      entry[m] = null;
      continue;
    }
    any = true;
    entry[m] = [0, 1, 2].map((k) => Math.round(mean(tips.map((t) => t[k])) * 1e4) / 1e4); // 0.1 mm
    entry[`n_${m}`] = tips.length;
  }
  if (!any) {
    toast('没认到食指尖：手要在画面里');
    return;
  }
  st.marks[v] = entry;
  save();
  log('stage3: ruler mark', { at_cm: v, ...entry });
  render();
}

/** Distances between the marks per method (cm). */
function markDistances() {
  const out = {};
  for (const m of METHODS) {
    const P = (v) => st.marks?.[v]?.[m] || null;
    const d = (a, b) => (P(a) && P(b) ? r1(dist(P(a), P(b)) * 100) : null);
    out[m] = { '0-10': d(0, 10), '10-20': d(10, 20), '0-20': d(0, 20) };
  }
  return out;
}

function marksTable() {
  const D = markDistances();
  const f = (v) => (v == null ? '—' : v.toFixed(1));
  return [
    table(
      ['', '0→10', '10→20', '0→20'],
      [...METHODS_SHOWN.map((m) => [METHOD_NAME[m], f(D[m]['0-10']), f(D[m]['10-20']), f(D[m]['0-20'])]), ['应该是', '10.0', '10.0', '20.0']],
    ),
    line('单位 cm：两次记下之间食指尖挪了多远。', 'muted'),
  ];
}

// --- step 6: the 5-s recording ---

async function record5() {
  if (rt.recording || !rt.arOn) return;
  rt.recording = true;
  rt.recLine = '';
  render();
  rt.recorder = rt.recorder || new HandRecorder({ ar: AR });
  try {
    rt.recorder.start({ note: 'check3', maxSeconds: 5, model });
  } catch (e) {
    rt.recording = false;
    rt.recLine = String(e.message || e);
    render();
    return;
  }
  const r = await rt.recorder.done;
  rt.recording = false;
  rt.recOk = r.ok;
  rt.recLine = r.ok ? `录好了：${r.name}（${r.count} 帧）` : `没发出去：${r.error}`;
  if (r.ok) {
    st.recordings.push({ name: r.name, count: r.count, at: new Date().toISOString(), settings: { ...st.settings } });
    save();
  }
  log('stage3: recorded', { ok: r.ok, name: r.name ?? null, count: r.count, error: r.error ?? null });
  render();
}

async function resend() {
  if (!rt.recorder) return;
  const r = await rt.recorder.upload();
  rt.recOk = r.ok;
  rt.recLine = r.ok ? `录好了：${r.name}（${r.count} 帧）` : `还是没发出去：${r.error}`;
  if (r.ok) {
    st.recordings.push({ name: r.name, count: r.count, at: new Date().toISOString(), settings: { ...st.settings } });
    save();
  }
  render();
}

// --- step 7: the small shelf, occlusion and touch ---

$('tap').addEventListener('click', async (e) => {
  if (!rt.arOn || !rt.placing || rt.busy || step().id !== 'occl') return;
  rt.busy = true;
  try {
    const hit = await AR.raycastFloor(e.clientX / window.innerWidth, e.clientY / window.innerHeight);
    const camera = hit?.camera || rt.status?.camera;
    if (!hit || !camera) {
      toast('这里没找到桌面。慢慢移动手机让它看到桌面，再点一次');
      log('stage3: tap found no surface');
    } else {
      const eye = AR.cameraPosition(camera);
      const yaw = AR.yawToFace(hit.position, eye); // front towards the person
      await AR.setGroup(SHELF_ID, SHELF_BOXES, { position: hit.position, yaw, anchored: true, shadow: true });
      rt.shelf = { position: hit.position, yaw };
      rt.touching = false;
      rt.placing = false;
      log('stage3: small shelf placed', {
        how: hit.how,
        plane: hit.plane ?? null,
        belowCamera_m: Math.round((eye[1] - hit.position[1]) * 100) / 100,
        distance_m: Math.round(Math.hypot(eye[0] - hit.position[0], eye[2] - hit.position[2]) * 100) / 100,
      });
    }
  } catch (err) {
    toast(`放书架失败：${err.message || err}`);
    log('stage3: shelf failed', { error: String(err.message || err) }, 'error');
  }
  rt.busy = false;
  render();
});

/** The shelf's box now: where ARKit has the anchored group (after its corrections), else where it was put. */
function shelfBox() {
  const T = rt.status?.groups?.[SHELF_ID]?.transform;
  let o;
  let x;
  let y;
  let z;
  if (Array.isArray(T) && T.length === 16) {
    o = [T[12], T[13], T[14]];
    x = norm([T[0], T[1], T[2]]);
    y = norm([T[4], T[5], T[6]]);
    z = norm([T[8], T[9], T[10]]);
  } else {
    const { position, yaw } = rt.shelf;
    o = position;
    x = [Math.cos(yaw), 0, -Math.sin(yaw)];
    y = [0, 1, 0];
    z = [Math.sin(yaw), 0, Math.cos(yaw)];
  }
  return { c: add(o, scale(y, SHELF_SIZE[1] / 2)), x, y, z, h: SHELF_SIZE.map((v) => v / 2) };
}

/** Two boxes {c, x, y, z (unit axes), h (half sizes)} overlap (separating axis test). */
function boxesOverlap(A, B) {
  const ax = [A.x, A.y, A.z];
  const bx = [B.x, B.y, B.z];
  const axes = [...ax, ...bx];
  for (const u of ax) {
    for (const v of bx) {
      const c = cross(u, v);
      if (len(c) > 1e-6) axes.push(norm(c));
    }
  }
  const d = sub(B.c, A.c);
  for (const L of axes) {
    const ra = A.h[0] * Math.abs(dot(ax[0], L)) + A.h[1] * Math.abs(dot(ax[1], L)) + A.h[2] * Math.abs(dot(ax[2], L));
    const rb = B.h[0] * Math.abs(dot(bx[0], L)) + B.h[1] * Math.abs(dot(bx[1], L)) + B.h[2] * Math.abs(dot(bx[2], L));
    if (Math.abs(dot(d, L)) > ra + rb) return false;
  }
  return true;
}

function setShelfTint(on) {
  AR.updateGroups([{ id: SHELF_ID, boxes: SHELF_BOXES.map((b, i) => ({ i, color: on ? TOUCH_TINT : b.color })) }]);
}

function checkTouch(pose) {
  if (!rt.shelf) return;
  const rows = pose && !pose.quality?.held ? view.lastRows : null;
  let touching = false;
  if (rows) {
    const shelf = shelfBox();
    touching = rows.some((r) => boxesOverlap(rowBox(r), shelf));
  }
  if (touching !== rt.touching) {
    rt.touching = touching;
    setShelfTint(touching);
    updateLive();
  }
  const now = performance.now();
  if (touching && now - rt.lastBuzz >= BUZZ_EVERY_MS) {
    rt.lastBuzz = now;
    AR.haptic({ kind: 'impact', style: 'medium' });
  }
}

function setTouch(on) {
  rt.touchOn = on;
  if (!on && rt.touching) {
    rt.touching = false;
    if (rt.shelf) setShelfTint(false);
  }
  log('stage3: touch reaction', { on });
  render();
}

// --- step 8: one minute in the background ---

function startBg() {
  st.bg = { loadId: LOAD_ID, at: Date.now(), hiddenAt: null, backAt: null };
  delete st.answers.bgAuto;
  delete st.answers.bg;
  save();
  render();
}

/** After coming back (or after a reload): record what survived. */
async function recordBg(reloaded) {
  if (!st.bg || st.answers.bgAuto || rt.bgBusy) return;
  rt.bgBusy = true;
  const backAt = st.bg.backAt || Date.now();
  let arRunning = null;
  try {
    arRunning = Boolean((await AR.state()).running);
  } catch {
    arRunning = false;
  }
  // hand events still coming from the native layer? (counted raw: after a reload nothing listens yet)
  let n = 0;
  const off = AR.onHands(() => n++);
  await new Promise((r) => setTimeout(r, 1500));
  off();
  const auto = {
    value: 'auto',
    reloaded,
    awaySeconds: st.bg.hiddenAt ? Math.round((backAt - st.bg.hiddenAt) / 1000) : null,
    arRunning,
    handsRate: Math.round((n / 1.5) * 10) / 10,
    interruptions: rt.interruptions,
    at: new Date().toISOString(),
  };
  st.answers.bgAuto = auto;
  save();
  report();
  rt.bgBusy = false;
  log('stage3: background', auto);
  render();
}

document.addEventListener('visibilitychange', () => {
  if (!st.bg || st.answers.bgAuto || step().id !== 'bg') return;
  if (document.visibilityState === 'hidden') {
    if (!st.bg.hiddenAt) {
      st.bg.hiddenAt = Date.now();
      save();
    }
  } else if (st.bg.hiddenAt) {
    st.bg.backAt = Date.now();
    save();
    setTimeout(() => recordBg(false), 1000);
  }
});

// --- steps ---

function needApp() {
  if (HANDS) return null;
  if (!hasNative) return line('这一页要在 app 里打开（现在没有原生层）。', 'badc');
  if (!hasAR) return line('手机上的 app 是旧版，还没有 AR。先装新版本，再来做这个检查。', 'badc');
  return line('手机上的 app 还是阶段 2 的版本，不会认手。先装新版本（阶段 3），再来做这个检查。', 'badc');
}

function arBlock() {
  // shown in AR steps while the camera is not running
  if (!HANDS) return [needApp()];
  if (rt.starting) return [line('正在打开相机…')];
  return [rt.startError && line(rt.startError, 'badc'), h('button', { class: 'primary', onclick: ensureAR }, '打开相机')];
}

const handsProblem = () => rt.handsError && line(rt.handsError, 'badc');
const thicknessNote = () => (model.source === 'scan' ? '' : '（还没扫描，用的是常见值）');

async function setPhoneHand(hand) {
  st.phoneHand = hand;
  save();
  if (model.source !== 'scan') await useModel(defaultModel(scanHand()));
  log('stage3: phone hand', { phoneHand: hand });
  render();
}

function saveRuler() {
  const v = Object.fromEntries(RULER_ROWS.map(([k]) => [k, num(`ruler:${k}`)]));
  const ok = v.palmWidth >= 4 && v.palmWidth <= 14 && v.handLength >= 10 && v.handLength <= 30 && v.thickness >= 0.8 && v.thickness <= 6;
  if (!ok) {
    toast('先填三个数（厘米）：手掌宽 4–14，手长 10–30，手掌厚 0.8–6');
    return;
  }
  st.ruler = { palmWidth: v.palmWidth, handLength: v.handLength, thickness: v.thickness, hand: scanHand() };
  save();
  answer('ruler', 'done', { extra: { ...st.ruler } });
}

function nextButton(label = '下一步', noteId = null) {
  return h(
    'button',
    {
      class: 'primary',
      onclick: () => {
        const note = noteId ? (rt.drafts[`note:${noteId}`] || '').trim() : '';
        if (note) {
          st.answers[`${noteId}Note`] = { note, at: new Date().toISOString() };
          save();
          report();
        }
        go(st.step + 1);
      },
    },
    label,
  );
}

const ACC = [
  ['ok', '准'],
  ['some', '不太准'],
  ['bad', '不准'],
];

const STEPS = [
  {
    id: 'prep',
    title: '准备',
    text: () => [
      p('这个检查看：手能不能「进到」AR 画面里。先量你的手，再看手的模型跟不跟得上真手。'),
      p('要用到：一把尺子或卷尺，一张桌子。大约 5 分钟。'),
      p('一只手拿手机，另一只手来做。'),
    ],
    controls: () => {
      const c = rt.prep;
      return [
        needApp(),
        c && line(c.webLog ? '电脑能收到这一页的日志 ✓' : `电脑收不到日志：${c.webLogError}`, c.webLog ? 'okc' : 'badc'),
        c?.native && line(c.native.startupLogOK ? `电脑收到了 app 的启动日志 ✓（还在排队的日志：${c.native.logPending ?? 0} 条）` : `app 的启动日志还没送到：${c.native.startupLog}`, c.native.startupLogOK ? 'okc' : 'badc'),
        q('哪只手拿手机？'),
        row(
          h('button', { class: st.phoneHand === 'left' ? 'chosen' : '', onclick: () => setPhoneHand('left') }, '左手拿手机'),
          h('button', { class: st.phoneHand === 'right' ? 'chosen' : '', onclick: () => setPhoneHand('right') }, '右手拿手机'),
        ),
        h('button', { class: 'primary', disabled: !st.phoneHand, onclick: () => go(1) }, st.phoneHand ? '开始' : '先选哪只手拿手机'),
        h('button', { onclick: () => (location.href = '/check2.html') }, '打开阶段 2 的检查（还差一个卷尺读数）'),
        Object.keys(st.answers).length > 0 && h('button', { onclick: restart }, '清掉上次的答案，从头来'),
      ];
    },
  },
  {
    id: 'ruler',
    title: '用尺子量手',
    text: () => [
      p(`量${HAND_NAME[scanHand()]}（不拿手机的那只）。量个大概就行。`),
      p('手掌宽：四个指根关节那一排，横着量最宽的地方（不算大拇指）。'),
      p('手长：从手腕的横纹量到中指尖。'),
      p('手掌厚：手平放在桌上，量手背中间离桌面多高。'),
    ],
    controls: () => [
      row(
        h('label', {}, '手掌宽 cm', input('ruler:palmWidth', { type: 'number', inputmode: 'decimal', step: '0.1' })),
        h('label', {}, '手长 cm', input('ruler:handLength', { type: 'number', inputmode: 'decimal', step: '0.1' })),
        h('label', {}, '手掌厚 cm', input('ruler:thickness', { type: 'number', inputmode: 'decimal', step: '0.1' })),
      ),
      h('button', { class: 'primary', onclick: saveRuler }, '记下，下一步'),
    ],
  },
  {
    id: 'scan',
    title: '扫描手',
    ar: true,
    text: () => [
      p('手机拿在桌面上方 25–45 cm，镜头朝下。'),
      p(`${HAND_NAME[scanHand()]}平放在桌上：手心朝下，手指伸直、稍微分开，整只手都在画面里。`),
      p('点「开始扫描」，然后别动，大约 3 秒。'),
    ],
    live: () => {
      if (!rt.scanning) return [];
      const s = session.scanStatus || { progress: 0, hint: '' };
      return [h('div', { class: 'big' }, s.hint || '…'), h('div', { class: 'bar' }, h('div', { style: `width: ${Math.round((s.progress || 0) * 100)}%` }))];
    },
    controls: () => {
      if (rt.scanning) return [handsProblem(), h('button', { onclick: () => session.stopScan() }, '停止')];
      return [
        handsProblem(),
        rt.scanFail && line(`没扫好：${rt.scanFail}。再扫一次。`, 'badc'),
        st.scan && scanResult(),
        h('button', { class: st.scan ? '' : 'primary', onclick: startScan }, st.scan ? '重扫' : '开始扫描'),
        st.scan && noteInput('scan'),
        st.scan && q('扫出来的和尺子量的：'),
        st.scan &&
          row(
            ...choices(
              'scan',
              [
                ['ok', '对得上'],
                ['close', '差一点'],
                ['off', '差很多'],
              ],
              { extra: { diff_cm: scanDiff() } },
            ),
          ),
      ];
    },
  },
  {
    id: 'detect',
    title: '认得出手吗',
    ar: true,
    text: () => [p('一项一项来：点「开始」，2 秒后数 5 秒，这 5 秒里照着做。')],
    live: () => {
      const d = rt.detectRun;
      if (!d) return [];
      const sub = SUBS.find((s) => s.id === d.id);
      const left = Math.max(0, Math.ceil((d.until - performance.now()) / 1000));
      return [h('div', { class: 'big warnc' }, d.phase === 'ready' ? `${sub.label}：准备…` : `${sub.label}：还剩 ${left} 秒`)];
    },
    controls: () => {
      if (rt.detectIdx == null) {
        const next = SUBS.findIndex((s) => !st.detect[s.id]);
        rt.detectIdx = next >= 0 ? next : 0;
      }
      const sub = SUBS[rt.detectIdx];
      return [
        handsProblem(),
        h('div', { class: 'big' }, `${rt.detectIdx + 1}/${SUBS.length} ${sub.label}`),
        p(sub.how),
        h('button', { class: 'primary', disabled: Boolean(rt.detectRun), onclick: () => runDetect(sub) }, rt.detectRun ? '正在数…' : st.detect[sub.id] ? '再来一次（5 秒）' : '开始（5 秒）'),
        h(
          'div',
          { class: 'row tight' },
          ...SUBS.map((s, i) =>
            h('button', { class: i === rt.detectIdx ? 'primary' : st.detect[s.id] ? 'chosen' : '', disabled: Boolean(rt.detectRun), onclick: () => ((rt.detectIdx = i), render()) }, s.short),
          ),
        ),
        detectTable(),
        line('认到手 = 有手的帧占多少；对上 = 模型对上了手；把握 = Vision 自己说的把握。', 'muted'),
        noteInput('detect'),
        q('手和「没有手」（拿开、腿脚）分得开吗？'),
        row(
          ...choices(
            'detect',
            [
              ['yes', '分得开'],
              ['no', '分不开'],
            ],
            { extra: { results: st.detect } },
          ),
        ),
      ];
    },
  },
  {
    id: 'depth',
    title: '远近准吗',
    ar: true,
    text: () => [
      p('手平放在桌上别动。点「开始」，把手机从离手 20 cm 左右慢慢抬到 60 cm，再慢慢放回来（10–20 秒）。然后点「结束」。'),
      p(`下面是三种算法算出的「手背离桌面多高」，应该等于手厚 ${(model.palm.thickness * 100).toFixed(1)} cm${thicknessNote()}。`),
    ],
    live: () => {
      const L = depthLive();
      const T = model.palm.thickness;
      const out = [];
      if (!L) out.push(line('还没认到手：手放在画面中间。', 'warnc'));
      else {
        out.push(line(`手机到手：${cm(L.distance)} cm`, binOf(L.distance) < 0 ? 'warnc' : ''));
        if (!L.plane) out.push(line('还没找到桌面：让手机多看一点桌面。', 'warnc'));
        else out.push(table(['', '手背高', '减去手厚'], METHODS_SHOWN.map((m) => [METHOD_NAME[m], cm(L.h[m]), signedCm(L.h[m] == null ? null : L.h[m] - T)])));
      }
      if (rt.depthRec) {
        const counts = BINS.map(([a, b]) => rt.depthRec.samples.filter((s) => s.d >= a && s.d < b).length);
        out.push(line(`记录中：${BINS.map(([a, b], i) => `${Math.round(a * 100)}–${Math.round(b * 100)} cm ${counts[i]} 帧`).join(' · ')}`, 'warnc'));
      }
      return out;
    },
    controls: () => [
      handsProblem(),
      h('button', { class: rt.depthRec || !st.depth ? 'primary' : '', onclick: toggleDepthRec }, rt.depthRec ? '结束' : st.depth ? '重新记录' : '开始'),
      st.depth && !rt.depthRec && depthTable(st.depth),
      st.depth && !rt.depthRec && noteInput('depth'),
      st.depth && !rt.depthRec && q('远近准吗？'),
      st.depth && !rt.depthRec && row(...choices('depth', ACC, { extra: { bins: st.depth.bins, thickness_cm: st.depth.thickness_cm } })),
    ],
  },
  {
    id: 'pos',
    title: '位置准吗',
    ar: true,
    text: () => [
      p('尺子平放在桌上。食指尖放在 0 cm 上，按住不动，点「记下 0」。再放到 10 cm、20 cm，各点一次。'),
      p('用拿手机的手点按钮，量的那只手别动。'),
    ],
    live: () => {
      const seen = session.recent('fused', 0.3).length > 0;
      return [line(seen ? '食指尖：认到了 ✓' : '食指尖：没认到', seen ? 'okc' : 'warnc')];
    },
    controls: () => {
      const next = MARKS.find((v) => !st.marks[v]);
      return [
        handsProblem(),
        row(...MARKS.map((v) => h('button', { class: v === next ? 'primary' : st.marks[v] ? 'chosen' : '', onclick: () => mark(v) }, `记下 ${v}`))),
        marksTable(),
        noteInput('pos'),
        q('位置准吗？'),
        row(...choices('pos', ACC, { extra: { distances: markDistances() } })),
      ];
    },
  },
  {
    id: 'follow',
    title: '跟得上吗',
    ar: true,
    text: () => [p('手在画面里动一动：停住、慢慢动、快快动。看手的模型跟不跟得上。'), p('下面的开关可以随便换着看。')],
    live: () => {
      const k = session.stats();
      const lat = k.latency && k.latency.n > 0 ? k.latency : null;
      return [
        line(`延迟（拍到→画出）：${lat ? `${Math.round(lat.p50)} ms，慢的时候 ${Math.round(lat.p90)} ms` : '还没有'}`),
        line(`认手耗时：${k.visionMs ? `${Math.round(k.visionMs.mean)} ms（最慢 ${Math.round(k.visionMs.max)}）` : '—'}　网页算：${k.webMs ? `${k.webMs.mean.toFixed(1)} ms` : '—'}`),
        line(`每秒几次：${k.rate}　相机：${k.fps ?? '—'} 帧/秒`),
        line(`发热：${THERMAL[k.thermal] || k.thermal || '—'}　预测：${Math.round(k.predictS * 1000)} ms`),
      ];
    },
    controls: () => [
      handsProblem(),
      ...switches(),
      h('button', { disabled: rt.recording, onclick: record5 }, rt.recording ? '正在录…（5 秒）' : '录 5 秒（发到电脑）'),
      rt.recLine && line(rt.recLine, rt.recOk ? 'okc' : 'badc'),
      rt.recLine && !rt.recOk && rt.recorder?.last && h('button', { onclick: resend }, '再发一次'),
      q('手停住时，模型和手对得上吗？'),
      row(
        ...choices(
          'still',
          [
            ['ok', '对得上'],
            ['close', '差一点'],
            ['off', '对不上'],
          ],
          { stay: true },
        ),
      ),
      q('手动起来，模型落后多少？'),
      row(
        ...choices(
          'lag',
          [
            ['none', '看不出'],
            ['some', '一点'],
            ['much', '很明显'],
          ],
          { stay: true },
        ),
      ),
      q('模型抖不抖？'),
      row(
        ...choices(
          'jitter',
          [
            ['none', '不抖'],
            ['some', '有点'],
            ['much', '很抖'],
          ],
          { stay: true },
        ),
      ),
      q('哪种样子最好？'),
      h('div', { class: 'row tight' }, ...choices('bestLook', LOOKS.map((l) => [l, LOOK_NAME[l]]), { stay: true })),
      noteInput('follow'),
      nextButton('下一步', 'follow'),
    ],
  },
  {
    id: 'occl',
    title: '实物挡家具时，手挡得住吗',
    ar: true,
    text: () => [
      p('在画面上点一下桌面，放一个小书架（宽 25 cm）。这一步不显示手的模型。'),
      p('上面的「实物挡家具」开着。把手伸到书架前面：手能挡住书架吗？'),
    ],
    live: () => (rt.touchOn && rt.shelf ? [line(rt.touching ? '碰到了' : '没碰到', rt.touching ? 'warnc' : 'muted')] : []),
    controls: () => [
      handsProblem(),
      !rt.shelf && line(rt.placing ? '在画面上点一下桌面。' : '书架还没放。', 'badc'),
      h('button', { onclick: () => ((rt.placing = true), toast('点一下桌面'), render()) }, rt.placing ? '点一下桌面…' : rt.shelf ? '重新放书架' : '放书架'),
      !rt.meshOcclusion && h('button', { class: 'primary', onclick: () => setMeshOcclusion(true) }, '打开「实物挡家具」'),
      q('手在书架前面时：'),
      row(
        ...choices(
          'occl',
          [
            ['yes', '能挡住'],
            ['no', '挡不住'],
            ['flicker', '一闪一闪'],
          ],
          { stay: true },
        ),
      ),
      h('button', { class: rt.touchOn ? 'chosen' : '', disabled: !rt.shelf, onclick: () => setTouch(!rt.touchOn) }, `碰到有反应：${rt.touchOn ? '开' : '关'}`),
      rt.touchOn && line('手碰到书架时，手机震一下，书架变红。', 'muted'),
      q('（可不答）碰到时的反应对吗？'),
      row(
        ...choices(
          'touch',
          [
            ['ok', '对'],
            ['late', '慢了'],
            ['wrong', '不对'],
          ],
          { stay: true },
        ),
      ),
      noteInput('occl'),
      nextButton('下一步', 'occl'),
    ],
  },
  {
    id: 'bg',
    title: '后台 1 分钟',
    ar: true,
    text: () => [
      p('点「开始」，然后回到主屏幕（从屏幕底边往上滑），等 1 分钟，再点开 app 回来。'),
      p('回来以后，这一页自己会记下：页面还在不在，AR 还在不在跑。'),
    ],
    controls: () => {
      const b = st.bg;
      const a = st.answers.bgAuto;
      return [
        h('button', { class: b && !a ? '' : 'primary', onclick: startBg }, b ? '再来一次' : '开始'),
        b && !a && line(rt.bgBusy ? '回来了，正在看…' : '现在回到主屏幕，1 分钟后再回来。', 'warnc'),
        a && line(a.reloaded ? '页面重新加载了' : '页面还在 ✓', a.reloaded ? 'badc' : 'okc'),
        a && line(`离开了 ${a.awaySeconds ?? '?'} 秒${a.awaySeconds != null && a.awaySeconds < 50 ? '（不到 1 分钟，可以再来一次）' : ''}`),
        // read at the moment of coming back; after a reload the page starts AR again itself
        a && line(a.arRunning ? '回来时 AR 还在跑 ✓' : '回来时 AR 停了' + (a.reloaded ? '（页面已重新打开它）' : ''), a.arRunning ? 'okc' : 'badc'),
        a && line(a.handsRate > 0 ? `回来时认手还在：每秒 ${Math.round(a.handsRate)} 次 ✓` : '回来时认手停了', a.handsRate > 0 ? 'okc' : 'badc'),
        a && q('回来以后，相机画面和手的模型正常吗？'),
        a &&
          row(
            ...choices(
              'bg',
              [
                ['ok', '正常'],
                ['bad', '不正常'],
              ],
              { extra: { auto: a } },
            ),
          ),
      ];
    },
  },
  {
    id: 'done',
    title: '结果',
    ar: true,
    text: () => summary(),
    controls: () => [
      q('手进来了吗？（手的模型像不像真的在画面里）'),
      row(
        ...choices(
          'main',
          [
            ['yes', '进来了'],
            ['some', '有一点'],
            ['no', '没有'],
          ],
          { stay: true },
        ),
      ),
      noteInput('main'),
      h('button', { class: 'primary', onclick: send }, '发送到电脑'),
      rt.sendLine && line(rt.sendLine, rt.sendLine.includes('✓') ? 'okc' : 'badc'),
      line('下面的开关随便试，不影响结果。', 'muted'),
      ...(rt.arOn ? switches() : []),
      h('button', { onclick: () => (location.href = '/') }, '回到试次页'),
      h('button', { onclick: restart }, '清掉答案，从头再做一遍'),
    ],
  },
];

const step = () => STEPS[Math.min(Math.max(st.step, 0), STEPS.length - 1)];

function words(id, options) {
  const a = st.answers[id];
  if (!a) return '没做';
  return Object.fromEntries(options)[a.value] || a.value;
}

function summary() {
  const s = st.scan?.cm;
  const r = st.ruler;
  const D = markDistances().fused['0-20'];
  const bg = st.answers.bgAuto;
  return [
    r ? p(`尺子：手掌宽 ${r.palmWidth} · 手长 ${r.handLength} · 手掌厚 ${r.thickness} cm`) : p('尺子：没量'),
    s
      ? p(
          `扫描：手掌宽 ${s.palmWidth} · 手长 ${s.handLength} · 手掌厚 ${s.thickness} cm（${words('scan', [
            ['ok', '对得上'],
            ['close', '差一点'],
            ['off', '差很多'],
          ])}）`,
        )
      : p('扫描：没做'),
    p(
      `认手：${words('detect', [
        ['yes', '分得开'],
        ['no', '分不开'],
      ])}；${SUBS.map((x) => `${x.short} ${pct(st.detect[x.id]?.handShare)}`).join(' · ')}`,
    ),
    p(`远近：${words('depth', ACC)}　位置：${words('pos', ACC)}${D != null ? `（0→20 量到 ${D.toFixed(1)} cm）` : ''}`),
    p(
      `跟手：停住 ${words('still', [
        ['ok', '对得上'],
        ['close', '差一点'],
        ['off', '对不上'],
      ])} · 落后 ${words('lag', [
        ['none', '看不出'],
        ['some', '一点'],
        ['much', '很明显'],
      ])} · 抖 ${words('jitter', [
        ['none', '不抖'],
        ['some', '有点'],
        ['much', '很抖'],
      ])} · 最好的样子 ${words('bestLook', Object.entries(LOOK_NAME))}`,
    ),
    p(
      `实物挡：${words('occl', [
        ['yes', '能挡住'],
        ['no', '挡不住'],
        ['flicker', '一闪一闪'],
      ])} · 碰到：${words('touch', [
        ['ok', '对'],
        ['late', '慢了'],
        ['wrong', '不对'],
      ])}`,
    ),
    p(`后台：${bg ? (bg.reloaded ? '页面重新加载了' : '页面还在') : '没做'}${st.answers.bg ? `（${st.answers.bg.value === 'ok' ? '正常' : '不正常'}）` : ''}　录了 ${st.recordings.length} 段`),
  ];
}

async function send() {
  const r = await report();
  rt.sendLine = r.ok ? '电脑收到了 ✓' : `没发出去：${r.error}`;
  render();
}

function restart() {
  cancelDetect();
  rt.depthRec = null;
  Object.assign(st, { step: 0, answers: {}, startedAt: new Date().toISOString(), ruler: null, scan: null, detect: {}, depth: null, marks: {}, bg: null, recordings: [] });
  rt.drafts = {};
  rt.detectIdx = null;
  rt.recLine = '';
  rt.sendLine = '';
  save();
  go(0);
}

/** Leaving a step: stop what only makes sense in it. */
function leave(from) {
  if (from.id === 'scan' && rt.scanning) session.stopScan();
  if (from.id === 'detect') cancelDetect();
  if (from.id === 'depth') rt.depthRec = null;
  if (from.id === 'occl') {
    if (rt.touchOn) setTouch(false);
    rt.placing = false;
  }
}

function go(index) {
  const from = step();
  st.step = Math.min(Math.max(index, 0), STEPS.length - 1);
  if (step() !== from) leave(from);
  save();
  enter();
  render();
}

/** Things that depend on which step is showing. */
function enter() {
  const s = step();
  $('panel').classList.remove('folded');
  if (s.id === 'occl' && !rt.shelf) rt.placing = true;
  if (s.ar && !rt.arOn && HANDS) ensureAR();
  else applyView();
}

function updateLive() {
  const s = step();
  const show = s.live && (!s.ar || rt.arOn);
  $('step-live').replaceChildren(...(show ? s.live() : []).flat().filter(Boolean));
}

function render() {
  const s = step();
  const index = STEPS.indexOf(s);
  $('step-no').textContent = `${index + 1} / ${STEPS.length}`;
  $('step-title').textContent = s.title;
  $('btn-fold').textContent = $('panel').classList.contains('folded') ? '展开' : '收起';
  const needsCamera = s.ar && !rt.arOn;
  $('step-text').replaceChildren(...s.text().flat().filter(Boolean));
  $('step-controls').replaceChildren(...(needsCamera ? arBlock() : s.controls()).flat().filter(Boolean));
  updateLive();
  $('btn-prev').disabled = index === 0;
  $('btn-skip').classList.toggle('hidden', index === STEPS.length - 1);
  updateHud();
}

$('btn-prev').addEventListener('click', () => go(st.step - 1));
$('btn-skip').addEventListener('click', () => go(st.step + 1));
// The dev server no longer reloads the page when it changes (vite.config.js): this does it by hand.
$('btn-reload').addEventListener('click', () => location.reload());
$('btn-fold').addEventListener('click', () => {
  $('panel').classList.toggle('folded');
  render();
});
$('hud-occ').addEventListener('click', () => setMeshOcclusion(!rt.meshOcclusion));
$('ver').textContent = nativeInfo ? `${versionLabel()} · iOS ${nativeInfo.ios} · ${nativeInfo.model}` : versionLabel();

async function prepChecks() {
  const web = await log('stage3 check page opened', { step: step().id, features: nativeInfo?.features ?? null, model: modelSummary() });
  rt.prep = { webLog: web.ok, webLogError: web.error };
  if (hasNative) {
    try {
      rt.prep.native = await callNative('status');
    } catch (e) {
      rt.prep.native = { startupLogOK: false, startupLog: String(e.message || e) };
    }
  }
  if (step().id === 'prep') render();
}

// live numbers and the HUD, a few times a second (the panel itself only re-renders on changes)
setInterval(() => {
  updateLive();
  updateHud();
}, 250);

// Step 8 after a reload: record that it happened, and whether the native session kept running,
// before this page starts (and so resets) AR again.
if (step().id === 'bg' && st.bg && st.bg.loadId !== LOAD_ID && !st.answers.bgAuto && HANDS) {
  st.bg.backAt = st.bg.backAt || Date.now();
  save();
  render();
  await recordBg(true);
}
enter();
render();
prepChecks();
