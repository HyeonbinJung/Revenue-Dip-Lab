/* Evaluates a chunk of multi-factor combinations. Screening runs once per period (down to the lowest
 * entry decline in the chunk); each combination is then simulated for the in-sample period and,
 * when a split is set, again for the out-of-sample period. */
'use strict';
importScripts('engine.js');
self.onmessage = ({ data: m }) => {
  const { data, config, combos, periods } = m;
  try {
    Lab.validate(data);
    const floor = Math.min(...combos.map((c) => c.drop));
    const preps = periods.map((p) => Lab.prepare(data, Lab.settings({ ...config, ...p, drop: floor }), floor));
    self.postMessage({ type: 'ready' });
    let batch = [];
    combos.forEach((combo, i) => {
      const out = { ...combo };
      periods.forEach((p, k) => {
        const r = Lab.simulate(preps[k], Lab.settings({ ...config, ...combo, ...p })).metrics;
        out[k ? 'oos' : 'is'] = { cagr: r.cagr, returnPct: r.returnPct, mdd: r.mdd, winRate: r.winRate, trades: r.trades };
      });
      batch.push(out);
      if (batch.length >= 25 || i === combos.length - 1) { self.postMessage({ type: 'points', points: batch }); batch = []; }
    });
    self.postMessage({ type: 'done' });
  } catch (error) { self.postMessage({ type: 'error', message: error.message }); }
};
