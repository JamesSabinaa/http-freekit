import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { execFileSync } from 'child_process';

const DESCRIPTOR_LOCK_VERSION = 1;
const DEFAULT_LOCK_TIMEOUT_MS = 2000;
const MAX_LOCK_TIMEOUT_MS = 10000;
const DEFAULT_LOCK_RETRY_MS = 20;
const PROCESS_STARTED_AT = Date.now() - (process.uptime() * 1000);
const PROCESS_START_TOLERANCE_MS = 2000;
const FILE_OPERATION_ATTEMPTS = 3;
const FILE_OPERATION_RETRY_MS = 5;
const LOCK_SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));
const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const abandonedLocks = new Map();

export function createMcpLaunchConfig({
  executablePath = process.execPath,
  bridgeScript,
  descriptorPath,
  electronRuntime = false,
  packagedAppRuntime = false,
  remountingPackagedApp = false
}) {
  if (!path.isAbsolute(executablePath)) {
    throw new Error('MCP executable path must be absolute');
  }
  if (!path.isAbsolute(bridgeScript)) {
    throw new Error('MCP bridge script path must be absolute');
  }
  if (!path.isAbsolute(descriptorPath)) {
    throw new Error('MCP runtime descriptor path must be absolute');
  }

  if (packagedAppRuntime && remountingPackagedApp) {
    return {
      command: executablePath,
      args: ['--mcp-stdio-bridge', descriptorPath]
    };
  }

  return {
    command: executablePath,
    args: [bridgeScript, descriptorPath],
    ...(electronRuntime || packagedAppRuntime
      ? { env: { ELECTRON_RUN_AS_NODE: '1' } }
      : {})
  };
}

function normalizeBoundedDuration(value, fallback, maximum) {
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.min(Math.floor(value), maximum);
}

function descriptorLockPath(descriptorPath) {
  return `${descriptorPath}.lock`;
}

function sleepSync(milliseconds) {
  if (milliseconds > 0) Atomics.wait(LOCK_SLEEP_BUFFER, 0, 0, milliseconds);
}

function createLockError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function inspectLockOwner(lockPath) {
  let stats;
  try {
    stats = fs.lstatSync(lockPath);
  } catch (err) {
    if (err.code === 'ENOENT') return { state: 'missing' };
    return { state: 'ambiguous', reason: err.message };
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    return { state: 'ambiguous', reason: 'lock path is not a regular file' };
  }

  let owner;
  try {
    owner = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch (err) {
    return { state: 'ambiguous', reason: `lock owner could not be read: ${err.message}` };
  }
  if (!owner || typeof owner !== 'object' || Array.isArray(owner) ||
      owner.version !== DESCRIPTOR_LOCK_VERSION ||
      typeof owner.token !== 'string' || !owner.token || owner.token.length > 200 ||
      !Number.isInteger(owner.pid) || owner.pid <= 0 ||
      !Number.isFinite(owner.processStartedAt) || owner.processStartedAt <= 0 ||
      !Number.isFinite(owner.createdAt) || owner.createdAt <= 0) {
    return { state: 'ambiguous', reason: 'lock owner metadata is invalid' };
  }
  return { state: 'owned', owner };
}

function isSameLockOwner(left, right) {
  return !!left && !!right &&
    left.version === right.version &&
    left.token === right.token &&
    left.pid === right.pid &&
    left.processStartedAt === right.processStartedAt &&
    left.createdAt === right.createdAt;
}

function lockOwnerKey(owner) {
  return `${owner.token}:${owner.pid}:${owner.processStartedAt}:${owner.createdAt}`;
}

function abandonedLockKey(lockPath) {
  return path.resolve(lockPath);
}

function sameFileIdentity(left, right) {
  if (!left || !right || left.dev !== right.dev || left.ino !== right.ino) return false;
  if (left.ino !== 0n || left.dev !== 0n) return true;
  return left.birthtimeNs === right.birthtimeNs;
}

function inspectCreatedLockIdentity(lockPath, fd) {
  try {
    const descriptorStats = fs.fstatSync(fd, { bigint: true });
    const pathStats = fs.lstatSync(lockPath, { bigint: true });
    if (!descriptorStats.isFile() || !pathStats.isFile() || pathStats.isSymbolicLink()) return null;
    return sameFileIdentity(descriptorStats, pathStats) ? descriptorStats : null;
  } catch {
    return null;
  }
}

function removeFailedCreatedLock(lockPath, identity) {
  if (!identity) return false;
  try {
    const current = fs.lstatSync(lockPath, { bigint: true });
    if (!current.isFile() || current.isSymbolicLink() || !sameFileIdentity(current, identity)) return false;
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function inspectOwnedFileIdentity(filePath, expectedOwner) {
  const current = inspectLockOwner(filePath);
  if (current.state !== 'owned' || !isSameLockOwner(current.owner, expectedOwner)) return null;
  try {
    const stats = fs.lstatSync(filePath, { bigint: true });
    if (!stats.isFile() || stats.isSymbolicLink()) return null;
    return stats;
  } catch {
    return null;
  }
}

function removeOwnedArtifact(filePath, expectedOwner, expectedIdentity) {
  const identity = expectedIdentity || inspectOwnedFileIdentity(filePath, expectedOwner);
  if (!identity) return false;

  for (let attempt = 0; attempt < FILE_OPERATION_ATTEMPTS; attempt++) {
    const currentIdentity = inspectOwnedFileIdentity(filePath, expectedOwner);
    if (!currentIdentity || !sameFileIdentity(currentIdentity, identity)) return false;
    try {
      fs.unlinkSync(filePath);
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') return true;
      if (attempt + 1 < FILE_OPERATION_ATTEMPTS) sleepSync(FILE_OPERATION_RETRY_MS);
    }
  }
  return false;
}

function queryProcessStartedAt(pid) {
  let output;
  try {
    if (process.platform === 'win32') {
      const script = [
        `$target = Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\" -ErrorAction Stop`,
        'if ($null -eq $target) { exit 3 }',
        '$target.CreationDate.ToUniversalTime().ToString("o")'
      ].join('; ');
      output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
        windowsHide: true
      });
    } else {
      output = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C' },
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1000
      });
    }
  } catch {
    return null;
  }

  const value = Date.parse(output.trim());
  return Number.isFinite(value) ? value : null;
}

