# tampermonkey-scripts

油猴脚本集合，提升网页浏览体验。

## 脚本列表

### 飞书文档助手

解除飞书文档复制限制，1:1 复刻飞书文档（含图片、表格、公式、callout 等完整结构）。

**安装：** 将 [scripts/feishu-helper.user.js](scripts/feishu-helper.user.js) 的内容添加到 Tampermonkey 新脚本中。

**适用页面：** `feishu.cn`、`larksuite.com`、`larkoffice.com` 下的所有页面

#### 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Cmd+Shift+D` | 在源文档页面提取完整内容（含图片 base64） |
| `Cmd+Shift+P` | 在目标文档页面粘贴副本（自动上传图片到目标文档） |
| `Cmd+Shift+I` | 提取页面图片（弹出图片面板） |

#### 文档 1:1 复刻流程

1. 在源文档页面按 `Cmd+Shift+D` 提取内容
2. 打开目标飞书文档
3. 在目标文档页面按 `Cmd+Shift+P`，脚本会自动：
   - 上传所有图片到目标文档（通过飞书内部 API）
   - 用新 token 替换 docxRecord 中的旧 token
   - 写入剪贴板（`docx/record` + `text/html` + `text/plain`）
4. 按 `Cmd+V` 粘贴

**支持的完整结构**：标题、正文、列表、表格（含表格内图片）、grid 多栏、callout、引用、代码块、分割线、书签、公式等。

#### 图片复刻原理

飞书文档的图片 token 是文档绑定的，直接粘贴源文档的 docxRecord 会导致图片全部丢失。解决方案：

1. 提取阶段：从 HTML 和 docxRecord 中收集所有图片的 base64 数据
2. 上传阶段：通过 `POST /space/api/box/stream/upload/all/?mount_point=docx_image` 将图片上传到目标文档，获取新的 file_token
3. 替换阶段：将 docxRecord 中的旧 token 替换为新 token
4. 粘贴阶段：写入包含有效 token 的完整 docxRecord，飞书粘贴解析器正常创建图片块

**表格内图片的特殊处理**：表格内的图片不会出现在 `blockToHtml` 生成的 HTML 中（`collectTableCellParts` 只提取文本），因此无法通过 HTML 中的 CDN URL 获取 base64。修复方式是直接遍历 `docxRecord.recordMap` 中所有图片块，对缺少 base64 的图片用 token 调 `/space/api/box/stream/download/preview/TOKEN` 下载。

#### 自动解除复制限制

脚本在页面加载时自动运行，覆盖以下限制：
- 禁止选中文本 → 强制 `user-select: text`
- 禁止右键菜单 → 拦截 `contextmenu` 事件
- 图片右键菜单 → 恢复浏览器原生图片菜单
- 禁止 Ctrl+C / Ctrl+A → 拦截 `keydown` 事件
- 透明遮罩层 → 自动隐藏

---

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

### 一键同步 + 验证

将本地脚本同步到 Chrome Tampermonkey，并在目标页面验证效果：

```bash
# 同步飞书文档助手脚本
npm run tm:sync -- --script-path scripts/feishu-helper.user.js

# 同步后自动验证
npm run tm:action -- --script-path scripts/feishu-helper.user.js --url "https://xxx.larkoffice.com/docx/..."
```

### 飞书文档 1:1 复刻自动化测试

```bash
node scripts/feishu-helper-profile-runner.js \
  --attach-active-chrome \
  --sync-tampermonkey \
  --validate-native-paste \
  --script-path scripts/feishu-helper.user.js \
  --source-url "https://xxx.larkoffice.com/docx/SOURCE_DOC_ID" \
  --target-url "https://xxx.larkoffice.com/wiki/TARGET_DOC_ID"
```

该命令自动执行：脚本同步 → 源文档提取 → 图片上传到目标文档 → token 替换 → 粘贴 → 验证结果。

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

## License

MIT
