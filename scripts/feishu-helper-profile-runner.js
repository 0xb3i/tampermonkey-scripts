const { chromium } = require('@playwright/test');
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } = require('fs');
const { DatabaseSync } = require('node:sqlite');
const { join, resolve } = require('path');
const { homedir, tmpdir } = require('os');

const DEFAULT_VIEWPORT = { width: 1440, height: 960 };
const DEFAULT_SCRIPT_PATH = join(__dirname, 'feishu-helper.user.js');
const DEFAULT_PROBE_FUNCTION = '__tampermonkeyScriptDebugExports';
const LEGACY_PROBE_FUNCTION = '__feishuDebugExports';
const BOOLEAN_FLAGS = new Set(['headless', 'close', 'clone-profile', 'attach-active-chrome', 'sync-tampermonkey', 'real-test', 'validate-native-paste']);
const CHROMIUM_EPOCH_OFFSET_SECONDS = 11644473600;
const CHROME_SAFE_STORAGE_SERVICE = 'Chrome Safe Storage';
const COOKIE_DOMAIN_SUFFIXES = ['larkoffice.com', 'feishu.cn', 'feishuapp.cn'];

function extractInjectableScript(scriptContent) {
  const match = String(scriptContent || '').match(/\(function\s*\(\)\s*\{[\s\S]*\}\)\(\);/);
  return match ? match[0] : String(scriptContent || '');
}

function readInjectableScript(scriptPath) {
  const content = readFileSync(scriptPath || DEFAULT_SCRIPT_PATH, 'utf-8');
  return extractInjectableScript(content);
}

function readUserscriptSource(scriptPath) {
  return readFileSync(scriptPath || DEFAULT_SCRIPT_PATH, 'utf-8');
}

function extractUserscriptMetadata(scriptContent) {
  const source = String(scriptContent || '');
  const readMeta = (key) => {
    const match = source.match(new RegExp(`^\\s*//\\s*@${key}\\s+(.+)$`, 'm'));
    return match ? match[1].trim() : '';
  };

  return {
    name: readMeta('name'),
    version: readMeta('version'),
  };
}

function readConfiguredPageScript(options) {
  const inlineScript = options && options.pageScript ? String(options.pageScript) : '';
  if (inlineScript) return inlineScript;

  const pageScriptFile = options && options.pageScriptFile ? String(options.pageScriptFile) : '';
  if (!pageScriptFile) return '';
  return readFileSync(resolve(pageScriptFile), 'utf-8');
}

function buildAsyncPageScriptRunnerSource(scriptSource) {
  return `
    const summarizeError = (error) => String(error && error.stack ? error.stack : error);
    const scriptSource = ${JSON.stringify(String(scriptSource || ''))};
    const pageRunner = new Function('window', 'document', 'return (async () => {\\n' + scriptSource + '\\n})();');
  `;
}

function buildProbeFunctionCandidates(preferred) {
  return Array.from(new Set([
    preferred,
    DEFAULT_PROBE_FUNCTION,
    LEGACY_PROBE_FUNCTION,
  ].filter(Boolean)));
}

function resolveAutomationAction(options) {
  const config = options || {};
  const explicitAction = config.explicitAction ? String(config.explicitAction) : '';
  if (explicitAction) return explicitAction;

  const automation = config.automation || {};
  const actions = Array.isArray(automation.actions)
    ? automation.actions.map((action) => String(action || '')).filter(Boolean)
    : [];
  const defaultAction = automation.defaultAction ? String(automation.defaultAction) : '';

  if (config.realTest) {
    const realTestAction = actions.find((action) => /^realtest/i.test(action));
    if (realTestAction) return realTestAction;
  }

  return defaultAction || actions[0] || '';
}

function deriveChromeSafeStorageKey(password) {
  return crypto.pbkdf2Sync(Buffer.from(String(password || ''), 'utf8'), Buffer.from('saltysalt', 'utf8'), 1003, 16, 'sha1');
}

function chromiumTimeToUnixSeconds(chromiumTime) {
  if (!chromiumTime) return undefined;
  return Math.floor(Number(chromiumTime) / 1000000 - CHROMIUM_EPOCH_OFFSET_SECONDS);
}

function escapeAppleScriptString(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

function runAppleScriptLines(lines) {
  const args = [];
  for (const line of lines) {
    args.push('-e', line);
  }
  return execFileSync('osascript', args, {
    encoding: 'utf8',
  }).trim();
}

function executeJavaScriptInActiveChromeTab(script) {
  return runAppleScriptLines([
    `tell application "Google Chrome" to tell active tab of front window to execute javascript "${escapeAppleScriptString(script)}"`,
  ]);
}

function getActiveChromeTabUrl() {
  return runAppleScriptLines([
    'tell application "Google Chrome" to get URL of active tab of front window',
  ]);
}

function navigateActiveChromeTab(url) {
  runAppleScriptLines([
    'tell application "Google Chrome" to activate',
    `tell application "Google Chrome" to set URL of active tab of front window to "${escapeAppleScriptString(url)}"`,
    'tell application "Google Chrome" to repeat 240 times',
    'tell application "Google Chrome" to if loading of active tab of front window is false then exit repeat',
    'delay 0.25',
    'end repeat',
  ]);
}

function reloadActiveChromeTab() {
  runAppleScriptLines([
    'tell application "Google Chrome" to activate',
    'tell application "Google Chrome" to tell active tab of front window to reload',
    'tell application "Google Chrome" to repeat 240 times',
    'tell application "Google Chrome" to if loading of active tab of front window is false then exit repeat',
    'delay 0.25',
    'end repeat',
  ]);
}

function buildActiveChromeInjectionSteps(scriptContent, chunkSize) {
  const source = String(scriptContent || '');
  const size = Math.max(1024, Number(chunkSize) || 48000);
  const steps = [
    'window.__feishuHelperScriptChunks = []; window.__feishuDebugProbeError = "";',
  ];

  for (let i = 0; i < source.length; i += size) {
    const chunk = source.slice(i, i + size);
    steps.push(`window.__feishuHelperScriptChunks.push(${JSON.stringify(chunk)});`);
  }

  steps.push(`(()=>{try{const code=window.__feishuHelperScriptChunks.join('');window.__feishuHelperScriptChunks=[];window.__feishuDebugProbeError='';return eval(code);}catch(error){window.__feishuDebugProbeError=String(error&&error.stack?error.stack:error);throw error;}})();`);
  return steps;
}

function injectScriptIntoActiveChromeTab(scriptContent) {
  const steps = buildActiveChromeInjectionSteps(scriptContent);
  for (const step of steps) {
    executeJavaScriptInActiveChromeTab(step);
  }
}

function executeLargeJavaScriptInActiveChromeTab(scriptContent, chunkSize) {
  const steps = buildActiveChromeInjectionSteps(scriptContent, chunkSize);
  let result = '';
  for (const step of steps) {
    result = executeJavaScriptInActiveChromeTab(step);
  }
  return result;
}

function ensureInjectedScriptOnActiveChrome(scriptContent) {
  if (!scriptContent) return;
  // NEVER re-inject the userscript via AppleScript execute javascript.
  // AppleScript's JS execution context runs in a Chrome isolated world that
  // cannot see React fiber properties on DOM elements (__reactFiber$*), so
  // any script injected this way will always fall back to dom-fallback mode
  // and miss images/structure.  Additionally, re-injecting overwrites the
  // window.__feishu* exports with new closures that lose in-memory state.
  //
  // Instead, always wait for the Tampermonkey extension to auto-inject.
  // Tampermonkey scripts run in a context with full React fiber access.
  // Communication between the Tampermonkey context and AppleScript's context
  // is done via DOM attributes (which ARE shared across isolated worlds).

  const hasTM = (() => {
    const raw = executeJavaScriptInActiveChromeTab(
      `document.documentElement.getAttribute('data-feishu-helper-active') !== null`
    );
    return Boolean(raw && raw !== 'false' && raw !== 'null' && raw !== '');
  })();

  if (hasTM) return;

  // TM not detected — reload the page to activate the freshly-synced script,
  // then wait for it to inject.
  reloadActiveChromeTab();
  try {
    waitForActiveChromeJavaScriptValue(`document.documentElement.getAttribute('data-feishu-helper-active') !== null`, {
      timeoutMs: 10000,
      intervalMs: 500,
      description: 'Tampermonkey script after page reload',
      predicate(value) {
        return Boolean(value && value !== false && value !== 'null' && value !== '');
      },
    });
    return;
  } catch (error) {
    // Still not available after reload.
  }
  console.warn('[feishu-helper-profile-runner] Tampermonkey did not auto-inject after reload, falling back to manual injection (limited functionality)');
  injectScriptIntoActiveChromeTab(scriptContent);
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, Number(ms) || 0));
}

