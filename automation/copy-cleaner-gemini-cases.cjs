const DEFAULT_GEMINI_CASE_ID = 'gemini-markdown-fixture-page';

const GEMINI_REAL_TEST_CASES = {
  'gemini-markdown-fixture-page': {
    id: 'gemini-markdown-fixture-page',
    description: '固定 Gemini 会话页中的 Markdown 样式回复，点击主回复 Copy 按钮并对比 oracle。',
    url: 'https://gemini.google.com/app/29c1ebf2ba2d1d74',
    requirePageMarker: true,
    useExistingAssistantReply: true,
    expectedText: [
      '这是一份展示 Markdown 常用语法的综合文本。它包含了从基础排版到高级组件的多种样式，旨在清晰地呈现每种视觉效果。',
      '',
      '## 1. 基础文本样式',
      '在文档中，我们可以通过不同的符号来强调内容。我们可以使用 **加粗文本** 来突出重点，或者使用 *倾斜文本* 来表示强调。如果需要，还可以结合使用 ***加粗并倾斜***。',
      '',
      '对于已经失效的信息，可以使用 ~~删除线~~。此外，在处理专业术语或代码片段时，行内代码（如 `console.log("Hello")`）是非常实用的。',
      '',
      '## 2. 列表表达',
      '### 无序列表',
      '*   探索新技术的边界',
      '*   保持好奇心与创造力',
      '    *   二级缩进项',
      '    *   持续学习',
      '',
      '### 有序列表',
      '1.  第一步：分析用户需求',
      '2.  第二步：制定执行方案',
      '3.  第三步：交付最终成果',
      '',
      '### 任务列表',
      '- [x] 已完成 Markdown 语法调研',
      '- [ ] 待完成 样式深度美化',
      '- [ ] 待发布 文档正式版本',
      '',
      '## 3. 引用与对比',
      '> **智者云：** “代码不仅是写给机器执行的，更是写给开发者阅读的。”',
      '> ',
      '> —— 匿名程序员',
      '',
      '## 4. 数据组织',
      '通过表格，我们可以清晰地对比不同维度的信息：',
      '',
      '| 样式类别 | 语法示例 | 适用场景 |',
      '| :--- | :---: | :--- |',
      '| **标题** | `# H1` | 结构化层级 |',
      '| **链接** | `[文字](URL)` | 外部资源跳转 |',
      '| **图片** | `![描述](URL)` | 视觉辅助说明 |',
      '',
      '## 5. 代码块展示',
      '这里是一个简单的 Python 示例，展示了代码块的语法高亮：',
      '',
      '```python',
      'def greet_user(name):',
      '    """向用户致以诚挚的问候"""',
      '    print(f"你好, {name}! 欢迎来到 Markdown 的世界。")',
      '',
      'greet_user("Gemini")',
      '```',
      '',
      '## 6. 数学公式与链接',
      '当涉及到科学计算时，可以使用 LaTeX 进行排版。例如，勾股定理可以表示为：$a^2 + b^2 = c^2$。',
      '',
      '如果需要引用资源，可以使用 [Markdown 官方教程](https://www.markdownguide.org) 这样的超链接。',
      '',
      '## 7. 插入图片',
      '![AI 助手示例图](https://www.gstatic.com/lamda/images/favicon_v1_15011f0304a58145eb381.svg)',
      '',
      '---',
      '*(此处本应有分割线，但根据您的要求已省略。)*',
    ].join('\n'),
  },
};

function getGeminiRealTestCase(caseId) {
  var targetId = String(caseId || DEFAULT_GEMINI_CASE_ID);
  var result = GEMINI_REAL_TEST_CASES[targetId];
  if (!result) {
    throw new Error('Unknown Gemini real test case: ' + targetId);
  }
  return result;
}

function listGeminiRealTestCases() {
  return Object.keys(GEMINI_REAL_TEST_CASES).map(function (id) {
    return GEMINI_REAL_TEST_CASES[id];
  });
}

module.exports = {
  DEFAULT_GEMINI_CASE_ID,
  GEMINI_REAL_TEST_CASES,
  getGeminiRealTestCase,
  listGeminiRealTestCases,
};
