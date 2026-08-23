import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const styles = fs.readFileSync(new URL('../../src/ui/styles.css', import.meta.url), 'utf8');

test('reduced-motion preference removes motion while retaining static state indicators', () => {
  const mediaStart = styles.indexOf('@media (prefers-reduced-motion: reduce)');
  assert.ok(mediaStart >= 0);
  const reducedMotionStyles = styles.slice(mediaStart);

  assert.match(reducedMotionStyles, /\*, \*::before, \*::after\s*\{/);
  assert.match(reducedMotionStyles, /animation-duration:\s*0\.01ms\s*!important/);
  assert.match(reducedMotionStyles, /animation-iteration-count:\s*1\s*!important/);
  assert.match(reducedMotionStyles, /transition-duration:\s*0\.01ms\s*!important/);
  assert.match(reducedMotionStyles, /transition-delay:\s*0ms\s*!important/);
  assert.match(reducedMotionStyles, /scroll-behavior:\s*auto\s*!important/);

  for (const selector of [
    '.status-dot:not(.connected)',
    '.intercept-spinner',
    '#sendBtnSpinner',
    '.status-badge.status-pending svg'
  ]) {
    assert.ok(reducedMotionStyles.includes(selector), selector);
  }
  assert.match(reducedMotionStyles, /animation:\s*none\s*!important/);
  assert.match(
    reducedMotionStyles,
    /\.status-dot:not\(\.connected\)\s*\{\s*opacity:\s*1\s*!important/
  );
});
