#!/usr/bin/env node

const { resolve } = require('path');

const {
  DEFAULT_CDP_ENDPOINT,
  connectToChromeOverCDP,
  getPrimaryContext,
  navigateCurrentTab,
  syncUserscriptInBrowser,
} = require('./tampermonkey-cdp-utils.cjs');
const {
  DEFAULT_CHATGPT_CASE_ID,
  getChatGPTRealTestCase,
  listChatGPTRealTestCases,
} = require('./copy-cleaner-chatgpt-cases.cjs');

const DEFAULT_SCRIPT_PATH = resolve(__dirname, 'copy-cleaner.user.js');
const DEFAULT_URL = 'https://chatgpt.com/';

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

function normalizeText(text) {
  return String(text || '').replace(/\r\n?/g, '\n').trim();
}

function buildTextMismatchSummary(expectedText, actualText) {
  var expected = normalizeText(expectedText);
  var actual = normalizeText(actualText);
  if (expected === actual) {
    return {
      matches: true,
      firstDiffIndex: -1,
      expectedFragment: '',
      actualFragment: '',
    };
  }
  var index = 0;
  var max = Math.max(expected.length, actual.length);
  while (index < max && expected.charAt(index) === actual.charAt(index)) {
    index += 1;
  }
  var start = Math.max(0, index - 12);
  var end = index + 24;
  return {
    matches: false,
    firstDiffIndex: index,
    expectedFragment: expected.slice(start, end),
    actualFragment: actual.slice(start, end),
  };
}

async function waitForExistingAssistantCopyButton(page) {
  await page.waitForFunction(function () {
    return Array.from(document.querySelectorAll('button[data-testid="copy-turn-action-button"]')).some(function (btn) {
      var turn = btn.closest('[data-turn], [data-testid^="conversation-turn-"]');
      return turn && String(turn.getAttribute('data-turn') || '') === 'assistant';
    });
  }, null, { timeout: 120000 });
}

async function ensureClipboardPermission(context, origin) {
  if (!origin) return;
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: origin });
}

async function waitForChatInput(page) {
  var editor = page.locator('div#prompt-textarea[contenteditable="true"], div#prompt-textarea[contenteditable="plaintext-only"]').first();
  try {
    await editor.waitFor({ state: 'visible', timeout: 10000 });
    return { locator: editor, kind: 'editor' };
  } catch (error) {}
  var textarea = page.locator('textarea[aria-label*="ChatGPT"], textarea');
  await textarea.first().waitFor({ state: 'visible', timeout: 20000 });
  return { locator: textarea.first(), kind: 'textarea' };
}

async function waitForAssistantCopyButton(page, baselineCount) {
  await page.waitForFunction(function (expectedCount) {
    var assistantButtons = document.querySelectorAll('[data-turn="assistant"] button[data-testid="copy-turn-action-button"]');
    if (assistantButtons.length > 0) return true;
    var replyButtons = Array.from(document.querySelectorAll('button[data-testid="copy-turn-action-button"]')).filter(function (btn) {
      return /复制回复|copy response/i.test(String(btn.getAttribute('aria-label') || ''));
    });
    if (replyButtons.length > 0) return true;
    return document.querySelectorAll('button[data-testid="copy-turn-action-button"]').length > expectedCount + 1;
  }, baselineCount, { timeout: 120000 });
}

async function sendPrompt(page, promptText) {
  var input = await waitForChatInput(page);
  var baselineCopyCount = await page.locator('button[data-testid="copy-turn-action-button"]').count();
  await input.locator.click();
  if (input.kind === 'editor') {
    await page.keyboard.insertText(promptText);
  } else {
    await input.locator.fill(promptText);
  }
  await page.waitForFunction(function () {
    var button = document.querySelector('button[data-testid="send-button"]');
    return !!(button && !button.disabled);
  }, null, { timeout: 10000 });
  await page.locator('button[data-testid="send-button"]').click();
  await waitForAssistantCopyButton(page, baselineCopyCount);
}

async function clickLatestCopyButton(page) {
  var buttons = page.locator('button[data-testid="copy-turn-action-button"]');
  await buttons.last().waitFor({ state: 'visible', timeout: 120000 });
  await page.evaluate(function () {
    var selection = window.getSelection();
    if (selection) selection.removeAllRanges();
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
  });
  var target = await page.evaluate(function () {
    var nodes = Array.from(document.querySelectorAll('button[data-testid="copy-turn-action-button"]'));
    function readTarget(btn, index) {
      var turn = btn.closest('[data-turn], [data-testid^="conversation-turn-"]');
      return {
        index: index,
        aria: String(btn.getAttribute('aria-label') || ''),
        dataTurn: turn ? String(turn.getAttribute('data-turn') || '') : '',
        turnTestId: turn ? String(turn.getAttribute('data-testid') || '') : '',
      };
    }
    var targets = nodes.map(readTarget);
    return targets.find(function (item) {
      return item.dataTurn === 'assistant' && /复制回复|copy response/i.test(item.aria);
    }) || targets.find(function (item) {
      return item.dataTurn === 'assistant';
    }) || targets[targets.length - 1] || null;
  });
  if (!target) {
    throw new Error('No ChatGPT copy button found.');
  }
  await buttons.nth(target.index).click({ force: true });
  return target;
}