function waitForActiveChromeJavaScriptValue(script, options) {
  const {
    timeoutMs = 15000,
    intervalMs = 250,
    predicate,
    description = 'condition',
  } = options || {};

  const startedAt = Date.now();
  let lastValue = null;
  let lastError = '';

  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const raw = executeJavaScriptInActiveChromeTab(`JSON.stringify((()=>{try{return (${script});}catch(error){return {__error:String(error&&error.stack?error.stack:error)}}})())`);
      lastValue = raw ? JSON.parse(raw) : null;
      if (lastValue && lastValue.__error) {
        lastError = lastValue.__error;
      } else if (typeof predicate !== 'function' ? lastValue : predicate(lastValue)) {
        return lastValue;
      }
    } catch (error) {
      lastError = String(error && error.stack ? error.stack : error);
    }
    sleepMs(intervalMs);
  }

  throw new Error(`Timed out waiting for ${description}${lastError ? ` (${lastError})` : ''}${lastValue ? `: ${JSON.stringify(lastValue)}` : ''}`);
}

function clickActiveChromeElementByText(pattern, options) {
  const matcher = pattern instanceof RegExp ? pattern : new RegExp(String(pattern || ''), 'i');
  const exclude = options && options.exclude instanceof RegExp ? options.exclude : null;
  const selector = options && options.selector ? String(options.selector) : 'input, button, a, span, div';
  const escapedPattern = matcher.source.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const escapedFlags = matcher.flags.replace(/'/g, '');
  const escapedExclude = exclude ? exclude.source.replace(/\\/g, '\\\\').replace(/'/g, "\\'") : '';
  const excludeFlags = exclude ? exclude.flags.replace(/'/g, '') : '';
  const escapedSelector = selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  return executeLargeJavaScriptInActiveChromeTab(`(()=>{
    const pattern = new RegExp('${escapedPattern}', '${escapedFlags}');
    const exclude = ${exclude ? `new RegExp('${escapedExclude}', '${excludeFlags}')` : 'null'};
    const nodes = Array.from(document.querySelectorAll('${escapedSelector}'));
    const match = nodes.find((node) => {
      const text = String(node.innerText || node.value || '').trim();
      if (!text || !pattern.test(text)) return false;
      if (exclude && exclude.test(text)) return false;
      return true;
    });
    if (!match) return 'not-found';
    match.click();
    return String(match.innerText || match.value || match.id || match.className || match.tagName || 'clicked');
  })();`, 20000);
}

function decodeTampermonkeyScriptIdFromRowId(rowId) {
  const raw = String(rowId || '');
  if (!raw.startsWith('tr_')) return '';

  try {
    const decoded = Buffer.from(raw.slice(3), 'base64').toString('utf8');
    return decoded.endsWith('_pi') ? decoded.slice(0, -3) : decoded;
  } catch (error) {
    return '';
  }
}

function isTampermonkeyEditorPage(value, scriptId) {
  return Boolean(
    value &&
    value.readyState === 'complete' &&
    typeof value.href === 'string' &&
    value.href.includes(String(scriptId || '') + '+editor')
  );
}

function openTampermonkeyScriptEditorInActiveChrome(scriptName) {
  navigateActiveChromeTab('chrome-extension://dhdgffkkebhmkfjojejmpbldmpobfkfo/options.html#nav=scripts');
  const escapedScriptName = JSON.stringify(String(scriptName || ''));
  const rowMatchRaw = executeLargeJavaScriptInActiveChromeTab(`JSON.stringify((()=>{
    const rows = Array.from(document.querySelectorAll('tr.scripttr'));
    const target = rows.find((row) => String(row.innerText || '').includes(${escapedScriptName}));
    if (!target) return null;
    return {
      id: String(target.id || ''),
      text: String(target.innerText || ''),
    };
  })())`, 20000);
  const rowMatch = rowMatchRaw ? JSON.parse(rowMatchRaw) : null;
  if (!rowMatch || !rowMatch.id) {
    throw new Error(`Unable to find Tampermonkey script row for ${scriptName}`);
  }

  const scriptId = decodeTampermonkeyScriptIdFromRowId(rowMatch.id);
  if (!scriptId) {
    throw new Error(`Unable to decode Tampermonkey script id from row ${rowMatch.id}`);
  }

  navigateActiveChromeTab(`chrome-extension://dhdgffkkebhmkfjojejmpbldmpobfkfo/options.html#nav=${scriptId}+editor`);

  return waitForActiveChromeJavaScriptValue(`({
    readyState: document.readyState,
    href: location.href,
    title: document.title,
    text: document.body ? document.body.innerText : ''
  })`, {
    timeoutMs: 10000,
    description: 'Tampermonkey editor page',
    predicate(value) {
      return isTampermonkeyEditorPage(value, scriptId);
    },
  });
}

function syncTampermonkeyScriptInActiveChrome(options) {
  const scriptPath = options && options.scriptPath ? options.scriptPath : DEFAULT_SCRIPT_PATH;
  const scriptSource = options && options.scriptSource ? options.scriptSource : readUserscriptSource(scriptPath);
  const meta = extractUserscriptMetadata(scriptSource);

  if (!meta.name) {
    throw new Error('Unable to determine userscript name from source.');
  }

  navigateActiveChromeTab('chrome-extension://dhdgffkkebhmkfjojejmpbldmpobfkfo/options.html#nav=utilities');
  executeLargeJavaScriptInActiveChromeTab(`(()=>{
    const textarea = document.getElementById('textarea_dXRpbHNfdXRpbHM_ta');
    if (!textarea) throw new Error('Tampermonkey import textarea not found');
    textarea.value = ${JSON.stringify(scriptSource)};
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    const button = document.getElementById('input_dXRpbHNfdXRpbHNfaV90YQ_bu');
    if (!button) throw new Error('Tampermonkey import button not found');
    button.click();
    return 'import-clicked';
  })();`, 24000);

  waitForActiveChromeJavaScriptValue(`({
    href: location.href,
    title: document.title,
    bodyText: document.body ? document.body.innerText : ''
  })`, {
    timeoutMs: 15000,
    description: 'Tampermonkey reinstall confirmation',
    predicate(value) {
      return Boolean(
        value &&
        typeof value.href === 'string' &&
        value.href.includes('/ask.html') &&
        typeof value.bodyText === 'string' &&
        /重新安装|更新用户脚本|Reinstall|Install|Update/i.test(value.bodyText)
      );
    },
  });

  const reinstallClick = clickActiveChromeElementByText(/重新安装|更新|确认|Reinstall|Install|Update|Confirm/i, {
    exclude: /取消|Cancel|禁用|Disable/i,
    selector: 'input, button',
  });
  if (reinstallClick === 'not-found') {
    throw new Error('Tampermonkey reinstall confirmation button not found.');
  }

  const editorPage = openTampermonkeyScriptEditorInActiveChrome(meta.name);
  if (meta.version && !(editorPage && editorPage.text && editorPage.text.includes(meta.version))) {
    throw new Error(`Tampermonkey editor did not show expected version ${meta.version}.`);
  }

  // Ensure the script is enabled after reinstall — the Tampermonkey import
  // flow sometimes leaves the script in a disabled state.
  navigateActiveChromeTab('chrome-extension://dhdgffkkebhmkfjojejmpbldmpobfkfo/options.html#nav=scripts');
  waitForActiveChromeJavaScriptValue(`({
    readyState: document.readyState,
    href: location.href
  })`, {
    timeoutMs: 10000,
    description: 'Tampermonkey scripts list to load',
    predicate(value) {
      return Boolean(value && value.readyState === 'complete' && String(value.href || '').includes('options.html'));
    },
  });
  const escapedScriptName = JSON.stringify(String(meta.name || ''));
  const enableResult = executeLargeJavaScriptInActiveChromeTab(`(()=>{
    const rows = Array.from(document.querySelectorAll('tr.scripttr'));
    const target = rows.find((row) => String(row.innerText || '').includes(${escapedScriptName}));
    if (!target) return 'not-found';
    const cb = target.querySelector('input[type="checkbox"]');
    if (cb && !cb.checked) { cb.click(); return 'enabled'; }
    return 'already-enabled';
  })();`, 10000);
  console.log('[feishu-helper-profile-runner] script-enable:', enableResult);

  return {
    name: meta.name,
    version: meta.version,
    editorUrl: editorPage.href,
  };
}

function runPageScriptInCurrentActiveChrome(options) {
  const pageScript = readConfiguredPageScript(options);
  const injectScript = options && options.injectScript ? String(options.injectScript) : '';

  if (!pageScript) {
    throw new Error('A page script is required. Use --page-script or --page-script-file.');
  }

  ensureInjectedScriptOnActiveChrome(injectScript);

  executeLargeJavaScriptInActiveChromeTab(`(()=>{
    window.__tampermonkeyPageScriptStatus = { status: 'running' };
    ${buildAsyncPageScriptRunnerSource(pageScript)}
    const finish = (value) => {
      window.__tampermonkeyPageScriptStatus = value;
    };

    (async () => {
      try {
        const result = await pageRunner(window, document);
        finish({ status: 'done', result: result == null ? null : result });
      } catch (error) {
        finish({ status: 'error', error: summarizeError(error) });
      }
    })();

    return 'started';
  })();`, 24000);

  const result = waitForActiveChromeJavaScriptValue('window.__tampermonkeyPageScriptStatus || null', {
    timeoutMs: 45000,
    intervalMs: 300,
    description: 'configured page script to finish',
    predicate(value) {
      return Boolean(value && (value.status === 'done' || value.status === 'error'));
    },
  });

  if (result.status === 'error') {
    throw new Error(result.error || 'Unknown configured page script failure.');
  }

  return result.result;
}

function waitForFeishuEditorReadyInActiveChrome(targetUrl, options) {
  const config = options || {};
  return waitForActiveChromeJavaScriptValue(`(()=>{
    const raw = document.documentElement.getAttribute('data-feishu-editor-ready-state');
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  })()`, {
    timeoutMs: Number(config.timeoutMs || 20000),
    intervalMs: Number(config.intervalMs || 300),
    description: config.description || 'Feishu editor API to be ready',
    predicate(value) {
      if (!value || value.__error) return false;
      if (value.href !== targetUrl) return false;
      if (value.readyState !== 'complete') return false;
      // Accept as ready when either:
      // 1. Full struct API is available (React fiber path), or
      // 2. Content root exists with loaded content (fallback path for newer Feishu builds)
      const hasFullAPI = value.hasContentRoot && value.hasEditorAPI && value.hasStructService && value.hasRootBlock;
      const hasLoadedContent = value.hasContentRoot && value.hasContentLoaded;
      return hasFullAPI || hasLoadedContent;
    },
  });
}

function runConfiguredPageScriptInActiveChrome(options) {
  const targetUrl = options && options.url ? String(options.url) : '';
  const allowReload = !(options && options.reload === false);

  if (!targetUrl) {
    throw new Error('A target URL is required for configured page actions.');
  }

  const currentUrl = getActiveChromeTabUrl();
  if (currentUrl !== targetUrl) {
    navigateActiveChromeTab(targetUrl);
  } else if (allowReload) {
    reloadActiveChromeTab();
  }

  waitForActiveChromeJavaScriptValue(`({
    readyState: document.readyState,
    href: location.href
  })`, {
    timeoutMs: 20000,
    description: 'target page to finish loading for configured page script',
    predicate(value) {
      return Boolean(value && value.readyState === 'complete' && value.href === targetUrl);
    },
  });

  const injectScript = options && options.injectScript ? String(options.injectScript) : '';
  ensureInjectedScriptOnActiveChrome(injectScript);

  if (options && options.waitForFeishuEditor) {
    try {
      waitForFeishuEditorReadyInActiveChrome(targetUrl, {
        timeoutMs: options.editorReadyTimeoutMs,
        description: 'Feishu editor API to be ready for configured page script',
      });
    } catch (error) {
      console.warn('[feishu-helper-profile-runner] editor-ready warning:', error && error.message ? error.message : error);
    }
  }

  return runPageScriptInCurrentActiveChrome(options);
}

function triggerNativePasteInActiveChrome() {
  runAppleScriptLines([
    'tell application "Google Chrome" to activate',
    'tell application "System Events" to keystroke "v" using command down',
  ]);
  return {
    shortcut: 'Cmd+V',
  };
}

function triggerShortcutInActiveChrome(key) {
  const shortcutKey = String(key || '').toLowerCase();
  if (!shortcutKey) {
    throw new Error('A shortcut key is required.');
  }
  runAppleScriptLines([
    'tell application "Google Chrome" to activate',
    `tell application "System Events" to keystroke "${escapeAppleScriptString(shortcutKey)}" using {command down, shift down}`,
  ]);
  return {
    shortcut: `Cmd+Shift+${shortcutKey.toUpperCase()}`,
  };
}

function compareValidationSnapshots(sourceSnapshot, targetSnapshot) {
  const source = sourceSnapshot || {};
  const target = targetSnapshot || {};
  const mismatches = [];

  const pushMismatch = (field, sourceValue, targetValue) => {
    if (JSON.stringify(sourceValue) === JSON.stringify(targetValue)) return;
    mismatches.push({
      field,
      source: sourceValue,
      target: targetValue,
    });
  };

  pushMismatch('blockCount', Number(source.blockCount || 0), Number(target.blockCount || 0));
  pushMismatch('equationCount', Number(source.equationCount || 0), Number(target.equationCount || 0));
  pushMismatch('text', String(source.text || '').trim(), String(target.text || '').trim());

  const sourceStyleSummary = source.styleSummary || {};
  const targetStyleSummary = target.styleSummary || {};
  pushMismatch('styleSummary.blockCount', Number(sourceStyleSummary.blockCount || 0), Number(targetStyleSummary.blockCount || 0));

  const sourceCounts = sourceStyleSummary.countsByType || {};
  const targetCounts = targetStyleSummary.countsByType || {};
  const allTypes = Array.from(new Set([...Object.keys(sourceCounts), ...Object.keys(targetCounts)])).sort();
  for (const type of allTypes) {
    pushMismatch(`styleSummary.countsByType.${type}`, Number(sourceCounts[type] || 0), Number(targetCounts[type] || 0));
  }

  const sourceBlocks = Array.isArray(sourceStyleSummary.blocks) ? sourceStyleSummary.blocks : [];
  const targetBlocks = Array.isArray(targetStyleSummary.blocks) ? targetStyleSummary.blocks : [];
  const maxBlockCount = Math.max(sourceBlocks.length, targetBlocks.length);
  for (let index = 0; index < maxBlockCount; index++) {
    pushMismatch(`styleSummary.blocks[${index}]`, sourceBlocks[index] || null, targetBlocks[index] || null);
  }

  return {
    ok: mismatches.length === 0,
    mismatchCount: mismatches.length,
    mismatches,
  };
}

function waitForSourceImageConversionInActiveChrome(sourceUrl) {
  // Use DOM attributes (shared across Chrome isolated worlds).
  const result = waitForActiveChromeJavaScriptValue(`(()=>{
    const raw = document.documentElement.getAttribute('data-feishu-img-conv-status');
    const status = raw ? JSON.parse(raw) : null;
    return {
      href: location.href,
      status: status
    };
  })()`, {
    timeoutMs: 30000,
    intervalMs: 500,
    description: 'source image conversion to finish',
    predicate(value) {
      if (!value || value.__error) return false;
      if (value.href !== sourceUrl) return false;
      const status = value.status;
      const state = status && status.state ? String(status.state) : '';
      const done = Number(status && typeof status.done !== 'undefined' ? status.done : 0);
      const total = Number(status && typeof status.total !== 'undefined' ? status.total : 0);
      const updatedAt = Number(status && status.updatedAt ? status.updatedAt : 0);
      if (!state || updatedAt <= 0) return false;
      if (state === 'no-images' || state === 'error') return true;
      if (state !== 'done') return false;
      return done >= total;
    },
  });

  const status = result && result.status ? result.status : null;
  const state = status && status.state ? String(status.state) : '';
  if (state === 'error') {
    const reason = status && status.error ? String(status.error) : 'Unknown image conversion error';
    throw new Error(`Source image conversion failed: ${reason}`);
  }
  return result;
}

function summarizeSourceExtractionForLog(extraction) {
  if (!extraction || typeof extraction !== 'object') return extraction || null;
  return {
    title: extraction.title || '',
    blockCount: Number(extraction.blockCount || 0),
    equationCount: Number(extraction.equationCount || 0),
    imageCount: Number(extraction.imageCount || 0),
    inlinedImageCount: Number(extraction.inlinedImageCount || 0),
    textLen: Number(extraction.textLen || 0),
    htmlLen: Number(extraction.htmlLen || 0),
    clipboardHtmlLen: Number(extraction.clipboardHtmlLen || 0),
    payloadError: Boolean(extraction.payloadError),
    extractionDebug: extraction.extractionDebug || null,
    validationSnapshot: extraction.validationSnapshot ? {
      title: extraction.validationSnapshot.title || '',
      blockCount: Number(extraction.validationSnapshot.blockCount || 0),
      equationCount: Number(extraction.validationSnapshot.equationCount || 0),
      textLength: Number(extraction.validationSnapshot.textLength || 0),
      htmlLength: Number(extraction.validationSnapshot.htmlLength || 0),
      extractionDebug: extraction.validationSnapshot.extractionDebug || null,
      styleSummary: extraction.validationSnapshot.styleSummary ? {
        blockCount: Number(extraction.validationSnapshot.styleSummary.blockCount || 0),
        countsByType: extraction.validationSnapshot.styleSummary.countsByType || {},
      } : null,
    } : null,
    pendingPaste: extraction.pendingPaste || null,
  };
}

function openActiveChromeUrlForShortcut(url, options) {
  const targetUrl = String(url || '');
  const allowReload = Boolean(options && options.reload);
  if (!targetUrl) {
    throw new Error('A target URL is required.');
  }
  const currentUrl = getActiveChromeTabUrl();
  if (currentUrl !== targetUrl) {
    navigateActiveChromeTab(targetUrl);
  } else if (allowReload) {
    reloadActiveChromeTab();
  }
  // Note: we do NOT wait for the page to finish loading here.
  // ensureInjectedScriptOnActiveChrome will reload the page if TM is
  // not detected, and that reload includes its own page-load wait.
  return targetUrl;
}

function focusFeishuEditorInActiveChrome(url, injectScript) {
  return runConfiguredPageScriptInActiveChrome({
    url,
    injectScript,
    reload: false,
    pageScript: `
      const editor = document.querySelector('[data-content-editable-root="true"], [contenteditable="true"], [role="textbox"]');
      const selectEditableText = (root) => {
        if (!root || !window.getSelection || !document.createRange) return false;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
          acceptNode(node) {
            return node && String(node.nodeValue || '').trim()
              ? NodeFilter.FILTER_ACCEPT
              : NodeFilter.FILTER_SKIP;
          },
        });
        const textNode = walker.nextNode();
        if (!textNode) return false;
        const range = document.createRange();
        range.setStart(textNode, 0);
        range.collapse(true);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return true;
      };
      if (editor && typeof editor.focus === 'function') {
        if (typeof editor.scrollIntoView === 'function') {
          editor.scrollIntoView({ block: 'center', inline: 'nearest' });
        }
        editor.focus();
        try { editor.click(); } catch (error) {}
        selectEditableText(editor);
      }
      return {
        focused: !!editor,
        tagName: editor ? String(editor.tagName || '') : '',
        activeTagName: document.activeElement ? String(document.activeElement.tagName || '') : '',
      };
    `,
  });
}

function readSourceExtractionStateInActiveChrome(url, injectScript) {
  return runConfiguredPageScriptInActiveChrome({
    url,
    injectScript,
    reload: false,
    pageScript: `
      const pendingTs = Number(document.documentElement.getAttribute('data-feishu-pending-paste-ts') || '0');
      const pendingPaste = pendingTs > 0 ? { ts: pendingTs } : null;
      const extractionResultRaw = document.documentElement.getAttribute('data-feishu-extraction-result');
      const extractionResult = extractionResultRaw ? (function() { try { return JSON.parse(extractionResultRaw); } catch(e) { return null; } })() : null;
      const snapshotRaw = document.documentElement.getAttribute('data-feishu-validation-snapshot');
      const validationSnapshot = snapshotRaw ? (function() { try { return JSON.parse(snapshotRaw); } catch(e) { return null; } })() : null;
      const debugTs = Number(document.documentElement.getAttribute('data-feishu-extraction-debug-ts') || '0');
      const extractionDebug = debugTs > 0 ? { ts: debugTs } : null;
      return {
        pendingPaste,
        validationSnapshot,
        extractionDebug,
        extractionResult,
      };
    `,
  });
}

function captureValidationSnapshotViaDOM() {
  // Trigger the TM script's captureValidationSnapshot() by dispatching a DOM
  // CustomEvent (which IS visible across Chrome isolated worlds), then read
  // the result from a DOM attribute.  This avoids calling
  // window.__feishuCaptureValidationSnapshot() which is NOT visible from
  // AppleScript's JS context.
  executeJavaScriptInActiveChromeTab(
    `document.dispatchEvent(new CustomEvent('feishu-capture-snapshot'))`
  );
  // Wait briefly for the async capture to complete and the DOM attribute to update.
  const result = waitForActiveChromeJavaScriptValue(`(()=>{
    const raw = document.documentElement.getAttribute('data-feishu-validation-snapshot');
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  })()`, {
    timeoutMs: 10000,
    intervalMs: 300,
    description: 'validation snapshot via DOM',
    predicate(value) {
      return value && value !== null && !value.__error;
    },
  });
  return result;
}

function triggerSourceExtractionByShortcutInActiveChrome(options) {
  const sourceUrl = options && options.url ? String(options.url) : '';
  const injectScript = options && options.injectScript ? String(options.injectScript) : '';
  openActiveChromeUrlForShortcut(sourceUrl, { reload: false });
  ensureInjectedScriptOnActiveChrome(injectScript);

  try {
    waitForFeishuEditorReadyInActiveChrome(sourceUrl, {
      description: 'Feishu editor API to be ready for source extraction',
    });
  } catch (error) {
    console.warn('[feishu-helper-profile-runner] source-editor-ready warning:', error && error.message ? error.message : error);
  }

  // Read the baseline pending paste timestamp before triggering.
  // Use DOM attributes (shared across Chrome isolated worlds) instead of
  // window.__feishu* variables (which are NOT shared).
  const beforePendingTs = Number(executeJavaScriptInActiveChromeTab(
    `document.documentElement.getAttribute('data-feishu-pending-paste-ts') || '0'`
  ) || 0);
  const beforeDebugTs = Number(executeJavaScriptInActiveChromeTab(
    `document.documentElement.getAttribute('data-feishu-extraction-debug-ts') || '0'`
  ) || 0);

  // Focus the editor so the keyboard shortcut is received by the page.
  focusFeishuEditorInActiveChrome(sourceUrl, injectScript);

  // Use the real Cmd+Shift+D keyboard shortcut instead of calling
  // window.__feishuDuplicateDoc() via AppleScript JS. The AppleScript
  // JS context cannot see React fiber properties, so calling the
  // function directly would use the wrong (AppleScript-injected) closure
  // and always fall back to dom-fallback mode. The real keyboard shortcut
  // triggers the Tampermonkey-injected handler which has full React access.
  triggerShortcutInActiveChrome('d');

  // Use DOM attributes (shared across Chrome isolated worlds) instead of
  // window.__feishu* variables (which are NOT shared across contexts).
  waitForActiveChromeJavaScriptValue(`(()=>{
    const pendingTs = document.documentElement.getAttribute('data-feishu-pending-paste-ts') || '0';
    const debugTs = document.documentElement.getAttribute('data-feishu-extraction-debug-ts') || '0';
    const extractionResult = document.documentElement.getAttribute('data-feishu-extraction-result');
    return {
      href: location.href,
      pendingTs: Number(pendingTs || 0),
      debugTs: Number(debugTs || 0),
      hasExtractionResult: extractionResult !== null
    };
  })()`, {
    timeoutMs: 45000,
    intervalMs: 400,
    description: 'source shortcut extraction to finish',
    predicate(value) {
      if (!value || value.__error) return false;
      if (value.href !== sourceUrl) return false;
      // Prefer hasExtractionResult as the definitive completion signal.
      // Fall back to pendingTs change for cases where extraction fails
      // before writing the result DOM attribute.
      if (value.hasExtractionResult) return true;
      // Only accept pendingTs change as a fallback after a reasonable
      // delay (the extraction result should be written very quickly
      // after pendingTs changes, within the 400ms polling interval).
      if (value.pendingTs > beforePendingTs && value.debugTs > beforeDebugTs) return true;
      return false;
    },
  });
  const afterState = readSourceExtractionStateInActiveChrome(sourceUrl, injectScript) || {};
  const extractionResult = afterState.extractionResult || null;
  const validationSnapshot = afterState.validationSnapshot || null;
  const pendingPaste = afterState.pendingPaste || null;
  const extractionDebug = afterState.extractionDebug || null;
  // Prefer extractionResult for image/block counts (written by TM after
  // duplicateDocumentForAutomation completes), fall back to validationSnapshot.
  const imageCount = extractionResult
    ? Number(extractionResult.imageCount || 0)
    : Number(validationSnapshot && validationSnapshot.extractionDebug
      ? Number(validationSnapshot.extractionDebug.fallbackHtmlImageCount || validationSnapshot.extractionDebug.htmlImageCount || 0)
      : 0);
  return {
    shortcut: { shortcut: 'Cmd+Shift+D' },
    title: extractionResult && extractionResult.title ? extractionResult.title : (validationSnapshot && validationSnapshot.title ? validationSnapshot.title : (pendingPaste && pendingPaste.title ? pendingPaste.title : '')),
    blockCount: Number(extractionResult && extractionResult.blockCount ? extractionResult.blockCount : (validationSnapshot && validationSnapshot.blockCount ? validationSnapshot.blockCount : 0)),
    equationCount: Number(extractionResult && extractionResult.equationCount ? extractionResult.equationCount : (validationSnapshot && validationSnapshot.equationCount ? validationSnapshot.equationCount : 0)),
    imageCount,
    inlinedImageCount: Number(extractionResult && extractionResult.inlinedImageCount ? extractionResult.inlinedImageCount : ((pendingPaste && pendingPaste.clipboardHtmlLen ? pendingPaste.clipboardHtmlLen : 0) > 0 ? imageCount : 0)),
    textLen: Number(extractionResult && extractionResult.textLen ? extractionResult.textLen : (validationSnapshot && validationSnapshot.textLength ? validationSnapshot.textLength : (pendingPaste && pendingPaste.textLen ? pendingPaste.textLen : 0))),
    htmlLen: Number(extractionResult && extractionResult.htmlLen ? extractionResult.htmlLen : (validationSnapshot && validationSnapshot.htmlLength ? validationSnapshot.htmlLength : (pendingPaste && pendingPaste.htmlLen ? pendingPaste.htmlLen : 0))),
    clipboardHtmlLen: Number(extractionResult && extractionResult.clipboardHtmlLen ? extractionResult.clipboardHtmlLen : (pendingPaste && pendingPaste.clipboardHtmlLen ? pendingPaste.clipboardHtmlLen : 0)),
    payloadError: extractionResult ? Boolean(extractionResult.payloadError) : false,
    extractionDebug,
    validationSnapshot,
    pendingPaste,
  };
}

function triggerTargetPasteByShortcutInActiveChrome(options) {
  const targetUrl = options && options.url ? String(options.url) : '';
  const injectScript = options && options.injectScript ? String(options.injectScript) : '';
  openActiveChromeUrlForShortcut(targetUrl, { reload: false });
  ensureInjectedScriptOnActiveChrome(injectScript);
  focusFeishuEditorInActiveChrome(targetUrl, injectScript);
  // Use the real Cmd+Shift+P keyboard shortcut instead of calling
  // window.__feishuPasteIntoDoc() via AppleScript JS, for the same reason
  // as triggerSourceExtractionByShortcutInActiveChrome uses Cmd+Shift+D.
  triggerShortcutInActiveChrome('p');
  return { triggered: 'Cmd+Shift+P' };
}

function runNativePasteValidationInActiveChrome(options) {
  const sourceUrl = options && options.sourceUrl ? String(options.sourceUrl) : '';
  const targetUrl = options && options.targetUrl ? String(options.targetUrl) : '';
  const expectedVersion = options && options.expectedVersion ? String(options.expectedVersion) : '';
  const preferredProbeFunction = options && options.probeFunction ? String(options.probeFunction) : DEFAULT_PROBE_FUNCTION;
  const injectScript = options && options.injectScript ? String(options.injectScript) : '';
  const waitForSourceImageConversion = typeof waitForSourceImageConversionInActiveChrome === 'function'
    ? waitForSourceImageConversionInActiveChrome
    : function (currentSourceUrl) {
      const result = waitForActiveChromeJavaScriptValue(`(()=>{
        const raw = document.documentElement.getAttribute('data-feishu-img-conv-status');
        const status = raw ? (function() { try { return JSON.parse(raw); } catch(e) { return null; } })() : null;
        return {
          href: location.href,
          status: status
        };
      })()`, {
        timeoutMs: 30000,
        intervalMs: 500,
        description: 'source image conversion to finish',
        predicate(value) {
          if (!value || value.__error) return false;
          if (value.href !== currentSourceUrl) return false;
          const status = value.status;
          const state = status && status.state ? String(status.state) : '';
          const done = Number(status && typeof status.done !== 'undefined' ? status.done : 0);
          const total = Number(status && typeof status.total !== 'undefined' ? status.total : 0);
          const updatedAt = Number(status && status.updatedAt ? status.updatedAt : 0);
          if (!state || updatedAt <= 0) return false;
          if (state === 'no-images' || state === 'error') return true;
          if (state !== 'done') return false;
          return done >= total;
        },
      });

      const status = result && result.status ? result.status : null;
      const state = status && status.state ? String(status.state) : '';
      if (state === 'error') {
        const reason = status && status.error ? String(status.error) : 'Unknown image conversion error';
        throw new Error(`Source image conversion failed: ${reason}`);
      }
      return result;
    };

  if (!sourceUrl) {
    throw new Error('A source URL is required for native paste validation.');
  }
  if (!targetUrl) {
    throw new Error('A target URL is required for native paste validation.');
  }

  const extraction = triggerSourceExtractionByShortcutInActiveChrome({
    url: sourceUrl,
    injectScript,
    expectedVersion,
    probeFunction: preferredProbeFunction,
  });
  console.log('[feishu-helper-profile-runner] source-extraction:', JSON.stringify(summarizeSourceExtractionForLog(extraction), null, 2));

  const sourceImageConversion = waitForSourceImageConversion(sourceUrl);

  const sourceSnapshot = extraction && extraction.validationSnapshot
    ? extraction.validationSnapshot
    : captureValidationSnapshotViaDOM();

  const targetBeforeSnapshot = captureValidationSnapshotViaDOM();

  const targetPreparation = focusFeishuEditorInActiveChrome(targetUrl, injectScript);
  const nativePaste = triggerTargetPasteByShortcutInActiveChrome({
    url: targetUrl,
    injectScript,
  });
  const baselineSnapshotSignature = JSON.stringify(targetBeforeSnapshot || null);
  waitForActiveChromeJavaScriptValue(`(()=>{
    document.dispatchEvent(new CustomEvent('feishu-capture-snapshot'));
    const raw = document.documentElement.getAttribute('data-feishu-validation-snapshot');
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  })()`, {
    timeoutMs: 15000,
    intervalMs: 400,
    description: 'native paste result to stabilize',
    predicate(value) {
      if (!value || value.__error) return false;
      return JSON.stringify(value) !== baselineSnapshotSignature;
    },
  });

  const targetSnapshot = captureValidationSnapshotViaDOM();

  const diff = compareValidationSnapshots(sourceSnapshot, targetSnapshot);
  return {
    sourceUrl,
    targetUrl,
    extraction,
    sourceImageConversion,
    targetPreparation,
    nativePaste,
    sourceSnapshot,
    targetSnapshot,
    diff,
  };
}

function runTampermonkeyAutomationActionInActiveChrome(options) {
  const targetUrl = options && options.url ? String(options.url) : '';
  const expectedVersion = options && options.expectedVersion ? String(options.expectedVersion) : '';
  const preferredProbeFunction = options && options.probeFunction ? String(options.probeFunction) : DEFAULT_PROBE_FUNCTION;
  const explicitAction = options && options.action ? String(options.action) : '';
  const realTest = Boolean(options && options.realTest);
  const injectScript = options && options.injectScript ? String(options.injectScript) : '';

  if (!targetUrl) {
    throw new Error('A target URL is required for Tampermonkey automation testing.');
  }

  const currentUrl = getActiveChromeTabUrl();
  if (currentUrl !== targetUrl) {
    navigateActiveChromeTab(targetUrl);
  } else {
    reloadActiveChromeTab();
  }

  waitForActiveChromeJavaScriptValue(`({
    readyState: document.readyState,
    href: location.href,
    title: document.title
  })`, {
    timeoutMs: 20000,
    description: 'target page to finish loading',
    predicate(value) {
      return Boolean(
        value &&
        value.readyState === 'complete' &&
        value.href === targetUrl
      );
    },
  });

  ensureInjectedScriptOnActiveChrome(injectScript);
  try {
    waitForFeishuEditorReadyInActiveChrome(targetUrl, {
      description: 'Feishu editor API to be ready for automation',
    });
  } catch (error) {
    console.warn('[feishu-helper-profile-runner] editor-ready warning:', error && error.message ? error.message : error);
  }

  executeLargeJavaScriptInActiveChromeTab(`(()=>{
    window.__tampermonkeyAutomationStatus = { status: 'running' };
    const summarizeError = (error) => String(error && error.stack ? error.stack : error);
    const probeFunctionNames = ${JSON.stringify(buildProbeFunctionCandidates(preferredProbeFunction))};
    const resolveAutomationAction = ${resolveAutomationAction.toString()};

    const finish = (value) => {
      window.__tampermonkeyAutomationStatus = value;
    };

    const readProbe = () => {
      for (const fnName of probeFunctionNames) {
        const probeFn = fnName && typeof window[fnName] === 'function' ? window[fnName] : null;
        if (!probeFn) continue;
        const probe = probeFn();
        if (probe && typeof probe === 'object') {
          return {
            functionName: fnName,
            probe,
          };
        }
      }
      return null;
    };

    try {
      const probeInfo = readProbe();
      if (!probeInfo || !probeInfo.probe || !probeInfo.probe.version) {
        throw new Error('Userscript debug exports are unavailable.');
      }

      const probe = probeInfo.probe;
      if (${JSON.stringify(expectedVersion)} && probe.version !== ${JSON.stringify(expectedVersion)}) {
        throw new Error('Loaded script version mismatch: expected ' + ${JSON.stringify(expectedVersion)} + ', got ' + probe.version);
      }

      const automation = probe.automation || {};
      const requestEvent = String(automation.requestEvent || '');
      const resultEvent = String(automation.resultEvent || '');
      const exportsInfo = probe.exports || {};
      const hasDirectAutomation = exportsInfo.runAutomationAction === 'function' && typeof window.__feishuRunAutomationAction === 'function';
      const action = resolveAutomationAction({
        explicitAction: ${JSON.stringify(explicitAction)},
        realTest: ${realTest ? 'true' : 'false'},
        automation,
      });

      if (!action) {
        throw new Error('Userscript automation contract is unavailable.');
      }

      if (!hasDirectAutomation && (!requestEvent || !resultEvent)) {
        throw new Error('Userscript automation contract is unavailable.');
      }

      if (hasDirectAutomation) {
        Promise.resolve(window.__feishuRunAutomationAction({ action }))
          .then((summary) => {
            finish({
              status: 'done',
              action,
              result: {
                probeFunction: probeInfo.functionName,
                probeVersion: probe.version,
                detail: {
                  status: 'success',
                  summary,
                  direct: true,
                },
              },
            });
          })
          .catch((error) => {
            finish({ status: 'error', error: summarizeError(error) });
          });
        return 'started';
      }

      const requestId = 'tm-action-' + Date.now() + '-' + Math.random().toString(36).slice(2);

      const onAutomationResult = (event) => {
      const detail = event && event.detail ? event.detail : null;
      if (!detail || detail.requestId !== requestId) return;
      window.removeEventListener(resultEvent, onAutomationResult, true);

      try {
        if (detail.status !== 'success') {
          throw new Error(detail.error || 'Automation bridge request failed.');
        }
        finish({
          status: 'done',
          action,
          result: {
            probeFunction: probeInfo.functionName,
            probeVersion: probe.version,
            detail,
          },
        });
      } catch (error) {
        finish({ status: 'error', error: summarizeError(error) });
      }
      };

      window.addEventListener(resultEvent, onAutomationResult, true);
      window.dispatchEvent(new CustomEvent(requestEvent, {
      detail: {
        requestId,
        action,
      },
      }));

      setTimeout(() => {
        if (window.__tampermonkeyAutomationStatus && window.__tampermonkeyAutomationStatus.status === 'running') {
          window.removeEventListener(resultEvent, onAutomationResult, true);
          finish({ status: 'error', error: 'Timed out waiting for automation bridge result.' });
        }
      }, 45000);

      return 'started';
    } catch (error) {
      finish({ status: 'error', error: summarizeError(error) });
      return 'error';
    }
  })();`, 24000);

  const result = waitForActiveChromeJavaScriptValue('window.__tampermonkeyAutomationStatus || null', {
    timeoutMs: 45000,
    intervalMs: 300,
    description: 'Tampermonkey automation action to finish',
    predicate(value) {
      return Boolean(value && (value.status === 'done' || value.status === 'error'));
    },
  });

  if (result.status === 'error') {
    throw new Error(result.error || 'Unknown real test failure.');
  }

  const detail = result.result && result.result.detail ? result.result.detail : null;
  return detail && detail.summary ? detail.summary : (detail || result.result || result);
}

function runTampermonkeyRealTestInActiveChrome(options) {
  return runTampermonkeyAutomationActionInActiveChrome({ ...options, realTest: true });
}

function probeActiveChromeTab(options) {
  const probeFunctionNames = buildProbeFunctionCandidates(options && options.probeFunction ? options.probeFunction : DEFAULT_PROBE_FUNCTION);
  const raw = executeJavaScriptInActiveChromeTab(`JSON.stringify((()=>{
    const probeFunctionNames = ${JSON.stringify(probeFunctionNames)};
    for (const fnName of probeFunctionNames) {
      if (fnName && typeof window[fnName] === 'function') {
        return {
          url: window.location.href,
          probeFunction: fnName,
          probe: window[fnName](),
          error: window.__feishuDebugProbeError || null,
        };
      }
    }
    return {
      url: window.location.href,
      probeFunction: null,
      probe: null,
      error: window.__feishuDebugProbeError || null,
    };
  })())`);
  return raw ? JSON.parse(raw) : null;
}

function attachToActiveChrome(options) {
  const targetUrl = options && options.url ? String(options.url) : '';
  if (targetUrl && getActiveChromeTabUrl() !== targetUrl) {
    navigateActiveChromeTab(targetUrl);
  }

  injectScriptIntoActiveChromeTab(options && options.injectScript ? options.injectScript : '');
  return probeActiveChromeTab(options);
}

function decryptChromiumCookieValue(encryptedValue, options) {
  if (!encryptedValue) return '';

  const hostKey = options && options.hostKey ? String(options.hostKey) : '';
  const safeStoragePassword = options && options.safeStoragePassword ? String(options.safeStoragePassword) : '';
  const buffer = Buffer.from(encryptedValue);
  const prefix = buffer.subarray(0, 3).toString('utf8');

  if (prefix !== 'v10' && prefix !== 'v11') {
    return buffer.toString('utf8');
  }

  const key = deriveChromeSafeStorageKey(safeStoragePassword);
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '));
  let decrypted = Buffer.concat([decipher.update(buffer.subarray(3)), decipher.final()]);

  if (hostKey && decrypted.length > 32) {
    const hostDigest = crypto.createHash('sha256').update(hostKey).digest();
    if (decrypted.subarray(0, 32).equals(hostDigest)) {
      decrypted = decrypted.subarray(32);
    }
  }

  return decrypted.toString('utf8');
}

function buildChromeUserDataDir(homePath) {
  return join(homePath || homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
}

function readJsonFile(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

function detectChromeProfileDirectory(localState) {
  const profile = localState && localState.profile ? localState.profile : {};
  if (Array.isArray(profile.last_active_profiles) && profile.last_active_profiles[0]) {
    return profile.last_active_profiles[0];
  }
  if (Array.isArray(profile.profiles_order) && profile.profiles_order[0]) {
    return profile.profiles_order[0];
  }
  return 'Default';
}

function detectDefaultChromeUserDataDir() {
  const defaultPath = buildChromeUserDataDir();
  if (existsSync(defaultPath)) return defaultPath;
  return '';
}

function getChromeSafeStoragePassword() {
  return execFileSync('security', ['find-generic-password', '-w', '-s', CHROME_SAFE_STORAGE_SERVICE], {
    encoding: 'utf8',
  }).trim();
}

function buildCookieDomainWhereClause(domainSuffixes) {
  const suffixes = (domainSuffixes || []).filter(Boolean);
  if (!suffixes.length) return {
    clause: '1 = 1',
    params: [],
  };

  return {
    clause: suffixes.map(() => 'host_key LIKE ?').join(' OR '),
    params: suffixes.map((suffix) => '%' + suffix),
  };
}

function loadChromeCookiesFromProfile(options) {
  const userDataDir = resolve(options.userDataDir);
  const profileDirectory = options.profileDirectory || 'Default';
  const cookiesPath = join(userDataDir, profileDirectory, 'Cookies');

  if (!existsSync(cookiesPath)) return [];

  const safeStoragePassword = options.safeStoragePassword || getChromeSafeStoragePassword();
  const { clause, params } = buildCookieDomainWhereClause(options.domainSuffixes || COOKIE_DOMAIN_SUFFIXES);
  const database = new DatabaseSync(cookiesPath, { readonly: true });

  try {
    const rows = database.prepare(`
      SELECT host_key, name, value, encrypted_value, path, CAST(expires_utc AS TEXT) AS expires_utc_text, is_secure, is_httponly
      FROM cookies
      WHERE ${clause}
    `).all(...params);

    return rows.map((row) => {
      const encryptedValue = row.encrypted_value ? Buffer.from(row.encrypted_value) : null;
      const value = row.value || decryptChromiumCookieValue(encryptedValue, {
        hostKey: row.host_key,
        safeStoragePassword,
      });
      const expires = chromiumTimeToUnixSeconds(row.expires_utc_text);

      return {
        name: row.name,
        value,
        domain: row.host_key,
        path: row.path || '/',
        secure: Boolean(row.is_secure),
        httpOnly: Boolean(row.is_httponly),
        ...(expires ? { expires } : {}),
      };
    }).filter((cookie) => cookie.value);
  } finally {
    database.close();
  }
}

async function restoreChromeProfileCookies(context, options) {
  const cookies = loadChromeCookiesFromProfile(options);
  if (!cookies.length) return 0;
  await context.addCookies(cookies);
  return cookies.length;
}

function cloneProfileToTempUserDataDir(options) {
  const userDataDir = resolve(options.userDataDir);
  const profileDirectory = options.profileDirectory || 'Default';
  const clonedUserDataDir = mkdtempSync(join(tmpdir(), 'feishu-helper-chrome-'));
  const localStatePath = join(userDataDir, 'Local State');
  const profilePath = join(userDataDir, profileDirectory);

  if (!existsSync(profilePath)) {
    throw new Error('Chrome profile directory not found: ' + profilePath);
  }

  if (existsSync(localStatePath)) {
    cpSync(localStatePath, join(clonedUserDataDir, 'Local State'));
  }
  cpSync(profilePath, join(clonedUserDataDir, profileDirectory), {
    recursive: true,
    force: true,
  });

  return {
    userDataDir: clonedUserDataDir,
    cleanup() {
      rmSync(clonedUserDataDir, { recursive: true, force: true });
    },
  };
}

async function launchInjectedPersistentContext(options) {
  const {
    userDataDir,
    injectScript,
    url,
    headless = false,
    channel,
    profileDirectory,
    onContextReady,
  } = options || {};

  if (!userDataDir) throw new Error('userDataDir is required');
  if (!injectScript) throw new Error('injectScript is required');

  const launchOptions = {
    headless,
    viewport: DEFAULT_VIEWPORT,
  };

  if (channel) launchOptions.channel = channel;
  if (profileDirectory) {
    launchOptions.args = ['--profile-directory=' + profileDirectory];
  }

  const context = await chromium.launchPersistentContext(userDataDir, launchOptions);
  await context.addInitScript({ content: injectScript });
  if (typeof onContextReady === 'function') {
    await onContextReady(context);
  }

  let page = await context.newPage();
  if (url) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  }

  return { context, page };
}

async function executeConfiguredPageScriptInPage(page, options) {
  const pageScript = readConfiguredPageScript(options);
  if (!pageScript) return null;

  return page.evaluate(async (scriptSource) => {
    const pageRunner = new Function('window', 'document', 'return (async () => {\n' + scriptSource + '\n})();');
    return pageRunner(window, document);
  }, pageScript);
}

async function probeInjectedScript(page, options) {
  const probeFunctionNames = buildProbeFunctionCandidates(options && options.probeFunction ? options.probeFunction : DEFAULT_PROBE_FUNCTION);
  return page.evaluate((fnNames) => {
    for (const fnName of fnNames) {
      if (fnName && typeof window[fnName] === 'function') {
        return window[fnName]();
      }
    }
    return null;
  }, probeFunctionNames);
}

function assertProbeLoaded(probe, options) {
  const expectedVersion = options && options.expectedVersion ? String(options.expectedVersion) : '';
  if (!probe || !probe.version || !probe.exports || typeof probe.exports !== 'object') {
    throw new Error('Userscript was not injected successfully.');
  }
  if (expectedVersion && probe.version !== expectedVersion) {
    throw new Error(`Userscript version mismatch: expected ${expectedVersion}, got ${probe.version}.`);
  }

  return probe;
}

function parseBooleanFlag(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return !/^(0|false|no)$/i.test(String(value));
}

function parseCliArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;

    const eqIndex = arg.indexOf('=');
    if (eqIndex !== -1) {
      result[arg.slice(2, eqIndex)] = arg.slice(eqIndex + 1);
      continue;
    }

    const key = arg.slice(2);
    const next = argv[i + 1];
    if (BOOLEAN_FLAGS.has(key) || !next || next.startsWith('--')) {
      result[key] = 'true';
      continue;
    }

    result[key] = next;
    i++;
  }
  return result;
}

function findPositionalUrl(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg.startsWith('--')) {
      const eqIndex = arg.indexOf('=');
      if (eqIndex === -1) {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (!BOOLEAN_FLAGS.has(key) && next && !next.startsWith('--')) {
          i++;
        }
      }
      continue;
    }
    return arg;
  }
  return '';
}

