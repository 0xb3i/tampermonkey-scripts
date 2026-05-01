const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadCopyCleanerExports() {
  const filePath = path.join(__dirname, '../userscripts/copy-cleaner.user.js');
  const source = fs.readFileSync(filePath, 'utf8');
  const instrumented = source.replace(
    /\}\)\(\);\s*$/,
    "window.__copyCleanerTestExports = { cleanText: cleanText, splitByLatex: splitByLatex, normalizeClipboardText: normalizeClipboardText, normalizeStructuredMarkdownForPaste: normalizeStructuredMarkdownForPaste, buildClipboardPayloadFromSelection: buildClipboardPayloadFromSelection, serializeStructuredFragment: serializeStructuredFragment, extractFragmentText: extractFragmentText };})();"
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

test('copy cleaner selection payload uses structured serialization for rich paragraph links', () => {
  const { buildClipboardPayloadFromSelection } = loadCopyCleanerExports();
  const paragraph = createElement('P', [
    createTextNode('链接：'),
    createLink('https://example.com', '示例'),
  ]);
  const fragment = createFragment([paragraph]);
  const payload = buildClipboardPayloadFromSelection({
    isCollapsed: false,
    rangeCount: 1,
    toString: function () { return '链接：示例'; },
    getRangeAt: function () {
      return {
        startContainer: createTextNode('链接：'),
        endContainer: createTextNode('示例'),
        cloneRange: function () { return this; },
        cloneContents: function () { return fragment; },
      };
    },
  });

  assert.ok(payload);
  assert.equal(payload.text, '链接：[示例](https://example.com)');
});

