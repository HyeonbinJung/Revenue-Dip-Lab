/* ALL BACKTEST: grid search over any two strategy parameters, plotted as a rotatable 3D CAGR surface.
 * The user picks the X and Y parameters and their from / to / step ranges. Pure helpers are exported for tests. */
(function (root) {
  'use strict';
  const money = (n) => '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const kUSD = (n) => n >= 1000 ? '$' + +(n / 1000).toFixed(1) + 'k' : '$' + n;
  const num = (n) => String(+Number(n).toFixed(6));
  // Sweepable parameters: Strategy form field name -> label, formatting, default range and valid bounds.
  const PARAMS = {
    drop: { label: 'ENTRY DECLINE', short: 'DIP', fmt: (v) => num(v) + '%', tick: (v) => num(v) + '%', range: [5, 30, 1], min: 0.1, max: 99 },
    target: { label: 'TAKE PROFIT', short: 'TP', fmt: (v) => num(v) + '%', tick: (v) => num(v) + '%', range: [5, 50, 5], min: 0.1, max: 1000 },
    base: { label: 'BASE ORDER', short: 'BASE', fmt: money, tick: kUSD, range: [5000, 50000, 5000], min: 1, max: 1e9 },
    extra: { label: 'ADD / 1%', short: 'ADD', fmt: money, tick: kUSD, range: [1000, 50000, 1000], min: 0, max: 1e9 },
    hold: { label: 'MAX HOLDING (M)', short: 'HOLD', fmt: (v) => v + 'M', tick: (v) => String(v), range: [1, 12, 1], min: 1, max: 120, integer: true },
    costBps: { label: 'ONE-WAY COSTS (BPS)', short: 'COST', fmt: (v) => num(v) + ' bps', tick: (v) => num(v), range: [0, 50, 5], min: 0, max: 999 },
  };
  const MAX_RUNS = 20000;
  // Values from..to in step increments (to is included when it lands on a step), or an error message.
  function axisValues(key, from, to, step) {
    const p = PARAMS[key];
    if (!p) return { error: 'Unknown parameter.' };
    if (![from, to, step].every(Number.isFinite)) return { error: `${p.short}: enter from, to and step.` };
    if (step <= 0) return { error: `${p.short}: step must be positive.` };
    if (to <= from) return { error: `${p.short}: "to" must be greater than "from" (a surface needs at least 2 values).` };
    if (from < p.min || to > p.max) return { error: `${p.short}: allowed range is ${p.min}–${p.max}.` };
    if (p.integer && ![from, to, step].every(Number.isInteger)) return { error: `${p.short}: whole numbers only.` };
    const n = Math.floor((to - from) / step + 1e-9) + 1;
    if (n > 2000) return { error: `${p.short}: ${n.toLocaleString()} values; use a larger step.` };
    return { values: Array.from({ length: n }, (_, i) => +(from + i * step).toFixed(10)) };
  }
  // Round-number ticks inside [lo, hi], always including both ends; whole-number steps for integer parameters.
  function niceTicks(lo, hi, count = 5, integer = false) {
    if (!(hi > lo)) return [lo];
    const raw = (hi - lo) / count, mag = 10 ** Math.floor(Math.log10(raw));
    const step = Math.max(integer ? 1 : 0, (integer ? [1, 2, 5, 10] : [1, 2, 2.5, 5, 10]).map((m) => m * mag).find((s) => s >= raw));
    const inner = [];
    for (let v = Math.ceil(lo / step) * step; v < hi; v += step) if (v - lo > step * 0.3 && hi - v > step * 0.3) inner.push(+v.toFixed(10));
    return [lo, ...inner, hi];
  }
  // Sequential one-hue ramp (blue), dark -> light: brighter means higher CAGR on the dark surface.
  const RAMP = ['#184f95', '#1c5cab', '#256abf', '#2a78d6', '#3987e5', '#5598e7', '#6da7ec', '#86b6ef', '#9ec5f4', '#b7d3f6', '#cde2fb'];
  const BANDS = 8;
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  function rampColor(t) {
    t = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
    const f = t * (RAMP.length - 1), i = Math.min(RAMP.length - 2, Math.floor(f)), k = f - i;
    const a = hex(RAMP[i]), b = hex(RAMP[i + 1]);
    return '#' + a.map((v, j) => Math.round(v + (b[j] - v) * k).toString(16).padStart(2, '0')).join('');
  }
  // Contour bands: the surface is painted in BANDS flat steps of the ramp, like a banded volatility surface.
  const band = (t) => Math.min(BANDS - 1, Math.max(0, Math.floor((Number.isFinite(t) ? t : 0) * BANDS)));
  const bandColor = (t) => rampColor(band(t) / (BANDS - 1));
  // Rotate a point in the unit cube by yaw (around the vertical) and pitch, then apply mild perspective.
  function project(x, y, z, view) {
    const cy = Math.cos(view.yaw), sy = Math.sin(view.yaw), cp = Math.cos(view.pitch), sp = Math.sin(view.pitch);
    const x1 = x * cy - y * sy, y1 = x * sy + y * cy;
    const up = z * cp + y1 * sp, depth = y1 * cp - z * sp, s = 4 / (4 + depth);
    return { x: view.cx + x1 * s * view.scale, y: view.cy - up * s * view.scale, depth };
  }
  const span = (lo, hi, v) => hi > lo ? (v - lo) / (hi - lo) * 2 - 1 : 0;
  if (typeof module !== 'undefined') { module.exports = { PARAMS, MAX_RUNS, axisValues, niceTicks, rampColor, bandColor, band, project, RAMP, BANDS }; return; }

  const $ = (id) => document.getElementById(id);
  const canvas = $('sweepCanvas'), stage = canvas.parentElement, tip = $('sweepTip'), ctx = canvas.getContext('2d');
  const pct = (n) => n == null ? '—' : n.toFixed(2) + '%';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const HOME = { yaw: -0.62, pitch: 0.42, zoom: 1 };
  let view = { ...HOME }, points = [], cells = new Map(), worker = null, busy = false, total = 0, hover = null, dirty = true, projected = [], appliedConfig = null;
  // The axes of the grid on screen; replaced from the form when a run starts.
  let X = { key: 'hold', values: [] }, Y = { key: 'extra', values: [] };

  // Axis form: parameter select + from / to / step per axis, remembered per browser.
  const rows = { x: $('sweepAxisX'), y: $('sweepAxisY') };
  const field = (axis, name) => rows[axis].querySelector(`[data-f="${name}"]`);
  for (const axis of ['x', 'y']) field(axis, 'key').innerHTML = Object.entries(PARAMS).map(([k, p]) => `<option value="${k}">${p.label}</option>`).join('');
  function setAxis(axis, key, range = PARAMS[key].range) {
    field(axis, 'key').value = key; field(axis, 'key').dataset.prev = key;
    ['from', 'to', 'step'].forEach((name, i) => { field(axis, name).value = range[i]; });
  }
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('rdl-sweep-axes')); } catch { saved = null; }
  const valid = (a) => a && PARAMS[a.key] && ['from', 'to', 'step'].every((k) => Number.isFinite(a[k]));
  if (valid(saved?.x) && valid(saved?.y) && saved.x.key !== saved.y.key) { setAxis('x', saved.x.key, [saved.x.from, saved.x.to, saved.x.step]); setAxis('y', saved.y.key, [saved.y.from, saved.y.to, saved.y.step]); }
  else { setAxis('x', 'hold'); setAxis('y', 'extra'); }
  function readAxes() {
    const axes = ['x', 'y'].map((axis) => {
      const key = field(axis, 'key').value, [from, to, step] = ['from', 'to', 'step'].map((n) => parseFloat(field(axis, n).value));
      return { axis, key, from, to, step, ...axisValues(key, from, to, step) };
    });
    let error = axes.find((a) => a.error)?.error;
    if (!error && axes[0].key === axes[1].key) error = 'X and Y must be different parameters.';
    const runs = error ? 0 : axes[0].values.length * axes[1].values.length;
    if (!error && runs > MAX_RUNS) error = `${runs.toLocaleString()} backtests exceeds the ${MAX_RUNS.toLocaleString()} limit; use larger steps.`;
    return { axes, error, runs };
  }
  function describe() {
    const { axes, error, runs } = readAxes();
    for (const a of axes) rows[a.axis].querySelector('.axis-count').textContent = a.values ? `${a.values.length} values` : '—';
    $('sweepSummary').textContent = error || `${PARAMS[axes[0].key].short} × ${PARAMS[axes[1].key].short} = ${runs.toLocaleString()} BACKTESTS${runs > 3000 ? ' · may take a minute' : ''}`;
    $('sweepSummary').classList.toggle('error', !!error);
    document.querySelectorAll('.sweep-count').forEach((el) => { el.textContent = error ? '—' : runs.toLocaleString(); });
    document.querySelectorAll('[data-sweep-run]').forEach((b) => { b.disabled = busy || !!error; });
    if (!error) try { localStorage.setItem('rdl-sweep-axes', JSON.stringify({ x: axes[0], y: axes[1] })); } catch { /* storage unavailable */ }
    return { axes, error, runs };
  }
  for (const axis of ['x', 'y']) {
    // Picking a parameter loads its default range; picking the other axis's parameter swaps the two.
    field(axis, 'key').addEventListener('change', (e) => {
      const other = axis === 'x' ? 'y' : 'x', key = e.target.value, previous = field(axis, 'key').dataset.prev;
      if (field(other, 'key').value === key) setAxis(other, previous);
      setAxis(axis, key); describe();
    });
    ['from', 'to', 'step'].forEach((n) => field(axis, n).addEventListener('input', describe));
  }
  describe();
  $('sweepRamp').style.background = `linear-gradient(90deg,${Array.from({ length: BANDS }, (_, i) => `${rampColor(i / (BANDS - 1))} ${i / BANDS * 100}% ${(i + 1) / BANDS * 100}%`).join(',')})`;

  const label = (p) => `${PARAMS[X.key].short} ${PARAMS[X.key].fmt(p.x)} · ${PARAMS[Y.key].short} ${PARAMS[Y.key].fmt(p.y)}`;
  function extent() {
    const v = points.map((p) => p.cagr).filter(Number.isFinite);
    if (!v.length) return [0, 1];
    let lo = Math.min(...v), hi = Math.max(...v);
    if (hi - lo < 1e-9) { lo -= 0.5; hi += 0.5; }
    return [lo, hi];
  }
  const best = () => points.reduce((a, p) => Number.isFinite(p.cagr) && (!a || p.cagr > a.cagr) ? p : a, null);
  const shadeHex = (h, k) => '#' + hex(h).map((v) => Math.round(Math.min(255, v * k)).toString(16).padStart(2, '0')).join('');
  function draw() {
    dirty = false;
    const dpr = root.devicePixelRatio || 1, W = stage.clientWidth, H = stage.clientHeight;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!X.values.length) return;
    // Fit the cube (plus room for axis labels) to the stage for the current rotation, then apply zoom.
    const corners = [-1, 1].flatMap((x) => [-1, 1].flatMap((y) => [-1, 1].map((z) => project(x * 1.3, y * 1.3, z * 0.75, { ...view, cx: 0, cy: 0, scale: 1 }))));
    const bx = [Math.min(...corners.map((c) => c.x)), Math.max(...corners.map((c) => c.x))], by = [Math.min(...corners.map((c) => c.y)), Math.max(...corners.map((c) => c.y))];
    const fit = Math.min((W - 110) / (bx[1] - bx[0]), (H - 70) / (by[1] - by[0])) * view.zoom;
    const v = { ...view, scale: fit, cx: W / 2 - (bx[0] + bx[1]) / 2 * fit, cy: H / 2 - (by[0] + by[1]) / 2 * fit + 8 };
    const [lo, hi] = extent(), Z = 0.75, x0 = X.values[0], x1 = X.values.at(-1), y0 = Y.values[0], y1 = Y.values.at(-1);
    const P = (x, y, z) => project(x, y, z * Z, v);
    const poly = (pts, fill, stroke, width = 1) => {
      ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath();
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = width; ctx.stroke(); }
    };
    const path = (pts, color, width) => { ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath(); pts.forEach((p, k) => (k ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.stroke(); };
    const line = (a, b, color, width = 1) => path([a, b], color, width);
    const text = (p, s, align = 'center', color = '#8c8c8c', dy = 0, dx = 0) => { ctx.fillStyle = color; ctx.textAlign = align; ctx.fillText(s, p.x + dx, p.y + dy); };
    ctx.font = '10px Consolas, "SFMono-Regular", monospace'; ctx.textBaseline = 'middle';
    // Back walls: of each opposite pair of vertical planes, the one farther from the viewer.
    const xb = P(1, 0, 0).depth > P(-1, 0, 0).depth ? 1 : -1, yb = P(0, 1, 0).depth > P(0, -1, 0).depth ? 1 : -1;
    const zTicks = [0, 1, 2, 3, 4].map((i) => -1 + i / 2);
    poly([P(-1, -1, -1), P(1, -1, -1), P(1, 1, -1), P(-1, 1, -1)], '#1b1b1b', '#2e2e2e');
    poly([P(xb, -1, -1), P(xb, 1, -1), P(xb, 1, 1), P(xb, -1, 1)], '#161616', '#2e2e2e');
    poly([P(-1, yb, -1), P(1, yb, -1), P(1, yb, 1), P(-1, yb, 1)], '#141414', '#2e2e2e');
    for (const z of zTicks.slice(1)) { line(P(xb, -1, z), P(xb, 1, z), '#272727'); line(P(-1, yb, z), P(1, yb, z), '#272727'); }
    const xTicks = niceTicks(x0, x1, 5, PARAMS[X.key].integer), yTicks = niceTicks(y0, y1, 5, PARAMS[Y.key].integer);
    for (const t of xTicks) line(P(span(x0, x1, t), -1, -1), P(span(x0, x1, t), 1, -1), '#262626');
    for (const t of yTicks) line(P(-1, span(y0, y1, t), -1), P(1, span(y0, y1, t), -1), '#262626');
    // Axis labels on the front edges, outside the floor.
    const zAlign = P(xb, -yb, 0).x < v.cx ? 'right' : 'left', zdx = zAlign === 'right' ? -8 : 8;
    zTicks.forEach((z, i) => text(P(xb, -yb, z), (lo + (hi - lo) * i / 4).toFixed(2) + '%', zAlign, '#8c8c8c', 0, zdx));
    text(P(xb, -yb, 1.22), 'CAGR', zAlign, '#b0b0b0', 0, zdx);
    for (const t of xTicks) text(P(span(x0, x1, t), -yb * 1.14, -1), PARAMS[X.key].tick(t), 'center', '#8c8c8c', 6);
    for (const t of yTicks) text(P(-xb * 1.14, span(y0, y1, t), -1), PARAMS[Y.key].tick(t), 'center', '#8c8c8c', 6);
    text(P(0, -yb * 1.36, -1), PARAMS[X.key].label, 'center', '#b0b0b0', 12);
    text(P(-xb * 1.36, 0, -1), PARAMS[Y.key].label, 'center', '#b0b0b0', 12);
    if (!points.length) {
      projected = [];
      if (busy) { ctx.font = '11px Consolas, "SFMono-Regular", monospace'; text({ x: W / 2, y: H / 2 }, 'SCREENING UNIVERSE…', 'center', '#b0b0b0'); }
      return;
    }
    const t = (p) => (p.cagr - lo) / (hi - lo);
    const world = (p) => [span(x0, x1, p.x), span(y0, y1, p.y), span(lo, hi, p.cagr) * Z];
    const pos = (p) => P(span(x0, x1, p.x), span(y0, y1, p.y), span(lo, hi, p.cagr));
    const at = (i, j) => cells.get(`${X.values[i]}|${Y.values[j]}`);
    // Surface quads, far to near (painter's algorithm), flat-shaded by their tilt to a fixed light.
    const light = [-0.35, -0.45, 0.82], quads = [];
    for (let i = 0; i < X.values.length - 1; i++) for (let j = 0; j < Y.values.length - 1; j++) {
      const c = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];
      if (c.some((p) => !p || !Number.isFinite(p.cagr))) continue;
      const pr = c.map(pos), w = c.map(world);
      const u = w[2].map((x, k) => x - w[0][k]), q = w[3].map((x, k) => x - w[1][k]);
      const n = [u[1] * q[2] - u[2] * q[1], u[2] * q[0] - u[0] * q[2], u[0] * q[1] - u[1] * q[0]], len = Math.hypot(...n) || 1;
      const lit = 0.62 + 0.38 * Math.abs((n[0] * light[0] + n[1] * light[1] + n[2] * light[2]) / len);
      quads.push({ pr, depth: pr.reduce((s, p) => s + p.depth, 0) / 4, fill: shadeHex(bandColor(c.reduce((s, p) => s + t(p), 0) / 4), lit) });
    }
    quads.sort((a, b) => b.depth - a.depth);
    // Dense grids get thinner mesh lines so the bands stay readable.
    const mesh = Math.max(X.values.length, Y.values.length) > 80 ? 0.35 : 0.7;
    for (const qd of quads) poly(qd.pr, qd.fill, 'rgba(8,8,8,.55)', mesh);
    // While streaming, the newest X row has no quads yet: show it as a line.
    const complete = (i) => Y.values.every((e, j) => at(i, j));
    const edge = X.values.findIndex((h, i) => !complete(i) && Y.values.some((e, j) => at(i, j)));
    const lead = edge >= 0 ? edge : X.values.filter((h, i) => complete(i)).length === 1 ? 0 : -1;
    if (lead >= 0) path(Y.values.map((e, j) => at(lead, j)).filter(Boolean).map(pos), '#cde2fb', 1.5);
    projected = points.map((p) => ({ p, ...pos(p) })).sort((a, b) => b.depth - a.depth);
    const top = busy ? null : best();
    if (top) {
      const b = pos(top);
      ctx.beginPath(); ctx.arc(b.x, b.y, 6, 0, Math.PI * 2); ctx.fillStyle = '#ffffff'; ctx.fill(); ctx.strokeStyle = '#0b0b0b'; ctx.lineWidth = 2; ctx.stroke();
      ctx.font = '11px Consolas, "SFMono-Regular", monospace'; ctx.textAlign = 'left';
      const tag = `MAX ${top.cagr.toFixed(2)}%`, w = ctx.measureText(tag).width;
      ctx.fillStyle = 'rgba(11,11,11,.8)'; ctx.fillRect(b.x + 9, b.y - 21, w + 8, 16);
      ctx.fillStyle = '#ffffff'; ctx.fillText(tag, b.x + 13, b.y - 13);
    }
    if (hover) {
      const h = pos(hover), base = P(span(x0, x1, hover.x), span(y0, y1, hover.y), -1);
      ctx.setLineDash([3, 3]); line(base, h, '#ffffff', 1); ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(h.x, h.y, 5, 0, Math.PI * 2); ctx.fillStyle = '#ffffff'; ctx.fill(); ctx.strokeStyle = '#0b0b0b'; ctx.lineWidth = 1.5; ctx.stroke();
    }
  }
  function frame() { if (dirty) draw(); requestAnimationFrame(frame); }
  const invalidate = () => { dirty = true; };
  requestAnimationFrame(frame);
  if ('ResizeObserver' in root) new ResizeObserver(invalidate).observe(stage); else root.addEventListener('resize', invalidate);

  // Rotate by dragging, zoom with the wheel, double-click to reset; click a point to apply it.
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, yaw: view.yaw, pitch: view.pitch, moved: false };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (drag && drag.id === e.pointerId) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.hypot(dx, dy) > 3) drag.moved = true;
      view.yaw = drag.yaw + dx * 0.01;
      view.pitch = Math.max(-0.2, Math.min(1.45, drag.pitch + dy * 0.008));
      tip.hidden = true; hover = null; invalidate(); return;
    }
    const r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    let near = null, dist = 12;
    for (let i = projected.length - 1; i >= 0; i--) { const d = Math.hypot(projected[i].x - x, projected[i].y - y); if (d < dist) { dist = d; near = projected[i]; } }
    const next = near ? near.p : null;
    if (next !== hover) { hover = next; invalidate(); }
    if (!near) { tip.hidden = true; canvas.style.cursor = 'grab'; return; }
    canvas.style.cursor = 'pointer';
    const p = near.p;
    tip.innerHTML = `<b>CAGR ${pct(p.cagr)}</b><span>${esc(label(p))}</span><span>RETURN ${pct(p.returnPct)} · MDD ${pct(p.mdd)}</span><span>WIN ${pct(p.winRate)} · ${p.trades} CLOSED · ${p.skipped} SKIPPED</span><small>CLICK TO APPLY</small>`;
    tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.min(r.width - w - 4, Math.max(4, near.x + 12)) + 'px';
    tip.style.top = Math.max(4, Math.min(r.height - h - 4, near.y - h - 10)) + 'px';
  });
  const release = (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    const d = drag; drag = null;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    if (!d.moved && e.type === 'pointerup' && hover) apply(hover);
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('pointerleave', () => { if (!drag) { tip.hidden = true; if (hover) { hover = null; invalidate(); } } });
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); view.zoom = Math.max(0.6, Math.min(2.4, view.zoom * Math.exp(-e.deltaY * 0.001))); invalidate(); }, { passive: false });
  canvas.addEventListener('dblclick', () => { view = { ...HOME }; invalidate(); });

  function apply(p) {
    const form = $('settings');
    form.elements[X.key].value = p.x; form.elements[Y.key].value = p.y;
    form.dispatchEvent(new Event('input', { bubbles: true }));
    root.dispatchEvent(new CustomEvent('sweep:apply', { detail: { ...p, label: label(p) } }));
  }
  function summary() {
    const top = best();
    if (!top) { $('sweepBest').innerHTML = ''; $('sweepTable').innerHTML = ''; return; }
    const [lo, hi] = extent();
    $('sweepMin').textContent = pct(lo); $('sweepMax').textContent = pct(hi);
    const c = appliedConfig, fixed = Object.keys(PARAMS).filter((k) => k !== X.key && k !== Y.key).map((k) => `${PARAMS[k].short} ${PARAMS[k].fmt(c[k])}`).join(' · ');
    $('sweepBest').innerHTML = `<span class="micro-label">BEST CAGR</span><strong>${pct(top.cagr)}</strong><span>${esc(label(top))} · MDD ${pct(top.mdd)}</span><small>FIXED: ${esc(fixed)} · ${c.start} — ${c.end}</small>`;
    const ranked = points.filter((p) => Number.isFinite(p.cagr)).sort((a, b) => b.cagr - a.cagr).slice(0, 10);
    $('sweepTable').innerHTML = `<table><thead><tr><th>#</th><th>${PARAMS[X.key].short}</th><th>${PARAMS[Y.key].short}</th><th>CAGR</th><th>RETURN</th><th>MDD</th><th>WIN</th></tr></thead><tbody>${ranked.map((p, i) => `<tr data-x="${p.x}" data-y="${p.y}" tabindex="0"><td>${i + 1}</td><td>${esc(PARAMS[X.key].fmt(p.x))}</td><td>${esc(PARAMS[Y.key].fmt(p.y))}</td><td>${pct(p.cagr)}</td><td>${pct(p.returnPct)}</td><td>${pct(p.mdd)}</td><td>${pct(p.winRate)}</td></tr>`).join('')}</tbody></table>`;
  }
  $('sweepTable').addEventListener('click', (e) => {
    const row = e.target.closest('tr[data-x]'); if (!row) return;
    apply(cells.get(`${Number(row.dataset.x)}|${Number(row.dataset.y)}`));
  });
  $('sweepTable').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('tr[data-x]')) e.target.click(); });

  function setBusy(on) {
    busy = on;
    $('sweepCancel').hidden = !on; $('sweepExport').disabled = on || !points.length;
    for (const row of Object.values(rows)) row.querySelectorAll('select, input').forEach((el) => { el.disabled = on; });
    describe();
  }
  function reset() {
    if (worker) { worker.terminate(); worker = null; }
    points = []; cells = new Map(); hover = null; total = 0; appliedConfig = null;
    $('sweepFill').style.width = '0%'; $('sweepEmpty').hidden = false; $('sweepResult').hidden = true;
    $('sweepMin').textContent = '—'; $('sweepMax').textContent = '—';
    setBusy(false); invalidate();
  }
  function add(batch, done) {
    for (const p of batch) { points.push(p); cells.set(`${p.x}|${p.y}`, p); }
    $('sweepFill').style.width = (done / total * 100) + '%';
    invalidate();
  }
  // Callbacks report progress to the host page: onProgress(done, total, last), onDone(best), onError(message).
  function run(data, config, hooks = {}) {
    const plan = readAxes();
    if (plan.error) { hooks.onError?.(plan.error); return; }
    reset();
    [X, Y] = plan.axes.map((a) => ({ key: a.key, values: a.values }));
    total = plan.runs; appliedConfig = config;
    $('sweepEmpty').hidden = true; $('sweepResult').hidden = false; setBusy(true);
    const finish = () => { worker = null; setBusy(false); summary(); invalidate(); hooks.onDone?.(best()); };
    const fail = (message) => { worker = null; setBusy(false); hooks.onError?.(message); };
    const axes = [X, Y];
    try {
      worker = new Worker('sweep-worker.js');
      worker.onmessage = ({ data: m }) => {
        if (m.type === 'screening') hooks.onProgress?.(0, total, null);
        if (m.type === 'points') { add(m.points, m.done); hooks.onProgress?.(m.done, total, m.points.at(-1)); }
        if (m.type === 'done') finish();
        if (m.type === 'error') fail(m.message);
      };
      worker.onerror = (e) => { e.preventDefault(); fail(e.message || 'Sweep worker failed.'); };
      worker.postMessage({ data, config, axes });
    } catch {
      // No worker support (e.g. file://): compute in small slices on the main thread.
      worker = null;
      let prep, k = 0;
      const combos = X.values.flatMap((x) => Y.values.map((y) => [x, y]));
      const step = () => {
        if (!busy) return;
        try {
          if (!prep) {
            const drops = axes.filter((a) => a.key === 'drop').flatMap((a) => a.values);
            prep = Lab.prepare(Lab.validate(data), { ...config }, drops.length ? Math.min(...drops) : config.drop);
            hooks.onProgress?.(0, total, null);
          }
          const stop = Math.min(k + 8, combos.length), batch = [];
          for (; k < stop; k++) {
            const [x, y] = combos[k], m = Lab.simulate(prep, { ...config, [X.key]: x, [Y.key]: y }).metrics;
            batch.push({ x, y, [X.key]: x, [Y.key]: y, cagr: m.cagr, returnPct: m.returnPct, mdd: m.mdd, winRate: m.winRate, trades: m.trades, skipped: m.skipped });
          }
          add(batch, k); hooks.onProgress?.(k, total, batch.at(-1));
          if (k < combos.length) setTimeout(step, 0); else finish();
        } catch (error) { fail(error.message); }
      };
      setTimeout(step, 0);
    }
  }
  function cancel() { if (worker) { worker.terminate(); worker = null; } setBusy(false); summary(); invalidate(); }
  $('sweepExport').addEventListener('click', () => {
    const keys = [X.key, Y.key, 'cagr', 'returnPct', 'mdd', 'winRate', 'trades', 'skipped'];
    const csv = '﻿' + keys.join(',') + '\n' + points.map((p) => keys.map((k) => p[k] ?? '').join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })), a = document.createElement('a');
    a.href = url; a.download = `cagr-sweep-${X.key}-${Y.key}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $('sweepCancel').addEventListener('click', () => { cancel(); root.dispatchEvent(new CustomEvent('sweep:cancel')); });
  root.Sweep = { run, reset, cancel, busy: () => busy, plan: readAxes, label, PARAMS, niceTicks, bandColor, rampColor, BANDS };
})(globalThis);
