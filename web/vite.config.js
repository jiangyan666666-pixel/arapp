import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
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

// Dev only: hand recordings (src/hand/recorder.js). The phone records the raw "ar.hands" /
// "ar.status" / "ar.planes" events for a few seconds and sends them here, so hand tracking can be
// replayed and tuned on the PC against real data.
//   POST /__handrec          a JSON object, at most 64 MB → notes/handrec/<YYYY-MM-DD_HH-MM-SS>[_<note>].json
//                            reply {ok, file, name}
//   GET  /__handrec          {ok, names: [...]} newest first
//   GET  /__handrec/<name>   that file
// Names are ours ([A-Za-z0-9_.-], ending .json), so a request can never reach outside the folder.
// BLIND TEST: a recording carries hand sizes only; the terminal line carries no furniture size.
const HANDREC_DIR = resolve(NOTES_DIR, 'handrec');
const HANDREC_MAX = 64 * 1024 * 1024;
const HANDREC_NAME = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.json$/;
const handrecReceiver = {
  name: 'handrec-receiver',
  configureServer(server) {
    server.middlewares.use('/__handrec', (req, res) => {
      const reply = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
        res.end(JSON.stringify(obj));
      };
      const path = (req.url || '/').split(/[?#]/)[0];
      if (req.method === 'GET') {
        if (path === '/' || path === '') {
          let names = [];
          if (existsSync(HANDREC_DIR)) {
            names = readdirSync(HANDREC_DIR)
              .filter((n) => HANDREC_NAME.test(n))
              .map((n) => ({ n, t: statSync(resolve(HANDREC_DIR, n)).mtimeMs }))
              .sort((a, b) => b.t - a.t || (a.n < b.n ? 1 : -1))
              .map((e) => e.n);
          }
          return reply(200, { ok: true, names });
        }
        let name;
        try {
          name = decodeURIComponent(path.slice(1));
        } catch {
          return reply(400, { ok: false, error: 'bad name' });
        }
        const file = resolve(HANDREC_DIR, name);
        if (!path.startsWith('/') || !HANDREC_NAME.test(name) || name.includes('..') || dirname(file) !== HANDREC_DIR) {
          return reply(400, { ok: false, error: 'bad name' });
        }
        readFile(file).then(
          (body) => {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': body.length, 'Cache-Control': 'no-cache' });
            res.end(body);
          },
          () => reply(404, { ok: false, error: 'no such recording' }),
        );
        return;
      }
      if (req.method !== 'POST' || (path !== '/' && path !== '')) return reply(405, { ok: false, error: 'POST /__handrec or GET' });
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > 2 * HANDREC_MAX) req.destroy(); // not a recording; stop reading
        else if (size <= HANDREC_MAX) chunks.push(c);
      });
      req.on('end', () => {
        if (size > HANDREC_MAX) return reply(413, { ok: false, error: `more than ${HANDREC_MAX / 1024 / 1024} MB` });
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('need a JSON object');
          const now = new Date();
          const stamp = `${now.toLocaleDateString('sv-SE')}_${now.toLocaleTimeString('sv-SE').replace(/:/g, '-')}`;
          const slug = String(data.note ?? '')
            .normalize('NFKD')
            .replace(/[^A-Za-z0-9]+/g, '-')
            .replace(/^-+/, '')
            .slice(0, 40)
            .replace(/-+$/, '');
          const base = slug ? `${stamp}_${slug}` : stamp;
          let name = `${base}.json`;
          for (let n = 2; existsSync(resolve(HANDREC_DIR, name)); n++) name = `${base}_${n}.json`;
          mkdirSync(HANDREC_DIR, { recursive: true });
          writeFileSync(resolve(HANDREC_DIR, name), JSON.stringify({ receivedAt: now.toISOString(), ip: req.socket.remoteAddress, ...data }));
          const file = `notes/handrec/${name}`;
          const count = (k) => (Array.isArray(data[k]) ? data[k].length : 0);
          const rolling = data.rolling > 0 && Number.isFinite(data.attemptSeconds) && data.attemptSeconds > data.rolling ? ` (the last ${data.rolling} s of ${data.attemptSeconds.toFixed(1)} s)` : '';
          const secs = Number.isFinite(data.seconds) ? ` ${data.seconds.toFixed(1)} s${rolling},` : '';
          server.config.logger.info(
            `[handrec] saved ${file} (${(size / 1024 / 1024).toFixed(1)} MB,${secs} ${count('events')} hand events, ${count('statuses')} statuses, ${count('planes')} plane lists)`,
            { timestamp: true },
          );
          reply(200, { ok: true, file, name });
        } catch (e) {
          reply(400, { ok: false, error: String(e.message || e) });
        }
      });
    });
  },
};

// Dev only: pages never reload by themselves. Vite's client (/@vite/client, put into every page)
// reloads the page when a file changes and whenever its websocket to this server reconnects – which
// on the phone is every time the app comes back from the background, because iOS closes the socket.
// A reload wipes the scanned hand model and everything placed in the AR world, so:
//   server.hmr: false  the server sends no updates when files change;
//   server.ws: false   there is no websocket server at all (Vite 8.3.6 puts a no-op channel in its
//                      place). The client would still try to connect, fail twice, print an error
//                      and stop: it only polls the server and reloads after a socket that WAS open
//                      closes ("vite:ws:disconnect"), and none ever opens.
// To keep even that failed attempt and its console error out, the plugin below leaves the client's
// script tag out of the pages (nothing in src/ uses import.meta.hot or imports CSS from JS, the
// only other ways it gets loaded). A page now changes only when it is reloaded by hand (the
// 刷新页面 buttons). Pages opened before this was switched on still run the old client – reload
// them once by hand. If Vite re-bundles dependencies while a page is open, it can no longer tell
// the page: reload by hand if a page fails to load after adding an import of a new package.
const noAutoReload = {
  name: 'no-auto-reload',
  apply: 'serve',
  transformIndexHtml: {
    order: 'post',
    handler: (html) => html.replace(/<script type="module" src="[^"]*\/@vite\/client"><\/script>\s*/g, ''),
  },
};

export default defineConfig(({ mode }) => ({
  base: process.env.BASE_PATH || '/',
  server: { host: true, port: 5173, strictPort: true, hmr: false, ws: false },
  plugins: [...(mode === 'ssl' ? [basicSsl()] : []), noAutoReload, usdzMime, selftestUpload, logReceiver, captureReceiver, handrecReceiver],
  // pre-bundle three and the addon together so dev doesn't load two copies of three
  optimizeDeps: { include: ['three', 'three/addons/loaders/GLTFLoader.js', 'three/addons/exporters/USDZExporter.js'] },
  build: {
    target: 'es2022',
    sourcemap: true,
    rolldownOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'), // the trial page
        check: resolve(import.meta.dirname, 'check.html'), // on-device check for the current stage (3)
        check2: resolve(import.meta.dirname, 'check2.html'), // the stage-2 check, kept for the stage-2 app
      },
    },
  },
}));
