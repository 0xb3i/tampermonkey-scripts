// ==UserScript==
// @name         复制净化器
// @namespace    https://github.com/tampermonkey-scripts
// @version      5.0.10
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

  function looksLikeMarkdownCopy(text) {
    if (!text) return false;
    var doubleBreaks = (text.match(/\n\n/g) || []).length;
    if (doubleBreaks < 8) return false;
    return /(^|\n)(#{1,6}\s|[-*]\s|\d+\.\s|>\s|```|---\s*$)/m.test(text);
  }

  function compactMarkdownBlankLines(text) {
    var parts = String(text || '').split(/(```[\s\S]*?```)/g);
    for (var i = 0; i < parts.length; i += 2) {
      parts[i] = parts[i].replace(/\n{2,}/g, '\n');
    }
    return parts.join('');
  }

  function cleanTextOutsideCodeFences(text) {
    var parts = String(text || '').split(/(```[\s\S]*?```)/g);
    var result = '';
    for (var i = 0; i < parts.length; i += 2) {
      parts[i] = cleanText(parts[i]);
    }
    for (var j = 0; j < parts.length; j++) {
      var part = parts[j];
      if (!part) continue;
      var isFence = j % 2 === 1;
      if (isFence && result && !/\n$/.test(result)) result += '\n';
      result += part;
      if (isFence && j < parts.length - 1 && parts[j + 1] && !/^\n/.test(parts[j + 1])) result += '\n';
    }
    return result;
  }

  function looksLikePlainCodeCopy(text) {
    text = String(text || '').replace(/\r\n?/g, '\n');
    if (text.indexOf('\n') === -1 || /```/.test(text)) return false;
    return /(^|\n)( {2,}|\t)\S/.test(text) &&
      /(^|\n)(def |class |if |elif |else:|for |while |try:|except |return |const |let |var |function |import |from |print\(|console\.)/.test(text);
  }

  function normalizeClipboardText(text) {
    if (looksLikePlainCodeCopy(text)) return String(text || '').replace(/\r\n?/g, '\n');
    var cleaned = cleanTextOutsideCodeFences(text);
    cleaned = normalizeStructuredMarkdownForPaste(cleaned);
    return looksLikeMarkdownCopy(cleaned)
      ? compactMarkdownBlankLines(cleaned)
      : cleaned;
  }

  function normalizeStructuredMarkdownForPaste(text) {
    var lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    var result = [];
    function isTableLine(line) {
      return /^\|.*\|$/.test(String(line || '').trim());
    }
    function isDividerLine(line) {
      var trimmed = String(line || '').trim();
      return /^\|(?:\s*:?-{3,}:?\s*\|)+$/.test(trimmed);
    }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      result.push(line);
      var prev = i > 0 ? lines[i - 1] : '';
      var next = i + 1 < lines.length ? lines[i + 1] : '';
      if (isTableLine(prev) && isDividerLine(line)) continue;
      if (isTableLine(line) && !isTableLine(next) && next) {
        result.push('');
      }
    }
    return result.join('\n');
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
    var delimiter = isDisplay ? '$$' : '$';
    return delimiter + latex + delimiter;
  }

  function formatInlineCode(text) {
    return '`' + String(text || '').replace(/\r\n?/g, '\n').replace(/\n+/g, ' ').replace(/`/g, '\\`').replace(/\|/g, '\\|') + '`';
  }

  function formatImageMarkdown(alt, src) {
    if (!src) return '';
    return '![' + String(alt || '').replace(/]/g, '\\]') + '](' + String(src).replace(/\)/g, '\\)') + ')';
  }

  function shouldSkipImageNode(node) {
    var src = getAttributeValue(node, 'src');
    var alt = getAttributeValue(node, 'alt');
    if (!src) return true;
    return /^data:image\/svg\+xml/i.test(src) && !alt;
  }

  function getRenderedText(node) {
    if (!node) return '';
    if (typeof node.innerText === 'string' && node.innerText) {
      return String(node.innerText).replace(/\r\n?/g, '\n');
    }
    return getPreformattedText(node);
  }

  function getAttributeValue(node, name) {
    if (!node || !name) return '';
    if (typeof node.getAttribute === 'function') {
      return String(node.getAttribute(name) || '');
    }
    return typeof node[name] === 'string' ? node[name] : '';
  }

  function hasAttributeValue(node, name) {
    if (!node || !name) return false;
    if (typeof node.hasAttribute === 'function') return node.hasAttribute(name);
    return !!node[name];
  }

  function getPreformattedText(node) {
    if (!node) return '';
    if (node.nodeType === Node.TEXT_NODE) {
      return String(node.nodeValue || '').replace(/\u00a0/g, ' ');
    }
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) {
      return '';
    }
    if (node.nodeType === Node.ELEMENT_NODE && /^(SCRIPT|STYLE)$/.test(node.tagName)) {
      return '';
    }
    if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'BR') {
      return '\n';
    }
    var text = '';
    for (var child = node.firstChild; child; child = child.nextSibling) {
      text += getPreformattedText(child);
    }
    return text.replace(/\r\n?/g, '\n');
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

    if (window.katex) {
      doPatch(window.katex);
      return;
    }

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

  patchKaTeX();

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
      annotateKatexTree(document.body || document.documentElement);
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

  function extractLatexFromFragment(fragment) {
    extractLatexFromKatex(fragment);
    extractLatexFromMathJax(fragment);
    return fragment;
  }

  function isBlockElement(node) {
    return node && node.nodeType === Node.ELEMENT_NODE && /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DIV|DL|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HR|LI|MAIN|NAV|OL|P|PRE|SECTION|TABLE|TR|UL)$/.test(node.tagName);
  }

  function finalizeStructuredValue(value) {
    return value
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function getStructuredText(node, includeSelf) {
    var state = { value: '' };
    if (includeSelf) {
      serializeStructuredNode(node, state);
    } else {
      for (var child = node.firstChild; child; child = child.nextSibling) {
        serializeStructuredNode(child, state);
      }
    }
    return finalizeStructuredValue(state.value);
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
      parts.push(formatInlineCode(getRenderedText(node) || node.textContent));
      return;
    }

    if (node.tagName === 'IMG') {
      if (shouldSkipImageNode(node)) return;
      parts.push(formatImageMarkdown(getAttributeValue(node, 'alt'), getAttributeValue(node, 'src')));
      return;
    }

    if (node.tagName === 'A') {
      var label = getInlineNodeText(node, options);
      var href = getAttributeValue(node, 'href');
      if (hasAttributeValue(node, 'data-footnote-ref')) {
        var refText = String(label || '').replace(/[^\d]+/g, '') || '1';
        parts.push('[^' + refText + ']');
        return;
      }
      if (hasAttributeValue(node, 'data-footnote-backref')) {
        parts.push('↩');
        return;
      }
      if (href && label) {
        parts.push('[' + label.replace(/]/g, '\\]') + '](' + href.replace(/\)/g, '\\)') + ')');
        return;
      }
      appendInlineText(parts, label);
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

  function getLiteralInlineText(node) {
    if (!node) return '';
    if (node.nodeType === Node.TEXT_NODE) {
      return String(node.nodeValue || '').replace(/\u00a0/g, ' ');
    }
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) {
      return '';
    }
    if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'BR') {
      return '\n';
    }
    if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'CODE') {
      return formatInlineCode(getRenderedText(node) || node.textContent);
    }
    if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'IMG') {
      if (shouldSkipImageNode(node)) return '';
      return formatImageMarkdown(getAttributeValue(node, 'alt'), getAttributeValue(node, 'src'));
    }
    if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'A') {
      var label = getInlineNodeText(node, { lineBreakToken: ' ' });
      var href = getAttributeValue(node, 'href');
      return href && label ? '[' + label.replace(/]/g, '\\]') + '](' + href.replace(/\)/g, '\\)') + ')' : label;
    }
    var text = '';
    for (var child = node.firstChild; child; child = child.nextSibling) {
      text += getLiteralInlineText(child);
    }
    return text;
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

  function looksLikeCodeLine(line) {
    var trimmed = String(line || '').trim();
    if (!trimmed) return false;
    return /^\s/.test(String(line || '')) ||
      /[{}()[\];=]/.test(trimmed) ||
      /:$/.test(trimmed) ||
      /^(def |class |if |elif |else:|for |while |try:|except |return |const |let |var |function |import |from |print\(|console\.|<\w)/.test(trimmed);
  }

  function extractPreformattedCodeBlock(preNode, codeNode) {
    var preRendered = getRenderedText(preNode).replace(/\r\n?/g, '\n');
    var preLines = preRendered.split('\n').filter(function (line, index, lines) {
      return line || index < lines.length - 1;
    });
    var languageLabel = preNode && preNode.querySelector ? getRenderedText(preNode.querySelector('.code-block-language-label')).trim().toLowerCase() : '';
    var classLanguage = '';
    function readClassLanguage(value) {
      var match = String(value || '').match(/(?:^|\s)language-([A-Za-z0-9.+#_-]{1,30})(?:\s|$)/);
      return match ? match[1].toLowerCase() : '';
    }
    classLanguage = readClassLanguage(preNode && preNode.className);
    if (!classLanguage) classLanguage = readClassLanguage(codeNode && codeNode.className);
    function detectLanguage(codeText) {
      if (/^[a-z0-9.+#_-]{1,30}$/.test(languageLabel)) {
        return languageLabel;
      }
      if (/^[a-z0-9.+#_-]{1,30}$/.test(classLanguage)) {
        return classLanguage;
      }
      for (var languageIndex = 0; languageIndex < preLines.length; languageIndex++) {
        var languageCandidate = preLines[languageIndex].trim();
        if (!languageCandidate || /^(复制|运行)$/i.test(languageCandidate)) continue;
        if (/^[A-Za-z0-9.+#_-]{1,30}$/.test(languageCandidate)) {
          return languageCandidate.toLowerCase();
        }
      }
      var compactPre = preRendered.replace(/\s+/g, '');
      var compactCode = String(codeText || '').replace(/\s+/g, '');
      if (compactPre && compactCode) {
        var codePos = compactPre.indexOf(compactCode);
        if (codePos > 0) {
          var prefix = compactPre.slice(0, codePos).replace(/(复制|运行)+$/i, '');
          if (/^[A-Za-z0-9.+#_-]{1,30}$/.test(prefix)) {
            return prefix.toLowerCase();
          }
        }
      }
      return '';
    }

    var rawCodeText = getPreformattedText(codeNode || preNode).replace(/\n$/, '');
    if (/\n/.test(rawCodeText)) {
      return {
        language: detectLanguage(rawCodeText),
        codeText: rawCodeText,
      };
    }

    var codeRendered = codeNode && typeof codeNode.innerText === 'string'
      ? String(codeNode.innerText || '').replace(/\r\n?/g, '\n')
      : '';
    if (codeRendered) {
      return {
        language: detectLanguage(codeRendered),
        codeText: codeRendered.replace(/\n$/, ''),
      };
    }

    var codeStartIndex = -1;
    for (var i = 0; i < preLines.length; i++) {
      if (looksLikeCodeLine(preLines[i])) {
        codeStartIndex = i;
        break;
      }
    }

    if (codeStartIndex === -1) {
      return {
        language: detectLanguage(rawCodeText),
        codeText: getPreformattedText(codeNode || preNode).replace(/\n$/, ''),
      };
    }

    return {
      language: detectLanguage(preLines.slice(codeStartIndex).join('\n')),
      codeText: preLines.slice(codeStartIndex).join('\n').replace(/\n$/, ''),
    };
  }

  function buildMarkdownTable(table) {
    var rowNodes = table.querySelectorAll('tr');
    if (!rowNodes.length) return '';

    var rows = [];
    var columnAlignments = [];
    for (var i = 0; i < rowNodes.length; i++) {
      var cellNodes = rowNodes[i].children;
      var cells = [];
      var isHeader = false;
      for (var j = 0; j < cellNodes.length; j++) {
        if (cellNodes[j].tagName !== 'TH' && cellNodes[j].tagName !== 'TD') continue;
        if (cellNodes[j].tagName === 'TH') isHeader = true;
        if (!columnAlignments[j]) {
          var align = cellNodes[j].style && cellNodes[j].style.textAlign ? String(cellNodes[j].style.textAlign).toLowerCase() : '';
          columnAlignments[j] = align;
        }
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

    function formatDivider(index) {
      var align = columnAlignments[index] || '';
      if (align === 'right') return '---:';
      if (align === 'left') return ':---';
      if (align === 'center') return ':---:';
      return '---';
    }

    var header = rows[0].isHeader ? rows[0].cells : new Array(columnCount).fill('');
    var bodyRows = rows[0].isHeader ? rows.slice(1) : rows;
    var lines = [
      formatRow(header),
      formatRow(new Array(columnCount).fill('').map(function (_, index) { return formatDivider(index); })),
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

  function appendStructuredLiteralText(state, text) {
    if (!text) return;
    state.value += String(text);
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

  function collectListItemContent(node, inlineParts, nestedBlocks) {
    if (!node) return;
    if (node.nodeType === Node.TEXT_NODE) {
      appendInlineText(inlineParts, node.nodeValue);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (/^(UL|OL)$/.test(node.tagName)) {
      nestedBlocks.push(node);
      return;
    }
    if (node.tagName === 'P') {
      appendInlineText(inlineParts, getInlineNodeText(node, { lineBreakToken: ' ' }));
      return;
    }
    if (isBlockElement(node)) {
      nestedBlocks.push(node);
      return;
    }
    if (node.tagName === 'BR' || node.tagName === 'CODE' || node.tagName === 'A' || node.tagName === 'IMG') {
      serializeInlineNode(node, inlineParts, { lineBreakToken: ' ' });
      return;
    }
    for (var child = node.firstChild; child; child = child.nextSibling) {
      collectListItemContent(child, inlineParts, nestedBlocks);
    }
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

    if (node.tagName === 'CODE') {
      if ((node.querySelector && node.querySelector('br')) || /\n/.test(getPreformattedText(node))) {
        var blockCodeText = getPreformattedText(node).replace(/\n$/, '');
        var blockFence = getCodeFence(blockCodeText);
        appendStructuredBlock(state, blockFence + '\n' + blockCodeText + '\n' + blockFence);
        return;
      }
      appendStructuredLiteralText(state, formatInlineCode(getRenderedText(node) || node.textContent));
      return;
    }

    if (node.tagName === 'A' || node.tagName === 'IMG') {
      appendStructuredLiteralText(state, getLiteralInlineText(node));
      return;
    }

    if (node.classList && node.classList.contains('katex-display')) {
      appendStructuredBlock(state, normalizeStructuredText(node.textContent || ''));
      return;
    }

    if (node.tagName === 'UL' || node.tagName === 'OL') {
      state.listDepth = (state.listDepth || 0) + 1;
      for (var listNode = node.firstChild; listNode; listNode = listNode.nextSibling) {
        serializeStructuredNode(listNode, state);
      }
      state.listDepth = Math.max(0, (state.listDepth || 1) - 1);
      return;
    }

    if (node.tagName === 'LI') {
      appendStructuredLineBreak(state);
      var indent = '';
      if (state.listDepth > 1) {
        indent = new Array(getNestedListIndent(node) + 1).join(' ');
      }
      if (indent) state.value += indent;
      var itemIndex = 0;
      for (var sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        if (sibling.tagName === 'LI') itemIndex++;
      }
      var taskCheckbox = node.querySelector ? node.querySelector('input[type="checkbox"], input') : null;
      if (taskCheckbox && taskCheckbox.tagName === 'INPUT') {
        appendStructuredText(state, '- [' + (taskCheckbox.checked ? 'x' : ' ') + '] ');
      } else if (node.parentElement && node.parentElement.tagName === 'OL') {
        var start = parseInt(getAttributeValue(node.parentElement, 'start') || '1', 10);
        appendStructuredText(state, (isNaN(start) ? 1 : start) + itemIndex + '. ');
      } else {
        appendStructuredText(state, '- ');
      }
      var inlineParts = [];
      var nestedBlocks = [];
      for (var listChild = node.firstChild; listChild; listChild = listChild.nextSibling) {
        collectListItemContent(listChild, inlineParts, nestedBlocks);
      }
      if (inlineParts.length) appendStructuredText(state, inlineParts.join('').trim());
      for (var nestedIndex = 0; nestedIndex < nestedBlocks.length; nestedIndex++) {
        serializeStructuredNode(nestedBlocks[nestedIndex], state);
      }
      appendStructuredLineBreak(state);
      return;
    }

    if (/^H[1-6]$/.test(node.tagName)) {
      appendStructuredBlock(state, new Array(parseInt(node.tagName.charAt(1), 10) + 1).join('#') + ' ' + getStructuredText(node, false));
      return;
    }

    if (node.tagName === 'BLOCKQUOTE') {
      var quoteParts = [];
      for (var quoteChild = node.firstChild; quoteChild; quoteChild = quoteChild.nextSibling) {
        var quotePart = getStructuredText(quoteChild, true);
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

    if (node.tagName === 'SECTION' && node.querySelector && node.querySelector('ol > li[id^="user-content-fn-"]')) {
      var footnoteItems = node.querySelectorAll('ol > li[id^="user-content-fn-"]');
      var footnoteLines = [];
      for (var footnoteIndex = 0; footnoteIndex < footnoteItems.length; footnoteIndex++) {
        var footnoteItem = footnoteItems[footnoteIndex];
        var footnoteId = getAttributeValue(footnoteItem, 'id').replace(/^user-content-fn-/, '') || String(footnoteIndex + 1);
        var footnoteParagraph = footnoteItem.querySelector('p') || footnoteItem;
        footnoteLines.push('[^' + footnoteId + ']: ' + getInlineNodeText(footnoteParagraph, { lineBreakToken: ' ' }).trim());
      }
      appendStructuredBlock(state, footnoteLines.join('\n'));
      return;
    }

    if (node.tagName === 'PRE') {
      var codeChild = node.querySelector ? node.querySelector('code') : null;
      if (codeChild) {
        var codeBlock = extractPreformattedCodeBlock(node, codeChild);
        var codeText = codeBlock.codeText;
        var language = codeBlock.language;
        var fence = getCodeFence(codeText);
        appendStructuredBlock(state, fence + language + '\n' + codeText + '\n' + fence);
      } else {
        appendStructuredLineBreak(state);
        state.value += getRenderedText(node).replace(/\n$/, '');
        appendStructuredLineBreak(state);
      }
      return;
    }

    if (getAttributeValue(node, 'data-testid') === 'code_block' && node.querySelector) {
      var nestedPre = node.querySelector('pre');
      if (nestedPre) {
        serializeStructuredNode(nestedPre, state);
        return;
      }
    }

    if (node.tagName === 'P') {
      var renderedParagraph = getLiteralInlineText(node).replace(/\r\n?/g, '\n').trim();
      if (/^>\s?/m.test(renderedParagraph)) {
        appendStructuredBlock(state, renderedParagraph);
        return;
      }
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
    var state = { value: '' };
    serializeStructuredNode(fragment, state);
    return finalizeStructuredValue(state.value);
  }

  function rehydrateClonedLinks(fragment, sourceRoot) {
    if (!fragment || !fragment.querySelectorAll || !sourceRoot || !sourceRoot.querySelectorAll) return;
    var sourceAnchors = sourceRoot.querySelectorAll('a[href]');
    var exactLookup = {};
    var textLookup = {};
    for (var i = 0; i < sourceAnchors.length; i++) {
      var sourceAnchor = sourceAnchors[i];
      var sourceText = normalizeStructuredText(getRenderedText(sourceAnchor) || sourceAnchor.textContent || '').trim();
      var sourceHref = getAttributeValue(sourceAnchor, 'href');
      if (!sourceText || !sourceHref) continue;
      var sourceKey = [
        getAttributeValue(sourceAnchor, 'data-start'),
        getAttributeValue(sourceAnchor, 'data-end'),
        sourceText,
      ].join('|');
      exactLookup[sourceKey] = sourceHref;
      if (!textLookup[sourceText]) textLookup[sourceText] = sourceHref;
    }

    var clonedAnchors = fragment.querySelectorAll('a');
    for (var j = 0; j < clonedAnchors.length; j++) {
      var clonedAnchor = clonedAnchors[j];
      if (getAttributeValue(clonedAnchor, 'href')) continue;
      var clonedText = normalizeStructuredText(getRenderedText(clonedAnchor) || clonedAnchor.textContent || '').trim();
      if (!clonedText) continue;
      var clonedKey = [
        getAttributeValue(clonedAnchor, 'data-start'),
        getAttributeValue(clonedAnchor, 'data-end'),
        clonedText,
      ].join('|');
      var matchedHref = exactLookup[clonedKey] || textLookup[clonedText] || '';
      if (matchedHref) {
        clonedAnchor.setAttribute('href', matchedHref);
      }
    }
  }

  function restoreMarkdownLinksFromFragmentText(text, fragment) {
    if (!text || !fragment || !fragment.querySelectorAll) return text;
    var anchors = fragment.querySelectorAll('a');
    var seen = [];
    var result = text;
    for (var i = 0; i < anchors.length; i++) {
      var anchor = anchors[i];
      if (hasAttributeValue(anchor, 'data-footnote-ref') || hasAttributeValue(anchor, 'data-footnote-backref')) continue;
      var container = anchor.closest ? anchor.closest('p, li, td, th, blockquote') : anchor.parentElement;
      if (!container || seen.indexOf(container) >= 0) continue;
      seen.push(container);
      var markdownLine = getInlineNodeText(container, { lineBreakToken: ' ' }).trim();
      if (!/\]\([^)]+\)/.test(markdownLine)) continue;
      var plainLine = normalizeStructuredText(getRenderedText(container) || container.textContent || '').trim();
      if (!plainLine || plainLine === markdownLine) continue;
      result = result.replace(plainLine, markdownLine);
    }
    return result;
  }

  function restoreMarkdownLinksFromSourceText(text, sourceRoot) {
    if (!text || !sourceRoot || !sourceRoot.querySelectorAll) return text;
    var anchors = sourceRoot.querySelectorAll('a[href]');
    var seen = [];
    var result = text;
    for (var i = 0; i < anchors.length; i++) {
      var anchor = anchors[i];
      if (hasAttributeValue(anchor, 'data-footnote-ref') || hasAttributeValue(anchor, 'data-footnote-backref')) continue;
      var container = anchor.closest ? anchor.closest('p, li, td, th, blockquote') : anchor.parentElement;
      if (!container || seen.indexOf(container) >= 0) continue;
      seen.push(container);
      var markdownLine = getInlineNodeText(container, { lineBreakToken: ' ' }).trim();
      if (!/\]\([^)]+\)/.test(markdownLine)) continue;
      var plainLine = normalizeStructuredText(getRenderedText(container) || container.textContent || '').trim();
      if (!plainLine || plainLine === markdownLine) continue;
      result = result.replace(plainLine, markdownLine);
    }
    return result;
  }

  function setCopyMarker(name, text) {
    if (!name || !text) return;
    try {
      document.documentElement.setAttribute(name, text);
      document.documentElement.setAttribute(name + '-length', String(text.length));
    } catch (error) {}
  }

  function buildStructuredCopyText(contentRoot, sourceRoot) {
    if (!contentRoot || !contentRoot.cloneNode) return '';
    var fragment = document.createDocumentFragment();
    fragment.appendChild(contentRoot.cloneNode(true));
    rehydrateClonedLinks(fragment, sourceRoot || contentRoot);
    extractLatexFromFragment(fragment);
    var text = serializeStructuredFragment(fragment) || cleanText(fragment.textContent || '');
    text = restoreMarkdownLinksFromFragmentText(text, fragment);
    text = restoreMarkdownLinksFromSourceText(text, contentRoot);
    if (sourceRoot && sourceRoot !== contentRoot) {
      text = restoreMarkdownLinksFromSourceText(text, sourceRoot);
    }
    return restoreMarkdownLinksFromSourceText(text, document);
  }

  function normalizeTikaCopiedMarkdown(text) {
    var parts = String(text || '').split(/(```[\s\S]*?```)/g);
    for (var i = 0; i < parts.length; i += 2) {
      parts[i] = parts[i].replace(/^(#{2,6})(\s)/gm, function (_, hashes, suffix) {
        return hashes.slice(1) + suffix;
      });
    }
    return parts.join('');
  }

  function copyTextWithMarker(text, markerName) {
    if (!text) return Promise.resolve('');
    var normalizedText = normalizeStructuredMarkdownForPaste(text);
    return withClipboardCleanBypass(function () {
      return navigator.clipboard.writeText(normalizedText);
    }).then(function () {
      setCopyMarker(markerName, normalizedText);
      return normalizedText;
    }).catch(function () {
      return '';
    });
  }

  function copyStructuredContentRoot(contentRoot, sourceRoot, markerName) {
    var text = buildStructuredCopyText(contentRoot, sourceRoot);
    return copyTextWithMarker(text, markerName);
  }

  // #region debug-point A:reporter
  function reportSelectionCopyDebug(hypothesisId, location, msg, data) {
    if (typeof fetch !== 'function') return;
    fetch('http://127.0.0.1:7777/event', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: 'selection-copy-regression',
        runId: 'post-fix',
        hypothesisId: hypothesisId,
        location: location,
        msg: '[DEBUG] ' + msg,
        data: data || {},
        ts: Date.now(),
      }),
    }).catch(function () {});
  }
  // #endregion

  function hasStructuredFragmentContent(fragment) {
    return !!(fragment && fragment.querySelector && fragment.querySelector('*'));
  }

  function getNestedListIndent(node) {
    var indent = 0;
    var currentList = node && node.parentElement;
    while (currentList && (currentList.tagName === 'UL' || currentList.tagName === 'OL')) {
      var parentItem = currentList.parentElement;
      if (!parentItem || parentItem.tagName !== 'LI') break;
      var containerList = parentItem.parentElement;
      if (!containerList || (containerList.tagName !== 'UL' && containerList.tagName !== 'OL')) break;
      indent += containerList.tagName === 'OL' ? 4 : 2;
      currentList = containerList;
    }
    return indent;
  }

  function extractFragmentText(fragment, baseText) {
    if (!fragment) return '';
    if (hasStructuredFragmentContent(fragment)) {
      return serializeStructuredFragment(fragment);
    }
    return typeof baseText === 'string' ? baseText : fragment.textContent;
  }

  function buildClipboardPayloadFromSelection(selection) {
    if (!selection || selection.isCollapsed) return null;

    var rawText = selection.toString();
    // #region debug-point A:selection-entry
    reportSelectionCopyDebug('A', 'copy-cleaner.user.js:1061', 'selection payload entry', {
      rawTextLength: rawText ? rawText.length : 0,
      rangeCount: selection.rangeCount || 0,
      isCollapsed: !!selection.isCollapsed,
    });
    // #endregion
    if (selection.rangeCount) {
      var range = selection.getRangeAt(0).cloneRange();
      var startElement = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
      var startKatex = startElement && startElement.closest('.katex');
      if (startKatex) range.setStartBefore(startKatex);
      var endElement = range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement;
      var endKatex = endElement && endElement.closest('.katex');
      if (endKatex) range.setEndAfter(endKatex);

      var fragment = range.cloneContents();
      var hasMath = fragment.querySelector('.katex') ||
        fragment.querySelector('mjx-container') ||
        fragment.querySelector('[data-latex]') ||
        fragment.querySelector('[data-latex-display]');
      var hasStructured = hasStructuredFragmentContent(fragment);
      // #region debug-point B:fragment-shape
      reportSelectionCopyDebug('B', 'copy-cleaner.user.js:1076', 'selection fragment shape', {
        hasMath: !!hasMath,
        hasStructured: !!hasStructured,
        fragmentTextLength: fragment && typeof fragment.textContent === 'string' ? fragment.textContent.length : 0,
      });
      // #endregion
      if (hasMath) {
        extractLatexFromFragment(fragment);
        var mathText = extractFragmentText(fragment, fragment.textContent);
        // #region debug-point C:math-branch
        reportSelectionCopyDebug('C', 'copy-cleaner.user.js:1080', 'selection math branch', {
          structured: !!hasStructured,
          resultPreview: String(hasStructured ? mathText : cleanText(mathText)).slice(0, 200),
        });
        // #endregion
        return { text: hasStructured ? mathText : cleanText(mathText) };
      }
      if (hasStructured) {
        var structuredText = extractFragmentText(fragment, rawText);
        // #region debug-point D:structured-branch
        reportSelectionCopyDebug('D', 'copy-cleaner.user.js:1086', 'selection structured branch', {
          changed: structuredText !== rawText,
          resultPreview: String(structuredText || '').slice(0, 200),
        });
        // #endregion
        return structuredText !== rawText ? { text: structuredText } : null;
      }
    }

    if (!rawText) return null;
    var cleanedText = cleanText(rawText);
    // #region debug-point E:plain-branch
    reportSelectionCopyDebug('E', 'copy-cleaner.user.js:1090', 'selection plain branch', {
      changed: cleanedText !== rawText,
      resultPreview: String(cleanedText || '').slice(0, 200),
    });
    // #endregion
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
          if (shouldBypassClipboardClean) {
            return originalWriteText.call(this, text);
          }
          return originalWriteText.call(this, normalizeClipboardText(text));
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
          var newItems = [];
          for (var item of items) {
            var newItem = {};
            for (var type of item.types) {
              if (type === 'text/plain') {
                newItem[type] = item.getType(type).then(function (blob) {
                  return blob.text();
                }).then(function (text) {
                  if (shouldBypassClipboardClean) {
                    return new Blob([text], { type: 'text/plain' });
                  }
                  return new Blob([normalizeClipboardText(text)], { type: 'text/plain' });
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
    // #region debug-point F:on-copy
    reportSelectionCopyDebug('F', 'copy-cleaner.user.js:1165', 'onCopy observed', {
      intercepted: !!(payload && e.clipboardData),
      hasClipboardData: !!(e && e.clipboardData),
      payloadPreview: payload && payload.text ? String(payload.text).slice(0, 200) : '',
    });
    // #endregion
    if (!payload || !e.clipboardData) return;

    e.preventDefault();
    e.stopImmediatePropagation();
    e.clipboardData.setData('text/plain', normalizeClipboardText(payload.text));
  }

  function onKeydown(e) {
    var isCopy = (e.ctrlKey || e.metaKey) && e.key === 'c';
    if (!isCopy) return;

    var payload = buildClipboardPayloadFromSelection(window.getSelection());
    // #region debug-point G:on-keydown
    reportSelectionCopyDebug('G', 'copy-cleaner.user.js:1178', 'onKeydown observed', {
      intercepted: payload !== null,
      hasClipboardWriteText: !!(navigator.clipboard && navigator.clipboard.writeText),
      payloadPreview: payload && payload.text ? String(payload.text).slice(0, 200) : '',
    });
    // #endregion
    if (payload === null) return;

    e.preventDefault();
    e.stopImmediatePropagation();

    if (navigator.clipboard && navigator.clipboard.writeText) {
      withClipboardCleanBypass(function () {
        return navigator.clipboard.writeText(payload.text);
      }).catch(function () {});
    }
  }

  function onChatGptCopyButtonClick(e) {
    if (!e.target || !e.target.closest || !/https:\/\/chatgpt\.com\//.test(String(window.location && window.location.href || ''))) {
      return;
    }
    var button = e.target.closest('button[data-testid="copy-turn-action-button"]');
    if (!button) return;
    var turn = button.closest('[data-turn], [data-testid^="conversation-turn-"]');
    var dataTurn = turn ? String(turn.getAttribute('data-turn') || '') : '';
    var ariaLabel = String(button.getAttribute('aria-label') || '');
    if (dataTurn !== 'assistant' && !/复制回复|copy response/i.test(ariaLabel)) return;
    if (!turn || !turn.querySelector) return;

    e.preventDefault();
    e.stopImmediatePropagation();

    function finalizeCopy(attempt) {
      var contentRoot = turn.querySelector('[data-message-author-role="assistant"] .markdown')
        || turn.querySelector('[data-message-author-role="assistant"]')
        || turn;
      if (!contentRoot || !contentRoot.cloneNode) return;
      var text = buildStructuredCopyText(contentRoot, turn);
      var hasPendingDecoratedLinks = !!turn.querySelector('a.decorated-link:not([href])');
      if (hasPendingDecoratedLinks && attempt < 5 && !/\]\([^)]+\)/.test(text)) {
        setTimeout(function () {
          finalizeCopy(attempt + 1);
        }, 50);
        return;
      }
      if (!text) return;
      copyStructuredContentRoot(contentRoot, turn, 'data-copy-cleaner-chatgpt-copy');
    }

    setTimeout(function () {
      finalizeCopy(0);
    }, 0);
  }

  function onTikaCopyButtonClick(e) {
    if (!e.target || !e.target.closest || !/https:\/\/tika\.byteintl\.net\//.test(String(window.location && window.location.href || ''))) {
      return;
    }
    var button = e.target.closest('button');
    if (!button || !button.querySelector || !button.querySelector('.i-icon-copy')) return;
    var toolbar = button.closest('.pt-2.flex.items-center');
    if (!toolbar) return;
    var answerRoot = toolbar.closest('.chat-answer-area');
    if (!answerRoot) return;

    e.preventDefault();
    e.stopImmediatePropagation();

    setTimeout(function () {
      copyTextWithMarker(
        normalizeTikaCopiedMarkdown(buildStructuredCopyText(answerRoot, answerRoot)),
        'data-copy-cleaner-tika-copy'
      );
    }, 0);
  }

  window.addEventListener('copy', onCopy, true);
  window.addEventListener('keydown', onKeydown, true);
  window.addEventListener('click', onChatGptCopyButtonClick, true);
  window.addEventListener('click', onTikaCopyButtonClick, true);
})();