function isLockOwnerDemonstrablyLive(owner, options = {}, livenessCache) {
  if (owner.pid === process.pid) {
    return Math.abs(owner.processStartedAt - PROCESS_STARTED_AT) <= PROCESS_START_TOLERANCE_MS;
  }
  let pidExists = false;
  try {
    process.kill(owner.pid, 0);
    pidExists = true;
  } catch (err) {
    if (err.code === 'ESRCH') return false;
    if (err.code !== 'EPERM') return null;
    pidExists = true;
  }

  if (!pidExists) return false;
  const cacheKey = lockOwnerKey(owner);
  if (livenessCache?.has(cacheKey)) return livenessCache.get(cacheKey);
  const probe = typeof options.processStartTimeProbe === 'function'
    ? options.processStartTimeProbe
    : queryProcessStartedAt;
  let actualStartedAt;
  try {
    actualStartedAt = probe(owner.pid);
  } catch {
    livenessCache?.set(cacheKey, null);
    return null;
  }
  if (!Number.isFinite(actualStartedAt) || actualStartedAt <= 0) {
    livenessCache?.set(cacheKey, null);
    return null;
  }
  const matches = Math.abs(actualStartedAt - owner.processStartedAt) <= PROCESS_START_TOLERANCE_MS;
  // A matching/ambiguous result may be cached only for this acquisition and
  // exact owner identity. A mismatch is never cached, so a recycled PID is
  // freshly verified before that owner is declared stale.
  if (matches) livenessCache?.set(cacheKey, true);
  return matches;
}

function isGeneratedLockArtifactName(lockPath, name, labels) {
  const basename = path.basename(lockPath);
  return labels.some(label => {
    const prefix = `${basename}.${label}-`;
    if (!name.startsWith(prefix)) return false;
    return new RegExp(`^[1-9]\\d*-${UUID_PATTERN}$`, 'i').test(name.slice(prefix.length));
  });
}

function cleanupLockArtifacts(lockPath, options = {}, livenessCache) {
  const directory = path.dirname(lockPath);
  let entries;
  try {
    entries = fs.readdirSync(directory);
  } catch {
    return;
  }

  for (const name of entries) {
    const artifactPath = path.join(directory, name);
    if (isGeneratedLockArtifactName(lockPath, name, ['release', 'stale', 'failed'])) {
      const artifact = inspectLockOwner(artifactPath);
      if (artifact.state === 'owned') removeOwnedArtifact(artifactPath, artifact.owner);
      continue;
    }
    if (!isGeneratedLockArtifactName(lockPath, name, ['pending'])) continue;
    const pending = inspectLockOwner(artifactPath);
    if (pending.state !== 'owned') continue;
    if (isLockOwnerDemonstrablyLive(pending.owner, options, livenessCache) !== false) continue;
    removeOwnedArtifact(artifactPath, pending.owner);
  }
}

