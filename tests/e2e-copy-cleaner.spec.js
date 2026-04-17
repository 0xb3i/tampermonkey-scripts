import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { join } from 'path';

const SCRIPT_PATH = join(__dirname, '..', 'scripts', 'copy-cleaner.user.js');
const SCRIPT_CONTENT = readFileSync(SCRIPT_PATH, 'utf-8');

function extractInjectableScript(scriptContent) {
  const match = scriptContent.match(/\(function\s*\(\)\s*\{[\s\S]*\}\)\(\);/);
  return match ? match[0] : scriptContent;
}

const injectScript = extractInjectableScript(SCRIPT_CONTENT);

const FIXTURE_PATH = join(__dirname, 'fixtures', 'ai-chat.html');

test.describe('E2E - Copy Cleaner on simulated AI website', () => {
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(injectScript);
  });

  test('clicking copy button should put cleaned text on clipboard', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(`file://${FIXTURE_PATH}`);

    await page.click('#msg1 .copy-btn');
    await page.waitForTimeout(200);

    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());

    expect(clipboardText).toBe('深度学习是机器学习的一个分支，它使用多层神经网络来学习数据的表示。');
    expect(clipboardText).not.toContain('**');
    expect(clipboardText).not.toContain('（');
    expect(clipboardText).not.toContain('）');
  });

  test('copy button on complex AI message should clean all markers', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(`file://${FIXTURE_PATH}`);

    await page.click('#msg2 .copy-btn');
    await page.waitForTimeout(200);

    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());

    expect(clipboardText).toBe('大语言模型是一种基于Transformer架构的深度学习模型。它通过自监督学习在海量文本上进行预训练。');
  });

  test('clean text should pass through unchanged via copy button', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(`file://${FIXTURE_PATH}`);

    await page.click('#msg3 .copy-btn');
    await page.waitForTimeout(200);

    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());

    expect(clipboardText).toBe('这是一段没有加粗和括号的干净文本，应该原样复制。');
  });

  test('mixed full-width and half-width parentheses should both be removed', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(`file://${FIXTURE_PATH}`);

    await page.click('#msg4 .copy-btn');
    await page.waitForTimeout(200);

    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());

    expect(clipboardText).toBe('强化学习中，智能体通过试错来学习最优策略。');
  });

  test('Ctrl+C on selected text should clean clipboard', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(`file://${FIXTURE_PATH}`);

    const contentEl = page.locator('#msg1 .content');
    await contentEl.click();
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Control+c');
    await page.waitForTimeout(200);

    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());

    expect(clipboardText).not.toContain('**');
    expect(clipboardText).not.toContain('Deep Learning');
  });

  test('clipboard content after copy button can be pasted as clean text', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(`file://${FIXTURE_PATH}`);

    await page.click('#msg1 .copy-btn');
    await page.waitForTimeout(200);

    const clipboardText = await page.evaluate(async () => {
      const text = await navigator.clipboard.readText();
      document.getElementById('paste-area').value = text;
      return text;
    });

    expect(clipboardText).toBe('深度学习是机器学习的一个分支，它使用多层神经网络来学习数据的表示。');

    const textareaValue = await page.evaluate(() => document.getElementById('paste-area').value);
    expect(textareaValue).toBe(clipboardText);
  });

  test('copy button visual feedback should still work', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(`file://${FIXTURE_PATH}`);

    const btn = page.locator('#msg1 .copy-btn');
    await btn.click();

    await expect(btn).toHaveText('已复制');
    await expect(btn).toHaveClass(/copied/);
  });
});
