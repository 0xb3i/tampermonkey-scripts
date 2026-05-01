function buildSnapshotSignature(snapshot) {
  return JSON.stringify(snapshot || null);
}

function didSnapshotChange(baselineSignature, snapshot) {
  if (snapshot == null) return false;
  return buildSnapshotSignature(snapshot) !== String(baselineSignature || 'null');
}

function runPasteAttemptWithFallback(options) {
  const config = options || {};
  const baselineSignature = String(config.baselineSignature || 'null');
  const primaryTrigger = typeof config.runPrimary === 'function' ? config.runPrimary() : null;

  let primaryResult = null;
  let primaryError = '';
  try {
    primaryResult = typeof config.waitForPrimary === 'function' ? config.waitForPrimary() : null;
  } catch (error) {
    primaryError = String(error && error.message ? error.message : error);
  }

  const primarySnapshot = primaryResult && primaryResult.snapshot ? primaryResult.snapshot : null;
  const primaryChanged = didSnapshotChange(baselineSignature, primarySnapshot);
  if (primaryChanged) {
    return {
      changed: true,
      usedFallback: false,
      primaryChanged: true,
      primaryTrigger,
      finalTrigger: primaryTrigger,
      finalSnapshot: primarySnapshot,
      primaryError,
    };
  }

  const fallbackTrigger = typeof config.runFallback === 'function' ? config.runFallback() : null;
  let fallbackResult = null;
  let fallbackError = '';
  try {
    fallbackResult = typeof config.waitForFallback === 'function' ? config.waitForFallback() : null;
  } catch (error) {
    fallbackError = String(error && error.message ? error.message : error);
  }

  const fallbackSnapshot = fallbackResult && fallbackResult.snapshot ? fallbackResult.snapshot : null;
  const changed = didSnapshotChange(baselineSignature, fallbackSnapshot);
  return {
    changed,
    usedFallback: true,
    primaryChanged: false,
    primaryTrigger,
    fallbackTrigger,
    finalTrigger: fallbackTrigger,
    finalSnapshot: fallbackSnapshot,
    primaryError,
    fallbackError,
  };
}

function runPostValidationCleanup(options) {
  const config = options || {};
  if (typeof config.runCleanup !== 'function') {
    return {
      attempted: false,
      error: '',
      trigger: null,
      finalSnapshot: null,
    };
  }

  let trigger = null;
  let finalSnapshot = null;
  let error = '';

  try {
    trigger = config.runCleanup();
    const waitResult = typeof config.waitForCleanup === 'function' ? config.waitForCleanup() : null;
    finalSnapshot = waitResult && waitResult.snapshot ? waitResult.snapshot : null;
  } catch (cleanupError) {
    error = String(cleanupError && cleanupError.message ? cleanupError.message : cleanupError);
  }

  return {
    attempted: true,
    error,
    trigger,
    finalSnapshot,
  };
}

module.exports = {
  buildSnapshotSignature,
  didSnapshotChange,
  runPasteAttemptWithFallback,
  runPostValidationCleanup,
};
