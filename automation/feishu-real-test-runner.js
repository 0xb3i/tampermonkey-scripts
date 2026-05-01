#!/usr/bin/env node

const { resolve } = require('path');

const {
  buildSnapshotSignature,
} = require('../lib/feishu-paste-fallback-utils.cjs');
const {
  DEFAULT_CDP_ENDPOINT,
  connectToChromeOverCDP,
  navigateCurrentTab,
  syncUserscriptInBrowser,
  waitForDocumentReady,
} = require('../lib/tampermonkey-cdp-utils.cjs');

const DEFAULT_SCRIPT_PATH = resolve(__dirname, '../userscripts/feishu-helper.user.js');
const DEFAULT_ACTION = 'realTestDuplicateDocument';
const DEFAULT_TIMEOUT_MS = 45000;
const DEFAULT_SHORT_WAIT_MS = 1200;
const FEISHU_DOC_HOST_RE = /(^|\.)((feishu\.cn)|(larksuite\.com)|(larkoffice\.com))$/i;
const FEISHU_DOC_PATH_RE = /^\/(docx|wiki|doc)\//i;
const AUTOMATION_REQUEST_EVENT = 'feishu-helper:automation-request';
const AUTOMATION_RESULT_EVENT = 'feishu-helper:automation-result';
const CONTENT_ROOT_SELECTOR = '[data-content-editable-root="true"], [contenteditable="true"], [contenteditable="plaintext-only"]';

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

function isFeishuDocUrl(rawUrl) {
  try {
    var url = new URL(String(rawUrl || ''));
    return FEISHU_DOC_HOST_RE.test(url.hostname) && FEISHU_DOC_PATH_RE.test(url.pathname);
  } catch (error) {
    return false;
  }
}

async function ensureFeishuDocumentPage(page, targetUrl) {
  var url = targetUrl ? String(targetUrl) : String(page.url() || '');
  if (!isFeishuDocUrl(url)) {
    throw new Error('当前活动标签页不是飞书文档页；请先打开目标文档，或通过 --url 传入文档地址。');
  }
  await navigateCurrentTab(page, url);
  await waitForDocumentReady(page, 15000);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForDocumentReady(page, 15000);
  return url;
}

async function waitForFeishuHelperReady(page, timeoutMs) {
  await page.waitForFunction(function () {
    var attr = document.documentElement.getAttribute('data-feishu-helper-active');
    return Boolean(attr);
  }, null, { timeout: timeoutMs || 15000 });
  await page.waitForFunction(function () {
    var raw = document.documentElement.getAttribute('data-feishu-editor-ready-state');
    if (!raw) return false;
    try {
      var state = JSON.parse(raw);
      return !!(state && state.hasContentRoot && state.hasContentLoaded);
    } catch (error) {
      return false;
    }
  }, null, { timeout: timeoutMs || 15000 });
  return page.evaluate(function () {
    var attr = document.documentElement.getAttribute('data-feishu-helper-active') || '';
    var editorState = document.documentElement.getAttribute('data-feishu-editor-ready-state') || '';
    return {
      version: attr,
      readyState: document.readyState,
      url: location.href,
      editorState: editorState,
    };
  });
}

async function runAutomationActionInPage(page, action, timeoutMs) {
  return page.evaluate(function (payload) {
    return new Promise(function (resolve, reject) {
      var timeoutId = 0;
      var requestId = 'feishu-real-test-' + Date.now() + '-' + Math.random().toString(16).slice(2);

      function cleanup() {
        if (timeoutId) clearTimeout(timeoutId);
        window.removeEventListener(payload.resultEvent, onResult, true);
      }

      function onResult(event) {
        var detail = event && event.detail ? event.detail : {};
        if (detail.requestId !== requestId) return;
        cleanup();
        resolve(detail);
      }

      timeoutId = setTimeout(function () {
        cleanup();
        reject(new Error('Timed out waiting for automation result.'));
      }, payload.timeoutMs);

      window.addEventListener(payload.resultEvent, onResult, true);
      window.dispatchEvent(new CustomEvent(payload.requestEvent, {
        detail: {
          requestId: requestId,
          action: payload.action,
        },
      }));
    });
  }, {
    action: String(action || DEFAULT_ACTION),
    timeoutMs: Number(timeoutMs || DEFAULT_TIMEOUT_MS),
    requestEvent: AUTOMATION_REQUEST_EVENT,
    resultEvent: AUTOMATION_RESULT_EVENT,
  });
}

async function readAutomationArtifacts(page) {
  return page.evaluate(function () {
    function readJsonAttr(name) {
      var raw = document.documentElement.getAttribute(name);
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch (error) {
        return { parseError: String(error && error.message || error), raw: raw };
      }
    }

    return {
      helperVersion: document.documentElement.getAttribute('data-feishu-helper-active') || '',
      pendingPasteTs: document.documentElement.getAttribute('data-feishu-pending-paste-ts') || '',
      extractionResult: readJsonAttr('data-feishu-extraction-result'),
      validationSnapshot: readJsonAttr('data-feishu-validation-snapshot'),
      nativePastePrepare: readJsonAttr('data-feishu-native-paste-prepare'),
      uploadResult: readJsonAttr('data-feishu-upload-result'),
    };
  });
}

