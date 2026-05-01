const DEFAULT_CHATGPT_CASE_ID = 'chatgpt-markdown-fixture-page';

const CHATGPT_REAL_TEST_CASES = {
  'chatgpt-markdown-fixture-page': {
    id: 'chatgpt-markdown-fixture-page',
    description: '固定会话页中的 Markdown 全样式回复，直接复制现成 assistant 回复并对比标准答案。',
    url: 'https://chatgpt.com/c/69f45156-a908-83e8-a147-f694e7d9c109',
    useExistingAssistantReply: true,
    ignoreLinePatterns: [
      /^脚注示例：$/,
      /^这是一个脚注\d+[。.]?$/,
      /^\[\^\d+\]:/,
    ],
    expectedText: [
      '好的，我给你写一段示例文本，尽量覆盖 Markdown 常见语法样式：',
      '---',
      '# 一级标题',
      '## 二级标题',
      '### 三级标题',
      '#### 四级标题',
      '##### 五级标题',
      '###### 六级标题',
      '这是普通段落文本，下面展示粗体、斜体、粗斜体、删除线和`inline code`。',
      '> 这是一个引用块，可以用于强调文本或引用他人内容。',
      '> 也可以多行。',
      '---',
      '无序列表：',
      '- 项目一',
      '- 项目二',
      '  - 子项目 2.1',
      '  - 子项目 2.2',
      '- 项目三',
      '有序列表：',
      '1. 第一点',
      '2. 第二点',
      '    1. 子点 2.1',
      '    2. 子点 2.2',
      '3. 第三点',
      '任务列表：',
      '- [x] 已完成任务',
      '- [ ] 未完成任务',
      '- [ ] 进行中任务',
      '---',
      '代码块：',
      '```python',
      'def greet(name):',
      '    print(f"Hello, {name}!")',
      'greet("World")',
      '```',
      '行内代码：`print("Hello")`',
      '---',
      '表格：',
      '| 名称 | 年龄 | 城市 |',
      '| --- | ---: | :--- |',
      '| Alice | 25 | 北京 |',
      '| Bob | 30 | 上海 |',
      '| Charlie | 28 | 广州 |',
      '---',
      '链接与图片：',
      '- 链接：[百度](https://www.baidu.com)',
      '- 图片：',
      '---',
      '## 水平线：',
      '---',
      '数学公式：',
      '行内公式：$E=mc^2$',
      '块级公式：',
      '$$\\int_0^\\infty e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}$$',
      '---',
      '我可以帮你再生成一个完整示例，几乎把所有 Markdown 特性都放进一篇小文章，看起来像真实文档。如果你想要这个，我可以直接生成。',
      '你希望我生成吗？',
    ].join('\n'),
  },
  'chatgpt-basic-cleanup': {
    id: 'chatgpt-basic-cleanup',
    description: '验证 ChatGPT 官方复制按钮是否能把 AI 噪音和行内公式清洗成稳定文本。',
    url: 'https://chatgpt.com/',
    useExistingAssistantReply: false,
    promptText: [
      '请只回复下面这一行，完全按原样输出，不要解释，不要代码块：',
      '',
      '**AI**（人工智能）“公式”在$x^2$里',
    ].join('\n'),
    expectedText: 'AI公式在 $x^2$ 里',
  },
};

function getChatGPTRealTestCase(caseId) {
  var targetId = String(caseId || DEFAULT_CHATGPT_CASE_ID);
  var result = CHATGPT_REAL_TEST_CASES[targetId];
  if (!result) {
    throw new Error('Unknown ChatGPT real test case: ' + targetId);
  }
  return result;
}

function listChatGPTRealTestCases() {
  return Object.keys(CHATGPT_REAL_TEST_CASES).map(function (id) {
    return CHATGPT_REAL_TEST_CASES[id];
  });
}

module.exports = {
  CHATGPT_REAL_TEST_CASES,
  DEFAULT_CHATGPT_CASE_ID,
  getChatGPTRealTestCase,
  listChatGPTRealTestCases,
};
