import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');

test('Save All rejects concurrent invocations and disables its button', () => {
  const start = source.indexOf('async function saveAllMockRules()');
  const end = source.indexOf('/** Send a single draft rule', start);
  const saveAllSource = source.slice(start, end);
  const buttonsStart = source.indexOf('function updateMockSaveButtons()');
  const buttonsEnd = source.indexOf('async function deleteMockRule', buttonsStart);
  const buttonsSource = source.slice(buttonsStart, buttonsEnd);

  assert.match(
    saveAllSource,
    /if\s*\(\s*mockSaveInProgress(?:\s*\|\|[^)]*)?\)\s*return/
  );
  assert.match(saveAllSource, /mockSaveInProgress = true/);
  assert.match(saveAllSource, /finally\s*{[\s\S]*mockSaveInProgress = false/);
  assert.match(buttonsSource, /saveAllBtn\.disabled = mockSaveInProgress/);
});

test('Save All removes each successful draft before another request can fail', () => {
  const start = source.indexOf('async function saveAllMockRules()');
  const end = source.indexOf('/** Send a single draft rule', start);
  const saveAllSource = source.slice(start, end);
  const loopStart = saveAllSource.indexOf('for (const [draftId, draft] of entries)');
  const catchStart = saveAllSource.indexOf('} catch (err)');
  const loopSource = saveAllSource.slice(loopStart, catchStart);

  assert.match(loopSource, /mockDraftRules\.delete\(draftId\)/);
  assert.match(loopSource, /mockNewDraftIds\.delete\(draftId\)/);
  assert.doesNotMatch(saveAllSource.slice(catchStart), /mockDraftRules\.clear/);
});
