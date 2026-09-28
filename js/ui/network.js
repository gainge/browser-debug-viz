import { h, fmtBytes, fmtMs, fmtRel, makeMatcher } from '../util/dom.js';
import { VirtualList } from './virtual-list.js';
import { failureKey } from '../model.js';

const COLUMNS = [
  { id: 'status', label: 'Status', sort: (r) => r.status },
  { id: 'method', label: 'Method', sort: (r) => r.method },
  { id: 'host', label: 'Host', sort: (r) => r.host },
  { id: 'path', label: 'Path', sort: (r) => r.path },
  { id: 'type', label: 'Type', sort: (r) => r.resourceType },
  { id: 'initiator', label: 'Initiator', sort: (r) => r.initiator?.type || '' },
  { id: 'size', label: 'Size', sort: (r) => r.transferSize ?? -1 },
  { id: 'time', label: 'Time', sort: (r) => r.durationMs },
  { id: 'start', label: 'Waterfall', sort: (r) => r.startMs },
];

export const FLAGS = {
  failed: { label: 'Failed', test: (r) => r.flags.failed },
  blocked: { label: 'Blocked', test: (r) => r.flags.blocked },
  slow: { label: 'Slow', test: (r) => r.flags.slow },
  large: { label: 'Large', test: (r) => r.flags.large },
  redirect: { label: 'Redirects', test: (r) => r.flags.redirect },
  preflight: { label: 'Failed preflight', test: (r) => r.resourceType === 'preflight' && r.flags.failed },
  related: { label: 'Has console messages', test: (r) => r.relatedMessageIds.length > 0 },
};

const STATUS = {
  '': 'Any status',
  '2xx': '2xx',
  '3xx': '3xx',
  '4xx': '4xx',
  '5xx': '5xx',
  err: 'No response / net error',
};

