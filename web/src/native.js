// Bridge to the native iOS layer (ios/ARApp/WebView.swift).
//
//   web → native: window.webkit.messageHandlers.native.postMessage({type, id, payload})
//   native → web: window.__fromNative({id, ...reply})     reply to one message
//                 window.__nativeEvent({type, ...})       unasked, e.g. "ar.status"
//
// callNative() returns a promise for the reply. In a normal browser there is no native layer:
// hasNative is false and callNative() rejects, so pages still work for a desktop run-through.

/** Injected by the app before any page script runs: {version, buildTime, label, ios, model, features}. */
export const nativeInfo = window.__nativeInfo || null;
export const hasNative = Boolean(window.webkit?.messageHandlers?.native);
/** The installed app has the native AR layer (stage 2 and later; the stage-1 app does not). */
export const hasAR = hasNative && Array.isArray(nativeInfo?.features) && nativeInfo.features.includes('ar');

const listeners = new Map(); // event type → Set of functions

window.__nativeEvent = (event) => {
  const set = event && listeners.get(event.type);
  if (!set) return;
  for (const fn of set) {
    try {
      fn(event);
    } catch (e) {
      console.error(e);
    }
  }
};

/** Listen for an event the native layer sends by itself. Returns a function that stops listening. */
export function onNativeEvent(type, fn) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(fn);
  return () => listeners.get(type)?.delete(fn);
}

const pending = new Map();
let seq = 0;

window.__fromNative = (msg) => {
  const p = msg && pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  clearTimeout(p.timer);
  if (msg.error) p.reject(new Error(msg.error));
  else p.resolve(msg);
};

/**
 * @param {string} type  'ping' | 'status' | 'openSettings' | 'ar.*' (see ar.js)
 * @param {any} [payload]
 * @param {number} [timeoutMs]
 * @returns {Promise<object>} the native reply
 */
export function callNative(type, payload = null, timeoutMs = 3000) {
  if (!hasNative) return Promise.reject(new Error('不在 app 里（没有原生层）'));
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`原生层 ${timeoutMs / 1000} 秒内没有回应`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    window.webkit.messageHandlers.native.postMessage({ type, id, payload });
  });
}

/** "版本 abc1234 · 11-16 19:13 JST", or a note that this is a plain browser. */
export function versionLabel() {
  return nativeInfo ? nativeInfo.label : '网页（不在 app 里）';
}
