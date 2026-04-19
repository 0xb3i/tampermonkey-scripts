// 步骤1: 在 target 页面控制台执行这段代码（安装 hook）
window.__pasteLog = [];
var origSetData = DataTransfer.prototype.setData;
DataTransfer.prototype.setData = function(type, data) {
  window.__pasteLog.push({type: type, len: String(data||'').length, preview: String(data||'').slice(0,100)});
  return origSetData.apply(this, arguments);
};
console.log('hook installed, now do Cmd+Shift+D then Cmd+Shift+P');

// 步骤2: 粘贴后执行这段代码看结果
// JSON.stringify(window.__pasteLog)
