#!/usr/bin/env node

const { resolve } = require('path');

const {
  DEFAULT_CDP_ENDPOINT,
  connectToChromeOverCDP,
  getPrimaryContext,
  getPrimaryPage,
  navigateCurrentTab,
  syncTampermonkeyScript,
} = require('./tampermonkey-cdp-utils.cjs');

const DEFAULT_SCRIPT_PATH = resolve(__dirname, 'copy-cleaner.user.js');
const DEFAULT_URL = 'https://chatgpt.com/';
const DEFAULT_PROMPT = [
  '请只回复下面这一行，完全按原样输出，不要解释，不要代码块：',
  '',
  '**AI**（人工智能）“公式”在$x^2$里',
].join('\n');
const DEFAULT_EXPECTED_TEXT = 'AI公式在 $x^2$ 里';

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
  var promptText = options && options.promptText ? String(options.promptText) : DEFAULT_PROMPT;
  var expectedText = options && options.expectedText ? String(options.expectedText) : DEFAULT_EXPECTED_TEXT;
  await sendPrompt(page, promptText);
  var clickedTarget = await clickLatestCopyButton(page);
  var clipboardText = normalizeText(await readClipboardText(page));
  return {
    promptText: promptText,
    expectedText: expectedText,
    clickedTarget: clickedTarget,
    clipboardText: clipboardText,
    matches: clipboardText === expectedText,
  };
}

async function main() {
  var args = parseCliArgs(process.argv.slice(2));
  var endpointUrl = args['cdp-url'] || DEFAULT_CDP_ENDPOINT;
  var scriptPath = resolve(args['script-path'] || DEFAULT_SCRIPT_PATH);
  var targetUrl = args.url || DEFAULT_URL;
  var promptText = args.prompt || DEFAULT_PROMPT;
  var expectedText = args.expected || DEFAULT_EXPECTED_TEXT;

  var browser = await connectToChromeOverCDP(endpointUrl);
  try {
    var context = getPrimaryContext(browser);
    var page = await getPrimaryPage(browser);

    var originalUrl = page.url();
    console.log('[copy-cleaner-chatgpt-runner] sync:start');
    var syncResult = await syncTampermonkeyScript(page, {
      scriptPath: scriptPath,
    });
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
    });
    console.log('[copy-cleaner-chatgpt-runner] validate:done');

    console.log(JSON.stringify({
      sync: syncResult,
      validation: validationResult,
      pageUrl: page.url(),
      previousUrl: originalUrl,
    }, null, 2));

    if (!validationResult.matches) {
      throw new Error('Clipboard text did not match expected cleaned output.');
    }
  } finally {
    await browser.close();
  }
}

main().catch(function (error) {
  console.error('[copy-cleaner-chatgpt-runner] failed:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
