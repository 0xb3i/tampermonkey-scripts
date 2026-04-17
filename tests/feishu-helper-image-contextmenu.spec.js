import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { join } from 'path';

const SCRIPT_PATH = join(__dirname, '..', 'scripts', 'feishu-helper.user.js');
const SCRIPT_CONTENT = readFileSync(SCRIPT_PATH, 'utf-8');
const FIXTURE_PATH = join(__dirname, 'fixtures', 'feishu-image-contextmenu.html');

function extractInjectableScript(scriptContent) {
  const match = scriptContent.match(/\(function\s*\(\)\s*\{[\s\S]*\}\)\(\);/);
  return match ? match[0] : scriptContent;
}

const injectScript = extractInjectableScript(SCRIPT_CONTENT);

async function dispatchContextGesture(page, selector) {
  return page.evaluate((targetSelector) => {
    window.hostileEvents = [];

    const target = document.querySelector(targetSelector);
    const eventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      button: 2,
      buttons: 2,
      clientX: 80,
      clientY: 80,
    };

    const pointerDownReturn = target.dispatchEvent(new PointerEvent('pointerdown', {
      ...eventInit,
      pointerType: 'mouse',
      isPrimary: true,
    }));
    const mouseDownReturn = target.dispatchEvent(new MouseEvent('mousedown', eventInit));
    const mouseUpReturn = target.dispatchEvent(new MouseEvent('mouseup', eventInit));
    const contextMenuReturn = target.dispatchEvent(new MouseEvent('contextmenu', eventInit));

    return {
      pointerDownReturn,
      mouseDownReturn,
      mouseUpReturn,
      contextMenuReturn,
      hostileEvents: window.hostileEvents,
      inlineImageContextCount: window.inlineImageContextCount || 0,
      inlineNormalContextCount: window.inlineNormalContextCount || 0,
      proxyExists: !!document.getElementById('__feishu_native_image_proxy__'),
      proxySrc: document.getElementById('__feishu_native_image_proxy__')?.getAttribute('src') || '',
    };
  }, selector);
}

test.describe('Feishu Helper - image native context menu bypass', () => {
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(injectScript);
  });

  test('right click on img should block page handlers before they suppress the browser menu', async ({ page }) => {
    await page.goto(`file://${FIXTURE_PATH}`);
    const state = await dispatchContextGesture(page, '#doc-image');

    expect(state.pointerDownReturn).toBe(true);
    expect(state.mouseDownReturn).toBe(true);
    expect(state.mouseUpReturn).toBe(true);
    expect(state.contextMenuReturn).toBe(true);
    expect(state.hostileEvents).toEqual([]);
    expect(state.inlineImageContextCount).toBe(0);
  });

  test('right click on background image should create a temporary img proxy and block page handlers', async ({ page }) => {
    await page.goto(`file://${FIXTURE_PATH}`);
    const state = await dispatchContextGesture(page, '#bg-image');

    expect(state.pointerDownReturn).toBe(true);
    expect(state.contextMenuReturn).toBe(true);
    expect(state.hostileEvents).toEqual([]);
    expect(state.proxyExists).toBe(true);
    expect(state.proxySrc).toContain('data:image/svg+xml');
  });

  test('non-image right click should still fall through to the page handlers', async ({ page }) => {
    await page.goto(`file://${FIXTURE_PATH}`);
    const state = await dispatchContextGesture(page, '#normal-area');

    expect(state.pointerDownReturn).toBe(false);
    expect(state.contextMenuReturn).toBe(false);
    expect(state.hostileEvents.length).toBeGreaterThan(0);
    expect(state.hostileEvents.some((item) => item.target === 'normal-area')).toBe(true);
    expect(state.inlineNormalContextCount).toBe(0);
  });
});
