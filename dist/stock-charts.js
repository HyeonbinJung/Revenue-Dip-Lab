/* Per-symbol three-year price histories and actual execution markers.
 * Pure model functions are exported for the regression tests. */
(function (root) {
  'use strict';
  const DAY = 86400000;
  const stamp = (s) => Date.parse(s + 'T00:00:00Z');
  const iso = (n) => new Date(n).toISOString().slice(0, 10);
  const safe = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const dollars = (n) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  function shiftMonths(s, m) {
    const d = new Date(stamp(s)), originalDay = d.getUTCDate();
    d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + m);
    const maxDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(originalDay, maxDay));
    return iso(+d);
  }
  function windowFor(end, trade) {
    let to = end, from = iso(stamp(shiftMonths(to, -36)) + DAY);
    // Retain the actual entry when a longer backtest started more than 3 years ago.
    if (trade && trade.entryDate < from) {
      to = [shiftMonths(trade.entryDate, 24), end].sort()[0];
      from = iso(stamp(shiftMonths(to, -36)) + DAY);
    }
    return { from, to };
  }
  function buildModels(data, result, filter = 'all') {
    const history = new Map(), companies = new Map();
    for (const p of data.prices) {
      if (!history.has(p.symbol)) history.set(p.symbol, []);
      history.get(p.symbol).push(p);
    }
    for (const h of history.values()) h.sort((a, b) => a.date.localeCompare(b.date));
    for (const u of data.universe) companies.set(u.symbol, u.name || u.symbol);
    const trades = new Map([...result.trades, ...result.open].map((t) => [t.symbol, t]));
    const candidates = result.universeSymbols || result.screen.map((s) => s.symbol);
    const symbols = [...new Set([...candidates, ...trades.keys()])];
    symbols.sort((a, b) => {
      const ta = trades.get(a), tb = trades.get(b);
      if (ta && !tb) return -1;
      if (tb && !ta) return 1;
      return (ta && tb ? ta.entryDate.localeCompare(tb.entryDate) : 0) || a.localeCompare(b);
    });
    return symbols.filter((s) => filter !== 'entered' || trades.has(s)).map((symbol) => {
      const trade = trades.get(symbol), range = windowFor(result.config.end, trade);
      const points = (history.get(symbol) || []).filter((p) => p.date >= range.from && p.date <= range.to);
      const events = [];
      if (trade) {
        events.push({ kind: 'buy', date: trade.entryDate, price: trade.entryPrice });
        if (trade.exitDate) events.push({ kind: 'sell', date: trade.exitDate, price: trade.exitPrice });
      }
      return { symbol, name: companies.get(symbol) || symbol, range, points, trade, events,
        visibleEvents: events.filter((e) => e.date >= range.from && e.date <= range.to) };
    });
  }
  // Compact charts are small multiples: fewer labels and smaller markers.
  function geometry(W, H, compact) {
    if (compact) return { left: 36, right: 6, top: 8, bottom: 16, font: 9, rows: 3, ticks: 3, r: 6 };
    return { left: W < 450 ? 52 : 78, right: W < 450 ? 16 : 28, top: 28, bottom: 35, font: 12, rows: 4, ticks: W < 450 ? 3 : 4, r: 9 };
  }
  let clipId = 0;
  function makeSVG(model, width = 1040, height = 250, compact = false) {
    const W = Math.max(compact ? 120 : 245, width), H = Math.max(60, height), g = geometry(W, H, compact);
    const { left, right, top, bottom } = g;
    const p = model.points;
    if (!p.length) return '<div class="empty">No price data in this window.</div>';
    const values = [...p.map((v) => v.close), ...model.visibleEvents.map((v) => v.price)];
    let low = Math.min(...values), high = Math.max(...values), pad = Math.max((high - low) * .17, high * .01);
    low = Math.max(0, low - pad); high += pad;
    const x = (date) => left + (stamp(date) - stamp(model.range.from)) / (stamp(model.range.to) - stamp(model.range.from)) * (W - left - right);
    const y = (v) => top + (high - v) / (high - low) * (H - top - bottom);
    let grid = '';
    for (let i = 0; i < g.rows; i++) {
      const price = low + (high - low) * i / (g.rows - 1), yy = y(price);
      const label = compact ? price.toFixed(price >= 100 ? 0 : 1) : price.toFixed(price > 1000 ? 0 : 2);
      grid += `<line x1="${left}" x2="${W - right}" y1="${yy}" y2="${yy}" stroke="#313131"/><text x="${left - (compact ? 5 : 10)}" y="${yy + g.font / 3}" fill="#909090" text-anchor="end" font-size="${g.font}">${label}</text>`;
    }
    for (let i = 0; i < g.ticks; i++) {
      const d = iso(stamp(model.range.from) + (stamp(model.range.to) - stamp(model.range.from)) * i / (g.ticks - 1));
      grid += `<text x="${x(d)}" y="${H - (compact ? 4 : 8)}" fill="#909090" text-anchor="${i === 0 ? 'start' : i === g.ticks - 1 ? 'end' : 'middle'}" font-size="${g.font}">${compact ? d.slice(0, 4) : d.slice(0, 7)}</text>`;
    }
    let band = '';
    if (model.trade) {
      const a = Math.max(left, x(model.trade.entryDate)), b = Math.min(W - right, x(model.trade.exitDate || model.range.to));
      if (b > a) band = `<rect x="${a}" y="${top}" width="${b - a}" height="${H - top - bottom}" fill="#7fb98f" opacity=".06"/>`;
    }
    const line = p.map((v, i) => `${i ? 'L' : 'M'}${x(v.date).toFixed(2)},${y(v.close).toFixed(2)}`).join(' ');
    const markers = model.visibleEvents.map((e) => {
      const buy = e.kind === 'buy', color = buy ? '#7fb98f' : '#d9776f', title = `${buy ? 'BUY' : 'SELL'} ${e.date} · ${dollars(e.price)}`;
      const near = g.r * 3;
      const overlaps = model.visibleEvents.some((other) => other !== e && Math.hypot(x(other.date) - x(e.date), y(other.price) - y(e.price)) < near);
      const labelY = overlaps ? Math.max(top + g.r, Math.min(H - bottom - g.r, y(e.price) + (buy ? -1 : 1) * g.r * 2.2)) : y(e.price);
      const leader = overlaps ? `<line x1="${x(e.date)}" x2="${x(e.date)}" y1="${y(e.price)}" y2="${labelY}" stroke="${color}"/><circle cx="${x(e.date)}" cy="${y(e.price)}" r="${compact ? 2 : 3}" fill="${color}"/>` : '';
      return `<g class="trade-marker ${e.kind}" data-date="${safe(e.date)}" data-price="${e.price}" tabindex="0" aria-label="${safe(title)}"><title>${safe(title)}</title><line x1="${x(e.date)}" x2="${x(e.date)}" y1="${top}" y2="${H - bottom}" stroke="${color}" opacity=".5" stroke-dasharray="${compact ? '2 3' : '4 4'}"/>${leader}<circle cx="${x(e.date)}" cy="${labelY}" r="${g.r}" fill="${color}" stroke="#141414" stroke-width="${compact ? 1.5 : 2}"/><text x="${x(e.date)}" y="${labelY + g.r * .42}" fill="#141414" text-anchor="middle" font-size="${compact ? 8 : 11}" font-weight="700">${buy ? 'B' : 'S'}</text></g>`;
    }).join('');
    const id = 'reveal-' + (++clipId);
    // The clip rectangle and playhead are driven by the shared playback clock.
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${safe(model.symbol)} three-year closing prices and execution markers" data-plot-left="${left}" data-plot-right="${W - right}"><defs><clipPath id="${id}"><rect class="reveal" x="0" y="0" width="${W}" height="${H}"/></clipPath></defs>${grid}<g clip-path="url(#${id})">${band}<path d="${line}" fill="none" stroke="#e4e4e4" stroke-width="${compact ? 1.3 : 1.7}" vector-effect="non-scaling-stroke"/></g><line class="playhead" x1="0" x2="0" y1="${top}" y2="${H - bottom}" visibility="hidden"/>${markers}</svg><div class="price-tooltip" hidden></div>`;
  }
  let generation = 0, observer = null, resizeObserver = null, frame = null;
  function clear() {
    generation++;
    if (observer) observer.disconnect();
    if (resizeObserver) resizeObserver.disconnect();
    if (frame !== null) cancelAnimationFrame(frame);
    const container = document.getElementById('stockCharts');
    if (container) container.replaceChildren();
  }
  function paint(box, model) {
    const width = Math.max(120, box.clientWidth - (box.clientWidth > 500 ? 28 : 6)), height = Math.max(60, box.clientHeight);
    const compact = height < 170, { left, right } = geometry(width, height, compact);
    box.dataset.painted = 'true';
    box.innerHTML = makeSVG(model, width, height, compact);
    if (!model.points.length) return;
    const svg = box.querySelector('svg'), tip = box.querySelector('.price-tooltip');
    const reveal = svg.querySelector('.reveal'), playhead = svg.querySelector('.playhead');
    const markers = [...svg.querySelectorAll('.trade-marker')].map((m) => [m, stamp(m.dataset.date)]);
    const from = stamp(model.range.from), to = stamp(model.range.to), span = width - left - right;
    Playback.bind(box, (t) => {
      const done = t === Infinity || t >= to, k = done ? 1 : Math.max(0, (t - from) / (to - from)), px = left + k * span;
      reveal.setAttribute('width', done ? width : Math.max(0, px));
      playhead.setAttribute('visibility', done || t < from ? 'hidden' : 'visible');
      playhead.setAttribute('x1', px); playhead.setAttribute('x2', px);
      for (const [m, at] of markers) m.classList.toggle('pending', at > t);
    });
    svg.addEventListener('pointermove', (e) => {
      const rect = svg.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, ((e.clientX - rect.left) / rect.width * width - left) / span));
      const t = Math.min(Playback.now(), from + ratio * (to - from));
      const points = model.points; let lo = 0, hi = points.length - 1;
      while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (stamp(points[mid].date) < t) lo = mid + 1; else hi = mid; }
      let k = lo;
      if (k > 0 && Math.abs(stamp(points[k - 1].date) - t) < Math.abs(stamp(points[k].date) - t)) k--;
      const p = points[k];
      if (stamp(p.date) > Playback.now()) { tip.hidden = true; return; }
      tip.hidden = false;
      tip.textContent = compact ? `${p.date} · ${dollars(p.close)}` : `${p.date} · CLOSE ${dollars(p.close)}`;
    });
    svg.addEventListener('pointerleave', () => { tip.hidden = true; });
  }
  function card(model, index) {
    const el = document.createElement('article'), t = model.trade;
    el.className = 'stock-card' + (t ? ' entered' : ''); el.dataset.symbol = model.symbol;
    el.tabIndex = 0; el.setAttribute('role', 'button'); el.setAttribute('aria-expanded', 'false');
    const state = !t ? 'NO ENTRY' : !t.exitDate ? 'OPEN' : (t.returnPct >= 0 ? '+' : '') + t.returnPct.toFixed(1) + '%';
    const stateClass = !t ? '' : !t.exitDate ? 'entered' : t.returnPct >= 0 ? 'entered win' : 'entered loss';
    const buyText = t ? `B ${t.entryDate} · ${dollars(t.entryPrice)}` : 'No executed order';
    const sellText = t?.exitDate ? `S ${t.exitDate} · ${dollars(t.exitPrice)}` : t ? `OPEN → ${t.deadline}` : '';
    const coverage = model.points.length ? `${model.points[0].date} — ${model.points.at(-1).date} / ${model.points.length} daily bars` : 'No prices';
    const limited = !model.points.length || stamp(model.points[0].date) - stamp(model.range.from) > 10 * DAY || stamp(model.range.to) - stamp(model.points.at(-1).date) > 10 * DAY;
    const hiddenExit = model.events.some((e) => e.date < model.range.from || e.date > model.range.to);
    const detail = t ? `SIZE ${dollars(t.investment)}${t.exitDate ? ' · ' + t.reason : ''}` : 'No executed order under these parameters';
    el.title = `${model.symbol} · ${model.name}\n${t ? buyText + (sellText ? '\n' + sellText : '') + '\n' + detail : detail}`;
    el.innerHTML = `<div class="stock-card-heading"><span class="stock-number">${String(index + 1).padStart(3, '0')}</span><strong>${safe(model.symbol)}</strong><span class="company-name">${safe(model.name)}</span><span class="stock-state ${stateClass}">${state}</span></div><div class="stock-price-plot"><div class="empty">…</div></div><div class="trade-details"><span class="buy-detail">${safe(buyText)}</span><span class="sell-detail">${safe(sellText)}</span></div><div class="stock-card-footer"><span>${safe(detail)}</span><span>36M WINDOW ${model.range.from} — ${model.range.to}</span><span>${safe(coverage)}${limited ? ' · PARTIAL COVERAGE' : ''}${hiddenExit ? ' · EXECUTION OUTSIDE WINDOW' : ''}</span></div>`;
    const toggle = () => {
      const open = el.classList.toggle('expanded');
      el.setAttribute('aria-expanded', String(open));
      if (open) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    };
    el.addEventListener('click', (e) => { if (!e.target.closest('.trade-marker')) toggle(); });
    el.addEventListener('keydown', (e) => { if (e.target === el && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle(); } });
    return el;
  }
  function render(data, result, filter) {
    clear(); const id = generation, models = buildModels(data, result, filter);
    const container = document.getElementById('stockCharts'), progress = document.getElementById('stockProgress');
    document.getElementById('stockSummary').textContent = `${data.source?.toLowerCase().includes('synthetic') ? 'SYNTHETIC / ' : ''}${models.length} SYMBOLS / ${result.metrics.entered} ENTERED / DAILY CLOSE / USD`;
    if (!models.length) { container.innerHTML = '<div class="empty">No symbols to display. Review parameters and data coverage.</div>'; progress.textContent = ''; return models; }
    const lookup = new WeakMap();
    if ('ResizeObserver' in root) resizeObserver = new ResizeObserver((entries) => { for (const e of entries) if (e.target.dataset.painted) paint(e.target, lookup.get(e.target)); });
    if ('IntersectionObserver' in root) observer = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { const m = lookup.get(e.target); if (m) paint(e.target, m); observer.unobserve(e.target); }
    }, { rootMargin: '400px 0px' });
    let i = 0;
    function batch() {
      if (generation !== id) return;
      const stop = Math.min(i + 24, models.length), frag = document.createDocumentFragment(), boxes = [];
      while (i < stop) { const m = models[i], el = card(m, i++), box = el.querySelector('.stock-price-plot'); lookup.set(box, m); boxes.push([box, m]); frag.append(el); }
      container.append(frag);
      for (const [box, model] of boxes) {
        if (resizeObserver) resizeObserver.observe(box);
        if (observer) observer.observe(box); else paint(box, model);
      }
      progress.textContent = `${i} / ${models.length} PRICE SERIES INDEXED`;
      if (i < models.length) frame = requestAnimationFrame(batch);
    }
    frame = requestAnimationFrame(batch);
    return models;
  }
  // Earliest and latest dates any chart covers; the playback clock spans this interval.
  function extent(models) {
    let from = null, to = null;
    for (const m of models) {
      if (!from || m.range.from < from) from = m.range.from;
      if (!to || m.range.to > to) to = m.range.to;
    }
    return { from, to };
  }
  const api = { buildModels, windowFor, makeSVG, render, clear, extent };
  if (typeof module !== 'undefined') module.exports = api; else root.StockCharts = api;
})(globalThis);
