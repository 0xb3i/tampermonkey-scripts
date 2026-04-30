[OPEN] Mira official copy adds too many double line breaks

- Session ID: `mira-double-breaks`
- Started: `2026-05-01`
- Target page: `https://mira.byteintl.net/chat/108002078739`
- Symptom: Clicking the official `Copy` button yields copied text with a large number of `\n\n`.
- Expected: Copied text should preserve normal paragraph spacing and avoid pathological double blank lines.

## Hypotheses

1. Mira's official copy button bypasses the patched `Clipboard.writeText` and `Clipboard.write` hooks, so our normalization never runs.
2. Mira writes HTML or a `ClipboardItem` whose `text/plain` payload already contains excessive `\n\n`, and our current hook does not inspect enough metadata to prove which branch ran.
3. Mira dispatches a private copy flow from an isolated world / extension world / iframe, so userscript hooks exist on the page but are not on the effective execution path of the button.
4. The copied payload is assembled from DOM blocks with intentional empty separators, and the browser's plain-text conversion expands them into many `\n\n` before our code sees them.
5. The button target we manually click during automation is not the real message-level `Copy` trigger, so previous evidence came from stale clipboard contents rather than a fresh official-copy execution.

## Evidence Log

- Pre-debug state:
  - Sync to Tampermonkey succeeded with `matchedMarkers: 12`.
  - On Mira page, `Clipboard.prototype.writeText` and `Clipboard.prototype.write` show patched function bodies.
  - Previous automation did not locate a visible `Copy` button via broad text scan.
  - Clipboard still contained `length=8707`, `doubleBreaks=269`, `tripleBreaks=0`.

## Plan

1. Start / verify debug server for `mira-double-breaks`.
2. Add instrumentation only around clipboard hooks and capture-phase click observation for Mira copy controls.
3. Reproduce on the live page and collect runtime logs.
4. Decide the real path from evidence, then apply a minimal fix.
5. Re-run and compare pre-fix vs post-fix logs before cleanup.