export function create(ctx) {
  const m = ctx.model;
  if (!m.har) {
    return {
      el: h('div', { class: 'view empty-view' }, h('p', { class: 'muted', text: 'No HAR loaded. Drop a .har from DevTools Network → Export HAR to populate this view.' })),
      update() {},
    };
  }
  const span = Math.max(1, m.tEnd - m.t0);
  const collapsed = new Set();
  let params = {};
  let lastSel = null;

  const search = h('input', {
    type: 'search',
    class: 'search',
    placeholder: 'Filter URL (text or /regex/)',
    oninput: () => ctx.setParams({ q: search.value }),
  });
  const statusSel = h(
    'select',
    { onchange: () => ctx.setParams({ status: statusSel.value }) },
    Object.entries(STATUS).map(([v, label]) => h('option', { value: v, text: label })),
  );
  const hostList = h('datalist', { id: 'host-list' }, m.hostStats.map((s) => h('option', { value: s.host })));
  const hostInput = h('input', {
    type: 'search',
    class: 'host-input',
    placeholder: 'Host',
    list: 'host-list',
    onchange: () => ctx.setParams({ host: hostInput.value }),
  });
  const firstParty = h('input', { type: 'checkbox', onchange: () => ctx.setParams({ fp: firstParty.checked ? '1' : '' }) });
  const groupSel = h(
    'select',
    { onchange: () => ctx.setParams({ group: groupSel.value }) },
    h('option', { value: '', text: 'No grouping' }),
    h('option', { value: 'host', text: 'Group by host' }),
    h('option', { value: 'type', text: 'Group by type' }),
    h('option', { value: 'code', text: 'Group by failure' }),
  );
  const typeChips = h(
    'div',
    { class: 'chips' },
    m.types.map((t) =>
      h(
        'button',
        {
          class: 'chip',
          dataset: { type: t.key },
          onclick: () => {
            const set = new Set((params.types || '').split(',').filter(Boolean));
            set.has(t.key) ? set.delete(t.key) : set.add(t.key);
            ctx.setParams({ types: [...set].join(',') });
          },
        },
        t.key,
        h('span', { class: 'count', text: t.count }),
      ),
    ),
  );
  const flagChips = h(
    'div',
    { class: 'chips' },
    Object.entries(FLAGS).map(([key, f]) =>
      h('button', { class: 'chip flag', dataset: { flag: key }, onclick: () => ctx.setParams({ flag: params.flag === key ? '' : key }) }, f.label),
    ),
  );
  const activeFilters = h('div', { class: 'active-filters' });
  const summary = h('span', { class: 'muted small' });

  const header = h(
    'div',
    { class: 'net-row net-header' },
    COLUMNS.map((c) =>
      h('button', {
        class: `cell col-${c.id}`,
        dataset: { col: c.id },
        text: c.label,
        onclick: () => {
          const dir = (params.sort || 'start') === c.id && params.dir !== 'desc' ? 'desc' : 'asc';
          const isDefault = c.id === 'start' && dir === 'asc';
          ctx.setParams({ sort: isDefault ? '' : c.id, dir: isDefault ? '' : dir });
        },
      }),
    ),
  );

  const list = new VirtualList({ rowHeight: 26, renderRow });
  list.el.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const idx = list.items.findIndex((it) => !it.group && `r${it.id}` === params.sel);
    for (let i = idx + (e.key === 'ArrowDown' ? 1 : -1); i >= 0 && i < list.items.length; i += e.key === 'ArrowDown' ? 1 : -1) {
      if (!list.items[i].group) {
        ctx.setParams({ sel: `r${list.items[i].id}` });
        break;
      }
    }
  });

  const el = h(
    'div',
    { class: 'view network-view' },
    h(
      'div',
      { class: 'toolbar' },
      search,
      statusSel,
      hostInput,
      hostList,
      h('label', { class: 'check', title: `Hide hosts outside ${m.pageHost || 'the page site'}` }, firstParty, 'First-party only'),
      groupSel,
      summary,
    ),
    h('div', { class: 'toolbar secondary' }, typeChips),
    h('div', { class: 'toolbar secondary' }, flagChips, activeFilters),
    h('div', { class: 'table' }, header, list.el),
  );

  function renderRow(item) {
    if (item.group) {
      return h(
        'div',
        {
          class: `group-row ${collapsed.has(item.key) ? 'collapsed' : ''}`,
          onclick: () => {
            collapsed.has(item.key) ? collapsed.delete(item.key) : collapsed.add(item.key);
            refresh();
          },
        },
        h('span', { class: 'caret', text: collapsed.has(item.key) ? '▸' : '▾' }),
        h('span', { class: 'group-key', text: item.key || '(none)' }),
        h('span', { class: 'muted', text: `${item.count} requests` }),
        item.failed ? h('span', { class: 'badge error', text: `${item.failed} failed` }) : null,
      );
    }
    const r = item;
    const left = ((r.startMs - m.t0) / span) * 100;
    const width = Math.max((r.durationMs / span) * 100, 0.15);
    return h(
      'div',
      {
        class: `net-row ${r.flags.failed ? 'failed' : ''} ${params.sel === `r${r.id}` ? 'selected' : ''}`,
        onclick: () => ctx.setParams({ sel: `r${r.id}` }),
        title: r.url,
      },
      h('span', { class: `cell col-status ${statusClass(r)}`, text: r.error ? shortError(r.error) : r.status || '—', title: r.error || `${r.status} ${r.statusText}` }),
      h('span', { class: 'cell col-method', text: r.method }),
      h('span', { class: `cell col-host ellipsis ${r.thirdParty ? 'third-party' : ''}`, text: r.host }),
      h('span', { class: 'cell col-path ellipsis mono', text: r.path }),
      h('span', { class: 'cell col-type', text: r.resourceType }),
      h('span', { class: 'cell col-initiator ellipsis', text: initiatorLabel(r) }),
      h('span', { class: 'cell col-size num', text: r.fromCache ? `(${r.fromCache})` : fmtBytes(r.transferSize) }),
      h('span', { class: `cell col-time num ${r.flags.slow ? 'slow' : ''}`, text: fmtMs(r.durationMs) }),
      h(
        'span',
        { class: 'cell col-start waterfall', title: `${fmtRel(r.startMs - m.t0)} · ${fmtMs(r.durationMs)}` },
        h('span', { class: `wf-bar type-${r.resourceType} ${r.flags.failed ? 'failed' : ''}`, style: { left: `${left}%`, width: `${width}%` } }),
        r.relatedMessageIds.length ? h('span', { class: 'console-dot', title: `${r.relatedMessageIds.length} console message(s)` }) : null,
      ),
    );
  }

  function filtered() {
    const match = makeMatcher(params.q);
    const types = params.types ? new Set(params.types.split(',')) : null;
    const flag = FLAGS[params.flag];
    const host = params.host;
    return m.requests.filter(
      (r) =>
        (!match || match(r.url)) &&
        (!types || types.has(r.resourceType)) &&
        (!flag || flag.test(r)) &&
        (!host || r.host === host) &&
        (!params.fp || !r.thirdParty) &&
        (!params.code || (r.flags.failed && failureKey(r) === params.code)) &&
        statusMatches(r, params.status),
    );
  }

  function refresh() {
    let rows = filtered();
    const col = COLUMNS.find((c) => c.id === params.sort);
    if (col) {
      const dir = params.dir === 'desc' ? -1 : 1;
      rows = [...rows].sort((a, b) => {
        const x = col.sort(a);
        const y = col.sort(b);
        return (x < y ? -1 : x > y ? 1 : 0) * dir || a.startMs - b.startMs;
      });
    }
    summary.textContent = `${rows.length.toLocaleString()} of ${m.requests.length.toLocaleString()}`;

    let items = rows;
    if (params.group) {
      const keyFn = { host: (r) => r.host, type: (r) => r.resourceType, code: (r) => (r.flags.failed ? failureKey(r) : 'OK') }[params.group];
      const groups = new Map();
      for (const r of rows) {
        const k = keyFn(r);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(r);
      }
      items = [];
      for (const [key, list] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
        items.push({ group: true, key, count: list.length, failed: list.filter((r) => r.flags.failed).length });
        if (!collapsed.has(key)) items.push(...list);
      }
    }
    list.setItems(items);

    if (params.sel !== lastSel) {
      lastSel = params.sel;
      const idx = items.findIndex((it) => !it.group && `r${it.id}` === params.sel);
      if (idx >= 0) list.scrollToIndex(idx);
    }
  }

  function update(p) {
    params = p;
    if (search.value !== (p.q || '')) search.value = p.q || '';
    statusSel.value = p.status || '';
    if (hostInput.value !== (p.host || '')) hostInput.value = p.host || '';
    firstParty.checked = !!p.fp;
    groupSel.value = p.group || '';
    const types = new Set((p.types || '').split(','));
    for (const chip of typeChips.children) chip.classList.toggle('on', types.has(chip.dataset.type));
    for (const chip of flagChips.children) chip.classList.toggle('on', p.flag === chip.dataset.flag);
    for (const cell of header.children) {
      const active = !!p.sort && p.sort === cell.dataset.col;
      cell.classList.toggle('sorted', active);
      cell.dataset.dir = active ? p.dir || 'asc' : '';
    }

    activeFilters.replaceChildren();
    if (p.code) activeFilters.append(filterChip(`Failure: ${p.code}`, () => ctx.setParams({ code: '' })));
    if (Object.keys(p).some((k) => k !== 'sel' && k !== 'sort' && k !== 'dir' && k !== 'group')) {
      activeFilters.append(
        h('button', {
          class: 'link-btn',
          text: 'Clear filters',
          onclick: () => ctx.navigate('network', { sel: p.sel, group: p.group, sort: p.sort, dir: p.dir }),
        }),
      );
    }
    refresh();
  }

  return { el, update };
}

function filterChip(label, onRemove) {
  return h('span', { class: 'chip on removable' }, label, h('button', { class: 'icon-btn', text: '×', 'aria-label': 'Remove filter', onclick: onRemove }));
}

function statusMatches(r, status) {
  if (!status) return true;
  if (status === 'err') return r.status === 0 || !!r.error;
  const base = Number(status[0]) * 100;
  return r.status >= base && r.status < base + 100;
}

export function statusClass(r) {
  if (r.error || r.status === 0) return 'st-err';
  if (r.status >= 500) return 'st-5xx';
  if (r.status >= 400) return 'st-4xx';
  if (r.status >= 300) return 'st-3xx';
  return 'st-ok';
}

function shortError(err) {
  return err.replace(/^net::ERR_/, '').replace(/^BLOCKED_BY_/, '');
}

function initiatorLabel(r) {
  const i = r.initiator;
  if (!i) return '';
  if (!i.url) return i.type;
  const file = i.url.split(/[?#]/)[0].split('/').pop() || i.url;
  return `${i.type} · ${file}${i.line ? ':' + i.line : ''}`;
}
