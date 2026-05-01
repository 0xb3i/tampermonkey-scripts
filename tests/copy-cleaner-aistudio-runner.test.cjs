const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_AISTUDIO_CASE_ID,
  getAiStudioRealTestCase,
  listAiStudioRealTestCases,
} = require('../automation/copy-cleaner-aistudio-cases.cjs');
const { runCopyCleanerAiStudioRealTest } = require('../automation/copy-cleaner-aistudio-runner.js');

test('AI Studio real test cases expose a stable default oracle', () => {
  const cases = listAiStudioRealTestCases();
  assert.ok(cases.length >= 1);
  const target = getAiStudioRealTestCase(DEFAULT_AISTUDIO_CASE_ID);
  assert.equal(target.id, DEFAULT_AISTUDIO_CASE_ID);
  assert.match(target.url, /^https:\/\/aistudio\.google\.com\//);
  assert.match(target.description, /Copy as markdown/);
  assert.match(target.expectedText, /```python/);
  assert.match(target.expectedText, /\[google_link\]: https:\/\/www\.google\.com/);
});

test('AI Studio runner exports the real test entry point', () => {
  assert.equal(typeof runCopyCleanerAiStudioRealTest, 'function');
});
