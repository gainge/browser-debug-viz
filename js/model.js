// Derived, cross-source view of the loaded captures. Everything here is pure so
// it can be unit tested in Node and recomputed cheaply when inputs change.

import { splitUrl } from './parsers/har.js';

export const SLOW_MS = 2000;
export const LARGE_BYTES = 1024 * 1024;
const DAY_MS = 24 * 3600 * 1000;

export function buildModel({ har, consoleLog, manualOffsetMs = 0 }) {
  const requests = har ? har.requests : [];
  const messages = consoleLog ? consoleLog.messages : [];
  const pages = har ? har.pages : [];

  const pageHost = pages.length ? splitUrl(pages[0].title).host : mostCommonDocumentHost(requests);
  const siteKey = registrableDomain(pageHost);
  for (const r of requests) {
    r.thirdParty = !!siteKey && registrableDomain(r.host) !== siteKey;
    r.flags.slow = r.durationMs >= SLOW_MS;
    r.flags.large = Math.max(r.transferSize || 0, r.contentSize || 0) >= LARGE_BYTES;
    r.relatedMessageIds = [];
    r.redirectFrom = null;
    r.redirectTo = null;
  }
  linkRedirects(requests);
  linkConsoleToRequests(messages, requests);

  const timeAlign = consoleLog?.hasTimestamps ? alignTimes(messages, requests, manualOffsetMs) : null;

  const groups = groupMessages(messages);
  let t0 = Infinity;
  let tEnd = -Infinity;
  for (const r of requests) {
    if (!Number.isFinite(r.startMs)) continue;
    t0 = Math.min(t0, r.startMs);
    tEnd = Math.max(tEnd, r.startMs + r.durationMs);
  }
  for (const m of messages) {
    if (m.absMs == null) continue;
    t0 = Math.min(t0, m.absMs);
    tEnd = Math.max(tEnd, m.absMs);
  }
  if (!Number.isFinite(t0)) t0 = tEnd = 0;

  return {
    har,
    consoleLog,
    requests,
    messages,
    groups,
    pages,
    pageHost,
    t0,
    tEnd,
    timeAlign,
    issues: detectIssues(requests, messages, groups),
    hostStats: hostStats(requests),
    types: countBy(requests, (r) => r.resourceType),
    categories: countBy(messages, (m) => m.category),
    sources: countBy(messages, (m) => (m.source ? m.source.file : '(browser)')),
  };
}

// Naive eTLD+1: good enough to separate first/third party for triage without
// shipping the public suffix list. Multi-part suffixes like co.uk are handled
// only for the common cases.
export function registrableDomain(host) {
  if (!host) return '';
  const name = host.replace(/:\d+$/, '');
  if (/^[\d.]+$/.test(name) || name.includes(':')) return name;
  const parts = name.split('.');
  const twoPart = /^(co|com|net|org|gov|ac|edu)\.[a-z]{2}$/.test(parts.slice(-2).join('.'));
  return parts.slice(twoPart ? -3 : -2).join('.');
}

function mostCommonDocumentHost(requests) {
  const docs = requests.filter((r) => r.resourceType === 'document');
  const counts = countBy(docs.length ? docs : requests, (r) => r.host);
  return counts[0]?.key || '';
}

function linkRedirects(requests) {
  const byUrl = new Map();
  for (const r of requests) push(byUrl, r.url, r);
  for (const r of requests) {
    if (!r.flags.redirect || !r.redirectURL) continue;
    let target;
    try {
      target = new URL(r.redirectURL, r.url).href;
    } catch {
      continue;
    }
    const next = (byUrl.get(target) || []).find((n) => n.startMs >= r.startMs && !n.redirectFrom);
    if (next) {
      r.redirectTo = next.id;
      next.redirectFrom = r.id;
    }
  }
}

// Console exports rarely carry timestamps, so URLs are the only dependable link
// between a console message and the request it describes.
function linkConsoleToRequests(messages, requests) {
  const byUrl = new Map();
  const byHostPath = new Map();
  for (const r of requests) {
    push(byUrl, r.url, r);
    push(byHostPath, hostPathKey(r.url), r);
  }
  for (const m of messages) {
    const ids = new Set();
    const urls = m.network ? [m.network.url, ...m.urls] : m.urls;
    for (const u of urls) {
      const hits = byUrl.get(u) || byHostPath.get(hostPathKey(u)) || [];
      const matching = m.network ? hits.filter((r) => r.method === m.network.method) : hits;
      for (const r of matching.length ? matching : hits) ids.add(r.id);
    }
    m.relatedRequestIds = [...ids];
    for (const id of ids) requests[id].relatedMessageIds.push(m.id);
  }
}

function hostPathKey(url) {
  try {
    const u = new URL(url);
    return u.host + u.pathname;
  } catch {
    return url;
  }
}

