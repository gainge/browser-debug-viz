import { h, clear, plural } from './util/dom.js';
import { parseFile } from './parsers/index.js';
import { buildModel } from './model.js';
import * as issuesTab from './ui/issues.js';
import * as networkTab from './ui/network.js';
import * as consoleTab from './ui/console.js';
import * as timelineTab from './ui/timeline.js';
import { DetailPane } from './ui/detail.js';

const TABS = [
  { id: 'issues', label: 'Issues', mod: issuesTab },
  { id: 'network', label: 'Network', mod: networkTab },
  { id: 'console', label: 'Console', mod: consoleTab },
  { id: 'timeline', label: 'Timeline', mod: timelineTab },
];

const state = {
  har: null,
  consoleLog: null,
  files: { har: null, console: null },
  manualOffsetMs: 0,
  model: null,
  views: {},
  route: { tab: 'issues', params: {} },
};

const $ = (sel) => document.querySelector(sel);
const fileInput = $('#file-input');
const tabBar = $('#tabs');
const viewHost = $('#views');
const loadedFiles = $('#loaded-files');
const status = $('#status');
const detail = new DetailPane($('#detail'), ctx());

// ---- routing -------------------------------------------------------------
// The URL hash holds tab + filters + selection so the back button works and an
// analyst can share a view with a colleague who has loaded the same files.

function parseHash() {
  const raw = location.hash.slice(1);
  const [tab, query = ''] = raw.split('?');
  const params = Object.fromEntries(new URLSearchParams(query));
  return { tab: TABS.some((t) => t.id === tab) ? tab : 'issues', params };
}

function buildHash(tab, params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') q.set(k, v);
  const qs = q.toString();
  return `#${tab}${qs ? '?' + qs : ''}`;
}

function navigate(tab, params = {}, { replace = false } = {}) {
  const hash = buildHash(tab, params);
  if (hash === location.hash) return;
  if (replace) {
    history.replaceState(null, '', hash);
    route();
  } else {
    location.hash = hash;
  }
}

function setParams(patch, opts = {}) {
  const params = { ...state.route.params };
  for (const [k, v] of Object.entries(patch)) {
    if (v == null || v === '') delete params[k];
    else params[k] = String(v);
  }
  navigate(state.route.tab, params, { replace: !opts.push });
}

function ctx() {
  return {
    get model() {
      return state.model;
    },
    get params() {
      return state.route.params;
    },
    get tab() {
      return state.route.tab;
    },
    navigate,
    setParams,
    select: (sel) => setParams({ sel }, { push: true }),
    setManualOffset(ms) {
      state.manualOffsetMs = ms;
      rebuild();
    },
  };
}

function route() {
  state.route = parseHash();
  const { tab, params } = state.route;
  for (const btn of tabBar.children) btn.classList.toggle('active', btn.dataset.tab === tab);
  for (const [id, view] of Object.entries(state.views)) view.el.hidden = id !== tab;
  if (state.model) state.views[tab]?.update(params);
  detail.update(params.sel);
}

// ---- loading -------------------------------------------------------------

function parseInWorker(file) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    } catch {
      file.text().then((text) => resolve(parseFile(file.name, text)), reject);
      return;
    }
    worker.onmessage = (e) => {
      worker.terminate();
      e.data.ok ? resolve(e.data.result) : reject(new Error(e.data.error));
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || 'Worker failed'));
    };
    worker.postMessage(file);
  });
}

async function loadFiles(files) {
  if (!files.length) return;
  status.textContent = `Parsing ${plural(files.length, 'file')}…`;
  status.className = 'status busy';
  const errors = [];
  const started = performance.now();
  for (const file of files) {
    try {
      const result = await parseInWorker(file);
      if (result.kind === 'har') {
        state.har = result.data;
        state.files.har = { name: file.name, size: file.size };
      } else {
        state.consoleLog = result.data;
        state.files.console = { name: file.name, size: file.size };
      }
    } catch (err) {
      errors.push(err.message);
    }
  }
  if (errors.length) {
    status.textContent = errors.join(' · ');
    status.className = 'status error';
  } else {
    status.textContent = `Parsed in ${Math.round(performance.now() - started)} ms`;
    status.className = 'status';
  }
  state.manualOffsetMs = 0;
  rebuild();
}

