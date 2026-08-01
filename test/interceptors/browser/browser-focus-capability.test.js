import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { BrowserInterceptor } from '../../../src/interceptors/browser-interceptor.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('isolated browsers advertise focus only while active on supported platforms', () => {
  const interceptor = new BrowserInterceptor('chrome', 'Chrome', 'chrome');

  interceptor._platform = () => 'linux';
  assert.equal(interceptor.canFocus(), false);
  assert.equal(interceptor.toJSON().focusable, false);

  interceptor.active = true;
  interceptor._platform = () => 'darwin';
  assert.equal(interceptor.toJSON().focusable, true);

  interceptor._platform = () => 'win32';
  assert.equal(interceptor.toJSON().focusable, true);

  interceptor.active = false;
  assert.equal(interceptor.canFocus(), true);
  assert.equal(interceptor.toJSON().focusable, false);
});

test('connected-source rendering follows the backend focus capability', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'src/ui/app.js'), 'utf8');

  assert.match(source, /const canFocus = i\.focusable === true/);
  assert.doesNotMatch(source, /FOCUSABLE_INTERCEPTORS/);
});
