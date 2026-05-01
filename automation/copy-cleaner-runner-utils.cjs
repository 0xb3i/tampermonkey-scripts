function parseCliArgs(argv) {
  var result = {};
  for (var i = 0; i < argv.length; i++) {
    var token = String(argv[i] || '');
    if (!token.startsWith('--')) continue;
    var key = token.slice(2);
    var next = argv[i + 1];
    if (!next || String(next).startsWith('--')) {
      result[key] = true;
      continue;
    }
    result[key] = next;
    i += 1;
  }
  return result;
}

function normalizeText(text, ignoreLinePatterns) {
  var patterns = Array.isArray(ignoreLinePatterns) ? ignoreLinePatterns : [];
  var lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  if (patterns.length) {
    lines = lines.filter(function (line) {
      for (var i = 0; i < patterns.length; i++) {
        if (patterns[i] && patterns[i].test && patterns[i].test(line)) return false;
      }
      return true;
    });
  }
  return lines.join('\n').trim();
}

function buildTextMismatchSummary(expectedText, actualText, ignoreLinePatterns) {
  var expected = normalizeText(expectedText, ignoreLinePatterns);
  var actual = normalizeText(actualText, ignoreLinePatterns);
  if (expected === actual) {
    return {
      matches: true,
      firstDiffIndex: -1,
      expectedFragment: '',
      actualFragment: '',
    };
  }
  var index = 0;
  var max = Math.max(expected.length, actual.length);
  while (index < max && expected.charAt(index) === actual.charAt(index)) {
    index += 1;
  }
  var start = Math.max(0, index - 12);
  var end = index + 24;
  return {
    matches: false,
    firstDiffIndex: index,
    expectedFragment: expected.slice(start, end),
    actualFragment: actual.slice(start, end),
  };
}

async function ensureClipboardPermission(context, origin) {
  if (!origin) return;
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: origin });
}

async function readClipboardText(page) {
  return page.evaluate(async function () {
    return navigator.clipboard.readText();
  });
}

module.exports = {
  buildTextMismatchSummary,
  ensureClipboardPermission,
  normalizeText,
  parseCliArgs,
  readClipboardText,
};
