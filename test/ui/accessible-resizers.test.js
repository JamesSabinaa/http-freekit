import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const appSource = fs.readFileSync(new URL('../../src/ui/app.js', import.meta.url), 'utf8');
const htmlSource = fs.readFileSync(new URL('../../src/ui/index.html', import.meta.url), 'utf8');
const cssSource = fs.readFileSync(new URL('../../src/ui/styles.css', import.meta.url), 'utf8');
const helperStart = appSource.indexOf('function setupSplitPaneResizer(');
const helperEnd = appSource.indexOf('// ============ RESIZE DETAIL', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart);

class FakeTarget {
  constructor() {
    this.listeners = new Map();
    this.attributes = new Map();
    this.style = {};
    this.classes = new Set();
    this.classList = {
      add: name => this.classes.add(name),
      remove: name => this.classes.delete(name)
    };
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type, properties = {}) {
    const event = {
      key: '',
      clientX: 0,
      clientY: 0,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      ...properties
    };
    for (const listener of this.listeners.get(type) || []) listener(event);
    return event;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
}

class FakePane extends FakeTarget {
  constructor(width, height) {
    super();
    this.baseWidth = width;
    this.baseHeight = height;
  }

  get offsetWidth() {
    return Number.parseFloat(this.style.width) || this.baseWidth;
  }

