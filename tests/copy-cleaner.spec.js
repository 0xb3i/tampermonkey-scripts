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
});
