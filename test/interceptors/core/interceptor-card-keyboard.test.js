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

function pressKey(target, key, { nativeClick = false, ...overrides } = {}) {
  const event = createEvent('keydown', { key, ...overrides });
  target.dispatchEvent(event);
  if (nativeClick && !event.defaultPrevented) target.click();
  return event;
}

const nestedControls = [
  ['INPUT', 'Electron application path', false, false],
  ['BUTTON', 'Electron Browse', true, true],
  ['BUTTON', 'Electron Launch', true, true],
  ['SELECT', 'Android host adapter selector', false, false],
  ['BUTTON', 'Android device Activate', true, true],
  ['BUTTON', 'Android Refresh Devices', true, true],
  ['BUTTON', 'JVM process Attach', true, true],
  ['BUTTON', 'JVM Refresh Processes', true, true],
  ['BUTTON', 'expanded-card Close', true, true],
  ['BUTTON', 'active-card Stop', true, true],
  ['A', 'nested configuration link', true, false],
  ['DIV', 'expanded configuration control', false, false]
];

test('Enter and Space on every expanded interceptor control stay scoped to that control', () => {
  for (const key of ['Enter', ' ']) {
    for (const [tagName, label, enterClick, spaceClick] of nestedControls) {
      const { card, activations } = createCard();
      const control = card.appendChild(new FakeElement(tagName, label));
      let keydowns = 0;
      let nativeActions = 0;
      control.onkeydown = () => { keydowns += 1; };
      if (enterClick || spaceClick) {
        // Matches the existing inline guards on nested action controls.
        control.onclick = event => {
          event.stopPropagation();
          nativeActions += 1;
        };
      }
      const nativeClick = key === 'Enter' ? enterClick : spaceClick;

      const event = pressKey(control, key, { nativeClick });

      assert.equal(keydowns, 1, `${label} must receive ${JSON.stringify(key)} keydown`);
      assert.equal(event.defaultPrevented, false, `${label} must retain native key behavior`);
      assert.equal(nativeActions, nativeClick ? 1 : 0, `${label} native action count`);
      assert.equal(activations(), 0, `${label} must not activate or collapse its parent card`);
    }
  }
});

test('direct Enter and Space activate every interceptor card category exactly once', () => {
  for (const key of ['Enter', ' ']) {
    for (const label of ['activable interceptor', 'browser download', 'manual Anything']) {
      const { card, activations } = createCard(label);

      const event = pressKey(card, key);

      assert.equal(activations(), 1, `${label} ${JSON.stringify(key)} activation count`);
      assert.equal(event.defaultPrevented, true, `${label} key default must be consumed`);
      assert.equal(event.preventDefaultCalls, 1, `${label} must prevent default exactly once`);
    }
  }
});

test('card keyboard synthesis suppresses repeats and only Space repeats prevent scrolling', () => {
  for (const [key, expectedPrevented] of [['Enter', false], [' ', true]]) {
    const { card, activations } = createCard();
    const event = pressKey(card, key, { repeat: true });

    assert.equal(activations(), 0, `${JSON.stringify(key)} repeat activation`);
    assert.equal(event.defaultPrevented, expectedPrevented);
    assert.equal(event.preventDefaultCalls, expectedPrevented ? 1 : 0);
  }
});

test('handled events, descendants, and unsupported keys remain untouched', () => {
  for (const key of ['Enter', ' ']) {
    const { card, activations } = createCard();
    const event = pressKey(card, key, { defaultPrevented: true });

    assert.equal(activations(), 0, `${JSON.stringify(key)} handled activation`);
    assert.equal(event.preventDefaultCalls, 0, `${JSON.stringify(key)} handled prevention`);
  }

  for (const key of ['Escape', 'Spacebar', 'ArrowDown']) {
    const { card, activations } = createCard();
    const event = pressKey(card, key);

    assert.equal(activations(), 0, `${key} activation`);
    assert.equal(event.preventDefaultCalls, 0, `${key} prevention`);
  }

  const { card, activations } = createCard();
  const configChild = card.appendChild(new FakeElement('div', 'nested config'));
  for (const key of ['Enter', ' ']) {
    const event = pressKey(configChild, key, { repeat: true, defaultPrevented: true });
    assert.equal(activations(), 0);
    assert.equal(event.preventDefaultCalls, 0);
  }
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
