const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('userscript syncs semantic snapshot into validation and extraction DOM attributes', () => {
  const source = fs.readFileSync(path.join(__dirname, '../userscripts/feishu-helper.user.js'), 'utf8');
  assert.match(source, /semanticSnapshot:\s*snap\.semanticSnapshot\s*\|\|\s*null/);
  assert.match(source, /semanticSnapshot:\s*result\s*&&\s*result\.semanticSnapshot\s*\|\|\s*null/);
  assert.match(source, /function collectSemanticSnapshot\(/);
  assert.match(source, /mergeSemanticSnapshots\s*\(/);
  assert.match(source, /collectSemanticSnapshotFromStructService\s*\(/);
  assert.match(source, /collectSemanticSnapshotFromDomFallback\s*\(/);
});

test('userscript DOM fallback covers non-text rich components beyond tables and images', () => {
  const source = fs.readFileSync(path.join(__dirname, '../userscripts/feishu-helper.user.js'), 'utf8');
  assert.match(source, /callout-container/);
  assert.match(source, /class\*="code-block"/);
  assert.match(source, /class\*="whiteboard"/);
  assert.match(source, /collectLiteralPlaceholderElements/);
});

test('userscript chooses the richest editable root instead of blindly taking the first editor block', () => {
  const source = fs.readFileSync(path.join(__dirname, '../userscripts/feishu-helper.user.js'), 'utf8');
  assert.match(source, /function scoreEditableRootCandidate\(/);
  assert.match(source, /document\.querySelectorAll\(EDITABLE_SELECTOR\)/);
  assert.doesNotMatch(source, /function getContentRootElement\(\)\s*{\s*return document\.querySelector\(CONTENT_ROOT_SELECTOR\);/);
});

test('userscript searches editor APIs starting from the chosen content root before activeElement fallbacks', () => {
  const source = fs.readFileSync(path.join(__dirname, '../userscripts/feishu-helper.user.js'), 'utf8');
  const rootIndex = source.indexOf('pushCandidate(getContentRootElement());');
  const activeIndex = source.indexOf('pushCandidate(document.activeElement);');
  assert.ok(rootIndex >= 0);
  assert.ok(activeIndex >= 0);
  assert.ok(rootIndex < activeIndex);
});

test('userscript validation fallback can scan a broader page surface than the editable root alone', () => {
  const source = fs.readFileSync(path.join(__dirname, '../userscripts/feishu-helper.user.js'), 'utf8');
  assert.match(source, /function getValidationSurfaceElement\(/);
  assert.match(source, /document\.querySelector\('main'\)/);
  assert.match(source, /document\.querySelector\('\[role="main"\]'\)/);
  assert.match(source, /document\.body/);
  assert.match(source, /return extractVisibleDomFallback\(\);/);
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

test('runner keeps the pasted target result instead of clearing it after validation', () => {
  const source = fs.readFileSync(path.join(__dirname, '../automation/feishu-runner.js'), 'utf8');
  assert.match(source, /initialSnapshot:\s*initialSnapshot/);
  assert.doesNotMatch(source, /result\.cleanup\s*=\s*await cleanupTargetDocumentToBaseline/);
  assert.doesNotMatch(source, /assertTargetCleanupResult\(result\)/);
});
