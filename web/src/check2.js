// Stage 2 on-device check (handoff/PROJECT_OVERVIEW.md §5, stage 2): a step-by-step guide on
// top of the live AR picture. Pass = the first three questions are all right:
//   1. hand in front of the shelf hides it   2. hand at the shelf's edge: front/back correct
//   3. the size is right (tape measure)
// Recorded only: 4. does the whole shelf fit in the picture while the hand is at its edge;
//   5. a shelf 6 cm wider than a gap: is the extra width visible, with "real objects hide the
//   furniture" on and off;  plus: the server-address screen opens (left over from stage 1) and
//   "capture a frame" reaches the PC (data for stage 3).
// Every answer is saved on the phone and sent to the PC as a log line "stage2-check".
// (check2.html; it was check.html until stage 3 took that name. It still works with the stage-2 app.)
//
// This page is a check, not a trial: widths are shown here. Trials must never show them.

import { callNative, hasAR, hasFeature, hasNative, nativeInfo, versionLabel } from './native.js';
import { forwardErrors, log } from './log.js';
import * as AR from './ar.js';

forwardErrors();

const $ = (id) => document.getElementById(id);
const MODEL = 'shelf';
const SHELF_W = 0.8; // metres
const KEY = 'arapp/stage2-check/v1';

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

// --- state: what survives a reload (st) and what does not (rt) ---

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s && typeof s === 'object' && s.answers) return s;
  } catch {
    /* nothing saved, or storage blocked */
  }
  return { step: 0, answers: {}, startedAt: new Date().toISOString() };
}
const st = loadState();
function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(st));
  } catch {
    /* storage blocked: the answers still go to the PC */
  }
}

const rt = {
  arOn: false,
  starting: false,
  startError: '',
  startInfo: null,
  status: null, // latest ar.status event
  placing: false, // the next tap on the picture puts the shelf there
  busy: false,
  placed: null, // {position, yaw, width, modelId}
  wantWidth: SHELF_W,
  meshOcclusion: true, // real objects hide the furniture: part of the tool since 2026-11-17 (Jiang)
  personOcclusion: true,
  showMesh: false,
  shadow: true,
  prep: null,
  settingsOpened: false,
  captureLines: [],
  capturing: false,
  drafts: {}, // text typed into inputs, so a re-render keeps it
};

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
  if (!hasAR) return false;
  rt.starting = true;
  rt.startError = '';
  render();
  try {
    const info = await AR.start({ meshOcclusion: rt.meshOcclusion, personOcclusion: rt.personOcclusion, debug: rt.showMesh ? ['mesh'] : [] });
    rt.arOn = true;
    rt.startInfo = info;
    rt.placed = null;
    document.documentElement.classList.add('ar');
    log('stage2: ar started', info);
  } catch (e) {
    const code = String(e.message || e);
    rt.startError = START_ERRORS[code] || code;
    log('stage2: ar start failed', { error: code }, 'error');
  }
  rt.starting = false;
  if (rt.arOn && step().ar && !rt.placed) rt.placing = true;
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
AR.onInterrupted((e) => toast(e.interrupted ? 'AR 暂停了（app 不在前台）' : 'AR 继续', 2000));

let toastTimer = 0;
function toast(text, ms = 3000) {
  $('toast').textContent = text;
  $('toast').classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.add('hidden'), ms);
}

function updateHud() {
  const s = rt.status;
  const on = rt.arOn;
  $('hud-track').classList.toggle('hidden', !on);
  $('hud-floor').classList.toggle('hidden', !on);
  $('hud-occ').classList.toggle('hidden', !on);
  if (!on) return;
  const tracking = s ? TRACKING[s.tracking] || s.tracking : '等相机…';
  $('hud-track').textContent = tracking;
  $('hud-track').classList.toggle('warn', Boolean(s) && s.tracking !== 'normal');
  const floor = Boolean(s?.planes?.horizontal);
  $('hud-floor').textContent = rt.placing ? (floor ? '点一下地面放书架' : '还没看到地面：扫一下') : rt.placed ? '书架已放' : '书架没放';
  $('hud-floor').classList.toggle('warn', rt.placing);
  $('hud-occ').textContent = `实物挡家具：${rt.meshOcclusion ? '开' : '关'}`;
  $('hud-occ').classList.toggle('on', rt.meshOcclusion);
}

