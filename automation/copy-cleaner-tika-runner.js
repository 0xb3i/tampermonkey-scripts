#!/usr/bin/env node

const { resolve } = require('path');

const {
  DEFAULT_CDP_ENDPOINT,
  connectToChromeOverCDP,
  getPrimaryContext,
  navigateCurrentTab,
  syncUserscriptInBrowser,
} = require('../lib/tampermonkey-cdp-utils.cjs');
const {
  buildTextMismatchSummary,
  ensureClipboardPermission,
  normalizeText,
  parseCliArgs,
  readClipboardText,
} = require('./copy-cleaner-runner-utils.cjs');
const {
  DEFAULT_TIKA_CASE_ID,
  getTikaRealTestCase,
  listTikaRealTestCases,
} = require('./copy-cleaner-tika-cases.cjs');

const DEFAULT_SCRIPT_PATH = resolve(__dirname, '../userscripts/copy-cleaner.user.js');

async function waitForExistingAssistantCopyButton(page) {
  await page.waitForFunction(function () {
    return Array.from(document.querySelectorAll('.chat-answer-area')).some(function (root) {
      return !!root.querySelector('button .i-icon-copy');
    });
  }, null, { timeout: 120000 });
}

async function waitForExistingAssistantReplyReady(page) {
  await waitForExistingAssistantCopyButton(page);
  await page.waitForFunction(function () {
    return Array.from(document.querySelectorAll('.chat-answer-area')).some(function (root) {
      var text = String(root.innerText || '').trim();
      return text.length > 120 && !!root.querySelector('button .i-icon-copy');
    });
  }, null, { timeout: 15000 });
  await page.waitForTimeout(300);
}

async function clickLatestCopyButton(page) {
  var target = await page.evaluate(function () {
    var roots = Array.from(document.querySelectorAll('.chat-answer-area'));
    for (var rootIndex = roots.length - 1; rootIndex >= 0; rootIndex--) {
      var root = roots[rootIndex];
      var text = String(root.innerText || '').trim();
      if (text.length < 40) continue;
      var toolbar = root.querySelector('.pt-2.flex.items-center');
      if (!toolbar) continue;
      var buttons = Array.from(toolbar.querySelectorAll('button'));
      for (var buttonIndex = 0; buttonIndex < buttons.length; buttonIndex++) {
        var button = buttons[buttonIndex];
        if (!button.querySelector('.i-icon-copy')) continue;
        return {
          rootIndex: rootIndex,
          buttonIndex: buttonIndex,
          textLength: text.length,
        };
      }
    }
    return null;
  });
  if (!target) {
    throw new Error('No Tika copy button found.');
  }
  await page.locator('.chat-answer-area').nth(target.rootIndex).locator('.pt-2.flex.items-center button').nth(target.buttonIndex).click({ force: true });
  return target;
}

async function validateTikaCopyButton(page, options) {
  var expectedText = options && options.expectedText ? String(options.expectedText) : '';
  var ignoreLinePatterns = options && Array.isArray(options.ignoreLinePatterns) ? options.ignoreLinePatterns : [];
  await waitForExistingAssistantReplyReady(page);
  var clickedTarget = await clickLatestCopyButton(page);
  await page.waitForTimeout(300);
  var clipboardText = normalizeText(await readClipboardText(page), ignoreLinePatterns);
  var pageMarker = normalizeText(await page.evaluate(function () {
    return document.documentElement.getAttribute('data-copy-cleaner-tika-copy') || '';
  }), ignoreLinePatterns);
  if (pageMarker) {
    clipboardText = pageMarker;
  }
  expectedText = normalizeText(expectedText, ignoreLinePatterns);
  var mismatch = buildTextMismatchSummary(expectedText, clipboardText, ignoreLinePatterns);
  return {
    expectedText: expectedText,
    clickedTarget: clickedTarget,
    pageMarker: pageMarker,
    clipboardText: clipboardText,
    mismatch: mismatch,
    matches: mismatch.matches,
  };
}

async function runCopyCleanerTikaRealTest(options) {
  var runtimeOptions = options || {};
  var endpointUrl = runtimeOptions.cdpUrl || DEFAULT_CDP_ENDPOINT;
  var scriptPath = resolve(runtimeOptions.scriptPath || DEFAULT_SCRIPT_PATH);
  var selectedCase = getTikaRealTestCase(runtimeOptions.caseId || DEFAULT_TIKA_CASE_ID);
  var targetUrl = runtimeOptions.url || selectedCase.url;
  var expectedText = runtimeOptions.expected || selectedCase.expectedText || '';
  var browser = await connectToChromeOverCDP(endpointUrl);
  try {
    var context = getPrimaryContext(browser);
    console.log('[copy-cleaner-tika-runner] sync:start');
    var syncStep = await syncUserscriptInBrowser(browser, {
      scriptPath: scriptPath,
    });
    var page = syncStep.page;
    var originalUrl = syncStep.previousUrl;
    var syncResult = syncStep.sync;
    console.log('[copy-cleaner-tika-runner] sync:done');

    console.log('[copy-cleaner-tika-runner] page:navigate');
    await navigateCurrentTab(page, targetUrl);
    await ensureClipboardPermission(context, new URL(targetUrl).origin);
    await page.reload({ waitUntil: 'domcontentloaded' });
    console.log('[copy-cleaner-tika-runner] page:ready');

    console.log('[copy-cleaner-tika-runner] validate:start');
    var validationResult = await validateTikaCopyButton(page, {
      expectedText: expectedText,
      ignoreLinePatterns: selectedCase.ignoreLinePatterns,
    });
    console.log('[copy-cleaner-tika-runner] validate:done');

    var result = {
      caseId: selectedCase.id,
      caseDescription: selectedCase.description,
      sync: syncResult,
      validation: validationResult,
      pageUrl: page.url(),
      previousUrl: originalUrl,
    };
    console.log(JSON.stringify(result, null, 2));

    if (!validationResult.matches) {
      throw new Error(
        'Clipboard text did not match expected cleaned output. ' +
        'firstDiffIndex=' + validationResult.mismatch.firstDiffIndex +
        ' expectedFragment=' + JSON.stringify(validationResult.mismatch.expectedFragment) +
        ' actualFragment=' + JSON.stringify(validationResult.mismatch.actualFragment)
      );
    }
    return result;
  } finally {
    await browser.close();
  }
}

module.exports = {
  parseCliArgs,
  runCopyCleanerTikaRealTest,
};

if (require.main === module) {
  var args = parseCliArgs(process.argv.slice(2));
  if (args['list-cases']) {
    console.log(JSON.stringify(listTikaRealTestCases(), null, 2));
  } else {
    runCopyCleanerTikaRealTest({
      cdpUrl: args['cdp-url'] || DEFAULT_CDP_ENDPOINT,
      scriptPath: args['script-path'] || DEFAULT_SCRIPT_PATH,
      url: args.url,
      expected: args.expected,
      caseId: args.case || DEFAULT_TIKA_CASE_ID,
    }).catch(function (error) {
      console.error('[copy-cleaner-tika-runner] failed:', error && error.stack ? error.stack : error);
      process.exitCode = 1;
    });
  }
}
