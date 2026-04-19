# Feishu Block Style Fidelity Design

## Goal

把飞书原始文档的块级样式提取与应用链路做准，优先实现 `callout`、`image`、`heading/text`、`quote_container` 的 1:1 复刻，重点覆盖背景色、边框色、文字色、对齐、缩进与图片容器对齐，并保持现有 clipboard / HTML paste 语义不退化。

## Problem Statement

当前脚本已经能复制大部分结构和部分富文本，但块级样式仍存在明显偏差：

- `callout` 的背景色、边框色、文字色、高亮色不能稳定保留。
- 图片块的对齐方式在目标文档里会退化。
- `heading` / `text` / `quote_container` 的块级背景色、文字色、缩进和对齐并不总能正确映射。
- 样式来源目前主要依赖 `snapshot` 上少量已知字段，缺少统一归一化和按块类型的补充提取逻辑。
- HTML 导出与 clipboard metadata 虽然已经开始保留部分结构语义，但样式层仍不够完整，距离“视觉 + 语义同时接近 1:1”还有差距。

## Scope

### In Scope

- 只处理块级样式，不扩到复杂行内样式。
- 首批块类型：`callout`、`image`、`heading1~heading6`、`text`、`quote_container`。
- 样式字段：
  - `background_color`
  - `border_color`
  - `text_color`
  - `align`
  - `text_indent`
  - 图片容器对齐 / margin
  - callout 容器相关外观字段（padding / radius 如结构化数据不可得，则按统一模板保留）
- 样式来源策略：结构化数据优先，DOM / computed style 仅兜底。
- 验证范围：单测 + rich clipboard 回归测试 + 一次脚本同步验证。

### Out of Scope

- 复杂行内样式全量 1:1（例如更多组合高亮、特殊字体、字号体系、复杂局部颜色继承）。
- 重新设计整个复制/粘贴架构。
- 与本轮目标无关的块类型（如 table 深层样式、grid 更复杂布局、whiteboard/diagram 专有样式）。

## Constraints

- 必须保持现有 `callout HTML paste` 修复有效。
- 必须保持 `Cmd+Shift+P` 的一键动作行为不退化。
- 对“必须走原生 parser”的 payload（公式、纯 markdown callout）不能误切到错误路径。
- 改动要尽量聚焦在现有 `extractFullDoc -> blockToHtml -> buildClipboardHtml -> pasteIntoDoc` 链路，不做无关重构。
- 每次代码改动完成后需要同步到 Tampermonkey，避免人工复制。

## Existing Code Anchors

- `scripts/feishu-helper.user.js`
  - `getStructService()`：当前结构化数据入口
  - `extractFullDoc()`：整篇文档提取主链路
  - `buildBlockStyle()`：块级样式拼接入口
  - `blockToHtml()`：各块类型的 HTML 序列化
  - `buildCalloutClipboardMetadata()`：callout 语义元数据
  - `payloadHasFeishuCalloutHtml()` / `shouldAutoDispatchPastePayload()` / `pasteIntoDoc()`：粘贴路径选择
  - `__feishuDebugRichStyles()`：块级样式调试入口
- `tests/feishu-helper-rich-clipboard.spec.js`
  - 已有 callout / image / heading / paste 路径相关回归测试
  - 需要继续补“提取正确”和“应用正确”的样式测试

## Design Overview

实现分三层：

1. **样式提取层**：从结构化数据里提取块级样式，产出统一的 `normalizedBlockStyle`。
2. **样式补全层**：当关键字段缺失时，按块类型有限度读取 DOM / computed style 做兜底。
3. **样式应用层**：把 `normalizedBlockStyle` 同时映射到 HTML 渲染和 clipboard metadata，确保视觉与语义尽量一致。

这样做的关键收益是：

- 提取逻辑与渲染逻辑分离，后续扩更多块类型时只需扩映射。
- 结构化数据仍然是主线，DOM fallback 只覆盖“明显缺字段”的情况，避免强依赖飞书前端实现。
- HTML 输出和 metadata 会基于同一份归一化样式，减少“看起来像但语义不一致”的偏差。

## Detailed Design

### 1. Normalized Block Style Model

在 `scripts/feishu-helper.user.js` 中引入一个轻量归一化样式对象，作为块级渲染前的统一输入。它不需要成为复杂类，只需要是一个普通对象：

```js
{
  align: '',
  textIndent: '',
  textColor: '',
  backgroundColor: '',
  borderColor: '',
  imageAlign: '',
  imageMargin: '',
  calloutEmojiId: '',
  calloutPadding: '',
  calloutRadius: ''
}
```

该对象的目标不是“描述所有样式”，而是只覆盖这一轮块级 1:1 需要的字段。

### 2. Structured Extraction First

新增按块类型的样式提取逻辑，优先读取 `snapshot` 里已有字段。核心原则：