async function setMeshOcclusion(on) {
  rt.meshOcclusion = on;
  try {
    await AR.setOptions({ meshOcclusion: on });
    log('stage2: mesh occlusion', { on });
  } catch (e) {
    toast(String(e.message || e));
  }
  render();
}

/** Draw the shelf at the wanted width, at its current place. */
async function redraw() {
  if (!rt.placed) return;
  rt.placed.width = rt.wantWidth;
  await AR.setFurniture(MODEL, rt.placed.width, rt.placed.position, rt.placed.yaw, { shadow: rt.shadow });
}

async function setWidth(width) {
  rt.wantWidth = width;
  if (rt.placed && rt.placed.width !== width) {
    try {
      await redraw();
    } catch (e) {
      toast(String(e.message || e));
    }
  }
}

$('tap').addEventListener('click', async (e) => {
  if (!rt.arOn || !rt.placing || rt.busy) return;
  rt.busy = true;
  try {
    const hit = await AR.raycastFloor(e.clientX / window.innerWidth, e.clientY / window.innerHeight);
    const camera = hit?.camera || rt.status?.camera;
    if (!hit || !camera) {
      toast('这里没找到地面。慢慢移动手机扫一下地面，再点一次');
      log('stage2: tap found no floor');
    } else {
      const eye = AR.cameraPosition(camera);
      const yaw = AR.yawToFace(hit.position, eye); // front towards the person
      await AR.setFurniture(MODEL, rt.wantWidth, hit.position, yaw, { shadow: rt.shadow });
      rt.placed = { position: hit.position, yaw, width: rt.wantWidth, modelId: MODEL };
      const below = eye[1] - hit.position[1];
      log('stage2: shelf placed', {
        how: hit.how,
        plane: hit.plane ?? null,
        floorBelowCamera_m: Math.round(below * 100) / 100,
        distance_m: Math.round(Math.hypot(eye[0] - hit.position[0], eye[2] - hit.position[2]) * 100) / 100,
      });
      if (below < 0.5) toast('这个点离手机的高度不到半米，可能不是地面（桌面？）。不对就再点一次', 5000);
      if (step().id !== 'place') rt.placing = false;
    }
  } catch (err) {
    toast(`放书架失败：${err.message || err}`);
    log('stage2: place failed', { error: String(err.message || err) }, 'error');
  }
  rt.busy = false;
  render();
});

async function nudge(dx, dz, dyaw) {
  const f = rt.placed;
  if (!f) return;
  if (hasFeature('groups')) {
    // Stage-3 app: move from where the shelf is NOW. ARKit may have shifted it since it was placed
    // (the anchor follows corrections of the map); working from the tapped pose, as below, made the
    // shelf jump back to where it first stood on every press.
    try {
      const r = await AR.moveGroup('furniture', { dx, dz, dyaw });
      if (r.transform?.length === 16 && rt.placed === f) {
        f.position = AR.cameraPosition(r.transform);
        f.yaw = AR.yawOf(r.transform);
      }
    } catch (e) {
      toast(String(e.message || e));
    }
    return;
  }
  // stage-2 app: it only knows absolute poses
  f.position = AR.nudged(f.position, f.yaw, dx, dz);
  f.yaw += dyaw;
  try {
    await AR.moveFurniture(f.position, f.yaw);
  } catch (e) {
    toast(String(e.message || e));
  }
}

