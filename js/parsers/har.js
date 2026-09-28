// Normalizes a Chrome DevTools HAR export. Chrome adds underscore-prefixed
// extensions (_initiator, _resourceType, _error, ...) that carry most of the
// triage value, so they are lifted into first-class fields.

export function isHar(json) {
  return !!(json && json.log && Array.isArray(json.log.entries));
}

export function parseHar(json) {
  const log = json.log;
  const pages = (log.pages || []).map((p) => ({
    id: p.id,
    title: p.title,
    startMs: Date.parse(p.startedDateTime),
    onContentLoad: validTiming(p.pageTimings?.onContentLoad),
    onLoad: validTiming(p.pageTimings?.onLoad),
  }));

  const requests = log.entries.map(normalizeEntry);
  requests.sort((a, b) => a.startMs - b.startMs);
  requests.forEach((r, i) => (r.id = i));

  return {
    pages,
    requests,
    creator: log.creator ? `${log.creator.name} ${log.creator.version}` : 'unknown',
    sanitizedLikely: looksSanitized(log.entries),
  };
}

function normalizeEntry(e) {
  const req = e.request || {};
  const res = e.response || {};
  const content = res.content || {};
  const url = req.url || '';
  const { host, path, scheme } = splitUrl(url);
  const status = res.status ?? 0;
  const error = res._error || null;
  const timings = e.timings || {};

  const r = {
    id: 0,
    url,
    host,
    path,
    scheme,
    method: req.method || '',
    status,
    statusText: res.statusText || '',
    error,
    resourceType: e._resourceType || 'other',
    mimeType: content.mimeType || '',
    startMs: Date.parse(e.startedDateTime),
    durationMs: typeof e.time === 'number' ? e.time : 0,
    timings: {
      blocked: validTiming(timings.blocked),
      queueing: validTiming(timings._blocked_queueing),
      dns: validTiming(timings.dns),
      connect: validTiming(timings.connect),
      ssl: validTiming(timings.ssl),
      send: validTiming(timings.send),
      wait: validTiming(timings.wait),
      receive: validTiming(timings.receive),
    },
    transferSize: res._transferSize ?? (res.bodySize > 0 ? res.bodySize : null),
    contentSize: content.size ?? null,
    fromCache: e._fromCache || null,
    priority: e._priority || null,
    initiator: normalizeInitiator(e._initiator),
    httpVersion: res.httpVersion || req.httpVersion || '',
    serverIp: e.serverIPAddress || '',
    connectionId: e._connectionId || '',
    redirectURL: res.redirectURL || '',
    reqHeaders: req.headers || [],
    resHeaders: res.headers || [],
    queryString: req.queryString || [],
    postData: req.postData || null,
    body: content.text != null ? { text: content.text, encoding: content.encoding || null } : null,
    wsMessages: e._webSocketMessages || null,
    pageref: e.pageref || null,
    fetchedViaServiceWorker: !!res._fetchedViaServiceWorker,
  };
  r.flags = {
    failed: status >= 400 || status === 0 || !!error,
    blocked: !!error && /BLOCKED/.test(error),
    redirect: status >= 300 && status < 400,
  };
  return r;
}

// Chrome uses -1 to mean "phase did not apply" (e.g. reused connection).
function validTiming(v) {
  return typeof v === 'number' && v >= 0 ? v : null;
}

function normalizeInitiator(init) {
  if (!init) return null;
  return {
    type: init.type || 'other',
    url: init.url || null,
    line: typeof init.lineNumber === 'number' ? init.lineNumber + 1 : null,
    stack: flattenInitiatorStack(init.stack),
  };
}

function flattenInitiatorStack(stack) {
  const frames = [];
  for (let s = stack; s; s = s.parent) {
    if (s.description && frames.length) frames.push({ async: s.description });
    for (const f of s.callFrames || []) {
      frames.push({ fn: f.functionName || '(anonymous)', file: f.url, line: f.lineNumber + 1 });
    }
  }
  return frames.length ? frames : null;
}

export function splitUrl(url) {
  try {
    const u = new URL(url);
    return { host: u.host, path: u.pathname + u.search, scheme: u.protocol.replace(':', '') };
  } catch {
    return { host: '', path: url, scheme: '' };
  }
}

// Chrome's default HAR export ("sanitized") strips Cookie/Set-Cookie/Authorization.
// Their total absence across a capture is a strong signal it was sanitized, which
// matters when the suspected problem is auth/session related.
function looksSanitized(entries) {
  const sensitive = /^(cookie|set-cookie|authorization)$/i;
  for (const e of entries) {
    if (e.request?.cookies?.length || e.response?.cookies?.length) return false;
    for (const hd of e.request?.headers || []) if (sensitive.test(hd.name)) return false;
    for (const hd of e.response?.headers || []) if (sensitive.test(hd.name)) return false;
  }
  return entries.length > 0;
}
