#!/usr/bin/env node

const { spawn } = require('child_process');

const { parseCliArgs } = require('./copy-cleaner-runner.js');

const DEFAULT_SITES = ['chatgpt', 'gemini', 'tika', 'aistudio'];
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

  return commandArgs;
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
  var runCommand = runtimeOptions.runCommand || function (_site, commandArgs) {
    return spawnRunner(commandArgs);
  };
  var sites = resolveSites(args || {});

  for (var index = 0; index < sites.length; index += 1) {
    var site = sites[index];
    var commandArgs = buildRunnerCommand(site, args || {});
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
  buildRunnerCommand: buildRunnerCommand,
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
