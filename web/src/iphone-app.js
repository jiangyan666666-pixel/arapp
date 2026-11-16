// Self-test on iPhone (Safari has no WebXR): each trial builds the furniture at
// the hidden width W + delta *on the phone* and hands it to AR Quick Look as a
// blob, so no file name, URL or label ever carries the width.
//
// Every trial has two judgments:
//   ① 第一眼 – look for a few seconds from where you stand, no moving, no hand
//   ② 仔细看 – look as long as you like (walk around, closer, hand as ruler per instruction)
// Comparing ① with ② separates an intuitive sense of size from a judgment reached by checking.
//
// Placement: 'manual' only (plane anchoring, you drag it in). The printed-marker option of
// the previous project was removed in ARAPP; stage 4 replaces Quick Look with the native AR view.
//
// Same block / trial / CSV format as the 8T app (src/app.js, src/trials.js), with
// platform = 'ios-quicklook'. Quick Look cannot lock scaling, so every trial records whether
// the furniture was scaled (rule: keep it at 100%). No camera pose from Quick Look: no
// distance or trajectory; "how did you look" is asked instead.

import * as store from './trials.js';
import { MODELS } from './furniture.js';
import { furnitureUSDZ } from './usdz.js';
import { callNative, hasNative, versionLabel } from './native.js';
import { forwardErrors, log } from './log.js';

forwardErrors();

const CURRENT_KEY = 'ar-hand-ruler/iphone-current';
const INSTRUCTION_LABELS = { A: 'A 只用眼睛看（不伸手）', B: 'B 手伸进画面当尺子', C: 'C 走进空隙', other: '其他' };
const STRATEGY_LABELS = { side: '绕到侧面', closer: '走近看', back: '退远看', hand: '伸手比', top: '从上往下看', none: '都没有' };
const THUMBS = { shelf: '/ar/shelf.svg', sideboard: '/ar/sideboard.svg' };
const CAN_AR = document.createElement('a').relList.supports('ar');
const PHASE_TEXT = {
  first: {
    manual: '打开 AR，把家具拖进空隙。然后站到离空隙 1.5–2 米的地方，只看几秒：不走动、不伸手、不绕。退出 AR，凭第一眼回答。',
  },
  final: '再打开 AR，按这一组的指令仔细看：可以绕到侧面、走近、退远，指令 B 还可以伸手比。看完退出 AR，回答，再勾上你用了哪些看法。',
};

const $ = (id) => document.getElementById(id);
const ui = {
  screens: ['setup', 'trial', 'summary', 'data'].map($),
  noAr: $('no-ar'),
  resume: $('resume'),
  resumeText: $('resume-text'),
  fW: $('f-w'),
  fN: $('f-n'),
  fModel: $('f-model'),
  fPlace: $('f-place'),
  fRand: $('f-rand'),
  fInstr: $('f-instr'),
  fNote: $('f-note'),
  setupError: $('setup-error'),
  progress: $('progress'),
  phaseTitle: $('phase-title'),
  instrLine: $('instr-line'),
  phaseText: $('phase-text'),
  arLink: $('ar-link'),
  arImg: $('ar-img'),
  arStatus: $('ar-status'),
  answer: $('answer'),
  cAnswer: $('c-answer'),
  cStrat: $('c-strat'),
  cScaled: $('c-scaled'),
  finalOnly: $('final-only'),
  fConf: $('f-conf'),
  confVal: $('conf-val'),
  fRemark: $('f-remark'),
  btnNext: $('btn-next'),
  summaryBody: $('summary-body'),
  dataBody: $('data-body'),
  csvText: $('csv-text'),
};

// cur = { blockId, plan, index, trial } – persisted, so a reload (or Safari discarding the
// tab while Quick Look is open) resumes the block at the same trial and phase.
// trial = { base, phase: 'first'|'final', shownAt, first: {...}, final: {...} }
let cur = null;
let choice = { answer: null, scaled: null, strategies: new Set() };
let modelUrl = null;
let buildToken = 0;

function saveCurrent() {
  try {
    if (cur) localStorage.setItem(CURRENT_KEY, JSON.stringify(cur));
    else localStorage.removeItem(CURRENT_KEY);
  } catch {
    // storage full or blocked: the trial records themselves are still written by store.addTrial
  }
}

