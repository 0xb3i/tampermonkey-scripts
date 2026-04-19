import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { join } from 'path';

const SCRIPT_PATH = join(__dirname, '..', 'scripts', 'feishu-helper.user.js');
const SCRIPT_CONTENT = readFileSync(SCRIPT_PATH, 'utf-8');

function extractInjectableScript(scriptContent) {
  const match = scriptContent.match(/\(function\s*\(\)\s*\{[\s\S]*\}\)\(\);/);
  return match ? match[0] : scriptContent;
}

const injectScript = extractInjectableScript(SCRIPT_CONTENT);

test.describe('Feishu Helper - rich clipboard pipeline', () => {
  test.beforeEach(async ({ page }) => {
    await page.setContent('<!DOCTYPE html><html><body></body></html>');
    await page.evaluate(injectScript);
  });

  test('version probe should expose script version and debug exports', async ({ page }) => {
    const result = await page.evaluate(() => ({
      probe: window.__feishuDebugExports(),
      getLastCopyCapture: typeof window.__feishuGetLastCopyCapture,
    }));

    expect(result.probe.version).toBe('4.2.15');
    expect(result.probe.exports.extractFullDoc).toBe('function');
    expect(result.probe.exports.pasteIntoDoc).toBe('function');
    expect(result.probe.exports.debugEditorAPI).toBe('function');
    expect(result.probe.exports.captureNextCopy).toBe('function');
    expect(result.getLastCopyCapture).toBe('function');
  });

  test('inline attributed text should render semantic HTML instead of raw markdown markers', async ({ page }) => {
    const result = await page.evaluate(() => {
      return {
        bold: window.__feishuDecodeFeishuAttribsToHtml('*0+4', 'bold', {
          0: ['bold', 'true'],
        }),
        linkItalic: window.__feishuDecodeFeishuAttribsToHtml('*0*1+4', 'link', {
          0: ['link', encodeURIComponent('https://example.com')],
          1: ['italic', 'true'],
        }),
        equation: window.__feishuDecodeFeishuAttribsToHtml('*0+1', 'x', {
          0: ['equation', 'x^2 + y^2'],
        }),
        colored: window.__feishuDecodeFeishuAttribsToHtml('*0*1+2', 'hi', {
          0: ['textHighlight', 'rgb(216,57,49)'],
          1: ['textHighlightBackground', 'rgb(242,243,245)'],
        }),
      };
    });

    expect(result.bold).toBe('<strong>bold</strong>');
    expect(result.linkItalic).toBe('<a href="https://example.com"><em>link</em></a>');
    expect(result.equation).toBe(' $$x^2 + y^2$$ ');
    expect(result.colored).toBe('<span style="color:rgb(216,57,49);background-color:rgb(242,243,245);">hi</span>');
  });

  test('block renderer should preserve align, heading background, image align and callout colors', async ({ page }) => {
    const result = await page.evaluate(() => {
      return {
        heading: window.__feishuBlockToHtml({ type: 'heading2', align: 'center', background_color: 'rgb(253,226,226)', text: { initialAttributedTexts: { attribs: { '0': '' }, text: { '0': '标题' } }, apool: { numToAttrib: {} } } }, null, []),
        text: window.__feishuBlockToHtml({ type: 'text', align: 'right', text_indent: '2em', text: { initialAttributedTexts: { attribs: { '0': '' }, text: { '0': '段落' } }, apool: { numToAttrib: {} } } }, null, []),
        image: window.__feishuBlockToHtml({ type: 'image', align: 'left', image: { token: 'demo', name: 'img' } }, null, []),
        callout: window.__feishuBlockToHtml({ type: 'callout', align: 'center', background_color: 'rgb(255,245,235)', border_color: 'rgb(254,212,164)', text_color: 'rgb(216,57,49)', emoji_id: 'memo' }, null, ['<p>内容</p>']),
      };
    });

    expect(result.heading).toContain('text-align:center;');
    expect(result.heading).toContain('background-color:rgb(253,226,226);');
    expect(result.text).toContain('text-align:right;');
    expect(result.text).toContain('text-indent:2em;');
    expect(result.image).toContain('<figure style="margin:1em 0;text-align:left;">');
    expect(result.image).toContain('margin:0 auto 0 0;');
    expect(result.callout).toContain('color:rgb(216,57,49);');
    expect(result.callout).toContain('text-align:center;');
    expect(result.callout).toContain('background:rgb(255,245,235);');
  });

  test('list fragments should be normalized into valid ul/ol containers', async ({ page }) => {
    const html = await page.evaluate(() => {
      return window.__feishuNormalizeListHtmlFragment([
        '<li data-feishu-list="bullet">A</li>',
        '<li data-feishu-list="bullet">B</li>',
        '<li data-feishu-list="ordered">1</li>',
        '<li data-feishu-list="ordered">2</li>',
      ].join('\n'));
    });

    expect(html).toContain('<ul');
    expect(html).toContain('<ol');
    expect(html).toContain('<li>A</li>');
    expect(html).toContain('<li>2</li>');
    expect(html).not.toContain('data-feishu-list=');
  });

  test('list items should keep inline formulas as raw latex text', async ({ page }) => {
    const html = await page.evaluate(() => {
      const formula = window.__feishuDecodeFeishuAttribsToHtml('*0+1', 'x', {
        0: ['equation', 'S_t'],
      });

      return window.__feishuBuildClipboardHtml(
        '<li data-feishu-list="bullet">在状态 ' + formula + ' 下继续优化</li>'
      );
    });

    expect(html).toContain('<li><p style="margin:0;">在状态 $$S_t$$ 下继续优化</p></li>');
    expect(html).not.toContain('data-feishu-formula=');
  });

  test('list item html should wrap text content in paragraph nodes for stable formula parsing', async ({ page }) => {
    const html = await page.evaluate(() => {
      return window.__feishuBuildClipboardHtml(
        '<li data-feishu-list="bullet">Value Model：给出在每一个状态 $$S_t$$ 下，总奖励 $$V_t$$ 的估计</li>' +
        '<li data-feishu-list="bullet">软过长长惩罚机制： $$R_{\\text {length }}(y)= \\begin{cases}0, & |y| \\leq L_{\\max } \\end{cases}$$</li>'
      );
    });

    expect(html).toContain('<li><p style="margin:0;">Value Model：给出在每一个状态 $$S_t$$ 下，总奖励 $$V_t$$ 的估计</p></li>');
    expect(html).toContain('<li><p style="margin:0;">软过长长惩罚机制： $$R_{\\text {length }}(y)= \\begin{cases}0, &amp; |y| \\leq L_{\\max } \\end{cases}$$ </p></li>');
  });

  test('formula blocks immediately after images should be isolated into a separate wrapper', async ({ page }) => {
    const html = await page.evaluate(() => {
      return window.__feishuBuildClipboardHtml(
        '<figure><img src="data:image/png;base64,cG5n" alt="demo" /></figure>' +
        '<p>Value Model：给出在每一个状态 $$S_t$$ 下，总奖励 $$V_t$$ 的估计。</p>' +
        '<figure><img src="data:image/png;base64,cG5n" alt="demo2" /></figure>' +
        '<ul><li><p style="margin:0;">软过长长惩罚机制： $$R_{\\text {length }}(y)= \\begin{cases}0, &amp; |y| \\leq L_{\\max } \\end{cases}$$ </p></li></ul>'
      );
    });

    expect(html).toContain('<figure><img src="data:image/png;base64,cG5n" alt="demo"></figure><div style="display:block;"><p>Value Model：给出在每一个状态 $$S_t$$ 下，总奖励 $$V_t$$ 的估计。</p></div>');
    expect(html).toContain('<figure><img src="data:image/png;base64,cG5n" alt="demo2"></figure><div style="display:block;"><ul><li><p style="margin:0;">软过长长惩罚机制： $$R_{\\text {length }}(y)= \\begin{cases}0, &amp; |y| \\leq L_{\\max } \\end{cases}$$ </p></li></ul></div>');
  });

  test('latex boundary normalizer should pad formulas adjacent to CJK text', async ({ page }) => {
    const result = await page.evaluate(() => {
      return {
        plain: window.__feishuNormalizeLatexTextBoundaries('最后只在掩码$m$下计算优势。'),
        html: window.__feishuNormalizeLatexHtmlTextNodes('<p>最后只在掩码$m$下计算优势。</p>'),
      };
    });

    expect(result.plain).toBe('最后只在掩码 $m$ 下计算优势。');
    expect(result.html).toBe('<p>最后只在掩码 $$m$$ 下计算优势。</p>');
  });

  test('html latex normalizer should keep spaces around formulas before punctuation', async ({ page }) => {
    const result = await page.evaluate(() => {
      return window.__feishuNormalizeLatexHtmlTextNodes('<p>最大化$$y_w$$和$$y_l$$的奖励函数。</p><p>返回集合$$\\mathcal{S}$$。</p>');
    });

    expect(result).toBe('<p>最大化 $$y_w$$ 和 $$y_l$$ 的奖励函数。</p><p>返回集合 $$\\mathcal{S}$$ 。</p>');
  });

  test('html sanitizer should strip noisy markup but keep rich text essentials', async ({ page }) => {
    const result = await page.evaluate(() => {
      return window.__feishuSanitizeHtmlFragment(
        '<div class="outer" data-test="1"><!--comment--><p id="x">结果$y_w$。<script>alert(1)</script><span class="tmp" data-x="1">保留</span></p><img src="data:image/png;base64,cG5n" alt="demo" class="img" /><a href="https://example.com" class="link" onclick="alert(1)">link</a></div>'
      );
    });

    expect(result).toContain('<div>');
    expect(result).toContain('<p>结果 $$y_w$$ 。保留</p>');
    expect(result).toContain('<img src="data:image/png;base64,cG5n" alt="demo">');
    expect(result).toContain('<a href="https://example.com">link</a>');
    expect(result).not.toContain('script');
    expect(result).not.toContain('comment');
    expect(result).not.toContain('class=');
    expect(result).not.toContain('data-test=');
    expect(result).not.toContain('onclick=');
  });

  test('clipboard payload builder should inline remote preview images as base64', async ({ page }) => {
    const payload = await page.evaluate(async () => {
      const originalFetch = window.fetch;
      window.fetch = () => Promise.resolve(new Response(new Blob(['png'], { type: 'image/png' }), { status: 200 }));

      try {
        return await window.__feishuBuildClipboardPayload({
          text: '公式 $x^2$',
          html: '<figure><img src="https://example.feishu.cn/space/api/box/stream/download/preview/token/?preview_type=16" alt="demo" /></figure>',
        });
      } finally {
        window.fetch = originalFetch;
      }
    });

    expect(payload.text).toBe('公式 $x^2$');
    expect(payload.html).toContain('<meta charset="utf-8">');
    expect(payload.html).toContain('data:image/png;base64,');
  });

  test('paste payload resolver should reuse prepared clipboard html without refetching images', async ({ page }) => {
    const result = await page.evaluate(async () => {
      let fetchCalled = false;
      window.fetch = () => {
        fetchCalled = true;
        return Promise.reject(new Error('fetch should not run'));
      };

      const payload = await window.__feishuResolvePastePayload({
        text: '标题\n图片',
        html: '<figure><img src="https://example.feishu.cn/space/api/box/stream/download/preview/token/?preview_type=16" alt="demo" /></figure>',
        clipboardHtml: window.__feishuBuildClipboardHtml('<figure><img src="data:image/png;base64,cG5n" alt="demo" /></figure>'),
      });

      return {
        fetchCalled,
        html: payload.html,
      };
    });

    expect(result.fetchCalled).toBe(false);
    expect(result.html).toContain('data:image/png;base64,cG5n');
  });

  test('extractFullDoc should read a non-enumerable React fiber so formulas are not lost to DOM fallback', async ({ page }) => {
    await page.setContent('<!DOCTYPE html><html><body><div data-content-editable-root="true" contenteditable="true">fallback text</div></body></html>');
    await page.evaluate(injectScript);

    const result = await page.evaluate(() => {
      const root = document.querySelector('[data-content-editable-root="true"]');
      const rootBlock = {
        record: {
          snapshot: {
            type: 'page',
          },
        },
        children: [
          {
            record: {
              snapshot: {
                type: 'text',
                text: {
                  initialAttributedTexts: {
                    attribs: { '0': '+2*0+1+2' },
                    text: { '0': '公式x完成' },
                  },
                  apool: {
                    numToAttrib: {
                      '0': ['equation', 'x^2'],
                    },
                  },
                },
              },
            },
            children: [],
          },
        ],
      };

      Object.defineProperty(root, '__reactFiber$debug', {
        configurable: true,
        enumerable: false,
        value: {
          memoizedProps: {
            editorAPI: {
              structService: {
                rootBlock,
              },
            },
          },
          return: null,
        },
      });

      return window.__feishuExtractFullDoc();
    });

    expect(result).toBeTruthy();
    expect(result.blockCount).toBe(1);
    expect(result.equationCount).toBeGreaterThan(0);
    expect(result.text).toContain('x^2');
    expect(result.text).not.toContain('fallback text');
  });

  test('direct paste dispatcher should send both html and plain text to the editor', async ({ page }) => {
    await page.setContent('<!DOCTYPE html><html><body><div class="editor-kit-container" contenteditable="true"></div></body></html>');
    await page.evaluate(injectScript);

    const result = await page.evaluate(() => {
      let received = null;
      const editor = document.querySelector('.editor-kit-container');
      editor.addEventListener('paste', (e) => {
        received = {
          text: e.clipboardData.getData('text/plain'),
          html: e.clipboardData.getData('text/html'),
        };
        e.preventDefault();
      });

      const dispatched = window.__feishuDispatchPastePayload({
        text: '标题\n公式 $x^2$',
        html: window.__feishuBuildClipboardHtml('<h1>标题</h1><p>公式 $x^2$</p>'),
      });

      return {
        dispatched,
        received,
      };
    });

    expect(result.dispatched).toBe(true);
    expect(result.received.text).toContain('公式 $x^2$');
    expect(result.received.html).toContain('<p>公式 $$x^2$$ </p>');
  });

  test('auto paste dispatcher should be disabled for formula payloads', async ({ page }) => {
    const result = await page.evaluate(() => {
      return {
        formula: window.__feishuShouldAutoDispatchPastePayload({
          text: '最后只在掩码 $m$ 下计算优势。',
          html: window.__feishuBuildClipboardHtml('<p>最后只在掩码 $$m$$ 下计算优势。</p>'),
        }),
        plain: window.__feishuShouldAutoDispatchPastePayload({
          text: '普通段落',
          html: window.__feishuBuildClipboardHtml('<p>普通段落</p>'),
        }),
      };
    });

    expect(result.formula).toBe(false);
    expect(result.plain).toBe(true);
  });

  test('editor api debugger should summarize react fiber editor api keys', async ({ page }) => {
    await page.setContent('<!DOCTYPE html><html><body><div data-content-editable-root="true"></div></body></html>');
    await page.evaluate(injectScript);

    const summary = await page.evaluate(() => {
      const root = document.querySelector('[data-content-editable-root="true"]');
      Object.defineProperty(root, '__reactFiber$debug', {
        configurable: true,
        enumerable: true,
        value: {
          memoizedProps: {
            editorAPI: {
              version: 'demo',
              insertNodes() {},
              selectionManager: {
                getSelection() {},
                currentBlockId: 'blk_1',
              },
              clipboardBridge: {
                pasteHTML() {},
                copySelection() {},
              },
              moduleService: {
                clipboardManager: {
                  copyNative() {},
                },
              },
            },
          },
        },
      });
      return window.__feishuDebugEditorAPI();
    });

    expect(summary.topLevelKeys).toContain('clipboardBridge');
    expect(summary.topLevelFunctions).toContain('insertNodes');
    expect(summary.interestingChildren.selectionManager.functionKeys).toContain('getSelection');
    expect(summary.interestingChildren.clipboardBridge.functionKeys).toContain('pasteHTML');
    expect(summary.matchedPaths.some((item) => item.path === 'editorAPI.moduleService')).toBe(true);
    expect(summary.interestingChildren.moduleService.matchedPaths.some((item) => item.path === 'editorAPI.moduleService.clipboardManager')).toBe(true);
  });

  test('path inspector should summarize nested editor objects and find matching paths', async ({ page }) => {
    await page.setContent('<!DOCTYPE html><html><body><div data-content-editable-root="true"></div></body></html>');
    await page.evaluate(injectScript);

    const result = await page.evaluate(() => {
      const root = document.querySelector('[data-content-editable-root="true"]');
      Object.defineProperty(root, '__reactFiber$debug', {
        configurable: true,
        enumerable: true,
        value: {
          memoizedProps: {
            editorAPI: {
              moduleService: {
                editor: {
                  triggerPaste() {},
                  clipboardState: 'ready',
                },
              },
              injectionService: {
                rootInjector: {
                  clipboardBridge: {
                    copySelection() {},
                  },
                },
              },
            },
          },
        },
      });

      return {
        inspect: window.__feishuInspectEditorPath('moduleService.editor'),
        find: window.__feishuFindEditorPaths('clipboard'),
      };
    });

    expect(result.inspect.ok).toBe(true);
    expect(result.inspect.path).toBe('editorAPI.moduleService.editor');
    expect(result.inspect.functionKeys).toContain('triggerPaste');
    expect(result.find.some((item) => item.path === 'editorAPI.moduleService.editor.clipboardState')).toBe(true);
  });

  test('copy capture debugger should record copy event clipboard writes', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const armed = window.__feishuCaptureNextCopy();
      document.addEventListener('copy', (e) => {
        e.clipboardData.setData('docx/text', JSON.stringify({
          rootId: 'root_1',
          payloadMap: {
            record_1: {
              snapshot: {
                type: 'bullet',
                text: {
                  apool: {
                    numToAttrib: {
                      '0': ['equation', 'x^2'],
                    },
                  },
                },
              },
            },
          },
          text: {
            initialAttributedTexts: { text: { '0': '公式' }, attribs: { '0': '*0+2' } },
            apool: { numToAttrib: { '0': ['equation', 'x^2'] } },
          },
        }));
        e.clipboardData.setData('docx/record', JSON.stringify({
          rootId: 'root_1',
          blockIds: ['block_1'],
          recordIds: ['record_1'],
          payloadMap: {
            block_1: {
              snapshot: {
                type: 'equation',
                text: {
                  apool: {
                    numToAttrib: {
                      '0': ['equation', 'x^2'],
                    },
                  },
                },
              },
            },
          },
          recordMap: {
            record_1: {
              snapshot: {
                type: 'bullet',
              },
            },
          },
        }));
        e.clipboardData.setData('text/plain', '原生文本');
        e.clipboardData.setData('text/html', '<div data-page-id="root_1"><p>原生 HTML</p><span data-lark-record-data="{&quot;rootId&quot;:&quot;root_1&quot;,&quot;type&quot;:&quot;bullet&quot;,&quot;text&quot;:{&quot;apool&quot;:{&quot;numToAttrib&quot;:{&quot;0&quot;:[&quot;equation&quot;,&quot;x^2&quot;]}}}}"></span><span data-meta-block-props="{&quot;blockId&quot;:&quot;block_1&quot;,&quot;blockType&quot;:&quot;EQUATION_BLOCK&quot;,&quot;props&quot;:{&quot;data&quot;:{&quot;latex&quot;:&quot;x^2&quot;}}}"></span></div>');
        e.preventDefault();
      }, { once: true });

      const dt = new DataTransfer();
      const event = new ClipboardEvent('copy', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      document.dispatchEvent(event);
      await new Promise((resolve) => setTimeout(resolve, 300));

      return {
        armed,
        capture: window.__feishuLastCopyCapture,
        summary: window.__feishuSummarizeLastCopyCapture(),
      };
    });

    expect(result.armed.armed).toBe(true);
    expect(result.capture.reason).toBe('setData');
    expect(result.capture.setDataCalls.map((item) => item.type)).toEqual(['docx/text', 'docx/record', 'text/plain', 'text/html']);
    expect(result.capture.copyEvents.length).toBeGreaterThan(0);
    expect(result.summary.types).toContain('docx/text');
    expect(result.summary.types).toContain('docx/record');
    expect(result.summary.docxText.ok).toBe(true);
    expect(result.summary.docxText.attribNames.equation).toBe(1);
    expect(result.summary.docxText.deepAttribNames.equation).toBeGreaterThanOrEqual(2);
    expect(result.summary.docxText.payloadMap.count).toBe(1);
    expect(result.summary.docxText.payloadMap.attribNames.equation).toBe(1);
    expect(result.summary.docxRecord.ok).toBe(true);
    expect(result.summary.docxRecord.blockIds).toBe(1);
    expect(result.summary.docxRecord.payloadMap.attribNames.equation).toBe(1);
    expect(result.summary.htmlRecordData.ok).toBe(true);
    expect(result.summary.htmlRecordData.count).toBe(1);
    expect(result.summary.htmlRecordData.sampleRecords[0].attribNames.equation).toBe(1);
    expect(result.summary.htmlMetaBlockProps.ok).toBe(true);
    expect(result.summary.htmlMetaBlockProps.count).toBe(1);
    expect(result.summary.htmlMetaBlockProps.blockTypes.EQUATION_BLOCK).toBe(1);
    expect(result.summary.htmlMetaBlockProps.sampleBlocks[0].dataPreview).toContain('x^2');
  });

  test('editor insertion path should insert non-formula html fragments directly', async ({ page }) => {
    await page.setContent('<!DOCTYPE html><html><body><div class="editor-kit-container" contenteditable="true"></div></body></html>');
    await page.evaluate(injectScript);

    const result = await page.evaluate(() => {
      const editor = document.querySelector('.editor-kit-container');
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);

      const inserted = window.__feishuInsertPayloadIntoEditor({
        text: '标题\n正文',
        html: window.__feishuBuildClipboardHtml('<h1>标题</h1><p>正文</p><figure><img src="data:image/png;base64,cG5n" alt="demo" /></figure>'),
      });

      return {
        inserted,
        html: editor.innerHTML,
        text: editor.textContent,
      };
    });

    expect(result.inserted).toBe(true);
    expect(result.html).toContain('<h1>标题</h1>');
    expect(result.html).toContain('正文');
    expect(result.html).toContain('data:image/png;base64,cG5n');
    expect(result.text).toContain('正文');
  });

  test('editor insertion path should skip formula payloads so Feishu paste parsing can run', async ({ page }) => {
    await page.setContent('<!DOCTYPE html><html><body><div class="editor-kit-container" contenteditable="true"></div></body></html>');
    await page.evaluate(injectScript);

    const result = await page.evaluate(() => {
      return {
        shouldParse: window.__feishuPayloadRequiresPasteParsing({
          text: '最后只在掩码 $m$ 下计算优势。',
          html: window.__feishuBuildClipboardHtml('<p>最后只在掩码 $$m$$ 下计算优势。</p>'),
        }),
        inserted: window.__feishuInsertPayloadIntoEditor({
          text: '最后只在掩码 $m$ 下计算优势。',
          html: window.__feishuBuildClipboardHtml('<p>最后只在掩码 $$m$$ 下计算优势。</p>'),
        }),
      };
    });

    expect(result.shouldParse).toBe(true);
    expect(result.inserted).toBe(false);
  });

  test('clipboard writer should publish html and plain text together in one copy operation', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    const clipboard = await page.evaluate(async () => {
      let writtenItems = [];
      let execCalled = false;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          write(items) {
            writtenItems = items;
            return Promise.resolve();
          },
        },
      });
      window.ClipboardItem = class ClipboardItem {
        constructor(items) {
          this._items = items;
          this.types = Object.keys(items);
        }

        getType(type) {
          return Promise.resolve(this._items[type]);
        }
      };
      document.execCommand = () => {
        execCalled = true;
        return true;
      };

      await window.__feishuWriteClipboardPayload({
        text: '标题\n公式 $x^2$',
        html: window.__feishuBuildClipboardHtml(
          '<h1>标题</h1><p>公式 $x^2$</p><figure><img src="data:image/png;base64,cG5n" alt="demo" /></figure>'
        ),
      });

      const item = writtenItems[0];
      const result = { types: item.types };

      if (item.types.includes('text/plain')) {
        result.text = await (await item.getType('text/plain')).text();
      }
      if (item.types.includes('text/html')) {
        result.html = await (await item.getType('text/html')).text();
      }
      result.execCalled = execCalled;

      return result;
    });

    expect(clipboard.types).toContain('text/plain');
    expect(clipboard.types).toContain('text/html');
    expect(clipboard.execCalled).toBe(false);
    expect(clipboard.text).toContain('公式 $x^2$');
    expect(clipboard.html).toContain('<!--StartFragment-->');
    expect(clipboard.html).toContain('<p>公式 $$x^2$$ </p>');
    expect(clipboard.html).toContain('<img src="data:image/png;base64,cG5n" alt="demo"');
  });
});
