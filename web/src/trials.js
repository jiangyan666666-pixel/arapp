// Trial plan, per-trial records, localStorage persistence, export.
//
// A *block* = one gap (measured width W), one model, one instruction (A/B/C),
// n trials. Each trial draws a hidden width W + delta; truth: fits iff delta <= 0.

export const DELTAS_CM = [-6, -3, 0, 3, 6];
const STORE_KEY = 'ar-hand-ruler/v1';
const SETTINGS_KEY = 'ar-hand-ruler/settings';

export function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function shuffle(arr, rng = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * @param {number} n trials
 * @param {'discrete5'|'continuous'} randomization
 * @returns {number[]} deltas in cm. discrete5: balanced sets of the 5 steps, each set shuffled.
 */
export function makeTrialPlan(n, randomization, rng = Math.random) {
  if (randomization === 'continuous') {
    return Array.from({ length: n }, () => Math.round((rng() * 12 - 6) * 10) / 10);
  }
  const plan = [];
  while (plan.length < n) plan.push(...shuffle([...DELTAS_CM], rng));
  return plan.slice(0, n);
}

// --- storage ------------------------------------------------------------------

export function loadStore() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && Array.isArray(s.blocks) && Array.isArray(s.trials)) return s;
  } catch {
    /* corrupted or missing */
  }
  return { blocks: [], trials: [] };
}

function saveStore(store) {
  localStorage.setItem(STORE_KEY, JSON.stringify(store));
}

export function addBlock(block) {
  const s = loadStore();
  s.blocks.push(block);
  saveStore(s);
}

export function updateBlock(id, patch) {
  const s = loadStore();
  const b = s.blocks.find((x) => x.id === id);
  if (b) Object.assign(b, patch);
  saveStore(s);
}

export function addTrial(trial) {
  const s = loadStore();
  s.trials.push(trial);
  saveStore(s);
}

export function trialsOfBlock(blockId) {
  return loadStore().trials.filter((t) => t.blockId === blockId);
}

export function clearStore() {
  localStorage.removeItem(STORE_KEY);
}

export function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
  } catch {
    return {};
  }
}

export function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

// --- analysis -----------------------------------------------------------------

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

/** Bucket a delta for the by-delta table (continuous plans land on the nearest 3 cm step). */
export function deltaBucket(delta) {
  return Math.max(-6, Math.min(6, Math.round(delta / 3) * 3));
}

export function summarize(trials) {
  const n = trials.length;
  const correct = trials.filter((t) => t.correct).length;
  const byDelta = {};
  for (const d of DELTAS_CM) byDelta[d] = { n: 0, fits: 0, correct: 0 };
  for (const t of trials) {
    const b = byDelta[deltaBucket(t.delta_cm)];
    b.n++;
    if (t.answer === 'fits') b.fits++;
    if (t.correct) b.correct++;
  }
  return {
    n,
    correct,
    accuracy: n ? correct / n : NaN,
    byDelta,
    confidenceCorrect: mean(trials.filter((t) => t.correct).map((t) => t.confidence)),
    confidenceWrong: mean(trials.filter((t) => !t.correct).map((t) => t.confidence)),
    meanDistance: mean(trials.map((t) => t.distance_m)),
    meanTimeToAnswer: mean(trials.map((t) => t.timeToAnswer_s)),
    meanTimeToPlace: mean(trials.map((t) => t.timeToPlace_s)),
  };
}

// --- export -------------------------------------------------------------------

const CSV_COLUMNS = [
  ['block_id', (t) => t.blockId],
  ['platform', (t, b) => b?.platform ?? 'android-webxr'],
  ['instruction', (t, b) => b?.instruction ?? ''],
  ['block_note', (t, b) => b?.note ?? ''],
  ['model', (t, b) => b?.modelId ?? ''],
  ['randomization', (t, b) => b?.randomization ?? ''],
  ['occlusion', (t, b) => (b?.occlusion ? 1 : 0)],
  ['depth_usage', (t, b) => b?.depth?.usage ?? ''],
  ['depth_format', (t, b) => b?.depth?.format ?? ''],
  ['W_cm', (t) => t.W_cm],
  ['trial_index', (t) => t.index + 1],
  ['delta_cm', (t) => t.delta_cm],
  ['width_cm', (t) => t.width_cm],
  ['fits_truth', (t) => (t.fitsTruth ? 1 : 0)],
  ['answer', (t) => t.answer],
  ['correct', (t) => (t.correct ? 1 : 0)],
  ['confidence', (t) => t.confidence],
  ['distance_m', (t) => t.distance_m?.toFixed(3)],
  ['distance_xz_m', (t) => t.distanceXZ_m?.toFixed(3)],
  ['time_to_answer_s', (t) => t.timeToAnswer_s?.toFixed(2)],
  ['time_to_place_s', (t) => t.timeToPlace_s?.toFixed(2)],
  ['replace_count', (t) => t.replaceCount],
  ['furniture_x', (t) => t.furniturePose?.x?.toFixed(3)],
  ['furniture_y', (t) => t.furniturePose?.y?.toFixed(3)],
  ['furniture_z', (t) => t.furniturePose?.z?.toFixed(3)],
  ['furniture_yaw_deg', (t) => t.furniturePose?.yaw_deg?.toFixed(1)],
  ['camera_x', (t) => t.cameraAtAnswer?.x?.toFixed(3)],
  ['camera_y', (t) => t.cameraAtAnswer?.y?.toFixed(3)],
  ['camera_z', (t) => t.cameraAtAnswer?.z?.toFixed(3)],
  ['trajectory_samples', (t) => t.trajectory?.length ?? 0],
  ['remark', (t) => t.remark ?? ''],
  ['answered_at', (t) => t.answeredAt],
  // iPhone / AR Quick Look only: scaling cannot be locked there, so each trial says whether it was scaled
  ['scaled', (t) => (t.scaled === undefined ? '' : t.scaled ? 1 : 0)],
  ['open_count', (t) => t.openCount ?? ''],
  // iPhone two-judgment design: (1) first glance from where you stand, (2) after looking freely
  ['placement', (t, b) => t.placement ?? b?.placement ?? ''],
  ['first_answer', (t) => t.firstAnswer ?? ''],
  ['first_correct', (t) => (t.firstAnswer ? (t.firstCorrect ? 1 : 0) : '')],
  ['first_confidence', (t) => t.firstConfidence ?? ''],
  ['first_open_count', (t) => t.firstOpenCount ?? ''],
  ['first_time_s', (t) => t.firstTime_s?.toFixed(2)],
  ['strategies', (t) => (t.strategies ? t.strategies.join('|') : '')],
];

function csvCell(v) {
  if (v === undefined || v === null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCSV(store) {
  const blocks = new Map(store.blocks.map((b) => [b.id, b]));
  const rows = [CSV_COLUMNS.map(([name]) => name).join(',')];
  for (const t of store.trials) {
    const b = blocks.get(t.blockId);
    rows.push(CSV_COLUMNS.map(([, f]) => csvCell(f(t, b))).join(','));
  }
  return rows.join('\n');
}

export function download(filename, text, type = 'text/plain') {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export function stamp() {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
}
