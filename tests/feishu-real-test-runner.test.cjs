const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assertAutomationResult,
  isFeishuDocUrl,
  parseCliArgs,
} = require('../scripts/feishu-real-test-runner.js');

test('isFeishuDocUrl accepts supported Feishu document URLs', () => {
  assert.equal(isFeishuDocUrl('https://bytedance.feishu.cn/docx/abc123'), true);
  assert.equal(isFeishuDocUrl('https://foo.larksuite.com/wiki/xyz789'), true);
  assert.equal(isFeishuDocUrl('https://foo.larkoffice.com/doc/token'), true);
});

test('isFeishuDocUrl rejects non-document and non-Feishu URLs', () => {
  assert.equal(isFeishuDocUrl('https://chatgpt.com/'), false);
  assert.equal(isFeishuDocUrl('https://bytedance.feishu.cn/base/abc123'), false);
  assert.equal(isFeishuDocUrl('not-a-url'), false);
});

test('parseCliArgs keeps boolean flags and key-value pairs', () => {
  assert.deepEqual(parseCliArgs([
    '--url', 'https://bytedance.feishu.cn/docx/abc123',
    '--dry-run',
    '--timeout', '3000',
  ]), {
    url: 'https://bytedance.feishu.cn/docx/abc123',
    'dry-run': true,
    timeout: '3000',
  });
});

test('assertAutomationResult accepts successful automation payloads', () => {
  assert.doesNotThrow(function () {
    assertAutomationResult({
      status: 'success',
      summary: {
        title: 'Demo',
        pendingPaste: {
          ts: Date.now(),
        },
        validationSnapshot: {
          blockCount: 2,
        },
      },
    }, {
      helperVersion: '4.2.18',
      validationSnapshot: null,
    });
  });
});

test('assertAutomationResult rejects missing pending paste updates', () => {
  assert.throws(function () {
    assertAutomationResult({
      status: 'success',
      summary: {
        title: 'Demo',
        validationSnapshot: {
          blockCount: 2,
        },
      },
    }, {
      helperVersion: '4.2.18',
      validationSnapshot: null,
    });
  }, /Pending paste cache was not updated/);
});
