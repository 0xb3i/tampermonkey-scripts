#!/usr/bin/env node

const { resolve } = require('path');

const {
  DEFAULT_CASE_ID,
  getFeishuCase,
  listFeishuCases,
} = require('./feishu-cases.cjs');
const {
  buildSnapshotSignature,
} = require('../lib/feishu-paste-fallback-utils.cjs');
const {
  assertFeishuCaseResult,
} = require('../lib/feishu-assertions.cjs');
const {
  DEFAULT_CDP_ENDPOINT,
  connectToChromeOverCDP,
  navigateCurrentTab,
  syncUserscriptInBrowser,
  waitForDocumentReady,
} = require('../lib/tampermonkey-cdp-utils.cjs');

const DEFAULT_SCRIPT_PATH = resolve(__dirname, '../userscripts/feishu-helper.user.js');
const DEFAULT_ACTION = 'validateDuplicateDocument';
const DEFAULT_TIMEOUT_MS = 45000;
const DEFAULT_SHORT_WAIT_MS = 1200;
const DEFAULT_CLEANUP_MAX_ATTEMPTS = 3;
const DEFAULT_CLEANUP_STABLE_POLLS = 4;
const DEFAULT_CLEANUP_STABLE_WAIT_MS = 400;
const DEFAULT_SELECT_ALL_REPEAT_COUNT = 3;
const CLEANUP_BASELINE_ALLOWED_COMPONENT_LIMITS = {
  equation: 2,
  image: 6,
};
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

function resolveRequestedCaseId(args) {
  return args && typeof args.case === 'string' ? args.case : '';
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

function parseEditorReadyState(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(String(raw));
  } catch (error) {
    return null;
  }
}

function isEditorReadyStateSatisfied(state) {
  if (!state || !state.hasContentRoot) {
    return false;
  }
  return !!(state.hasContentLoaded || state.hasStructService || state.hasRootBlock);
}

function chooseBestEditorCandidateIndex(candidates) {
  if (!Array.isArray(candidates) || !candidates.length) {
    return 0;
  }

  var bestIndex = 0;
  var bestScore = -Infinity;

  candidates.forEach(function (candidate, index) {
    var item = candidate || {};
    var area = Math.max(Number(item.rectWidth || 0), 0) * Math.max(Number(item.rectHeight || 0), 0);
    var score = 0;

    if (item.isPrimaryRoot) score += 8;
    score += Math.min(Number(item.textLength || 0), 4000) / 50;
    score += Math.min(Number(item.richNodeCount || 0), 30) * 3;
    score += Math.min(Number(item.imageCount || 0), 10) * 4;
    score += Math.min(Number(item.tableCount || 0), 10) * 4;
    score += Math.min(Number(item.blockCount || 0), 40) * 1.5;
    score += Math.min(area, 1600000) / 20000;

    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });

  return bestIndex;
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
      if (!state || !state.hasContentRoot) return false;
      return !!(state.hasContentLoaded || state.hasStructService || state.hasRootBlock);
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
      var requestId = 'feishu-test-' + Date.now() + '-' + Math.random().toString(16).slice(2);

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
      whiteboardClones: readJsonAttr('data-feishu-captured-whiteboard-clones'),
      whiteboardHookState: readJsonAttr('data-feishu-whiteboard-hook-state'),
      whiteboardHookLog: readJsonAttr('data-feishu-whiteboard-hook-log'),
    };
  });
}

