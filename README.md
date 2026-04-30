# tampermonkey-scripts

油猴脚本集合，提升网页浏览体验。

## 脚本列表

### 飞书文档助手

解除飞书文档复制限制，1:1 复刻飞书文档。允许在无复制权限的页面中右键复制图片。

**安装：** 将 [scripts/feishu-helper.user.js](scripts/feishu-helper.user.js) 的内容添加到 Tampermonkey 新脚本中。

**适用页面：** `feishu.cn`、`larksuite.com`、`larkoffice.com` 下的所有页面

#### 快捷键

| 快捷键           | 功能           |
| ------------- | ------------ |
| `Cmd+Shift+D` | 在源文档页面提取完整内容 |
| `Cmd+Shift+P` | 在目标文档页面粘贴副本  |
| `Cmd+Shift+I` | 提取页面所有图片     |

#### 操作流程

1. 在源文档页面按 `Cmd+Shift+D` 提取内容
2. 在目标文档页面按 `Cmd+Shift+P`

**支持的完整结构**：标题、正文、列表、表格、grid 多栏、callout、引用、代码块、分割线、书签、公式等。

#### 图片复制原理

飞书文档的图片 token 是文档绑定的，直接粘贴源文档的 docxRecord 会导致图片全部丢失。解决方案：

1. 提取阶段：从 HTML 和 docxRecord 中收集所有图片的 base64 数据
2. 上传阶段：先解析目标 wiki/doc 的真实 `obj_token`，再通过 `POST /space/api/box/stream/upload/all/?mount_point=docx_image` 将图片上传到目标文档，获取新的 `file_token`
3. 替换阶段：将 docxRecord 中的旧 token 替换为新 token
4. 粘贴阶段：写入包含有效 token 的完整 docxRecord，飞书粘贴解析器会创建图片块

**表格内图片的特殊处理**：表格内的图片不会出现在 `blockToHtml` 生成的 HTML 中，因此无法通过 HTML 中的 CDN URL 获取 base64。修复方式是直接遍历 `docxRecord.recordMap` 中所有图片块，对缺少 base64 的图片用 token 调取 `/space/api/box/stream/download/preview/TOKEN` 下载。

**wiki 页面注意事项**：`mount_node_token` 不能直接使用 URL 里的 wiki token。当前在 `my.feishu.cn` 上需要通过 `GET /space/api/wiki/v2/tree/get_node/?wiki_token=...&expand_shortcut=true&with_deleted=true` 解析真实 `obj_token`，否则上传会返回 `mount node not exist`，最终表现为“上传了 0 张图片”。

***

### 复制净化器

复制时自动清理 AI 生成内容中的格式噪音，并将网页前端复制数学公式得到的 Unicode 乱码转化为 LaTeX 格式。

**安装：** 将 [scripts/copy-cleaner.user.js](scripts/copy-cleaner.user.js) 的内容添加到 Tampermonkey 新脚本中。

#### 功能

| 功能                 | 示例输入           | 输出                                |
| ------------------ | -------------- | --------------------------------- |
| 去除加粗标记 `**`        | `**深度学习**是...` | `深度学习是...`                        |
| 去除中文括号注释 `（）`      | `AI（人工智能）是...` | `AI是...`                          |
| 去除中英文引号 `""''""''` | `"深度学习"是...`   | `深度学习是...`                        |
| 数学公式提取为 LaTeX      | 渲染后的 ∇θ logπθ  | `$\nabla_\theta \log \pi_\theta$` |
| 飞书空格兼容             | `公式$x^2$在这里`   | `公式 $x^2$ 在这里`                    |

#### 自动测试

启动好 `9222` 调试 Chrome 后，可直接执行：

```bash
npm run copycleaner:chatgpt
```

该命令会自动完成：

1. 连接 `http://127.0.0.1:9222`
2. 把本地 `scripts/copy-cleaner.user.js` 同步进 Tampermonkey
3. 在当前标签页打开 `https://chatgpt.com/`
4. 发送固定提示词，并点击 ChatGPT 官方回复 copy 按钮
5. 读取系统剪贴板，校验结果是否为 `AI公式在 $x^2$ 里`

如果要自定义目标页面或断言文本，也可以直接运行：

```bash
node scripts/copy-cleaner-chatgpt-runner.js \
  --url https://chatgpt.com/ \
  --expected 'AI公式在 $x^2$ 里'
```

***

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

启动 Chrome：

```bash
python3 - <<'PY'
import shutil, subprocess, pathlib, time, urllib.request
home = pathlib.Path.home()
chrome_dir = home / 'Library' / 'Application Support' / 'Google' / 'Chrome'
profile = 'Default'
src_profile = chrome_dir / profile
src_local_state = chrome_dir / 'Local State'
clone_root = home / '.cache' / 'agent-browser'
clone_dir = clone_root / 'chrome-9222-profile'
if not src_profile.exists():
    raise SystemExit(f'missing profile: {src_profile}')
ignore = shutil.ignore_patterns(
    'Cache', 'Code Cache', 'GPUCache', 'Dawn*Cache', 'GrShaderCache',
    'BrowserMetrics', 'Crashpad', 'Singleton*', 'LOCK'
)
clone_root.mkdir(parents=True, exist_ok=True)
if not (clone_dir / profile).exists():
    clone_dir.mkdir(parents=True, exist_ok=True)
    if src_local_state.exists():
        shutil.copy2(src_local_state, clone_dir / 'Local State')
    shutil.copytree(src_profile, clone_dir / profile, dirs_exist_ok=True, ignore=ignore)
subprocess.check_call([
    'open', '-na', 'Google Chrome', '--args',
    '--remote-debugging-port=9222',
    f'--user-data-dir={clone_dir}',
    f'--profile-directory={profile}',
])
for _ in range(60):
    try:
        with urllib.request.urlopen('http://127.0.0.1:9222/json/version', timeout=1) as resp:
            if resp.status == 200:
                break
    except Exception:
        time.sleep(0.5)
else:
    raise SystemExit('Chrome started but CDP 9222 was not ready within 30s')
print(clone_dir)
PY
agent-browser connect 9222
```

说明：

- 该命令首次运行时会把 `~/Library/Application Support/Google/Chrome/Default` 克隆到 `~/.cache/agent-browser/chrome-9222-profile`，后续直接复用这个目录启动新 Chrome。
- 这样能复用个人登录态，又不会和当前正在使用的主 Chrome profile 直接冲突，同时避免每次都重新全量复制 profile。
- 如果想重新同步主 Chrome 的最新登录态或配置，先关闭这个 `9222` Chrome，再删除 `~/.cache/agent-browser/chrome-9222-profile` 后重新运行脚本。

### 通用 Tampermonkey 同步

- `scripts/tampermonkey-cdp-utils.cjs` 提供了基于 CDP 的通用同步能力，可被不同 userscript 的自动化验证复用。
- 当前 `scripts/copy-cleaner-chatgpt-runner.js` 已经使用这套通用同步逻辑；后续其他脚本也应优先复用这里。
