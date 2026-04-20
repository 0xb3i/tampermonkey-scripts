// ==UserScript==
// @name         Tap To Tab
// @namespace    https://local.userscripts.niubei/
// @version      0.1.0
// @description  Double-click a normal link to open it in a new tab while keeping single-click behavior with a short delay.
// @author       Codex
// @match        http://*/*
// @match        https://*/*
// @grant        GM_openInTab
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    doubleClickDelayMs: 150,
    openInBackground: false,
    cancelPendingOnOutsideClick: true,
    excludedHostPatterns: [
      // '*.example.com',
    ],
    debug: false,
  };

  const NAVIGABLE_PROTOCOLS = new Set(['http:', 'https:']);
  const REPLAYING_ANCHORS = new WeakSet();

  let pendingClick = null;
  let suppressedDblClick = null;

  if (isCurrentHostExcluded()) {
    return;
  }

  document.addEventListener('mousedown', handleMouseDown, true);
  document.addEventListener('click', handleClick, true);
  document.addEventListener('dblclick', handleDoubleClick, true);

  function log(...args) {
    if (CONFIG.debug) {
      console.debug('[TapToTab]', ...args);
    }
  }

  function handleMouseDown(event) {
    if (!pendingClick || !CONFIG.cancelPendingOnOutsideClick) {
      return;
    }

    if (event.button !== 0) {
      cancelPendingClick('non-left-mousedown');
      return;
    }

    const anchor = findAnchor(event);
    if (anchor !== pendingClick.anchor) {
      cancelPendingClick('mousedown-elsewhere');
    }
  }

  function handleClick(event) {
    const anchor = findAnchor(event);

    if (!isEligibleClick(event, anchor)) {
      if (!anchor && pendingClick && CONFIG.cancelPendingOnOutsideClick) {
        cancelPendingClick('click-outside-link');
      }
      return;
    }

    const linkUrl = resolveLinkUrl(anchor);
    if (!linkUrl) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();

    if (pendingClick && pendingClick.anchor === anchor) {
      const snapshot = consumePendingClick('double-click');
      suppressNextDblClick(anchor);
      openUrlInNewTab(snapshot.url);
      return;
    }

    cancelPendingClick('new-pending-click');
    pendingClick = {
      anchor,
      url: linkUrl,
      timerId: window.setTimeout(() => {
        replayPendingSingleClick();
      }, CONFIG.doubleClickDelayMs),
    };
    log('pending', linkUrl.href);
  }

  function handleDoubleClick(event) {
    if (!suppressedDblClick) {
      return;
    }

    if (Date.now() > suppressedDblClick.expiresAt) {
      suppressedDblClick = null;
      return;
    }

    const anchor = findAnchor(event);
    if (anchor === suppressedDblClick.anchor) {
      event.preventDefault();
      event.stopImmediatePropagation();
      log('suppressed dblclick', suppressedDblClick.href);
    }
  }

  function replayPendingSingleClick() {
    const snapshot = consumePendingClick('single-click');
    if (!snapshot) {
      return;
    }

    replayAnchorClick(snapshot.anchor, snapshot.url);
  }

  function replayAnchorClick(anchor, url) {
    if (!(anchor instanceof HTMLAnchorElement) || !anchor.isConnected) {
      window.location.assign(url.href);
      return;
    }

    REPLAYING_ANCHORS.add(anchor);
    try {
      anchor.click();
    } finally {
      REPLAYING_ANCHORS.delete(anchor);
    }
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

  function suppressNextDblClick(anchor) {
    suppressedDblClick = {
      anchor,
      href: anchor.href,
      expiresAt: Date.now() + 1000,
    };
  }

  function consumePendingClick(reason) {
    if (!pendingClick) {
      return null;
    }

    const snapshot = pendingClick;
    window.clearTimeout(snapshot.timerId);
    pendingClick = null;
    log('consume', reason, snapshot.url.href);
    return snapshot;
  }

  function cancelPendingClick(reason) {
    if (!pendingClick) {
      return;
    }

    window.clearTimeout(pendingClick.timerId);
    log('cancel', reason, pendingClick.url.href);
    pendingClick = null;
  }

  function isEligibleClick(event, anchor) {
    if (!(anchor instanceof HTMLAnchorElement)) {
      return false;
    }

    if (REPLAYING_ANCHORS.has(anchor)) {
      return false;
    }

    if (event.defaultPrevented || event.button !== 0) {
      return false;
    }

    if (event.detail === 0) {
      return false;
    }

    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return false;
    }

    if (isEditableTarget(event.target)) {
      return false;
    }

    if (anchor.hasAttribute('download')) {
      return false;
    }

    const target = (anchor.getAttribute('target') || '').trim().toLowerCase();
    if (target && target !== '_self') {
      return false;
    }

    const hrefAttr = (anchor.getAttribute('href') || '').trim();
    if (!hrefAttr || hrefAttr === '#') {
      return false;
    }

    const url = resolveLinkUrl(anchor);
    if (!url || !NAVIGABLE_PROTOCOLS.has(url.protocol)) {
      return false;
    }

    if (isSameDocumentAnchor(url)) {
      return false;
    }

    return true;
  }

  function resolveLinkUrl(anchor) {
    try {
      return new URL(anchor.href, window.location.href);
    } catch {
      return null;
    }
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

    if (!element) {
      return false;
    }

    return Boolean(
      element.closest(
        'input, textarea, select, option, [contenteditable=""], [contenteditable="true"], [role="textbox"]'
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
})();
