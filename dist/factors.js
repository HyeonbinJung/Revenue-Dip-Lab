/* Multi-factor search: all six strategy parameters at once (random sample or full grid), evaluated in
 * parallel workers, optionally on an in-sample / out-of-sample split. Views: sensitivity (eta squared),
 * parallel coordinates, in-sample vs out-of-sample scatter, pair heat map and a top-20 table.
 * Pure helpers are exported for the regression tests. */
(function (root) {
  'use strict';
  const KEYS = ['drop', 'target', 'base', 'extra', 'hold', 'costBps'];
  const DEFAULTS = { drop: [5, 25, 5], target: [5, 50, 5], base: [5000, 20000, 5000], extra: [0, 20000, 2000], hold: [1, 12, 1], costBps: [10, 10, 1] };
  const MAX_GRID = 100000, MAX_SAMPLES = 100000;
  // Deterministic PRNG so the same settings draw the same sample.
  function mulberry32(seed) {
    return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  }
  const gridSize = (lists) => KEYS.reduce((n, k) => n * lists[k].length, 1);
  // Combination number i of the full grid, decoded in mixed radix (last key varies fastest).
  function decode(lists, i) {
    const combo = {};
    for (let k = KEYS.length - 1; k >= 0; k--) { const vs = lists[KEYS[k]]; combo[KEYS[k]] = vs[i % vs.length]; i = Math.floor(i / vs.length); }
    return combo;
  }
  // Full grid, or n distinct grid points drawn uniformly at random (the full grid when n covers it).
  function buildCombos(lists, mode, n, seed = 42) {
    const total = gridSize(lists);
    if (mode === 'grid' || n >= total) return Array.from({ length: total }, (_, i) => decode(lists, i));
    const rng = mulberry32(seed), picked = new Set();
    while (picked.size < n) picked.add(Math.floor(rng() * total));
    return [...picked].map((i) => decode(lists, i));
  }
  // Share of the metric's variance explained by grouping on one factor (main effect, 0..1).
  function etaSquared(points, key, metric) {
    const xs = points.map(metric), mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const total = xs.reduce((s, x) => s + (x - mean) ** 2, 0);
    if (!(total > 0)) return 0;
    const groups = new Map();
    points.forEach((p, i) => { const g = groups.get(p[key]) || { n: 0, sum: 0 }; g.n++; g.sum += xs[i]; groups.set(p[key], g); });
    let between = 0;
    for (const g of groups.values()) between += g.n * (g.sum / g.n - mean) ** 2;
    return between / total;
  }
  function ranks(xs) {
    const order = xs.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]), r = new Array(xs.length);
    for (let i = 0; i < order.length;) {
      let j = i; while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
      for (let k = i; k <= j; k++) r[order[k][1]] = (i + j) / 2 + 1;  // average rank for ties
      i = j + 1;
    }
    return r;
  }
  // Spearman rank correlation: does the in-sample ordering survive out of sample?
  function spearman(a, b) {
    const ra = ranks(a), rb = ranks(b), n = a.length, ma = (n + 1) / 2;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) { num += (ra[i] - ma) * (rb[i] - ma); da += (ra[i] - ma) ** 2; db += (rb[i] - ma) ** 2; }
    return da && db ? num / Math.sqrt(da * db) : 0;
  }
  const median = (xs) => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  if (typeof module !== 'undefined') { module.exports = { KEYS, DEFAULTS, MAX_GRID, mulberry32, gridSize, decode, buildCombos, etaSquared, spearman, median }; return; }

  const $ = (id) => document.getElementById(id);
  const { PARAMS, niceTicks, bandColor, BANDS } = root.Sweep;
  const pct = (n) => n == null || !Number.isFinite(n) ? '—' : n.toFixed(2) + '%';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const day = 86400000, iso = (t) => new Date(t).toISOString().slice(0, 10);
  let points = [], workers = [], busy = false, total = 0, done = 0, plan = null, dirty = true;

  // Range table: one row per factor; from == to fixes the factor.
  $('factorRanges').innerHTML = `<div class="factor-row head"><span>FACTOR</span><span>FROM</span><span>TO</span><span>STEP</span><span></span></div>` + KEYS.map((k) =>
    `<div class="factor-row" data-key="${k}"><span class="factor-name">${PARAMS[k].label}</span><input data-f="from" type="number" step="any" aria-label="${PARAMS[k].label} from"><input data-f="to" type="number" step="any" aria-label="${PARAMS[k].label} to"><input data-f="step" type="number" step="any" min="0" aria-label="${PARAMS[k].label} step"><span class="axis-count"></span></div>`).join('');
  const row = (k) => $('factorRanges').querySelector(`[data-key="${k}"]`);
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('rdl-factor-ranges')); } catch { saved = null; }
  for (const k of KEYS) {
    const r = Array.isArray(saved?.[k]) && saved[k].every(Number.isFinite) ? saved[k] : DEFAULTS[k];
    ['from', 'to', 'step'].forEach((f, i) => { row(k).querySelector(`[data-f="${f}"]`).value = r[i]; });
  }
  function values(k) {
    const p = PARAMS[k], [from, to, step] = ['from', 'to', 'step'].map((f) => parseFloat(row(k).querySelector(`[data-f="${f}"]`).value));
    if (![from, to].every(Number.isFinite)) return { error: `${p.short}: enter from and to.` };
    if (from < p.min || to > p.max) return { error: `${p.short}: allowed range is ${p.min}–${p.max}.` };
    if (to < from) return { error: `${p.short}: "to" must not be below "from".` };
    if (to === from) return { values: [from], range: [from, to, Number.isFinite(step) && step > 0 ? step : 1] };
    if (!(step > 0)) return { error: `${p.short}: step must be positive.` };
    if (p.integer && ![from, to, step].every(Number.isInteger)) return { error: `${p.short}: whole numbers only.` };
    const n = Math.floor((to - from) / step + 1e-9) + 1;
    if (n > 500) return { error: `${p.short}: ${n} values; use a larger step.` };
    return { values: Array.from({ length: n }, (_, i) => +(from + i * step).toFixed(10)), range: [from, to, step] };
  }
  const workerCount = () => Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
  function readPlan() {
    const lists = {}, ranges = {};
    let error = null;
    for (const k of KEYS) {
      const v = values(k);
      row(k).querySelector('.axis-count').textContent = v.values ? (v.values.length === 1 ? 'fixed' : `${v.values.length}`) : '—';
      if (v.error) { error = error || v.error; continue; }
      lists[k] = v.values; ranges[k] = v.range;
    }
    const mode = document.querySelector('input[name="factorMode"]:checked').value, samples = Math.floor(Number($('factorSamples').value));
    const grid = error ? 0 : gridSize(lists);
    if (!error && mode === 'random' && !(samples >= 10 && samples <= MAX_SAMPLES)) error = `Samples: 10–${MAX_SAMPLES.toLocaleString()}.`;
    if (!error && mode === 'grid' && grid > MAX_GRID) error = `Full grid is ${grid.toLocaleString()} combinations (limit ${MAX_GRID.toLocaleString()}); use random sampling or larger steps.`;
    const runs = error ? 0 : mode === 'grid' ? grid : Math.min(samples, grid);
    return { lists, ranges, mode, samples, grid, runs, error, split: $('factorSplit').checked ? $('factorSplitDate').value : null };
  }
  function describe() {
    const p = readPlan();
    const sims = p.runs * (p.split ? 2 : 1);
    $('factorSummary').textContent = p.error || `${p.runs.toLocaleString()} of ${p.grid.toLocaleString()} combinations${p.split ? ' × 2 periods' : ''} = ${sims.toLocaleString()} backtests on ${workerCount()} workers${sims > 40000 ? ' · several minutes' : ''}`;
    $('factorSummary').classList.toggle('error', !!p.error);
    $('factorRun').disabled = busy || !!p.error;
    if (!p.error) try { localStorage.setItem('rdl-factor-ranges', JSON.stringify(p.ranges)); } catch { /* storage unavailable */ }
    return p;
  }
  $('factorRanges').addEventListener('input', describe);
  for (const el of document.querySelectorAll('input[name="factorMode"], #factorSamples, #factorSplit, #factorSplitDate')) el.addEventListener('input', describe);
  describe();
  for (const id of ['factorPairX', 'factorPairY']) $(id).innerHTML = KEYS.map((k) => `<option value="${k}">${PARAMS[k].short}</option>`).join('');
  $('factorPairX').value = 'hold'; $('factorPairY').value = 'extra';
  for (const id of ['factorPairX', 'factorPairY', 'factorAgg']) $(id).addEventListener('change', () => { dirty = true; });

  // Metrics used by the views: in-sample CAGR ranks; out-of-sample CAGR tests the ranking.
  const isC = (p) => p.is.cagr, oosC = (p) => p.oos?.cagr;
  const finite = () => points.filter((p) => Number.isFinite(isC(p)) && (!plan?.split || Number.isFinite(oosC(p))));
  const topShare = (list) => { const s = [...list].sort((a, b) => isC(b) - isC(a)); return new Set(s.slice(0, Math.max(1, Math.ceil(s.length * 0.1)))); };
  function canvasFor(id) {
    const canvas = $(id), box = canvas.parentElement, dpr = root.devicePixelRatio || 1, W = box.clientWidth, H = box.clientHeight;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
    const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    ctx.font = '10px Consolas, "SFMono-Regular", monospace'; ctx.textBaseline = 'middle';
    return { ctx, W, H };
  }
  function drawSensitivity(list) {
    const rows = KEYS.filter((k) => plan.lists[k].length > 1).map((k) => [k, etaSquared(list, k, isC)]).sort((a, b) => b[1] - a[1]);
    const top = Math.max(...rows.map((r) => r[1]), 1e-9);
    $('factorSens').innerHTML = rows.map(([k, v]) => `<div class="sens-row"><span>${PARAMS[k].short}</span><i><b style="width:${v / top * 100}%"></b></i><em>${(v * 100).toFixed(1)}%</em></div>`).join('') || '<p class="factor-note">All factors are fixed.</p>';
  }
  function drawParallel(list, top) {
    const { ctx, W, H } = canvasFor('factorParallel');
    const axes = [...KEYS.map((k) => ({ label: PARAMS[k].short, get: (p) => p[k], fmt: PARAMS[k].tick, lo: Math.min(...plan.lists[k]), hi: Math.max(...plan.lists[k]) })),
      { label: plan.split ? 'IS CAGR' : 'CAGR', get: isC, fmt: (v) => v.toFixed(1) + '%' }, ...(plan.split ? [{ label: 'OOS CAGR', get: oosC, fmt: (v) => v.toFixed(1) + '%' }] : [])];
    for (const a of axes) if (a.lo === undefined) { const v = list.map(a.get); a.lo = Math.min(...v); a.hi = Math.max(...v); }
    const L = 28, R = 28, T = 30, B = 22, gap = (W - L - R) / (axes.length - 1);
    const xAt = (i) => L + i * gap, yAt = (a, v) => a.hi > a.lo ? T + (1 - (v - a.lo) / (a.hi - a.lo)) * (H - T - B) : (T + H - B) / 2;
    const [clo, chi] = [axes[KEYS.length].lo, axes[KEYS.length].hi];
    const draw = (p) => { ctx.beginPath(); axes.forEach((a, i) => (i ? ctx.lineTo(xAt(i), yAt(a, a.get(p))) : ctx.moveTo(xAt(i), yAt(a, a.get(p))))); ctx.stroke(); };
    ctx.lineWidth = 1; ctx.strokeStyle = `rgba(255,255,255,${Math.max(0.012, Math.min(0.06, 60 / list.length))})`;
    for (const p of list) if (!top.has(p)) draw(p);
    ctx.lineWidth = 1.1; ctx.globalAlpha = 0.75;
    for (const p of [...top].sort((a, b) => isC(a) - isC(b))) { ctx.strokeStyle = bandColor(chi > clo ? (isC(p) - clo) / (chi - clo) : 1); draw(p); }
    ctx.globalAlpha = 1;
    axes.forEach((a, i) => {
      ctx.strokeStyle = '#4a4a4a'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(xAt(i), T); ctx.lineTo(xAt(i), H - B); ctx.stroke();
      ctx.textAlign = 'center'; ctx.fillStyle = '#d0d0d0'; ctx.fillText(a.label, xAt(i), 10);
      ctx.fillStyle = '#8c8c8c'; ctx.fillText(a.fmt(a.hi), xAt(i), T - 9); ctx.fillText(a.fmt(a.lo), xAt(i), H - B + 11);
    });
  }
  let scatterHits = [];
  function drawScatter(list, top) {
    const { ctx, W, H } = canvasFor('factorScatter');
    const L = 52, R = 14, T = 12, B = 30, xs = list.map(isC), ys = list.map(oosC);
    const padded = (v) => { const lo = Math.min(...v), hi = Math.max(...v), pad = (hi - lo) * 0.06 || 0.5; return [lo - pad, hi + pad]; };
    const [xa, xb] = padded(xs), [ya, yb] = padded(ys);
    const X = (v) => L + (v - xa) / (xb - xa) * (W - L - R), Y = (v) => H - B - (v - ya) / (yb - ya) * (H - T - B);
    ctx.strokeStyle = '#222'; ctx.fillStyle = '#8c8c8c';
    for (const t of niceTicks(+xa.toFixed(2), +xb.toFixed(2)).slice(1, -1)) { ctx.beginPath(); ctx.moveTo(X(t), T); ctx.lineTo(X(t), H - B); ctx.stroke(); ctx.textAlign = 'center'; ctx.fillText(t.toFixed(1) + '%', X(t), H - B + 10); }
    for (const t of niceTicks(+ya.toFixed(2), +yb.toFixed(2)).slice(1, -1)) { ctx.beginPath(); ctx.moveTo(L, Y(t)); ctx.lineTo(W - R, Y(t)); ctx.stroke(); ctx.textAlign = 'right'; ctx.fillText(t.toFixed(1) + '%', L - 6, Y(t)); }
    const d0 = Math.max(xa, ya), d1 = Math.min(xb, yb);
    if (d1 > d0) { ctx.setLineDash([4, 4]); ctx.strokeStyle = '#5a5a5a'; ctx.beginPath(); ctx.moveTo(X(d0), Y(d0)); ctx.lineTo(X(d1), Y(d1)); ctx.stroke(); ctx.setLineDash([]); }
    ctx.fillStyle = '#b0b0b0'; ctx.textAlign = 'center'; ctx.fillText('IN-SAMPLE CAGR →', (L + W - R) / 2, H - 6);
    ctx.save(); ctx.translate(11, (T + H - B) / 2); ctx.rotate(-Math.PI / 2); ctx.fillText('OUT-OF-SAMPLE CAGR →', 0, 0); ctx.restore();
    scatterHits = [];
    for (const p of list) if (!top.has(p)) { ctx.fillStyle = 'rgba(160,160,160,.35)'; ctx.fillRect(X(isC(p)) - 1.5, Y(oosC(p)) - 1.5, 3, 3); }
    for (const p of top) { const x = X(isC(p)), y = Y(oosC(p)); ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fillStyle = '#86b6ef'; ctx.fill(); scatterHits.push({ p, x, y }); }
    for (const p of list) if (!top.has(p)) scatterHits.push({ p, x: X(isC(p)), y: Y(oosC(p)) });
    const rho = spearman(xs, ys), ranked = [...list].sort((m, n) => oosC(n) - oosC(m)), bestIs = [...list].sort((m, n) => isC(n) - isC(m))[0];
    const pctile = (1 - ranked.indexOf(bestIs) / Math.max(1, list.length - 1)) * 100, topOos = [...top].reduce((s, p) => s + oosC(p), 0) / top.size, allOos = ys.reduce((s, v) => s + v, 0) / ys.length;
    $('factorRho').textContent = `SPEARMAN ρ ${rho.toFixed(2)}`;
    const verdict = rho <= -0.2 ? 'Negative ρ: combinations that did best in-sample tended to do worse out of sample, so picking the in-sample optimum would have hurt.'
      : rho < 0.3 ? 'ρ near 0: the in-sample ranking barely carries over, so the "optimum" is mostly noise.'
        : 'Positive ρ: the in-sample ranking partly holds out of sample.';
    $('factorOosNote').textContent = `Best in-sample combination lands at the ${pctile.toFixed(0)}th percentile out of sample (${pct(oosC(bestIs))}). Top 10% in-sample average ${pct(topOos)} out of sample vs ${pct(allOos)} for all combinations. ${verdict}`;
  }
  let heatCells = [];
  function drawHeat(list) {
    const { ctx, W, H } = canvasFor('factorHeat'), xk = $('factorPairX').value, yk = $('factorPairY').value, agg = $('factorAgg').value;
    heatCells = [];
    if (xk === yk) { ctx.fillStyle = '#8c8c8c'; ctx.textAlign = 'center'; ctx.fillText('Choose two different factors.', W / 2, H / 2); return; }
    const xv = plan.lists[xk], yv = plan.lists[yk], groups = new Map();
    for (const p of list) { const key = `${p[xk]}|${p[yk]}`; (groups.get(key) || groups.set(key, []).get(key)).push(isC(p)); }
    const vals = new Map([...groups].map(([k, v]) => [k, agg === 'max' ? Math.max(...v) : median(v)]));
    const all = [...vals.values()], lo = Math.min(...all), hi = Math.max(...all);
    const L = 58, R = 10, T = 8, B = 34, cw = (W - L - R) / xv.length, ch = (H - T - B) / yv.length;
    xv.forEach((x, i) => yv.forEach((y, j) => {
      const key = `${x}|${y}`, v = vals.get(key), cx = L + i * cw, cy = H - B - (j + 1) * ch;
      ctx.fillStyle = v === undefined ? '#151515' : bandColor(hi > lo ? (v - lo) / (hi - lo) : 1);
      ctx.fillRect(cx + 0.5, cy + 0.5, Math.max(0.5, cw - 1), Math.max(0.5, ch - 1));
      heatCells.push({ x: cx, y: cy, w: cw, h: ch, xv: x, yv: y, v, n: groups.get(key)?.length || 0 });
    }));
    ctx.fillStyle = '#8c8c8c';
    const every = (n, px, gap) => Math.max(1, Math.ceil(n / Math.max(1, Math.floor(px / gap))));
    const ex = every(xv.length, W - L - R, 46), ey = every(yv.length, H - T - B, 15);
    xv.forEach((x, i) => { if (i % ex === 0) { ctx.textAlign = 'center'; ctx.fillText(PARAMS[xk].tick(x), L + (i + 0.5) * cw, H - B + 10); } });
    yv.forEach((y, j) => { if (j % ey === 0) { ctx.textAlign = 'right'; ctx.fillText(PARAMS[yk].tick(y), L - 6, H - B - (j + 0.5) * ch); } });
    ctx.fillStyle = '#b0b0b0'; ctx.textAlign = 'center'; ctx.fillText(`${PARAMS[xk].label} →`, (L + W - R) / 2, H - 6);
    $('factorHeatLegend').textContent = `${agg.toUpperCase()} IN-SAMPLE CAGR OVER OTHER FACTORS · ${pct(lo)} – ${pct(hi)} · Y: ${PARAMS[yk].label}`;
  }
  function drawTable(list) {
    const sorted = [...list].sort((a, b) => isC(b) - isC(a)).slice(0, 20);
    $('factorTable').innerHTML = `<table><thead><tr><th>#</th>${KEYS.map((k) => `<th>${PARAMS[k].short}</th>`).join('')}<th>${plan.split ? 'IS CAGR' : 'CAGR'}</th>${plan.split ? '<th>OOS CAGR</th>' : ''}<th>MDD</th><th>TRADES</th></tr></thead><tbody>${sorted.map((p, i) =>
      `<tr data-i="${points.indexOf(p)}" tabindex="0"><td>${i + 1}</td>${KEYS.map((k) => `<td>${esc(PARAMS[k].fmt(p[k]))}</td>`).join('')}<td>${pct(isC(p))}</td>${plan.split ? `<td class="${oosC(p) < 0 ? 'negative' : ''}">${pct(oosC(p))}</td>` : ''}<td>${pct(p.is.mdd)}</td><td>${p.is.trades}</td></tr>`).join('')}</tbody></table>`;
  }
  function render() {
    dirty = false;
    if (!plan || !points.length) return;
    const list = finite(); if (!list.length) return;
    const top = topShare(list);
    drawSensitivity(list); drawParallel(list, top); drawHeat(list);
    $('factorOosBlock').hidden = !plan.split;
    if (plan.split) drawScatter(list, top);
    if (!busy) drawTable(list);
  }
  let lastPaint = 0;
  (function loop(ts) { if (dirty && (!busy || ts - lastPaint > 400)) { lastPaint = ts; render(); } requestAnimationFrame(loop); })(0);
  if ('ResizeObserver' in root) new ResizeObserver(() => { dirty = true; }).observe($('factorResult'));

  function tooltip(tipId, canvasId, hits, find, html) {
    const canvas = $(canvasId), tip = $(tipId);
    canvas.addEventListener('pointermove', (e) => {
      const r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, hit = find(hits(), x, y);
      if (!hit) { tip.hidden = true; return; }
      tip.innerHTML = html(hit); tip.hidden = false;
      tip.style.left = Math.min(r.width - tip.offsetWidth - 4, x + 12) + 'px'; tip.style.top = Math.max(4, y - tip.offsetHeight - 8) + 'px';
    });
    canvas.addEventListener('pointerleave', () => { tip.hidden = true; });
  }
  const combo = (p) => KEYS.map((k) => `${PARAMS[k].short} ${PARAMS[k].fmt(p[k])}`).join(' · ');
  tooltip('factorScatterTip', 'factorScatter', () => scatterHits, (hs, x, y) => { let best = null, d = 8; for (const h of hs) { const e = Math.hypot(h.x - x, h.y - y); if (e < d) { d = e; best = h; } } return best; },
    (h) => `<b>IS ${pct(isC(h.p))} → OOS ${pct(oosC(h.p))}</b><span>${esc(combo(h.p))}</span>`);
  tooltip('factorHeatTip', 'factorHeat', () => heatCells, (hs, x, y) => hs.find((c) => x >= c.x && x < c.x + c.w && y >= c.y && y < c.y + c.h),
    (c) => `<b>${c.v === undefined ? 'NO SAMPLES' : pct(c.v)}</b><span>${PARAMS[$('factorPairX').value].short} ${PARAMS[$('factorPairX').value].fmt(c.xv)} · ${PARAMS[$('factorPairY').value].short} ${PARAMS[$('factorPairY').value].fmt(c.yv)}</span><span>${c.n} SAMPLES</span>`);
  $('factorTable').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-i]'); if (!tr) return;
    const p = points[Number(tr.dataset.i)], form = $('settings');
    for (const k of KEYS) form.elements[k].value = p[k];
    form.dispatchEvent(new Event('input', { bubbles: true }));
    root.dispatchEvent(new CustomEvent('factors:apply', { detail: { label: combo(p), cagr: isC(p) } }));
  });
  $('factorTable').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('tr[data-i]')) e.target.click(); });

  function setBusy(on) {
    busy = on; $('factorCancel').hidden = !on; $('factorExport').disabled = on || !points.length;
    $('factorConfig').querySelectorAll('input').forEach((el) => { el.disabled = on; });
    describe();
  }
  function stop() { for (const w of workers) w.terminate(); workers = []; }
  function reset() { stop(); points = []; plan = null; total = done = 0; $('factorFill').style.width = '0%'; $('factorEmpty').hidden = false; $('factorResult').hidden = true; setBusy(false); }
  // Periods: the whole test, or in-sample [start, split) and out-of-sample [split, end].
  function periods(config, split) {
    if (!split) return [{ start: config.start, end: config.end }];
    if (!(split > config.start && split <= config.end)) throw Error('The out-of-sample start must fall inside the Strategy start/end dates.');
    return [{ start: config.start, end: iso(Date.parse(split + 'T00:00:00Z') - day) }, { start: split, end: config.end }];
  }
  function run(data, config, hooks = {}) {
    const p = readPlan();
    if (p.error) { hooks.onError?.(p.error); return; }
    let spans;
    try { spans = periods(config, p.split); } catch (error) { hooks.onError?.(error.message); return; }
    reset(); plan = p; plan.config = config;
    const combos = buildCombos(p.lists, p.mode, p.samples);
    total = combos.length; $('factorEmpty').hidden = true; $('factorResult').hidden = false; setBusy(true);
    const started = performance.now();
    let finished = 0, failed = false;
    const fail = (message) => { if (failed) return; failed = true; stop(); setBusy(false); dirty = true; hooks.onError?.(message); };
    const onMessage = ({ data: m }) => {
      if (m.type === 'points') {
        points.push(...m.points); done += m.points.length;
        $('factorFill').style.width = (done / total * 100) + '%'; dirty = true;
        hooks.onProgress?.(done, total);
      }
      if (m.type === 'error') fail(m.message);
      if (m.type === 'done' && ++finished === workers.length) { workers = []; setBusy(false); dirty = true; hooks.onDone?.({ seconds: (performance.now() - started) / 1000, runs: total, best: finite().sort((a, b) => isC(b) - isC(a))[0], split: !!p.split }); }
    };
    try {
      const n = Math.min(workerCount(), combos.length);
      hooks.onProgress?.(0, total);
      for (let w = 0; w < n; w++) {
        const worker = new Worker('factor-worker.js');
        worker.onmessage = onMessage; worker.onerror = (e) => { e.preventDefault(); fail(e.message || 'Factor worker failed.'); };
        workers.push(worker);
        // Interleave so every worker covers the whole range and the picture fills in evenly.
        worker.postMessage({ data, config, combos: combos.filter((c, i) => i % n === w), periods: spans });
      }
    } catch (error) { fail('Web Workers are required for the factor search (open the app through the local server). ' + error.message); }
  }
  $('factorCancel').addEventListener('click', () => { stop(); setBusy(false); dirty = true; root.dispatchEvent(new CustomEvent('factors:cancel')); });
  $('factorExport').addEventListener('click', () => {
    const head = [...KEYS, ...(plan?.split ? ['is_cagr', 'oos_cagr', 'is_return', 'oos_return', 'is_mdd', 'oos_mdd', 'is_trades', 'oos_trades'] : ['cagr', 'return', 'mdd', 'trades'])];
    const rows = points.map((p) => [...KEYS.map((k) => p[k]), ...(plan?.split ? [p.is.cagr, p.oos.cagr, p.is.returnPct, p.oos.returnPct, p.is.mdd, p.oos.mdd, p.is.trades, p.oos.trades] : [p.is.cagr, p.is.returnPct, p.is.mdd, p.is.trades])].join(','));
    const url = URL.createObjectURL(new Blob(['﻿' + head.join(',') + '\n' + rows.join('\n')], { type: 'text/csv;charset=utf-8' })), a = document.createElement('a');
    a.href = url; a.download = 'factor-search.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  root.Factors = { run, reset, busy: () => busy, plan: readPlan, label: combo };
})(globalThis);
