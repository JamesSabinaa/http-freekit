import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');

test('Send startup reconciles Monaco with the active tab after its await', () => {
  const start = source.indexOf('function initializeSendTabs()');
  const end = source.indexOf('function prepopulateSendUrl', start);
  const initSource = source.slice(start, end);
  const awaitIndex = initSource.indexOf('await initSendBodyEditor');
  const currentLookupIndex = initSource.indexOf('sendTabs.find(tab => tab.id === activeSendTab)', awaitIndex);

  assert.notEqual(awaitIndex, -1);
  assert.ok(currentLookupIndex > awaitIndex);
  assert.match(initSource.slice(currentLookupIndex), /loadSendTabState\(currentTab\)/);
});

test('Send state is loaded synchronously and stored bodies survive pre-Monaco tab changes', () => {
  const initStart = source.indexOf('function initializeSendTabs()');
  const initEnd = source.indexOf('function prepopulateSendUrl', initStart);
  const initSource = source.slice(initStart, initEnd);
  const saveStart = source.indexOf('function saveSendTabState()');
  const saveEnd = source.indexOf('function persistSendTabs()', saveStart);
  const saveSource = source.slice(saveStart, saveEnd);

  assert.ok(initSource.indexOf('loadSendTabState(startupTab)') < initSource.indexOf('setTimeout'));
  assert.match(saveSource, /tab\.body = getSendBodyValue\(\)/);
  assert.match(source, /restoreSendTabs\(\);\s*initializeSendTabs\(\);/);
});
