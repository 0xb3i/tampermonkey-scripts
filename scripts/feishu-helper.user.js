// ==UserScript==
// @name         飞书文档助手
// @namespace    https://github.com/tampermonkey-scripts
// @version      4.1.0
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
          latex = latex.trim();
          result.push(' $' + latex + '$ ');
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

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function blockToHtml(snap, block, childHtmlArr) {
    var type = snap.type;
    var text = escapeHtml(decodeBlockText(snap));
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
        var borderColor = snap.border_color || '';
        var containerStyle = '';
        if (bgColor || borderColor) {
          containerStyle = ' style="';
          if (borderColor) containerStyle += 'border:1px solid ' + borderColor + ';';
          if (bgColor) containerStyle += 'background:' + bgColor + ';';
          containerStyle += 'padding:12px 16px;border-radius:8px;"';
        }
        return '<div class="callout-container"' + containerStyle + ' data-emoji-id="' + escapeHtml(snap.emoji_id || '') + '"><div class="callout-block">' + (emoji ? '<span>' + emoji + '</span> ' : '') + childHtml + '</div></div>';
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
                  var gcText = escapeHtml(decodeBlockText(gc.record.snapshot));
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

    html += '</table>';
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
        return (emoji ? emoji + ' ' : '') + childMd;
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

    var md = '| ' + cols.map(function() { return ''; }).join(' | ') + ' |\n';
    md += '| ' + cols.map(function() { return '---'; }).join(' | ') + ' |\n';
    tableData.forEach(function(row) {
      md += '| ' + row.join(' | ') + ' |\n';
    });

    return md.trim();
  }

  function normalizePlainText(text) {
    return text
      .split(/(```[\s\S]*?```)/g)
      .map(function (part) {
        if (part.startsWith('```') && part.endsWith('```')) return part;
        return part
          .replace(/[\u200B\u200C\u200D\uFEFF]/g, '')
          .replace(/\r\n/g, '\n')
          .replace(/^[ \t]+$/gm, '')
          .replace(/[ \t]+\n/g, '\n')
          .replace(/\n{3,}/g, '\n\n');
      })
      .join('')
      .replace(/^\n+/, '')
      .replace(/\n+$/, '');
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
      text: normalizePlainText(mdParts.join('\n')),
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

  function buildExportHtml(title, bodyHtml) {
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + title + '</title>' +
      '<style>' +
      'body{max-width:960px;margin:0 auto;padding:40px 48px;font:16px/1.75 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#1f2329;background:#fff;}' +
      'h1,h2,h3,h4,h5,h6{line-height:1.35;margin:1.2em 0 0.6em;}' +
      'p,li,blockquote,pre,table,figure{margin:0.75em 0;}' +
      'ul,ol{padding-left:1.6em;}' +
      'blockquote{border-left:4px solid #d0d7de;padding-left:1em;color:#57606a;}' +
      'pre{background:#f6f8fa;padding:12px 16px;border-radius:8px;overflow:auto;white-space:pre-wrap;}' +
      'code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}' +
      'table{width:100%;border-collapse:collapse;font-size:14px;}' +
      'td,th{border:1px solid #d0d7de;padding:8px 10px;vertical-align:top;}' +
      'img{max-width:100%;height:auto;display:block;margin:0 auto;}' +
      'figure{margin:1em 0;text-align:center;}' +
      'figcaption{margin-top:8px;color:#57606a;font-size:13px;}' +
      'hr{border:none;border-top:1px solid #d0d7de;margin:24px 0;}' +
      '@page{size:auto;margin:16mm 14mm;}' +
      '@media print{body{padding:0;}a{text-decoration:none;color:inherit;}}' +
      '</style></head><body>' + bodyHtml + '</body></html>';
  }

  function downloadTextFile(filename, content, mimeType) {
    var blob = new Blob([content], { type: mimeType || 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
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

      setPendingPaste({ html: content.html, text: content.text, title: docTitle }).then(function () {
        var imgCount = (content.text.match(/!\[/g) || []).length;
        showToast('✅ 已提取 ' + content.blockCount + ' 块 · ' + content.equationCount + ' 公式 · ' + imgCount + ' 图片', 3000);
      });
    }, 50);
  }

  function exportDocumentAsHtml() {
    showToast('⏳ 导出 HTML 中...', 0);

    setTimeout(function () {
      var content = extractFullDoc();
      if (!content) {
        showToast('⚠️ 导出失败，请确保文档已加载');
        return;
      }

      var title = document.querySelector('title');
      var docTitle = title ? title.textContent.replace(/ - 飞书云文档$/, '').replace(/ - Lark$/, '') : '副本';

      convertImagesToBase64(content.html).then(function (htmlWithImages) {
        var fullHtml = buildExportHtml(docTitle, htmlWithImages);
        var safeName = docTitle.replace(/[\\/:*?"<>|]/g, '_').trim() || 'feishu-export';
        downloadTextFile(safeName + '.html', fullHtml, 'text/html;charset=utf-8');
        var imgCount = (htmlWithImages.match(/data:image/g) || []).length;
        showToast('✅ 已导出 HTML · ' + content.blockCount + ' 块 · ' + content.equationCount + ' 公式 · ' + imgCount + ' 图片', 3000);
      }).catch(function () {
        showToast('⚠️ 导出 HTML 失败', 3000);
      });
    }, 50);
  }

  function getActiveBodyEditor() {
    return document.querySelector('.editor-kit-container[contenteditable="true"]') ||
      document.querySelector('[data-content-editable-root="true"]');
  }

  function writePlainTextToClipboard(text) {
    return new Promise(function (resolve, reject) {
      var handled = false;

      function cleanup() {
        document.removeEventListener('copy', onCopy, true);
      }

      function onCopy(e) {
        handled = true;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.clipboardData) {
          e.clipboardData.setData('text/plain', text);
        }
      }

      document.addEventListener('copy', onCopy, true);

      try {
        var ok = document.execCommand('copy');
        cleanup();
        if (handled || ok) {
          resolve();
          return;
        }
      } catch (err) {
        cleanup();
      }

      if (!navigator.clipboard || !navigator.clipboard.write) {
        reject(new Error('clipboard unavailable'));
        return;
      }

      var clipboardItem = new ClipboardItem({
        'text/plain': new Blob([text], { type: 'text/plain' }),
      });

      navigator.clipboard.write([clipboardItem]).then(resolve).catch(reject);
    });
  }

  function pasteIntoDoc() {
    getPendingPaste().then(function (pendingPaste) {
      if (!pendingPaste) {
        showToast('⚠️ 请先在源文档按 Cmd+Shift+D 提取');
        return;
      }

      var content = pendingPaste;
      writePlainTextToClipboard(content.text).then(function () {
        showToast('📋 已写入剪贴板，按 Cmd+V 粘贴', 3000);
      }).catch(function () {
        var editor = getActiveBodyEditor();
        if (!editor) {
          showToast('⚠️ 写入剪贴板失败且未找到编辑器', 3000);
          return;
        }
        editor.focus();
        var dt = new DataTransfer();
        dt.setData('text/plain', content.text);
        var pasteEvent = new ClipboardEvent('paste', {
          clipboardData: dt,
          bubbles: true,
          cancelable: true
        });
        editor.dispatchEvent(pasteEvent);
        showToast('⚠️ 剪贴板写入失败，已改为兜底粘贴，格式可能有偏差', 3500);
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
      var bgUrl = extractUrlFromBackgroundImage(el.style.backgroundImage || '');
      if (bgUrl && !seen.has(bgUrl)) {
        seen.add(bgUrl);
        images.push({
          src: bgUrl,
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

  function getImageInfoFromTarget(target) {
    var img = target.closest && target.closest('img');
    if (img) {
      var src = img.currentSrc || img.src || img.getAttribute('data-src') || img.getAttribute('data-original');
      if (!src) return null;
      return {
        src: src,
        alt: img.alt || '',
        width: img.naturalWidth || img.width || 0,
        height: img.naturalHeight || img.height || 0,
        element: img,
        sourceType: 'img',
      };
    }

    var el = target;
    var bgUrl = '';
    while (el && el !== document.documentElement) {
      if (el.nodeType === 1) {
        var bg = getComputedStyle(el).backgroundImage || '';
        bgUrl = extractUrlFromBackgroundImage(bg);
        if (bgUrl) break;
      }
      el = el.parentElement;
    }
    if (!el || !bgUrl) return null;
    return {
      src: bgUrl,
      alt: '',
      width: el.offsetWidth || 0,
      height: el.offsetHeight || 0,
      element: el,
      sourceType: 'background',
    };
  }

  function extractUrlFromBackgroundImage(backgroundImage) {
    if (!backgroundImage) return '';
    var urlIndex = backgroundImage.indexOf('url(');
    if (urlIndex === -1) return '';

    var remainder = backgroundImage.slice(urlIndex + 4).trim();
    if (!remainder) return '';

    var quote = remainder[0];
    if (quote === '"' || quote === '\'') {
      var quotedEnd = remainder.indexOf(quote, 1);
      return quotedEnd > 0 ? remainder.slice(1, quotedEnd) : '';
    }

    var closeIndex = remainder.indexOf(')');
    return closeIndex > -1 ? remainder.slice(0, closeIndex).trim() : '';
  }

  function isContextMenuGesture(e) {
    return !!e && (e.button === 2 || (e.button === 0 && e.ctrlKey));
  }

  var nativeImageMenuContext = null;
  var nativeImageMenuProxy = null;
  var nativeImageMenuCleanupTimer = 0;

  function cleanupNativeImageMenuBypass() {
    nativeImageMenuContext = null;
    if (nativeImageMenuCleanupTimer) {
      clearTimeout(nativeImageMenuCleanupTimer);
      nativeImageMenuCleanupTimer = 0;
    }
    if (nativeImageMenuProxy) {
      nativeImageMenuProxy.remove();
      nativeImageMenuProxy = null;
    }
  }

  function scheduleNativeImageMenuCleanup(delay) {
    if (nativeImageMenuCleanupTimer) {
      clearTimeout(nativeImageMenuCleanupTimer);
    }
    nativeImageMenuCleanupTimer = setTimeout(function () {
      cleanupNativeImageMenuBypass();
    }, delay || 2200);
  }

  function ensureNativeImageMenuProxy(imageInfo) {
    if (!imageInfo || imageInfo.sourceType !== 'background' || !imageInfo.element) {
      return true;
    }

    var rect = imageInfo.element.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;

    if (!nativeImageMenuProxy) {
      nativeImageMenuProxy = document.createElement('img');
      nativeImageMenuProxy.id = '__feishu_native_image_proxy__';
      nativeImageMenuProxy.setAttribute('aria-hidden', 'true');
      nativeImageMenuProxy.style.cssText = [
        'position:fixed',
        'z-index:2147483646',
        'pointer-events:auto',
        'opacity:0.01',
        'user-select:none',
        '-webkit-user-drag:none',
        'margin:0',
        'padding:0',
        'border:none',
        'background:transparent',
      ].join(';');
    }

    var computedStyle = getComputedStyle(imageInfo.element);
    nativeImageMenuProxy.src = imageInfo.src;
    nativeImageMenuProxy.alt = imageInfo.alt || '';
    nativeImageMenuProxy.style.left = Math.round(rect.left) + 'px';
    nativeImageMenuProxy.style.top = Math.round(rect.top) + 'px';
    nativeImageMenuProxy.style.width = Math.max(1, Math.round(rect.width)) + 'px';
    nativeImageMenuProxy.style.height = Math.max(1, Math.round(rect.height)) + 'px';
    nativeImageMenuProxy.style.borderRadius = computedStyle.borderRadius || '0';
    nativeImageMenuProxy.style.objectFit = computedStyle.backgroundSize === 'cover' ? 'cover' : 'contain';

    if (!nativeImageMenuProxy.isConnected) {
      document.documentElement.appendChild(nativeImageMenuProxy);
    }

    return true;
  }

  function activateNativeImageMenuBypass(imageInfo) {
    if (!imageInfo) return false;
    if (!ensureNativeImageMenuProxy(imageInfo)) return false;
    nativeImageMenuContext = imageInfo;
    pendingImageContextInfo = imageInfo;
    scheduleNativeImageMenuCleanup();
    return true;
  }

  function bypassSiteImageContextMenu(e) {
    if (!isContextMenuGesture(e)) return false;
    var imageInfo = nativeImageMenuContext || getImageInfoFromTarget(e.target);
    if (!activateNativeImageMenuBypass(imageInfo)) return false;
    e.stopImmediatePropagation();
    e.stopPropagation();
    return true;
  }

  function copyImageBlobToClipboard(url) {
    return fetch(url, { credentials: 'include' }).then(function (res) {
      if (!res.ok) throw new Error('fetch failed');
      return res.blob();
    }).then(function (blob) {
      if (!navigator.clipboard || !navigator.clipboard.write) {
        throw new Error('clipboard unavailable');
      }
      var type = blob.type || 'image/png';
      return navigator.clipboard.write([
        new ClipboardItem((function () {
          var item = {};
          item[type] = blob;
          return item;
        })())
      ]);
    });
  }

  var pendingImageContextInfo = null;

  function injectImageMenuItem(menu) {
    if (!menu || menu.querySelector('[data-feishu-copy-image-item="true"]')) return;
    if (!pendingImageContextInfo) return;

    var firstItem = menu.querySelector('li, [role="menuitem"], .ud__menu-normal-item');
    var item = document.createElement(firstItem && firstItem.tagName ? firstItem.tagName : 'li');
    item.setAttribute('data-feishu-copy-image-item', 'true');
    item.setAttribute('role', 'menuitem');
    item.className = firstItem && firstItem.className ? firstItem.className : 'ud__menu-normal-item ud__menu-normal-item--root-normal ud-typography-body-0';
    item.style.cursor = 'pointer';

    if (firstItem) {
      item.innerHTML = firstItem.innerHTML;
      var titleNode = item.querySelector('.ud__menu-normal-item-title-content') || item.querySelector('[class*="title"]') || item;
      titleNode.textContent = '复制图片';
    } else {
      item.innerHTML = '<div class="ud__menu-normal-item-title-content">复制图片</div>';
    }

    item.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var imageInfo = pendingImageContextInfo;
      pendingImageContextInfo = null;
      showToast('⏳ 正在复制图片...', 1200);
      copyImageBlobToClipboard(imageInfo.src).then(function () {
        showToast('✅ 图片已复制到剪贴板', 2500);
      }).catch(function () {
        showToast('⚠️ 复制图片失败，可尝试右键后“打开图片”', 3000);
      });
    }, true);

    menu.appendChild(item);
  }

  function tryInjectImageMenu() {
    if (!pendingImageContextInfo || nativeImageMenuContext) return;
    var menus = document.querySelectorAll('[role="menu"], .ud__menu-normal-root, .ud__menu-normal');
    for (var i = menus.length - 1; i >= 0; i--) {
      var menu = menus[i];
      var text = (menu.innerText || '');
      if (text.indexOf('上传日志') !== -1 && text.indexOf('联系客服') !== -1) continue;
      injectImageMenuItem(menu);
      return;
    }
  }

  document.addEventListener('pointerdown', function (e) {
    if (bypassSiteImageContextMenu(e)) return;
    cleanupNativeImageMenuBypass();
  }, true);

  document.addEventListener('mousedown', function (e) {
    bypassSiteImageContextMenu(e);
  }, true);

  document.addEventListener('mouseup', function (e) {
    if (!nativeImageMenuContext || !isContextMenuGesture(e)) return;
    e.stopImmediatePropagation();
    e.stopPropagation();
    scheduleNativeImageMenuCleanup();
  }, true);

  document.addEventListener('contextmenu', function (e) {
    if (bypassSiteImageContextMenu(e)) return;
    cleanupNativeImageMenuBypass();
    pendingImageContextInfo = getImageInfoFromTarget(e.target);
    setTimeout(tryInjectImageMenu, 0);
    setTimeout(tryInjectImageMenu, 120);
  }, true);

  var imageMenuObserver = new MutationObserver(function () {
    tryInjectImageMenu();
  });

  imageMenuObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  document.addEventListener('click', function () {
    cleanupNativeImageMenuBypass();
    pendingImageContextInfo = null;
  }, true);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      cleanupNativeImageMenuBypass();
      pendingImageContextInfo = null;
    }
  }, true);
  document.addEventListener('scroll', function () {
    cleanupNativeImageMenuBypass();
  }, true);

  document.addEventListener('keydown', function (e) {
    if (!e.metaKey || !e.shiftKey) return;
    var k = e.key.toLowerCase();

    if (k === 'd') {
      e.preventDefault();
      e.stopImmediatePropagation();
      duplicateDocument();
    } else if (k === 'h') {
      e.preventDefault();
      e.stopImmediatePropagation();
      exportDocumentAsHtml();
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
  window.__feishuPasteIntoDoc = pasteIntoDoc;
  window.__feishuDebugEquations = function () {
    var ss = getStructService();
    if (!ss || !ss.rootBlock) { console.log('no rootBlock'); return; }
    var equations = [];
    function find(block, depth) {
      if (!block || depth > 12) return;
      if (block.record && block.record.snapshot) {
        var snap = block.record.snapshot;
        if (snap.text && snap.text.apool && snap.text.apool.numToAttrib) {
          var nta = snap.text.apool.numToAttrib;
          for (var num in nta) {
            if (nta[num][0] === 'equation') {
              equations.push({ num: num, latex: nta[num][1], len: nta[num][1].length });
            }
          }
        }
      }
      if (block.children) block.children.forEach(function (c) { find(c, depth + 1); });
    }
    find(ss.rootBlock, 0);
    console.log('Total equations:', equations.length);
    var truncated = equations.filter(function (e) {
      var open = (e.latex.match(/\{/g) || []).length;
      var close = (e.latex.match(/\}/g) || []).length;
      return open !== close;
    });
    console.log('Possibly truncated:', truncated.length);
    equations.forEach(function (e, i) {
      console.log('[' + i + '] len=' + e.len + ' ' + e.latex.substring(0, 150));
    });
    if (truncated.length > 0) {
      console.log('\n--- Truncated ---');
      truncated.forEach(function (e, i) {
        console.log('[' + i + '] len=' + e.len + ' ' + e.latex);
      });
    }
    return equations;
  };
})();
