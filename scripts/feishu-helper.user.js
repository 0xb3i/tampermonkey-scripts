// ==UserScript==
// @name         飞书文档助手
// @namespace    https://github.com/tampermonkey-scripts
// @version      2.0.0
// @description  解除飞书文档复制限制，批量提取文档图片，创建文档副本
// @author       You
// @match        https://*.feishu.cn/*
// @match        https://*.larksuite.com/*
// @match        https://*.larkoffice.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  var EVENTS = ['copy', 'cut', 'contextmenu', 'keydown', 'keyup'];
  var STYLE_CSS = '*{user-select:text!important;-webkit-user-select:text!important}';

  var installed = new WeakSet();

  function install(win) {
    if (installed.has(win)) return;
    installed.add(win);

    try {
      var doc = win.document;

      if (!doc.getElementById('__feishu_freecopy_style__')) {
        var s = doc.createElement('style');
        s.id = '__feishu_freecopy_style__';
        s.textContent = STYLE_CSS;
        (doc.head || doc.documentElement).appendChild(s);
      }

      var handler = function (e) {
        if (e.type === 'keydown' || e.type === 'keyup') {
          var k = (e.key || '').toLowerCase();
          var ctrlLike = e.ctrlKey || e.metaKey;
          if (!(ctrlLike && (k === 'c' || k === 'a' || k === 'x' || k === 'v'))) return;
        }
        e.stopImmediatePropagation();
      };

      [win, doc, doc.documentElement, doc.body].forEach(function (t) {
        if (!t || !t.addEventListener) return;
        EVENTS.forEach(function (ev) {
          t.addEventListener(ev, handler, true);
        });
      });

      removeOverlays(win);
    } catch (_) {}
  }

  function removeOverlays(win) {
    try {
      var doc = win.document;
      doc.querySelectorAll('*').forEach(function (el) {
        var cs = win.getComputedStyle(el);
        if ((cs.position === 'fixed' || cs.position === 'absolute') && parseFloat(cs.opacity) === 0 && cs.pointerEvents !== 'none') {
          el.style.display = 'none';
        }
      });
    } catch (_) {}
  }

  function startFreeCopy() {
    install(window);

    var t0 = performance.now();
    (function loop() {
      try {
        window.document.querySelectorAll('iframe').forEach(function (f) {
          try { if (f.contentWindow && f.contentDocument) install(f.contentWindow); } catch (_) {}
        });
      } catch (_) {}
      if (performance.now() - t0 < 15000) requestAnimationFrame(loop);
    })();
  }

  if (document.body) {
    startFreeCopy();
  } else {
    document.addEventListener('DOMContentLoaded', startFreeCopy);
  }

  function getBaseUrl() {
    return location.origin;
  }

  function getDocToken() {
    var match = location.pathname.match(/\/(docx|wiki|doc|sheet|slides|base)\/([A-Za-z0-9]+)/);
    return match ? match[2] : null;
  }

  function getCsrfToken() {
    var match = document.cookie.match(/_csrf_token=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  }

  function getDocContent() {
    var contentEl = document.querySelector('[data-content-editable-root="true"]') ||
                    document.querySelector('.doc-content') ||
                    document.querySelector('.docx-container') ||
                    document.querySelector('[class*="doc-content"]') ||
                    document.querySelector('[class*="editor"]');

    if (!contentEl) return null;

    annotateKatexInPlace(contentEl);

    var clone = contentEl.cloneNode(true);
    clone.querySelectorAll('script, style').forEach(function (el) { el.remove(); });
    clone.querySelectorAll('[contenteditable]').forEach(function (el) { el.removeAttribute('contenteditable'); });

    replaceKatexInFragment(clone);

    clone.querySelectorAll('[class]').forEach(function (el) {
      var keep = [];
      el.classList.forEach(function (c) {
        if (/image|img|table|code-block|heading|list|quote/.test(c)) keep.push(c);
      });
      el.className = keep.join(' ');
    });

    return {
      html: clone.innerHTML,
      text: clone.innerText,
    };
  }

  function annotateKatexInPlace(root) {
    var katexEls = root.querySelectorAll('.katex:not([data-latex]):not([data-latex-display])');
    for (var i = 0; i < katexEls.length; i++) {
      var el = katexEls[i];
      var ann = el.querySelector('.katex-mathml annotation');
      if (ann) {
        var isDisplay = el.closest('.katex-display') !== null;
        el.setAttribute(isDisplay ? 'data-latex-display' : 'data-latex', ann.textContent);
      }
    }
  }

  function replaceKatexInFragment(fragment) {
    var katexEls = fragment.querySelectorAll('.katex');
    for (var i = 0; i < katexEls.length; i++) {
      var el = katexEls[i];
      var latex = null;
      var isDisplay = false;

      if (el.hasAttribute('data-latex-display')) {
        latex = el.getAttribute('data-latex-display');
        isDisplay = true;
      } else if (el.hasAttribute('data-latex')) {
        latex = el.getAttribute('data-latex');
      } else {
        var ann = el.querySelector('.katex-mathml annotation');
        if (ann) {
          latex = ann.textContent;
          isDisplay = el.closest('.katex-display') !== null;
        }
      }

      if (latex !== null) {
        var delimiters = isDisplay ? ['$$', '$$'] : [' $', '$ '];
        var tex = delimiters[0] + latex + delimiters[1];
        var textNode = document.createTextNode(tex);
        if (el.replaceWith) { el.replaceWith(textNode); }
        else if (el.parentNode) { el.parentNode.replaceChild(textNode, el); }
      }
    }

    var mjxEls = fragment.querySelectorAll('mjx-container');
    for (var j = 0; j < mjxEls.length; j++) {
      var mjx = mjxEls[j];
      var mathEl = mjx.querySelector('math');
      if (mathEl) {
        var ann2 = mathEl.querySelector('annotation');
        if (ann2) {
          var isDisplay2 = mjx.getAttribute('display') === 'true' || mjx.hasAttribute('display');
          var delimiters2 = isDisplay2 ? ['$$', '$$'] : [' $', '$ '];
          var tex2 = delimiters2[0] + ann2.textContent + delimiters2[1];
          var textNode2 = document.createTextNode(tex2);
          if (mjx.replaceWith) { mjx.replaceWith(textNode2); }
          else if (mjx.parentNode) { mjx.parentNode.replaceChild(textNode2, mjx); }
        }
      }
    }
  }

  function scrollAndExtract(callback) {
    var scrollEl = document.querySelector('[class*="scroll-container"]') ||
                   document.querySelector('[class*="doc-scroll"]') ||
                   document.querySelector('.wiki-content') ||
                   document.scrollingElement ||
                   document.documentElement;

    var btn = document.getElementById('__feishu_duplicate_btn__');
    if (btn) btn.textContent = '滚动加载中...';

    var scrollHeight = scrollEl.scrollHeight;
    var currentPos = 0;
    var scrollStep = 800;
    var stableCount = 0;

    function doScroll() {
      currentPos += scrollStep;
      scrollEl.scrollTo({ top: currentPos, behavior: 'auto' });
      window.scrollTo(0, currentPos);

      var newHeight = scrollEl.scrollHeight;
      if (newHeight > scrollHeight) {
        scrollHeight = newHeight;
        stableCount = 0;
      } else {
        stableCount++;
      }

      if (currentPos < scrollHeight - window.innerHeight && stableCount < 5) {
        setTimeout(doScroll, 100);
      } else {
        scrollEl.scrollTo({ top: 0, behavior: 'auto' });
        window.scrollTo(0, 0);
        setTimeout(function () {
          var content = getDocContent();
          if (btn) btn.textContent = '创建副本';
          callback(content);
        }, 500);
      }
    }

    doScroll();
  }

  function getPendingPaste() {
    try {
      var data = localStorage.getItem('__feishu_pending_paste__');
      if (!data) return null;
      var parsed = JSON.parse(data);
      if (parsed && parsed.ts && Date.now() - parsed.ts < 3600000) return parsed;
      localStorage.removeItem('__feishu_pending_paste__');
      return null;
    } catch (_) { return null; }
  }

  function setPendingPaste(data) {
    try {
      data.ts = Date.now();
      localStorage.setItem('__feishu_pending_paste__', JSON.stringify(data));
    } catch (_) {}
  }

  function duplicateDocument() {
    var token = getDocToken();
    if (!token) {
      alert('无法识别当前文档，请确保在飞书文档页面使用此功能');
      return;
    }

    scrollAndExtract(function (content) {
      if (!content) {
        alert('无法提取文档内容');
        return;
      }

      var title = document.querySelector('title');
      var docTitle = title ? title.textContent.replace(/ - 飞书云文档$/, '').replace(/ - Lark$/, '') : '副本';

      setPendingPaste({ html: content.html, text: content.text, title: docTitle });

      showNotice(
        '✅',
        '文档内容已提取',
        '接下来请：<br>' +
        '1. 手动新建一个飞书文档<br>' +
        '2. 打开空白文档<br>' +
        '3. 点击右下角绿色的 <b>粘贴副本</b> 按钮<br><br>' +
        '内容会在新文档页面写入剪贴板，然后按 Cmd+V 粘贴即可'
      );
    });
  }

  function pasteIntoDoc() {
    var pendingPaste = getPendingPaste();
    if (!pendingPaste) {
      alert('请先在源文档页面点击"创建副本"');
      return;
    }

    var content = pendingPaste;
    var html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + content.title + '</title></head><body>' + content.html + '</body></html>';

    var blob = new Blob([html], { type: 'text/html' });
    var clipboardItem = new ClipboardItem({
      'text/html': blob,
      'text/plain': new Blob([content.text], { type: 'text/plain' }),
    });

    navigator.clipboard.write([clipboardItem]).then(function () {
      showNotice(
        '📋',
        '内容已写入剪贴板',
        '请按 <kbd style="background:#f0f0f0;padding:2px 6px;border-radius:4px;border:1px solid #ccc;">Cmd+V</kbd> 粘贴到文档中'
      );
    }).catch(function () {
      showNotice(
        '⚠️',
        '写入剪贴板失败',
        '请手动复制：全选下方内容 → Cmd+C → 切换到文档 → Cmd+V'
      );
    });
  }

  function showNotice(icon, title, message) {
    var existing = document.getElementById('__feishu_notice__');
    if (existing) existing.remove();

    var notice = document.createElement('div');
    notice.id = '__feishu_notice__';
    notice.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#fff;padding:24px 32px;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,0.2);z-index:9999999;text-align:center;max-width:420px;';
    notice.innerHTML =
      '<div style="font-size:24px;margin-bottom:8px;">' + icon + '</div>' +
      '<div style="font-size:16px;font-weight:bold;margin-bottom:8px;">' + title + '</div>' +
      '<div style="font-size:14px;color:#666;margin-bottom:16px;text-align:left;line-height:1.8;">' + message + '</div>' +
      '<button id="__feishu_notice_close__" style="background:#3370ff;color:#fff;border:none;padding:8px 24px;border-radius:6px;cursor:pointer;font-size:14px;">知道了</button>';
    document.body.appendChild(notice);

    document.getElementById('__feishu_notice_close__').addEventListener('click', function (e) {
      e.stopPropagation();
      notice.remove();
    });
  }

  function downloadAsHTML(docTitle, content) {
    var html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + docTitle + ' (副本)</title>' +
      '<style>body{font-family:-apple-system,sans-serif;max-width:800px;margin:40px auto;padding:0 20px;line-height:1.8;}img{max-width:100%;}table{border-collapse:collapse;width:100%;}td,th{border:1px solid #ddd;padding:8px;}pre{background:#f5f5f5;padding:12px;border-radius:6px;overflow-x:auto;}code{background:#f0f0f0;padding:2px 4px;border-radius:3px;}</style>' +
      '</head><body>' + content.html + '</body></html>';

    var blob = new Blob([html], { type: 'text/html' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = docTitle + '_副本.html';
    a.click();
    URL.revokeObjectURL(url);

    alert('已导出为 HTML 文件（飞书编辑器支持直接粘贴 HTML）。\n\n操作步骤：\n1. 打开一个新的飞书文档\n2. 用浏览器打开导出的 HTML 文件\n3. 全选复制 → 粘贴到飞书文档');
  }

  function createFloatingButton() {
    if (document.getElementById('__feishu_toolbar__')) return;

    var container = document.createElement('div');
    container.id = '__feishu_toolbar__';
    container.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:999998;display:flex;flex-direction:column;gap:8px;';

    if (getPendingPaste()) {
      var pasteBtn = document.createElement('button');
      pasteBtn.id = '__feishu_paste_btn__';
      pasteBtn.textContent = '粘贴副本';
      pasteBtn.style.cssText = 'background:#00b578;color:#fff;border:none;padding:10px 16px;border-radius:8px;cursor:pointer;font-size:14px;box-shadow:0 2px 8px rgba(0,0,0,0.2);white-space:nowrap;';
      pasteBtn.onclick = pasteIntoDoc;
      container.appendChild(pasteBtn);
    }

    if (getDocToken()) {
      var dupBtn = document.createElement('button');
      dupBtn.id = '__feishu_duplicate_btn__';
      dupBtn.textContent = '创建副本';
      dupBtn.style.cssText = 'background:#3370ff;color:#fff;border:none;padding:10px 16px;border-radius:8px;cursor:pointer;font-size:14px;box-shadow:0 2px 8px rgba(0,0,0,0.2);white-space:nowrap;';
      dupBtn.onclick = duplicateDocument;
      container.appendChild(dupBtn);
    }

    var imgBtn = document.createElement('button');
    imgBtn.id = '__feishu_img_btn__';
    imgBtn.textContent = '提取图片';
    imgBtn.style.cssText = 'background:#fff;color:#333;border:1px solid #ddd;padding:10px 16px;border-radius:8px;cursor:pointer;font-size:14px;box-shadow:0 2px 8px rgba(0,0,0,0.1);white-space:nowrap;';
    imgBtn.onclick = function () {
      var images = extractImages();
      if (images.length === 0) {
        alert('当前页面未找到图片');
      } else {
        createImagePanel(images);
      }
    };

    container.appendChild(dupBtn);
    container.appendChild(imgBtn);
    document.body.appendChild(container);
  }

  document.addEventListener('DOMContentLoaded', function () {
    function tryCreateButton() {
      if (!document.getElementById('__feishu_toolbar__') && document.body) {
        createFloatingButton();
      }
    }
    setTimeout(tryCreateButton, 2000);
    setTimeout(tryCreateButton, 5000);
    setTimeout(tryCreateButton, 10000);
  });

  var lastUrl = location.href;
  setInterval(function () {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      var existing = document.getElementById('__feishu_toolbar__');
      if (existing) existing.remove();
      setTimeout(createFloatingButton, 1500);
    }
  }, 1000);

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
      var style = el.style.backgroundImage || '';
      var match = style.match(/url\(["']?([^"')]+)["']?\)/);
      if (match && match[1] && !seen.has(match[1])) {
        seen.add(match[1]);
        images.push({
          src: match[1],
          alt: '',
          width: el.offsetWidth,
          height: el.offsetHeight,
        });
      }
    });

    document.querySelectorAll('image').forEach(function (img) {
      var href = img.getAttribute('href') || img.getAttribute('xlink:href');
      if (href && !seen.has(href)) {
        seen.add(href);
        images.push({
          src: href,
          alt: '',
          width: 0,
          height: 0,
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
            '<h3 style="margin:0;font-size:18px;">飞书文档图片提取 (' + images.length + ' 张)</h3>' +
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

  document.addEventListener('keydown', function (e) {
    if (e.metaKey && e.shiftKey && e.key.toLowerCase() === 'i') {
      e.preventDefault();
      e.stopImmediatePropagation();
      var images = extractImages();
      if (images.length === 0) {
        alert('当前页面未找到图片');
      } else {
        createImagePanel(images);
      }
    }
  }, true);

  window.__feishuExtractImages = extractImages;
  window.__feishuDuplicateDoc = duplicateDocument;
})();
