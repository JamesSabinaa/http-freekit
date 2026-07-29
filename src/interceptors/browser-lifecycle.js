import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileAsync } from './command-runner.js';

const PROFILE_MARKER = '.http-freekit-profile.json';
const MANAGED_PROFILE_PATTERN = /^http-freekit-(?:chrome|firefox|edge|brave)-[A-Za-z0-9._-]+$/;
const PROCESS_START_TOLERANCE_MS = 2000;
const WINDOWS_PROCESS_SNAPSHOT_SCRIPT = `
$items = @(Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object {
  [pscustomobject]@{
    pid = [int]$_.ProcessId
    ppid = [int]$_.ParentProcessId
    command = [string]$_.CommandLine
    executablePath = [string]$_.ExecutablePath
    startedAt = if ($null -ne $_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null }
  }
})
[Console]::Out.Write((ConvertTo-Json -InputObject $items -Compress))
`;
const BROWSER_PROCESS_NAMES = {
  win32: {
    chromium: new Set([
      'chrome',
      'chrome.exe',
      'chromium',
      'chromium.exe',
      'msedge',
      'msedge.exe',
      'brave',
      'brave.exe'
    ]),
    firefox: new Set(['firefox', 'firefox.exe'])
  },
  darwin: {
    chromium: new Set(['Google Chrome', 'chrome', 'Microsoft Edge', 'Brave Browser']),
    firefox: new Set(['firefox'])
  },
  linux: {
    chromium: new Set([
      'chrome',
      'google-chrome',
      'google-chrome-stable',
      'chromium',
      'chromium-browser',
      'microsoft-edge',
      'microsoft-edge-stable',
      'msedge',
      'brave',
      'brave-browser',
      'brave-browser-stable'
    ]),
    firefox: new Set(['firefox', 'firefox-bin'])
  }
};