function loadCurrent() {
  try {
    const c = JSON.parse(localStorage.getItem(CURRENT_KEY));
    if (!c || !c.blockId || !Array.isArray(c.plan)) return null;
    const block = store.loadStore().blocks.find((b) => b.id === c.blockId);
    if (c.trial && !c.trial.phase) c.trial = null; // saved by the one-judgment version: restart that trial
    return block && !block.completed && c.index < c.plan.length ? c : null;
  } catch {
    return null;
  }
}

function blockOf(id) {
  return store.loadStore().blocks.find((b) => b.id === id);
}

function showScreen(name) {
  for (const s of ui.screens) s.classList.toggle('hidden', s.id !== name);
  window.scrollTo(0, 0);
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pct = (v) => (Number.isFinite(v) ? `${Math.round(v * 100)}%` : '—');
const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : '—');
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

// --- setup ------------------------------------------------------------------------------

function initSetup() {
  ui.noAr.classList.toggle('hidden', CAN_AR);
  if (hasNative) ui.noAr.textContent = 'app 里暂时还打不开 AR（阶段 4 才接上原生 AR）。在这里只能走一遍流程。';
  ui.fModel.innerHTML = MODELS.filter((m) => m.kind === 'procedural')
    .map((m) => `<option value="${m.id}">${escapeHtml(m.label)}</option>`)
    .join('');
  const s = store.loadSettings();
  if (s.W) ui.fW.value = s.W;
  if (s.n) ui.fN.value = s.n;
  if (s.modelId && MODELS.some((m) => m.id === s.modelId)) ui.fModel.value = s.modelId;
  if (s.placement === 'manual') ui.fPlace.value = s.placement;
  if (s.randomization) ui.fRand.value = s.randomization;
  if (s.instruction && INSTRUCTION_LABELS[s.instruction]) ui.fInstr.value = s.instruction;
  if (s.note) ui.fNote.value = s.note;

  cur = loadCurrent();
  ui.resume.classList.toggle('hidden', !cur);
  if (cur) {
    const b = blockOf(cur.blockId);
    ui.resumeText.textContent = `有一组没做完：${INSTRUCTION_LABELS[b.instruction] || ''} · W ${b.W_cm} cm · 已答 ${cur.index} / ${cur.plan.length}。`;
  }
}

function readSetup() {
  const W = parseFloat(ui.fW.value);
  const n = parseInt(ui.fN.value, 10);
  if (!(W >= 20 && W <= 300)) return { error: '先量空隙宽度 W（20–300 cm）' };
  if (!(n >= 1 && n <= 60)) return { error: '试次数 1–60' };
  return {
    W,
    n,
    modelId: ui.fModel.value,
    placement: ui.fPlace.value,
    randomization: ui.fRand.value,
    instruction: ui.fInstr.value,
    note: ui.fNote.value.trim(),
  };
}

function startBlock() {
  const settings = readSetup();
  ui.setupError.textContent = settings.error || '';
  if (settings.error) return;
  store.saveSettings({ ...store.loadSettings(), ...settings });
  const block = {
    id: store.newId('b'),
    createdAt: new Date().toISOString(),
    platform: 'ios-quicklook',
    mode: 'quicklook',
    design: 'first-then-final',
    W_cm: settings.W,
    modelId: settings.modelId,
    placement: settings.placement,
    randomization: settings.randomization,
    nTrials: settings.n,
    instruction: settings.instruction,
    note: settings.note,
    occlusion: true, // iOS people occlusion, always on in Quick Look
    ua: navigator.userAgent,
    completed: false,
  };
  store.addBlock(block);
  cur = { blockId: block.id, plan: store.makeTrialPlan(settings.n, settings.randomization), index: 0, trial: null };
  beginTrial();
}

// --- trials --------------------------------------------------------------------------------