async function captureFrame(note, withMesh = true) {
  if (!rt.arOn || rt.capturing) return null;
  rt.capturing = true;
  render();
  let result;
  try {
    result = await AR.captureToPC({ mesh: withMesh, meshRadius: 4 }, { note, appVersion: nativeInfo?.version ?? 'browser', meshOcclusion: rt.meshOcclusion });
  } catch (e) {
    result = { ok: false, error: String(e.message || e) };
  }
  rt.capturing = false;
  log('stage2: capture', { note, ok: result.ok, dir: result.dir, summary: result.summary, error: result.error }, result.ok ? 'info' : 'error');
  return result;
}

// --- answers ---

/** What the app saw at the moment of an answer – evidence to go with it. */
function context() {
  const s = rt.status;
  return {
    meshOcclusion: rt.meshOcclusion,
    tracking: s?.tracking ?? null,
    person: s?.person ?? null, // how much of the picture ARKit takes for a person (the hand), and how far
    view: AR.furnitureInView(s, rt.placed), // distance to the shelf, corners of it on screen
    anchor: s?.furniture ? { updates: s.furniture.anchorUpdates, shift_m: s.furniture.anchorShift } : null,
  };
}

function passed() {
  return ['q1', 'q2', 'q3'].every((id) => st.answers[id]?.value === 'yes');
}

