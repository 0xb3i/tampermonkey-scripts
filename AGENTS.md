# tampermonkey-scripts

## 关键约束

- Tampermonkey 运行在隔离环境中，很多宿主页面或前端应用里的环境变量不能直接读取。
- 如果脚本逻辑依赖这些值，不要假设可以直接从运行时环境里拿到；应先把所需数据写入页面可访问的 DOM 缓存，再从 DOM 缓存中读取。
- 做功能设计时，优先考虑“油猴隔离环境 + 页面侧 DOM 可见数据”这条边界，不要把方案建立在 Node/构建时环境变量可直接透传到脚本的假设上。
- 当你在反复试错中得到重要经验、踩坑结论、可复用方案或明确不可行的架构时，要及时更新 `AGENTS.md`，把这些项目记忆沉淀下来。
- 当前关于飞书图片复制的已知经验：纯 `HTML + base64` 可以插入图片，但整体结构还原度不够；纯 `docx/record` 能最大程度保持 1:1 结构，但图片 token 不能直接跨文档复用。
- 当前默认思路：非图片内容优先走飞书结构化链路；图片优先做目标侧可落地处理，必要时只对图片块降级，避免整篇文档退化成纯 HTML 粘贴。
- 当需要与外部工具/库协同时，优先通过 search 等方式查证真实 api 而不是臆测。

## 飞书编辑器内部 API 探索记录

### 剪贴板服务 (clipboard-service) 格式处理器

通过 `editorAPI._renderer.injectionService.rootInjector._instanceMap` 可访问全部服务。
clipboard-service.instance 有 6 个格式处理器 (formats[0..5])：

| 索引 | format | 特殊属性 | 说明 |
|------|--------|----------|------|
| 0 | `Files` | - | 处理文件粘贴（截图、拖拽图片） |
| 1 | `docx/record` | `getCopyPayload()` | 结构化数据复制/粘贴主路径 |
| 2 | `docx/text` | - | 纯文本结构化 |
| 3 | `text/html` | `blockBuilder`, `htmlBuilder`, `key="pasting"` | HTML 粘贴解析，将 HTML 转飞书块 |
| 4 | `text/plain` | `markdownParser` | 纯文本 + Markdown 解析 |
| 5 | `text/uri-list` | `markdownParser` | URL 列表解析 |

**关键发现**：当剪贴板同时有 `docx/record` + `text/html` 时，Feishu 优先走 `docx/record` 创建块，HTML 仅做 fallback。这意味着如果把图片从 docxRecord 中移除（降级策略），即使 HTML 里包含 base64 `<img>`，也不会被处理——因为 docx/record 路径已经接管了粘贴流程，但图片记录已被删除。

### 图片管理服务 (image-manager)

- `image-manager.externalSaver`：图片上传管线
  - `taskMap`：上传任务追踪
  - `uploadingSet`：正在上传的图片集合
  - `imageCodeToRecordIdMap`：imageCode → recordId 映射
  - `handleSaveSuccess` / `handleSaveFailed`：上传回调
  - `poll`：轮询上传状态
- `image-manager.imageFetcher`：图片下载/加载
  - `fetch`、`load`、`fetchCdnInfos`
  - `instance.resTaskCreator.imgMimeTypeCache`：MIME 类型缓存
- `image-manager.docxSignalService`：信号服务
  - `mobileImageAddSignal`：移动端添加图片信号（可能可用于程序化插入图片）
  - `mobileImageDeleteSignal`：删除图片信号

### 注入器 Map 的访问方式

- `feishu-resolve-path` 事件通过点号路径解析（`obj[key]`），对 Map 对象返回 null。
- `feishu-inspect-path` 事件使用 `summarizeObjectValue`，内部通过 `safeGetOwnKeys` 处理了 Map/Set，可正确列出 Map 的 key。
- 因此查 Map 内部结构时必须用 `feishu-inspect-path`，不要用 `feishu-resolve-path`。

### 已验证的失败路径

