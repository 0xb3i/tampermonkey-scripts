# Tampermonkey Scripts

当前维护两个可直接安装的用户脚本：

| 脚本 | 版本 | 作用 |
| --- | --- | --- |
| [复制净化器](userscripts/copy-cleaner.user.js) | 5.2.0 | 清理复制内容中的格式噪音，将网页公式和结构化内容转换成稳定 Markdown |
| [Tap To Tab](userscripts/tap-to-tab.user.js) | 0.4.1 | 短按链接正常跳转，按住链接后松开可在新标签页打开 |

## 脚本说明

### 复制净化器

- 还原 KaTeX、MathJax 公式为 LaTeX。
- 保留标题、列表、表格、引用、代码块、链接和图片等 Markdown 结构。
- 统一行内公式间距、嵌套列表四空格缩进和表格后的空行。
- 支持页面选区、Clipboard API，以及 ChatGPT、Gemini、AI Studio、Tika 的复制按钮。

安装：将 [userscripts/copy-cleaner.user.js](userscripts/copy-cleaner.user.js) 导入 Tampermonkey。

### Tap To Tab

- 普通短按不被拦截，保持网页原生跳转速度。
- 鼠标左键按住普通链接约 300ms，出现蓝色轮廓后松开，即在新标签页打开。
- 蓝框出现前允许 96px 漂移，避免触控板抖动打断计时；蓝框出现后移动超过 32px 仍会取消。
- 修饰键点击、下载链接、非 `_self` 链接、页内锚点和编辑区域保持原行为。

安装：将 [userscripts/tap-to-tab.user.js](userscripts/tap-to-tab.user.js) 导入 Tampermonkey。

## 目录

- `userscripts/`：可直接安装的用户脚本。
- `tests/`：不依赖浏览器的 Node.js 单元与仓库契约测试。

## 开发与验证

要求 Node.js 20 或更高版本。

```bash
npm test
```

## 同步与浏览器验证

仓库不再提供浏览器控制、脚本同步 CLI 或 Node API。需要更新 Tampermonkey 或验证真实网页时，在 Codex 中明确要求使用 **Chrome DevTools MCP** 操作当前 Chrome。

推荐请求方式：

```text
使用 Chrome DevTools MCP，将 userscripts/tap-to-tab.user.js 更新到当前 Chrome 的 Tampermonkey，并校验版本、启用状态和源码哈希。
```

同步完成后应确认 Tampermonkey 中的脚本版本与本地 `@version` 一致、脚本处于启用状态、编辑器源码哈希与本地文件一致，并刷新需要加载新版本的现有网页。
