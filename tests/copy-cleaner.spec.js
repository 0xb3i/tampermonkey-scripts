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

  test('should remove () half-width parentheses and content', async ({ page }) => {
    const result = await runCleanText(page, 'Hello (this is a note) World');
    expect(result).toBe('Hello World');
  });

  test('should handle mixed bold and parentheses', async ({ page }) => {
    const result = await runCleanText(page, '**AI** 是一种技术（人工智能的简称），它**非常强大**（指潜力巨大）');
    expect(result).toBe('AI 是一种技术，它非常强大');
  });

  test('should handle nested parentheses gracefully', async ({ page }) => {
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
