const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SCRIPT_PATH = path.join(__dirname, '../userscripts/tap-to-tab.user.js');

function createRuntime() {
  const source = fs.readFileSync(SCRIPT_PATH, 'utf8');
  const listeners = {
    document: new Map(),
    window: new Map(),
  };
  const timers = new Map();
  const openedTabs = [];
  let nextTimerId = 1;
  let currentTime = 0;

  class FakeNode {}

  class FakeElement extends FakeNode {
    constructor() {
      super();
      this.parentElement = null;
      this.isConnected = true;
      this.attributes = new Map();
    }

    closest(selector) {
      if (selector === 'a[href]' && this instanceof FakeAnchor) return this;
      if (selector === '[inert]' && this.inert) return this;
      if (selector.includes('contenteditable') && this.editable) return this;
      return null;
    }

    hasAttribute(name) {
      return this.attributes.has(name);
    }

    getAttribute(name) {
      return this.attributes.has(name) ? this.attributes.get(name) : null;
    }

    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    }

    removeAttribute(name) {
      this.attributes.delete(name);
    }
  }

  class FakeAnchor extends FakeElement {
    constructor(href) {
      super();
      this.href = href;
      this.setAttribute('href', href);
    }
  }

  function addListener(target, type, listener) {
    const targetListeners = listeners[target];
    if (!targetListeners.has(type)) targetListeners.set(type, []);
    targetListeners.get(type).push(listener);
  }

  const documentElement = new FakeElement();
  documentElement.children = [];
  documentElement.appendChild = function (child) {
    this.children.push(child);
    return child;
  };

  const document = {
    documentElement,
    hidden: false,
    addEventListener: function (type, listener) {
      addListener('document', type, listener);
    },
    createElement: function () {
      return new FakeElement();
    },
    getElementById: function (id) {
      return documentElement.children.find(function (child) {
        return child.id === id;
      }) || null;
    },
  };

  const location = new URL('https://example.com/current?mode=1');
  const window = {
    document,
    location,
    addEventListener: function (type, listener) {
      addListener('window', type, listener);
    },
    setTimeout: function (callback, delay) {
      const id = nextTimerId;
      nextTimerId += 1;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: function (id) {
      timers.delete(id);
    },
    open: function (url, target, features) {
      openedTabs.push({ url, target, features, fallback: true });
    },
  };

  const sandbox = {
    window,
    document,
    navigator: {},
    Node: FakeNode,
    Element: FakeElement,
    HTMLAnchorElement: FakeAnchor,
    URL,
    Set,
    RegExp,
    Date,
    performance: {
      now: function () { return currentTime; },
    },
    GM_openInTab: function (url, options) {
      openedTabs.push({ url, options });
    },
    console,
  };

  vm.runInNewContext(source, sandbox, { filename: SCRIPT_PATH });

  function dispatch(target, type, event) {
    const normalizedEvent = Object.assign({
      button: 0,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      clientX: 0,
      clientY: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      defaultPrevented: false,
      immediatePropagationStopped: false,
      preventDefault: function () { this.defaultPrevented = true; },
      stopImmediatePropagation: function () { this.immediatePropagationStopped = true; },
    }, event || {});
    if (!normalizedEvent.composedPath) {
      normalizedEvent.composedPath = function () {
        return normalizedEvent.target ? [normalizedEvent.target] : [];
      };
    }
    const callbacks = listeners[target].get(type) || [];
    callbacks.forEach(function (callback) { callback(normalizedEvent); });
    return normalizedEvent;
  }

  function runTimers(delay) {
    const matchingTimers = Array.from(timers.entries()).filter(function (entry) {
      return typeof delay === 'undefined' || entry[1].delay === delay;
    });
    matchingTimers.forEach(function (entry) {
      timers.delete(entry[0]);
      entry[1].callback();
    });
  }

  return {
    FakeAnchor,
    dispatch,
    openedTabs,
    runTimers,
    setTime: function (value) { currentTime = value; },
    source,
  };
}

test('tap to tab metadata exposes the trackpad-tolerant release as version 0.3.1', () => {
  const source = fs.readFileSync(SCRIPT_PATH, 'utf8');
  assert.match(source, /^\/\/ @version\s+0\.3\.1$/m);
  assert.match(source, /without delaying regular clicks/);
  assert.doesNotMatch(source, /dblclick|doubleClickDelayMs/);
});

test('short press keeps the native click path untouched', () => {
  const runtime = createRuntime();
  const anchor = new runtime.FakeAnchor('https://example.com/next');

  runtime.setTime(0);
  const down = runtime.dispatch('document', 'pointerdown', { target: anchor });
  runtime.setTime(120);
  const up = runtime.dispatch('document', 'pointerup', { target: anchor });
  const click = runtime.dispatch('window', 'click', { target: anchor });

  assert.equal(down.defaultPrevented, false);
  assert.equal(up.defaultPrevented, false);
  assert.equal(click.defaultPrevented, false);
  assert.deepEqual(runtime.openedTabs, []);
});