async function focusFeishuEditor(page) {
  var editor = page.locator(CONTENT_ROOT_SELECTOR).first();
  await editor.waitFor({ state: 'visible', timeout: 20000 });
  await editor.click({ force: true });
  return editor;
}

async function readJsonDocumentAttribute(page, attrName) {
  return page.evaluate(function (name) {
    var raw = document.documentElement.getAttribute(name);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (error) {
      return { parseError: String(error && error.message || error), raw: raw };
    }
  }, attrName);
}

async function dispatchDocumentEvent(page, eventName, detail) {
  await page.evaluate(function (payload) {
    document.dispatchEvent(new CustomEvent(payload.eventName, {
      detail: payload.detail || {},
      bubbles: true,
      cancelable: true,
    }));
  }, {
    eventName: String(eventName || ''),
    detail: detail || {},
  });
}

async function captureValidationSnapshot(page) {
  await dispatchDocumentEvent(page, 'feishu-capture-snapshot', {});
  await page.waitForFunction(function () {
    return !!document.documentElement.getAttribute('data-feishu-validation-snapshot');
  }, null, { timeout: 10000 });
  return readJsonDocumentAttribute(page, 'data-feishu-validation-snapshot');
}

async function waitForSnapshotChange(page, baselineSignature, timeoutMs) {
  await page.waitForFunction(function (payload) {
    var raw = document.documentElement.getAttribute('data-feishu-validation-snapshot');
    if (!raw) return false;
    try {
      return JSON.stringify(JSON.parse(raw)) !== payload.baselineSignature;
    } catch (error) {
      return false;
    }
  }, {
    baselineSignature: String(baselineSignature || 'null'),
  }, { timeout: timeoutMs || 15000 });
  return {
    snapshot: await readJsonDocumentAttribute(page, 'data-feishu-validation-snapshot'),
  };
}

async function clearTargetDocument(page) {
  await focusFeishuEditor(page);
  await page.keyboard.press('Meta+A');
  await page.waitForTimeout(80);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(250);
  await page.keyboard.press('Meta+A');
  await page.waitForTimeout(80);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(400);
  return captureValidationSnapshot(page);
}

async function prepareNativeClipboard(page, timeoutMs) {
  await dispatchDocumentEvent(page, 'feishu-prepare-native-paste', {});
  await page.waitForFunction(function () {
    var raw = document.documentElement.getAttribute('data-feishu-native-paste-prepare');
    if (!raw) return false;
    try {
      var value = JSON.parse(raw);
      return value && value.status && value.status !== 'running';
    } catch (error) {
      return false;
    }
  }, null, { timeout: timeoutMs || 20000 });
  return readJsonDocumentAttribute(page, 'data-feishu-native-paste-prepare');
}

async function runTargetPasteValidation(page, options) {
  var timeoutMs = Number(options && options.timeoutMs || DEFAULT_TIMEOUT_MS);
  await focusFeishuEditor(page);
  var beforeCleanupSnapshot = await clearTargetDocument(page);
  var baselineSnapshot = await captureValidationSnapshot(page);
  var baselineSignature = buildSnapshotSignature(baselineSnapshot);
  var nativePrepare = await prepareNativeClipboard(page, timeoutMs);
  if (nativePrepare && nativePrepare.status === 'error') {
    throw new Error(nativePrepare.error || 'Native clipboard preparation failed.');
  }
  var result = {
    baselineSnapshot: baselineSnapshot,
    baselineSignature: baselineSignature,
    beforeCleanupSnapshot: beforeCleanupSnapshot,
    nativePrepare: nativePrepare,
  };

  var primaryTrigger = { triggered: 'Cmd+Shift+P' };
  await page.keyboard.press('Meta+Shift+P');
  var primaryResult = null;
  var primaryError = '';
  try {
    primaryResult = await waitForSnapshotChange(page, baselineSignature, timeoutMs);
  } catch (error) {
    primaryError = String(error && error.message || error);
  }
  var primarySnapshot = primaryResult && primaryResult.snapshot ? primaryResult.snapshot : null;
  var primaryChanged = buildSnapshotSignature(primarySnapshot) !== baselineSignature;

  if (primaryChanged) {
    result.pasteAttempt = {
      changed: true,
      usedFallback: false,
      primaryChanged: true,
      primaryTrigger: primaryTrigger,
      finalTrigger: primaryTrigger,
      finalSnapshot: primarySnapshot,
      primaryError: primaryError,
    };
  } else {
    var fallbackTrigger = { triggered: 'Cmd+V' };
    await page.keyboard.press('Meta+V');
    var fallbackResult = null;
    var fallbackError = '';
    try {
      fallbackResult = await waitForSnapshotChange(page, baselineSignature, timeoutMs);
    } catch (error) {
      fallbackError = String(error && error.message || error);
    }
    var fallbackSnapshot = fallbackResult && fallbackResult.snapshot ? fallbackResult.snapshot : null;
    result.pasteAttempt = {
      changed: buildSnapshotSignature(fallbackSnapshot) !== baselineSignature,
      usedFallback: true,
      primaryChanged: false,
      primaryTrigger: primaryTrigger,
      fallbackTrigger: fallbackTrigger,
      finalTrigger: fallbackTrigger,
      finalSnapshot: fallbackSnapshot,
      primaryError: primaryError,
      fallbackError: fallbackError,
    };
  }

  result.afterPasteSnapshot = await captureValidationSnapshot(page);
  await page.waitForTimeout(DEFAULT_SHORT_WAIT_MS);
  result.cleanup = {
    attempted: true,
    error: '',
    trigger: { shortcut: 'Cmd+A+Backspace' },
    finalSnapshot: null,
  };
  await focusFeishuEditor(page);
  await page.keyboard.press('Meta+A');
  await page.waitForTimeout(80);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(400);
  result.cleanup.finalSnapshot = await captureValidationSnapshot(page);
  return result;
}

