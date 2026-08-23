import assert from 'node:assert/strict';
import test from 'node:test';

import { BrowserInterceptor } from '../../../src/interceptors/browser-interceptor.js';

test('Windows Focus never seeds candidates from a stale launcher PID', async () => {
  const interceptor = new BrowserInterceptor('chrome', 'Chrome', 'chrome');
  interceptor._platform = () => 'win32';
  interceptor.isActive = async () => true;
  interceptor.profileDir = 'C:\\Temp\\http-freekit-chrome-managed';
  interceptor.process = { pid: 7412 };
  let script = '';
  interceptor._execFile = async (_command, args) => {
    script = args.at(-1);
  };

  await interceptor.focus();

  assert.match(script, /\$candidatePids = @\(\)/);
  assert.match(script, /CommandLine\.Contains\(\$profileDir\)/);
  assert.match(script, /\$candidatePids = @\(\$profileMatches\)/);
  assert.doesNotMatch(script, /\$candidatePids = @\(7412\)/);
});
