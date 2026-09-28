import { h, fmtBytes, fmtMs, fmtIso, plural } from '../util/dom.js';

export function create(ctx) {
  const m = ctx.model;
  const el = h('div', { class: 'view issues-view' });

  const failed = m.requests.filter((r) => r.flags.failed).length;
  const blocked = m.requests.filter((r) => r.flags.blocked).length;
  const bytes = m.requests.reduce((s, r) => s + Math.max(r.transferSize || 0, 0), 0);
  const levelCount = (lvl) => m.messages.filter((x) => x.level === lvl).length;

  const tile = (label, value, opts = {}) =>
    h(
      opts.target ? 'button' : 'div',
      {
        class: `tile ${opts.tone || ''}`,
        onclick: opts.target ? () => ctx.navigate(opts.target.tab, opts.target.params, { push: true }) : null,
      },
      h('div', { class: 'tile-value', text: value }),
      h('div', { class: 'tile-label', text: label }),
    );

  const tiles = h('div', { class: 'tiles' });
  if (m.har) {
    tiles.append(
      tile('requests', m.requests.length.toLocaleString(), { target: { tab: 'network', params: {} } }),
      tile('failed', failed.toLocaleString(), { tone: failed ? 'error' : '', target: { tab: 'network', params: { flag: 'failed' } } }),
      tile('blocked', blocked.toLocaleString(), { tone: blocked ? 'warn' : '', target: { tab: 'network', params: { flag: 'blocked' } } }),
      tile('transferred', fmtBytes(bytes)),
      tile('capture span', fmtMs(m.tEnd - m.t0)),
    );
  }
  if (m.consoleLog) {
    const errs = levelCount('error');
    const warns = levelCount('warn');
    tiles.append(
      tile('console messages', m.messages.length.toLocaleString(), { target: { tab: 'console', params: {} } }),
      tile('errors (inferred)', errs.toLocaleString(), { tone: errs ? 'error' : '', target: { tab: 'console', params: { lvl: 'error' } } }),
      tile('warnings (inferred)', warns.toLocaleString(), { tone: warns ? 'warn' : '', target: { tab: 'console', params: { lvl: 'warn' } } }),
    );
  }
  el.append(tiles);

  const cols = h('div', { class: 'issues-cols' });
  el.append(cols);

  const left = h('div', { class: 'issues-col' });
  cols.append(left);
  left.append(h('h2', { text: 'Detected issues' }));
  if (!m.issues.list.length) left.append(h('p', { class: 'muted', text: 'Nothing flagged.' }));
  const list = h('ul', { class: 'issue-list' });
  for (const issue of m.issues.list) {
    list.append(
      h(
        'li',
        {},
        h(
          'button',
          { class: `issue ${issue.severity}`, onclick: () => ctx.navigate(issue.target.tab, issue.target.params, { push: true }) },
          h('span', { class: `sev-dot ${issue.severity}`, 'aria-label': issue.severity }),
          h('span', { class: 'issue-title', text: issue.title }),
          h('span', { class: 'issue-count', text: issue.count.toLocaleString() }),
          h('span', { class: 'issue-detail muted', text: issue.detail }),
        ),
      ),
    );
  }
  left.append(list);

  if (m.issues.topConsole.length) {
    left.append(h('h2', { text: 'Top console errors & warnings' }));
    const cl = h('ul', { class: 'issue-list' });
    for (const g of m.issues.topConsole) {
      const msg = g.first;
      cl.append(
        h(
          'li',
          {},
          h(
            'button',
            {
              class: `issue ${msg.level}`,
              onclick: () => ctx.navigate('console', { sig: String(g.id), sel: `m${msg.id}` }, { push: true }),
            },
            h('span', { class: `sev-dot ${msg.level}` }),
            h('span', { class: 'issue-title mono', text: msg.text.split('\n')[0] }),
            h('span', { class: 'issue-count', text: `×${g.messageIds.length}` }),
            h('span', { class: 'issue-detail muted', text: msg.source ? `${msg.source.file}:${msg.source.line}` : 'browser' }),
          ),
        ),
      );
    }
    left.append(cl);
  }

  const right = h('div', { class: 'issues-col' });
  cols.append(right);

  if (m.pages.length) {
    right.append(h('h2', { text: 'Pages' }));
    for (const p of m.pages) {
      right.append(
        h(
          'div',
          { class: 'page-card' },
          h('div', { class: 'mono ellipsis', text: p.title, title: p.title }),
          h(
            'div',
            { class: 'muted' },
            `Started ${fmtIso(p.startMs)} · DOMContentLoaded ${fmtMs(p.onContentLoad)} · load ${p.onLoad == null ? 'not reached' : fmtMs(p.onLoad)}`,
          ),
        ),
      );
    }
  }

  if (m.hostStats.length) {
    right.append(h('h2', {}, 'Requests by host ', h('span', { class: 'muted small', text: `(${plural(m.hostStats.length, 'host')})` })));
    const max = m.hostStats[0].count;
    const table = h('div', { class: 'host-table' });
    for (const s of m.hostStats.slice(0, 25)) {
      const okPct = ((s.count - s.failed) / max) * 100;
      const failPct = (s.failed / max) * 100;
      table.append(
        h(
          'button',
          { class: 'host-row', onclick: () => ctx.navigate('network', { host: s.host }, { push: true }), title: s.host },
          h('span', { class: 'host-name ellipsis' }, s.host, s.thirdParty ? h('span', { class: 'tag', text: '3p' }) : null),
          h(
            'span',
            { class: 'host-bar' },
            h('span', { class: 'bar ok', style: { width: `${okPct}%` } }),
            h('span', { class: 'bar fail', style: { width: `${failPct}%` } }),
          ),
          h('span', { class: 'num', text: s.count }),
          h('span', { class: 'num muted', text: fmtBytes(s.bytes) }),
        ),
      );
    }
    if (m.hostStats.length > 25) table.append(h('div', { class: 'muted small', text: `…and ${m.hostStats.length - 25} more (see Network → group by host)` }));
    right.append(table);
  }

  if (m.consoleLog && !m.consoleLog.hasTimestamps) {
    right.append(
      h(
        'p',
        { class: 'note' },
        'The console log has no timestamps, so console ↔ network correlation is by URL only. ',
        'Ask for a re-capture with DevTools Console settings → "Show timestamps" enabled to unlock the Timeline.',
      ),
    );
  }

  return { el, update() {} };
}