function beginTrial() {
  const block = blockOf(cur.blockId);
  const delta = cur.plan[cur.index];
  const width_cm = Math.round((block.W_cm + delta) * 10) / 10;
  // A resumed trial keeps its phase, open counts and first-glance answer.
  if (!cur.trial || cur.trial.base.index !== cur.index) {
    cur.trial = {
      base: {
        id: store.newId('t'),
        blockId: block.id,
        index: cur.index,
        delta_cm: delta,
        width_cm,
        W_cm: block.W_cm,
        fitsTruth: delta <= 0,
        startedAt: new Date().toISOString(),
      },
      phase: 'first',
      shownAt: Date.now(),
      first: { openCount: 0, firstOpenAt: null },
      final: { openCount: 0, firstOpenAt: null },
    };
  }
  saveCurrent();
  ui.arImg.src = THUMBS[block.modelId] || THUMBS.shelf;
  renderPhase(block);
  showScreen('trial');
  prepareModel(block, width_cm);
}

function renderPhase(block = blockOf(cur.blockId)) {
  const t = cur.trial;
  const first = t.phase === 'first';
  choice = { answer: null, scaled: null, strategies: new Set() };
  for (const b of ui.answer.querySelectorAll('.choice button')) b.classList.remove('on');
  ui.fConf.value = 75;
  ui.confVal.textContent = '75';
  ui.fRemark.value = '';
  ui.progress.textContent = `第 ${cur.index + 1} / ${cur.plan.length} 次`;
  ui.phaseTitle.textContent = first ? '① 第一眼' : '② 仔细看';
  ui.instrLine.textContent = first ? '站在原地，只看几秒' : `指令：${INSTRUCTION_LABELS[block.instruction] || ''}`;
  ui.phaseText.textContent = first ? PHASE_TEXT.first.manual : PHASE_TEXT.final;
  ui.finalOnly.classList.toggle('hidden', first);
  ui.btnNext.textContent = first ? '记下第一眼' : '下一件';
  ui.answer.classList.toggle('locked', t[t.phase].openCount === 0);
  if (modelUrl) ui.arStatus.textContent = t[t.phase].openCount ? '再打开一次 AR' : '打开 AR';
  updateNext();
  window.scrollTo(0, 0);
}

async function prepareModel(block, width_cm) {
  const token = ++buildToken;
  ui.arLink.classList.add('busy');
  ui.arLink.setAttribute('href', '#');
  ui.arStatus.textContent = '准备模型…';
  if (modelUrl) {
    URL.revokeObjectURL(modelUrl);
    modelUrl = null;
  }
  try {
    const { data } = await furnitureUSDZ(block.modelId, width_cm / 100);
    if (token !== buildToken) return; // a newer trial started meanwhile
    modelUrl = URL.createObjectURL(new Blob([data], { type: 'model/vnd.usdz+zip' }));
    ui.arLink.setAttribute('href', modelUrl);
    ui.arLink.setAttribute('download', 'furniture.usdz'); // neutral name: nothing about the width
    ui.arLink.classList.remove('busy');
    const t = cur.trial;
    ui.arStatus.textContent = t[t.phase].openCount ? '再打开一次 AR' : '打开 AR';
  } catch (e) {
    if (token !== buildToken) return;
    ui.arStatus.textContent = `模型生成失败：${e}`;
  }
}

function onOpenAR(e) {
  if (!modelUrl) {
    e.preventDefault();
    return;
  }
  if (!CAN_AR) e.preventDefault(); // desktop run-through: don't download the file
  const p = cur.trial[cur.trial.phase];
  p.openCount++;
  if (!p.firstOpenAt) p.firstOpenAt = Date.now();
  saveCurrent();
  ui.answer.classList.remove('locked');
  ui.arStatus.textContent = '再打开一次 AR';
  updateNext();
}

function pick(group, key, btn) {
  for (const b of group.querySelectorAll('button')) b.classList.toggle('on', b === btn);
  choice[key] = btn.dataset.v;
  updateNext();
}

function toggleStrategy(btn) {
  const v = btn.dataset.v;
  if (choice.strategies.has(v)) choice.strategies.delete(v);
  else {
    // "都没有" excludes the others and vice versa
    if (v === 'none') choice.strategies.clear();
    else choice.strategies.delete('none');
    choice.strategies.add(v);
  }
  for (const b of ui.cStrat.querySelectorAll('button')) b.classList.toggle('on', choice.strategies.has(b.dataset.v));
  updateNext();
}

