// ==UserScript==
// @name         飞书文档助手
// @namespace    https://github.com/tampermonkey-scripts
// @version      4.2.17
// @description  飞书文档完整复制、图片提取、文档副本（含LaTeX公式）
// @author       You
// @match        https://*.feishu.cn/*
// @match        https://*.larksuite.com/*
// @match        https://*.larkoffice.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  if (window.__feishuHelperRuntime && typeof window.__feishuHelperRuntime.dispose === 'function') {
    try {
      window.__feishuHelperRuntime.dispose();
    } catch (error) {
      console.warn('[Feishu Helper] failed to dispose previous runtime', error);
    }
  }

  var SCRIPT_NAME = '飞书文档助手';
  var SCRIPT_VERSION = '4.2.16';
  var AUTOMATION_REQUEST_EVENT = 'feishu-helper:automation-request';
  var AUTOMATION_RESULT_EVENT = 'feishu-helper:automation-result';
  var CONTENT_ROOT_SELECTOR = '[data-content-editable-root="true"]';
  var EDITABLE_SELECTOR = [
    CONTENT_ROOT_SELECTOR,
    '.editor-kit-container[contenteditable="true"]',
    '[contenteditable="true"]',
    '[contenteditable="plaintext-only"]',
    '[role="textbox"]',
  ].join(', ');
  var MAX_BLOCK_DEPTH = 12;
  var DEFAULT_HEADING_STYLE = 'margin:1.2em 0 0.6em;line-height:1.35;';
  var DEFAULT_PARAGRAPH_STYLE = 'margin:0.75em 0;';
  var DEBUG_EDITOR_KEY_PATTERN = /paste|insert|block|clip|copy|formula|math|selection|range|command|transform|convert|doc|node|editor|service|inject|module|model|data|feature|struct|scope|render|life/i;
  var SPECIAL_BLOCK_LABELS = {
    diagram: '流程图',
    whiteboard: '白板',
    synced_reference: '引用块',
  };
  var runtimeDisposers = [];

  function registerRuntimeDisposer(disposer) {
    if (typeof disposer !== 'function') return disposer;
    runtimeDisposers.push(disposer);
    return disposer;
  }

  function registerEventListener(target, type, listener, options) {
    if (!target || typeof target.addEventListener !== 'function' || typeof listener !== 'function') {
      return listener;
    }
    target.addEventListener(type, listener, options);
    registerRuntimeDisposer(function () {
      target.removeEventListener(type, listener, options);
    });
    return listener;
  }

  window.__feishuHelperRuntime = {
    version: SCRIPT_VERSION,
    dispose: function () {
      while (runtimeDisposers.length) {
        var disposer = runtimeDisposers.pop();
        try {
          disposer();
        } catch (error) {}
      }
    },
  };
  console.info('[Feishu Helper v' + SCRIPT_VERSION + '] loaded on', location.href);

  function getContentRootElement() {
    return document.querySelector(CONTENT_ROOT_SELECTOR);
  }

  function getReactFiberNode(el) {
    if (!el) return null;
    var fiberKey = Object.getOwnPropertyNames(el).find(function (k) {
      return k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$');
    });
    return fiberKey ? el[fiberKey] : null;
  }

  function getEditorApiSearchElements() {
    var candidates = [];

    function pushCandidate(node) {
      if (!node || node.nodeType !== 1 || candidates.indexOf(node) !== -1) return;
      candidates.push(node);
    }

    pushCandidate(document.activeElement);

    var selection = null;
    try {
      selection = window.getSelection ? window.getSelection() : null;
    } catch (error) {}
    pushCandidate(selection && selection.anchorNode ? (selection.anchorNode.nodeType === 1 ? selection.anchorNode : selection.anchorNode.parentElement) : null);

    pushCandidate(getContentRootElement());

    Array.prototype.slice.call(document.querySelectorAll(EDITABLE_SELECTOR), 0, 12).forEach(function (node) {
      pushCandidate(node);
    });

    return candidates;
  }

  function findEditorApiValue(extractor) {
    var candidates = getEditorApiSearchElements();
    for (var i = 0; i < candidates.length; i++) {
      var node = candidates[i];
      var domDepth = 0;
      while (node && domDepth < 6) {
        var fiber = getReactFiberNode(node);
        var fiberDepth = 0;
        while (fiber && fiberDepth < 40) {
          var props = fiber.memoizedProps || {};
          var value = extractor(props);
          if (value) return value;
          fiber = fiber.return;
          fiberDepth++;
        }
        node = node.parentElement;
        domDepth++;
      }
    }
    return null;
  }

  function getDocToken() {
    var match = location.pathname.match(/\/(docx|wiki|doc|sheet|slides|base)\/([A-Za-z0-9]+)/);
    return match ? match[2] : null;
  }

  function getStructService() {
    return findEditorApiValue(function (props) {
      return props.editorAPI && props.editorAPI.structService;
    });
  }

  function getEditorAPI() {
    return findEditorApiValue(function (props) {
      return props.editorAPI;
    });
  }

  function getEditorReadyState() {
    var root = getContentRootElement() || document.querySelector(EDITABLE_SELECTOR);
    var editorAPI = getEditorAPI();
    var structService = editorAPI && editorAPI.structService ? editorAPI.structService : getStructService();
    var hasStructAPI = !!(structService && structService.rootBlock);
    // Content is considered loaded when the content root has meaningful innerHTML,
    // even if the React fiber-based editorAPI is not available (e.g. newer Feishu builds).
    var hasContentLoaded = !!(root && root.innerHTML && root.innerHTML.length > 100);
    return {
      href: location.href,
      readyState: document.readyState,
      hasContentRoot: !!root,
      contentRootTag: root ? String(root.tagName || '') : '',
      hasEditorAPI: !!editorAPI,
      hasStructService: !!structService,
      hasRootBlock: hasStructAPI,
      rootChildCount: structService && structService.rootBlock ? getBlockChildren(structService.rootBlock).length : 0,
      hasContentLoaded: hasContentLoaded,
    };
  }

  function summarizeDebugText(value, limit) {
    value = String(value == null ? '' : value);
    limit = limit || 240;
    return value.length > limit ? value.slice(0, limit) + '…' : value;
  }

  function getDocumentTitle() {
    var title = document.querySelector('title');
    return title ? title.textContent.replace(/ - 飞书云文档$/, '').replace(/ - Lark$/, '') : '副本';
  }

  function getBlockChildren(block) {
    return block && Array.isArray(block.children) ? block.children : [];
  }

  function buildBlockRecordMap(block) {
    var blockMap = {};
    getBlockChildren(block).forEach(function (child) {
      if (child.record && child.record.id) blockMap[child.record.id] = child;
    });
    return blockMap;
  }

  function collectRenderedChildBlocks(block, depth, renderChild) {
    var childHtmlArr = [];
    var childMdArr = [];

    getBlockChildren(block).forEach(function (child) {
      var childResult = renderChild(child, depth + 1);
      if (!childResult) return;
      if (childResult.html) childHtmlArr.push(childResult.html);
      if (childResult.md) childMdArr.push(childResult.md);
    });

    return {
      html: childHtmlArr,
      md: childMdArr,
    };
  }

  function collectTableCellParts(cellBlock, extractor) {
    var parts = [];
    getBlockChildren(cellBlock).forEach(function (child) {
      if (!(child.record && child.record.snapshot)) return;
      var value = extractor(child.record.snapshot);
      if (value) parts.push(value);
    });
    return parts;
  }

  function withExtractedDocument(loadingMessage, failureMessage, onSuccess) {
    showToast(loadingMessage, 0);
    setTimeout(function () {
      var content = extractFullDoc();
      if (!content) {
        showToast(failureMessage);
        return;
      }
      onSuccess(content, getDocumentTitle());
    }, 50);
  }

  function getHeadingTagName(type) {
    var match = /^heading([1-9])$/.exec(type || '');
    if (!match) return '';
    return 'h' + Math.min(parseInt(match[1], 10), 6);
  }

  function getHeadingMarkdownPrefix(type) {
    var match = /^heading([1-9])$/.exec(type || '');
    if (!match) return '';
    return new Array(Math.min(parseInt(match[1], 10), 6) + 1).join('#');
  }

  function indentMultilineText(text, prefix) {
    return String(text || '').split('\n').map(function (line) {
      return prefix + line;
    }).join('\n');
  }

  function renderMarkdownListItem(prefix, text, childMd) {
    var line = prefix + text;
    return childMd ? line + '\n' + indentMultilineText(childMd, '  ') : line;
  }

  function renderMarkdownBlockquote(content) {
    content = String(content || '').trim();
    if (!content) return '';
    return content.split('\n').map(function (line) {
      return '> ' + line;
    }).join('\n');
  }

  function getCalloutMarkdownType(snap) {
    var emojiId = normalizeEmojiId(snap && snap.emoji_id);

    if (emojiId === 'warning') return 'WARNING';
    if (emojiId === 'light_bulb' || emojiId === 'rocket' || emojiId === 'key') return 'TIP';
    if (emojiId === 'boom' || emojiId === 'thumbs_down') return 'CAUTION';
    if (emojiId === 'check_box_with_check' || emojiId === 'trophy' || emojiId === 'thumbs_up') return 'SUCCESS';
    if (emojiId === 'exclamation' || emojiId === 'question' || emojiId === 'gear' || emojiId === 'lock') return 'IMPORTANT';

    return 'NOTE';
  }

  function renderHtmlPlaceholder(label) {
    return '<p>[' + label + ']</p>';
  }

  function renderMarkdownPlaceholder(label) {
    return '[' + label + ']';
  }

  function getImageAssetInfo(image) {
    image = image || {};
    return {
      src: image.token ? location.origin + '/space/api/box/stream/download/preview/' + image.token + '/?preview_type=16' : '',
      alt: image.name || '',
    };
  }

  function countDocumentImagesInRoot(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return 0;
    return root.querySelectorAll('img[src*="/space/api/box/stream/download/"]').length;
  }

  function countDocumentImagesInHtml(html) {
    return (String(html || '').match(/<img\b[^>]+src=["'][^"']*\/space\/api\/box\/stream\/download\//gi) || []).length;
  }

  function countFallbackEquationNodes(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return 0;
    return Math.max(
      root.querySelectorAll('.editor-kit-equation-block').length,
      root.querySelectorAll('.docx-equation-block.equation-leaf').length,
      root.querySelectorAll('.katex').length,
      root.querySelectorAll('[data-latex]').length,
      0
    );
  }

  function countExtractedImages(content) {
    content = content || {};
    var markdownCount = (String(content.text || '').match(/!\[/g) || []).length;
    return markdownCount > 0 ? markdownCount : countDocumentImagesInHtml(content.html);
  }

  function buildTableMatrix(snap, block, extractor, joinParts) {
    var rows = snap.rows_id || [];
    var cols = snap.columns_id || [];
    var cellSet = snap.cell_set || {};

    if (!rows.length || !cols.length) return null;

    var blockMap = buildBlockRecordMap(block);
    var tableRows = rows.map(function (rowId) {
      return cols.map(function (colId) {
        var cellInfo = cellSet[rowId + colId];
        if (!(cellInfo && cellInfo.block_id)) return '';

        var cellBlock = blockMap[cellInfo.block_id];
        if (!cellBlock) return '';

        return joinParts(collectTableCellParts(cellBlock, extractor));
      });
    });

    return {
      cols: cols,
      rows: tableRows,
    };
  }

  function runPasteAttempt(payload, options) {
    var insertResult = options.allowInsert ? tryInsertPayloadIntoEditor(payload) : null;
    var autoInserted = !!insertResult;
    var autoPasted = autoInserted ? false : (!!options.allowDispatch && dispatchPastePayload(payload));
    return {
      autoInserted: autoInserted,
      autoPasted: autoPasted,
      pathLabel: describePasteMode(insertResult ? insertResult.mode : (autoPasted ? 'pasteEvent' : 'clipboardOnly')),
    };
  }

  function showPasteResultToast(status, needsParser, clipboardWritten) {
    if (clipboardWritten) {
      if (needsParser) {
        showToast('📋 v' + SCRIPT_VERSION + ' 已写入剪贴板；检测到公式，请直接按 Cmd+V 走飞书原生粘贴解析', 4300);
      } else if (status.autoInserted) {
        showToast('✅ v' + SCRIPT_VERSION + ' 已通过“' + status.pathLabel + '”插入内容，并已写入剪贴板', 3600);
      } else if (status.autoPasted) {
        showToast('✅ v' + SCRIPT_VERSION + ' 已通过“' + status.pathLabel + '”尝试粘贴，并已写入剪贴板；若没生效再按 Cmd+V', 4200);
      } else {
        showToast('📋 v' + SCRIPT_VERSION + ' 当前走的是“' + status.pathLabel + '”，请按 Cmd+V 粘贴', 3800);
      }
      return;
    }

    if (status.autoInserted) {
      showToast('✅ v' + SCRIPT_VERSION + ' 已通过“' + status.pathLabel + '”插入内容', 3200);
    } else if (status.autoPasted) {
      showToast('✅ v' + SCRIPT_VERSION + ' 已通过“' + status.pathLabel + '”尝试粘贴' + (needsParser ? '；检测到公式，若仍未渲染请再按 Cmd+V' : '；若没生效再按 Cmd+V'), 4200);
    } else {
      showToast('⚠️ v' + SCRIPT_VERSION + ' 未找到可直接粘贴的编辑器，只能走“' + status.pathLabel + '”但写剪贴板也失败了' + (needsParser ? '；当前内容含公式' : ''), 4300);
    }
  }

  function safeGetOwnKeys(obj) {
    try {
      return Object.getOwnPropertyNames(obj || {}).sort();
    } catch (err) {
      return [];
    }
  }

  function safeReadProperty(obj, key) {
    try {
      return { ok: true, value: obj[key] };
    } catch (err) {
      return { ok: false, error: err };
    }
  }

  function createVisitedStore() {
    if (typeof WeakSet !== 'undefined') return new WeakSet();
    return {
      _items: [],
      has: function (value) { return this._items.indexOf(value) !== -1; },
      add: function (value) {
        if (this._items.indexOf(value) === -1) this._items.push(value);
      },
    };
  }

  function collectInterestingPaths(root, rootLabel, keyPattern, maxDepth, maxEntries) {
    var results = [];
    var visited = createVisitedStore();
    maxDepth = maxDepth || 2;
    maxEntries = maxEntries || 80;

    function walk(value, path, depth) {
      if (!value || depth > maxDepth || results.length >= maxEntries) return;
      if (typeof value !== 'object' && typeof value !== 'function') return;
      if (visited.has(value)) return;
      visited.add(value);

      safeGetOwnKeys(value).forEach(function (key) {
        if (results.length >= maxEntries) return;

        var childRead = safeReadProperty(value, key);
        var childPath = path + '.' + key;
        if (!childRead.ok) {
          if (keyPattern.test(key)) {
            results.push({
              path: childPath,
              type: 'throws',
              error: summarizeDebugText(childRead.error && childRead.error.message, 120),
            });
          }
          return;
        }

        var child = childRead.value;
        var keyMatched = keyPattern.test(key);
        if (keyMatched) {
          var entry = {
            path: childPath,
            type: typeof child,
          };
          if (typeof child === 'string') entry.value = summarizeDebugText(child, 120);
          else if (child == null || typeof child === 'number' || typeof child === 'boolean') entry.value = child;
          else if (Array.isArray(child)) entry.value = '[array:' + child.length + ']';
          else entry.keys = safeGetOwnKeys(child).slice(0, 24);
          results.push(entry);
        }

        if ((typeof child === 'object' || typeof child === 'function') && depth < maxDepth) {
          walk(child, childPath, depth + 1);
        }
      });
    }

    walk(root, rootLabel || 'root', 0);
    return results;
  }

  function summarizeObjectValue(value, keyPattern) {
    keyPattern = keyPattern || /paste|insert|block|clip|copy|formula|math|selection|range|command|transform|convert|doc|node|editor|service|inject|module|model|data|feature|struct|scope|render|life/i;

    if (value == null || (typeof value !== 'object' && typeof value !== 'function')) {
      return {
        type: typeof value,
        value: typeof value === 'string' ? summarizeDebugText(value, 200) : value,
      };
    }

    var keys = safeGetOwnKeys(value);
    var functionKeys = [];
    var sampleValues = {};

    keys.slice(0, 80).forEach(function (key) {
      var childRead = safeReadProperty(value, key);
      if (!childRead.ok) {
        sampleValues[key] = '[throws:' + summarizeDebugText(childRead.error && childRead.error.message, 80) + ']';
        return;
      }

      var child = childRead.value;
      if (typeof child === 'function') {
        functionKeys.push(key);
      } else if (child == null || typeof child === 'string' || typeof child === 'number' || typeof child === 'boolean') {
        sampleValues[key] = typeof child === 'string' ? summarizeDebugText(child, 120) : child;
      } else if (Array.isArray(child)) {
        sampleValues[key] = '[array:' + child.length + ']';
      } else {
        sampleValues[key] = '[object]';
      }
    });

    return {
      type: typeof value,
      keys: keys,
      functionKeys: functionKeys,
      sampleValues: sampleValues,
      matchedPaths: collectInterestingPaths(value, 'target', keyPattern, 2, 80),
    };
  }

  function resolveEditorPath(path) {
    var editorAPI = getEditorAPI();
    if (!editorAPI) return { ok: false, error: new Error('editorAPI unavailable') };

    path = String(path || '').trim();
    if (!path || path === 'editorAPI') {
      return { ok: true, root: editorAPI, value: editorAPI, label: 'editorAPI' };
    }

    var normalized = path.replace(/^editorAPI\./, '');
    var current = editorAPI;
    var currentLabel = 'editorAPI';
    var parts = normalized.split('.').filter(Boolean);

    for (var i = 0; i < parts.length; i++) {
      var key = parts[i];
      var childRead = safeReadProperty(current, key);
      currentLabel += '.' + key;
      if (!childRead.ok) {
        return { ok: false, error: childRead.error, label: currentLabel };
      }
      current = childRead.value;
    }

    return { ok: true, root: editorAPI, value: current, label: currentLabel };
  }

  function storeCaptureRawData(capture, type, value) {
    if (!capture.rawData) capture.rawData = {};
    var str = String(value == null ? '' : value);
    capture.rawData[type] = {
      length: str.length,
      truncated: str.length > 200000,
      text: str.length > 200000 ? str.slice(0, 200000) : str,
    };
  }

  function collectAttribNamesDeep(root, maxDepth, maxEntries) {
    var names = {};
    var visited = createVisitedStore();
    maxDepth = maxDepth || 4;
    maxEntries = maxEntries || 400;
    var seenEntries = 0;

    function walk(value, depth) {
      if (value == null || depth > maxDepth || seenEntries >= maxEntries) return;
      var valueType = typeof value;
      if (valueType !== 'object' && valueType !== 'function') return;
      if (visited.has(value)) return;
      visited.add(value);
      seenEntries++;

      if (value.numToAttrib && typeof value.numToAttrib === 'object') {
        Object.keys(value.numToAttrib).forEach(function (key) {
          var attr = value.numToAttrib[key];
          if (Array.isArray(attr) && attr[0]) {
            names[attr[0]] = (names[attr[0]] || 0) + 1;
          }
        });
      }

      safeGetOwnKeys(value).forEach(function (key) {
        if (seenEntries >= maxEntries) return;
        var childRead = safeReadProperty(value, key);
        if (!childRead.ok) return;
        walk(childRead.value, depth + 1);
      });
    }

    walk(root, 0);
    return names;
  }

  function summarizePayloadMap(payloadMap) {
    if (!payloadMap || typeof payloadMap !== 'object') {
      return {
        count: 0,
        sampleKeys: [],
        sampleEntries: [],
        attribNames: {},
      };
    }

    var keys = Object.keys(payloadMap);
    var sampleEntries = keys.slice(0, 8).map(function (key) {
      var entryRead = safeReadProperty(payloadMap, key);
      if (!entryRead.ok) {
        return {
          key: key,
          error: summarizeDebugText(entryRead.error && entryRead.error.message, 120),
        };
      }

      var entry = entryRead.value;
      var snapshot = entry && entry.snapshot;
      return {
        key: key,
        topKeys: safeGetOwnKeys(entry).slice(0, 16),
        type: entry && entry.type || snapshot && snapshot.type || '',
        snapshotType: snapshot && snapshot.type || '',
        attribNames: collectAttribNamesDeep(entry, 3, 160),
      };
    });

    return {
      count: keys.length,
      sampleKeys: keys.slice(0, 20),
      sampleEntries: sampleEntries,
      attribNames: collectAttribNamesDeep(payloadMap, 4, 300),
    };
  }

  function summarizeHtmlRecordData(rawHtml) {
    var html = String(rawHtml || '');
    if (!html) {
      return { ok: false, error: 'empty html payload' };
    }

    try {
      var doc = new DOMParser().parseFromString(html, 'text/html');
      var nodes = Array.from(doc.querySelectorAll('[data-lark-record-data]'));
      var samples = nodes.slice(0, 8).map(function (node) {
        var raw = node.getAttribute('data-lark-record-data') || '';
        try {
          var parsed = JSON.parse(raw);
          return {
            topKeys: safeGetOwnKeys(parsed).slice(0, 20),
            rootId: parsed.rootId || '',
            type: parsed.type || parsed.snapshot && parsed.snapshot.type || '',
            attribNames: collectAttribNamesDeep(parsed, 4, 200),
          };
        } catch (err) {
          return {
            error: summarizeDebugText(err && err.message, 120),
            preview: summarizeDebugText(raw, 200),
          };
        }
      });

      return {
        ok: true,
        count: nodes.length,
        rootAttrs: doc.body && doc.body.firstElementChild ? {
          tag: doc.body.firstElementChild.tagName,
          attrs: Array.from(doc.body.firstElementChild.attributes || []).slice(0, 12).map(function (attr) {
            return {
              name: attr.name,
              value: summarizeDebugText(attr.value, 120),
            };
          }),
        } : null,
        sampleRecords: samples,
      };
    } catch (err) {
      return {
        ok: false,
        error: summarizeDebugText(err && err.message, 160),
      };
    }
  }

  function summarizeGenericClipboardJson(rawText, label) {
    var text = String(rawText || '');
    if (!text) {
      return { ok: false, error: 'empty ' + label + ' payload' };
    }

    try {
      var parsed = JSON.parse(text);
      var pathPattern = /root|text|attrib|apool|equation|block|child|type|record|snapshot|inline|author|link|color|highlight|payload|selection|meta|data/i;
      return {
        ok: true,
        topKeys: safeGetOwnKeys(parsed),
        rootId: parsed.rootId || parsed.id || '',
        type: parsed.type || '',
        blockIds: Array.isArray(parsed.blockIds) ? parsed.blockIds.length : 0,
        recordIds: Array.isArray(parsed.recordIds) ? parsed.recordIds.length : 0,
        payloadMap: summarizePayloadMap(parsed.payloadMap),
        recordMap: summarizePayloadMap(parsed.recordMap),
        attribNames: collectAttribNamesDeep(parsed, 5, 500),
        matchedPaths: collectInterestingPaths(parsed, label, pathPattern, 3, 140),
      };
    } catch (err) {
      return {
        ok: false,
        error: summarizeDebugText(err && err.message, 160),
      };
    }
  }

  function summarizeHtmlMetaBlockProps(rawHtml) {
    var html = String(rawHtml || '');
    if (!html) {
      return { ok: false, error: 'empty html payload' };
    }

    try {
      var doc = new DOMParser().parseFromString(html, 'text/html');
      var nodes = Array.from(doc.querySelectorAll('[data-meta-block-props]'));
      var samples = nodes.slice(0, 12).map(function (node) {
        var raw = node.getAttribute('data-meta-block-props') || '';
        try {
          var parsed = JSON.parse(raw);
          var props = parsed.props || {};
          var data = props.data || {};
          return {
            blockId: parsed.blockId || '',
            blockType: parsed.blockType || '',
            topKeys: safeGetOwnKeys(parsed).slice(0, 20),
            propKeys: safeGetOwnKeys(props).slice(0, 20),
            dataKeys: safeGetOwnKeys(data).slice(0, 20),
            dataPreview: summarizeDebugText(JSON.stringify(data), 240),
            attribNames: collectAttribNamesDeep(parsed, 4, 220),
          };
        } catch (err) {
          return {
            error: summarizeDebugText(err && err.message, 120),
            preview: summarizeDebugText(raw, 220),
          };
        }
      });

      return {
        ok: true,
        count: nodes.length,
        blockTypes: samples.reduce(function (acc, item) {
          if (item && item.blockType) acc[item.blockType] = (acc[item.blockType] || 0) + 1;
          return acc;
        }, {}),
        sampleBlocks: samples,
      };
    } catch (err) {
      return {
        ok: false,
        error: summarizeDebugText(err && err.message, 160),
      };
    }
  }

  function summarizeDocxClipboardPayload(rawText) {
    var text = String(rawText || '');
    if (!text) {
      return { ok: false, error: 'empty docx/text payload' };
    }

    try {
      var parsed = JSON.parse(text);
      var pathPattern = /root|text|attrib|apool|equation|block|child|type|record|snapshot|inline|author|link|color|highlight/i;
      var topKeys = safeGetOwnKeys(parsed);
      var textNode = parsed.text || {};
      var apool = textNode.apool || parsed.apool || {};
      var numToAttrib = apool.numToAttrib || {};
      var attribNames = {};

      Object.keys(numToAttrib).forEach(function (key) {
        var attr = numToAttrib[key];
        if (Array.isArray(attr) && attr[0]) attribNames[attr[0]] = (attribNames[attr[0]] || 0) + 1;
      });

      return {
        ok: true,
        topKeys: topKeys,
        type: parsed.type || '',
        rootId: parsed.rootId || parsed.id || '',
        textKeys: safeGetOwnKeys(textNode),
        apoolKeys: safeGetOwnKeys(apool),
        attribNames: attribNames,
        deepAttribNames: collectAttribNamesDeep(parsed, 5, 400),
        payloadMap: summarizePayloadMap(parsed.payloadMap),
        matchedPaths: collectInterestingPaths(parsed, 'docxText', pathPattern, 3, 120),
      };
    } catch (err) {
      return {
        ok: false,
        error: summarizeDebugText(err && err.message, 160),
      };
    }
  }

  function decodeFeishuAttribs(attribsStr, textStr, numToAttrib) {
    var result = [];
    var textIdx = 0;
    var i = 0;

    while (i < attribsStr.length) {
      var attrs = [];
      while (i < attribsStr.length && attribsStr[i] === '*') {
        i++;
        var numStr = '';
        while (i < attribsStr.length && /[0-9a-z]/.test(attribsStr[i])) {
          numStr += attribsStr[i];
          i++;
        }
        var num = parseInt(numStr, 36);
        if (numToAttrib[num]) {
          attrs.push(numToAttrib[num]);
        }
      }

      if (i < attribsStr.length && attribsStr[i] === '+') {
        i++;
        var countStr = '';
        while (i < attribsStr.length && /[0-9a-z]/.test(attribsStr[i])) {
          countStr += attribsStr[i];
          i++;
        }
        var count = parseInt(countStr, 36);

        var equationAttr = null;
        var linkAttr = null;
        var isBold = false;
        var isItalic = false;
        var isStrike = false;
        var isInlineCode = false;

        for (var ai = 0; ai < attrs.length; ai++) {
          var a = attrs[ai];
          if (a[0] === 'equation') equationAttr = a;
          else if (a[0] === 'link') linkAttr = a;
          else if (a[0] === 'bold' && a[1] === 'true') isBold = true;
          else if (a[0] === 'italic' && a[1] === 'true') isItalic = true;
          else if (a[0] === 'strikethrough' && a[1] === 'true') isStrike = true;
          else if (a[0] === 'inlineCode' && a[1] === 'true') isInlineCode = true;
        }

        var rawText = textStr.substring(textIdx, textIdx + count);

        if (equationAttr) {
          var latex = normalizeEquationLatex(equationAttr[1]);
          result.push('$' + latex + '$');
        } else {
          var segment = rawText;
          if (isInlineCode) segment = '`' + segment + '`';
          if (isBold) segment = '**' + segment + '**';
          if (isItalic) segment = '*' + segment + '*';
          if (isStrike) segment = '~~' + segment + '~~';
          if (linkAttr) {
            var href = decodeURIComponent(linkAttr[1] || '');
            segment = '[' + segment + '](' + href + ')';
          }
          result.push(segment);
        }

        textIdx += count;
      } else {
        break;
      }
    }

    if (textIdx < textStr.length) {
      result.push(textStr.substring(textIdx));
    }

    return normalizeLatexTextBoundaries(result.join(''));
  }

  function decodeBlockText(snap) {
    if (!snap.text || !snap.text.initialAttributedTexts || !snap.text.apool) return '';
    var iat = snap.text.initialAttributedTexts;
    var apool = snap.text.apool;
    var attribs = (iat.attribs && iat.attribs['0']) || '';
    var text = (iat.text && iat.text['0']) || '';
    var numToAttrib = apool.numToAttrib || {};
    return decodeFeishuAttribs(attribs, text, numToAttrib);
  }

  var EMOJI_MAP = {
    'purple_heart': '💜', 'star': '⭐', 'sparkler': '🎇', 'fire': '🔥',
    'light_bulb': '💡', 'warning': '⚠️', 'memo': '📝', 'check_box_with_check': '✅',
    'exclamation': '❗', 'question': '❓', 'rocket': '🚀', 'gear': '⚙️',
    'book': '📖', 'pin': '📌', 'clipboard': '📋', 'trophy': '🏆',
    'thumbs_up': '👍', 'thumbs_down': '👎', 'heart': '❤️', 'boom': '💥',
    'sun': '☀️', 'rainbow': '🌈', 'key': '🔑', 'lock': '🔒',
  };

  function getEmoji(emojiId) {
    return EMOJI_MAP[emojiId] || '';
  }

  function escapeHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function escapeAttr(str) {
    return escapeHtml(str).replace(/"/g, '&quot;');
  }

  function isSafeCssColor(value) {
    return /^rgb(a)?\([\d\s.,%]+\)$/i.test(value || '') ||
      /^#[0-9a-f]{3,8}$/i.test(value || '') ||
      /^[a-z]+$/i.test(value || '');
  }

  function normalizeCssColor(value) {
    value = String(value || '').trim();
    return isSafeCssColor(value) ? value : '';
  }

  function normalizeTextAlign(value) {
    value = String(value || '').trim().toLowerCase();
    return /^(left|right|center|justify)$/.test(value) ? value : '';
  }

  function normalizeCssLength(value) {
    value = String(value || '').trim();
    return /^-?[\d.]+(px|em|rem|%)?$/.test(value) ? value : '';
  }

  function normalizeEmojiId(value) {
    return String(value || '').trim().toLowerCase();
  }

  // Canonical block-level style metadata shared across rendering and clipboard
  // paths. This helper only normalizes structured values; presentation defaults
  // are resolved by the specific block renderer that needs them.
  function normalizeBlockStyle(snap) {
    snap = snap || {};
    return {
      align: normalizeTextAlign(snap.align),
      textIndent: normalizeCssLength(snap.text_indent),
      textColor: normalizeCssColor(snap.text_color),
      backgroundColor: normalizeCssColor(snap.background_color),
      borderColor: normalizeCssColor(snap.border_color),
      imageAlign: normalizeTextAlign(snap.align),
      calloutEmojiId: normalizeEmojiId(snap.emoji_id),
    };
  }

  function resolveImageAlign(normalizedBlockStyle) {
    return normalizedBlockStyle && normalizedBlockStyle.imageAlign ? normalizedBlockStyle.imageAlign : 'center';
  }

  function selectPrimaryCalloutContent(snapshotContent, childContent) {
    var snapshotValue = String(snapshotContent || '').trim();
    var childValue = String(childContent || '').trim();
    return childValue || snapshotValue;
  }

  function extractPlainTextFromHtmlFragment(html) {
    html = String(html || '').trim();
    if (!html) return '';

    try {
      var doc = new DOMParser().parseFromString('<body>' + html + '</body>', 'text/html');
      return normalizePlainText(doc && doc.body ? (doc.body.textContent || '') : '');
    } catch (err) {
      return '';
    }
  }

  function styleObjectToString(styleObj) {
    return Object.keys(styleObj || {}).filter(function (key) {
      return styleObj[key] !== '' && styleObj[key] != null;
    }).map(function (key) {
      return key + ':' + styleObj[key] + ';';
    }).join('');
  }

  var syntheticClipboardBlockCounter = 0;

  function nextSyntheticClipboardId(prefix) {
    syntheticClipboardBlockCounter += 1;
    return String(prefix || 'feishu_helper') + '_' + syntheticClipboardBlockCounter.toString(36);
  }

  function buildCalloutClipboardMetadata(snap, normalizedStyle, options) {
    var blockId = String(snap && (snap.block_id || snap.blockId) || nextSyntheticClipboardId('callout_block'));
    var recordId = String(snap && (snap.record_id || snap.recordId) || nextSyntheticClipboardId('callout_record'));
    var normalizedBlockStyle = normalizedStyle || normalizeBlockStyle(snap);
    var normalizedStyleMetadata = {
      align: normalizedBlockStyle.align,
      textIndent: normalizedBlockStyle.textIndent,
      textColor: normalizedBlockStyle.textColor,
      backgroundColor: normalizedBlockStyle.backgroundColor,
      borderColor: normalizedBlockStyle.borderColor,
      imageAlign: normalizedBlockStyle.imageAlign,
      calloutEmojiId: normalizedBlockStyle.calloutEmojiId,
    };
    var emojiId = normalizedBlockStyle.calloutEmojiId;
    var backgroundColor = normalizedBlockStyle.backgroundColor;
    var borderColor = normalizedBlockStyle.borderColor;
    var textColor = normalizedBlockStyle.textColor;
    var align = normalizedBlockStyle.align;
    var text = selectPrimaryCalloutContent(decodeBlockText(snap || {}), options && options.text);
    var calloutType = getCalloutMarkdownType({ emoji_id: emojiId });
    var snapshot = {
      type: 'callout',
      emoji_id: emojiId,
      background_color: backgroundColor,
      border_color: borderColor,
      text_color: textColor,
      align: align,
      callout_type: calloutType,
      normalizedStyle: normalizedStyleMetadata,
    };

    if (text) snapshot.text = text;

    return {
      blockId: blockId,
      recordId: recordId,
      recordData: JSON.stringify({
        rootId: recordId,
        blockId: blockId,
        recordId: recordId,
        type: 'callout',
        emoji_id: emojiId,
        background_color: backgroundColor,
        border_color: borderColor,
        text_color: textColor,
        align: align,
        normalizedStyle: normalizedStyleMetadata,
        snapshot: snapshot,
      }),
      metaBlockProps: JSON.stringify({
        blockId: blockId,
        recordId: recordId,
        blockType: 'CALLOUT_BLOCK',
        props: {
          data: {
            emojiId: emojiId,
            backgroundColor: backgroundColor,
            borderColor: borderColor,
            textColor: textColor,
            align: align,
            calloutType: calloutType,
            text: text,
            normalizedStyle: normalizedStyleMetadata,
          },
        },
      }),
    };
  }

  function shouldPreserveFeishuHtmlAttribute(el, attr) {
    if (!el || !attr) return false;
    var name = String(attr.name || '').toLowerCase();
    if (!name) return false;

    if (name === 'class') {
      if (el.hasAttribute('data-block-type')) return true;
      return /\b(docx-[\w-]+|callout-[\w-]+)\b/i.test(String(attr.value || ''));
    }

    var preservedDataAttrs = {
      'data-block-type': true,
      'data-block-id': true,
      'data-record-id': true,
      'data-emoji-id': true,
      'data-lark-record-data': true,
      'data-meta-block-props': true,
    };
    return !!preservedDataAttrs[name];
  }

  function mergeStyleStrings() {
    var merged = {};
    for (var i = 0; i < arguments.length; i++) {
      var styleStr = arguments[i];
      if (!styleStr) continue;
      styleStr.split(';').forEach(function (part) {
        var idx = part.indexOf(':');
        if (idx === -1) return;
        var key = part.slice(0, idx).trim();
        var value = part.slice(idx + 1).trim();
        if (!key || !value) return;
        merged[key] = value;
      });
    }
    return styleObjectToString(merged);
  }

  function buildInlineRichTextStyle(opts) {
    var style = {};
    if (opts.textColor) style.color = opts.textColor;
    if (opts.backgroundColor) style['background-color'] = opts.backgroundColor;
    return styleObjectToString(style);
  }

  function buildBlockStyle(baseStyle, snap, extraStyle, normalizedStyle, options) {
    options = options || {};
    var style = mergeStyleStrings(baseStyle, extraStyle);
    var normalizedBlockStyle = normalizedStyle || normalizeBlockStyle(snap);
    var dynamicStyle = styleObjectToString({
      'text-align': options.applyAlign === false ? '' : normalizedBlockStyle.align,
      'text-indent': options.applyTextIndent === false ? '' : normalizedBlockStyle.textIndent,
      'background-color': options.applyBackgroundColor === false ? '' : normalizedBlockStyle.backgroundColor,
      color: options.applyTextColor === false ? '' : normalizedBlockStyle.textColor,
    });
    return mergeStyleStrings(style, dynamicStyle);
  }

  function wrapWithStyleTag(tagName, style, innerHtml, extraAttrs) {
    var attrs = [];
    if (style) attrs.push('style="' + escapeAttr(style) + '"');
    if (extraAttrs) attrs.push(extraAttrs);
    return '<' + tagName + (attrs.length ? ' ' + attrs.join(' ') : '') + '>' + innerHtml + '</' + tagName + '>';
  }

  function normalizeEquationLatex(latex) {
    latex = latex || '';
    if (latex.endsWith('\\n')) latex = latex.slice(0, -2);
    else if (latex.endsWith('\n')) latex = latex.slice(0, -1);
    return latex.trim();
  }

  function isFormulaBoundaryWordChar(ch) {
    return !!ch && /[0-9A-Za-z_\u00C0-\u024F\u2E80-\u9FFF]/.test(ch);
  }

  function splitLatexSegments(text) {
    var source = String(text || '');
    var segments = [];
    var cursor = 0;
    var index = 0;

    while (index < source.length) {
      if (source[index] !== '$' || (index > 0 && source[index - 1] === '\\')) {
        index++;
        continue;
      }

      var delimiter = source[index + 1] === '$' ? '$$' : '$';
      var openLen = delimiter.length;
      var scan = index + openLen;
      var closeIndex = -1;

      while (scan < source.length) {
        if (source[scan] === '\\') {
          scan += 2;
          continue;
        }

        if (delimiter === '$$') {
          if (source[scan] === '$' && source[scan + 1] === '$') {
            closeIndex = scan;
            break;
          }
          scan++;
          continue;
        }

        if (source[scan] === '$' && source[scan + 1] !== '$') {
          closeIndex = scan;
          break;
        }
        scan++;
      }

      if (closeIndex === -1) {
        index += openLen;
        continue;
      }

      if (cursor < index) {
        segments.push({ type: 'text', value: source.slice(cursor, index) });
      }

      segments.push({
        type: 'formula',
        value: normalizeEquationLatex(source.slice(index + openLen, closeIndex)),
        delimiter: delimiter,
      });

      index = closeIndex + openLen;
      cursor = index;
    }

    if (cursor < source.length) {
      segments.push({ type: 'text', value: source.slice(cursor) });
    }

    if (!segments.length) {
      segments.push({ type: 'text', value: source });
    }

    return segments;
  }

  function findNextNonWhitespaceChar(segments, startIndex) {
    for (var i = startIndex + 1; i < segments.length; i++) {
      var segment = segments[i];
      if (!segment || !segment.value) continue;
      for (var j = 0; j < segment.value.length; j++) {
        if (!/\s/.test(segment.value[j])) return segment.value[j];
      }
    }
    return '';
  }

  function normalizeLatexTextBoundaries(text) {
    var segments = splitLatexSegments(text);
    var out = '';

    for (var i = 0; i < segments.length; i++) {
      var segment = segments[i];
      if (segment.type === 'text') {
        out += segment.value;
        continue;
      }

      var formula = segment.delimiter + segment.value + segment.delimiter;
      var prevChar = out ? out[out.length - 1] : '';
      var nextChar = findNextNonWhitespaceChar(segments, i);
      var prefix = isFormulaBoundaryWordChar(prevChar) ? ' ' : '';
      var suffix = isFormulaBoundaryWordChar(nextChar) ? ' ' : '';
      out += prefix + formula + suffix;
    }

    return out.replace(/[ \t]{2,}/g, ' ');
  }

  function normalizeLatexForHtml(text) {
    var segments = splitLatexSegments(text);
    var out = '';

    for (var i = 0; i < segments.length; i++) {
      var segment = segments[i];
      if (segment.type === 'text') {
        out += segment.value;
        continue;
      }

      var formula = '$$' + segment.value + '$$';
      var prevChar = out ? out[out.length - 1] : '';
      var nextChar = findNextNonWhitespaceChar(segments, i);
      var prefix = prevChar && /\s/.test(prevChar) ? '' : ' ';
      var suffix = nextChar && /\s/.test(nextChar) ? '' : ' ';
      out += prefix + formula + suffix;
    }

    return out.replace(/[ \t]{2,}/g, ' ');
  }

  function normalizeLatexHtmlTextNodes(html) {
    return String(html || '')
      .split(/(<[^>]+>)/g)
      .map(function (part) {
        return part && part[0] === '<' ? part : normalizeLatexForHtml(part);
      })
      .join('');
  }

  function containsLatexText(text) {
    return /\$\$[\s\S]+?\$\$|\$(?:\\.|[^$\n])+\$/.test(String(text || ''));
  }

  function isImageBlockElement(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.tagName === 'FIGURE') return !!el.querySelector('img');
    if ((el.tagName === 'P' || el.tagName === 'DIV') && el.querySelector('img')) {
      var meaningfulText = (el.textContent || '').replace(/\s+/g, '');
      return meaningfulText === '';
    }
    return false;
  }

  function isFormulaBearingBlock(el) {
    if (!el || el.nodeType !== 1) return false;
    if (!/^(P|DIV|UL|OL|BLOCKQUOTE|TABLE)$/.test(el.tagName)) return false;
    return containsLatexText(el.textContent || '');
  }

  function isolateFormulaBlocksAfterImages(root) {
    function walk(parent) {
      var children = Array.from(parent.children || []);
      for (var i = 0; i < children.length; i++) {
        var child = children[i];
        if (!child || child.nodeType !== 1) continue;
        walk(child);
      }

      children = Array.from(parent.children || []);
      for (var j = 1; j < children.length; j++) {
        var prev = children[j - 1];
        var current = children[j];
        if (!isImageBlockElement(prev) || !isFormulaBearingBlock(current)) continue;
        if (current.tagName === 'DIV' && current.getAttribute('style') === 'display:block;') continue;

        var wrapper = document.createElement('div');
        wrapper.setAttribute('style', 'display:block;');
        parent.insertBefore(wrapper, current);
        wrapper.appendChild(current);
        children = Array.from(parent.children || []);
      }
    }

    walk(root);
  }

  function sanitizeHtmlFragment(html) {
    html = normalizeLatexHtmlTextNodes((html || '').trim());
    if (!html) return '';

    var container = document.createElement('div');
    container.innerHTML = html;

    var blockedTags = {
      SCRIPT: true,
      STYLE: true,
      META: true,
      LINK: true,
      IFRAME: true,
      OBJECT: true,
      EMBED: true,
      FORM: true,
      INPUT: true,
      BUTTON: true,
      TEXTAREA: true,
      SELECT: true,
      OPTION: true,
      SVG: true,
      CANVAS: true,
      NOSCRIPT: true,
    };
    var allowedTags = {
      A: true,
      BLOCKQUOTE: true,
      BR: true,
      CODE: true,
      DEL: true,
      DIV: true,
      EM: true,
      FIGCAPTION: true,
      FIGURE: true,
      H1: true,
      H2: true,
      H3: true,
      H4: true,
      H5: true,
      H6: true,
      HR: true,
      IMG: true,
      LI: true,
      OL: true,
      P: true,
      PRE: true,
      STRONG: true,
      TABLE: true,
      TBODY: true,
      TD: true,
      TH: true,
      THEAD: true,
      TR: true,
      UL: true,
      SPAN: true,
    };
    var textSensitiveTags = {
      CODE: true,
      PRE: true,
    };
    var attrAllowlist = {
      A: { href: true, style: true },
      BLOCKQUOTE: { style: true },
      CODE: { style: true },
      DEL: { style: true },
      DIV: { style: true },
      EM: { style: true },
      FIGCAPTION: { style: true },
      FIGURE: { style: true },
      H1: { style: true },
      H2: { style: true },
      H3: { style: true },
      H4: { style: true },
      H5: { style: true },
      H6: { style: true },
      HR: { style: true },
      IMG: { src: true, alt: true, style: true },
      LI: { style: true },
      OL: { style: true },
      P: { style: true },
      PRE: { style: true },
      STRONG: { style: true },
      TABLE: { style: true, border: true, cellpadding: true, cellspacing: true },
      TBODY: {},
      TD: { style: true, colspan: true, rowspan: true },
      TH: { style: true, colspan: true, rowspan: true },
      THEAD: {},
      TR: { style: true },
      UL: { style: true },
      SPAN: { style: true },
    };

    Array.from(container.querySelectorAll('*')).forEach(function (el) {
      if (blockedTags[el.tagName]) {
        el.remove();
        return;
      }

      if (!allowedTags[el.tagName]) {
        while (el.firstChild) {
          el.parentNode.insertBefore(el.firstChild, el);
        }
        el.remove();
        return;
      }

      Array.from(el.attributes).forEach(function (attr) {
        var name = attr.name.toLowerCase();
        if (name.indexOf('on') === 0) {
          el.removeAttribute(attr.name);
          return;
        }
        if (shouldPreserveFeishuHtmlAttribute(el, attr)) {
          return;
        }
        if (name.indexOf('data-') === 0 || name === 'id' || name === 'class' || name === 'contenteditable' || name === 'role') {
          el.removeAttribute(attr.name);
          return;
        }

        var allowed = attrAllowlist[el.tagName] || {};
        if (!allowed[name]) {
          el.removeAttribute(attr.name);
        }
      });

      if (el.tagName === 'A' && !el.getAttribute('href')) {
        while (el.firstChild) {
          el.parentNode.insertBefore(el.firstChild, el);
        }
        el.remove();
        return;
      }

      if (el.tagName === 'IMG' && !el.getAttribute('src')) {
        el.remove();
      }
    });

    var commentWalker = document.createTreeWalker(container, NodeFilter.SHOW_COMMENT, null);
    var commentNodes = [];
    while (commentWalker.nextNode()) {
      commentNodes.push(commentWalker.currentNode);
    }
    commentNodes.forEach(function (node) { node.remove(); });

    var textWalker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
    var textNodes = [];
    while (textWalker.nextNode()) {
      textNodes.push(textWalker.currentNode);
    }
    textNodes.forEach(function (node) {
      var parentTag = node.parentNode && node.parentNode.tagName;
      if (parentTag && textSensitiveTags[parentTag]) return;
      node.textContent = normalizeLatexForHtml(node.textContent);
    });

    var inlineListTags = {
      A: true,
      BR: true,
      CODE: true,
      DEL: true,
      EM: true,
      IMG: true,
      SPAN: true,
      STRONG: true,
    };

    Array.from(container.querySelectorAll('li')).forEach(function (li) {
      var nodesToWrap = [];
      var blockedByStructure = false;

      Array.from(li.childNodes).forEach(function (node) {
        if (node.nodeType === 1 && (node.tagName === 'UL' || node.tagName === 'OL')) {
          return;
        }

        if (node.nodeType === 3) {
          if (node.textContent && node.textContent.trim()) nodesToWrap.push(node);
          return;
        }

        if (node.nodeType === 1 && node.tagName === 'P') {
          nodesToWrap.push(node);
          return;
        }

        if (node.nodeType === 1 && inlineListTags[node.tagName]) {
          nodesToWrap.push(node);
          return;
        }

        if (node.nodeType === 1) {
          blockedByStructure = true;
        }
      });

      if (!nodesToWrap.length || blockedByStructure) return;
      if (nodesToWrap.length === 1 && nodesToWrap[0].nodeType === 1 && nodesToWrap[0].tagName === 'P') {
        if (!nodesToWrap[0].getAttribute('style')) nodesToWrap[0].setAttribute('style', 'margin:0;');
        return;
      }

      var p = document.createElement('p');
      p.setAttribute('style', 'margin:0;');
      li.insertBefore(p, nodesToWrap[0]);
      nodesToWrap.forEach(function (node) {
        p.appendChild(node);
      });
    });

    Array.from(container.querySelectorAll('span')).forEach(function (el) {
      if (el.attributes.length === 0) {
        while (el.firstChild) {
          el.parentNode.insertBefore(el.firstChild, el);
        }
        el.remove();
      }
    });

    Array.from(container.querySelectorAll('p,div,li,blockquote,figcaption')).forEach(function (el) {
      if (!el.querySelector('img,br,table,ul,ol,pre,code,figure,blockquote') && !el.textContent.trim()) {
        el.remove();
      }
    });

    isolateFormulaBlocksAfterImages(container);

    container.normalize();
    return container.innerHTML.trim();
  }

  function decodeFeishuAttribsToHtml(attribsStr, textStr, numToAttrib) {
    var result = [];
    var textIdx = 0;
    var i = 0;

    function wrapInlineHtml(segment, opts) {
      if (opts.inlineStyle) segment = '<span style="' + escapeAttr(opts.inlineStyle) + '">' + segment + '</span>';
      if (opts.isInlineCode) segment = '<code style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#f6f8fa;padding:0.1em 0.3em;border-radius:4px;">' + segment + '</code>';
      if (opts.isBold) segment = '<strong>' + segment + '</strong>';
      if (opts.isItalic) segment = '<em>' + segment + '</em>';
      if (opts.isStrike) segment = '<del>' + segment + '</del>';
      if (opts.linkHref) segment = '<a href="' + escapeAttr(opts.linkHref) + '">' + segment + '</a>';
      return segment;
    }

    while (i < attribsStr.length) {
      var attrs = [];
      while (i < attribsStr.length && attribsStr[i] === '*') {
        i++;
        var numStr = '';
        while (i < attribsStr.length && /[0-9a-z]/.test(attribsStr[i])) {
          numStr += attribsStr[i];
          i++;
        }
        var num = parseInt(numStr, 36);
        if (numToAttrib[num]) attrs.push(numToAttrib[num]);
      }

      if (i < attribsStr.length && attribsStr[i] === '+') {
        i++;
        var countStr = '';
        while (i < attribsStr.length && /[0-9a-z]/.test(attribsStr[i])) {
          countStr += attribsStr[i];
          i++;
        }
        var count = parseInt(countStr, 36);

        var equationAttr = null;
        var linkAttr = null;
        var isBold = false;
        var isItalic = false;
        var isStrike = false;
        var isInlineCode = false;
        var textColor = '';
        var backgroundColor = '';

        for (var ai = 0; ai < attrs.length; ai++) {
          var a = attrs[ai];
          if (a[0] === 'equation') equationAttr = a;
          else if (a[0] === 'link') linkAttr = a;
          else if (a[0] === 'bold' && a[1] === 'true') isBold = true;
          else if (a[0] === 'italic' && a[1] === 'true') isItalic = true;
          else if (a[0] === 'strikethrough' && a[1] === 'true') isStrike = true;
          else if (a[0] === 'inlineCode' && a[1] === 'true') isInlineCode = true;
          else if (a[0] === 'textHighlight') textColor = normalizeCssColor(a[1]);
          else if (a[0] === 'textHighlightBackground') backgroundColor = normalizeCssColor(a[1]);
        }

        var rawText = textStr.substring(textIdx, textIdx + count);

        if (equationAttr) {
          // Keep LaTeX as a raw text node so Feishu can re-parse it during HTML paste,
          // especially inside list items where wrapped spans tend to stay literal.
          var latex = normalizeEquationLatex(equationAttr[1]);
          result.push(escapeHtml('$' + latex + '$'));
        } else {
          var segment = escapeHtml(rawText).replace(/\n/g, '<br>');
          segment = wrapInlineHtml(segment, {
            isInlineCode: isInlineCode,
            isBold: isBold,
            isItalic: isItalic,
            isStrike: isStrike,
            linkHref: linkAttr ? decodeURIComponent(linkAttr[1] || '') : '',
            inlineStyle: buildInlineRichTextStyle({
              textColor: textColor,
              backgroundColor: backgroundColor,
            }),
          });
          result.push(segment);
        }

        textIdx += count;
      } else {
        break;
      }
    }

    if (textIdx < textStr.length) {
      result.push(escapeHtml(textStr.substring(textIdx)).replace(/\n/g, '<br>'));
    }

    return normalizeLatexHtmlTextNodes(result.join(''));
  }

  function decodeBlockHtml(snap) {
    if (!snap.text || !snap.text.initialAttributedTexts || !snap.text.apool) {
      return escapeHtml(decodeBlockText(snap));
    }
    var iat = snap.text.initialAttributedTexts;
    var apool = snap.text.apool;
    var attribs = (iat.attribs && iat.attribs['0']) || '';
    var text = (iat.text && iat.text['0']) || '';
    var numToAttrib = apool.numToAttrib || {};
    return decodeFeishuAttribsToHtml(attribs, text, numToAttrib);
  }

  function normalizeListHtmlFragment(html) {
    if (!html || html.indexOf('data-feishu-list=') === -1) return html;

    var container = document.createElement('div');
    container.innerHTML = html;

    function groupListChildren(node) {
      Array.from(node.children).forEach(function (child) {
        groupListChildren(child);
      });

      var index = 0;
      while (index < node.children.length) {
        var child = node.children[index];
        if (!child || child.tagName !== 'LI' || !child.hasAttribute('data-feishu-list')) {
          index++;
          continue;
        }

        var kind = child.getAttribute('data-feishu-list');
        var wrapper = document.createElement(kind === 'ordered' ? 'ol' : 'ul');
        wrapper.style.cssText = 'margin:0.75em 0;padding-left:1.6em;';
        node.insertBefore(wrapper, child);

        while (child && child.tagName === 'LI' && child.getAttribute('data-feishu-list') === kind) {
          var next = child.nextElementSibling;
          child.removeAttribute('data-feishu-list');
          wrapper.appendChild(child);
          child = next;
        }

        index++;
      }
    }

    groupListChildren(container);
    return container.innerHTML;
  }

  function finalizeHtmlFragment(html) {
    return sanitizeHtmlFragment(normalizeListHtmlFragment((html || '').trim()));
  }

  function buildClipboardHtml(bodyHtml) {
    var fragment = finalizeHtmlFragment(bodyHtml);
    return '<html><head><meta charset="utf-8"></head><body><!--StartFragment--><div data-feishu-helper="true">' + fragment + '</div><!--EndFragment--></body></html>';
  }

  function renderListItemHtml(kind, text, childHtml, snap, normalizedStyle) {
    var liStyle = buildBlockStyle('', snap, '', normalizedStyle);
    var pStyle = buildBlockStyle('margin:0;', snap, '', normalizedStyle);
    var textHtml = text ? '<p style="' + escapeAttr(pStyle) + '">' + text + '</p>' : '';
    if (!textHtml && !childHtml) return '';
    return '<li data-feishu-list="' + kind + '"' + (liStyle ? ' style="' + escapeAttr(liStyle) + '"' : '') + '>' + textHtml + childHtml + '</li>';
  }

  function blockToHtml(snap, block, childHtmlArr) {
    var type = snap.type;
    var text = decodeBlockHtml(snap);
    var childHtml = childHtmlArr ? finalizeHtmlFragment(childHtmlArr.join('\n')) : '';
    var normalizedBlockStyle = normalizeBlockStyle(snap);
    var headingTag = getHeadingTagName(type);

    if (headingTag) {
      return wrapWithStyleTag(headingTag, buildBlockStyle(DEFAULT_HEADING_STYLE, snap, '', normalizedBlockStyle), text);
    }

    switch (type) {
      case 'text':
        if (childHtml && text) return '<p style="' + escapeAttr(buildBlockStyle(DEFAULT_PARAGRAPH_STYLE, snap, '', normalizedBlockStyle)) + '">' + text + '</p>' + childHtml;
        if (childHtml) return childHtml;
        return '<p style="' + escapeAttr(buildBlockStyle(DEFAULT_PARAGRAPH_STYLE, snap, '', normalizedBlockStyle)) + '">' + text + '</p>';
      case 'ordered':
        return renderListItemHtml('ordered', text, childHtml, snap, normalizedBlockStyle);
      case 'bullet':
        return renderListItemHtml('bullet', text, childHtml, snap, normalizedBlockStyle);
      case 'todo':
        return renderListItemHtml('bullet', (snap.checked ? '☑ ' : '☐ ') + text, childHtml, snap, normalizedBlockStyle);
      case 'divider': return '<hr style="border:none;border-top:1px solid #d0d7de;margin:24px 0;">';
      case 'code':
        var lang = (snap.language || snap.lang || '').replace(/^plain_text$/, '');
        return '<pre style="' + escapeAttr(buildBlockStyle('margin:0.75em 0;background:#f6f8fa;padding:12px 16px;border-radius:8px;overflow:auto;white-space:pre-wrap;', snap, '', normalizedBlockStyle)) + '"><code' + (lang ? ' class="language-' + escapeAttr(lang) + '"' : '') + ' style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">' + escapeHtml(decodeBlockText(snap)) + '</code></pre>';
      case 'image':
        var imageAsset = getImageAssetInfo(snap.image);
        var caption = '';
        var imageAlign = resolveImageAlign(normalizedBlockStyle);
        var imageMargin = imageAlign === 'left' ? 'margin:0 auto 0 0;' : imageAlign === 'right' ? 'margin:0 0 0 auto;' : 'margin:0 auto;';
        if (snap.image && snap.image.caption && snap.image.caption.text) {
          var capText = decodeBlockHtml({ text: snap.image.caption.text });
          if (capText) caption = '<figcaption style="margin-top:8px;color:#57606a;font-size:13px;">' + capText + '</figcaption>';
        }
        return '<figure style="' + escapeAttr(buildBlockStyle('margin:1em 0;text-align:' + imageAlign + ';', snap, '', normalizedBlockStyle, { applyAlign: false })) + '"><img src="' + escapeAttr(imageAsset.src) + '" alt="' + escapeAttr(imageAsset.alt) + '" style="max-width:100%;height:auto;display:block;' + imageMargin + '" />' + caption + '</figure>';
      case 'callout':
        var emoji = getEmoji(normalizedBlockStyle.calloutEmojiId);
        var bgColor = normalizedBlockStyle.backgroundColor;
        var borderColor = normalizedBlockStyle.borderColor;
        var calloutTextHtml = text ? '<p style="margin:0;">' + text + '</p>' : '';
        var calloutBodyHtml = selectPrimaryCalloutContent(calloutTextHtml, childHtml);
        var calloutMeta = buildCalloutClipboardMetadata(snap, normalizedBlockStyle, {
          text: selectPrimaryCalloutContent(text, extractPlainTextFromHtmlFragment(childHtml)),
        });
        var containerStyle = buildBlockStyle('padding:12px 16px;border-radius:8px;margin:0.75em 0;', snap, styleObjectToString({
          border: borderColor ? '1px solid ' + borderColor : '',
          background: bgColor,
        }), normalizedBlockStyle);
        return '<div class="block docx-callout-block callout-container" data-block-type="callout" data-block-id="' + escapeAttr(calloutMeta.blockId) + '" data-record-id="' + escapeAttr(calloutMeta.recordId) + '" data-emoji-id="' + escapeAttr(normalizedBlockStyle.calloutEmojiId) + '" data-lark-record-data="' + escapeAttr(calloutMeta.recordData) + '" data-meta-block-props="' + escapeAttr(calloutMeta.metaBlockProps) + '"' + (containerStyle ? ' style="' + escapeAttr(containerStyle) + '"' : '') + '><div class="callout-block">' + (emoji ? '<span>' + emoji + '</span> ' : '') + calloutBodyHtml + '</div></div>';
      case 'quote_container':
        return '<blockquote style="' + escapeAttr(buildBlockStyle('margin:0.75em 0;border-left:4px solid #d0d7de;padding-left:1em;color:#57606a;', snap, '', normalizedBlockStyle)) + '">' + childHtml + '</blockquote>';
      case 'grid':
        return '<div style="display:flex;gap:12px;">' + childHtml + '</div>';
      case 'grid_column':
        var w = snap.width_ratio ? (snap.width_ratio * 100).toFixed(1) : '50';
        return '<div style="flex:' + w + '%;">' + childHtml + '</div>';
      case 'table':
        return tableToHtml(snap, block);
      case 'table_cell':
        return childHtml || '<p></p>';
      case 'diagram':
      case 'whiteboard':
      case 'synced_reference':
        return renderHtmlPlaceholder(SPECIAL_BLOCK_LABELS[type]);
      default:
        return text ? '<p style="' + DEFAULT_PARAGRAPH_STYLE + '">' + text + '</p>' : '';
    }
  }

  function tableToHtml(snap, block) {
    var matrix = buildTableMatrix(snap, block, decodeBlockHtml, function (parts) {
      return finalizeHtmlFragment(parts.join('<br>'));
    });
    if (!matrix) return '';

    var html = '<table border="1" cellpadding="6" cellspacing="0" style="width:100%;border-collapse:collapse;font-size:14px;margin:0.75em 0;">';
    matrix.rows.forEach(function (row) {
      html += '<tr>';
      row.forEach(function (cellContent) {
        html += '<td style="border:1px solid #d0d7de;padding:8px 10px;vertical-align:top;">' + cellContent + '</td>';
      });
      html += '</tr>';
    });

    html += '</table>';
    return html;
  }

  function blockToMarkdown(snap, block, childMdArr) {
    var type = snap.type;
    var text = decodeBlockText(snap);
    var childMd = childMdArr ? childMdArr.join('\n') : '';
    var headingPrefix = getHeadingMarkdownPrefix(type);

    if (headingPrefix) {
      return headingPrefix + ' ' + text;
    }

    switch (type) {
      case 'text':
        if (childMd) return text + '\n' + childMd;
        return text;
      case 'ordered':
        return renderMarkdownListItem('1. ', text, childMd);
      case 'bullet':
        return renderMarkdownListItem('- ', text, childMd);
      case 'todo': return (snap.checked ? '[x]' : '[ ]') + ' ' + text;
      case 'divider': return '---';
      case 'code':
        var lang = (snap.language || snap.lang || '').replace(/^plain_text$/, '');
        return '```' + lang + '\n' + text + '\n```';
      case 'image':
        var imageAsset = getImageAssetInfo(snap.image);
        return '![' + imageAsset.alt + '](' + imageAsset.src + ')';
      case 'callout':
        var calloutType = getCalloutMarkdownType(snap);
        var calloutLines = ['[!' + calloutType + ']'];
        var calloutContent = selectPrimaryCalloutContent(text, childMd);
        if (calloutContent) calloutLines.push(calloutContent);
        return renderMarkdownBlockquote(calloutLines.join('\n'));
      case 'quote_container':
        return renderMarkdownBlockquote(childMd);
      case 'grid':
        return childMd;
      case 'grid_column':
        return childMd;
      case 'table':
        return tableToMarkdown(snap, block);
      case 'table_cell':
        return childMd;
      case 'diagram':
      case 'whiteboard':
      case 'synced_reference':
        return renderMarkdownPlaceholder(SPECIAL_BLOCK_LABELS[type]);
      default:
        return text;
    }
  }

  function tableToMarkdown(snap, block) {
    var matrix = buildTableMatrix(snap, block, decodeBlockText, function (parts) {
      return parts.join(' ').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    });
    if (!matrix) return '';

    var md = '| ' + matrix.cols.map(function() { return ''; }).join(' | ') + ' |\n';
    md += '| ' + matrix.cols.map(function() { return '---'; }).join(' | ') + ' |\n';
    matrix.rows.forEach(function (row) {
      md += '| ' + row.join(' | ') + ' |\n';
    });

    return md.trim();
  }

  function normalizePlainText(text) {
    return text
      .split(/(```[\s\S]*?```)/g)
      .map(function (part) {
        if (part.startsWith('```') && part.endsWith('```')) return part;
        return part
          .replace(/[\u200B\u200C\u200D\uFEFF]/g, '')
          .replace(/\r\n/g, '\n')
          .replace(/^[ \t]+$/gm, '')
          .replace(/[ \t]+\n/g, '\n')
          .replace(/\n{3,}/g, '\n\n');
      })
      .join('')
      .replace(/^\n+/, '')
      .replace(/\n+$/, '');
  }

  function extractVisibleDomFallback() {
    var root = getContentRootElement() || document.querySelector(EDITABLE_SELECTOR);
    if (!root) {
      updateLastExtractionDebug({
        mode: 'dom-fallback',
        reason: 'missing-content-root',
        href: location.href,
        readyState: document.readyState,
        hasContentRoot: false,
        hasEditorAPI: !!getEditorAPI(),
        hasStructService: !!getStructService(),
        hasRootBlock: !!(getStructService() && getStructService().rootBlock),
      });
      return null;
    }

    var text = normalizePlainText(root.innerText || root.textContent || '');
    var html = finalizeHtmlFragment(root.innerHTML || '');
    var documentImageCount = countDocumentImagesInRoot(root);
    var fallbackEquationCount = countFallbackEquationNodes(root) || (text.match(/\$/g) || []).length;
    if (!text && !html) {
      updateLastExtractionDebug({
        mode: 'dom-fallback',
        reason: 'empty-dom-content',
        href: location.href,
        readyState: document.readyState,
        hasContentRoot: true,
        contentRootTag: String(root.tagName || ''),
        contentRootTextLength: 0,
        contentRootHtmlLength: 0,
        contentRootImageCount: documentImageCount,
        contentRootMathLikeCount: root.querySelectorAll('math, mjx-container, [data-latex], .katex, [class*="equation"], [class*="formula"]').length,
      });
      return null;
    }

    var blockCount = text ? text.split('\n').filter(function (line) {
      return line.trim();
    }).length : 0;

    var result = {
      html: html || '<p>' + escapeHtml(text).replace(/\n/g, '<br>') + '</p>',
      text: text,
      blockCount: Math.max(1, blockCount),
      equationCount: fallbackEquationCount,
    };

    result.extractionDebug = updateLastExtractionDebug({
      mode: 'dom-fallback',
      reason: 'missing-struct-service-or-root-block',
      href: location.href,
      readyState: document.readyState,
      hasContentRoot: true,
      contentRootTag: String(root.tagName || ''),
      contentRootTextLength: text.length,
      contentRootHtmlLength: html.length,
      contentRootImageCount: documentImageCount,
      contentRootMathLikeCount: root.querySelectorAll('math, mjx-container, [data-latex], .katex, [class*="equation"], [class*="formula"]').length,
      hasEditorAPI: !!getEditorAPI(),
      hasStructService: !!getStructService(),
      hasRootBlock: !!(getStructService() && getStructService().rootBlock),
      fallbackBlockCount: Math.max(1, blockCount),
      fallbackEquationCount: result.equationCount,
      fallbackHtmlImageCount: countDocumentImagesInHtml(result.html),
      fallbackMarkdownImageCount: (text.match(/!\[/g) || []).length,
      textPreview: summarizeDebugText(text, 240),
    });

    return result;
  }

  function extractFullDoc() {
    var ss = getStructService();
    if (!ss || !ss.rootBlock) return extractVisibleDomFallback();

    var root = getContentRootElement() || document.querySelector(EDITABLE_SELECTOR);
    var htmlParts = [];
    var mdParts = [];
    var blockCount = 0;
    var equationCount = 0;
    var blockTypeCounts = {};
    var imageBlockCount = 0;
    var equationBlockCount = 0;

    function processBlock(block, depth) {
      if (!block || depth > MAX_BLOCK_DEPTH) return;
      if (block.record && block.record.snapshot) {
        var snap = block.record.snapshot;
        var type = snap.type;

        if (type === 'page') {
          getBlockChildren(block).forEach(function (child) {
            processBlock(child, depth + 1);
          });
          return;
        }

        blockTypeCounts[type] = (blockTypeCounts[type] || 0) + 1;
        var childContent = collectRenderedChildBlocks(block, depth, processBlockInner);

        var decoded = decodeBlockText(snap);
        if (type === 'image') imageBlockCount++;
        if (decoded.includes('$')) {
          equationCount++;
          equationBlockCount++;
        }

        var html = blockToHtml(snap, block, childContent.html);
        var md = blockToMarkdown(snap, block, childContent.md);

        if (html) htmlParts.push(html);
        if (md) mdParts.push(md);
        blockCount++;
        return;
      }
      getBlockChildren(block).forEach(function (child) {
        processBlock(child, depth + 1);
      });
    }

    function processBlockInner(block, depth) {
      if (!block || depth > MAX_BLOCK_DEPTH) return null;
      if (!block.record || !block.record.snapshot) return null;

      var snap = block.record.snapshot;
      var childContent = collectRenderedChildBlocks(block, depth, processBlockInner);

      var html = blockToHtml(snap, block, childContent.html);
      var md = blockToMarkdown(snap, block, childContent.md);

      return { html: html, md: md };
    }

    processBlock(ss.rootBlock, 0);

    var finalHtml = finalizeHtmlFragment(htmlParts.join('\n'));
    var finalText = normalizePlainText(mdParts.join('\n'));
    var result = {
      html: finalHtml,
      text: finalText,
      blockCount: blockCount,
      equationCount: equationCount,
    };

    result.extractionDebug = updateLastExtractionDebug({
      mode: 'struct',
      reason: 'struct-service',
      href: location.href,
      readyState: document.readyState,
      hasContentRoot: !!root,
      contentRootTag: root ? String(root.tagName || '') : '',
      contentRootTextLength: root ? String(root.innerText || root.textContent || '').length : 0,
      contentRootHtmlLength: root ? String(root.innerHTML || '').length : 0,
      contentRootImageCount: root ? countDocumentImagesInRoot(root) : 0,
      contentRootMathLikeCount: root ? root.querySelectorAll('math, mjx-container, [data-latex], .katex, [class*="equation"], [class*="formula"]').length : 0,
      hasEditorAPI: !!getEditorAPI(),
      hasStructService: true,
      hasRootBlock: true,
      rootBlockType: ss.rootBlock && ss.rootBlock.record && ss.rootBlock.record.snapshot ? String(ss.rootBlock.record.snapshot.type || '') : '',
      rootChildCount: getBlockChildren(ss.rootBlock).length,
      blockCount: blockCount,
      equationCount: equationCount,
      equationBlockCount: equationBlockCount,
      imageBlockCount: imageBlockCount,
      markdownImageCount: (finalText.match(/!\[/g) || []).length,
      htmlImageCount: countDocumentImagesInHtml(finalHtml),
      blockTypeCounts: blockTypeCounts,
      textPreview: summarizeDebugText(finalText, 240),
    });

    return result;
  }

  var DB_NAME = '__feishu_helper_db__';
  var DB_STORE = 'paste';
  var DB_KEY = 'pending';
  var lastExtractionDebug = null;
  var imageConversionStatus = {
    state: 'idle',
    done: 0,
    total: 0,
    updatedAt: 0,
    error: '',
  };
  var lastPendingPasteTimestamp = 0;

  function updateImageConversionStatus(patch) {
    imageConversionStatus = Object.assign({}, imageConversionStatus, patch || {}, {
      updatedAt: Date.now(),
    });
    // Sync to DOM for cross-context visibility (AppleScript JS context).
    try {
      document.documentElement.setAttribute('data-feishu-img-conv-status', JSON.stringify(imageConversionStatus));
    } catch (e) {}
    return imageConversionStatus;
  }

  function getImageConversionStatus() {
    return Object.assign({}, imageConversionStatus);
  }

  function updateLastExtractionDebug(summary) {
    lastExtractionDebug = Object.assign({
      ts: Date.now(),
    }, summary || {});
    console.info('[Feishu Helper] extraction debug', lastExtractionDebug);
    // Sync to DOM for cross-context visibility (AppleScript JS context).
    try {
      document.documentElement.setAttribute('data-feishu-extraction-debug-ts', String(lastExtractionDebug.ts));
    } catch (e) {}
    return lastExtractionDebug;
  }

  function getLastExtractionDebug() {
    return lastExtractionDebug ? Object.assign({}, lastExtractionDebug) : null;
  }

  function openDB() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        req.result.createObjectStore(DB_STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function getPendingPaste() {
    return openDB().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction(DB_STORE, 'readonly');
        var req = tx.objectStore(DB_STORE).get(DB_KEY);
        req.onsuccess = function () {
          var data = req.result;
          if (data && data.ts && Date.now() - data.ts < 3600000) {
            resolve(data);
          } else {
            if (data) {
              var dtx = db.transaction(DB_STORE, 'readwrite');
              dtx.objectStore(DB_STORE).delete(DB_KEY);
            }
            resolve(null);
          }
        };
        req.onerror = function () { resolve(null); };
      });
    }).catch(function () { return null; });
  }

  function setPendingPaste(data) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        data.ts = Date.now();
        lastPendingPasteTimestamp = data.ts;
        // Write to a DOM attribute so AppleScript's execute javascript
        // (which runs in a separate JS context) can read the value.
        // window properties are NOT shared across Chrome's isolated worlds,
        // but DOM attributes are.
        try {
          document.documentElement.setAttribute('data-feishu-pending-paste-ts', String(data.ts));
        } catch (e) {}
        var tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).put(data, DB_KEY);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    }).catch(function () {});
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve) {
      var reader = new FileReader();
      reader.onloadend = function () { resolve(reader.result); };
      reader.readAsDataURL(blob);
    });
  }

  function fetchImageAsBase64(url) {
    return fetch(url, { credentials: 'include' })
      .then(function (r) {
        if (!r.ok) return null;
        return r.blob();
      })
      .then(function (blob) {
        if (!blob) return null;
        return blobToBase64(blob);
      })
      .catch(function () { return null; });
  }

  function convertImagesToBase64(html) {
    var imgUrls = [];
    var urlRegex = /src="(https?:\/\/[^"]+\/space\/api\/box\/stream\/download\/[^"]+)"/g;
    var match;
    while ((match = urlRegex.exec(html)) !== null) {
      imgUrls.push({ url: match[1], full: match[0] });
    }

    if (imgUrls.length === 0) {
      updateImageConversionStatus({
        state: 'no-images',
        done: 0,
        total: 0,
        error: '',
      });
      return Promise.resolve(html);
    }

    var done = 0;
    var total = imgUrls.length;
    updateImageConversionStatus({
      state: 'running',
      done: 0,
      total: total,
      error: '',
    });

    showToast('📷 转换图片中 0/' + total);

    var promises = imgUrls.map(function (item) {
      return function () {
        return fetchImageAsBase64(item.url).then(function (base64) {
          done++;
          updateImageConversionStatus({
            state: done >= total ? 'done' : 'running',
            done: done,
            total: total,
            error: '',
          });
          showToast('📷 转换图片中 ' + done + '/' + total);
          if (base64) {
            html = html.replace(item.full, 'src="' + base64 + '"');
          }
        });
      };
    });

    var batchSize = 5;
    var chain = Promise.resolve();
    for (var i = 0; i < promises.length; i += batchSize) {
      (function (batch) {
        chain = chain.then(function () {
          return Promise.all(batch.map(function (fn) { return fn(); }));
        });
      })(promises.slice(i, i + batchSize));
    }

    return chain.then(function () {
      updateImageConversionStatus({
        state: 'done',
        done: total,
        total: total,
        error: '',
      });
      return html;
    }).catch(function (error) {
      updateImageConversionStatus({
        state: 'error',
        done: done,
        total: total,
        error: String(error && error.message ? error.message : error),
      });
      throw error;
    });
  }

  function buildExportHtml(title, bodyHtml) {
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + title + '</title>' +
      '<style>' +
      'body{max-width:960px;margin:0 auto;padding:40px 48px;font:16px/1.75 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#1f2329;background:#fff;}' +
      'h1,h2,h3,h4,h5,h6{line-height:1.35;margin:1.2em 0 0.6em;}' +
      'p,li,blockquote,pre,table,figure{margin:0.75em 0;}' +
      'ul,ol{padding-left:1.6em;}' +
      'blockquote{border-left:4px solid #d0d7de;padding-left:1em;color:#57606a;}' +
      'pre{background:#f6f8fa;padding:12px 16px;border-radius:8px;overflow:auto;white-space:pre-wrap;}' +
      'code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}' +
      'table{width:100%;border-collapse:collapse;font-size:14px;}' +
      'td,th{border:1px solid #d0d7de;padding:8px 10px;vertical-align:top;}' +
      'img{max-width:100%;height:auto;display:block;margin:0 auto;}' +
      'figure{margin:1em 0;text-align:center;}' +
      'figcaption{margin-top:8px;color:#57606a;font-size:13px;}' +
      'hr{border:none;border-top:1px solid #d0d7de;margin:24px 0;}' +
      '@page{size:auto;margin:16mm 14mm;}' +
      '@media print{body{padding:0;}a{text-decoration:none;color:inherit;}}' +
      '</style></head><body>' + bodyHtml + '</body></html>';
  }

  function downloadTextFile(filename, content, mimeType) {
    var blob = new Blob([content], { type: mimeType || 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function getTopAccessibleDocument() {
    try {
      if (window.top && window.top.document) return window.top.document;
    } catch (err) {}
    return document;
  }

  function showToast(msg, duration) {
    var toastDoc = getTopAccessibleDocument();
    var existing = toastDoc.getElementById('__feishu_toast__');
    if (existing) existing.remove();

    var toast = toastDoc.createElement('div');
    toast.id = '__feishu_toast__';
    toast.style.cssText = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.85);color:#fff;padding:10px 20px;border-radius:8px;font-size:14px;z-index:2147483647;pointer-events:none;transition:opacity 0.3s;white-space:nowrap;box-shadow:0 10px 30px rgba(0,0,0,0.2);';
    toast.textContent = msg;
    console.info('[Feishu Helper]', msg);
    (toastDoc.body || toastDoc.documentElement).appendChild(toast);

    if (duration !== 0) {
      setTimeout(function () {
        toast.style.opacity = '0';
        setTimeout(function () { toast.remove(); }, 300);
      }, duration || 2000);
    }
  }

  function duplicateDocument() {
    duplicateDocumentForAutomation().catch(function () {});
  }

  function duplicateDocumentForAutomation() {
    var token = getDocToken();
    if (!token) {
      showToast('⚠️ 无法识别当前文档');
      return Promise.reject(new Error('无法识别当前文档'));
    }

    showToast('⏳ 提取文档中...', 0);
    return new Promise(function (resolve, reject) {
      setTimeout(function () {
        var content = extractFullDoc();
        if (!content) {
          showToast('⚠️ 提取失败，请确保文档已加载');
          reject(new Error('提取失败，请确保文档已加载'));
          return;
        }

        var docTitle = getDocumentTitle();
        buildClipboardPayload(content).then(function (payload) {
          return setPendingPaste({
            html: content.html,
            text: content.text,
            clipboardHtml: payload.html,
            title: docTitle,
          }).then(function () {
            var imgCount = countExtractedImages(content);
            var inlinedImgCount = (payload.html.match(/data:image/g) || []).length;
            showToast('✅ 已提取 ' + content.blockCount + ' 块 · ' + content.equationCount + ' 公式 · ' + imgCount + ' 图片 · 已缓存 ' + inlinedImgCount + ' 张', 3200);
            var result = {
              title: docTitle,
              blockCount: Number(content.blockCount || 0),
              equationCount: Number(content.equationCount || 0),
              imageCount: imgCount,
              inlinedImageCount: inlinedImgCount,
              textLen: String(content.text || '').length,
              htmlLen: String(content.html || '').length,
              clipboardHtmlLen: String(payload.html || '').length,
              extractionDebug: content.extractionDebug || getLastExtractionDebug(),
            };
            // Sync extraction result to DOM for cross-context visibility.
            try {
              var snap = captureValidationSnapshot();
              document.documentElement.setAttribute('data-feishu-extraction-result', JSON.stringify({
                title: result.title,
                blockCount: result.blockCount,
                equationCount: result.equationCount,
                imageCount: result.imageCount,
                inlinedImageCount: result.inlinedImageCount,
                textLen: result.textLen,
                htmlLen: result.htmlLen,
                clipboardHtmlLen: result.clipboardHtmlLen,
                payloadError: false,
                ts: Date.now(),
              }));
              if (snap) {
                document.documentElement.setAttribute('data-feishu-validation-snapshot', JSON.stringify({
                  title: snap.title || '',
                  blockCount: Number(snap.blockCount || 0),
                  equationCount: Number(snap.equationCount || 0),
                  textLength: Number(snap.textLength || 0),
                  htmlLength: Number(snap.htmlLength || 0),
                  styleSummary: snap.styleSummary || null,
                }));
              }
            } catch (e) {}
            resolve(result);
          });
        }).catch(function () {
          setPendingPaste({ html: content.html, text: content.text, title: docTitle }).then(function () {
            var imgCount = countExtractedImages(content);
            showToast('⚠️ 内容已提取，但图片预处理失败，粘贴时可能退回纯文本 · ' + imgCount + ' 图片', 3500);
            var result = {
              title: docTitle,
              blockCount: Number(content.blockCount || 0),
              equationCount: Number(content.equationCount || 0),
              imageCount: imgCount,
              inlinedImageCount: 0,
              textLen: String(content.text || '').length,
              htmlLen: String(content.html || '').length,
              clipboardHtmlLen: 0,
              payloadError: true,
              extractionDebug: content.extractionDebug || getLastExtractionDebug(),
            };
            // Sync extraction result to DOM for cross-context visibility.
            try {
              var snap = captureValidationSnapshot();
              document.documentElement.setAttribute('data-feishu-extraction-result', JSON.stringify({
                title: result.title,
                blockCount: result.blockCount,
                equationCount: result.equationCount,
                imageCount: result.imageCount,
                inlinedImageCount: result.inlinedImageCount,
                textLen: result.textLen,
                htmlLen: result.htmlLen,
                clipboardHtmlLen: result.clipboardHtmlLen,
                payloadError: true,
                ts: Date.now(),
              }));
              if (snap) {
                document.documentElement.setAttribute('data-feishu-validation-snapshot', JSON.stringify({
                  title: snap.title || '',
                  blockCount: Number(snap.blockCount || 0),
                  equationCount: Number(snap.equationCount || 0),
                  textLength: Number(snap.textLength || 0),
                  htmlLength: Number(snap.htmlLength || 0),
                  styleSummary: snap.styleSummary || null,
                }));
              }
            } catch (e) {}
            resolve(result);
          });
        });
      }, 50);
    });
  }

  function dispatchAutomationResult(detail) {
    try {
      window.dispatchEvent(new CustomEvent(AUTOMATION_RESULT_EVENT, {
        detail: detail,
      }));
    } catch (err) {}
  }

  function summarizePendingPasteForAutomation() {
    return getPendingPaste().then(function (pending) {
      if (!pending) return null;
      return {
        title: String(pending.title || ''),
        textLen: String(pending.text || '').length,
        htmlLen: String(pending.html || '').length,
        clipboardHtmlLen: String(pending.clipboardHtml || '').length,
        ts: Number(pending.ts || 0),
      };
    });
  }

  function getPendingPasteTimestamp() {
    return lastPendingPasteTimestamp;
  }

  function buildRealTestDuplicateDocumentSummary() {
    return duplicateDocumentForAutomation().then(function (summary) {
      return summarizePendingPasteForAutomation().then(function (pendingPaste) {
        var result = {};
        var validationSnapshot = captureValidationSnapshot();
        Object.keys(summary || {}).forEach(function (key) {
          result[key] = summary[key];
        });
        if (validationSnapshot) {
          result.validationSnapshot = validationSnapshot;
        }
        if (pendingPaste) {
          result.pendingPaste = pendingPaste;
        } else {
          result.pendingError = 'Pending paste cache was not updated.';
        }
        return result;
      });
    });
  }

  function collectValidationStyleSummary() {
    var summary = {
      blockCount: 0,
      countsByType: {},
      blocks: [],
    };
    var ss = getStructService();
    if (!ss || !ss.rootBlock) return summary;

    function walk(block, depth) {
      if (!block || depth > MAX_BLOCK_DEPTH) return;
      if (block.record && block.record.snapshot) {
        var snap = block.record.snapshot;
        if (snap.type && snap.type !== 'page') {
          var normalizedStyle = normalizeBlockStyle(snap);
          summary.blockCount += 1;
          summary.countsByType[snap.type] = (summary.countsByType[snap.type] || 0) + 1;
          summary.blocks.push({
            type: String(snap.type || ''),
            align: String(normalizedStyle.align || ''),
            textIndent: String(normalizedStyle.textIndent || ''),
            textColor: String(normalizedStyle.textColor || ''),
            backgroundColor: String(normalizedStyle.backgroundColor || ''),
            borderColor: String(normalizedStyle.borderColor || ''),
            calloutEmojiId: String(normalizedStyle.calloutEmojiId || ''),
            imageAlign: String(normalizedStyle.imageAlign || ''),
          });
        }
      }
      getBlockChildren(block).forEach(function (child) {
        walk(child, depth + 1);
      });
    }

    walk(ss.rootBlock, 0);
    return summary;
  }

  function captureValidationSnapshot() {
    var content = extractFullDoc();
    if (!content) {
      return null;
    }

    var snap = {
      title: getDocumentTitle(),
      text: String(content.text || ''),
      textLength: String(content.text || '').length,
      htmlLength: String(content.html || '').length,
      blockCount: Number(content.blockCount || 0),
      equationCount: Number(content.equationCount || 0),
      extractionDebug: content.extractionDebug || getLastExtractionDebug(),
      styleSummary: collectValidationStyleSummary(),
    };
    // Sync to DOM for cross-context visibility (AppleScript JS context).
    try {
      document.documentElement.setAttribute('data-feishu-validation-snapshot', JSON.stringify({
        title: snap.title || '',
        blockCount: Number(snap.blockCount || 0),
        equationCount: Number(snap.equationCount || 0),
        textLength: Number(snap.textLength || 0),
        htmlLength: Number(snap.htmlLength || 0),
        styleSummary: snap.styleSummary || null,
      }));
    } catch (e) {}
    return snap;
  }

  function preparePendingPasteForNativePaste() {
    return getPendingPaste().then(function (pendingPaste) {
      if (!pendingPaste) {
        throw new Error('请先在源文档按 Cmd+Shift+D 提取');
      }

      return resolvePastePayload(pendingPaste).then(function (payload) {
        return writeClipboardPayload(payload).then(function () {
          return {
            title: String(pendingPaste.title || ''),
            textLength: String(payload && payload.text || '').length,
            htmlLength: String(payload && payload.html || '').length,
            requiresNativePaste: payloadRequiresPasteParsing(payload),
            canAutoDispatch: shouldAutoDispatchPastePayload(payload),
          };
        });
      });
    });
  }

  function runAutomationAction(action) {
    var handlers = {
      duplicateDocument: duplicateDocumentForAutomation,
      realTestDuplicateDocument: buildRealTestDuplicateDocumentSummary,
    };
    var handler = handlers[String(action || '')];
    if (!handler) {
      return Promise.reject(new Error('Unsupported automation action: ' + String(action || '')));
    }
    return handler();
  }

  function onAutomationRequest(event) {
    var detail = event && event.detail ? event.detail : {};
    if (!detail.requestId) return;

    runAutomationAction(detail.action).then(function (summary) {
      dispatchAutomationResult({
        requestId: detail.requestId,
        status: 'success',
        summary: summary,
      });
    }).catch(function (error) {
      dispatchAutomationResult({
        requestId: detail.requestId,
        status: 'error',
        error: String(error && error.stack ? error.stack : error),
      });
    });
  }

  function exportDocumentAsHtml() {
    withExtractedDocument('⏳ 导出 HTML 中...', '⚠️ 导出失败，请确保文档已加载', function (content, docTitle) {
      convertImagesToBase64(content.html).then(function (htmlWithImages) {
        var fullHtml = buildExportHtml(docTitle, htmlWithImages);
        var safeName = docTitle.replace(/[\\/:*?"<>|]/g, '_').trim() || 'feishu-export';
        downloadTextFile(safeName + '.html', fullHtml, 'text/html;charset=utf-8');
        var imgCount = (htmlWithImages.match(/data:image/g) || []).length;
        showToast('✅ 已导出 HTML · ' + content.blockCount + ' 块 · ' + content.equationCount + ' 公式 · ' + imgCount + ' 图片', 3000);
      }).catch(function () {
        showToast('⚠️ 导出 HTML 失败', 3000);
      });
    });
  }

  function isEditableElement(el) {
    if (!el || el.nodeType !== 1) return false;
    return el.matches(EDITABLE_SELECTOR);
  }

  function closestEditableElement(node) {
    var el = node && node.nodeType === 1 ? node : node && node.parentElement;
    while (el) {
      if (isEditableElement(el)) return el;
      el = el.parentElement;
    }
    return null;
  }

  function isVisibleElement(el) {
    if (!el || el.nodeType !== 1) return false;
    var rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function getEditableCandidates() {
    var seen = new Set();
    var result = [];

    function push(el) {
      if (!el || seen.has(el)) return;
      seen.add(el);
      result.push(el);
    }

    push(closestEditableElement(document.activeElement));

    var selection = window.getSelection && window.getSelection();
    if (selection) {
      push(closestEditableElement(selection.anchorNode));
      push(closestEditableElement(selection.focusNode));
    }

    document.querySelectorAll(
      EDITABLE_SELECTOR
    ).forEach(function (el) {
      push(el);
    });

    return result.filter(isVisibleElement);
  }

  function getActiveBodyEditor() {
    var candidates = getEditableCandidates();
    return candidates.length ? candidates[0] : null;
  }

  function buildClipboardPayload(content) {
    var text = content && content.text ? content.text : '';
    var preparedHtml = content && content.clipboardHtml ? content.clipboardHtml : '';
    var html = content && content.html ? content.html : '';
    if (preparedHtml) {
      return Promise.resolve({
        text: text,
        html: preparedHtml,
      });
    }
    if (!html) {
      return Promise.resolve({
        text: text,
        html: '',
      });
    }

    return convertImagesToBase64(html).then(function (htmlWithImages) {
      return {
        text: text,
        html: buildClipboardHtml(htmlWithImages),
      };
    }).catch(function () {
      return {
        text: text,
        html: buildClipboardHtml(html),
      };
    });
  }

  function writeClipboardPayloadWithExecCommand(payload) {
    return new Promise(function (resolve, reject) {
      var handled = false;
      var text = payload && payload.text ? payload.text : '';
      var html = payload && payload.html ? payload.html : '';

      function cleanup() {
        document.removeEventListener('copy', onCopy, true);
      }

      function onCopy(e) {
        handled = true;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.clipboardData) {
          if (text) e.clipboardData.setData('text/plain', text);
          if (html) e.clipboardData.setData('text/html', html);
        }
      }

      document.addEventListener('copy', onCopy, true);

      try {
        var ok = document.execCommand('copy');
        cleanup();
        if (handled || ok) {
          resolve();
          return;
        }
      } catch (err) {
        cleanup();
      }

      reject(new Error('execCommand copy failed'));
    });
  }

  function writeClipboardPayload(payload) {
    var text = payload && payload.text ? payload.text : '';
    var html = payload && payload.html ? payload.html : '';
    var clipboardData = {};

    if (text) clipboardData['text/plain'] = new Blob([text], { type: 'text/plain' });
    if (html) clipboardData['text/html'] = new Blob([html], { type: 'text/html' });

    if (!Object.keys(clipboardData).length) {
      return Promise.reject(new Error('clipboard payload empty'));
    }

    if (navigator.clipboard && navigator.clipboard.write && typeof ClipboardItem !== 'undefined') {
      return navigator.clipboard.write([new ClipboardItem(clipboardData)]).catch(function () {
        return writeClipboardPayloadWithExecCommand(payload);
      });
    }

    return writeClipboardPayloadWithExecCommand(payload);
  }

  function resolvePastePayload(content) {
    var preparedPayload = {
      text: content && content.text ? content.text : '',
      html: content && content.clipboardHtml ? content.clipboardHtml : '',
    };

    if (preparedPayload.html || !(content && content.html)) {
      return Promise.resolve(preparedPayload);
    }

    return buildClipboardPayload(content);
  }

  function getPastePayloadHandlingMode(payload) {
    var text = payload && payload.text ? payload.text : '';
    var html = payload && payload.html ? payload.html : '';
    var source = text + '\n' + html;
    var hasFeishuCalloutHtml = payloadHasFeishuCalloutHtml(payload);
    var requiresNativeParsing = !hasFeishuCalloutHtml && (
      /^\s*>\s*\[!(NOTE|WARNING|TIP|CAUTION|IMPORTANT|SUCCESS|INFO)\]/mi.test(source) ||
      /(^|[^\\])\$\$?[\s\S]+?\$\$?/.test(source) ||
      /\\\([\s\S]+?\\\)/.test(source) ||
      /\\\[[\s\S]+?\\\]/.test(source)
    );

    // Any LaTeX-like marker should go through Feishu's native paste parser.
    // Direct DOM insertion preserves the literal "$...$" text but does not
    // trigger the editor's formula conversion, which is most visible in lists.
    if (hasFeishuCalloutHtml) {
      return {
        mode: 'dispatchPasteEvent',
        requiresNativeParsing: false,
      };
    }

    return {
      mode: requiresNativeParsing ? 'nativePaste' : 'autoDispatch',
      requiresNativeParsing: requiresNativeParsing,
    };
  }

  function payloadRequiresPasteParsing(payload) {
    return getPastePayloadHandlingMode(payload).requiresNativeParsing;
  }

  function payloadHasFeishuCalloutHtml(payload) {
    var html = payload && payload.html ? payload.html : '';
    if (!html) return false;
    return /data-block-type=("|')callout\1/i.test(html) &&
      /data-lark-record-data=/i.test(html) &&
      /data-meta-block-props=/i.test(html);
  }

  function extractInsertionHtml(html) {
    html = html || '';
    if (!html) return '';

    var fragmentMatch = html.match(/<!--StartFragment-->([\s\S]*?)<!--EndFragment-->/i);
    if (fragmentMatch) return fragmentMatch[1];

    try {
      var doc = new DOMParser().parseFromString(html, 'text/html');
      return doc && doc.body ? doc.body.innerHTML : html;
    } catch (err) {
      return html;
    }
  }

  function ensureEditorSelection(editor) {
    var selection = window.getSelection && window.getSelection();
    if (!selection) return;

    if (selection.rangeCount > 0) {
      var range = selection.getRangeAt(0);
      var anchorNode = range.commonAncestorContainer;
      if (editor.contains(anchorNode) || anchorNode === editor) {
        return;
      }
    }

    var newRange = document.createRange();
    newRange.selectNodeContents(editor);
    newRange.collapse(false);
    selection.removeAllRanges();
    selection.addRange(newRange);
  }

  function insertHtmlFragmentIntoEditor(editor, htmlFragment, textFallback) {
    if (!editor || !htmlFragment) return false;

    editor.focus();
    ensureEditorSelection(editor);

    var selection = window.getSelection && window.getSelection();
    if (!selection || selection.rangeCount === 0) return false;

    var range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer) && range.commonAncestorContainer !== editor) {
      ensureEditorSelection(editor);
      if (!selection.rangeCount) return false;
      range = selection.getRangeAt(0);
    }

    try {
      var fragment = range.createContextualFragment(htmlFragment);
      var lastNode = fragment.lastChild;
      range.deleteContents();
      range.insertNode(fragment);
      if (lastNode) {
        range.setStartAfter(lastNode);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      try {
        editor.dispatchEvent(new InputEvent('input', {
          inputType: 'insertFromPaste',
          bubbles: true,
          cancelable: false,
          data: textFallback || '',
        }));
      } catch (err) {}
      return true;
    } catch (err) {
      return false;
    }
  }

  function tryInsertPayloadIntoEditor(payload) {
    if (payloadRequiresPasteParsing(payload)) {
      return null;
    }

    var htmlFragment = extractInsertionHtml(payload && payload.html ? payload.html : '');
    var text = payload && payload.text ? payload.text : '';
    var candidates = getEditableCandidates();

    for (var i = 0; i < candidates.length; i++) {
      var editor = candidates[i];
      if (!editor) continue;

      editor.focus();
      ensureEditorSelection(editor);

      if (htmlFragment) {
        try {
          var okHtml = document.execCommand('insertHTML', false, htmlFragment);
          if (okHtml) return { ok: true, mode: 'insertHTML', editor: editor };
        } catch (err) {}

        if (insertHtmlFragmentIntoEditor(editor, htmlFragment, text)) {
          return { ok: true, mode: 'domInsert', editor: editor };
        }
      }

      if (text) {
        try {
          var okText = document.execCommand('insertText', false, text);
          if (okText) return { ok: true, mode: 'insertText', editor: editor };
        } catch (err) {}
      }
    }

    return null;
  }

  function insertPayloadIntoEditor(payload) {
    return !!tryInsertPayloadIntoEditor(payload);
  }

  function shouldAutoDispatchPastePayload(payload) {
    return getPastePayloadHandlingMode(payload).mode !== 'nativePaste';
  }

  function describePasteMode(mode) {
    if (mode === 'insertHTML') return '直接插入 HTML';
    if (mode === 'domInsert') return '直接写入 DOM';
    if (mode === 'insertText') return '直接插入纯文本';
    if (mode === 'pasteEvent') return '派发 paste 事件';
    return '仅写入剪贴板';
  }

  function dispatchPastePayload(payload) {
    var editor = getActiveBodyEditor();
    if (!editor) return false;

    editor.focus();
    var dt = new DataTransfer();
    if (payload && payload.text) dt.setData('text/plain', payload.text);
    if (payload && payload.html) dt.setData('text/html', payload.html);

    try {
      var beforeInputEvent = new InputEvent('beforeinput', {
        inputType: 'insertFromPaste',
        bubbles: true,
        cancelable: true,
        data: payload && payload.text ? payload.text : '',
      });
      Object.defineProperty(beforeInputEvent, 'dataTransfer', {
        value: dt,
      });
      editor.dispatchEvent(beforeInputEvent);
    } catch (err) {}

    var pasteEvent = new ClipboardEvent('paste', {
      clipboardData: dt,
      bubbles: true,
      cancelable: true
    });
    editor.dispatchEvent(pasteEvent);
    return true;
  }

  function pasteIntoDoc() {
    getPendingPaste().then(function (pendingPaste) {
      if (!pendingPaste) {
        showToast('⚠️ 请先在源文档按 Cmd+Shift+D 提取');
        return;
      }

      var content = pendingPaste;

      function commitPayload(payload) {
        var needsParser = payloadRequiresPasteParsing(payload);
        var canAutoDispatch = shouldAutoDispatchPastePayload(payload);
        var preferPasteEventOnly = payloadHasFeishuCalloutHtml(payload);
        var needsManualPaste = needsParser && !canAutoDispatch;

        writeClipboardPayload(payload).then(function () {
          var status = needsManualPaste ? { autoInserted: false, autoPasted: false, pathLabel: describePasteMode('clipboardOnly') } : runPasteAttempt(payload, {
            allowInsert: !preferPasteEventOnly,
            allowDispatch: canAutoDispatch,
          });
          showPasteResultToast(status, needsManualPaste, true);
        }).catch(function () {
          showPasteResultToast(runPasteAttempt(payload, {
            allowInsert: !needsParser && !preferPasteEventOnly,
            allowDispatch: canAutoDispatch,
          }), needsManualPaste, false);
        });
      }

      if (!(content && content.clipboardHtml) && content && content.html) {
        showToast('⏳ 准备粘贴内容中...', 0);
      }

      resolvePastePayload(content).then(function (payload) {
        commitPayload(payload);
      }).catch(function () {
        handleClipboardFailure({
          text: content.text || '',
          html: '',
        });
      });
    });
  }

  function extractImages() {
    var images = [];
    var seen = new Set();

    document.querySelectorAll('img').forEach(function (img) {
      var src = img.src || img.getAttribute('data-src') || img.getAttribute('data-original');
      if (src && !seen.has(src)) {
        seen.add(src);
        images.push({
          src: src,
          alt: img.alt || '',
          width: img.naturalWidth || img.width,
          height: img.naturalHeight || img.height,
        });
      }
    });

    document.querySelectorAll('[style*="background-image"]').forEach(function (el) {
      var bgUrl = extractUrlFromBackgroundImage(el.style.backgroundImage || '');
      if (bgUrl && !seen.has(bgUrl)) {
        seen.add(bgUrl);
        images.push({
          src: bgUrl,
          alt: '',
          width: el.offsetWidth,
          height: el.offsetHeight,
        });
      }
    });

    return images;
  }

  function createImagePanel(images) {
    var existing = document.getElementById('__feishu_image_panel__');
    if (existing) existing.remove();

    var panel = document.createElement('div');
    panel.id = '__feishu_image_panel__';
    panel.innerHTML =
      '<div style="position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:999999;display:flex;align-items:center;justify-content:center;">' +
        '<div style="background:#fff;border-radius:12px;padding:24px;max-width:80vw;max-height:80vh;overflow:auto;position:relative;">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">' +
            '<h3 style="margin:0;font-size:18px;">图片提取 (' + images.length + ' 张)</h3>' +
            '<div>' +
              '<button id="__feishu_download_all__" style="background:#3370ff;color:#fff;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;margin-right:8px;">全部下载</button>' +
              '<button id="__feishu_close_panel__" style="background:#f5f5f5;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;">关闭</button>' +
            '</div>' +
          '</div>' +
          '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;">' +
            images.map(function (img, i) {
              return '<div style="border:1px solid #e5e5e5;border-radius:8px;padding:8px;text-align:center;">' +
                '<img src="' + img.src + '" style="max-width:100%;max-height:150px;object-fit:contain;" crossorigin="anonymous">' +
                '<div style="margin-top:4px;font-size:12px;color:#999;">' + img.width + 'x' + img.height + '</div>' +
                '<a href="' + img.src + '" target="_blank" download="feishu_img_' + (i + 1) + '.png" style="display:inline-block;margin-top:4px;font-size:12px;color:#3370ff;">下载</a>' +
              '</div>';
            }).join('') +
          '</div>' +
        '</div>' +
      '</div>';

    document.body.appendChild(panel);

    document.getElementById('__feishu_close_panel__').onclick = function () {
      panel.remove();
    };

    document.getElementById('__feishu_download_all__').onclick = function () {
      images.forEach(function (img, i) {
        setTimeout(function () {
          var a = document.createElement('a');
          a.href = img.src;
          a.target = '_blank';
          a.download = 'feishu_img_' + (i + 1) + '.png';
          a.click();
        }, i * 300);
      });
    };

    panel.addEventListener('click', function (e) {
      if (e.target === panel.firstElementChild.parentElement) {
        panel.remove();
      }
    });
  }

  function getImageInfoFromTarget(target) {
    var img = target.closest && target.closest('img');
    if (img) {
      var src = img.currentSrc || img.src || img.getAttribute('data-src') || img.getAttribute('data-original');
      if (!src) return null;
      return {
        src: src,
        alt: img.alt || '',
        width: img.naturalWidth || img.width || 0,
        height: img.naturalHeight || img.height || 0,
        element: img,
        sourceType: 'img',
      };
    }

    var el = target;
    var bgUrl = '';
    while (el && el !== document.documentElement) {
      if (el.nodeType === 1) {
        var bg = getComputedStyle(el).backgroundImage || '';
        bgUrl = extractUrlFromBackgroundImage(bg);
        if (bgUrl) break;
      }
      el = el.parentElement;
    }
    if (!el || !bgUrl) return null;
    return {
      src: bgUrl,
      alt: '',
      width: el.offsetWidth || 0,
      height: el.offsetHeight || 0,
      element: el,
      sourceType: 'background',
    };
  }

  function extractUrlFromBackgroundImage(backgroundImage) {
    if (!backgroundImage) return '';
    var urlIndex = backgroundImage.indexOf('url(');
    if (urlIndex === -1) return '';

    var remainder = backgroundImage.slice(urlIndex + 4).trim();
    if (!remainder) return '';

    var quote = remainder[0];
    if (quote === '"' || quote === '\'') {
      var quotedEnd = remainder.indexOf(quote, 1);
      return quotedEnd > 0 ? remainder.slice(1, quotedEnd) : '';
    }

    var closeIndex = remainder.indexOf(')');
    return closeIndex > -1 ? remainder.slice(0, closeIndex).trim() : '';
  }

  function isContextMenuGesture(e) {
    return !!e && (e.button === 2 || (e.button === 0 && e.ctrlKey));
  }

  var nativeImageMenuContext = null;
  var nativeImageMenuProxy = null;
  var nativeImageMenuCleanupTimer = 0;
  var startImageMenuObserverTimer = 0;

  function cleanupNativeImageMenuBypass() {
    nativeImageMenuContext = null;
    if (nativeImageMenuCleanupTimer) {
      clearTimeout(nativeImageMenuCleanupTimer);
      nativeImageMenuCleanupTimer = 0;
    }
    if (nativeImageMenuProxy) {
      nativeImageMenuProxy.remove();
      nativeImageMenuProxy = null;
    }
  }

  function scheduleNativeImageMenuCleanup(delay) {
    if (nativeImageMenuCleanupTimer) {
      clearTimeout(nativeImageMenuCleanupTimer);
    }
    nativeImageMenuCleanupTimer = setTimeout(function () {
      cleanupNativeImageMenuBypass();
    }, delay || 2200);
  }

  function ensureNativeImageMenuProxy(imageInfo) {
    if (!imageInfo || imageInfo.sourceType !== 'background' || !imageInfo.element) {
      return true;
    }

    var rect = imageInfo.element.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;

    if (!nativeImageMenuProxy) {
      nativeImageMenuProxy = document.createElement('img');
      nativeImageMenuProxy.id = '__feishu_native_image_proxy__';
      nativeImageMenuProxy.setAttribute('aria-hidden', 'true');
      nativeImageMenuProxy.style.cssText = [
        'position:fixed',
        'z-index:2147483646',
        'pointer-events:auto',
        'opacity:0.01',
        'user-select:none',
        '-webkit-user-drag:none',
        'margin:0',
        'padding:0',
        'border:none',
        'background:transparent',
      ].join(';');
    }

    var computedStyle = getComputedStyle(imageInfo.element);
    nativeImageMenuProxy.src = imageInfo.src;
    nativeImageMenuProxy.alt = imageInfo.alt || '';
    nativeImageMenuProxy.style.left = Math.round(rect.left) + 'px';
    nativeImageMenuProxy.style.top = Math.round(rect.top) + 'px';
    nativeImageMenuProxy.style.width = Math.max(1, Math.round(rect.width)) + 'px';
    nativeImageMenuProxy.style.height = Math.max(1, Math.round(rect.height)) + 'px';
    nativeImageMenuProxy.style.borderRadius = computedStyle.borderRadius || '0';
    nativeImageMenuProxy.style.objectFit = computedStyle.backgroundSize === 'cover' ? 'cover' : 'contain';

    if (!nativeImageMenuProxy.isConnected) {
      document.documentElement.appendChild(nativeImageMenuProxy);
    }

    return true;
  }

  function activateNativeImageMenuBypass(imageInfo) {
    if (!imageInfo) return false;
    if (!ensureNativeImageMenuProxy(imageInfo)) return false;
    nativeImageMenuContext = imageInfo;
    pendingImageContextInfo = imageInfo;
    scheduleNativeImageMenuCleanup();
    return true;
  }

  function bypassSiteImageContextMenu(e) {
    if (!isContextMenuGesture(e)) return false;
    var imageInfo = nativeImageMenuContext || getImageInfoFromTarget(e.target);
    if (!activateNativeImageMenuBypass(imageInfo)) return false;
    e.stopImmediatePropagation();
    e.stopPropagation();
    return true;
  }

  function copyImageBlobToClipboard(url) {
    return fetch(url, { credentials: 'include' }).then(function (res) {
      if (!res.ok) throw new Error('fetch failed');
      return res.blob();
    }).then(function (blob) {
      if (!navigator.clipboard || !navigator.clipboard.write) {
        throw new Error('clipboard unavailable');
      }
      var type = blob.type || 'image/png';
      return navigator.clipboard.write([
        new ClipboardItem((function () {
          var item = {};
          item[type] = blob;
          return item;
        })())
      ]);
    });
  }

  var pendingImageContextInfo = null;

  function injectImageMenuItem(menu) {
    if (!menu || menu.querySelector('[data-feishu-copy-image-item="true"]')) return;
    if (!pendingImageContextInfo) return;

    var firstItem = menu.querySelector('li, [role="menuitem"], .ud__menu-normal-item');
    var item = document.createElement(firstItem && firstItem.tagName ? firstItem.tagName : 'li');
    item.setAttribute('data-feishu-copy-image-item', 'true');
    item.setAttribute('role', 'menuitem');
    item.className = firstItem && firstItem.className ? firstItem.className : 'ud__menu-normal-item ud__menu-normal-item--root-normal ud-typography-body-0';
    item.style.cursor = 'pointer';

    if (firstItem) {
      item.innerHTML = firstItem.innerHTML;
      var titleNode = item.querySelector('.ud__menu-normal-item-title-content') || item.querySelector('[class*="title"]') || item;
      titleNode.textContent = '复制图片';
    } else {
      item.innerHTML = '<div class="ud__menu-normal-item-title-content">复制图片</div>';
    }

    item.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var imageInfo = pendingImageContextInfo;
      pendingImageContextInfo = null;
      showToast('⏳ 正在复制图片...', 1200);
      copyImageBlobToClipboard(imageInfo.src).then(function () {
        showToast('✅ 图片已复制到剪贴板', 2500);
      }).catch(function () {
        showToast('⚠️ 复制图片失败，可尝试右键后“打开图片”', 3000);
      });
    }, true);

    menu.appendChild(item);
  }

  function tryInjectImageMenu() {
    if (!pendingImageContextInfo || nativeImageMenuContext) return;
    var menus = document.querySelectorAll('[role="menu"], .ud__menu-normal-root, .ud__menu-normal');
    for (var i = menus.length - 1; i >= 0; i--) {
      var menu = menus[i];
      var text = (menu.innerText || '');
      if (text.indexOf('上传日志') !== -1 && text.indexOf('联系客服') !== -1) continue;
      injectImageMenuItem(menu);
      return;
    }
  }

  function onImagePointerdown(e) {
    if (bypassSiteImageContextMenu(e)) return;
    cleanupNativeImageMenuBypass();
  }

  function onImageMousedown(e) {
    bypassSiteImageContextMenu(e);
  }

  function onImageMouseup(e) {
    if (!nativeImageMenuContext || !isContextMenuGesture(e)) return;
    e.stopImmediatePropagation();
    e.stopPropagation();
    scheduleNativeImageMenuCleanup();
  }

  function onImageContextmenu(e) {
    if (bypassSiteImageContextMenu(e)) return;
    cleanupNativeImageMenuBypass();
    pendingImageContextInfo = getImageInfoFromTarget(e.target);
    setTimeout(tryInjectImageMenu, 0);
    setTimeout(tryInjectImageMenu, 120);
  }

  var imageMenuObserver = new MutationObserver(function () {
    tryInjectImageMenu();
  });
  registerRuntimeDisposer(function () {
    imageMenuObserver.disconnect();
  });

  function startImageMenuObserver() {
    if (!document.documentElement) {
      startImageMenuObserverTimer = setTimeout(startImageMenuObserver, 0);
      return;
    }
    startImageMenuObserverTimer = 0;

    imageMenuObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }
  registerRuntimeDisposer(function () {
    if (startImageMenuObserverTimer) {
      clearTimeout(startImageMenuObserverTimer);
      startImageMenuObserverTimer = 0;
    }
    cleanupNativeImageMenuBypass();
    pendingImageContextInfo = null;
  });

  startImageMenuObserver();

  function onDocumentClick() {
    cleanupNativeImageMenuBypass();
    pendingImageContextInfo = null;
  }

  function onEscapeKeydown(e) {
    if (e.key === 'Escape') {
      cleanupNativeImageMenuBypass();
      pendingImageContextInfo = null;
    }
  }

  function onDocumentScroll() {
    cleanupNativeImageMenuBypass();
  }

  function onShortcutKeydown(e) {
    if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return;
    var k = e.key.toLowerCase();

    if (k === 'd') {
      e.preventDefault();
      e.stopImmediatePropagation();
      duplicateDocument();
    } else if (k === 'h') {
      e.preventDefault();
      e.stopImmediatePropagation();
      exportDocumentAsHtml();
    } else if (k === 'p') {
      e.preventDefault();
      e.stopImmediatePropagation();
      pasteIntoDoc();
    } else if (k === 'i') {
      e.preventDefault();
      e.stopImmediatePropagation();
      var images = extractImages();
      if (images.length === 0) {
        showToast('当前页面未找到图片');
      } else {
        createImagePanel(images);
      }
    }
  }

  registerEventListener(document, 'pointerdown', onImagePointerdown, true);
  registerEventListener(document, 'mousedown', onImageMousedown, true);
  registerEventListener(document, 'mouseup', onImageMouseup, true);
  registerEventListener(document, 'contextmenu', onImageContextmenu, true);
  registerEventListener(document, 'click', onDocumentClick, true);
  registerEventListener(document, 'scroll', onDocumentScroll, true);
  registerEventListener(window, 'keydown', onEscapeKeydown, true);
  registerEventListener(window, 'keydown', onShortcutKeydown, true);
  registerEventListener(window, AUTOMATION_REQUEST_EVENT, onAutomationRequest, true);
  // Listen for snapshot capture requests from AppleScript's JS context.
  // AppleScript cannot call window.__feishuCaptureValidationSnapshot() directly
  // because it runs in a different Chrome isolated world. Instead, it dispatches
  // a DOM CustomEvent which IS visible across worlds.
  registerEventListener(document, 'feishu-capture-snapshot', function () {
    try { captureValidationSnapshot(); } catch (e) {}
  }, true);

  window.__feishuHelperVersion = SCRIPT_VERSION;
  // Write a DOM attribute to signal that TM has injected, so AppleScript's
  // execute javascript (which runs in a separate Chrome isolated world and
  // cannot see window.__feishuHelperVersion) can detect injection.
  try {
    document.documentElement.setAttribute('data-feishu-helper-active', SCRIPT_VERSION);
  } catch (e) {}
  // Periodically sync editor ready state to a DOM attribute so AppleScript's
  // execute javascript (which runs in a separate Chrome isolated world and
  // cannot see window.__feishu* properties) can detect when the Feishu editor
  // is ready.  DOM attributes ARE shared across isolated worlds.
  var _editorStateSyncTimer = setInterval(function () {
    try {
      var state = getEditorReadyState();
      if (state) {
        document.documentElement.setAttribute('data-feishu-editor-ready-state', JSON.stringify(state));
      }
    } catch (e) {}
  }, 500);
  window.__tampermonkeyScriptDebugExports = function () {
    return {
      name: SCRIPT_NAME,
      version: SCRIPT_VERSION,
      automation: {
        requestEvent: AUTOMATION_REQUEST_EVENT,
        resultEvent: AUTOMATION_RESULT_EVENT,
        defaultAction: 'duplicateDocument',
        actions: ['duplicateDocument', 'realTestDuplicateDocument'],
      },
      exports: {
        extractFullDoc: typeof window.__feishuExtractFullDoc,
        pasteIntoDoc: typeof window.__feishuPasteIntoDoc,
        preparePendingPasteForNativePaste: typeof window.__feishuPreparePendingPasteForNativePaste,
        captureValidationSnapshot: typeof window.__feishuCaptureValidationSnapshot,
        getLastExtractionDebug: typeof window.__feishuGetLastExtractionDebug,
        getEditorReadyState: typeof window.__feishuGetEditorReadyState,
        debugEditorAPI: typeof window.__feishuDebugEditorAPI,
        captureNextCopy: typeof window.__feishuCaptureNextCopy,
        runAutomationAction: typeof window.__feishuRunAutomationAction,
      },
    };
  };
  window.__feishuDebugExports = function () {
    return window.__tampermonkeyScriptDebugExports();
  };
  window.__feishuRunAutomationAction = function (options) {
    var action = typeof options === 'string'
      ? options
      : options && options.action;
    return runAutomationAction(action);
  };
  window.__feishuGetPendingPasteSummary = summarizePendingPasteForAutomation;
  window.__feishuGetPendingPasteTimestamp = getPendingPasteTimestamp;
  window.__feishuGetEditorReadyState = getEditorReadyState;
  window.__feishuGetLastExtractionDebug = getLastExtractionDebug;
  window.__feishuGetImageConversionStatus = getImageConversionStatus;
  window.__feishuResetImageConversionStatus = function () {
    imageConversionStatus = {
      state: 'idle',
      done: 0,
      total: 0,
      updatedAt: 0,
      error: '',
    };
  };
  window.__feishuGetLastCopyCapture = function () {
    return window.__feishuLastCopyCapture || null;
  };
  window.__feishuSummarizeLastCopyCapture = function () {
    var capture = window.__feishuLastCopyCapture;
    if (!capture) return null;

    var summary = {
      reason: capture.reason || '',
      types: [],
      rawTypes: Object.keys(capture.rawData || {}),
    };

    var firstEvent = capture.copyEvents && capture.copyEvents[0];
    if (firstEvent && firstEvent.snapshot && firstEvent.snapshot.types) {
      summary.types = firstEvent.snapshot.types.slice();
    }
    if ((!summary.types || !summary.types.length) && capture.rawData) {
      summary.types = Object.keys(capture.rawData);
    }

    if (capture.rawData && capture.rawData['docx/text']) {
      summary.docxText = summarizeDocxClipboardPayload(capture.rawData['docx/text'].text);
    }

    if (capture.rawData && capture.rawData['docx/record']) {
      summary.docxRecord = summarizeGenericClipboardJson(capture.rawData['docx/record'].text, 'docxRecord');
    }

    if (capture.rawData && capture.rawData['text/html']) {
      summary.htmlPreview = summarizeDebugText(capture.rawData['text/html'].text, 500);
      summary.htmlRecordData = summarizeHtmlRecordData(capture.rawData['text/html'].text);
      summary.htmlMetaBlockProps = summarizeHtmlMetaBlockProps(capture.rawData['text/html'].text);
    }

    if (capture.rawData && capture.rawData['text/plain']) {
      summary.plainPreview = summarizeDebugText(capture.rawData['text/plain'].text, 300);
    }

    console.log('[Feishu Helper] last copy capture summary');
    console.log(summary);
    return summary;
  };
  window.__feishuInspectEditorPath = function (path) {
    var resolved = resolveEditorPath(path);
    if (!resolved.ok) {
      var errorSummary = {
        ok: false,
        path: resolved.label || String(path || ''),
        error: summarizeDebugText(resolved.error && resolved.error.message, 160),
      };
      console.log('[Feishu Helper] inspect path failed');
      console.log(errorSummary);
      return errorSummary;
    }

    var summary = summarizeObjectValue(resolved.value);
    summary.ok = true;
    summary.path = resolved.label;
    console.log('[Feishu Helper] inspect path', resolved.label);
    console.log(summary);
    return summary;
  };
  window.__feishuFindEditorPaths = function (pattern) {
    var editorAPI = getEditorAPI();
    if (!editorAPI) {
      console.log('[Feishu Helper] no editorAPI');
      return [];
    }

    var regex;
    try {
      regex = pattern instanceof RegExp ? pattern : new RegExp(String(pattern || ''), 'i');
    } catch (err) {
      regex = /clipboard|copy|paste|formula|equation|selection|insert|command/i;
    }

    var all = collectInterestingPaths(editorAPI, 'editorAPI', regex, 3, 200);
    console.log('[Feishu Helper] matched editor paths', regex);
    console.log(all);
    return all;
  };
  window.__feishuExtractFullDoc = extractFullDoc;
  window.__feishuDuplicateDoc = duplicateDocument;
  window.__feishuDuplicateDocForAutomation = duplicateDocumentForAutomation;
  window.__feishuPasteIntoDoc = pasteIntoDoc;
  window.__feishuDecodeFeishuAttribsToHtml = decodeFeishuAttribsToHtml;
  window.__feishuDecodeBlockHtml = decodeBlockHtml;
  window.__feishuNormalizeBlockStyle = normalizeBlockStyle;
  window.__feishuBlockToHtml = blockToHtml;
  window.__feishuNormalizeLatexTextBoundaries = normalizeLatexTextBoundaries;
  window.__feishuNormalizeLatexHtmlTextNodes = normalizeLatexHtmlTextNodes;
  window.__feishuSanitizeHtmlFragment = sanitizeHtmlFragment;
  window.__feishuNormalizeListHtmlFragment = normalizeListHtmlFragment;
  window.__feishuBuildClipboardHtml = buildClipboardHtml;
  window.__feishuBuildClipboardPayload = buildClipboardPayload;
  window.__feishuResolvePastePayload = resolvePastePayload;
  window.__feishuPayloadRequiresPasteParsing = payloadRequiresPasteParsing;
  window.__feishuShouldAutoDispatchPastePayload = shouldAutoDispatchPastePayload;
  window.__feishuPreparePendingPasteForNativePaste = preparePendingPasteForNativePaste;
  window.__feishuCaptureValidationSnapshot = captureValidationSnapshot;
  window.__feishuExtractInsertionHtml = extractInsertionHtml;
  window.__feishuInsertPayloadIntoEditor = insertPayloadIntoEditor;
  window.__feishuDispatchPastePayload = dispatchPastePayload;
  window.__feishuWriteClipboardPayload = writeClipboardPayload;
  window.__feishuDebugEditorAPI = function () {
    var editorAPI = getEditorAPI();
    if (!editorAPI) {
      console.log('[Feishu Helper] no editorAPI');
      return null;
    }

    var topLevelKeys = safeGetOwnKeys(editorAPI);
    var topLevelFunctions = [];
    var interestingChildren = {};

    topLevelKeys.forEach(function (key) {
      var value;
      try {
        value = editorAPI[key];
      } catch (err) {
        interestingChildren[key] = { type: 'throws', error: summarizeDebugText(err && err.message, 120) };
        return;
      }

      if (typeof value === 'function') {
        topLevelFunctions.push(key);
      }

      if (!DEBUG_EDITOR_KEY_PATTERN.test(key) && typeof value !== 'function') return;

      if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
        interestingChildren[key] = {
          type: typeof value,
          value: typeof value === 'string' ? summarizeDebugText(value, 160) : value,
        };
        return;
      }

      var childKeys = safeGetOwnKeys(value);
      var childFunctions = [];
      var childValues = {};
      childKeys.slice(0, 60).forEach(function (childKey) {
        var childValue;
        try {
          childValue = value[childKey];
        } catch (err) {
          childValues[childKey] = '[throws:' + summarizeDebugText(err && err.message, 80) + ']';
          return;
        }
        if (typeof childValue === 'function') {
          childFunctions.push(childKey);
        } else if (childValue == null || typeof childValue === 'string' || typeof childValue === 'number' || typeof childValue === 'boolean') {
          childValues[childKey] = typeof childValue === 'string' ? summarizeDebugText(childValue, 120) : childValue;
        } else if (Array.isArray(childValue)) {
          childValues[childKey] = '[array:' + childValue.length + ']';
        } else {
          childValues[childKey] = '[object]';
        }
      });

      interestingChildren[key] = {
        type: typeof value,
        keys: childKeys,
        functionKeys: childFunctions,
        sampleValues: childValues,
        matchedPaths: collectInterestingPaths(value, 'editorAPI.' + key, DEBUG_EDITOR_KEY_PATTERN, 2, 40),
      };
    });

    var summary = {
      topLevelKeys: topLevelKeys,
      topLevelFunctions: topLevelFunctions,
      interestingChildren: interestingChildren,
      matchedPaths: collectInterestingPaths(editorAPI, 'editorAPI', DEBUG_EDITOR_KEY_PATTERN, 2, 120),
    };

    console.log('[Feishu Helper] editorAPI summary');
    console.log(summary);
    return summary;
  };
  window.__feishuCaptureNextCopy = function () {
    if (window.__feishuCopyCaptureCleanup) {
      try { window.__feishuCopyCaptureCleanup(); } catch (err) {}
    }

    var capture = {
      armedAt: new Date().toISOString(),
      copyEvents: [],
      setDataCalls: [],
      clipboardWriteCalls: [],
      clipboardWriteHooked: false,
      rawData: {},
    };
    var active = true;
    var finalizeTimer = null;
    var timeoutId = null;
    var originalSetData = null;
    var originalClipboardWrite = null;
    var clipboardRef = null;

    function snapshotDataTransfer(dt) {
      if (!dt) return null;
      var result = { types: [] };
      try {
        result.types = Array.from(dt.types || []);
      } catch (err) {}
      var readTypes = result.types.length ? result.types.slice() : ['text/plain', 'text/html'];
      readTypes.forEach(function (type) {
        try {
          var value = dt.getData(type);
          if (value) {
            result[type] = {
              length: value.length,
              preview: summarizeDebugText(value, 320),
            };
          }
        } catch (err) {
          result[type] = '[read-error:' + summarizeDebugText(err && err.message, 80) + ']';
        }
      });
      return result;
    }

    function cleanup() {
      active = false;
      clearTimeout(finalizeTimer);
      clearTimeout(timeoutId);
      document.removeEventListener('copy', onCopyCapture, true);
      document.removeEventListener('copy', onCopyBubble, false);
      if (originalSetData && typeof DataTransfer !== 'undefined' && DataTransfer.prototype) {
        DataTransfer.prototype.setData = originalSetData;
      }
      if (clipboardRef && originalClipboardWrite) {
        try { clipboardRef.write = originalClipboardWrite; } catch (err) {}
      }
      window.__feishuCopyCaptureCleanup = null;
    }

    function finalize(reason) {
      if (!active) return capture;
      capture.finalizedAt = new Date().toISOString();
      capture.reason = reason;
      window.__feishuLastCopyCapture = capture;
      cleanup();
      console.log('[Feishu Helper] copy capture');
      console.log(capture);
      return capture;
    }

    function scheduleFinalize(reason, delay) {
      if (!active) return;
      clearTimeout(finalizeTimer);
      finalizeTimer = setTimeout(function () {
        finalize(reason);
      }, delay || 80);
    }

    function onCopyCapture(e) {
      if (!active) return;
      capture.copyEvents.push({
        phase: 'capture',
        trusted: !!e.isTrusted,
        defaultPrevented: !!e.defaultPrevented,
        snapshot: snapshotDataTransfer(e.clipboardData),
      });
      scheduleFinalize('copy-event', 160);
    }

    function onCopyBubble(e) {
      if (!active) return;
      capture.copyEvents.push({
        phase: 'bubble',
        trusted: !!e.isTrusted,
        defaultPrevented: !!e.defaultPrevented,
        snapshot: snapshotDataTransfer(e.clipboardData),
      });
      scheduleFinalize('copy-event', 160);
    }

    if (typeof DataTransfer !== 'undefined' && DataTransfer.prototype && typeof DataTransfer.prototype.setData === 'function') {
      originalSetData = DataTransfer.prototype.setData;
      DataTransfer.prototype.setData = function (type, value) {
        if (active) {
          capture.setDataCalls.push({
            type: type,
            length: String(value == null ? '' : value).length,
            preview: summarizeDebugText(value, 320),
          });
          storeCaptureRawData(capture, type, value);
          scheduleFinalize('setData', 160);
        }
        return originalSetData.apply(this, arguments);
      };
    }

    if (navigator.clipboard && typeof navigator.clipboard.write === 'function') {
      clipboardRef = navigator.clipboard;
      originalClipboardWrite = clipboardRef.write;
      try {
        clipboardRef.write = function (items) {
          if (active) {
            capture.clipboardWriteCalls.push(Array.from(items || []).map(function (item) {
              var types = [];
              try { types = Array.from(item.types || []); } catch (err) {}
              return { types: types };
            }));
            scheduleFinalize('clipboard.write', 220);
          }
          return originalClipboardWrite.apply(this, arguments);
        };
        capture.clipboardWriteHooked = true;
      } catch (err) {
        capture.clipboardWriteHookError = summarizeDebugText(err && err.message, 120);
      }
    }

    document.addEventListener('copy', onCopyCapture, true);
    document.addEventListener('copy', onCopyBubble, false);

    timeoutId = setTimeout(function () {
      capture.timedOut = true;
      finalize('timeout');
    }, 30000);

    window.__feishuCopyCaptureCleanup = cleanup;
    window.__feishuLastCopyCapture = null;
    console.log('[Feishu Helper] copy capture armed');
    return {
      armed: true,
      timeoutMs: 30000,
    };
  };
  window.__feishuDebugRichStyles = function () {
    var ss = getStructService();
    if (!ss || !ss.rootBlock) {
      console.log('no rootBlock');
      return null;
    }

    var textAttrs = {};
    var blockStyleKeys = {};
    var blockStyleSamples = [];
    var interestingKeyPattern = /color|background|highlight|align|justify|indent|font|size|width|height|border|padding|margin|emoji|layout|ratio|checked|language|level|style|callout|quote|grid/i;
    var ignoredSnapshotKeys = {
      text: true,
      image: true,
      table: true,
      rows_id: true,
      columns_id: true,
      cell_set: true,
    };

    function cloneDebugValue(value, depth) {
      if (depth > 2) return '[depth-limit]';
      if (value == null) return value;
      if (typeof value === 'string') {
        return value.length > 180 ? value.slice(0, 180) + '…' : value;
      }
      if (typeof value === 'number' || typeof value === 'boolean') return value;
      if (Array.isArray(value)) {
        return value.slice(0, 8).map(function (item) { return cloneDebugValue(item, depth + 1); });
      }
      if (typeof value === 'object') {
        var out = {};
        Object.keys(value).slice(0, 12).forEach(function (key) {
          out[key] = cloneDebugValue(value[key], depth + 1);
        });
        return out;
      }
      return String(value);
    }

    function recordTextAttr(attr, blockType) {
      if (!attr || !attr.length) return;
      var name = attr[0];
      if (!textAttrs[name]) {
        textAttrs[name] = {
          count: 0,
          blockTypes: {},
          samples: [],
        };
      }
      var bucket = textAttrs[name];
      bucket.count++;
      bucket.blockTypes[blockType] = (bucket.blockTypes[blockType] || 0) + 1;
      if (bucket.samples.length < 8) {
        bucket.samples.push(cloneDebugValue(attr, 0));
      }
    }

    function recordBlockStyles(snap, blockId) {
      if (!snap || !snap.type) return;
      var type = snap.type;
      if (!blockStyleKeys[type]) blockStyleKeys[type] = {};
      var sample = { type: type, id: blockId, styles: {} };
      var found = false;

      Object.keys(snap).forEach(function (key) {
        if (ignoredSnapshotKeys[key]) return;
        if (!interestingKeyPattern.test(key)) return;
        blockStyleKeys[type][key] = (blockStyleKeys[type][key] || 0) + 1;
        sample.styles[key] = cloneDebugValue(snap[key], 0);
        found = true;
      });

      if (found && blockStyleSamples.length < 30) {
        blockStyleSamples.push(sample);
      }
    }

    function walk(block, depth) {
      if (!block || depth > 14) return;
      if (block.record && block.record.snapshot) {
        var snap = block.record.snapshot;
        recordBlockStyles(snap, block.record.id || '');

        if (snap.text && snap.text.apool && snap.text.apool.numToAttrib) {
          var nta = snap.text.apool.numToAttrib;
          Object.keys(nta).forEach(function (num) {
            recordTextAttr(nta[num], snap.type || 'unknown');
          });
        }
      }
      if (block.children && Array.isArray(block.children)) {
        block.children.forEach(function (child) { walk(child, depth + 1); });
      }
    }

    walk(ss.rootBlock, 0);

    var summary = {
      textAttrNames: Object.keys(textAttrs).sort(),
      textAttrs: textAttrs,
      blockStyleKeys: blockStyleKeys,
      blockStyleSamples: blockStyleSamples,
    };

    console.log('[Feishu Helper] rich-style summary');
    console.log(summary);
    return summary;
  };
  window.__feishuDebugEquations = function () {
    var ss = getStructService();
    if (!ss || !ss.rootBlock) { console.log('no rootBlock'); return; }
    var equations = [];
    function find(block, depth) {
      if (!block || depth > 12) return;
      if (block.record && block.record.snapshot) {
        var snap = block.record.snapshot;
        if (snap.text && snap.text.apool && snap.text.apool.numToAttrib) {
          var nta = snap.text.apool.numToAttrib;
          for (var num in nta) {
            if (nta[num][0] === 'equation') {
              equations.push({ num: num, latex: nta[num][1], len: nta[num][1].length });
            }
          }
        }
      }
      if (block.children) block.children.forEach(function (c) { find(c, depth + 1); });
    }
    find(ss.rootBlock, 0);
    console.log('Total equations:', equations.length);
    var truncated = equations.filter(function (e) {
      var open = (e.latex.match(/\{/g) || []).length;
      var close = (e.latex.match(/\}/g) || []).length;
      return open !== close;
    });
    console.log('Possibly truncated:', truncated.length);
    equations.forEach(function (e, i) {
      console.log('[' + i + '] len=' + e.len + ' ' + e.latex.substring(0, 150));
    });
    if (truncated.length > 0) {
      console.log('\n--- Truncated ---');
      truncated.forEach(function (e, i) {
        console.log('[' + i + '] len=' + e.len + ' ' + e.latex);
      });
    }
    return equations;
  };
})();
