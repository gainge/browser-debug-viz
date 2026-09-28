import { h, clear, fmtBytes, fmtMs, fmtRel, fmtIso } from '../util/dom.js';
import { statusClass } from './network.js';

const TEXT_LIMIT = 200_000;

export class DetailPane {
  constructor(el, ctx) {
    this.el = el;
    this.ctx = ctx;
    this.requestTab = 'headers';
    this.current = null;
    this.installResizer();
  }

  update(sel) {
    const m = this.ctx.model;
    if (!sel || !m) {
      this.current = null;
      this.el.hidden = true;
      return;
    }
    // Re-rendering on unrelated hash changes would reset scroll and collapse state.
    const key = `${sel}|${this.ctx.tab}|${m.t0}`;
    if (key === this.current) return;
    this.current = key;
    this.el.hidden = false;
    clear(this.el);
    this.el.append(this.resizer);
    const id = Number(sel.slice(1));
    if (sel[0] === 'r' && m.requests[id]) this.renderRequest(m.requests[id]);
    else if (sel[0] === 'm' && m.messages[id]) this.renderMessage(m.messages[id]);
    else this.el.hidden = true;
  }

  installResizer() {
    this.resizer = h('div', { class: 'detail-resizer', title: 'Drag to resize' });
    this.resizer.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.resizer.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const width = Math.min(Math.max(window.innerWidth - ev.clientX, 320), window.innerWidth - 300);
        document.documentElement.style.setProperty('--detail-width', `${width}px`);
      };
      const up = () => {
        this.resizer.removeEventListener('pointermove', move);
        this.resizer.removeEventListener('pointerup', up);
      };
      this.resizer.addEventListener('pointermove', move);
      this.resizer.addEventListener('pointerup', up);
    });
  }

  header(titleNodes, jump) {
    return h(
      'div',
      { class: 'detail-head' },
      h('div', { class: 'detail-title' }, titleNodes),
      jump && this.ctx.tab !== jump.tab
        ? h('button', { class: 'link-btn', text: `Show in ${jump.label}`, onclick: () => this.ctx.navigate(jump.tab, { sel: jump.sel }) })
        : null,
      h('button', { class: 'icon-btn close', text: '×', 'aria-label': 'Close details', onclick: () => this.ctx.setParams({ sel: '' }, { push: true }) }),
    );
  }

  // ---- request ------------------------------------------------------------

  renderRequest(r) {
    const m = this.ctx.model;
    this.el.append(
      this.header(
        [
          h('span', { class: `status-pill ${statusClass(r)}`, text: r.error || r.status || '—' }),
          h('span', { class: 'mono', text: r.method }),
          h('span', { class: 'mono ellipsis', text: r.url, title: r.url }),
        ],
        { tab: 'network', label: 'Network', sel: `r${r.id}` },
      ),
    );

    const tabs = [
      ['headers', 'Headers'],
      (r.queryString.length || r.postData) && ['payload', 'Payload'],
      ['response', 'Response'],
      ['timing', 'Timing'],
      ['initiator', 'Initiator'],
      r.wsMessages && ['ws', `Messages (${r.wsMessages.length})`],
      r.relatedMessageIds.length && ['console', `Console (${r.relatedMessageIds.length})`],
    ].filter(Boolean);
    if (!tabs.some(([id]) => id === this.requestTab)) this.requestTab = 'headers';

    const body = h('div', { class: 'detail-body' });
    const bar = h(
      'div',
      { class: 'subtabs' },
      tabs.map(([id, label]) =>
        h('button', {
          class: `subtab ${id === this.requestTab ? 'active' : ''}`,
          text: label,
          onclick: (e) => {
            this.requestTab = id;
            for (const b of bar.children) b.classList.toggle('active', b === e.currentTarget);
            show();
          },
        }),
      ),
    );
    const show = () => {
      clear(body);
      body.scrollTop = 0;
      const render = {
        headers: () => this.requestHeaders(r),
        payload: () => this.requestPayload(r),
        response: () => this.responseBody(r),
        timing: () => this.timing(r),
        initiator: () => this.initiator(r),
        ws: () => this.wsFrames(r),
        console: () => this.messageLinks(r.relatedMessageIds.map((id) => m.messages[id])),
      }[this.requestTab];
      body.append(render());
    };
    this.el.append(bar, body);
    show();
  }

  requestHeaders(r) {
    const m = this.ctx.model;
    const general = [
      ['URL', r.url],
      ['Method', r.method],
      ['Status', `${r.status} ${r.statusText}`.trim()],
      r.error && ['Error', r.error],
      ['Type', `${r.resourceType}${r.mimeType ? ' · ' + r.mimeType : ''}`],
      ['Started', `${fmtIso(r.startMs)} (${fmtRel(r.startMs - m.t0)})`],
      ['Duration', fmtMs(r.durationMs)],
      ['Transferred', `${fmtBytes(r.transferSize)} (content ${fmtBytes(r.contentSize)})`],
      r.fromCache && ['Cache', r.fromCache],
      r.fetchedViaServiceWorker && ['Service worker', 'yes'],
      ['Remote address', r.serverIp || '—'],
      ['Protocol', r.httpVersion || '—'],
      r.priority && ['Priority', r.priority],
      r.connectionId && ['Connection', r.connectionId],
      r.redirectURL && ['Redirects to', r.redirectURL],
    ].filter(Boolean);
    const frag = h('div', {}, section('General', kvTable(general)));
    const redirects = this.redirectChain(r);
    if (redirects) frag.append(section('Redirect chain', redirects));
    frag.append(section(`Response headers (${r.resHeaders.length})`, kvTable(r.resHeaders.map((x) => [x.name, x.value]))));
    frag.append(section(`Request headers (${r.reqHeaders.length})`, kvTable(r.reqHeaders.map((x) => [x.name, x.value]))));
    return frag;
  }

  redirectChain(r) {
    const reqs = this.ctx.model.requests;
    if (r.redirectFrom == null && r.redirectTo == null) return null;
    let start = r;
    for (let n = 0; start.redirectFrom != null && n < 50; n++) start = reqs[start.redirectFrom];
    const ol = h('ol', { class: 'chain' });
    for (let cur = start, n = 0; cur && n < 50; cur = cur.redirectTo != null ? reqs[cur.redirectTo] : null, n++) {
      ol.append(
        h(
          'li',
          { class: cur === r ? 'current' : '' },
          h('span', { class: `status-pill ${statusClass(cur)}`, text: cur.status || cur.error || '—' }),
          this.requestLink(cur),
        ),
      );
    }
    return ol;
  }

  requestPayload(r) {
    const frag = h('div');
    if (r.queryString.length) frag.append(section('Query string', kvTable(r.queryString.map((q) => [q.name, safeDecode(q.value)]))));
    if (r.postData) {
      const pd = r.postData;
      const title = `Request body${pd.mimeType ? ' · ' + pd.mimeType : ''}`;
      if (pd.params?.length) frag.append(section(title, kvTable(pd.params.map((p) => [p.name, p.value ?? p.fileName ?? '']))));
      else if (pd.text != null) {
        if (/x-www-form-urlencoded/.test(pd.mimeType || '')) {
          frag.append(section(title, kvTable([...new URLSearchParams(pd.text)])));
        } else {
          frag.append(section(title, textView(pd.text, pd.mimeType)));
        }
      }
    }
    return frag;
  }

  responseBody(r) {
    const mime = r.mimeType || '';
    if (!r.body || r.body.text === '') {
      const why = r.fromCache ? 'Served from cache.' : r.flags.failed ? 'Request failed.' : 'Chrome did not include the body in the export.';
      return h('p', { class: 'muted', text: `No response body. ${why}` });
    }
    const { text, encoding } = r.body;
    if (mime.startsWith('image/')) {
      const src =
        encoding === 'base64'
          ? `data:${mime};base64,${text}`
          : mime.includes('svg')
            ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`
            : null;
      if (src) {
        return h(
          'div',
          { class: 'image-preview' },
          h('img', { src, alt: 'Response image', onload: (e) => (e.target.nextSibling.textContent = `${e.target.naturalWidth} × ${e.target.naturalHeight} · ${fmtBytes(r.contentSize)}`) }),
          h('div', { class: 'muted small' }),
        );
      }
    }
    if (encoding === 'base64') {
      let decoded = null;
      if (/json|text|javascript|xml|html|css/.test(mime)) {
        try {
          decoded = new TextDecoder().decode(Uint8Array.from(atob(text), (c) => c.charCodeAt(0)));
        } catch {}
      }
      if (decoded == null) return h('p', { class: 'muted', text: `Binary body (${mime || 'unknown type'}, ${fmtBytes(r.contentSize)}).` });
      return textView(decoded, mime);
    }
    return textView(text, mime);
  }

  timing(r) {
    const t = r.timings;
    const connectOnly = t.connect != null ? Math.max(t.connect - (t.ssl || 0), 0) : null;
    const phases = [
      ['Queueing / blocked', t.blocked, 'blocked'],
      ['DNS lookup', t.dns, 'dns'],
      ['Initial connection', connectOnly, 'connect'],
      ['SSL', t.ssl, 'ssl'],
      ['Request sent', t.send, 'send'],
      ['Waiting (TTFB)', t.wait, 'wait'],
      ['Content download', t.receive, 'receive'],
    ];
    const total = Math.max(r.durationMs, phases.reduce((s, p) => s + (p[1] || 0), 0), 1);
    let offset = 0;
    const rows = h('div', { class: 'timing' });
    for (const [label, ms, cls] of phases) {
      if (ms == null) continue;
      rows.append(
        h(
          'div',
          { class: 'timing-row' },
          h('span', { class: 'timing-label', text: label }),
          h('span', { class: 'timing-track' }, h('span', { class: `timing-bar ph-${cls}`, style: { left: `${(offset / total) * 100}%`, width: `${Math.max((ms / total) * 100, 0.3)}%` } })),
          h('span', { class: 'num', text: fmtMs(ms) }),
        ),
      );
      offset += ms;
    }
    const frag = h('div', {}, rows, h('div', { class: 'timing-total' }, 'Total ', h('strong', { text: fmtMs(r.durationMs) })));
    if (!rows.children.length) frag.prepend(h('p', { class: 'muted', text: 'No phase timings recorded.' }));
    if (t.wait != null && t.wait > 1000) frag.append(h('p', { class: 'note', text: 'Long TTFB: the server (or a proxy) took over a second to start responding.' }));
    if (t.blocked != null && t.blocked > 500) frag.append(h('p', { class: 'note', text: 'Long queueing: the browser held this request (connection limits, lower priority, or a busy main thread).' }));
    return frag;
  }

  initiator(r) {
    const i = r.initiator;
    if (!i) return h('p', { class: 'muted', text: 'No initiator recorded.' });
    const reqs = this.ctx.model.requests;
    const src = i.url ? reqs.find((x) => x.url === i.url) : null;
    const frag = h(
      'div',
      {},
      kvTable([
        ['Type', i.type],
        ['URL', i.url ? `${i.url}${i.line ? ':' + i.line : ''}` : '—'],
      ]),
    );
    if (src) frag.append(h('p', {}, 'Initiated by: ', this.requestLink(src)));
    if (r.redirectFrom != null) frag.append(h('p', {}, 'Redirected from: ', this.requestLink(reqs[r.redirectFrom])));
    if (i.stack) frag.append(section('Call stack', stackView(i.stack)));
    return frag;
  }

  wsFrames(r) {
    const table = h('table', { class: 'kv ws' }, h('tr', {}, h('th', { text: 'Dir' }), h('th', { text: 'Time' }), h('th', { text: 'Data' })));
    const first = r.wsMessages[0]?.time;
    for (const f of r.wsMessages.slice(0, 2000)) {
      table.append(
        h(
          'tr',
          { class: f.type },
          h('td', { text: f.type === 'send' ? '↑' : '↓', title: f.type }),
          h('td', { class: 'num', text: first != null ? `+${(f.time - first).toFixed(3)}s` : '' }),
          h('td', { class: 'mono wrap', text: f.opcode === 2 ? `(binary ${f.data.length} chars)` : truncate(f.data, 2000) }),
        ),
      );
    }
    return table;
  }

  requestLink(r) {
    return h('button', {
      class: 'link-btn mono ellipsis',
      title: r.url,
      text: `${r.method} ${r.url}`,
      onclick: () => this.ctx.setParams({ sel: `r${r.id}` }, { push: true }),
    });
  }

  // ---- console message ------------------------------------------------------

  renderMessage(msg) {
    const m = this.ctx.model;
    this.el.append(
      this.header(
        [h('span', { class: `sev-dot ${msg.level}` }), h('span', { text: `${msg.level} (inferred) · ${msg.category}` })],
        { tab: 'console', label: 'Console', sel: `m${msg.id}` },
      ),
    );
    const body = h('div', { class: 'detail-body' });
    this.el.append(body);

    body.append(h('pre', { class: 'message-text', text: msg.text }));
    const meta = [
      ['Source', msg.source ? `${msg.source.file}:${msg.source.line}` : '(browser-generated)'],
      ['Log file line', String(msg.lineNo)],
      msg.time && ['Timestamp', msg.time.raw + (msg.absMs != null ? ` → ${fmtIso(msg.absMs)} (${fmtRel(msg.absMs - m.t0)})` : '')],
    ].filter(Boolean);
    body.append(kvTable(meta));

    if (msg.network) {
      body.append(
        h('p', { class: 'note' }, `Network failure logged by Chrome: ${msg.network.method} ${msg.network.status ?? ''} ${msg.network.statusText ?? ''} ${msg.network.error ?? ''}`),
      );
    }

    const related = msg.relatedRequestIds.map((id) => m.requests[id]);
    if (related.length) {
      const ul = h('ul', { class: 'link-list' });
      for (const r of related) ul.append(h('li', {}, h('span', { class: `status-pill ${statusClass(r)}`, text: r.error || r.status || '—' }), this.requestLink(r)));
      body.append(section(`Related requests (${related.length})`, ul));
    } else if (msg.urls.length && m.har) {
      body.append(h('p', { class: 'muted small', text: 'References URLs not present in the loaded HAR (captures may be from different sessions).' }));
    }

    if (msg.stack.length) body.append(section('Stack trace', stackView(msg.stack)));

    const group = m.groups[msg.groupId];
    if (group && group.messageIds.length > 1) {
      body.append(
        section(
          `Occurrences (${group.messageIds.length})`,
          h(
            'div',
            {},
            h('button', {
              class: 'link-btn',
              text: 'Show all in Console',
              onclick: () => this.ctx.navigate('console', { sig: String(group.id), dedup: '0', sel: `m${msg.id}` }),
            }),
            this.messageLinks(group.messageIds.map((id) => m.messages[id]), msg.id),
          ),
        ),
      );
    }
  }

  messageLinks(messages, currentId) {
    const m = this.ctx.model;
    const ul = h('ul', { class: 'link-list' });
    for (const msg of messages.slice(0, 500)) {
      const when = msg.absMs != null ? fmtRel(msg.absMs - m.t0) : `line ${msg.lineNo}`;
      ul.append(
        h(
          'li',
          { class: msg.id === currentId ? 'current' : '' },
          h('span', { class: `sev-dot ${msg.level}` }),
          h('span', { class: 'muted mono small', text: when }),
          h('button', {
            class: 'link-btn ellipsis',
            text: msg.text.split('\n')[0],
            title: msg.text,
            onclick: () => this.ctx.setParams({ sel: `m${msg.id}` }, { push: true }),
          }),
        ),
      );
    }
    return ul;
  }
}

// ---- shared renderers -------------------------------------------------------

function section(title, content) {
  return h('details', { class: 'section', open: true }, h('summary', { text: title }), content);
}

function kvTable(rows) {
  if (!rows.length) return h('p', { class: 'muted small', text: 'None' });
  return h(
    'table',
    { class: 'kv' },
    rows.map(([k, v]) => h('tr', {}, h('th', { text: k }), h('td', { class: 'mono wrap', text: v }))),
  );
}

function stackView(stack) {
  const ol = h('ol', { class: 'stack' });
  for (const f of stack) {
    if (f.async) ol.append(h('li', { class: 'async', text: f.async }));
    else ol.append(h('li', {}, h('span', { class: 'fn', text: f.fn }), ' @ ', h('span', { class: 'loc muted', text: `${f.file}${f.line ? ':' + f.line : ''}` })));
  }
  return ol;
}

function textView(text, mime = '') {
  const trimmed = text.trimStart();
  const jsonLike = /json/.test(mime) || /^[{[]/.test(trimmed);
  if (jsonLike && text.length < 5_000_000) {
    try {
      const value = JSON.parse(text);
      return jsonView(value, text);
    } catch {}
  }
  return rawText(text);
}

function rawText(text) {
  const pre = h('pre', { class: 'body-text', text: truncate(text, TEXT_LIMIT) });
  if (text.length <= TEXT_LIMIT) return pre;
  return h(
    'div',
    {},
    h('p', { class: 'muted small' }, `Showing first ${fmtBytes(TEXT_LIMIT)} of ${fmtBytes(text.length)}. `, h('button', { class: 'link-btn', text: 'Show all', onclick: () => (pre.textContent = text) })),
    pre,
  );
}

function jsonView(value, raw) {
  const container = h('div', { class: 'json-view' });
  const tree = h('div', { class: 'json-tree' }, jsonNode(null, value, 2));
  let showingRaw = false;
  const toggle = h('button', {
    class: 'link-btn',
    text: 'View raw',
    onclick: () => {
      showingRaw = !showingRaw;
      toggle.textContent = showingRaw ? 'View tree' : 'View raw';
      container.replaceChild(showingRaw ? rawText(JSON.stringify(value, null, 2)) : tree, container.lastChild);
    },
  });
  container.append(h('div', { class: 'json-toolbar muted small' }, `JSON · ${fmtBytes(raw.length)} `, toggle), tree);
  return container;
}

// Children are built on first expand so multi-MB JSON bodies open instantly.
function jsonNode(key, value, openDepth = 0) {
  const keyEl = key != null ? h('span', { class: 'j-key', text: `${key}: ` }) : null;
  if (value === null || typeof value !== 'object') {
    return h('div', { class: 'j-leaf' }, keyEl, h('span', { class: `j-${value === null ? 'null' : typeof value}`, text: JSON.stringify(value) }));
  }
  const entries = Array.isArray(value) ? value.map((v, i) => [i, v]) : Object.entries(value);
  const label = Array.isArray(value) ? `Array(${entries.length})` : `{${entries.length}}`;
  const details = h('details', { class: 'j-node' }, h('summary', {}, keyEl, h('span', { class: 'muted', text: label })));
  let built = false;
  const build = () => {
    if (built) return;
    built = true;
    const kids = h('div', { class: 'j-children' });
    for (const [k, v] of entries.slice(0, 1000)) kids.append(jsonNode(k, v, openDepth - 1));
    if (entries.length > 1000) kids.append(h('div', { class: 'muted small', text: `…${entries.length - 1000} more` }));
    details.append(kids);
  };
  details.addEventListener('toggle', () => details.open && build());
  if (openDepth > 0 && entries.length <= 200) {
    details.open = true;
    build();
  }
  return details;
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}