function assertAutomationResult(result, artifacts) {
  if (!result || result.status !== 'success') {
    throw new Error(result && result.error ? String(result.error) : 'Automation action failed.');
  }
  var summary = result.summary || {};
  var snapshot = summary.validationSnapshot || artifacts.validationSnapshot || {};
  if (!artifacts.helperVersion) {
    throw new Error('Userscript did not expose the ready marker on the target page.');
  }
  if (!summary.title) {
    throw new Error('Automation summary did not contain a document title.');
  }
  if (!Number(snapshot.blockCount || 0)) {
    throw new Error('Automation validation snapshot reported zero blocks.');
  }
  if (!(summary.pendingPaste && Number(summary.pendingPaste.ts || 0) > 0)) {
    throw new Error('Pending paste cache was not updated after extraction.');
  }
}

async function main() {
  var args = parseCliArgs(process.argv.slice(2));
  var endpointUrl = args['cdp-url'] || DEFAULT_CDP_ENDPOINT;
  var scriptPath = resolve(args['script-path'] || DEFAULT_SCRIPT_PATH);
  var action = args.action || DEFAULT_ACTION;
  var timeoutMs = Number(args.timeout || DEFAULT_TIMEOUT_MS);
  var sourceUrl = args['source-url'] || '';
  var targetUrl = args['target-url'] || args.url || '';

  var browser = await connectToChromeOverCDP(endpointUrl);
  try {
    var page = null;
    console.log('[feishu-real-test-runner] sync:start');
    var syncStep = await syncUserscriptInBrowser(browser, {
      scriptPath: scriptPath,
    });
    page = syncStep.page;
    var originalUrl = syncStep.previousUrl;
    var sync = syncStep.sync;
    console.log('[feishu-real-test-runner] sync:done');

    console.log('[feishu-real-test-runner] source:prepare');
    var sourcePageUrl = await ensureFeishuDocumentPage(page, sourceUrl || originalUrl);
    var sourceHelper = await waitForFeishuHelperReady(page, timeoutMs);
    console.log('[feishu-real-test-runner] source:ready');

    console.log('[feishu-real-test-runner] source:extract:start');
    var extraction = await runAutomationActionInPage(page, action, timeoutMs);
    var sourceArtifacts = await readAutomationArtifacts(page);
    assertAutomationResult(extraction, sourceArtifacts);
    console.log('[feishu-real-test-runner] source:extract:done');

    console.log('[feishu-real-test-runner] target:prepare');
    var targetPageUrl = await ensureFeishuDocumentPage(page, targetUrl);
    var targetHelper = await waitForFeishuHelperReady(page, timeoutMs);
    console.log('[feishu-real-test-runner] target:ready');

    console.log('[feishu-real-test-runner] target:paste:start');
    var targetValidation = await runTargetPasteValidation(page, {
      timeoutMs: timeoutMs,
    });
    var targetArtifacts = await readAutomationArtifacts(page);
    console.log('[feishu-real-test-runner] target:paste:done');

    console.log(JSON.stringify({
      sync: sync,
      source: {
        pageUrl: sourcePageUrl,
        helper: sourceHelper,
        automation: extraction,
        artifacts: sourceArtifacts,
      },
      target: {
        pageUrl: targetPageUrl,
        helper: targetHelper,
        validation: targetValidation,
        artifacts: targetArtifacts,
      },
      previousUrl: originalUrl,
    }, null, 2));
  } finally {
    await browser.close();
  }
}

module.exports = {
  assertAutomationResult: assertAutomationResult,
  isFeishuDocUrl: isFeishuDocUrl,
  parseCliArgs: parseCliArgs,
  runAutomationActionInPage: runAutomationActionInPage,
  waitForFeishuHelperReady: waitForFeishuHelperReady,
};

if (require.main === module) {
  main().catch(function (error) {
    console.error('[feishu-real-test-runner] failed:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}
