#!/usr/bin/env node

const { resolve } = require('path');

const {
  DEFAULT_CDP_ENDPOINT,
  DEFAULT_TAMPERMONKEY_EXTENSION_ID,
  syncUserscriptToTampermonkey,
} = require('./tampermonkey-cdp-utils.cjs');

function parseCliArgs(argv) {
  var result = {};
  for (var i = 0; i < argv.length; i++) {
    var token = String(argv[i] || '');
    if (!token.startsWith('--')) continue;
    var key = token.slice(2);
    var next = argv[i + 1];
    if (!next || String(next).startsWith('--')) {
      result[key] = true;
      continue;
    }
    result[key] = next;
    i += 1;
  }
  return result;
}

function buildHelpText() {
  return [
    'Tampermonkey userscript sync CLI',
    '',
    'Usage:',
    '  node scripts/tampermonkey-sync-cli.cjs --script-path <path> [options]',
    '',
    'Options:',
    '  --script-path <path>    Local userscript file to import into Tampermonkey',
    '  --cdp-url <url>         CDP endpoint URL or port alias (default: ' + DEFAULT_CDP_ENDPOINT + ')',
    '  --extension-id <id>     Tampermonkey extension id (default: ' + DEFAULT_TAMPERMONKEY_EXTENSION_ID + ')',
    '  --json                  Print machine-readable JSON only',
    '  --help                  Show this message',
    '',
    'Examples:',
    '  node scripts/tampermonkey-sync-cli.cjs --script-path scripts/copy-cleaner.user.js',
    '  node scripts/tampermonkey-sync-cli.cjs --script-path scripts/feishu-helper.user.js --cdp-url http://127.0.0.1:9222',
  ].join('\n');
}

async function main() {
  var args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    console.log(buildHelpText());
    return;
  }

  if (!args['script-path']) {
    throw new Error('Missing required --script-path. Use --help for usage.');
  }

  var result = await syncUserscriptToTampermonkey({
    cdpUrl: args['cdp-url'] || DEFAULT_CDP_ENDPOINT,
    scriptPath: resolve(args['script-path']),
    extensionId: args['extension-id'] || DEFAULT_TAMPERMONKEY_EXTENSION_ID,
  });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log('[tampermonkey-sync] done');
  console.log('script:', result.sync.name || '(unknown)');
  console.log('version:', result.sync.version || '(unknown)');
  console.log('enabled:', result.sync.enableResult);
  console.log('matched markers:', result.sync.matchedMarkers);
  console.log('previous url:', result.previousUrl || '(blank)');
  console.log('editor url:', result.sync.editorUrl || '(blank)');
}

module.exports = {
  buildHelpText,
  parseCliArgs,
};

if (require.main === module) {
  main().catch(function (error) {
    console.error('[tampermonkey-sync] failed:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}