function updateNext() {
  const t = cur && cur.trial;
  if (!t) {
    ui.btnNext.disabled = true;
    return;
  }
  const opened = t[t.phase].openCount > 0;
  ui.btnNext.disabled = t.phase === 'first'
    ? !(opened && choice.answer)
    : !(opened && choice.answer && choice.scaled && choice.strategies.size);
}

function commit() {
  if (ui.btnNext.disabled) return;
  const now = Date.now();
  const t = cur.trial;
  if (t.phase === 'first') {
    Object.assign(t.first, {
      answer: choice.answer,
      confidence: parseInt(ui.fConf.value, 10),
      answeredAt: new Date(now).toISOString(),
      time_s: (now - t.first.firstOpenAt) / 1000,
    });
    t.phase = 'final';
    saveCurrent();
    renderPhase();
    return;
  }
  const block = blockOf(cur.blockId);
  const fits = choice.answer === 'fits';
  store.addTrial({
    ...t.base,
    platform: 'ios-quicklook',
    placement: block.placement,
    firstAnswer: t.first.answer,
    firstConfidence: t.first.confidence,
    firstCorrect: (t.first.answer === 'fits') === t.base.fitsTruth,
    firstOpenCount: t.first.openCount,
    firstTime_s: t.first.time_s,
    answer: choice.answer,
    correct: fits === t.base.fitsTruth,
    confidence: parseInt(ui.fConf.value, 10),
    strategies: [...choice.strategies],
    remark: ui.fRemark.value.trim(),
    scaled: choice.scaled === 'yes',
    openCount: t.final.openCount,
    timeToAnswer_s: (now - t.final.firstOpenAt) / 1000, // ② first "open AR" → final answer (includes time in AR)
    timeFromShown_s: (now - t.shownAt) / 1000,
    answeredAt: new Date(now).toISOString(),
  });
  cur.index++;
  cur.trial = null;
  if (cur.index >= cur.plan.length) endBlock(true);
  else beginTrial();
}

function endBlock(completed) {
  const id = cur.blockId;
  store.updateBlock(id, { completed, endedAt: new Date().toISOString() });
  cur = null;
  saveCurrent();
  buildToken++;
  if (modelUrl) {
    URL.revokeObjectURL(modelUrl);
    modelUrl = null;
  }
  showSummary(id);
}

// --- summary / data -----------------------------------------------------------------------

