import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// `npm run dev`      -> http on LAN + localhost (use USB port forwarding for the phone)
// `npm run dev:ssl`  -> self-signed https on LAN (accept the warning once on the phone)
// BASE_PATH=/repo/   -> for GitHub Pages builds
// iPhone AR Quick Look only opens .usdz served as model/vnd.usdz+zip; Vite's static
// server sends no content type for it, so serve those files ourselves in dev.
const usdzMime = {
  name: 'usdz-mime',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const path = decodeURIComponent((req.url || '').split(/[?#]/)[0]);
      if (!path.endsWith('.usdz')) return next();
      try {
        const body = readFileSync(resolve(import.meta.dirname, 'public', '.' + path));
        res.writeHead(200, { 'Content-Type': 'model/vnd.usdz+zip', 'Content-Length': body.length, 'Cache-Control': 'no-cache' });
        res.end(body);
      } catch {
        next();
      }
    });
  },
};

// Dev only: the iPhone page can POST its self-test store here and it lands in
// <project root>/notes/selftest/ on the PC (iOS has no easy way to hand a downloaded file to Windows).
// Accepts only a JSON object with blocks[] and trials[], at most 5 MB; the file name is ours.
const NOTES_DIR = resolve(import.meta.dirname, '..', 'notes');
const selftestUpload = {
  name: 'selftest-upload',
  configureServer(server) {
    server.middlewares.use('/__selftest/upload', (req, res) => {
      const reply = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.method !== 'POST') return reply(405, { ok: false, error: 'POST only' });
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > 5 * 1024 * 1024) req.destroy();
        else chunks.push(c);
      });
      req.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!data || !Array.isArray(data.blocks) || !Array.isArray(data.trials)) throw new Error('need {blocks: [], trials: []}');
          const dir = resolve(NOTES_DIR, 'selftest');
          mkdirSync(dir, { recursive: true });
          const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
          const name = `iphone-${stamp}-${data.blocks.length}b-${data.trials.length}t.json`;
          writeFileSync(resolve(dir, name), JSON.stringify({ receivedAt: new Date().toISOString(), ...data }, null, 2));
          server.config.logger.info(`[selftest] saved notes/selftest/${name}`);
          reply(200, { ok: true, file: `notes/selftest/${name}` });
        } catch (e) {
          reply(400, { ok: false, error: String(e.message || e) });
        }
      });
    });
  },
};

// Dev only: the app has no debugger attached, so native code and the web pages POST log
// lines here. Each line is printed in the dev-server terminal and appended to
// <project root>/notes/logs/YYYY-MM-DD.jsonl. Body: {source, level, message, data?, ...}, at most 256 KB.
// BLIND TEST: Jiang watches this terminal – never log a trial's width or delta.
const logReceiver = {
  name: 'log-receiver',
  configureServer(server) {
    server.middlewares.use('/__log', (req, res) => {
      const reply = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.method !== 'POST') return reply(405, { ok: false, error: 'POST only' });
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > 256 * 1024) req.destroy();
        else chunks.push(c);
      });
      req.on('end', () => {
        try {
          const entry = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('need a JSON object');
          const now = new Date();
          const line = { receivedAt: now.toISOString(), ip: req.socket.remoteAddress, ...entry };
          const dir = resolve(NOTES_DIR, 'logs');
          mkdirSync(dir, { recursive: true });
          const day = now.toLocaleDateString('sv-SE'); // YYYY-MM-DD in the PC's time zone
          appendFileSync(resolve(dir, `${day}.jsonl`), JSON.stringify(line) + '\n');
          const src = String(entry.source || '?');
          const lvl = entry.level && entry.level !== 'info' ? ` ${String(entry.level).toUpperCase()}` : '';
          const data = entry.data === undefined ? '' : ' ' + JSON.stringify(entry.data).slice(0, 300);
          const say = lvl.includes('ERROR') ? server.config.logger.error : server.config.logger.info;
          say.call(server.config.logger, `[${src}${lvl}] ${String(entry.message ?? '').slice(0, 300)}${data}`, { timestamp: true });
          reply(200, { ok: true });
        } catch (e) {
          reply(400, { ok: false, error: String(e.message || e) });
        }
      });
    });
  },
};

