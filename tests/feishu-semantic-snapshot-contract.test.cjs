const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('userscript syncs semantic snapshot into validation and extraction DOM attributes', () => {
  const source = fs.readFileSync(path.join(__dirname, '../userscripts/feishu-helper.user.js'), 'utf8');
  assert.match(source, /semanticSnapshot:\s*snap\.semanticSnapshot\s*\|\|\s*null/);
  assert.match(source, /semanticSnapshot:\s*result\s*&&\s*result\.semanticSnapshot\s*\|\|\s*null/);
  assert.match(source, /function collectSemanticSnapshot\(/);
});

test('userscript exposes validateDuplicateDocument automation action instead of real-test naming', () => {
  const source = fs.readFileSync(path.join(__dirname, '../userscripts/feishu-helper.user.js'), 'utf8');
  assert.match(source, /validateDuplicateDocument/);
  assert.doesNotMatch(source, /realTestDuplicateDocument/);
});

test('userscript exposes upload result counts for runner assertions', () => {
  const source = fs.readFileSync(path.join(__dirname, '../userscripts/feishu-helper.user.js'), 'utf8');
  assert.match(source, /uploadedCount:/);
  assert.match(source, /failedCount:/);
  assert.match(source, /attemptedCount:/);
});
