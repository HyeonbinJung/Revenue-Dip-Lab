const assert = require('node:assert/strict');
const Lab = require('../dist/engine.js');
const { KEYS, gridSize, decode, buildCombos, etaSquared, spearman, median, mulberry32 } = require('../dist/factors.js');
const lists = { drop: [5, 10], target: [5, 10, 15], base: [10000], extra: [0, 1000], hold: [1, 2], costBps: [10] };
assert.equal(gridSize(lists), 24);
// Decoding visits every grid point exactly once.
const grid = buildCombos(lists, 'grid');
assert.equal(grid.length, 24);
assert.equal(new Set(grid.map((c) => KEYS.map((k) => c[k]).join('|'))).size, 24);
assert.deepEqual(decode(lists, 0), { drop: 5, target: 5, base: 10000, extra: 0, hold: 1, costBps: 10 });
assert.deepEqual(decode(lists, 23), { drop: 10, target: 15, base: 10000, extra: 1000, hold: 2, costBps: 10 });
// Random sampling: distinct, reproducible, falls back to the full grid when n covers it.
const a = buildCombos(lists, 'random', 10, 7), b = buildCombos(lists, 'random', 10, 7);
assert.equal(a.length, 10); assert.deepEqual(a, b);
assert.equal(new Set(a.map((c) => KEYS.map((k) => c[k]).join('|'))).size, 10);
assert.equal(buildCombos(lists, 'random', 999).length, 24);
const big = { drop: [5, 10, 15, 20, 25], target: Array.from({ length: 10 }, (_, i) => 5 + 5 * i), base: [5000, 10000, 15000, 20000], extra: Array.from({ length: 11 }, (_, i) => 2000 * i), hold: Array.from({ length: 12 }, (_, i) => i + 1), costBps: [10] };
assert.equal(gridSize(big), 26400);
const sample = buildCombos(big, 'random', 5000);
assert.equal(sample.length, 5000);
assert(sample.every((c) => KEYS.every((k) => big[k].includes(c[k]))));
const r = mulberry32(1); assert(Array.from({ length: 1000 }, r).every((x) => x >= 0 && x < 1));
// eta squared: a metric driven only by hold is fully explained by hold and not at all by target.
const pts = grid.map((c) => ({ ...c, is: { cagr: c.hold * 3 } }));
assert(Math.abs(etaSquared(pts, 'hold', (p) => p.is.cagr) - 1) < 1e-12);
assert(Math.abs(etaSquared(pts, 'target', (p) => p.is.cagr)) < 1e-12);
assert.equal(etaSquared(pts.map((p) => ({ ...p, is: { cagr: 1 } })), 'hold', (p) => p.is.cagr), 0);
// Spearman: monotonic = 1, reversed = -1, ties use average ranks.
assert.equal(spearman([1, 2, 3, 4], [10, 20, 30, 1000]), 1);
assert.equal(spearman([1, 2, 3, 4], [4, 3, 2, 1]), -1);
assert(Math.abs(spearman([1, 1, 2, 3], [1, 2, 3, 4]) - 0.9486832980505138) < 1e-12);
assert.equal(median([3, 1, 2]), 2); assert.equal(median([4, 1, 3, 2]), 2.5);
// The worker path (one screening per period down to the lowest dip, then simulate) equals independent full runs,
// including in-sample / out-of-sample split periods.
const data = Lab.demo(), config = { start: '2023-01-01', end: '2025-12-31' };
const combos = [{ drop: 8, target: 15, base: 10000, extra: 3000, hold: 4, costBps: 5 }, { drop: 14, target: 5, base: 20000, extra: 0, hold: 9, costBps: 20 }];
const periods = [{ start: '2023-01-01', end: '2023-12-31' }, { start: '2024-01-01', end: '2025-12-31' }];
const floor = Math.min(...combos.map((c) => c.drop));
const preps = periods.map((p) => Lab.prepare(data, Lab.settings({ ...config, ...p, drop: floor }), floor));
for (const c of combos) periods.forEach((p, k) => {
  const viaWorker = Lab.simulate(preps[k], Lab.settings({ ...config, ...c, ...p })).metrics, direct = Lab.run(data, { ...config, ...c, ...p }).metrics;
  assert.equal(viaWorker.cagr, direct.cagr); assert.equal(viaWorker.trades, direct.trades); assert.equal(viaWorker.mdd, direct.mdd);
});
console.log('PASS: grid decoding, reproducible distinct random samples, eta squared, Spearman with ties, worker path equals full runs on split periods');
