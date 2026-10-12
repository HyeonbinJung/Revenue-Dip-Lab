const assert = require('node:assert/strict');
const { run, sweep, range, SWEEP_KEYS } = require('../dist/engine.js');
const { PARAMS, MAX_RUNS, axisValues, niceTicks, rampColor, bandColor, band, project, RAMP, BANDS } = require('../dist/sweep.js');
const f = [2017, 2018, 2019, 2020].map((y, i) => ({ symbol: 'TEST', fiscalYear: y, published: `${y + 1}-03-01`, revenue: 1000 * 1.1 ** i }));
const px = [['2021-12-03', 100, 100], ['2022-01-03', 90, 88], ['2022-01-04', 80, 80], ['2022-01-05', 85, 85], ['2022-02-04', 70, 70], ['2022-03-04', 72, 72], ['2022-04-04', 65, 65], ['2022-05-04', 95, 95]];
const data = { source: 'fixture', universeMode: 'historical', financials: f, prices: px.map(([date, open, close]) => ({ symbol: 'TEST', date, open, close })), universe: px.map(([date]) => ({ symbol: 'TEST', date, marketCap: 1e9 })) };
const c = { start: '2022-01-01', end: '2022-06-01', capital: 100000, costBps: 0 };
// Every sweep cell must equal an independent full run() with the same parameters, for any axis pair.
const pairs = [['hold', [1, 2, 4], 'extra', [1000, 2500]], ['drop', [5, 10, 12, 13], 'target', [5, 30]], ['base', [5000, 20000], 'costBps', [0, 50]]];
for (const [xk, xv, yk, yv] of pairs) {
  const seen = [], points = sweep(data, c, [{ key: xk, values: xv }, { key: yk, values: yv }], (p, n) => seen.push(n));
  assert.equal(points.length, xv.length * yv.length);
  assert.deepEqual(seen, points.map((p, i) => i + 1));
  for (const p of points) {
    assert.equal(p[xk], p.x); assert.equal(p[yk], p.y);
    const m = run(data, { ...c, [xk]: p.x, [yk]: p.y }).metrics;
    assert.equal(p.cagr, m.cagr, `${xk}=${p.x} ${yk}=${p.y}`); assert.equal(p.mdd, m.mdd); assert.equal(p.trades, m.trades);
  }
}
// The fixture's deepest 30-day dip is 20%: a 10% threshold trades, 25% does not, from one shared screening pass.
const dips = sweep(data, c, [{ key: 'drop', values: [10, 25] }, { key: 'hold', values: [1, 2] }]);
assert(dips.find((p) => p.drop === 10).trades > 0); assert.equal(dips.find((p) => p.drop === 25).trades, 0);
assert.throws(() => sweep(data, c, [{ key: 'hold', values: [0] }, { key: 'extra', values: [1000] }]), /parameter ranges/);
assert.throws(() => sweep(data, c, [{ key: 'hold', values: [1] }, { key: 'hold', values: [2] }]), /two different/);
assert.throws(() => sweep(data, c, [{ key: 'capital', values: [1] }, { key: 'hold', values: [2] }]), /two different/);
assert.deepEqual(range(1000, 1300, 100), [1000, 1100, 1200, 1300]);
// Axis ranges from the form.
assert.deepEqual(Object.keys(PARAMS).sort(), [...SWEEP_KEYS].sort());
assert.deepEqual(axisValues('extra', 100, 5000, 100).values.slice(0, 3), [100, 200, 300]);
assert.equal(axisValues('extra', 100, 5000, 100).values.length, 50);
assert.deepEqual(axisValues('drop', 5, 6, 0.5).values, [5, 5.5, 6]);
assert.equal(axisValues('extra', 1000, 50000, 2500).values.at(-1), 48500); // never overshoots "to"
assert.match(axisValues('hold', 1, 12, 0.5).error, /whole numbers/);
assert.match(axisValues('drop', 5, 100, 1).error, /allowed range/);
assert.match(axisValues('target', 10, 10, 1).error, /greater/);
assert.match(axisValues('base', 1, 100, 0).error, /positive/);
assert.match(axisValues('extra', 0, 1e6, 1).error, /larger step/);
assert(MAX_RUNS >= 600);
assert.deepEqual(niceTicks(1, 12, 5, true), [1, 5, 10, 12]); // months stay whole
assert.deepEqual(niceTicks(5, 6), [5, 5.2, 5.4, 5.6, 5.8, 6]);
assert.deepEqual(niceTicks(1000, 50000), [1000, 10000, 20000, 30000, 40000, 50000]);
// Contour bands: 8 flat steps, monotonic, ends match the ramp.
assert.equal(band(0), 0); assert.equal(band(1), BANDS - 1); assert.equal(band(0.124), 0); assert.equal(band(0.126), 1);
assert.equal(bandColor(0), RAMP[0]); assert.equal(bandColor(1), RAMP.at(-1));
assert.equal(bandColor(0.13), bandColor(0.2));
assert.equal(rampColor(0), RAMP[0]); assert.equal(rampColor(1), RAMP.at(-1)); assert.equal(rampColor(-3), RAMP[0]);
const lum = (h) => [1, 3, 5].reduce((s, i, k) => s + parseInt(h.slice(i, i + 2), 16) * [.2126, .7152, .0722][k], 0);
for (let t = 0.1; t <= 1; t += 0.1) assert(lum(rampColor(t)) >= lum(rampColor(t - 0.1))); // higher CAGR is never darker
const front = project(0, 0, 0, { yaw: 0, pitch: 0, cx: 100, cy: 50, scale: 10 });
assert.deepEqual([front.x, front.y], [100, 50]);
assert(project(0, 0, 1, { yaw: 0.5, pitch: 0.3, cx: 0, cy: 0, scale: 10 }).y < 0); // higher CAGR draws higher
console.log('PASS: any-axis sweep cells equal full runs (hold/extra, drop/target, base/cost), shared screening for drop, axis range validation, nice ticks, contour bands, projection');
