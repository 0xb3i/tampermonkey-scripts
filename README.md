# tampermonkey-scripts

油猴脚本集合，当前主要维护两类能力：

- `feishu-helper`：绕过飞书文档复制限制，1 比 1 复刻源飞书文档。
- `copy-cleaner`：清理 AI 输出的噪音，将网页渲染出的乱码公式和列表等组件转换成更稳定的 Markdown。

## 目录

- `userscripts/`：安装到 Tampermonkey 的脚本
- `automation/`：真实浏览器测试 runner 和内置 case
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

| 快捷键           | 功能           |
| ------------- | ------------ |
| `Cmd+Shift+D` | 在源文档页面提取完整内容 |
| `Cmd+Shift+P` | 在目标文档页面粘贴副本  |
| `Cmd+Shift+I` | 提取页面所有图片     |

自动测试：

```bash
npm run feishu:test
npm run feishu:cases
```

### 复制净化器

作用：

- 去除 AI 回复里的格式噪音
- 把网页复制出来的公式 Unicode 乱码转回 LaTeX
- 统一列表、表格、代码块、引用等 Markdown 输出
- 兼容飞书对公式间距和嵌套列表缩进的要求

安装：

- 将 [userscripts/copy-cleaner.user.js](userscripts/copy-cleaner.user.js) 添加到 Tampermonkey

输出示例：

| 输入              | 输出                                |
| --------------- | --------------------------------- |
| `**深度学习**是...`  | `深度学习是...`                        |
| `AI（人工智能）是...`  | `AI是...`                          |
| 渲染后的 `∇θ logπθ` | `$\nabla_\theta \log \pi_\theta$` |
| `公式$x^2$在这里`    | `公式 $x^2$ 在这里`                    |

## 开发

开发环境：

- Node.js `v25.9.0`
- npm `11.12.1`
- Chrome `147.0.7727.x`
- Playwright `@playwright/test@1.60.0-alpha-2026-05-01`
- CDP `http://127.0.0.1:9222`

优先复用现有 `9222`端口的浏览器：

```bash
curl -s http://127.0.0.1:9222/json/version
```

启动调试 Chrome：

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

## 常见问题

- `EPERM 127.0.0.1:9222`
  常见于受限沙箱，需要改成提权运行。
- `Browser.setDownloadBehavior` / `Browser context management is not supported`
  是 Playwright 附着日常 Chrome 的兼容问题，需要保留 `noDefaults: true`。

## 脚本同步

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

