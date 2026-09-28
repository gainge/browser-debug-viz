// Parses the plain-text output of DevTools Console "Save as...".
//
// The format is lossy: it carries no log level, and timestamps only appear when
// the capturer enabled "Show timestamps". Messages are therefore reconstructed
// heuristically:
//   <message line>          "source.js:123 text" or source-less browser text
//   [continuation line]     extra message text before the first stack frame
//   fn @ file:line          stack frames
//   Promise.then            async boundary labels between frames

const TIMESTAMP = /^(?:(\d{4})-(\d{2})-(\d{2})[ T])?(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?\s+/;
const FRAME = /^(.+?) @ (\S+)$/;
const SOURCE = /^(\S+):(\d+)\s+(.*)$/s;
const ASYNC_LABEL = /^[A-Za-z_$][\w.$]*$/;
const NETWORK = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)(?:\s+(\d{3}))?(?:\s+\((.*?)\))?(?:\s+(net::\S+))?/;
const URL_RE = /https?:\/\/[^\s'"<>`)\]}]+/g;

export function parseConsoleLog(text) {
  const lines = text.split(/\r?\n/);
  const messages = [];
  let current = null;

  const isFrameAt = (idx) => {
    for (let j = idx; j < lines.length; j++) {
      const l = stripTimestamp(lines[j]).rest.trim();
      if (l) return FRAME.test(l);
    }
    return false;
  };

  for (let i = 0; i < lines.length; i++) {
    const { ts, rest } = stripTimestamp(lines[i]);
    const line = rest.trimEnd();
    if (!line.trim()) continue;

    const frame = current && FRAME.exec(line);
    if (frame) {
      current.stack.push(parseFrame(frame[1], frame[2]));
      continue;
    }

    if (current && ASYNC_LABEL.test(line) && isFrameAt(i + 1)) {
      current.stack.push({ async: line });
      continue;
    }

    const src = SOURCE.exec(line);
    if (!src && current && current.source && current.stack.length === 0 && !ts && isFrameAt(i + 1)) {
      current.text += '\n' + line;
      continue;
    }

    current = {
      id: messages.length,
      lineNo: i + 1,
      time: ts,
      source: src ? { file: src[1], line: Number(src[2]) } : null,
      text: src ? src[3] : line,
      stack: [],
    };
    messages.push(current);
  }

  for (const m of messages) classify(m);
  return {
    messages,
    hasTimestamps: messages.some((m) => m.time),
  };
}

function stripTimestamp(line) {
  const m = TIMESTAMP.exec(line);
  if (!m) return { ts: null, rest: line };
  const [, y, mo, d, hh, mm, ss, frac] = m;
  const ms = frac ? Number(frac.padEnd(3, '0').slice(0, 3)) : 0;
  return {
    ts: {
      date: y ? { y: Number(y), m: Number(mo), d: Number(d) } : null,
      msOfDay: ((Number(hh) * 60 + Number(mm)) * 60 + Number(ss)) * 1000 + ms,
      raw: m[0].trim(),
    },
    rest: line.slice(m[0].length),
  };
}

function parseFrame(fn, loc) {
  const m = /^(.*):(\d+)(?::(\d+))?$/.exec(loc);
  return m ? { fn, file: m[1], line: Number(m[2]) } : { fn, file: loc, line: null };
}

// Levels and categories are inferred because the export drops them. The
// console.error/console.warn frame Chrome records as the top of the stack is the
// most reliable signal; message wording is the fallback.
function classify(m) {
  const text = m.text;
  const topFn = m.stack.find((f) => f.fn)?.fn || '';
  let level = 'info';
  let category = 'log';

  const net = NETWORK.exec(text);
  if (net) {
    m.network = {
      method: net[1],
      url: net[2],
      status: net[3] ? Number(net[3]) : null,
      statusText: net[4] || null,
      error: net[5] || null,
    };
  }

  if (/^Uncaught\b|^Unhandled/.test(text)) {
    level = 'error';
    category = 'exception';
  } else if (/Content Security Policy|Refused to (load|connect|execute|frame|apply|create)/.test(text)) {
    level = 'error';
    category = 'csp';
  } else if (net || /Failed to load resource|net::ERR_|Access to .* has been blocked by CORS/.test(text)) {
    level = 'error';
    category = /CORS/.test(text) ? 'cors' : 'network';
  } else if (/deprecat/i.test(text)) {
    level = 'warn';
    category = 'deprecation';
  } else if (!m.source || /\[Violation\]|sandbox|preload/i.test(text)) {
    level = 'warn';
    category = 'browser';
  }

  if (topFn === 'console.error') level = 'error';
  else if (topFn === 'console.warn') level = level === 'error' ? level : 'warn';

  m.level = level;
  m.category = category;
  m.urls = [...new Set((text.match(URL_RE) || []).map((u) => u.replace(/[.,;:]+$/, '')))];
  m.signature = signature(m);
}

// Collapses messages that differ only in volatile parts (numbers, ids, URLs) so
// repeated noise folds into one row with a count.
function signature(m) {
  const norm = m.text
    .replace(URL_RE, '<url>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')
    .replace(/\d+(\.\d+)?/g, '<n>');
  return `${m.level}|${m.source ? m.source.file : ''}|${norm}`;
}
