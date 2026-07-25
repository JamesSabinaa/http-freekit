import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const builderConfig = require('../electron-builder.config.cjs');

test('macOS builds publish both installable DMG and updater ZIP artifacts', () => {
  const targets = new Map(builderConfig.mac.target.map(target => [target.target, target.arch]));

  assert.deepEqual(targets.get('dmg'), ['x64', 'arm64']);
  assert.deepEqual(targets.get('zip'), ['x64', 'arm64']);
});
