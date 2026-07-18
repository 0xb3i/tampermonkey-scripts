const test = require('node:test');
const assert = require('node:assert/strict');

const packageJson = require('../package.json');
const {
  DEFAULT_SCRIPT_PATH,
  DEFAULT_SITES,
  buildRunnerCommand,
  defaultSyncScript,
  resolveSites,
  runAllSites,
} = require('../automation/copy-cleaner-all-sites.js');

test('package exposes only maintained test, copy cleaner, and sync commands', () => {
  assert.deepEqual(Object.keys(packageJson.scripts).sort(), [
    'copycleaner:aistudio',
    'copycleaner:all',
    'copycleaner:chatgpt',
    'copycleaner:gemini',
    'copycleaner:prompttest',
    'copycleaner:tika',
    'tampermonkey:sync',
    'test',
  ]);
});

test('resolveSites defaults to all supported sites in a stable serial order', () => {
  assert.deepEqual(DEFAULT_SITES, ['chatgpt', 'gemini', 'tika', 'aistudio']);
  assert.deepEqual(resolveSites({}), DEFAULT_SITES);
});

test('resolveSites accepts comma separated site filters and rejects unknown values', () => {
  assert.deepEqual(resolveSites({ sites: 'gemini,tika' }), ['gemini', 'tika']);
  assert.deepEqual(resolveSites({ site: 'chatgpt' }), ['chatgpt']);
  assert.throws(function () {
    resolveSites({ sites: 'chatgpt,unknown' });
  }, /Unknown site/);
});

test('buildRunnerCommand forwards shared runner arguments to each site invocation', () => {
  assert.deepEqual(
    buildRunnerCommand('gemini', {
      'cdp-url': 'http://127.0.0.1:9222',
      'script-path': '/tmp/copy-cleaner.user.js',
      'skip-sync': true,
    }),
    [
      require.resolve('../automation/copy-cleaner-runner.js'),
      '--site', 'gemini',
      '--cdp-url', 'http://127.0.0.1:9222',
      '--script-path', '/tmp/copy-cleaner.user.js',
      '--skip-sync',
    ]
  );
});

test('runAllSites synchronizes once and then executes every site sequentially with skip-sync', async () => {
  const calls = [];
  const logs = [];
  const syncCalls = [];

  await assert.rejects(async function () {
    await runAllSites({}, {
      logger: {
        log: function (message) {
          logs.push(message);
        },
      },
      syncScript: async function () {
        syncCalls.push('sync');
      },
      runCommand: async function (site, commandArgs) {
        calls.push({ site, commandArgs });
        if (site === 'tika') {
          throw new Error('tika failed');
        }
      },
    });
  }, /tika failed/);

  assert.deepEqual(syncCalls, ['sync']);
  assert.deepEqual(calls.map(function (entry) { return entry.site; }), ['chatgpt', 'gemini', 'tika']);
  assert.deepEqual(logs, [
    '[copy-cleaner-all-sites] sync:start',
    '[copy-cleaner-all-sites] sync:done',
    '[copy-cleaner-all-sites] site:start chatgpt',
    '[copy-cleaner-all-sites] site:done chatgpt',
    '[copy-cleaner-all-sites] site:start gemini',
    '[copy-cleaner-all-sites] site:done gemini',
    '[copy-cleaner-all-sites] site:start tika',
  ]);
  assert.deepEqual(calls[0].commandArgs, [
    require.resolve('../automation/copy-cleaner-runner.js'),
    '--site', 'chatgpt',
    '--skip-sync',
  ]);
});

test('runAllSites honors aggregate skip-sync and avoids the upfront sync step too', async () => {
  const calls = [];
  let syncCalled = false;

  await runAllSites({ 'skip-sync': true, site: 'chatgpt' }, {
    logger: { log: function () {} },
    syncScript: async function () {
      syncCalled = true;
    },
    runCommand: async function (_site, commandArgs) {
      calls.push(commandArgs);
    },
  });

  assert.equal(syncCalled, false);
  assert.deepEqual(calls, [[
    require.resolve('../automation/copy-cleaner-runner.js'),
    '--site', 'chatgpt',
    '--skip-sync',
  ]]);
});

test('defaultSyncScript falls back to the shared userscript path when no script-path is provided', async () => {
  const allSitesPath = require.resolve('../automation/copy-cleaner-all-sites.js');
  const utilsPath = require.resolve('../lib/tampermonkey-cdp-utils.cjs');
  const originalAllSitesModule = require.cache[allSitesPath];
  const originalUtilsModule = require.cache[utilsPath];
  const calls = [];

  require.cache[utilsPath] = {
    id: utilsPath,
    filename: utilsPath,
    loaded: true,
    exports: {
      DEFAULT_CDP_ENDPOINT: 'http://127.0.0.1:9222',
      connectToChromeOverCDP: async function (endpointUrl) {
        calls.push(['connect', endpointUrl]);
        return {
          close: async function () {
            calls.push(['close']);
          },
        };
      },
      syncUserscriptInBrowser: async function (_browser, options) {
        calls.push(['sync', options]);
        return { sync: { ok: true } };
      },
    },
  };
  delete require.cache[allSitesPath];

  try {
    const reloadedModule = require('../automation/copy-cleaner-all-sites.js');
    await reloadedModule.defaultSyncScript({});

    assert.deepEqual(calls, [
      ['connect', 'http://127.0.0.1:9222'],
      ['sync', { scriptPath: reloadedModule.DEFAULT_SCRIPT_PATH }],
      ['close'],
    ]);
  } finally {
    delete require.cache[allSitesPath];
    if (originalAllSitesModule) require.cache[allSitesPath] = originalAllSitesModule;
    if (originalUtilsModule) require.cache[utilsPath] = originalUtilsModule;
    else delete require.cache[utilsPath];
  }
  assert.match(DEFAULT_SCRIPT_PATH, /userscripts\/copy-cleaner\.user\.js$/);
});
