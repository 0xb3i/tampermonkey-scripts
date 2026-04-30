// ==UserScript==
// @name         复制净化器
// @namespace    https://github.com/tampermonkey-scripts
// @version      5.0.0
// @description  复制时自动去除加粗/括号/引号，并将数学公式提取为 LaTeX $$ 格式，兼容网站自带复制按钮
// @author       beibei
// @match        *://*/*
// @exclude      https://*.feishu.cn/*
// @exclude      https://*.larksuite.com/*
// @exclude      https://*.larkoffice.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // #region debug-point A:report-event
  function reportDebugEvent(hypothesisId, debugLocation, msg, data) {
    if (!/https:\/\/chatgpt\.com\//.test(String(window.location && window.location.href || ''))) return;
    var debugServerUrl = (function () {
      try {
        return document.documentElement.getAttribute('data-copy-cleaner-debug-url') || 'http://127.0.0.1:7777/event';
      } catch (error) {
        return 'http://127.0.0.1:7777/event';
      }
    })();
    var debugSessionId = (function () {
      try {
        return document.documentElement.getAttribute('data-copy-cleaner-debug-session') || 'chatgpt-copy-cleaner';
      } catch (error) {
        return 'chatgpt-copy-cleaner';
      }
    })();
    var debugRunId = (function () {
      try {
        return document.documentElement.getAttribute('data-copy-cleaner-debug-run') || 'pre-fix';
      } catch (error) {
        return 'pre-fix';
      }
    })();
    fetch(debugServerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: debugSessionId,
        runId: debugRunId,
        hypothesisId: hypothesisId,
        location: debugLocation,
        msg: msg,
        data: data || {},
        ts: Date.now(),
      }),
    }).catch(function () {});
  }
  // #endregion

  // #region debug-point A:boot
  try {
    document.documentElement.setAttribute('data-copy-cleaner-active', '1');
    document.documentElement.setAttribute('data-copy-cleaner-version', '5.0.0');
  } catch (error) {}
  reportDebugEvent('A', 'copy-cleaner.user.js:boot', '[DEBUG] copy cleaner booted', {
    href: String(window.location && window.location.href || ''),
    readyState: String(document.readyState || ''),
  });
  // #endregion

  function cleanText(text, options) {
    options = options || {};
    var parts = splitByLatex(text);
    var cleaned = parts.map(function (part) {
      if (part.latex) return part.text;
      return cleanPlainText(part.text, false, options.preserveIndentation);
    });
    var result = '';
    for (var i = 0; i < cleaned.length; i++) {
      var current = cleaned[i];
      if (i > 0) {
        var prev = cleaned[i - 1];
        var prevEnd = prev.charAt(prev.length - 1);
        var currentStart = current.charAt(0);
        if (prevEnd && currentStart && /\S/.test(prevEnd) && /\S/.test(currentStart)) {
          result += ' ';
        }
      }
      result += current;
    }
    return result.trim();
  }

  function splitByLatex(text) {
    var parts = [];
    var regex = /(\$\$[\s\S]*?\$\$|\$[^$\n]+?\$)/g;
    var lastIndex = 0;
    var match;
    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parts.push({ text: text.slice(lastIndex, match.index), latex: false });
      }
      parts.push({ text: match[1], latex: true });
      lastIndex = regex.lastIndex;
    }
    if (lastIndex < text.length) {
      parts.push({ text: text.slice(lastIndex), latex: false });
    }
    if (parts.length === 0) {
      parts.push({ text: text, latex: false });
    }
    return parts;
  }

  function cleanPlainText(text, isStandalone, preserveIndentation) {
    if (typeof isStandalone === 'undefined') isStandalone = true;
    if (typeof preserveIndentation === 'undefined') preserveIndentation = false;
    var result = text;

    result = result.replace(/\*\*/g, '');

    while (/（[^（）]*）/.test(result)) {
      result = result.replace(/（[^（）]*）/g, '');
    }

    result = result.replace(/["\u201C\u201D]/g, '');
    result = result.replace(/['\u2018\u2019]/g, '');

    result = result.replace(/\n{3,}/g, '\n\n');

    if (!preserveIndentation) {
      result = result.replace(/  +/g, ' ');
    }

    if (preserveIndentation) {
      return result;
    }

    if (isStandalone) {
      result = result.replace(/^ +| +$/gm, '');
    } else {
      result = result.replace(/\n +/g, '\n');
      result = result.replace(/ +\n/g, '\n');
    }

    return result;
  }

  var LATEX_DELIMITERS = {
    inline: ['$', '$'],
    display: ['$$', '$$'],
  };

  function getLatexDelimiters(isDisplay) {
    return isDisplay ? LATEX_DELIMITERS.display : LATEX_DELIMITERS.inline;
  }

  function getLatexDataAttr(isDisplay) {
    return isDisplay ? 'data-latex-display' : 'data-latex';
  }

  function replaceNodeWithText(node, text) {
    var textNode = document.createTextNode(text);
    if (node.replaceWith) {
      node.replaceWith(textNode);
    } else if (node.parentNode) {
      node.parentNode.replaceChild(textNode, node);
    }
  }

  function formatLatexText(latex, isDisplay) {
    var delimiters = getLatexDelimiters(isDisplay);
    return delimiters[0] + latex + delimiters[1];
  }

  function annotateKatexElement(el) {
    if (!el || el.hasAttribute('data-latex') || el.hasAttribute('data-latex-display')) return false;
    var annotation = el.querySelector('.katex-mathml annotation');
    if (!annotation) return false;
    el.setAttribute(getLatexDataAttr(el.closest('.katex-display') !== null), annotation.textContent);
    return true;
  }

  function annotateKatexTree(root) {
    if (!root || root.nodeType !== 1) return;
    if (root.classList && root.classList.contains('katex')) annotateKatexElement(root);
    if (!root.querySelectorAll) return;
    var katexElements = root.querySelectorAll('.katex:not([data-latex]):not([data-latex-display])');
    for (var i = 0; i < katexElements.length; i++) {
      annotateKatexElement(katexElements[i]);
    }
  }

  function patchKaTeX() {
    var katexPatched = false;

    function doPatch(katex) {
      if (katexPatched) return;
      katexPatched = true;

      if (katex.renderToString) {
        var origRenderToString = katex.renderToString;
        katex.renderToString = function (expression, options) {
          options = options || {};
          var result = origRenderToString.call(this, expression, options);
          var dataAttr = getLatexDataAttr(options.displayMode || false);
          result = result.replace(/class="katex"/, 'class="katex" ' + dataAttr + '="' + expression.replace(/"/g, '&quot;') + '"');
          return result;
        };
      }

      if (katex.render) {
        var origRender = katex.render;
        katex.render = function (expression, element, options) {
          options = options || {};
          var result = origRender.call(this, expression, element, options);
          var katexEl = element.querySelector && element.querySelector('.katex');
          if (katexEl) {
            katexEl.setAttribute(getLatexDataAttr(options.displayMode || false), expression);
          }
          return result;
        };
      }
    }

    function tryPatch() {
      if (window.katex) {
        doPatch(window.katex);
        return true;
      }
      return false;
    }

    if (!tryPatch()) {
      var katexDescriptor = Object.getOwnPropertyDescriptor(window, 'katex');
      var _katexValue = katexDescriptor ? katexDescriptor.value : undefined;

      Object.defineProperty(window, 'katex', {
        configurable: true,
        enumerable: true,
        get: function () { return _katexValue; },
        set: function (val) {
          _katexValue = val;
          if (val && typeof val === 'object') {
            doPatch(val);
          }
        }
      });
    }
  }

  patchKaTeX();

  function annotateExistingKatex() {
    annotateKatexTree(document.body || document.documentElement);
  }

  var mathObserver = new MutationObserver(function (mutations) {
    for (var i = 0; i < mutations.length; i++) {
      var added = mutations[i].addedNodes;
      for (var j = 0; j < added.length; j++) {
        var node = added[j];
        if (node.nodeType !== 1) continue;
        annotateKatexTree(node);
      }
    }
  });

  if (document.body) {
    mathObserver.observe(document.body, { childList: true, subtree: true });
  } else {
    document.addEventListener('DOMContentLoaded', function () {
      annotateExistingKatex();
      mathObserver.observe(document.body, { childList: true, subtree: true });
    });
  }

  function getKatexLatexData(katexEl) {
    var annotation = katexEl.querySelector('.katex-mathml annotation');
    var annotationLatex = annotation ? annotation.textContent : '';
    var isDisplay = katexEl.hasAttribute('data-latex-display') || katexEl.closest('.katex-display') !== null;
    var displayLatex = katexEl.getAttribute('data-latex-display') || '';
    if (isDisplay && (displayLatex || annotationLatex)) {
      return {
        latex: annotationLatex.length > displayLatex.length ? annotationLatex : displayLatex,
        isDisplay: true,
      };
    }
    var inlineLatex = katexEl.getAttribute('data-latex') || '';
    if (inlineLatex || annotationLatex) {
      return {
        latex: annotationLatex.length > inlineLatex.length ? annotationLatex : inlineLatex,
        isDisplay: false,
      };
    }
    if (!annotationLatex) return null;
    return {
      latex: annotationLatex,
      isDisplay: isDisplay,
    };
  }

  function extractLatexFromKatex(fragment) {
    var katexHtml = fragment.querySelectorAll('.katex-mathml + .katex-html');
    for (var i = 0; i < katexHtml.length; i++) {
      var el = katexHtml[i];
      if (el.remove) { el.remove(); }
      else if (el.parentNode) { el.parentNode.removeChild(el); }
    }

    var katexEls = fragment.querySelectorAll('.katex');
    for (var j = 0; j < katexEls.length; j++) {
      var katexData = getKatexLatexData(katexEls[j]);
      if (katexData) replaceNodeWithText(katexEls[j], formatLatexText(katexData.latex, katexData.isDisplay));
    }

    return fragment;
  }

  function getMathJaxLatexData(el) {
    var annotation = el.querySelector('math annotation');
    var annotationLatex = annotation ? annotation.textContent : '';
    var attrLatex = el.getAttribute('data-latex-display') || el.getAttribute('data-latex') || '';
    if (!attrLatex && !annotationLatex) return null;
    return {
      latex: annotationLatex.length > attrLatex.length ? annotationLatex : attrLatex,
      isDisplay: el.getAttribute('display') === 'true' || el.hasAttribute('display'),
    };
  }

  function extractLatexFromMathJax(fragment) {
    var mathjaxElements = fragment.querySelectorAll('mjx-container, [data-latex], [data-latex-display]');
    for (var k = 0; k < mathjaxElements.length; k++) {
      var mjEl = mathjaxElements[k];
      if (mjEl.classList.contains('katex')) continue;
      var mathJaxData = getMathJaxLatexData(mjEl);
      if (mathJaxData) replaceNodeWithText(mjEl, formatLatexText(mathJaxData.latex, mathJaxData.isDisplay));
    }

    return fragment;
  }

  function closestKatex(node) {
    var element = node instanceof Element ? node : node.parentElement;
    return element && element.closest('.katex');
  }

  function getListItemPrefix(list, itemIndex) {
    if (!list || list.tagName !== 'OL') return '- ';
    var start = parseInt(list.getAttribute('start') || '1', 10);
    if (isNaN(start)) start = 1;
    return (start + itemIndex) + '. ';
  }

  function getListItemIndex(item) {
    var index = 0;
    while (item && item.previousElementSibling) {
      item = item.previousElementSibling;
      if (item.tagName === 'LI') index++;
    }
    return index;
  }

  function isBlockElement(node) {
    return node && node.nodeType === Node.ELEMENT_NODE && /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DIV|DL|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HR|LI|MAIN|NAV|OL|P|PRE|SECTION|TABLE|TR|UL)$/.test(node.tagName);
  }

  function createStructuredState() {
    return { value: '' };
  }

  function finalizeStructuredValue(value) {
    return value
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function getStructuredNodeText(node) {
    var nestedState = createStructuredState();
    for (var child = node.firstChild; child; child = child.nextSibling) {
      serializeStructuredNode(child, nestedState);
    }
    return finalizeStructuredValue(nestedState.value);
  }

  function getStructuredSingleNodeText(node) {
    var nestedState = createStructuredState();
    serializeStructuredNode(node, nestedState);
    return finalizeStructuredValue(nestedState.value);
  }

  function normalizeStructuredText(text) {
    return splitByLatex(text).map(function (part) {
      if (part.latex) return part.text;
      return cleanPlainText(part.text.replace(/\s+/g, ' '), false);
    }).join('');
  }

  function appendInlineText(parts, text) {
    if (!text) return;
    var normalized = text.replace(/\s+/g, ' ');
    var cleaned = normalizeStructuredText(text);
    if (!cleaned.trim()) {
      if (parts.length && !/[ <\n]$/.test(parts[parts.length - 1])) parts.push(' ');
      return;
    }
    if (/^\s/.test(normalized) && parts.length && !/[ <\n]$/.test(parts[parts.length - 1])) {
      parts.push(' ');
    }
    parts.push(cleaned.trim());
    if (/\s$/.test(normalized)) parts.push(' ');
  }

  function serializeInlineNode(node, parts, options) {
    if (!node) return;

    if (node.nodeType === Node.TEXT_NODE) {
      appendInlineText(parts, node.nodeValue);
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return;

    if (node.tagName === 'BR') {
      parts.push(options && options.lineBreakToken ? options.lineBreakToken : '\n');
      return;
    }

    if (node.tagName === 'CODE') {
      var codeText = node.textContent.replace(/\r\n?/g, '\n').replace(/\n+/g, ' ');
      parts.push('`' + codeText.replace(/`/g, '\\`').replace(/\|/g, '\\|') + '`');
      return;
    }

    for (var child = node.firstChild; child; child = child.nextSibling) {
      serializeInlineNode(child, parts, options);
    }
  }

  function getInlineNodeText(node, options) {
    var parts = [];
    for (var child = node.firstChild; child; child = child.nextSibling) {
      serializeInlineNode(child, parts, options);
    }
    return parts.join('').replace(/[ \t]+$/g, '').replace(/^[ \t]+/g, '');
  }

  function normalizeTableCell(text) {
    return text.replace(/(^|[^\\])\|/g, '$1\\|');
  }

  function getCodeFence(text) {
    var matches = text.match(/`+/g) || [];
    var longest = 2;
    for (var i = 0; i < matches.length; i++) {
      if (matches[i].length > longest) longest = matches[i].length;
    }
    return new Array(longest + 2).join('`');
  }

  function buildMarkdownTable(table) {
    var rowNodes = table.querySelectorAll('tr');
    if (!rowNodes.length) return '';

    var rows = [];
    for (var i = 0; i < rowNodes.length; i++) {
      var cellNodes = rowNodes[i].children;
      var cells = [];
      var isHeader = false;
      for (var j = 0; j < cellNodes.length; j++) {
        if (cellNodes[j].tagName !== 'TH' && cellNodes[j].tagName !== 'TD') continue;
        if (cellNodes[j].tagName === 'TH') isHeader = true;
        cells.push(normalizeTableCell(getInlineNodeText(cellNodes[j], { lineBreakToken: '<br>' })));
      }
      if (cells.length) rows.push({ cells: cells, isHeader: isHeader });
    }

    if (!rows.length) return '';

    var columnCount = 0;
    for (var k = 0; k < rows.length; k++) {
      if (rows[k].cells.length > columnCount) columnCount = rows[k].cells.length;
    }
    if (!columnCount) return '';

    function formatRow(cells) {
      var padded = [];
      for (var m = 0; m < columnCount; m++) {
        padded.push(cells[m] || '');
      }
      return '| ' + padded.join(' | ') + ' |';
    }

    var header = rows[0].isHeader ? rows[0].cells : new Array(columnCount).fill('');
    var bodyRows = rows[0].isHeader ? rows.slice(1) : rows;
    var lines = [
      formatRow(header),
      formatRow(new Array(columnCount).fill('---')),
    ];

    for (var n = 0; n < bodyRows.length; n++) {
      lines.push(formatRow(bodyRows[n].cells));
    }

    return lines.join('\n');
  }

  function appendStructuredText(state, text) {
    if (!text) return;

    var normalized = text.replace(/\s+/g, ' ');
    var cleaned = normalizeStructuredText(text);
    if (!cleaned.trim()) {
      if (state.value && !/[ \n]$/.test(state.value)) state.value += ' ';
      return;
    }

    if (/^\s/.test(normalized) && state.value && !/[ \n]$/.test(state.value)) {
      state.value += ' ';
    }

    state.value += cleaned.trim();
    if (/\s$/.test(normalized)) state.value += ' ';
  }

  function appendStructuredLineBreak(state) {
    state.value = state.value.replace(/[ \t]+$/, '');
    if (state.value && !/\n$/.test(state.value)) state.value += '\n';
  }

  function appendStructuredBlock(state, text) {
    if (!text) return;
    appendStructuredLineBreak(state);
    state.value += text;
    appendStructuredLineBreak(state);
  }

  function serializeStructuredNode(node, state) {
    if (!node) return;

    if (node.nodeType === Node.TEXT_NODE) {
      appendStructuredText(state, node.nodeValue);
      return;
    }

    if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      for (var child = node.firstChild; child; child = child.nextSibling) {
        serializeStructuredNode(child, state);
      }
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return;

    if (node.tagName === 'BR') {
      appendStructuredLineBreak(state);
      return;
    }

    if (node.classList && node.classList.contains('katex-display')) {
      appendStructuredBlock(state, normalizeStructuredText(node.textContent || ''));
      return;
    }

    if (node.tagName === 'LI') {
      appendStructuredLineBreak(state);
      appendStructuredText(state, getListItemPrefix(node.parentElement, getListItemIndex(node)));
      var inlineParts = [];
      var nestedBlocks = [];
      for (var listChild = node.firstChild; listChild; listChild = listChild.nextSibling) {
        if (listChild.nodeType === Node.ELEMENT_NODE && /^(UL|OL)$/.test(listChild.tagName)) {
          nestedBlocks.push(listChild);
          continue;
        }
        if (listChild.nodeType === Node.ELEMENT_NODE && listChild.tagName === 'P') {
          appendInlineText(inlineParts, getInlineNodeText(listChild, { lineBreakToken: ' ' }));
          continue;
        }
        if (listChild.nodeType === Node.ELEMENT_NODE && isBlockElement(listChild)) {
          nestedBlocks.push(listChild);
          continue;
        }
        serializeInlineNode(listChild, inlineParts, { lineBreakToken: ' ' });
      }
      if (inlineParts.length) {
        appendStructuredText(state, inlineParts.join('').trim());
      }
      for (var nestedIndex = 0; nestedIndex < nestedBlocks.length; nestedIndex++) {
        serializeStructuredNode(nestedBlocks[nestedIndex], state);
      }
      appendStructuredLineBreak(state);
      return;
    }

    if (/^H[1-6]$/.test(node.tagName)) {
      var level = parseInt(node.tagName.charAt(1), 10);
      appendStructuredBlock(state, new Array(level + 1).join('#') + ' ' + getStructuredNodeText(node));
      return;
    }

    if (node.tagName === 'BLOCKQUOTE') {
      var quoteParts = [];
      for (var quoteChild = node.firstChild; quoteChild; quoteChild = quoteChild.nextSibling) {
        var quotePart = getStructuredSingleNodeText(quoteChild);
        if (quotePart) quoteParts.push(quotePart);
      }
      var quoteText = quoteParts.join('\n');
      if (!quoteText) return;
      appendStructuredBlock(state, quoteText.split('\n').map(function (line) {
        return line ? '> ' + line : '>';
      }).join('\n'));
      return;
    }

    if (node.tagName === 'HR') {
      appendStructuredBlock(state, '---');
      return;
    }

    if (node.tagName === 'TABLE') {
      appendStructuredBlock(state, buildMarkdownTable(node));
      return;
    }

    if (node.tagName === 'PRE') {
      var codeChild = node.children && node.children.length === 1 && node.firstElementChild && node.firstElementChild.tagName === 'CODE'
        ? node.firstElementChild
        : null;
      if (codeChild) {
        var codeText = codeChild.textContent.replace(/\r\n?/g, '\n').replace(/\n$/, '');
        var fence = getCodeFence(codeText);
        appendStructuredBlock(state, fence + '\n' + codeText + '\n' + fence);
        return;
      }
      appendStructuredLineBreak(state);
      state.value += node.textContent.replace(/\r\n?/g, '\n').replace(/\n$/, '');
      appendStructuredLineBreak(state);
      return;
    }

    var isBlock = isBlockElement(node);
    if (isBlock && node.tagName !== 'UL' && node.tagName !== 'OL') {
      appendStructuredLineBreak(state);
    }

    for (var childNode = node.firstChild; childNode; childNode = childNode.nextSibling) {
      serializeStructuredNode(childNode, state);
    }

    if (isBlock) appendStructuredLineBreak(state);
  }

  function serializeStructuredFragment(fragment) {
    var state = createStructuredState();
    serializeStructuredNode(fragment, state);
    return finalizeStructuredValue(state.value);
  }

  function hasStructuredFragmentContent(fragment) {
    return !!(fragment && fragment.querySelector && fragment.querySelector('ul li, ol li, h1, h2, h3, h4, h5, h6, blockquote, pre, hr, table'));
  }

  function extractFragmentText(fragment, baseText) {
    if (!fragment) return '';
    if (hasStructuredFragmentContent(fragment)) {
      return serializeStructuredFragment(fragment);
    }
    return typeof baseText === 'string' ? baseText : fragment.textContent;
  }

  function resolveLatexSelectionPayload(selection) {
    if (!selection || selection.rangeCount === 0) return null;

    var range = selection.getRangeAt(0).cloneRange();

    var startKatex = closestKatex(range.startContainer);
    if (startKatex) { range.setStartBefore(startKatex); }

    var endKatex = closestKatex(range.endContainer);
    if (endKatex) { range.setEndAfter(endKatex); }

    var fragment = range.cloneContents();

    var hasMath = fragment.querySelector('.katex') ||
                  fragment.querySelector('mjx-container') ||
                  fragment.querySelector('[data-latex]') ||
                  fragment.querySelector('[data-latex-display]');

    if (!hasMath) return null;

    extractLatexFromKatex(fragment);
    extractLatexFromMathJax(fragment);

    return {
      text: extractFragmentText(fragment, fragment.textContent),
      alreadyStructured: hasStructuredFragmentContent(fragment),
    };
  }

  function extractStructuredSelectionText(selection) {
    if (!selection || selection.rangeCount === 0) return null;
    var fragment = selection.getRangeAt(0).cloneContents();
    if (!hasStructuredFragmentContent(fragment)) return null;
    return {
      text: extractFragmentText(fragment, selection.toString()),
    };
  }

  function buildClipboardPayloadFromSelection(selection) {
    if (!selection || selection.isCollapsed) return null;

    var rawText = selection.toString();
    var latexPayload = resolveLatexSelectionPayload(selection);
    if (latexPayload !== null) {
      return {
        text: latexPayload.alreadyStructured ? latexPayload.text : cleanText(latexPayload.text),
      };
    }

    var structuredText = extractStructuredSelectionText(selection);
    if (structuredText !== null) {
      return structuredText.text !== rawText
        ? { text: structuredText.text }
        : null;
    }

    if (!rawText) return null;
    var cleanedText = cleanText(rawText);
    return cleanedText !== rawText
      ? { text: cleanedText }
      : null;
  }

  var shouldBypassClipboardClean = false;

  function withClipboardCleanBypass(fn) {
    shouldBypassClipboardClean = true;
    var result;
    try {
      result = fn();
    } catch (error) {
      shouldBypassClipboardClean = false;
      throw error;
    }
    return Promise.resolve(result).finally(function () {
      shouldBypassClipboardClean = false;
    });
  }

  function patchClipboardAPI() {
    if (typeof Clipboard === 'undefined' || !Clipboard.prototype) return;

    if (Clipboard.prototype.writeText) {
      var originalWriteText = Clipboard.prototype.writeText;
      Object.defineProperty(Clipboard.prototype, 'writeText', {
        value: function (text) {
          // #region debug-point B:clipboard-writeText
          reportDebugEvent('B', 'copy-cleaner.user.js:writeText', '[DEBUG] Clipboard.writeText intercepted', {
            href: String(location.href || ''),
            originalText: String(text || '').slice(0, 500),
            bypass: shouldBypassClipboardClean,
            cleanedText: shouldBypassClipboardClean ? String(text || '').slice(0, 500) : String(cleanText(text) || '').slice(0, 500),
          });
          // #endregion
          if (shouldBypassClipboardClean) {
            return originalWriteText.call(this, text);
          }
          return originalWriteText.call(this, cleanText(text));
        },
        writable: true,
        configurable: true,
        enumerable: true,
      });
    }

    if (Clipboard.prototype.write) {
      var originalWrite = Clipboard.prototype.write;
      Object.defineProperty(Clipboard.prototype, 'write', {
        value: function (items) {
          // #region debug-point C:clipboard-write
          try {
            reportDebugEvent('C', 'copy-cleaner.user.js:write', '[DEBUG] Clipboard.write intercepted', {
              href: String(location.href || ''),
              itemCount: items && typeof items.length === 'number' ? items.length : null,
              itemTypes: Array.prototype.map.call(items || [], function (item) {
                return item && item.types ? Array.prototype.slice.call(item.types) : [];
              }),
              bypass: shouldBypassClipboardClean,
            });
          } catch (error) {}
          // #endregion
          var newItems = [];
          for (var item of items) {
            var newItem = {};
            for (var type of item.types) {
              if (type === 'text/plain') {
                newItem[type] = item.getType(type).then(function (blob) {
                  return blob.text();
                }).then(function (text) {
                  // #region debug-point C:clipboard-write-plain-text
                  reportDebugEvent('C', 'copy-cleaner.user.js:write:text/plain', '[DEBUG] Clipboard.write text/plain observed', {
                    href: String(location.href || ''),
                    originalText: String(text || '').slice(0, 500),
                    bypass: shouldBypassClipboardClean,
                    cleanedText: shouldBypassClipboardClean ? String(text || '').slice(0, 500) : String(cleanText(text) || '').slice(0, 500),
                  });
                  // #endregion
                  if (shouldBypassClipboardClean) {
                    return new Blob([text], { type: 'text/plain' });
                  }
                  return new Blob([cleanText(text)], { type: 'text/plain' });
                });
              } else {
                newItem[type] = item.getType(type);
              }
            }
            newItems.push(new ClipboardItem(newItem));
          }
          return originalWrite.call(this, newItems);
        },
        writable: true,
        configurable: true,
        enumerable: true,
      });
    }
  }

  patchClipboardAPI();

  function onCopy(e) {
    var payload = buildClipboardPayloadFromSelection(window.getSelection());
    // #region debug-point D:copy-event
    reportDebugEvent('D', 'copy-cleaner.user.js:onCopy', '[DEBUG] copy event observed', {
      href: String(location.href || ''),
      hasClipboardData: !!(e && e.clipboardData),
      selectionText: String(window.getSelection && window.getSelection() ? window.getSelection().toString() : '').slice(0, 500),
      payloadText: payload && payload.text ? String(payload.text).slice(0, 500) : '',
      intercepted: !!(payload && e && e.clipboardData),
    });
    // #endregion
    if (!payload || !e.clipboardData) return;

    e.preventDefault();
    e.stopImmediatePropagation();
    e.clipboardData.setData('text/plain', payload.text);
  }

  function onKeydown(e) {
    var isCopy = (e.ctrlKey || e.metaKey) && e.key === 'c';
    if (!isCopy) return;

    var payload = buildClipboardPayloadFromSelection(window.getSelection());
    if (payload === null) return;

    e.preventDefault();
    e.stopImmediatePropagation();

    if (navigator.clipboard && navigator.clipboard.writeText) {
      withClipboardCleanBypass(function () {
        return navigator.clipboard.writeText(payload.text);
      }).catch(function () {});
    }
  }

  function findChatGptAssistantCopyButton(target) {
    if (!target || !target.closest || !/https:\/\/chatgpt\.com\//.test(String(window.location && window.location.href || ''))) {
      return null;
    }
    var button = target.closest('button[data-testid="copy-turn-action-button"]');
    if (!button) return null;
    var turn = button.closest('[data-turn], [data-testid^="conversation-turn-"]');
    var dataTurn = turn ? String(turn.getAttribute('data-turn') || '') : '';
    var ariaLabel = String(button.getAttribute('aria-label') || '');
    if (dataTurn === 'assistant') return button;
    if (/复制回复|copy response/i.test(ariaLabel)) return button;
    return null;
  }

  function getChatGptAssistantContentRoot(button) {
    if (!button || !button.closest) return '';
    var turn = button.closest('[data-turn], [data-testid^="conversation-turn-"]');
    if (!turn || !turn.querySelector) return null;
    return turn.querySelector('[data-message-author-role="assistant"] .markdown')
      || turn.querySelector('[data-message-author-role="assistant"]')
      || turn;
  }

  function buildClipboardPayloadFromRoot(root) {
    if (!root || !root.cloneNode) return null;
    var fragment = document.createDocumentFragment();
    fragment.appendChild(root.cloneNode(true));
    // #region debug-point F:root-before-extract
    reportDebugEvent('F', 'copy-cleaner.user.js:buildClipboardPayloadFromRoot:before', '[DEBUG] ChatGPT root snapshot before extract', {
      rootHtml: root.innerHTML.slice(0, 4000),
      displayLatexAttrs: Array.prototype.map.call(root.querySelectorAll('.katex[data-latex-display]'), function (el) {
        return String(el.getAttribute('data-latex-display') || '').slice(0, 300);
      }).slice(0, 8),
      displayAnnotations: Array.prototype.map.call(root.querySelectorAll('.katex .katex-mathml annotation'), function (el) {
        return String(el.textContent || '').slice(0, 300);
      }).slice(0, 8),
    });
    // #endregion
    extractLatexFromKatex(fragment);
    extractLatexFromMathJax(fragment);
    var text = serializeStructuredFragment(fragment);
    if (!text) {
      text = cleanText(fragment.textContent || '');
    }
    // #region debug-point G:payload-after-extract
    reportDebugEvent('G', 'copy-cleaner.user.js:buildClipboardPayloadFromRoot:after', '[DEBUG] ChatGPT payload built from root', {
      payloadText: String(text || '').slice(0, 4000),
      latexMatches: String(text || '').match(/\$\$[\s\S]*?\$\$|\$[^$\n]+?\$/g) || [],
    });
    // #endregion
    return text ? { text: text } : null;
  }

  function onChatGptCopyButtonClick(e) {
    var button = findChatGptAssistantCopyButton(e.target);
    if (!button) return;

    var contentRoot = getChatGptAssistantContentRoot(button);
    var payload = buildClipboardPayloadFromRoot(contentRoot);
    if (!payload || !payload.text) return;

    // #region debug-point E:chatgpt-copy-button
    reportDebugEvent('E', 'copy-cleaner.user.js:onChatGptCopyButtonClick', '[DEBUG] ChatGPT assistant copy button intercepted', {
      href: String(window.location && window.location.href || ''),
      rootTag: contentRoot && contentRoot.tagName ? contentRoot.tagName : '',
      rootClass: contentRoot && contentRoot.className ? String(contentRoot.className).slice(0, 200) : '',
      cleanedText: payload.text.slice(0, 1000),
      containsLatex: /\$\$[\s\S]*\$\$|\$[^$\n]+\$/.test(payload.text),
    });
    // #endregion

    e.preventDefault();
    e.stopImmediatePropagation();

    withClipboardCleanBypass(function () {
      return navigator.clipboard.writeText(payload.text);
    }).then(function () {
      // #region debug-point H:clipboard-after-write
      reportDebugEvent('H', 'copy-cleaner.user.js:onChatGptCopyButtonClick:afterWrite', '[DEBUG] ChatGPT payload written to clipboard', {
        payloadText: String(payload.text || '').slice(0, 4000),
      });
      // #endregion
      try {
        document.documentElement.setAttribute('data-copy-cleaner-chatgpt-copy', payload.text);
        document.documentElement.setAttribute('data-copy-cleaner-chatgpt-copy-length', String(payload.text.length));
      } catch (error) {}
    }).catch(function () {});
  }

  window.addEventListener('copy', onCopy, true);
  window.addEventListener('keydown', onKeydown, true);
  window.addEventListener('click', onChatGptCopyButtonClick, true);
})();
