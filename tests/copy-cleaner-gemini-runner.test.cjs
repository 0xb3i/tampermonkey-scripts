const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_GEMINI_CASE_ID,
  getGeminiRealTestCase,
} = require('../automation/copy-cleaner-gemini-cases.cjs');
const {
  parseCliArgs,
} = require('../automation/copy-cleaner-gemini-runner.js');
const {
  buildTextMismatchSummary,
} = require('../automation/copy-cleaner-runner-utils.cjs');

test('gemini real test exposes the default standard case', () => {
  const testCase = getGeminiRealTestCase(DEFAULT_GEMINI_CASE_ID);
  assert.equal(testCase.id, DEFAULT_GEMINI_CASE_ID);
  assert.equal(testCase.url, 'https://gemini.google.com/app/29c1ebf2ba2d1d74');
  assert.equal(testCase.useExistingAssistantReply, true);
  assert.match(testCase.expectedText, /## 1\. 基础文本样式/);
  assert.match(testCase.expectedText, /\| 样式类别 \| 语法示例 \| 适用场景 \|/);
  assert.match(testCase.expectedText, /\[Markdown 官方教程\]\(https:\/\/www\.markdownguide\.org\)/);
});

test('gemini runner parseCliArgs keeps boolean flags and key-value pairs', () => {
  assert.deepEqual(parseCliArgs([
    '--case', DEFAULT_GEMINI_CASE_ID,
    '--list-cases',
    '--url', 'https://gemini.google.com/app/29c1ebf2ba2d1d74',
  ]), {
    case: DEFAULT_GEMINI_CASE_ID,
    'list-cases': true,
    url: 'https://gemini.google.com/app/29c1ebf2ba2d1d74',
  });
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
