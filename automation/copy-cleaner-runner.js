#!/usr/bin/env node

const { resolve } = require('path');

const {
  DEFAULT_CDP_ENDPOINT,
  connectToChromeOverCDP,
  getPrimaryContext,
  getPrimaryPage,
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
  DEFAULT_CASE_IDS,
  getRealTestCase,
  listRealTestCases,
} = require('./copy-cleaner-cases.cjs');

const DEFAULT_SCRIPT_PATH = resolve(__dirname, '../userscripts/copy-cleaner.user.js');

function findExistingPageForUrl(context, targetUrl, currentPage) {
  var expectedUrl = String(targetUrl || '');
  var pages = context && typeof context.pages === 'function' ? context.pages() : [];
  return pages.find(function (item) {
    return item !== currentPage && String(item.url && item.url() || '') === expectedUrl;
  }) || null;
}

async function defaultNavigateToPage(context, page, targetUrl) {
  await page.bringToFront().catch(function () {});
  await navigateCurrentTab(page, targetUrl);
  await ensureClipboardPermission(context, new URL(targetUrl).origin);
  await page.reload({ waitUntil: 'domcontentloaded' });
  return page;
}

async function navigateExistingPageOrCurrent(context, page, targetUrl) {
  var targetPage = findExistingPageForUrl(context, targetUrl, page) || page;
  await targetPage.bringToFront().catch(function () {});
  if (String(targetPage.url && targetPage.url() || '') !== String(targetUrl || '')) {
    await navigateCurrentTab(targetPage, targetUrl);
  }
  await ensureClipboardPermission(context, new URL(targetUrl).origin);
  await targetPage.reload({ waitUntil: 'domcontentloaded' });
  return targetPage;
}

async function ensurePageFocusForClipboard(page) {
  await page.bringToFront().catch(function () {});

  async function readFocusState() {
    return page.evaluate(function () {
      try {
        if (typeof window.focus === 'function') window.focus();
      } catch (error) {}
      return {
        active: !!(document && document.hasFocus && document.hasFocus()),
        visibility: String(document && document.visibilityState || ''),
      };
    }).catch(function () {
      return { active: false, visibility: '' };
    });
  }

  var state = await readFocusState();
  if (state.active && state.visibility === 'visible') {
    return state;
  }

  await page.locator('body').click({
    force: true,
    position: { x: 8, y: 8 },
  }).catch(function () {});
  return readFocusState();
}

async function readClipboardTextWithFocus(page) {
  try {
    return await readClipboardText(page);
  } catch (error) {
    var message = String(error && error.message || error || '');
    if (!/notallowederror|not focused/i.test(message)) {
      throw error;
    }
  }

  await ensurePageFocusForClipboard(page);
  return readClipboardText(page);
}

var ADAPTERS = {
  aistudio: {
    pageMarkerAttr: 'data-copy-cleaner-aistudio-copy',
    requirePageMarker: false,
    waitForReply: waitForAiStudioReply,
    clickCopy: clickAiStudioCopy,
    prepareClipboard: prepareAiStudioClipboard,
    navigateToPage: navigateAiStudioPage,
    postClickWait: 1000,
    retryClick: true,
  },
  chatgpt: {
    pageMarkerAttr: 'data-copy-cleaner-chatgpt-copy',
    requirePageMarker: true,
    waitForReply: waitForChatGPTReply,
    clickCopy: clickChatGPTCopy,
    prepareClipboard: null,
    navigateToPage: defaultNavigateToPage,
    postClickWait: 300,
    retryClick: false,
  },
  gemini: {
    pageMarkerAttr: 'data-copy-cleaner-gemini-copy',
    requirePageMarker: true,
    waitForReply: waitForGeminiReply,
    clickCopy: clickGeminiCopy,
    prepareClipboard: null,
    navigateToPage: navigateGeminiPage,
    postClickWait: 500,
    retryClick: false,
  },
  tika: {
    pageMarkerAttr: 'data-copy-cleaner-tika-copy',
    requirePageMarker: true,
    waitForReply: waitForTikaReply,
    clickCopy: clickTikaCopy,
    prepareClipboard: null,
    navigateToPage: navigateExistingPageOrCurrent,
    postClickWait: 300,
    retryClick: false,
  },
};

