// ==UserScript==
// @name         飞书文档助手
// @namespace    https://github.com/tampermonkey-scripts
// @version      4.2.18
// @description  飞书文档完整复制、图片提取、文档副本（含LaTeX公式）
// @author       You
// @match        https://*.feishu.cn/*
// @match        https://*.larksuite.com/*
// @match        https://*.larkoffice.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @sandbox      raw
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
  var SCRIPT_VERSION = '4.2.18';
  var AUTOMATION_REQUEST_EVENT = 'feishu-helper:automation-request';
  var AUTOMATION_RESULT_EVENT = 'feishu-helper:automation-result';
  var CONTENT_ROOT_SELECTOR = '[data-content-editable-root="true"]';
  var HIDDEN_PASTE_TEXTAREA_SELECTOR = 'textarea.docx-selection-hidden-textarea';
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
  var NON_TEXT_COMPONENT_TYPE_MAP = {
    image: 'image',
    callout: 'callout',
    quote_container: 'quote',
    code: 'code_block',
    divider: 'divider',
    grid: 'grid',
    table: 'table',
    bookmark: 'bookmark',
    diagram: 'diagram',
    whiteboard: 'whiteboard',
    synced_reference: 'synced_reference',
  };
  var runtimeDisposers = [];
  var lastDocxRecord = null;
  var lastCopyCapture = null;
  var copyCaptureCleanup = null;
  var FeishuHelperModules = null;

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

  // ── Fetch interceptor for discovering Feishu's internal upload API ──
  // Always active — captures every upload/media POST so we can discover the
  // correct mount_point, headers, and body format that Feishu itself uses.
  var _feishuCapturedUploads = [];
  var _feishuCapturedWhiteboardClones = [];
  var _feishuWhiteboardHookLog = [];
  var _feishuWhiteboardHookState = {
    installed: false,
    installedAt: '',
    href: '',
    wrappedPaths: [],
    logCount: 0,
    errors: [],
  };
  var _feishuWhiteboardHookCallSeq = 0;
  var FEISHU_CAPTURED_REQUEST_LIMIT = 10;
  var FEISHU_UPLOAD_REQUEST_RE = /upload|media|image|pre_upload|box\/stream|box\/image|put\//i;
  var FEISHU_WHITEBOARD_CLONE_RE = /\/space\/api\/whiteboard\/block\/clone(?:[/?#]|$)/i;
  var _originalFetch = window.fetch;
  function _parseUrlQueryParams(url) {
    var params = {};
    try {
      var qs = url.split('?')[1] || '';
      qs.split('&').forEach(function (pair) {
        var kv = pair.split('=');
        if (kv[0]) params[decodeURIComponent(kv[0])] = decodeURIComponent(kv.slice(1).join('='));
      });
    } catch (e) {}
    return params;
  }
  function _isCapturedRequest(url, method, urlRe, methodRe) {
    return urlRe.test(String(url || '')) && (!methodRe || methodRe.test(String(method || 'GET')));
  }
  function _captureRequestHeaders(headers) {
    var captured = {};
    if (!headers) return captured;
    try {
      if (headers instanceof Headers) {
        headers.forEach(function (v, k) { captured[k] = v; });
      } else if (typeof headers === 'object') {
        Object.keys(headers).forEach(function (k) { captured[k] = headers[k]; });
      }
    } catch (e) {}
    return captured;
  }
  function _summarizeDiagnosticJsonValue(value, depth) {
    depth = Number(depth || 0);
    if (value == null || typeof value !== 'object') {
      return typeof value === 'string' ? summarizeDebugText(value, 160) : value;
    }
    if (depth >= 2) {
      return Array.isArray(value)
        ? { type: 'array', length: value.length }
        : { type: 'object', keys: Object.keys(value).slice(0, 12) };
    }
    if (Array.isArray(value)) {
      return {
        type: 'array',
        length: value.length,
        sample: value.slice(0, 4).map(function (item) {
          return _summarizeDiagnosticJsonValue(item, depth + 1);
        }),
      };
    }
    var summary = {
      keys: Object.keys(value).slice(0, 20),
    };
    [
      'code',
      'msg',
      'message',
      'baseToken',
      'token',
      'blockToken',
      'whiteboardToken',
      'cloneToken',
      'obj_token',
      'status',
    ].forEach(function (key) {
      if (value[key] !== undefined) {
        summary[key] = _summarizeDiagnosticJsonValue(value[key], depth + 1);
      }
    });
    ['data', 'result', 'payload', 'response'].forEach(function (key) {
      if (value[key] && typeof value[key] === 'object') {
        summary[key] = _summarizeDiagnosticJsonValue(value[key], depth + 1);
      }
    });
    return summary;
  }
  function _summarizeCapturedPayloadText(rawText, options) {
    var text = String(rawText || '').trim();
    var previewKey = options && options.previewKey ? String(options.previewKey) : 'textPreview';
    var summaryKey = options && options.summaryKey ? String(options.summaryKey) : 'jsonSummary';
    var summary = {};
    if (!text) return summary;
    summary[previewKey] = summarizeDebugText(text, 600);
    summary.textLength = text.length;
    try {
      summary[summaryKey] = _summarizeDiagnosticJsonValue(JSON.parse(text), 0);
    } catch (error) {}
    return summary;
  }
  function _summarizeCapturedRequestBody(body) {
    var summary = {
      bodyType: body ? (typeof body === 'string' ? 'string' : (body instanceof FormData ? 'FormData' : (body instanceof Blob ? 'Blob' : typeof body))) : 'none',
    };
    if (!body) return summary;
    if (typeof body === 'string') {
      return Object.assign(summary, _summarizeCapturedPayloadText(body, {
        previewKey: 'bodyPreview',
        summaryKey: 'bodyJsonSummary',
      }));
    }
    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
      return Object.assign(summary, _summarizeCapturedPayloadText(String(body), {
        previewKey: 'bodyPreview',
        summaryKey: 'bodyJsonSummary',
      }));
    }
    if (body instanceof FormData) {
      summary.formDataFields = [];
      try {
        body.forEach(function (val, key) {
          var entry = { key: key };
          if (val instanceof File || val instanceof Blob) {
            entry.type = val instanceof File ? 'File' : 'Blob';
            if (val instanceof File) entry.fileName = val.name;
          } else {
            entry.type = 'string';
            entry.value = String(val).substring(0, 200);
          }
          summary.formDataFields.push(entry);
        });
      } catch (e) {}
      return summary;
    }
    if (body instanceof Blob) {
      summary.blobSize = Number(body.size || 0);
      summary.blobType = String(body.type || '');
      return summary;
    }
    return summary;
  }
  function _syncCapturedRequestAttr(attrName, records) {
    try {
      document.documentElement.setAttribute(attrName, JSON.stringify((records || []).slice(-FEISHU_CAPTURED_REQUEST_LIMIT)));
    } catch (e) {}
  }
  function _recordWhiteboardCloneCapture(captured) {
    if (!captured) return null;
    _feishuCapturedWhiteboardClones.push(captured);
    _syncCapturedRequestAttr('data-feishu-captured-whiteboard-clones', _feishuCapturedWhiteboardClones);
    return captured;
  }
  function _updateWhiteboardCloneCapture(captured, patch) {
    if (!captured || !patch || typeof patch !== 'object') return;
    Object.keys(patch).forEach(function (key) {
      captured[key] = patch[key];
    });
    _syncCapturedRequestAttr('data-feishu-captured-whiteboard-clones', _feishuCapturedWhiteboardClones);
  }
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input instanceof Request ? input.url : String(input || ''));
    var method = (init && init.method) || (input instanceof Request ? input.method : 'GET');
    var body = init && Object.prototype.hasOwnProperty.call(init, 'body') ? init.body : null;
    if (_isCapturedRequest(url, method, FEISHU_UPLOAD_REQUEST_RE, /post|put/i)) {
      var captured = {
        url: url,
        method: method,
        transport: 'fetch',
        timestamp: Date.now(),
        headers: _captureRequestHeaders(init && init.headers),
        queryParams: _parseUrlQueryParams(url),
      };
      Object.assign(captured, _summarizeCapturedRequestBody(body));
      _feishuCapturedUploads.push(captured);
      console.info('[Feishu Helper] Captured upload request:', url, captured.queryParams);
      _syncCapturedRequestAttr('data-feishu-captured-uploads', _feishuCapturedUploads);
    }
    var whiteboardCapture = null;
    if (_isCapturedRequest(url, method, FEISHU_WHITEBOARD_CLONE_RE, /post/i)) {
      whiteboardCapture = _recordWhiteboardCloneCapture({
        url: url,
        method: method,
        transport: 'fetch',
        timestamp: Date.now(),
        headers: _captureRequestHeaders(init && init.headers),
        queryParams: _parseUrlQueryParams(url),
      });
      Object.assign(whiteboardCapture, _summarizeCapturedRequestBody(body));
      _updateWhiteboardCloneCapture(whiteboardCapture, {
        diagnosticType: 'whiteboardClone',
      });
      console.info('[Feishu Helper] Captured whiteboard clone request:', url);
    }
    var fetchResult = _originalFetch.apply(this, arguments);
    if (!whiteboardCapture || !fetchResult || typeof fetchResult.then !== 'function') {
      return fetchResult;
    }
    return fetchResult.then(function (response) {
      _updateWhiteboardCloneCapture(whiteboardCapture, {
        ok: !!(response && response.ok),
        status: Number(response && response.status || 0),
        statusText: String(response && response.statusText || ''),
        responseCapturedAt: Date.now(),
      });
      if (response && typeof response.clone === 'function') {
        response.clone().text().then(function (text) {
          _updateWhiteboardCloneCapture(
            whiteboardCapture,
            _summarizeCapturedPayloadText(text, {
              previewKey: 'responsePreview',
              summaryKey: 'responseJsonSummary',
            })
          );
        }).catch(function (error) {
          _updateWhiteboardCloneCapture(whiteboardCapture, {
            responseReadError: stringifyError(error),
          });
        });
      }
      return response;
    }).catch(function (error) {
      _updateWhiteboardCloneCapture(whiteboardCapture, {
        fetchError: stringifyError(error),
        responseCapturedAt: Date.now(),
      });
      throw error;
    });
  };
  registerRuntimeDisposer(function () { window.fetch = _originalFetch; });

  // ── XHR interceptor for upload API discovery (always active) ──
  var _originalXHROpen = XMLHttpRequest.prototype.open;
  var _originalXHRSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this._feishuInterceptorInfo = { method: method, url: String(url || '') };
    return _originalXHROpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    if (this._feishuInterceptorInfo) {
      var info = this._feishuInterceptorInfo;
      if (_isCapturedRequest(info.url, info.method, FEISHU_UPLOAD_REQUEST_RE)) {
        var captured = {
          url: info.url,
          method: info.method,
          transport: 'xhr',
          timestamp: Date.now(),
          queryParams: _parseUrlQueryParams(info.url),
          xhr: true,
        };
        Object.assign(captured, _summarizeCapturedRequestBody(body));
        _feishuCapturedUploads.push(captured);
        console.info('[Feishu Helper] Captured XHR upload request:', info.url, captured.queryParams);
        _syncCapturedRequestAttr('data-feishu-captured-uploads', _feishuCapturedUploads);
      }
      if (_isCapturedRequest(info.url, info.method, FEISHU_WHITEBOARD_CLONE_RE, /post/i)) {
        var xhrCloneCapture = _recordWhiteboardCloneCapture({
          url: info.url,
          method: info.method,
          transport: 'xhr',
          timestamp: Date.now(),
          queryParams: _parseUrlQueryParams(info.url),
          xhr: true,
          diagnosticType: 'whiteboardClone',
        });
        Object.assign(xhrCloneCapture, _summarizeCapturedRequestBody(body));
        try {
          this.addEventListener('loadend', function onFeishuWhiteboardCloneLoadEnd() {
            try {
              this.removeEventListener('loadend', onFeishuWhiteboardCloneLoadEnd);
            } catch (e) {}
            var patch = {
              ok: Number(this.status || 0) >= 200 && Number(this.status || 0) < 300,
              status: Number(this.status || 0),
              statusText: String(this.statusText || ''),
              responseCapturedAt: Date.now(),
            };
            try {
              Object.assign(patch, _summarizeCapturedPayloadText(this.responseText, {
                previewKey: 'responsePreview',
                summaryKey: 'responseJsonSummary',
              }));
            } catch (error) {
              patch.responseReadError = stringifyError(error);
            }
            _updateWhiteboardCloneCapture(xhrCloneCapture, patch);
          });
        } catch (error) {
          _updateWhiteboardCloneCapture(xhrCloneCapture, {
            listenerError: stringifyError(error),
          });
        }
        console.info('[Feishu Helper] Captured XHR whiteboard clone request:', info.url);
      }
    }
    return _originalXHRSend.apply(this, arguments);
  };
  registerRuntimeDisposer(function () {
    XMLHttpRequest.prototype.open = _originalXHROpen;
    XMLHttpRequest.prototype.send = _originalXHRSend;
  });

  function scoreEditableRootCandidate(node) {
    if (!node || node.nodeType !== 1) return -Infinity;
    var rect = typeof node.getBoundingClientRect === 'function'
      ? node.getBoundingClientRect()
      : { width: 0, height: 0 };
    var textLength = summarizeComponentText(node.innerText || node.textContent || '', 4000).length;
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

  function getContentRootElement() {
    var nodes = Array.prototype.slice.call(document.querySelectorAll(EDITABLE_SELECTOR), 0, 24);
    if (!nodes.length) return null;
    var bestNode = nodes[0];
    var bestScore = -Infinity;
    nodes.forEach(function (node) {
      var score = scoreEditableRootCandidate(node);
      if (score > bestScore) {
        bestScore = score;
        bestNode = node;
      }
    });
    return bestNode || null;
  }

  function getValidationSurfaceElement() {
    var candidates = [];

    function pushCandidate(node) {
      if (!node || node.nodeType !== 1 || candidates.indexOf(node) !== -1) return;
      candidates.push(node);
    }

    pushCandidate(getContentRootElement());
    pushCandidate(document.querySelector('main'));
    pushCandidate(document.querySelector('[role="main"]'));
    Array.prototype.slice.call(document.querySelectorAll('[class*="wiki"], [class*="doc"], [class*="editor"], [data-page-id], [data-block-type]'), 0, 24).forEach(function (node) {
      pushCandidate(node);
    });
    pushCandidate(document.body);

    if (!candidates.length) return null;

    var bestNode = candidates[0];
    var bestScore = -Infinity;
    candidates.forEach(function (node) {
      var score = scoreEditableRootCandidate(node);
      if (node === document.body) score -= 8;
      if (node === getContentRootElement()) score += 4;
      if (score > bestScore) {
        bestScore = score;
        bestNode = node;
      }
    });

    return bestNode || document.body || null;
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

    pushCandidate(getContentRootElement());

    pushCandidate(document.activeElement);

    var selection = null;
    try {
      selection = window.getSelection ? window.getSelection() : null;
    } catch (error) {}
    pushCandidate(selection && selection.anchorNode ? (selection.anchorNode.nodeType === 1 ? selection.anchorNode : selection.anchorNode.parentElement) : null);

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

  function summarizeComponentText(text, limit) {
    var normalized = normalizePlainText(String(text || ''))
      .replace(/\s+/g, ' ')
      .trim();
    if (!normalized) return '';
    return normalized.slice(0, limit || 120);
  }

  function collectEquationComponentsFromText(text) {
    var components = [];
    splitLatexSegments(text).forEach(function (segment) {
      if (!segment || segment.type !== 'formula' || !segment.value) return;
      components.push({
        type: 'equation',
        textSample: summarizeComponentText(segment.value, 160),
        rendered: true,
      });
    });
    return components;
  }

  function collectBlockPlainText(block, depth) {
    if (!block || depth > MAX_BLOCK_DEPTH || !block.record || !block.record.snapshot) return '';
    var parts = [];
    var snap = block.record.snapshot;
    var text = decodeBlockText(snap);
    if (text) parts.push(text);
    getBlockChildren(block).forEach(function (child) {
      var childText = collectBlockPlainText(child, depth + 1);
      if (childText) parts.push(childText);
    });
    return parts.join('\n');
  }

  function buildRenderedImageSummary(image) {
    var token = image && image.token ? String(image.token) : '';
    var selector = token ? 'img[src*="' + token.replace(/["\\]/g, '\\$&') + '"]' : 'img';
    var node = null;
    try {
      node = document.querySelector(selector);
    } catch (e) {}
    var width = node ? Number(node.naturalWidth || node.width || 0) : Number(image && image.width || 0);
    var height = node ? Number(node.naturalHeight || node.height || 0) : Number(image && image.height || 0);
    return {
      rendered: width > 0 && height > 0,
      width: width,
      height: height,
    };
  }

  function createSemanticSnapshot() {
    return {
      componentCounts: {},
      components: [],
      totalComponentCount: 0,
      storedComponentCount: 0,
    };
  }

  function pushSemanticComponent(snapshot, component) {
    if (!snapshot || !component || !component.type) return;
    var type = String(component.type || '');
    snapshot.componentCounts[type] = (snapshot.componentCounts[type] || 0) + 1;
    snapshot.totalComponentCount += 1;
    if (snapshot.components.length >= 40) return;
    snapshot.components.push(component);
    snapshot.storedComponentCount = snapshot.components.length;
  }

  function listSemanticComponentsByType(snapshot, type) {
    if (!snapshot || !Array.isArray(snapshot.components)) return [];
    return snapshot.components.filter(function (component) {
      return component && component.type === type;
    });
  }

  function scoreSemanticComponent(component) {
    if (!component) return 0;
    var score = 0;
    if (component.rendered === true) score += 2;
    if (component.textSample) score += Math.min(String(component.textSample).length, 80) / 20;
    if (Number(component.width || 0) > 0) score += 1;
    if (Number(component.height || 0) > 0) score += 1;
    if (Number(component.rowCount || 0) > 0) score += 1;
    if (Number(component.colCount || 0) > 0) score += 1;
    if (Array.isArray(component.cellTexts) && component.cellTexts.length) {
      score += Math.min(component.cellTexts.length, 4);
    }
    return score;
  }

  function scoreSemanticComponentList(components) {
    return (components || []).reduce(function (total, component) {
      return total + scoreSemanticComponent(component);
    }, 0);
  }

  function chooseSemanticComponentsForType(primaryComponents, fallbackComponents) {
    if ((fallbackComponents || []).length > (primaryComponents || []).length) {
      return fallbackComponents || [];
    }
    if ((primaryComponents || []).length > (fallbackComponents || []).length) {
      return primaryComponents || [];
    }
    return scoreSemanticComponentList(fallbackComponents || []) > scoreSemanticComponentList(primaryComponents || [])
      ? (fallbackComponents || [])
      : (primaryComponents || []);
  }

  function mergeSemanticSnapshots(primarySnapshot, fallbackSnapshot) {
    var primary = primarySnapshot || createSemanticSnapshot();
    var fallback = fallbackSnapshot || createSemanticSnapshot();
    var result = createSemanticSnapshot();
    var typeMap = {};

    Object.keys(primary.componentCounts || {}).forEach(function (type) {
      typeMap[type] = true;
    });
    Object.keys(fallback.componentCounts || {}).forEach(function (type) {
      typeMap[type] = true;
    });
    (primary.components || []).forEach(function (component) {
      if (component && component.type) typeMap[component.type] = true;
    });
    (fallback.components || []).forEach(function (component) {
      if (component && component.type) typeMap[component.type] = true;
    });

    var storedComponents = [];
    Object.keys(typeMap).sort().forEach(function (type) {
      var primaryComponents = listSemanticComponentsByType(primary, type);
      var fallbackComponents = listSemanticComponentsByType(fallback, type);
      var resolvedCount = Math.max(
        Number(primary.componentCounts && primary.componentCounts[type] || 0),
        Number(fallback.componentCounts && fallback.componentCounts[type] || 0),
        primaryComponents.length,
        fallbackComponents.length
      );
      if (resolvedCount <= 0) return;
      result.componentCounts[type] = resolvedCount;
      result.totalComponentCount += resolvedCount;

      chooseSemanticComponentsForType(primaryComponents, fallbackComponents).forEach(function (component) {
        if (storedComponents.length >= 40) return;
        storedComponents.push(component);
      });
    });

    result.components = storedComponents;
    result.storedComponentCount = storedComponents.length;
    return result;
  }

  function collectUniqueElements(root, selectors, limit) {
    var seen = [];
    var nodes = [];
    if (!root || typeof root.querySelectorAll !== 'function') return nodes;
    (selectors || []).forEach(function (selector) {
      if (nodes.length >= (limit || 12)) return;
      try {
        Array.prototype.slice.call(root.querySelectorAll(selector), 0, limit || 12).forEach(function (node) {
          if (!node || seen.indexOf(node) !== -1 || nodes.length >= (limit || 12)) return;
          seen.push(node);
          nodes.push(node);
        });
      } catch (error) {}
    });
    return nodes;
  }

  function collectLiteralPlaceholderElements(root, labels, limit) {
    var results = [];
    if (!root || typeof root.querySelectorAll !== 'function') return results;
    Array.prototype.slice.call(root.querySelectorAll('*'), 0, 240).forEach(function (node) {
      if (results.length >= (limit || 8)) return;
      var text = summarizeComponentText(node.textContent || '', 40);
      if (!text) return;
      if ((labels || []).some(function (label) {
        return text === label || text === '[' + label + ']';
      })) {
        results.push(node);
      }
    });
    return results;
  }

  function collectSemanticSnapshotFromStructService() {
    var summary = createSemanticSnapshot();
    var ss = getStructService();
    if (!ss || !ss.rootBlock) return summary;

    function walk(block, depth) {
      if (!block || depth > MAX_BLOCK_DEPTH || !block.record || !block.record.snapshot) return;
      var snap = block.record.snapshot;
      var rawType = String(snap.type || '');
      var componentType = NON_TEXT_COMPONENT_TYPE_MAP[rawType] || '';

      if (rawType === 'page') {
        getBlockChildren(block).forEach(function (child) {
          walk(child, depth + 1);
        });
        return;
      }

      if (rawType === 'callout' && !snap.background_color) {
        var domStyle = extractCalloutStyleFromDOM(block.record.id);
        if (domStyle.background_color) snap.background_color = domStyle.background_color;
        if (domStyle.border_color) snap.border_color = domStyle.border_color;
      }

      if (componentType === 'image') {
        var imageRender = buildRenderedImageSummary(snap.image || {});
        pushSemanticComponent(summary, {
          type: 'image',
          textSample: summarizeComponentText((snap.image && snap.image.name) || '', 80),
          rendered: imageRender.rendered,
          width: imageRender.width,
          height: imageRender.height,
        });
      } else if (componentType === 'table') {
        var matrix = buildTableMatrix(snap, block, decodeBlockText, function (parts) {
          return parts.join(' ').replace(/\s+/g, ' ').trim();
        });
        var cellTexts = [];
        if (matrix && matrix.rows) {
          matrix.rows.forEach(function (row) {
            row.forEach(function (cell) {
              var normalized = summarizeComponentText(cell, 80);
              if (normalized) cellTexts.push(normalized);
            });
          });
        }
        pushSemanticComponent(summary, {
          type: 'table',
          rendered: true,
          rowCount: matrix && matrix.rows ? matrix.rows.length : 0,
          colCount: matrix && matrix.cols ? matrix.cols.length : 0,
          cellTexts: cellTexts.slice(0, 6),
          textSample: cellTexts[0] || '',
        });
      } else if (componentType === 'callout') {
        pushSemanticComponent(summary, {
          type: 'callout',
          rendered: true,
          textSample: summarizeComponentText(selectPrimaryCalloutContent(
            decodeBlockText(snap),
            collectBlockPlainText(block, depth + 1)
          ), 160),
        });
      } else if (componentType === 'quote') {
        pushSemanticComponent(summary, {
          type: 'quote',
          rendered: true,
          textSample: summarizeComponentText(collectBlockPlainText(block, depth), 160),
        });
      } else if (componentType === 'code_block') {
        pushSemanticComponent(summary, {
          type: 'code_block',
          rendered: true,
          textSample: summarizeComponentText(decodeBlockText(snap), 160),
        });
      } else if (componentType === 'divider') {
        pushSemanticComponent(summary, {
          type: 'divider',
          rendered: true,
          textSample: '',
        });
      } else if (componentType === 'grid') {
        var columnCount = getBlockChildren(block).filter(function (child) {
          return child && child.record && child.record.snapshot && child.record.snapshot.type === 'grid_column';
        }).length;
        pushSemanticComponent(summary, {
          type: 'grid',
          rendered: true,
          colCount: columnCount,
          textSample: summarizeComponentText(collectBlockPlainText(block, depth), 160),
        });
      } else if (componentType) {
        pushSemanticComponent(summary, {
          type: componentType,
          rendered: true,
          textSample: summarizeComponentText(collectBlockPlainText(block, depth), 160),
        });
      }

      collectEquationComponentsFromText(decodeBlockText(snap)).forEach(function (component) {
        pushSemanticComponent(summary, component);
      });

      getBlockChildren(block).forEach(function (child) {
        walk(child, depth + 1);
      });
    }

    walk(ss.rootBlock, 0);
    return summary;
  }

  function collectSemanticSnapshotFromDomFallback() {
    var summary = createSemanticSnapshot();
    var root = getValidationSurfaceElement() || getContentRootElement() || document.querySelector(EDITABLE_SELECTOR) || document.body;
    if (!root) return summary;

    collectUniqueElements(root, [
      'figure.docx-image-block img',
      '[data-block-type="image"] img',
      'img',
    ], 12).forEach(function (img) {
      pushSemanticComponent(summary, {
        type: 'image',
        rendered: Number(img.naturalWidth || img.width || 0) > 0 && Number(img.naturalHeight || img.height || 0) > 0,
        width: Number(img.naturalWidth || img.width || 0),
        height: Number(img.naturalHeight || img.height || 0),
        textSample: summarizeComponentText(img.alt || '', 80),
      });
    });

    collectUniqueElements(root, [
      '[data-block-type="table"] table',
      'table',
    ], 8).forEach(function (table) {
      var rows = Array.from(table.querySelectorAll('tr'));
      var firstRow = rows[0] ? Array.from(rows[0].querySelectorAll('th,td')) : [];
      var cellTexts = Array.from(table.querySelectorAll('th,td')).map(function (cell) {
        return summarizeComponentText(cell.textContent || '', 80);
      }).filter(Boolean).slice(0, 6);
      pushSemanticComponent(summary, {
        type: 'table',
        rendered: true,
        rowCount: rows.length,
        colCount: firstRow.length,
        cellTexts: cellTexts,
        textSample: cellTexts[0] || '',
      });
    });

    collectUniqueElements(root, [
      '.zoneType-calloutBlock',
      '.callout-container',
      '.callout-block',
      '[class*="callout"]',
      '[data-block-type="callout"]',
    ], 12).forEach(function (node) {
      pushSemanticComponent(summary, {
        type: 'callout',
        rendered: true,
        textSample: summarizeComponentText(node.textContent || '', 160),
      });
    });

    Array.prototype.slice.call(root.querySelectorAll('blockquote'), 0, 8).forEach(function (node) {
      pushSemanticComponent(summary, {
        type: 'quote',
        rendered: true,
        textSample: summarizeComponentText(node.textContent || '', 160),
      });
    });

    collectUniqueElements(root, [
      'pre',
      '[data-block-type="code"]',
      '[class*="code-block"]',
      '[class*="CodeBlock"]',
    ], 8).forEach(function (node) {
      pushSemanticComponent(summary, {
        type: 'code_block',
        rendered: true,
        textSample: summarizeComponentText(node.textContent || '', 160),
      });
    });

    Array.prototype.slice.call(root.querySelectorAll('hr'), 0, 8).forEach(function () {
      pushSemanticComponent(summary, {
        type: 'divider',
        rendered: true,
        textSample: '',
      });
    });

    Array.prototype.slice.call(root.querySelectorAll('math, mjx-container, [data-latex], .katex, [class*="equation"], [class*="formula"]'), 0, 12).forEach(function (node) {
      pushSemanticComponent(summary, {
        type: 'equation',
        rendered: true,
        textSample: summarizeComponentText(
          node.getAttribute('data-latex') || node.textContent || '',
          160
        ),
      });
    });

    collectUniqueElements(root, [
      '[data-block-type="whiteboard"]',
      '[class*="whiteboard"]',
      '[aria-label*="白板"]',
      '[aria-label*="whiteboard"]',
    ], 8).concat(
      collectLiteralPlaceholderElements(root, ['白板'], 8)
    ).slice(0, 8).forEach(function (node) {
      pushSemanticComponent(summary, {
        type: 'whiteboard',
        rendered: true,
        textSample: summarizeComponentText(node.textContent || node.getAttribute && node.getAttribute('aria-label') || '白板', 80),
      });
    });

    return summary;
  }

  function collectSemanticSnapshot() {
    return mergeSemanticSnapshots(
      collectSemanticSnapshotFromStructService(),
      collectSemanticSnapshotFromDomFallback()
    );
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
      if (typeof Map !== 'undefined' && obj instanceof Map) {
        return Array.from(obj.keys()).slice(0, 120).map(function (key) {
          return String(key);
        }).sort();
      }
      if (typeof Set !== 'undefined' && obj instanceof Set) {
        return Array.from(obj.values()).slice(0, 120).map(function (value) {
          return String(value);
        }).sort();
      }
      return Object.getOwnPropertyNames(obj || {}).sort();
    } catch (err) {
      return [];
    }
  }

  function safeReadProperty(obj, key) {
    try {
      if (typeof Map !== 'undefined' && obj instanceof Map) {
        if (obj.has(key)) {
          return { ok: true, value: obj.get(key) };
        }
        var wantedKey = String(key);
        var matchedValue;
        var foundMatch = false;
        obj.forEach(function (value, mapKey) {
          if (foundMatch) return;
          if (String(mapKey) === wantedKey) {
            matchedValue = value;
            foundMatch = true;
          }
        });
        return { ok: true, value: foundMatch ? matchedValue : undefined };
      }
      if (typeof Set !== 'undefined' && obj instanceof Set) {
        var index = Number(key);
        if (!isFinite(index) || index < 0) return { ok: true, value: undefined };
        return { ok: true, value: Array.from(obj.values())[index] };
      }
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

  function syncWhiteboardHookDebugState() {
    _feishuWhiteboardHookState.logCount = _feishuWhiteboardHookLog.length;
    _feishuWhiteboardHookState.href = location.href;
    try {
      document.documentElement.setAttribute(
        'data-feishu-whiteboard-hook-state',
        JSON.stringify(_feishuWhiteboardHookState)
      );
    } catch (error) {}
    _syncCapturedRequestAttr('data-feishu-whiteboard-hook-log', _feishuWhiteboardHookLog);
  }

  function resetWhiteboardHookDebugLog() {
    _feishuWhiteboardHookLog = [];
    _feishuWhiteboardHookState.errors = [];
    syncWhiteboardHookDebugState();
  }

  function summarizeWhiteboardRecordMap(recordMap) {
    if (!recordMap || typeof recordMap !== 'object') return null;
    var recordIds = Object.keys(recordMap);
    var whiteboardRecords = [];
    recordIds.forEach(function (recordId) {
      var record = recordMap[recordId];
      var snapshot = record && record.snapshot;
      if (!(snapshot && snapshot.type === 'whiteboard')) return;
      whiteboardRecords.push({
        id: String(record && record.id || recordId || ''),
        token: String(snapshot.token || snapshot.blockToken || ''),
        parent_id: String(record && record.parent_id || snapshot.parent_id || ''),
      });
    });
    if (!whiteboardRecords.length) return null;
    return {
      recordCount: recordIds.length,
      whiteboardCount: whiteboardRecords.length,
      whiteboardRecords: whiteboardRecords.slice(0, 6),
    };
  }

  function summarizeWhiteboardHookValue(value, depth, visited) {
    depth = Number(depth || 0);
    if (!visited) visited = createVisitedStore();

    if (value == null) return value;

    var valueType = typeof value;
    if (valueType === 'string') {
      return {
        type: 'string',
        length: value.length,
        preview: summarizeDebugText(value, 220),
      };
    }
    if (valueType === 'number' || valueType === 'boolean') return value;
    if (valueType === 'function') {
      return {
        type: 'function',
        name: String(value.name || ''),
        length: Number(value.length || 0),
        wrapped: value.__feishuWhiteboardHookTracer === true,
      };
    }
    if (visited.has(value)) {
      return {
        type: 'circular',
      };
    }
    visited.add(value);

    if (typeof Promise !== 'undefined' && value instanceof Promise) {
      return { type: 'promise' };
    }
    if (typeof ClipboardEvent !== 'undefined' && value instanceof ClipboardEvent) {
      return {
        type: 'ClipboardEvent',
        trusted: !!value.isTrusted,
        clipboardData: summarizeWhiteboardHookValue(value.clipboardData, depth + 1, visited),
      };
    }
    if (typeof DataTransfer !== 'undefined' && value instanceof DataTransfer) {
      var types = [];
      try { types = Array.from(value.types || []); } catch (error) {}
      return {
        type: 'DataTransfer',
        types: types,
      };
    }
    if (typeof Element !== 'undefined' && value instanceof Element) {
      return {
        type: 'Element',
        tagName: String(value.tagName || ''),
        blockType: String(value.getAttribute && value.getAttribute('data-block-type') || ''),
        ariaLabel: summarizeDebugText(value.getAttribute && value.getAttribute('aria-label') || '', 120),
        className: summarizeDebugText(value.className || '', 120),
        textPreview: summarizeDebugText(value.textContent || '', 120),
      };
    }
    if (Array.isArray(value)) {
      return {
        type: 'array',
        length: value.length,
        sample: value.slice(0, 4).map(function (item) {
          return summarizeWhiteboardHookValue(item, depth + 1, visited);
        }),
      };
    }
    if (typeof Map !== 'undefined' && value instanceof Map) {
      return {
        type: 'Map',
        size: value.size,
        keys: Array.from(value.keys()).slice(0, 8).map(function (item) {
          return summarizeWhiteboardHookValue(item, depth + 1, visited);
        }),
      };
    }
    if (typeof Set !== 'undefined' && value instanceof Set) {
      return {
        type: 'Set',
        size: value.size,
        sample: Array.from(value.values()).slice(0, 4).map(function (item) {
          return summarizeWhiteboardHookValue(item, depth + 1, visited);
        }),
      };
    }

    var keys = safeGetOwnKeys(value).slice(0, 20);
    var summary = {
      type: value && value.constructor && value.constructor.name
        ? String(value.constructor.name)
        : valueType,
      keys: keys,
    };

    [
      'type',
      'blockType',
      'id',
      'name',
      'token',
      'blockToken',
      'whiteboardToken',
      'originWhiteboardToken',
      'originWhiteboardVersion',
      'baseToken',
      'obj_token',
      'objToken',
      'parent_id',
      'parentId',
      'rootId',
      'whiteboardVersion',
      'mode',
      'baseTokenType',
      'reqVersion',
      'status',
      'code',
      'msg',
      'message',
    ].forEach(function (key) {
      var childRead = safeReadProperty(value, key);
      if (!childRead.ok || childRead.value === undefined) return;
      summary[key] = summarizeWhiteboardHookValue(childRead.value, depth + 1, visited);
    });

    if (depth >= 2) {
      return summary;
    }

    ['record', 'snapshot', 'data', 'payload', 'result', 'context'].forEach(function (key) {
      var childRead = safeReadProperty(value, key);
      if (!childRead.ok || !childRead.value || typeof childRead.value !== 'object') return;
      summary[key] = summarizeWhiteboardHookValue(childRead.value, depth + 1, visited);
    });

    var recordMapRead = safeReadProperty(value, 'recordMap');
    if (recordMapRead.ok) {
      summary.recordMap = summarizeWhiteboardRecordMap(recordMapRead.value);
    }

    ['recordIds', 'blockIds', 'selection'].forEach(function (key) {
      var childRead = safeReadProperty(value, key);
      if (!childRead.ok || !Array.isArray(childRead.value)) return;
      summary[key] = {
        length: childRead.value.length,
        sample: childRead.value.slice(0, 6).map(function (item) {
          return summarizeWhiteboardHookValue(item, depth + 1, visited);
        }),
      };
    });

    return summary;
  }

  function summarizeWhiteboardHookArgs(argsLike) {
    return Array.prototype.slice.call(argsLike || []).map(function (arg) {
      return summarizeWhiteboardHookValue(arg, 0, createVisitedStore());
    });
  }

  function recordWhiteboardHookLog(entry) {
    if (!entry || typeof entry !== 'object') return;
    _feishuWhiteboardHookLog.push(entry);
    _feishuWhiteboardHookState.logCount = _feishuWhiteboardHookLog.length;
    syncWhiteboardHookDebugState();
  }

  function createWhiteboardHookLogEntry(meta, phase) {
    return {
      callId: 'whiteboard-hook-' + (++_feishuWhiteboardHookCallSeq),
      phase: String(phase || ''),
      timestamp: Date.now(),
      href: location.href,
      path: meta && meta.path ? String(meta.path) : '',
      feature: meta && meta.feature ? String(meta.feature) : '',
      method: meta && meta.method ? String(meta.method) : '',
      blockType: meta && meta.blockType ? String(meta.blockType) : '',
    };
  }

  function wrapWhiteboardHookFunction(target, methodName, meta) {
    if (!target || typeof target[methodName] !== 'function') {
      return { ok: false, reason: 'missing-function' };
    }

    var current = target[methodName];
    if (current.__feishuWhiteboardHookTracer === true) {
      return { ok: true, alreadyWrapped: true };
    }

    var wrapped = function () {
      var callEntry = createWhiteboardHookLogEntry(meta, 'call');
      callEntry.argsBefore = summarizeWhiteboardHookArgs(arguments);
      callEntry.thisValue = summarizeWhiteboardHookValue(this, 0, createVisitedStore());
      recordWhiteboardHookLog(callEntry);

      var result;
      try {
        result = current.apply(this, arguments);
      } catch (error) {
        var throwEntry = createWhiteboardHookLogEntry(meta, 'throw');
        throwEntry.argsAfter = summarizeWhiteboardHookArgs(arguments);
        throwEntry.error = stringifyError(error);
        recordWhiteboardHookLog(throwEntry);
        throw error;
      }

      var returnEntry = createWhiteboardHookLogEntry(meta, 'return');
      returnEntry.argsAfter = summarizeWhiteboardHookArgs(arguments);
      if (result && typeof result.then === 'function') {
        returnEntry.result = { type: 'promise' };
        recordWhiteboardHookLog(returnEntry);
        return result.then(function (resolved) {
          var resolveEntry = createWhiteboardHookLogEntry(meta, 'resolve');
          resolveEntry.result = summarizeWhiteboardHookValue(resolved, 0, createVisitedStore());
          recordWhiteboardHookLog(resolveEntry);
          return resolved;
        }).catch(function (error) {
          var rejectEntry = createWhiteboardHookLogEntry(meta, 'reject');
          rejectEntry.error = stringifyError(error);
          recordWhiteboardHookLog(rejectEntry);
          throw error;
        });
      }

      returnEntry.result = summarizeWhiteboardHookValue(result, 0, createVisitedStore());
      recordWhiteboardHookLog(returnEntry);
      return result;
    };

    wrapped.__feishuWhiteboardHookTracer = true;
    wrapped.__feishuWhiteboardHookTracerOriginal = current;
    target[methodName] = wrapped;
    return { ok: true, alreadyWrapped: false };
  }

  function listWhiteboardFeatureEntries(featureName) {
    var resolved = resolveEditorPath('editorAPI.featureService._contentMap.' + featureName);
    if (!resolved.ok || !resolved.value) return [];

    var entries = [];
    safeGetOwnKeys(resolved.value).forEach(function (key) {
      var childRead = safeReadProperty(resolved.value, key);
      if (!childRead.ok || !childRead.value) return;
      var entry = childRead.value;
      var blockSetting = entry && entry.blockSetting;
      if (!(blockSetting && String(blockSetting.blockType || '') === 'whiteboard')) return;
      entries.push({
        key: String(key),
        value: entry,
        blockSetting: blockSetting,
      });
    });
    return entries;
  }

  function installWhiteboardHookTracer(options) {
    var opts = options && typeof options === 'object' ? options : {};
    if (opts.reset !== false) {
      resetWhiteboardHookDebugLog();
    }

    var wrappedPaths = [];
    var errors = [];
    var featureMap = resolveEditorPath('editorAPI.featureService._contentMap');
    var featureNames = featureMap.ok && featureMap.value
      ? safeGetOwnKeys(featureMap.value).filter(function (name) {
        return /clipboard|copy|paste/i.test(String(name || ''));
      })
      : [];

    featureNames.forEach(function (featureName) {
      listWhiteboardFeatureEntries(featureName).forEach(function (entry) {
        safeGetOwnKeys(entry.blockSetting).forEach(function (methodName) {
          if (typeof entry.blockSetting[methodName] !== 'function') return;
          if (!/^on[A-Z]/.test(String(methodName || ''))) return;
          var path = 'editorAPI.featureService._contentMap.' + featureName + '.' + entry.key + '.blockSetting.' + methodName;
          try {
            var wrapResult = wrapWhiteboardHookFunction(entry.blockSetting, methodName, {
              path: path,
              feature: featureName,
              blockType: 'whiteboard',
              method: methodName,
            });
            if (wrapResult && wrapResult.ok) {
              wrappedPaths.push({
                path: path,
                alreadyWrapped: wrapResult.alreadyWrapped === true,
              });
            }
          } catch (error) {
            errors.push({
              path: path,
              error: stringifyError(error),
            });
          }
        });
      });
    });

    var whiteboardConfig = resolveEditorPath('editorAPI.dataService.dataProvider.configs.whiteboard');
    if (whiteboardConfig.ok && whiteboardConfig.value && typeof whiteboardConfig.value.createSnapshot === 'function') {
      try {
        var snapshotWrapResult = wrapWhiteboardHookFunction(whiteboardConfig.value, 'createSnapshot', {
          path: 'editorAPI.dataService.dataProvider.configs.whiteboard.createSnapshot',
          feature: 'whiteboard-config',
          blockType: 'whiteboard',
          method: 'createSnapshot',
        });
        if (snapshotWrapResult && snapshotWrapResult.ok) {
          wrappedPaths.push({
            path: 'editorAPI.dataService.dataProvider.configs.whiteboard.createSnapshot',
            alreadyWrapped: snapshotWrapResult.alreadyWrapped === true,
          });
        }
      } catch (error) {
        errors.push({
          path: 'editorAPI.dataService.dataProvider.configs.whiteboard.createSnapshot',
          error: stringifyError(error),
        });
      }
    }

    _feishuWhiteboardHookState = {
      installed: true,
      installedAt: new Date().toISOString(),
      href: location.href,
      wrappedPaths: wrappedPaths,
      featureNames: featureNames,
      logCount: _feishuWhiteboardHookLog.length,
      errors: errors,
    };
    syncWhiteboardHookDebugState();
    return _feishuWhiteboardHookState;
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
    // Feishu internal snapshot may store colors as integer codes
    var num = Number(value);
    if (num > 0 && num <= 14 && FEISHU_BG_COLOR_TO_CSS[num]) return FEISHU_BG_COLOR_TO_CSS[num];
    if (num > 0 && num <= 7 && FEISHU_TEXT_COLOR_TO_CSS[num]) return FEISHU_TEXT_COLOR_TO_CSS[num];
    value = String(value || '').trim();
    return isSafeCssColor(value) ? value : '';
  }

  function normalizeTextAlign(value) {
    // Feishu internal snapshot may store align as integer: 1=left, 2=center, 3=right
    var num = Number(value);
    if (num === 1) return 'left';
    if (num === 2) return 'center';
    if (num === 3) return 'right';
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

  // Feishu internal color codes (integers) mapped to CSS hex values.
  // Background colors use the fontBgColorMap (1–14), text colors use fontColorMap (1–7).
  var FEISHU_BG_COLOR_TO_CSS = {
    1: '#fef2f2', 2: '#fff7ed', 3: '#fefce8', 4: '#f0fdf4',
    5: '#eff6ff', 6: '#faf5ff', 7: '#f9fafb',
    8: '#fecaca', 9: '#fed7aa', 10: '#fef08a', 11: '#bbf7d0',
    12: '#bfdbfe', 13: '#e9d5ff', 14: '#e5e7eb',
  };
  var FEISHU_TEXT_COLOR_TO_CSS = {
    1: '#ef4444', 2: '#f97316', 3: '#eab308', 4: '#22c55e',
    5: '#3b82f6', 6: '#a855f7', 7: '#6b7280',
  };
  // Callout border_color uses a separate enum (1-7) with different color values than background_color.
  var FEISHU_BORDER_COLOR_TO_CSS = {
    1: '#fecaca', 2: '#fed7aa', 3: '#fef08a', 4: '#bbf7d0',
    5: '#bfdbfe', 6: '#e9d5ff', 7: '#e5e7eb',
  };

  // Reverse maps: CSS hex → Feishu integer code
  var CSS_TO_FEISHU_BG_COLOR = {};
  Object.keys(FEISHU_BG_COLOR_TO_CSS).forEach(function (k) {
    CSS_TO_FEISHU_BG_COLOR[FEISHU_BG_COLOR_TO_CSS[k].toLowerCase()] = Number(k);
  });
  var CSS_TO_FEISHU_TEXT_COLOR = {};
  Object.keys(FEISHU_TEXT_COLOR_TO_CSS).forEach(function (k) {
    CSS_TO_FEISHU_TEXT_COLOR[FEISHU_TEXT_COLOR_TO_CSS[k].toLowerCase()] = Number(k);
  });
  var CSS_TO_FEISHU_BORDER_COLOR = {};
  Object.keys(FEISHU_BORDER_COLOR_TO_CSS).forEach(function (k) {
    CSS_TO_FEISHU_BORDER_COLOR[FEISHU_BORDER_COLOR_TO_CSS[k].toLowerCase()] = Number(k);
  });

  function cssColorToFeishuBgCode(cssColor) {
    if (!cssColor) return 0;
    var hex = cssColorToHex(cssColor);
    if (!hex) return 0;
    return CSS_TO_FEISHU_BG_COLOR[hex.toLowerCase()] || 0;
  }

  function cssColorToFeishuBorderColorCode(cssColor) {
    if (!cssColor) return 0;
    var hex = cssColorToHex(cssColor);
    if (!hex) return 0;
    return CSS_TO_FEISHU_BORDER_COLOR[hex.toLowerCase()] || 0;
  }

  function cssColorToFeishuTextCode(cssColor) {
    if (!cssColor) return 0;
    var hex = cssColorToHex(cssColor);
    if (!hex) return 0;
    return CSS_TO_FEISHU_TEXT_COLOR[hex.toLowerCase()] || 0;
  }

  function cssColorToHex(cssColor) {
    cssColor = String(cssColor || '').trim();
    if (!cssColor) return '';
    if (cssColor.charAt(0) === '#') return cssColor;
    var rgbMatch = cssColor.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (!rgbMatch) return cssColor;
    var r = parseInt(rgbMatch[1], 10);
    var g = parseInt(rgbMatch[2], 10);
    var b = parseInt(rgbMatch[3], 10);
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  }

  // Feishu align codes: 1=left, 2=center, 3=right
  function alignStringToFeishuCode(alignStr) {
    if (alignStr === 'left') return 1;
    if (alignStr === 'center') return 2;
    if (alignStr === 'right') return 3;
    return 0;
  }

  function feishuCodeToAlignString(code) {
    code = Number(code) || 0;
    if (code === 1) return 'left';
    if (code === 2) return 'center';
    if (code === 3) return 'right';
    return '';
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
    // Feishu paste parser expects integer color codes and align codes in recordData/metaBlockProps.
    var bgColorCode = cssColorToFeishuBgCode(backgroundColor);
    var borderColorCode = cssColorToFeishuBorderColorCode(borderColor);
    var textColorCode = cssColorToFeishuTextCode(textColor);
    var alignCode = alignStringToFeishuCode(align);
    var snapshot = {
      type: 'callout',
      emoji_id: emojiId,
      background_color: bgColorCode,
      border_color: borderColorCode,
      text_color: textColorCode,
      align: alignCode,
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
        background_color: bgColorCode,
        border_color: borderColorCode,
        text_color: textColorCode,
        align: alignCode,
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
            backgroundColor: bgColorCode,
            borderColor: borderColorCode,
            textColor: textColorCode,
            align: alignCode,
            calloutType: calloutType,
            text: text,
            normalizedStyle: normalizedStyleMetadata,
          },
        },
      }),
    };
  }

  function buildImageClipboardMetadata(snap, normalizedStyle) {
    var blockId = String(snap && (snap.block_id || snap.blockId) || nextSyntheticClipboardId('image_block'));
    var recordId = String(snap && (snap.record_id || snap.recordId) || nextSyntheticClipboardId('image_record'));
    var normalizedBlockStyle = normalizedStyle || normalizeBlockStyle(snap);
    var normalizedStyleMetadata = {
      align: normalizedBlockStyle.align,
      imageAlign: normalizedBlockStyle.imageAlign,
    };
    var imageInfo = snap && snap.image ? snap.image : {};
    var imageToken = imageInfo.token || '';
    var imageWidth = imageInfo.width || 0;
    var imageHeight = imageInfo.height || 0;
    var imageAlign = normalizedBlockStyle.imageAlign || 'center';
    // Feishu paste parser expects integer align code (1=left, 2=center, 3=right).
    var alignCode = alignStringToFeishuCode(imageAlign);
    var snapshot = {
      type: 'image',
      align: alignCode,
      image: {
        token: imageToken,
        width: imageWidth,
        height: imageHeight,
      },
      normalizedStyle: normalizedStyleMetadata,
    };

    return {
      blockId: blockId,
      recordId: recordId,
      recordData: JSON.stringify({
        rootId: recordId,
        blockId: blockId,
        recordId: recordId,
        type: 'image',
        align: alignCode,
        image: {
          token: imageToken,
          width: imageWidth,
          height: imageHeight,
        },
        normalizedStyle: normalizedStyleMetadata,
        snapshot: snapshot,
      }),
      metaBlockProps: JSON.stringify({
        blockId: blockId,
        recordId: recordId,
        blockType: 'IMAGE_BLOCK',
        props: {
          data: {
            align: alignCode,
            token: imageToken,
            width: imageWidth,
            height: imageHeight,
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
      return /\b(docx-[\w-]+|callout-[\w-]+|lark-record-clipboard|zoneType-[\w-]+)\b/i.test(String(attr.value || ''));
    }

    var preservedDataAttrs = {
      'data-block-type': true,
      'data-block-id': true,
      'data-record-id': true,
      'data-feishu-downgraded-images': true,
      'data-emoji-id': true,
      'data-lark-record-data': true,
      'data-lark-record-format': true,
      'data-meta-block-props': true,
      'data-page-id': true,
      'data-lark-html-role': true,
      'data-docx-has-block-data': true,
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

  function buildClipboardHtml(bodyHtml, docxRecord, hasDowngradedImages) {
    var fragment = finalizeHtmlFragment(bodyHtml);
    // When images have been downgraded to base64, the docx/record no longer
    // contains image blocks.  Feishu's paste handler prioritises docx/record
    // over HTML, so if we keep data-docx-has-block-data="true" AND include
    // docx/record on the clipboard, the images in the HTML body are silently
    // dropped.  Setting the flag to "false" (and omitting docx/record from the
    // clipboard) forces Feishu to walk the HTML paste path, which can convert
    // base64 <img> tags into image blocks via the text/html format handler.
    var blockDataFlag = (hasDowngradedImages ? 'false' : 'true');
    var rootAttr = ' data-page-id="" data-lark-html-role="root" data-docx-has-block-data="' + blockDataFlag + '"';
    return '<meta charset="utf-8"><div' + rootAttr + '>' + fragment + '</div>';
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
        var imageMeta = buildImageClipboardMetadata(snap, normalizedBlockStyle);
        return '<figure class="block docx-image-block" data-block-type="image" data-block-id="' + escapeAttr(imageMeta.blockId) + '" data-record-id="' + escapeAttr(imageMeta.recordId) + '" data-lark-record-data="' + escapeAttr(imageMeta.recordData) + '" data-meta-block-props="' + escapeAttr(imageMeta.metaBlockProps) + '" style="' + escapeAttr(buildBlockStyle('margin:1em 0;text-align:' + imageAlign + ';', snap, '', normalizedBlockStyle, { applyAlign: false })) + '"><img src="' + escapeAttr(imageAsset.src) + '" alt="' + escapeAttr(imageAsset.alt) + '" style="max-width:100%;height:auto;display:block;' + imageMargin + '" />' + caption + '</figure>';
      case 'callout':
        var emoji = getEmoji(normalizedBlockStyle.calloutEmojiId);
        var bgColor = normalizedBlockStyle.backgroundColor;
        var borderColor = normalizedBlockStyle.borderColor;
        var calloutTextHtml = text ? '<p style="margin:0;">' + text + '</p>' : '';
        var calloutBodyHtml = selectPrimaryCalloutContent(calloutTextHtml, childHtml);
        var calloutRecordId = block && block.record && block.record.id ? block.record.id : nextSyntheticClipboardId('callout_record');
        // Match Feishu's native HTML structure for callout blocks.
        // The paste parser recognizes zoneType-calloutBlock, callout-container, callout-block.
        return '<div class="zoneType-calloutBlock old-record-id-' + escapeAttr(calloutRecordId) + '"><div class="callout-container" data-emoji-id="' + escapeAttr(normalizedBlockStyle.calloutEmojiId) + '"><div class="callout-block" style="background-color:' + escapeAttr(bgColor || '') + ';border-color:' + escapeAttr(borderColor || '') + ';border-radius:8px;">' + calloutBodyHtml + '</div></div></div>';
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
    var root = getValidationSurfaceElement() || getContentRootElement() || document.querySelector(EDITABLE_SELECTOR) || document.body;
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

  // Build a docx/record payload matching Feishu's native clipboard format.
  // Feishu's paste parser reads the docx/record MIME type and uses recordMap
  // Deep-clone a snapshot, stripping non-serializable / internal fields that
  // Feishu's server rejects (React fibers, circular refs, internal keys, etc.).
  function sanitizeSnapshotForRecord(snap) {
    if (!snap || typeof snap !== 'object') return snap;
    // Keys that are internal to the editor and must NOT appear in paste data.
    var internalKeys = {
      _reactRootContainer: true,
      _owner: true,
      _store: true,
      _self: true,
      _source: true,
      __reactInternalInstance$: true,
      __reactFiber$: true,
    };
    try {
      return JSON.parse(JSON.stringify(snap, function (key, value) {
        if (internalKeys[key]) return undefined;
        // Skip functions and symbols entirely.
        if (typeof value === 'function' || typeof value === 'symbol') return undefined;
        return value;
      }));
    } catch (e) {
      // If JSON.stringify fails (circular ref), fall back to shallow clone of safe keys.
      var out = {};
      Object.keys(snap).forEach(function (k) {
        if (internalKeys[k]) return;
        var v = snap[k];
        if (typeof v === 'function' || typeof v === 'symbol') return;
        try { JSON.stringify(v); out[k] = v; } catch (e2) {}
      });
      return out;
    }
  }

  // to reconstruct block structure (type, children, style properties).
  function buildDocxRecordPayload(ss) {
    if (!ss || !ss.rootBlock) return null;
    var recordMap = {};
    var blockIds = [];
    var recordIds = [];
    var rootId = '';
    var payloadMap = {};

    function walk(block, depth, parentBlock) {
      if (!block || depth > MAX_BLOCK_DEPTH) return;
      if (block.record && block.record.id && block.record.snapshot) {
        var snap = block.record.snapshot;
        var recordId = block.record.id;
        var cleanSnap = sanitizeSnapshotForRecord(snap);

        recordMap[recordId] = { id: recordId, snapshot: cleanSnap };

        if (cleanSnap.type === 'page') {
          if (!rootId) rootId = recordId;
        } else {
          // Only page's direct children go into recordIds/blockIds/selection.
          // Deeper blocks are referenced via parent's "children" array in snapshot
          // and go into payloadMap only — matching Feishu's native copy format.
          var isDirectChildOfPage = parentBlock && parentBlock.record &&
            parentBlock.record.snapshot && parentBlock.record.snapshot.type === 'page';
          if (isDirectChildOfPage) {
            recordIds.push(recordId);
            blockIds.push(recordIds.length + 1);
          } else if (parentBlock && parentBlock.record && parentBlock.record.snapshot) {
            var parentType = parentBlock.record.snapshot.type;
            if (parentType && parentType !== 'page') {
              payloadMap[recordId] = { level: depth };
            }
          }
        }
      }
      getBlockChildren(block).forEach(function (child) {
        walk(child, depth + 1, block);
      });
    }

    walk(ss.rootBlock, 0, null);
    if (!rootId || !recordIds.length) return null;

    return {
      isCut: false,
      rootId: rootId,
      parentId: rootId,
      blockIds: blockIds,
      recordIds: recordIds,
      recordMap: recordMap,
      payloadMap: payloadMap,
      extra: {
        channel: 'saas',
        pasteRandomId: generateRandomId(),
        mention_page_title: {},
        external_mention_url: {},
        isEqualBlockSelection: true,
      },
      isKeepQuoteContainer: false,
      selection: recordIds.map(function(rid, i) {
        return { id: i + 2, type: 'block', recordId: rid };
      }),
      pasteFlag: generateRandomId(),
    };
  }

  function generateRandomId() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      var r = Math.random() * 16 | 0;
      var v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  // Extract callout style (background_color, border_color) from the rendered DOM
  // because Feishu structService snapshot does not store these values.
  // Feishu's native docx/record uses CSS rgb strings like "rgb(236,226,254)".
  function extractCalloutStyleFromDOM(blockId) {
    var result = { background_color: '', border_color: '' };
    try {
      // Feishu renders callout blocks with data-block-id attributes
      var escapedId = blockId ? blockId.replace(/"/g, '\\"') : '';
      var selector = escapedId
        ? '[data-block-id="' + escapedId + '"]'
        : '[data-block-type="callout"]';
      var el = document.querySelector(selector);
      if (!el) {
        // Fallback: search by class
        var callouts = document.querySelectorAll('.docx-callout-block, .callout-container');
        for (var i = 0; i < callouts.length; i++) {
          if (callouts[i].getAttribute('data-block-id') === blockId || !blockId) {
            el = callouts[i];
            break;
          }
        }
      }
      if (!el) return result;
      var computed = window.getComputedStyle(el);
      var bg = computed.backgroundColor;
      var brd = computed.borderColor || computed.borderLeftColor;
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
        result.background_color = normalizeCssRgb(bg);
      }
      if (brd && brd !== 'rgba(0, 0, 0, 0)' && brd !== 'transparent') {
        result.border_color = normalizeCssRgb(brd);
      }
    } catch (e) {}
    return result;
  }

  // Normalize CSS rgb() to Feishu's format: "rgb(R,G,B)" (no spaces).
  function normalizeCssRgb(str) {
    if (!str) return '';
    var m = str.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (m) return 'rgb(' + m[1] + ',' + m[2] + ',' + m[3] + ')';
    return str;
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

        // Callout colors are not stored in the structService snapshot.
        // Read them from the rendered DOM element instead.
        if (type === 'callout' && !snap.background_color) {
          var domStyle = extractCalloutStyleFromDOM(block.record.id);
          if (domStyle.background_color) snap.background_color = domStyle.background_color;
          if (domStyle.border_color) snap.border_color = domStyle.border_color;
        }

        blockTypeCounts[type] = (blockTypeCounts[type] || 0) + 1;

        var decoded = decodeBlockText(snap);
        if (type === 'image') imageBlockCount++;
        if (decoded.includes('$')) {
          equationCount++;
          equationBlockCount++;
        }

        var childContent = collectRenderedChildBlocks(block, depth, processBlockInner);
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
    if (!blockCount && !finalText && !finalHtml) {
      return extractVisibleDomFallback();
    }
    var docxRecord = buildDocxRecordPayload(ss);
    lastDocxRecord = docxRecord;
    var result = {
      html: finalHtml,
      text: finalText,
      blockCount: blockCount,
      equationCount: equationCount,
      docxRecord: docxRecord ? JSON.stringify(docxRecord) : '',
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
  var SHARED_PENDING_PASTE_KEY = '__feishu_helper_pending_paste__';
  var lastExtractionDebug = null;
  var imageConversionStatus = {
    state: 'idle',
    done: 0,
    total: 0,
    updatedAt: 0,
    error: '',
  };
  var lastPendingPasteTimestamp = 0;
  var _uploadedTokenMapPendingTs = 0;

  function setDocumentAttribute(name, value) {
    try {
      if (value === null || value === undefined || value === '') {
        document.documentElement.removeAttribute(name);
      } else {
        document.documentElement.setAttribute(name, String(value));
      }
    } catch (e) {}
  }

  function setDocumentJsonAttribute(name, value) {
    try {
      setDocumentAttribute(name, JSON.stringify(value));
    } catch (e) {}
  }

  function stringifyError(error) {
    return String(error && error.stack ? error.stack : error && error.message ? error.message : error);
  }

  function syncValidationSnapshotToDom(snap) {
    if (!snap) return;
    setDocumentJsonAttribute('data-feishu-validation-snapshot', {
      title: snap.title || '',
      blockCount: Number(snap.blockCount || 0),
      equationCount: Number(snap.equationCount || 0),
      textLength: Number(snap.textLength || 0),
      htmlLength: Number(snap.htmlLength || 0),
      styleSummary: snap.styleSummary || null,
      semanticSnapshot: snap.semanticSnapshot || null,
    });
  }

  function syncExtractionResultToDom(result, extra) {
    captureValidationSnapshot();
    setDocumentJsonAttribute('data-feishu-extraction-result', Object.assign({
      title: result && result.title || '',
      blockCount: Number(result && result.blockCount || 0),
      equationCount: Number(result && result.equationCount || 0),
      imageCount: Number(result && result.imageCount || 0),
      inlinedImageCount: Number(result && result.inlinedImageCount || 0),
      textLen: Number(result && result.textLen || 0),
      htmlLen: Number(result && result.htmlLen || 0),
      clipboardHtmlLen: Number(result && result.clipboardHtmlLen || 0),
      payloadError: Boolean(result && result.payloadError),
      semanticSnapshot: result && result.semanticSnapshot || null,
      ts: Date.now(),
    }, extra || {}));
  }

  function updateImageConversionStatus(patch) {
    imageConversionStatus = Object.assign({}, imageConversionStatus, patch || {}, {
      updatedAt: Date.now(),
    });
    // Sync to DOM for cross-context visibility (AppleScript JS context).
    setDocumentJsonAttribute('data-feishu-img-conv-status', imageConversionStatus);
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
    setDocumentAttribute('data-feishu-extraction-debug-ts', lastExtractionDebug.ts);
    return lastExtractionDebug;
  }

  function getLastExtractionDebug() {
    return lastExtractionDebug ? Object.assign({}, lastExtractionDebug) : null;
  }

  function clonePendingPasteData(data) {
    if (!data || typeof data !== 'object') return null;
    try {
      return JSON.parse(JSON.stringify(data));
    } catch (e) {
      return null;
    }
  }

  function isPendingPasteFresh(data) {
    return !!(data && data.ts && Date.now() - data.ts < 3600000);
  }

  function canUseSharedPendingPasteStorage() {
    return typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
  }

  function getSharedPendingPaste() {
    if (!canUseSharedPendingPasteStorage()) return null;
    try {
      var data = GM_getValue(SHARED_PENDING_PASTE_KEY, null);
      return clonePendingPasteData(data);
    } catch (e) {
      return null;
    }
  }

  function setSharedPendingPaste(data) {
    if (!canUseSharedPendingPasteStorage()) return;
    try {
      GM_setValue(SHARED_PENDING_PASTE_KEY, clonePendingPasteData(data));
    } catch (e) {}
  }

  function deleteSharedPendingPaste() {
    if (typeof GM_deleteValue !== 'function') return;
    try {
      GM_deleteValue(SHARED_PENDING_PASTE_KEY);
    } catch (e) {}
  }

  function clearUploadedTokenMap(reason) {
    _uploadedTokenMap = {};
    _uploadedTokenMapPendingTs = 0;
    setDocumentAttribute('data-feishu-debug', reason || 'uploaded-token-map-cleared');
  }

  function ensureUploadedTokenMapMatchesPending(pendingPaste) {
    if (!pendingPaste || !_uploadedTokenMapPendingTs) return pendingPaste;
    if (pendingPaste.ts && pendingPaste.ts > _uploadedTokenMapPendingTs) {
      clearUploadedTokenMap('stale-uploaded-token-map-cleared');
    }
    return pendingPaste;
  }

  function mergeUploadedTokenMap(tokenMap) {
    if (!tokenMap || typeof tokenMap !== 'object') {
      _uploadedTokenMapPendingTs = Date.now();
      return Object.keys(_uploadedTokenMap).length;
    }
    Object.keys(tokenMap).forEach(function (key) {
      _uploadedTokenMap[key] = tokenMap[key];
    });
    _uploadedTokenMapPendingTs = Date.now();
    return Object.keys(_uploadedTokenMap).length;
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

  // ── Token replacement map for uploaded images ──
  // Set by the runner after successfully uploading images to the target document.
  var _uploadedTokenMap = {};

  function getLocalPendingPaste() {
    return openDB().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction(DB_STORE, 'readonly');
        var req = tx.objectStore(DB_STORE).get(DB_KEY);
        req.onsuccess = function () {
          var data = req.result;
          if (isPendingPasteFresh(data)) {
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

  function setLocalPendingPaste(data) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).put(data, DB_KEY);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function getPendingPaste() {
    return getLocalPendingPaste().then(function (localData) {
      var sharedData = getSharedPendingPaste();
      if (!isPendingPasteFresh(sharedData)) {
        if (sharedData) deleteSharedPendingPaste();
        sharedData = null;
      }
      var chosen = localData;
      if (sharedData && (!chosen || Number(sharedData.ts || 0) > Number(chosen.ts || 0))) {
        chosen = sharedData;
      }
      if (chosen && chosen !== localData) {
        return setLocalPendingPaste(chosen).catch(function () {
          return null;
        }).then(function () {
          return ensureUploadedTokenMapMatchesPending(chosen);
        });
      }
      return ensureUploadedTokenMapMatchesPending(chosen);
    }).catch(function () { return null; });
  }

  function setPendingPaste(data) {
    return openDB().then(function () {
      return new Promise(function (resolve, reject) {
        data.ts = Date.now();
        data.savedFromHost = location.host;
        data.savedFromHref = location.href;
        lastPendingPasteTimestamp = data.ts;
        try {
          document.documentElement.setAttribute('data-feishu-pending-paste-ts', String(data.ts));
        } catch (e) {}
        setSharedPendingPaste(data);
        setLocalPendingPaste(data).then(function () {
          resolve();
        }).catch(function (error) {
          reject(error);
        });
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

  // Tiny 1x1 transparent PNG placeholder for clipboard HTML.
  // We keep the clipboard HTML small so Feishu's paste handler can process it,
  // and store the actual base64 data separately in IndexedDB for post-paste injection.
  var IMAGE_PLACEHOLDER_SRC = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  function convertImagesToBase64(html) {
    var imgUrls = [];
    var tokenToBase64 = {}; // token → base64 mapping for recordMap patching
    // Match various Feishu image URL formats:
    // 1. /space/api/box/stream/download/preview/TOKEN
    // 2. /space/api/box/stream/download/v2/cover/TOKEN
    // 3. /space/api/box/stream/download/all/?token=TOKEN
    // 4. CDN URLs: feishucdn.com/static-resource/v1/TOKEN~?...
    var urlRegex = /src="(https?:\/\/[^"]+?(?:\/space\/api\/box\/stream\/download\/(?:preview\/|v2\/cover\/|all\/)|(?:feishucdn\.com\/static-resource\/v1\/))([A-Za-z0-9_.~-]+)[^"]*)"/g;
    var match;
    while ((match = urlRegex.exec(html)) !== null) {
      imgUrls.push({ url: match[1], full: match[0], token: match[2] });
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
            // Store the full base64 data for post-paste injection,
            // but replace the HTML src with a tiny placeholder to keep
            // the clipboard payload small.
            html = html.replace(item.full, 'src="' + IMAGE_PLACEHOLDER_SRC + '"');
            if (item.token) tokenToBase64[item.token] = base64;
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
      return { html: html, tokenToBase64: tokenToBase64 };
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

  function pruneRemovedRecordIds(value, removedIds) {
    if (!value || !removedIds || removedIds.size === 0) return value;
    if (Array.isArray(value)) {
      var next = [];
      value.forEach(function (item) {
        if (typeof item === 'string' && removedIds.has(item)) return;
        if (item && typeof item === 'object' && typeof item.recordId === 'string' && removedIds.has(item.recordId)) return;
        next.push(pruneRemovedRecordIds(item, removedIds));
      });
      return next;
    }
    if (typeof value !== 'object') return value;
    Object.keys(value).forEach(function (key) {
      value[key] = pruneRemovedRecordIds(value[key], removedIds);
    });
    return value;
  }

  // Remove image blocks from a docxRecord so that the docxRecord paste path
  // creates all non-image blocks with full structure (grid, table, callout etc.)
  // while skipping the image blocks (which have invalid tokens in the target).
  // We inject base64 images into the editor after the paste.
  function removeImageBlocksFromDocxRecord(docxRecordObj) {
    if (!docxRecordObj) return docxRecordObj;
    var recordMap = docxRecordObj.recordMap || {};
    var removedIds = new Set();

    // First pass: find all image block recordIds
    Object.keys(recordMap).forEach(function (recordId) {
      var record = recordMap[recordId];
      if (record && record.snapshot && record.snapshot.type === 'image') {
        removedIds.add(recordId);
      }
    });

    if (removedIds.size === 0) return docxRecordObj;

    // Deep clone to avoid mutating the original
    var clone = JSON.parse(JSON.stringify(docxRecordObj));
    var cleanMap = clone.recordMap || {};

    // Remove image records from recordMap
    removedIds.forEach(function (id) {
      delete cleanMap[id];
    });

    // Remove image recordIds from recordIds, blockIds, selection
    if (clone.recordIds) {
      clone.recordIds = clone.recordIds.filter(function (id) { return !removedIds.has(id); });
    }
    if (clone.blockIds) {
      var newBlockIds = [];
      clone.recordIds.forEach(function (_, i) { newBlockIds.push(i + 1); });
      clone.blockIds = newBlockIds;
    }
    if (clone.selection) {
      clone.selection = clone.selection.filter(function (s) { return !removedIds.has(s.recordId); });
    }

    // Remove image children from parent snapshots
    Object.keys(cleanMap).forEach(function (recordId) {
      var record = cleanMap[recordId];
      if (record && record.snapshot && record.snapshot.children) {
        record.snapshot.children = record.snapshot.children.filter(function (childId) {
          return !removedIds.has(childId);
        });
      }
    });

    // Also clean payloadMap if present
    if (clone.payloadMap) {
      removedIds.forEach(function (id) { delete clone.payloadMap[id]; });
    }

    return clone;
  }

  function stripStructuredImageAttrsFromHtml(html) {
    if (!html || typeof html !== 'string') return html || '';
    return html.replace(/<figure\b([^>]*)>([\s\S]*?<img\b[^>]*src="data:image\/[^"]+"[^>]*>[\s\S]*?)<\/figure>/gi, function (full, attrs, inner) {
      var cleanedAttrs = String(attrs || '')
        .replace(/\sdata-block-type="[^"]*"/gi, '')
        .replace(/\sdata-block-id="[^"]*"/gi, '')
        .replace(/\sdata-record-id="[^"]*"/gi, '')
        .replace(/\sdata-lark-record-data="[^"]*"/gi, '')
        .replace(/\sdata-meta-block-props="[^"]*"/gi, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
      cleanedAttrs = (cleanedAttrs ? cleanedAttrs + ' ' : '') + 'data-feishu-downgraded-images="true"';
      return '<figure ' + cleanedAttrs.trim() + '>' + inner + '</figure>';
    });
  }

  function downgradeStructuredImagesForPaste(docxRecordObj, html) {
    if (!docxRecordObj || !docxRecordObj.recordMap || typeof docxRecordObj.recordMap !== 'object') {
      return {
        docxRecord: docxRecordObj,
        html: html || '',
        removedImageRecordIds: [],
      };
    }

    var imageRecordIds = Object.keys(docxRecordObj.recordMap).filter(function (recordId) {
      var record = docxRecordObj.recordMap[recordId];
      return !!(record && record.snapshot && record.snapshot.type === 'image');
    });

    if (!imageRecordIds.length) {
      return {
        docxRecord: docxRecordObj,
        html: html || '',
        removedImageRecordIds: [],
      };
    }

    var removedIds = new Set(imageRecordIds);

    if (Array.isArray(docxRecordObj.recordIds)) {
      var paired = docxRecordObj.recordIds.map(function (recordId, index) {
        return {
          recordId: recordId,
          blockId: Array.isArray(docxRecordObj.blockIds) ? docxRecordObj.blockIds[index] : undefined,
        };
      });
      var kept = paired.filter(function (entry) {
        return !removedIds.has(entry.recordId);
      });
      docxRecordObj.recordIds = kept.map(function (entry) { return entry.recordId; });
      if (Array.isArray(docxRecordObj.blockIds)) {
        docxRecordObj.blockIds = kept.map(function (entry) { return entry.blockId; });
      }
    }

    if (Array.isArray(docxRecordObj.selection)) {
      docxRecordObj.selection = docxRecordObj.selection.filter(function (entry) {
        return !(entry && removedIds.has(entry.recordId));
      });
    }

    if (docxRecordObj.payloadMap && typeof docxRecordObj.payloadMap === 'object') {
      imageRecordIds.forEach(function (recordId) {
        delete docxRecordObj.payloadMap[recordId];
      });
    }

    Object.keys(docxRecordObj.recordMap).forEach(function (recordId) {
      var record = docxRecordObj.recordMap[recordId];
      if (!record || !record.snapshot) return;
      record.snapshot = pruneRemovedRecordIds(record.snapshot, removedIds);
    });

    imageRecordIds.forEach(function (recordId) {
      delete docxRecordObj.recordMap[recordId];
    });

    return {
      docxRecord: docxRecordObj,
      html: stripStructuredImageAttrsFromHtml(html || ''),
      removedImageRecordIds: imageRecordIds,
    };
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
          var validationSnapshot = captureValidationSnapshot();
          var semanticSnapshot = validationSnapshot && validationSnapshot.semanticSnapshot
            ? validationSnapshot.semanticSnapshot
            : null;
          var hasDowngradedImages = !!(payload && payload.hasDowngradedImages) || /data-feishu-downgraded-images="true"/i.test(String(payload && payload.html || ''));
          var hasImagesToInject = !!(payload && payload.hasImagesToInject);
          var orderedImageBase64List = (payload && payload.orderedImageBase64List) || [];
          var withBase64 = orderedImageBase64List.filter(function (img) { return !!img.base64; }).length;
          setDocumentAttribute('data-feishu-debug',
            'extraction-listLen=' + orderedImageBase64List.length + '-withBase64=' + withBase64);
          // Use the docxRecord from the payload (which has image blocks removed
          // when images need injection).  Don't fall back to content.docxRecord
          // which would include the invalid image tokens.
          var effectiveDocxRecord = (payload && payload.docxRecord) || '';
          return setPendingPaste({
            html: content.html,
            text: content.text,
            clipboardHtml: payload.html,
            docxRecord: effectiveDocxRecord,
            title: docTitle,
            hasDowngradedImages: hasDowngradedImages,
            hasImagesToInject: hasImagesToInject,
            hasImagesToUpload: !!(payload && payload.hasImagesToUpload),
            orderedImageBase64List: orderedImageBase64List,
            semanticSnapshot: semanticSnapshot,
            originalDocxRecordObj: payload && payload.originalDocxRecordObj ? payload.originalDocxRecordObj : null,
          }).then(function () {
            var imgCount = countExtractedImages(content);
            var inlinedImgCount = (payload.html.match(/data:image/g) || []).length;
            var injectCount = orderedImageBase64List.length;
            var toastMsg = '✅ 已提取 ' + content.blockCount + ' 块 · ' + content.equationCount + ' 公式 · ' + imgCount + ' 图片';
            if (injectCount > 0) toastMsg += ' · ' + injectCount + ' 张待注入';
            showToast(toastMsg, 3200);
            var result = {
              title: docTitle,
              blockCount: Number(content.blockCount || 0),
              equationCount: Number(content.equationCount || 0),
              imageCount: imgCount,
              inlinedImageCount: inlinedImgCount,
              textLen: String(content.text || '').length,
              htmlLen: String(content.html || '').length,
              clipboardHtmlLen: String(payload.html || '').length,
              hasDowngradedImages: hasDowngradedImages,
              hasImagesToInject: hasImagesToInject,
              imageInjectCount: orderedImageBase64List.length,
              semanticSnapshot: semanticSnapshot,
              extractionDebug: content.extractionDebug || getLastExtractionDebug(),
            };
            syncExtractionResultToDom(result, {
              hasDowngradedImages: result.hasDowngradedImages,
              hasImagesToInject: result.hasImagesToInject,
              imageInjectCount: result.imageInjectCount,
              imageInjectWithBase64: withBase64,
            });
            resolve(result);
          });
        }).catch(function () {
          var fallbackValidationSnapshot = captureValidationSnapshot();
          var fallbackSemanticSnapshot = fallbackValidationSnapshot && fallbackValidationSnapshot.semanticSnapshot
            ? fallbackValidationSnapshot.semanticSnapshot
            : null;
          setPendingPaste({
            html: content.html,
            text: content.text,
            title: docTitle,
            semanticSnapshot: fallbackSemanticSnapshot,
          }).then(function () {
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
              semanticSnapshot: fallbackSemanticSnapshot,
              extractionDebug: content.extractionDebug || getLastExtractionDebug(),
            };
            syncExtractionResultToDom(result);
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
        hasDowngradedImages: Boolean(pending.hasDowngradedImages),
        semanticSnapshot: pending.semanticSnapshot || null,
        ts: Number(pending.ts || 0),
      };
    });
  }

  function getPendingPasteTimestamp() {
    return lastPendingPasteTimestamp;
  }

  function buildValidateDuplicateDocumentSummary() {
    return duplicateDocumentForAutomation().then(function (summary) {
      return summarizePendingPasteForAutomation().then(function (pendingPaste) {
        var result = {};
        var validationSnapshot = captureValidationSnapshot();
        Object.keys(summary || {}).forEach(function (key) {
          result[key] = summary[key];
        });
        if (validationSnapshot) {
          result.validationSnapshot = validationSnapshot;
          result.semanticSnapshot = validationSnapshot.semanticSnapshot || null;
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
      semanticSnapshot: collectSemanticSnapshot(),
    };
    // Sync to DOM for cross-context visibility (AppleScript JS context).
    syncValidationSnapshotToDom(snap);
    return snap;
  }

  function preparePendingPasteForNativePaste() {
    return getPendingPaste().then(function (pendingPaste) {
      if (!pendingPaste) {
        throw new Error('请先在源文档按 Cmd+Shift+D 提取');
      }

      return resolvePastePayload(pendingPaste).then(function (payload) {
        // If we have uploaded tokens, replace invalid tokens in docxRecord
        // to get a complete docxRecord with valid image tokens.
        var tokenMapKeys = Object.keys(_uploadedTokenMap);
        var hasImageBlocks = false;
        var origRecord = payload.originalDocxRecordObj;
        if (origRecord && origRecord.recordMap) {
          hasImageBlocks = Object.keys(origRecord.recordMap).some(function (recordId) {
            var rec = origRecord.recordMap[recordId];
            return rec && rec.snapshot && rec.snapshot.type === 'image';
          });
        }

        if (tokenMapKeys.length > 0 && origRecord) {
          var replacedRecord = replaceTokensInDocxRecord(origRecord, _uploadedTokenMap);
          var replacedCount = 0;
          var origRecordMap = origRecord.recordMap || {};
          Object.keys(origRecordMap).forEach(function (recordId) {
            var record = origRecordMap[recordId];
            if (record && record.snapshot && record.snapshot.type === 'image' && record.snapshot.image) {
              var oldToken = record.snapshot.image.token || '';
              if (oldToken && _uploadedTokenMap[oldToken]) replacedCount++;
            }
          });
          if (replacedCount > 0) {
            payload.docxRecord = JSON.stringify(replacedRecord);
            payload.hasDowngradedImages = false;
            payload.hasImagesToInject = false;
            payload.orderedImageBase64List = [];
          setDocumentAttribute('data-feishu-debug',
            'tokenReplace-' + replacedCount + '-of-' + tokenMapKeys.length);
          } else if (hasImageBlocks) {
            // Upload succeeded but no tokens matched — fallback to removing image blocks
            payload.docxRecord = JSON.stringify(removeImageBlocksFromDocxRecord(origRecord));
          setDocumentAttribute('data-feishu-debug',
            'tokenReplace-none-matched-fallback-remove');
          }
        } else if (hasImageBlocks && origRecord) {
          // No uploaded tokens available — remove image blocks from docxRecord
          // to avoid Feishu skipping the entire paste due to invalid image tokens
          payload.docxRecord = JSON.stringify(removeImageBlocksFromDocxRecord(origRecord));
        setDocumentAttribute('data-feishu-debug',
          'no-tokens-fallback-remove-images');
        }

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
      validateDuplicateDocument: buildValidateDuplicateDocumentSummary,
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
      convertImagesToBase64(content.html).then(function (result) {
        var htmlWithImages = result.html || result;
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

  function isHiddenPasteTextarea(el) {
    return !!(el && el.nodeType === 1 && el.matches(HIDDEN_PASTE_TEXTAREA_SELECTOR));
  }

  function isContentRootEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.getAttribute('data-content-editable-root') === 'true') return true;
    return /(^|\s)root-block(\s|$)/.test(String(el.className || ''));
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

  function getEditableCandidateScore(el, options) {
    if (!el) return -Infinity;
    var config = options || {};
    var purpose = config.purpose || 'insert';
    var score = 0;
    var selection = window.getSelection && window.getSelection();
    var className = String(el.className || '');

    if (isHiddenPasteTextarea(el)) {
      score += purpose === 'paste' ? 1000 : -1000;
      if (el === document.activeElement) score += 300;
      return score;
    }

    if (isContentRootEditable(el)) score += 100;
    else score += 300;

    if (/zone-container|editor-kit-container|text-editor/.test(className)) score += 80;
    if (el === document.activeElement) score += 240;

    if (selection) {
      var anchorNode = selection.anchorNode;
      var focusNode = selection.focusNode;
      if ((anchorNode && el.contains(anchorNode)) || (focusNode && el.contains(focusNode))) {
        score += 160;
      }
    }

    var rect = el.getBoundingClientRect();
    score += Math.min(Math.round(rect.height), 120);
    if (rect.top >= 0) score += 40;
    return score;
  }

  function getEditableCandidates(options) {
    var config = options || {};
    var includeHiddenTextarea = !!config.includeHiddenTextarea;
    var seen = new Set();
    var result = [];

    function push(el) {
      if (!el || seen.has(el)) return;
      seen.add(el);
      result.push(el);
    }

    if (includeHiddenTextarea && isHiddenPasteTextarea(document.activeElement)) {
      push(document.activeElement);
    }
    push(closestEditableElement(document.activeElement));

    var selection = window.getSelection && window.getSelection();
    if (selection) {
      push(closestEditableElement(selection.anchorNode));
      push(closestEditableElement(selection.focusNode));
    }

    if (includeHiddenTextarea) {
      document.querySelectorAll(HIDDEN_PASTE_TEXTAREA_SELECTOR).forEach(function (el) {
        push(el);
      });
    }

    document.querySelectorAll(
      EDITABLE_SELECTOR
    ).forEach(function (el) {
      push(el);
    });

    return result.filter(function (el) {
      if (isHiddenPasteTextarea(el)) return includeHiddenTextarea;
      return isVisibleElement(el);
    }).sort(function (left, right) {
      return getEditableCandidateScore(right, config) - getEditableCandidateScore(left, config);
    });
  }

  function getActiveBodyEditor() {
    var candidates = getEditableCandidates({
      purpose: 'insert',
      includeHiddenTextarea: false,
    });
    return candidates.length ? candidates[0] : null;
  }

  function getActivePasteDispatchTarget() {
    var candidates = getEditableCandidates({
      purpose: 'paste',
      includeHiddenTextarea: true,
    });
    return candidates.length ? candidates[0] : null;
  }

  function buildClipboardPayload(content) {
    document.documentElement.setAttribute('data-feishu-debug', 'buildClipboardPayload-called');
    var text = content && content.text ? content.text : '';
    var preparedHtml = content && content.clipboardHtml ? content.clipboardHtml : '';
    var html = content && content.html ? content.html : '';
    var docxRecord = content && content.docxRecord ? content.docxRecord : '';
    if (preparedHtml) {
      document.documentElement.setAttribute('data-feishu-debug', 'buildClipboardPayload-shortcircuit');
      return Promise.resolve({
        text: text,
        html: preparedHtml,
        docxRecord: docxRecord,
      });
    }
    if (!html) {
      return Promise.resolve({
        text: text,
        html: '',
        docxRecord: docxRecord,
      });
    }

    var docxRecordObj = null;
    try { docxRecordObj = docxRecord ? JSON.parse(docxRecord) : null; } catch (e) {}

    return convertImagesToBase64(html).then(function (result) {
      var htmlWithImages = result.html || result;
      var tokenToBase64 = result.tokenToBase64 || {};
      var tokenCount = Object.keys(tokenToBase64).length;

      document.documentElement.setAttribute('data-feishu-debug', 'convertImages-base64keys-' + tokenCount);

      // Build ordered image base64 list from docxRecord by walking the
      // block tree in document order.  Image blocks nested inside grid_column,
      // callout, table_cell etc. are NOT in recordIds (only direct children
      // of the page are).  We must walk the tree recursively.
      var orderedImageBase64List = [];
      if (docxRecordObj) {
        var recordMap = docxRecordObj.recordMap || {};
        var imageBlocksFound = 0;
        var tokensMatched = 0;

        // Walk ALL records in recordMap directly (like replaceTokensInDocxRecord)
        // This catches image blocks that might not be reachable via children chain
        // (e.g. inside table cells).
        Object.keys(recordMap).forEach(function (recordId) {
          var record = recordMap[recordId];
          if (record && record.snapshot && record.snapshot.type === 'image' && record.snapshot.image) {
            imageBlocksFound++;
            var token = record.snapshot.image.token || '';
            var base64 = tokenToBase64[token] || '';
            if (base64) tokensMatched++;
            orderedImageBase64List.push({
              token: token,
              base64: base64,
              width: record.snapshot.image.width || 0,
              height: record.snapshot.image.height || 0,
            });
          }
        });

        document.documentElement.setAttribute('data-feishu-debug',
          'imgBlocks-' + imageBlocksFound + '-tokensMatched-' + tokensMatched +
          '-listLen-' + orderedImageBase64List.length);
      }

      // Fallback: if orderedImageBase64List is empty but we have base64 images,
      // build the list directly from tokenToBase64 (token order from HTML).
      if (orderedImageBase64List.length === 0 && tokenCount > 0) {
        var allTokens = Object.keys(tokenToBase64);
        allTokens.forEach(function (token) {
          orderedImageBase64List.push({
            recordId: '',
            token: token,
            base64: tokenToBase64[token],
            width: 0,
            height: 0,
          });
        });
        document.documentElement.setAttribute('data-feishu-debug',
          'fallback-tokenList-' + orderedImageBase64List.length);
      }

      // New strategy: keep the full docxRecord with image blocks intact.
      // The upload flow (mount_point=docx_image) will upload images to the
      // target document, obtain valid tokens, and replace the old tokens
      // in docxRecord before pasting.  This preserves the complete structure
      // (grid/table/callout with embedded images) via the docx/record paste path.
      // For image blocks in docxRecord that have no matching base64 in tokenToBase64
      // (e.g. images nested inside table cells that don't appear in HTML),
      // fetch them directly using the token via the internal download API.
      var unmatchedImageTokens = [];
      var unmatchedTokenValues = [];
      orderedImageBase64List.forEach(function (img) {
        if (img.token && !img.base64) {
          unmatchedImageTokens.push(img);
          unmatchedTokenValues.push(img.token);
        }
      });

      var fetchMissingChain = Promise.resolve();
      if (unmatchedImageTokens.length > 0) {
        document.documentElement.setAttribute('data-feishu-debug',
          'unmatchedImageTokens-' + unmatchedImageTokens.length +
          '-tokens=' + JSON.stringify(unmatchedTokenValues));
        unmatchedImageTokens.forEach(function (img) {
          fetchMissingChain = fetchMissingChain.then(function () {
            // Try multiple download URL patterns for the token
            var urls = [
              '/space/api/box/stream/download/all/?token=' + encodeURIComponent(img.token),
              '/space/api/box/stream/download/preview/' + encodeURIComponent(img.token) + '/?preview_type=16',
            ];
            function tryFetchUrl(index) {
              if (index >= urls.length) return Promise.resolve(null);
              return fetchImageAsBase64(urls[index]).then(function (b64) {
                if (b64) return b64;
                return tryFetchUrl(index + 1);
              });
            }
            return tryFetchUrl(0).then(function (base64) {
              if (base64) {
                img.base64 = base64;
                document.documentElement.setAttribute('data-feishu-debug',
                  'fetchMissing-ok-token=' + img.token + '-b64len=' + base64.length);
              } else {
                document.documentElement.setAttribute('data-feishu-debug',
                  'fetchMissing-fail-token=' + img.token);
                console.warn('[feishu-helper] Failed to fetch base64 for token:', img.token);
              }
            });
          });
        });
      }

      return fetchMissingChain.then(function () {
        var matchedCount = orderedImageBase64List.filter(function (img) { return !!img.base64; }).length;
        document.documentElement.setAttribute('data-feishu-debug',
          'imgBlocks-' + imageBlocksFound + '-tokensMatched-' + tokensMatched +
          '-unmatched-' + unmatchedImageTokens.length +
          '-fetched-' + (matchedCount - tokensMatched) +
          '-totalWithBase64-' + matchedCount +
          '-listLen-' + orderedImageBase64List.length);

        var hasImages = orderedImageBase64List.length > 0;
        var shouldDowngrade = false; // No longer downgrade — upload replaces tokens instead

        return {
          text: text,
          html: buildClipboardHtml(htmlWithImages, docxRecordObj, false),
          docxRecord: docxRecordObj ? JSON.stringify(docxRecordObj) : '',
          hasDowngradedImages: false,
          hasImagesToInject: hasImages,
          hasImagesToUpload: hasImages,
          orderedImageBase64List: orderedImageBase64List,
          originalDocxRecordObj: docxRecordObj,
        };
      });
    }).catch(function () {
      return {
        text: text,
        html: buildClipboardHtml(html, docxRecordObj),
        docxRecord: docxRecord,
      };
    });
  }

  function writeClipboardPayloadWithExecCommand(payload) {
    return new Promise(function (resolve, reject) {
      var handled = false;
      var text = payload && payload.text ? payload.text : '';
      var html = payload && payload.html ? payload.html : '';
      var docxRecord = payload && payload.docxRecord ? payload.docxRecord : '';

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
          if (docxRecord) e.clipboardData.setData('docx/record', docxRecord);
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
    var docxRecord = payload && payload.docxRecord ? payload.docxRecord : '';
    // Debug: check if docxRecord has replaced tokens
    try {
      var drObj = docxRecord ? JSON.parse(docxRecord) : null;
      if (drObj && drObj.recordMap) {
        var imgCount = 0;
        var sampleToken = '';
        Object.keys(drObj.recordMap).forEach(function (rid) {
          var r = drObj.recordMap[rid];
          if (r && r.snapshot && r.snapshot.type === 'image' && r.snapshot.image) {
            imgCount++;
            if (!sampleToken) sampleToken = r.snapshot.image.token || '';
          }
        });
        document.documentElement.setAttribute('data-feishu-clipboard-debug',
          'writeClipboard: imgBlocks=' + imgCount + ', sampleToken=' + sampleToken +
          ', docxLen=' + (docxRecord || '').length);
      }
    } catch (e) {}
    var clipboardData = {};

    if (text) clipboardData['text/plain'] = new Blob([text], { type: 'text/plain' });
    if (html) clipboardData['text/html'] = new Blob([html], { type: 'text/html' });
    if (docxRecord) clipboardData['docx/record'] = new Blob([docxRecord], { type: 'text/plain' });

    if (!Object.keys(clipboardData).length) {
      return Promise.reject(new Error('clipboard payload empty'));
    }

    function markClipboardWritten() {
      try { document.documentElement.setAttribute('data-feishu-clipboard-write', 'ok'); } catch (e) {}
    }

    if (navigator.clipboard && navigator.clipboard.write && typeof ClipboardItem !== 'undefined') {
      return navigator.clipboard.write([new ClipboardItem(clipboardData)]).then(function () {
        markClipboardWritten();
      }).catch(function () {
        return writeClipboardPayloadWithExecCommand(payload).then(function () {
          markClipboardWritten();
        });
      });
    }

    return writeClipboardPayloadWithExecCommand(payload).then(function () {
      markClipboardWritten();
    });
  }

  function resolvePastePayload(content) {
    var preparedPayload = {
      text: content && content.text ? content.text : '',
      html: content && content.clipboardHtml ? content.clipboardHtml : '',
      docxRecord: content && content.docxRecord ? content.docxRecord : '',
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
    var hasFeishuStructuredHtml = payloadHasFeishuStructuredHtml(payload);
    var requiresNativeParsing = !hasFeishuStructuredHtml && (
      /^\s*>\s*\[!(NOTE|WARNING|TIP|CAUTION|IMPORTANT|SUCCESS|INFO)\]/mi.test(source) ||
      /(^|[^\\])\$\$?[\s\S]+?\$\$?/.test(source) ||
      /\\\([\s\S]+?\\\)/.test(source) ||
      /\\\[[\s\S]+?\\\]/.test(source)
    );

    // Any LaTeX-like marker should go through Feishu's native paste parser.
    // Direct DOM insertion preserves the literal "$...$" text but does not
    // trigger the editor's formula conversion, which is most visible in lists.
    if (hasFeishuStructuredHtml && payloadHasDowngradedImages(payload)) {
      return {
        mode: 'nativePaste',
        requiresNativeParsing: true,
      };
    }

    if (hasFeishuStructuredHtml) {
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

  function payloadHasFeishuStructuredHtml(payload) {
    var html = payload && payload.html ? payload.html : '';
    var hasDocxRecord = payload && payload.docxRecord ? true : false;
    if (!html && !hasDocxRecord) return false;
    // Feishu native copy signals structured data via data-docx-has-block-data="true"
    // in HTML AND provides docx/record MIME type on the clipboard.
    return /data-docx-has-block-data="true"/i.test(html) && hasDocxRecord;
  }

  function payloadHasDowngradedImages(payload) {
    var html = payload && payload.html ? payload.html : '';
    return /data-feishu-downgraded-images="true"/i.test(html);
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

  function preparePasteTarget(target) {
    if (!target) return false;
    try {
      if (!isHiddenPasteTextarea(target) && typeof target.scrollIntoView === 'function') {
        target.scrollIntoView({ block: 'center', inline: 'nearest' });
      }
    } catch (err) {}

    try { target.focus(); } catch (err) {}

    if (isHiddenPasteTextarea(target)) {
      try {
        var currentValue = typeof target.value === 'string' ? target.value : '';
        target.setSelectionRange(currentValue.length, currentValue.length);
      } catch (err) {}
      return true;
    }

    try { target.click(); } catch (err) {}
    ensureEditorSelection(target);
    return true;
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
    var candidates = getEditableCandidates({
      purpose: 'insert',
      includeHiddenTextarea: false,
    });

    for (var i = 0; i < candidates.length; i++) {
      var editor = candidates[i];
      if (!editor) continue;

      preparePasteTarget(editor);

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
    var target = getActivePasteDispatchTarget();
    if (!target) return false;

    preparePasteTarget(target);
    var dt = new DataTransfer();
    if (payload && payload.text) dt.setData('text/plain', payload.text);
    if (payload && payload.html) dt.setData('text/html', payload.html);
    if (payload && payload.docxRecord) dt.setData('docx/record', payload.docxRecord);

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
      target.dispatchEvent(beforeInputEvent);
    } catch (err) {}

    var pasteEvent = new ClipboardEvent('paste', {
      clipboardData: dt,
      bubbles: true,
      cancelable: true
    });
    target.dispatchEvent(pasteEvent);
    return true;
  }

  function pasteIntoDoc() {
    getPendingPaste().then(function (pendingPaste) {
      if (!pendingPaste) {
        showToast('⚠️ 请先在源文档按 Cmd+Shift+D 提取');
        return;
      }

      var content = pendingPaste;

      // If there are images to upload and we haven't uploaded them yet,
      // trigger the upload flow first, then proceed with paste.
      var hasImagesToUpload = !!(content.orderedImageBase64List && content.orderedImageBase64List.length)
        && Object.keys(_uploadedTokenMap).length === 0;

      if (hasImagesToUpload) {
        showToast('⏳ 上传图片中...', 0);
        uploadAllImages(content.orderedImageBase64List).then(function (uploadSummary) {
          var tokenMap = uploadSummary && uploadSummary.tokenMap ? uploadSummary.tokenMap : {};
          var uploadedCount = Number(uploadSummary && uploadSummary.uploadedCount || 0);
          var failedCount = Number(uploadSummary && uploadSummary.failedCount || 0);
          setDocumentJsonAttribute('data-feishu-upload-result', {
            tokenMap: tokenMap,
            uploadedCount: uploadedCount,
            failedCount: failedCount,
            attemptedCount: Number(uploadSummary && uploadSummary.attemptedCount || 0),
          });
          if (uploadedCount > 0) {
            Object.keys(tokenMap).forEach(function (key) {
              _uploadedTokenMap[key] = tokenMap[key];
            });
            _uploadedTokenMapPendingTs = Date.now();
            // Update pendingPaste docxRecord with replaced tokens
            var origRecord = content.originalDocxRecordObj;
            if (origRecord) {
              var replacedRecord = replaceTokensInDocxRecord(origRecord, tokenMap);
              content.docxRecord = JSON.stringify(replacedRecord);
              content.hasImagesToInject = false;
              content.hasImagesToUpload = false;
              return setPendingPaste(content).then(function () {
                showToast('✅ ' + uploadedCount + ' 张图片已上传' + (failedCount ? '，失败 ' + failedCount + ' 张' : ''), 1500);
                doPaste(content);
              });
            }
          }
          showToast('✅ ' + uploadedCount + ' 张图片已上传' + (failedCount ? '，失败 ' + failedCount + ' 张' : ''), 1500);
          doPaste(content);
        }).catch(function () {
          showToast('⚠️ 图片上传失败，将粘贴不含图片的内容', 3000);
          doPaste(content);
        });
        return;
      }

      doPaste(content);
    });

    function doPaste(content) {

      function commitPayload(payload) {
        var needsParser = payloadRequiresPasteParsing(payload);
        var canAutoDispatch = shouldAutoDispatchPastePayload(payload);
        var preferPasteEventOnly = payloadHasFeishuStructuredHtml(payload);
        var hasDowngradedImages = payloadHasDowngradedImages(payload);
        var hasImagesToInject = !!(content.orderedImageBase64List && content.orderedImageBase64List.length);
        var needsManualPaste = needsParser && !canAutoDispatch;

        writeClipboardPayload(payload).then(function () {
          var status = needsManualPaste ? { autoInserted: false, autoPasted: false, pathLabel: describePasteMode('clipboardOnly') } : runPasteAttempt(payload, {
            allowInsert: !preferPasteEventOnly,
            allowDispatch: canAutoDispatch,
          });

          // Mark that image injection is needed after paste.
          // The MutationObserver will inject after Feishu creates the image blocks
          // (which happens during Cmd+V, not during this Cmd+Shift+P handler).
          // The actual base64 data is stored in pendingPaste (IndexedDB).
          if (hasImagesToInject) {
            markImageInjectionNeeded(true);
            startImageInjectionObserver();
          }

          if (hasDowngradedImages && needsManualPaste) {
            showToast('📋 检测到图片块已降级到 base64；已写入剪贴板，请直接按 Cmd+V 走飞书原生粘贴以插入图片', 4600);
            return;
          }
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
    }
  }

  // Store a flag indicating that image injection is needed after paste.
  // The actual base64 data is stored in the pendingPaste (IndexedDB),
  // not in DOM attributes (which have size limits for large base64 strings).
  function markImageInjectionNeeded(needed) {
    try {
      document.documentElement.setAttribute('data-feishu-image-inject-needed', needed ? '1' : '');
      if (!needed) document.documentElement.removeAttribute('data-feishu-image-inject-needed');
    } catch (e) {}
  }

  function isImageInjectionNeeded() {
    return document.documentElement.getAttribute('data-feishu-image-inject-needed') === '1';
  }

  // Observe the editor for new image blocks and inject base64 data into them.
  // This runs continuously so it catches image blocks created by either
  // Cmd+Shift+P or Cmd+V paste flows.
  var _imageInjectionObserver = null;
  var _imageInjectionRetryCount = 0;
  var MAX_IMAGE_INJECTION_RETRIES = 8;

  function startImageInjectionObserver() {
    if (_imageInjectionObserver) return;
    var target = getContentRootElement() || document.body;
    _imageInjectionObserver = new MutationObserver(function (mutations) {
      if (!isImageInjectionNeeded()) return;
      // Debounce: wait a tick so all blocks from a paste batch are in the DOM
      clearTimeout(_imageInjectionObserver._timer);
      _imageInjectionObserver._timer = setTimeout(function () {
        // Read the image list from IndexedDB (pendingPaste)
        getPendingPaste().then(function (pending) {
          var list = (pending && pending.orderedImageBase64List) || [];
          if (!list.length) return;
          var count = injectBase64ImagesIntoEditor(list);
          if (count >= list.length) {
            markImageInjectionNeeded(false);
            _imageInjectionRetryCount = 0;
          } else if (count > 0) {
            _imageInjectionRetryCount++;
            if (_imageInjectionRetryCount < MAX_IMAGE_INJECTION_RETRIES) {
              setTimeout(function () {
                getPendingPaste().then(function (p) {
                  if (p && p.orderedImageBase64List) {
                    injectBase64ImagesIntoEditor(p.orderedImageBase64List);
                  }
                });
              }, 1500);
            }
          }
        });
      }, 500);
    });
    _imageInjectionObserver.observe(target, { childList: true, subtree: true });
  }

  // Inject base64 images into image block placeholders in the editor.
  // After an HTML paste, image blocks may exist but show as loading/empty
  // placeholders because Feishu's upload pipeline may not handle base64 src.
  // This function finds those blocks by position and sets the img src to base64.
  function injectBase64ImagesIntoEditor(orderedImageBase64List) {
    if (!orderedImageBase64List || !orderedImageBase64List.length) return 0;

    var editable = getContentRootElement();
    if (!editable) return 0;

    var imageBlocks = editable.querySelectorAll('[data-block-type="image"]');
    if (!imageBlocks.length) return 0;

    var injected = 0;
    imageBlocks.forEach(function (block, index) {
      if (index >= orderedImageBase64List.length) return;
      var imageData = orderedImageBase64List[index];
      if (!imageData || !imageData.base64) return;

      var dataUrl = imageData.base64.indexOf('data:') === 0
        ? imageData.base64
        : 'data:image/png;base64,' + imageData.base64;

      // Strategy 1: find existing <img> and set its src
      var img = block.querySelector('img');
      if (img) {
        // Only inject if the current src is not already our base64
        if (img.src !== dataUrl) {
          img.src = dataUrl;
        }
        if (imageData.width) img.setAttribute('width', imageData.width);
        if (imageData.height) img.setAttribute('height', imageData.height);
        injected++;
        return;
      }

      // Strategy 2: find the image content container and create an img element
      var container = block.querySelector(
        '.img, [class*="image-content"], [class*="img-container"], ' +
        '[class*="ImgContainer"], [class*="image-wrap"]'
      );
      if (container) {
        img = document.createElement('img');
        img.src = dataUrl;
        img.style.maxWidth = '100%';
        img.style.height = 'auto';
        img.style.display = 'block';
        if (imageData.width) img.setAttribute('width', imageData.width);
        if (imageData.height) img.setAttribute('height', imageData.height);
        container.appendChild(img);
        injected++;
        return;
      }

      // Strategy 3: try to find the React fiber node and update it
      var fiberKey = Object.getOwnPropertyNames(block).find(function (k) {
        return k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$');
      });
      if (fiberKey) {
        // If there's a fiber, the component might re-render our changes away.
        // Set a data attribute so our MutationObserver can re-inject.
        block.setAttribute('data-feishu-inject-src', dataUrl);
        if (imageData.width) block.setAttribute('data-feishu-inject-width', imageData.width);
        if (imageData.height) block.setAttribute('data-feishu-inject-height', imageData.height);
        injected++;
      }
    });

    return injected;
  }

  // ── Image Upload via Feishu Internal API ──
  // Upload base64 images to the current document and get valid tokens.
  // Strategy: use the Feishu editor's own upload pipeline by inspecting
  // the externalSaver service and calling its internal upload method,
  // or by calling the discovered internal API endpoint directly.

  // Get the image-manager service from the editor's DI container
  function getImageManagerService() {
    var editorAPI = getEditorAPI();
    if (!editorAPI || !editorAPI._renderer || !editorAPI._renderer.injectionService) return null;
    var rootInj = editorAPI._renderer.injectionService.rootInjector;
    if (!rootInj || !rootInj._instanceMap) return null;
    var service = null;
    try {
      rootInj._instanceMap.forEach(function (val, key) {
        if (!service && String(key).indexOf('image-manager') !== -1) {
          service = val;
        }
      });
    } catch (e) {}
    return service;
  }

  // Discover the internal upload API by checking captured requests or using
  // the known endpoint. Returns captured request info + obj_token for wiki pages.
  function discoverUploadApi() {
    // Check if we already captured a real upload request (e.g. from manual image paste)
    var realCapture = null;
    for (var i = _feishuCapturedUploads.length - 1; i >= 0; i--) {
      var c = _feishuCapturedUploads[i];
      if (/box\/stream\/upload|box\/image\/create|medias\/upload/i.test(c.url)) {
        realCapture = c;
        break;
      }
    }

    var uploadApi;
    if (realCapture) {
      // Use the real captured parameters (especially mount_point)
      uploadApi = realCapture;
      console.info('[Feishu Helper] Using captured upload API with params:', realCapture.queryParams);
    } else {
      // Fall back to known endpoint from code analysis
      uploadApi = {
        url: '/space/api/box/stream/upload/all/',
        method: 'POST',
        bodyType: 'FormData',
        timestamp: Date.now(),
        headers: {
          'biz-ua-type': 'Web',
          'biz-scene': 'file_upload',
        },
        formDataFields: [{ key: 'file', type: 'File' }],
        queryParams: {
          mount_point: 'docx_image',
          push_open_history_record: '0',
        },
      };
    }

    // For wiki pages, we need the obj_token (underlying doc token)
    // Check if this is a wiki page and resolve the obj_token
    var isWiki = false;
    var docToken = '';
    try {
      var m = location.pathname.match(/\/(docx|wiki|doc)\/([A-Za-z0-9]+)/);
      if (m) {
        isWiki = m[1] === 'wiki';
        docToken = m[2];
      }
    } catch (e) {}

    if (isWiki && docToken) {
      // For wiki pages, we need to resolve the obj_token first
      // `my.feishu.cn` wiki pages resolve successfully via the GET endpoint.
      // The POST variant returns 404 there, which leaves us using the wiki
      // token as mount_node_token and causes image uploads to return
      // `mount node not exist`, producing an empty tokenMap.
      return _originalFetch('/space/api/wiki/v2/tree/get_node/?wiki_token=' + encodeURIComponent(docToken) + '&expand_shortcut=true&with_deleted=true', {
        credentials: 'include',
      }).then(function (r) {
        return r.json();
      }).then(function (data) {
        var objToken = '';
        // The API returns obj_token in either data.data.node.obj_token or data.data.obj_token
        var node = (data && data.data && data.data.node) || data.data || {};
        if (node.obj_token) {
          objToken = node.obj_token;
        }
        console.info('[Feishu Helper] Wiki obj_token resolved:', { wikiToken: docToken, objToken: objToken });
        var result = {
          captured: [uploadApi],
          objToken: objToken,
          wikiToken: docToken,
          imageBlockCount: document.querySelectorAll('[data-block-type="image"]').length,
        };
        try {
          document.documentElement.setAttribute('data-feishu-upload-api-discovery',
            JSON.stringify(result));
        } catch (e) {}
        return result;
      }).catch(function (err) {
        console.warn('[Feishu Helper] Failed to resolve wiki obj_token:', err);
        return {
          captured: [uploadApi],
          objToken: docToken,
          wikiToken: isWiki ? docToken : '',
          imageBlockCount: 0,
        };
      });
    }

    var result = {
      captured: [uploadApi],
      objToken: docToken,
      wikiToken: '',
      imageBlockCount: document.querySelectorAll('[data-block-type="image"]').length,
    };
    try {
      document.documentElement.setAttribute('data-feishu-upload-api-discovery',
        JSON.stringify(result));
    } catch (e) {}
    return Promise.resolve(result);
  }

  // Upload a single base64 image to the current document using the
  // Feishu internal API. Returns the new valid token.
  // If we captured a real upload request, reuse its mount_point & URL pattern.
  // objToken: resolved wiki obj_token (overrides URL token for wiki pages)
  function uploadBase64ImageViaApi(base64Data, width, height, discoveredApi, objToken) {
    // Convert base64 to Blob
    var dataUrl = base64Data.indexOf('data:') === 0 ? base64Data : 'data:image/png;base64,' + base64Data;
    var base64Part = dataUrl.split(',')[1] || '';
    var mimeMatch = dataUrl.match(/data:(image\/\w+);/);
    var mimeType = mimeMatch ? mimeMatch[1] : 'image/png';
    var ext = mimeType.split('/')[1] || 'png';

    var byteString = atob(base64Part);
    var ab = new ArrayBuffer(byteString.length);
    var ia = new Uint8Array(ab);
    for (var i = 0; i < byteString.length; i++) {
      ia[i] = byteString.charCodeAt(i);
    }
    var blob = new Blob([ab], { type: mimeType });
    var fileName = 'image.' + ext;
    var fileSize = blob.size;

    // Get the document token — prefer resolved objToken (for wiki pages) over URL token
    var docToken = objToken || '';
    if (!docToken) {
      try {
        var m = location.pathname.match(/\/(docx|wiki|doc)\/([A-Za-z0-9]+)/);
        if (m) docToken = m[2];
      } catch (e) {}
    }

    // Build the upload URL using captured or default parameters
    var uploadUrl;
    var uploadHeaders = {
      'biz-ua-type': 'Web',
      'biz-scene': 'file_upload',
    };

    if (discoveredApi && discoveredApi.queryParams && Object.keys(discoveredApi.queryParams).length > 0) {
      // Reconstruct URL from the captured base path + our file params
      var baseUrl = discoveredApi.url.split('?')[0];
      var params = {};
      // Copy non-file-specific params from the captured request
      if (discoveredApi.queryParams.mount_point) params.mount_point = discoveredApi.queryParams.mount_point;
      // Always include mount_node_token with our resolved docToken
      if (docToken) {
        params.mount_node_token = docToken;
      } else if (discoveredApi.queryParams.mount_node_token) {
        params.mount_node_token = discoveredApi.queryParams.mount_node_token;
      }
      if (discoveredApi.queryParams.push_open_history_record !== undefined) {
        params.push_open_history_record = discoveredApi.queryParams.push_open_history_record;
      }
      // Add file-specific params
      params.name = fileName;
      params.size = fileSize;
      // Copy any extra params from captured request
      Object.keys(discoveredApi.queryParams).forEach(function (k) {
        if (!params[k] && k !== 'name' && k !== 'size') {
          params[k] = discoveredApi.queryParams[k];
        }
      });

      var qs = Object.keys(params).map(function (k) {
        return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
      }).join('&');
      uploadUrl = baseUrl + '?' + qs;

      // Merge any captured headers
      if (discoveredApi.headers) {
        Object.keys(discoveredApi.headers).forEach(function (k) {
          uploadHeaders[k] = discoveredApi.headers[k];
        });
      }
      console.info('[Feishu Helper] Uploading with captured params:', params);
    } else {
      // Fall back to known endpoint with correct mount_point for document images
      // docx_image = upload image to docx document (NOT ccm_import which is for cloud import)
      uploadUrl = '/space/api/box/stream/upload/all/?name=' + encodeURIComponent(fileName) +
        '&size=' + fileSize +
        '&mount_point=docx_image' +
        '&mount_node_token=' + encodeURIComponent(docToken) +
        '&push_open_history_record=0';
      console.info('[Feishu Helper] Uploading with default params (no capture available)');
    }

    var formData = new FormData();
    formData.append('file', blob, fileName);

    return _originalFetch(uploadUrl, {
      method: 'POST',
      body: formData,
      credentials: 'include',
      headers: uploadHeaders,
    }).then(function (r) {
      return r.json();
    }).then(function (data) {
      var token = '';
      if (data && data.data) {
        token = data.data.token || data.data.file_token || data.data.image_key || '';
      }
      if (!token && data && data.result) {
        token = data.result.token || data.result.file_token || data.result.image_key || '';
      }
      console.info('[Feishu Helper] Upload result:', { token: token, code: data && data.code, msg: data && data.msg });
      return { token: token, raw: data };
    }).catch(function (err) {
      return { token: '', error: String(err) };
    });
  }

  // Upload all base64 images and return upload summary plus token mapping.
  function uploadAllImages(orderedImageBase64List) {
    if (!orderedImageBase64List || !orderedImageBase64List.length) {
      return Promise.resolve({
        tokenMap: {},
        attemptedCount: 0,
        uploadedCount: 0,
        failedCount: 0,
      });
    }

    // First, discover the upload API (also resolves obj_token for wiki pages)
    return discoverUploadApi().then(function (discovery) {
      var discoveredApi = null;
      if (discovery.captured && discovery.captured.length > 0) {
        discoveredApi = discovery.captured[0];
      }

      var resolvedObjToken = discovery.objToken || '';

      // Upload each image sequentially to avoid overwhelming the server
      var tokenMap = {};
      var uploadedCount = 0;
      var failedCount = 0;
      var chain = Promise.resolve();
      var total = orderedImageBase64List.length;

      orderedImageBase64List.forEach(function (img, index) {
        chain = chain.then(function () {
          // Skip images with no base64 data (e.g. failed fetch)
          if (!img.base64) {
            return { token: '', error: 'no base64 data' };
          }
          return uploadBase64ImageViaApi(img.base64, img.width, img.height, discoveredApi, resolvedObjToken);
        }).then(function (result) {
          if (result.token) {
            tokenMap[img.token] = result.token;
            uploadedCount += 1;
          } else {
            failedCount += 1;
          }
          try {
            document.documentElement.setAttribute('data-feishu-upload-progress',
              JSON.stringify({
                index: index,
                total: total,
                oldToken: img.token,
                newToken: result.token || '',
                error: result.error || '',
                uploadedCount: uploadedCount,
                failedCount: failedCount,
              }));
          } catch (e) {}
        }).catch(function (err) {
          failedCount += 1;
          try {
            document.documentElement.setAttribute('data-feishu-upload-progress',
              JSON.stringify({
                index: index,
                total: total,
                oldToken: img.token,
                error: String(err),
                uploadedCount: uploadedCount,
                failedCount: failedCount,
              }));
          } catch (e) {}
        });
      });

      return chain.then(function () {
        return {
          tokenMap: tokenMap,
          attemptedCount: total,
          uploadedCount: uploadedCount,
          failedCount: failedCount,
        };
      });
    });
  }

  // Replace tokens in docxRecord with new valid tokens
  function replaceTokensInDocxRecord(docxRecordObj, tokenMap) {
    if (!docxRecordObj || !tokenMap || Object.keys(tokenMap).length === 0) return docxRecordObj;
    var clone = JSON.parse(JSON.stringify(docxRecordObj));
    var recordMap = clone.recordMap || {};
    var replaced = 0;
    var docxTokens = [];
    var mapKeys = Object.keys(tokenMap);
    Object.keys(recordMap).forEach(function (recordId) {
      var record = recordMap[recordId];
      if (record && record.snapshot && record.snapshot.type === 'image' && record.snapshot.image) {
        var oldToken = record.snapshot.image.token || '';
        docxTokens.push(oldToken);
        if (oldToken && tokenMap[oldToken]) {
          record.snapshot.image.token = tokenMap[oldToken];
          replaced++;
        }
      }
    });
    var debugInfo = 'replaceTokens: replaced=' + replaced +
      '/' + docxTokens.length + ' docxImageTokens, tokenMapKeys=' + mapKeys.length +
      ', sampleDocxToken=' + (docxTokens[0] || 'none') +
      ', sampleMapKey=' + (mapKeys[0] || 'none') +
      ', overlap=' + docxTokens.filter(function(t) { return !!tokenMap[t]; }).length;
    // Log unmatched docxTokens for debugging table images
    var unmatchedDocxTokens = docxTokens.filter(function(t) { return !tokenMap[t]; });
    if (unmatchedDocxTokens.length > 0) {
      debugInfo += ', unmatchedDocxTokens=' + JSON.stringify(unmatchedDocxTokens);
    }
    console.log('[feishu-helper] ' + debugInfo);
    try { document.documentElement.setAttribute('data-feishu-token-replace-debug', debugInfo); } catch(e) {}
    return clone;
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
  // Listen for API exploration requests from AppleScript's JS context.
  // Runs findEditorPaths in TM's context (which has React fiber access)
  // and writes the result to a DOM attribute for cross-context reading.
  registerEventListener(document, 'feishu-explore-api', function (e) {
    try {
      var pattern = e.detail && e.detail.pattern ? new RegExp(e.detail.pattern, 'i') : /insert|command|apply|mutation|addBlock|createBlock|updateBlock|paste|clipboard/;
      var result = FeishuHelperModules && FeishuHelperModules.debug
        ? FeishuHelperModules.debug.findEditorPaths(pattern)
        : [];
      document.documentElement.setAttribute('data-feishu-api-paths', JSON.stringify(result));
    } catch (err) {
      document.documentElement.setAttribute('data-feishu-api-paths', JSON.stringify({ error: String(err.message || err) }));
    }
  }, true);
  // Listen for editor path resolution requests from AppleScript's JS context.
  // Reads a nested property from editorAPI (which requires React fiber access)
  // and writes the result to a DOM attribute.
  registerEventListener(document, 'feishu-resolve-path', function (e) {
    try {
      var path = e.detail && e.detail.path ? String(e.detail.path) : '';
      if (!path) {
        document.documentElement.setAttribute('data-feishu-path-result', JSON.stringify({ error: 'no path' }));
        return;
      }
      var editorAPI = getEditorAPI();
      if (!editorAPI) {
        document.documentElement.setAttribute('data-feishu-path-result', JSON.stringify({ error: 'no editorAPI' }));
        return;
      }
      var parts = path.replace(/^editorAPI\./, '').split('.');
      var obj = editorAPI;
      for (var i = 0; i < parts.length; i++) {
        if (obj == null) break;
        obj = obj[parts[i]];
      }
      var resultType = typeof obj;
      var result;
      if (obj === null || obj === undefined) {
        result = { path: path, type: 'null' };
      } else if (resultType === 'function') {
        result = { path: path, type: 'function', name: obj.name || '', length: obj.length };
      } else if (resultType === 'object') {
        var keys = [];
        try { keys = safeGetOwnKeys(obj).slice(0, 80); } catch (err) {}
        result = { path: path, type: 'object', keys: keys };
      } else {
        var str = String(obj);
        result = { path: path, type: resultType, value: str.length > 500 ? str.slice(0, 500) + '...' : str };
      }
      document.documentElement.setAttribute('data-feishu-path-result', JSON.stringify(result));
    } catch (err) {
      document.documentElement.setAttribute('data-feishu-path-result', JSON.stringify({ error: String(err.message || err) }));
    }
  }, true);
  registerEventListener(document, 'feishu-inspect-path', function (e) {
    try {
      var path = e.detail && e.detail.path ? String(e.detail.path) : '';
      if (!path) {
        document.documentElement.setAttribute('data-feishu-path-inspection', JSON.stringify({ error: 'no path' }));
        return;
      }
      var resolved = resolveEditorPath(path);
      if (!resolved.ok) {
        document.documentElement.setAttribute('data-feishu-path-inspection', JSON.stringify({
          ok: false,
          path: resolved.label || path,
          error: String(resolved.error && resolved.error.message ? resolved.error.message : resolved.error),
        }));
        return;
      }
      var summary = summarizeObjectValue(resolved.value, /image|img|upload|asset|media|resource|clip|copy|paste|command|service|docx|token|block|data/i);
      summary.ok = true;
      summary.path = resolved.label;
      document.documentElement.setAttribute('data-feishu-path-inspection', JSON.stringify(summary));
    } catch (err) {
      document.documentElement.setAttribute('data-feishu-path-inspection', JSON.stringify({ error: String(err && err.message ? err.message : err) }));
    }
  }, true);
  // Listen for native copy capture requests from AppleScript's JS context.
  registerEventListener(document, 'feishu-capture-copy', function () {
    try {
      if (FeishuHelperModules && FeishuHelperModules.debug && typeof FeishuHelperModules.debug.captureNextCopy === 'function') {
        FeishuHelperModules.debug.captureNextCopy();
      }
    } catch (e) {}
  }, true);
  registerEventListener(document, 'feishu-install-whiteboard-hook-debug', function (e) {
    try {
      installWhiteboardHookTracer(e && e.detail ? e.detail : {});
    } catch (error) {
      _feishuWhiteboardHookState = {
        installed: false,
        installedAt: '',
        href: location.href,
        wrappedPaths: [],
        logCount: _feishuWhiteboardHookLog.length,
        errors: [{ error: stringifyError(error) }],
      };
      syncWhiteboardHookDebugState();
    }
  }, true);
  registerEventListener(document, 'feishu-reset-whiteboard-hook-debug', function () {
    try {
      resetWhiteboardHookDebugLog();
    } catch (error) {}
  }, true);
  registerEventListener(document, 'feishu-read-whiteboard-hook-debug', function () {
    try {
      syncWhiteboardHookDebugState();
    } catch (error) {}
  }, true);
  registerEventListener(document, 'feishu-call-service', function (e) {
    try {
      var serviceName = e.detail && e.detail.service ? String(e.detail.service) : '';
      var method = e.detail && e.detail.method ? String(e.detail.method) : '';
      var args = e.detail && e.detail.args ? e.detail.args : [];
      var resultAttr = 'data-feishu-service-result';
      if (!serviceName) {
        document.documentElement.setAttribute(resultAttr, JSON.stringify({ error: 'no service name' }));
        return;
      }
      var editorAPI = getEditorAPI();
      if (!editorAPI || !editorAPI._renderer || !editorAPI._renderer.injectionService) {
        document.documentElement.setAttribute(resultAttr, JSON.stringify({ error: 'no injectionService' }));
        return;
      }
      // Try _instanceMap first (Map with already-instantiated services),
      // then fall back to _resolve / get for lazy providers.
      var injService = editorAPI._renderer.injectionService;
      var rootInj = injService.rootInjector;
      var service = null;
      // The _instanceMap is a Map. Its keys might be strings or objects.
      // Try string key first, then iterate to find by name match.
      if (rootInj._instanceMap && typeof rootInj._instanceMap.get === 'function') {
        service = rootInj._instanceMap.get(serviceName);
        if (!service) {
          // Iterate Map entries to find by key.toString() match
          try {
            rootInj._instanceMap.forEach(function (val, key) {
              if (!service && String(key) === serviceName) {
                service = val;
              }
            });
          } catch (mapErr) {}
        }
      }
      if (!service && typeof injService.get === 'function') {
        try { service = injService.get(serviceName); } catch (e) {}
      }
      if (!service && typeof rootInj._resolve === 'function') {
        try { service = rootInj._resolve(serviceName); } catch (e) {}
      }
      if (!service) {
        document.documentElement.setAttribute(resultAttr, JSON.stringify({ error: 'service not found: ' + serviceName }));
        return;
      }
      if (!method) {
        // Return service keys for inspection
        var keys = [];
        try { keys = safeGetOwnKeys(service).slice(0, 50); } catch (err) {}
        document.documentElement.setAttribute(resultAttr, JSON.stringify({ service: serviceName, type: typeof service, keys: keys }));
        return;
      }
      // Support dot-separated paths for nested property access, e.g. "externalSaver.uploadImage"
      var methodParts = method.split('.');
      var target = service;
      for (var pi = 0; pi < methodParts.length - 1; pi++) {
        if (target == null) break;
        target = target[methodParts[pi]];
      }
      var finalMethod = methodParts[methodParts.length - 1];
      if (!target || typeof target[finalMethod] !== 'function') {
        // If it's a property (not a function), return its value for inspection
        if (target && target[finalMethod] !== undefined) {
          var propVal = target[finalMethod];
          if (typeof propVal === 'object' && propVal !== null) {
            var propKeys = [];
            try { propKeys = safeGetOwnKeys(propVal).slice(0, 50); } catch (err) {}
            document.documentElement.setAttribute(resultAttr, JSON.stringify({ service: serviceName, property: method, type: typeof propVal, keys: propKeys }));
          } else {
            document.documentElement.setAttribute(resultAttr, JSON.stringify({ service: serviceName, property: method, type: typeof propVal, value: String(propVal).substring(0, 200) }));
          }
          return;
        }
        document.documentElement.setAttribute(resultAttr, JSON.stringify({ error: 'method/property not found: ' + method, availableKeys: target ? safeGetOwnKeys(target).slice(0, 50) : [] }));
        return;
      }
      var result = target[finalMethod].apply(target, args);
      // Handle both sync and async results
      if (result && typeof result.then === 'function') {
        result.then(function (val) {
          var serialized = val;
          if (val && typeof val === 'object') {
            try { serialized = JSON.parse(JSON.stringify(val)); } catch (err) {
              try { serialized = { keys: safeGetOwnKeys(val).slice(0, 30) }; } catch (e2) { serialized = '[object]'; }
            }
          }
          document.documentElement.setAttribute(resultAttr, JSON.stringify({ service: serviceName, method: method, async: true, result: serialized }));
        }).catch(function (err) {
          document.documentElement.setAttribute(resultAttr, JSON.stringify({ service: serviceName, method: method, async: true, error: String(err.message || err) }));
        });
      } else {
        document.documentElement.setAttribute(resultAttr, JSON.stringify({ service: serviceName, method: method, async: false, result: result }));
      }
    } catch (err) {
      document.documentElement.setAttribute('data-feishu-service-result', JSON.stringify({ error: String(err.message || err) }));
    }
  }, true);
  registerEventListener(document, 'feishu-prepare-native-paste', function () {
    try {
      setDocumentJsonAttribute('data-feishu-native-paste-prepare', { status: 'running' });
      preparePendingPasteForNativePaste().then(function (summary) {
        setDocumentJsonAttribute('data-feishu-native-paste-prepare', {
          status: 'success',
          summary: summary || null,
        });
      }).catch(function (error) {
        setDocumentJsonAttribute('data-feishu-native-paste-prepare', {
          status: 'error',
          error: stringifyError(error),
        });
      });
    } catch (error) {
      setDocumentJsonAttribute('data-feishu-native-paste-prepare', {
        status: 'error',
        error: stringifyError(error),
      });
    }
  }, true);
  // Listen for token map setting from runner.
  // e.detail should have: { tokenMap: { oldToken: newToken, ... } }
  registerEventListener(document, 'feishu-set-token-map', function (e) {
    try {
      var tokenMap = (e.detail && e.detail.tokenMap) || {};
      if (tokenMap && typeof tokenMap === 'object') {
        setDocumentJsonAttribute('data-feishu-token-map-set', {
          count: mergeUploadedTokenMap(tokenMap),
        });
      }
    } catch (err) {
      setDocumentJsonAttribute('data-feishu-token-map-set', {
        error: stringifyError(err),
      });
    }
  }, true);
  registerEventListener(document, 'feishu-discover-upload-api', function () {
    try {
      discoverUploadApi().then(function (result) {
        setDocumentJsonAttribute('data-feishu-upload-api-result', result);
      });
    } catch (e) {
      setDocumentJsonAttribute('data-feishu-upload-api-result', {
        error: stringifyError(e),
      });
    }
  }, true);
  // Listen for image upload requests from runner.
  // e.detail should have: { images: [{base64, token, width, height}, ...] }
  registerEventListener(document, 'feishu-upload-images', function (e) {
    try {
      var images = (e.detail && e.detail.images) || [];
      if (!images.length) {
        setDocumentJsonAttribute('data-feishu-upload-result', {
          error: 'no images provided',
        });
        return;
      }
      uploadAllImages(images).then(function (uploadSummary) {
        var tokenMap = uploadSummary && uploadSummary.tokenMap ? uploadSummary.tokenMap : {};
        // Directly populate _uploadedTokenMap so the paste flow can use it
        // without waiting for the runner to echo it back
        setDocumentJsonAttribute('data-feishu-upload-result', {
          tokenMap: tokenMap,
          count: mergeUploadedTokenMap(tokenMap),
          uploadedCount: Number(uploadSummary && uploadSummary.uploadedCount || 0),
          failedCount: Number(uploadSummary && uploadSummary.failedCount || 0),
          attemptedCount: Number(uploadSummary && uploadSummary.attemptedCount || images.length),
        });
      }).catch(function (err) {
        setDocumentJsonAttribute('data-feishu-upload-result', {
          error: stringifyError(err),
        });
      });
    } catch (err) {
      setDocumentJsonAttribute('data-feishu-upload-result', {
        error: stringifyError(err),
      });
    }
  }, true);
  // Listen for image upload requests that read from IndexedDB's pendingPaste.
  // This is used by the runner when the target page already has the
  // orderedImageBase64List stored in IndexedDB (too large for DOM attributes).
  registerEventListener(document, 'feishu-upload-pending-images', function () {
    try {
      getPendingPaste().then(function (pending) {
        var images = (pending && pending.orderedImageBase64List) || [];
        if (!images.length) {
          setDocumentJsonAttribute('data-feishu-upload-result', {
            error: 'no pending images found in IndexedDB',
          });
          return;
        }
        uploadAllImages(images).then(function (uploadSummary) {
          var tokenMap = uploadSummary && uploadSummary.tokenMap ? uploadSummary.tokenMap : {};
          var mergedCount = mergeUploadedTokenMap(tokenMap);
          // Also update the pendingPaste docxRecord with new tokens
          // so the next Cmd+Shift+P paste uses the valid tokens.
          var origRecord = pending && pending.originalDocxRecordObj;
          if (origRecord && Object.keys(tokenMap).length > 0) {
            var replacedRecord = replaceTokensInDocxRecord(origRecord, tokenMap);
            pending.docxRecord = JSON.stringify(replacedRecord);
            pending.hasImagesToInject = false;
            pending.hasImagesToUpload = false;
            return setPendingPaste(pending).then(function () {
              setDocumentJsonAttribute('data-feishu-upload-result', {
                tokenMap: tokenMap,
                count: mergedCount,
                uploadedCount: Number(uploadSummary && uploadSummary.uploadedCount || 0),
                failedCount: Number(uploadSummary && uploadSummary.failedCount || 0),
                attemptedCount: Number(uploadSummary && uploadSummary.attemptedCount || images.length),
                pendingUpdated: true,
              });
            });
          }
          setDocumentJsonAttribute('data-feishu-upload-result', {
            tokenMap: tokenMap,
            count: mergedCount,
            uploadedCount: Number(uploadSummary && uploadSummary.uploadedCount || 0),
            failedCount: Number(uploadSummary && uploadSummary.failedCount || 0),
            attemptedCount: Number(uploadSummary && uploadSummary.attemptedCount || images.length),
          });
        }).catch(function (err) {
          setDocumentJsonAttribute('data-feishu-upload-result', {
            error: stringifyError(err),
          });
        });
      }).catch(function (err) {
        setDocumentJsonAttribute('data-feishu-upload-result', {
          error: stringifyError(err),
        });
      });
    } catch (err) {
      setDocumentJsonAttribute('data-feishu-upload-result', {
        error: stringifyError(err),
      });
    }
  }, true);
  // Listen for image injection requests from AppleScript's JS context.
  // The runner calls this after Cmd+V paste completes to trigger base64
  // injection into image block placeholders.
  registerEventListener(document, 'feishu-inject-images', function () {
    try {
      getPendingPaste().then(function (pending) {
        var list = (pending && pending.orderedImageBase64List) || [];
        var count = injectBase64ImagesIntoEditor(list);
        var editable = getContentRootElement();
        var imageBlocks = editable ? editable.querySelectorAll('[data-block-type="image"]') : [];
        document.documentElement.setAttribute('data-feishu-image-inject-result', JSON.stringify({
          injected: count,
          pending: list.length,
          imageBlocks: imageBlocks.length,
        }));
      });
    } catch (e) {
      document.documentElement.setAttribute('data-feishu-image-inject-result', JSON.stringify({ error: String(e.message || e) }));
    }
  }, true);
  // Listen for copy capture result reading from AppleScript's JS context.
  registerEventListener(document, 'feishu-read-copy-capture', function () {
    try {
      var capture = lastCopyCapture || null;
      if (capture) {
        // Only keep the essential data (HTML and MIME types), not raw Blobs
        var summary = {
          types: Object.keys(capture.rawData || {}),
          htmlLength: 0,
          htmlPreview: '',
        };
        var htmlData = capture.rawData && capture.rawData['text/html'];
        if (htmlData && htmlData.text) {
          summary.htmlLength = htmlData.text.length;
          summary.htmlPreview = htmlData.text.slice(0, 5000);
        }
        document.documentElement.setAttribute('data-feishu-copy-capture', JSON.stringify(summary));
      }
    } catch (e) {}
  }, true);

  // Write a DOM attribute to signal that TM has injected, so AppleScript's
  // execute javascript (which runs in a separate Chrome isolated world and
  // cannot see TM-scoped globals) can detect injection.
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
  // Start the image injection observer so it's ready before any paste action.
  // It watches for new [data-block-type="image"] elements and injects stored
  // base64 data into them after a paste creates image block placeholders.
  setTimeout(function () {
    startImageInjectionObserver();
  }, 2000);

  function resetImageConversionStatus() {
    imageConversionStatus = {
      state: 'idle',
      done: 0,
      total: 0,
      updatedAt: 0,
      error: '',
    };
  }

  function getLastCopyCapture() {
    return lastCopyCapture || null;
  }

  function summarizeLastCopyCapture() {
    var capture = lastCopyCapture;
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
  }

  function inspectEditorPath(path) {
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
  }

  function findEditorPaths(pattern) {
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
  }

  function getImageInjectionStatus() {
    var needed = isImageInjectionNeeded();
    var editable = getContentRootElement();
    var imageBlocks = editable ? editable.querySelectorAll('[data-block-type="image"]') : [];
    return { injectionNeeded: needed, imageBlockCount: imageBlocks.length };
  }

  function debugEditorAPI() {
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
  }

  function captureNextCopy() {
    if (copyCaptureCleanup) {
      try { copyCaptureCleanup(); } catch (err) {}
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
      copyCaptureCleanup = null;
    }

    function finalize(reason) {
      if (!active) return capture;
      capture.finalizedAt = new Date().toISOString();
      capture.reason = reason;
      lastCopyCapture = capture;
      cleanup();
      console.log('[Feishu Helper] copy capture');
      console.log(capture);
      // Write to DOM attribute so DevTools (different isolated world)
      // can read the capture result without dispatching a custom event.
      try {
        var summary = {
          finalizedAt: capture.finalizedAt,
          reason: capture.reason,
          types: Object.keys(capture.rawData || {}),
          setDataTypes: capture.setDataCalls.map(function (c) { return c.type; }),
        };
        var docxData = capture.rawData && capture.rawData['docx/record'];
        if (docxData && docxData.text) {
          summary.docxRecordLength = docxData.text.length;
          summary.docxRecordPreview = docxData.text.slice(0, 2000);
        }
        var htmlData = capture.rawData && capture.rawData['text/html'];
        if (htmlData && htmlData.text) {
          summary.htmlLength = htmlData.text.length;
          summary.htmlPreview = htmlData.text.slice(0, 2000);
        }
        document.documentElement.setAttribute('data-feishu-copy-capture', JSON.stringify(summary));
      } catch (e) {}
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

    copyCaptureCleanup = cleanup;
    lastCopyCapture = null;
    // Signal to DevTools that capture is armed (cross-isolated-world visibility)
    document.documentElement.setAttribute('data-feishu-copy-capture', JSON.stringify({ armed: true, armedAt: capture.armedAt, timeoutMs: 30000 }));
    console.log('[Feishu Helper] copy capture armed');
    return {
      armed: true,
      timeoutMs: 30000,
    };
  }

  function debugRichStyles() {
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
  }

  function debugEquations() {
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
  }

  FeishuHelperModules = {
    extraction: {
      extractFullDoc: extractFullDoc,
      duplicateDocument: duplicateDocument,
      duplicateDocumentForAutomation: duplicateDocumentForAutomation,
      preparePendingPasteForNativePaste: preparePendingPasteForNativePaste,
      captureValidationSnapshot: captureValidationSnapshot,
      getLastExtractionDebug: getLastExtractionDebug,
      getEditorReadyState: getEditorReadyState,
      exportDocumentAsHtml: exportDocumentAsHtml,
    },
    clipboard: {
      buildClipboardPayload: buildClipboardPayload,
      resolvePastePayload: resolvePastePayload,
      payloadRequiresPasteParsing: payloadRequiresPasteParsing,
      shouldAutoDispatchPastePayload: shouldAutoDispatchPastePayload,
      writeClipboardPayload: writeClipboardPayload,
      dispatchPastePayload: dispatchPastePayload,
      insertPayloadIntoEditor: insertPayloadIntoEditor,
      extractInsertionHtml: extractInsertionHtml,
      pasteIntoDoc: pasteIntoDoc,
    },
    images: {
      getImageConversionStatus: getImageConversionStatus,
      resetImageConversionStatus: resetImageConversionStatus,
      getImageInjectionStatus: getImageInjectionStatus,
      uploadAllImages: uploadAllImages,
      replaceTokensInDocxRecord: replaceTokensInDocxRecord,
      injectBase64ImagesIntoEditor: injectBase64ImagesIntoEditor,
    },
    debug: {
      getPendingPasteSummary: summarizePendingPasteForAutomation,
      getPendingPasteTimestamp: getPendingPasteTimestamp,
      getLastCopyCapture: getLastCopyCapture,
      summarizeLastCopyCapture: summarizeLastCopyCapture,
      inspectEditorPath: inspectEditorPath,
      findEditorPaths: findEditorPaths,
      debugEditorAPI: debugEditorAPI,
      captureNextCopy: captureNextCopy,
      installWhiteboardHookTracer: installWhiteboardHookTracer,
      resetWhiteboardHookDebugLog: resetWhiteboardHookDebugLog,
      debugRichStyles: debugRichStyles,
      debugEquations: debugEquations,
      getLastDocxRecord: function () {
        return lastDocxRecord;
      },
    },
    automation: {
      runAutomationAction: runAutomationAction,
      requestEvent: AUTOMATION_REQUEST_EVENT,
      resultEvent: AUTOMATION_RESULT_EVENT,
    },
  };

  if (window.__feishuHelperRuntime) {
    window.__feishuHelperRuntime.modules = FeishuHelperModules;
  }

  function runAutomationActionCompat(options) {
    var action = typeof options === 'string'
      ? options
      : options && options.action;
    return FeishuHelperModules.automation.runAutomationAction(action);
  }

  window.__tampermonkeyScriptDebugExports = function () {
    return {
      name: SCRIPT_NAME,
      version: SCRIPT_VERSION,
      automation: {
        requestEvent: AUTOMATION_REQUEST_EVENT,
        resultEvent: AUTOMATION_RESULT_EVENT,
        defaultAction: 'duplicateDocument',
        actions: ['duplicateDocument', 'validateDuplicateDocument'],
      },
      exports: {
        extractFullDoc: typeof FeishuHelperModules.extraction.extractFullDoc,
        pasteIntoDoc: typeof FeishuHelperModules.clipboard.pasteIntoDoc,
        preparePendingPasteForNativePaste: typeof FeishuHelperModules.extraction.preparePendingPasteForNativePaste,
        captureValidationSnapshot: typeof FeishuHelperModules.extraction.captureValidationSnapshot,
        getLastExtractionDebug: typeof FeishuHelperModules.extraction.getLastExtractionDebug,
        getEditorReadyState: typeof FeishuHelperModules.extraction.getEditorReadyState,
        debugEditorAPI: typeof FeishuHelperModules.debug.debugEditorAPI,
        captureNextCopy: typeof FeishuHelperModules.debug.captureNextCopy,
        runAutomationAction: typeof runAutomationActionCompat,
      },
    };
  };
  window.__feishuDebugExports = function () {
    return window.__tampermonkeyScriptDebugExports();
  };
  window.__feishuRunAutomationAction = runAutomationActionCompat;
  })();
