const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  downgradeStructuredImagesForPaste,
} = require('../scripts/feishu-image-paste-utils.cjs');

test('downgradeStructuredImagesForPaste removes image records and strips structured attrs from base64 image figures', () => {
  const originalRecord = {
    rootId: 'page-1',
    parentId: 'page-1',
    blockIds: [1, 2],
    recordIds: ['text-1', 'img-1'],
    recordMap: {
      'page-1': {
        id: 'page-1',
        snapshot: {
          type: 'page',
          children: ['text-1', 'img-1'],
        },
      },
      'text-1': {
        id: 'text-1',
        snapshot: {
          type: 'text',
          text: 'hello',
        },
      },
      'img-1': {
        id: 'img-1',
        snapshot: {
          type: 'image',
          image: {
            token: 'img-token-1',
            width: 320,
            height: 200,
          },
        },
      },
      'quote-1': {
        id: 'quote-1',
        snapshot: {
          type: 'quote_container',
          children: ['img-1', 'text-1'],
        },
      },
    },
    payloadMap: {
      'img-1': { level: 1 },
      'quote-1': { level: 1 },
    },
    selection: [
      { id: 2, type: 'block', recordId: 'text-1' },
      { id: 3, type: 'block', recordId: 'img-1' },
    ],
  };

  const originalHtml = '<div data-page-id="" data-lark-html-role="root" data-docx-has-block-data="true">'
    + '<p>hello</p>'
    + '<figure class="block docx-image-block" data-block-type="image" data-block-id="img-block-1" data-record-id="img-1" '
    + 'data-lark-record-data="{&quot;type&quot;:&quot;image&quot;,&quot;image&quot;:{&quot;token&quot;:&quot;img-token-1&quot;}}" '
    + 'data-meta-block-props="{&quot;blockType&quot;:&quot;IMAGE_BLOCK&quot;,&quot;props&quot;:{&quot;data&quot;:{&quot;token&quot;:&quot;img-token-1&quot;}}}">'
    + '<img src="data:image/png;base64,abc123" alt="demo"></figure></div>';

  const result = downgradeStructuredImagesForPaste({
    docxRecord: originalRecord,
    html: originalHtml,
  });

  assert.deepEqual(result.removedImageRecordIds, ['img-1']);
  assert.equal(result.docxRecord.recordMap['img-1'], undefined);
  assert.deepEqual(result.docxRecord.recordIds, ['text-1']);
  assert.deepEqual(result.docxRecord.blockIds, [1]);
  assert.deepEqual(result.docxRecord.selection, [
    { id: 2, type: 'block', recordId: 'text-1' },
  ]);
  assert.deepEqual(result.docxRecord.recordMap['page-1'].snapshot.children, ['text-1']);
  assert.deepEqual(result.docxRecord.recordMap['quote-1'].snapshot.children, ['text-1']);
  assert.equal(result.docxRecord.payloadMap['img-1'], undefined);
  assert.match(result.html, /<figure class="block docx-image-block"[^>]*><img src="data:image\/png;base64,abc123" alt="demo"><\/figure>/);
  assert.match(result.html, /data-feishu-downgraded-images="true"/);
  assert.doesNotMatch(result.html, /data-lark-record-data=/);
  assert.doesNotMatch(result.html, /data-meta-block-props=/);
  assert.doesNotMatch(result.html, /data-block-id=/);
  assert.doesNotMatch(result.html, /data-record-id=/);
});

test('downgradeStructuredImagesForPaste keeps non-base64 image html untouched when no structured images are removed', () => {
  const originalRecord = {
    rootId: 'page-1',
    parentId: 'page-1',
    blockIds: [1],
    recordIds: ['text-1'],
    recordMap: {
      'page-1': { id: 'page-1', snapshot: { type: 'page', children: ['text-1'] } },
      'text-1': { id: 'text-1', snapshot: { type: 'text', text: 'hello' } },
    },
    payloadMap: {},
    selection: [{ id: 2, type: 'block', recordId: 'text-1' }],
  };

  const originalHtml = '<div><figure class="block docx-image-block" data-block-id="x"><img src="https://example.com/demo.png"></figure></div>';
  const result = downgradeStructuredImagesForPaste({ docxRecord: originalRecord, html: originalHtml });

  assert.deepEqual(result.removedImageRecordIds, []);
  assert.deepEqual(result.docxRecord, originalRecord);
  assert.equal(result.html, originalHtml);
  assert.doesNotMatch(result.html, /data-feishu-downgraded-images="true"/);
});

test('userscript preserves downgraded image marker during clipboard html sanitization', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/feishu-helper.user.js'), 'utf8');
  assert.match(source, /'data-feishu-downgraded-images'\s*:\s*true/);
});

test('userscript resolves wiki obj_token with the GET get_node endpoint', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/feishu-helper.user.js'), 'utf8');
  assert.match(source, /\/space\/api\/wiki\/v2\/tree\/get_node\/\?wiki_token=/);
  assert.doesNotMatch(source, /_originalFetch\('\/space\/api\/wiki\/v2\/tree\/get_node\/', \{\s*method:\s*'POST'/);
});
