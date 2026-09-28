import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { parseHar } from '../js/parsers/har.js';
import { parseConsoleLog } from '../js/parsers/console.js';
import { buildModel, registrableDomain } from '../js/model.js';

const SAMPLE = new URL('../examples/sample.har', import.meta.url);

function entry(url, { status = 200, start = '2026-09-27T23:22:24.420Z', time = 100, error, redirectURL = '', type = 'fetch', method = 'GET' } = {}) {
  return {
    startedDateTime: start,
    time,
    _resourceType: type,
    request: { method, url, headers: [], queryString: [], cookies: [] },
    response: { status, statusText: '', headers: [], cookies: [], content: { size: 0, mimeType: 'text/plain' }, redirectURL, _error: error },
    timings: { blocked: -1, dns: -1, connect: -1, ssl: -1, send: 0, wait: time, receive: 0 },
  };
}

function har(entries) {
  return parseHar({ log: { version: '1.2', creator: { name: 'test', version: '1' }, pages: [], entries } });
}

test('normalizes chrome HAR extensions and flags failures', () => {
  const h = har([
    entry('https://a.test/ok'),
    entry('https://a.test/blocked', { status: 0, error: 'net::ERR_BLOCKED_BY_CSP' }),
    entry('https://a.test/missing', { status: 404 }),
  ]);
  const [ok, blocked, missing] = h.requests;
  assert.equal(ok.flags.failed, false);
  assert.equal(blocked.flags.blocked, true);
  assert.equal(missing.flags.failed, true);
  assert.equal(ok.timings.dns, null, '-1 timings become null');
  assert.equal(h.sanitizedLikely, true);
});

test('links console network lines to requests and detects issues', () => {
  const h = har([
    entry('https://x.test/a', { status: 422, start: '2026-09-27T23:22:24.420Z', time: 300 }),
    entry('https://x.test/r1', { status: 302, redirectURL: 'https://x.test/r2' }),
    entry('https://x.test/r2', { status: 302, redirectURL: '/r3', start: '2026-09-27T23:22:24.500Z' }),
    entry('https://x.test/r3', { start: '2026-09-27T23:22:24.600Z' }),
  ]);
  const log = parseConsoleLog('16:22:24.600 v1:1  GET https://x.test/a 422 (Unprocessable Content)\nImage\nf @ p.js:1');
  const m = buildModel({ har: h, consoleLog: log });

  const msg = m.messages[0];
  const req = m.requests.find((r) => r.url === 'https://x.test/a');
  assert.deepEqual(msg.relatedRequestIds, [req.id]);
  assert.deepEqual(req.relatedMessageIds, [msg.id]);

  assert.equal(m.timeAlign.offsetMin, -420, 'console clock inferred as UTC-7');
  assert.equal(msg.absMs, Date.parse('2026-09-27T23:22:24.600Z'));

  const r1 = m.requests.find((r) => r.url.endsWith('/r1'));
  assert.equal(m.requests[m.requests[r1.redirectTo].redirectTo].url, 'https://x.test/r3');
  assert.ok(m.issues.list.some((i) => i.title.startsWith('HTTP 422')));
  assert.ok(m.issues.list.some((i) => i.title.startsWith('Redirect chains')));
});

test('manual offset shifts console times', () => {
  const h = har([entry('https://x.test/a', { status: 500 })]);
  const log = parseConsoleLog('16:22:24.600 v1:1  GET https://x.test/a 500 (Internal Server Error)');
  const a = buildModel({ har: h, consoleLog: log }).messages[0].absMs;
  const b = buildModel({ har: h, consoleLog: log, manualOffsetMs: 1500 }).messages[0].absMs;
  assert.equal(b - a, 1500);
});

test('registrable domain heuristic', () => {
  assert.equal(registrableDomain('query1.finance.yahoo.com'), 'yahoo.com');
  assert.equal(registrableDomain('www.bbc.co.uk'), 'bbc.co.uk');
  assert.equal(registrableDomain('127.0.0.1:8080'), '127.0.0.1');
});

test('example HAR parses into expected shape', { skip: !existsSync(SAMPLE) }, () => {
  const h = parseHar(JSON.parse(readFileSync(SAMPLE, 'utf8')));
  assert.equal(h.requests.length, 686);
  assert.equal(h.requests.filter((r) => r.error).length, 22);
  assert.equal(h.requests.filter((r) => r.wsMessages).length, 1);
  const m = buildModel({ har: h });
  assert.equal(m.pageHost, 'finance.yahoo.com');
});
