import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { join } from 'path';

const SCRIPT_PATH = join(__dirname, '..', 'scripts', 'copy-cleaner.user.js');
const SCRIPT_CONTENT = readFileSync(SCRIPT_PATH, 'utf-8');

function extractCoreLogic(scriptContent) {
  const match = scriptContent.match(/\(function\s*\(\)\s*\{[\s\S]*\}\)\(\);/);
  return match ? match[0] : scriptContent;
}

const coreScript = extractCoreLogic(SCRIPT_CONTENT);

test.describe('Copy Cleaner - cleanText logic', () => {
  test.beforeEach(async ({ page }) => {
    await page.setContent('<!DOCTYPE html><html><body></body></html>');
    await page.evaluate(coreScript);
  });

  async function runCleanText(page, input) {
    return page.evaluate((text) => {
      return window.__copyCleanerCleanText(text);
    }, input);
  }

  test('should remove ** bold markers', async ({ page }) => {
    const result = await runCleanText(page, '**Hello World**');
    expect(result).toBe('Hello World');
  });

  test('should remove （） full-width parentheses and content', async ({ page }) => {
    const result = await runCleanText(page, '你好（这是一个注释）世界');
    expect(result).toBe('你好世界');
  });

  test('should NOT remove () half-width parentheses', async ({ page }) => {
    const result = await runCleanText(page, 'Hello (this is a note) World');
    expect(result).toBe('Hello (this is a note) World');
  });

  test('should handle mixed bold and Chinese parentheses', async ({ page }) => {
    const result = await runCleanText(page, '**AI** 是一种技术（人工智能的简称），它**非常强大**（指潜力巨大）');
    expect(result).toBe('AI 是一种技术，它非常强大');
  });

  test('should handle nested Chinese parentheses gracefully', async ({ page }) => {
    const result = await runCleanText(page, '外层（内层（嵌套）内容）剩余');
    expect(result).toBe('外层剩余');
  });

  test('should not modify clean text', async ({ page }) => {
    const result = await runCleanText(page, '这是一段干净的文本');
    expect(result).toBe('这是一段干净的文本');
  });

  test('should handle multiple ** markers in one line', async ({ page }) => {
    const result = await runCleanText(page, '**第一**和**第二**和**第三**');
    expect(result).toBe('第一和第二和第三');
  });

  test('should handle real AI-style output', async ({ page }) => {
    const input = '**深度学习**（Deep Learning）是机器学习的一个分支，它使用**多层神经网络**（Multi-layer Neural Networks）来学习数据的表示。';
    const result = await runCleanText(page, input);
    expect(result).toBe('深度学习是机器学习的一个分支，它使用多层神经网络来学习数据的表示。');
  });

  test('should remove Chinese quotation marks \u201C\u201D', async ({ page }) => {
    const result = await runCleanText(page, '\u201C深度学习\u201D是一种技术');
    expect(result).toBe('深度学习是一种技术');
  });

  test('should remove English double quotes', async ({ page }) => {
    const result = await runCleanText(page, '"Hello World" is a phrase');
    expect(result).toBe('Hello World is a phrase');
  });

  test('should remove Chinese single quotation marks \u2018\u2019', async ({ page }) => {
    const result = await runCleanText(page, '\u2018人工智能\u2019发展迅速');
    expect(result).toBe('人工智能发展迅速');
  });

  test('should remove English single quotes', async ({ page }) => {
    const result = await runCleanText(page, "it's a 'great' day");
    expect(result).toBe('its a great day');
  });

  test('should handle mixed quotes, bold and Chinese parentheses', async ({ page }) => {
    const input = '**\u201C深度学习\u201D**（Deep Learning）是\u201C人工智能\u201D的核心技术';
    const result = await runCleanText(page, input);
    expect(result).toBe('深度学习是人工智能的核心技术');
  });

  test('should preserve parentheses inside inline LaTeX', async ({ page }) => {
    const input = '梯度下降公式 $\\nabla_\\theta J(\\theta)$ 是核心';
    const result = await runCleanText(page, input);
    expect(result).toBe('梯度下降公式 $\\nabla_\\theta J(\\theta)$ 是核心');
  });

  test('should preserve parentheses inside display LaTeX', async ({ page }) => {
    const input = '贝叶斯定理：$$P(A|B) = \\frac{P(B|A) \\cdot P(A)}{P(B)}$$ 其中 P(A) 是先验';
    const result = await runCleanText(page, input);
    expect(result).toBe('贝叶斯定理： $$P(A|B) = \\frac{P(B|A) \\cdot P(A)}{P(B)}$$ 其中 P(A) 是先验');
  });

  test('should clean plain text but preserve LaTeX in mixed content', async ({ page }) => {
    const input = '**梯度下降**（Gradient Descent）的公式为 $\\nabla_\\theta J(\\theta)$，它是**优化**（Optimization）的基础';
    const result = await runCleanText(page, input);
    expect(result).toBe('梯度下降的公式为 $\\nabla_\\theta J(\\theta)$ ，它是优化的基础');
  });

  test('should preserve LaTeX fractions with parentheses', async ({ page }) => {
    const input = '$$\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}$$';
    const result = await runCleanText(page, input);
    expect(result).toBe('$$\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}$$');
  });

  test('should add space before $ when adjacent to text', async ({ page }) => {
    const result = await runCleanText(page, '公式$x^2$在这里');
    expect(result).toBe('公式 $x^2$ 在这里');
  });

  test('should add space before $ when adjacent to Chinese punctuation', async ({ page }) => {
    const result = await runCleanText(page, '这是一个公式。$x^2$这是公式。');
    expect(result).toBe('这是一个公式。 $x^2$ 这是公式。');
  });

  test('should add space around $$ when adjacent to text', async ({ page }) => {
    const result = await runCleanText(page, '结果$$E=mc^2$$正确');
    expect(result).toBe('结果 $$E=mc^2$$ 正确');
  });

  test('should not add extra space when space already exists', async ({ page }) => {
    const result = await runCleanText(page, '公式 $x^2$ 在这里');
    expect(result).toBe('公式 $x^2$ 在这里');
  });

  test('should handle multiple LaTeX with punctuation', async ({ page }) => {
    const result = await runCleanText(page, '设$a=1$，则$b=2$。');
    expect(result).toBe('设 $a=1$ ，则 $b=2$ 。');
  });
});

