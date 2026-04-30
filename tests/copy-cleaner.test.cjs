const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadCopyCleanerExports() {
  const filePath = path.join(__dirname, '../scripts/copy-cleaner.user.js');
  const source = fs.readFileSync(filePath, 'utf8');
  const instrumented = source.replace(
    /\}\)\(\);\s*$/,
    "window.__copyCleanerTestExports = { cleanText: cleanText, splitByLatex: splitByLatex, buildClipboardPayloadFromSelection: buildClipboardPayloadFromSelection };})();"
  );

  if (instrumented === source) {
    throw new Error('failed to instrument copy-cleaner.user.js');
  }

  function MutationObserver() {}
  MutationObserver.prototype.observe = function () {};

  function Clipboard() {}
  Clipboard.prototype = {};

  function ClipboardItem(items) {
    this.items = items;
  }

  function Element() {}

  const document = {
    body: null,
    documentElement: {
      nodeType: 1,
      classList: { contains: function () { return false; } },
      querySelectorAll: function () { return []; },
    },
    addEventListener: function () {},
    createTextNode: function (text) {
      return { nodeType: 3, textContent: text };
    },
  };

  const window = {
    addEventListener: function () {},
    getSelection: function () { return null; },
    document: document,
  };

  const sandbox = {
    window: window,
    document: document,
    navigator: {},
    MutationObserver: MutationObserver,
    Clipboard: Clipboard,
    ClipboardItem: ClipboardItem,
    Node: {
      ELEMENT_NODE: 1,
      TEXT_NODE: 3,
      DOCUMENT_FRAGMENT_NODE: 11,
    },
    Element: Element,
    Blob: Blob,
    Promise: Promise,
    Object: Object,
    RegExp: RegExp,
    console: console,
  };

  vm.runInNewContext(instrumented, sandbox, { filename: filePath });
  return window.__copyCleanerTestExports;
}

test('copy cleaner cleanText strips AI noise while preserving latex boundaries', () => {
  const { cleanText } = loadCopyCleanerExports();
  assert.equal(
    cleanText('**AI**（人工智能）“模型”在公式$x^2$里'),
    'AI模型在公式 $x^2$ 里'
  );
});

test('copy cleaner selection payload only intercepts when text actually changes', () => {
  const { buildClipboardPayloadFromSelection } = loadCopyCleanerExports();
  const cleanedPayload = buildClipboardPayloadFromSelection({
    isCollapsed: false,
    rangeCount: 0,
    toString: function () { return '**Hello**'; },
  });

  assert.ok(cleanedPayload);
  assert.equal(cleanedPayload.text, 'Hello');

  assert.equal(
    buildClipboardPayloadFromSelection({
      isCollapsed: false,
      rangeCount: 0,
      toString: function () { return 'Hello'; },
    }),
    null
  );
});

test('copy cleaner removes old debug globals but keeps dual copy entry points', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/copy-cleaner.user.js'), 'utf8');

  assert.doesNotMatch(source, /__copyCleanerCleanText/);
  assert.doesNotMatch(source, /__copyCleanerSplitByLatex/);
  assert.doesNotMatch(source, /__copyCleanerExtractLatex/);
  assert.doesNotMatch(source, /__tampermonkeyScriptDebugExports/);
  assert.match(source, /window\.addEventListener\('copy', onCopy, true\)/);
  assert.match(source, /window\.addEventListener\('keydown', onKeydown, true\)/);
});