function rebuild() {
  if (!state.har && !state.consoleLog) {
    state.model = null;
    renderShell();
    route();
    return;
  }
  state.model = buildModel({ har: state.har, consoleLog: state.consoleLog, manualOffsetMs: state.manualOffsetMs });
  renderShell();
  route();
}

function renderShell() {
  const m = state.model;
  document.body.classList.toggle('empty', !m);

  clear(loadedFiles);
  for (const kind of ['har', 'console']) {
    const f = state.files[kind];
    if (!f) continue;
    const summary =
      kind === 'har'
        ? plural(state.har.requests.length, 'request')
        : `${plural(state.consoleLog.messages.length, 'message')}${state.consoleLog.hasTimestamps ? '' : ', no timestamps'}`;
    loadedFiles.append(
      h(
        'span',
        { class: 'file-chip', title: f.name },
        h('span', { class: 'file-kind', text: kind === 'har' ? 'HAR' : 'LOG' }),
        h('span', { class: 'file-name', text: f.name }),
        h('span', { class: 'muted', text: summary }),
        h('button', {
          class: 'icon-btn',
          title: 'Unload',
          'aria-label': `Unload ${f.name}`,
          text: '×',
          onclick: () => {
            state.files[kind] = null;
            if (kind === 'har') state.har = null;
            else state.consoleLog = null;
            rebuild();
          },
        }),
      ),
    );
  }
  if (state.har?.sanitizedLikely) {
    loadedFiles.append(
      h('span', {
        class: 'badge warn',
        text: 'Sanitized HAR',
        title:
          'No Cookie / Set-Cookie / Authorization headers found. Chrome strips these by default; ask for "Export HAR (with sensitive data)" if auth or session state is suspected.',
      }),
    );
  }

  const counts = m
    ? {
        network: m.requests.length,
        console: m.messages.length,
        issues: m.issues.list.length,
      }
    : {};
  clear(tabBar);
  for (const t of TABS) {
    tabBar.append(
      h(
        'button',
        {
          class: 'tab',
          role: 'tab',
          dataset: { tab: t.id },
          disabled: !m,
          onclick: () => navigate(t.id, t.id === state.route.tab ? state.route.params : lastParams[t.id] || {}, {}),
        },
        t.label,
        counts[t.id] != null ? h('span', { class: 'count', text: counts[t.id].toLocaleString() }) : null,
      ),
    );
  }

  clear(viewHost);
  state.views = {};
  if (!m) return;
  for (const t of TABS) {
    const view = t.mod.create(ctx());
    view.el.hidden = true;
    state.views[t.id] = view;
    viewHost.append(view.el);
  }
}

// Remember each tab's filters so switching tabs and back does not lose them.
const lastParams = {};
window.addEventListener('hashchange', () => {
  const { tab, params } = parseHash();
  lastParams[tab] = params;
});
window.addEventListener('hashchange', route);

// ---- file input & drag/drop ---------------------------------------------

fileInput.addEventListener('change', () => {
  loadFiles([...fileInput.files]);
  fileInput.value = '';
});

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  dragDepth++;
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    document.body.classList.remove('dragging');
  }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  loadFiles([...(e.dataTransfer?.files || [])]);
});

$('#load-example').addEventListener('click', async () => {
  status.textContent = 'Fetching example…';
  try {
    const files = await Promise.all(
      ['examples/sample.har', 'examples/sample.log'].map(async (path) => {
        const res = await fetch(path);
        if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
        return new File([await res.blob()], path.split('/').pop());
      }),
    );
    await loadFiles(files);
  } catch (err) {
    status.textContent = `Could not load example: ${err.message}`;
    status.className = 'status error';
  }
});

rebuild();
