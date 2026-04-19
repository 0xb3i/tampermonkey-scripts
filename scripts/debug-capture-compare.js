// ===== 逐步排查 =====

// 步骤1: 先检查函数存在
console.log('__feishuCaptureNextCopy:', typeof window.__feishuCaptureNextCopy);

// 步骤2: 激活捕获
window.__feishuCaptureNextCopy();
console.log('捕获已激活');

// 步骤3: 现在去选中一个 callout，按 Cmd+C
// 等待 2-3 秒后，执行步骤4

// 步骤4: 检查捕获结果
console.log('__feishuLastCopyCapture:', window.__feishuLastCopyCapture);
console.log('rawData:', window.__feishuLastCopyCapture && window.__feishuLastCopyCapture.rawData);
console.log('setDataCalls:', window.__feishuLastCopyCapture && window.__feishuLastCopyCapture.setDataCalls);

// 步骤5: 如果上面有数据，看 docx/record
if (window.__feishuLastCopyCapture && window.__feishuLastCopyCapture.rawData) {
  var keys = Object.keys(window.__feishuLastCopyCapture.rawData);
  console.log('rawData keys:', keys);
  keys.forEach(function(k) {
    console.log(k, 'length:', window.__feishuLastCopyCapture.rawData[k].length);
  });
}