test('copy cleaner selection payload preserves nested ordered lists for structured selections', () => {
  const { buildClipboardPayloadFromSelection } = loadCopyCleanerExports();
  const fragment = createFragment([
    createElement('OL', [
      createElement('LI', [
        createElement('P', [createTextNode('第一点')]),
      ]),
      createElement('LI', [
        createElement('P', [createTextNode('第二点')]),
        createElement('OL', [
          createElement('LI', [
            createElement('P', [createTextNode('子点 2.1')]),
          ]),
          createElement('LI', [
            createElement('P', [createTextNode('子点 2.2')]),
          ]),
        ]),
      ]),
    ]),
  ]);
  const payload = buildClipboardPayloadFromSelection({
    isCollapsed: false,
    rangeCount: 1,
    toString: function () { return '第一点第二点子点 2.1子点 2.2'; },
    getRangeAt: function () {
      return {
        startContainer: createTextNode('第一点'),
        endContainer: createTextNode('子点 2.2'),
        cloneRange: function () { return this; },
        cloneContents: function () { return fragment; },
      };
    },
  });

  assert.ok(payload);
  assert.equal(
    payload.text,
    [
      '1. 第一点',
      '2. 第二点',
      '    1. 子点 2.1',
      '    2. 子点 2.2',
    ].join('\n')
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

test('copy cleaner inserts a blank line after markdown tables for Feishu rendering', () => {
  const { normalizeStructuredMarkdownForPaste } = loadCopyCleanerExports();
  assert.equal(
    normalizeStructuredMarkdownForPaste([
      '| 姓名 | 角色 | 状态 |',
      '| --- | --- | --- |',
      '| 张三 | 开发 | 已完成 |',
      '下面是一段包含图片语法的文本：',
    ].join('\n')),
    [
      '| 姓名 | 角色 | 状态 |',
      '| --- | --- | --- |',
      '| 张三 | 开发 | 已完成 |',
      '',
      '下面是一段包含图片语法的文本：',
    ].join('\n')
  );
});

test('copy cleaner removes old debug globals but keeps dual copy entry points', () => {
  const source = fs.readFileSync(path.join(__dirname, '../userscripts/copy-cleaner.user.js'), 'utf8');

  assert.doesNotMatch(source, /__copyCleanerCleanText/);
  assert.doesNotMatch(source, /__copyCleanerSplitByLatex/);
  assert.doesNotMatch(source, /__copyCleanerExtractLatex/);
  assert.doesNotMatch(source, /__tampermonkeyScriptDebugExports/);
  assert.match(source, /window\.addEventListener\('copy', onCopy, true\)/);
  assert.match(source, /window\.addEventListener\('keydown', onKeydown, true\)/);
  assert.match(source, /window\.addEventListener\('click', onChatGptCopyButtonClick, true\)/);
  assert.match(source, /window\.addEventListener\('click', onTikaCopyButtonClick, true\)/);
  assert.match(source, /data-copy-cleaner-tika-copy/);
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
  let prevElement = null;
  for (let i = 0; i < children.length; i++) {
    children[i].parentElement = parent;
    children[i].nextSibling = children[i + 1] || null;
    if (children[i].nodeType === 1) {
      children[i].previousElementSibling = prevElement;
      if (prevElement) prevElement.nextElementSibling = children[i];
      children[i].nextElementSibling = null;
      prevElement = children[i];
    }
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
    if (selector === '*' || node.tagName === selector) return node;
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

function setAttributes(element, attrs) {
  attrs = attrs || {};
  element.getAttribute = function (name) {
    return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : '';
  };
  element.hasAttribute = function (name) {
    return Object.prototype.hasOwnProperty.call(attrs, name);
  };
  if (Object.prototype.hasOwnProperty.call(attrs, 'class')) {
    element.className = attrs.class;
  }
  return element;
}

function createLink(href, text) {
  const link = createElement('A', [createTextNode(text)]);
  link.getAttribute = function (name) {
    return name === 'href' ? href : '';
  };
  link.hasAttribute = function (name) {
    return name === 'href';
  };
  return link;
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
        if (selectors.includes('*') || selectors.includes(node.tagName)) return node;
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

test('copy cleaner preserves quotes inside inline code when structured fragments are serialized', () => {
  const { extractFragmentText } = loadCopyCleanerExports();
  const fragment = createFragment([
    createElement('P', [
      createTextNode('行内代码：'),
      createElement('CODE', [createTextNode('print("Hello")')]),
    ]),
  ]);

  assert.equal(
    extractFragmentText(fragment, '行内代码：print("Hello")'),
    '行内代码：`print("Hello")`'
  );
});

test('copy cleaner preserves markdown links when structured fragments are serialized', () => {
  const { extractFragmentText } = loadCopyCleanerExports();
  const fragment = createFragment([
    createElement('UL', [
      createElement('LI', [
        createElement('P', [
          createTextNode('链接：'),
          createLink('https://www.baidu.com', '百度'),
        ]),
      ]),
    ]),
  ]);

  assert.equal(
    extractFragmentText(fragment, '链接：百度'),
    '- 链接：[百度](https://www.baidu.com)'
  );
});

test('copy cleaner skips code block headers outside pre when container already exposes data-testid code_block', () => {
  const { serializeStructuredFragment } = loadCopyCleanerExports();
  const code = setAttributes(createElement('CODE', [
    createTextNode('def hello():\n    print("Hello, Markdown!")\n\nhello()\n'),
  ]), { class: 'language-python' });
  const pre = setAttributes(createElement('PRE', [code]), { class: 'language-python' });
  const header = createElement('DIV', [createTextNode('python')]);
  const container = setAttributes(createElement('DIV', [header, pre]), { 'data-testid': 'code_block' });
  const fragment = createFragment([container]);

  assert.equal(
    serializeStructuredFragment(fragment),
    [
      '```python',
      'def hello():',
      '    print("Hello, Markdown!")',
      '',
      'hello()',
      '```',
    ].join('\n')
  );
});

test('copy cleaner skips empty svg placeholder images in structured serialization', () => {
  const { extractFragmentText } = loadCopyCleanerExports();
  const placeholder = setAttributes(createElement('IMG'), {
    src: 'data:image/svg+xml,%3csvg%20xmlns=%27http://www.w3.org/2000/svg%27/%3e',
    alt: '',
  });
  const realImage = setAttributes(createElement('IMG'), {
    src: 'https://example.com/image.png',
    alt: 'image',
  });
  const fragment = createFragment([
    createElement('P', [
      createTextNode('图片：'),
      placeholder,
      realImage,
    ]),
  ]);

  assert.equal(
    extractFragmentText(fragment, '图片：'),
    '图片：![image](https://example.com/image.png)'
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
    '```python\nfor i in range(3):\n    print(i)\n```'
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

test('copy cleaner uses Feishu-friendly indentation for nested ordered lists', () => {
  const { serializeStructuredFragment } = loadCopyCleanerExports();
  const fragment = createFragment([
    createElement('OL', [
      createElement('LI', [
        createElement('P', [createTextNode('第一点')]),
      ]),
      createElement('LI', [
        createElement('P', [createTextNode('第二点')]),
        createElement('OL', [
          createElement('LI', [
            createElement('P', [createTextNode('子点 2.1')]),
          ]),
          createElement('LI', [
            createElement('P', [createTextNode('子点 2.2')]),
          ]),
        ]),
      ]),
      createElement('LI', [
        createElement('P', [createTextNode('第三点')]),
      ]),
    ]),
  ]);

  assert.equal(
    serializeStructuredFragment(fragment),
    [
      '1. 第一点',
      '2. 第二点',
      '    1. 子点 2.1',
      '    2. 子点 2.2',
      '3. 第三点',
    ].join('\n')
  );
});

test('copy cleaner uses four spaces for unordered sublists nested under ordered items', () => {
  const { serializeStructuredFragment } = loadCopyCleanerExports();
  const fragment = createFragment([
    createElement('OL', [
      createElement('LI', [
        createElement('P', [createTextNode('打开文档')]),
      ]),
      createElement('LI', [
        createElement('P', [createTextNode('输入以下内容：')]),
        createElement('UL', [
          createElement('LI', [
            createElement('P', [createTextNode('使用 粗体 强调重点')]),
          ]),
          createElement('LI', [
            createElement('P', [createTextNode('使用 斜体 表示术语')]),
          ]),
          createElement('LI', [
            createElement('P', [createTextNode('使用 `代码` 表示命令')]),
          ]),
        ]),
      ]),
    ]),
  ]);

  assert.equal(
    serializeStructuredFragment(fragment),
    [
      '1. 打开文档',
      '2. 输入以下内容：',
      '    - 使用 粗体 强调重点',
      '    - 使用 斜体 表示术语',
      '    - 使用 `代码` 表示命令',
    ].join('\n')
  );
});

test('copy cleaner extracts ChatGPT code blocks from rendered pre text with language header', () => {
  const { serializeStructuredFragment } = loadCopyCleanerExports();
  const code = createElement('CODE', [
    createTextNode('def greet(name):    print(f"Hello, {name}!")greet("World")'),
  ]);
  code.innerText = '';
  const pre = createElement('PRE', [code]);
  pre.innerText = 'Python\n运行\ndef greet(name):\n    print(f"Hello, {name}!")\ngreet("World")';
  const fragment = createFragment([pre]);

  assert.equal(
    serializeStructuredFragment(fragment),
    [
      '```python',
      'def greet(name):',
      '    print(f"Hello, {name}!")',
      'greet("World")',
      '```',
    ].join('\n')
  );
});
