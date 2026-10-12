/* Five-panel workspace: drag headers to reorder panels, drag dividers to resize,
 * maximize a single panel. Pure layout functions are exported for the regression tests. */
(function (root) {
  'use strict';
  const DEFAULT = { order: ['strategy', 'results', 'signals', 'sweep', 'factors'], widths: { strategy: 0.19, results: 0.2, signals: 0.18, sweep: 0.21, factors: 0.22 } };
  const MIN = 0.1;
  function moveItem(order, from, to) {
    const next = order.slice(), [item] = next.splice(from, 1);
    next.splice(Math.max(0, Math.min(next.length, to)), 0, item);
    return next;
  }
  // Move `delta` (fraction of the workspace) from the right-hand panel to the left-hand one.
  function resizePair(a, b, delta, min = MIN) {
    const total = a + b, left = Math.max(min, Math.min(total - min, a + delta));
    return [left, total - left];
  }
  // Slot for a dragged panel: the number of other panels whose centre lies before its centre.
  function slotFor(otherCenters, center) {
    return otherCenters.filter((c) => c < center).length;
  }
  function sanitize(saved) {
    const ids = DEFAULT.order;
    if (!saved || !Array.isArray(saved.order) || saved.order.length !== ids.length || !ids.every((id) => saved.order.includes(id))) return structuredClone(DEFAULT);
    const widths = {};
    for (const id of ids) { const w = Number(saved.widths?.[id]); widths[id] = Number.isFinite(w) && w >= MIN ? w : DEFAULT.widths[id]; }
    const sum = ids.reduce((s, id) => s + widths[id], 0);
    for (const id of ids) widths[id] /= sum;
    return { order: saved.order.slice(), widths };
  }
  if (typeof module !== 'undefined') { module.exports = { moveItem, resizePair, slotFor, sanitize, DEFAULT }; return; }

  const KEY = 'rdl-layout-v4';
  const workspace = document.getElementById('workspace');
  const panels = new Map([...workspace.querySelectorAll('.panel')].map((p) => [p.dataset.panel, p]));
  const gutters = [...workspace.querySelectorAll('.gutter')];
  const stacked = root.matchMedia('(max-width: 900px)');
  const reduce = () => root.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let layout = DEFAULT;
  try { layout = sanitize(JSON.parse(localStorage.getItem(KEY))); } catch { layout = structuredClone(DEFAULT); }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(layout)); } catch { /* storage unavailable */ } };
  const axis = () => stacked.matches ? 'y' : 'x';
  const offset = (el) => axis() === 'x' ? el.offsetLeft : el.offsetTop;

  function apply() {
    layout.order.forEach((id, slot) => {
      const panel = panels.get(id);
      panel.style.order = String(slot * 2);
      panel.style.flex = stacked.matches ? '' : `${layout.widths[id]} 1 0px`;
    });
    gutters.forEach((g, i) => { g.style.order = String(i * 2 + 1); });
  }
  // FLIP: keep moved panels visually in place, then let them slide into their new slots.
  function animateFrom(before) {
    if (reduce()) return;
    for (const [panel, start] of before) {
      const shift = start - offset(panel);
      if (!shift || panel.classList.contains('is-dragging')) continue;
      panel.style.transition = 'none';
      panel.style.transform = axis() === 'x' ? `translateX(${shift}px)` : `translateY(${shift}px)`;
      requestAnimationFrame(() => { panel.style.transition = ''; panel.style.transform = ''; });
    }
  }
  function reorder(id, slot) {
    const from = layout.order.indexOf(id);
    if (from === slot) return;
    const before = [...panels.values()].map((p) => [p, offset(p)]);
    layout.order = moveItem(layout.order, from, slot);
    apply(); animateFrom(before); save();
  }

  // Panel drag. Mouse can grab the whole heading; touch uses the grip so headings still scroll.
  let drag = null;
  function dragStart(e) {
    if (e.button !== 0 || workspace.dataset.max) return;
    const grip = e.target.closest('.grip');
    if (!grip && (e.pointerType === 'touch' || e.target.closest('input, select, a, button'))) return;
    const panel = e.currentTarget.closest('.panel');
    drag = { pointer: e.pointerId, zone: e.currentTarget, panel, id: panel.dataset.panel, start: axis() === 'x' ? e.clientX : e.clientY, origin: offset(panel), active: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function dragMove(e) {
    if (!drag || drag.pointer !== e.pointerId) return;
    const delta = (axis() === 'x' ? e.clientX : e.clientY) - drag.start;
    if (!drag.active) {
      if (Math.abs(delta) < 6) return;
      drag.active = true; drag.panel.classList.add('is-dragging'); workspace.classList.add('is-reordering');
    }
    e.preventDefault();
    const size = axis() === 'x' ? drag.panel.offsetWidth : drag.panel.offsetHeight;
    const center = drag.origin + delta + size / 2;
    const others = layout.order.filter((id) => id !== drag.id).map((id) => { const p = panels.get(id); return offset(p) + (axis() === 'x' ? p.offsetWidth : p.offsetHeight) / 2; });
    reorder(drag.id, slotFor(others, center));
    const shift = drag.origin + delta - offset(drag.panel);
    drag.panel.style.transform = axis() === 'x' ? `translateX(${shift}px)` : `translateY(${shift}px)`;
  }
  function dragEnd(e) {
    if (!drag || drag.pointer !== e.pointerId) return;
    const d = drag; drag = null;
    if (d.zone.hasPointerCapture(e.pointerId)) d.zone.releasePointerCapture(e.pointerId);
    if (!d.active) return;
    d.panel.classList.remove('is-dragging'); workspace.classList.remove('is-reordering');
    d.panel.style.transform = '';
  }
  for (const panel of panels.values()) {
    const zone = panel.querySelector('[data-drag-zone]');
    zone.addEventListener('pointerdown', dragStart);
    zone.addEventListener('pointermove', dragMove);
    zone.addEventListener('pointerup', dragEnd);
    zone.addEventListener('pointercancel', dragEnd);
    const grip = panel.querySelector('.grip');
    grip.addEventListener('keydown', (e) => {
      const back = ['ArrowLeft', 'ArrowUp'].includes(e.key), forward = ['ArrowRight', 'ArrowDown'].includes(e.key);
      if (!back && !forward) return;
      e.preventDefault();
      const slot = layout.order.indexOf(panel.dataset.panel);
      reorder(panel.dataset.panel, Math.max(0, Math.min(layout.order.length - 1, slot + (forward ? 1 : -1))));
      grip.focus();
    });
    panel.querySelector('.maximize').addEventListener('click', () => maximize(panel.dataset.panel));
    zone.addEventListener('dblclick', (e) => { if (!e.target.closest('input, select, button')) maximize(panel.dataset.panel); });
  }

  // Divider drag: gutter i sits between slot i and slot i + 1.
  gutters.forEach((gutter, i) => {
    let resize = null;
    const pair = () => [layout.order[i], layout.order[i + 1]];
    const set = (delta, base) => {
      const [a, b] = pair();
      [layout.widths[a], layout.widths[b]] = resizePair(base[0], base[1], delta);
      apply();
    };
    gutter.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const [a, b] = pair();
      resize = { pointer: e.pointerId, x: e.clientX, base: [layout.widths[a], layout.widths[b]], span: workspace.clientWidth - gutters.length * gutter.offsetWidth };
      gutter.setPointerCapture(e.pointerId); gutter.classList.add('active'); workspace.classList.add('is-resizing');
      e.preventDefault();
    });
    gutter.addEventListener('pointermove', (e) => {
      if (!resize || resize.pointer !== e.pointerId) return;
      set((e.clientX - resize.x) / Math.max(1, resize.span), resize.base);
    });
    const end = (e) => {
      if (!resize || resize.pointer !== e.pointerId) return;
      resize = null; gutter.classList.remove('active'); workspace.classList.remove('is-resizing'); save();
    };
    gutter.addEventListener('pointerup', end);
    gutter.addEventListener('pointercancel', end);
    gutter.addEventListener('dblclick', () => {
      const [a, b] = pair(), half = (layout.widths[a] + layout.widths[b]) / 2;
      layout.widths[a] = layout.widths[b] = half; apply(); save();
    });
    gutter.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      e.preventDefault();
      const [a, b] = pair();
      set(e.key === 'ArrowRight' ? 0.02 : -0.02, [layout.widths[a], layout.widths[b]]); save();
    });
  });

  function maximize(id) {
    const on = workspace.dataset.max !== id;
    if (on) workspace.dataset.max = id; else delete workspace.dataset.max;
    for (const [pid, panel] of panels) {
      const b = panel.querySelector('.maximize');
      b.textContent = on && pid === id ? '⤡' : '⤢';
      b.setAttribute('aria-pressed', String(on && pid === id));
    }
  }
  function focusPanel(id) {
    const panel = panels.get(id);
    if (workspace.dataset.max && workspace.dataset.max !== id) maximize(workspace.dataset.max);
    if (stacked.matches) panel.scrollIntoView({ behavior: reduce() ? 'auto' : 'smooth', block: 'start' });
    panel.classList.remove('pulse'); void panel.offsetWidth; panel.classList.add('pulse');
  }
  document.getElementById('resetLayout').addEventListener('click', () => {
    const before = [...panels.values()].map((p) => [p, offset(p)]);
    layout = structuredClone(DEFAULT);
    if (workspace.dataset.max) maximize(workspace.dataset.max);
    apply(); animateFrom(before); save();
  });
  stacked.addEventListener('change', apply);
  apply();
  root.Layout = { focus: focusPanel, maximize };
})(globalThis);
