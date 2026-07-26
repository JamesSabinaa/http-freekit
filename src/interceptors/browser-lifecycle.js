import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileAsync } from './command-runner.js';

const PROFILE_MARKER = '.http-freekit-profile.json';
const MANAGED_PROFILE_PATTERN = /^http-freekit-(?:chrome|firefox|edge|brave)-[A-Za-z0-9._-]+$/;
const PROCESS_START_TOLERANCE_MS = 2000;

function normalizePathForComparison(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Verify that a recursive-delete target is one of our direct temp children. */
export function inspectManagedProfilePath(profileDir, tempDir = os.tmpdir()) {
  if (typeof profileDir !== 'string' || !profileDir) {
    return { safe: false, reason: 'missing path' };
  }

  const resolvedTempDir = path.resolve(tempDir);
  const resolvedProfileDir = path.resolve(profileDir);
  const name = path.basename(resolvedProfileDir);
  if (normalizePathForComparison(path.dirname(resolvedProfileDir)) !== normalizePathForComparison(resolvedTempDir)) {
    return { safe: false, reason: 'profile is not directly inside the temp directory' };
  }
  if (!MANAGED_PROFILE_PATTERN.test(name)) {
    return { safe: false, reason: 'profile name is not managed by HTTP FreeKit' };
  }

  try {
    const stats = fs.lstatSync(resolvedProfileDir);
    if (stats.isSymbolicLink()) {
      return { safe: false, reason: 'profile path is a symbolic link' };
    }
    if (!stats.isDirectory()) {
      return { safe: false, reason: 'profile path is not a directory' };
    }
    const realTempDir = fs.realpathSync(resolvedTempDir);
    const realProfileDir = fs.realpathSync(resolvedProfileDir);
    if (normalizePathForComparison(path.dirname(realProfileDir)) !== normalizePathForComparison(realTempDir)) {
      return { safe: false, reason: 'profile resolves outside the temp directory' };
    }
  } catch (err) {
    if (err.code !== 'ENOENT') return { safe: false, reason: err.message };
  }

  return { safe: true, path: resolvedProfileDir };
}

export function createManagedBrowserProfile(browserType, tempDir = os.tmpdir()) {
  if (!/^(?:chrome|firefox|edge|brave)$/.test(browserType)) {
    throw new Error(`Unsupported browser profile type: ${browserType}`);
  }

  const resolvedTempDir = path.resolve(tempDir);
  const profileDir = fs.mkdtempSync(path.join(resolvedTempDir, `http-freekit-${browserType}-`));
  try {
    fs.writeFileSync(path.join(profileDir, PROFILE_MARKER), JSON.stringify({
      ownerPid: process.pid,
      ownerStartedAt: new Date(Date.now() - (process.uptime() * 1000)).toISOString(),
      browserType,
      createdAt: new Date().toISOString()
    }, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (err) {
    fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    throw err;
  }
  return profileDir;
}

function inspectProfileOwner(profileDir) {
  const markerPath = path.join(profileDir, PROFILE_MARKER);
  let stats;
  try {
    stats = fs.lstatSync(markerPath);
  } catch (err) {
    return {
      valid: false,
      reason: err.code === 'ENOENT'
        ? `missing ${PROFILE_MARKER} ownership marker`
        : `could not inspect ${PROFILE_MARKER}: ${err.message}`
    };
  }

  if (stats.isSymbolicLink()) {
    return { valid: false, reason: `${PROFILE_MARKER} ownership marker is a symbolic link` };
  }
  if (!stats.isFile()) {
    return { valid: false, reason: `${PROFILE_MARKER} ownership marker is not a regular file` };
  }

  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch (err) {
    return { valid: false, reason: `could not parse ${PROFILE_MARKER} ownership marker: ${err.message}` };
  }

  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) {
    return { valid: false, reason: `${PROFILE_MARKER} ownership marker must contain a JSON object` };
  }
  if (!Number.isInteger(marker.ownerPid) || marker.ownerPid <= 0) {
    return { valid: false, reason: `${PROFILE_MARKER} ownership marker has an invalid ownerPid` };
  }
  if (typeof marker.createdAt !== 'string' || !Number.isFinite(Date.parse(marker.createdAt))) {
    return { valid: false, reason: `${PROFILE_MARKER} ownership marker has an invalid createdAt` };
  }
  if (!/^(?:chrome|firefox|edge|brave)$/.test(marker.browserType)) {
    return { valid: false, reason: `${PROFILE_MARKER} ownership marker has an invalid browserType` };
  }
  if (!path.basename(profileDir).startsWith(`http-freekit-${marker.browserType}-`)) {
    return { valid: false, reason: `${PROFILE_MARKER} ownership marker does not match the profile directory` };
  }

  let startedAt = null;
  if (Object.hasOwn(marker, 'ownerStartedAt')) {
    if (typeof marker.ownerStartedAt !== 'string' || !Number.isFinite(Date.parse(marker.ownerStartedAt))) {
      return { valid: false, reason: `${PROFILE_MARKER} ownership marker has an invalid ownerStartedAt` };
    }
    startedAt = Date.parse(marker.ownerStartedAt);
  }

  return {
    valid: true,
    owner: {
      pid: marker.ownerPid,
      createdAt: Date.parse(marker.createdAt),
      startedAt
    }
  };
}

function isProfileOwnerActive(owner, processes) {
  if (!owner) return false;
  const ownerProcess = processes.find(row => row.pid === owner.pid);
  const startedAt = typeof ownerProcess?.startedAt === 'number'
    ? ownerProcess.startedAt
    : Date.parse(ownerProcess?.startedAt);
  if (!Number.isFinite(startedAt)) return false;
  if (Number.isFinite(owner.startedAt)) {
    return Math.abs(startedAt - owner.startedAt) <= PROCESS_START_TOLERANCE_MS;
  }
  return startedAt <= owner.createdAt;
}

function parsePosixProcessSnapshot(output) {
  return output.split(/\r?\n/).flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s*(.*)$/);
    if (!match) return [];
    const startedAt = Date.parse(match[3]);
    return [{
      pid: Number(match[1]),
      ppid: Number(match[2]),
      startedAt: Number.isFinite(startedAt) ? startedAt : null,
      command: match[4] || ''
    }];
  });
}