function blockTable(trials) {
  const kept = trials.filter((t) => !t.scaled);
  const two = kept.filter((t) => t.firstAnswer); // trials that have a first-glance answer
  const n = kept.length;
  const right = kept.filter((t) => t.correct).length;
  let html = '<table>';
  html += `<tr><td>试次（不含缩放过的）</td><td class="num">${n}${trials.length !== n ? `（另有 ${trials.length - n} 次缩放过）` : ''}</td></tr>`;
  if (two.length) {
    const r1 = two.filter((t) => t.firstCorrect).length;
    html += `<tr><td>① 第一眼正确率</td><td class="num">${pct(r1 / two.length)}（${r1}/${two.length}）</td></tr>`;
  }
  html += `<tr><td>${two.length ? '② 看完后正确率' : '正确率'}</td><td class="num">${pct(n ? right / n : NaN)}（${right}/${n}）</td></tr>`;
  if (two.length) {
    const changed = two.filter((t) => t.firstAnswer !== t.answer);
    const better = changed.filter((t) => t.correct).length;
    html += `<tr><td>改了答案</td><td class="num">${changed.length} 次（改对 ${better}，改错 ${changed.length - better}）</td></tr>`;
    html += `<tr><td>① 把握 · 答对 / 答错</td><td class="num">${f1(mean(two.filter((t) => t.firstCorrect).map((t) => t.firstConfidence)))} / ${f1(mean(two.filter((t) => !t.firstCorrect).map((t) => t.firstConfidence)))}</td></tr>`;
  }
  html += `<tr><td>${two.length ? '② ' : ''}把握 · 答对 / 答错</td><td class="num">${f1(mean(kept.filter((t) => t.correct).map((t) => t.confidence)))} / ${f1(mean(kept.filter((t) => !t.correct).map((t) => t.confidence)))}</td></tr>`;
  html += `<tr><td>${two.length ? '② 打开 AR → 回答' : '打开 AR → 回答'}（均值）</td><td class="num">${f1(mean(kept.map((t) => t.timeToAnswer_s)))} s</td></tr>`;
  html += '</table>';

  html += '<h2>按 δ（家具宽 − 空隙宽）</h2><table><tr><th>δ cm</th><th class="num">n</th>';
  html += two.length ? '<th class="num">① 答「放得下」</th><th class="num">② 答「放得下」</th></tr>' : '<th class="num">答「放得下」</th></tr>';
  for (const d of store.DELTAS_CM) {
    const sub = kept.filter((t) => store.deltaBucket(t.delta_cm) === d);
    const fitsFinal = sub.filter((t) => t.answer === 'fits').length;
    const fitsFirst = sub.filter((t) => t.firstAnswer === 'fits').length;
    html += `<tr><td>${d > 0 ? '+' : ''}${d}${d <= 0 ? '（放得下）' : '（放不下）'}</td><td class="num">${sub.length}</td>`;
    html += two.length ? `<td class="num">${sub.length ? fitsFirst : '—'}</td><td class="num">${sub.length ? fitsFinal : '—'}</td></tr>` : `<td class="num">${sub.length ? fitsFinal : '—'}</td></tr>`;
  }
  html += '</table>';

  const counts = {};
  for (const t of kept) for (const s of t.strategies || []) counts[s] = (counts[s] || 0) + 1;
  if (Object.keys(counts).length) {
    html += '<h2>② 怎么看的</h2><p>' + Object.entries(counts).map(([k, v]) => `${STRATEGY_LABELS[k] || k} ${v}`).join(' · ') + '</p>';
  }
  const remarks = trials
    .filter((t) => t.remark)
    .map((t) => {
      const first = t.firstAnswer ? `① ${t.firstAnswer === 'fits' ? '放得下' : '放不下'} → ` : '';
      return `<li>#${t.index + 1}（δ ${t.delta_cm > 0 ? '+' : ''}${t.delta_cm}，${first}② ${t.answer === 'fits' ? '放得下' : '放不下'}${t.correct ? ' ✓' : ' ✗'}${t.scaled ? '，缩放过' : ''}）${escapeHtml(t.remark)}</li>`;
    });
  if (remarks.length) html += `<h2>观察</h2><ul>${remarks.join('')}</ul>`;
  return html;
}

function showSummary(blockId) {
  const s = store.loadStore();
  const block = s.blocks.find((b) => b.id === blockId);
  const trials = s.trials.filter((t) => t.blockId === blockId).sort((a, b) => a.index - b.index);
  ui.summaryBody.innerHTML =
    `<p class="muted">${escapeHtml(block.createdAt.slice(0, 16).replace('T', ' '))} · ${escapeHtml(INSTRUCTION_LABELS[block.instruction] || '')} · W ${block.W_cm} cm · ${escapeHtml(block.modelId)} · ${block.placement === 'marker' ? '定位图' : '手动摆放'} · ${block.completed ? '完成' : '中止'}</p>` +
    blockTable(trials);
  ui.summaryBody.dataset.blockId = blockId;
  $('sum-send-status').textContent = '';
  showScreen('summary');
}

function blockStore(blockId) {
  const s = store.loadStore();
  return { blocks: s.blocks.filter((b) => b.id === blockId), trials: s.trials.filter((t) => t.blockId === blockId) };
}

function exportStore(s, suffix, kind) {
  const name = `iphone-${suffix}-${store.stamp()}`;
  if (kind === 'json') store.download(`${name}.json`, JSON.stringify(s, null, 2), 'application/json');
  else store.download(`${name}.csv`, store.toCSV(s), 'text/csv');
}

// Dev server only (vite.config.js → notes/selftest/ on the PC). Falls back to export.
async function sendToPC(s, statusEl) {
  statusEl.textContent = '发送中…';
  try {
    const res = await fetch('/__selftest/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sentAt: new Date().toISOString(), ua: navigator.userAgent, ...s }),
    });
    const r = await res.json();
    if (!r.ok) throw new Error(r.error || res.status);
    statusEl.textContent = `已发送 ✓ 电脑上：${r.file}`;
  } catch (e) {
    statusEl.textContent = `发送失败（${e.message || e}）。电脑上的开发服务器要开着；不行就用下面的导出。`;
  }
}