function normalizePathForComparison(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function splitProcessCommandLine(commandLine, platform) {
  const args = [];
  let current = '';
  let quote = null;
  let started = false;
  const command = String(commandLine || '');

  for (let index = 0; index < command.length; index++) {
    const character = command[index];
    if (quote) {
      if (character === quote) {
        quote = null;
      } else if (platform !== 'win32' && quote === '"' && character === '\\' && index + 1 < command.length) {
        current += command[++index];
      } else {
        current += character;
      }
      started = true;
      continue;
    }

    if (/\s/.test(character)) {
      if (started) {
        args.push(current);
        current = '';
        started = false;
      }
    } else if (character === '"' || character === "'") {
      quote = character;
      started = true;
    } else if (platform !== 'win32' && character === '\\' && index + 1 < command.length) {
      current += command[++index];
      started = true;
    } else {
      current += character;
      started = true;
    }
  }

  if (started) args.push(current);
  return args;
}

function sanitizeProcessIdentity(value) {
  if (typeof value !== 'string') return null;
  const sanitized = value.trim();
  if (!sanitized || sanitized.length > 32768 || /[\0\r\n]/.test(sanitized)) return null;
  return sanitized;
}

const PROFILE_MATCH_NONE = 'none';
const PROFILE_MATCH_EXACT = 'exact';
const PROFILE_MATCH_AMBIGUOUS = 'ambiguous';

function flattenedPathArgumentMatch(commandLine, prefix, value) {
  const command = String(commandLine || '');
  const token = prefix + value;
  let index = command.indexOf(token);
  let foundExactMatch = false;
  let foundAmbiguousMatch = false;
  while (index !== -1) {
    const startsAtBoundary = index === 0 || /\s/.test(command[index - 1]);
    const suffix = command.slice(index + token.length);
    const endsAtBoundary = suffix === '' || /^\s+-/.test(suffix);
    if (startsAtBoundary && endsAtBoundary) {
      // ps flattens argv, so "<managed path> --suffix" could either be an
      // exact path followed by a flag or one longer path argument. Browsers
      // create/use their profile directory before we inspect them; reject the
      // match if any longer interpretation exists on disk.
      let ambiguous = false;
      const possibleEnds = [suffix.length];
      for (const match of suffix.matchAll(/\s+-/g)) {
        if (match.index > 0) possibleEnds.push(match.index);
      }
      for (const end of possibleEnds) {
        if (end === 0) continue;
        const extendedPath = value + suffix.slice(0, end);
        if (fs.existsSync(extendedPath)) {
          ambiguous = true;
          break;
        }
      }
      if (ambiguous) foundAmbiguousMatch = true;
      else foundExactMatch = true;
    }
    index = command.indexOf(token, index + 1);
  }
  if (foundAmbiguousMatch) return PROFILE_MATCH_AMBIGUOUS;
  return foundExactMatch ? PROFILE_MATCH_EXACT : PROFILE_MATCH_NONE;
}

export function getProcessArgv0(commandLine, platform = process.platform) {
  return sanitizeProcessIdentity(splitProcessCommandLine(commandLine, platform)[0]);
}

function browserProfileCommandMatch(
  commandLine,
  profileDir,
  platform = process.platform,
  commandName = null
) {
  if (typeof profileDir !== 'string' || !profileDir) return PROFILE_MATCH_NONE;

  const platformNames = BROWSER_PROCESS_NAMES[platform] || BROWSER_PROCESS_NAMES.linux;
  const compare = platform === 'win32'
    ? value => String(value).toLowerCase()
    : value => String(value);
  const expectedProfile = compare(profileDir);
  const args = splitProcessCommandLine(commandLine, platform);
  if (args.length === 0) return PROFILE_MATCH_NONE;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  // macOS ps flattens argv without restoring quotes, so an application path
  // such as "Google Chrome.app/.../Google Chrome" cannot supply argv[0]
  // reliably. Its comm column remains an authoritative executable name.
  const snapshotCommandName = platform === 'darwin'
    ? sanitizeProcessIdentity(commandName)
    : null;
  const executableName = compare(pathApi.basename(snapshotCommandName || args[0]));

  // Darwin's flattened ps args also lose boundaries around argument values
  // containing spaces. Resolve the remaining boundary ambiguity against the
  // profile directories that actually exist on disk.
  if (platform === 'darwin' && snapshotCommandName) {
    if (platformNames.chromium.has(executableName)) {
      return flattenedPathArgumentMatch(commandLine, '--user-data-dir=', expectedProfile);
    }
    if (platformNames.firefox.has(executableName)) {
      return flattenedPathArgumentMatch(commandLine, '-profile ', expectedProfile);
    }
    return PROFILE_MATCH_NONE;
  }

  for (let index = 0; index < args.length; index++) {
    const argument = compare(args[index]);
    if (platformNames.chromium.has(executableName) && argument.startsWith('--user-data-dir=')) {
      if (argument.slice('--user-data-dir='.length) === expectedProfile) return PROFILE_MATCH_EXACT;
      continue;
    }
    if (platformNames.firefox.has(executableName) && argument === '-profile' && index + 1 < args.length) {
      if (compare(args[index + 1]) === expectedProfile) return PROFILE_MATCH_EXACT;
      index += 1;
    }
  }

  return PROFILE_MATCH_NONE;
}

/** Match only browser launch arguments that unambiguously select this exact profile. */
export function commandUsesBrowserProfile(
  commandLine,
  profileDir,
  platform = process.platform,
  commandName = null
) {
  return browserProfileCommandMatch(commandLine, profileDir, platform, commandName) ===
    PROFILE_MATCH_EXACT;
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
      startedAt,
      browserType: marker.browserType
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

function isSameProfileOwner(left, right) {
  return !!left && !!right &&
    left.pid === right.pid &&
    left.createdAt === right.createdAt &&
    left.startedAt === right.startedAt;
}

export function parsePosixProcessSnapshot(output) {
  return String(output || '').split(/\r?\n/).flatMap(line => {
    // Repeating PID creates a reliable boundary after a comm value that may
    // itself contain spaces, while keeping comm and args in one ps snapshot.
    const match = line.match(/^\s*(\d+)\s+(.*?)\s+\1\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s*(.*)$/);
    if (!match) return [];
    const startedAt = Date.parse(match[4]);
    const pid = Number(match[1]);
    const command = match[5] || '';
    return [{
      pid,
      ppid: Number(match[3]),
      startedAt: Number.isFinite(startedAt) ? startedAt : null,
      command,
      executablePath: null,
      commandName: sanitizeProcessIdentity(match[2]),
      argv0: getProcessArgv0(command, 'linux')
    }];
  });
}

export function parseWindowsProcessSnapshot(output) {
  const serialized = String(output || '').trim();
  if (!serialized) return [];
  const parsed = JSON.parse(serialized);
  return (Array.isArray(parsed) ? parsed : [parsed]).map(item => {
    const command = String(item.command || '');
    return {
      pid: Number(item.pid),
      ppid: Number(item.ppid),
      startedAt: Date.parse(item.startedAt),
      command,
      executablePath: sanitizeProcessIdentity(item.executablePath),
      commandName: null,
      argv0: getProcessArgv0(command, 'win32')
    };
  });
}

function getWindowsProcessSnapshot() {
  const output = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_PROCESS_SNAPSHOT_SCRIPT],
    { encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer: 5 * 1024 * 1024 }
  );
  return parseWindowsProcessSnapshot(output);
}

function getPosixProcessSnapshot() {
  const options = {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 5 * 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C' }
  };
  const output = execFileSync('ps', ['-eo', 'pid=,comm=,pid=,ppid=,lstart=,args='], options);
  return parsePosixProcessSnapshot(output);
}

