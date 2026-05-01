const test = require('node:test');
const assert = require('node:assert/strict');

const rootExports = require('../index.js');
const {
  buildHelpText,
  parseCliArgs,
} = require('../bin/tampermonkey-sync-cli.cjs');

test('tampermonkey sync cli parses boolean flags and key-value pairs', () => {
  assert.deepEqual(parseCliArgs([
    '--script-path', './userscripts/copy-cleaner.user.js',
    '--json',
    '--cdp-url', 'http://127.0.0.1:9222',
  ]), {
    'script-path': './userscripts/copy-cleaner.user.js',
    json: true,
    'cdp-url': 'http://127.0.0.1:9222',
  });
});

test('tampermonkey sync cli help documents required usage', () => {
  const help = buildHelpText();
  assert.match(help, /Usage:/);
  assert.match(help, /--script-path <path>/);
  assert.match(help, /--cdp-url <url>/);
  assert.match(help, /--json/);
});

test('package root exports high-level tampermonkey sync helper', () => {
  assert.equal(typeof rootExports.syncUserscriptToTampermonkey, 'function');
  assert.equal(typeof rootExports.syncUserscriptInBrowser, 'function');
  assert.equal(typeof rootExports.syncTampermonkeyScript, 'function');
});