1. **同时写 docx/record + HTML(base64 图片)**：Feishu 走 docx/record 路径，忽略 HTML 中的 base64 图片。结果：文本结构完整，但图片块为 0。**已修复**：有降级图片时不再写 docx/record，强制走 HTML 路径。
2. **data-feishu-downgraded-images 标记被 HTML 消毒器剥离**：已修复，添加到 `preservedDataAttrs` 白名单。
3. **从 AppleScript JS 上下文调用 TM 脚本的 window.__feishu* 函数**：AppleScript JS 运行在 Chrome isolated world，无法访问 TM 上下文中的 React fiber 属性，必须通过 DOM 属性（`data-feishu-*`）桥接。
4. **runTampermonkeyAutomationActionInActiveChrome** 要求当前标签页已经加载了 TM 脚本，如果标签页刚切换过来可能 TM 还未注入，会报 "Userscript debug exports are unavailable"。需要先 ensureInjectedScriptOnActiveChrome。
5. **Drive Media Upload API（/open-apis/drive/v1/medias/upload_all）从浏览器不可用**：该端点在浏览器中 CORS 被阻止，fetch 返回 "Failed to fetch"。内部 /pre_upload 路径需要正确的 API gateway base URL（尝试 20+ 种路径组合均 404）。该方案需要 OAuth2 access_token，油猴脚本无法获取。
6. **只按 Cmd+V 粘贴降级图片内容**：Cmd+V 只能触发飞书的 Files handler 或 HTML paste handler，图片只会变成占位块而非真实图片。需要 Cmd+Shift+P（触发 TM 脚本写入剪贴板）+ Cmd+V（实际粘贴）的组合。
7. **Chrome 远程调试端口**：Chrome 147+ 要求 `--user-data-dir` 参数才能启用 `--remote-debugging-port`，否则端口不监听。使用默认 profile 的 Chrome 无法直接开启调试端口。
8. **注入器 Map 的 get() 方法**：`rootInjector.get()` 和 `injectionService.get()` 都找不到 image-manager 等服务（返回 "No providers are found"）。必须通过 `_instanceMap.forEach()` 遍历 Map 条目才能按 key 名称匹配获取服务实例。
9. **DOM 属性存储大 base64 数据**：`document.documentElement.setAttribute()` 有大小限制（约 2-4MB），38 张 base64 图片（约 4-8MB）无法存入 DOM 属性。改用 IndexedDB（`pendingPaste`）存储。
10. **HTML 粘贴路径剪贴板过大**：38 张图片的完整 base64 嵌入 HTML 后约 8.7MB，Feishu 粘贴处理器无法处理，结果只有 1 个 text 块。改用 1x1 像素占位符替代，HTML 缩小到 ~95KB。
11. **HTML 粘贴路径无法创建嵌套结构中的图片块**：HTML paste handler 只为顶层 `<img>` 创建图片块，嵌套在 grid/grid_column/callout/table 中的 `<img>` 被忽略。测试结果：source 40 图片 → target 3-4 图片（仅顶层）。
12. **docxRecord 中图片 token 无效导致 0 个图片块**：保留 docxRecord 中完整图片块（含源文档 token）粘贴时，Feishu 跳过所有无效 token 的图片块，创建 0 个 image 块。
13. **从 docxRecord 移除图片块后粘贴**：`removeImageBlocksFromDocxRecord` 清理后粘贴，非图片结构（grid/table/callout）完整还原，但无图片块可供 base64 注入。
14. **image/png 剪贴板粘贴不创建图片块**：通过 `navigator.clipboard.write([new ClipboardItem({"image/png": blob})])` 写入 Canvas 生成的 PNG 后按 Cmd+V，Feishu 不创建 image 块。
15. **effectiveDocxRecord 回退到原始 docxRecord**：当 `payload.docxRecord` 为空字符串时，`payload.docxRecord || content.docxRecord` 会回退到包含无效图片 token 的原始 docxRecord，导致 Feishu 用 docx/record 路径粘贴但跳过所有图片。**已修复**：不再回退到 content.docxRecord。

### 已验证的成功修复

