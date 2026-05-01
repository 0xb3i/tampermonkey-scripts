function deepCloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function pruneRemovedRecordIds(value, removedIds) {
  if (!value || !removedIds || removedIds.size === 0) return value;
  if (Array.isArray(value)) {
    const next = [];
    for (const item of value) {
      if (typeof item === 'string' && removedIds.has(item)) continue;
      if (item && typeof item === 'object' && typeof item.recordId === 'string' && removedIds.has(item.recordId)) {
        continue;
      }
      next.push(pruneRemovedRecordIds(item, removedIds));
    }
    return next;
  }
  if (typeof value !== 'object') return value;
  for (const key of Object.keys(value)) {
    value[key] = pruneRemovedRecordIds(value[key], removedIds);
  }
  return value;
}

function stripStructuredImageAttrsFromHtml(html) {
  if (!html || typeof html !== 'string') return html || '';
  return html.replace(/<figure\b([^>]*)>([\s\S]*?<img\b[^>]*src="data:image\/[^"]+"[^>]*>[\s\S]*?)<\/figure>/gi, (full, attrs, inner) => {
    let cleanedAttrs = attrs || '';
    cleanedAttrs = cleanedAttrs
      .replace(/\sdata-block-type="[^"]*"/gi, '')
      .replace(/\sdata-block-id="[^"]*"/gi, '')
      .replace(/\sdata-record-id="[^"]*"/gi, '')
      .replace(/\sdata-lark-record-data="[^"]*"/gi, '')
      .replace(/\sdata-meta-block-props="[^"]*"/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    cleanedAttrs = (cleanedAttrs ? cleanedAttrs + ' ' : '') + 'data-feishu-downgraded-images="true"';
    return '<figure ' + cleanedAttrs.trim() + '>' + inner + '</figure>';
  });
}

function downgradeStructuredImagesForPaste(options) {
  const config = options || {};
  const originalRecord = config.docxRecord || null;
  const originalHtml = typeof config.html === 'string' ? config.html : '';

  if (!originalRecord || !originalRecord.recordMap || typeof originalRecord.recordMap !== 'object') {
    return {
      docxRecord: originalRecord,
      html: originalHtml,
      removedImageRecordIds: [],
    };
  }

  const imageRecordIds = Object.keys(originalRecord.recordMap).filter((recordId) => {
    const record = originalRecord.recordMap[recordId];
    return !!(record && record.snapshot && record.snapshot.type === 'image');
  });

  if (!imageRecordIds.length) {
    return {
      docxRecord: originalRecord,
      html: originalHtml,
      removedImageRecordIds: [],
    };
  }

  const removedIds = new Set(imageRecordIds);
  const nextRecord = deepCloneJson(originalRecord);

  if (Array.isArray(nextRecord.recordIds)) {
    const paired = nextRecord.recordIds.map((recordId, index) => ({
      recordId,
      blockId: Array.isArray(nextRecord.blockIds) ? nextRecord.blockIds[index] : undefined,
    }));
    const kept = paired.filter((entry) => !removedIds.has(entry.recordId));
    nextRecord.recordIds = kept.map((entry) => entry.recordId);
    if (Array.isArray(nextRecord.blockIds)) {
      nextRecord.blockIds = kept.map((entry) => entry.blockId);
    }
  }

  if (Array.isArray(nextRecord.selection)) {
    nextRecord.selection = nextRecord.selection.filter((entry) => !(entry && removedIds.has(entry.recordId)));
  }

  if (nextRecord.payloadMap && typeof nextRecord.payloadMap === 'object') {
    imageRecordIds.forEach((recordId) => {
      delete nextRecord.payloadMap[recordId];
    });
  }

  Object.keys(nextRecord.recordMap).forEach((recordId) => {
    const record = nextRecord.recordMap[recordId];
    if (!record || !record.snapshot) return;
    record.snapshot = pruneRemovedRecordIds(record.snapshot, removedIds);
  });

  imageRecordIds.forEach((recordId) => {
    delete nextRecord.recordMap[recordId];
  });

  return {
    docxRecord: nextRecord,
    html: stripStructuredImageAttrsFromHtml(originalHtml),
    removedImageRecordIds: imageRecordIds,
  };
}

module.exports = {
  downgradeStructuredImagesForPaste,
  stripStructuredImageAttrsFromHtml,
};
