const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_CASE_IDS,
  getRealTestCase,
  listRealTestCases,
} = require('../automation/copy-cleaner-cases.cjs');
const {
  parseCliArgs,
  runCopyCleanerRealTest,
} = require('../automation/copy-cleaner-runner.js');
const {
  buildExactTextMismatchSummary,
  buildTextMismatchSummary,
} = require('../automation/copy-cleaner-runner-utils.cjs');

test('aistudio default case exposes stable oracle', () => {
  const testCase = getRealTestCase('aistudio', DEFAULT_CASE_IDS.aistudio);
  assert.equal(testCase.id, DEFAULT_CASE_IDS.aistudio);
  assert.match(testCase.url, /^https:\/\/aistudio\.google\.com\//);
  assert.match(testCase.description, /Copy as markdown/);
  assert.match(testCase.expectedText, /```python/);
  assert.match(testCase.expectedText, /\[google_link\]: https:\/\/www\.google\.com/);
});

test('chatgpt default case exposes stable oracle', () => {
  const testCase = getRealTestCase('chatgpt', DEFAULT_CASE_IDS.chatgpt);
  assert.equal(testCase.id, DEFAULT_CASE_IDS.chatgpt);
  assert.equal(testCase.url, 'https://chatgpt.com/c/69f45156-a908-83e8-a147-f694e7d9c109');
  assert.equal(testCase.useExistingAssistantReply, true);
  assert.match(testCase.expectedText, /Markdown 常见语法样式：/);
  assert.match(testCase.expectedText, /```python/);
});

test('gemini default case exposes stable oracle', () => {
  const testCase = getRealTestCase('gemini', DEFAULT_CASE_IDS.gemini);
  assert.equal(testCase.id, DEFAULT_CASE_IDS.gemini);
  assert.equal(testCase.url, 'https://gemini.google.com/app/29c1ebf2ba2d1d74');
  assert.equal(testCase.useExistingAssistantReply, true);
  assert.match(testCase.expectedText, /## 1\. 基础文本样式/);
  assert.match(testCase.expectedText, /\| 样式类别 \| 语法示例 \| 适用场景 \|/);
  assert.match(testCase.expectedText, /\[Markdown 官方教程\]\(https:\/\/www\.markdownguide\.org\)/);
});

test('tika default case exposes stable oracle', () => {
  const testCase = getRealTestCase('tika', DEFAULT_CASE_IDS.tika);
  assert.equal(testCase.id, DEFAULT_CASE_IDS.tika);
  assert.equal(testCase.url, 'https://tika.byteintl.net/search?conversation_id=1077720878852');
  assert.equal(testCase.useExistingAssistantReply, true);
  assert.match(testCase.expectedText, /# 一级标题/);
  assert.match(testCase.expectedText, /\[Markdown 链接\]\(https:\/\/example\.com\)/);
  assert.match(testCase.expectedText, /\$\$a\^2 \+ b\^2 = c\^2\$\$/);
});

test('listRealTestCases returns all cases across sites', () => {
  const all = listRealTestCases();
  assert.ok(all.length >= 5);
  const aistudio = listRealTestCases('aistudio');
  assert.equal(aistudio.length, 1);
  const chatgpt = listRealTestCases('chatgpt');
  assert.equal(chatgpt.length, 2);
});

test('getRealTestCase throws for unknown site', () => {
  assert.throws(function () { getRealTestCase('unknown'); }, /Unknown site/);
});

test('getRealTestCase throws for unknown case', () => {
  assert.throws(function () { getRealTestCase('chatgpt', 'nonexistent'); }, /Unknown chatgpt real test case/);
});

test('runner exports the real test entry point', () => {
  assert.equal(typeof runCopyCleanerRealTest, 'function');
});

test('parseCliArgs keeps boolean flags and key-value pairs', () => {
  assert.deepEqual(parseCliArgs([
    '--site', 'chatgpt',
    '--case', DEFAULT_CASE_IDS.chatgpt,
    '--list-cases',
    '--url', 'https://chatgpt.com/',
  ]), {
    site: 'chatgpt',
    case: DEFAULT_CASE_IDS.chatgpt,
    'list-cases': true,
    url: 'https://chatgpt.com/',
  });
});

test('buildTextMismatchSummary reports first mismatch and nearby fragments', () => {
  assert.deepEqual(
    buildTextMismatchSummary('AI公式在 $x^2$ 里', 'AI公式在$x^2$里'),
    {
      matches: false,
      firstDiffIndex: 5,
      expectedFragment: 'AI公式在 $x^2$ 里',
      actualFragment: 'AI公式在$x^2$里',
    }
  );
});

test('buildTextMismatchSummary reports exact match when texts are equal after normalization', () => {
  assert.deepEqual(
    buildTextMismatchSummary('foo\r\nbar', 'foo\nbar'),
    {
      matches: true,
      firstDiffIndex: -1,
      expectedFragment: '',
      actualFragment: '',
    }
  );
});

test('buildTextMismatchSummary ignores blank lines globally', () => {
  assert.deepEqual(
    buildTextMismatchSummary('foo\n\nbar\n\nbaz', 'foo\nbar\nbaz'),
    {
      matches: true,
      firstDiffIndex: -1,
      expectedFragment: '',
      actualFragment: '',
    }
  );
});

test('buildTextMismatchSummary preserves a blank line only after markdown tables', () => {
  assert.deepEqual(
    buildTextMismatchSummary(
      '| a | b |\n| --- | --- |\n| 1 | 2 |\n\n后文',
      '| a | b |\n| --- | --- |\n| 1 | 2 |\n后文'
    ),
    {
      matches: false,
      firstDiffIndex: 34,
      expectedFragment: '|\n| 1 | 2 |\n\n后文',
      actualFragment: '|\n| 1 | 2 |\n后文',
    }
  );
});

test('buildTextMismatchSummary can ignore footnote lines for real browser oracle comparison', () => {
  assert.deepEqual(
    buildTextMismatchSummary(
      '正文\n脚注示例：\n这是一个脚注1。\n[^1]: https://example.com',
      '正文',
      [/^脚注示例：$/, /^这是一个脚注\d+[。.]?$/, /^\[\^\d+\]:/]
    ),
    {
      matches: true,
      firstDiffIndex: -1,
      expectedFragment: '',
      actualFragment: '',
    }
  );
});

test('buildExactTextMismatchSummary keeps extra blank lines visible', () => {
  assert.deepEqual(
    buildExactTextMismatchSummary('foo\nbar', 'foo\n\nbar'),
    {
      matches: false,
      firstDiffIndex: 4,
      expectedFragment: 'foo\nbar',
      actualFragment: 'foo\n\nbar',
    }
  );
});

test('gemini oracle highlights partial-copy mismatches clearly', () => {
  assert.deepEqual(
    buildTextMismatchSummary(
      '## 5. 代码块展示\n这里是一个简单的 Python 示例，展示了代码块的语法高亮：\n\n```python',
      '这里是一个简单的 Python 示例，展示了代码块的语法高亮：\nPython\n```'
    ),
    {
      matches: false,
      firstDiffIndex: 0,
      expectedFragment: '## 5. 代码块展示\n这里是一个简单的 Pyt',
      actualFragment: '这里是一个简单的 Python 示例，展示了代码',
    }
  );
});

test('tika oracle highlights markdown link mismatch clearly', () => {
  assert.deepEqual(
    buildTextMismatchSummary(
      '这是一个 [Markdown 链接](https://example.com)。',
      '这是一个 Markdown 链接。'
    ),
    {
      matches: false,
      firstDiffIndex: 5,
      expectedFragment: '这是一个 [Markdown 链接](https://ex',
      actualFragment: '这是一个 Markdown 链接。',
    }
  );
});
