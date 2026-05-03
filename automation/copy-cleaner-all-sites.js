#!/usr/bin/env node

const { spawn } = require('child_process');
const { resolve } = require('path');

const {
  DEFAULT_CDP_ENDPOINT,
  connectToChromeOverCDP,
  syncUserscriptInBrowser,
} = require('../lib/tampermonkey-cdp-utils.cjs');
const { parseCliArgs } = require('./copy-cleaner-runner.js');

const DEFAULT_SITES = ['chatgpt', 'gemini', 'tika', 'aistudio'];
const DEFAULT_SCRIPT_PATH = resolve(__dirname, '../userscripts/copy-cleaner.user.js');
const RUNNER_ENTRY = require.resolve('./copy-cleaner-runner.js');

function resolveSites(args) {
  var rawSites = [];

  if (args && args.site) {
    rawSites = rawSites.concat(String(args.site).split(','));
  }
  if (args && args.sites) {
    rawSites = rawSites.concat(String(args.sites).split(','));
  }

  var sites = rawSites
    .map(function (site) { return String(site || '').trim(); })
    .filter(Boolean);

  if (!sites.length) {
    return DEFAULT_SITES.slice();
  }

  sites.forEach(function (site) {
    if (!DEFAULT_SITES.includes(site)) {
      throw new Error('Unknown site: ' + site + '. Available: ' + DEFAULT_SITES.join(', '));
    }
  });

  return sites;
}

function buildRunnerCommand(site, args) {
  var commandArgs = [RUNNER_ENTRY, '--site', site];

  if (args && args['cdp-url']) {
    commandArgs.push('--cdp-url', String(args['cdp-url']));
  }
  if (args && args['script-path']) {
    commandArgs.push('--script-path', String(args['script-path']));
  }
  if (args && args['skip-sync']) {
    commandArgs.push('--skip-sync');
  }

  return commandArgs;
}

async function defaultSyncScript(args) {
  var runtimeArgs = args || {};
  var endpointUrl = runtimeArgs['cdp-url'] ? String(runtimeArgs['cdp-url']) : DEFAULT_CDP_ENDPOINT;
  var browser = await connectToChromeOverCDP(endpointUrl);
  try {
    return await syncUserscriptInBrowser(browser, {
      scriptPath: runtimeArgs['script-path'] ? String(runtimeArgs['script-path']) : DEFAULT_SCRIPT_PATH,
    });
  } finally {
    await browser.close();
  }
}

function spawnRunner(commandArgs) {
  return new Promise(function (resolve, reject) {
    var child = spawn(process.execPath, commandArgs, {
      stdio: 'inherit',
    });

    child.once('error', reject);
    child.once('exit', function (code, signal) {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(
        'copy-cleaner child process failed'
        + ' code=' + String(code)
        + ' signal=' + String(signal || '')
      ));
    });
  });
}

async function runAllSites(args, options) {
  var runtimeOptions = options || {};
  var logger = runtimeOptions.logger || console;
  var syncScript = runtimeOptions.syncScript || defaultSyncScript;
  var runCommand = runtimeOptions.runCommand || function (_site, commandArgs) {
    return spawnRunner(commandArgs);
  };
  var runnerArgs = Object.assign({}, args || {}, { 'skip-sync': true });
  var sites = resolveSites(runnerArgs);

  if (!(args && args['skip-sync'])) {
    logger.log('[copy-cleaner-all-sites] sync:start');
    await syncScript(args || {});
    logger.log('[copy-cleaner-all-sites] sync:done');
  }

  for (var index = 0; index < sites.length; index += 1) {
    var site = sites[index];
    var commandArgs = buildRunnerCommand(site, runnerArgs);
    logger.log('[copy-cleaner-all-sites] site:start ' + site);
    await runCommand(site, commandArgs);
    logger.log('[copy-cleaner-all-sites] site:done ' + site);
  }

  return {
    sites: sites,
  };
}

module.exports = {
  DEFAULT_SITES: DEFAULT_SITES,
  DEFAULT_SCRIPT_PATH: DEFAULT_SCRIPT_PATH,
  buildRunnerCommand: buildRunnerCommand,
  defaultSyncScript: defaultSyncScript,
  resolveSites: resolveSites,
  runAllSites: runAllSites,
  spawnRunner: spawnRunner,
};

if (require.main === module) {
  var args = parseCliArgs(process.argv.slice(2));
  runAllSites(args).catch(function (error) {
    console.error('[copy-cleaner-all-sites] failed:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}