  get offsetHeight() {
    return Number.parseFloat(this.style.height) || this.baseHeight;
  }
}

function rendererHarness({
  flexDirection,
  containerWidth,
  containerHeight,
  paneWidth,
  paneHeight,
  controlledAfter,
  detail = false
}) {
  const document = new FakeTarget();
  const window = new FakeTarget();
  const container = {
    flexDirection,
    clientWidth: containerWidth,
    clientHeight: containerHeight
  };
  const resizer = new FakeTarget();
  resizer.parentElement = container;
  resizer.offsetWidth = 11;
  resizer.offsetHeight = 11;
  const pane = new FakePane(paneWidth, paneHeight);
  if (!controlledAfter) pane.style.flex = '1';
  const context = {
    document,
    window,
    getComputedStyle: element => ({ flexDirection: element.flexDirection })
  };
  vm.createContext(context);
  vm.runInContext(
    `${appSource.slice(helperStart, helperEnd)}; globalThis.setup = setupSplitPaneResizer;`,
    context
  );
  context.setup({
    resizer,
    pane,
    controlledAfter,
    minWidth: detail ? 300 : 250,
    otherMinWidth: detail ? 300 : 250,
    minHeight: detail ? 150 : 200,
    otherMinHeight: 200,
    initialWidth: detail ? 300 : 350,
    initialHeight: detail ? 250 : 300,
    maxHeightFraction: detail ? 0.5 : undefined,
    keyboardStep: 10
  });
  return { document, window, container, resizer, pane };
}

test('both resizers expose labelled, focusable separator semantics in markup', () => {
  const expectations = [
    ['detailResizer', 'detailPanel', 'Resize request detail pane'],
    ['sendResizer', 'sendRequestPane', 'Resize request editor pane']
  ];

  for (const [id, controls, label] of expectations) {
    const tag = htmlSource.match(new RegExp(`<div[^>]+id="${id}"[^>]*>`))?.[0] || '';
    assert.match(tag, /role="separator"/);
    assert.match(tag, /tabindex="0"/);
    assert.ok(tag.includes(`aria-label="${label}"`));
    assert.ok(tag.includes(`aria-controls="${controls}"`));
    assert.match(tag, /aria-orientation="vertical"/);
    assert.match(tag, /aria-valuemin="0"/);
    assert.match(tag, /aria-valuemax="0"/);
    assert.match(tag, /aria-valuenow="0"/);
  }

  assert.match(cssSource, /@media \(max-width: 1100px\)[\s\S]*?\.resizer \{[\s\S]*?width: 100%;[\s\S]*?cursor: row-resize;/);
  assert.match(cssSource, /@media \(max-width: 768px\)[\s\S]*?#panel-send \.send-resizer \{[\s\S]*?width: 100%;[\s\S]*?cursor: row-resize;/);
});

test('desktop detail separator preserves pointer resizing and clamps keyboard values', () => {
  const ui = rendererHarness({
    flexDirection: 'row',
    containerWidth: 1000,
    containerHeight: 700,
    paneWidth: 400,
    paneHeight: 280,
    controlledAfter: true,
    detail: true
  });

  assert.equal(ui.resizer.getAttribute('aria-orientation'), 'vertical');
  assert.equal(ui.resizer.getAttribute('aria-valuemin'), '300');
  assert.equal(ui.resizer.getAttribute('aria-valuemax'), '689');
  assert.equal(ui.resizer.getAttribute('aria-valuenow'), '589');

  assert.equal(ui.resizer.dispatch('keydown', { key: 'ArrowRight' }).defaultPrevented, true);
  assert.equal(ui.pane.style.width, '390px');
  assert.equal(ui.resizer.getAttribute('aria-valuenow'), '599');
  ui.resizer.dispatch('keydown', { key: 'End' });
  ui.resizer.dispatch('keydown', { key: 'ArrowRight' });
  assert.equal(ui.pane.style.width, '300px');
  assert.equal(ui.resizer.getAttribute('aria-valuenow'), '689');
  assert.equal(ui.resizer.getAttribute('aria-valuetext'), '300 pixels');

  ui.resizer.dispatch('keydown', { key: 'Home' });
  ui.resizer.dispatch('mousedown', { clientX: 400, clientY: 9999 });
  ui.document.dispatch('mousemove', { clientX: 450, clientY: -9999 });
  assert.equal(ui.pane.style.width, '639px');
  assert.equal(ui.resizer.getAttribute('aria-valuenow'), '350');
  ui.document.dispatch('mouseup');
  assert.equal(ui.resizer.classes.has('active'), false);
});

test('responsive detail separator switches to height, Y pointer input, and horizontal ARIA', () => {
  const ui = rendererHarness({
    flexDirection: 'column',
    containerWidth: 800,
    containerHeight: 700,
    paneWidth: 400,
    paneHeight: 280,
    controlledAfter: true,
    detail: true
  });

  assert.equal(ui.resizer.getAttribute('aria-orientation'), 'horizontal');
  assert.equal(ui.resizer.getAttribute('aria-valuemin'), '339');
  assert.equal(ui.resizer.getAttribute('aria-valuemax'), '539');
  assert.equal(ui.resizer.getAttribute('aria-valuenow'), '409');
  ui.resizer.dispatch('keydown', { key: 'ArrowDown' });
  assert.equal(ui.pane.style.height, '270px');
  assert.equal(ui.pane.style.width, '');
  assert.equal(ui.resizer.getAttribute('aria-valuenow'), '419');
  ui.resizer.dispatch('keydown', { key: 'Home' });
  assert.equal(ui.pane.style.height, '350px');
  ui.resizer.dispatch('keydown', { key: 'ArrowUp' });
  assert.equal(ui.pane.style.height, '350px', '50% responsive maximum remains clamped');

  ui.resizer.dispatch('mousedown', { clientX: 9999, clientY: 300 });
  ui.document.dispatch('mousemove', { clientX: -9999, clientY: 500 });
  assert.equal(ui.pane.style.height, '150px');
  assert.equal(ui.resizer.getAttribute('aria-valuenow'), '539');
});

test('Send separator uses left-pane width on desktop and top-pane height responsively', () => {
  const desktop = rendererHarness({
    flexDirection: 'row',
    containerWidth: 900,
    containerHeight: 700,
    paneWidth: 350,
    paneHeight: 300,
    controlledAfter: false
  });
  assert.equal(desktop.resizer.getAttribute('aria-orientation'), 'vertical');
  desktop.resizer.dispatch('keydown', { key: 'Home' });
  assert.equal(desktop.pane.style.width, '250px');
  desktop.resizer.dispatch('mousedown', { clientX: 200, clientY: 9000 });
  desktop.document.dispatch('mousemove', { clientX: 800, clientY: -9000 });
  assert.equal(desktop.pane.style.width, '639px');
  assert.equal(desktop.resizer.getAttribute('aria-valuenow'), '639');

  desktop.container.flexDirection = 'column';
  desktop.container.clientHeight = 700;
  desktop.window.dispatch('resize');
  assert.equal(desktop.pane.style.width, '');
  assert.equal(desktop.pane.style.flex, '1', 'untouched responsive axis restores its original flex');
  assert.equal(desktop.resizer.getAttribute('aria-orientation'), 'horizontal');

  const responsive = rendererHarness({
    flexDirection: 'column',
    containerWidth: 700,
    containerHeight: 700,
    paneWidth: 350,
    paneHeight: 300,
    controlledAfter: false
  });
  assert.equal(responsive.resizer.getAttribute('aria-orientation'), 'horizontal');
  responsive.resizer.dispatch('keydown', { key: 'ArrowDown' });
  assert.equal(responsive.pane.style.height, '310px');
  assert.equal(responsive.pane.style.width, '');
  responsive.resizer.dispatch('keydown', { key: 'End' });
  responsive.resizer.dispatch('keydown', { key: 'ArrowDown' });
  assert.equal(responsive.pane.style.height, '489px');
  assert.equal(responsive.resizer.getAttribute('aria-valuenow'), '489');
});
