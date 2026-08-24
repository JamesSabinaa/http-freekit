import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const menuSource = fs.readFileSync(path.join(process.cwd(), 'electron', 'menu.cjs'), 'utf8');

test('Electron menu leaves renderer-owned shortcuts unregistered', () => {
  assert.doesNotMatch(menuSource, /accelerator:\s*['"]CmdOrCtrl\+Shift\+N['"]/);
  assert.doesNotMatch(menuSource, /role:\s*['"]reload['"]/);
  assert.doesNotMatch(menuSource, /role:\s*['"]close['"]/);
});

test('reload and close remain available without a duplicate new-session command', () => {
  assert.doesNotMatch(menuSource, /label:\s*['"]New Session['"]/);
  assert.match(menuSource, /label:\s*['"]Reload['"][\s\S]*webContents\.reload/);
  assert.match(menuSource, /label:\s*['"]Close Window['"][\s\S]*mainWindow\?\.close/);
});
