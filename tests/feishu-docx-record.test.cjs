const test = require('node:test');
const assert = require('node:assert/strict');

const {
  deepCloneJson,
  downgradeStructuredImagesForPaste,
  listImageRecords,
  pruneRemovedRecordIds,
  replaceTokensInDocxRecord,
  sanitizeSnapshotForRecord,
  stripStructuredImageAttrsFromHtml,
} = require('../lib/feishu-docx-record.cjs');

test('deepCloneJson returns structurally independent copies', () => {
  const input = { a: [1, { b: 2 }] };
  const clone = deepCloneJson(input);
  clone.a[1].b = 99;
  assert.equal(input.a[1].b, 2);
});

test('pruneRemovedRecordIds drops string ids and objects carrying removed recordId', () => {
  const removedIds = new Set(['img-1']);
  const data = {
    children: ['img-1', 'text-1'],
    selection: [
      { recordId: 'img-1' },
      { recordId: 'text-1' },
    ],
    meta: { recordId: 'img-1' },
  };
  pruneRemovedRecordIds(data, removedIds);
  assert.deepEqual(data.children, ['text-1']);
  assert.deepEqual(data.selection, [{ recordId: 'text-1' }]);
});

test('stripStructuredImageAttrsFromHtml keeps caller-free html when no base64 figure is present', () => {
  const html = '<div><figure><img src="https://x/y.png"></figure></div>';
  assert.equal(stripStructuredImageAttrsFromHtml(html), html);
});

test('downgradeStructuredImagesForPaste removes image blocks and flags figures as downgraded', () => {
  const record = {
    rootId: 'page-1',
    blockIds: [1, 2],
    recordIds: ['text-1', 'img-1'],
    recordMap: {
      'page-1': { id: 'page-1', snapshot: { type: 'page', children: ['text-1', 'img-1'] } },
      'text-1': { id: 'text-1', snapshot: { type: 'text' } },
      'img-1': { id: 'img-1', snapshot: { type: 'image', image: { token: 'tok-1' } } },
    },
    selection: [
      { id: 2, type: 'block', recordId: 'text-1' },
      { id: 3, type: 'block', recordId: 'img-1' },
    ],
  };
  const html = '<div><figure data-block-type="image" data-block-id="b"><img src="data:image/png;base64,AA"></figure></div>';

  const result = downgradeStructuredImagesForPaste({ docxRecord: record, html });
  assert.deepEqual(result.removedImageRecordIds, ['img-1']);
  assert.equal(result.docxRecord.recordMap['img-1'], undefined);
  assert.deepEqual(result.docxRecord.recordMap['page-1'].snapshot.children, ['text-1']);
  assert.match(result.html, /data-feishu-downgraded-images="true"/);
});

test('replaceTokensInDocxRecord rewrites image tokens without mutating the original record', () => {
  const record = {
    recordMap: {
      'img-1': { id: 'img-1', snapshot: { type: 'image', image: { token: 'old' } } },
    },
  };
  const replaced = replaceTokensInDocxRecord(record, { old: 'new' });
  assert.equal(record.recordMap['img-1'].snapshot.image.token, 'old');
  assert.equal(replaced.recordMap['img-1'].snapshot.image.token, 'new');
});

test('listImageRecords surfaces every image record with its embedded image descriptor', () => {
  const record = {
    recordMap: {
      'img-1': { id: 'img-1', snapshot: { type: 'image', image: { token: 'a' } } },
      'text-1': { id: 'text-1', snapshot: { type: 'text' } },
      'img-2': { id: 'img-2', snapshot: { type: 'image', image: { token: 'b' } } },
    },
  };
  const list = listImageRecords(record).map(function (entry) { return entry.image.token; }).sort();
  assert.deepEqual(list, ['a', 'b']);
});

test('sanitizeSnapshotForRecord drops react internals and function values', () => {
  const snap = {
    type: 'image',
    _reactFiber$: { ghost: true },
    handler: function () {},
    image: { token: 'a' },
  };
  const cleaned = sanitizeSnapshotForRecord(snap);
  assert.equal(cleaned._reactFiber$, undefined);
  assert.equal(cleaned.handler, undefined);
  assert.deepEqual(cleaned.image, { token: 'a' });
});
