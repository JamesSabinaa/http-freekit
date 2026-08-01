import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');

function functionSource(name, nextName) {
  const start = source.indexOf(`async function ${name}`);
  const end = source.indexOf(`async function ${nextName}`, start + 1);
  assert.notEqual(start, -1, `${name} should exist`);
  assert.notEqual(end, -1, `${nextName} should follow ${name}`);
  return source.slice(start, end);
}

test('interceptor activation handlers reject a second in-flight operation', () => {
  const expandable = functionSource('handleExpandableCardClick', 'browseElectronApp');
  const android = functionSource('activateAndroidDevice', 'refreshAndroidDevices');
  const jvm = functionSource('activateJvmProcess', 'refreshJvmProcesses');
  const toggle = functionSource('toggleInterceptor', 'loadMockRules');

  assert.match(expandable, /interceptorsInProgress\.has\(id\)\) return/);
  assert.match(android, /interceptorsInProgress\.has\('android-adb'\)\) return/);
  assert.match(jvm, /interceptorsInProgress\.has\('jvm'\)\) return/);
  assert.match(toggle, /interceptorsInProgress\.has\(id\)\) return/);
});

test('status events cannot release an activation lock owned by an outstanding request', () => {
  const handlerStart = source.indexOf('function handleInterceptorStatusEvent');
  const handlerEnd = source.indexOf('function filterInterceptors', handlerStart);
  const handler = source.slice(handlerStart, handlerEnd);

  assert.doesNotMatch(handler, /interceptorsInProgress\.delete/);
});
