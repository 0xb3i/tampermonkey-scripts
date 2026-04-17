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

const FIXTURE_PATH = join(__dirname, 'fixtures', 'ai-chat-math.html');

test.describe('LaTeX extraction - E2E with KaTeX page', () => {
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(injectScript);
  });

  test('should extract inline LaTeX from KaTeX via extractLatex API', async ({ page }) => {
    await page.goto(`file://${FIXTURE_PATH}`);
    await page.waitForSelector('.katex');

    const result = await page.evaluate(() => {
      var el = document.querySelector('#msg2 .content');
      var selection = window.getSelection();
      var range = document.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);

      return window.__copyCleanerExtractLatex(selection);
    });

    expect(result).not.toBeNull();
    expect(result).toContain('$e^{i\\pi} + 1 = 0$');
  });

  test('should extract display LaTeX from KaTeX via extractLatex API', async ({ page }) => {
    await page.goto(`file://${FIXTURE_PATH}`);
    await page.waitForSelector('.katex');

    const result = await page.evaluate(() => {
      var el = document.querySelector('#msg1 .content');
      var selection = window.getSelection();
      var range = document.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);

      return window.__copyCleanerExtractLatex(selection);
    });

    expect(result).not.toBeNull();
    expect(result).toContain('$$\\nabla_\\theta J(\\theta)');
    expect(result).toContain('$A$');
  });

  test('should handle mixed inline and display math', async ({ page }) => {
    await page.goto(`file://${FIXTURE_PATH}`);
    await page.waitForSelector('.katex');

    const result = await page.evaluate(() => {
      var el = document.querySelector('#msg3 .content');
      var selection = window.getSelection();
      var range = document.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);

      return window.__copyCleanerExtractLatex(selection);
    });

    expect(result).not.toBeNull();
    expect(result).toContain('$$P(A|B)');
    expect(result).toContain('$P(A|B)$');
    expect(result).toContain('$P(B|A)$');
    expect(result).toContain('$P(A)$');
  });

  test('should return null for non-math content', async ({ page }) => {
    await page.goto(`file://${FIXTURE_PATH}`);
    await page.waitForSelector('#msg4 .content');

    const result = await page.evaluate(() => {
      var el = document.querySelector('#msg4 .content');
      var selection = window.getSelection();
      var range = document.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);

      return window.__copyCleanerExtractLatex(selection);
    });

    expect(result).toBeNull();
  });

  test('copy button should produce LaTeX from KaTeX content', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(`file://${FIXTURE_PATH}`);
    await page.waitForSelector('.katex');

    await page.click('#msg2 .copy-btn');
    await page.waitForTimeout(300);

    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());

    expect(clipboardText).toContain('e^{i');
  });
});

test.describe('LaTeX extraction - DOM-based unit tests', () => {
  test('should extract LaTeX from KaTeX DOM structure', async ({ page }) => {
    await page.setContent('<!DOCTYPE html><html><body></body></html>');
    await page.evaluate(injectScript);

    const result = await page.evaluate(() => {
      var container = document.createElement('div');
      container.innerHTML =
        '<span class="katex">' +
          '<span class="katex-mathml">' +
            '<math>' +
              '<annotation encoding="application/x-tex">E = mc^2</annotation>' +
            '</math>' +
          '</span>' +
          '<span class="katex-html">RENDERED</span>' +
        '</span>';

      document.body.appendChild(container);

      var selection = window.getSelection();
      var range = document.createRange();
      range.selectNodeContents(container);
      selection.removeAllRanges();
      selection.addRange(range);

      return window.__copyCleanerExtractLatex(selection);
    });

    expect(result).toContain('$E = mc^2$');
    expect(result).not.toContain('RENDERED');
  });

  test('should extract display LaTeX from .katex-display', async ({ page }) => {
    await page.setContent('<!DOCTYPE html><html><body></body></html>');
    await page.evaluate(injectScript);

    const result = await page.evaluate(() => {
      var container = document.createElement('div');
      container.innerHTML =
        '<span class="katex-display">' +
          '<span class="katex">' +
            '<span class="katex-mathml">' +
              '<math>' +
                '<annotation encoding="application/x-tex">\\int_0^1 f(x) dx</annotation>' +
              '</math>' +
            '</span>' +
            '<span class="katex-html">RENDERED</span>' +
          '</span>' +
        '</span>';

      document.body.appendChild(container);

      var selection = window.getSelection();
      var range = document.createRange();
      range.selectNodeContents(container);
      selection.removeAllRanges();
      selection.addRange(range);

      return window.__copyCleanerExtractLatex(selection);
    });

    expect(result).toContain('$$\\int_0^1 f(x) dx$$');
  });

  test('should extract LaTeX from MathJax-style data attributes', async ({ page }) => {
    await page.setContent('<!DOCTYPE html><html><body></body></html>');
    await page.evaluate(injectScript);

    const result = await page.evaluate(() => {
      var container = document.createElement('div');
      container.innerHTML =
        '<span class="MathJax" data-mathml="unused" data-latex="x^2 + y^2 = r^2">RENDERED</span>';

      document.body.appendChild(container);

      var selection = window.getSelection();
      var range = document.createRange();
      range.selectNodeContents(container);
      selection.removeAllRanges();
      selection.addRange(range);

      return window.__copyCleanerExtractLatex(selection);
    });

    expect(result).toContain('$x^2 + y^2 = r^2$');
  });

  test('should return null for non-math content', async ({ page }) => {
    await page.setContent('<!DOCTYPE html><html><body><div id="test">Hello World</div></body></html>');
    await page.evaluate(injectScript);

    const result = await page.evaluate(() => {
      var el = document.getElementById('test');
      var selection = window.getSelection();
      var range = document.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);

      return window.__copyCleanerExtractLatex(selection);
    });

    expect(result).toBeNull();
  });

  test('should extract LaTeX from mjx-container (MathJax 3)', async ({ page }) => {
    await page.setContent('<!DOCTYPE html><html><body></body></html>');
    await page.evaluate(injectScript);

    const result = await page.evaluate(() => {
      var container = document.createElement('div');
      container.innerHTML =
        '<mjx-container>' +
          '<math>' +
            '<annotation encoding="application/x-tex">\\alpha + \\beta</annotation>' +
          '</math>' +
        '</mjx-container>';

      document.body.appendChild(container);

      var selection = window.getSelection();
      var range = document.createRange();
      range.selectNodeContents(container);
      selection.removeAllRanges();
      selection.addRange(range);

      return window.__copyCleanerExtractLatex(selection);
    });

    expect(result).toContain('$\\alpha + \\beta$');
  });

  test('should extract display LaTeX from mjx-container with display attribute', async ({ page }) => {
    await page.setContent('<!DOCTYPE html><html><body></body></html>');
    await page.evaluate(injectScript);

    const result = await page.evaluate(() => {
      var container = document.createElement('div');
      container.innerHTML =
        '<mjx-container display="true">' +
          '<math>' +
            '<annotation encoding="application/x-tex">\\sum_{n=1}^{\\infty} \\frac{1}{n^2}</annotation>' +
          '</math>' +
        '</mjx-container>';

      document.body.appendChild(container);

      var selection = window.getSelection();
      var range = document.createRange();
      range.selectNodeContents(container);
      selection.removeAllRanges();
      selection.addRange(range);

      return window.__copyCleanerExtractLatex(selection);
    });

    expect(result).toContain('$$\\sum_{n=1}^{\\infty} \\frac{1}{n^2}$$');
  });
});
