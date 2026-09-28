import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { parseConsoleLog } from '../js/parsers/console.js';

const SAMPLE = new URL('../examples/sample.log', import.meta.url);

test('parses messages, stacks and async boundaries', () => {
  const log = [
    'app.js:10 Something failed',
    'console.error @ app.js:10',
    'load @ app.js:20',
    'Promise.then',
    '(anonymous) @ main.js:3',
    'app.js:11 Next message',
  ].join('\n');
  const { messages, hasTimestamps } = parseConsoleLog(log);
  assert.equal(hasTimestamps, false);
  assert.equal(messages.length, 2);
  const [m] = messages;
  assert.deepEqual(m.source, { file: 'app.js', line: 10 });
  assert.equal(m.text, 'Something failed');
  assert.equal(m.level, 'error');
  assert.deepEqual(
    m.stack.map((f) => f.async || f.fn),
    ['console.error', 'load', 'Promise.then', '(anonymous)'],
  );
});

test('keeps continuation text before the stack with its message', () => {
  const log = [
    'gpt.js:195 [GPT] Foo is deprecated.',
    'https://goo.gle/gpt-message#170',
    'console.warn @ gpt.js:195',
  ].join('\n');
  const { messages } = parseConsoleLog(log);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, '[GPT] Foo is deprecated.\nhttps://goo.gle/gpt-message#170');
  assert.equal(messages[0].level, 'warn');
  assert.equal(messages[0].category, 'deprecation');
});

test('source-less browser lines are separate messages', () => {
  const log = ['(index):6 <link rel=preload> uses an unsupported `as` value', 'An iframe which has both allow-scripts and allow-same-origin.'].join('\n');
  const { messages } = parseConsoleLog(log);
  assert.equal(messages.length, 2);
  assert.equal(messages[1].source, null);
  assert.equal(messages[1].category, 'browser');
});

test('sources with query strings and network failure lines', () => {
  const log = [
    'gtm_ns.html?id=GTM-1&type=FIN:922 [gtm-wrapper] waiting',
    'v1:1  GET https://match.example.com/v1?a=1 422 (Unprocessable Content)',
    'Image',
    '(anonymous) @ prebid.js:14',
  ].join('\n');
  const { messages } = parseConsoleLog(log);
  assert.equal(messages[0].source.file, 'gtm_ns.html?id=GTM-1&type=FIN');
  const net = messages[1];
  assert.equal(net.category, 'network');
  assert.deepEqual(net.network, {
    method: 'GET',
    url: 'https://match.example.com/v1?a=1',
    status: 422,
    statusText: 'Unprocessable Content',
    error: null,
  });
  assert.deepEqual(net.stack[0], { async: 'Image' });
});

test('classifies CSP, exceptions, and dedup signatures', () => {
  const log = [
    "Loading the image 'https://a.test/1.png' violates the following Content Security Policy directive: \"img-src 'self'\"",
    "Loading the image 'https://b.test/2.png' violates the following Content Security Policy directive: \"img-src 'self'\"",
    'app.js:5 Uncaught TypeError: x is undefined',
  ].join('\n');
  const { messages } = parseConsoleLog(log);
  assert.equal(messages[0].category, 'csp');
  assert.equal(messages[0].signature, messages[1].signature);
  assert.equal(messages[2].category, 'exception');
  assert.equal(messages[2].level, 'error');
});

test('parses optional timestamp prefixes', () => {
  const log = ['16:22:24.900 app.js:1 hello', 'fn @ app.js:1', '2026-09-27 16:22:25.1 app.js:2 dated'].join('\n');
  const { messages, hasTimestamps } = parseConsoleLog(log);
  assert.equal(hasTimestamps, true);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].time.msOfDay, ((16 * 60 + 22) * 60 + 24) * 1000 + 900);
  assert.equal(messages[0].stack.length, 1);
  assert.deepEqual(messages[1].time.date, { y: 2026, m: 9, d: 27 });
  assert.equal(messages[1].time.msOfDay % 1000, 100);
});

test('example capture parses into expected shape', { skip: !existsSync(SAMPLE) }, () => {
  const { messages } = parseConsoleLog(readFileSync(SAMPLE, 'utf8'));
  assert.equal(messages.length, 63);
  const net = messages.find((m) => m.network);
  assert.equal(net.lineNo, 1088);
  assert.equal(net.network.status, 422);
  assert.equal(messages.filter((m) => m.category === 'csp').length, 26);
});
