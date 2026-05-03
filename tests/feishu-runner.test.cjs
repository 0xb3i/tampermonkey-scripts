const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assertTargetCleanupResult,
  assertAutomationResult,
  buildCleanupSnapshotSignature,
  chooseBestEditorCandidateIndex,
  isCleanupSnapshotReadyAsBaseline,
  isEditorReadyStateSatisfied,
  parseEditorReadyState,
  runDoubleSelectDeleteShortcut,
  isFeishuDocUrl,
  parseCliArgs,
  resolveRequestedCaseId,
  resolveFeishuCases,
  runFeishuTest,
} = require('../automation/feishu-runner.js');

test('isFeishuDocUrl accepts supported Feishu document URLs', () => {
  assert.equal(isFeishuDocUrl('https://bytedance.feishu.cn/docx/abc123'), true);
  assert.equal(isFeishuDocUrl('https://foo.larksuite.com/wiki/xyz789'), true);
  assert.equal(isFeishuDocUrl('https://foo.larkoffice.com/doc/token'), true);
});

test('isFeishuDocUrl rejects non-document and non-Feishu URLs', () => {
  assert.equal(isFeishuDocUrl('https://chatgpt.com/'), false);
  assert.equal(isFeishuDocUrl('https://bytedance.feishu.cn/base/abc123'), false);
  assert.equal(isFeishuDocUrl('not-a-url'), false);
});

test('parseCliArgs keeps boolean flags and key-value pairs', () => {
  assert.deepEqual(parseCliArgs([
    '--case', 'feishu-docx-to-wiki-rich-components',
    '--url', 'https://bytedance.feishu.cn/docx/abc123',
    '--list-cases',
    '--dry-run',
    '--timeout', '3000',
  ]), {
    case: 'feishu-docx-to-wiki-rich-components',
    url: 'https://bytedance.feishu.cn/docx/abc123',
    'list-cases': true,
    'dry-run': true,
    timeout: '3000',
  });
});

test('runner exports the feishu test entry point', () => {
  assert.equal(typeof runFeishuTest, 'function');
});

test('parseEditorReadyState parses serialized editor state JSON', () => {
  assert.deepEqual(
    parseEditorReadyState(JSON.stringify({
      hasContentRoot: true,
      hasContentLoaded: false,
      hasStructService: true,
      hasRootBlock: true,
    })),
    {
      hasContentRoot: true,
      hasContentLoaded: false,
      hasStructService: true,
      hasRootBlock: true,
    }
  );
  assert.equal(parseEditorReadyState('not-json'), null);
  assert.equal(parseEditorReadyState(''), null);
});

test('isEditorReadyStateSatisfied accepts struct-service-backed ready states even before heavy DOM content appears', () => {
  assert.equal(isEditorReadyStateSatisfied({
    hasContentRoot: true,
    hasContentLoaded: true,
  }), true);
  assert.equal(isEditorReadyStateSatisfied({
    hasContentRoot: true,
    hasContentLoaded: false,
    hasStructService: true,
  }), true);
  assert.equal(isEditorReadyStateSatisfied({
    hasContentRoot: true,
    hasContentLoaded: false,
    hasRootBlock: true,
  }), true);
  assert.equal(isEditorReadyStateSatisfied({
    hasContentRoot: true,
    hasContentLoaded: false,
    hasStructService: false,
    hasRootBlock: false,
  }), false);
  assert.equal(isEditorReadyStateSatisfied(null), false);
});

test('chooseBestEditorCandidateIndex prefers the main document editor over a small title block', () => {
  assert.equal(chooseBestEditorCandidateIndex([
    {
      isPrimaryRoot: true,
      rectWidth: 640,
      rectHeight: 48,
      textLength: 12,
      richNodeCount: 0,
      imageCount: 0,
      tableCount: 0,
      blockCount: 1,
    },
    {
      isPrimaryRoot: true,
      rectWidth: 960,
      rectHeight: 720,
      textLength: 2800,
      richNodeCount: 14,
      imageCount: 3,
      tableCount: 4,
      blockCount: 42,
    },
  ]), 1);
});

test('chooseBestEditorCandidateIndex falls back to the first candidate when scores tie or inputs are empty', () => {
  assert.equal(chooseBestEditorCandidateIndex([]), 0);
  assert.equal(chooseBestEditorCandidateIndex([
    { isPrimaryRoot: false, rectWidth: 100, rectHeight: 100, textLength: 0, richNodeCount: 0, imageCount: 0, tableCount: 0, blockCount: 0 },
    { isPrimaryRoot: false, rectWidth: 100, rectHeight: 100, textLength: 0, richNodeCount: 0, imageCount: 0, tableCount: 0, blockCount: 0 },
  ]), 0);
});

test('assertTargetCleanupResult accepts cleanup snapshots that return to baseline', () => {
  assert.doesNotThrow(function () {
    assertTargetCleanupResult({
      cleanup: {
        attempted: true,
        error: '',
        matchedBaseline: true,
        finalSnapshot: {
          blockCount: 1,
        },
      },
      baselineSignature: JSON.stringify({
        blockCount: 1,
      }),
    });
  });
});

test('assertTargetCleanupResult rejects cleanup snapshots that still differ from baseline', () => {
  assert.throws(function () {
    assertTargetCleanupResult({
      cleanup: {
        attempted: true,
        error: '',
        matchedBaseline: false,
        finalSnapshot: {
          blockCount: 3,
        },
      },
      baselineSignature: JSON.stringify({
        blockCount: 1,
      }),
    });
  }, /Cleanup did not return target document to baseline snapshot/);
});