function moveAndRemoveOwnedLock(lockPath, expectedOwner, label) {
  const originalIdentity = inspectOwnedFileIdentity(lockPath, expectedOwner);
  if (!originalIdentity) return false;

  const movedPath = `${lockPath}.${label}-${process.pid}-${crypto.randomUUID()}`;
  let moved = false;
  for (let attempt = 0; attempt < FILE_OPERATION_ATTEMPTS; attempt++) {
    const currentIdentity = inspectOwnedFileIdentity(lockPath, expectedOwner);
    if (!currentIdentity || !sameFileIdentity(currentIdentity, originalIdentity)) return false;
    try {
      fs.renameSync(lockPath, movedPath);
      moved = true;
      break;
    } catch (err) {
      if (err.code === 'ENOENT') return false;
      if (attempt + 1 < FILE_OPERATION_ATTEMPTS) sleepSync(FILE_OPERATION_RETRY_MS);
    }
  }
  // A direct unlink remains ownership- and identity-checked. This is a bounded
  // fallback only when this process owns the current operation's token. Stale
  // recovery must use atomic quarantine: check-then-unlink could otherwise
  // delete a replacement acquired by another concurrent recoverer.
  if (!moved) {
    if (label === 'stale') return false;
    return removeOwnedArtifact(lockPath, expectedOwner, originalIdentity);
  }

  const movedOwner = inspectLockOwner(movedPath);
  if (movedOwner.state !== 'owned' || !isSameLockOwner(movedOwner.owner, expectedOwner)) {
    try {
      if (!fs.existsSync(lockPath)) fs.renameSync(movedPath, lockPath);
    } catch {}
    return false;
  }

  // Renaming the canonical path releases the lock. Removing the uniquely
  // named artifact is best-effort and must not turn a successful operation
  // into a reported failure; a later acquisition validates and removes it.
  removeOwnedArtifact(movedPath, expectedOwner);
  return true;
}

function createDescriptorLock(lockPath, options = {}) {
  const owner = {
    version: DESCRIPTOR_LOCK_VERSION,
    token: crypto.randomUUID(),
    pid: process.pid,
    processStartedAt: PROCESS_STARTED_AT,
    createdAt: Date.now()
  };
  const pendingPath = `${lockPath}.pending-${process.pid}-${owner.token}`;
  let fd;
  let linked = false;
  let pendingIdentity;
  try {
    fd = fs.openSync(pendingPath, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(owner), { encoding: 'utf8' });
    if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
    pendingIdentity = inspectCreatedLockIdentity(pendingPath, fd);
    if (!pendingIdentity) {
      throw createLockError(
        'MCP runtime descriptor pending lock identity could not be verified',
        'MCP_DESCRIPTOR_LOCK_LOST'
      );
    }
    fs.closeSync(fd);
    fd = undefined;

    if (typeof options.beforeLockLink === 'function') {
      options.beforeLockLink({ lockPath, pendingPath, owner: { ...owner } });
    }
    fs.linkSync(pendingPath, lockPath);
    linked = true;
    if (typeof options.afterLockLink === 'function') {
      options.afterLockLink({ lockPath, pendingPath, owner: { ...owner } });
    }
    try { fs.unlinkSync(pendingPath); } catch {}
  } catch (err) {
    if (fd !== undefined) {
      const createdIdentity = inspectCreatedLockIdentity(pendingPath, fd);
      try { fs.closeSync(fd); } catch {}
      fd = undefined;
      removeFailedCreatedLock(pendingPath, createdIdentity);
    } else {
      if (linked && !moveAndRemoveOwnedLock(lockPath, owner, 'failed')) {
        removeFailedCreatedLock(lockPath, pendingIdentity);
      }
      removeFailedCreatedLock(pendingPath, pendingIdentity);
    }
    throw err;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }

  const written = inspectLockOwner(lockPath);
  if (written.state !== 'owned' || !isSameLockOwner(written.owner, owner)) {
    removeFailedCreatedLock(lockPath, pendingIdentity);
    removeFailedCreatedLock(pendingPath, pendingIdentity);
    throw createLockError('MCP runtime descriptor lock ownership could not be verified', 'MCP_DESCRIPTOR_LOCK_LOST');
  }
  const identity = inspectOwnedFileIdentity(lockPath, owner);
  if (!identity) {
    removeFailedCreatedLock(lockPath, pendingIdentity);
    removeFailedCreatedLock(pendingPath, pendingIdentity);
    throw createLockError('MCP runtime descriptor lock identity could not be verified', 'MCP_DESCRIPTOR_LOCK_LOST');
  }
  return { path: lockPath, owner, identity, pendingPath };
}

