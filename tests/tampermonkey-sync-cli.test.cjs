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

test('connectToChromeOverCDP disables default overrides for attached Chrome sessions', async () => {
  const playwrightPath = require.resolve('@playwright/test');
  const utilsPath = require.resolve('../lib/tampermonkey-cdp-utils.cjs');
  const originalPlaywrightModule = require.cache[playwrightPath];
  const originalUtilsModule = require.cache[utilsPath];
  const calls = [];

  require.cache[playwrightPath] = {
    id: playwrightPath,
    filename: playwrightPath,
    loaded: true,
    exports: {
      chromium: {
        connectOverCDP: async (...args) => {
          calls.push(args);
          return { close: async () => {}, contexts: () => [] };
        },
      },
    },
  };
  delete require.cache[utilsPath];

  try {
    const {
      DEFAULT_CDP_ENDPOINT,
      connectToChromeOverCDP,
    } = require('../lib/tampermonkey-cdp-utils.cjs');

    await connectToChromeOverCDP();

    assert.deepEqual(calls, [
      [DEFAULT_CDP_ENDPOINT, { noDefaults: true }],
    ]);
  } finally {
    delete require.cache[utilsPath];
    if (originalUtilsModule) require.cache[utilsPath] = originalUtilsModule;
    if (originalPlaywrightModule) require.cache[playwrightPath] = originalPlaywrightModule;
    else delete require.cache[playwrightPath];
  }
});

test('getPrimaryPage auto-creates a page when the attached 9222 browser exposes no page targets', async () => {
  const { getPrimaryPage } = require('../lib/tampermonkey-cdp-utils.cjs');
  const createdPage = {
    url: () => 'about:blank',
    bringToFront: async () => {},
  };
  let newPageCalls = 0;
  const browser = {
    contexts: () => [{
      pages: () => [],
      newPage: async () => {
        newPageCalls += 1;
        return createdPage;
      },
    }],
  };

  const page = await getPrimaryPage(browser);

  assert.equal(page, createdPage);
  assert.equal(newPageCalls, 1);
});

test('getPrimaryPage ignores Tampermonkey ask pages and opens a fresh page instead', async () => {
  const { getPrimaryPage } = require('../lib/tampermonkey-cdp-utils.cjs');
  const askPage = {
    url: () => 'chrome-extension://dhdgffkkebhmkfjojejmpbldmpobfkfo/ask.html#foo',
  };
  const createdPage = {
    url: () => 'about:blank',
    bringToFront: async () => {},
  };
  let newPageCalls = 0;
  const browser = {
    contexts: () => [{
      pages: () => [askPage],
      newPage: async () => {
        newPageCalls += 1;
        return createdPage;
      },
    }],
  };

  const page = await getPrimaryPage(browser);

  assert.equal(page, createdPage);
  assert.equal(newPageCalls, 1);
});

test('openTampermonkeyPage force-clicks tab labels to survive extension UI instability', async () => {
  const { openTampermonkeyPage } = require('../lib/tampermonkey-cdp-utils.cjs');
  const clickCalls = [];
  const page = {
    goto: async () => {},
    waitForLoadState: async () => {},
    waitForFunction: async () => {},
    getByText: function () {
      return {
        first: function () {
          return {
            click: async function (options) {
              clickCalls.push(options);
            },
          };
        },
      };
    },
  };

  await openTampermonkeyPage(page, {
    extensionId: 'example-extension',
    tabLabel: '实用工具',
  });

  assert.deepEqual(clickCalls, [
    { force: true },
  ]);
});
