// ==UserScript==
// @name         飞书文档助手
// @namespace    https://github.com/tampermonkey-scripts
// @version      4.0.0
// @description  飞书文档完整复制、图片提取、文档副本（含LaTeX公式）
// @author       You
// @match        https://*.feishu.cn/*
// @match        https://*.larksuite.com/*
// @match        https://*.larkoffice.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

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
      case 'text':
        if (childHtml) return '<p>' + text + '</p>' + childHtml;
        return '<p>' + text + '</p>';
      case 'ordered':
        if (childHtml) return '<li>' + text + '<ul>' + childHtml + '</ul></li>';
        return '<li>' + text + '</li>';
      case 'bullet':
        if (childHtml) return '<li>' + text + '<ul>' + childHtml + '</ul></li>';
        return '<li>' + text + '</li>';
      case 'todo': return '<li>' + (snap.checked ? '☑' : '☐') + ' ' + text + '</li>';
      case 'divider': return '<hr>';
      case 'code':
        var lang = (snap.language || snap.lang || '').replace(/^plain_text$/, '');
        return '<pre><code' + (lang ? ' class="language-' + lang + '"' : '') + '>' + text + '</code></pre>';
      case 'image':
        var imgToken = snap.image && snap.image.token;
        var imgSrc = imgToken ? location.origin + '/space/api/box/stream/download/preview/' + imgToken + '/?preview_type=16' : '';
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
      case 'text':
        if (childMd) return text + '\n' + childMd;
        return text;
      case 'ordered':
        if (childMd) return '1. ' + text + '\n' + childMd.split('\n').map(function(l) { return '  ' + l; }).join('\n');
        return '1. ' + text;
      case 'bullet':
        if (childMd) return '- ' + text + '\n' + childMd.split('\n').map(function(l) { return '  ' + l; }).join('\n');
        return '- ' + text;
      case 'todo': return (snap.checked ? '[x]' : '[ ]') + ' ' + text;
      case 'divider': return '---';
      case 'code':
        var lang = (snap.language || snap.lang || '').replace(/^plain_text$/, '');
        return '```' + lang + '\n' + text + '\n```';
      case 'image':
        var imgTokenMd = snap.image && snap.image.token;
        var imgSrcMd = imgTokenMd ? location.origin + '/space/api/box/stream/download/preview/' + imgTokenMd + '/?preview_type=16' : '';
        return '![' + (snap.image && snap.image.name || '') + '](' + imgSrcMd + ')';
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

        if (block.children && Array.isArray(block.children) && block.children.length > 0) {
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

      if (block.children && Array.isArray(block.children) && block.children.length > 0) {
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

  var DB_NAME = '__feishu_helper_db__';
  var DB_STORE = 'paste';
  var DB_KEY = 'pending';

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

  function getPendingPaste() {
    return openDB().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction(DB_STORE, 'readonly');
        var req = tx.objectStore(DB_STORE).get(DB_KEY);
        req.onsuccess = function () {
          var data = req.result;
          if (data && data.ts && Date.now() - data.ts < 3600000) {
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

  function setPendingPaste(data) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        data.ts = Date.now();
        var tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).put(data, DB_KEY);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
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

  function convertImagesToBase64(html) {
    var imgUrls = [];
    var urlRegex = /src="(https?:\/\/[^"]+\/space\/api\/box\/stream\/download\/preview\/[^"]+)"/g;
    var match;
    while ((match = urlRegex.exec(html)) !== null) {
      imgUrls.push({ url: match[1], full: match[0] });
    }

    if (imgUrls.length === 0) return Promise.resolve(html);

    var done = 0;
    var total = imgUrls.length;

    showToast('📷 转换图片中 0/' + total);

    var promises = imgUrls.map(function (item) {
      return function () {
        return fetchImageAsBase64(item.url).then(function (base64) {
          done++;
          showToast('📷 转换图片中 ' + done + '/' + total);
          if (base64) {
            html = html.replace(item.full, 'src="' + base64 + '"');
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
      return html;
    });
  }

  function showToast(msg, duration) {
    var existing = document.getElementById('__feishu_toast__');
    if (existing) existing.remove();

    var toast = document.createElement('div');
    toast.id = '__feishu_toast__';
    toast.style.cssText = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.75);color:#fff;padding:10px 20px;border-radius:8px;font-size:14px;z-index:9999999;pointer-events:none;transition:opacity 0.3s;white-space:nowrap;';
    toast.textContent = msg;
    document.body.appendChild(toast);

    if (duration !== 0) {
      setTimeout(function () {
        toast.style.opacity = '0';
        setTimeout(function () { toast.remove(); }, 300);
      }, duration || 2000);
    }
  }

  function duplicateDocument() {
    var token = getDocToken();
    if (!token) {
      showToast('⚠️ 无法识别当前文档');
      return;
    }

    showToast('⏳ 提取文档中...', 0);

    setTimeout(function () {
      var content = extractFullDoc();
      if (!content) {
        showToast('⚠️ 提取失败，请确保文档已加载');
        return;
      }

      var title = document.querySelector('title');
      var docTitle = title ? title.textContent.replace(/ - 飞书云文档$/, '').replace(/ - Lark$/, '') : '副本';

      convertImagesToBase64(content.html).then(function (htmlWithImages) {
        content.html = htmlWithImages;
        return setPendingPaste({ html: content.html, text: content.text, title: docTitle });
      }).then(function () {
        var imgCount = (content.html.match(/data:image/g) || []).length;
        showToast('✅ 已提取 ' + content.blockCount + ' 块 · ' + content.equationCount + ' 公式 · ' + imgCount + ' 图片', 3000);
      });
    }, 50);
  }

  function pasteIntoDoc() {
    getPendingPaste().then(function (pendingPaste) {
      if (!pendingPaste) {
        showToast('⚠️ 请先在源文档按 Cmd+Shift+D 提取');
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
        showToast('📋 已写入剪贴板，按 Cmd+V 粘贴', 3000);
      }).catch(function () {
        showToast('⚠️ 写入剪贴板失败', 3000);
      });
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
        showToast('当前页面未找到图片');
      } else {
        createImagePanel(images);
      }
    }
  }, true);

  window.__feishuExtractFullDoc = extractFullDoc;
  window.__feishuDuplicateDoc = duplicateDocument;
})();