1. **降级图片时不写 docx/record，强制走 HTML 粘贴路径**（2026-04-19）：
   - 修改 `buildClipboardHtml`：当 `hasDowngradedImages=true` 时，`data-docx-has-block-data` 设为 `"false"`
   - 修改 `buildClipboardPayload`：当有降级图片时，返回空 `docxRecord`，不写 `docx/record` MIME 类型
   - **结果**：source 40 个图片块 → target 38 个图片块（95% 覆盖率），从之前的 0% 大幅提升
   - **已知局限**：HTML 路径对表格、grid_column 等复杂结构的还原度不如 docx/record；少量图片可能因格式问题丢失

3. **feishu-call-service 事件**（2026-04-20）：
   - 新增 `feishu-call-service` DOM 事件，可从 AppleScript JS 上下文调用编辑器内部服务
   - 支持通过 `_instanceMap.forEach()` 迭代访问 Map 中的服务实例
   - 支持点号分隔的嵌套属性路径（如 `externalSaver.taskMap`）
   - 支持属性查看和异步方法调用

4. **docxRecord 递归遍历查找所有图片块**（2026-04-20）：
   - 之前只遍历 `recordIds`（页面直接子块），嵌套在 grid_column/callout/table_cell 中的图片块被遗漏（只找到 3/38）
   - 改为递归遍历 `snapshot.children`，找到所有 38 个图片块，token 匹配率 100%
   - **进一步修复**：`snapshot.children` 递归仍遗漏表格内图片（38/40），改为直接遍历 `recordMap` 所有 key（与 `replaceTokensInDocxRecord` 一致），找到全部 40 个

5. **表格内图片 base64 获取**（2026-04-20）：
   - `blockToHtml` → `buildTableMatrix` → `collectTableCellParts` 只提取文本，不生成 `<img>` 标签
   - 因此表格内图片的 token 不在 HTML 中，`convertImagesToBase64` 的 `tokenToBase64` 没有它们的映射
   - 修复：对 `orderedImageBase64List` 中 base64 为空的图片，用 token 直接调 `/space/api/box/stream/download/preview/TOKEN` 下载
   - `/download/all/?token=TOKEN` 对部分 token 返回 404，但 `/download/preview/TOKEN/?preview_type=16` 返回 200

6. **图片占位符策略**（2026-04-20）：
   - `convertImagesToBase64` 将 HTML 中的 CDN 图片 URL 替换为 1x1 透明 PNG 占位符（而非完整 base64）
   - 剪贴板 HTML 从 ~8.7MB 缩小到 ~95KB，Feishu 可以正常处理
   - 完整 base64 数据存储在 IndexedDB 的 `orderedImageBase64List` 中，用于粘贴后注入

7. **feishu-inject-images 事件**（2026-04-20）：
   - 新增 DOM 事件，供 AppleScript JS 上下文触发图片注入
   - 从 IndexedDB 读取 `orderedImageBase64List`，避免 DOM 属性大小限制

8. **mount_point=docx_image 图片上传到目标文档**（2026-04-20）：
   - 发现 `mount_point=docx_image` 是飞书内部上传 API 的正确参数（非 `ccm_import`）
   - 完整流程：上传 base64 图片到目标文档 → 获取 file_token → 替换 docxRecord 中的 image.token → 粘贴完整 docxRecord → 结构和图片同时 1:1 还原
   - `mount_node_token` 必须使用 obj_token（wiki 页面需通过 `/space/api/wiki/v2/tree/get_node/` 解析）
   - `size` 参数必须与实际文件大小一致（否则返回 size inconsistent 错误）

### 待验证的可能修复方向

1. ~~**有降级图片时，剪贴板不写 docx/record，只写 text/html + text/plain**~~：已验证并实施，见上方成功修复 #1。
2. ~~**图片上传到目标文档后再组装 docxRecord**~~：已验证并实施，见上方成功修复 #7。
3. **通过 mobileImageAddSignal 程序化插入图片块**：`image-manager.docxSignalService.mobileImageAddSignal` 是 RxJS Subject，可以 `.next()` 发送信号。需要确定信号数据格式。
4. **混合策略 - 两步粘贴**：
   - **Step 1**: 粘贴 `removeImageBlocksFromDocxRecord` 后的 docxRecord（保留 grid/table/callout 等结构，不含图片）
   - **Step 2**: 在每个图片位置，通过编辑器 API 或模拟粘贴逐个插入图片
   - **核心难点**：如何在粘贴后定位正确的图片插入位置？需要追踪 docxRecord 中图片块相对于其他块的位置
