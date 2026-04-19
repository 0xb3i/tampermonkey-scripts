# Feishu Block Style Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让飞书原始文档的块级样式在复制到目标文档时尽量 1:1 保留，优先覆盖 `callout`、`image`、`heading/text`、`quote_container` 的背景色、边框色、文字色、对齐、缩进与图片容器对齐。

**Architecture:** 在 `scripts/feishu-helper.user.js` 中增加轻量的块级样式归一化层，优先读取 `snapshot` 里的结构化字段，再按块类型做最小化 DOM fallback。所有 HTML 渲染与 callout clipboard metadata 都从同一份归一化样式对象派生，避免视觉与语义出现分叉。

**Tech Stack:** Tampermonkey userscript、原生 DOM API、Playwright

---

## File Map

- Modify: `scripts/feishu-helper.user.js`
  - 增加块级样式归一化 helper
  - 在 `blockToHtml()` 中让 `callout`、`image`、`heading/text`、`quote_container` 消费统一样式对象
  - 让 `buildCalloutClipboardMetadata()` 复用归一化后的关键样式字段
  - 保持 `pasteIntoDoc()` / auto-dispatch 行为不退化
- Modify: `tests/feishu-helper-rich-clipboard.spec.js`
  - 增加“提取正确”测试
  - 增加“应用正确”测试
  - 增加 callout clipboard metadata 与 auto-dispatch 回归覆盖

## Task 1: 引入块级样式归一化层

**Files:**
- Modify: `scripts/feishu-helper.user.js`
- Test: `tests/feishu-helper-rich-clipboard.spec.js`

- [ ] **Step 1: 写失败测试，锁定结构化字段优先级**

```js
test('normalized block style extraction should prefer structured fields for block-level styles', async ({ page }) => {
  const result = await page.evaluate(() => {
    return {
      callout: window.__feishuNormalizeBlockStyle({
        type: 'callout',
        align: 'center',
        background_color: 'rgb(255,245,235)',
        border_color: 'rgb(254,212,164)',
        text_color: 'rgb(216,57,49)',
        emoji_id: 'memo',
      }),
      image: window.__feishuNormalizeBlockStyle({
        type: 'image',
        align: 'right',
      }),
      text: window.__feishuNormalizeBlockStyle({
        type: 'text',
        align: 'left',
        text_indent: '2em',
        background_color: 'rgb(242,243,245)',
        text_color: 'rgb(31,35,40)',
      }),
    };
  });

  expect(result.callout.backgroundColor).toBe('rgb(255,245,235)');
  expect(result.callout.borderColor).toBe('rgb(254,212,164)');
  expect(result.callout.textColor).toBe('rgb(216,57,49)');
  expect(result.callout.calloutEmojiId).toBe('memo');
  expect(result.image.imageAlign).toBe('right');
  expect(result.text.textIndent).toBe('2em');
});
```

- [ ] **Step 2: 运行单测并确认它因缺少 helper 而失败**

Run: `npx playwright test tests/feishu-helper-rich-clipboard.spec.js --grep "normalized block style extraction should prefer structured fields for block-level styles"`

Expected: FAIL，报错 `window.__feishuNormalizeBlockStyle is not a function` 或字段缺失。

- [ ] **Step 3: 写最小实现，新增归一化 helper 与调试导出**

```js
function normalizeBlockStyle(snap) {
  snap = snap || {};
  return {
    align: normalizeTextAlign(snap.align || ''),
    textIndent: normalizeCssLength(snap.text_indent || ''),
    textColor: normalizeCssColor(snap.text_color || ''),
    backgroundColor: normalizeCssColor(snap.background_color || ''),
    borderColor: normalizeCssColor(snap.border_color || ''),
    imageAlign: normalizeTextAlign(snap.align || ''),
    calloutEmojiId: String(snap.emoji_id || ''),
  };
}

window.__feishuNormalizeBlockStyle = normalizeBlockStyle;
```

- [ ] **Step 4: 重新运行单测并确认通过**

Run: `npx playwright test tests/feishu-helper-rich-clipboard.spec.js --grep "normalized block style extraction should prefer structured fields for block-level styles"`

Expected: PASS。

- [ ] **Step 5: 提交这一小步**