async function navigateAiStudioPage(context, page, targetUrl) {
  var newPage = await context.newPage();
  await newPage.bringToFront().catch(function () {});
  await newPage.setViewportSize({ width: 1440, height: 1400 }).catch(function () {});
  await navigateCurrentTab(newPage, targetUrl);
  await ensureClipboardPermission(context, new URL(targetUrl).origin);
  await newPage.setViewportSize({ width: 1440, height: 1400 }).catch(function () {});
  return newPage;
}

async function navigateGeminiPage(context, page, targetUrl) {
  await page.setViewportSize({ width: 1440, height: 1400 }).catch(function () {});
  await navigateCurrentTab(page, targetUrl);
  await ensureClipboardPermission(context, new URL(targetUrl).origin);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.setViewportSize({ width: 1440, height: 1400 }).catch(function () {});
  return page;
}

async function waitForAiStudioReply(page) {
  await page.waitForFunction(function () {
    return Array.from(document.querySelectorAll('ms-chat-turn')).some(function (turn) {
      return String(turn.innerText || '').includes('这是一个包含常用 Markdown 语法的示例文本');
    });
  }, null, { timeout: 120000 });
  await page.waitForTimeout(500);
}

async function clickAiStudioCopy(page) {
  await ensurePageFocusForClipboard(page);
  var target = page.locator('ms-chat-turn').filter({ hasText: '这是一个包含常用 Markdown 语法的示例文本' }).first();
  await target.locator('button[aria-label="Open options"]').click({ force: true });
  await page.waitForTimeout(800);
  var menuItem = page.locator('[role="menuitem"]').filter({ hasText: /Copy as markdown/i });
  await menuItem.waitFor({ state: 'visible', timeout: 5000 });
  await ensurePageFocusForClipboard(page);
  await menuItem.click({ force: true });
  return { action: 'copy-as-markdown' };
}

async function prepareAiStudioClipboard(page) {
  async function writeSentinel() {
    return page.evaluate(async function (sentinel) {
      document.documentElement.removeAttribute('data-copy-cleaner-aistudio-copy');
      var selection = window.getSelection && window.getSelection();
      if (selection) selection.removeAllRanges();
      if (!(navigator.clipboard && navigator.clipboard.writeText)) {
        return { ok: false, reason: 'clipboard-write-unavailable' };
      }
      try {
        await navigator.clipboard.writeText(sentinel);
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: String(error && error.message || error || 'clipboard-write-failed') };
      }
    }, '__copycleaner_aistudio_sentinel__');
  }

  await ensurePageFocusForClipboard(page);
  var result = await writeSentinel();
  if (result && result.ok) return;

  await ensurePageFocusForClipboard(page);
  result = await writeSentinel();
  if (result && result.ok) return;

  throw new Error('AI Studio clipboard preparation failed: ' + String(result && result.reason || 'unknown'));
}

async function waitForChatGPTReply(page) {
  await page.waitForFunction(function () {
    return Array.from(document.querySelectorAll('button[data-testid="copy-turn-action-button"]')).some(function (btn) {
      var turn = btn.closest('[data-turn], [data-testid^="conversation-turn-"]');
      return turn && String(turn.getAttribute('data-turn') || '') === 'assistant';
    });
  }, null, { timeout: 120000 });
  await page.waitForFunction(function () {
    var turns = Array.from(document.querySelectorAll('[data-turn="assistant"], [data-testid^="conversation-turn-"]')).filter(function (turn) {
      return String(turn.getAttribute('data-turn') || '') === 'assistant'
        || turn.querySelector('button[data-testid="copy-turn-action-button"]');
    });
    var turn = turns[turns.length - 1];
    if (!turn) return false;
    var decoratedLinks = Array.from(turn.querySelectorAll('a.decorated-link'));
    if (!decoratedLinks.length) return true;
    return decoratedLinks.some(function (link) {
      return !!link.getAttribute('href');
    });
  }, null, { timeout: 5000 }).catch(function () {});
  await page.waitForTimeout(300);
}

async function clickChatGPTCopy(page) {
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
  await page.evaluate(function (targetIndex) {
    var nodes = Array.from(document.querySelectorAll('button[data-testid="copy-turn-action-button"]'));
    var targetButton = nodes[targetIndex];
    if (!targetButton) {
      throw new Error('ChatGPT copy button disappeared before click.');
    }
    targetButton.click();
  }, target.index);
  return target;
}

