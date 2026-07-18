# Tampermonkey Scripts

当前维护两个可直接安装的用户脚本：

| 脚本 | 版本 | 作用 |
| --- | --- | --- |
| [复制净化器](userscripts/copy-cleaner.user.js) | 5.2.0 | 清理复制内容中的格式噪音，将网页公式和结构化内容转换成稳定 Markdown |
| [Tap To Tab](userscripts/tap-to-tab.user.js) | 0.3.0 | 短按链接正常跳转，按住链接后松开可在新标签页打开 |

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
- 移动超过 16px 才会取消长按，小幅触控板漂移和误触发的拖拽不会中断识别。
- 修饰键点击、下载链接、非 `_self` 链接、页内锚点和编辑区域保持原行为。

安装：将 [userscripts/tap-to-tab.user.js](userscripts/tap-to-tab.user.js) 导入 Tampermonkey。

## 目录

- `userscripts/`：可直接安装的用户脚本。
- `automation/`：复制净化器的真实浏览器验证与稳定用例。
- `lib/`：CDP、脚本同步和 CLI 公共能力。
- `bin/`：命令行入口。
- `tests/`：Node.js 单元与契约测试。

## 开发与验证

要求 Node.js 20 或更高版本。

```bash
npm install
npm test
```

真实站点验证需要一个已登录、开启 CDP `9222` 端口的 Chrome：

```bash
curl -s http://127.0.0.1:9222/json/version
npm run copycleaner:all
```

也可以只验证单个站点：

```bash
npm run copycleaner:chatgpt
npm run copycleaner:gemini
npm run copycleaner:aistudio
npm run copycleaner:tika
```

## 同步到 Tampermonkey

```bash
npm run tampermonkey:sync -- --script-path userscripts/copy-cleaner.user.js
npm run tampermonkey:sync -- --script-path userscripts/tap-to-tab.user.js
```

Node API：

```js
const { syncUserscriptToTampermonkey } = require('./index.js');

await syncUserscriptToTampermonkey({
  scriptPath: './userscripts/copy-cleaner.user.js',
  cdpUrl: 'http://127.0.0.1:9222',
});
```
