# tampermonkey-scripts

油猴脚本集合，提升网页浏览体验。

## 脚本列表

### 复制净化器

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

### 飞书文档助手

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
- 图片右键菜单 → 在图片上优先拦住飞书监听，恢复浏览器原生图片菜单，可直接使用“复制图片”
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
3. 在新文档页面按 `Cmd+Shift+P` 写入混合剪贴板（同时包含 `text/html` 与 `text/plain`）
4. 按 `Cmd+V` 粘贴

粘贴策略：
- 图片、标题、列表、表格等优先走精简 HTML 结构
- LaTeX 公式在 HTML 中保留原始 `$...$` 文本，而不是渲染后的数学 DOM，尽量维持和 Markdown 一样的稳定性
- 同时保留 `text/plain` 兜底，避免目标编辑器不接受 HTML 时丢失内容

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

### 油猴脚本自动同步 / 自动化测试

仓库里的 `scripts/feishu-helper-profile-runner.js` 现在已经抽成了通用的 Tampermonkey 同步器：

- 读取任意 `.user.js` 的 `@name` / `@version`
- 自动接管当前已登录的 Chrome 活跃标签页
- 打开 Tampermonkey `utilities` 导入页并重新安装脚本
- 自动跳到脚本编辑页，确认最新版本已经生效
- 可选触发脚本自带的自动化 action，验证真实效果而不是只验证注入成功

#### 通用命令

```bash
npm run tm:sync -- --script-path scripts/copy-cleaner.user.js
```

把本地脚本同步到当前登录态 Chrome 的 Tampermonkey。

```bash
npm run tm:action -- --script-path scripts/feishu-helper.user.js --url "https://bytedance.feishu.cn/docx/..."
```

同步后自动刷新目标页，并调用脚本声明的默认自动化 action。

#### Feishu 一键真实测试

```bash
npm run feishu:real-test -- "https://bytedance.feishu.cn/docx/..."
```

这条命令会执行：本地脚本同步 → Tampermonkey 重装 → 刷新目标文档 → 触发自动化提取 → 输出块数、公式数、图片数、缓存粘贴内容等真实指标。

#### 自定义页面动作（适合 `copy-cleaner` 这类非飞书脚本）

如果脚本没有内建 automation action，也可以自己指定目标 URL，并注入一段页面脚本作为“预期行为”。runner 会在页面加载完成后执行这段脚本，并把返回结果打印出来。

例如给 `copy-cleaner` 做“点击复制按钮后读取剪贴板”的观测：

```bash
node scripts/feishu-helper-profile-runner.js \
  --attach-active-chrome \
  --sync-tampermonkey \
  --script-path scripts/copy-cleaner.user.js \
  --url "file:///ABSOLUTE/PATH/tests/fixtures/ai-chat.html" \
  --page-script-file /ABSOLUTE/PATH/tmp/copy-cleaner-click.js
```

`copy-cleaner-click.js` 可以这样写：

```js
await navigator.clipboard.writeText('');
document.querySelector('#msg1 .copy-btn').click();
await new Promise((resolve) => setTimeout(resolve, 300));
return {
  clipboardText: await navigator.clipboard.readText(),
  buttonText: document.querySelector('#msg1 .copy-btn').textContent,
};
```

如果你想验证“局部选中后按复制快捷键”，也可以把行为写进同一个脚本：

```js
const content = document.querySelector('#msg1 .content');
const range = document.createRange();
range.selectNodeContents(content);
const selection = window.getSelection();
selection.removeAllRanges();
selection.addRange(range);
document.dispatchEvent(new KeyboardEvent('keydown', {
  key: 'c',
  ctrlKey: true,
  metaKey: true,
  bubbles: true,
}));
await new Promise((resolve) => setTimeout(resolve, 300));
return {
  clipboardText: await navigator.clipboard.readText(),
  selectedText: selection.toString(),
};
```

也支持直接内联：

```bash
node scripts/feishu-helper-profile-runner.js \
  --attach-active-chrome \
  --script-path scripts/copy-cleaner.user.js \
  --url "https://example.com" \
  --page-script "return { title: document.title };"
```

#### 让别的脚本复用这套自动化逻辑

只需要在脚本里暴露统一探针：

```js
window.__tampermonkeyScriptDebugExports = function () {
  return {
    name: '脚本名',
    version: '1.0.0',
    automation: null,
    exports: {
      example: typeof window.__example,
    },
  };
};
```

如果脚本还希望支持“真实动作测试”，再额外声明 automation contract：

```js
window.__tampermonkeyScriptDebugExports = function () {
  return {
    name: '脚本名',
    version: '1.0.0',
    automation: {
      requestEvent: 'my-script:automation-request',
      resultEvent: 'my-script:automation-result',
      defaultAction: 'runPrimaryAction',
      actions: ['runPrimaryAction'],
    },
    exports: {
      example: typeof window.__example,
    },
  };
};
```

runner 会优先调用 `--probe-function` 指定的函数；未指定时默认查找 `window.__tampermonkeyScriptDebugExports()`，并兼容旧的 `window.__feishuDebugExports()`。

#### 常用参数

- `--script-path`：要同步的本地 `.user.js` 文件
- `--url`：同步后要验证的目标页面
- `--probe-function`：自定义探针函数名
- `--action`：指定自动化 action 名称；不传时使用脚本声明的 `defaultAction`
- `--page-script`：直接内联一段页面脚本，执行后返回结果
- `--page-script-file`：从文件读取页面脚本，适合复杂点击/选区/剪贴板场景
- `--attach-active-chrome`：复用当前前台 Chrome 登录态
- `--sync-tampermonkey`：把本地脚本更新进 Tampermonkey
- `--real-test`：执行脚本声明的默认自动化 action

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
