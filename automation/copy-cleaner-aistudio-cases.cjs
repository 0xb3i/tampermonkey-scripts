const DEFAULT_AISTUDIO_CASE_ID = 'aistudio-markdown-fixture-page';

const AISTUDIO_REAL_TEST_CASES = {
  'aistudio-markdown-fixture-page': {
    id: 'aistudio-markdown-fixture-page',
    description: '固定 AI Studio 会话页中点击官方 Copy as markdown 菜单项，并对比 oracle。',
    url: 'https://aistudio.google.com/prompts/16_iu3lu3TxymZVU_k7PXtEKLqWATN4O7',
    requirePageMarker: false,
    expectedText: [
      '这是一个包含常用 Markdown 语法的示例文本（已排除分割线）：',
      '# 一级标题 (H1)',
      '## 二级标题 (H2)',
      '### 三级标题 (H3)',
      '#### 四级标题 (H4)',
      '##### 五级标题 (H5)',
      '###### 六级标题 (H6)',
      '文本样式',
      '* 这是 斜体 (Italic)',
      '* 这是 加粗 (Bold)',
      '* 这是 斜体加粗 (Bold & Italic)',
      '* 这是 删除线 (Strikethrough)',
      '* 这是 `行内代码` (Inline Code)',
      '* 下标：H~2~O，上标：X^2^（部分编辑器支持）',
      '列表样式',
      '1. 有序列表项一',
      '2. 有序列表项二',
      '   1. 嵌套有序列表',
      '- 无序列表项 A',
      '- 无序列表项 B',
      '  - 嵌套无序列表',
      '* 另一种无序符号',
      '+ 另一种无序符号',
      '任务列表 (Task List)',
      '- [x] 已完成任务',
      '- [ ] 待完成任务 1',
      '- [ ] 待完成任务 2',
      '引用 (Blockquote)',
      '> 这是一级引用。',
      '>> 这是嵌套的二级引用。',
      '>',
      '> 引用内的多段落处理。',
      '代码块 (Code Block)',
      '```python',
      'def hello_markdown():',
      '    # 这是一个带语法高亮的 Python 代码块',
      '    message = "Hello, World!"',
      '    print(message)',
      '```',
      '表格 (Table)',
      '| 姓名 | 年龄 | 职业 | 对齐方式 |',
      '| :--- | :--: | :--: | ---: |',
      '| 张三 | 25 | 程序员 | 左对齐 |',
      '| 李四 | 30 | 设计师 | 居中对齐 |',
      '| 王五 | 28 | 教师 | 右对齐 |',
      '',
      '链接与图片',
      '* 外部链接：[百度搜索](https://www.baidu.com)',
      '* 自动链接：<https://www.example.com>',
      '* 引用式链接：[Google][google_link]',
      '* 图片：![图片描述](https://via.placeholder.com/150 "鼠标悬停提示")',
      '[google_link]: https://www.google.com',
      '数学公式 (LaTeX)',
      '* 行内公式： $E = mc^2$',
      '* 块级公式：',
      '$$',
      '\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}',
      '$$',
      '脚注 (Footnote)',
      '这是一个带有脚注的句子[^1]。',
      '[^1]: 这是脚注的具体内容，通常显示在页面底部。',
      'HTML 标签（兼容模式）',
      '使用 <kbd>Ctrl</kbd> + <kbd>C</kbd> 复制。',
      '<span style="color:red">这是一段红色的文字。</span>',
    ].join('\n'),
  },
};

function getAiStudioRealTestCase(caseId) {
  var targetId = String(caseId || DEFAULT_AISTUDIO_CASE_ID);
  var result = AISTUDIO_REAL_TEST_CASES[targetId];
  if (!result) {
    throw new Error('Unknown AI Studio real test case: ' + targetId);
  }
  return result;
}

function listAiStudioRealTestCases() {
  return Object.keys(AISTUDIO_REAL_TEST_CASES).map(function (id) {
    return AISTUDIO_REAL_TEST_CASES[id];
  });
}

module.exports = {
  AISTUDIO_REAL_TEST_CASES,
  DEFAULT_AISTUDIO_CASE_ID,
  getAiStudioRealTestCase,
  listAiStudioRealTestCases,
};