async function readClipboardText(page) {
  return page.evaluate(async function () {
    return navigator.clipboard.readText();
  });
}

async function validateChatGPTCopyButton(page, options) {
  var promptText = options && options.promptText ? String(options.promptText) : '';
  var expectedText = options && options.expectedText ? String(options.expectedText) : '';
  if (options && options.useExistingAssistantReply) {
    await waitForExistingAssistantCopyButton(page);
  } else {
    await sendPrompt(page, promptText);
  }
  var clickedTarget = await clickLatestCopyButton(page);
  await page.waitForTimeout(300);
  var clipboardText = normalizeText(await readClipboardText(page));
  var pageMarker = normalizeText(await page.evaluate(function () {
    return document.documentElement.getAttribute('data-copy-cleaner-chatgpt-copy') || '';
  }));
  if (expectedText === '__debug_placeholder__' && pageMarker) {
    expectedText = pageMarker;
  }
  var mismatch = buildTextMismatchSummary(expectedText, clipboardText);
  return {
    promptText: promptText,
    expectedText: expectedText,
    clickedTarget: clickedTarget,
    pageMarker: pageMarker,
    clipboardText: clipboardText,
    mismatch: mismatch,
    matches: mismatch.matches,
  };
}

async function runCopyCleanerChatGPTRealTest(options) {
  var runtimeOptions = options || {};
  var endpointUrl = runtimeOptions.cdpUrl || DEFAULT_CDP_ENDPOINT;
  var scriptPath = resolve(runtimeOptions.scriptPath || DEFAULT_SCRIPT_PATH);
  var selectedCase = getChatGPTRealTestCase(runtimeOptions.caseId || DEFAULT_CHATGPT_CASE_ID);
  var targetUrl = runtimeOptions.url || selectedCase.url || DEFAULT_URL;
  var promptText = runtimeOptions.prompt || selectedCase.promptText || '';
  var expectedText = runtimeOptions.expected || selectedCase.expectedText || '';
  var browser = await connectToChromeOverCDP(endpointUrl);
  try {
    var context = getPrimaryContext(browser);
    var page = null;
    console.log('[copy-cleaner-chatgpt-runner] sync:start');
    var syncStep = await syncUserscriptInBrowser(browser, {
      scriptPath: scriptPath,
    });
    page = syncStep.page;
    var originalUrl = syncStep.previousUrl;
    var syncResult = syncStep.sync;
    console.log('[copy-cleaner-chatgpt-runner] sync:done');

    console.log('[copy-cleaner-chatgpt-runner] page:navigate');
    await navigateCurrentTab(page, targetUrl);
    await ensureClipboardPermission(context, new URL(targetUrl).origin);
    await page.reload({ waitUntil: 'domcontentloaded' });
    console.log('[copy-cleaner-chatgpt-runner] page:ready');

    console.log('[copy-cleaner-chatgpt-runner] validate:start');
    var validationResult = await validateChatGPTCopyButton(page, {
      promptText: promptText,
      expectedText: expectedText,
      useExistingAssistantReply: !!selectedCase.useExistingAssistantReply,
    });
    console.log('[copy-cleaner-chatgpt-runner] validate:done');

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
  buildTextMismatchSummary,
  parseCliArgs,
  runCopyCleanerChatGPTRealTest,
};

if (require.main === module) {
  var args = parseCliArgs(process.argv.slice(2));
  if (args['list-cases']) {
    console.log(JSON.stringify(listChatGPTRealTestCases(), null, 2));
  } else {
    runCopyCleanerChatGPTRealTest({
      cdpUrl: args['cdp-url'] || DEFAULT_CDP_ENDPOINT,
      scriptPath: args['script-path'] || DEFAULT_SCRIPT_PATH,
      url: args.url,
      prompt: args.prompt,
      expected: args.expected,
      caseId: args.case || DEFAULT_CHATGPT_CASE_ID,
    }).catch(function (error) {
    console.error('[copy-cleaner-chatgpt-runner] failed:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
    });
  }
}
