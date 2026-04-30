[OPEN] ChatGPT code block copy is not preserved correctly

- Session ID: `chatgpt-code-block-copy`
- Started: `2026-05-01`
- Target page: `https://chatgpt.com/c/69ee1a9f-ea48-83e8-9569-1d062bf6300b`
- Symptom: Official copy button and selection copy do not preserve code blocks correctly.
- Expected: Code blocks should remain recognizable and copy out in a stable plain-text format, ideally fenced or otherwise unambiguous.

## Hypotheses

1. `serializeStructuredFragment()` treats code blocks as ordinary text nodes, so block boundaries are lost.
2. ChatGPT reply-copy adaptation clones the assistant root, but code payload lives in `pre code` structures that are not serialized correctly.
3. Selection-copy path uses `buildClipboardPayloadFromSelection()` and flattens `Range` content before code block structure can be preserved.
4. Code block structure is initially extracted, but later normalization strips fencing or indentation.
5. The current page exposes separate copy paths for whole-reply copy and code-block copy, and only one path is currently adapted.

## Evidence Log

- User-confirmed evidence:
  - Official ChatGPT reply copy branch is definitely hit because LaTeX extraction still works.
  - The remaining failures are specific to `inline code` and block code.
- Static code evidence:
  - `serializeInlineNode()` handles `CODE`, but `serializeStructuredNode()` did not.
  - ChatGPT reply-copy path uses `serializeStructuredFragment(fragment)` on the cloned assistant root.
  - Therefore any `CODE` element encountered during structured traversal was flattened to plain text.
  - `PRE` only fenced when its sole child was `CODE`, which is too strict for ChatGPT's wrapped code-block DOM.
  - `hasStructuredFragmentContent()` did not treat `code` as structured content, so selection-copy of inline code could fall back to plain text cleaning and lose backticks.

## Fix

- Added a dedicated `CODE` branch in `serializeStructuredNode()` so structured traversal preserves inline code as backtick-wrapped text.
- Relaxed `PRE` handling to use the first descendant `code` node instead of requiring `PRE > CODE` as the only child.
- Expanded `hasStructuredFragmentContent()` to include `code`, so selection-copy of inline code also routes through structured serialization.

## Verification

- Added focused tests:
  - inline code in structured fragments remains `` `const x = 1` ``
  - wrapped `pre/code` structures serialize as fenced code blocks
- `npm test` passes with the new cases included.
- Tampermonkey sync succeeded with `matchedMarkers: 12`.

## Plan

1. Ask the user to verify the official copy button and selection-copy on the provided current ChatGPT page.
2. If confirmed fixed, remove temporary debug instrumentation and stop the debug server.
