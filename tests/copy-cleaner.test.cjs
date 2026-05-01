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
    "window.__copyCleanerTestExports = { cleanText: cleanText, splitByLatex: splitByLatex, normalizeClipboardText: normalizeClipboardText, buildClipboardPayloadFromSelection: buildClipboardPayloadFromSelection, serializeStructuredFragment: serializeStructuredFragment, extractFragmentText: extractFragmentText };})();"
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

test('copy cleaner keeps indentation for plain code copied through clipboard text path', () => {
  const { normalizeClipboardText } = loadCopyCleanerExports();
  const code = 'def foo():\n    x = 1\n\n    if x:\n        print(x)';
  assert.equal(normalizeClipboardText(code), code);
});

test('copy cleaner preserves fenced code blocks when normalizing markdown clipboard text', () => {
  const { normalizeClipboardText } = loadCopyCleanerExports();
  const input = [
    '**说明**',
    '```python',
    'def foo():',
    '    x = 1',
    '',
    '    if x:',
    '        print(x)',
    '```',
    '**结束**',
  ].join('\n');
  assert.equal(
    normalizeClipboardText(input),
    [
      '说明',
      '```python',
      'def foo():',
      '    x = 1',
      '',
      '    if x:',
      '        print(x)',
      '```',
      '结束',
    ].join('\n')
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

function createTextNode(text) {
  return {
    nodeType: 3,
    nodeValue: text,
    textContent: text,
    parentElement: null,
    nextSibling: null,
  };
}

function linkChildren(parent, children) {
  parent.firstChild = children[0] || null;
  for (let i = 0; i < children.length; i++) {
    children[i].parentElement = parent;
    children[i].nextSibling = children[i + 1] || null;
  }
}

function createElement(tagName, children) {
  const element = {
    nodeType: 1,
    tagName: tagName,
    parentElement: null,
    nextSibling: null,
    firstChild: null,
    children: [],
    firstElementChild: null,
    classList: { contains: function () { return false; } },
    querySelector: function (selector) {
      selector = String(selector || '').toUpperCase();
      function visit(node) {
        if (!node || node.nodeType !== 1) return null;
        if (node.tagName === selector) return node;
        for (let child = node.firstChild; child; child = child.nextSibling) {
          const found = visit(child);
          if (found) return found;
        }
        return null;
      }
      return visit(this);
    },
  };
  children = children || [];
  element.children = children.filter(function (child) {
    return child.nodeType === 1;
  });
  element.firstElementChild = element.children[0] || null;
  linkChildren(element, children);
  Object.defineProperty(element, 'textContent', {
    get: function () {
      let text = '';
      for (let child = this.firstChild; child; child = child.nextSibling) {
        text += child.textContent || child.nodeValue || '';
      }
      return text;
    },
  });
  return element;
}

function createFragment(children) {
  const fragment = {
    nodeType: 11,
    firstChild: null,
    querySelector: function (selector) {
      const selectors = String(selector || '').split(',').map(function (item) {
        return item.trim().toUpperCase().split(/\s+/).pop();
      }).filter(Boolean);
      function visit(node) {
        if (!node || node.nodeType !== 1) return null;
        if (selectors.includes(node.tagName)) return node;
        for (let child = node.firstChild; child; child = child.nextSibling) {
          const found = visit(child);
          if (found) return found;
        }
        return null;
      }
      for (let child = fragment.firstChild; child; child = child.nextSibling) {
        const found = visit(child);
        if (found) return found;
      }
      return null;
    },
  };
  linkChildren(fragment, children || []);
  return fragment;
}

test('copy cleaner preserves inline code when structured fragments are serialized', () => {
  const { extractFragmentText } = loadCopyCleanerExports();
  const fragment = createFragment([
    createElement('P', [
      createTextNode('请运行 '),
      createElement('CODE', [createTextNode('const x = 1')]),
      createTextNode(' 再继续'),
    ]),
  ]);

  assert.equal(
    extractFragmentText(fragment, '请运行 const x = 1 再继续'),
    '请运行 `const x = 1` 再继续'
  );
});

test('copy cleaner preserves fenced code blocks for wrapped pre/code structures', () => {
  const { serializeStructuredFragment } = loadCopyCleanerExports();
  const fragment = createFragment([
    createElement('DIV', [
      createElement('PRE', [
        createElement('DIV', [createTextNode('Python')]),
        createElement('DIV', [
          createElement('CODE', [
            createTextNode('for i in range(3):\n    print(i)\n'),
          ]),
        ]),
      ]),
    ]),
  ]);

  assert.equal(
    serializeStructuredFragment(fragment),
    '```\nfor i in range(3):\n    print(i)\n```'
  );
});

test('copy cleaner uses rendered code layout when chatgpt code DOM stores line breaks as br tags', () => {
  const { serializeStructuredFragment } = loadCopyCleanerExports();
  const code = createElement('CODE', [
    createTextNode('def foo():'),
    createElement('BR'),
    createTextNode('\u00a0\u00a0\u00a0\u00a0x = 1'),
    createElement('BR'),
    createElement('BR'),
    createTextNode('\u00a0\u00a0\u00a0\u00a0if x:'),
    createElement('BR'),
    createTextNode('\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0print(x)'),
  ]);
  code.innerText = 'def foo():\n    x = 1\n\n    if x:\n        print(x)';
  const fragment = createFragment([
    createElement('PRE', [code]),
  ]);

  assert.equal(
    serializeStructuredFragment(fragment),
    '```\ndef foo():\n    x = 1\n\n    if x:\n        print(x)\n```'
  );
});
