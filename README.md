# tampermonkey-scripts

油猴脚本集合，提升网页浏览体验。

## 脚本列表

### 飞书文档助手

解除飞书文档复制限制，1:1 复刻飞书文档。允许在无复制权限页面中右键复制图片。

**安装：** 将 [scripts/feishu-helper.user.js](scripts/feishu-helper.user.js) 的内容添加到 Tampermonkey 新脚本中。

**适用页面：** `feishu.cn`、`larksuite.com`、`larkoffice.com` 下的所有页面

#### 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Cmd+Shift+D` | 在源文档页面提取完整内容 |
| `Cmd+Shift+P` | 在目标文档页面粘贴副本 |
| `Cmd+Shift+I` | 提取页面所有图片 |

#### 操作流程

1. 在源文档页面按 `Cmd+Shift+D` 提取内容
2. 打开目标飞书文档
3. 在目标文档页面按 `Cmd+Shift+P`，脚本会自动：
   - 上传所有图片到目标文档（通过飞书内部 API）
   - 用新 token 替换 docxRecord 中的旧 token
   - 写入剪贴板（`docx/record` + `text/html` + `text/plain`）
4. 按 `Cmd+V` 粘贴

**支持的完整结构**：标题、正文、列表、表格、grid 多栏、callout、引用、代码块、分割线、书签、公式等。

#### 图片复制原理

飞书文档的图片 token 是文档绑定的，直接粘贴源文档的 docxRecord 会导致图片全部丢失。解决方案：

1. 提取阶段：从 HTML 和 docxRecord 中收集所有图片的 base64 数据
2. 上传阶段：先解析目标 wiki/doc 的真实 `obj_token`，再通过 `POST /space/api/box/stream/upload/all/?mount_point=docx_image` 将图片上传到目标文档，获取新的 `file_token`
3. 替换阶段：将 docxRecord 中的旧 token 替换为新 token
4. 粘贴阶段：写入包含有效 token 的完整 docxRecord，飞书粘贴解析器会创建图片块

**表格内图片的特殊处理**：表格内的图片不会出现在 `blockToHtml` 生成的 HTML 中，因此无法通过 HTML 中的 CDN URL 获取 base64。修复方式是直接遍历 `docxRecord.recordMap` 中所有图片块，对缺少 base64 的图片用 token 调取 `/space/api/box/stream/download/preview/TOKEN` 下载。

**wiki 页面注意事项**：`mount_node_token` 不能直接使用 URL 里的 wiki token。当前在 `my.feishu.cn` 上需要通过 `GET /space/api/wiki/v2/tree/get_node/?wiki_token=...&expand_shortcut=true&with_deleted=true` 解析真实 `obj_token`，否则上传会返回 `mount node not exist`，最终表现为“上传了 0 张图片”。

---

### 复制净化器

复制时自动清理 AI 生成内容中的格式噪音，并将网页前端复制数学公式得到的 Unicode 乱码转化为 LaTeX 格式。

**安装：** 将 [scripts/copy-cleaner.user.js](scripts/copy-cleaner.user.js) 的内容添加到 Tampermonkey 新脚本中。

#### 功能

| 功能 | 示例输入 | 输出 |
|------|---------|------|
| 去除加粗标记 `**` | `**深度学习**是...` | `深度学习是...` |
| 去除中文括号注释 `（）` | `AI（人工智能）是...` | `AI是...` |
| 去除中英文引号 `""''""''` | `"深度学习"是...` | `深度学习是...` |
| 数学公式提取为 LaTeX | 渲染后的 ∇θ logπθ | `$\nabla_\theta \log \pi_\theta$` |
| 飞书空格兼容 | `公式$x^2$在这里` | `公式 $x^2$ 在这里` |

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

### 自动化调试

推荐通过已登录浏览器 + `agent-browser` 直接复现整条链路：

```bash
agent-browser connect 9222
```

建议流程：

- 在当前标签页打开源文档，执行 `Cmd+Shift+D`
- 切到目标文档，执行 `Cmd+Shift+P`
- 再执行 `Cmd+V`，观察 `data-feishu-upload-result`、`data-feishu-upload-progress` 等 DOM 状态
- 需要深挖时，使用 `agent-browser eval` 直接读取 `IndexedDB pendingPaste`、`window.__tampermonkeyScriptDebugExports()` 或触发 `feishu-upload-pending-images`

### 历史 runner

仓库里仍保留 `scripts/feishu-helper-profile-runner.js` 作为历史实验脚本，但当前推荐方案已经切换到 `agent-browser` 驱动；涉及文档同步、真实页面排障时，优先走 `agent-browser`。

```bash
node scripts/feishu-helper-profile-runner.js \
  --attach-active-chrome \
  --sync-tampermonkey \
  --validate-native-paste \
  --script-path scripts/feishu-helper.user.js \
  --source-url "https://xxx.larkoffice.com/docx/SOURCE_DOC_ID" \
  --target-url "https://xxx.larkoffice.com/wiki/TARGET_DOC_ID"
```

### 通用参数

- `--script-path`：要同步的本地 `.user.js` 文件
- `--url`：同步后要验证的目标页面
- `--attach-active-chrome`：复用当前前台 Chrome 登录态
- `--sync-tampermonkey`：把本地脚本更新进 Tampermonkey
- `--validate-native-paste`：执行完整的提取→上传→粘贴验证流程
- `--source-url`：源文档 URL（用于 `--validate-native-paste`）
- `--target-url`：目标文档 URL（用于 `--validate-native-paste`）
- `--page-script`：内联页面脚本，执行后返回结果
- `--page-script-file`：从文件读取页面脚本

### `agent-browser` 常用检查点

- `data-feishu-upload-result`：上传结果摘要
- `data-feishu-upload-progress`：逐张上传进度
- `data-feishu-token-replace-debug`：docxRecord token 替换情况
- IndexedDB `__feishu_helper_db__ / paste / pending`：提取阶段保存的待粘贴数据

## License

MIT
