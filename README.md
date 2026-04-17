# tampermonkey-scripts

油猴脚本集合，提升网页浏览体验。

## 脚本列表

### 复制净化器 (Copy Cleaner)

复制时自动清理 AI 生成内容中的格式噪音，并将数学公式提取为 LaTeX 源码。

**安装：** 将 [scripts/copy-cleaner.user.js](scripts/copy-cleaner.user.js) 的内容添加到 Tampermonkey 新脚本中。

#### 功能

| 功能 | 示例输入 | 输出 |
|------|---------|------|
| 去除加粗标记 `**` | `**深度学习**是...` | `深度学习是...` |
| 去除中文括号注释 `（）` | `AI（人工智能）是...` | `AI是...` |
| 去除中英文引号 `""''""''` | `"深度学习"是...` | `深度学习是...` |
| 数学公式提取为 LaTeX | 渲染后的 ∇θ logπθ | `$\nabla_\theta \log \pi_\theta$` |
| 飞书空格兼容 | `公式$x^2$在这里` | `公式 $x^2$ 在这里` |

#### LaTeX 公式提取

从 AI 网页中复制数学公式时，浏览器默认复制渲染后的 Unicode 乱码。本脚本从 DOM 中提取底层 LaTeX 源码，用 `$...$`（行内）和 `$$...$$`（整行）包裹，粘贴到飞书等支持 LaTeX 的编辑器可直接渲染。

支持的渲染引擎：
- **KaTeX**（ChatGPT、Claude 等）— monkey-patch `katex.render` 存入 `data-latex` 属性
- **MathJax 2** — 从 `script[type="math/tex"]` 提取
- **MathJax 3** — 从 `mjx-container > math > annotation` 提取
- **MutationObserver 兜底** — 对已渲染的 `.katex` 元素自动补注 `data-latex`

#### 拦截机制

```
┌──────────────────────────────────────────────────────────────┐
│  第1层: keydown 监听 Ctrl+C / Cmd+C                          │
│  键盘事件阶段直接拦截，调用 navigator.clipboard.writeText      │
├──────────────────────────────────────────────────────────────┤
│  第2层: copy 事件 (capture phase)                             │
│  e.stopImmediatePropagation() 阻止其他 handler 覆盖          │
├──────────────────────────────────────────────────────────────┤
│  第3层: Clipboard.prototype.writeText / write patch           │
│  覆盖网站自带复制按钮                                         │
└──────────────────────────────────────────────────────────────┘
```

#### LaTeX 空格保护

`cleanText` 会自动将文本按 `$...$` / `$$...$$` 分段处理，只对非 LaTeX 部分做净化，LaTeX 内部的括号和符号完整保留。同时在 LaTeX 与相邻文本/标点之间自动插入空格，确保飞书等平台能正确渲染。

---

### 飞书文档助手 (Feishu Helper)

解除飞书文档复制限制，批量提取文档中的所有图片。

**安装：** 将 [scripts/feishu-helper.user.js](scripts/feishu-helper.user.js) 的内容添加到 Tampermonkey 新脚本中。

**适用页面：** `feishu.cn` 和 `larksuite.com` 下的所有页面

#### 功能

**1. 自动解除复制限制**

脚本在页面加载时自动运行，持续 30 秒加固，覆盖以下限制：
- 禁止选中文本 → 强制 `user-select: text`
- 禁止右键菜单 → 拦截 `contextmenu` 事件
- 禁止 Ctrl+C / Ctrl+A → 拦截 `keydown` 事件
- 透明遮罩层 → 自动隐藏
- 同源 iframe → 递归处理

**2. 批量提取图片**

快捷键 `Cmd+Shift+I` 打开图片提取面板：

- 自动扫描页面中所有 `<img>`、`background-image`、SVG `<image>` 元素
- 弹出面板展示所有图片缩略图和尺寸
- 支持单张下载或一键全部下载
- 去重处理，避免重复图片

---

## 开发

### 安装依赖

```bash
npm install
```

### 运行测试

```bash
npm test
```

### 测试结构

```
tests/
├── copy-cleaner.spec.js          # 单元测试：cleanText 逻辑、copy 事件
├── e2e-copy-cleaner.spec.js      # E2E 测试：模拟 AI 网站完整复制流程
├── latex-extraction.spec.js      # LaTeX 提取测试：KaTeX/MathJax DOM 解析
└── fixtures/
    ├── ai-chat.html              # 模拟 AI 聊天页面
    └── ai-chat-math.html         # 含 KaTeX 数学公式的模拟页面
```

测试使用 Playwright + `context.addInitScript()` 注入脚本，等价于 Tampermonkey 的 `@run-at document-start` 行为，无需手动安装脚本即可验证。

## License

MIT
