// Send a log line to the PC (dev server → terminal + notes/logs/). There is no debugger on the
// phone, so this is how Claude sees what happened.
// BLIND TEST: Jiang can read these lines – never pass a trial's width or delta.

import { nativeInfo } from './native.js';

/**
 * @returns {Promise<{ok: boolean, error?: string}>} never rejects
 */
export async function log(message, data, level = 'info') {
  // a PC that is gone can leave a request hanging for over a minute; give up after 8 s
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), 8000) : 0;
  try {
    const res = await fetch('/__log', {
      method: 'POST',
      signal: ctl?.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'web',
        level,
        message: String(message),
        data,
        page: location.pathname,
        version: nativeInfo?.version ?? 'browser',
        t: new Date().toISOString(),
      }),
    });
    const r = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
    return r.ok ? { ok: true } : { ok: false, error: r.error || `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: e?.name === 'AbortError' ? '电脑 8 秒没回应' : String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

/** Forward uncaught errors to the PC. */
export function forwardErrors() {
  window.addEventListener('error', (e) => {
    log(e.message || 'error', { file: e.filename, line: e.lineno, col: e.colno }, 'error');
  });
  window.addEventListener('unhandledrejection', (e) => {
    log(`unhandled rejection: ${e.reason?.message || e.reason}`, undefined, 'error');
  });
}
