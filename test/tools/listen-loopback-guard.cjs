'use strict';
/**
 * TEST-ELECTRON-NONLOOPBACK-LISTEN-FIREWALL-108: no test may open a TCP listener on anything but
 * loopback. A listener on 0.0.0.0 or :: is reachable from the network and makes Windows Firewall
 * ask the person at the desk to allow the test runtime.
 *
 * Loading this file (require, or `--require` as a preload) wraps net.Server.prototype.listen, which
 * http and https servers share. Every TCP bind is checked BEFORE the socket is opened:
 *   - host 127.0.0.1 or ::1: passed through unchanged;
 *   - any other host, or no host at all (Node then binds every interface): refused with a throw.
 * Pipes, unix sockets, fds and ready handles are not TCP binds and pass through.
 *
 * asked(fn) is for a test that must prove product code WOULD bind publicly. While fn runs, each
 * TCP bind is recorded with the host the caller asked for, and a non-loopback one is opened on
 * 127.0.0.1 instead, so the caller's listen() completes and no public socket ever exists.
 *
 * UDP (dgram) is not covered.
 */
const net = require('node:net');

const KEY = Symbol.for('guppy.test.listenLoopbackGuard');
const LOOPBACK = new Set(['127.0.0.1', '::1']);

/** The TCP bind a listen() call asks for, or null when it is a pipe, an fd or a ready handle. */
function tcpBind(args) {
  const first = args[0];
  if (first !== null && typeof first === 'object') {
    if (first._handle || first.handle || typeof first.fd === 'number') return null;
    if (first.port === undefined && typeof first.path === 'string') return null;
    return { host: first.host, options: first };
  }
  if (typeof first === 'string' && !/^\d+$/.test(first)) return null;
  const port = typeof first === 'function' || first == null ? 0 : Number(first);
  return { host: typeof args[1] === 'string' ? args[1] : undefined, port };
}

function install() {
  if (globalThis[KEY]) return globalThis[KEY];
  const state = { recording: null, binds: [] };
  const original = net.Server.prototype.listen;
  net.Server.prototype.listen = function guardedListen(...args) {
    const bind = tcpBind(args);
    if (!bind) return original.apply(this, args);
    const row = { host: bind.host, loopback: LOOPBACK.has(bind.host) };
    state.binds.push(row);
    if (state.recording) state.recording.push(row);
    if (row.loopback) return original.apply(this, args);
    if (!state.recording) {
      const what = bind.host === undefined ? 'every interface (no host given)' : JSON.stringify(bind.host);
      const error = new Error(`listen-loopback-guard: a test asked for a TCP listener on ${what}. ` +
        'Tests bind 127.0.0.1 or ::1 only; prove a public bind with asked().');
      error.code = 'ERR_TEST_NONLOOPBACK_LISTEN';
      throw error;
    }
    const callback = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : undefined;
    const options = bind.options ? { ...bind.options, host: '127.0.0.1' } : { port: bind.port, host: '127.0.0.1' };
    return callback ? original.call(this, options, callback) : original.call(this, options);
  };
  /** Run fn; return the TCP binds it asked for, in order, as { host, loopback }. */
  state.asked = async function asked(fn) {
    if (state.recording) throw new Error('listen-loopback-guard: asked() does not nest');
    const rows = state.recording = [];
    try { await fn(); } finally { state.recording = null; }
    return rows;
  };
  state.original = original;
  globalThis[KEY] = state;
  return state;
}

module.exports = install();
