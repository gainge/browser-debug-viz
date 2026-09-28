import { h, fmtMs, fmtRel } from '../util/dom.js';

const AXIS_H = 26;
const BAND_H = 34;
const LANE_H = 9;
const LANE_GAP = 3;
const PAD = 12;

export function create(ctx) {
  const m = ctx.model;
  const stamped = m.messages.filter((x) => x.absMs != null);
  const span = Math.max(1, m.tEnd - m.t0);
  let view = [-span * 0.01, span * 1.02];
  let params = {};
  let hits = [];
  let brush = null;
  let showNet = true;
  let showCon = true;

  const lanes = packLanes(m.requests, m.t0);
  const laneCount = lanes.reduce((n, l) => Math.max(n, l + 1), 0);

  const canvas = h('canvas', { class: 'timeline-canvas' });
  const tooltip = h('div', { class: 'tooltip', hidden: true });
  const scroller = h('div', { class: 'timeline-scroll' }, canvas, tooltip);
  const rangeLabel = h('span', { class: 'muted small' });

  const toggle = (label, get, set) => {
    const box = h('input', { type: 'checkbox', checked: get(), onchange: () => (set(box.checked), draw()) });
    return h('label', { class: 'check' }, box, label);
  };

  const notes = [];
  if (m.consoleLog && !m.consoleLog.hasTimestamps) {
    notes.push(
      h(
        'div',
        { class: 'note' },
        'The console log has no timestamps, so only network requests are plotted. ',
        'Re-capture with DevTools Console settings → "Show timestamps" to place console messages on this timeline.',
      ),
    );
  }
  let offsetControl = null;
  if (m.timeAlign) {
    const a = m.timeAlign;
    const input = h('input', {
      type: 'number',
      step: '0.1',
      value: String(a.manualOffsetMs / 1000),
      class: 'offset-input',
      onchange: () => ctx.setManualOffset(Math.round(Number(input.value || 0) * 1000)),
    });
    offsetControl = h(
      'span',
      { class: 'offset-control', title: 'Console timestamps are local wall-clock time; the HAR is UTC. Adjust if markers look misaligned.' },
      `Console clock UTC${fmtOffset(a.offsetMin)} (${a.method}) · adjust `,
      input,
      ' s',
    );
  }

  const el = h(
    'div',
    { class: 'view timeline-view' },
    h(
      'div',
      { class: 'toolbar' },
      m.requests.length ? toggle('Network', () => showNet, (v) => (showNet = v)) : null,
      stamped.length ? toggle('Console', () => showCon, (v) => (showCon = v)) : null,
      h('button', { class: 'btn', text: '−', title: 'Zoom out', onclick: () => zoom(1.6, 0.5) }),
      h('button', { class: 'btn', text: '+', title: 'Zoom in', onclick: () => zoom(1 / 1.6, 0.5) }),
      h('button', { class: 'btn', text: 'Reset', onclick: () => ((view = [-span * 0.01, span * 1.02]), draw()) }),
      rangeLabel,
      offsetControl,
      h('span', { class: 'muted small hint', text: 'Drag to zoom into a range · ⌘/Ctrl+scroll to zoom · Shift+scroll to pan · double-click to reset' }),
    ),
    notes,
    legend(),
    scroller,
  );

  function zoom(factor, anchorFrac) {
    const width = view[1] - view[0];
    const anchor = view[0] + width * anchorFrac;
    const next = Math.max(width * factor, 5);
    view = [anchor - next * anchorFrac, anchor + next * (1 - anchorFrac)];
    draw();
  }

  const xOf = (ms, w) => PAD + ((ms - view[0]) / (view[1] - view[0])) * (w - PAD * 2);
  const msOf = (x, w) => view[0] + ((x - PAD) / (w - PAD * 2)) * (view[1] - view[0]);

  function draw() {
    const w = scroller.clientWidth;
    if (!w) return;
    const bandH = showCon && stamped.length ? BAND_H : 0;
    const netH = showNet ? laneCount * (LANE_H + LANE_GAP) + PAD : 0;
    const hgt = AXIS_H + bandH + netH + PAD;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = hgt * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${hgt}px`;
    const g = canvas.getContext('2d');
    g.scale(dpr, dpr);
    const css = getComputedStyle(document.documentElement);
    const color = (name) => css.getPropertyValue(name).trim();
    hits = [];

    g.fillStyle = color('--bg');
    g.fillRect(0, 0, w, hgt);

    // axis
    const step = niceStep((view[1] - view[0]) / Math.max(4, w / 110));
    g.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    g.textBaseline = 'middle';
    for (let t = Math.ceil(view[0] / step) * step; t <= view[1]; t += step) {
      const x = xOf(t, w);
      g.fillStyle = color('--grid');
      g.fillRect(Math.round(x), AXIS_H - 4, 1, hgt);
      g.fillStyle = color('--muted');
      g.fillText(fmtRel(t), x + 3, AXIS_H / 2);
    }

    for (const p of m.pages) {
      for (const [ms, name] of [
        [p.onContentLoad, '--c-dcl'],
        [p.onLoad, '--c-load'],
      ]) {
        if (ms == null) continue;
        g.fillStyle = color(name);
        g.fillRect(Math.round(xOf(p.startMs - m.t0 + ms, w)), AXIS_H, 1.5, hgt);
      }
    }

    const sel = params.sel;

    if (bandH) {
      const y = AXIS_H + bandH / 2;
      g.fillStyle = color('--panel');
      g.fillRect(0, AXIS_H, w, bandH - 4);
      for (const msg of stamped) {
        const x = xOf(msg.absMs - m.t0, w);
        if (x < -5 || x > w + 5) continue;
        const r = msg.level === 'error' ? 5 : 4;
        g.fillStyle = color(`--lvl-${msg.level}`);
        g.beginPath();
        g.moveTo(x, y - r);
        g.lineTo(x + r, y);
        g.lineTo(x, y + r);
        g.lineTo(x - r, y);
        g.fill();
        if (sel === `m${msg.id}`) {
          g.strokeStyle = color('--fg');
          g.lineWidth = 2;
          g.stroke();
        }
        hits.push({ x0: x - r - 1, x1: x + r + 1, y0: y - r - 2, y1: y + r + 2, kind: 'm', item: msg });
      }
    }

    if (showNet) {
      const top = AXIS_H + bandH + 4;
      for (const r of m.requests) {
        const x0 = xOf(r.startMs - m.t0, w);
        const x1 = Math.max(xOf(r.startMs - m.t0 + r.durationMs, w), x0 + 2);
        if (x1 < 0 || x0 > w) continue;
        const y = top + lanes[r.id] * (LANE_H + LANE_GAP);
        g.fillStyle = r.flags.failed ? color('--lvl-error') : color(`--t-${typeColor(r.resourceType)}`);
        g.fillRect(x0, y, x1 - x0, LANE_H);
        if (sel === `r${r.id}`) {
          g.strokeStyle = color('--fg');
          g.lineWidth = 2;
          g.strokeRect(x0 - 1, y - 1, x1 - x0 + 2, LANE_H + 2);
        }
        hits.push({ x0, x1, y0: y, y1: y + LANE_H, kind: 'r', item: r });
      }
    }

    if (brush) {
      g.fillStyle = color('--brush');
      g.fillRect(Math.min(brush.x0, brush.x1), 0, Math.abs(brush.x1 - brush.x0), hgt);
    }

    rangeLabel.textContent = `${fmtRel(view[0])} → ${fmtRel(view[1])} (${fmtMs(view[1] - view[0])})`;
  }

  const hitAt = (x, y) => {
    for (let i = hits.length - 1; i >= 0; i--) {
      const t = hits[i];
      if (x >= t.x0 && x <= t.x1 && y >= t.y0 && y <= t.y1) return t;
    }
    return null;
  };

  const local = (e) => {
    const rect = canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  };

  canvas.addEventListener('pointerdown', (e) => {
    const [x] = local(e);
    brush = { x0: x, x1: x, moved: false };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    const [x, y] = local(e);
    if (brush) {
      brush.x1 = x;
      brush.moved ||= Math.abs(brush.x1 - brush.x0) > 4;
      if (brush.moved) draw();
      return;
    }
    const hit = hitAt(x, y);
    canvas.style.cursor = hit ? 'pointer' : 'crosshair';
    if (!hit) {
      tooltip.hidden = true;
      return;
    }
    tooltip.hidden = false;
    tooltip.textContent =
      hit.kind === 'r'
        ? `${hit.item.error || hit.item.status} ${hit.item.method} ${hit.item.url}\n${fmtRel(hit.item.startMs - m.t0)} · ${fmtMs(hit.item.durationMs)} · ${hit.item.resourceType}`
        : `[${hit.item.level}] ${hit.item.text.slice(0, 300)}\n${fmtRel(hit.item.absMs - m.t0)}`;
    const maxLeft = scroller.clientWidth - 420;
    tooltip.style.left = `${Math.max(0, Math.min(x + 12, maxLeft))}px`;
    tooltip.style.top = `${y + 14}px`;
  });
  canvas.addEventListener('pointerup', (e) => {
    const [x, y] = local(e);
    const b = brush;
    brush = null;
    if (b?.moved) {
      const w = scroller.clientWidth;
      const a = msOf(Math.min(b.x0, b.x1), w);
      const z = msOf(Math.max(b.x0, b.x1), w);
      if (z - a > 1) view = [a, z];
      draw();
      return;
    }
    const hit = hitAt(x, y);
    if (hit) ctx.setParams({ sel: `${hit.kind}${hit.item.id}` });
  });
  canvas.addEventListener('pointerleave', () => (tooltip.hidden = true));
  canvas.addEventListener('dblclick', () => {
    view = [-span * 0.01, span * 1.02];
    draw();
  });
  canvas.addEventListener(
    'wheel',
    (e) => {
      const w = scroller.clientWidth;
      const [x] = local(e);
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoom(Math.exp(e.deltaY * 0.01), Math.min(Math.max((x - PAD) / (w - PAD * 2), 0), 1));
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        const delta = ((e.shiftKey ? e.deltaY : e.deltaX) / w) * (view[1] - view[0]);
        view = [view[0] + delta, view[1] + delta];
        draw();
      }
    },
    { passive: false },
  );

  new ResizeObserver(() => draw()).observe(scroller);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', draw);

  return {
    el,
    update(p) {
      params = p;
      draw();
    },
  };
}

// Greedy interval packing keeps concurrent requests on separate lanes while
// letting sequential ones share, so hundreds of requests fit on one screen.
function packLanes(requests, t0) {
  const laneEnds = [];
  const lanes = [];
  for (const r of requests) {
    const start = r.startMs - t0;
    const end = start + Math.max(r.durationMs, 1);
    let lane = laneEnds.findIndex((e) => e <= start);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = end;
    lanes[r.id] = lane;
  }
  return lanes;
}

function legend() {
  const item = (cls, label) => h('span', { class: 'legend-item' }, h('span', { class: `swatch ${cls}` }), label);
  return h(
    'div',
    { class: 'legend' },
    [
      ['document', 'Document'],
      ['script', 'Script'],
      ['stylesheet', 'CSS'],
      ['image', 'Image'],
      ['fetch', 'Fetch/XHR'],
      ['font', 'Font'],
      ['other', 'Other'],
    ].map(([t, label]) => item(`sw-${t}`, label)),
    item('sw-failed', 'Failed'),
    item('sw-dcl line', 'DOMContentLoaded'),
    item('sw-load line', 'Load'),
    item('sw-console', 'Console (◆ by level)'),
  );
}

function niceStep(raw) {
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (m * pow >= raw) return m * pow;
  return 10 * pow;
}

function typeColor(type) {
  return ['document', 'script', 'stylesheet', 'image', 'fetch', 'xhr', 'font', 'media', 'websocket'].includes(type)
    ? type === 'xhr'
      ? 'fetch'
      : type
    : 'other';
}

function fmtOffset(min) {
  const sign = min < 0 ? '−' : '+';
  const a = Math.abs(min);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}
