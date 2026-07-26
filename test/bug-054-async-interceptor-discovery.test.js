import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { DockerInterceptor } from '../src/interceptors/docker-interceptor.js';

const runtimeInterceptors = [
  'src/interceptors/browser-interceptor.js',
  'src/interceptors/docker-interceptor.js',
  'src/interceptors/jvm-interceptor.js',
  'src/interceptors/android-adb-interceptor.js',
  'src/interceptors/terminal-interceptors.js'
];

test('runtime interceptor discovery does not use synchronous child processes', () => {
  for (const file of runtimeInterceptors) {
    const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\bexec(?:File)?Sync\b/, file);
  }

  const browserSource = fs.readFileSync(
    new URL('../src/interceptors/browser-interceptor.js', import.meta.url),
    'utf8'
  );
  assert.match(browserSource, /await getRelatedProcessIdsAsync\(/);
});

test('slow Docker discovery yields to other event-loop work', async () => {
  const interceptor = new DockerInterceptor();
  let commandFinished = false;
  interceptor._exec = () => new Promise(resolve => {
    setTimeout(() => {
      commandFinished = true;
      resolve('');
    }, 25);
  });

  const discovery = interceptor.isActivable();
  await Promise.resolve();

  assert.equal(commandFinished, false);
  assert.equal(await discovery, true);
});
