// 在 source 页面，按 Cmd+Shift+D 后执行
// 检查 docxRecord 中的 image token 是否被替换为 base64
(function() {
  var d = window.__feishuLastDocxRecord;
  if (!d) {
    console.log('no __feishuLastDocxRecord, try Cmd+Shift+D first');
    return;
  }
  var count = 0, base64Count = 0, origCount = 0;
  var samples = [];
  Object.keys(d.recordMap).forEach(function(k) {
    var rec = d.recordMap[k];
    if (rec.snapshot && rec.snapshot.type === 'image' && rec.snapshot.image) {
      count++;
      var t = rec.snapshot.image.token || '';
      var isB64 = t.indexOf('data:image') === 0;
      if (isB64) base64Count++; else origCount++;
      if (samples.length < 3) {
        samples.push({ tokenStart: t.slice(0,60), isBase64: isB64 });
      }
    }
  });
  console.log('image total:', count, 'base64:', base64Count, 'original:', origCount);
  console.log('samples:', samples);
})();