export function getProcessSnapshot() {
  return process.platform === 'win32' ? getWindowsProcessSnapshot() : getPosixProcessSnapshot();
}

export async function getProcessSnapshotAsync() {
  if (process.platform === 'win32') {
    const output = String(await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_PROCESS_SNAPSHOT_SCRIPT],
      { encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer: 5 * 1024 * 1024 }
    ));
    return parseWindowsProcessSnapshot(output);
  }

  const options = {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 5 * 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C' }
  };
  const output = String(await execFileAsync(
    'ps',
    ['-eo', 'pid=,comm=,pid=,ppid=,lstart=,args='],
    options
  ));
  return parsePosixProcessSnapshot(output);
}

/**
 * Find every process using a profile and all descendants of those processes.
 * Descendant tracking catches Chromium subprocesses that omit --user-data-dir.
 */
export function inspectRelatedBrowserProcesses(
  processes,
  profileDir,
  rootPids = [],
  platform = process.platform
) {
  const rows = Array.isArray(processes) ? processes : [];
  const explicitRoots = new Set(
    rootPids.filter(pid => Number.isInteger(pid) && pid > 0 && pid !== process.pid)
  );
  const related = new Set(explicitRoots);
  const ambiguous = new Set();

  for (const row of rows) {
    const profileMatch = browserProfileCommandMatch(
      row.command,
      profileDir,
      platform,
      row.commandName
    );
    if (explicitRoots.has(row.pid) || profileMatch === PROFILE_MATCH_EXACT) {
      if (row.pid > 0 && row.pid !== process.pid) related.add(row.pid);
    } else if (profileMatch === PROFILE_MATCH_AMBIGUOUS && row.pid > 0 && row.pid !== process.pid) {
      ambiguous.add(row.pid);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (row.pid > 0 && row.pid !== process.pid &&
          related.has(row.ppid) && !related.has(row.pid) && !ambiguous.has(row.pid)) {
        related.add(row.pid);
        changed = true;
      }
    }
  }

  return { processIds: related, ambiguousProcessIds: ambiguous };
}

export function collectRelatedProcessIds(processes, profileDir, rootPids = [], platform = process.platform) {
  return inspectRelatedBrowserProcesses(processes, profileDir, rootPids, platform).processIds;
}

function inferLoopbackProxyPort(processes, processIds, platform = process.platform) {
  const relatedIds = processIds instanceof Set ? processIds : new Set(processIds);
  const ports = new Set();
  for (const row of processes) {
    if (!relatedIds.has(row?.pid)) continue;
    for (const arg of splitProcessCommandLine(row.command, platform)) {
      const match = arg.match(/^--proxy-server=(?:https?:\/\/)?127\.0\.0\.1:(\d{1,5})$/i);
      if (!match) continue;
      const port = Number(match[1]);
      if (port >= 1 && port <= 65535) ports.add(port);
    }
  }
  return ports.size === 1 ? [...ports][0] : null;
}

function requireUnambiguousRelatedProcessIds(processes, profileDir, rootPids, platform) {
  const inspection = inspectRelatedBrowserProcesses(processes, profileDir, rootPids, platform);
  if (inspection.ambiguousProcessIds.size > 0) {
    const error = new Error('Browser profile process arguments are ambiguous');
    error.code = 'AMBIGUOUS_BROWSER_PROFILE_PROCESS';
    throw error;
  }
  return inspection.processIds;
}

export function getRelatedProcessIds(
  profileDir,
  rootPids = [],
  snapshot,
  platform = process.platform
) {
  return requireUnambiguousRelatedProcessIds(
    snapshot || getProcessSnapshot(),
    profileDir,
    rootPids,
    platform
  );
}

export async function getRelatedProcessIdsAsync(
  profileDir,
  rootPids = [],
  snapshot,
  platform = process.platform
) {
  return requireUnambiguousRelatedProcessIds(
    snapshot || await getProcessSnapshotAsync(),
    profileDir,
    rootPids,
    platform
  );
}