function resolveRunnerOptions(argv, env) {
  const args = parseCliArgs(argv || []);
  const sourceEnv = env || process.env;
  const attachActiveChrome = parseBooleanFlag(args['attach-active-chrome'] || sourceEnv.TM_ATTACH_ACTIVE_CHROME || sourceEnv.FEISHU_ATTACH_ACTIVE_CHROME, false);
  const userDataDir = args['user-data-dir'] || sourceEnv.TM_USER_DATA_DIR || sourceEnv.FEISHU_USER_DATA_DIR || detectDefaultChromeUserDataDir();
  const localState = readJsonFile(join(resolve(userDataDir || '.'), 'Local State'));

  if (!attachActiveChrome && !userDataDir) {
    throw new Error('Missing user data dir. Use --user-data-dir or FEISHU_USER_DATA_DIR.');
  }

  return {
    userDataDir: userDataDir ? resolve(userDataDir) : '',
    scriptPath: resolve(args['script-path'] || sourceEnv.TM_SCRIPT_PATH || sourceEnv.FEISHU_SCRIPT_PATH || DEFAULT_SCRIPT_PATH),
    url: args.url || sourceEnv.TM_TARGET_URL || sourceEnv.FEISHU_TARGET_URL || findPositionalUrl(argv || []) || 'https://bytedance.feishu.cn/',
    headless: parseBooleanFlag(args.headless || sourceEnv.TM_HEADLESS || sourceEnv.FEISHU_HEADLESS, false),
    close: parseBooleanFlag(args.close || sourceEnv.TM_CLOSE || sourceEnv.FEISHU_CLOSE, false),
    attachActiveChrome,
    channel: args.channel || sourceEnv.TM_BROWSER_CHANNEL || sourceEnv.FEISHU_BROWSER_CHANNEL || 'chrome',
    profileDirectory: args['profile-directory'] || sourceEnv.TM_PROFILE_DIRECTORY || sourceEnv.FEISHU_PROFILE_DIRECTORY || detectChromeProfileDirectory(localState),
    cloneProfile: parseBooleanFlag(args['clone-profile'] || sourceEnv.TM_CLONE_PROFILE || sourceEnv.FEISHU_CLONE_PROFILE, true),
    syncTampermonkey: parseBooleanFlag(args['sync-tampermonkey'] || sourceEnv.TM_SYNC_TAMPERMONKEY || sourceEnv.FEISHU_SYNC_TAMPERMONKEY, false),
    realTest: parseBooleanFlag(args['real-test'] || sourceEnv.TM_REAL_TEST || sourceEnv.FEISHU_REAL_TEST, false),
    validateNativePaste: parseBooleanFlag(args['validate-native-paste'] || sourceEnv.TM_VALIDATE_NATIVE_PASTE || sourceEnv.FEISHU_VALIDATE_NATIVE_PASTE, false),
    probeFunction: args['probe-function'] || sourceEnv.TM_PROBE_FUNCTION || sourceEnv.FEISHU_PROBE_FUNCTION || DEFAULT_PROBE_FUNCTION,
    action: args.action || sourceEnv.TM_ACTION || sourceEnv.FEISHU_ACTION || '',
    pageScript: args['page-script'] || sourceEnv.TM_PAGE_SCRIPT || sourceEnv.FEISHU_PAGE_SCRIPT || '',
    pageScriptFile: args['page-script-file'] || sourceEnv.TM_PAGE_SCRIPT_FILE || sourceEnv.FEISHU_PAGE_SCRIPT_FILE || '',
    sourceUrl: args['source-url'] || sourceEnv.TM_SOURCE_URL || sourceEnv.FEISHU_SOURCE_URL || '',
    targetUrl: args['target-url'] || sourceEnv.TM_TARGET_URL || sourceEnv.FEISHU_TARGET_URL || '',
  };
}