5. **利用 Feishu 服务端 API 通过 Node.js 进程上传图片**：
   - Runner 是 Node.js 进程，不受浏览器 CORS 限制
   - 可以在 Runner 中调用 `/open-apis/drive/v1/medias/upload_all` 上传图片
   - 获取有效 token 后回传给浏览器，更新 docxRecord 再粘贴
   - **需要**：获取有效的 access_token（可通过 Cookie 或 OAuth）
6. ~~**通过 Feishu 内部上传 API 上传图片**~~：已验证并实施，见上方成功修复 #7。
   - 从飞书前端 JS 代码中提取到完整内部上传 API 路径：
     - `POST /space/api/box/stream/upload/all/` - 直接上传（小文件 ≤4MB）
     - `POST /space/api/box/upload/prepare/` - 准备分块上传
     - `POST /space/api/box/stream/upload/v3/block/` - 上传分块
     - `POST /space/api/box/upload/finish/` - 完成上传
     - `POST /space/api/box/image/create/` - 创建图片记录
     - `POST /space/api/box/image/check/` - 检查图片状态
   - 直接上传参数：
     - FormData: `file` (Blob/File)
     - URL 查询参数: `name`, `size`, `mount_point`, `mount_node_token`, `push_open_history_record`
     - 必须 Header: `biz-ua-type: Web`, `biz-scene: file_upload`
   - **✅ mount_point=docx_image**：正确值！返回 `code:0` + `file_token`
   - **❌ mount_point=ccm_import**：错误值，返回 code:4 "Forbidden"
   - **❌ mount_point=docx/doc/explorer/ccm**：均返回 Forbidden
   - **mount_node_token 必须用 obj_token**（wiki 页面通过 `/space/api/wiki/v2/tree/get_node/` 获取，不能直接用 wiki_token）
   - **已验证完整流程**：上传图片 → 获取 file_token → 替换 docxRecord 中的 image.token → 粘贴 → 图片正常显示
   - Feishu 开放 API 的 `parent_type` 与内部 API 的 `mount_point` 对应关系：
     - `docx_image` = 新版文档图片上传
     - `docx_file` = 新版文档文件上传
     - `ccm_import_open` = 上传素材至云空间（导入场景，不适用于文档内图片）
   - Wiki 页面的 obj_token 获取：通过 `/space/api/wiki/v2/tree/get_node/` 可获取底层 obj_token

## 测试约定

- **永远不要打开新标签页**，始终在当前标签页操作（通过 `set URL of active tab` 而非 `make new tab`）。
- 每次执行完脚本相关改动后，都要自动做一次验证，不要只看代码或只验证是否注入成功。
- 跑飞书全流程验证时，默认使用下面这条 `source -> target` 的原生粘贴校验命令。

```bash
node scripts/feishu-helper-profile-runner.js \
  --attach-active-chrome \
  --sync-tampermonkey \
  --validate-native-paste \
  --script-path scripts/feishu-helper.user.js \
  --source-url "https://bytedance.larkoffice.com/wiki/wikcneDo3rauAOsAu5IJQWaKu0c" \
  --target-url "https://bytedance.larkoffice.com/wiki/DDCSwoAkpiNHS2ke8ebcnqjknkf"
```

- 测试目标不是“看起来能跑”，而是尽量做到对 source 页面内容的 1:1 复刻。
- 每次执行完真实测试后，都要再通过控制台命令检查任务是否成功，确认复制结果、粘贴结果或导出的结构化内容与预期一致。

## 交付约定

- 如果改动属于较大的功能更新，整理成清晰的独立 `git commit`，便于后续推送和前端对接。
- 如果用户在当前任务中明确要求推送，再执行远端推送；否则至少保证本地改动和 commit 边界清晰。
