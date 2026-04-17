// ==UserScript==
// @name         飞书文档助手
// @namespace    https://github.com/tampermonkey-scripts
// @version      3.0.0
// @description  解除飞书文档复制限制，批量提取文档图片，创建文档副本（含LaTeX公式）
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

  function getDocToken() {
    var match = location.pathname.match(/\/(docx|wiki|doc|sheet|slides|base)\/([A-Za-z0-9]+)/);
    return match ? match[2] : null;
  }

  function getStructService() {
    var contentEl = document.querySelector('[data-content-editable-root="true"]');
    if (!contentEl) return null;
    var fiberKey = Object.keys(contentEl).find(function (k) {
      return k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$');
    });
    if (!fiberKey) return null;
    var fiber = contentEl[fiberKey];
    var depth = 0;
    while (fiber && depth < 15) {
      var props = fiber.memoizedProps || {};
      if (props.editorAPI && props.editorAPI.structService) {
        return props.editorAPI.structService;
      }
      fiber = fiber.return;
      depth++;
    }
    return null;
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
          var latex = equationAttr[1];
          if (latex.endsWith('\\n')) latex = latex.slice(0, -2);
          else if (latex.endsWith('\n')) latex = latex.slice(0, -1);

          var isDisplay = rawText.trim() === '';
          if (isDisplay) {
            result.push(' $$' + latex + '$$ ');
          } else {
            result.push(' $' + latex + '$ ');
          }
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

    return result.join('');
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

  var CONTAINER_TYPES = {
    'callout': true, 'quote_container': true, 'grid': true,
    'grid_column': true, 'table': true, 'table_cell': true,
  };

  function blockToHtml(snap, block, childHtmlArr) {
    var type = snap.type;
    var text = decodeBlockText(snap);
    var childHtml = childHtmlArr ? childHtmlArr.join('\n') : '';

    switch (type) {
      case 'heading1': return '<h1>' + text + '</h1>';
      case 'heading2': return '<h2>' + text + '</h2>';
      case 'heading3': return '<h3>' + text + '</h3>';
      case 'heading4': return '<h4>' + text + '</h4>';
      case 'heading5': return '<h5>' + text + '</h5>';
      case 'heading6': return '<h6>' + text + '</h6>';
      case 'heading7': return '<h6>' + text + '</h6>';
      case 'heading8': return '<h6>' + text + '</h6>';
      case 'heading9': return '<h6>' + text + '</h6>';
      case 'text': return '<p>' + text + '</p>';
      case 'ordered': return '<li>' + text + '</li>';
      case 'bullet': return '<li>' + text + '</li>';
      case 'todo': return '<li>' + (snap.checked ? '☑' : '☐') + ' ' + text + '</li>';
      case 'divider': return '<hr>';
      case 'code':
        var lang = (snap.language || snap.lang || '').replace(/^plain_text$/, '');
        return '<pre><code' + (lang ? ' class="language-' + lang + '"' : '') + '>' + text + '</code></pre>';
      case 'image':
        var imgToken = snap.image && snap.image.token;
        var imgSrc = imgToken ? 'https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/all/' + imgToken + '/' : '';
        var imgAlt = (snap.image && snap.image.name) || '';
        var caption = '';
        if (snap.image && snap.image.caption && snap.image.caption.text) {
          var capText = decodeBlockText({ text: snap.image.caption.text });
          if (capText) caption = '<figcaption>' + capText + '</figcaption>';
        }
        return '<figure><img src="' + imgSrc + '" alt="' + imgAlt + '" />' + caption + '</figure>';
      case 'callout':
        var emoji = getEmoji(snap.emoji_id);
        var bgColor = snap.background_color || '';
        var style = bgColor ? ' style="background:' + bgColor + ';padding:12px 16px;border-radius:8px;"' : '';
        return '<div class="callout"' + style + '>' + (emoji ? '<span>' + emoji + '</span> ' : '') + childHtml + '</div>';
      case 'quote_container':
        return '<blockquote>' + childHtml + '</blockquote>';
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
        return '<p>[流程图]</p>';
      case 'whiteboard':
        return '<p>[白板]</p>';
      case 'synced_reference':
        return '<p>[引用块]</p>';
      default:
        return text ? '<p>' + text + '</p>' : '';
    }
  }

  function tableToHtml(snap, block) {
    var rows = snap.rows_id || [];
    var cols = snap.columns_id || [];
    var cellSet = snap.cell_set || {};

    if (!rows.length || !cols.length) return '';

    var blockMap = {};
    if (block.children && Array.isArray(block.children)) {
      block.children.forEach(function(c) {
        if (c.record && c.record.id) blockMap[c.record.id] = c;
      });
    }

    var html = '<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;">';
    html += '<thead><tr>';
    html += '<th></th>';
    for (var ci = 0; ci < cols.length; ci++) {
      html += '<th>列' + (ci + 1) + '</th>';
    }
    html += '</tr></thead><tbody>';

    for (var ri = 0; ri < rows.length; ri++) {
      html += '<tr>';
      for (var cj = 0; cj < cols.length; cj++) {
        var cellKey = rows[ri] + cols[cj];
        var cellInfo = cellSet[cellKey];
        var cellContent = '';

        if (cellInfo && cellInfo.block_id) {
          var cellBlock = blockMap[cellInfo.block_id];
          if (cellBlock) {
            var cellChildHtml = [];
            if (cellBlock.children && Array.isArray(cellBlock.children)) {
              cellBlock.children.forEach(function(gc) {
                if (gc.record && gc.record.snapshot) {
                  var gcText = decodeBlockText(gc.record.snapshot);
                  if (gcText) cellChildHtml.push(gcText);
                }
              });
            }
            cellContent = cellChildHtml.join('<br>');
          }
        }

        html += '<td>' + cellContent + '</td>';
      }
      html += '</tr>';
    }

    html += '</tbody></table>';
    return html;
  }

  function blockToMarkdown(snap, block, childMdArr) {
    var type = snap.type;
    var text = decodeBlockText(snap);
    var childMd = childMdArr ? childMdArr.join('\n') : '';

    switch (type) {
      case 'heading1': return '# ' + text;
      case 'heading2': return '## ' + text;
      case 'heading3': return '### ' + text;
      case 'heading4': return '#### ' + text;
      case 'heading5': return '##### ' + text;
      case 'heading6': return '###### ' + text;
      case 'heading7': return '###### ' + text;
      case 'heading8': return '###### ' + text;
      case 'heading9': return '###### ' + text;
      case 'text': return text;
      case 'ordered': return '1. ' + text;
      case 'bullet': return '- ' + text;
      case 'todo': return (snap.checked ? '[x]' : '[ ]') + ' ' + text;
      case 'divider': return '---';
      case 'code':
        var lang = (snap.language || snap.lang || '').replace(/^plain_text$/, '');
        return '```' + lang + '\n' + text + '\n```';
      case 'image':
        return '![' + (snap.image && snap.image.name || '') + '](' + (snap.image && snap.image.token || '') + ')';
      case 'callout':
        var emoji = getEmoji(snap.emoji_id);
        return (emoji ? emoji + ' ' : '') + childMd.split('\n').map(function(l) { return '> ' + l; }).join('\n');
      case 'quote_container':
        return childMd.split('\n').map(function(l) { return '> ' + l; }).join('\n');
      case 'grid':
        return childMd;
      case 'grid_column':
        return childMd;
      case 'table':
        return tableToMarkdown(snap, block);
      case 'table_cell':
        return childMd;
      case 'diagram':
        return '[流程图]';
      case 'whiteboard':
        return '[白板]';
      case 'synced_reference':
        return '[引用块]';
      default:
        return text;
    }
  }

  function tableToMarkdown(snap, block) {
    var rows = snap.rows_id || [];
    var cols = snap.columns_id || [];
    var cellSet = snap.cell_set || {};

    if (!rows.length || !cols.length) return '';

    var blockMap = {};
    if (block.children && Array.isArray(block.children)) {
      block.children.forEach(function(c) {
        if (c.record && c.record.id) blockMap[c.record.id] = c;
      });
    }

    var tableData = [];
    for (var ri = 0; ri < rows.length; ri++) {
      var row = [];
      for (var ci = 0; ci < cols.length; ci++) {
        var cellKey = rows[ri] + cols[ci];
        var cellInfo = cellSet[cellKey];
        var cellContent = '';

        if (cellInfo && cellInfo.block_id) {
          var cellBlock = blockMap[cellInfo.block_id];
          if (cellBlock) {
            var cellTexts = [];
            if (cellBlock.children && Array.isArray(cellBlock.children)) {
              cellBlock.children.forEach(function(gc) {
                if (gc.record && gc.record.snapshot) {
                  var gcText = decodeBlockText(gc.record.snapshot);
                  if (gcText) cellTexts.push(gcText);
                }
              });
            }
            cellContent = cellTexts.join(' ');
          }
        }

        row.push(cellContent.replace(/\|/g, '\\|').replace(/\n/g, ' '));
      }
      tableData.push(row);
    }

    var md = '| ' + cols.map(function(_, i) { return '列' + (i + 1); }).join(' | ') + ' |\n';
    md += '| ' + cols.map(function() { return '---'; }).join(' | ') + ' |\n';
    tableData.forEach(function(row) {
      md += '| ' + row.join(' | ') + ' |\n';
    });

    return md.trim();
  }

  function extractFullDoc() {
    var ss = getStructService();
    if (!ss || !ss.rootBlock) return null;

    var htmlParts = [];
    var mdParts = [];
    var blockCount = 0;
    var equationCount = 0;

    function processBlock(block, depth) {
      if (!block || depth > 12) return;
      if (block.record && block.record.snapshot) {
        var snap = block.record.snapshot;
        var type = snap.type;

        if (type === 'page') {
          if (block.children && Array.isArray(block.children)) {
            for (var i = 0; i < block.children.length; i++) {
              processBlock(block.children[i], depth + 1);
            }
          }
          return;
        }

        var childHtmlArr = [];
        var childMdArr = [];

        if (CONTAINER_TYPES[type] && block.children && Array.isArray(block.children)) {
          for (var ci = 0; ci < block.children.length; ci++) {
            var childResult = processBlockInner(block.children[ci], depth + 1);
            if (childResult) {
              if (childResult.html) childHtmlArr.push(childResult.html);
              if (childResult.md) childMdArr.push(childResult.md);
            }
          }
        }

        var decoded = decodeBlockText(snap);
        if (decoded.includes('$')) equationCount++;

        var html = blockToHtml(snap, block, childHtmlArr);
        var md = blockToMarkdown(snap, block, childMdArr);

        if (html) htmlParts.push(html);
        if (md) mdParts.push(md);
        blockCount++;
        return;
      }
      if (block.children && Array.isArray(block.children)) {
        for (var i = 0; i < block.children.length; i++) {
          processBlock(block.children[i], depth + 1);
        }
      }
    }

    function processBlockInner(block, depth) {
      if (!block || depth > 12) return null;
      if (!block.record || !block.record.snapshot) return null;

      var snap = block.record.snapshot;
      var type = snap.type;

      var childHtmlArr = [];
      var childMdArr = [];

      if (CONTAINER_TYPES[type] && block.children && Array.isArray(block.children)) {
        for (var ci = 0; ci < block.children.length; ci++) {
          var childResult = processBlockInner(block.children[ci], depth + 1);
          if (childResult) {
            if (childResult.html) childHtmlArr.push(childResult.html);
            if (childResult.md) childMdArr.push(childResult.md);
          }
        }
      }

      var html = blockToHtml(snap, block, childHtmlArr);
      var md = blockToMarkdown(snap, block, childMdArr);

      return { html: html, md: md };
    }

    processBlock(ss.rootBlock, 0);

    return {
      html: htmlParts.join('\n'),
      text: mdParts.join('\n\n'),
      blockCount: blockCount,
      equationCount: equationCount,
    };
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

    var content = extractFullDoc();
    if (!content) {
      alert('无法提取文档内容，请确保文档已完全加载');
      return;
    }

    var title = document.querySelector('title');
    var docTitle = title ? title.textContent.replace(/ - 飞书云文档$/, '').replace(/ - Lark$/, '') : '副本';

    setPendingPaste({ html: content.html, text: content.text, title: docTitle });

    showNotice(
      '✅',
      '文档内容已提取',
      '共 ' + content.blockCount + ' 个内容块，其中 ' + content.equationCount + ' 个含公式<br><br>' +
      '接下来请：<br>' +
      '1. 手动新建一个飞书文档<br>' +
      '2. 打开空白文档<br>' +
      '3. 按 <kbd style="background:#f0f0f0;padding:2px 6px;border-radius:4px;border:1px solid #ccc;">Cmd+Shift+P</kbd> 粘贴副本<br><br>' +
      '内容会写入剪贴板，然后按 Cmd+V 粘贴即可'
    );
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
    if (!e.metaKey || !e.shiftKey) return;
    var k = e.key.toLowerCase();

    if (k === 'd') {
      e.preventDefault();
      e.stopImmediatePropagation();
      duplicateDocument();
    } else if (k === 'p') {
      e.preventDefault();
      e.stopImmediatePropagation();
      pasteIntoDoc();
    } else if (k === 'i') {
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
  window.__feishuExtractFullDoc = extractFullDoc;
})();