function acquireDescriptorLock(descriptorPath, options = {}) {
  const lockPath = descriptorLockPath(descriptorPath);
  const livenessCache = new Map();
  cleanupLockArtifacts(lockPath, options, livenessCache);
  const timeoutMs = normalizeBoundedDuration(
    options.lockTimeoutMs,
    DEFAULT_LOCK_TIMEOUT_MS,
    MAX_LOCK_TIMEOUT_MS
  );
  const retryMs = Math.max(1, normalizeBoundedDuration(
    options.lockRetryMs,
    DEFAULT_LOCK_RETRY_MS,
    250
  ));
  const deadline = Date.now() + timeoutMs;
  let lastReason = 'lock is held by another process';
  let contentionReported = false;

  while (true) {
    try {
      const lock = createDescriptorLock(lockPath, options);
      abandonedLocks.delete(abandonedLockKey(lockPath));
      cleanupLockArtifacts(lockPath, options, livenessCache);
      return lock;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }

    const existing = inspectLockOwner(lockPath);
    const abandonedKey = abandonedLockKey(lockPath);
    const abandoned = abandonedLocks.get(abandonedKey);
    if (existing.state === 'missing') {
      abandonedLocks.delete(abandonedKey);
      continue;
    }
    if (existing.state === 'owned') {
      const existingIdentity = abandoned
        ? inspectOwnedFileIdentity(lockPath, existing.owner)
        : null;
      const isExactAbandonedLock = !!abandoned &&
        isSameLockOwner(existing.owner, abandoned.owner) &&
        sameFileIdentity(existingIdentity, abandoned.identity);
      if (abandoned && !isExactAbandonedLock) abandonedLocks.delete(abandonedKey);
      if (isExactAbandonedLock) {
        if (moveAndRemoveOwnedLock(lockPath, existing.owner, 'stale')) {
          abandonedLocks.delete(abandonedKey);
          continue;
        }
        lastReason = 'a previously failed release could not be safely quarantined';
      } else {
        const live = isLockOwnerDemonstrablyLive(existing.owner, options, livenessCache);
        if (live === false && moveAndRemoveOwnedLock(lockPath, existing.owner, 'stale')) continue;
        lastReason = live === true
          ? `lock holder PID ${existing.owner.pid} is still running`
          : 'lock holder liveness could not be verified';
      }
    } else {
      abandonedLocks.delete(abandonedKey);
      lastReason = existing.reason || 'lock ownership is ambiguous';
    }

    if (!contentionReported && typeof options.onLockContention === 'function') {
      contentionReported = true;
      options.onLockContention({ lockPath, reason: lastReason });
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw createLockError(
        `Timed out waiting for MCP runtime descriptor lock: ${lastReason}`,
        'MCP_DESCRIPTOR_LOCK_TIMEOUT'
      );
    }
    sleepSync(Math.min(retryMs, remaining));
  }
}

function assertDescriptorLockOwned(lock) {
  const current = inspectLockOwner(lock.path);
  if (current.state !== 'owned' || !isSameLockOwner(current.owner, lock.owner)) {
    throw createLockError('MCP runtime descriptor lock ownership was lost', 'MCP_DESCRIPTOR_LOCK_LOST');
  }
}

function withDescriptorLock(descriptorPath, options, operation) {
  const lock = acquireDescriptorLock(descriptorPath, options);
  let operationError = null;
  let result;
  try {
    assertDescriptorLockOwned(lock);
    if (typeof options.onLockAcquired === 'function') {
      options.onLockAcquired({ lockPath: lock.path, owner: { ...lock.owner } });
    }
    assertDescriptorLockOwned(lock);
    result = operation(lock);
  } catch (err) {
    operationError = err;
  }

  const released = moveAndRemoveOwnedLock(lock.path, lock.owner, 'release');
  removeOwnedArtifact(lock.pendingPath, lock.owner);
  const abandonedKey = abandonedLockKey(lock.path);
  if (released) {
    abandonedLocks.delete(abandonedKey);
  } else {
    const currentIdentity = inspectOwnedFileIdentity(lock.path, lock.owner);
    if (currentIdentity && sameFileIdentity(currentIdentity, lock.identity)) {
      abandonedLocks.set(abandonedKey, {
        owner: { ...lock.owner },
        identity: lock.identity
      });
    } else {
      abandonedLocks.delete(abandonedKey);
    }
  }
  if (operationError && !released) {
    const releaseError = createLockError(
      'MCP runtime descriptor lock could not be safely released',
      'MCP_DESCRIPTOR_LOCK_LOST'
    );
    const combined = new AggregateError(
      [operationError, releaseError],
      'MCP runtime descriptor operation and lock release both failed'
    );
    combined.code = 'MCP_DESCRIPTOR_OPERATION_AND_RELEASE_FAILED';
    throw combined;
  }
  if (operationError) throw operationError;
  if (!released) {
    throw createLockError('MCP runtime descriptor lock could not be safely released', 'MCP_DESCRIPTOR_LOCK_LOST');
  }
  return result;
}

