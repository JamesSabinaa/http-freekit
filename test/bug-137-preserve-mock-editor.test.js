import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');

function section(startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start + startText.length);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return source.slice(start, end);
}

test('opening a mock editor first preserves the currently open edit', () => {
  const addSource = section('function addNewMockRule()', 'function editMockRule');
  const editSource = section('function editMockRule', 'function cancelMockEdit');

  assert.match(addSource, /if \(!preserveOpenMockEdit\('__new__'\)\) return/);
  assert.match(editSource, /if \(!preserveOpenMockEdit\(ruleId\)\) return/);
});

test('editor preservation saves valid drafts and blocks navigation on validation failure', () => {
  const preserveSource = section('function preserveOpenMockEdit', 'function addNewMockRule');
  const saveSource = section('function saveMockRule', 'function _applyDraftToLocal');

  assert.match(preserveSource, /return saveMockRule\(mockEditingRule\)/);
  assert.match(saveSource, /return false/);
  assert.match(saveSource, /return true/);
});
