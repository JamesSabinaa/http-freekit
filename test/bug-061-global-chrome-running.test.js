import assert from 'node:assert/strict';
import test from 'node:test';
import { ExistingBrowserInterceptor } from '../src/interceptors/existing-browser-interceptor.js';

test('Global Chrome refuses activation while Chrome is already running', async () => {
  const interceptor = new ExistingBrowserInterceptor('existing-chrome', 'Global Chrome', 'chrome');
  interceptor._findBrowserPath = () => '/test/chrome';
  interceptor._isBrowserRunning = async () => true;
  interceptor.ca = { systemTrustInstalled: true };

  await assert.rejects(
    interceptor.activate(8080),
    /Close every Chrome window/
  );
  assert.equal(interceptor.active, false);
  assert.equal(interceptor.process, null);
});

test('browser process detection recognizes the selected executable', async () => {
  const interceptor = new ExistingBrowserInterceptor('existing-chrome', 'Global Chrome', 'chrome');
  interceptor._getPlatform = () => 'win32';
  interceptor._getProcessSnapshot = async () => [{
    command: '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --type=browser'
  }];

  assert.equal(
    await interceptor._isBrowserRunning('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'),
    true
  );
});
