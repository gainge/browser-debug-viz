# Chrome Debug Viz

A static, dependency-free viewer for Chrome DevTools exports: network **HAR** files and **console logs**. It's for triaging hard-to-reproduce customer issues. Everything runs in the browser, and captured files are never uploaded.

## Using it

Open the site and drop in one or both files:

| Capture | How the customer exports it |
| --- | --- |
| Network | DevTools → Network → ⤓ **Export HAR** (`.har`) |
| Console | DevTools → Console → right-click → **Save as…** (`.log`) |

Ask the customer to enable these **before reproducing**:

- **Network → Preserve log** and **Console → Preserve log**, so navigations don't clear the capture.
- **Console settings → Show timestamps**. Without it the console export has no times at all, so console messages can only be tied to requests by URL and the Timeline shows network only.
- If auth/session state is suspected: Network export menu → **Export HAR (with sensitive data)**. The default export strips cookies and `Authorization`, and the viewer flags this as "Sanitized HAR".

### Views

- **Issues**: summary tiles and a ranked list of detected problems (HTTP errors, `net::ERR_*` codes, CSP violations, failed preflights, slow/large responses, redirect chains, top repeated console errors). It also has a per-host breakdown. Every item links to a pre-filtered Network or Console view.
- **Network**: a sortable, filterable, groupable request table with a waterfall. The detail pane covers headers, payload, the response (JSON tree, image preview, text), a timing breakdown, the initiator/redirect chain, WebSocket frames, and linked console messages.
- **Console**: messages rebuilt from the text export, with inferred level and category. Duplicates are collapsed by default. Stack traces show async boundaries, and linked requests are shown for each message.
- **Timeline**: requests and (when timestamped) console messages on one zoomable axis. Console times are local wall-clock and the HAR is UTC, so the UTC offset is inferred by matching console network-error lines to their requests. The offset can be adjusted manually.

The URL hash holds the current tab, filters and selection. The back button works, and a link reproduces the same view for anyone who loads the same files.

## Design notes

- **No build step.** Native ES modules served as-is, so GitHub Pages can host the repo root directly.
- **Untrusted input.** File content only ever reaches the DOM as text nodes. The page CSP blocks scripts, remote loads and network access, so a malicious capture can't execute or exfiltrate anything.
- **Lossy console format.** Chrome's "Save as…" drops log levels (and timestamps unless enabled), so level, category and message boundaries are inferred heuristically (`js/parsers/console.js`). The UI labels levels as inferred.
- **Scale.** Parsing runs in a module Web Worker and lists are virtualized. A 25 MB / 700-request HAR loads in about 200 ms.

## Layout

```
index.html              app shell
css/app.css             styles (light/dark via prefers-color-scheme)
js/main.js              file loading, routing, app state
js/worker.js            off-main-thread parsing
js/parsers/             HAR + console log parsers (pure, Node-testable)
js/model.js             cross-linking, time alignment, issue detection
js/ui/                  views: issues, network, console, timeline, detail pane
test/                   node:test unit tests
examples/sample.*       trimmed demo capture for "Load example"
```

## Development

```sh
python3 -m http.server 8000   # ES modules need http://, not file://
npm test                      # node --test, no dependencies
```

## Deploying to GitHub Pages

Settings → Pages → Source: **Deploy from a branch** → `main` / `(root)`. `.nojekyll` keeps Pages from running Jekyll on the files.