function getWindowsProcessSnapshot() {
  const script = `
$items = @(Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object {
  [pscustomobject]@{
    pid = [int]$_.ProcessId
    ppid = [int]$_.ParentProcessId
    command = [string]$_.CommandLine
    startedAt = if ($null -ne $_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null }
  }
})
[Console]::Out.Write((ConvertTo-Json -InputObject $items -Compress))
`;
  const output = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer: 5 * 1024 * 1024 }
  ).trim();
  if (!output) return [];
  const parsed = JSON.parse(output);
  return (Array.isArray(parsed) ? parsed : [parsed]).map(item => ({
    pid: Number(item.pid),
    ppid: Number(item.ppid),
    startedAt: Date.parse(item.startedAt),
    command: String(item.command || '')
  }));
}

function getPosixProcessSnapshot() {
  const output = execFileSync('ps', ['-eo', 'pid=,ppid=,lstart=,args='], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 5 * 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C' }
  });
  return parsePosixProcessSnapshot(output);
}

export function getProcessSnapshot() {
  return process.platform === 'win32' ? getWindowsProcessSnapshot() : getPosixProcessSnapshot();
}

export async function getProcessSnapshotAsync() {
  if (process.platform === 'win32') {
    const script = `
$items = @(Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object {
  [pscustomobject]@{
    pid = [int]$_.ProcessId
    ppid = [int]$_.ParentProcessId
    command = [string]$_.CommandLine
    startedAt = if ($null -ne $_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null }
  }
})
[Console]::Out.Write((ConvertTo-Json -InputObject $items -Compress))
`;
    const output = String(await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer: 5 * 1024 * 1024 }
    )).trim();
    if (!output) return [];
    const parsed = JSON.parse(output);
    return (Array.isArray(parsed) ? parsed : [parsed]).map(item => ({
      pid: Number(item.pid),
      ppid: Number(item.ppid),
      startedAt: Date.parse(item.startedAt),
      command: String(item.command || '')
    }));
  }

  const output = String(await execFileAsync('ps', ['-eo', 'pid=,ppid=,lstart=,args='], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 5 * 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C' }
  }));
  return parsePosixProcessSnapshot(output);
}