test('resolveFeishuCases returns all built-in cases when no case id is provided', () => {
  const cases = resolveFeishuCases();
  assert.ok(cases.length >= 2);
  assert.equal(cases[0].id, 'feishu-docx-to-wiki-rich-components');
  assert.ok(cases.some(function (testCase) {
    return testCase.id === 'feishu-docx-to-wiki-equation';
  }));
});

test('resolveFeishuCases narrows to one case when case id is provided', () => {
  const cases = resolveFeishuCases('feishu-docx-to-wiki-equation');
  assert.equal(cases.length, 1);
  assert.equal(cases[0].id, 'feishu-docx-to-wiki-equation');
});

test('resolveRequestedCaseId keeps empty case selection so CLI can run all built-in cases', () => {
  assert.equal(resolveRequestedCaseId({}), '');
  assert.equal(resolveRequestedCaseId({ case: '' }), '');
  assert.equal(resolveRequestedCaseId({ case: 'feishu-docx-to-wiki-equation' }), 'feishu-docx-to-wiki-equation');
});

test('runDoubleSelectDeleteShortcut presses Cmd+A three times before deleting', async () => {
  const calls = [];
  const page = {
    keyboard: {
      async press(key) {
        calls.push(['press', key]);
      },
    },
    async waitForTimeout(ms) {
      calls.push(['wait', ms]);
    },
  };

  await runDoubleSelectDeleteShortcut(page, 'Backspace');

  assert.deepEqual(calls, [
    ['press', 'Meta+A'],
    ['wait', 80],
    ['press', 'Meta+A'],
    ['wait', 80],
    ['press', 'Meta+A'],
    ['wait', 80],
    ['press', 'Backspace'],
    ['wait', 320],
  ]);
});

test('isCleanupSnapshotReadyAsBaseline allows small image/equation noise but rejects structural rich leftovers', () => {
  assert.equal(isCleanupSnapshotReadyAsBaseline({
    equationCount: 0,
    semanticSnapshot: {
      componentCounts: {},
    },
  }), true);

  assert.equal(isCleanupSnapshotReadyAsBaseline({
    semanticSnapshot: {
      componentCounts: {
        image: 4,
        equation: 1,
      },
    },
  }), true);

  assert.equal(isCleanupSnapshotReadyAsBaseline({
    semanticSnapshot: {
      componentCounts: {
        image: 7,
      },
    },
  }), false);

  assert.equal(isCleanupSnapshotReadyAsBaseline({
    semanticSnapshot: {
      componentCounts: {
        callout: 1,
      },
    },
  }), false);
});

test('buildCleanupSnapshotSignature ignores transient validation fields', () => {
  const baseline = buildCleanupSnapshotSignature({
    title: 'Target',
    text: '',
    textLength: 0,
    htmlLength: 101,
    blockCount: 1,
    equationCount: 0,
    extractionDebug: {
      source: 'baseline',
    },
    styleSummary: {
      blocks: [],
    },
    semanticSnapshot: {
      componentCounts: {},
      components: [],
    },
  });

  const afterCleanup = buildCleanupSnapshotSignature({
    title: 'Another title',
    text: '\u200b\u200cnoise',
    textLength: 9,
    htmlLength: 88,
    blockCount: 1,
    equationCount: 0,
    extractionDebug: {
      source: 'after-cleanup',
      ts: Date.now(),
    },
    styleSummary: {
      blocks: [],
    },
    semanticSnapshot: {
      componentCounts: {},
      components: [],
    },
  });

  assert.equal(afterCleanup, baseline);
});

test('buildCleanupSnapshotSignature ignores semantic component ordering noise', () => {
  const baseline = buildCleanupSnapshotSignature({
    semanticSnapshot: {
      componentCounts: {
        image: 2,
        table: 1,
      },
      components: [
        { type: 'image', width: 320, height: 180, rendered: true },
        { type: 'table', rowCount: 3, colCount: 2, textSample: 'A1' },
        { type: 'image', width: 640, height: 480, rendered: true },
      ],
    },
  });

  const afterCleanup = buildCleanupSnapshotSignature({
    semanticSnapshot: {
      componentCounts: {
        table: 1,
        image: 2,
      },
      components: [
        { type: 'image', width: 640, height: 480, rendered: true },
        { type: 'image', width: 320, height: 180, rendered: true },
        { type: 'table', rowCount: 3, colCount: 2, textSample: 'A1' },
      ],
    },
  });

  assert.equal(afterCleanup, baseline);
});

test('assertAutomationResult accepts successful automation payloads', () => {
  assert.doesNotThrow(function () {
    assertAutomationResult({
      status: 'success',
      summary: {
        title: 'Demo',
        pendingPaste: {
          ts: Date.now(),
        },
        validationSnapshot: {
          blockCount: 2,
        },
      },
    }, {
      helperVersion: '4.2.18',
      validationSnapshot: null,
    });
  });
});

test('assertAutomationResult rejects missing pending paste updates', () => {
  assert.throws(function () {
    assertAutomationResult({
      status: 'success',
      summary: {
        title: 'Demo',
        validationSnapshot: {
          blockCount: 2,
        },
      },
    }, {
      helperVersion: '4.2.18',
      validationSnapshot: null,
    });
  }, /Pending paste cache was not updated/);
});

test('assertAutomationResult accepts semantic snapshot rich payloads', () => {
  assert.doesNotThrow(function () {
    assertAutomationResult({
      status: 'success',
      summary: {
        title: 'Demo',
        pendingPaste: {
          ts: Date.now(),
        },
        validationSnapshot: {
          blockCount: 3,
          semanticSnapshot: {
            componentCounts: {
              table: 1,
              equation: 1,
            },
          },
        },
        semanticSnapshot: {
          componentCounts: {
            table: 1,
            equation: 1,
          },
        },
      },
    }, {
      helperVersion: '4.2.18',
      validationSnapshot: null,
    });
  });
});
