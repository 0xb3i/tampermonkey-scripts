# tampermonkey-scripts

## 关键约束

- Tampermonkey 运行在隔离环境中，很多宿主页面或前端应用里的环境变量不能直接读取。
- 如果脚本逻辑依赖这些值，不要假设可以直接从运行时环境里拿到；应先把所需数据写入页面可访问的 DOM 缓存，再从 DOM 缓存中读取。
- 做功能设计时，优先考虑"油猴隔离环境 + 页面侧 DOM 可见数据"这条边界，不要把方案建立在 Node/构建时环境变量可直接透传到脚本的假设上。
- **不要通过 `window.__feishu*` 等 window 全局函数暴露接口**：AppleScript 的 `execute javascript` 运行在 Chrome isolated world，无法访问 Tampermonkey 注入的 window 属性。跨上下文通信必须通过 DOM 属性（`document.documentElement.setAttribute('data-feishu-*', ...)`) 或 DOM 事件（`document.dispatchEvent(new CustomEvent('feishu-xxx', {detail: ...}))`)。
- 当需要与外部工具/库协同时，优先通过 search 等方式查证真实 api 而不是臆测。

## 飞书文档 1:1 复刻

### 最终方案

整体流程：**提取 → 上传图片 → 替换 token → 粘贴**

1. **提取阶段**（`Cmd+Shift+D`，在源文档页面执行）
   - 通过 `structService.rootBlock` 遍历块树，生成 HTML + docxRecord
   - `convertImagesToBase64` 从 HTML 中解析 CDN 图片 URL，下载为 base64，构建 `tokenToBase64` 映射
   - `buildClipboardPayload` 直接遍历 `docxRecord.recordMap` 所有 key，收集全部图片块（含嵌套在 table_cell 中的）
   - 对 `tokenToBase64` 中找不到的图片 token（表格内图片），用 token 调 `/space/api/box/stream/download/preview/TOKEN/?preview_type=16` 下载
   - 结果存入 IndexedDB `pendingPaste`

2. **上传阶段**（`Cmd+Shift+P` 或 runner 自动触发，在目标文档页面执行）
   - `feishu-upload-pending-images` 事件从 IndexedDB 读取 `orderedImageBase64List`
   - 逐张上传到 `POST /space/api/box/stream/upload/all/?mount_point=docx_image&mount_node_token=OBJ_TOKEN`
   - 返回新 `file_token`，构建 `tokenMap`（oldToken → newToken）
   - 调 `replaceTokensInDocxRecord` 替换 docxRecord 中所有 `snapshot.image.token`
   - 更新 IndexedDB 中的 `pendingPaste.docxRecord`

3. **粘贴阶段**
   - `writeClipboardPayload` 写入 `docx/record` + `text/html` + `text/plain` 三种 MIME
   - 用户按 `Cmd+V`，飞书走 `docx/record` 路径创建所有块（含有效 token 的图片块）

### 踩过的坑

#### 图片上传 API

| 尝试 | 结果 |
|------|------|
| `mount_point=ccm_import` | 返回 code:4 "Forbidden" |
| `mount_point=docx/doc/explorer/ccm` | 均返回 Forbidden |
| **`mount_point=docx_image`** | **返回 code:0 + file_token** |

- `mount_node_token` 必须用 `obj_token`：wiki 页面不能直接用 URL 中的 token，需通过 `/space/api/wiki/v2/tree/get_node/` 解析
- `size` 参数必须与实际文件大小一致（否则返回 "size inconsistent"）
- 必须 Header：`biz-ua-type: Web`、`biz-scene: file_upload`
- Drive Media Upload API（`/open-apis/drive/v1/medias/upload_all`）在浏览器中 CORS 被阻止，不可用

#### 飞书粘贴路径优先级

当剪贴板同时有 `docx/record` + `text/html` 时，飞书**优先走 `docx/record`**，HTML 仅做 fallback。这意味着：
- 不能用"HTML 里放 base64 图片 + docxRecord 里不放图片"的策略——飞书走 docxRecord 路径，忽略 HTML 中的图片
- 必须在 docxRecord 中放入有效的图片 token，或者完全不写 docxRecord 强制走 HTML

#### HTML 粘贴路径的局限

纯 HTML 粘贴（不写 `docx/record`）可以插入图片，但：
- HTML paste handler 只为**顶层** `<img>` 创建图片块，嵌套在 grid/grid_column/callout/table 中的 `<img>` 被忽略
- 38 张图片的完整 base64 HTML 约 8.7MB，飞书粘贴处理器无法处理（改为 1x1 占位符后 ~95KB 可用）
- 结构还原度不如 docx/record（表格、多栏等复杂结构丢失）

→ 结论：**必须走 docx/record 路径**，把图片 token 替换为有效的再粘贴。

#### 表格内图片的提取问题

