import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const builderConfig = require('../../electron-builder.config.cjs');
const {
  MAC_NODE_PACKAGES,
  assertPackagedMacNodeArchitecture,
  getPackagedNodePath,
  stagePackagedMacNodeArchitecture
} = require('../../scripts/mac-node-architecture.cjs');

function writeMachO(filePath, architecture) {
  const cpuType = architecture === 'arm64' ? 0x0100000c : 0x01000007;
  const header = Buffer.alloc(8);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(cpuType, 4);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, header);
}

test('macOS builds publish DMG and updater ZIP artifacts for x64 and arm64', () => {
  const targets = new Map(builderConfig.mac.target.map(target => [target.target, target.arch]));

  assert.deepEqual(targets.get('dmg'), ['x64', 'arm64']);
  assert.deepEqual(targets.get('zip'), ['x64', 'arm64']);
  assert.equal(builderConfig.afterPack, stagePackagedMacNodeArchitecture);
  assert.equal(MAC_NODE_PACKAGES.x64.spec, 'node-darwin-x64@26.7.0');
  assert.equal(MAC_NODE_PACKAGES.arm64.spec, 'node-bin-darwin-arm64@26.7.0');
});

test('macOS packaging stages and caches the pinned runtime for each target', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freekit-mac-stage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = Buffer.from('fixture macOS Node package');
  const packageInfo = {
    spec: 'fixture-node@26.7.0',
    filename: 'fixture-node-26.7.0.tgz',
    integrity: `sha512-${crypto.createHash('sha512').update(archive).digest('base64')}`
  };
  const context = {
    electronPlatformName: 'darwin',
    arch: 3,
    appOutDir: path.join(root, 'output'),
    packager: { appInfo: { productFilename: 'HTTP FreeKit' } }
  };
  let packCalls = 0;
  const options = {
    cacheDir: path.join(root, 'cache'),
    packages: { arm64: packageInfo },
    packNpmPackage(_packageInfo, destination) {
      packCalls++;
      const tarballPath = path.join(destination, packageInfo.filename);
      fs.writeFileSync(tarballPath, archive);
      return tarballPath;
    },
    extractNodeExecutable(_tarballPath, destination) {
      const executablePath = path.join(destination, 'package', 'bin', 'node');
      writeMachO(executablePath, 'arm64');
      return executablePath;
    }
  };

  stagePackagedMacNodeArchitecture(context, options);
  stagePackagedMacNodeArchitecture(context, options);

  assert.equal(packCalls, 1, 'the verified npm archive should be reused from cache');
  assert.doesNotThrow(() => assertPackagedMacNodeArchitecture(context));
});

test('packaged macOS apps contain a Node Mach-O matching their target label', t => {
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freekit-mac-arch-'));
  t.after(() => fs.rmSync(appOutDir, { recursive: true, force: true }));
  const context = {
    electronPlatformName: 'darwin',
    arch: 3,
    appOutDir,
    packager: { appInfo: { productFilename: 'HTTP FreeKit' } }
  };
  const executablePath = getPackagedNodePath(context);
  fs.mkdirSync(path.dirname(executablePath), { recursive: true });
  writeMachO(executablePath, 'arm64');

  assert.doesNotThrow(() => assertPackagedMacNodeArchitecture(context));
  context.arch = 1;
  assert.throws(
    () => assertPackagedMacNodeArchitecture(context),
    /architecture arm64 does not match macOS target x64/
  );
});
