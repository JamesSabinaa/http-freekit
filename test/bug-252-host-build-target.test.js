import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { getBuildArguments, selectBuildTarget } from '../scripts/build.js';

const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const readme = fs.readFileSync('README.md', 'utf8');

test('default build selects only the electron-builder target for the current host', () => {
  assert.equal(selectBuildTarget('win32'), '--win');
  assert.equal(selectBuildTarget('darwin'), '--mac');
  assert.equal(selectBuildTarget('linux'), '--linux');

  for (const [platform, expectedTarget] of [
    ['win32', '--win'],
    ['darwin', '--mac'],
    ['linux', '--linux']
  ]) {
    assert.deepEqual(
      getBuildArguments(platform, {
        builderCli: 'electron-builder-cli',
        config: 'builder-config'
      }),
      [
        '--no-deprecation',
        'electron-builder-cli',
        expectedTarget,
        '--config',
        'builder-config'
      ]
    );
  }
});

test('default build fails clearly on unsupported hosts', () => {
  assert.throws(
    () => selectBuildTarget('freebsd'),
    /Unsupported build platform "freebsd"\. Supported platforms: win32, darwin, linux\./
  );
});

test('package scripts keep explicit targets and route only the default through the selector', () => {
  assert.equal(packageJson.scripts.build, 'node scripts/build.js');
  assert.equal(
    packageJson.scripts['build:win'],
    'node --no-deprecation ./node_modules/electron-builder/cli.js --win --config electron-builder.config.cjs'
  );
  assert.equal(
    packageJson.scripts['build:mac'],
    'node --no-deprecation ./node_modules/electron-builder/cli.js --mac --config electron-builder.config.cjs'
  );
  assert.equal(
    packageJson.scripts['build:linux'],
    'node --no-deprecation ./node_modules/electron-builder/cli.js --linux --config electron-builder.config.cjs'
  );
});

test('README describes the default as a current-host build, not an all-platform build', () => {
  const buildLine = readme.split(/\r?\n/).find(line => line.includes('npm run build '));
  assert.ok(buildLine);
  assert.match(buildLine, /current operating system/i);
  assert.doesNotMatch(buildLine, /all platforms/i);
  assert.match(readme, /default build selects the target supported by the current host/i);
});
