import { isHar, parseHar } from './har.js';
import { parseConsoleLog } from './console.js';

// Detection is by content rather than extension because customers rename files
// and some tools export HAR as .json.
export function parseFile(name, text) {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{')) {
    let json;
    try {
      json = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`${name}: looks like JSON but failed to parse (${err.message})`);
    }
    if (!isHar(json)) throw new Error(`${name}: JSON file is not a HAR (no log.entries)`);
    return { kind: 'har', name, data: parseHar(json) };
  }
  return { kind: 'console', name, data: parseConsoleLog(text) };
}
