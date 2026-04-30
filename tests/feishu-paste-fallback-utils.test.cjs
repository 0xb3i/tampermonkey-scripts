const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runPasteAttemptWithFallback,
  runPostValidationCleanup,
} = require('../scripts/feishu-paste-fallback-utils.cjs');
const {
  prepareNativeClipboardForValidation,
  shouldPreferNativeClipboardPasteForValidation,
} = require('../scripts/feishu-native-paste-validation-utils.cjs');

test('runPasteAttemptWithFallback stops after Cmd+Shift+P when snapshot changed', () => {
  const calls = [];
  const result = runPasteAttemptWithFallback({
    baselineSignature: '{"blockCount":1}',
    runPrimary() {
      calls.push('primary');
      return { triggered: 'Cmd+Shift+P' };
    },
    waitForPrimary() {
      return { snapshot: { blockCount: 2 } };
    },
    runFallback() {
      calls.push('fallback');
      return { triggered: 'Cmd+V' };
    },
    waitForFallback() {
      return { snapshot: { blockCount: 3 } };
    },
  });

  assert.deepEqual(calls, ['primary']);
  assert.equal(result.usedFallback, false);
  assert.equal(result.changed, true);
  assert.deepEqual(result.primaryTrigger, { triggered: 'Cmd+Shift+P' });
  assert.equal(result.finalTrigger.triggered, 'Cmd+Shift+P');
  assert.deepEqual(result.finalSnapshot, { blockCount: 2 });
});

test('runPasteAttemptWithFallback retries with Cmd+V when Cmd+Shift+P produced no snapshot change', () => {
  const calls = [];
  const result = runPasteAttemptWithFallback({
    baselineSignature: '{"blockCount":1}',
    runPrimary() {
      calls.push('primary');
      return { triggered: 'Cmd+Shift+P' };
    },
    waitForPrimary() {
      return { snapshot: { blockCount: 1 } };
    },
    runFallback() {
      calls.push('fallback');
      return { triggered: 'Cmd+V' };
    },
    waitForFallback() {
      return { snapshot: { blockCount: 2 } };
    },
  });

  assert.deepEqual(calls, ['primary', 'fallback']);
  assert.equal(result.usedFallback, true);
  assert.equal(result.changed, true);
  assert.equal(result.primaryChanged, false);
  assert.equal(result.finalTrigger.triggered, 'Cmd+V');
  assert.deepEqual(result.finalSnapshot, { blockCount: 2 });
});

test('runPasteAttemptWithFallback surfaces no-change state when both attempts failed', () => {
  const result = runPasteAttemptWithFallback({
    baselineSignature: '{"blockCount":1}',
    runPrimary() {
      return { triggered: 'Cmd+Shift+P' };
    },
    waitForPrimary() {
      throw new Error('primary timeout');
    },
    runFallback() {
      return { triggered: 'Cmd+V' };
    },
    waitForFallback() {
      return { snapshot: { blockCount: 1 } };
    },
  });

  assert.equal(result.usedFallback, true);
  assert.equal(result.changed, false);
  assert.match(result.primaryError, /primary timeout/);
  assert.equal(result.finalTrigger.triggered, 'Cmd+V');
  assert.deepEqual(result.finalSnapshot, { blockCount: 1 });
});

test('runPostValidationCleanup runs cleanup hooks after validation snapshot is collected', () => {
  const calls = [];
  const result = runPostValidationCleanup({
    runCleanup() {
      calls.push('cleanup');
      return { shortcut: 'Cmd+A+Backspace' };
    },
    waitForCleanup() {
      calls.push('wait');
      return { snapshot: { blockCount: 3 } };
    },
  });

  assert.deepEqual(calls, ['cleanup', 'wait']);
  assert.equal(result.attempted, true);
  assert.equal(result.error, '');
  assert.deepEqual(result.trigger, { shortcut: 'Cmd+A+Backspace' });
  assert.deepEqual(result.finalSnapshot, { blockCount: 3 });
});

test('runPostValidationCleanup captures cleanup errors without throwing', () => {
  const result = runPostValidationCleanup({
    runCleanup() {
      throw new Error('cleanup failed');
    },
  });

  assert.equal(result.attempted, true);
  assert.match(result.error, /cleanup failed/);
  assert.equal(result.trigger, null);
  assert.equal(result.finalSnapshot, null);
});

test('prepareNativeClipboardForValidation prepares clipboard when downgraded images require native paste', () => {
  const calls = [];
  const result = prepareNativeClipboardForValidation({ hasDowngradedImages: true }, {
    prepare() {
      calls.push('prepare');
      return { htmlLength: 123, requiresNativePaste: true };
    },
  });

  assert.deepEqual(calls, ['prepare']);
  assert.equal(result.attempted, true);
  assert.equal(result.skipped, false);
  assert.deepEqual(result.summary, { htmlLength: 123, requiresNativePaste: true });
});

test('prepareNativeClipboardForValidation skips clipboard preparation when structured paste is still allowed', () => {
  const calls = [];
  const result = prepareNativeClipboardForValidation({ hasDowngradedImages: false }, {
    prepare() {
      calls.push('prepare');
      return { htmlLength: 123 };
    },
  });

  assert.deepEqual(calls, []);
  assert.equal(result.attempted, false);
  assert.equal(result.skipped, true);
  assert.equal(result.summary, null);
});

test('shouldPreferNativeClipboardPasteForValidation returns true for downgraded image payloads', () => {
  assert.equal(shouldPreferNativeClipboardPasteForValidation({
    hasDowngradedImages: true,
  }), true);
});

test('shouldPreferNativeClipboardPasteForValidation returns false for normal structured payloads', () => {
  assert.equal(shouldPreferNativeClipboardPasteForValidation({
    hasDowngradedImages: false,
  }), false);
  assert.equal(shouldPreferNativeClipboardPasteForValidation(null), false);
});
