# Debug Session: kl-invalid-formula [OPEN]

## Context
- Symptom: ChatGPT `解释一下 kl 散度` 的官方“复制回复”结果里仍有无效公式。
- Goal: 找到无效公式是来源于页面 DOM、公式提取、还是结构化序列化阶段。

## Hypotheses
- H1: 页面原始回复里的某个公式节点本身就是残缺的。
- H2: KaTeX/MathJax 提取阶段错误选择了残缺来源。
- H3: 结构化序列化把两个公式或公式与正文错误拼接。
- H4: 列表/段落排版修正破坏了公式边界。

## Plan
- 启动独立调试会话并清空日志。
- 只加插桩，不改业务逻辑。
- 自动复现 ChatGPT 官方复制按钮。
- 对比页面原始 DOM、提取后 payload、最终剪贴板文本。
