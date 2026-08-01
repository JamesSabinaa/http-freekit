import fs from 'fs';
import path from 'path';

const MAX_PROCESS_ID = 0xffffffff;
const MAX_EXECUTABLE_IDENTITY_LENGTH = 4096;

function stdoutFrom(result) {
  if (result && typeof result === 'object' && 'stdout' in result) return result.stdout;
  return result;
}

export function normalizeExecutableIdentity(executable, options = {}) {
  const {
    platform = process.platform,
    maxLength = MAX_EXECUTABLE_IDENTITY_LENGTH,
    requireAbsolute = false
  } = options;
  if (typeof executable !== 'string') {
    throw new Error('Process executable identity is missing');
  }
  const value = executable.trim();
  if (!value || value.length > maxLength || /[\0\r\n]/.test(value)) {
    throw new Error('Process executable identity is invalid');
  }

  const pathFlavor = platform === 'auto'
    ? (/^(?:[a-z]:[\\/]|\\\\)/i.test(value) ? path.win32 : path.posix)
    : platform === 'win32' ? path.win32 : path.posix;
  if (requireAbsolute && !pathFlavor.isAbsolute(value)) {
    throw new Error('Process executable identity is not absolute');
  }
  const normalized = pathFlavor.normalize(value).normalize('NFC');
  return pathFlavor === path.win32 ? normalized.toLowerCase() : normalized;
}

export function normalizeProcessIdentity(identity, expectedPid, options = {}) {
  const { platform = process.platform, includePlatform = false } = options;
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
    throw new Error('Process identity is missing or malformed');
  }
  if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0 ||
      identity.pid > MAX_PROCESS_ID || identity.pid !== expectedPid) {
    throw new Error('Process identity PID is missing, invalid, or unexpected');
  }
  const startTime = String(identity.startTime || '');
  if (!/^\d{1,32}$/.test(startTime)) {
    throw new Error('Process start identity is missing or invalid');
  }
  return Object.freeze({
    pid: identity.pid,
    startTime,
    executable: normalizeExecutableIdentity(identity.executable, {
      platform,
      maxLength: options.maxExecutableLength
    }),
    ...(includePlatform ? { platform } : {})
  });
}

export function parseLinuxProcessStart(stat, pid, options = {}) {
  const commandEnd = stat.lastIndexOf(')');
  if (!stat.startsWith(`${pid} (`) || commandEnd < 0) {
    throw new Error('Linux process metadata is ambiguous');
  }
  const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
  const startTime = fields[19];
  if (!/^\d+$/.test(startTime || '')) {
    throw new Error(options.unavailableMessage || 'Linux process start identity is unavailable');
  }
  return startTime;
}

export function probeProcessPid(pid) {
  try {
    process.kill(pid, 0);
    return 'running';
  } catch (error) {
    if (error?.code === 'EPERM') return 'running';
    if (error?.code === 'ESRCH') return 'absent';
    return 'unknown';
  }
}

export function sameProcessIdentity(left, right, options = {}) {
  return Boolean(
    left && right &&
    left.pid === right.pid &&
    left.startTime === right.startTime &&
    left.executable === right.executable &&
    (!options.includePlatform || left.platform === right.platform)
  );
}

export async function inspectLinuxProcessIdentity(pid, options = {}) {
  const procDirectory = `/proc/${pid}`;
  const parseStart = options.parseStart || parseLinuxProcessStart;
  const statBefore = await fs.promises.readFile(path.join(procDirectory, 'stat'), 'utf8');
  const startTime = parseStart(statBefore, pid);
  const executable = await fs.promises.readlink(path.join(procDirectory, 'exe'));
  const statAfter = await fs.promises.readFile(path.join(procDirectory, 'stat'), 'utf8');
  if (parseStart(statAfter, pid) !== startTime) {
    throw new Error('Process identity changed during inspection');
  }
  return { pid, startTime, executable };
}

export async function inspectDarwinProcessIdentity(pid, options = {}) {
  const result = await options.execFile(
    '/bin/ps',
    ['-ww', '-p', String(pid), '-o', 'pid=', '-o', 'lstart=', '-o', 'comm='],
    {
      timeout: options.timeoutMs,
      maxBuffer: 16 * 1024,
      windowsHide: true,
      env: { ...options.environment, LC_ALL: 'C' }
    }
  );
  const lines = String(stdoutFrom(result)).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length !== 1) throw new Error('macOS process metadata is ambiguous');
  const match = lines[0].match(/^(\d+)\s+(\S+\s+\S+\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
  if (!match || Number(match[1]) !== pid) throw new Error('macOS process metadata is invalid');
  const startTime = Date.parse(match[2]);
  if (!Number.isFinite(startTime)) throw new Error('macOS process start identity is unavailable');
  return { pid, startTime: String(startTime), executable: match[3] };
}

async function inspectWindowsProcessIdentity(pid, options = {}) {
  const script = [
    `$target = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction Stop | Select-Object -First 1`,
    "if ($null -eq $target) { [Console]::Out.Write('null'); exit 0 }",
    '$identity = [PSCustomObject]@{',
    '  pid = [int]$target.ProcessId',
    "  startTime = [string]([DateTime]$target.CreationDate).ToUniversalTime().Ticks",
    '  executable = [string]$target.ExecutablePath',
    '}',
    '[Console]::Out.Write(($identity | ConvertTo-Json -Compress))'
  ].join('\n');
  const result = await options.execFile(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    {
      encoding: 'utf8',
      timeout: options.timeoutMs,
      maxBuffer: 16 * 1024,
      windowsHide: true
    }
  );
  const serialized = String(stdoutFrom(result)).trim();
  if (!serialized) throw new Error('Windows process identity query returned no result');
  const identity = JSON.parse(serialized);
  if (identity === null) {
    const error = new Error(options.absentMessage || 'Process is absent');
    error.code = 'ESRCH';
    throw error;
  }
  return identity;
}

export async function inspectProcessIdentity(pid, options = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > MAX_PROCESS_ID) {
    return {
      state: 'unknown',
      ...(options.includeInvalidPidError === false
        ? {}
        : { error: new Error('Process ID is invalid') })
    };
  }

  try {
    const platform = options.platform || process.platform;
    const identity = platform === 'win32'
      ? await inspectWindowsProcessIdentity(pid, options)
      : platform === 'darwin'
        ? await inspectDarwinProcessIdentity(pid, options)
        : await inspectLinuxProcessIdentity(pid, options);
    return {
      state: 'running',
      identity: options.normalizeIdentity ? options.normalizeIdentity(identity) : identity
    };
  } catch (error) {
    const state = (options.probePid || probeProcessPid)(pid);
    return state === 'absent' ? { state } : { state: 'unknown', error };
  }
}
