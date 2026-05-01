const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_CHATGPT_CASE_ID,
  getChatGPTRealTestCase,
} = require('../automation/copy-cleaner-chatgpt-cases.cjs');
const {
  buildTextMismatchSummary,
  parseCliArgs,
} = require('../automation/copy-cleaner-chatgpt-runner.js');
const { buildExactTextMismatchSummary } = require('../automation/copy-cleaner-runner-utils.cjs');

test('chatgpt real test exposes the default standard case', () => {
  const testCase = getChatGPTRealTestCase(DEFAULT_CHATGPT_CASE_ID);
  assert.equal(testCase.id, DEFAULT_CHATGPT_CASE_ID);
  assert.equal(testCase.url, 'https://chatgpt.com/c/69f45156-a908-83e8-a147-f694e7d9c109');
  assert.equal(testCase.useExistingAssistantReply, true);
  assert.match(testCase.expectedText, /Markdown 常见语法样式：/);
  assert.match(testCase.expectedText, /```python/);
});

test('chatgpt runner parseCliArgs keeps boolean flags and key-value pairs', () => {
  assert.deepEqual(parseCliArgs([
    '--case', DEFAULT_CHATGPT_CASE_ID,
    '--list-cases',
    '--url', 'https://chatgpt.com/',
  ]), {
    case: DEFAULT_CHATGPT_CASE_ID,
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