function waitForInterrupt() {
  return new Promise((resolvePromise) => {
    const finish = () => resolvePromise();
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
  });
}

async function main() {
  const options = resolveRunnerOptions(process.argv.slice(2), process.env);
  const injectScript = readInjectableScript(options.scriptPath);
  const userscriptSource = readUserscriptSource(options.scriptPath);
  const userscriptMeta = extractUserscriptMetadata(userscriptSource);

  if (options.attachActiveChrome) {
    if (options.syncTampermonkey || options.realTest || options.action || options.pageScript || options.pageScriptFile || options.validateNativePaste) {
      if (options.syncTampermonkey || options.realTest || options.action || options.validateNativePaste) {
        const syncResult = syncTampermonkeyScriptInActiveChrome({
          scriptPath: options.scriptPath,
          scriptSource: userscriptSource,
        });

        console.log('[feishu-helper-profile-runner] sync:', JSON.stringify(syncResult, null, 2));
      }

      if (options.pageScript || options.pageScriptFile) {
        const pageScriptResult = runConfiguredPageScriptInActiveChrome({
          url: options.url,
          pageScript: options.pageScript,
          pageScriptFile: options.pageScriptFile,
          injectScript,
        });
        console.log('[feishu-helper-profile-runner] page-script:', JSON.stringify(pageScriptResult, null, 2));
        return;
      }

      if (options.validateNativePaste) {
        const validationResult = runNativePasteValidationInActiveChrome({
          sourceUrl: options.sourceUrl,
          targetUrl: options.targetUrl,
          expectedVersion: userscriptMeta.version,
          probeFunction: options.probeFunction,
          injectScript,
        });
        console.log('[feishu-helper-profile-runner] native-validation:', JSON.stringify(validationResult, null, 2));
        return;
      }

      if (options.realTest || options.action) {
        const testResult = runTampermonkeyAutomationActionInActiveChrome({
          url: options.url,
          expectedVersion: userscriptMeta.version,
          probeFunction: options.probeFunction,
          action: options.action,
          realTest: options.realTest,
          injectScript,
        });
        console.log('[feishu-helper-profile-runner] real-test:', JSON.stringify(testResult, null, 2));
      }
      return;
    }

    const activeResult = attachToActiveChrome({
      url: options.url,
      injectScript,
      probeFunction: options.probeFunction,
    });
    const probe = assertProbeLoaded(activeResult && activeResult.probe, {
      expectedVersion: userscriptMeta.version,
    });
    console.log('[feishu-helper-profile-runner] page:', activeResult && activeResult.url ? activeResult.url : options.url);
    console.log('[feishu-helper-profile-runner] script:', options.scriptPath);
    console.log('[feishu-helper-profile-runner] attach:', 'active-chrome');
    console.log('[feishu-helper-profile-runner] probe:', JSON.stringify(probe, null, 2));
    if (activeResult && activeResult.error) {
      console.log('[feishu-helper-profile-runner] browser-error:', activeResult.error);
    }
    return;
  }

  const preparedProfile = options.cloneProfile ? cloneProfileToTempUserDataDir(options) : {
    userDataDir: options.userDataDir,
    cleanup() {},
  };
  const { context, page } = await launchInjectedPersistentContext({
    userDataDir: preparedProfile.userDataDir,
    injectScript,
    url: options.url,
    headless: options.headless,
    channel: options.channel || undefined,
    profileDirectory: options.profileDirectory || undefined,
    onContextReady: async (context) => {
      if (!options.cloneProfile) return;
      const restoredCookieCount = await restoreChromeProfileCookies(context, {
        userDataDir: options.userDataDir,
        profileDirectory: options.profileDirectory,
      });
      if (restoredCookieCount) {
        console.log('[feishu-helper-profile-runner] restored cookies:', restoredCookieCount);
      }
    },
  });

  try {
    const probe = assertProbeLoaded(await probeInjectedScript(page, {
      probeFunction: options.probeFunction,
    }), {
      expectedVersion: userscriptMeta.version,
    });
    console.log('[feishu-helper-profile-runner] page:', page.url());
    console.log('[feishu-helper-profile-runner] script:', options.scriptPath);
    console.log('[feishu-helper-profile-runner] profile:', options.profileDirectory, options.cloneProfile ? '(cloned)' : '(live)');
    console.log('[feishu-helper-profile-runner] probe:', JSON.stringify(probe, null, 2));

    if (options.pageScript || options.pageScriptFile) {
      const pageScriptResult = await executeConfiguredPageScriptInPage(page, {
        pageScript: options.pageScript,
        pageScriptFile: options.pageScriptFile,
      });
      console.log('[feishu-helper-profile-runner] page-script:', JSON.stringify(pageScriptResult, null, 2));
    }

    if (options.close) return;

    console.log('[feishu-helper-profile-runner] 浏览器保持打开，按 Ctrl+C 退出。');
    await waitForInterrupt();
  } finally {
    await context.close();
    preparedProfile.cleanup();
  }
}

