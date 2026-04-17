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
    var match = location.pathname.match(/\/docx\/([A-Za-z0-9]+)/);
    return match ? match[1] : null;
  }

  function getCsrfToken() {
    var match = document.cookie.match(/_csrf_token=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  }

  function duplicateDocument() {
    var token = getDocToken();
    if (!token) {
      alert('无法识别当前文档，请确保在飞书文档页面使用此功能');
      return;
    }

    var baseUrl = getBaseUrl();
    var csrfToken = getCsrfToken();

    var btn = document.getElementById('__feishu_duplicate_btn__');
    if (btn) btn.textContent = '复制中...';

    fetch(baseUrl + '/api/v2/docx/' + token + '/copy', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Csrf-Token': csrfToken,
      },
      credentials: 'include',
      body: JSON.stringify({}),
    })
    .then(function (res) { return res.json(); })
    .then(function (data) {
      if (btn) btn.textContent = '创建副本';

      if (data.code === 0 && data.data && data.data.document_id) {
        var newUrl = baseUrl + '/docx/' + data.data.document_id;
        window.open(newUrl, '_blank');
      } else if (data.code === 0 && data.data && data.data.node_token) {
        var newUrl2 = baseUrl + '/docx/' + data.data.node_token;
        window.open(newUrl2, '_blank');
      } else {
        tryAlternativeAPIs(token, baseUrl, csrfToken, btn);
      }
    })
    .catch(function () {
      tryAlternativeAPIs(token, baseUrl, csrfToken, btn);
    });
  }

  function tryAlternativeAPIs(token, baseUrl, csrfToken, btn) {
    fetch(baseUrl + '/doc/api/create_shortcut', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Csrf-Token': csrfToken,
      },
      credentials: 'include',
      body: JSON.stringify({
        obj_token: token,
        obj_type: 'docx',
        is_copy: true,
      }),
    })
    .then(function (res) { return res.json(); })
    .then(function (data) {
      if (btn) btn.textContent = '创建副本';

      if (data.code === 0 && data.data && data.data.token) {
        window.open(baseUrl + '/docx/' + data.data.token, '_blank');
      } else if (data.code === 0 && data.data && data.data.url) {
        window.open(data.data.url, '_blank');
      } else {
        fallbackDOMCopy();
      }
    })
    .catch(function () {
      if (btn) btn.textContent = '创建副本';
      fallbackDOMCopy();
    });
  }

  function fallbackDOMCopy() {
    var title = document.querySelector('title');
    var docTitle = title ? title.textContent.replace(/ - 飞书云文档$/, '') : '副本';

    var contentEl = document.querySelector('[data-content-editable-root="true"]') ||
                    document.querySelector('.doc-content') ||
                    document.querySelector('.docx-container') ||
                    document.querySelector('[class*="doc-content"]') ||
                    document.querySelector('[class*="editor"]');

    if (!contentEl) {
      alert('无法提取文档内容，请尝试手动复制');
      return;
    }

    var html = contentEl.innerHTML;
    var blob = new Blob([
      '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + docTitle + ' (副本)</title>' +
      '<style>body{font-family:-apple-system,sans-serif;max-width:800px;margin:40px auto;padding:0 20px;line-height:1.8;}img{max-width:100%;}table{border-collapse:collapse;width:100%;}td,th{border:1px solid #ddd;padding:8px;}</style>' +
      '</head><body><h1>' + docTitle + ' (副本)</h1>' + html + '</body></html>'
    ], { type: 'text/html' });

    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = docTitle + '_副本.html';
    a.click();
    URL.revokeObjectURL(url);

    alert('API 复制未成功，已导出为 HTML 文件。你可以手动将内容粘贴到新文档中。');
  }

  function createFloatingButton() {
    if (document.getElementById('__feishu_duplicate_btn__')) return;

    var container = document.createElement('div');
    container.id = '__feishu_toolbar__';
    container.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:999998;display:flex;flex-direction:column;gap:8px;';

    var dupBtn = document.createElement('button');
    dupBtn.id = '__feishu_duplicate_btn__';
    dupBtn.textContent = '创建副本';
    dupBtn.style.cssText = 'background:#3370ff;color:#fff;border:none;padding:10px 16px;border-radius:8px;cursor:pointer;font-size:14px;box-shadow:0 2px 8px rgba(0,0,0,0.2);white-space:nowrap;';
    dupBtn.onclick = duplicateDocument;

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
    if (getDocToken()) {
      setTimeout(createFloatingButton, 2000);
    }
  });

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
