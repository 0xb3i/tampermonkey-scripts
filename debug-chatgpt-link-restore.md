[OPEN] chatgpt-link-restore

## Symptom
- ChatGPT fixed-case realtest still outputs `- 链接：百度` instead of `- 链接：[百度](https://www.baidu.com)`.

## Expected
- Official ChatGPT copy flow should produce Markdown link text that remains usable in Feishu.

## Hypotheses
- H1: The decorated link node loses `href` at the moment the official copy button click handler runs.
- H2: The real `href` remains elsewhere in the live DOM, but the current extraction root misses that source.
- H3: The link restore logic is correct but runs before ChatGPT finishes patching link metadata.
- H4: Markdown link restoration succeeds transiently but a later path downgrades it back to plain text before clipboard write.
- H5: Runtime behavior does not match the latest local code due to sync/version mismatch.

## Evidence Plan
- Capture runtime snapshots for the decorated link node and all `a[href]` nodes before and after official copy.
- Verify whether the same `data-start` / `data-end` pair can be mapped back to a live node with `href`.
- Verify whether a post-click delayed extraction yields the expected Markdown link.
- Confirm synced version and source exact match before each reproduction.

## Status
- Runtime evidence collected and first fix applied.

## Evidence
- Real browser probe shows `a.decorated-link[href*="baidu"]` is already present before click and remains present after click.
- Standalone runtime probe shows `data-copy-cleaner-chatgpt-copy` becomes Markdown-correct around 200-300ms after click.
- Realtest failure moved from link mismatch to block-math newline mismatch after waiting for existing assistant reply hydration.
- Browser-side debug fetch to `http://127.0.0.1:7777/event` fails from `https://chatgpt.com`, so direct Debug Server reporting is blocked by browser policy in this environment.

## Hypothesis Status
- H1: REJECTED. The target link does not permanently lose `href`; live DOM still contains the real link.
- H2: REJECTED. The extraction root is not fundamentally wrong once the reply is hydrated.
- H3: CONFIRMED. Existing-reply runner path clicked too early, before reply hydration stabilized under automation.
- H4: REJECTED. After hydration wait, the final clipboard text carries the Markdown link correctly.
- H5: REJECTED. Sync now verifies exact editor/source match and runtime version is `5.0.6`.
