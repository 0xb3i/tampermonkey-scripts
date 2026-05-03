const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_CASE_IDS,
  getRealTestCase,
  listRealTestCases,
} = require('../automation/copy-cleaner-cases.cjs');
const {
  ADAPTERS,
  defaultNavigateToPage,
  ensurePageFocusForClipboard,
  findExistingPageForUrl,
  navigateExistingPageOrCurrent,
  readClipboardTextWithFocus,
  parseCliArgs,
  runCopyCleanerRealTest,
} = require('../automation/copy-cleaner-runner.js');
const {
  buildExactTextMismatchSummary,
  buildTextMismatchSummary,
} = require('../automation/copy-cleaner-runner-utils.cjs');

test('aistudio default case exposes stable oracle', () => {
  const testCase = getRealTestCase('aistudio', DEFAULT_CASE_IDS.aistudio);
  assert.equal(testCase.id, DEFAULT_CASE_IDS.aistudio);
  assert.match(testCase.url, /^https:\/\/aistudio\.google\.com\//);
  assert.match(testCase.description, /Copy as markdown/);
  assert.match(testCase.expectedText, /```python/);
  assert.match(testCase.expectedText, /\[google_link\]: https:\/\/www\.google\.com/);
});

test('chatgpt default case exposes stable oracle', () => {
  const testCase = getRealTestCase('chatgpt', DEFAULT_CASE_IDS.chatgpt);
  assert.equal(testCase.id, DEFAULT_CASE_IDS.chatgpt);
  assert.equal(testCase.url, 'https://chatgpt.com/c/69f45156-a908-83e8-a147-f694e7d9c109');
  assert.equal(testCase.useExistingAssistantReply, true);
  assert.match(testCase.expectedText, /Markdown 常见语法样式：/);
  assert.match(testCase.expectedText, /```python/);
});

test('gemini default case exposes stable oracle', () => {
  const testCase = getRealTestCase('gemini', DEFAULT_CASE_IDS.gemini);
  assert.equal(testCase.id, DEFAULT_CASE_IDS.gemini);
  assert.equal(testCase.url, 'https://gemini.google.com/app/29c1ebf2ba2d1d74');
  assert.equal(testCase.useExistingAssistantReply, true);
  assert.match(testCase.expectedText, /## 1\. 基础文本样式/);
  assert.match(testCase.expectedText, /\| 样式类别 \| 语法示例 \| 适用场景 \|/);
  assert.match(testCase.expectedText, /\[Markdown 官方教程\]\(https:\/\/www\.markdownguide\.org\)/);
});

test('tika default case exposes stable oracle', () => {
  const testCase = getRealTestCase('tika', DEFAULT_CASE_IDS.tika);
  assert.equal(testCase.id, DEFAULT_CASE_IDS.tika);
  assert.equal(testCase.url, 'https://tika.byteintl.net/search?conversation_id=1077720878852');
  assert.equal(testCase.useExistingAssistantReply, true);
  assert.match(testCase.expectedText, /# 一级标题/);
  assert.match(testCase.expectedText, /\[Markdown 链接\]\(https:\/\/example\.com\)/);
  assert.match(testCase.expectedText, /\$\$a\^2 \+ b\^2 = c\^2\$\$/);
});

test('listRealTestCases returns all cases across sites', () => {
  const all = listRealTestCases();
  assert.ok(all.length >= 5);
  const aistudio = listRealTestCases('aistudio');
  assert.equal(aistudio.length, 1);
  const chatgpt = listRealTestCases('chatgpt');
  assert.equal(chatgpt.length, 2);
});

test('getRealTestCase throws for unknown site', () => {
  assert.throws(function () { getRealTestCase('unknown'); }, /Unknown site/);
});

test('getRealTestCase throws for unknown case', () => {
  assert.throws(function () { getRealTestCase('chatgpt', 'nonexistent'); }, /Unknown chatgpt real test case/);
});

test('runner exports the real test entry point', () => {
  assert.equal(typeof runCopyCleanerRealTest, 'function');
});

test('structured intercept site adapters require page markers during verification', () => {
  assert.equal(ADAPTERS.chatgpt.requirePageMarker, true);
  assert.equal(ADAPTERS.tika.requirePageMarker, true);
});

test('findExistingPageForUrl prefers an already-open matching target page', () => {
  const currentPage = {
    url: function () {
      return 'chrome-extension://dhdgffkkebhmkfjojejmpbldmpobfkfo/options.html#nav=dashboard';
    },
  };
  const targetPage = {
    url: function () {
      return 'https://tika.byteintl.net/search?conversation_id=1077720878852';
    },
  };
  const context = {
    pages: function () {
      return [currentPage, targetPage];
    },
  };

  assert.equal(
    findExistingPageForUrl(context, 'https://tika.byteintl.net/search?conversation_id=1077720878852', currentPage),
    targetPage
  );
});

test('defaultNavigateToPage always navigates the provided page for general sites', async () => {
  const calls = [];
  const currentPage = {
    url: function () {
      return 'chrome-extension://dhdgffkkebhmkfjojejmpbldmpobfkfo/options.html#nav=dashboard';
    },
    bringToFront: async function () {
      calls.push('current:bringToFront');
    },
    goto: async function (url) {
      calls.push(['goto', url]);
    },
    waitForLoadState: async function (state) {
      calls.push(['waitForLoadState', state]);
    },
    reload: async function () {
      calls.push('current:reload');
    },
  };
  const context = {
    grantPermissions: async function (permissions, options) {
      calls.push(['grantPermissions', permissions, options]);
    },
  };

  const result = await defaultNavigateToPage(context, currentPage, 'https://chatgpt.com/c/69f45156-a908-83e8-a147-f694e7d9c109');

  assert.equal(result, currentPage);
  assert.deepEqual(calls, [
    'current:bringToFront',
    ['goto', 'https://chatgpt.com/c/69f45156-a908-83e8-a147-f694e7d9c109'],
    ['waitForLoadState', 'domcontentloaded'],
    ['grantPermissions', ['clipboard-read', 'clipboard-write'], { origin: 'https://chatgpt.com' }],
    'current:reload',
  ]);
});

test('navigateExistingPageOrCurrent reuses an existing target page for Tika-style fixed conversations', async () => {
  const calls = [];
  const currentPage = {
    url: function () {
      return 'chrome-extension://dhdgffkkebhmkfjojejmpbldmpobfkfo/options.html#nav=dashboard';
    },
    bringToFront: async function () {
      calls.push('current:bringToFront');
    },
    reload: async function () {
      calls.push('current:reload');
    },
  };
  const targetPage = {
    url: function () {
      return 'https://tika.byteintl.net/search?conversation_id=1077720878852';
    },
    bringToFront: async function () {
      calls.push('target:bringToFront');
    },
    reload: async function () {
      calls.push('target:reload');
    },
    context: function () {
      return context;
    },
  };
  const context = {
    pages: function () {
      return [currentPage, targetPage];
    },
    grantPermissions: async function (permissions, options) {
      calls.push(['grantPermissions', permissions, options]);
    },
  };

  const result = await navigateExistingPageOrCurrent(context, currentPage, 'https://tika.byteintl.net/search?conversation_id=1077720878852');

  assert.equal(result, targetPage);
  assert.deepEqual(calls, [
    'target:bringToFront',
    ['grantPermissions', ['clipboard-read', 'clipboard-write'], { origin: 'https://tika.byteintl.net' }],
    'target:reload',
  ]);
});

test('ensurePageFocusForClipboard retries body click when the page is not focused yet', async () => {
  const calls = [];
  let evaluateCount = 0;
  const page = {
    bringToFront: async function () {
      calls.push('bringToFront');
    },
    evaluate: async function () {
      evaluateCount += 1;
      calls.push('evaluate:' + evaluateCount);
      if (evaluateCount === 1) {
        return { active: false, visibility: 'hidden' };
      }
      return { active: true, visibility: 'visible' };
    },
    locator: function (selector) {
      calls.push('locator:' + selector);
      return {
        click: async function () {
          calls.push('click:' + selector);
        },
      };
    },
  };

  const result = await ensurePageFocusForClipboard(page);

  assert.deepEqual(result, { active: true, visibility: 'visible' });
  assert.deepEqual(calls, [
    'bringToFront',
    'evaluate:1',
    'locator:body',
    'click:body',
    'evaluate:2',
  ]);
});

test('readClipboardTextWithFocus retries clipboard read after recovering focus', async () => {
  const calls = [];
  let evaluateCount = 0;
  const page = {
    bringToFront: async function () {
      calls.push('bringToFront');
    },
    locator: function (selector) {
      calls.push('locator:' + selector);
      return {
        click: async function () {
          calls.push('click:' + selector);
        },
      };
    },
    evaluate: async function () {
      evaluateCount += 1;
      calls.push('evaluate:' + evaluateCount);
      if (evaluateCount === 1) {
        throw new Error('NotAllowedError: Document is not focused');
      }
      if (evaluateCount === 2) {
        return { active: false, visibility: 'hidden' };
      }
      if (evaluateCount === 3) {
        return { active: true, visibility: 'visible' };
      }
      return 'clipboard text';
    },
  };

  const result = await readClipboardTextWithFocus(page);

  assert.equal(result, 'clipboard text');
  assert.deepEqual(calls, [
    'evaluate:1',
    'bringToFront',
    'evaluate:2',
    'locator:body',
    'click:body',
    'evaluate:3',
    'evaluate:4',
  ]);
});

test('runCopyCleanerRealTest skips tampermonkey sync when skipSync is enabled', async () => {
  const runnerPath = require.resolve('../automation/copy-cleaner-runner.js');
  const utilsPath = require.resolve('../lib/tampermonkey-cdp-utils.cjs');
  const originalRunnerModule = require.cache[runnerPath];
  const originalUtilsModule = require.cache[utilsPath];
  const syncCalls = [];

  const page = {
    currentUrl: 'about:blank',
    url: function () {
      return this.currentUrl;
    },
    bringToFront: async function () {},
    goto: async function (url) {
      this.currentUrl = url;
    },
    waitForLoadState: async function () {},
    reload: async function () {},
    waitForTimeout: async function () {},
    evaluate: async function (fn, arg) {
      const source = String(fn);
      if (arg === 'data-copy-cleaner-chatgpt-copy') {
        return 'expected output';
      }
      if (source.includes('navigator.clipboard.readText')) {
        return 'expected output';
      }
      return null;
    },
  };
  const context = {
    pages: function () {
      return [page];
    },
    grantPermissions: async function () {},
    newPage: async function () {
      return page;
    },
  };
  const browser = {
    close: async function () {},
    contexts: function () {
      return [context];
    },
  };

  require.cache[utilsPath] = {
    id: utilsPath,
    filename: utilsPath,
    loaded: true,
    exports: {
      DEFAULT_CDP_ENDPOINT: 'http://127.0.0.1:9222',
      connectToChromeOverCDP: async function () {
        return browser;
      },
      getPrimaryContext: function () {
        return context;
      },
      getPrimaryPage: async function () {
        return page;
      },
      navigateCurrentTab: async function (targetPage, url) {
        targetPage.currentUrl = url;
      },
      syncUserscriptInBrowser: async function () {
        syncCalls.push('sync');
        return {
          page: page,
          previousUrl: 'chrome-extension://tampermonkey/options.html',
          sync: { name: '复制净化器' },
        };
      },
    },
  };
  delete require.cache[runnerPath];

  try {
    const runner = require('../automation/copy-cleaner-runner.js');
    const originalAdapter = Object.assign({}, runner.ADAPTERS.chatgpt);
    runner.ADAPTERS.chatgpt.waitForReply = async function () {};
    runner.ADAPTERS.chatgpt.clickCopy = async function () {
      return { action: 'copy' };
    };
    runner.ADAPTERS.chatgpt.navigateToPage = async function (_context, targetPage, url) {
      targetPage.currentUrl = url;
      return targetPage;
    };

    try {
      const result = await runner.runCopyCleanerRealTest({
        site: 'chatgpt',
        skipSync: true,
        expected: 'expected output',
        url: 'https://chatgpt.com/c/fixture',
      });

      assert.deepEqual(syncCalls, []);
      assert.deepEqual(result.sync, { skipped: true });
      assert.equal(result.pageUrl, 'https://chatgpt.com/c/fixture');
      assert.equal(result.validation.matches, true);
    } finally {
      Object.assign(runner.ADAPTERS.chatgpt, originalAdapter);
    }
  } finally {
    delete require.cache[runnerPath];
    if (originalRunnerModule) require.cache[runnerPath] = originalRunnerModule;
    if (originalUtilsModule) require.cache[utilsPath] = originalUtilsModule;
    else delete require.cache[utilsPath];
  }
});

test('parseCliArgs keeps boolean flags and key-value pairs', () => {
  assert.deepEqual(parseCliArgs([
    '--site', 'chatgpt',
    '--case', DEFAULT_CASE_IDS.chatgpt,
    '--list-cases',
    '--url', 'https://chatgpt.com/',
  ]), {
    site: 'chatgpt',
    case: DEFAULT_CASE_IDS.chatgpt,
    'list-cases': true,
    url: 'https://chatgpt.com/',
  });
});

test('buildTextMismatchSummary reports first mismatch and nearby fragments', () => {
  assert.deepEqual(
    buildTextMismatchSummary('AI公式在 $x^2$ 里', 'AI公式在$x^2$里'),
    {
      matches: false,
      firstDiffIndex: 5,
      expectedFragment: 'AI公式在 $x^2$ 里',
      actualFragment: 'AI公式在$x^2$里',
    }
  );
});

test('buildTextMismatchSummary reports exact match when texts are equal after normalization', () => {
  assert.deepEqual(
    buildTextMismatchSummary('foo\r\nbar', 'foo\nbar'),
    {
      matches: true,
      firstDiffIndex: -1,
      expectedFragment: '',
      actualFragment: '',
    }
  );
});

test('buildTextMismatchSummary ignores blank lines globally', () => {
  assert.deepEqual(
    buildTextMismatchSummary('foo\n\nbar\n\nbaz', 'foo\nbar\nbaz'),
    {
      matches: true,
      firstDiffIndex: -1,
      expectedFragment: '',
      actualFragment: '',
    }
  );
});

test('buildTextMismatchSummary preserves a blank line only after markdown tables', () => {
  assert.deepEqual(
    buildTextMismatchSummary(
      '| a | b |\n| --- | --- |\n| 1 | 2 |\n\n后文',
      '| a | b |\n| --- | --- |\n| 1 | 2 |\n后文'
    ),
    {
      matches: false,
      firstDiffIndex: 34,
      expectedFragment: '|\n| 1 | 2 |\n\n后文',
      actualFragment: '|\n| 1 | 2 |\n后文',
    }
  );
});

test('buildTextMismatchSummary can ignore footnote lines for real browser oracle comparison', () => {
  assert.deepEqual(
    buildTextMismatchSummary(
      '正文\n脚注示例：\n这是一个脚注1。\n[^1]: https://example.com',
      '正文',
      [/^脚注示例：$/, /^这是一个脚注\d+[。.]?$/, /^\[\^\d+\]:/]
    ),
    {
      matches: true,
      firstDiffIndex: -1,
      expectedFragment: '',
      actualFragment: '',
    }
  );
});

test('buildExactTextMismatchSummary keeps extra blank lines visible', () => {
  assert.deepEqual(
    buildExactTextMismatchSummary('foo\nbar', 'foo\n\nbar'),
    {
      matches: false,
      firstDiffIndex: 4,
      expectedFragment: 'foo\nbar',
      actualFragment: 'foo\n\nbar',
    }
  );
});

test('gemini oracle highlights partial-copy mismatches clearly', () => {
  assert.deepEqual(
    buildTextMismatchSummary(
      '## 5. 代码块展示\n这里是一个简单的 Python 示例，展示了代码块的语法高亮：\n\n```python',
      '这里是一个简单的 Python 示例，展示了代码块的语法高亮：\nPython\n```'
    ),
    {
      matches: false,
      firstDiffIndex: 0,
      expectedFragment: '## 5. 代码块展示\n这里是一个简单的 Pyt',
      actualFragment: '这里是一个简单的 Python 示例，展示了代码',
    }
  );
});

test('tika oracle highlights markdown link mismatch clearly', () => {
  assert.deepEqual(
    buildTextMismatchSummary(
      '这是一个 [Markdown 链接](https://example.com)。',
      '这是一个 Markdown 链接。'
    ),
    {
      matches: false,
      firstDiffIndex: 5,
      expectedFragment: '这是一个 [Markdown 链接](https://ex',
      actualFragment: '这是一个 Markdown 链接。',
    }
  );
});
