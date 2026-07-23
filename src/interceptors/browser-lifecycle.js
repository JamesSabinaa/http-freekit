import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const PROFILE_MARKER = '.http-freekit-profile.json';
const MANAGED_PROFILE_PATTERN = /^http-freekit-(?:chrome|firefox|edge|brave)-[A-Za-z0-9._-]+$/;

function normalizePathForComparison(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isPidRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
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
      browserType,
      createdAt: new Date().toISOString()
    }, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (err) {
    fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    throw err;
  }
  return profileDir;
}

function readProfileOwner(profileDir) {
  const markerPath = path.join(profileDir, PROFILE_MARKER);
  try {
    const stats = fs.lstatSync(markerPath);
    if (!stats.isFile() || stats.isSymbolicLink()) return null;
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    return Number.isInteger(marker.ownerPid) && marker.ownerPid > 0 ? marker.ownerPid : null;
  } catch {
    return null;
  }
}

function getWindowsProcessSnapshot() {
  const script = `
$items = @(Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object {
  [pscustomobject]@{
    pid = [int]$_.ProcessId
    ppid = [int]$_.ParentProcessId
    command = [string]$_.CommandLine
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
    command: String(item.command || '')
  }));
}

function getPosixProcessSnapshot() {
  const output = execFileSync('ps', ['-eo', 'pid=,ppid=,args='], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 5 * 1024 * 1024
  });
  return output.split(/\r?\n/).flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s*(.*)$/);
    if (!match) return [];
    return [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] || '' }];
  });
}

export function getProcessSnapshot() {
  return process.platform === 'win32' ? getWindowsProcessSnapshot() : getPosixProcessSnapshot();
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

/** Remove one verified managed profile, with built-in retries for Windows locks. */
export function removeManagedBrowserProfile(profileDir, options = {}) {
  const tempDir = options.tempDir || os.tmpdir();
  const inspected = inspectManagedProfilePath(profileDir, tempDir);
  if (!inspected.safe) {
    return { removed: false, reason: inspected.reason, unsafe: true };
  }
  if (!fs.existsSync(inspected.path)) return { removed: true, alreadyMissing: true };

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
    const ownerPid = readProfileOwner(profileDir);
    const relatedPids = collectRelatedProcessIds(snapshot, profileDir);
    if ((ownerPid && isPidRunning(ownerPid)) || relatedPids.size > 0) {
      result.skippedActive.push(profileDir);
      continue;
    }

    const cleanup = removeManagedBrowserProfile(profileDir, { ...options, tempDir });
    if (cleanup.removed) result.removed.push(profileDir);
    else result.failed.push({ path: profileDir, reason: cleanup.reason || 'Unknown cleanup failure' });
  }

  return result;
}
