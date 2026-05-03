const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_CASE_ID,
  getFeishuCase,
  listFeishuCases,
} = require('../automation/feishu-cases.cjs');

test('default feishu case exposes fixed source and target documents', () => {
  const testCase = getFeishuCase(DEFAULT_CASE_ID);
  assert.equal(testCase.id, DEFAULT_CASE_ID);
  assert.equal(
    testCase.sourceUrl,
    'https://bytedance.larkoffice.com/docx/H3qVdELWFojYlIx1dBmcqcQMnUd'
  );
  assert.equal(
    testCase.targetUrl,
    'https://bytedance.larkoffice.com/wiki/Eoqpwyw4SiUrJdkphu0cSqFxnWd'
  );
  assert.equal(testCase.action, 'validateDuplicateDocument');
});

test('default feishu case enables semantic source-target component validation', () => {
  const testCase = getFeishuCase(DEFAULT_CASE_ID);
  assert.deepEqual(testCase.expect.render.compareSourceComponents.componentTypes, [
    'callout',
    'table',
    'image',
    'equation',
    'quote',
    'code_block',
    'divider',
    'grid',
    'bookmark',
  ]);
  assert.equal(testCase.expect.render.compareSourceComponents.requireRenderedImages, true);
  assert.equal(testCase.expect.upload.requireUploadedImages, true);
});

test('listFeishuCases returns all feishu cases', () => {
  const all = listFeishuCases();
  assert.ok(all.length >= 1);
  assert.equal(all[0].id, DEFAULT_CASE_ID);
});

test('getFeishuCase throws for unknown case id', () => {
  assert.throws(function () {
    getFeishuCase('missing-feishu-case');
  }, /Unknown Feishu case/);
});
