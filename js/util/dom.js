// All file-derived content must reach the DOM through text nodes, never innerHTML:
// the inputs are arbitrary customer captures and may contain markup.
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key === 'style') Object.assign(el.style, value);
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else if (key in el && typeof value !== 'string') el[key] = value;
      else el.setAttribute(key, value === true ? '' : value);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children) {
    if (child == null || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

export function fmtBytes(n) {
  if (n == null || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function fmtMs(ms) {
  if (ms == null || ms < 0 || Number.isNaN(ms)) return '—';
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function fmtRel(ms) {
  if (ms == null || Number.isNaN(ms)) return '';
  const sign = ms < 0 ? '−' : '+';
  return `${sign}${(Math.abs(ms) / 1000).toFixed(3)}s`;
}

export function fmtIso(epochMs) {
  if (epochMs == null || Number.isNaN(epochMs)) return '—';
  return new Date(epochMs).toISOString().replace('T', ' ').replace('Z', ' UTC');
}

export function plural(n, word) {
  return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
}

// Treats /pattern/flags as a regex so analysts can do precise searches; anything
// else is a case-insensitive substring match.
export function makeMatcher(query) {
  if (!query) return null;
  const m = /^\/(.+)\/([a-z]*)$/.exec(query);
  if (m) {
    try {
      const re = new RegExp(m[1], m[2].includes('i') ? m[2] : m[2] + 'i');
      return (s) => re.test(s);
    } catch {
      return () => false;
    }
  }
  const q = query.toLowerCase();
  return (s) => s.toLowerCase().includes(q);
}