function isGeneratedDescriptorTempName(descriptorPath, name) {
  const prefix = `.${path.basename(descriptorPath)}.`;
  if (!name.startsWith(prefix) || !name.endsWith('.tmp')) return false;
  const generatedPart = name.slice(prefix.length, -'.tmp'.length);
  return new RegExp(`^[1-9]\\d*\\.${UUID_PATTERN}$`, 'i').test(generatedPart);
}

function removeRegularFileByIdentity(filePath) {
  let identity;
  try {
    identity = fs.lstatSync(filePath, { bigint: true });
    if (!identity.isFile() || identity.isSymbolicLink()) return true;
  } catch (err) {
    return err.code === 'ENOENT';
  }

  for (let attempt = 0; attempt < FILE_OPERATION_ATTEMPTS; attempt++) {
    try {
      const current = fs.lstatSync(filePath, { bigint: true });
      if (!current.isFile() || current.isSymbolicLink() || !sameFileIdentity(current, identity)) return false;
      fs.unlinkSync(filePath);
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') return true;
      if (attempt + 1 < FILE_OPERATION_ATTEMPTS) sleepSync(FILE_OPERATION_RETRY_MS);
    }
  }
  return false;
}

function cleanupDescriptorTempOrphans(descriptorPath) {
  const directory = path.dirname(descriptorPath);
  const failed = [];
  for (const name of fs.readdirSync(directory)) {
    if (!isGeneratedDescriptorTempName(descriptorPath, name)) continue;
    if (!removeRegularFileByIdentity(path.join(directory, name))) failed.push(name);
  }
  if (failed.length > 0) {
    throw createLockError(
      `Could not remove orphaned MCP runtime descriptor temp file: ${failed.join(', ')}`,
      'MCP_DESCRIPTOR_TEMP_CLEANUP_FAILED'
    );
  }
}

export function writeMcpRuntimeDescriptor({ descriptorPath, sseUrl, authToken, instanceId }, options = {}) {
  if (!path.isAbsolute(descriptorPath)) throw new Error('MCP runtime descriptor path must be absolute');
  const descriptor = {
    sseUrl,
    instanceId,
    ...(authToken ? { authToken } : {})
  };
  const serialized = JSON.stringify(descriptor);
  const directory = path.dirname(descriptorPath);
  fs.mkdirSync(directory, { recursive: true });

  return withDescriptorLock(descriptorPath, options, lock => {
    cleanupDescriptorTempOrphans(descriptorPath);
    const tempPath = path.join(
      directory,
      `.${path.basename(descriptorPath)}.${process.pid}.${crypto.randomUUID()}.tmp`
    );
    let fd;
    let published = false;
    try {
      fd = fs.openSync(tempPath, 'wx', 0o600);
      fs.writeFileSync(fd, serialized, { encoding: 'utf8' });
      if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;

      if (typeof options.beforeDescriptorRename === 'function') {
        options.beforeDescriptorRename({ descriptorPath, tempPath });
      }
      assertDescriptorLockOwned(lock);
      fs.renameSync(tempPath, descriptorPath);
      published = true;
      return descriptor;
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch {}
      }
      if (!published) {
        try { fs.unlinkSync(tempPath); } catch (err) {
          if (err.code !== 'ENOENT') console.error('[MCP] Could not remove descriptor temp file:', err.message);
        }
      }
    }
  });
}

export function removeMcpRuntimeDescriptor(descriptorPath, instanceId, options = {}) {
  if (!fs.existsSync(path.dirname(descriptorPath))) return false;
  try {
    return withDescriptorLock(descriptorPath, options, lock => {
      cleanupDescriptorTempOrphans(descriptorPath);
      let current;
      try {
        current = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
      } catch (err) {
        if (err.code === 'ENOENT') return false;
        throw err;
      }
      if (typeof options.afterOwnershipRead === 'function') {
        options.afterOwnershipRead({ descriptorPath, current: { ...current } });
      }
      if (current.instanceId !== instanceId) return false;

      assertDescriptorLockOwned(lock);
      const revalidated = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
      if (revalidated.instanceId !== instanceId) return false;
      fs.unlinkSync(descriptorPath);
      return true;
    });
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[MCP] Could not remove runtime descriptor:', err.message);
    return false;
  }
}
