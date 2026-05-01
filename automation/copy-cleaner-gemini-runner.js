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
  DEFAULT_GEMINI_CASE_ID,
  getGeminiRealTestCase,
  listGeminiRealTestCases,
} = require('./copy-cleaner-gemini-cases.cjs');

const DEFAULT_SCRIPT_PATH = resolve(__dirname, '../userscripts/copy-cleaner.user.js');

async function waitForExistingAssistantCopyButton(page) {
  await page.waitForFunction(function () {
    return Array.from(document.querySelectorAll('button[data-test-id="copy-button"][aria-label="Copy"]')).length > 0;
  }, null, { timeout: 120000 });
}

async function waitForExistingAssistantReplyReady(page) {
  await waitForExistingAssistantCopyButton(page);
  await page.waitForFunction(function () {
    var responses = Array.from(document.querySelectorAll('response-container .markdown, .response-container .response-content .markdown'));
    return responses.some(function (root) {
      return String(root.innerText || '').trim().length > 200;
    });
  }, null, { timeout: 15000 });
  await page.waitForTimeout(300);
}

async function clickLatestCopyButton(page) {
  var target = await page.evaluate(function () {
    var buttons = Array.from(document.querySelectorAll('button[data-test-id="copy-button"][aria-label="Copy"]'));
    for (var index = buttons.length - 1; index >= 0; index--) {
      var button = buttons[index];
      var responseRoot = button.closest('response-container, .response-container');
      if (!responseRoot) continue;
      var contentRoot = responseRoot.querySelector('structured-content-container .markdown')
        || responseRoot.querySelector('message-content .markdown')
        || responseRoot.querySelector('.response-content .markdown')
        || responseRoot.querySelector('.markdown');
      var text = contentRoot ? String(contentRoot.innerText || '').trim() : '';
      if (text.length < 80) continue;
      return {
        index: index,
        textLength: text.length,
        tooltip: String(button.getAttribute('mattooltip') || button.getAttribute('title') || ''),
      };
    }
    return null;
  });
  if (!target) {
    throw new Error('No Gemini main copy button found.');
  }
  await page.locator('button[data-test-id="copy-button"][aria-label="Copy"]').nth(target.index).click({ force: true });
  return target;
}

async function validateGeminiCopyButton(page, options) {
  var expectedText = options && options.expectedText ? String(options.expectedText) : '';
  var ignoreLinePatterns = options && Array.isArray(options.ignoreLinePatterns) ? options.ignoreLinePatterns : [];
  var requirePageMarker = !!(options && options.requirePageMarker);
  await waitForExistingAssistantReplyReady(page);
  var clickedTarget = await clickLatestCopyButton(page);
  await page.waitForTimeout(500);
  var clipboardText = normalizeText(await readClipboardText(page), ignoreLinePatterns);
  var pageMarker = normalizeText(await page.evaluate(function () {
    return document.documentElement.getAttribute('data-copy-cleaner-gemini-copy') || '';
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

async function runCopyCleanerGeminiRealTest(options) {
  var runtimeOptions = options || {};
  var endpointUrl = runtimeOptions.cdpUrl || DEFAULT_CDP_ENDPOINT;
  var scriptPath = resolve(runtimeOptions.scriptPath || DEFAULT_SCRIPT_PATH);
  var selectedCase = getGeminiRealTestCase(runtimeOptions.caseId || DEFAULT_GEMINI_CASE_ID);
  var targetUrl = runtimeOptions.url || selectedCase.url;
  var expectedText = runtimeOptions.expected || selectedCase.expectedText || '';
  var browser = await connectToChromeOverCDP(endpointUrl);
  try {
    var context = getPrimaryContext(browser);
    console.log('[copy-cleaner-gemini-runner] sync:start');
    var syncStep = await syncUserscriptInBrowser(browser, {
      scriptPath: scriptPath,
    });
    var page = syncStep.page;
    var originalUrl = syncStep.previousUrl;
    var syncResult = syncStep.sync;
    console.log('[copy-cleaner-gemini-runner] sync:done');

    console.log('[copy-cleaner-gemini-runner] page:navigate');
    await page.setViewportSize({ width: 1440, height: 1400 }).catch(function () {});
    await navigateCurrentTab(page, targetUrl);
    await ensureClipboardPermission(context, new URL(targetUrl).origin);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.setViewportSize({ width: 1440, height: 1400 }).catch(function () {});
    console.log('[copy-cleaner-gemini-runner] page:ready');

    console.log('[copy-cleaner-gemini-runner] validate:start');
    var validationResult = await validateGeminiCopyButton(page, {
      expectedText: expectedText,
      ignoreLinePatterns: selectedCase.ignoreLinePatterns,
      requirePageMarker: !!selectedCase.requirePageMarker,
    });
    console.log('[copy-cleaner-gemini-runner] validate:done');

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
  runCopyCleanerGeminiRealTest,
};

if (require.main === module) {
  var args = parseCliArgs(process.argv.slice(2));
  if (args['list-cases']) {
    console.log(JSON.stringify(listGeminiRealTestCases(), null, 2));
  } else {
    runCopyCleanerGeminiRealTest({
      cdpUrl: args['cdp-url'] || DEFAULT_CDP_ENDPOINT,
      scriptPath: args['script-path'] || DEFAULT_SCRIPT_PATH,
      url: args.url,
      expected: args.expected,
      caseId: args.case || DEFAULT_GEMINI_CASE_ID,
    }).catch(function (error) {
      console.error('[copy-cleaner-gemini-runner] failed:', error && error.stack ? error.stack : error);
      process.exitCode = 1;
    });
  }
}
