import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILDER_CLI = path.join(PROJECT_ROOT, 'node_modules', 'electron-builder', 'cli.js');
const BUILDER_CONFIG = path.join(PROJECT_ROOT, 'electron-builder.config.cjs');

const BUILD_TARGETS = Object.freeze({
  win32: '--win',
  darwin: '--mac',
  linux: '--linux'
});

export function selectBuildTarget(platform) {
  const target = BUILD_TARGETS[platform];
  if (!target) {
    throw new Error(
      `Unsupported build platform "${platform}". Supported platforms: win32, darwin, linux.`
    );
  }
  return target;
}

export function getBuildArguments(platform, options = {}) {
  return [
    '--no-deprecation',
    options.builderCli || BUILDER_CLI,
    selectBuildTarget(platform),
    '--config',
    options.config || BUILDER_CONFIG
  ];
}

export function runBuild(platform = process.platform) {
  const result = spawnSync(process.execPath, getBuildArguments(platform), {
    cwd: PROJECT_ROOT,
    stdio: 'inherit'
  });

  if (result.error) {
    throw new Error(`Could not start electron-builder: ${result.error.message}`, {
      cause: result.error
    });
  }

  if (result.signal) {
    throw new Error(`electron-builder was terminated by signal ${result.signal}.`);
  }

  return result.status ?? 1;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    process.exitCode = runBuild();
  } catch (error) {
    console.error(`Build failed: ${error.message}`);
    process.exitCode = 1;
  }
}