test.describe('Copy Cleaner - copy event integration', () => {
  test('should intercept copy event and clean clipboard', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    await page.setContent(`
      <!DOCTYPE html>
      <html><body>
        <div id="source">**Hello**（World）</div>
        <textarea id="target"></textarea>
      </body></html>
    `);

    await page.evaluate(coreScript);

    await page.click('#source');
    await page.keyboard.press('Control+a');

    const clipboardText = await page.evaluate(async () => {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('source'));
      selection.removeAllRanges();
      selection.addRange(range);

      document.execCommand('copy');

      try {
        return await navigator.clipboard.readText();
      } catch {
        return null;
      }
    });

    if (clipboardText !== null) {
      expect(clipboardText).toBe('Hello');
    }
  });

  test('should preserve unordered list markers when manually copying cleaned text', async ({ page, context }) => {
    await page.setContent(`
      <!DOCTYPE html>
      <html><body>
        <div id="source" tabindex="0">
          <ul>
            <li>**第一项**（注释）</li>
            <li>**第二项**（说明）</li>
          </ul>
        </div>
      </body></html>
    `);

    await page.evaluate(coreScript);
    await page.evaluate(() => {
      window.__copiedText = null;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText(text) {
            window.__copiedText = text;
            return Promise.resolve();
          }
        }
      });
    });

    await page.focus('#source');
    await page.evaluate(() => {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('source'));
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.keyboard.press('Control+c');
    await page.waitForTimeout(100);

    const clipboardText = await page.evaluate(() => window.__copiedText);
    expect(clipboardText).toBe('- 第一项\n- 第二项');
  });

  test('should preserve unordered list markers in copy event path', async ({ page }) => {
    await page.setContent(`
      <!DOCTYPE html>
      <html><body>
        <div id="source">
          <ul>
            <li>**第一项**（注释）</li>
            <li>**第二项**（说明）</li>
          </ul>
        </div>
      </body></html>
    `);

    await page.evaluate(coreScript);

    const copiedText = await page.evaluate(() => {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('source'));
      selection.removeAllRanges();
      selection.addRange(range);

      const dataTransfer = new DataTransfer();
      const copyEvent = new Event('copy', { bubbles: true, cancelable: true });
      Object.defineProperty(copyEvent, 'clipboardData', { value: dataTransfer });
      document.dispatchEvent(copyEvent);
      return dataTransfer.getData('text/plain');
    });

    expect(copiedText).toBe('- 第一项\n- 第二项');
  });

  test('should override site copy handler registered on window capture phase', async ({ page }) => {
    await page.setContent(`
      <!DOCTYPE html>
      <html><body>
        <div id="source">**第一项**（注释）</div>
      </body></html>
    `);

    await page.evaluate(coreScript);
    await page.evaluate(() => {
      window.addEventListener('copy', function (e) {
        e.preventDefault();
        e.stopImmediatePropagation();
        e.clipboardData.setData('text/plain', '**第一项**（注释）');
      }, true);
    });

    const copiedText = await page.evaluate(() => {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('source'));
      selection.removeAllRanges();
      selection.addRange(range);

      const dataTransfer = new DataTransfer();
      const copyEvent = new Event('copy', { bubbles: true, cancelable: true });
      Object.defineProperty(copyEvent, 'clipboardData', { value: dataTransfer });
      document.dispatchEvent(copyEvent);
      return dataTransfer.getData('text/plain');
    });

    expect(copiedText).toBe('第一项');
  });

  test('should keep surrounding text boundaries for unordered lists with latex', async ({ page }) => {
    await page.setContent(`
      <!DOCTYPE html>
      <html><body>
        <div id="source" tabindex="0">
          导语
          <ul>
            <li>**公式** $x^2$（说明）</li>
          </ul>
          结尾
        </div>
      </body></html>
    `);

    await page.evaluate(coreScript);
    await page.evaluate(() => {
      window.__copiedText = null;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText(text) {
            window.__copiedText = text;
            return Promise.resolve();
          }
        }
      });
    });

    await page.focus('#source');
    await page.evaluate(() => {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('source'));
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.keyboard.press('Control+c');
    await page.waitForTimeout(100);

    const clipboardText = await page.evaluate(() => window.__copiedText);
    expect(clipboardText).toContain('导语');
    expect(clipboardText).toContain('- 公式 $x^2$');
    expect(clipboardText).toContain('结尾');
  });

  test('should preserve multiple unordered latex list markers in order', async ({ page }) => {
    await page.setContent(`
      <!DOCTYPE html>
      <html><body>
        <div id="source" tabindex="0">
          导语
          <ul>
            <li><span class="katex"><span class="katex-mathml"><math><semantics><annotation encoding="application/x-tex">x^2</annotation></semantics></math></span><span class="katex-html" aria-hidden="true">x^2</span></span> 第一项（注释）</li>
            <li><span class="katex"><span class="katex-mathml"><math><semantics><annotation encoding="application/x-tex">y^2</annotation></semantics></math></span><span class="katex-html" aria-hidden="true">y^2</span></span> 第二项（说明）</li>
          </ul>
          结尾
        </div>
      </body></html>
    `);

    await page.evaluate(coreScript);
    await page.evaluate(() => {
      window.__copiedText = null;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText(text) {
            window.__copiedText = text;
            return Promise.resolve();
          }
        }
      });
    });

    await page.focus('#source');
    await page.evaluate(() => {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('source'));
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.keyboard.press('Control+c');
    await page.waitForTimeout(100);

    const clipboardText = await page.evaluate(() => window.__copiedText);
    expect(clipboardText).toBe('导语\n- $x^2$ 第一项\n- $y^2$ 第二项\n结尾');
  });

  test('should preserve unordered list markers when surrounding text repeats list content', async ({ page }) => {
    await page.setContent(`
      <!DOCTYPE html>
      <html><body>
        <div id="source" tabindex="0">
          第一项
          <ul>
            <li>**第一项**（注释）</li>
            <li>**第二项**（说明）</li>
          </ul>
          第一项
        </div>
      </body></html>
    `);

    await page.evaluate(coreScript);
    await page.evaluate(() => {
      window.__copiedText = null;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText(text) {
            window.__copiedText = text;
            return Promise.resolve();
          }
        }
      });
    });

    await page.focus('#source');
    await page.evaluate(() => {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('source'));
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.keyboard.press('Control+c');
    await page.waitForTimeout(100);

    const clipboardText = await page.evaluate(() => window.__copiedText);
    expect(clipboardText).toBe('第一项\n- 第一项\n- 第二项\n第一项');
  });

  test('should preserve raw latex inside structured list content', async ({ page }) => {
    await page.setContent(`
      <!DOCTYPE html>
      <html><body>
        <div id="source" tabindex="0">
          <ul>
            <li>公式 $f（x）$（注释）</li>
          </ul>
        </div>
      </body></html>
    `);

    await page.evaluate(coreScript);
    await page.evaluate(() => {
      window.__copiedText = null;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText(text) {
            window.__copiedText = text;
            return Promise.resolve();
          }
        }
      });
    });

    await page.focus('#source');
    await page.evaluate(() => {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('source'));
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.keyboard.press('Control+c');
    await page.waitForTimeout(100);

    const clipboardText = await page.evaluate(() => window.__copiedText);
    expect(clipboardText).toBe('- 公式 $f（x）$');
  });

  test('should preserve multiline latex inside structured list content', async ({ page }) => {
    await page.setContent(`
      <!DOCTYPE html>
      <html><body>
        <div id="source" tabindex="0">
          <ul>
            <li>$$a
b$$</li>
          </ul>
        </div>
      </body></html>
    `);

    await page.evaluate(coreScript);
    await page.evaluate(() => {
      window.__copiedText = null;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText(text) {
            window.__copiedText = text;
            return Promise.resolve();
          }
        }
      });
    });

    await page.focus('#source');
    await page.evaluate(() => {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('source'));
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.keyboard.press('Control+c');
    await page.waitForTimeout(100);

    const clipboardText = await page.evaluate(() => window.__copiedText);
    expect(clipboardText).toBe('- $$a\nb$$');
  });

  test('should preserve simple ordered list numbering', async ({ page }) => {
    await page.setContent(`
      <!DOCTYPE html>
      <html><body>
        <div id="source" tabindex="0">
          <ol>
            <li>**第一项**（注释）</li>
            <li>**第二项**（说明）</li>
          </ol>
        </div>
      </body></html>
    `);

    await page.evaluate(coreScript);
    await page.evaluate(() => {
      window.__copiedText = null;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText(text) {
            window.__copiedText = text;
            return Promise.resolve();
          }
        }
      });
    });

    await page.focus('#source');
    await page.evaluate(() => {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('source'));
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.keyboard.press('Control+c');
    await page.waitForTimeout(100);

    const clipboardText = await page.evaluate(() => window.__copiedText);
    expect(clipboardText).toBe('1. 第一项\n2. 第二项');
  });

  test('should preserve ordered list numbering when manually copying cleaned text', async ({ page }) => {
    await page.setContent(`
      <!DOCTYPE html>
      <html><body>
        <div id="source" tabindex="0">
          <ol>
            <li>**第一项**（注释）</li>
            <li>**第二项**（说明）</li>
            <li>**第三项**（备注）</li>
          </ol>
        </div>
      </body></html>
    `);

    await page.evaluate(coreScript);
    await page.evaluate(() => {
      window.__copiedText = null;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText(text) {
            window.__copiedText = text;
            return Promise.resolve();
          }
        }
      });
    });

    await page.focus('#source');
    await page.evaluate(() => {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('source'));
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.keyboard.press('Control+c');
    await page.waitForTimeout(100);

    const clipboardText = await page.evaluate(() => window.__copiedText);
    expect(clipboardText).toBe('1. 第一项\n2. 第二项\n3. 第三项');
  });

  test('should preserve ordered list numbering in copy event path', async ({ page }) => {
    await page.setContent(`
      <!DOCTYPE html>
      <html><body>
        <div id="source">
          <ol>
            <li>**第一项**（注释）</li>
            <li>**第二项**（说明）</li>
            <li>**第三项**（备注）</li>
          </ol>
        </div>
      </body></html>
    `);

    await page.evaluate(coreScript);

    const copiedText = await page.evaluate(() => {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('source'));
      selection.removeAllRanges();
      selection.addRange(range);

      const dataTransfer = new DataTransfer();
      const copyEvent = new Event('copy', { bubbles: true, cancelable: true });
      Object.defineProperty(copyEvent, 'clipboardData', { value: dataTransfer });
      document.dispatchEvent(copyEvent);
      return dataTransfer.getData('text/plain');
    });

    expect(copiedText).toBe('1. 第一项\n2. 第二项\n3. 第三项');
  });

  test('should preserve ordered latex list numbering without blank lines', async ({ page }) => {
    await page.setContent(`
      <!DOCTYPE html>
      <html><body>
        <div id="source" tabindex="0">
          导语
          <ol start="2">
            <li><span class="katex"><span class="katex-mathml"><math><semantics><annotation encoding="application/x-tex">x^2</annotation></semantics></math></span><span class="katex-html" aria-hidden="true">x^2</span></span> 第一项（注释）</li>
            <li><span class="katex"><span class="katex-mathml"><math><semantics><annotation encoding="application/x-tex">y^2</annotation></semantics></math></span><span class="katex-html" aria-hidden="true">y^2</span></span> 第二项（说明）</li>
          </ol>
          结尾
        </div>
      </body></html>
    `);

    await page.evaluate(coreScript);
    await page.evaluate(() => {
      window.__copiedText = null;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText(text) {
            window.__copiedText = text;
            return Promise.resolve();
          }
        }
      });
    });

    await page.focus('#source');
    await page.evaluate(() => {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('source'));
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.keyboard.press('Control+c');
    await page.waitForTimeout(100);

    const clipboardText = await page.evaluate(() => window.__copiedText);
    expect(clipboardText).toBe('导语\n2. $x^2$ 第一项\n3. $y^2$ 第二项\n结尾');
  });

  test('should preserve preformatted text adjacent to lists', async ({ page }) => {
    await page.setContent(`
      <!DOCTYPE html>
      <html><body>
        <div id="source" tabindex="0">
          <ul>
            <li>**第一项**（注释）</li>
          </ul>
          <pre>  const answer = 42;
    return answer;</pre>
        </div>
      </body></html>
    `);

    await page.evaluate(coreScript);
    await page.evaluate(() => {
      window.__copiedText = null;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText(text) {
            window.__copiedText = text;
            return Promise.resolve();
          }
        }
      });
    });

    await page.focus('#source');
    await page.evaluate(() => {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('source'));
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.keyboard.press('Control+c');
    await page.waitForTimeout(100);

    const clipboardText = await page.evaluate(() => window.__copiedText);
    expect(clipboardText).toBe('- 第一项\n  const answer = 42;\n    return answer;');
  });

  test('should preserve heading markers when manually copying cleaned text', async ({ page }) => {
    await page.setContent(`
      <!DOCTYPE html>
      <html><body>
        <div id="source" tabindex="0">
          <h2>**章节标题**（注释）</h2>
          <p>段落正文</p>
        </div>
      </body></html>
    `);

    await page.evaluate(coreScript);
    await page.evaluate(() => {
      window.__copiedText = null;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText(text) {
            window.__copiedText = text;
            return Promise.resolve();
          }
        }
      });
    });

    await page.focus('#source');
    await page.evaluate(() => {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('source'));
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.keyboard.press('Control+c');
    await page.waitForTimeout(100);

    const clipboardText = await page.evaluate(() => window.__copiedText);
    expect(clipboardText).toBe('## 章节标题\n段落正文');
  });

  test('should preserve blockquote markers in copy event path', async ({ page }) => {
    await page.setContent(`
      <!DOCTYPE html>
      <html><body>
        <div id="source">
          <blockquote>
            <p>**引用内容**（注释）</p>
            <p>第二行</p>
          </blockquote>
        </div>
      </body></html>
    `);

    await page.evaluate(coreScript);

    const copiedText = await page.evaluate(() => {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('source'));
      selection.removeAllRanges();
      selection.addRange(range);

      const dataTransfer = new DataTransfer();
      const copyEvent = new Event('copy', { bubbles: true, cancelable: true });
      Object.defineProperty(copyEvent, 'clipboardData', { value: dataTransfer });
      document.dispatchEvent(copyEvent);
      return dataTransfer.getData('text/plain');
    });

    expect(copiedText).toBe('> 引用内容\n> 第二行');
  });

  test('should preserve code fences and thematic breaks when manually copying cleaned text', async ({ page }) => {
    await page.setContent(`
      <!DOCTYPE html>
      <html><body>
        <div id="source" tabindex="0">
          <pre><code>const answer = 42;\nreturn answer;</code></pre>
          <hr>
          <p>收尾</p>
        </div>
      </body></html>
    `);

    await page.evaluate(coreScript);
    await page.evaluate(() => {
      window.__copiedText = null;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText(text) {
            window.__copiedText = text;
            return Promise.resolve();
          }
        }
      });
    });

    await page.focus('#source');
    await page.evaluate(() => {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('source'));
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.keyboard.press('Control+c');
    await page.waitForTimeout(100);

    const clipboardText = await page.evaluate(() => window.__copiedText);
    expect(clipboardText).toBe('```\nconst answer = 42;\nreturn answer;\n```\n---\n收尾');
  });

  test('should preserve code block literals without cleaning inside fences', async ({ page }) => {
    await page.setContent(`
      <!DOCTYPE html>
      <html><body>
        <div id="source" tabindex="0">
          <pre><code>const label = "**标题**";
const note = '（保留）';</code></pre>
        </div>
      </body></html>
    `);

    await page.evaluate(coreScript);
    await page.evaluate(() => {
      window.__copiedText = null;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText(text) {
            window.__copiedText = text;
            return Promise.resolve();
          }
        }
      });
    });

    await page.focus('#source');
    await page.evaluate(() => {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('source'));
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.keyboard.press('Control+c');
    await page.waitForTimeout(100);

    const clipboardText = await page.evaluate(() => window.__copiedText);
    expect(clipboardText).toBe('```\nconst label = "**标题**";\nconst note = \'（保留）\';\n```');
  });

  test('should preserve code block literals through patched clipboard writeText path', async ({ page }) => {
    await page.setContent(`
      <!DOCTYPE html>
      <html><body>
        <div id="source" tabindex="0">
          <pre><code>const label = "**标题**";
const note = '（保留）';</code></pre>
        </div>
      </body></html>
    `);

    await page.evaluate(() => {
      window.__copiedText = null;
      function ClipboardMock() {}
      ClipboardMock.prototype.writeText = function (text) {
        window.__copiedText = text;
        return Promise.resolve();
      };
      window.Clipboard = ClipboardMock;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: new ClipboardMock()
      });
    });
    await page.evaluate(coreScript);

    await page.focus('#source');
    await page.evaluate(() => {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('source'));
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.keyboard.press('Control+c');
    await page.waitForTimeout(100);

    const clipboardText = await page.evaluate(() => window.__copiedText);
    expect(clipboardText).toBe('```\nconst label = "**标题**";\nconst note = \'（保留）\';\n```');
  });

  test('should not reclean structured markdown generated from rendered latex selections', async ({ page }) => {
    await page.setContent(`
      <!DOCTYPE html>
      <html><body>
        <div id="source" tabindex="0">
          <blockquote>
            <p><span class="katex"><span class="katex-mathml"><math><semantics><annotation encoding="application/x-tex">x^2</annotation></semantics></math></span><span class="katex-html" aria-hidden="true">x^2</span></span> 公式（注释）</p>
            <pre><code>const label = "**保留**";</code></pre>
          </blockquote>
        </div>
      </body></html>
    `);

    await page.evaluate(() => {
      window.__copiedText = null;
      function ClipboardMock() {}
      ClipboardMock.prototype.writeText = function (text) {
        window.__copiedText = text;
        return Promise.resolve();
      };
      window.Clipboard = ClipboardMock;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: new ClipboardMock()
      });
    });
    await page.evaluate(coreScript);

    await page.focus('#source');
    await page.evaluate(() => {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('source'));
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.keyboard.press('Control+c');
    await page.waitForTimeout(100);

    const clipboardText = await page.evaluate(() => window.__copiedText);
    expect(clipboardText).toBe('> $x^2$ 公式\n> ```\n> const label = "**保留**";\n> ```');
  });

  test('should preserve nested structure inside blockquotes', async ({ page }) => {
    await page.setContent(`
      <!DOCTYPE html>
      <html><body>
        <div id="source">
          <blockquote>
            <h3>**引用标题**（注释）</h3>
            <pre><code>const x = 1;</code></pre>
          </blockquote>
        </div>
      </body></html>
    `);

    await page.evaluate(coreScript);

    const copiedText = await page.evaluate(() => {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('source'));
      selection.removeAllRanges();
      selection.addRange(range);

      const dataTransfer = new DataTransfer();
      const copyEvent = new Event('copy', { bubbles: true, cancelable: true });
      Object.defineProperty(copyEvent, 'clipboardData', { value: dataTransfer });
      document.dispatchEvent(copyEvent);
      return dataTransfer.getData('text/plain');
    });

    expect(copiedText).toBe('> ### 引用标题\n> ```\n> const x = 1;\n> ```');
  });

  test('should preserve tables as markdown when manually copying cleaned text', async ({ page }) => {
    await page.setContent(`
      <!DOCTYPE html>
      <html><body>
        <div id="source" tabindex="0">
          <table>
            <thead>
              <tr><th>列A</th><th>列B</th></tr>
            </thead>
            <tbody>
              <tr><td>**值1**（注释）</td><td>普通文本</td></tr>
              <tr><td><code>a|b</code></td><td>换行<br>内容</td></tr>
            </tbody>
          </table>
        </div>
      </body></html>
    `);

    await page.evaluate(coreScript);
    await page.evaluate(() => {
      window.__copiedText = null;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText(text) {
            window.__copiedText = text;
            return Promise.resolve();
          }
        }
      });
    });

    await page.focus('#source');
    await page.evaluate(() => {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('source'));
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.keyboard.press('Control+c');
    await page.waitForTimeout(100);

    const clipboardText = await page.evaluate(() => window.__copiedText);
    expect(clipboardText).toBe('| 列A | 列B |\n| --- | --- |\n| 值1 | 普通文本 |\n| `a\\|b` | 换行<br>内容 |');
  });

  test('should preserve headerless tables without promoting first row to header', async ({ page }) => {
    await page.setContent(`
      <!DOCTYPE html>
      <html><body>
        <div id="source" tabindex="0">
          <table>
            <tbody>
              <tr><td>A1</td><td>B1</td></tr>
              <tr><td>A2</td><td>B2</td></tr>
            </tbody>
          </table>
        </div>
      </body></html>
    `);

    await page.evaluate(coreScript);
    await page.evaluate(() => {
      window.__copiedText = null;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText(text) {
            window.__copiedText = text;
            return Promise.resolve();
          }
        }
      });
    });

    await page.focus('#source');
    await page.evaluate(() => {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('source'));
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.keyboard.press('Control+c');
    await page.waitForTimeout(100);

    const clipboardText = await page.evaluate(() => window.__copiedText);
    expect(clipboardText).toBe('|  |  |\n| --- | --- |\n| A1 | B1 |\n| A2 | B2 |');
  });

  test('should use longer code fences when code contains triple backticks', async ({ page }) => {
    await page.setContent(`
      <!DOCTYPE html>
      <html><body>
        <div id="source" tabindex="0">
          <pre><code>console.log(&quot;${'```'}&quot;);</code></pre>
        </div>
      </body></html>
    `);

    await page.evaluate(coreScript);
    await page.evaluate(() => {
      window.__copiedText = null;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText(text) {
            window.__copiedText = text;
            return Promise.resolve();
          }
        }
      });
    });

    await page.focus('#source');
    await page.evaluate(() => {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('source'));
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.keyboard.press('Control+c');
    await page.waitForTimeout(100);

    const clipboardText = await page.evaluate(() => window.__copiedText);
    expect(clipboardText).toBe('````\nconsole.log("```");\n````');
  });

  test('should preserve ordered list numbering when surrounding text repeats list content', async ({ page }) => {
    await page.setContent(`
      <!DOCTYPE html>
      <html><body>
        <div id="source" tabindex="0">
          第一项
          <ol start="3">
            <li>**第一项**（注释）</li>
            <li>**第二项**（说明）</li>
          </ol>
          第二项
        </div>
      </body></html>
    `);

    await page.evaluate(coreScript);
    await page.evaluate(() => {
      window.__copiedText = null;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText(text) {
            window.__copiedText = text;
            return Promise.resolve();
          }
        }
      });
    });

    await page.focus('#source');
    await page.evaluate(() => {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('source'));
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.keyboard.press('Control+c');
    await page.waitForTimeout(100);

    const clipboardText = await page.evaluate(() => window.__copiedText);
    expect(clipboardText).toBe('第一项\n3. 第一项\n4. 第二项\n第二项');
  });
});
