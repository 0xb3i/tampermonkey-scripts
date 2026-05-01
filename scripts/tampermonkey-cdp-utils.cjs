const { chromium } = require('@playwright/test');

const { readFileSync } = require('fs');

const DEFAULT_CDP_ENDPOINT = 'http://127.0.0.1:9222';
const DEFAULT_TAMPERMONKEY_EXTENSION_ID = 'dhdgffkkebhmkfjojejmpbldmpobfkfo';

function readUserscriptSource(scriptPath) {
  return readFileSync(String(scriptPath || ''), 'utf8');
}

function extractUserscriptMetadata(scriptContent) {
  var source = String(scriptContent || '');
  function readMeta(key) {
    var match = source.match(new RegExp('^\\s*//\\s*@' + key + '\\s+(.+)$', 'm'));
    return match ? match[1].trim() : '';
  }
  return {
    name: readMeta('name'),
    version: readMeta('version'),
  };
}

function decodeTampermonkeyScriptIdFromRowId(rowId) {
  var raw = String(rowId || '');
  if (raw.indexOf('tr_') !== 0) return '';
  try {
    var decoded = Buffer.from(raw.slice(3), 'base64').toString('utf8');
    return /_pi$/.test(decoded) ? decoded.slice(0, -3) : decoded;
  } catch (error) {
    return '';
  }
}

async function connectToChromeOverCDP(endpointUrl) {
  return chromium.connectOverCDP(endpointUrl || DEFAULT_CDP_ENDPOINT);
}

function getPrimaryContext(browser) {
  var contexts = browser.contexts();
  if (!contexts.length) {
    throw new Error('No browser context found on the connected CDP session.');
  }
  return contexts[0];
}

async function getPrimaryPage(browser) {
  var pages = getPrimaryContext(browser).pages();
  var page = pages.find(function (item) {
    return !isTampermonkeyAskPage(item);
  }) || pages[0];
  if (!page) {
    throw new Error('No existing page found in the connected browser.');
  }
  return page;
}

