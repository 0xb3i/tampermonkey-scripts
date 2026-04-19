// ==UserScript==
// @name         复制净化器
// @namespace    https://github.com/tampermonkey-scripts
// @version      5.0.0
// @description  复制时自动去除加粗/括号/引号，并将数学公式提取为 LaTeX $$ 格式，兼容网站自带复制按钮
// @author       You
// @match        *://*/*
// @exclude      https://*.feishu.cn/*
// @exclude      https://*.larksuite.com/*
// @exclude      https://*.larkoffice.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  var SCRIPT_NAME = '复制净化器';
  var SCRIPT_VERSION = '5.0.0';

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

  window.__copyCleanerCleanText = cleanText;
  window.__copyCleanerSplitByLatex = splitByLatex;

  var LATEX_DELIMITERS = {
    inline: ['$', '$'],
    display: ['$$', '$$'],
  };

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
          var displayMode = options.displayMode || false;
          var dataAttr = displayMode ? 'data-latex-display' : 'data-latex';
          result = result.replace(/class="katex"/, 'class="katex" ' + dataAttr + '="' + expression.replace(/"/g, '&quot;') + '"');
          return result;
        };
      }

      if (katex.render) {
        var origRender = katex.render;
        katex.render = function (expression, element, options) {
          options = options || {};
          var displayMode = options.displayMode || false;
          var dataAttr = displayMode ? 'data-latex-display' : 'data-latex';
          var result = origRender.call(this, expression, element, options);
          var katexEl = element.querySelector && element.querySelector('.katex');
          if (katexEl) {
            katexEl.setAttribute(dataAttr, expression);
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
    var katexElements = document.querySelectorAll('.katex:not([data-latex]):not([data-latex-display])');
    for (var i = 0; i < katexElements.length; i++) {
      var el = katexElements[i];
      var annotation = el.querySelector('.katex-mathml annotation');
      if (annotation) {
        var isDisplay = el.closest('.katex-display') !== null;
        var attr = isDisplay ? 'data-latex-display' : 'data-latex';
        el.setAttribute(attr, annotation.textContent);
      }
    }
  }

  var mathObserver = new MutationObserver(function (mutations) {
    for (var i = 0; i < mutations.length; i++) {
      var added = mutations[i].addedNodes;
      for (var j = 0; j < added.length; j++) {
        var node = added[j];
        if (node.nodeType !== 1) continue;
        if (node.classList && node.classList.contains('katex') && !node.hasAttribute('data-latex') && !node.hasAttribute('data-latex-display')) {
          var ann = node.querySelector('.katex-mathml annotation');
          if (ann) {
            var isDisp = node.closest('.katex-display') !== null;
            node.setAttribute(isDisp ? 'data-latex-display' : 'data-latex', ann.textContent);
          }
        }
        if (node.querySelectorAll) {
          var katexNodes = node.querySelectorAll('.katex:not([data-latex]):not([data-latex-display])');
          for (var k = 0; k < katexNodes.length; k++) {
            var ann2 = katexNodes[k].querySelector('.katex-mathml annotation');
            if (ann2) {
              var isDisp2 = katexNodes[k].closest('.katex-display') !== null;
              katexNodes[k].setAttribute(isDisp2 ? 'data-latex-display' : 'data-latex', ann2.textContent);
            }
          }
        }
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

  function extractLatexFromKatex(fragment) {
    var katexHtml = fragment.querySelectorAll('.katex-mathml + .katex-html');
    for (var i = 0; i < katexHtml.length; i++) {
      var el = katexHtml[i];
      if (el.remove) { el.remove(); }
      else if (el.parentNode) { el.parentNode.removeChild(el); }
    }

    var katexEls = fragment.querySelectorAll('.katex');
    for (var j = 0; j < katexEls.length; j++) {
      var katexEl = katexEls[j];
      var latex = null;
      var isDisplay = false;

      if (katexEl.hasAttribute('data-latex-display')) {
        latex = katexEl.getAttribute('data-latex-display');
        isDisplay = true;
      } else if (katexEl.hasAttribute('data-latex')) {
        latex = katexEl.getAttribute('data-latex');
        isDisplay = false;
      } else {
        var mathml = katexEl.querySelector('.katex-mathml');
        if (mathml) {
          var texSource = mathml.querySelector('annotation');
          if (texSource) {
            latex = texSource.textContent;
            isDisplay = katexEl.closest('.katex-display') !== null;
          }
        }
      }

      if (latex !== null) {
        var delimiters = isDisplay ? LATEX_DELIMITERS.display : LATEX_DELIMITERS.inline;
        var tex = delimiters[0] + latex + delimiters[1];
        var textNode = document.createTextNode(tex);
        if (katexEl.replaceWith) { katexEl.replaceWith(textNode); }
        else if (katexEl.parentNode) { katexEl.parentNode.replaceChild(textNode, katexEl); }
      }
    }

    return fragment;
  }

  function extractLatexFromMathJax(fragment) {
    var mjxContainers = fragment.querySelectorAll('mjx-container');
    for (var j = 0; j < mjxContainers.length; j++) {
      var container = mjxContainers[j];
      var latex = null;
      var isDisplay = container.getAttribute('display') === 'true' || container.hasAttribute('display');

      var mathEl = container.querySelector('math');
      if (mathEl) {
        var annotation = mathEl.querySelector('annotation');
        if (annotation) {
          latex = annotation.textContent;
        }
      }

      if (latex !== null) {
        var delimiters = isDisplay ? LATEX_DELIMITERS.display : LATEX_DELIMITERS.inline;
        var tex = delimiters[0] + latex + delimiters[1];
        var textNode = document.createTextNode(tex);
        if (container.replaceWith) { container.replaceWith(textNode); }
        else if (container.parentNode) { container.parentNode.replaceChild(textNode, container); }
      }
    }

    var mathjaxElements = fragment.querySelectorAll('[data-latex], [data-latex-display]');
    for (var k = 0; k < mathjaxElements.length; k++) {
      var mjEl = mathjaxElements[k];
      if (mjEl.classList.contains('katex')) continue;
      var latexAttr = mjEl.getAttribute('data-latex-display') || mjEl.getAttribute('data-latex');
      if (latexAttr) {
        var isDisplay3 = mjEl.hasAttribute('data-latex-display') || mjEl.classList.contains('MathJax_Display') || mjEl.classList.contains('mathjax-display');
        var delimiters3 = isDisplay3 ? LATEX_DELIMITERS.display : LATEX_DELIMITERS.inline;
        var tex3 = delimiters3[0] + latexAttr + delimiters3[1];
        var textNode3 = document.createTextNode(tex3);
        if (mjEl.replaceWith) { mjEl.replaceWith(textNode3); }
        else if (mjEl.parentNode) { mjEl.parentNode.replaceChild(textNode3, mjEl); }
      }
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

    if (node.tagName === 'LI') {
      appendStructuredLineBreak(state);
      appendStructuredText(state, getListItemPrefix(node.parentElement, getListItemIndex(node)));
      for (var listChild = node.firstChild; listChild; listChild = listChild.nextSibling) {
        serializeStructuredNode(listChild, state);
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

  function extractTextWithLatex(selection) {
    var payload = resolveLatexSelectionPayload(selection);
    return payload ? payload.text : null;
  }

  function extractStructuredSelectionText(selection) {
    if (!selection || selection.rangeCount === 0) return null;
    var fragment = selection.getRangeAt(0).cloneContents();
    if (!hasStructuredFragmentContent(fragment)) return null;
    return {
      text: extractFragmentText(fragment, selection.toString()),
      alreadyCleaned: true,
    };
  }

  window.__copyCleanerExtractLatex = extractTextWithLatex;

  function resolveSelectionPayload(selection) {
    if (!selection || selection.isCollapsed) return null;

    var rawText = selection.toString();
    var latexPayload = resolveLatexSelectionPayload(selection);
    if (latexPayload !== null) {
      return {
        text: latexPayload.alreadyStructured ? latexPayload.text : cleanText(latexPayload.text),
        shouldIntercept: true,
      };
    }

    var structuredText = extractStructuredSelectionText(selection);
    if (structuredText !== null) {
      return {
        text: structuredText.text,
        shouldIntercept: structuredText.text !== rawText,
      };
    }

    if (!rawText) return null;
    var cleanedText = cleanText(rawText);
    if (cleanedText !== rawText) {
      return { text: cleanedText, shouldIntercept: true };
    }

    return null;
  }

  function getCleanedText() {
    var selection = window.getSelection();
    var payload = resolveSelectionPayload(selection);
    return payload && payload.shouldIntercept ? payload : null;
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
      const originalWriteText = Clipboard.prototype.writeText;
      Object.defineProperty(Clipboard.prototype, 'writeText', {
        value: function (text) {
          if (shouldBypassClipboardClean) {
            return originalWriteText.call(this, text);
          }
          const cleaned = cleanText(text);
          return originalWriteText.call(this, cleaned);
        },
        writable: true,
        configurable: true,
        enumerable: true,
      });
    }

    if (Clipboard.prototype.write) {
      const originalWrite = Clipboard.prototype.write;
      Object.defineProperty(Clipboard.prototype, 'write', {
        value: function (items) {
          const newItems = [];
          for (const item of items) {
            const newItem = {};
            for (const type of item.types) {
              if (type === 'text/plain') {
                newItem[type] = item.getType(type).then(function (blob) {
                  return blob.text();
                }).then(function (text) {
                  if (shouldBypassClipboardClean) {
                    return new Blob([text], { type: 'text/plain' });
                  }
                  const cleaned = cleanText(text);
                  return new Blob([cleaned], { type: 'text/plain' });
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
    var selection = window.getSelection();
    var payload = resolveSelectionPayload(selection);
    if (!payload || !payload.shouldIntercept || !e.clipboardData) return;

    e.preventDefault();
    e.stopImmediatePropagation();
    e.clipboardData.setData('text/plain', payload.text);
  }

  function onKeydown(e) {
    var isCopy = (e.ctrlKey || e.metaKey) && e.key === 'c';
    if (!isCopy) return;

    var payload = getCleanedText();
    if (payload === null) return;

    e.preventDefault();
    e.stopImmediatePropagation();

    if (navigator.clipboard && navigator.clipboard.writeText) {
      withClipboardCleanBypass(function () {
        return navigator.clipboard.writeText(payload.text);
      }).catch(function () {});
    }
  }

  window.__tampermonkeyScriptDebugExports = function () {
    return {
      name: SCRIPT_NAME,
      version: SCRIPT_VERSION,
      automation: null,
      exports: {
        cleanText: typeof window.__copyCleanerCleanText,
        splitByLatex: typeof window.__copyCleanerSplitByLatex,
        extractLatex: typeof window.__copyCleanerExtractLatex,
      },
    };
  };
  window.addEventListener('copy', onCopy, true);
  window.addEventListener('keydown', onKeydown, true);
})();
