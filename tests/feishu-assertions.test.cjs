const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assertFeishuCaseResult,
  summarizeFeishuCaseFailures,
} = require('../lib/feishu-assertions.cjs');

function createPassingFixture() {
  return {
    testCase: {
      id: 'feishu-docx-to-wiki-rich-components',
      expect: {
        extraction: {
          minBlockCount: 6,
          minEquationCount: 1,
          requirePendingPaste: true,
          requiredSourceComponentTypes: ['callout', 'table', 'image', 'equation'],
        },
        upload: {
          minUploadedCount: 2,
          maxFailedUploads: 0,
        },
        paste: {
          requireChanged: true,
        },
        render: {
          requiredTargetComponents: [
            { type: 'callout', minCount: 1, requiredTextSamples: ['重点提示'] },
            { type: 'table', minCount: 1 },
            { type: 'image', minCount: 2, requireRendered: true },
            { type: 'equation', minCount: 1, requiredTextGroups: [['x^2', 'x²', 'z^2', 'z²']] },
          ],
        },
      },
    },
    source: {
      automation: {
        status: 'success',
        summary: {
          title: 'demo',
          pendingPaste: {
            ts: Date.now(),
          },
          validationSnapshot: {
            blockCount: 8,
          },
          semanticSnapshot: {
            componentCounts: {
              callout: 1,
              table: 1,
              image: 2,
              equation: 1,
            },
            components: [
              { type: 'callout', textSample: '重点提示' },
              { type: 'table', rowCount: 3, colCount: 2, cellTexts: ['A1', 'B1'] },
              { type: 'image', rendered: true, width: 320, height: 200 },
              { type: 'image', rendered: true, width: 320, height: 200 },
              { type: 'equation', textSample: 'x^2 + y^2 = z^2' },
            ],
          },
        },
      },
      artifacts: {
        helperVersion: '4.2.18',
        validationSnapshot: {
          blockCount: 8,
        },
        extractionResult: {
          blockCount: 8,
          equationCount: 1,
        },
      },
    },
    target: {
      validation: {
        pasteAttempt: {
          changed: true,
        },
      },
      artifacts: {
        uploadResult: {
          uploadedCount: 2,
          failedCount: 0,
        },
        validationSnapshot: {
          semanticSnapshot: {
            componentCounts: {
              callout: 1,
              table: 1,
              image: 2,
              equation: 1,
            },
            components: [
              { type: 'callout', textSample: '重点提示' },
              { type: 'table', rowCount: 3, colCount: 2, cellTexts: ['A1', 'B1'] },
              { type: 'image', rendered: true, width: 640, height: 360 },
              { type: 'image', rendered: true, width: 640, height: 360 },
              { type: 'equation', textSample: 'x^2 + y^2 = z^2' },
            ],
          },
        },
      },
    },
  };
}

test('assertFeishuCaseResult accepts matching source-target semantic components', () => {
  assert.doesNotThrow(function () {
    assertFeishuCaseResult(createPassingFixture());
  });
});

test('assertFeishuCaseResult rejects missing rendered equation component', () => {
  const fixture = createPassingFixture();
  fixture.target.artifacts.validationSnapshot.semanticSnapshot.componentCounts.equation = 0;
  fixture.target.artifacts.validationSnapshot.semanticSnapshot.components =
    fixture.target.artifacts.validationSnapshot.semanticSnapshot.components.filter(function (component) {
      return component.type !== 'equation';
    });

  assert.throws(function () {
    assertFeishuCaseResult(fixture);
  }, /render\.requiredTargetComponents/);
});

test('assertFeishuCaseResult rejects image upload regressions', () => {
  const fixture = createPassingFixture();
  fixture.target.artifacts.uploadResult = {
    uploadedCount: 0,
    failedCount: 2,
  };

  assert.throws(function () {
    assertFeishuCaseResult(fixture);
  }, /upload/);
});

test('assertFeishuCaseResult rejects missing key target component anchors', () => {
  const fixture = createPassingFixture();
  fixture.target.artifacts.validationSnapshot.semanticSnapshot.componentCounts.callout = 0;
  fixture.target.artifacts.validationSnapshot.semanticSnapshot.components =
    fixture.target.artifacts.validationSnapshot.semanticSnapshot.components.filter(function (component) {
      return component.type !== 'callout';
    });

  assert.throws(function () {
    assertFeishuCaseResult(fixture);
  }, /render\.requiredTargetComponents/);
});

test('assertFeishuCaseResult accepts target text anchor groups with alternative renderings', () => {
  const fixture = createPassingFixture();
  fixture.target.artifacts.validationSnapshot.semanticSnapshot.components =
    fixture.target.artifacts.validationSnapshot.semanticSnapshot.components.map(function (component) {
      if (component.type !== 'equation') return component;
      return { type: 'equation', textSample: 'β² + y² = z²' };
    });

  assert.doesNotThrow(function () {
    assertFeishuCaseResult(fixture);
  });
});

test('assertFeishuCaseResult prefers afterPasteSnapshot over post-cleanup artifact snapshot', () => {
  const fixture = createPassingFixture();
  fixture.target.validation.afterPasteSnapshot = fixture.target.artifacts.validationSnapshot;
  fixture.target.artifacts.validationSnapshot = {
    semanticSnapshot: {
      componentCounts: {},
      components: [],
    },
  };

  assert.doesNotThrow(function () {
    assertFeishuCaseResult(fixture);
  });
});

test('summarizeFeishuCaseFailures produces readable failure labels', () => {
  assert.equal(
    summarizeFeishuCaseFailures([
      {
        path: 'render.compareSourceComponents',
        message: 'missing component type equation',
      },
      {
        path: 'upload',
        message: 'uploadedCount=0',
      },
    ]),
    'render.compareSourceComponents: missing component type equation; upload: uploadedCount=0'
  );
});
