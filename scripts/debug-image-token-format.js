// source 页面执行，看替换后的 image token 格式
(function() {
  var d = window.__feishuLastDocxRecord;
  if (!d) { console.log('no data'); return; }
  var found = 0;
  Object.keys(d.recordMap).forEach(function(k) {
    var rec = d.recordMap[k];
    if (rec.snapshot && rec.snapshot.type === 'image' && rec.snapshot.image && found < 2) {
      found++;
      var t = rec.snapshot.image.token || '';
      console.log('image token type:', t.slice(0, 30), '...len:', t.length);
    }
  });
})();