async function waitForGeminiReply(page) {
  await page.waitForFunction(function () {
    return Array.from(document.querySelectorAll('button[data-test-id="copy-button"][aria-label="Copy"]')).length > 0;
  }, null, { timeout: 120000 });
  await page.waitForFunction(function () {
    var responses = Array.from(document.querySelectorAll('response-container .markdown, .response-container .response-content .markdown'));
    return responses.some(function (root) {
      return String(root.innerText || '').trim().length > 200;
    });
  }, null, { timeout: 15000 });
  await page.waitForTimeout(300);
}

async function clickGeminiCopy(page) {
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

async function waitForTikaReply(page) {
  await page.waitForFunction(function () {
    return Array.from(document.querySelectorAll('.chat-answer-area')).some(function (root) {
      return !!root.querySelector('button .i-icon-copy');
    });
  }, null, { timeout: 120000 });
  await page.waitForFunction(function () {
    return Array.from(document.querySelectorAll('.chat-answer-area')).some(function (root) {
      var text = String(root.innerText || '').trim();
      return text.length > 120 && !!root.querySelector('button .i-icon-copy');
    });
  }, null, { timeout: 15000 });
  await page.waitForTimeout(300);
}

async function clickTikaCopy(page) {
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

async function validateCopy(page, site, options) {
  var adapter = ADAPTERS[site];
  var expectedText = options && options.expectedText ? String(options.expectedText) : '';
  var ignoreLinePatterns = options && Array.isArray(options.ignoreLinePatterns) ? options.ignoreLinePatterns : [];

  await adapter.waitForReply(page);

  if (adapter.prepareClipboard) {
    await adapter.prepareClipboard(page);
  }

  var clickedTarget = await adapter.clickCopy(page);
  await page.waitForTimeout(adapter.postClickWait);

  if (adapter.retryClick) {
    var pageMarkerValue = String(await page.evaluate(function (attr) {
      return document.documentElement.getAttribute(attr) || '';
    }, adapter.pageMarkerAttr) || '');
    var clipboardValue = String(await readClipboardTextWithFocus(page) || '');
    var waitSatisfied = !!(pageMarkerValue || (clipboardValue && clipboardValue !== '__copycleaner_aistudio_sentinel__'));
    if (!waitSatisfied) {
      clickedTarget = await adapter.clickCopy(page);
      await page.waitForTimeout(adapter.postClickWait);
    }
    await page.waitForTimeout(200);
  }

  var rawClipboardText = String(await readClipboardTextWithFocus(page) || '');
  var rawPageMarker = String(await page.evaluate(function (attr) {
    return document.documentElement.getAttribute(attr) || '';
  }, adapter.pageMarkerAttr) || '');
  var clipboardText = normalizeText(rawClipboardText, ignoreLinePatterns);
  var pageMarker = normalizeText(rawPageMarker, ignoreLinePatterns);
  var actualText = pageMarker || clipboardText;
  var normalizedExpectedText = normalizeText(expectedText, ignoreLinePatterns);

  if (adapter.requirePageMarker && !pageMarker) {
    return {
      expectedText: normalizedExpectedText,
      clickedTarget: clickedTarget,
      rawPageMarker: rawPageMarker,
      pageMarker: pageMarker,
      rawClipboardText: rawClipboardText,
      clipboardText: clipboardText,
      effectiveText: actualText,
      usedPageMarker: !!pageMarker,
      mismatch: {
        matches: false,
        firstDiffIndex: 0,
        expectedFragment: '[copy-cleaner marker expected]',
        actualFragment: '[missing marker; native clipboard path used]',
      },
      matches: false,
    };
  }

  var mismatch = buildTextMismatchSummary(normalizedExpectedText, actualText, ignoreLinePatterns);

  return {
    expectedText: normalizedExpectedText,
    clickedTarget: clickedTarget,
    rawPageMarker: rawPageMarker,
    pageMarker: pageMarker,
    rawClipboardText: rawClipboardText,
    clipboardText: clipboardText,
    effectiveText: actualText,
    usedPageMarker: !!pageMarker,
    mismatch: mismatch,
    matches: mismatch.matches,
  };
}

async function runCopyCleanerRealTest(options) {
  var runtimeOptions = options || {};
  var site = runtimeOptions.site || 'chatgpt';
  var adapter = ADAPTERS[site];
  if (!adapter) {
    throw new Error('Unknown site: ' + site + '. Available: ' + Object.keys(ADAPTERS).join(', '));
  }
  var endpointUrl = runtimeOptions.cdpUrl || DEFAULT_CDP_ENDPOINT;
  var scriptPath = resolve(runtimeOptions.scriptPath || DEFAULT_SCRIPT_PATH);
  var selectedCase = getRealTestCase(site, runtimeOptions.caseId || DEFAULT_CASE_IDS[site]);
  var targetUrl = runtimeOptions.url || selectedCase.url;
  var expectedText = runtimeOptions.expected || selectedCase.expectedText || '';
  var skipSync = !!runtimeOptions.skipSync;

  var browser = await connectToChromeOverCDP(endpointUrl);
  try {
    var context = getPrimaryContext(browser);
    var page;
    var originalUrl;
    var syncResult;

    if (skipSync) {
      console.log('[copy-cleaner-runner] sync:skip');
      page = await getPrimaryPage(browser);
      originalUrl = page.url();
      syncResult = { skipped: true };
    } else {
      console.log('[copy-cleaner-runner] sync:start');
      var syncStep = await syncUserscriptInBrowser(browser, {
        scriptPath: scriptPath,
      });
      page = syncStep.page;
      originalUrl = syncStep.previousUrl;
      syncResult = syncStep.sync;
      console.log('[copy-cleaner-runner] sync:done');
    }

    console.log('[copy-cleaner-runner] page:navigate');
    page = await adapter.navigateToPage(context, page, targetUrl);
    console.log('[copy-cleaner-runner] page:ready');

    console.log('[copy-cleaner-runner] validate:start');
    var validationResult = await validateCopy(page, site, {
      expectedText: expectedText,
      ignoreLinePatterns: selectedCase.ignoreLinePatterns,
    });
    console.log('[copy-cleaner-runner] validate:done');

    var result = {
      site: site,
      caseId: selectedCase.id,
      caseDescription: selectedCase.description,
      sync: syncResult,
      validation: validationResult,
      pageUrl: page.url(),
      previousUrl: originalUrl,
    };
    console.log(JSON.stringify(result, null, 2));

    if (!validationResult.matches) {
      var failure = validationResult.mismatch;
      throw new Error(
        'Clipboard text did not match expected cleaned output. ' +
        'firstDiffIndex=' + failure.firstDiffIndex +
        ' expectedFragment=' + JSON.stringify(failure.expectedFragment) +
        ' actualFragment=' + JSON.stringify(failure.actualFragment)
      );
    }
    return result;
  } finally {
    await browser.close();
  }
}

module.exports = {
  ADAPTERS: ADAPTERS,
  defaultNavigateToPage: defaultNavigateToPage,
  ensurePageFocusForClipboard: ensurePageFocusForClipboard,
  findExistingPageForUrl: findExistingPageForUrl,
  navigateExistingPageOrCurrent: navigateExistingPageOrCurrent,
  readClipboardTextWithFocus: readClipboardTextWithFocus,
  parseCliArgs: parseCliArgs,
  runCopyCleanerRealTest: runCopyCleanerRealTest,
  validateCopy: validateCopy,
};

if (require.main === module) {
  var args = parseCliArgs(process.argv.slice(2));
  if (args['list-cases']) {
    var site = args.site || '';
    console.log(JSON.stringify(site ? listRealTestCases(site) : listRealTestCases(), null, 2));
  } else {
    var site = args.site || 'chatgpt';
    runCopyCleanerRealTest({
      site: site,
      cdpUrl: args['cdp-url'] || DEFAULT_CDP_ENDPOINT,
      scriptPath: args['script-path'] || DEFAULT_SCRIPT_PATH,
      skipSync: !!args['skip-sync'],
      url: args.url,
      expected: args.expected,
      caseId: args.case || DEFAULT_CASE_IDS[site],
    }).catch(function (error) {
      console.error('[copy-cleaner-runner] failed:', error && error.stack ? error.stack : error);
      process.exitCode = 1;
    });
  }
}
