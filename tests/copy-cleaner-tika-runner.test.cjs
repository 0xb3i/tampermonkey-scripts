const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_TIKA_CASE_ID,
  getTikaRealTestCase,
} = require('../automation/copy-cleaner-tika-cases.cjs');
const {
  parseCliArgs,
} = require('../automation/copy-cleaner-tika-runner.js');
const {
  buildTextMismatchSummary,
} = require('../automation/copy-cleaner-runner-utils.cjs');

test('tika real test exposes the default standard case', () => {
  const testCase = getTikaRealTestCase(DEFAULT_TIKA_CASE_ID);
  assert.equal(testCase.id, DEFAULT_TIKA_CASE_ID);
  assert.equal(testCase.url, 'https://tika.byteintl.net/search?conversation_id=1077720878852');
  assert.equal(testCase.useExistingAssistantReply, true);
  assert.match(testCase.expectedText, /# 一级标题/);
  assert.match(testCase.expectedText, /\[Markdown 链接\]\(https:\/\/example\.com\)/);
  assert.match(testCase.expectedText, /\$\$a\^2 \+ b\^2 = c\^2\$\$/);
});

test('tika runner parseCliArgs keeps boolean flags and key-value pairs', () => {
  assert.deepEqual(parseCliArgs([
    '--case', DEFAULT_TIKA_CASE_ID,
    '--list-cases',
    '--url', 'https://tika.byteintl.net/search?conversation_id=1077720878852',
  ]), {
    case: DEFAULT_TIKA_CASE_ID,
    'list-cases': true,
    url: 'https://tika.byteintl.net/search?conversation_id=1077720878852',
  });
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
