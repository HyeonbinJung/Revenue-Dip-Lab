'use strict';
const $ = (id) => document.getElementById(id);
let data = null, result = null, tab = 'trades', server = false, runGeneration = 0, busy = false;
const money = (n) => '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
const pct = (n) => n == null ? '—' : n.toFixed(2) + '%';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const synthetic = () => data?.source?.toLowerCase().includes('synthetic');
const realMarket = () => data?.source?.startsWith('Real market data');
function status(message, error = false) {
  $('status').textContent = message; $('status').title = message;
  $('status').className = 'notice' + (error ? ' error' : '');
}
function config() {
  return Object.fromEntries([...new FormData($('settings'))].map(([key, value]) => [key, ['start', 'end'].includes(key) ? value : Number(value)]));
}
function formula() {
  const c = config();
  $('formula').textContent = `${c.drop}% dip = ${money(c.base)}   /   ${c.drop + 1}% = ${money(c.base + c.extra)}   /   ${c.drop + 5}% = ${money(c.base + 5 * c.extra)}. Excess decline rounded down to 1% increments.`;
}
$('settings').addEventListener('input', () => {
  formula();
  if (result) status('PARAMETERS MODIFIED / Run backtest to apply the new configuration.');
});
formula();
fetch('/api/health').then((r) => r.ok ? r.json() : null).then((j) => { server = !!j?.engine; }).catch(() => {});
function setData(dataset) {
  Lab.validate(dataset); runGeneration++; StockCharts.clear();
  data = dataset; result = null; Playback.reset(); Sweep.reset(); Factors.reset();
  $('stockSection').hidden = true; $('signalsEmpty').hidden = false; $('appliedConfig').hidden = true;
  $('equityValue').textContent = 'Awaiting simulation'; $('range').textContent = '—'; $('exposure').textContent = '—';
  $('metrics').innerHTML = ['NET RETURN', 'CAGR', 'MAX DRAWDOWN', 'WIN RATE / CLOSED'].map((x) => `<article><span>${x}</span><strong>—</strong></article>`).join('');
  $('chart').innerHTML = '<div class="empty">Run a backtest to plot portfolio equity.</div>';
  $('table').innerHTML = '<div class="empty">Dataset loaded. Awaiting simulation.</div>';
  $('export').disabled = true;
  $('dataTitle').textContent = dataset.source || 'Imported dataset';
  $('dataInfo').textContent = `${new Set(dataset.universe.map((u) => u.symbol)).size} SYMBOLS / ${dataset.prices.length.toLocaleString()} PRICE ROWS / ${dataset.financials.length.toLocaleString()} ANNUAL REPORTS`;
  $('mode').textContent = synthetic() ? 'SYNTHETIC / DEMO' : realMarket() ? 'REAL / YFINANCE + SEC' : 'IMPORTED / UNVERIFIED';
  status(dataset.universeMode === 'current' ? 'CURRENT UNIVERSE / Historical results contain survivorship and look-ahead bias.' : 'HISTORICAL UNIVERSE / Financial reports become eligible after their publication date.');
}
function setBusy(value) {
  busy = value;
  ['run', 'demo', 'realData', 'upload', 'fetch'].forEach((id) => { $(id).disabled = value; });
  document.querySelectorAll('#settings fieldset').forEach((el) => { el.disabled = value; });
  $('run').innerHTML = value ? '<span class="run-icon">◌</span> COMPUTING…' : '<span class="run-icon">▶</span> RUN BACKTEST';
}
async function executeBacktest(advance = true) {
  if (busy) return;
  if (!data) { status('NO DATA / Load a demo or import a dataset first.', true); return; }
  const generation = ++runGeneration, runData = data, runConfig = config();
  setBusy(true); status('COMPUTING / Evaluating signals, executions and daily portfolio marks…');
  try {
    await new Promise((resolve) => setTimeout(resolve, 40));
    // The page runs the same engine as POST /api/backtest; re-uploading a large dataset per run would cost more than the run.
    const next = Lab.run(runData, runConfig);
    if (generation !== runGeneration) return;
    result = next; render();
    status(`${synthetic() ? 'SYNTHETIC DEMO / ' : ''}COMPLETE / ${result.metrics.entered} entries / ${result.metrics.trades} closed / ${result.metrics.skipped} cash-constrained orders skipped.${synthetic() ? ' Not actual market performance.' : ''}${realMarket() ? ' Real prices; current S&P 500 universe has survivorship bias.' : ''}`);
    if (advance) Layout.focus('results');
  } catch (error) { status('ERROR / ' + error.message, true); }
  finally { setBusy(false); }
}
$('settings').addEventListener('submit', (event) => { event.preventDefault(); executeBacktest(true); });
async function loadDemo() {
  if (busy) return;
  status('INITIALIZING / Generating reproducible synthetic price histories…');
  await new Promise((resolve) => setTimeout(resolve, 30));
  try { setData(Lab.demo()); await executeBacktest(false); }
  catch (error) { status('ERROR / ' + error.message, true); }
}
$('demo').onclick = loadDemo;
// Expand the server's columnar real-market payload into the engine's row format.
function expandCompact(d) {
  const { dates, symbols, names, open, close, snapshotDates, snapshots } = d.compact, prices = [], universe = [];
  symbols.forEach((symbol, i) => {
    const o = open[i], c = close[i];
    for (let k = 0; k < dates.length; k++) if (o[k] > 0 && c[k] > 0) prices.push({ symbol, date: dates[k], open: o[k], close: c[k] });
  });
  snapshotDates.forEach((date, k) => { for (const [i, marketCap] of snapshots[k]) universe.push({ symbol: symbols[i], name: names[i], date, marketCap }); });
  return { source: d.source, universeMode: d.universeMode, warnings: d.warnings, financials: d.financials, prices, universe };
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function loadReal() {
  if (busy) return;
  if (!server) { $('help').showModal(); return; }
  const button = $('realData'); button.disabled = true;
  try {
    let state = await (await fetch('/api/data/real/status')).json();
    if (!state.ready) {
      let job = state.building?.job;
      if (!job) {
        if (!confirm('No local market database yet.\n\nBuild it now? This downloads 2021–2025 prices from Yahoo Finance and 10-K revenue history from SEC EDGAR for the S&P 500 (about 5 minutes, once). Later loads read the SQLite file.')) { status('REAL DATA / Build cancelled.'); return; }
        const response = await fetch('/api/data/real/build', { method: 'POST' }), body = await response.json();
        if (!response.ok) throw Error(body.detail || 'Unable to start the build.');
        job = body.job;
      }
      for (;;) {
        await sleep(1500);
        const progress = await (await fetch('/api/data/jobs/' + job)).json();
        if (progress.status === 'failed') throw Error(progress.error);
        if (progress.status === 'succeeded') break;
        status(`BUILDING DATABASE / ${progress.symbol}`);
      }
    }
    status('REAL DATA / Reading the local SQLite database…');
    const started = performance.now(), response = await fetch('/api/data/real');
    if (!response.ok) throw Error((await response.json()).detail || 'Unable to load the real-market dataset.');
    const dataset = expandCompact(await response.json());
    setData(dataset);
    // Default real-data window; the database holds prices from 2021 for the 30-day warm-up and chart history.
    $('settings').elements.start.value = '2022-01-01'; $('settings').elements.end.value = '2025-12-31'; formula();
    status(`REAL DATA LOADED in ${((performance.now() - started) / 1000).toFixed(1)}s / ${dataset.prices.length.toLocaleString()} price rows. Running backtest…`);
    await executeBacktest(true);
  } catch (error) { status('REAL DATA ERROR / ' + error.message, true); }
  finally { button.disabled = busy; }
}
$('realData').onclick = loadReal;
$('upload').onchange = async (event) => {
  try {
    const file = event.target.files[0]; if (!file) return;
    if (file.size > 100 * 1024 * 1024) throw Error('Upload a JSON file smaller than 100 MB.');
    setData(JSON.parse(await file.text()));
    status('DATA LOADED / Confirm source, dates and universe coverage, then run the backtest.');
  } catch (error) { status('DATA ERROR / ' + error.message, true); }
  event.target.value = '';
};
const stamp = (s) => Date.parse(s + 'T00:00:00Z');
// Index of the last element of sorted `ts` at or before t, or -1.
function indexAt(ts, t) {
  let lo = 0, hi = ts.length - 1, k = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (ts[mid] <= t) { k = mid; lo = mid + 1; } else hi = mid - 1; }
  return k;
}
function metricCards(cards) {
  $('metrics').innerHTML = cards.map(([label, value, n]) => `<article><span>${label}</span><strong class="${n > 0 ? 'positive' : n < 0 ? 'negative' : ''}">${value}</strong></article>`).join('');
}
function finalMetrics() {
  const m = result.metrics;
  metricCards([['NET RETURN', pct(m.returnPct), m.returnPct], ['CAGR', pct(m.cagr), m.cagr], ['MAX DRAWDOWN', pct(m.mdd), m.mdd], ['WIN RATE / CLOSED', pct(m.winRate) + ' / ' + m.trades, null]]);
  $('equityValue').textContent = money(m.equity);
}
// Metrics as they stood on the playback date: return, running drawdown and trades closed so far.
function bindLiveMetrics() {
  const curve = result.curve, ts = curve.map((p) => stamp(p.date)), capital = result.config.capital;
  const worst = []; curve.reduce((low, p, i) => (worst[i] = Math.min(low, p.drawdown)), 0);
  const closed = result.trades.map((t) => [stamp(t.exitDate), t.pnl > 0]);
  let shown = null;
  Playback.bind($('metrics'), (t) => {
    if (t === Infinity) { if (shown !== Infinity) finalMetrics(); shown = Infinity; return; }
    const k = indexAt(ts, t);
    if (k === shown) return;
    shown = k;
    if (k < 0) { metricCards([['NET RETURN', '—'], ['CAGR', '—'], ['MAX DRAWDOWN', '—'], ['WIN RATE / CLOSED', '—']]); $('equityValue').textContent = money(capital); return; }
    const p = curve[k], ret = (p.equity / capital - 1) * 100, done = closed.filter((c) => c[0] <= ts[k]), wins = done.filter((c) => c[1]).length;
    metricCards([['NET RETURN', pct(ret), ret], ['CAGR', '…'], ['MAX DRAWDOWN', pct(worst[k]), worst[k]], ['WIN RATE / CLOSED', (done.length ? pct(wins / done.length * 100) : '—') + ' / ' + done.length, null]]);
    $('equityValue').textContent = money(p.equity);
  });
}
function render() {
  const m = result.metrics;
  $('range').textContent = `${result.curve[0].date} — ${result.curve.at(-1).date}`;
  $('exposure').textContent = `CASH ${money(result.curve.at(-1).cash)} / ${m.open} OPEN`;
  $('export').disabled = !result.trades.length;
  const c = result.config;
  $('appliedConfig').hidden = false;
  $('appliedConfig').textContent = `${synthetic() ? 'SYNTHETIC DEMO / ' : ''}APPLIED: BASE ${money(c.base)} + ${money(c.extra)}/1% / MAX HOLD ${c.hold}M / GROWTH RANGE ≤${c.spread}pp / MIN GROWTH ${c.minGrowth}%`;
  table();
  $('signalsEmpty').hidden = true; $('stockSection').hidden = false;
  // The clock covers the equity curve and every price window, so all charts draw on one timeline.
  const span = StockCharts.extent(StockCharts.render(data, result, $('stockFilter').value));
  const from = [result.curve[0].date, span.from].filter(Boolean).sort()[0], to = [result.curve.at(-1).date, span.to].filter(Boolean).sort().at(-1);
  Playback.play(from, to);
  bindLiveMetrics(); chart();
}
function chart() {
  if (!result) return;
  const points = result.curve, box = $('chart'), W = Math.max(245, box.clientWidth - 30), H = Math.max(160, box.clientHeight), left = 53, right = 15, top = 18, bottom = 30;
  const ts = points.map((p) => stamp(p.date)), t0 = ts[0], t1 = ts.at(-1);
  const values = points.map((p) => p.equity);
  let min = Math.min(...values, result.config.capital), max = Math.max(...values, result.config.capital);
  const pad = Math.max((max - min) * .15, result.config.capital * .01); min -= pad; max += pad;
  const x = (t) => left + (t1 > t0 ? (t - t0) / (t1 - t0) : 0) * (W - left - right);
  const y = (v) => top + (max - v) / (max - min) * (H - top - bottom);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(ts[i]).toFixed(2)},${y(p.equity).toFixed(2)}`).join(' ');
  let grid = '';
  for (let i = 0; i < 5; i++) {
    const v = min + (max - min) * i / 4, yy = y(v);
    grid += `<line x1="${left}" x2="${W - right}" y1="${yy}" y2="${yy}" stroke="#323232"/><text x="${left - 8}" y="${yy + 4}" fill="#828282" font-size="10" text-anchor="end">${(v / 1000).toFixed(0)}k</text>`;
  }
  const ticks = W < 450 ? 3 : 5;
  for (let i = 0; i < ticks; i++) {
    const k = Math.round(i * (points.length - 1) / (ticks - 1));
    grid += `<text x="${x(ts[k])}" y="${H - 4}" fill="#828282" font-size="10" text-anchor="${i === 0 ? 'start' : i === ticks - 1 ? 'end' : 'middle'}">${points[k].date.slice(0, 7)}</text>`;
  }
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily portfolio equity"><defs><linearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#e4e4e4" stop-opacity=".16"/><stop offset="1" stop-color="#e4e4e4" stop-opacity="0"/></linearGradient><clipPath id="equityReveal"><rect x="0" y="0" width="${W}" height="${H}"/></clipPath></defs>${grid}<line x1="${left}" x2="${W - right}" y1="${y(result.config.capital)}" y2="${y(result.config.capital)}" stroke="#5d5d5d" stroke-dasharray="4 5"/><g clip-path="url(#equityReveal)"><path d="${line} L${x(t1)},${H - bottom} L${left},${H - bottom} Z" fill="url(#equityFill)"/><path d="${line}" fill="none" stroke="#e4e4e4" stroke-width="2" vector-effect="non-scaling-stroke"/></g><g class="equity-head" visibility="hidden"><line class="playhead" y1="${top}" y2="${H - bottom}"/><circle r="4" fill="#e4e4e4" stroke="#141414" stroke-width="2"/><text class="play-label" y="${top + 10}" font-size="11"></text></g></svg><div class="tooltip"></div>`;
  const svg = box.querySelector('svg'), tip = box.querySelector('.tooltip'), reveal = svg.querySelector('#equityReveal rect');
  const head = svg.querySelector('.equity-head'), headLine = head.querySelector('line'), dot = head.querySelector('circle'), label = head.querySelector('text');
  Playback.bind(box, (t) => {
    const done = t === Infinity || t >= t1, k = indexAt(ts, t);
    reveal.setAttribute('width', done ? W : Math.max(0, x(Math.max(t0, t))));
    head.setAttribute('visibility', done || k < 0 ? 'hidden' : 'visible');
    if (done || k < 0) return;
    const px = x(t), flip = px > W - right - 80;
    headLine.setAttribute('x1', px); headLine.setAttribute('x2', px);
    dot.setAttribute('cx', x(ts[k])); dot.setAttribute('cy', y(points[k].equity));
    label.textContent = points[k].date;
    label.setAttribute('x', flip ? px - 6 : px + 6); label.setAttribute('text-anchor', flip ? 'end' : 'start');
  });
  svg.onpointermove = (event) => {
    const r = svg.getBoundingClientRect(), position = (event.clientX - r.left) / r.width * W;
    const t = Math.min(Playback.now(), t0 + Math.max(0, Math.min(1, (position - left) / (W - left - right))) * (t1 - t0));
    const k = indexAt(ts, t);
    if (k < 0) { tip.style.display = 'none'; return; }
    const p = points[k]; tip.style.display = 'block'; tip.textContent = `${p.date} / ${money(p.equity)} / DD ${pct(p.drawdown)}`;
  };
  svg.onpointerleave = () => { tip.style.display = 'none'; };
}
// Panels resize without a window resize, so watch the chart box itself.
if ('ResizeObserver' in window) {
  let lastWidth = 0, lastHeight = 0;
  new ResizeObserver(([entry]) => {
    const { width, height } = entry.contentRect;
    if (Math.abs(width - lastWidth) < 1 && Math.abs(height - lastHeight) < 1) return;
    lastWidth = width; lastHeight = height;
    if (result) chart();
  }).observe($('chart'));
} else window.addEventListener('resize', () => { if (result) chart(); });
Playback.onChange((s) => {
  const live = s.now !== Infinity;
  $('playDate').textContent = !result ? '—' : live ? new Date(Math.max(s.from, s.now)).toISOString().slice(0, 10) : 'COMPLETE';
  $('playFill').style.width = (result ? (live ? s.progress : 1) * 100 : 0) + '%';
  $('playback').classList.toggle('is-playing', s.playing);
  $('skip').disabled = !s.playing; $('replay').disabled = !result;
});
$('replay').onclick = () => { if (result) Playback.replay(); };
$('skip').onclick = () => Playback.finish();
function htmlTable(headers, rows) {
  return `<table><thead><tr>${headers.map((x) => `<th>${esc(x)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
}
const tr = (cells) => '<tr>' + cells.map((x) => `<td>${esc(x)}</td>`).join('') + '</tr>';
function table() {
  if (!result) return;
  if (tab === 'trades') $('table').innerHTML = result.trades.length ? htmlTable(['SYMBOL', 'ENTRY', 'EXIT', 'DIP', 'SIZE', 'BUY / SELL', 'P&L', 'RETURN', 'EXIT REASON'], result.trades.map((t) => tr([t.symbol, t.entryDate, t.exitDate, pct(t.dropPct), money(t.investment), t.entryPrice.toFixed(2) + ' / ' + t.exitPrice.toFixed(2), money(t.pnl), pct(t.returnPct), t.reason]))) : '<div class="empty">No closed trades. Check holdings and data coverage.</div>';
  if (tab === 'screen') $('table').innerHTML = result.screen.length ? htmlTable(['SYMBOL', 'MARKET CAP', 'YoY 1', 'YoY 2', 'YoY 3', 'RANGE', '30D DIP', 'FILTER', 'STATUS'], result.screen.map((s) => tr([s.symbol, money(s.marketCap), ...s.growth.map(pct), pct(s.spread), pct(s.dropPct), s.pass ? 'PASS' : 'FAIL', s.status]))) : '<div class="empty">No eligible data on the final simulation date.</div>';
  if (tab === 'open') $('table').innerHTML = result.open.length ? htmlTable(['SYMBOL', 'ENTRY', 'EXPIRY', 'SIZE', 'ENTRY PRICE', 'MARKET VALUE', 'P&L'], result.open.map((p) => tr([p.symbol, p.entryDate, p.deadline, money(p.investment), p.entryPrice.toFixed(2), money(p.value), money(p.pnl)]))) : '<div class="empty">No open positions.</div>';
  if (tab === 'rules') $('table').innerHTML = `<div class="rules"><b>EXECUTION PROTOCOL</b><ul><li>Compare the close with the most recent available close at or before 30 calendar days earlier, allowing a maximum seven-day gap.</li><li>Four annual revenue reports produce three consecutive YoY rates. Publication must precede the signal date. Use the latest eligible report for each fiscal year.</li><li>Order size is fixed using the signal close. Execute at the next available session open. One entry per symbol across the entire test; no averaging down or re-entry.</li><li>Insufficient cash cancels the order. Same-day orders execute in alphabetical ticker order. Apply costs on both sides.</li><li>A close at least ${result.config.target}% above entry triggers a sale at the next open. Otherwise sell at the first available open on or after the ${result.config.hold}-month deadline.</li><li>End-of-test holdings remain marked to market and are excluded from closed-trade win rate. Unfilled orders: ${result.pending.length}.</li><li>Return, CAGR and drawdown measure the whole portfolio, including cash and unrealized P&amp;L.</li></ul><b>DATA LIMITATIONS</b><ul>${result.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul><p>The screening table shows final-date candidates with valid prices and four annual revenue values. Rankings outside the supplied universe cannot be verified.</p><p><a href="https://site.financialmodelingprep.com/developer/docs" target="_blank" rel="noopener">FMP API documentation</a> / <a href="revenue-dip-lab.zip" download>Full project and data schema</a></p><button class="secondary" id="saveData">Export dataset JSON</button></div>`;
  if ($('saveData')) $('saveData').onclick = () => download('dataset.json', JSON.stringify(data), 'application/json');
}
document.querySelectorAll('[data-tab]').forEach((button) => { button.onclick = () => {
  tab = button.dataset.tab;
  document.querySelectorAll('[data-tab]').forEach((b) => { b.classList.toggle('active', b === button); b.setAttribute('aria-selected', String(b === button)); });
  table();
}; });
function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type })), a = document.createElement('a');
  a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('export').onclick = () => {
  if (!result) return;
  const keys = ['symbol', 'signalDate', 'entryDate', 'exitDate', 'dropPct', 'investment', 'entryPrice', 'exitPrice', 'shares', 'proceeds', 'pnl', 'returnPct', 'reason'];
  const quote = (value) => '"' + String(value ?? '').replace(/"/g, '""') + '"';
  download('trades.csv', '\ufeff' + keys.join(',') + '\n' + result.trades.map((t) => keys.map((key) => quote(t[key])).join(',')).join('\n'), 'text/csv;charset=utf-8');
};
$('closeHelp').onclick = () => $('help').close();
$('template').onclick = () => download('dataset-template.json', JSON.stringify({ source: 'Imported market data', universeMode: 'historical', prices: [{ symbol: 'EXAMPLE', date: '2022-01-03', open: 100, close: 100 }], financials: [2017, 2018, 2019, 2020].map((year, i) => ({ symbol: 'EXAMPLE', fiscalYear: year, published: `${year + 1}-03-01`, revenue: 1000000 * 1.1 ** i })), universe: [{ symbol: 'EXAMPLE', date: '2022-01-03', marketCap: 1e11, name: 'Example' }] }, null, 2), 'application/json');
$('fetch').onclick = async () => {
  if (!server) { $('help').showModal(); return; }
  const button = $('fetch'); button.disabled = true;
  try {
    const c = config(), response = await fetch('/api/data/fmp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ start: c.start, end: c.end }) });
    const job = await response.json(); if (!response.ok) throw Error(job.detail || 'Data collection failed.');
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 1800));
      const response = await fetch('/api/data/jobs/' + job.job); if (!response.ok) throw Error('Unable to retrieve job status.');
      const progress = await response.json(); status(`COLLECTING FMP / ${progress.progress}/${progress.total} / ${progress.symbol || 'Ranking the universe'}`);
      if (progress.status === 'failed') throw Error(progress.error);
      if (progress.status === 'succeeded') { setData(progress.data); await executeBacktest(true); break; }
    }
  } catch (error) { status('DATA ERROR / ' + error.message, true); }
  finally { button.disabled = false; }
};
$('stockFilter').onchange = () => { if (result) StockCharts.render(data, result, $('stockFilter').value); };
// ALL BACKTEST: every max holding × add-per-1% pair under the other current Strategy settings.
function runSweep() {
  if (!data) { status('NO DATA / Load a demo or import a dataset first.', true); return; }
  if (!$('settings').reportValidity()) return;
  const plan = Sweep.plan();
  if (plan.error) { status('SWEEP / ' + plan.error, true); return; }
  const c = config(), total = plan.runs, started = performance.now();
  Layout.focus('sweep');
  Sweep.run(data, c, {
    onProgress: (done, n, last) => status(done ? `ALL BACKTEST / ${done.toLocaleString()} / ${n.toLocaleString()} / ${Sweep.label(last)} → CAGR ${pct(last.cagr)}` : `ALL BACKTEST / Screening universe once for ${total.toLocaleString()} backtests…`),
    onDone: (best) => status(`ALL BACKTEST COMPLETE / ${total.toLocaleString()} runs in ${((performance.now() - started) / 1000).toFixed(1)}s / BEST CAGR ${pct(best?.cagr)} at ${best ? Sweep.label(best) : '—'}${synthetic() ? ' / Synthetic data, not actual market performance.' : ''}`),
    onError: (message) => status('SWEEP ERROR / ' + message, true),
  });
}
document.querySelectorAll('[data-sweep-run]').forEach((button) => { button.onclick = runSweep; });
addEventListener('sweep:apply', ({ detail: p }) => {
  Layout.focus('strategy');
  status(`APPLIED / ${p.label} (sweep CAGR ${pct(p.cagr)}). Run backtest to replay it.`);
});
function runFactors() {
  if (!data) { status('NO DATA / Load a demo or import a dataset first.', true); return; }
  if (!$('settings').reportValidity()) return;
  const plan = Factors.plan();
  if (plan.error) { status('FACTOR SEARCH / ' + plan.error, true); return; }
  Layout.focus('factors');
  Factors.run(data, config(), {
    onProgress: (done, n) => status(done ? `FACTOR SEARCH / ${done.toLocaleString()} / ${n.toLocaleString()} combinations` : `FACTOR SEARCH / Screening the universe in each worker for ${n.toLocaleString()} combinations…`),
    onDone: ({ seconds, runs, best, split }) => status(`FACTOR SEARCH COMPLETE / ${runs.toLocaleString()} combinations in ${seconds.toFixed(1)}s / BEST ${split ? 'IN-SAMPLE ' : ''}CAGR ${pct(best?.is.cagr)}${split ? ` → OUT-OF-SAMPLE ${pct(best?.oos.cagr)}` : ''}${synthetic() ? ' / Synthetic data.' : ''}`),
    onError: (message) => status('FACTOR SEARCH ERROR / ' + message, true),
  });
}
$('factorRun').onclick = runFactors;
addEventListener('factors:apply', ({ detail }) => { Layout.focus('strategy'); status(`APPLIED / ${detail.label} (in-sample CAGR ${pct(detail.cagr)}). Run backtest to replay it.`); });
addEventListener('factors:cancel', () => status('FACTOR SEARCH CANCELLED / Partial results kept.'));
addEventListener('sweep:cancel', () => status('ALL BACKTEST CANCELLED / Partial grid kept.'));
loadDemo();