这是最隐蔽的坑，涉及两层问题：

**问题 1：图片块遍历遗漏**

`buildClipboardPayload` 中用 `snapshot.children` 递归遍历块树收集图片块，但 table → table_cell → image 的 children 链在某些情况下断裂，只找到 38/40 个图片块。

而 `replaceTokensInDocxRecord` 直接遍历 `Object.keys(recordMap)`，能找到全部 40 个。

**修复**：改为直接遍历 `recordMap` 所有 key，和 `replaceTokensInDocxRecord` 保持一致。

**问题 2：表格图片没有 base64**

`blockToHtml` → `buildTableMatrix` → `collectTableCellParts` 只提取文本内容，不生成 `<img>` 标签。因此表格内图片的 token 不出现在 HTML 中，`convertImagesToBase64` 的 `tokenToBase64` 里没有它们的 base64 映射。

**修复**：对 `orderedImageBase64List` 中 base64 为空的图片，用 token 直接调飞书内部下载 API：
- `/space/api/box/stream/download/all/?token=TOKEN` → 部分返回 404
- **`/space/api/box/stream/download/preview/TOKEN/?preview_type=16`** → 返回 200 + 图片数据

#### 其他踩坑

| 问题 | 解决方案 |
|------|---------|
| DOM 属性存不下大 base64（2-4MB 限制，38 张约 4-8MB） | 改用 IndexedDB `pendingPaste` 存储 |
| `replaceTokensInDocxRecord` 返回新对象但代码用了原始对象 | 修为 `pending.docxRecord = JSON.stringify(replacedRecord)` |
| 图片 URL regex 不匹配 `v2/cover/` 路径 | 修为 `(?:preview\/\|v2\/cover\/\|all\/)` |
| `effectiveDocxRecord` 回退到包含无效 token 的原始 docxRecord | 不再回退到 `content.docxRecord` |
| AppleScript JS 运行在 Chrome isolated world，无法访问 TM 上下文 | 通过 `data-feishu-*` DOM 属性桥接 |
| `runTampermonkeyAutomationActionInActiveChrome` 需 TM 已注入 | 先 `ensureInjectedScriptOnActiveChrome` |

### 飞书编辑器内部 API 参考

#### 剪贴板格式处理器

clipboard-service.instance.formats[0..5]：

| 索引 | format | 说明 |
|------|--------|------|
| 0 | `Files` | 截图、拖拽图片 |
| 1 | `docx/record` | 结构化复制/粘贴主路径 |
| 2 | `docx/text` | 纯文本结构化 |
| 3 | `text/html` | HTML 粘贴解析 |
| 4 | `text/plain` | 纯文本 + Markdown |
| 5 | `text/uri-list` | URL 列表 |

#### 图片上传 API

```
POST /space/api/box/stream/upload/all/
  ?name=image.png
  &size=<file_size>
  &mount_point=docx_image
  &mount_node_token=<obj_token>
  &push_open_history_record=0
Body: FormData { file: Blob }
Headers: biz-ua-type: Web, biz-scene: file_upload
返回: { code: 0, data: { file_token: "NEW_TOKEN" } }
```

#### Wiki obj_token 解析

```
POST /space/api/wiki/v2/tree/get_node/
Body: { token: "WIKI_TOKEN", obj_type: "wiki" }
返回: { data: { node: { obj_token: "REAL_DOCX_TOKEN" } } }
```

#### 图片下载 API

```
GET /space/api/box/stream/download/preview/TOKEN/?preview_type=16
GET /space/api/box/stream/download/all/?token=TOKEN
```

注意：部分 token 通过 `all/` 返回 404，但 `preview/` 可用。

## 测试约定

- **永远不要打开新标签页**，始终在当前标签页操作（通过 `set URL of active tab` 而非 `make new tab`）。
- 每次执行完脚本相关改动后，都要自动做一次验证，不要只看代码或只验证是否注入成功。
- 跑飞书全流程验证时，默认使用下面这条命令。

```bash
node scripts/feishu-helper-profile-runner.js \
  --attach-active-chrome \
  --sync-tampermonkey \
  --validate-native-paste \
  --script-path scripts/feishu-helper.user.js \
  --source-url "https://bytedance.larkoffice.com/docx/EdpId2k96o7tFzxZVb8cF8QInVh" \
  --target-url "https://bytedance.larkoffice.com/wiki/DDCSwoAkpiNHS2ke8ebcnqjknkf"
```

- 测试目标不是"看起来能跑"，而是尽量做到对 source 页面内容的 1:1 复刻。

## 交付约定

- 如果改动属于较大的功能更新，整理成清晰的独立 `git commit`，便于后续推送和前端对接。
- 如果用户在当前任务中明确要求推送，再执行远端推送；否则至少保证本地改动和 commit 边界清晰。
