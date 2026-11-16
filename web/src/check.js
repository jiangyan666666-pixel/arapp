// Stage 1 on-device check (handoff/PROJECT_OVERVIEW.md §5, stage 1). Pass = the trial page shows
// on the phone, the PC receives logs, and one message goes web → native → web.
// Steps 1–4 run by themselves; step 5 (the server-address screen) needs one tap.
// Every run posts its results to the PC as one log line: "stage1-check".

import { callNative, hasNative, nativeInfo, versionLabel } from './native.js';
import { forwardErrors, log } from './log.js';

forwardErrors();

const $ = (id) => document.getElementById(id);

const STEPS = [
  { id: 'trial', title: '手机上看到试次页', auto: true },
  { id: 'nativeLog', title: '原生层启动时，电脑收到日志', auto: true },
  { id: 'webLog', title: '网页发日志，电脑收到', auto: true },
  { id: 'roundTrip', title: '网页 → 原生 → 网页，消息来回一次', auto: true },
  { id: 'settings', title: '能打开「电脑地址」设置', auto: false, button: '打开设置（看到后点「取消」）' },
];
const REQUIRED = ['trial', 'nativeLog', 'webLog', 'roundTrip']; // the stage-1 pass condition

let results = {};
let runId = 0;

function render() {
  $('steps').innerHTML = '';
  STEPS.forEach((s, i) => {
    const r = results[s.id];
    const state = !r || r.ok === null ? '' : r.ok ? 'ok' : 'bad';
    const card = document.createElement('div');
    card.className = 'card';
    const row = document.createElement('div');
    row.className = `step ${state}`;
    row.innerHTML = `<div class="mark">${state === 'ok' ? '✓' : state === 'bad' ? '✗' : i + 1}</div><div><div class="title"></div><div class="detail"></div></div>`;
    row.querySelector('.title').textContent = s.title;
    row.querySelector('.detail').textContent = r ? r.detail : s.auto ? '检查中…' : '';
    card.appendChild(row);
    if (s.button && !(r && r.ok)) {
      const b = document.createElement('button');
      b.textContent = s.button;
      b.addEventListener('click', () => runSettings());
      card.appendChild(b);
    }
    $('steps').appendChild(card);
  });

  const done = REQUIRED.every((id) => results[id] && results[id].ok !== null);
  const passed = REQUIRED.every((id) => results[id]?.ok);
  const v = $('verdict');
  v.className = done ? (passed ? 'ok' : 'bad') : '';
  v.textContent = !done ? '检查中…' : passed ? '阶段 1 通过 ✓' : '有没通过的项';
  $('verdict-detail').textContent = !done
    ? ''
    : passed
      ? results.settings?.ok
        ? '全部完成。结果已发到电脑，回到对话里告诉 Claude 就行。'
        : '必需的四项都通过了。第 5 项点一下就完成。'
      : '把这一屏截图发给 Claude。';
}

/** ok: true / false, or null while still waiting */
function set(id, ok, detail) {
  results[id] = { ok, detail };
  render();
}

async function report() {
  await log('stage1-check', {
    passed: REQUIRED.every((id) => results[id]?.ok),
    results,
    native: nativeInfo,
    ua: navigator.userAgent,
  });
}

async function runAuto() {
  const my = ++runId;
  results = {};
  render();

  // 1. The trial page sets this flag when it loads (src/iphone-app.js). The app opens the trial
  //    page first, and this page is reached from its button.
  let sawTrial = false;
  try {
    sawTrial = sessionStorage.getItem('arapp/saw-trial-page') === '1';
  } catch {
    /* storage blocked */
  }
  set('trial', sawTrial, sawTrial ? '试次页加载过' : '没记录到试次页加载。先回到试次页，再点「上机检查」');

  // 2. The native startup log is sent by the app itself; ask the app whether it got through.
  //    The first attempt usually fails while iOS asks for local-network permission (-1009), and
  //    the app resends whenever a page finishes loading – i.e. right as this page asks. So keep
  //    asking for a few seconds before calling it a failure.
  if (!hasNative) {
    set('nativeLog', false, '不在 app 里打开的（没有原生层）');
  } else {
    try {
      let s = await callNative('status');
      let waited = 0;
      while (!s.startupLogOK && waited < 8) {
        set('nativeLog', null, `${s.startupLog}，等 app 重发…（${waited} 秒）`);
        await new Promise((r) => setTimeout(r, 1000));
        if (my !== runId) return;
        waited++;
        s = await callNative('status');
      }
      const note = waited ? `（重发后，等了 ${waited} 秒）` : '';
      set('nativeLog', Boolean(s.startupLogOK), `${s.startupLog}${note}（电脑地址 ${s.server}）`);
    } catch (e) {
      set('nativeLog', false, String(e.message || e));
    }
  }
  if (my !== runId) return;

  // 3. Web → PC log.
  const r = await log('check page: web log test');
  if (my !== runId) return;
  set('webLog', r.ok, r.ok ? '电脑收到了' : `失败：${r.error}`);

  // 4. Web → native → web.
  if (!hasNative) {
    set('roundTrip', false, '不在 app 里打开的（没有原生层）');
  } else {
    const token = Math.random().toString(36).slice(2, 8);
    const t0 = performance.now();
    try {
      const reply = await callNative('ping', { token });
      const ms = Math.round(performance.now() - t0);
      const ok = reply.type === 'pong' && reply.echo?.token === token;
      set('roundTrip', ok, ok ? `来回 ${ms < 1 ? '不到 1' : ms} ms` : `回复不对：${JSON.stringify(reply).slice(0, 120)}`);
    } catch (e) {
      set('roundTrip', false, String(e.message || e));
    }
  }
  if (my !== runId) return;
  await report();
}

async function runSettings() {
  try {
    await callNative('openSettings');
    set('settings', true, '设置打开了');
  } catch (e) {
    set('settings', false, String(e.message || e));
  }
  await report();
}

$('ver').textContent = nativeInfo ? `${versionLabel()} · iOS ${nativeInfo.ios} · ${nativeInfo.model}` : versionLabel();
$('btn-again').addEventListener('click', runAuto);
$('btn-back').addEventListener('click', () => {
  location.href = '/';
});
runAuto();
