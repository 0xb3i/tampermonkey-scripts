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

test('default feishu case validates key target components instead of requiring source-target count parity', () => {
  const testCase = getFeishuCase(DEFAULT_CASE_ID);
  assert.deepEqual(testCase.expect.render.requiredTargetComponents.map(function (rule) {
    return rule.type;
  }), [
    'callout',
    'table',
    'image',
    'code_block',
    'whiteboard',
  ]);
  assert.equal(testCase.expect.render.requiredTargetComponents[2].requireRendered, true);
  assert.equal(testCase.expect.upload.minUploadedCount, 3);
  assert.equal(testCase.expect.render.compareSourceComponents, undefined);
});

test('listFeishuCases returns all feishu cases', () => {
  const all = listFeishuCases();
  assert.ok(all.length >= 2);
  assert.equal(all[0].id, DEFAULT_CASE_ID);
  assert.ok(all.some(function (testCase) {
    return testCase.id === 'feishu-docx-to-wiki-equation';
  }));
});

test('equation feishu case uses the dedicated source document and equation-only assertions', () => {
  const testCase = getFeishuCase('feishu-docx-to-wiki-equation');
  assert.equal(
    testCase.sourceUrl,
    'https://bytedance.larkoffice.com/docx/EdpId2k96o7tFzxZVb8cF8QInVh'
  );
  assert.equal(testCase.expect.extraction.minEquationCount, 5);
  assert.deepEqual(testCase.expect.extraction.requiredSourceComponentTypes, ['equation']);
  assert.deepEqual(testCase.expect.render.requiredTargetComponents[0].requiredTextGroups, [
    ['\\beta', 'β'],
    ['D_{\\text{JSD}}', 'JSD'],
    ['\\mathrm{KL}', 'KL'],
  ]);
});

test('getFeishuCase throws for unknown case id', () => {
  assert.throws(function () {
    getFeishuCase('missing-feishu-case');
  }, /Unknown Feishu case/);
});
