import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

export default defineConfig(({ mode }) => ({
  base: process.env.BASE_PATH || '/',
  server: { host: true, port: 5173, strictPort: true },
  plugins: mode === 'ssl' ? [basicSsl(), usdzMime, selftestUpload, logReceiver] : [usdzMime, selftestUpload, logReceiver],
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
