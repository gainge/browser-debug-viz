import { h, fmtRel, makeMatcher } from '../util/dom.js';
import { VirtualList } from './virtual-list.js';

const LEVELS = ['error', 'warn', 'info'];

export function create(ctx) {
  const m = ctx.model;
  let params = {};
  let lastSel = null;

  if (!m.consoleLog) {
    return {
      el: h('div', { class: 'view empty-view' }, h('p', { class: 'muted', text: 'No console log loaded. Drop a .log from DevTools Console → Save as… to populate this view.' })),
      update() {},
    };
  }

  const search = h('input', {
    type: 'search',
    class: 'search',
    placeholder: 'Filter text (text or /regex/)',
    oninput: () => ctx.setParams({ q: search.value }),
  });
  const levelBoxes = LEVELS.map((lvl) => {
    const n = m.messages.filter((x) => x.level === lvl).length;
    const box = h('input', { type: 'checkbox', value: lvl, onchange: () => ctx.setParams({ lvl: selectedLevels().join(',') }) });
    return h('label', { class: `check lvl-${lvl}` }, box, `${lvl} `, h('span', { class: 'count', text: n }));
  });
  const selectedLevels = () => levelBoxes.map((l) => l.firstChild).filter((b) => b.checked).map((b) => b.value);
  const srcSel = h(
    'select',
    { class: 'src-select', onchange: () => ctx.setParams({ src: srcSel.value }) },
    h('option', { value: '', text: 'All sources' }),
    m.sources.map((s) => h('option', { value: s.key, text: `${s.key} (${s.count})` })),
  );
  const dedup = h('input', { type: 'checkbox', onchange: () => ctx.setParams({ dedup: dedup.checked ? '' : '0' }) });
  const catChips = h(
    'div',
    { class: 'chips' },
    m.categories.map((c) =>
      h(
        'button',
        { class: 'chip', dataset: { cat: c.key }, onclick: () => ctx.setParams({ cat: params.cat === c.key ? '' : c.key }) },
        c.key,
        h('span', { class: 'count', text: c.count }),
      ),
    ),
  );
  const linkedOnly = h('input', { type: 'checkbox', onchange: () => ctx.setParams({ linked: linkedOnly.checked ? '1' : '' }) });
  const activeFilters = h('div', { class: 'active-filters' });
  const summary = h('span', { class: 'muted small' });

  const list = new VirtualList({ rowHeight: 26, renderRow });
  list.el.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const idx = list.items.findIndex((it) => isSelected(it));
    const next = list.items[idx + (e.key === 'ArrowDown' ? 1 : -1)];
    if (next) ctx.setParams({ sel: `m${repr(next).id}` });
  });

  const el = h(
    'div',
    { class: 'view console-view' },
    h(
      'div',
      { class: 'toolbar' },
      search,
      levelBoxes,
      srcSel,
      h('label', { class: 'check', title: 'Fold messages that differ only in numbers, ids or URLs' }, dedup, 'Collapse duplicates'),
      h('label', { class: 'check', title: 'Only messages that reference a request in the HAR' }, linkedOnly, 'Linked to HAR'),
      summary,
    ),
    h('div', { class: 'toolbar secondary' }, catChips, activeFilters),
    h('div', { class: 'note small' }, 'Levels are inferred: Chrome\'s "Save as…" export does not record them.'),
    h('div', { class: 'table' }, list.el),
  );

  const repr = (item) => (item.messageIds ? item.first : item);
  const isSelected = (item) => {
    const sel = params.sel;
    if (!sel?.startsWith('m')) return false;
    const msg = m.messages[Number(sel.slice(1))];
    return item.messageIds ? msg?.groupId === item.id : msg?.id === item.id;
  };

  function renderRow(item) {
    const msg = repr(item);
    const count = item.messageIds ? item.messageIds.length : 1;
    const firstLine = msg.text.split('\n')[0];
    return h(
      'div',
      {
        class: `con-row lvl-${msg.level} ${isSelected(item) ? 'selected' : ''}`,
        onclick: () => ctx.setParams({ sel: `m${msg.id}` }),
        title: msg.text,
      },
      h('span', { class: `sev-dot ${msg.level}` }),
      h('span', { class: 'con-count' }, count > 1 ? h('span', { class: 'badge', text: `×${count}` }) : null),
      h('span', { class: 'con-time mono muted', text: timeLabel(msg) }),
      h('span', { class: 'con-src ellipsis muted', text: msg.source ? `${msg.source.file}:${msg.source.line}` : 'browser' }),
      h('span', { class: 'con-text ellipsis mono', text: firstLine }),
      h(
        'span',
        { class: 'con-meta' },
        msg.relatedRequestIds.length ? h('span', { class: 'tag link', text: `⇄ ${msg.relatedRequestIds.length}`, title: 'Linked HAR requests' }) : null,
        msg.stack.length ? h('span', { class: 'tag', text: 'stack', title: `${msg.stack.filter((f) => f.fn).length} frames` }) : null,
      ),
    );
  }

  function timeLabel(msg) {
    if (msg.absMs != null) return fmtRel(msg.absMs - m.t0);
    if (msg.time) return msg.time.raw;
    return `L${msg.lineNo}`;
  }

  function filtered() {
    const match = makeMatcher(params.q);
    const levels = params.lvl ? new Set(params.lvl.split(',')) : null;
    const test = (msg) =>
      (!match || match(msg.text) || (msg.source && match(msg.source.file))) &&
      (!levels || levels.has(msg.level)) &&
      (!params.cat || msg.category === params.cat) &&
      (!params.src || (msg.source ? msg.source.file : '(browser)') === params.src) &&
      (!params.linked || msg.relatedRequestIds.length > 0) &&
      (params.sig == null || msg.groupId === Number(params.sig));
    const messages = m.messages.filter(test);
    if (params.dedup === '0') return { items: messages, count: messages.length };
    const seen = new Map();
    for (const msg of messages) {
      const g = m.groups[msg.groupId];
      if (!seen.has(g.id)) seen.set(g.id, { ...g, messageIds: [] });
      seen.get(g.id).messageIds.push(msg.id);
    }
    return { items: [...seen.values()], count: messages.length };
  }

  function update(p) {
    params = p;
    if (search.value !== (p.q || '')) search.value = p.q || '';
    const levels = new Set((p.lvl || LEVELS.join(',')).split(','));
    for (const l of levelBoxes) l.firstChild.checked = levels.has(l.firstChild.value);
    srcSel.value = p.src || '';
    dedup.checked = p.dedup !== '0';
    linkedOnly.checked = !!p.linked;
    for (const chip of catChips.children) chip.classList.toggle('on', p.cat === chip.dataset.cat);

    activeFilters.replaceChildren();
    if (p.sig != null) {
      const g = m.groups[Number(p.sig)];
      activeFilters.append(
        h(
          'span',
          { class: 'chip on removable' },
          `Same as: ${g ? g.first.text.slice(0, 50) : p.sig}`,
          h('button', { class: 'icon-btn', text: '×', 'aria-label': 'Remove filter', onclick: () => ctx.setParams({ sig: '' }) }),
        ),
      );
    }
    if (Object.keys(p).some((k) => !['sel', 'dedup'].includes(k))) {
      activeFilters.append(h('button', { class: 'link-btn', text: 'Clear filters', onclick: () => ctx.navigate('console', { sel: p.sel, dedup: p.dedup }) }));
    }

    const { items, count } = filtered();
    summary.textContent = `${count.toLocaleString()} of ${m.messages.length.toLocaleString()} messages${items.length !== count ? ` · ${items.length} unique` : ''}`;
    list.setItems(items);
    if (p.sel !== lastSel) {
      lastSel = p.sel;
      const idx = items.findIndex(isSelected);
      if (idx >= 0) list.scrollToIndex(idx);
    }
  }

  return { el, update };
}
