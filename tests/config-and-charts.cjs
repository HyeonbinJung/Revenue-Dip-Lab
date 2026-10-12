const assert = require('node:assert/strict');
const { run, demo } = require('../dist/engine.js');
const { buildModels, windowFor, makeSVG } = require('../dist/stock-charts.js');
const f = [2017, 2018, 2019, 2020].map((y, i) => ({ symbol: 'TEST', fiscalYear: y, published: `${y + 1}-03-01`, revenue: 1000 * 1.1 ** i }));
function fixture() {
  const px = [['2021-12-03', 100, 100], ['2022-01-03', 90, 88], ['2022-01-04', 80, 80], ['2022-02-04', 70, 70], ['2022-03-04', 72, 72], ['2022-04-04', 65, 65]];
  return { source: 'fixture', universeMode: 'historical', financials: f, prices: px.map(([date, open, close]) => ({ symbol: 'TEST', date, open, close })), universe: px.map(([date]) => ({ symbol: 'TEST', date, marketCap: 1e9 })) };
}
const c = { start: '2022-01-01', end: '2022-05-01', capital: 100000, costBps: 0 };
let d = fixture(), r = run(d, { ...c, base: 20000, extra: 2500, hold: 1 });
assert.equal(r.trades[0].investment, 25000); // 12% fall -> base + 2 increments
assert.equal(r.trades[0].exitDate, '2022-02-04');
assert.equal(r.trades[0].reason, '1-month expiry');
assert.equal(r.trades[0].deadline, '2022-02-04');
let models = buildModels(d, r);
assert.equal(models.length, 1);
assert.equal(models[0].visibleEvents.length, 2);
assert.equal(models[0].visibleEvents[0].price, 80); // execution open, not signal close 88
assert.equal(models[0].visibleEvents[0].date, '2022-01-04');
assert.equal(models[0].visibleEvents[1].price, 70);
let svg = makeSVG(models[0]);
assert(svg.includes('data-date="2022-01-04" data-price="80"'));
assert(svg.includes('data-date="2022-02-04" data-price="70"'));
assert(makeSVG(models[0], 380).includes('viewBox="0 0 380 250"'));
const small = makeSVG(models[0], 200, 96, true);
assert(small.includes('viewBox="0 0 200 96"') && small.includes('data-date="2022-01-04" data-price="80"'));
assert(small.includes('class="reveal"') && small.includes('class="playhead"'));
assert.deepEqual(windowFor('2025-12-31'), { from: '2023-01-01', to: '2025-12-31' });
const old = windowFor('2025-12-31', { entryDate: '2022-01-04' });
assert(old.from <= '2022-01-04' && old.to >= '2022-01-04');
// A single unstable growth year must fail a tight tolerance and pass a wider one.
d.financials = [1000, 1100, 1232, 1355.2].map((revenue, i) => ({ ...f[i], revenue }));
assert.equal(run(d, { ...c, spread: 1 }).metrics.entered, 0);
assert.equal(run(d, { ...c, spread: 3 }).metrics.entered, 1);
assert.equal(run(d, { ...c, spread: 3, minGrowth: 11 }).metrics.entered, 0);
const synthetic = demo(), full = run(synthetic);
models = buildModels(synthetic, full);
assert.equal(models.length, 200);
assert.equal(buildModels(synthetic, full, 'entered').length, full.metrics.entered);
for (const model of models) {
  assert(model.points.every(p => p.date >= model.range.from && p.date <= model.range.to));
  if (model.trade) assert(model.visibleEvents.some(e => e.kind === 'buy' && e.date === model.trade.entryDate));
}
for (let i = 1; i < models.filter(m => m.trade).length; i++) assert(models[i - 1].trade.entryDate <= models[i].trade.entryDate);
assert.equal(buildModels({ prices: [], universe: [] }, { ...full, trades: [], open: [], universeSymbols: [] }).length, 0);
console.log('PASS: configurable base/add-on/hold/growth; dynamic expiry; 200 chart models; 3-year windows; chronological ordering; exact fill markers; mobile SVG; empty results');
