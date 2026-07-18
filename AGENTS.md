# 仓库协作规则

- 所有真实 Chrome 与 Tampermonkey 操作必须通过 Chrome DevTools MCP 完成。
- 禁止新增或恢复基于 Agent Browser、独立 CDP 端口、Playwright 附加会话的浏览器控制、同步 CLI 或仓内自动化 runner。
- 仓库测试保持为不依赖真实浏览器的 Node.js 单元测试；真实网页验证由智能体通过 Chrome DevTools MCP 执行。
- 修改任一用户脚本时必须同步更新其 `@version`，同步到 Tampermonkey 后校验版本、启用状态与源码哈希，并刷新受影响页面。
