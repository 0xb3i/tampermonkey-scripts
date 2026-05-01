const DEFAULT_TIKA_CASE_ID = 'tika-markdown-fixture-page';

const TIKA_REAL_TEST_CASES = {
  'tika-markdown-fixture-page': {
    id: 'tika-markdown-fixture-page',
    description: '固定 Tika 会话页中的 Markdown 样例回复，直接点击官方复制按钮并对比标准答案。',
    url: 'https://tika.byteintl.net/search?conversation_id=1077720878852',
    useExistingAssistantReply: true,
    expectedText: [
      '# 一级标题',
      '## 二级标题',
      '### 三级标题',
      '这是一段普通文本，其中包含 加粗文本、斜体文本、加粗并斜体文本、删除线文本、`行内代码`，以及一个 [Markdown 链接](https://example.com)。',
      '> 这是一段引用文本。',
      '>',
      '> 引用中也可以包含 加粗、斜体 和 `代码`。',
      '下面是一个无序列表：',
      '- 第一项',
      '- 第二项',
      '  - 嵌套子项',
      '  - 另一个嵌套子项',
      '- 第三项',
      '下面是一个有序列表：',
      '1. 第一步',
      '2. 第二步',
      '    1. 子步骤一',
      '    2. 子步骤二',
      '3. 第三步',
      '下面是一个任务列表：',
      '- [x] 已完成的任务',
      '- [ ] 未完成的任务',
      '- [ ] 需要继续处理的任务',
      '下面是一个代码块：',
      '```python',
      'def hello_markdown():',
      '    print("Hello, Markdown!")',
      '',
      'hello_markdown()',
      '```',
      '下面是一个表格：',
      '| 姓名 | 角色 | 状态 |',
      '| --- | --- | --- |',
      '| 张三 | 开发 | 已完成 |',
      '| 李四 | 测试 | 进行中 |',
      '| 王五 | 产品 | 待开始 |',
      '',
      '下面是一段包含图片语法的文本：',
      '![示例图片](https://example.com/image.png)',
      '下面是脚注示例：',
      '这是一个带脚注的句子。',
      '下面是转义字符示例：',
      '*这段文字不会被解析为斜体*',
      '下面是 HTML 混合写法：',
      '<strong>这是 HTML 加粗文本</strong>',
      '下面是数学公式写法：',
      '行内公式：$E = mc^2$',
      '块级公式：',
      '$$a^2 + b^2 = c^2$$',
      '下面是高亮写法：',
      '==这是一段高亮文本==',
      '下面是定义列表写法：',
      'Markdown : 一种轻量级标记语言。',
      'HTML : 一种用于构建网页的标记语言。',
      '最后，这是一段综合示例：',
      'Markdown 可以让文本同时具备 可读性 和 `结构化表达能力`，适合用于文档、笔记、README、博客和技术说明。',
    ].join('\n'),
  },
};

function getTikaRealTestCase(caseId) {
  var targetId = String(caseId || DEFAULT_TIKA_CASE_ID);
  var result = TIKA_REAL_TEST_CASES[targetId];
  if (!result) {
    throw new Error('Unknown Tika real test case: ' + targetId);
  }
  return result;
}

function listTikaRealTestCases() {
  return Object.keys(TIKA_REAL_TEST_CASES).map(function (id) {
    return TIKA_REAL_TEST_CASES[id];
  });
}

module.exports = {
  DEFAULT_TIKA_CASE_ID,
  TIKA_REAL_TEST_CASES,
  getTikaRealTestCase,
  listTikaRealTestCases,
};