/**
 * Find every process using a profile and all descendants of those processes.
 * Descendant tracking catches Chromium subprocesses that omit --user-data-dir.
 */
export function collectRelatedProcessIds(processes, profileDir, rootPids = []) {
  const rows = Array.isArray(processes) ? processes : [];
  const pathNeedle = process.platform === 'win32'
    ? String(profileDir || '').toLowerCase()
    : String(profileDir || '');
  const explicitRoots = new Set(
    rootPids.filter(pid => Number.isInteger(pid) && pid > 0 && pid !== process.pid)
  );
  const related = new Set();

  for (const row of rows) {
    const command = process.platform === 'win32'
      ? String(row.command || '').toLowerCase()
      : String(row.command || '');
    if (explicitRoots.has(row.pid) || (pathNeedle && command.includes(pathNeedle))) {
      if (row.pid > 0 && row.pid !== process.pid) related.add(row.pid);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (row.pid > 0 && row.pid !== process.pid && related.has(row.ppid) && !related.has(row.pid)) {
        related.add(row.pid);
        changed = true;
      }
    }
  }

  return related;
}

export function getRelatedProcessIds(profileDir, rootPids = [], snapshot) {
  return collectRelatedProcessIds(snapshot || getProcessSnapshot(), profileDir, rootPids);
}

export async function getRelatedProcessIdsAsync(profileDir, rootPids = [], snapshot) {
  return collectRelatedProcessIds(snapshot || await getProcessSnapshotAsync(), profileDir, rootPids);
}

/** Remove one verified managed profile, with built-in retries for Windows locks. */
export function removeManagedBrowserProfile(profileDir, options = {}) {
  const tempDir = options.tempDir || os.tmpdir();
  const inspected = inspectManagedProfilePath(profileDir, tempDir);
  if (!inspected.safe) {
    return { removed: false, reason: inspected.reason, unsafe: true };
  }
  if (!fs.existsSync(inspected.path)) return { removed: true, alreadyMissing: true };

  if (options.requireOwnershipMarker) {
    const ownership = inspectProfileOwner(inspected.path);
    if (!ownership.valid) {
      return { removed: false, reason: ownership.reason, unsafe: true };
    }
  }

  try {
    fs.rmSync(inspected.path, {
      recursive: true,
      force: true,
      maxRetries: options.maxRetries ?? 6,
      retryDelay: options.retryDelay ?? 150
    });
    const removed = !fs.existsSync(inspected.path);
    return removed
      ? { removed: true }
      : { removed: false, reason: 'profile still exists after cleanup retries' };
  } catch (err) {
    return { removed: false, reason: err.message, error: err };
  }
}

/**
 * Remove abandoned profiles at startup. Active owner/browser processes always
 * win over cleanup; if process inspection fails, nothing is deleted.
 */
export function cleanupStaleBrowserProfiles(options = {}) {
  const tempDir = path.resolve(options.tempDir || os.tmpdir());
  const result = { removed: [], skippedActive: [], failed: [] };
  let snapshot;
  try {
    snapshot = options.processSnapshot || getProcessSnapshot();
  } catch (err) {
    result.failed.push({ path: tempDir, reason: `Could not inspect running processes: ${err.message}` });
    return result;
  }

  let entries;
  try {
    entries = fs.readdirSync(tempDir, { withFileTypes: true });
  } catch (err) {
    result.failed.push({ path: tempDir, reason: err.message });
    return result;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !MANAGED_PROFILE_PATTERN.test(entry.name)) continue;
    const profileDir = path.join(tempDir, entry.name);
    const ownership = inspectProfileOwner(profileDir);
    if (!ownership.valid) {
      result.failed.push({ path: profileDir, reason: ownership.reason });
      continue;
    }

    const relatedPids = collectRelatedProcessIds(snapshot, profileDir);
    if (isProfileOwnerActive(ownership.owner, snapshot) || relatedPids.size > 0) {
      result.skippedActive.push(profileDir);
      continue;
    }

    const cleanup = removeManagedBrowserProfile(profileDir, {
      ...options,
      tempDir,
      requireOwnershipMarker: true
    });
    if (cleanup.removed) result.removed.push(profileDir);
    else result.failed.push({ path: profileDir, reason: cleanup.reason || 'Unknown cleanup failure' });
  }

  return result;
}
