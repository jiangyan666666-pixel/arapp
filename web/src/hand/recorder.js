// Records what the native layer sends during a few seconds of hand tracking – the raw "ar.hands",
// "ar.status" and "ar.planes" events, untouched – and sends it to the PC (vite.config.js →
// notes/handrec/<time>[_<note>].json). There the same events can be replayed into the tracker as
// often as needed, so tracking is tuned against real data from this phone, not only the simulator.
//
//   const rec = new HandRecorder({ ar: AR });          // AR = the ar.js module
//   rec.start({ note: 'fist', model });                 // model = the scanned hand model (sizes are fine to send)
//   … rec.seconds, rec.count …
//   const r = await rec.stop();                         // or it stops itself after maxSeconds: await rec.done
//   // r = {ok, file, name, count} or {ok: false, error, count}
//
// File: {recordedAt, appVersion, note, model, seconds, events, statuses, planes}; events / statuses /
// planes are lists of {rt, ev}: rt = milliseconds since start on the page's clock (performance.now),
// ev = the event as it arrived. Native times inside ev (t, tSent, now…) are on the phone's own clock.
// BLIND TEST: never record during a trial – a status can carry the furniture's pose (not its size).

import { nativeInfo } from '../native.js';

const clone = (ev) => {
  try {
    return structuredClone(ev); // another listener may change the event object after us
  } catch {
    return JSON.parse(JSON.stringify(ev));
  }
};

export class HandRecorder {
  /** @param {{ar: {onHands: Function, onStatus: Function, onPlanes: Function}}} opts the ar.js module */
  constructor({ ar }) {
    this.ar = ar;
    this.recording = false;
    /** A promise for the result of the current (or last) recording; resolves when it has been sent. */
    this.done = Promise.resolve({ ok: false, error: 'nothing recorded', count: 0 });
    /** The last recording as sent (kept so it can be sent again with upload() if the PC was not reachable). */
    this.last = null;
    this._t0 = 0;
    this._t1 = 0;
    this._lists = { events: [], statuses: [], planes: [] };
    this._off = [];
    this._timer = 0;
    this._resolve = null;
  }

  /** Seconds recorded so far (or the length of the last recording). */
  get seconds() {
    if (!this._t0) return 0;
    return ((this.recording ? performance.now() : this._t1) - this._t0) / 1000;
  }

  /** Hand events recorded so far (or in the last recording). */
  get count() {
    return this._lists.events.length;
  }

  /**
   * @param {{note?: string, maxSeconds?: number, model?: object, onStop?: (result: object) => void}} [opts]
   * @returns {HandRecorder} this
   */
  start({ note = '', maxSeconds = 20, model = null, onStop = null } = {}) {
    if (this.recording) throw new Error('already recording');
    this.recording = true;
    this._note = String(note ?? '');
    this._model = model == null ? null : clone(model);
    this._recordedAt = new Date().toISOString();
    this._lists = { events: [], statuses: [], planes: [] };
    this._t0 = performance.now();
    this._t1 = 0;
    const keep = (list) => (ev) => {
      if (this.recording) list.push({ rt: Math.round((performance.now() - this._t0) * 100) / 100, ev: clone(ev) });
    };
    this._off = [this.ar.onHands(keep(this._lists.events)), this.ar.onStatus(keep(this._lists.statuses)), this.ar.onPlanes(keep(this._lists.planes))];
    this.done = new Promise((resolve) => (this._resolve = resolve));
    if (onStop) {
      this.done.then((r) => {
        try {
          onStop(r);
        } catch (e) {
          console.error(e);
        }
      });
    }
    clearTimeout(this._timer);
    if (maxSeconds > 0) this._timer = setTimeout(() => this.stop(), maxSeconds * 1000);
    return this;
  }

  /**
   * Stops listening and sends the recording to the PC. Calling it again (or after the automatic
   * stop) returns the same result.
   * @returns {Promise<{ok: boolean, file?: string, name?: string, count: number, error?: string}>}
   */
  stop() {
    if (!this.recording) return this.done;
    this.recording = false;
    this._t1 = performance.now();
    clearTimeout(this._timer);
    for (const off of this._off) off();
    this._off = [];
    this.last = {
      recordedAt: this._recordedAt,
      appVersion: nativeInfo?.version ?? 'browser',
      note: this._note,
      model: this._model,
      seconds: Math.round(this.seconds * 1000) / 1000,
      ...this._lists,
    };
    const resolve = this._resolve;
    this.upload(this.last).then(resolve);
    return this.done;
  }

  /**
   * Sends a recording (default: the last one) to the PC. Never rejects.
   * @returns {Promise<{ok: boolean, file?: string, name?: string, count: number, error?: string}>}
   */
  async upload(recording = this.last) {
    const count = recording?.events?.length ?? 0;
    if (!recording) return { ok: false, error: 'nothing recorded', count };
    try {
      const res = await fetch('/__handrec', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(recording),
      });
      const r = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
      return r.ok ? { ok: true, file: r.file, name: r.name, count } : { ok: false, error: r.error || `HTTP ${res.status}`, count };
    } catch (e) {
      return { ok: false, error: String(e.message || e), count };
    }
  }
}
