const DEFAULT_CASE_ID = 'feishu-docx-to-wiki-rich-components';

const CASES = {
  [DEFAULT_CASE_ID]: {
    id: DEFAULT_CASE_ID,
    description: '固定源文档复制到目标 wiki，验证关键富文本组件、图片上传与目标渲染语义快照。',
    sourceUrl: 'https://bytedance.larkoffice.com/docx/H3qVdELWFojYlIx1dBmcqcQMnUd',
    targetUrl: 'https://bytedance.larkoffice.com/wiki/Eoqpwyw4SiUrJdkphu0cSqFxnWd',
    action: 'validateDuplicateDocument',
    expect: {
      extraction: {
        minBlockCount: 1,
        minEquationCount: 1,
        requirePendingPaste: true,
        requiredSourceComponentTypes: [
          'callout',
          'table',
          'image',
          'equation',
        ],
      },
      upload: {
        requireUploadedImages: true,
        maxFailedUploads: 0,
      },
      paste: {
        requireChanged: true,
      },
      render: {
        compareSourceComponents: {
          componentTypes: [
            'callout',
            'table',
            'image',
            'equation',
            'quote',
            'code_block',
            'divider',
            'grid',
            'bookmark',
          ],
          requireRenderedImages: true,
        },
      },
    },
  },
};

function cloneCase(testCase) {
  return JSON.parse(JSON.stringify(testCase));
}

function listFeishuCases() {
  return Object.keys(CASES).map(function (caseId) {
    return cloneCase(CASES[caseId]);
  });
}

function getFeishuCase(caseId) {
  var resolvedCaseId = String(caseId || DEFAULT_CASE_ID);
  var testCase = CASES[resolvedCaseId];
  if (!testCase) {
    throw new Error('Unknown Feishu case: ' + resolvedCaseId);
  }
  return cloneCase(testCase);
}

module.exports = {
  CASES: CASES,
  DEFAULT_CASE_ID: DEFAULT_CASE_ID,
  getFeishuCase: getFeishuCase,
  listFeishuCases: listFeishuCases,
};
