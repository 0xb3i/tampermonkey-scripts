const test = require('node:test');
const assert = require('node:assert/strict');

const packageJson = require('../package.json');
const {
  DEFAULT_SITES,
  buildRunnerCommand,
  resolveSites,
  runAllSites,
} = require('../automation/copy-cleaner-all-sites.js');

test('package scripts expose aggregate and explicit copycleaner commands only', () => {
  assert.equal(packageJson.scripts['copycleaner:all'], 'node automation/copy-cleaner-all-sites.js');
  assert.equal(packageJson.scripts['copycleaner:chatgpt'], 'node automation/copy-cleaner-runner.js --site chatgpt');
  assert.equal(packageJson.scripts['copycleaner:realtest'], undefined);
  assert.equal(packageJson.scripts['copycleaner:chatgpt-fixture'], undefined);
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