// The console records local wall-clock time (and usually no date); the HAR
// records UTC. We pick the UTC offset under which console network-error lines
// best coincide with their matching requests, falling back to the analyst's own
// timezone when there is nothing to match.
export function alignTimes(messages, requests, manualOffsetMs = 0) {
  const stamped = messages.filter((m) => m.time);
  const anchor = requests.length ? requests[0].startMs : Date.now();
  const localOffsetMin = -new Date(anchor).getTimezoneOffset();

  const pairs = [];
  for (const m of stamped) {
    if (!m.network) continue;
    for (const id of m.relatedRequestIds || []) pairs.push([m.time.msOfDay, requests[id]]);
  }

  let offsetMin = localOffsetMin;
  let matched = 0;
  let method = 'browser timezone';
  if (pairs.length) {
    let best = { score: -1, dist: Infinity, offset: localOffsetMin };
    for (let o = -14 * 60; o <= 14 * 60; o += 15) {
      let score = 0;
      for (const [tod, r] of pairs) {
        const reqTod = mod(r.startMs + o * 60000, DAY_MS);
        const reqEnd = reqTod + r.durationMs;
        // Chrome logs failures when the response arrives, so allow the whole request span plus slack.
        if (circularWithin(tod, reqTod - 1000, reqEnd + 5000)) score++;
      }
      const dist = Math.abs(o - localOffsetMin);
      if (score > best.score || (score === best.score && dist < best.dist)) best = { score, dist, offset: o };
    }
    if (best.score > 0) {
      offsetMin = best.offset;
      matched = best.score;
      method = `matched ${best.score}/${pairs.length} network lines`;
    }
  }

  const offsetMs = offsetMin * 60000;
  let prevAbs = null;
  for (const m of messages) {
    if (!m.time) {
      m.absMs = null;
      continue;
    }
    let abs;
    if (m.time.date) {
      const { y, m: mo, d } = m.time.date;
      abs = Date.UTC(y, mo - 1, d) + m.time.msOfDay - offsetMs;
    } else if (prevAbs != null) {
      // Continue from the previous message so captures spanning midnight stay monotonic.
      const localDayStart = prevAbs + offsetMs - mod(prevAbs + offsetMs, DAY_MS);
      abs = localDayStart + m.time.msOfDay - offsetMs;
      if (abs < prevAbs - DAY_MS / 2) abs += DAY_MS;
    } else {
      const localDayStart = anchor + offsetMs - mod(anchor + offsetMs, DAY_MS);
      abs = localDayStart + m.time.msOfDay - offsetMs;
      if (abs - anchor > DAY_MS / 2) abs -= DAY_MS;
      else if (anchor - abs > DAY_MS / 2) abs += DAY_MS;
    }
    prevAbs = abs;
    m.absMs = abs + manualOffsetMs;
  }

  return { offsetMin, matched, pairs: pairs.length, method, manualOffsetMs };
}

function circularWithin(t, lo, hi) {
  if (hi - lo >= DAY_MS) return true;
  const a = mod(lo, DAY_MS);
  const b = mod(hi, DAY_MS);
  return a <= b ? t >= a && t <= b : t >= a || t <= b;
}

function mod(n, m) {
  return ((n % m) + m) % m;
}

export function groupMessages(messages) {
  const bySig = new Map();
  for (const m of messages) {
    let g = bySig.get(m.signature);
    if (!g) {
      g = { id: bySig.size, signature: m.signature, first: m, messageIds: [] };
      bySig.set(m.signature, g);
    }
    g.messageIds.push(m.id);
    m.groupId = g.id;
  }
  return [...bySig.values()];
}

const LEVEL_RANK = { error: 0, warn: 1, info: 2 };