```bash
git add scripts/feishu-helper.user.js tests/feishu-helper-rich-clipboard.spec.js
git commit -m "test: add normalized block style extraction coverage"
```

## Task 2: 把归一化样式接入块级 HTML 渲染

**Files:**
- Modify: `scripts/feishu-helper.user.js`
- Test: `tests/feishu-helper-rich-clipboard.spec.js`

- [ ] **Step 1: 写失败测试，锁定 callout / image / text / quote 的样式应用**

```js
test('block renderer should apply normalized block styles to callout image text and quote blocks', async ({ page }) => {
  const result = await page.evaluate(() => {
    return {
      callout: window.__feishuBlockToHtml({
        type: 'callout',
        align: 'center',
        background_color: 'rgb(255,245,235)',
        border_color: 'rgb(254,212,164)',
        text_color: 'rgb(216,57,49)',
        emoji_id: 'memo',
      }, null, ['<p>内容</p>']),
      image: window.__feishuBlockToHtml({
        type: 'image',
        align: 'right',
        image: { token: 'demo', name: 'img' },
      }, null, []),
      text: window.__feishuBlockToHtml({
        type: 'text',
        align: 'center',
        text_indent: '2em',
        background_color: 'rgb(242,243,245)',
        text_color: 'rgb(31,35,40)',
        text: { initialAttributedTexts: { attribs: { '0': '' }, text: { '0': '段落' } }, apool: { numToAttrib: {} } },
      }, null, []),
      quote: window.__feishuBlockToHtml({
        type: 'quote_container',
        align: 'right',
        background_color: 'rgb(242,243,245)',
        text_color: 'rgb(87,96,106)',
      }, null, ['<p>引用</p>']),
    };
  });

  expect(result.callout).toContain('border:1px solid rgb(254,212,164);');
  expect(result.image).toContain('text-align:right;');
  expect(result.image).toContain('margin:0 0 0 auto;');
  expect(result.text).toContain('background-color:rgb(242,243,245);');
  expect(result.quote).toContain('text-align:right;');
});
```

- [ ] **Step 2: 运行单测并确认失败信息是样式未落到 HTML 上**

Run: `npx playwright test tests/feishu-helper-rich-clipboard.spec.js --grep "block renderer should apply normalized block styles to callout image text and quote blocks"`

Expected: FAIL，至少一个 `toContain(...)` 断言失败。

- [ ] **Step 3: 最小实现，统一让 `buildBlockStyle()` 与各块分支消费归一化结果**

```js
function buildBlockStyle(baseStyle, snap, extraStyle, normalizedStyle) {
  var style = mergeStyleStrings(baseStyle, extraStyle);
  var source = normalizedStyle || normalizeBlockStyle(snap);
  var dynamicStyle = styleObjectToString({
    'text-align': source.align,
    'text-indent': source.textIndent,
    'background-color': source.backgroundColor,
    color: source.textColor,
  });
  return mergeStyleStrings(style, dynamicStyle);
}

// callout/image/text/quote_container 分支都先拿 normalizedStyle 再渲染
```

- [ ] **Step 4: 重新运行单测并确认通过**

Run: `npx playwright test tests/feishu-helper-rich-clipboard.spec.js --grep "block renderer should apply normalized block styles to callout image text and quote blocks"`

Expected: PASS。

- [ ] **Step 5: 提交这一小步**

```bash
git add scripts/feishu-helper.user.js tests/feishu-helper-rich-clipboard.spec.js
git commit -m "feat: apply normalized styles to block rendering"
```

## Task 3: 把归一化样式接入 callout clipboard metadata 与一键粘贴路径

**Files:**
- Modify: `scripts/feishu-helper.user.js`
- Test: `tests/feishu-helper-rich-clipboard.spec.js`

- [ ] **Step 1: 写失败测试，锁定 callout metadata 与 auto-dispatch 不退化**

