const test = require('node:test');
const assert = require('node:assert/strict');

const attribs = require('../lib/feishu-attribs.cjs');
const styleCodec = require('../lib/feishu-style-codec.cjs');
const docxRecord = require('../lib/feishu-docx-record.cjs');
const { createBlockRenderer } = require('../lib/feishu-block-render.cjs');

// Minimal sanitizer stand-in; the renderer only uses finalizeHtmlFragment to
// concat child fragments, so a pass-through implementation is enough for unit
// tests that don't depend on DOM behaviour.
const sanitizer = {
  finalizeHtmlFragment: function (html) { return String(html || ''); },
  buildClipboardHtml: function (html) { return String(html || ''); },
};

const renderer = createBlockRenderer({
  attribs: attribs,
  styleCodec: styleCodec,
  sanitizer: sanitizer,
  docxRecord: docxRecord,
});

function buildTextBlock(textValue, overrides) {
  return Object.assign({
    record: {
      id: 'text-1',
      snapshot: Object.assign({
        type: 'text',
        text: {
          initialAttributedTexts: {
            text: { 0: textValue },
            attribs: { 0: '*0+' + textValue.length.toString(36) },
          },
          apool: { numToAttrib: { 0: ['bold', 'false'] } },
        },
      }, overrides || {}),
    },
  }, {});
}

test('blockToHtml wraps paragraph content in <p> with the canonical paragraph style', () => {
  var block = buildTextBlock('hello world');
  var html = renderer.blockToHtml(block.record.snapshot, block, [], {});
  assert.match(html, /^<p style="margin:0\.75em 0;">hello world<\/p>$/);
});

test('blockToHtml renders headings with the heading tag matching snapshot type', () => {
  var snap = {
    type: 'heading2',
    text: {
      initialAttributedTexts: {
        text: { 0: 'Title' },
        attribs: { 0: '*0+5' },
      },
      apool: { numToAttrib: { 0: ['bold', 'false'] } },
    },
  };
  var html = renderer.blockToHtml(snap, null, [], {});
  assert.match(html, /^<h2 style="margin:1\.2em 0 0\.6em;line-height:1\.35;">Title<\/h2>$/);
});

test('blockToMarkdown converts images using the supplied location origin', () => {
  var snap = {
    type: 'image',
    image: { token: 'abc', name: 'demo' },
  };
  var md = renderer.blockToMarkdown(snap, null, null, { locationOrigin: 'https://example.com' });
  assert.equal(
    md,
    '![demo](https://example.com/space/api/box/stream/download/preview/abc/?preview_type=16)'
  );
});

test('blockToMarkdown emits the list prefix and indents children two spaces', () => {
  var snap = {
    type: 'bullet',
    text: {
      initialAttributedTexts: {
        text: { 0: 'parent' },
        attribs: { 0: '*0+6' },
      },
      apool: { numToAttrib: { 0: ['bold', 'false'] } },
    },
  };
  var md = renderer.blockToMarkdown(snap, null, ['- child'], {});
  assert.equal(md, '- parent\n  - child');
});

test('blockToMarkdown renders callouts as blockquote admonitions', () => {
  var snap = {
    type: 'callout',
    emoji_id: 'warning',
    text: {
      initialAttributedTexts: {
        text: { 0: 'be careful' },
        attribs: { 0: '*0+a' },
      },
      apool: { numToAttrib: { 0: ['bold', 'false'] } },
    },
  };
  var md = renderer.blockToMarkdown(snap, null, null, {});
  assert.equal(md, '> [!WARNING]\n> be careful');
});

test('buildDocxRecordPayload lifts only direct children of the page into recordIds', () => {
  var pageBlock = {
    record: { id: 'page-1', snapshot: { type: 'page' } },
    children: [
      {
        record: { id: 'txt-1', snapshot: { type: 'text' } },
        children: [],
      },
      {
        record: {
          id: 'quote-1',
          snapshot: { type: 'quote_container' },
        },
        children: [
          {
            record: { id: 'inner-1', snapshot: { type: 'text' } },
            children: [],
          },
        ],
      },
    ],
  };

  var payload = renderer.buildDocxRecordPayload(pageBlock);
  assert.ok(payload);
  assert.equal(payload.rootId, 'page-1');
  assert.deepEqual(payload.recordIds.sort(), ['quote-1', 'txt-1']);
  assert.equal(Object.keys(payload.payloadMap).length, 1);
  assert.ok(payload.payloadMap['inner-1']);
});

test('renderRootBlock walks the page tree into html + markdown parts and counts', () => {
  var pageBlock = {
    record: { id: 'page-1', snapshot: { type: 'page' } },
    children: [
      buildTextBlock('hello'),
      {
        record: {
          id: 'code-1',
          snapshot: {
            type: 'code',
            language: 'ts',
            text: {
              initialAttributedTexts: {
                text: { 0: 'const x = 1;' },
                attribs: { 0: '*0+c' },
              },
              apool: { numToAttrib: { 0: ['bold', 'false'] } },
            },
          },
        },
      },
    ],
  };

  var rendered = renderer.renderRootBlock(pageBlock, {});
  assert.equal(rendered.blockCount, 2);
  assert.ok(rendered.blockTypeCounts.text);
  assert.ok(rendered.blockTypeCounts.code);
  assert.ok(rendered.htmlParts.length >= 2);
  assert.match(rendered.mdParts[1], /```ts/);
});