// Each issue carries a navigation target so the summary is an index into the
// filtered Network/Console views rather than a dead-end report.
function detectIssues(requests, messages, groups) {
  const issues = [];
  const failures = new Map();
  for (const r of requests) {
    if (!r.flags.failed) continue;
    const key = failureKey(r);
    if (!failures.has(key)) failures.set(key, []);
    failures.get(key).push(r);
  }
  for (const [key, list] of failures) {
    const aborted = /ERR_ABORTED|^No response/.test(key);
    issues.push({
      severity: aborted ? 'warn' : 'error',
      title: key,
      detail: failureDetail(key, list),
      count: list.length,
      target: { tab: 'network', params: { code: key } },
    });
  }

  const preflightFails = requests.filter((r) => r.resourceType === 'preflight' && r.flags.failed);
  if (preflightFails.length) {
    issues.push({
      severity: 'error',
      title: 'Failed CORS preflight',
      detail: 'OPTIONS preflight did not succeed; the real request was likely blocked.',
      count: preflightFails.length,
      target: { tab: 'network', params: { flag: 'preflight' } },
    });
  }

  const csp = messages.filter((m) => m.category === 'csp');
  if (csp.length) {
    issues.push({
      severity: 'error',
      title: 'Content Security Policy violations',
      detail: 'Resources blocked by the page CSP (console).',
      count: csp.length,
      target: { tab: 'console', params: { cat: 'csp' } },
    });
  }

  const exceptions = messages.filter((m) => m.category === 'exception');
  if (exceptions.length) {
    issues.push({
      severity: 'error',
      title: 'Uncaught exceptions',
      detail: 'Unhandled errors or promise rejections in page scripts.',
      count: exceptions.length,
      target: { tab: 'console', params: { cat: 'exception' } },
    });
  }

  const slow = requests.filter((r) => r.flags.slow);
  if (slow.length) {
    issues.push({
      severity: 'warn',
      title: `Slow requests (≥ ${SLOW_MS / 1000}s)`,
      detail: `Slowest: ${Math.round(Math.max(...slow.map((r) => r.durationMs)))} ms`,
      count: slow.length,
      target: { tab: 'network', params: { flag: 'slow', sort: 'time', dir: 'desc' } },
    });
  }

  const large = requests.filter((r) => r.flags.large);
  if (large.length) {
    issues.push({
      severity: 'info',
      title: 'Large responses (≥ 1 MB)',
      detail: 'May indicate slow loads on constrained connections.',
      count: large.length,
      target: { tab: 'network', params: { flag: 'large', sort: 'size', dir: 'desc' } },
    });
  }

  const chains = requests.filter((r) => r.redirectTo != null && r.redirectFrom == null).map((r) => chainLength(requests, r));
  const longChains = chains.filter((n) => n >= 3);
  if (longChains.length) {
    issues.push({
      severity: 'info',
      title: 'Redirect chains (3+ hops)',
      detail: `Longest chain: ${Math.max(...longChains)} hops`,
      count: longChains.length,
      target: { tab: 'network', params: { flag: 'redirect' } },
    });
  }

  const sevRank = { error: 0, warn: 1, info: 2 };
  issues.sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || b.count - a.count);

  const topConsole = groups
    .filter((g) => g.first.level !== 'info')
    .sort((a, b) => LEVEL_RANK[a.first.level] - LEVEL_RANK[b.first.level] || b.messageIds.length - a.messageIds.length)
    .slice(0, 8);

  return { list: issues, topConsole };
}

export function failureKey(r) {
  if (r.error) return r.error;
  if (r.status === 0) return 'No response (status 0)';
  return `HTTP ${r.status}${r.statusText ? ' ' + r.statusText : ''}`;
}

function failureDetail(key, list) {
  const hosts = countBy(list, (r) => r.host);
  const top = hosts.slice(0, 3).map((h) => h.key).join(', ');
  const more = hosts.length > 3 ? ` +${hosts.length - 3} more` : '';
  const hint = FAILURE_HINTS.find(([re]) => re.test(key))?.[1];
  return `${hint ? hint + ' ' : ''}Hosts: ${top}${more}`;
}

const FAILURE_HINTS = [
  [/ERR_ABORTED/, 'Cancelled by the page or navigation (often benign).'],
  [/BLOCKED_BY_CSP/, 'Blocked by Content Security Policy.'],
  [/BLOCKED_BY_ORB/, 'Opaque Response Blocking: cross-origin response with unexpected MIME type.'],
  [/BLOCKED_BY_CLIENT/, 'Blocked by an extension (ad blocker?).'],
  [/NAME_NOT_RESOLVED/, 'DNS lookup failed.'],
  [/CONNECTION_(REFUSED|RESET|CLOSED)|TIMED_OUT/, 'Connection-level failure.'],
  [/CERT|SSL/, 'TLS / certificate problem.'],
  [/^No response/, 'No response recorded (cancelled, blocked, or still pending at export).'],
  [/HTTP 5\d\d/, 'Server error.'],
  [/HTTP 40[13]/, 'Auth / permission failure.'],
];

function chainLength(requests, r) {
  let n = 1;
  for (let cur = r; cur.redirectTo != null && n < 50; cur = requests[cur.redirectTo]) n++;
  return n;
}

function hostStats(requests) {
  const map = new Map();
  for (const r of requests) {
    let s = map.get(r.host);
    if (!s) map.set(r.host, (s = { host: r.host, count: 0, failed: 0, bytes: 0, thirdParty: r.thirdParty }));
    s.count++;
    if (r.flags.failed) s.failed++;
    s.bytes += Math.max(r.transferSize || 0, 0);
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

export function countBy(list, keyFn) {
  const map = new Map();
  for (const item of list) {
    const k = keyFn(item);
    map.set(k, (map.get(k) || 0) + 1);
  }
  return [...map.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
}

function push(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}
