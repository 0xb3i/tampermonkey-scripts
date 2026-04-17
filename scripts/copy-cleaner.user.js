// ==UserScript==
// @name         复制净化器
// @namespace    https://github.com/tampermonkey-scripts
// @version      3.0.0
// @description  复制时自动去除加粗标记(**)和括号注释(（）及内容)，兼容网站自带复制按钮
// @author       You
// @match        *://*/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  function cleanText(text) {
    let result = text;

    result = result.replace(/\*\*/g, '');

    while (/（[^（）]*）/.test(result)) {
      result = result.replace(/（[^（）]*）/g, '');
    }
    while (/\([^()]*\)/.test(result)) {
      result = result.replace(/\([^()]*\)/g, '');
    }

    result = result.replace(/  +/g, ' ');
    result = result.replace(/\n{3,}/g, '\n\n');

    result = result.replace(/^ +| +$/gm, '');

    return result.trim();
  }

  window.__copyCleanerCleanText = cleanText;

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

  function patchExecCommand() {
    const originalExecCommand = Document.prototype.execCommand;
    Document.prototype.execCommand = function (command) {
      if (command === 'copy') {
        const selection = window.getSelection();
        if (selection && !selection.isCollapsed) {
          const originalText = selection.toString();
          if (originalText) {
            const cleaned = cleanText(originalText);
            if (cleaned !== originalText) {
              try {
                navigator.clipboard.writeText(cleaned);
              } catch (_) {}
              return true;
            }
          }
        }
      }
      return originalExecCommand.apply(this, arguments);
    };
  }

  patchExecCommand();

  document.addEventListener('copy', function (e) {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;

    const originalText = selection.toString();
    if (!originalText) return;

    const cleanedText = cleanText(originalText);

    if (cleanedText !== originalText) {
      e.preventDefault();
      e.clipboardData.setData('text/plain', cleanedText);
    }
  }, true);
})();
