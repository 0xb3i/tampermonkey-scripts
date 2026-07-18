const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const ROOT = resolve(__dirname, '..');

test('repository exposes only browser-independent test commands', () => {
  const packageJson = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));

  assert.deepEqual(packageJson.scripts, {
    test: 'node --test ./tests/*.test.cjs',
  });
  assert.equal(packageJson.version, '2.0.0');
  assert.equal(packageJson.main, undefined);
  assert.equal(packageJson.bin, undefined);
  assert.equal(packageJson.dependencies, undefined);
  assert.equal(packageJson.devDependencies, undefined);
});

test('legacy in-repository browser automation stays removed', () => {
  ['automation', 'bin', 'lib', 'index.js'].forEach((path) => {
    assert.equal(existsSync(resolve(ROOT, path)), false, path + ' should not exist');
  });

  const readme = readFileSync(resolve(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /Chrome DevTools MCP/);
  assert.doesNotMatch(readme, /tampermonkey:sync|copycleaner:|connectOverCDP|127\.0\.0\.1:9222|Playwright/);
});
