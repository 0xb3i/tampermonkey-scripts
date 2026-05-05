const test = require('node:test');
const assert = require('node:assert/strict');

const {
  alignStringToFeishuCode,
  cssColorToFeishuBgCode,
  cssColorToFeishuBorderColorCode,
  cssColorToFeishuTextCode,
  cssColorToHex,
  feishuCodeToAlignString,
  getCalloutMarkdownType,
  getEmoji,
  normalizeBlockStyle,
  normalizeCssColor,
  normalizeCssLength,
  normalizeCssRgb,
  normalizeEmojiId,
  normalizeTextAlign,
  resolveImageAlign,
  selectPrimaryCalloutContent,
} = require('../lib/feishu-style-codec.cjs');

test('normalizeCssColor maps integer codes to canonical css hex values', () => {
  assert.equal(normalizeCssColor(5), '#eff6ff');
  assert.equal(normalizeCssColor(14), '#e5e7eb');
});

test('normalizeCssColor accepts safe raw css colours', () => {
  assert.equal(normalizeCssColor('rgba(10, 20, 30, 0.5)'), 'rgba(10, 20, 30, 0.5)');
  assert.equal(normalizeCssColor('#abcdef'), '#abcdef');
});

test('normalizeCssColor rejects unsafe inputs with silent empty string', () => {
  assert.equal(normalizeCssColor('javascript:alert(1)'), '');
});

test('normalizeTextAlign covers integer enums and textual aliases', () => {
  assert.equal(normalizeTextAlign(1), 'left');
  assert.equal(normalizeTextAlign(2), 'center');
  assert.equal(normalizeTextAlign(3), 'right');
  assert.equal(normalizeTextAlign('Justify'), 'justify');
  assert.equal(normalizeTextAlign('unknown'), '');
});

test('normalizeCssLength only accepts numeric lengths with optional units', () => {
  assert.equal(normalizeCssLength('1.5em'), '1.5em');
  assert.equal(normalizeCssLength('10'), '10');
  assert.equal(normalizeCssLength('foo'), '');
});

test('normalizeEmojiId lower-cases ids for consistent callout typing', () => {
  assert.equal(normalizeEmojiId('  WARNING  '), 'warning');
});

test('cssColorToHex handles hex passthrough and rgb conversion', () => {
  assert.equal(cssColorToHex('#ff00aa'), '#ff00aa');
  assert.equal(cssColorToHex('rgb(255, 255, 255)'), '#ffffff');
});

test('css colour codes roundtrip to their Feishu integer representation', () => {
  assert.equal(cssColorToFeishuBgCode('#eff6ff'), 5);
  assert.equal(cssColorToFeishuBgCode('rgb(239,246,255)'), 5);
  assert.equal(cssColorToFeishuBorderColorCode('#bfdbfe'), 5);
  assert.equal(cssColorToFeishuTextCode('#ef4444'), 1);
});

test('alignStringToFeishuCode and feishuCodeToAlignString roundtrip', () => {
  assert.equal(alignStringToFeishuCode('left'), 1);
  assert.equal(feishuCodeToAlignString(2), 'center');
  assert.equal(alignStringToFeishuCode('none'), 0);
});

test('getCalloutMarkdownType selects admonition flavours based on emoji id', () => {
  assert.equal(getCalloutMarkdownType({ emoji_id: 'warning' }), 'WARNING');
  assert.equal(getCalloutMarkdownType({ emoji_id: 'light_bulb' }), 'TIP');
  assert.equal(getCalloutMarkdownType({ emoji_id: 'boom' }), 'CAUTION');
  assert.equal(getCalloutMarkdownType({ emoji_id: 'trophy' }), 'SUCCESS');
  assert.equal(getCalloutMarkdownType({ emoji_id: 'lock' }), 'IMPORTANT');
  assert.equal(getCalloutMarkdownType({ emoji_id: 'unknown' }), 'NOTE');
});

test('getEmoji returns the unicode glyph or empty string for unknown ids', () => {
  assert.equal(getEmoji('fire'), '🔥');
  assert.equal(getEmoji('nonexistent'), '');
});

test('normalizeBlockStyle produces a stable snapshot of style codes', () => {
  // `normalizeCssColor` always prefers the shared background palette when a
  // numeric code is provided, so `text_color: 1` resolves to the same hex as
  // the matching background slot.  Upstream callers rely on this behaviour
  // when rewriting inline text colours.
  assert.deepEqual(
    normalizeBlockStyle({
      align: 2,
      text_indent: '24px',
      text_color: 1,
      background_color: 5,
      border_color: '#bfdbfe',
      emoji_id: 'WARNING',
    }),
    {
      align: 'center',
      textIndent: '24px',
      textColor: '#fef2f2',
      backgroundColor: '#eff6ff',
      borderColor: '#bfdbfe',
      imageAlign: 'center',
      calloutEmojiId: 'warning',
    }
  );
});

test('resolveImageAlign defaults to centre when image lacks explicit align', () => {
  assert.equal(resolveImageAlign(null), 'center');
  assert.equal(resolveImageAlign({ imageAlign: 'left' }), 'left');
});

test('selectPrimaryCalloutContent prefers richer child content over raw snapshot text', () => {
  assert.equal(selectPrimaryCalloutContent('snap', 'child'), 'child');
  assert.equal(selectPrimaryCalloutContent('snap', '   '), 'snap');
  assert.equal(selectPrimaryCalloutContent('', ''), '');
});

test('normalizeCssRgb compacts rgb() strings into Feishu canonical form', () => {
  assert.equal(normalizeCssRgb('rgba(10, 20, 30, 0.5)'), 'rgb(10,20,30)');
  assert.equal(normalizeCssRgb('#ffffff'), '#ffffff');
});
