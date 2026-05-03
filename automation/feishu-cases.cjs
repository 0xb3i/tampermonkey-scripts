const DEFAULT_CASE_ID = 'feishu-docx-to-wiki-rich-components';
const EQUATION_CASE_ID = 'feishu-docx-to-wiki-equation';

const CASES = {
  [DEFAULT_CASE_ID]: {
    id: DEFAULT_CASE_ID,
    description: '固定源文档复制到目标 wiki，验证关键富文本组件、图片上传、白板与目标渲染语义快照。',
    sourceUrl: 'https://bytedance.larkoffice.com/docx/H3qVdELWFojYlIx1dBmcqcQMnUd',
    targetUrl: 'https://bytedance.larkoffice.com/wiki/Eoqpwyw4SiUrJdkphu0cSqFxnWd',
    action: 'validateDuplicateDocument',
    expect: {
      extraction: {
        minBlockCount: 1,
        minEquationCount: 0,
        requirePendingPaste: true,
        requiredSourceComponentTypes: [
          'callout',
          'code_block',
          'table',
          'image',
          'whiteboard',
        ],
      },
      upload: {
        minUploadedCount: 3,
        maxFailedUploads: 0,
      },
      paste: {
        requireChanged: true,
      },
      render: {
        requiredTargetComponents: [
          {
            type: 'callout',
            minCount: 6,
            requiredTextSamples: [
              '去年可能很多同事都看过我的这篇文章',
              '关键设计：Prefix Cache 优化',
            ],
          },
          {
            type: 'table',
            minCount: 4,
          },
          {
            type: 'image',
            minCount: 4,
            requireRendered: true,
          },
          {
            type: 'code_block',
            minCount: 6,
          },
          {
            type: 'whiteboard',
            minCount: 2,
          },
        ],
      },
    },
  },
  [EQUATION_CASE_ID]: {
    id: EQUATION_CASE_ID,
    description: '固定源文档复制到目标 wiki，专门验证公式提取与目标渲染。',
    sourceUrl: 'https://bytedance.larkoffice.com/docx/EdpId2k96o7tFzxZVb8cF8QInVh',
    targetUrl: 'https://bytedance.larkoffice.com/wiki/Eoqpwyw4SiUrJdkphu0cSqFxnWd',
    action: 'validateDuplicateDocument',
    expect: {
      extraction: {
        minBlockCount: 1,
        minEquationCount: 5,
        requirePendingPaste: true,
        requiredSourceComponentTypes: [
          'equation',
        ],
      },
      upload: {
        requireUploadedImages: false,
        maxFailedUploads: 0,
      },
      paste: {
        requireChanged: true,
      },
      render: {
        requiredTargetComponents: [
          {
            type: 'equation',
            minCount: 5,
            requiredTextGroups: [
              ['\\beta', 'β'],
              ['D_{\\text{JSD}}', 'JSD'],
              ['\\mathrm{KL}', 'KL'],
            ],
          },
        ],
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
  EQUATION_CASE_ID: EQUATION_CASE_ID,
  getFeishuCase: getFeishuCase,
  listFeishuCases: listFeishuCases,
};
