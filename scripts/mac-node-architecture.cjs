'use strict';

const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ELECTRON_BUILDER_ARCH_NAMES = Object.freeze([
  'ia32',
  'x64',
  'armv7l',
  'arm64',
  'universal'
]);
const MACHO_64_MAGIC = 0xfeedfacf;
const MACHO_CPU_ARCHITECTURES = new Map([
  [0x01000007, 'x64'],
  [0x0100000c, 'arm64']
]);
const MAC_NODE_VERSION = '26.7.0';
const MAC_NODE_PACKAGES = Object.freeze({
  x64: Object.freeze({
    spec: `node-darwin-x64@${MAC_NODE_VERSION}`,
    filename: `node-darwin-x64-${MAC_NODE_VERSION}.tgz`,
    integrity: 'sha512-a9XMejcP9oqJETe5jDKDHcM3ihyCtvGsf6HmryPwLJZ/meaNdxxcQnPEFgHrWgPDshX1q5fwalc27cBSkUvHnA=='
  }),
  arm64: Object.freeze({
    spec: `node-bin-darwin-arm64@${MAC_NODE_VERSION}`,
    filename: `node-bin-darwin-arm64-${MAC_NODE_VERSION}.tgz`,
    integrity: 'sha512-B8xlPBR3PT9EzAw5MVrcnuWj7z4hzCFZFO5ZMqh8DmGHgOEZSTMsrMkBG+0ou7APYg1dFF76fGOu129O+BEpLQ=='
  })
});

function getTargetArchitecture(context) {
  const architecture = typeof context?.arch === 'string'
    ? context.arch
    : ELECTRON_BUILDER_ARCH_NAMES[context?.arch];
  if (!architecture) throw new Error(`Unsupported electron-builder architecture: ${context?.arch}`);
  return architecture;
}

function isMacContext(context) {
  return context?.electronPlatformName === 'darwin';
}

function getPackagedNodePath(context) {
  const productFilename = context?.packager?.appInfo?.productFilename;
  if (typeof productFilename !== 'string' || productFilename.trim() === '') {
    throw new Error('electron-builder did not provide the macOS product filename');
  }
  return path.join(
    context.appOutDir,
    `${productFilename}.app`,
    'Contents',
    'Resources',
    'app.asar.unpacked',
    'node_modules',
    'node',
    'bin',
    'node'
  );
}

function readMachOArchitecture(executablePath, fileSystem = fs) {
  const descriptor = fileSystem.openSync(executablePath, 'r');
  try {
    const header = Buffer.alloc(8);
    const bytesRead = fileSystem.readSync(descriptor, header, 0, header.length, 0);
    if (bytesRead !== header.length || header.readUInt32LE(0) !== MACHO_64_MAGIC) {
      throw new Error('bundled backend is not a thin 64-bit Mach-O executable');
    }
    const architecture = MACHO_CPU_ARCHITECTURES.get(header.readUInt32LE(4));
    if (!architecture) {
      throw new Error(`bundled backend has unsupported Mach-O CPU type 0x${header.readUInt32LE(4).toString(16)}`);
    }
    return architecture;
  } finally {
    fileSystem.closeSync(descriptor);
  }
}

function getMacNodePackage(architecture, packages = MAC_NODE_PACKAGES) {
  const packageInfo = packages[architecture];
  if (!packageInfo) {
    throw new Error(`No standalone macOS Node runtime is configured for ${architecture}`);
  }
  return packageInfo;
}

function assertPackageIntegrity(tarballPath, integrity, fileSystem = fs) {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(integrity || '');
  if (!match) throw new Error('macOS Node package has an invalid pinned integrity value');
  const actual = crypto.createHash('sha512')
    .update(fileSystem.readFileSync(tarballPath))
    .digest('base64');
  if (actual !== match[1]) {
    throw new Error(`macOS Node package failed integrity verification: ${tarballPath}`);
  }
}

function runNpmPack(packageInfo, destination, options = {}) {
  const run = options.execFileSync || execFileSync;
  const npmExecPath = process.env.npm_execpath;
  const executable = npmExecPath
    ? process.execPath
    : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const prefixArgs = npmExecPath ? [npmExecPath] : [];
  const output = run(executable, [
    ...prefixArgs,
    'pack',
    packageInfo.spec,
    '--json',
    '--ignore-scripts',
    '--pack-destination',
    destination
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit']
  });
  let metadata;
  try {
    metadata = JSON.parse(output);
  } catch (error) {
    throw new Error(`npm pack returned invalid metadata for ${packageInfo.spec}: ${error.message}`);
  }
  const filename = metadata?.[0]?.filename;
  if (filename !== packageInfo.filename) {
    throw new Error(
      `npm pack returned unexpected archive ${String(filename)} for ${packageInfo.spec}`
    );
  }
  return path.join(destination, filename);
}

