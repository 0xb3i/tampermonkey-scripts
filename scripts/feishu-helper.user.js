// ==UserScript==
// @name         飞书文档助手
// @namespace    https://github.com/tampermonkey-scripts
// @version      1.0.0
// @description  解除飞书文档复制限制，批量提取文档图片
// @author       You
// @match        https://*.feishu.cn/*
// @match        https://*.larksuite.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  var EVENTS = ['copy', 'cut', 'paste', 'contextmenu', 'selectstart', 'dragstart', 'keydown', 'keyup'];
  var STYLE_CSS = '*{user-select:text!important;-webkit-user-select:text!important;pointer-events:auto!important}';

  function install(win) {
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

      doc.querySelectorAll('*').forEach(function (el) {
        var cs = win.getComputedStyle(el);
        if ((cs.position === 'fixed' || cs.position === 'absolute') && parseFloat(cs.opacity) === 0) {
          el.style.pointerEvents = 'auto';
          el.style.display = 'none';
        }
      });
    } catch (_) {}
  }

  function harden(win) {
    install(win);
    try {
      win.document.querySelectorAll('iframe').forEach(function (f) {
        try { if (f.contentWindow && f.contentDocument) install(f.contentWindow); } catch (_) {}
      });
    } catch (_) {}
  }

  function startFreeCopy() {
    var t0 = performance.now();
    (function loop() {
      harden(window);
      if (performance.now() - t0 < 30000) requestAnimationFrame(loop);
    })();
  }

  if (document.body) {
    startFreeCopy();
  } else {
    document.addEventListener('DOMContentLoaded', startFreeCopy);
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
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'e') {
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
})();
