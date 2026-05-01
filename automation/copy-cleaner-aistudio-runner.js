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
  DEFAULT_AISTUDIO_CASE_ID,
  getAiStudioRealTestCase,
  listAiStudioRealTestCases,
} = require('./copy-cleaner-aistudio-cases.cjs');

const DEFAULT_SCRIPT_PATH = resolve(__dirname, '../userscripts/copy-cleaner.user.js');

async function waitForExistingAssistantReplyReady(page) {
  await page.waitForFunction(function () {
    return Array.from(document.querySelectorAll('ms-chat-turn')).some(function (turn) {
      return String(turn.innerText || '').includes('这是一个包含常用 Markdown 语法的示例文本');
    });
  }, null, { timeout: 120000 });
  await page.waitForTimeout(500);
}

async function clickCopyAsMarkdown(page) {
  var target = page.locator('ms-chat-turn').filter({ hasText: '这是一个包含常用 Markdown 语法的示例文本' }).first();
  await target.locator('button[aria-label="Open options"]').click({ force: true });
  await page.getByRole('menuitem', { name: /Copy as markdown/i }).click({ force: true });
  return {
    action: 'copy-as-markdown',
  };
}

async function validateAiStudioCopy(page, options) {
  var expectedText = options && options.expectedText ? String(options.expectedText) : '';
  var ignoreLinePatterns = options && Array.isArray(options.ignoreLinePatterns) ? options.ignoreLinePatterns : [];
  var requirePageMarker = !!(options && options.requirePageMarker);
  await waitForExistingAssistantReplyReady(page);
  var clickedTarget = await clickCopyAsMarkdown(page);
  await page.waitForTimeout(800);
  var clipboardText = normalizeText(await readClipboardText(page), ignoreLinePatterns);
  var pageMarker = normalizeText(await page.evaluate(function () {
    return document.documentElement.getAttribute('data-copy-cleaner-aistudio-copy') || '';
  }), ignoreLinePatterns);
  var actualText = pageMarker || clipboardText;
  expectedText = normalizeText(expectedText, ignoreLinePatterns);
  var mismatch = requirePageMarker && !pageMarker
    ? {
        matches: false,
        firstDiffIndex: 0,
        expectedFragment: '[copy-cleaner marker expected]',
        actualFragment: '[missing marker; native clipboard path used]',
      }
    : buildTextMismatchSummary(expectedText, actualText, ignoreLinePatterns);
  return {
    expectedText: expectedText,
    clickedTarget: clickedTarget,
    pageMarker: pageMarker,
    clipboardText: clipboardText,
    effectiveText: actualText,
    usedPageMarker: !!pageMarker,
    mismatch: mismatch,
    matches: mismatch.matches,
  };
}

async function runCopyCleanerAiStudioRealTest(options) {
  var runtimeOptions = options || {};
  var endpointUrl = runtimeOptions.cdpUrl || DEFAULT_CDP_ENDPOINT;
  var scriptPath = resolve(runtimeOptions.scriptPath || DEFAULT_SCRIPT_PATH);
  var selectedCase = getAiStudioRealTestCase(runtimeOptions.caseId || DEFAULT_AISTUDIO_CASE_ID);
  var targetUrl = runtimeOptions.url || selectedCase.url;
  var expectedText = runtimeOptions.expected || selectedCase.expectedText || '';
  var browser = await connectToChromeOverCDP(endpointUrl);
  try {
    var context = getPrimaryContext(browser);
    console.log('[copy-cleaner-aistudio-runner] sync:start');
    var syncStep = await syncUserscriptInBrowser(browser, {
      scriptPath: scriptPath,
    });
    var page = syncStep.page;
    var originalUrl = syncStep.previousUrl;
    var syncResult = syncStep.sync;
    console.log('[copy-cleaner-aistudio-runner] sync:done');

    console.log('[copy-cleaner-aistudio-runner] page:navigate');
    await page.setViewportSize({ width: 1440, height: 1400 }).catch(function () {});
    await navigateCurrentTab(page, targetUrl);
    await ensureClipboardPermission(context, new URL(targetUrl).origin);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.setViewportSize({ width: 1440, height: 1400 }).catch(function () {});
    console.log('[copy-cleaner-aistudio-runner] page:ready');

    console.log('[copy-cleaner-aistudio-runner] validate:start');
    var validationResult = await validateAiStudioCopy(page, {
      expectedText: expectedText,
      ignoreLinePatterns: selectedCase.ignoreLinePatterns,
      requirePageMarker: !!selectedCase.requirePageMarker,
    });
    console.log('[copy-cleaner-aistudio-runner] validate:done');

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
  runCopyCleanerAiStudioRealTest,
};

if (require.main === module) {
  var args = parseCliArgs(process.argv.slice(2));
  if (args['list-cases']) {
    console.log(JSON.stringify(listAiStudioRealTestCases(), null, 2));
  } else {
    runCopyCleanerAiStudioRealTest({
      cdpUrl: args['cdp-url'] || DEFAULT_CDP_ENDPOINT,
      scriptPath: args['script-path'] || DEFAULT_SCRIPT_PATH,
      url: args.url,
      expected: args.expected,
      caseId: args.case || DEFAULT_AISTUDIO_CASE_ID,
    }).catch(function (error) {
      console.error('[copy-cleaner-aistudio-runner] failed:', error && error.stack ? error.stack : error);
      process.exitCode = 1;
    });
  }
}
