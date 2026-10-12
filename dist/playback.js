/* Shared playback clock. Charts register a draw(t) callback and are revealed
 * from the first date to the last as the clock advances. */
(function (root) {
  'use strict';
  const DAY = 86400000;
  const stamp = (s) => Date.parse(s + 'T00:00:00Z');
  // About 1.6 s per simulated year, bounded so short tests stay visible and long ones stay watchable.
  function durationFor(from, to) {
    const years = Math.max(0, (to - from) / DAY / 365.25);
    return Math.round(Math.max(3000, Math.min(9000, years * 1600)));
  }
  // Fraction of [from, to] covered at time t, clamped to [0, 1].
  function progress(from, to, t) {
    return to > from ? Math.max(0, Math.min(1, (t - from) / (to - from))) : 1;
  }
  if (typeof module !== 'undefined') { module.exports = { durationFor, progress }; return; }

  const subscribers = new Map(), listeners = new Set();
  let from = 0, to = 0, now = Infinity, frame = null, startedAt = 0, duration = 0;
  const reduce = () => root.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function emit() {
    for (const [el, draw] of subscribers) {
      if (!el.isConnected) { subscribers.delete(el); continue; }
      draw(now);
    }
    for (const fn of listeners) fn(state());
  }
  function state() {
    return { from, to, now, playing: frame !== null, progress: progress(from, to, now) };
  }
  function tick(ts) {
    if (!startedAt) startedAt = ts;
    const k = Math.min(1, (ts - startedAt) / duration);
    now = from + (to - from) * k;
    frame = k < 1 ? requestAnimationFrame(tick) : null;
    if (frame === null) now = Infinity;
    emit();
  }
  function stop() { if (frame !== null) cancelAnimationFrame(frame); frame = null; }
  function play(start, end) {
    stop();
    from = stamp(start); to = stamp(end);
    if (reduce() || !(to > from)) { now = Infinity; emit(); return; }
    duration = durationFor(from, to); startedAt = 0; now = from;
    emit();
    frame = requestAnimationFrame(tick);
  }
  function replay() { if (to > from) play(new Date(from).toISOString().slice(0, 10), new Date(to).toISOString().slice(0, 10)); }
  function finish() { stop(); now = Infinity; emit(); }
  // Register (or replace) the draw callback for an element; it is called immediately.
  function bind(el, draw) { subscribers.set(el, draw); draw(now); }
  function reset() { stop(); subscribers.clear(); now = Infinity; from = to = 0; emit(); }
  root.Playback = { play, replay, finish, bind, reset, now: () => now, state, onChange: (fn) => listeners.add(fn) };
})(globalThis);