function report() {
  return log('stage2-check', {
    passed: passed(),
    answers: st.answers,
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
  if ((id === 'q1' || id === 'q2') && value === 'no') {
    // keep what the phone saw, so the failure can be looked at on the PC
    captureFrame(`${id}=no`, false).then(() => render());
  }
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

// --- steps ---

function needApp() {
  if (hasAR) return null;
  return line(hasNative ? '手机上的 app 是旧版，还没有 AR。先用 Sideloadly 装新版本，再来做这个检查。' : '这一页要在 app 里打开（现在没有原生层）。', 'badc');
}

function arBlock() {
  // shown in AR steps while the camera is not running
  if (!hasAR) return [needApp()];
  if (rt.starting) return [line('正在打开相机…')];
  return [rt.startError && line(rt.startError, 'badc'), h('button', { class: 'primary', onclick: ensureAR }, '打开相机')];
}

const notPlaced = () => !rt.placed && line('书架还没放：先在画面上点一下地面。', 'badc');

/** Fine adjustment after the tap: 1 cm / 1° per press, along the shelf's own axes. */
function nudgeRow() {
  const b = (label, dx, dz, dyaw) => h('button', { disabled: !rt.placed, onclick: () => nudge(dx, dz, dyaw) }, label);
  return h(
    'div',
    { class: 'row tight' },
    b('← 左', -0.01, 0, 0),
    b('右 →', 0.01, 0, 0),
    b('往里', 0, -0.01, 0),
    b('往外', 0, 0.01, 0),
    b('↺', 0, 0, Math.PI / 180),
    b('↻', 0, 0, -Math.PI / 180),
  );
}

const STEPS = [
  {
    id: 'prep',
    title: '准备',
    text: () => [
      p('大约 5 分钟。每一步照着做，然后点答案。'),
      p('要用到：一把卷尺；一个空隙（两边有东西，比如两个纸箱之间），第 9–11 步用。现在没有空隙，那三步可以先跳过。'),
    ],
    controls: () => {
      const c = rt.prep;
      return [
        needApp(),
        c && line(c.webLog ? '电脑能收到这一页的日志 ✓' : `电脑收不到日志：${c.webLogError}`, c.webLog ? 'okc' : 'badc'),
        c?.native && line(c.native.startupLogOK ? `电脑收到了 app 的启动日志 ✓（还在排队的日志：${c.native.logPending ?? 0} 条）` : `app 的启动日志还没送到：${c.native.startupLog}`, c.native.startupLogOK ? 'okc' : 'badc'),
        h('button', { class: 'primary', onclick: () => go(1) }, '开始'),
        Object.keys(st.answers).length > 0 && h('button', { onclick: restart }, '清掉上次的答案，从头来'),
      ];
    },
  },
  {
    id: 'settings',
    title: '打开「电脑地址」设置',
    text: () => [p('点下面的按钮，应该弹出一页「设置」，里面是电脑的地址。看到以后点左上角的「取消」回来。')],
    controls: () => [
      h(
        'button',
        {
          class: rt.settingsOpened ? '' : 'primary',
          onclick: async () => {
            try {
              await callNative('openSettings');
              rt.settingsOpened = true;
            } catch (e) {
              toast(String(e.message || e));
            }
            render();
          },
        },
        '打开设置',
      ),
      ...choices('settings', [
        ['yes', '看到了设置页，已取消'],
        ['no', '没有出现'],
      ]),
    ],
  },
  {
    id: 'camera',
    title: '打开相机',
    text: () => [p('点「打开相机」。iPhone 第一次会问能不能用相机，点「允许」。'), p('打开以后，这一页会变透明，后面是相机画面。')],
    controls: () => {
      if (!rt.arOn) return arBlock();
      const info = rt.startInfo || {};
      const has = (name) => (info.frameSemantics || []).includes(name);
      return [
        line('相机打开了 ✓', 'okc'),
        line(`手挡家具：${has('personSegmentationWithDepth') ? '可用 ✓' : '不可用 ✗'}　LiDAR 深度：${has('sceneDepth') ? '可用 ✓' : '没开'}　LiDAR 网格：${info.sceneReconstruction ? '可用 ✓' : '不可用 ✗'}`),
        info.skippedSemantics?.length > 0 && line(`不能同时开的：${info.skippedSemantics.join('、')}`, 'badc'),
        h('button', { class: 'primary', onclick: () => go(st.step + 1) }, '下一步'),
      ];
    },
  },
  {
    id: 'place',
    title: '放书架',
    ar: true,
    text: () => [
      p('慢慢左右移动手机，让它看到地面。然后在画面上点一下 1.5–2 米外的地面。'),
      p('一个宽 80、高 180、深 30 cm 的书架会站在那里，正面朝你。位置差得多就再点一次；差一点或者歪了，用下面的按钮挪（每按一下 1 cm 或 1°）。'),
    ],
    controls: () => [nudgeRow(), h('button', { class: 'primary', disabled: !rt.placed, onclick: () => go(st.step + 1) }, rt.placed ? '放好了，下一步' : '先点一下地面')],
  },
  {
    id: 'q1',
    title: '① 手在书架前面',
    ar: true,
    text: () => [p('把一只手伸到手机和书架之间。'), p('手能挡住书架吗？（手的地方看到的是手，不是书架）')],
    controls: () => [notPlaced(), noteInput('q1'), ...choices('q1', [['yes', '能挡住'], ['no', '挡不住']])],
  },
  {
    id: 'q2',
    title: '② 手扶着书架的边',
    ar: true,
    text: () => [
      p('走到书架旁边，用手去「扶」它的侧边。'),
      p('手在书架前面的部分应该盖住书架；伸到书架后面的部分应该被书架挡住。看上去对吗？'),
    ],
    controls: () => [notPlaced(), noteInput('q2'), ...choices('q2', [['yes', '对'], ['no', '不对']])],
  },
  {
    id: 'q3',
    title: '③ 尺寸',
    ar: true,
    text: () => [
      p('把卷尺拉开，平放在地上。用下面的按钮把书架挪到正面的底边紧贴卷尺、和卷尺平行（每按一下 1 cm 或 1°）。'),
      p('从手机里看：书架的左下角、右下角各对到卷尺的多少厘米？尽量从角的正上方看，斜着看会偏。'),
    ],
    controls: () => {
      const result = h('div', { class: 'line' });
      const update = () => {
        const l = num('q3:left');
        const r = num('q3:right');
        result.textContent = l == null || r == null ? '应该是 80 cm。' : `量到 ${Math.round(Math.abs(r - l) * 10) / 10} cm（应该是 80 cm）。`;
      };
      update();
      const measured = () => {
        const l = num('q3:left');
        const r = num('q3:right');
        return { left_cm: l, right_cm: r, width_cm: l == null || r == null ? null : Math.round(Math.abs(r - l) * 10) / 10, expected_cm: 80 };
      };
      return [
        notPlaced(),
        nudgeRow(),
        h(
          'div',
          { class: 'row' },
          h('label', {}, '左下角（cm）', input('q3:left', { type: 'number', inputmode: 'decimal', step: '0.1' }, update)),
          h('label', {}, '右下角（cm）', input('q3:right', { type: 'number', inputmode: 'decimal', step: '0.1' }, update)),
        ),
        result,
        noteInput('q3'),
        h('button', { class: st.answers.q3?.value === 'yes' ? 'chosen' : '', onclick: () => answer('q3', 'yes', { extra: measured() }) }, '尺寸对（差 1 cm 以内）'),
        h('button', { class: st.answers.q3?.value === 'no' ? 'chosen' : '', onclick: () => answer('q3', 'no', { extra: measured() }) }, '尺寸不对'),
      ];
    },
  },
  {
    id: 'q4',
    title: '④ 手扶边时，书架装得进画面吗',
    ar: true,
    text: () => [p('还是用手扶着书架的侧边，手机拿在平时看的位置。'), p('这时整个书架（从底到顶、从左到右）都在画面里吗？这一项只记录，不算通过条件。')],
    controls: () => [notPlaced(), noteInput('q4'), ...choices('q4', [['yes', '整个都在画面里'], ['no', '装不下']])],
  },
  {
    id: 'q5place',
    title: '⑤ 把宽 6 cm 的书架放进空隙',
    ar: true,
    text: () => [
      p('用卷尺量空隙的宽度，填在下面，点「用这个宽度」：书架会变成比空隙宽 6 cm。'),
      p('站在空隙正前方，点一下空隙中间的地面。再用按钮把书架挪到正中、摆正（每按一下 1 cm 或 1°）。'),
    ],
    controls: () => {
      const w = num('q5:gap');
      const applied = st.answers.q5gap?.gap_cm;
      return [
        h(
          'div',
          { class: 'row' },
          h('label', {}, '空隙宽度（cm）', input('q5:gap', { type: 'number', inputmode: 'decimal', step: '0.1' })),
          h(
            'button',
            {
              class: 'primary',
              onclick: async () => {
                const gap = num('q5:gap');
                if (gap == null || gap < 20 || gap > 300) return toast('先填空隙的宽度（厘米）');
                st.answers.q5gap = { gap_cm: gap, at: new Date().toISOString() };
                save();
                await setWidth((gap + 6) / 100);
                rt.placing = true;
                toast('点一下空隙中间的地面');
                render();
              },
            },
            '用这个宽度',
          ),
        ),
        applied != null && line(`现在的书架宽 ${applied + 6} cm（空隙 ${applied} cm）${w != null && w !== applied ? '。宽度改了，要再点一次「用这个宽度」' : ''}`),
        nudgeRow(),
        h('button', { class: 'primary', disabled: !rt.placed || applied == null, onclick: () => go(st.step + 1) }, '摆好了，下一步'),
      ];
    },
  },
  {
    id: 'q5',
    title: '⑤ 宽出来的部分看得见吗',
    ar: true,
    text: () => [p('书架比空隙宽 6 cm，左右各宽出来一条。点上面的「实物挡家具」，开、关各看一眼。'), p('宽出来的那两条，看得见吗？这一项只记录。')],
    controls: () => {
      const applied = st.answers.q5gap?.gap_cm;
      const question = (id, label) => [
        line(label),
        h('div', { class: 'row' }, ...choices(id, [['visible', '看得见'], ['hidden', '看不见'], ['unsure', '说不清']], { stay: true, extra: { gap_cm: applied ?? null } })),
      ];
      return [
        notPlaced(),
        h('button', { class: rt.meshOcclusion ? 'chosen' : '', onclick: () => setMeshOcclusion(!rt.meshOcclusion) }, `实物挡家具：现在是「${rt.meshOcclusion ? '开' : '关'}」，点一下切换`),
        h('button', { class: rt.showMesh ? 'chosen' : '', onclick: toggleMesh }, rt.showMesh ? '隐藏 LiDAR 网格' : '显示 LiDAR 网格（手机认为箱子的边在哪）'),
        ...question('q5on', '「实物挡家具」开着时，宽出来的部分：'),
        ...question('q5off', '「实物挡家具」关着时，宽出来的部分：'),
        noteInput('q5'),
        h(
          'button',
          {
            class: 'primary',
            onclick: () => {
              const note = (rt.drafts['note:q5'] || '').trim();
              if (note) {
                st.answers.q5note = { note, at: new Date().toISOString() };
                save();
                report();
              }
              go(st.step + 1);
            },
          },
          '下一步',
        ),
      ];
    },
  },
  {
    id: 'capture',
    title: '采一帧',
    ar: true,
    text: () => [
      p('这一步是给下一阶段（自动对准空隙）准备数据。'),
      p('站在空隙正前方 1.5–2 米，让空隙和两边的东西都在画面里，拿稳，点「采一帧」。建议采 3 帧：正前方、偏左一步、偏右一步。'),
    ],
    controls: () => [
      h(
        'button',
        {
          class: 'primary',
          disabled: rt.capturing,
          onclick: async () => {
            const r = await captureFrame('gap', true);
            if (r) {
              const s = r.summary || {};
              rt.captureLines.push(
                r.ok
                  ? `第 ${rt.captureLines.length + 1} 帧：电脑收到了 ✓（深度 ${s.depth ?? '没有'}，画面中间 ${s.depthCentre_m ?? '?'} m，网格 ${s.meshes ?? 0} 块）`
                  : `第 ${rt.captureLines.length + 1} 帧：失败 ✗ ${r.error}`,
              );
              st.answers.capture = { count: rt.captureLines.filter((l) => l.includes('✓')).length, at: new Date().toISOString(), last: r.dir ?? null, depthSource: s.depthSource ?? null };
              save();
              report();
            }
            render();
          },
        },
        rt.capturing ? '正在采…' : '采一帧',
      ),
      ...rt.captureLines.map((l) => line(l, l.includes('✓') ? 'okc' : 'badc')),
      h('button', { onclick: () => go(st.step + 1) }, '采完了，下一步'),
    ],
  },
  {
    id: 'done',
    title: '结果',
    ar: true,
    text: () => {
      const a = st.answers;
      const mark = (id, yes = 'yes') => (a[id] ? (a[id].value === yes ? '✓' : '✗') : '没做');
      const all = ['q1', 'q2', 'q3'].every((id) => a[id]);
      return [
        h('p', { class: all ? (passed() ? 'okc' : 'badc') : '' }, all ? (passed() ? '前三项都对：阶段 2 的通过条件达到了 ✓' : '前三项里有不对的。') : '前三项还没做完。'),
        p(`① 手挡书架 ${mark('q1')}　② 手扶边 ${mark('q2')}　③ 尺寸 ${mark('q3')}${a.q3?.width_cm != null ? `（量到 ${a.q3.width_cm} cm）` : ''}`),
        p(`④ 装得进画面：${a.q4 ? (a.q4.value === 'yes' ? '装得下' : '装不下') : '没做'}　⑤ 宽出来的部分：开 ${words(a.q5on)}／关 ${words(a.q5off)}`),
        p(`改地址页面 ${mark('settings')}　采到 ${a.capture?.count ?? 0} 帧`),
        p('结果已经发到电脑。回到对话里告诉 Claude 就行。下面的按钮可以随便试，不影响结果。'),
      ];
    },
    controls: () => [
      h('div', { class: 'row' }, h('button', { class: rt.personOcclusion ? 'chosen' : '', onclick: togglePerson }, `手挡家具：${rt.personOcclusion ? '开' : '关'}`), h('button', { class: rt.showMesh ? 'chosen' : '', onclick: toggleMesh }, `LiDAR 网格：${rt.showMesh ? '显示' : '隐藏'}`)),
      h('div', { class: 'row' }, h('button', { class: rt.shadow ? 'chosen' : '', onclick: toggleShadow }, `影子：${rt.shadow ? '开' : '关'}`), h('button', { disabled: rt.capturing, onclick: () => captureFrame('free', true).then((r) => (toast(r?.ok ? '电脑收到了' : `失败：${r?.error}`), render())) }, rt.capturing ? '正在采…' : '采一帧')),
      h('button', { onclick: () => setWidth(SHELF_W).then(render) }, '书架变回 80 cm'),
      h('button', { onclick: () => (location.href = '/') }, '回到试次页'),
      h('button', { onclick: restart }, '清掉答案，从头再做一遍'),
    ],
  },
];

const words = (a) => (!a ? '没做' : { visible: '看得见', hidden: '看不见', unsure: '说不清' }[a.value] || a.value);
const step = () => STEPS[Math.min(Math.max(st.step, 0), STEPS.length - 1)];

async function toggleMesh() {
  rt.showMesh = !rt.showMesh;
  await AR.setOptions({ debug: rt.showMesh ? ['mesh'] : [] }).catch((e) => toast(String(e.message || e)));
  render();
}
async function togglePerson() {
  rt.personOcclusion = !rt.personOcclusion;
  await AR.setOptions({ personOcclusion: rt.personOcclusion }).catch((e) => toast(String(e.message || e)));
  log('stage2: person occlusion', { on: rt.personOcclusion });
  render();
}
async function toggleShadow() {
  rt.shadow = !rt.shadow;
  await redraw().catch((e) => toast(String(e.message || e)));
  render();
}

function restart() {
  st.step = 0;
  st.answers = {};
  st.startedAt = new Date().toISOString();
  rt.drafts = {};
  rt.captureLines = [];
  save();
  go(0);
}

function go(index) {
  st.step = Math.min(Math.max(index, 0), STEPS.length - 1);
  save();
  enter();
  render();
}

/** Things that depend on which step is showing. */
function enter() {
  const s = step();
  $('panel').classList.remove('folded');
  if (!s.ar) {
    rt.placing = false;
    return;
  }
  // every AR step uses the 80 cm shelf, except ⑤ and what follows it (they keep the gap's shelf)
  if (s.id === 'q5place' && st.answers.q5gap) setWidth((st.answers.q5gap.gap_cm + 6) / 100);
  if (['place', 'q1', 'q2', 'q3', 'q4'].includes(s.id)) setWidth(SHELF_W);
  rt.placing = s.id === 'place' || !rt.placed;
  if (!rt.arOn) ensureAR();
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
  $('btn-prev').disabled = index === 0;
  $('btn-skip').classList.toggle('hidden', index === STEPS.length - 1);
  $('btn-replace').classList.toggle('hidden', !(s.ar && rt.arOn && s.id !== 'place'));
  $('btn-replace').textContent = rt.placing ? '点一下地面…' : '重新放书架';
  updateHud();
}

$('btn-prev').addEventListener('click', () => go(st.step - 1));
$('btn-skip').addEventListener('click', () => go(st.step + 1));
$('btn-replace').addEventListener('click', () => {
  rt.placing = !rt.placing;
  render();
});
// The dev server no longer reloads the page when it changes (vite.config.js): this does it by hand.
$('btn-reload').addEventListener('click', () => location.reload());
$('btn-fold').addEventListener('click', () => {
  $('panel').classList.toggle('folded');
  render();
});
$('hud-occ').addEventListener('click', () => setMeshOcclusion(!rt.meshOcclusion));
$('ver').textContent = nativeInfo ? `${versionLabel()} · iOS ${nativeInfo.ios} · ${nativeInfo.model}` : versionLabel();

async function prepChecks() {
  const web = await log('stage2 check page opened', { step: step().id });
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

enter();
render();
prepChecks();