// Dev only: "capture a frame" (src/ar.js → captureToPC). The phone sends one AR frame – LiDAR
// depth, camera pose, picture, optionally the LiDAR mesh – and it lands in
// <project root>/notes/captures/<time>/ so algorithms can be tuned on the PC against real data:
//   meta.json                       everything that is not binary (camera matrices, planes, sizes)
//   depth.f32 / confidence.u8       LiDAR depth in metres (Float32, row by row) and its confidence (0–2)
//   personMask.u8 / personDepth.f32 what ARKit sees as a person (the hand), and how far
//   image.jpg                       the camera picture (same orientation as the depth: landscape)
//   mesh-N.vertices.f32 / mesh-N.faces.u32
// At most 96 MB. BLIND TEST: the folder name and the terminal line carry no furniture size.
const BLOBS = { depth: 'depth.f32', confidence: 'confidence.u8', personMask: 'personMask.u8', personDepth: 'personDepth.f32', image: 'image.jpg' };
const captureReceiver = {
  name: 'capture-receiver',
  configureServer(server) {
    server.middlewares.use('/__capture', (req, res) => {
      const reply = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.method !== 'POST') return reply(405, { ok: false, error: 'POST only' });
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > 96 * 1024 * 1024) req.destroy();
        else chunks.push(c);
      });
      req.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!data || typeof data !== 'object' || !data.camera) throw new Error('need a captured frame with {camera}');
          const now = new Date();
          const stamp = `${now.toLocaleDateString('sv-SE')}_${now.toLocaleTimeString('sv-SE').replace(/:/g, '-')}`;
          let dir = resolve(NOTES_DIR, 'captures', stamp);
          for (let n = 2; existsSync(dir); n++) dir = resolve(NOTES_DIR, 'captures', `${stamp}_${n}`);
          mkdirSync(dir, { recursive: true });
          const meta = { receivedAt: now.toISOString(), ip: req.socket.remoteAddress, ...data, files: {} };
          const summary = {};
          for (const [key, file] of Object.entries(BLOBS)) {
            const blob = data[key];
            if (!blob || typeof blob.base64 !== 'string') continue;
            const bytes = Buffer.from(blob.base64, 'base64');
            writeFileSync(resolve(dir, file), bytes);
            const { base64, ...rest } = blob;
            meta[key] = rest;
            meta.files[key] = file;
            summary[key] = `${blob.width}×${blob.height}`;
            if (key === 'depth' && blob.bytesPerPixel === 4 && bytes.length === blob.width * blob.height * 4) {
              // a sanity line for the phone's screen: how far is the middle of the picture, and the range
              const f = new Float32Array(bytes.buffer, bytes.byteOffset, blob.width * blob.height);
              const valid = Array.from(f).filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
              const round = (v) => Math.round(v * 100) / 100;
              summary.depthCentre_m = round(f[Math.floor(blob.height / 2) * blob.width + Math.floor(blob.width / 2)]);
              if (valid.length) {
                summary.depthMin_m = round(valid[0]);
                summary.depthMedian_m = round(valid[valid.length >> 1]);
                summary.depthMax_m = round(valid[valid.length - 1]);
              }
              summary.depthValid = round(valid.length / f.length);
            }
          }
          if (Array.isArray(data.meshes)) {
            let vertices = 0;
            meta.meshes = data.meshes.map((m, i) => {
              const { vertices: v, faces: f, ...rest } = m;
              const files = { vertices: `mesh-${i}.vertices.f32`, faces: `mesh-${i}.faces.u32` };
              writeFileSync(resolve(dir, files.vertices), Buffer.from(String(v || ''), 'base64'));
              writeFileSync(resolve(dir, files.faces), Buffer.from(String(f || ''), 'base64'));
              vertices += m.vertexCount || 0;
              return { ...rest, files };
            });
            summary.meshes = data.meshes.length;
            summary.meshVertices = vertices;
          }
          summary.planes = Array.isArray(data.planes) ? data.planes.length : 0;
          summary.depthSource = data.depthSource;
          meta.summary = summary;
          writeFileSync(resolve(dir, 'meta.json'), JSON.stringify(meta, null, 2));
          const rel = `notes/captures/${dir.split(/[\\/]/).pop()}`;
          server.config.logger.info(`[capture] saved ${rel} (${(size / 1024 / 1024).toFixed(1)} MB) ${JSON.stringify(summary)}`, { timestamp: true });
          reply(200, { ok: true, dir: rel, summary });
        } catch (e) {
          reply(400, { ok: false, error: String(e.message || e) });
        }
      });
    });
  },
};

export default defineConfig(({ mode }) => ({
  base: process.env.BASE_PATH || '/',
  server: { host: true, port: 5173, strictPort: true },
  plugins: [...(mode === 'ssl' ? [basicSsl()] : []), usdzMime, selftestUpload, logReceiver, captureReceiver],
  // pre-bundle three and the addon together so dev doesn't load two copies of three
  optimizeDeps: { include: ['three', 'three/addons/loaders/GLTFLoader.js', 'three/addons/exporters/USDZExporter.js'] },
  build: {
    target: 'es2022',
    sourcemap: true,
    rolldownOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'), // the trial page
        check: resolve(import.meta.dirname, 'check.html'), // on-device check for the current stage
      },
    },
  },
}));
