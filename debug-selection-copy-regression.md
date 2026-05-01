[OPEN] Selection Copy Regression

## Session
- id: `selection-copy-regression`
- started_at: `2026-05-01`
- target_page: `https://mira.byteintl.net/chat/108759037971`

## Symptom
- 在 `mira` 页面，手动选中复制的最终结果与 `ChatGPT/Tika` 官方 copy 按钮输出不一致。
- 预期是选中复制也应尽量得到相同的结构化结果，包括嵌套列表、公式块等。

## Hypotheses
1. `copy` / `keydown` 监听已注册，但在目标页面没有拿到有效选区，导致脚本没有接管复制。
2. 选区进入了 `buildClipboardPayloadFromSelection()`，但 `cloneContents()` 返回的 fragment 结构不符合当前通用序列化假设，导致输出退化。
3. 页面自身的复制逻辑在脚本之后重写了剪贴板内容，覆盖了脚本结果。
4. 目标页面 DOM 结构与现有已验证站点差异较大，结构化序列化虽然执行，但结果本身就不符合预期。

## Plan
1. 给选中复制链路增加运行时打点，只记录关键分支和结果摘要。
2. 在目标页面复现一次真实选中复制，采集日志验证上述假设。
3. 根据证据做最小修复，再进行 post-fix 对比验证。

## Evidence
- `.dbg/trae-debug-log-selection-copy-regression.ndjson:1-4`
  - 已进入选中复制链路，`rawTextLength=732`，`rangeCount=1`
  - `hasStructured=true`
  - `structured branch changed=true`
  - `onKeydown intercepted=true`
- 运行时 DOM 证据：
  - `mira` 代码块容器含独立 header：`data-testid="code_block"`，语言标签 `python` 位于 `header_a898b`
  - 图片区域存在两个 `img`：一个空 `alt` 的占位 `data:image/svg+xml,...`，一个真实图片 `alt="image"`

## Hypothesis Status
| ID | Hypothesis | Status | Evidence Summary |
|----|------------|--------|------------------|
| A | 没拿到有效选区，脚本未接管 | REJECTED | 日志 1 显示 `rangeCount=1`，日志 4 显示 `intercepted=true` |
| B | `cloneContents()` 结构异常，导致根本没法走结构化链路 | REJECTED | 日志 2 显示 `hasStructured=true`，日志 3 显示已进入 structured branch |
| C | 页面自身复制逻辑覆盖脚本结果 | REJECTED | 日志 4 显示 `onKeydown` 已拦截并使用脚本 payload，当前剪贴板内容与 payload 形态一致 |
| D | 结构化序列化执行了，但结果本身不符合预期 | CONFIRMED | 剪贴板结果出现 `python` 落在代码围栏外、图片被序列化为占位图 + 实图两段 `data:` |

## Root Cause (Current)
- 通用选中复制链路本身已生效，问题不在拦截，而在序列化细节：
  - `mira` 代码块语言标签是独立 header，当前序列化把 header 文本当普通正文输出。
  - `mira` 图片 DOM 包含占位 `img` 与真实 `img`，当前通用图片序列化没有过滤占位图。

## Fix
- 对 `data-testid="code_block"` 容器优先序列化内部 `pre`，避免把外层 header 文本输出到代码围栏外。
- 为代码块语言探测补充 `pre/code.className` 中的 `language-*`。
- 过滤空 `alt` 的 SVG 占位图，避免占位图被复制成 Markdown 图片。

## Post-Fix Evidence
- `post-fix` 真机复现结果：
  - 代码块从 `python + fenced code` 修正为单个 ```` ```python ```` 围栏块
  - 图片从 `![](...placeholder...)![image](...real...)` 修正为单个 `![image](...)`
- 当前自动化复现拿到的剪贴板结果已符合这两项修复预期。
- 调试日志文件在 post-fix 复现后未收到新事件，后续如需继续深挖更细粒度问题，可单独补查调试上报链路。
