# tampermonkey-scripts

油猴脚本集合，当前主要维护两类能力：

- `feishu-helper`：绕过飞书文档复制限制，保留结构和图片。
- `copy-cleaner`：清理 AI 站点复制噪音，把公式和列表格式收敛成更稳定的 Markdown。

## 目录

- `userscripts/`：实际安装到 Tampermonkey 的脚本
- `automation/`：真实浏览器回归 runner 和内置 case
- `lib/`：CDP、Tampermonkey 同步、站点适配等复用逻辑
- `bin/`：CLI 入口
- `tests/`：单测

## 脚本

### 飞书文档助手

作用：

- 提取源文档完整结构并粘贴到目标文档
- 允许在无复制权限页面右键复制图片
- 1:1 保留标题、列表、表格、grid、callout、引用、代码块、分割线、书签、公式

安装：

- 将 [userscripts/feishu-helper.user.js](userscripts/feishu-helper.user.js) 添加到 Tampermonkey

适用页面：

- `feishu.cn`
- `larksuite.com`
- `larkoffice.com`

快捷键：

| 快捷键 | 功能 |
| --- | --- |
| `Cmd+Shift+D` | 在源文档页面提取完整内容 |
| `Cmd+Shift+P` | 在目标文档页面粘贴副本 |
| `Cmd+Shift+I` | 提取页面所有图片 |

图片处理要点：

- 飞书图片 token 绑定文档，不能直接复用源文档 token。
- 脚本会收集图片 base64，上传到目标文档，再把 `docxRecord` 里的旧 token 替换成新 token。
- 表格内图片不会稳定出现在 HTML 里，因此会回退扫描 `docxRecord.recordMap`。
- wiki 页面不能直接用 URL 里的 wiki token；需要先通过 `get_node` 解析真实 `obj_token`。

自动测试：

```bash
npm run feishu:test
npm run feishu:cases
```

Feishu 回归不是全文文本比对，而是固定源文档 -> 固定目标 wiki 的关键节点校验，重点看：

- 提取阶段是否得到 `pendingPaste`、块数、公式数和语义快照
- 图片上传是否产出 `uploadedCount` / `failedCount`
- 目标文档结构是否真的发生变化
- 图片、表格、高亮块、公式、引用、代码块、分割线、grid、bookmark 等关键组件是否重新渲染出来

### 复制净化器

作用：

- 去除 AI 回复里的格式噪音
- 把网页复制出来的公式 Unicode 乱码转回 LaTeX
- 统一列表、表格、代码块、引用等 Markdown 输出
- 兼容飞书对公式间距和嵌套列表缩进的要求

安装：

- 将 [userscripts/copy-cleaner.user.js](userscripts/copy-cleaner.user.js) 添加到 Tampermonkey

典型输出：

| 输入 | 输出 |
| --- | --- |
| `**深度学习**是...` | `深度学习是...` |
| `AI（人工智能）是...` | `AI是...` |
| 渲染后的 `∇θ logπθ` | `$\nabla_\theta \log \pi_\theta$` |
| `公式$x^2$在这里` | `公式 $x^2$ 在这里` |

真实站点回归：

```bash
npm run copycleaner:all

npm run copycleaner:chatgpt
npm run copycleaner:gemini
npm run copycleaner:tika
npm run copycleaner:aistudio

npm run copycleaner:prompttest
```

关键约束：

- `copycleaner:all` 是默认入口，会先做一次 Tampermonkey 同步，再按 `chatgpt -> gemini -> tika -> aistudio` 串行回归。
- 聚合入口内部会自动给子 runner 传 `--skip-sync` 复用这次同步；不要把 `--skip-sync` 当成冷启动命令单独使用。
- `copycleaner:realtest` 已废弃。
- 真实回归必须复用已经登录的 `9222` Chrome；不要另外启动一只空浏览器。
- `json/list` 为空不代表不能跑，runner 会自动补普通 tab。

完整回归会验证：

1. 本地 userscript 是否成功同步进 Tampermonkey
2. 站点官方 copy 按钮/菜单是否走到脚本拦截链路
3. 聚合串行回归是否能在同一只 `9222` 浏览器里稳定跑完
4. page marker / 系统剪贴板是否与 oracle 完全一致

查看 case 或自定义运行：

```bash
node automation/copy-cleaner-runner.js --list-cases

node automation/copy-cleaner-runner.js \
  --site chatgpt \
  --case chatgpt-basic-cleanup \
  --url https://chatgpt.com/ \
  --expected 'AI公式在 $x^2$ 里'
```

## 开发

安装与测试：

```bash
npm install
npm test
```

当前已验证过的真实回归环境：

- Node.js `v25.9.0`
- npm `11.12.1`
- Chrome `147.0.7727.x`
- Playwright `@playwright/test@1.60.0-alpha-2026-05-01`
- CDP `http://127.0.0.1:9222`

说明：

- 当前 Playwright 附着日常 Chrome 时需要 `connectOverCDP(..., { noDefaults: true })`，否则可能触发 `Browser.setDownloadBehavior` 兼容问题。

### 9222 浏览器

优先复用现有 `9222`：

```bash
curl -s http://127.0.0.1:9222/json/version
```

如果能返回版本信息，直接运行 runner。真正影响登录态的是 `9222` 对应的 browser profile，不是当前有没有普通 tab。

如果本机还没有 `9222`，再启动一只可调试 Chrome。推荐先克隆当前 `Default` profile，再暴露 `9222`，避免丢失登录态：

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

要点：

- 这样能复用登录态，又避免直接占用你正在使用的主 profile。
- 如果要重新同步主 Chrome 的最新状态，先关闭这个 `9222` Chrome，再删除 `~/.cache/agent-browser/chrome-9222-profile` 后重跑。

### 常见问题

- `EPERM 127.0.0.1:9222`
  常见于受限沙箱；改成提权运行。

- `Browser.setDownloadBehavior` / `Browser context management is not supported`
  是 Playwright 附着日常 Chrome 的兼容问题；保留 `noDefaults: true`。

- `No existing page found`
  当前 runner 会自动补普通 tab，优先检查 `9222` 是否真的可用。

- 打开站点后跳登录页
  不是 runner 逻辑问题，通常是 `9222` 对应 profile 没有登录态。

### 通用 Tampermonkey 同步

CLI：

```bash
npm run tampermonkey:sync -- --script-path userscripts/copy-cleaner.user.js
npm run tampermonkey:sync -- --help
```

Node API：

```js
const { syncUserscriptToTampermonkey } = require('./index.js');

await syncUserscriptToTampermonkey({
  scriptPath: './userscripts/copy-cleaner.user.js',
  cdpUrl: 'http://127.0.0.1:9222',
});
```

真实站点 runner 会直接复用这套同步入口。
