import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const styles = fs.readFileSync(new URL('../../src/ui/styles.css', import.meta.url), 'utf8');

function block(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = styles.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  assert.ok(match, `missing CSS block ${selector}`);
  return match[1];
}

function variable(css, name) {
  const match = css.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'));
  assert.ok(match, `missing --${name}`);
  return match[1];
}

function luminance(hex) {
  const channels = hex.slice(1).match(/../g).map(channel => parseInt(channel, 16) / 255);
  const linear = channels.map(channel => channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(left, right) {
  const first = luminance(left);
  const second = luminance(right);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function assertNormalTextContrast(foreground, background, label) {
  assert.ok(contrast(foreground, background) >= 4.5, `${label} must meet 4.5:1 contrast`);
}

test('built-in normal-text palette meets contrast on its declared surfaces', () => {
  const dark = block(':root');
  const light = block('[data-theme="light"]');

  assertNormalTextContrast(variable(dark, 'text-lowlight'), variable(dark, 'bg-main'), 'dark lowlight text');
  assertNormalTextContrast(variable(dark, 'text-watermark'), variable(dark, 'bg-main'), 'dark watermark text');
  assertNormalTextContrast(variable(light, 'text-watermark'), variable(light, 'bg-main'), 'light watermark on main');
  assertNormalTextContrast(variable(light, 'text-watermark'), variable(light, 'bg-container'), 'light watermark on container');

  for (const backgroundName of [
    'action-bg',
    'action-hover-bg',
    'jvm-action-bg',
    'jvm-action-hover-bg',
    'status-pill-1xx',
    'status-pill-2xx',
    'status-pill-3xx',
    'status-pill-4xx',
    'status-pill-5xx'
  ]) {
    assertNormalTextContrast('#ffffff', variable(dark, backgroundName), backgroundName);
  }
});

test('High Contrast gives white input and highlight surfaces an effective black foreground', () => {
  const highContrast = block('[data-theme="high-contrast"]');
  assert.equal(variable(highContrast, 'input-text-color').toLowerCase(), '#000000');
  assert.equal(variable(highContrast, 'highlight-text-color').toLowerCase(), '#000000');
  assert.match(styles, /\[data-theme="high-contrast"\] input,[\s\S]*?color:\s*var\(--input-text-color\) !important;/);
  assert.match(styles, /\.detail-pill\.pill-muted\s*\{[\s\S]*?color:\s*var\(--highlight-text-color\);/);
  assert.match(styles, /\.context-menu-item:hover,[\s\S]*?color:\s*var\(--highlight-text-color\);/);
  assert.match(styles, /\.filter-hint-item:hover\s*\{[\s\S]*?color:\s*var\(--highlight-text-color\);/);
});

test('accent text meets contrast on base and tinted surfaces without changing decorative accents', () => {
  const mix = (foreground, background, opacity) => '#' + foreground.slice(1).match(/../g)
    .map((channel, index) => Math.round(parseInt(channel, 16) * opacity
      + parseInt(background.slice(1 + index * 2, 3 + index * 2), 16) * (1 - opacity))
      .toString(16).padStart(2, '0')).join('');
  for (const selector of [':root', '[data-theme="light"]']) {
    const theme = block(selector);
    const accent = variable(theme, 'pop-color');
    const text = variable(theme, 'pop-text-color');
    assert.equal(accent, '#e1421f', 'decorative accent stays unchanged');
    for (const surface of ['bg-main', 'bg-lowlight', 'bg-container', 'bg-input', 'bg-highlight']) {
      const background = variable(theme, surface);
      assertNormalTextContrast(text, background, `${selector} accent text on ${surface}`);
      for (const opacity of [0.06, 0.07, 0.14]) {
        assertNormalTextContrast(text, mix(accent, background, opacity), `${selector} tinted ${surface}`);
      }
    }
  }
});
