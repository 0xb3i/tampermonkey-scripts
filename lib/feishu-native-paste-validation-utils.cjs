function shouldPreferNativeClipboardPasteForValidation(extraction) {
  return Boolean(extraction && (extraction.hasDowngradedImages || extraction.hasImagesToInject));
}

function prepareNativeClipboardForValidation(extraction, options) {
  if (!shouldPreferNativeClipboardPasteForValidation(extraction)) {
    return {
      attempted: false,
      skipped: true,
      summary: null,
    };
  }

  var prepare = options && typeof options.prepare === 'function'
    ? options.prepare
    : null;
  if (!prepare) {
    throw new Error('A prepare callback is required when native clipboard paste is preferred.');
  }

  return {
    attempted: true,
    skipped: false,
    summary: prepare() || null,
  };
}

module.exports = {
  prepareNativeClipboardForValidation,
  shouldPreferNativeClipboardPasteForValidation,
};
