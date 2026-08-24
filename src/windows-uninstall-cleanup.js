import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { removeWindowsCaTrust } from './proxy/windows-ca-trust.js';

const FINGERPRINT_PATTERN = /^[0-9A-F]{40}$/;

function normalizeFingerprint(value) {
  const fingerprint = String(value || '').trim().replace(/:/g, '').toUpperCase();
  return FINGERPRINT_PATTERN.test(fingerprint) ? fingerprint : null;
}

function readJson(fileSystem, filePath) {
  return JSON.parse(fileSystem.readFileSync(filePath, 'utf8'));
}

export function collectOwnedCaFingerprints(dataDir, fileSystem = fs) {
  const fingerprints = new Set();
  const add = value => {
    const fingerprint = normalizeFingerprint(value);
    if (!fingerprint) throw new Error(`Invalid CA fingerprint in ${dataDir}`);
    fingerprints.add(fingerprint);
  };
  const activeStatePath = path.join(dataDir, 'ca-active.json');
  const replacementStatePath = path.join(dataDir, 'ca-replacements.json');
  const migrationStatePath = path.join(dataDir, 'ca-migration.json');
  const certificatePath = path.join(dataDir, 'ca.pem');

  if (fileSystem.existsSync(activeStatePath)) add(readJson(fileSystem, activeStatePath)?.fingerprint);
  if (fileSystem.existsSync(replacementStatePath)) {
    const state = readJson(fileSystem, replacementStatePath);
    if (!Array.isArray(state?.fingerprints)) {
      throw new Error(`Invalid CA replacement state in ${replacementStatePath}`);
    }
    for (const fingerprint of state.fingerprints) add(fingerprint);
  }
  if (fileSystem.existsSync(migrationStatePath)) {
    add(readJson(fileSystem, migrationStatePath)?.previousFingerprint);
  }
  if (fileSystem.existsSync(certificatePath)) {
    const certificate = new crypto.X509Certificate(fileSystem.readFileSync(certificatePath));
    add(certificate.fingerprint);
  }

  return [...fingerprints];
}

export function cleanupWindowsInstallation(dataDir, options = {}) {
  const platform = options.platform || process.platform;
  const fileSystem = options.fileSystem || fs;
  const run = options.run;
  if (platform !== 'win32') throw new Error('Windows uninstall cleanup requires Windows');
  if (typeof dataDir !== 'string' || dataDir.trim() === '') {
    throw new TypeError('The HTTP FreeKit data directory is required');
  }

  const resolvedDataDir = path.resolve(dataDir);
  if (path.basename(resolvedDataDir).toLowerCase() !== 'data' ||
      path.basename(path.dirname(resolvedDataDir)).toLowerCase() !== 'http-freekit') {
    throw new Error('Refusing to remove an unexpected data directory');
  }
  if (!fileSystem.existsSync(resolvedDataDir)) return { fingerprints: [], removed: false };

  const fingerprints = collectOwnedCaFingerprints(resolvedDataDir, fileSystem);
  const hasPrivateKey = fileSystem.existsSync(path.join(resolvedDataDir, 'ca.key'));
  if (hasPrivateKey && fingerprints.length === 0) {
    throw new Error('Cannot identify the trusted CA associated with the retained private key');
  }

  const removal = removeWindowsCaTrust(fingerprints, run);
  if (removal.remainingFingerprints.length > 0) {
    throw new AggregateError(
      removal.errors.map(entry => entry.error),
      `Could not remove ${removal.remainingFingerprints.length} trusted CA certificate(s)`
    );
  }

  fileSystem.rmSync(resolvedDataDir, { recursive: true, force: false });
  return { fingerprints, removed: true };
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    cleanupWindowsInstallation(process.argv[2]);
  } catch (error) {
    console.error(`[Uninstall] ${error.message}`);
    process.exitCode = 1;
  }
}
