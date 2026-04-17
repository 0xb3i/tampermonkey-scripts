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

  function cleanText(text) {
    var parts = splitByLatex(text);
    var cleaned = parts.map(function (part) {
      if (part.latex) return part.text;
      return cleanPlainText(part.text, false);
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

  function cleanPlainText(text, isStandalone) {
    if (typeof isStandalone === 'undefined') isStandalone = true;
    var result = text;

    result = result.replace(/\*\*/g, '');

    while (/（[^（）]*）/.test(result)) {
      result = result.replace(/（[^（）]*）/g, '');
    }

    result = result.replace(/["\u201C\u201D]/g, '');
    result = result.replace(/['\u2018\u2019]/g, '');

    result = result.replace(/  +/g, ' ');
    result = result.replace(/\n{3,}/g, '\n\n');

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

  function extractTextWithLatex(selection) {
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

    return fragment.textContent;
  }

  window.__copyCleanerExtractLatex = extractTextWithLatex;

  function getCleanedText() {
    var selection = window.getSelection();
    if (!selection || selection.isCollapsed) return null;

    var latexText = extractTextWithLatex(selection);
    if (latexText !== null) {
      return cleanText(latexText);
    }

    var originalText = selection.toString();
    if (!originalText) return null;

    var cleaned = cleanText(originalText);
    if (cleaned !== originalText) {
      return cleaned;
    }

    return null;
  }

  function patchClipboardAPI() {
    if (typeof Clipboard === 'undefined' || !Clipboard.prototype) return;

    if (Clipboard.prototype.writeText) {
      const originalWriteText = Clipboard.prototype.writeText;
      Object.defineProperty(Clipboard.prototype, 'writeText', {
        value: function (text) {
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

  document.addEventListener('copy', function (e) {
    var selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;

    var latexText = extractTextWithLatex(selection);
    if (latexText !== null) {
      e.preventDefault();
      e.stopImmediatePropagation();
      e.clipboardData.setData('text/plain', cleanText(latexText));
      return;
    }

    var originalText = selection.toString();
    if (!originalText) return;

    var cleanedText = cleanText(originalText);

    if (cleanedText !== originalText) {
      e.preventDefault();
      e.stopImmediatePropagation();
      e.clipboardData.setData('text/plain', cleanedText);
    }
  }, true);

  document.addEventListener('keydown', function (e) {
    var isCopy = (e.ctrlKey || e.metaKey) && e.key === 'c';
    if (!isCopy) return;

    var cleaned = getCleanedText();
    if (cleaned === null) return;

    e.preventDefault();
    e.stopImmediatePropagation();

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(cleaned).catch(function () {});
    }
  }, true);
})();
