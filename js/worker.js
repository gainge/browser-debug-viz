// Parsing a multi-MB HAR is dominated by JSON.parse; doing it off the main
// thread keeps the page responsive while large captures load.
import { parseFile } from './parsers/index.js';

self.onmessage = async (e) => {
  const file = e.data;
  try {
    const text = await file.text();
    self.postMessage({ ok: true, result: parseFile(file.name, text) });
  } catch (err) {
    self.postMessage({ ok: false, error: err.message || String(err) });
  }
};
