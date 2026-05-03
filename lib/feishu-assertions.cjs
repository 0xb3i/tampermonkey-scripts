function toNumber(value, fallback) {
  var num = Number(value);
  return Number.isFinite(num) ? num : Number(fallback || 0);
}

function normalizeTextSample(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeComponent(component) {
  var source = component || {};
  return {
    type: String(source.type || ''),
    textSample: normalizeTextSample(source.textSample),
    rendered: source.rendered === true,
    rowCount: toNumber(source.rowCount, 0),
    colCount: toNumber(source.colCount, 0),
    width: toNumber(source.width, 0),
    height: toNumber(source.height, 0),
    cellTexts: Array.isArray(source.cellTexts)
      ? source.cellTexts.map(normalizeTextSample).filter(Boolean)
      : [],
  };
}

function normalizeSemanticSnapshot(snapshot) {
  var source = snapshot || {};
  var components = Array.isArray(source.components)
    ? source.components.map(normalizeComponent).filter(function (component) {
      return !!component.type;
    })
    : [];
  var componentCounts = {};
  var derivedCounts = {};

  Object.keys(source.componentCounts || {}).forEach(function (type) {
    componentCounts[String(type)] = toNumber(source.componentCounts[type], 0);
  });

  components.forEach(function (component) {
    if (!(component.type in derivedCounts)) {
      derivedCounts[component.type] = 0;
    }
    derivedCounts[component.type] += 1;
  });

  Object.keys(derivedCounts).forEach(function (type) {
    componentCounts[type] = Math.max(
      toNumber(componentCounts[type], 0),
      toNumber(derivedCounts[type], 0)
    );
  });

  return {
    components: components,
    componentCounts: componentCounts,
  };
}

function getValidationSnapshot(payload) {
  return payload && payload.validationSnapshot ? payload.validationSnapshot : {};
}

function getExtractionSummary(result) {
  var source = result && result.source ? result.source : {};
  var automationSummary = source.automation && source.automation.summary ? source.automation.summary : {};
  var extractionResult = source.artifacts && source.artifacts.extractionResult ? source.artifacts.extractionResult : {};
  var validationSnapshot = getValidationSnapshot(automationSummary);
  var fallbackSnapshot = source.artifacts && source.artifacts.validationSnapshot ? source.artifacts.validationSnapshot : {};

  return {
    blockCount: toNumber(
      extractionResult.blockCount || validationSnapshot.blockCount || fallbackSnapshot.blockCount,
      0
    ),
    equationCount: toNumber(
      extractionResult.equationCount || validationSnapshot.equationCount || fallbackSnapshot.equationCount,
      0
    ),
    pendingPasteTs: toNumber(automationSummary.pendingPaste && automationSummary.pendingPaste.ts, 0),
    semanticSnapshot: normalizeSemanticSnapshot(
      automationSummary.semanticSnapshot
      || validationSnapshot.semanticSnapshot
      || fallbackSnapshot.semanticSnapshot
      || extractionResult.semanticSnapshot
    ),
  };
}

function getTargetSummary(result) {
  var target = result && result.target ? result.target : {};
  var artifacts = target.artifacts || {};
  var uploadResult = artifacts.uploadResult || {};
  var validationSnapshot = (target.validation && target.validation.afterPasteSnapshot)
    || artifacts.validationSnapshot
    || {};

  return {
    pasteChanged: !!(target.validation && target.validation.pasteAttempt && target.validation.pasteAttempt.changed),
    uploadResult: {
      uploadedCount: toNumber(
        uploadResult.uploadedCount || uploadResult.count || Object.keys(uploadResult.tokenMap || {}).length,
        0
      ),
      failedCount: toNumber(uploadResult.failedCount, 0),
    },
    semanticSnapshot: normalizeSemanticSnapshot(validationSnapshot.semanticSnapshot),
  };
}

function addFailure(failures, path, message) {
  failures.push({
    path: String(path || ''),
    message: String(message || ''),
  });
}

function compareTextSample(sourceComponent, targetComponent) {
  if (!sourceComponent.textSample) return true;
  if (!targetComponent.textSample) return false;
  return targetComponent.textSample.indexOf(sourceComponent.textSample) !== -1
    || sourceComponent.textSample.indexOf(targetComponent.textSample) !== -1;
}

function compareCellTexts(sourceComponent, targetComponent) {
  if (!sourceComponent.cellTexts.length) return true;
  if (!targetComponent.cellTexts.length) return false;
  return sourceComponent.cellTexts.every(function (cellText) {
    return targetComponent.cellTexts.some(function (candidate) {
      return candidate.indexOf(cellText) !== -1 || cellText.indexOf(candidate) !== -1;
    });
  });
}

function componentTextContains(component, sample) {
  var normalizedSample = normalizeTextSample(sample);
  if (!normalizedSample) return true;
  return normalizeTextSample(component && component.textSample).indexOf(normalizedSample) !== -1;
}

function componentMatchesAnyTextSample(component, samples) {
  return (Array.isArray(samples) ? samples : []).some(function (sample) {
    return componentTextContains(component, sample);
  });
}

function isRenderedTargetComponent(component) {
  if (!component) return false;
  if (component.type === 'image') {
    return component.rendered && component.width > 0 && component.height > 0;
  }
  return component.rendered === true;
}

function componentMatches(sourceComponent, targetComponent) {
  if (!targetComponent || targetComponent.type !== sourceComponent.type) return false;

  if (sourceComponent.type === 'table') {
    return targetComponent.rowCount >= sourceComponent.rowCount
      && targetComponent.colCount >= sourceComponent.colCount
      && compareCellTexts(sourceComponent, targetComponent);
  }

  if (sourceComponent.type === 'image') {
    return targetComponent.rendered
      && targetComponent.width > 0
      && targetComponent.height > 0;
  }

  return compareTextSample(sourceComponent, targetComponent);
}

function collectFeishuCaseFailures(result) {
  var testCase = result && result.testCase ? result.testCase : {};
  var expect = testCase.expect || {};
  var extraction = expect.extraction || {};
  var upload = expect.upload || {};
  var paste = expect.paste || {};
  var render = expect.render || {};
  var sourceSummary = getExtractionSummary(result);
  var targetSummary = getTargetSummary(result);
  var failures = [];

  if (sourceSummary.blockCount < toNumber(extraction.minBlockCount, 0)) {
    addFailure(
      failures,
      'extraction.minBlockCount',
      'expected blockCount >= ' + toNumber(extraction.minBlockCount, 0) + ', got ' + sourceSummary.blockCount
    );
  }

  if (sourceSummary.equationCount < toNumber(extraction.minEquationCount, 0)) {
    addFailure(
      failures,
      'extraction.minEquationCount',
      'expected equationCount >= ' + toNumber(extraction.minEquationCount, 0) + ', got ' + sourceSummary.equationCount
    );
  }

  if (extraction.requirePendingPaste && sourceSummary.pendingPasteTs <= 0) {
    addFailure(failures, 'extraction.requirePendingPaste', 'pending paste timestamp missing');
  }

  (extraction.requiredSourceComponentTypes || []).forEach(function (type) {
    if (toNumber(sourceSummary.semanticSnapshot.componentCounts[type], 0) <= 0) {
      addFailure(failures, 'extraction.requiredSourceComponentTypes', 'missing source component type ' + type);
    }
  });

  if (upload.requireUploadedImages) {
    var sourceImageCount = toNumber(sourceSummary.semanticSnapshot.componentCounts.image, 0);
    if (sourceImageCount > 0 && targetSummary.uploadResult.uploadedCount < sourceImageCount) {
      addFailure(
        failures,
        'upload',
        'uploadedCount=' + targetSummary.uploadResult.uploadedCount + ' is less than source imageCount=' + sourceImageCount
      );
    }
  }

  if (targetSummary.uploadResult.failedCount > toNumber(upload.maxFailedUploads, 0)) {
    addFailure(
      failures,
      'upload',
      'failedCount=' + targetSummary.uploadResult.failedCount + ' exceeds maxFailedUploads=' + toNumber(upload.maxFailedUploads, 0)
    );
  }

  if (upload.minUploadedCount > 0 && targetSummary.uploadResult.uploadedCount < toNumber(upload.minUploadedCount, 0)) {
    addFailure(
      failures,
      'upload',
      'uploadedCount=' + targetSummary.uploadResult.uploadedCount + ' is less than minUploadedCount=' + toNumber(upload.minUploadedCount, 0)
    );
  }

  if (paste.requireChanged && !targetSummary.pasteChanged) {
    addFailure(failures, 'paste.requireChanged', 'target snapshot did not change after paste');
  }

  (Array.isArray(render.requiredTargetComponents) ? render.requiredTargetComponents : []).forEach(function (rule) {
    var normalizedRule = rule || {};
    var type = String(normalizedRule.type || '');
    if (!type) return;

    var minCount = toNumber(normalizedRule.minCount, 1);
    var targetComponents = targetSummary.semanticSnapshot.components.filter(function (component) {
      return component.type === type;
    });
    var targetCount = toNumber(targetSummary.semanticSnapshot.componentCounts[type], 0);

    if (targetCount < minCount) {
      addFailure(
        failures,
        'render.requiredTargetComponents',
        'component type ' + type + ' expected at least ' + minCount + ', got ' + targetCount
      );
      return;
    }

    if (normalizedRule.requireRendered) {
      var renderedCount = targetComponents.filter(isRenderedTargetComponent).length;
      if (renderedCount < minCount) {
        addFailure(
          failures,
          'render.requiredTargetComponents',
          'rendered component type ' + type + ' expected at least ' + minCount + ', got ' + renderedCount
        );
      }
    }

    (Array.isArray(normalizedRule.requiredTextSamples) ? normalizedRule.requiredTextSamples : []).forEach(function (sample) {
      var matched = targetComponents.some(function (component) {
        return componentTextContains(component, sample);
      });
      if (!matched) {
        addFailure(
          failures,
          'render.requiredTargetComponents',
          'missing target text anchor for ' + type + ' "' + normalizeTextSample(sample) + '"'
        );
      }
    });

    (Array.isArray(normalizedRule.requiredTextGroups) ? normalizedRule.requiredTextGroups : []).forEach(function (group) {
      var normalizedGroup = Array.isArray(group) ? group.map(normalizeTextSample).filter(Boolean) : [];
      if (!normalizedGroup.length) return;

      var matched = targetComponents.some(function (component) {
        return componentMatchesAnyTextSample(component, normalizedGroup);
      });

      if (!matched) {
        addFailure(
          failures,
          'render.requiredTargetComponents',
          'missing target text anchor group for ' + type + ' [' + normalizedGroup.join(' | ') + ']'
        );
      }
    });
  });

  if (render.compareSourceComponents) {
    var compareConfig = render.compareSourceComponents;
    var componentTypes = Array.isArray(compareConfig.componentTypes)
      ? compareConfig.componentTypes
      : Object.keys(sourceSummary.semanticSnapshot.componentCounts);
    var targetComponents = targetSummary.semanticSnapshot.components;

    componentTypes.forEach(function (type) {
      var sourceCount = toNumber(sourceSummary.semanticSnapshot.componentCounts[type], 0);
      var targetCount = toNumber(targetSummary.semanticSnapshot.componentCounts[type], 0);
      if (sourceCount <= 0) return;
      if (targetCount < sourceCount) {
        addFailure(
          failures,
          'render.compareSourceComponents',
          'component type ' + type + ' expected at least ' + sourceCount + ', got ' + targetCount
        );
      }
    });

    sourceSummary.semanticSnapshot.components.forEach(function (sourceComponent) {
      if (componentTypes.indexOf(sourceComponent.type) === -1) return;
      var candidates = targetComponents.filter(function (targetComponent) {
        return targetComponent.type === sourceComponent.type;
      });
      var matched = candidates.some(function (candidate) {
        return componentMatches(sourceComponent, candidate);
      });
      if (!matched) {
        addFailure(
          failures,
          'render.compareSourceComponents',
          'missing semantic match for ' + sourceComponent.type + (sourceComponent.textSample ? ' "' + sourceComponent.textSample + '"' : '')
        );
      }
    });

    if (compareConfig.requireRenderedImages) {
      var sourceImageCount = toNumber(sourceSummary.semanticSnapshot.componentCounts.image, 0);
      var renderedTargetImageCount = targetComponents.filter(function (component) {
        return component.type === 'image' && component.rendered && component.width > 0 && component.height > 0;
      }).length;
      if (sourceImageCount > 0 && renderedTargetImageCount < sourceImageCount) {
        addFailure(
          failures,
          'render.compareSourceComponents',
          'rendered image count ' + renderedTargetImageCount + ' is less than source image count ' + sourceImageCount
        );
      }
    }
  }

  return failures;
}

function summarizeFeishuCaseFailures(failures) {
  return (failures || []).map(function (failure) {
    return failure.path + ': ' + failure.message;
  }).join('; ');
}

function assertFeishuCaseResult(result) {
  var failures = collectFeishuCaseFailures(result);
  if (failures.length) {
    throw new Error(summarizeFeishuCaseFailures(failures));
  }
}

module.exports = {
  assertFeishuCaseResult,
  collectFeishuCaseFailures,
  normalizeSemanticSnapshot,
  summarizeFeishuCaseFailures,
};
