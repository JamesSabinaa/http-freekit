import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const handlerStart = source.indexOf('function activateInterceptorCardOnKeyboard(');
const handlerEnd = source.indexOf('function filterInterceptors(', handlerStart);
assert.ok(handlerStart >= 0 && handlerEnd > handlerStart, 'interceptor card keyboard handler must exist');

const context = {};
vm.createContext(context);
vm.runInContext(`
  ${source.slice(handlerStart, handlerEnd)}
  globalThis.activateInterceptorCardOnKeyboardForTest = activateInterceptorCardOnKeyboard;
`, context);
const cardKeydown = context.activateInterceptorCardOnKeyboardForTest;

class FakeElement {
  constructor(tagName, label) {
    this.tagName = tagName.toUpperCase();
    this.label = label;
    this.parentElement = null;
    this.children = [];
    this.onclick = null;
    this.onkeydown = null;
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  dispatchEvent(event) {
    event.target ||= this;
    event.currentTarget = this;
    if (event.type === 'keydown') this.onkeydown?.(event);
    if (event.type === 'click') this.onclick?.(event);
    if (!event.cancelBubble && this.parentElement) this.parentElement.dispatchEvent(event);
    return !event.defaultPrevented;
  }

  click() {
    this.dispatchEvent(createEvent('click'));
  }
}

function createEvent(type, overrides = {}) {
  return {
    type,
    key: '',
    repeat: false,
    defaultPrevented: false,
    cancelBubble: false,
    preventDefaultCalls: 0,
    preventDefault() {
      this.defaultPrevented = true;
      this.preventDefaultCalls += 1;
    },
    stopPropagation() { this.cancelBubble = true; },
    ...overrides
  };
}

function createCard(label = 'interceptor card') {
  const card = new FakeElement('div', label);
  let activations = 0;
  card.onkeydown = cardKeydown;
  card.onclick = () => { activations += 1; };
  return { card, activations: () => activations };
}

function pressEnter(target, { nativeClick = false, ...overrides } = {}) {
  const event = createEvent('keydown', { key: 'Enter', ...overrides });
  target.dispatchEvent(event);
  if (nativeClick && !event.defaultPrevented) target.click();
  return event;
}

const nestedControls = [
  ['INPUT', 'Electron application path', false],
  ['BUTTON', 'Electron Browse', true],
  ['BUTTON', 'Electron Launch', true],
  ['SELECT', 'Android host adapter selector', false],
  ['BUTTON', 'Android device Activate', true],
  ['BUTTON', 'Android Refresh Devices', true],
  ['BUTTON', 'JVM process Attach', true],
  ['BUTTON', 'JVM Refresh Processes', true],
  ['BUTTON', 'expanded-card Close', true],
  ['BUTTON', 'active-card Stop', true],
  ['A', 'nested configuration link', true],
  ['DIV', 'expanded configuration control', false]
];

test('Enter on every expanded interceptor control stays scoped to that control', () => {
  for (const [tagName, label, nativeClick] of nestedControls) {
    const { card, activations } = createCard();
    const control = card.appendChild(new FakeElement(tagName, label));
    let keydowns = 0;
    let nativeActions = 0;
    control.onkeydown = () => { keydowns += 1; };
    if (nativeClick) {
      // Matches the existing inline guards on nested action controls.
      control.onclick = event => {
        event.stopPropagation();
        nativeActions += 1;
      };
    }

    const event = pressEnter(control, { nativeClick });

    assert.equal(keydowns, 1, `${label} must receive its Enter keydown`);
    assert.equal(event.defaultPrevented, false, `${label} must retain native Enter behavior`);
    assert.equal(nativeActions, nativeClick ? 1 : 0, `${label} native action count`);
    assert.equal(activations(), 0, `${label} must not activate or collapse its parent card`);
  }
});

test('direct Enter activates activable, download, and manual cards exactly once', () => {
  for (const label of ['activable interceptor', 'browser download', 'manual Anything']) {
    const { card, activations } = createCard(label);

    const event = pressEnter(card);

    assert.equal(activations(), 1, `${label} activation count`);
    assert.equal(event.defaultPrevented, true, `${label} Enter default must be consumed`);
    assert.equal(event.preventDefaultCalls, 1, `${label} must prevent default exactly once`);
  }
});

test('card keyboard synthesis ignores repeats, handled events, other keys, and descendants', () => {
  const cases = [
    { key: 'Enter', repeat: true },
    { key: 'Enter', defaultPrevented: true },
    { key: ' ', repeat: false },
    { key: 'Escape', repeat: false }
  ];
  for (const overrides of cases) {
    const { card, activations } = createCard();
    const event = createEvent('keydown', overrides);
    card.dispatchEvent(event);
    assert.equal(activations(), 0, JSON.stringify(overrides));
    assert.equal(event.preventDefaultCalls, 0, JSON.stringify(overrides));
  }

  const { card, activations } = createCard();
  const configChild = card.appendChild(new FakeElement('div', 'nested config'));
  const event = pressEnter(configChild, { repeat: true, defaultPrevented: true });
  assert.equal(activations(), 0);
  assert.equal(event.preventDefaultCalls, 0);
});

test('all interceptor card categories use the scoped handler and named controls remain guarded', () => {
  assert.equal(
    (source.match(/\.onkeydown = activateInterceptorCardOnKeyboard;/g) || []).length,
    3,
    'activable, download, and manual cards must share the scoped handler'
  );
  assert.doesNotMatch(source, /onkeydown = \(e\) => \{ if \(e\.key === 'Enter'\) .*\.click\(\); \};/);

  for (const expectedControl of [
    /id="electronAppPath"[^>]*onclick="event\.stopPropagation\(\);"/s,
    /onclick="event\.stopPropagation\(\); browseElectronApp\(\);">Browse/,
    /onclick="event\.stopPropagation\(\); launchElectronApp\(\);">[\s\S]*Launch &amp; intercept/,
    /<select[^>]*onclick="event\.stopPropagation\(\);"/s,
    /onclick="event\.stopPropagation\(\); activateAndroidDevice\(/,
    /onclick="event\.stopPropagation\(\); refreshAndroidDevices\(\);"/,
    /onclick="event\.stopPropagation\(\); activateJvmProcess\(/,
    /onclick="event\.stopPropagation\(\); refreshJvmProcesses\(\);"/,
    /class="intercept-card-close" onclick="event\.stopPropagation\(\); collapseInterceptorCard\(\);"/,
    /class="intercept-card-stop" onclick="event\.stopPropagation\(\); deactivateInterceptor\(/
  ]) {
    assert.match(source, expectedControl);
  }
});