function ensureMacNodeTarball(packageInfo, cacheDir, options = {}) {
  const fileSystem = options.fileSystem || fs;
  const targetPath = path.join(cacheDir, packageInfo.filename);
  fileSystem.mkdirSync(cacheDir, { recursive: true });
  if (fileSystem.existsSync(targetPath)) {
    try {
      assertPackageIntegrity(targetPath, packageInfo.integrity, fileSystem);
      return targetPath;
    } catch {
      fileSystem.unlinkSync(targetPath);
    }
  }

  const packDirectory = fileSystem.mkdtempSync(path.join(cacheDir, '.pack-'));
  try {
    const packedPath = (options.packNpmPackage || runNpmPack)(
      packageInfo,
      packDirectory,
      options
    );
    const resolvedPackDirectory = path.resolve(packDirectory);
    const resolvedPackedPath = path.resolve(packedPath);
    if (path.dirname(resolvedPackedPath) !== resolvedPackDirectory ||
        path.basename(resolvedPackedPath) !== packageInfo.filename) {
      throw new Error('npm pack returned an archive outside its private staging directory');
    }
    assertPackageIntegrity(resolvedPackedPath, packageInfo.integrity, fileSystem);
    fileSystem.renameSync(resolvedPackedPath, targetPath);
    return targetPath;
  } finally {
    fileSystem.rmSync(packDirectory, { recursive: true, force: true });
  }
}

function extractMacNodeExecutable(tarballPath, destination, options = {}) {
  const run = options.execFileSync || execFileSync;
  run('tar', [
    '-xzf',
    tarballPath,
    '-C',
    destination,
    'package/bin/node'
  ], { stdio: 'inherit' });
  return path.join(destination, 'package', 'bin', 'node');
}

function stagePackagedMacNodeArchitecture(context, options = {}) {
  if (!isMacContext(context)) return;
  const fileSystem = options.fileSystem || fs;
  const targetArchitecture = getTargetArchitecture(context);
  const packageInfo = getMacNodePackage(targetArchitecture, options.packages);
  const cacheDir = options.cacheDir || process.env.HTTP_FREEKIT_MAC_NODE_CACHE ||
    path.resolve(__dirname, '..', 'node_modules', '.cache', 'http-freekit-mac-node');
  const tarballPath = ensureMacNodeTarball(packageInfo, cacheDir, options);
  const extractionDirectory = fileSystem.mkdtempSync(path.join(cacheDir, '.extract-'));

  try {
    const sourcePath = (options.extractNodeExecutable || extractMacNodeExecutable)(
      tarballPath,
      extractionDirectory,
      options
    );
    const sourceArchitecture = readMachOArchitecture(sourcePath, fileSystem);
    if (sourceArchitecture !== targetArchitecture) {
      throw new Error(
        `Staged Node backend architecture ${sourceArchitecture} does not match macOS target ${targetArchitecture}`
      );
    }

    const executablePath = getPackagedNodePath(context);
    fileSystem.mkdirSync(path.dirname(executablePath), { recursive: true });
    fileSystem.copyFileSync(sourcePath, executablePath);
    fileSystem.chmodSync(executablePath, 0o755);
    assertPackagedMacNodeArchitecture(context, { fileSystem });
  } finally {
    fileSystem.rmSync(extractionDirectory, { recursive: true, force: true });
  }
}

function assertPackagedMacNodeArchitecture(context, options = {}) {
  if (!isMacContext(context)) return;
  const targetArchitecture = getTargetArchitecture(context);
  const executablePath = getPackagedNodePath(context);
  const actualArchitecture = readMachOArchitecture(executablePath, options.fileSystem || fs);
  if (actualArchitecture !== targetArchitecture) {
    throw new Error(
      `Packaged Node backend architecture ${actualArchitecture} does not match macOS target ${targetArchitecture}: ${executablePath}`
    );
  }
}

module.exports = {
  MAC_NODE_PACKAGES,
  MAC_NODE_VERSION,
  assertPackageIntegrity,
  assertPackagedMacNodeArchitecture,
  ensureMacNodeTarball,
  getMacNodePackage,
  getPackagedNodePath,
  getTargetArchitecture,
  readMachOArchitecture,
  stagePackagedMacNodeArchitecture
};
