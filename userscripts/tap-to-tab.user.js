// ==UserScript==
// @name         Tap To Tab
// @namespace    https://local.userscripts.niubei/
// @version      0.3.0
// @description  Hold a normal link to open it in a new tab without delaying regular clicks.
// @author       Codex
// @match        http://*/*
// @match        https://*/*
// @grant        GM_openInTab
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    holdDelayMs: 300,
    movementTolerancePx: 16,
    openInBackground: false,
    excludedHostPatterns: [
      // '*.example.com',
    ],
    debug: false,
  };

  const NAVIGABLE_PROTOCOLS = new Set(['http:', 'https:']);
  const PRESSING_ATTRIBUTE = 'data-tap-to-tab-pressing';
  const READY_ATTRIBUTE = 'data-tap-to-tab-ready';
  const FEEDBACK_STYLE_ID = 'tap-to-tab-feedback-style';

  let activePress = null;
  let guardedClick = null;
  let guardedClickTimerId = null;

  if (isCurrentHostExcluded()) {
    return;
  }

  installFeedbackStyle();

  document.addEventListener('pointerdown', handlePointerDown, true);
  document.addEventListener('pointermove', handlePointerMove, true);
  document.addEventListener('pointerup', handlePointerUp, true);
  document.addEventListener('pointercancel', handlePointerCancel, true);
  document.addEventListener('dragstart', handleDragStart, true);
  document.addEventListener('webkitmouseforcewillbegin', handleForcePress, true);
  window.addEventListener('click', handleGuardedClick, true);
  window.addEventListener('blur', cancelActivePress, true);
  document.addEventListener('visibilitychange', handleVisibilityChange, true);

  function log(...args) {
    if (CONFIG.debug) {
      console.debug('[TapToTab]', ...args);
    }
  }

  function installFeedbackStyle() {
    if (!document.createElement || !document.documentElement) {
      return;
    }
    if (document.getElementById && document.getElementById(FEEDBACK_STYLE_ID)) {
      return;
    }

    const style = document.createElement('style');
    style.id = FEEDBACK_STYLE_ID;
    style.textContent = [
      `[${PRESSING_ATTRIBUTE}] {`,
      '  -webkit-user-select: none !important;',
      '  user-select: none !important;',
      '}',
      `[${READY_ATTRIBUTE}] {`,
      '  outline: 2px solid #1677ff !important;',
      '  outline-offset: 2px !important;',
      '  cursor: alias !important;',
      '}',
    ].join('\n');
    document.documentElement.appendChild(style);
  }

  function handlePointerDown(event) {
    cancelActivePress('new-pointerdown');

    const anchor = findAnchor(event);
    if (!isEligiblePointer(event, anchor)) {
      return;
    }

    const url = resolveLinkUrl(anchor);
    if (!url) {
      return;
    }

    const press = {
      pointerId: event.pointerId,
      anchor,
      url,
      startedAt: now(),
      startX: event.clientX,
      startY: event.clientY,
      maxDistanceSquared: 0,
      armed: false,
      timerId: null,
    };

    press.timerId = window.setTimeout(() => {
      if (activePress !== press || !press.anchor.isConnected) {
        return;
      }
      press.armed = true;
      press.anchor.setAttribute(READY_ATTRIBUTE, '');
      log('armed', press.url.href);
    }, CONFIG.holdDelayMs);

    activePress = press;
    press.anchor.setAttribute(PRESSING_ATTRIBUTE, '');
    log('pressing', url.href);
  }

  function handlePointerMove(event) {
    if (!isActivePointer(event)) {
      return;
    }

    const deltaX = event.clientX - activePress.startX;
    const deltaY = event.clientY - activePress.startY;
    const distanceSquared = (deltaX * deltaX) + (deltaY * deltaY);
    const toleranceSquared = CONFIG.movementTolerancePx * CONFIG.movementTolerancePx;
    activePress.maxDistanceSquared = Math.max(activePress.maxDistanceSquared, distanceSquared);
    if (activePress.maxDistanceSquared > toleranceSquared) {
      cancelActivePress('pointer-moved');
    }
  }

  function handleDragStart(event) {
    if (!activePress || findAnchor(event) !== activePress.anchor) {
      return;
    }

    const toleranceSquared = CONFIG.movementTolerancePx * CONFIG.movementTolerancePx;
    if (activePress.maxDistanceSquared <= toleranceSquared) {
      event.preventDefault();
      log('suppressed accidental drag', activePress.url.href);
      return;
    }

    cancelActivePress('drag-started');
  }

  function handleForcePress(event) {
    if (!activePress || findAnchor(event) !== activePress.anchor) {
      return;
    }

    event.preventDefault();
    log('suppressed force click lookup', activePress.url.href);
  }

  function handlePointerUp(event) {
    if (!isActivePointer(event)) {
      return;
    }

    const press = activePress;
    const releasedAnchor = findAnchor(event);
    const heldLongEnough = press.armed || now() - press.startedAt >= CONFIG.holdDelayMs;
    const shouldOpen = heldLongEnough &&
      releasedAnchor === press.anchor &&
      press.anchor.isConnected &&
      !hasModifierKey(event);

    clearActivePress();

    if (!shouldOpen) {
      log('short press', press.url.href);
      return;
    }

    guardNextClick(press.anchor);
    event.preventDefault();
    openUrlInNewTab(press.url);
  }

  function handlePointerCancel(event) {
    if (!isActivePointer(event)) {
      return;
    }

    const press = activePress;
    const heldLongEnough = press.armed || now() - press.startedAt >= CONFIG.holdDelayMs;
    const shouldOpen = heldLongEnough && press.anchor.isConnected;
    clearActivePress();

    if (!shouldOpen) {
      log('cancelled', 'pointer-cancelled', press.url.href);
      return;
    }

    guardNextClick(press.anchor);
    if (event.cancelable) {
      event.preventDefault();
    }
    openUrlInNewTab(press.url);
  }

  function handleGuardedClick(event) {
    if (!guardedClick) {
      return;
    }

    const guardedAnchor = guardedClick.anchor;
    clearGuardedClick();
    if (findAnchor(event) !== guardedAnchor) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    log('suppressed native click', guardedAnchor.href);
  }

  function handleVisibilityChange() {
    if (document.hidden) {
      cancelActivePress('document-hidden');
    }
  }

  function isActivePointer(event) {
    return Boolean(activePress && event.pointerId === activePress.pointerId);
  }

  function clearActivePress() {
    if (!activePress) {
      return null;
    }

    const press = activePress;
    activePress = null;
    window.clearTimeout(press.timerId);
    if (press.anchor && press.anchor.removeAttribute) {
      press.anchor.removeAttribute(PRESSING_ATTRIBUTE);
      press.anchor.removeAttribute(READY_ATTRIBUTE);
    }
    return press;
  }

  function cancelActivePress(reason) {
    const press = clearActivePress();
    if (press) {
      log('cancelled', reason, press.url.href);
    }
  }

  function guardNextClick(anchor) {
    clearGuardedClick();
    guardedClick = { anchor };
    guardedClickTimerId = window.setTimeout(clearGuardedClick, 0);
  }

  function clearGuardedClick() {
    if (guardedClickTimerId !== null) {
      window.clearTimeout(guardedClickTimerId);
      guardedClickTimerId = null;
    }
    guardedClick = null;
  }

  function openUrlInNewTab(url) {
    log('open new tab', url.href);

    if (typeof GM_openInTab === 'function') {
      GM_openInTab(url.href, {
        active: !CONFIG.openInBackground,
        insert: true,
        setParent: true,
      });
      return;
    }

    window.open(url.href, '_blank', 'noopener,noreferrer');
  }

  function isEligiblePointer(event, anchor) {
    if (!(anchor instanceof HTMLAnchorElement)) {
      return false;
    }
    if (event.isPrimary === false || event.button !== 0) {
      return false;
    }
    if (event.pointerType && event.pointerType !== 'mouse') {
      return false;
    }
    if (hasModifierKey(event)) {
      return false;
    }
    if (isEditableTarget(event.target)) {
      return false;
    }
    if (anchor.hasAttribute('download') || anchor.getAttribute('aria-disabled') === 'true') {
      return false;
    }
    if (anchor.closest && anchor.closest('[inert]')) {
      return false;
    }

    const target = (anchor.getAttribute('target') || '').trim().toLowerCase();
    if (target && target !== '_self') {
      return false;
    }

    const hrefAttribute = (anchor.getAttribute('href') || '').trim();
    if (!hrefAttribute || hrefAttribute === '#') {
      return false;
    }

    const url = resolveLinkUrl(anchor);
    if (!url || !NAVIGABLE_PROTOCOLS.has(url.protocol)) {
      return false;
    }

    return !isSameDocumentAnchor(url);
  }

  function resolveLinkUrl(anchor) {
    try {
      return new URL(anchor.href, window.location.href);
    } catch {
      return null;
    }
  }

  function hasModifierKey(event) {
    return Boolean(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
  }

  function isSameDocumentAnchor(url) {
    return (
      url.origin === window.location.origin &&
      url.pathname === window.location.pathname &&
      url.search === window.location.search &&
      url.hash &&
      url.hash !== window.location.hash
    );
  }

  function isEditableTarget(target) {
    let element = target instanceof Element ? target : null;
    if (!element && target instanceof Node) {
      element = target.parentElement;
    }

    return Boolean(
      element && element.closest(
        'input, textarea, select, option, [contenteditable]:not([contenteditable="false"]), [role="textbox"]'
      )
    );
  }

  function findAnchor(event) {
    if (typeof event.composedPath === 'function') {
      for (const node of event.composedPath()) {
        if (node instanceof HTMLAnchorElement && node.href) {
          return node;
        }
      }
    }

    let element = event.target instanceof Element ? event.target : null;
    if (!element && event.target instanceof Node) {
      element = event.target.parentElement;
    }

    return element ? element.closest('a[href]') : null;
  }

  function isCurrentHostExcluded() {
    return CONFIG.excludedHostPatterns.some((pattern) =>
      wildcardPatternToRegExp(pattern).test(window.location.hostname)
    );
  }

  function wildcardPatternToRegExp(pattern) {
    const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`, 'i');
  }

  function now() {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now();
    }
    return Date.now();
  }
})();