module.exports = {
  DEFAULT_SCRIPT_PATH,
  chromiumTimeToUnixSeconds,
  cloneProfileToTempUserDataDir,
  buildActiveChromeInjectionSteps,
  buildChromeUserDataDir,
  attachToActiveChrome,
  decodeTampermonkeyScriptIdFromRowId,
  decryptChromiumCookieValue,
  deriveChromeSafeStorageKey,
  executeJavaScriptInActiveChromeTab,
  executeLargeJavaScriptInActiveChromeTab,
  detectChromeProfileDirectory,
  detectDefaultChromeUserDataDir,
  extractUserscriptMetadata,
  executeConfiguredPageScriptInPage,
  getActiveChromeTabUrl,
  ensureInjectedScriptOnActiveChrome,
  extractInjectableScript,
  findPositionalUrl,
  injectScriptIntoActiveChromeTab,
  isTampermonkeyEditorPage,
  loadChromeCookiesFromProfile,
  navigateActiveChromeTab,
  openTampermonkeyScriptEditorInActiveChrome,
  probeActiveChromeTab,
  readInjectableScript,
  readUserscriptSource,
  reloadActiveChromeTab,
  runConfiguredPageScriptInActiveChrome,
  runPageScriptInCurrentActiveChrome,
  runNativePasteValidationInActiveChrome,
  runTampermonkeyAutomationActionInActiveChrome,
  runTampermonkeyRealTestInActiveChrome,
  triggerNativePasteInActiveChrome,
  launchInjectedPersistentContext,
  probeInjectedScript,
  restoreChromeProfileCookies,
  assertProbeLoaded,
  compareValidationSnapshots,
  waitForSourceImageConversionInActiveChrome,
  parseCliArgs,
  resolveAutomationAction,
  resolveRunnerOptions,
  syncTampermonkeyScriptInActiveChrome,
  waitForActiveChromeJavaScriptValue,
};

if (require.main === module) {
  main().catch((error) => {
    console.error('[feishu-helper-profile-runner] failed:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}