async function navigateCurrentTab(page, url) {
  await page.goto(String(url || ''), { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('domcontentloaded');
}

async function waitForDocumentReady(page, timeoutMs) {
  await page.waitForFunction(function () {
    return document.readyState === 'interactive' || document.readyState === 'complete';
  }, null, { timeout: timeoutMs || 15000 });
}

async function openTampermonkeyPage(page, options) {
  var extensionId = options && options.extensionId ? options.extensionId : DEFAULT_TAMPERMONKEY_EXTENSION_ID;
  var hash = options && options.hash ? String(options.hash) : '';
  await navigateCurrentTab(page, 'chrome-extension://' + extensionId + '/options.html' + hash);
  await waitForDocumentReady(page);
  if (options && options.tabLabel) {
    await page.getByText(String(options.tabLabel), { exact: true }).first().click();
    await waitForDocumentReady(page);
  }
}

async function waitForElement(page, selector, timeoutMs) {
  await page.waitForFunction(function (targetSelector) {
    return !!document.querySelector(targetSelector);
  }, selector, { timeout: timeoutMs || 15000 });
}

async function readScriptRow(page, scriptName) {
  return page.evaluate(function (targetName) {
    var rows = Array.from(document.querySelectorAll('tr.scripttr'));
    var target = rows.find(function (row) {
      return String(row.innerText || '').includes(String(targetName || ''));
    });
    if (!target) return null;
    var checkbox = target.querySelector('input[type="checkbox"]');
    return {
      id: String(target.id || ''),
      text: String(target.innerText || ''),
      enabled: !!(checkbox && checkbox.checked),
    };
  }, scriptName);
}

async function clickTampermonkeyConfirm(page) {
  var clicked = await page.evaluate(function () {
    var controls = Array.from(document.querySelectorAll('input, button'));
    var target = controls.find(function (el) {
      var text = String(el.innerText || el.value || el.getAttribute('aria-label') || '');
      return /重新安装|更新用户脚本|更新|确认|Reinstall|Install|Update|Confirm/i.test(text) &&
        !/取消|Cancel|禁用|Disable/i.test(text);
    });
    if (!target) return '';
    target.click();
    return String(target.innerText || target.value || target.getAttribute('aria-label') || 'clicked');
  });
  if (!clicked) {
    throw new Error('Tampermonkey reinstall confirmation button not found.');
  }
  return clicked;
}

function isTampermonkeyAskPage(page, extensionId) {
  var targetId = extensionId || DEFAULT_TAMPERMONKEY_EXTENSION_ID;
  return String(page.url() || '').indexOf('chrome-extension://' + targetId + '/ask.html') === 0;
}

async function closeTampermonkeyAskPages(context, extensionId) {
  var pages = context.pages().filter(function (page) {
    return isTampermonkeyAskPage(page, extensionId);
  });
  for (var i = 0; i < pages.length; i++) {
    await pages[i].close().catch(function () {});
  }
}

async function waitForTampermonkeyAskPage(context, extensionId, timeoutMs) {
  var start = Date.now();
  while (Date.now() - start < (timeoutMs || 15000)) {
    var askPage = context.pages().find(function (page) {
      return isTampermonkeyAskPage(page, extensionId);
    });
    if (askPage) {
      await waitForDocumentReady(askPage, 5000).catch(function () {});
      return askPage;
    }
    await new Promise(function (resolve) { setTimeout(resolve, 200); });
  }
  throw new Error('Tampermonkey reinstall confirmation page not found.');
}

async function ensureTampermonkeyScriptEnabled(page, scriptName) {
  var result = await page.evaluate(function (targetName) {
    var rows = Array.from(document.querySelectorAll('tr.scripttr'));
    var target = rows.find(function (row) {
      return String(row.innerText || '').includes(String(targetName || ''));
    });
    if (!target) return 'not-found';
    var checkbox = target.querySelector('input[type="checkbox"]');
    if (!checkbox) return 'checkbox-missing';
    if (!checkbox.checked) {
      checkbox.click();
      return 'enabled';
    }
    return 'already-enabled';
  }, scriptName);
  if (result === 'not-found') {
    throw new Error('Unable to find Tampermonkey script row for ' + scriptName);
  }
  if (result === 'checkbox-missing') {
    throw new Error('Tampermonkey script checkbox not found for ' + scriptName);
  }
  return result;
}

function buildSyncVerificationMarkers(scriptSource) {
  var source = String(scriptSource || '').replace(/\r\n?/g, '\n');
  var lines = source.split('\n').map(function (line) {
    return line.trim();
  }).filter(Boolean);
  return lines.filter(function (line) {
    return line.length >= 24 && line.indexOf('// @version') !== 0;
  }).slice(0, 12);
}

async function readTargetEditorState(page, meta) {
  var markers = buildSyncVerificationMarkers(meta && meta.scriptSource ? meta.scriptSource : '');
  return page.evaluate(function (payload) {
    var codeMirrors = Array.from(document.querySelectorAll('.CodeMirror'));
    var target = codeMirrors.map(function (el) {
      var instance = el.CodeMirror;
      var value = instance ? String(instance.getValue() || '') : '';
      return {
        value: value,
        hasName: payload.name ? value.indexOf('@name         ' + payload.name) !== -1 || value.indexOf('@name ' + payload.name) !== -1 : false,
      };
    }).find(function (item) {
      return item.hasName;
    }) || null;
    if (!target) {
      return {
        found: false,
        value: '',
        matchedMarkers: [],
      };
    }
    var normalized = target.value.replace(/\r\n?/g, '\n');
    var matchedMarkers = payload.markers.filter(function (marker) {
      return normalized.indexOf(marker) !== -1;
    });
    return {
      found: true,
      value: normalized,
      matchedMarkers: matchedMarkers,
    };
  }, {
    name: meta && meta.name ? String(meta.name) : '',
    markers: markers,
  });
}

async function syncTampermonkeyScript(page, options) {
  var scriptSource = options && options.scriptSource ? String(options.scriptSource) : readUserscriptSource(options && options.scriptPath);
  var meta = extractUserscriptMetadata(scriptSource);
  var extensionId = options && options.extensionId ? options.extensionId : DEFAULT_TAMPERMONKEY_EXTENSION_ID;
  var context = page.context();
  if (!meta.name) {
    throw new Error('Unable to determine userscript name from source.');
  }

  await closeTampermonkeyAskPages(context, extensionId);

  await openTampermonkeyPage(page, {
    extensionId: extensionId,
    tabLabel: '实用工具',
  });
  await waitForElement(page, '#textarea_dXRpbHNfdXRpbHM_ta');
  await waitForElement(page, '#input_dXRpbHNfdXRpbHNfaV90YQ_bu');

  await page.evaluate(function (source) {
    var textarea = document.getElementById('textarea_dXRpbHNfdXRpbHM_ta');
    if (!textarea) throw new Error('Tampermonkey import textarea not found');
    textarea.value = source;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    var button = document.getElementById('input_dXRpbHNfdXRpbHNfaV90YQ_bu');
    if (!button) throw new Error('Tampermonkey import button not found');
    button.click();
  }, scriptSource);

  var askPage = await waitForTampermonkeyAskPage(context, extensionId, 15000);
  await clickTampermonkeyConfirm(askPage);
  await askPage.close().catch(function () {});

  await openTampermonkeyPage(page, {
    extensionId: extensionId,
    tabLabel: '已安装脚本',
  });
  await waitForElement(page, 'tr.scripttr');

  var row = await readScriptRow(page, meta.name);
  if (!row || !row.id) {
    throw new Error('Unable to find Tampermonkey script row for ' + meta.name);
  }

  var scriptId = decodeTampermonkeyScriptIdFromRowId(row.id);
  if (!scriptId) {
    throw new Error('Unable to decode Tampermonkey script id from row ' + row.id);
  }

  await openTampermonkeyPage(page, {
    extensionId: extensionId,
    hash: '#nav=' + scriptId + '+editor',
  });

  await page.waitForFunction(function (expectedScriptId) {
    return document.readyState === 'complete' && location.href.includes(String(expectedScriptId || '') + '+editor');
  }, scriptId, { timeout: 15000 });

  var editorState = await readTargetEditorState(page, {
    name: meta.name,
    scriptSource: scriptSource,
  });
  if (!editorState.found) {
    throw new Error('Tampermonkey editor instance for ' + meta.name + ' not found.');
  }
  if (editorState.value.indexOf(scriptSource.replace(/\r\n?/g, '\n')) === -1 && editorState.matchedMarkers.length < 3) {
    throw new Error('Tampermonkey editor content did not match the local userscript source.');
  }

  await openTampermonkeyPage(page, {
    extensionId: extensionId,
    tabLabel: '已安装脚本',
  });
  await waitForElement(page, 'tr.scripttr');

  var enableResult = await ensureTampermonkeyScriptEnabled(page, meta.name);

  return {
    name: meta.name,
    version: meta.version,
    enableResult: enableResult,
    editorUrl: page.url(),
    matchedMarkers: editorState.matchedMarkers.length,
  };
}

async function syncUserscriptInBrowser(browser, options) {
  var page = options && options.page ? options.page : await getPrimaryPage(browser);
  var previousUrl = page.url();
  var sync = await syncTampermonkeyScript(page, options);
  return {
    page: page,
    previousUrl: previousUrl,
    sync: sync,
  };
}

async function syncUserscriptToTampermonkey(options) {
  var endpointUrl = options && options.cdpUrl ? String(options.cdpUrl) : DEFAULT_CDP_ENDPOINT;
  var browser = await connectToChromeOverCDP(endpointUrl);
  try {
    var result = await syncUserscriptInBrowser(browser, options);
    return {
      cdpUrl: endpointUrl,
      previousUrl: result.previousUrl,
      sync: result.sync,
    };
  } finally {
    await browser.close();
  }
}

module.exports = {
  DEFAULT_CDP_ENDPOINT,
  DEFAULT_TAMPERMONKEY_EXTENSION_ID,
  connectToChromeOverCDP,
  getPrimaryContext,
  getPrimaryPage,
  navigateCurrentTab,
  waitForDocumentReady,
  openTampermonkeyPage,
  readScriptRow,
  syncTampermonkeyScript,
  syncUserscriptInBrowser,
  syncUserscriptToTampermonkey,
  waitForElement,
};
