import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');

function section(startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start + startText.length);
  assert.notEqual(start, -1, startText);
  assert.notEqual(end, -1, endText);
  return source.slice(start, end);
}

test('mock response status editors expose only final-response bounds', () => {
  const renderSource = section(
    'function renderMockActionFields',
    'function rerenderMockActionConfig'
  );
  const finalStatusInputs = renderSource.match(/min="200" max="599"/g) || [];

  assert.equal(finalStatusInputs.length, 3);
  assert.doesNotMatch(renderSource, /min="1\d\d" max="599"/);
});

test('mock editor validation rejects informational statuses before staging a draft', () => {
  const helperSource = section(
    'function isValidMockFinalStatus',
    'function saveMockRule'
  );
  const saveSource = section('function saveMockRule', 'function _applyDraftToLocal');
  const context = {};
  vm.runInNewContext(`
    ${helperSource}
    globalThis.validate = mockActionFinalStatusError;
  `, context);

  const actionsForStatus = status => [
    { type: 'fixed-response', status },
    { type: 'serve-file', status },
    { type: 'transform-request', resStatusOverride: status },
    { type: 'transform-response', statusOverride: status }
  ];
  for (const status of [100, 199, 600]) {
    for (const action of actionsForStatus(status)) {
      assert.match(context.validate(action), /integer from 200 to 599/);
    }
  }
  for (const status of [200, 599]) {
    for (const action of actionsForStatus(status)) {
      assert.equal(context.validate(action), null);
    }
  }

  assert.match(
    saveSource,
    /const statusError = mockActionFinalStatusError\(mockEditDraft\.action\);[\s\S]*?toast\(statusError, 'error'\);[\s\S]*?return false;/
  );
});

test('traffic-derived fixed mocks fall back when a capture has no final status', () => {
  const createSource = section('function createMockFromRequest', 'function showHeaderContextMenu');

  assert.match(
    createSource,
    /status: Number\.isInteger\(req\.statusCode\) && req\.statusCode >= 200 && req\.statusCode <= 599\s*\? req\.statusCode\s*: 200/
  );
});