- 不直接在 `blockToHtml()` 各分支里散落读取逻辑。
- 先统一取出样式对象，再由各分支消费。
- 字段命名在归一化层统一，避免上层继续知道 `background_color` / `text_color` / `emoji_id` 这种飞书命名细节。

优先提取：

- 所有块：`align`、`text_indent`、`background_color`、`text_color`
- `callout`：`border_color`、`emoji_id`
- `image`：优先检查 `snap.align` 及图片容器相关布局字段
- `quote_container`：背景色 / 文字色 / 缩进 / 对齐（若结构化数据存在）

### 3. DOM / Computed Style Fallback

对结构化数据中缺失的关键字段，按块类型做最小化兜底：

- `callout`
  - 兜底读取容器的 `background-color`、`border-left-color` / `border-color`、文字颜色。
- `image`
  - 兜底读取容器实际 `text-align` 与图片 margin 表现。
- `heading/text/quote_container`
  - 仅兜底读取明显影响视觉的 `text-align`、`background-color`、`color`、`text-indent`。

兜底规则：

- 只有结构化字段为空时才读 DOM。
- 只读当前块节点，不做跨层复杂推断。
- 只回填本轮定义的块级字段，不扩大到行内样式。

### 4. Block-Type-Specific Application

基于归一化样式对象更新现有渲染：

- `buildBlockStyle()`
  - 继续负责通用的 `align`、`textIndent`、`backgroundColor`、`textColor`。
  - 输入从直接读 `snap` 改为优先使用归一化结果。
- `blockToHtml()`
  - `callout`：完整消费 `backgroundColor`、`borderColor`、`textColor`、emoji 及容器参数。
  - `image`：按归一化对齐计算 figure 的 `text-align` 与 image margin。
  - `heading/text`：确保背景色和文字色不会丢。
  - `quote_container`：把提取到的块级颜色/缩进/对齐合并到当前 blockquote 输出。

### 5. Metadata Consistency

对于 `callout`，归一化后的关键样式字段除了写进 HTML 外，还应继续进入 clipboard metadata：

- `data-lark-record-data`
- `data-meta-block-props`

这样在 HTML paste 路径里，飞书既能看见结构语义，也能拿到足够的块级样式信息。

这一轮只强化 `callout` metadata，不把其它块类型都扩成复杂 metadata 方案，避免 scope 膨胀。

## Testing Strategy

### A. 提取正确

在 `tests/feishu-helper-rich-clipboard.spec.js` 增加单测，验证：

- `callout` 的结构化字段能正确进入归一化样式对象
- `image` 的对齐字段能被识别
- `heading/text` 的背景色、文字色、缩进和对齐能被统一提取
- `quote_container` 的块级颜色/对齐在存在时可被读取

### B. 应用正确

新增/补强 HTML 渲染断言：

- `callout`：背景色、边框色、文字色、emoji 元数据都在
- `image`：`figure` 对齐与 `img` margin 正确
- `heading/text`：背景色 / 文字色 / 缩进 / 对齐正确落到 HTML
- `quote_container`：块级颜色和缩进不丢

### C. 粘贴路径不退化

保留并扩展现有测试，确保：

- `callout` HTML path 仍然可自动派发粘贴
- clipboard write 失败时，callout HTML 仍可走正确 fallback
- 公式 / markdown callout 仍不会被误判成可直接自动粘贴

## Risk Assessment

### Risk 1: DOM fallback 过重

如果 DOM fallback 读取太多字段，会让实现过于依赖飞书当前前端结构。规避方式是：只在字段缺失时使用，只读取本轮块级字段。

### Risk 2: 应用层与 metadata 不一致

如果 HTML 和 metadata 走两套值源，容易再次出现视觉与语义不一致。规避方式是：都从同一份 `normalizedBlockStyle` 派生。

### Risk 3: 影响现有 paste 路径

`callout` 路径已经较脆弱，误改容易回退成需要手动 `Cmd+V`。规避方式是保留现有 callout auto-dispatch 回归测试，并新增样式增强后的覆盖。

## Success Criteria

完成后应满足：

- `callout` 在复制/粘贴后，背景色、边框色、文字色比当前更接近原文档。
- 图片块在目标文档中的对齐不再明显退化。
- 标题/普通段落/引用容器的块级背景色、文字色、缩进和对齐能稳定保留。
- 富剪贴板现有 26 条回归测试不破坏，并新增样式相关覆盖。
- 改动完成后脚本同步到 Tampermonkey。

## Implementation Notes

- 这轮不追求一次性把所有富文本问题解决，而是先把“肉眼最明显的块级样式偏差”做准。
- 如果 live page 调试仍无法直接稳定拿到 `structService`，实现阶段可以先通过 mock snapshot + 已有调试入口推进，再补更强的线上观测辅助函数，但不应阻塞核心样式修复。
