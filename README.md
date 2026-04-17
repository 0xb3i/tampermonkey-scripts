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

解除飞书文档复制限制，提取完整文档内容（含 LaTeX 公式），批量提取图片，创建文档副本。

**安装：** 将 [scripts/feishu-helper.user.js](scripts/feishu-helper.user.js) 的内容添加到 Tampermonkey 新脚本中。

**适用页面：** `feishu.cn`、`larksuite.com`、`larkoffice.com` 下的所有页面

#### 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Cmd+Shift+D` | 创建文档副本（提取完整内容到剪贴板） |
| `Cmd+Shift+P` | 粘贴副本到新文档 |
| `Cmd+Shift+I` | 提取页面图片 |

#### 功能

**1. 自动解除复制限制**

脚本在页面加载时自动运行，持续 15 秒加固，覆盖以下限制：
- 禁止选中文本 → 强制 `user-select: text`
- 禁止右键菜单 → 拦截 `contextmenu` 事件
- 禁止 Ctrl+C / Ctrl+A → 拦截 `keydown` 事件
- 透明遮罩层 → 自动隐藏
- 同源 iframe → 递归处理

**2. 创建文档副本**

通过 React Fiber 链访问飞书内部 `structService.rootBlock`，直接从数据层提取完整文档内容，绕过虚拟滚动限制。

提取内容包括：
- 完整文本（不受虚拟滚动影响，获取全部内容块）
- LaTeX 公式（从 `apool.numToAttrib` 解码，输出 `$...$` / `$$...$$` 格式）
- 富文本属性（加粗、斜体、删除线、行内代码、链接等转为 Markdown）
- 文档结构（标题、列表、引用、代码块、分割线等转为 HTML/Markdown）

使用流程：
1. 在源文档页面按 `Cmd+Shift+D` 提取内容
2. 手动新建一个飞书文档
3. 在新文档页面按 `Cmd+Shift+P` 写入剪贴板
4. 按 `Cmd+V` 粘贴

**3. 批量提取图片**

快捷键 `Cmd+Shift+I` 打开图片提取面板：

- 自动扫描页面中所有 `<img>`、`background-image` 元素
- 弹出面板展示所有图片缩略图和尺寸
- 支持单张下载或一键全部下载
- 去重处理，避免重复图片

#### 技术细节：飞书文档数据提取

飞书文档使用虚拟滚动，DOM 中只保留当前视口附近的内容，无法通过滚动加载获取完整文档。本脚本通过以下方式绕过：

1. **React Fiber 访问**：通过 `__reactFiber$` 键遍历组件树，找到 `editorAPI.structService`
2. **rootBlock 遍历**：`structService.rootBlock.children` 包含文档的所有内容块（不受虚拟滚动影响）
3. **文本编码解码**：飞书使用自定义的 `attribs + apool` 编码格式，`*N` 表示应用属性 N，`+M` 表示接下来 M 个字符
4. **LaTeX 提取**：行内公式以 `["equation", "latex_code"]` 属性存储在 `apool.numToAttrib` 中

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
