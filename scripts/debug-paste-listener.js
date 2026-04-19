// 在 target 页面控制台执行，然后做一次 Cmd+Shift+D → Cmd+Shift+P 粘贴
document.addEventListener('paste', function(e) {
  console.log('PASTE types:', Array.from(e.clipboardData.types));
  try {
    var docxData = e.clipboardData.getData('docx/record');
    console.log('docx/record length:', docxData.length);
    console.log('docx/record preview:', docxData.slice(0, 300));
  } catch(err) {
    console.log('no docx/record');
  }
  try {
    var html = e.clipboardData.getData('text/html');
    console.log('html has-block-data:', /data-docx-has-block-data/.test(html));
    console.log('html block-data value:', html.match(/data-docx-has-block-data="([^"]*)"/));
    console.log('html has zoneType-calloutBlock:', /zoneType-calloutBlock/.test(html));
    console.log('html has base64 img:', /data:image/.test(html));
    console.log('html has image token url:', /space\/api\/box\/stream\/download/.test(html));
  } catch(err) {
    console.log('html read error:', err);
  }
}, true);
