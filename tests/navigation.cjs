const assert = require('node:assert/strict');
const { moveItem, resizePair, slotFor, sanitize, DEFAULT } = require('../dist/navigation.js');
const { durationFor, progress } = require('../dist/playback.js');
const order = ['strategy', 'results', 'signals', 'sweep', 'factors'];
assert.deepEqual(moveItem(order, 0, 4), ['results', 'signals', 'sweep', 'factors', 'strategy']);
assert.deepEqual(moveItem(order, 4, 0), ['factors', 'strategy', 'results', 'signals', 'sweep']);
assert.deepEqual(moveItem(order, 1, 1), order);
assert.deepEqual(moveItem(order, 0, 9), ['results', 'signals', 'sweep', 'factors', 'strategy']);
assert.deepEqual(order, ['strategy', 'results', 'signals', 'sweep', 'factors']); // input untouched
const close = (a, b) => assert(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
let [a, b] = resizePair(0.3, 0.4, 0.1); close(a, 0.4); close(b, 0.3);
[a, b] = resizePair(0.3, 0.4, 0.5); close(a, 0.7 - 0.1); close(b, 0.1); // clamps at the minimum
[a, b] = resizePair(0.3, 0.4, -0.5); close(a, 0.1); close(b, 0.6);
assert.equal(slotFor([100, 300], 50), 0);
assert.equal(slotFor([100, 300], 200), 1);
assert.equal(slotFor([100, 300], 400), 2);
assert.deepEqual(sanitize(null), DEFAULT);
assert.deepEqual(sanitize({ order: ['strategy', 'strategy', 'signals', 'sweep', 'factors'] }), DEFAULT);
assert.deepEqual(sanitize({ order: ['strategy', 'results', 'signals', 'sweep'] }), DEFAULT); // older 4-panel layout
const restored = sanitize({ order: ['factors', 'sweep', 'signals', 'strategy', 'results'], widths: { strategy: 1, results: 1, signals: 2, sweep: 2, factors: 2 } });
assert.deepEqual(restored.order, ['factors', 'sweep', 'signals', 'strategy', 'results']);
close(restored.widths.sweep, 0.25); close(restored.widths.strategy, 0.125);
assert.equal(durationFor(0, 0), 3000);
assert.equal(durationFor(0, 3 * 365.25 * 86400000), 4800);
assert.equal(durationFor(0, 30 * 365.25 * 86400000), 9000);
assert.equal(progress(10, 20, 5), 0);
assert.equal(progress(10, 20, 15), 0.5);
assert.equal(progress(10, 20, Infinity), 1);
console.log('PASS: panel reorder, divider resize bounds, drop slots, saved-layout validation, playback timing');