async function focusFeishuEditor(page) {
  var editorIndex = await page.locator(CONTENT_ROOT_SELECTOR).evaluateAll(function (nodes) {
    function scoreCandidate(node) {
      if (!node) return -Infinity;
      var rect = typeof node.getBoundingClientRect === 'function'
        ? node.getBoundingClientRect()
        : { width: 0, height: 0 };
      var textLength = String(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim().length;
      var richNodeCount = node.querySelectorAll('img, table, blockquote, pre, hr, [data-block-type], .callout-container, .callout-block, [class*="code-block"], [class*="whiteboard"]').length;
      var imageCount = node.querySelectorAll('img, [data-block-type="image"]').length;
      var tableCount = node.querySelectorAll('table, [data-block-type="table"]').length;
      var blockCount = node.querySelectorAll('[data-block-type], p, li, pre, table, blockquote').length;
      var area = Math.max(rect.width || 0, 0) * Math.max(rect.height || 0, 0);
      var score = 0;

      if (node.getAttribute('data-content-editable-root') === 'true') score += 8;
      score += Math.min(textLength, 4000) / 50;
      score += Math.min(richNodeCount, 30) * 3;
      score += Math.min(imageCount, 10) * 4;
      score += Math.min(tableCount, 10) * 4;
      score += Math.min(blockCount, 40) * 1.5;
      score += Math.min(area, 1600000) / 20000;
      return score;
    }

    if (!nodes || !nodes.length) return 0;
    var bestIndex = 0;
    var bestScore = -Infinity;
    nodes.forEach(function (node, index) {
      var score = scoreCandidate(node);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });
    return bestIndex;
  });
  var editor = page.locator(CONTENT_ROOT_SELECTOR).nth(editorIndex);
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

async function captureStableCleanupSnapshot(page, options) {
  var maxPolls = Number(options && options.maxPolls || DEFAULT_CLEANUP_STABLE_POLLS);
  var waitMs = Number(options && options.waitMs || DEFAULT_CLEANUP_STABLE_WAIT_MS);
  var lastSignature = '';
  var lastSnapshot = null;

  for (var attempt = 0; attempt < maxPolls; attempt += 1) {
    var snapshot = await captureValidationSnapshot(page);
    var signature = buildCleanupSnapshotSignature(snapshot);
    if (signature === lastSignature) {
      return snapshot;
    }
    lastSignature = signature;
    lastSnapshot = snapshot;
    if (attempt < maxPolls - 1) {
      await page.waitForTimeout(waitMs);
    }
  }

  return lastSnapshot;
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
  var lastSnapshot = null;

  for (var attempt = 0; attempt < DEFAULT_CLEANUP_MAX_ATTEMPTS; attempt += 1) {
    await focusFeishuEditor(page);
    await runDoubleSelectDeleteShortcut(page, 'Backspace');
    await runDoubleSelectDeleteShortcut(page, 'Backspace');
    await runDoubleSelectDeleteShortcut(page, 'Delete');
    await page.waitForTimeout(DEFAULT_SHORT_WAIT_MS);
    lastSnapshot = await captureStableCleanupSnapshot(page);
    if (isCleanupSnapshotReadyAsBaseline(lastSnapshot)) {
      return lastSnapshot;
    }
  }

  throw new Error(
    'Target pre-clean did not fully clear residual rich components.'
    + '\n[feishu-pre-clean-debug] '
    + JSON.stringify(summarizeSnapshotForDebug(lastSnapshot), null, 2)
  );
}

function snapshotMatchesBaseline(baselineSignature, snapshot) {
  return buildCleanupSnapshotSignature(snapshot) === String(baselineSignature || 'null');
}

function buildCleanupSnapshotSignature(snapshot) {
  if (!snapshot) {
    return 'null';
  }

  return buildSnapshotSignature({
    semanticSnapshot: {
      componentCounts: normalizeCleanupComponentCounts(
        snapshot.semanticSnapshot && snapshot.semanticSnapshot.componentCounts
      ),
    },
  });
}

function normalizeCleanupComponentCounts(componentCounts) {
  var source = componentCounts || {};
  var normalized = {};
  Object.keys(source).sort().forEach(function (key) {
    normalized[String(key)] = Number(source[key] || 0);
  });
  return normalized;
}

function isCleanupSnapshotReadyAsBaseline(snapshot) {
  if (!snapshot) return false;

  var componentCounts = normalizeCleanupComponentCounts(
    snapshot.semanticSnapshot && snapshot.semanticSnapshot.componentCounts
  );

  return Object.keys(componentCounts).every(function (key) {
    var count = Number(componentCounts[key] || 0);
    var allowedLimit = CLEANUP_BASELINE_ALLOWED_COMPONENT_LIMITS[String(key)];
    if (typeof allowedLimit === 'number') {
      return count <= allowedLimit;
    }
    return count <= 0;
  });
}

async function runDoubleSelectDeleteShortcut(page, deleteKey) {
  for (var repeat = 0; repeat < DEFAULT_SELECT_ALL_REPEAT_COUNT; repeat += 1) {
    await page.keyboard.press('Meta+A');
    await page.waitForTimeout(80);
  }
  await page.keyboard.press(String(deleteKey || 'Backspace'));
  await page.waitForTimeout(320);
}

async function performCleanupShortcut(page) {
  await focusFeishuEditor(page);
  await runDoubleSelectDeleteShortcut(page, 'Backspace');
  await runDoubleSelectDeleteShortcut(page, 'Delete');
}

async function cleanupTargetDocumentToBaseline(page, baselineSignature, options) {
  var maxAttempts = Number(options && options.maxAttempts || DEFAULT_CLEANUP_MAX_ATTEMPTS);
  var result = {
    attempted: true,
    error: '',
    trigger: { shortcut: 'Cmd+A+Backspace/Delete' },
    finalSnapshot: null,
    attempts: 0,
    matchedBaseline: false,
  };

  for (var attempt = 0; attempt < maxAttempts; attempt += 1) {
    result.attempts = attempt + 1;
    await performCleanupShortcut(page);
    result.finalSnapshot = await captureStableCleanupSnapshot(page);
    if (snapshotMatchesBaseline(baselineSignature, result.finalSnapshot)) {
      result.matchedBaseline = true;
      return result;
    }
    await page.waitForTimeout(250);
  }

  result.error = 'Cleanup did not return target document to baseline snapshot after '
    + maxAttempts + ' attempts.';
  return result;
}

function assertTargetCleanupResult(validation) {
  var cleanup = validation && validation.cleanup ? validation.cleanup : null;
  if (!cleanup || !cleanup.attempted) {
    throw new Error('Target cleanup was not attempted.');
  }
  if (cleanup.error) {
    throw new Error(
      cleanup.error
      + '\n[feishu-cleanup-debug] '
      + JSON.stringify({
        baselineSnapshot: summarizeSnapshotForDebug(validation && validation.baselineSnapshot),
        finalSnapshot: summarizeSnapshotForDebug(cleanup.finalSnapshot),
        attempts: Number(cleanup.attempts || 0),
        matchedBaseline: cleanup.matchedBaseline === true,
      }, null, 2)
    );
  }
  if (!cleanup.matchedBaseline) {
    throw new Error(
      'Cleanup did not return target document to baseline snapshot.'
      + '\n[feishu-cleanup-debug] '
      + JSON.stringify({
        baselineSnapshot: summarizeSnapshotForDebug(validation && validation.baselineSnapshot),
        finalSnapshot: summarizeSnapshotForDebug(cleanup.finalSnapshot),
        attempts: Number(cleanup.attempts || 0),
        matchedBaseline: cleanup.matchedBaseline === true,
      }, null, 2)
    );
  }
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

async function installWhiteboardHookDebug(page, options) {
  await dispatchDocumentEvent(page, 'feishu-install-whiteboard-hook-debug', {
    reset: !(options && options.reset === false),
  });
  await page.waitForFunction(function () {
    return !!document.documentElement.getAttribute('data-feishu-whiteboard-hook-state');
  }, null, { timeout: 10000 });
  return readJsonDocumentAttribute(page, 'data-feishu-whiteboard-hook-state');
}

async function refreshWhiteboardHookDebug(page) {
  await dispatchDocumentEvent(page, 'feishu-read-whiteboard-hook-debug', {});
  return readJsonDocumentAttribute(page, 'data-feishu-whiteboard-hook-state');
}

async function runTargetPasteValidation(page, options) {
  var timeoutMs = Number(options && options.timeoutMs || DEFAULT_TIMEOUT_MS);
  var whiteboardHookState = await installWhiteboardHookDebug(page, { reset: true });
  await focusFeishuEditor(page);
  var initialSnapshot = await captureStableCleanupSnapshot(page);
  var baselineSnapshot = await clearTargetDocument(page);
  var baselineSignature = buildCleanupSnapshotSignature(baselineSnapshot);
  var pasteBaselineSignature = buildSnapshotSignature(baselineSnapshot);
  var nativePrepare = await prepareNativeClipboard(page, timeoutMs);
  if (nativePrepare && nativePrepare.status === 'error') {
    throw new Error(nativePrepare.error || 'Native clipboard preparation failed.');
  }
  var result = {
    initialSnapshot: initialSnapshot,
    baselineSnapshot: baselineSnapshot,
    baselineSignature: baselineSignature,
    nativePrepare: nativePrepare,
    whiteboardHookState: whiteboardHookState,
  };

  var primaryTrigger = { triggered: 'Cmd+Shift+P' };
  await page.keyboard.press('Meta+Shift+P');
  var primaryResult = null;
  var primaryError = '';
  try {
    primaryResult = await waitForSnapshotChange(page, pasteBaselineSignature, timeoutMs);
  } catch (error) {
    primaryError = String(error && error.message || error);
  }
  var primarySnapshot = primaryResult && primaryResult.snapshot ? primaryResult.snapshot : null;
  var primaryChanged = buildSnapshotSignature(primarySnapshot) !== pasteBaselineSignature;

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
      fallbackResult = await waitForSnapshotChange(page, pasteBaselineSignature, timeoutMs);
    } catch (error) {
      fallbackError = String(error && error.message || error);
    }
    var fallbackSnapshot = fallbackResult && fallbackResult.snapshot ? fallbackResult.snapshot : null;
    result.pasteAttempt = {
      changed: buildSnapshotSignature(fallbackSnapshot) !== pasteBaselineSignature,
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

  await page.waitForTimeout(DEFAULT_SHORT_WAIT_MS);
  await refreshWhiteboardHookDebug(page);
  result.afterPasteSnapshot = await captureStableCleanupSnapshot(page);
  return result;
}

function resolveFeishuCases(caseId) {
  if (caseId) {
    return [getFeishuCase(caseId)];
  }
  return listFeishuCases();
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

function summarizeSnapshotForDebug(snapshot) {
  var semanticSnapshot = snapshot && snapshot.semanticSnapshot ? snapshot.semanticSnapshot : {};
  return {
    title: snapshot && snapshot.title ? String(snapshot.title) : '',
    blockCount: Number(snapshot && snapshot.blockCount || 0),
    equationCount: Number(snapshot && snapshot.equationCount || 0),
    textLength: Number(snapshot && snapshot.textLength || 0),
    componentCounts: semanticSnapshot && semanticSnapshot.componentCounts ? semanticSnapshot.componentCounts : {},
    componentSample: Array.isArray(semanticSnapshot && semanticSnapshot.components)
      ? semanticSnapshot.components.slice(0, 5).map(function (component) {
        return {
          type: component.type,
          textSample: component.textSample || '',
          rowCount: Number(component.rowCount || 0),
          colCount: Number(component.colCount || 0),
          rendered: component.rendered === true,
          width: Number(component.width || 0),
          height: Number(component.height || 0),
        };
      })
      : [],
  };
}

async function runSingleFeishuCaseTest(selectedCase, options) {
  var config = options || {};
  var endpointUrl = config.cdpUrl || DEFAULT_CDP_ENDPOINT;
  var scriptPath = resolve(config.scriptPath || DEFAULT_SCRIPT_PATH);
  var action = config.action || selectedCase.action || DEFAULT_ACTION;
  var timeoutMs = Number(config.timeout || DEFAULT_TIMEOUT_MS);
  var sourceUrl = config.sourceUrl || selectedCase.sourceUrl || '';
  var targetUrl = config.targetUrl || config.url || selectedCase.targetUrl || '';
  var browser = await connectToChromeOverCDP(endpointUrl);
  try {
    var page = null;
    console.log('[feishu-runner] sync:start');
    var syncStep = await syncUserscriptInBrowser(browser, {
      scriptPath: scriptPath,
    });
    page = syncStep.page;
    var originalUrl = syncStep.previousUrl;
    var sync = syncStep.sync;
    console.log('[feishu-runner] sync:done');

    console.log('[feishu-runner] source:prepare');
    var sourcePageUrl = await ensureFeishuDocumentPage(page, sourceUrl || originalUrl);
    var sourceHelper = await waitForFeishuHelperReady(page, timeoutMs);
    console.log('[feishu-runner] source:ready');

    console.log('[feishu-runner] source:extract:start');
    var extraction = await runAutomationActionInPage(page, action, timeoutMs);
    var sourceArtifacts = await readAutomationArtifacts(page);
    assertAutomationResult(extraction, sourceArtifacts);
    console.log('[feishu-runner] source:extract:done');

    console.log('[feishu-runner] target:prepare');
    var targetPageUrl = await ensureFeishuDocumentPage(page, targetUrl);
    var targetHelper = await waitForFeishuHelperReady(page, timeoutMs);
    console.log('[feishu-runner] target:ready');

    console.log('[feishu-runner] target:paste:start');
    var targetValidation = await runTargetPasteValidation(page, {
      timeoutMs: timeoutMs,
    });
    var targetArtifacts = await readAutomationArtifacts(page);
    console.log('[feishu-runner] target:paste:done');

    var result = {
      caseId: selectedCase.id,
      caseDescription: selectedCase.description,
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
    };

    try {
      assertFeishuCaseResult({
        testCase: selectedCase,
        source: result.source,
        target: result.target,
      });
    } catch (error) {
      var debugPayload = {
        caseId: selectedCase.id,
        pasteAttemptChanged: !!(targetValidation && targetValidation.pasteAttempt && targetValidation.pasteAttempt.changed),
        pasteAttemptFinalSnapshot: summarizeSnapshotForDebug(
          targetValidation && targetValidation.pasteAttempt
            ? targetValidation.pasteAttempt.finalSnapshot
            : null
        ),
        afterPasteSnapshot: summarizeSnapshotForDebug(
          targetValidation ? targetValidation.afterPasteSnapshot : null
        ),
        postCleanupArtifactSnapshot: summarizeSnapshotForDebug(
          targetArtifacts ? targetArtifacts.validationSnapshot : null
        ),
        uploadResult: targetArtifacts && targetArtifacts.uploadResult ? targetArtifacts.uploadResult : null,
        whiteboardClones: targetArtifacts && targetArtifacts.whiteboardClones ? targetArtifacts.whiteboardClones : null,
        whiteboardHookState: targetArtifacts && targetArtifacts.whiteboardHookState ? targetArtifacts.whiteboardHookState : null,
        whiteboardHookLog: targetArtifacts && targetArtifacts.whiteboardHookLog ? targetArtifacts.whiteboardHookLog : null,
      };
      throw new Error(
        (error && error.message ? error.message : String(error))
        + '\n[feishu-debug] '
        + JSON.stringify(debugPayload, null, 2)
      );
    }

    return result;
  } finally {
    await browser.close();
  }
}

async function runFeishuTest(options) {
  var config = options || {};
  var selectedCases = resolveFeishuCases(config.caseId || '');
  var results = [];

  for (var index = 0; index < selectedCases.length; index += 1) {
    var selectedCase = selectedCases[index];
    results.push(await runSingleFeishuCaseTest(selectedCase, config));
  }

  if (results.length === 1) {
    return results[0];
  }

  return {
    results: results,
    total: results.length,
  };
}

module.exports = {
  assertAutomationResult: assertAutomationResult,
  assertTargetCleanupResult: assertTargetCleanupResult,
  buildCleanupSnapshotSignature: buildCleanupSnapshotSignature,
  chooseBestEditorCandidateIndex: chooseBestEditorCandidateIndex,
  isCleanupSnapshotReadyAsBaseline: isCleanupSnapshotReadyAsBaseline,
  isEditorReadyStateSatisfied: isEditorReadyStateSatisfied,
  isFeishuDocUrl: isFeishuDocUrl,
  parseCliArgs: parseCliArgs,
  parseEditorReadyState: parseEditorReadyState,
  resolveRequestedCaseId: resolveRequestedCaseId,
  resolveFeishuCases: resolveFeishuCases,
  runDoubleSelectDeleteShortcut: runDoubleSelectDeleteShortcut,
  runAutomationActionInPage: runAutomationActionInPage,
  runFeishuTest: runFeishuTest,
  waitForFeishuHelperReady: waitForFeishuHelperReady,
};

if (require.main === module) {
  var args = parseCliArgs(process.argv.slice(2));
  if (args['list-cases']) {
    console.log(JSON.stringify(listFeishuCases(), null, 2));
  } else {
    runFeishuTest({
      caseId: resolveRequestedCaseId(args),
      cdpUrl: args['cdp-url'] || DEFAULT_CDP_ENDPOINT,
      scriptPath: args['script-path'] || DEFAULT_SCRIPT_PATH,
      sourceUrl: args['source-url'],
      targetUrl: args['target-url'] || args.url,
      action: args.action || DEFAULT_ACTION,
      timeout: Number(args.timeout || DEFAULT_TIMEOUT_MS),
    }).then(function (result) {
      console.log(JSON.stringify(result, null, 2));
    }).catch(function (error) {
      console.error('[feishu-runner] failed:', error && error.stack ? error.stack : error);
      process.exitCode = 1;
    });
  }
}