function showData() {
  const s = store.loadStore();
  ui.csvText.classList.add('hidden');
  $('send-status').textContent = '';
  if (!s.blocks.length) {
    ui.dataBody.innerHTML = '<p class="muted">还没有数据。</p>';
  } else {
    let html = '<table><tr><th>时间</th><th>指令</th><th class="num">W</th><th class="num">试次</th><th class="num">① / ② 正确</th></tr>';
    for (const b of [...s.blocks].reverse()) {
      const ts = s.trials.filter((t) => t.blockId === b.id);
      const two = ts.filter((t) => t.firstAnswer);
      const first = two.length ? pct(two.filter((t) => t.firstCorrect).length / two.length) : '—';
      const final = ts.length ? pct(ts.filter((t) => t.correct).length / ts.length) : '—';
      html += `<tr><td>${escapeHtml(b.createdAt.slice(5, 16).replace('T', ' '))}</td><td>${escapeHtml(b.instruction)}</td><td class="num">${b.W_cm}</td><td class="num">${ts.length}/${b.nTrials}</td><td class="num">${first} / ${final}</td></tr>`;
    }
    html += '</table>';
    ui.dataBody.innerHTML = html;
  }
  showScreen('data');
}

// --- wiring ---------------------------------------------------------------------------------

$('btn-start').addEventListener('click', startBlock);
$('btn-data').addEventListener('click', showData);
$('btn-resume').addEventListener('click', () => {
  if (cur) beginTrial();
});
$('btn-abandon').addEventListener('click', () => {
  if (cur && confirm('放弃这一组？已经答完的试次会保留。')) endBlock(false);
});
ui.arLink.addEventListener('click', onOpenAR);
ui.cAnswer.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) pick(ui.cAnswer, 'answer', b);
});
ui.cScaled.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) pick(ui.cScaled, 'scaled', b);
});
ui.cStrat.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) toggleStrategy(b);
});
ui.fConf.addEventListener('input', () => {
  ui.confVal.textContent = ui.fConf.value;
});
ui.btnNext.addEventListener('click', commit);
$('btn-end').addEventListener('click', () => {
  if (cur && confirm('结束这一组？已经答完的试次会保留，这一次的回答不会保存。')) endBlock(false);
});
$('btn-sum-send').addEventListener('click', () => sendToPC(blockStore(ui.summaryBody.dataset.blockId), $('sum-send-status')));
$('btn-send-all').addEventListener('click', () => sendToPC(store.loadStore(), $('send-status')));
$('btn-sum-json').addEventListener('click', () => exportStore(blockStore(ui.summaryBody.dataset.blockId), 'block', 'json'));
$('btn-sum-csv').addEventListener('click', () => exportStore(blockStore(ui.summaryBody.dataset.blockId), 'block', 'csv'));
$('btn-sum-back').addEventListener('click', () => {
  initSetup();
  showScreen('setup');
});
$('btn-export-json').addEventListener('click', () => exportStore(store.loadStore(), 'all', 'json'));
$('btn-export-csv').addEventListener('click', () => exportStore(store.loadStore(), 'all', 'csv'));
$('btn-show-csv').addEventListener('click', () => {
  ui.csvText.value = store.toCSV(store.loadStore());
  ui.csvText.classList.remove('hidden');
  ui.csvText.focus();
  ui.csvText.select();
});
$('btn-data-back').addEventListener('click', () => {
  initSetup();
  showScreen('setup');
});
$('btn-clear').addEventListener('click', () => {
  if (!confirm('清空这台手机上的全部自测数据？先确认已经发送或导出。这一步不能撤销。')) return;
  store.clearStore();
  cur = null;
  saveCurrent();
  showData();
});

$('btn-check').addEventListener('click', () => {
  location.href = '/check.html';
});
$('btn-server').classList.toggle('hidden', !hasNative);
$('btn-server').addEventListener('click', () => callNative('openSettings').catch(() => {}));
$('ver').textContent = versionLabel();
try {
  sessionStorage.setItem('arapp/saw-trial-page', '1'); // read by the on-device check (src/check.js)
} catch {
  /* storage blocked */
}
log('trial page loaded');

initSetup();
showScreen('setup');