test('long press opens the pointer-down URL once and suppresses the following click', () => {
  const runtime = createRuntime();
  const anchor = new runtime.FakeAnchor('https://example.com/original');

  runtime.setTime(0);
  runtime.dispatch('document', 'pointerdown', { target: anchor });
  anchor.href = 'https://example.com/changed';
  runtime.setTime(400);
  const up = runtime.dispatch('document', 'pointerup', { target: anchor });
  const click = runtime.dispatch('window', 'click', { target: anchor });

  assert.equal(up.defaultPrevented, true);
  assert.equal(click.defaultPrevented, true);
  assert.equal(click.immediatePropagationStopped, true);
  assert.equal(runtime.openedTabs.length, 1);
  assert.equal(runtime.openedTabs[0].url, 'https://example.com/original');
  assert.equal(runtime.openedTabs[0].options.active, true);
  assert.equal(runtime.openedTabs[0].options.insert, true);
  assert.equal(runtime.openedTabs[0].options.setParent, true);
});

test('elapsed hold time works even when the arming timer has not run', () => {
  const runtime = createRuntime();
  const anchor = new runtime.FakeAnchor('https://example.com/next');

  runtime.setTime(10);
  runtime.dispatch('document', 'pointerdown', { target: anchor });
  runtime.setTime(370);
  runtime.dispatch('document', 'pointerup', { target: anchor });

  assert.equal(runtime.openedTabs.length, 1);
});

test('small trackpad movement is tolerated while deliberate movement cancels', () => {
  const runtime = createRuntime();
  const anchor = new runtime.FakeAnchor('https://example.com/next');

  runtime.setTime(0);
  runtime.dispatch('document', 'pointerdown', { target: anchor });
  runtime.dispatch('document', 'pointermove', { target: anchor, clientX: 31 });
  runtime.setTime(310);
  const toleratedUp = runtime.dispatch('document', 'pointerup', { target: anchor, clientX: 31 });

  runtime.setTime(500);
  runtime.dispatch('document', 'pointerdown', { target: anchor, pointerId: 2 });
  runtime.dispatch('document', 'pointermove', { target: anchor, pointerId: 2, clientX: 33 });
  runtime.setTime(900);
  const movedUp = runtime.dispatch('document', 'pointerup', { target: anchor, pointerId: 2, clientX: 33 });

  assert.equal(toleratedUp.defaultPrevented, true);
  assert.equal(movedUp.defaultPrevented, false);
  assert.equal(runtime.openedTabs.length, 1);
});

test('long-press feedback arms at 300ms and is cleared after release', () => {
  const runtime = createRuntime();
  const anchor = new runtime.FakeAnchor('https://example.com/next');

  runtime.dispatch('document', 'pointerdown', { target: anchor });
  assert.equal(anchor.hasAttribute('data-tap-to-tab-pressing'), true);
  runtime.runTimers(300);
  assert.equal(anchor.hasAttribute('data-tap-to-tab-ready'), true);

  runtime.setTime(300);
  runtime.dispatch('document', 'pointerup', { target: anchor });
  assert.equal(anchor.hasAttribute('data-tap-to-tab-pressing'), false);
  assert.equal(anchor.hasAttribute('data-tap-to-tab-ready'), false);
});

test('accidental drag and force-click lookup do not cancel a stationary hold', () => {
  const runtime = createRuntime();
  const anchor = new runtime.FakeAnchor('https://example.com/next');

  runtime.setTime(0);
  runtime.dispatch('document', 'pointerdown', { target: anchor });
  runtime.dispatch('document', 'pointermove', { target: anchor, clientX: 8 });
  const drag = runtime.dispatch('document', 'dragstart', { target: anchor, clientX: 8 });
  const force = runtime.dispatch('document', 'webkitmouseforcewillbegin', { target: anchor });
  runtime.setTime(310);
  runtime.dispatch('document', 'pointerup', { target: anchor, clientX: 8 });

  assert.equal(drag.defaultPrevented, true);
  assert.equal(force.defaultPrevented, true);
  assert.equal(runtime.openedTabs.length, 1);
});

test('pointer cancellation after the hold threshold still opens the link', () => {
  const runtime = createRuntime();
  const anchor = new runtime.FakeAnchor('https://example.com/next');

  runtime.setTime(0);
  runtime.dispatch('document', 'pointerdown', { target: anchor });
  runtime.setTime(310);
  runtime.dispatch('document', 'pointercancel', {
    target: anchor,
    cancelable: true,
  });

  assert.equal(runtime.openedTabs.length, 1);
});

test('unsupported pointer and link variants are ignored', () => {
  const runtime = createRuntime();
  const modified = new runtime.FakeAnchor('https://example.com/modified');
  const download = new runtime.FakeAnchor('https://example.com/file');
  download.setAttribute('download', 'file.zip');
  const fragment = new runtime.FakeAnchor('https://example.com/current?mode=1#section');

  [
    { anchor: modified, event: { target: modified, ctrlKey: true } },
    { anchor: download, event: { target: download } },
    { anchor: fragment, event: { target: fragment } },
    { anchor: modified, event: { target: modified, pointerType: 'touch' } },
  ].forEach(function (entry, index) {
    runtime.setTime(index * 1000);
    runtime.dispatch('document', 'pointerdown', entry.event);
    runtime.setTime((index * 1000) + 500);
    runtime.dispatch('document', 'pointerup', entry.event);
  });

  assert.deepEqual(runtime.openedTabs, []);
});