/** Remove one verified managed profile, with built-in retries for Windows locks. */
export function removeManagedBrowserProfile(profileDir, options = {}) {
  const tempDir = options.tempDir || os.tmpdir();
  const inspected = inspectManagedProfilePath(profileDir, tempDir);
  if (!inspected.safe) {
    return { removed: false, reason: inspected.reason, unsafe: true };
  }
  if (!fs.existsSync(inspected.path)) return { removed: true, alreadyMissing: true };

  let ownership = null;
  if (options.requireOwnershipMarker || typeof options.revalidateBeforeRemove === 'function') {
    ownership = inspectProfileOwner(inspected.path);
    if (!ownership.valid) {
      return { removed: false, reason: ownership.reason, unsafe: true };
    }
  }

  if (typeof options.revalidateBeforeRemove === 'function') {
    let revalidation;
    try {
      revalidation = options.revalidateBeforeRemove({
        path: inspected.path,
        owner: ownership.owner
      });
    } catch (err) {
      return {
        removed: false,
        reason: `Profile cleanup revalidation failed: ${err.message}`,
        revalidationFailed: true
      };
    }
    if (!revalidation || revalidation.safeToRemove !== true) {
      return {
        removed: false,
        reason: revalidation?.reason || 'Profile cleanup revalidation did not permit removal',
        active: revalidation?.active === true,
        revalidationFailed: revalidation?.revalidationFailed === true
      };
    }

    const finalInspection = inspectManagedProfilePath(inspected.path, tempDir);
    if (!finalInspection.safe) {
      return { removed: false, reason: finalInspection.reason, unsafe: true };
    }
    if (!fs.existsSync(finalInspection.path)) return { removed: true, alreadyMissing: true };

    const finalOwnership = inspectProfileOwner(finalInspection.path);
    if (!finalOwnership.valid) {
      return { removed: false, reason: finalOwnership.reason, unsafe: true };
    }
    if (!isSameProfileOwner(ownership.owner, finalOwnership.owner)) {
      return {
        removed: false,
        reason: 'Profile ownership changed during cleanup revalidation',
        revalidationFailed: true
      };
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
  const result = { removed: [], skippedActive: [], recoverable: [], failed: [] };

  let entries;
  try {
    entries = fs.readdirSync(tempDir, { withFileTypes: true });
  } catch (err) {
    result.failed.push({ path: tempDir, reason: err.message });
    return result;
  }

  let processSnapshotProvider;
  if (Object.hasOwn(options, 'processSnapshotProvider')) {
    if (typeof options.processSnapshotProvider !== 'function') {
      result.failed.push({ path: tempDir, reason: 'Process snapshot provider must be a function' });
      return result;
    }
    processSnapshotProvider = options.processSnapshotProvider;
  } else if (Object.hasOwn(options, 'processSnapshot')) {
    processSnapshotProvider = () => options.processSnapshot;
  } else {
    processSnapshotProvider = getProcessSnapshot;
  }
  const inspectProcesses = () => {
    const snapshot = processSnapshotProvider();
    if (!Array.isArray(snapshot)) throw new Error('Process snapshot provider must return an array');
    return snapshot;
  };

  let snapshot;
  try {
    snapshot = inspectProcesses();
  } catch (err) {
    result.failed.push({ path: tempDir, reason: `Could not inspect running processes: ${err.message}` });
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

    const processInspection = inspectRelatedBrowserProcesses(snapshot, profileDir);
    const ownerActive = isProfileOwnerActive(ownership.owner, snapshot);
    if (!ownerActive &&
        processInspection.processIds.size > 0 &&
        processInspection.ambiguousProcessIds.size === 0) {
      result.recoverable.push({
        profileDir,
        browserType: ownership.owner.browserType,
        createdAt: ownership.owner.createdAt,
        processIds: [...processInspection.processIds].sort((left, right) => left - right),
        proxyPort: inferLoopbackProxyPort(
          snapshot,
          processInspection.processIds,
          options.platform || process.platform
        )
      });
      result.skippedActive.push(profileDir);
      continue;
    }
    if (ownerActive || processInspection.ambiguousProcessIds.size > 0) {
      result.skippedActive.push(profileDir);
      continue;
    }

    const cleanup = removeManagedBrowserProfile(profileDir, {
      ...options,
      tempDir,
      requireOwnershipMarker: true,
      revalidateBeforeRemove: ({ path: revalidatedPath, owner }) => {
        let refreshedSnapshot;
        try {
          refreshedSnapshot = inspectProcesses();
        } catch (err) {
          return {
            safeToRemove: false,
            revalidationFailed: true,
            reason: `Could not refresh running processes: ${err.message}`
          };
        }

        const refreshedInspection = inspectRelatedBrowserProcesses(
          refreshedSnapshot,
          revalidatedPath
        );
        if (isProfileOwnerActive(owner, refreshedSnapshot) ||
            refreshedInspection.processIds.size > 0 ||
            refreshedInspection.ambiguousProcessIds.size > 0) {
          return {
            safeToRemove: false,
            active: true,
            reason: 'Profile became active before cleanup'
          };
        }
        return { safeToRemove: true };
      }
    });
    if (cleanup.removed) result.removed.push(profileDir);
    else if (cleanup.active) result.skippedActive.push(profileDir);
    else result.failed.push({ path: profileDir, reason: cleanup.reason || 'Unknown cleanup failure' });
  }

  return result;
}