```js
test('callout clipboard html should include normalized style metadata and still auto-dispatch', async ({ page }) => {
  const result = await page.evaluate(() => {
    const callout = window.__feishuBlockToHtml({
      type: 'callout',
      background_color: 'rgb(255,245,235)',
      border_color: 'rgb(254,212,164)',
      text_color: 'rgb(216,57,49)',
      emoji_id: 'memo',
    }, null, ['<p>内容</p>']);
    const html = window.__feishuBuildClipboardHtml(callout);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const meta = JSON.parse(doc.querySelector('[data-meta-block-props]').getAttribute('data-meta-block-props'));
    return {
      shouldAutoDispatch: window.__feishuShouldAutoDispatchPastePayload({ text: '> [!NOTE]\n内容', html }),
      meta,
    };
  });

  expect(result.shouldAutoDispatch).toBe(true);
  expect(result.meta.props.data.borderColor).toBe('rgb(254,212,164)');
  expect(result.meta.props.data.textColor).toBe('rgb(216,57,49)');
});
```

- [ ] **Step 2: 运行单测并确认失败是 metadata 未完整复用归一化样式**

Run: `npx playwright test tests/feishu-helper-rich-clipboard.spec.js --grep "callout clipboard html should include normalized style metadata and still auto-dispatch"`

Expected: FAIL，缺字段或值不一致。

- [ ] **Step 3: 最小实现，让 `buildCalloutClipboardMetadata()` 从归一化样式取值**

```js
function buildCalloutClipboardMetadata(snap, normalizedStyle) {
  var style = normalizedStyle || normalizeBlockStyle(snap);
  return {
    // ...existing ids...
    metaBlockProps: JSON.stringify({
      blockType: 'CALLOUT_BLOCK',
      props: {
        data: {
          emojiId: style.calloutEmojiId,
          backgroundColor: style.backgroundColor,
          borderColor: style.borderColor,
          textColor: style.textColor,
          align: style.align,
        },
      },
    }),
  };
}
```

- [ ] **Step 4: 重新运行单测并确认通过**

Run: `npx playwright test tests/feishu-helper-rich-clipboard.spec.js --grep "callout clipboard html should include normalized style metadata and still auto-dispatch"`

Expected: PASS。

- [ ] **Step 5: 提交这一小步**

```bash
git add scripts/feishu-helper.user.js tests/feishu-helper-rich-clipboard.spec.js
git commit -m "feat: preserve normalized callout style metadata"
```

## Task 4: 回归验证与脚本同步

**Files:**
- Modify: `scripts/feishu-helper.user.js`
- Modify: `tests/feishu-helper-rich-clipboard.spec.js`

- [ ] **Step 1: 运行富剪贴板回归测试**

Run: `npx playwright test tests/feishu-helper-rich-clipboard.spec.js`

Expected: 全部 PASS，无新增失败。

- [ ] **Step 2: 如有失败，先修失败再重跑，直到稳定全绿**

Run: `npx playwright test tests/feishu-helper-rich-clipboard.spec.js --grep "callout|image|quote|normalized|pasteIntoDoc"`

Expected: 聚焦相关用例时也全部 PASS。

- [ ] **Step 3: 同步脚本到 Tampermonkey**

Run: `open -a "Google Chrome" && sleep 2 && npm run feishu:sync`

Expected: 输出包含 `"name": "飞书文档助手"` 与 `"version": "4.2.16"`。

- [ ] **Step 4: 做一次真实页面块级样式抽查**

Run: `npm run feishu:sync -- --url "https://bytedance.larkoffice.com/wiki/L8SqwUcokidergkU0FscC7t5n7e" --page-script 'return { hasDebugRichStyles: typeof window.__feishuDebugRichStyles, hasDebugExports: typeof window.__feishuDebugExports };'`

Expected: 至少确认 userscript 已挂载；若调试导出仍未稳定出现，记录为后续观测问题，不阻塞本轮样式修复交付。

- [ ] **Step 5: 提交这一小步**

```bash
git add scripts/feishu-helper.user.js tests/feishu-helper-rich-clipboard.spec.js
git commit -m "test: verify block style fidelity regressions"
```

## Self-Review

- Spec coverage: 已覆盖块级样式提取、HTML 应用、callout metadata、一键粘贴路径与回归验证。
- Placeholder scan: 无 `TODO` / `TBD` / “稍后实现” 类占位语句。
- Type consistency: 计划中统一使用 `normalizeBlockStyle()` / `buildCalloutClipboardMetadata()` / `buildBlockStyle()` 这组命名，没有前后漂移。
