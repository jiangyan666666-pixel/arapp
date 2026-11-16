// A pretend native layer for running the pages on the PC (check.html?fake). It answers the same
// messages as ios/ARApp (WebView.swift, ARController.swift) with made-up but plausible values,
// and paints a stand-in for the camera picture. It proves the page's own logic only – nothing
// about the real app. Loaded by check-boot.js before any other module.

const reply = (id, payload, delay = 5) => setTimeout(() => window.__fromNative?.({ id, ...payload }), delay);
const emit = (event) => window.__nativeEvent?.(event);

// camera 1.4 m above the floor at the origin, looking along -Z, tilted down a little
const CAMERA = [1, 0, 0, 0, 0, 0.966, 0.259, 0, 0, -0.259, 0.966, 0, 0, 1.4, 0, 1];
const VIEW = [1, 0, 0, 0, 0, 0.966, -0.259, 0, 0, 0.259, 0.966, 0, 0, -1.352, -0.363, 1];
const PROJECTION = [1.6, 0, 0, 0, 0, 0.74, 0, 0, 0, 0, -1.0002, -1, 0, 0, -0.02, 0];

const fake = {
  running: false,
  timer: 0,
  options: {},
  furniture: null,
  log: [],
};
window.__fakeNative = fake; // for poking at it from the console

function b64(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes.buffer)) s += String.fromCharCode(b);
  return btoa(s);
}

const handlers = {
  ping: (p) => ({ type: 'pong', echo: p, nativeTime: Date.now() }),
  status: () => ({ server: location.origin, startupLog: '电脑收到了', startupLogOK: true, logPending: 0, version: 'fake', buildTime: 'fake' }),
  openSettings: () => ({ ok: true }),
  'ar.start': (p) => {
    fake.running = true;
    fake.options = { ...p };
    fake.furniture = null;
    clearInterval(fake.timer);
    let n = 0;
    fake.timer = setInterval(() => {
      n++;
      emit({
        type: 'ar.status',
        t: n / 4,
        tracking: n < 6 ? 'initializing' : 'normal',
        mapping: 'extending',
        camera: CAMERA,
        view: VIEW,
        projection: PROJECTION,
        planes: { horizontal: n < 8 ? 0 : 1, vertical: 0 },
        meshAnchors: 12,
        hasDepth: true,
        person: { fraction: 0 },
        ...(fake.furniture ? { furniture: { transform: [], anchorUpdates: 0, anchorShift: 0 } } : {}),
      });
    }, 250);
    document.documentElement.style.setProperty('background', 'linear-gradient(#5b6b7a 0%, #8a8f94 45%, #6d5c4a 46%, #4a3d30 100%)', 'important');
    return {
      ok: true,
      support: { sceneReconstruction: true, personSegmentationWithDepth: true, sceneDepth: true, smoothedSceneDepth: true },
      frameSemantics: ['personSegmentationWithDepth', 'sceneDepth'],
      skippedSemantics: [],
      sceneReconstruction: true,
      viewport: [window.innerWidth, window.innerHeight],
    };
  },
  'ar.stop': () => {
    clearInterval(fake.timer);
    const wasRunning = fake.running;
    fake.running = false;
    return { ok: true, wasRunning };
  },
  'ar.setOptions': (p) => {
    Object.assign(fake.options, p);
    return { ok: true, running: fake.running, meshOcclusion: Boolean(fake.options.meshOcclusion) };
  },
  'ar.state': () => ({ ok: true, running: fake.running }),
  'ar.raycast': (p) => {
    if (!fake.running) return { error: 'ar-not-running' };
    // taps in the lower part of the picture hit the floor 1–3 m ahead; the "sky" hits nothing
    if (p.y < 0.46 || p.allowing === 'existingPlaneGeometry') return { ok: true, hits: [], camera: CAMERA };
    const z = -(1 + (1 - p.y) * 4);
    const x = (p.x - 0.5) * 1.5;
    return { ok: true, hits: [{ position: [x, 0, z], transform: [], alignment: 'horizontal', plane: 'floor' }], camera: CAMERA };
  },
  'ar.setFurniture': (p) => {
    if (!Array.isArray(p.boxes) || !p.boxes.length) return { error: 'bad-boxes' };
    fake.furniture = { boxes: p.boxes, position: p.position, yaw: p.yaw, shadow: p.shadow };
    return { ok: true };
  },
  'ar.moveFurniture': (p) => {
    if (!fake.furniture) return { error: 'no-furniture' };
    Object.assign(fake.furniture, { position: p.position, yaw: p.yaw });
    return { ok: true };
  },
  'ar.clearFurniture': () => {
    fake.furniture = null;
    return { ok: true };
  },
  'ar.capture': (p) => {
    if (!fake.running) return { error: 'ar-not-running' };
    const w = 16;
    const hgt = 12;
    const depth = new Float32Array(w * hgt).map((_, i) => 1.5 + (i % w) * 0.05);
    const out = {
      ok: true,
      timestamp: 1,
      tracking: 'normal',
      camera: { transform: CAMERA, intrinsics: [1400, 0, 0, 0, 1400, 0, 960, 720, 1], imageResolution: [1920, 1440], viewport: [393, 852] },
      depthSource: 'sceneDepth',
      depth: { width: w, height: hgt, format: 'fdep', bytesPerPixel: 4, base64: b64(depth) },
      confidence: { width: w, height: hgt, format: 'L008', bytesPerPixel: 1, base64: b64(new Uint8Array(w * hgt).fill(2)) },
      planes: [{ alignment: 'horizontal', class: 'floor', transform: [], center: [0, 0, 0], extent: [2, 3], rotationOnYAxis: 0 }],
    };
    if (p.mesh) {
      out.meshes = [{ transform: [], vertexCount: 3, vertexStride: 12, faceCount: 1, indicesPerFace: 3, bytesPerIndex: 4, vertices: b64(new Float32Array(9)), faces: b64(new Uint32Array([0, 1, 2])) }];
    }
    return out;
  },
};

window.__nativeInfo = { version: 'fake', buildTime: 'fake', label: '版本 fake（电脑上的假原生层）', ios: '0', model: 'PC', features: ['ar'] };
window.webkit = {
  messageHandlers: {
    native: {
      postMessage({ type, id, payload }) {
        fake.log.push({ type, payload });
        const handler = handlers[type];
        reply(id, handler ? handler(payload || {}) : { error: `unknown message type: ${type}` }, type === 'ar.start' ? 400 : 5);
      },
    },
  },
};
