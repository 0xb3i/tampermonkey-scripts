# [OPEN] chatgpt-copy-case

## Goal

- Use `https://chatgpt.com/c/69f45156-a908-83e8-a147-f694e7d9c109` as the real ChatGPT validation page.
- Copy the existing assistant reply via the official copy button.
- Compare clipboard output against a stable expected answer and iterate based on runtime evidence.

## Hypotheses

- `H1`: The fixed conversation page uses a different reply/button structure, so the current "latest copy button" targeting may select the wrong assistant turn.
- `H2`: The assistant reply on this page contains richer Markdown coverage, and the current copy-cleaner behavior may still regress on some block types during official-copy interception.
- `H3`: The current runner's prompt-driven expected text is no longer the right oracle; this case needs a page-specific expected answer fixture.
- `H4`: The current failure surface is too coarse, and we need structured mismatch evidence from the real clipboard output to iterate safely.

## Evidence Plan

- Inspect the target conversation page in the real 9222 browser session.
- Identify the intended assistant turn and its copy button.
- Capture the copied clipboard text from the official button path.
- Derive or confirm the expected answer fixture from runtime evidence.

## Status

- Runtime evidence collected from the fixed ChatGPT conversation page.
- Standard answer fixture has been switched to the fixed conversation case.
- High-level real test command now reproduces against the fixed page consistently.

## Evidence

- The fixed page is reachable in the real `9222` browser session and contains one assistant turn with the Markdown sample content.
- Current real-copy output already matches the intended cleaning policy for:
  - removal of decorative bold/italic/strikethrough markers
  - removal of Chinese parenthetical annotations
  - nested list indentation
  - task list checkbox state
  - table alignment row
  - footnote definition block normalization
- Current real-copy output still diverges from the standard answer for:
  - fenced code block extraction on the fixed ChatGPT page
  - inline code quotes in `print("Hello")`
  - markdown link serialization
  - footnote reference serialization in body text

## Current Result

- `npm test`: passing
- `copycleaner:realtest`: reproducibly failing against the fixed fixture page
- First current mismatch: code block section, where actual output still emits `Python运行` instead of a fenced code block
