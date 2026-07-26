import { execFile, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  NODE_ENV_PROXY_SUPPORT_NOTE,
  NODE_USE_ENV_PROXY_VALUE
} from './node-environment-proxy.js';

const LINUX_TERMINAL_LAUNCHERS = [
  {
    command: 'gnome-terminal',
    buildArgs: shellCommand => ['--wait', '--', 'sh', '-c', shellCommand]
  },
  {
    command: 'xterm',
    buildArgs: shellCommand => ['-e', 'sh', '-c', shellCommand]
  },
  {
    command: 'konsole',
    buildArgs: shellCommand => ['--separate', '--nofork', '-e', 'sh', '-c', shellCommand]
  }
];

function spawnDetached(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    const onSpawn = () => {
      child.removeListener('error', onError);
      resolve(child);
    };
    const onError = (err) => {
      child.removeListener('spawn', onSpawn);
      reject(err);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

function isProcessRunning(proc) {
  return proc && !proc.killed && proc.exitCode === null && proc.signalCode === null;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function powerShellQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function cmdSet(variable, value) {
  return `set "${variable}=${String(value)}"`;
}

function getTerminalCaPath(ca) {
  if (!ca) return '';
  if (typeof ca.getTerminalCaBundlePath === 'function') {
    return ca.getTerminalCaBundlePath();
  }
  const certInfo = ca.getCertInfo();
  return certInfo.terminalCaBundlePath || certInfo.certificatePath || '';
}

function buildTerminalEnvironment(proxyUrl, certPath) {
  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: '',
    no_proxy: '',
    NODE_USE_ENV_PROXY: NODE_USE_ENV_PROXY_VALUE,
    SSL_CERT_FILE: certPath,
    NODE_EXTRA_CA_CERTS: certPath,
    REQUESTS_CA_BUNDLE: certPath,
    CURL_CA_BUNDLE: certPath
  };
}

export function buildExistingTerminalInstructions(proxyUrl, certPath) {
  const environment = Object.entries(buildTerminalEnvironment(proxyUrl, certPath));
  return {
    bash: `unset NODE_TLS_REJECT_UNAUTHORIZED; export ${environment.map(([name, value]) => `${name}=${shellQuote(value)}`).join(' ')}`,
    powershell: [
      'Remove-Item Env:NODE_TLS_REJECT_UNAUTHORIZED -ErrorAction SilentlyContinue',
      ...environment.map(([name, value]) => `$env:${name}=${powerShellQuote(value)}`)
    ].join('; '),
    cmd: [cmdSet('NODE_TLS_REJECT_UNAUTHORIZED', ''), ...environment.map(([name, value]) => cmdSet(name, value))].join('&& ')
  };
}

export class FreshTerminalInterceptor {
  constructor() {
    this.id = 'fresh-terminal';
    this.name = 'Fresh Terminal';
    this.active = false;
    this.processes = [];
    this.sessions = new Map();
    this.ca = null;
    this.onStatusChange = null;
    this.statusMonitor = null;
  }

  _platform() {
    return process.platform;
  }

  _environment() {
    return process.env;
  }

  _workingDirectory() {
    return process.cwd();
  }

  _linuxTerminalLaunchers() {
    return LINUX_TERMINAL_LAUNCHERS;
  }

  async _isExecutablePath(executablePath) {
    try {
      const stats = await fs.promises.stat(executablePath);
      if (!stats.isFile()) return false;
      await fs.promises.access(executablePath, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  async _resolveLinuxLauncher(command) {
    const environment = this._environment();
    // Node uses /usr/bin:/bin to resolve commands on Unix when PATH is absent.
    const pathValue = environment.PATH == null ? '/usr/bin:/bin' : String(environment.PATH);
    for (const directory of pathValue.split(path.posix.delimiter)) {
      const executablePath = path.posix.resolve(
        this._workingDirectory(),
        directory || '.',
        command
      );
      if (await this._isExecutablePath(executablePath)) return executablePath;
    }
    return null;
  }

  async _availableLinuxTerminalLaunchers() {
    const launchers = this._linuxTerminalLaunchers();
    const resolvedPaths = await Promise.all(
      launchers.map(launcher => this._resolveLinuxLauncher(launcher.command))
    );
    return launchers.filter((launcher, index) => resolvedPaths[index] !== null);
  }

  _spawnDetached(command, args, options) {
    return spawnDetached(command, args, options);
  }

  _launcherStartupGraceMs() {
    return 100;
  }

  _confirmLauncherStartup(proc, graceMs = this._launcherStartupGraceMs()) {
    const failure = (code, signal) => {
      const detail = signal ? `signal ${signal}` : `exit code ${code}`;
      return new Error(`Terminal launcher failed during startup (${detail})`);
    };

    if (proc.signalCode !== null) {
      return Promise.reject(failure(proc.exitCode, proc.signalCode));
    }
    if (proc.exitCode !== null) {
      return proc.exitCode === 0
        ? Promise.resolve()
        : Promise.reject(failure(proc.exitCode, null));
    }

    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        proc.removeListener('exit', onExit);
        proc.removeListener('error', onError);
      };
      const finish = (callback, value) => {
        cleanup();
        callback(value);
      };
      const onExit = (code, signal) => {
        if (code === 0 && !signal) {
          finish(resolve);
        } else {
          finish(reject, failure(code, signal));
        }
      };
      const onError = (err) => finish(reject, err);

      proc.once('exit', onExit);
      proc.once('error', onError);
      timer = setTimeout(() => finish(resolve), graceMs);
    });
  }

  _createPidFilePath() {
    return path.join(os.tmpdir(), `http-freekit-terminal-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.pid`);
  }

  async _waitForShellPid(pidFile, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
        if (Number.isInteger(pid) && pid > 0) return pid;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Terminal shell did not report its process ID');
  }

  _probeSessionPid(pid) {
    try {
      process.kill(pid, 0);
      return 'running';
    } catch (err) {
      if (err?.code === 'EPERM') return 'running';
      if (err?.code === 'ESRCH') return 'absent';
      return 'unknown';
    }
  }

  _identityInspectionTimeoutMs() {
    return 1000;
  }

  _execFile(command, args, options) {
    return new Promise((resolve, reject) => {
      execFile(command, args, options, (err, stdout, stderr) => {
        if (err) {
          err.stderr = stderr;
          reject(err);
        } else {
          resolve({ stdout, stderr });
        }
      });
    });
  }

  _normalizeExecutableIdentity(executable) {
    const value = String(executable || '').trim();
    if (!value) throw new Error('Process executable identity is empty');
    const platformPath = this._platform() === 'win32' ? path.win32 : path.posix;
    return platformPath.normalize(value).normalize('NFC');
  }

  _parseLinuxProcessStart(stat, pid) {
    const commandEnd = stat.lastIndexOf(')');
    if (!stat.startsWith(`${pid} (`) || commandEnd < 0) {
      throw new Error('Linux process metadata is ambiguous');
    }
    const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
    const startTime = fields[19];
    if (!/^\d+$/.test(startTime || '')) {
      throw new Error('Linux process start time is unavailable');
    }
    return startTime;
  }

  async _inspectLinuxSessionIdentity(pid) {
    const procDirectory = `/proc/${pid}`;
    const statBefore = await fs.promises.readFile(path.join(procDirectory, 'stat'), 'utf8');
    const startTime = this._parseLinuxProcessStart(statBefore, pid);
    const executable = await fs.promises.readlink(path.join(procDirectory, 'exe'));
    const statAfter = await fs.promises.readFile(path.join(procDirectory, 'stat'), 'utf8');
    if (this._parseLinuxProcessStart(statAfter, pid) !== startTime) {
      throw new Error('Process identity changed during inspection');
    }
    return {
      pid,
      startTime,
      executable: this._normalizeExecutableIdentity(executable)
    };
  }

  async _inspectDarwinSessionIdentity(pid) {
    const { stdout } = await this._execFile(
      '/bin/ps',
      ['-ww', '-p', String(pid), '-o', 'pid=', '-o', 'lstart=', '-o', 'comm='],
      {
        timeout: this._identityInspectionTimeoutMs(),
        maxBuffer: 16 * 1024,
        windowsHide: true,
        env: { ...this._environment(), LC_ALL: 'C' }
      }
    );
    const lines = String(stdout).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (lines.length !== 1) throw new Error('macOS process metadata is ambiguous');
    const match = lines[0].match(/^(\d+)\s+(\S+\s+\S+\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
    if (!match || Number(match[1]) !== pid) throw new Error('macOS process metadata is invalid');
    const startTime = Date.parse(match[2]);
    if (!Number.isFinite(startTime)) throw new Error('macOS process start time is unavailable');
    return {
      pid,
      startTime: String(startTime),
      executable: this._normalizeExecutableIdentity(match[3])
    };
  }

  async _inspectSessionIdentity(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return { state: 'unknown' };
    try {
      const identity = this._platform() === 'darwin'
        ? await this._inspectDarwinSessionIdentity(pid)
        : await this._inspectLinuxSessionIdentity(pid);
      return { state: 'running', identity };
    } catch (error) {
      const state = this._probeSessionPid(pid);
      return state === 'absent' ? { state } : { state: 'unknown', error };
    }
  }

  async _observeSessionIdentity(pid) {
    try {
      return await this._inspectSessionIdentity(pid);
    } catch (error) {
      return { state: 'unknown', error };
    }
  }

  _isSameSession(expected, observation) {
    const actual = observation?.state === 'running' ? observation.identity : null;
    return Boolean(
      expected?.startTime &&
      expected?.executable &&
      actual &&
      actual.pid === expected.pid &&
      actual.startTime === expected.startTime &&
      actual.executable === expected.executable
    );
  }

  async _adoptSession(pid) {
    const observation = await this._observeSessionIdentity(pid);
    const identity = observation?.state === 'running' ? observation.identity : null;
    if (
      !identity ||
      identity.pid !== pid ||
      !identity.startTime ||
      !identity.executable
    ) return null;
    return Object.freeze({ ...identity });
  }

  _killSession(pid) {
    process.kill(pid, 'SIGTERM');
  }

  async _refreshActiveState(reason = 'exited', extra = {}) {
    const wasActive = this.active;
    for (const [pid, identity] of [...this.sessions]) {
      const observation = await this._observeSessionIdentity(pid);
      if (!this._isSameSession(identity, observation) && this.sessions.get(pid) === identity) {
        this.sessions.delete(pid);
      }
    }
    this.active = this.sessions.size > 0 || this.processes.some(isProcessRunning);
    if (wasActive && !this.active) {
      this._stopStatusMonitor();
      this._emitStatus(reason, extra);
    }
    return this.active;
  }

  _startStatusMonitor() {
    this._stopStatusMonitor();
    this.statusMonitor = setInterval(() => { void this._refreshActiveState(); }, 1000);
    this.statusMonitor.unref?.();
  }

  _stopStatusMonitor() {
    if (this.statusMonitor) {
      clearInterval(this.statusMonitor);
      this.statusMonitor = null;
    }
  }

  _buildPosixShellCommand(proxyUrl, certPath, pidFile) {
    return [
      `printf '%s' "$$" > ${shellQuote(pidFile)}`,
      ...Object.entries(buildTerminalEnvironment(proxyUrl, certPath))
        .map(([name, value]) => `export ${name}=${shellQuote(value)}`),
      `echo ${shellQuote(`HTTP FreeKit proxy active on ${proxyUrl}`)}`,
      'exec "${SHELL:-/bin/sh}" -l'
    ].join('; ');
  }

  async _launchTrackedPosixTerminal(command, args, env, pidFile) {
    const proc = await this._spawnDetached(command, args, { detached: true, stdio: 'ignore', env });
    try {
      await this._confirmLauncherStartup(proc);
      proc.unref();
      const shellPid = await this._waitForShellPid(pidFile);
      return { proc, shellPid };
    } catch (err) {
      try { proc.kill(); } catch {}
      throw err;
    } finally {
      try { fs.unlinkSync(pidFile); } catch {}
    }
  }

  async isActivable() {
    const platform = this._platform();
    if (platform === 'win32' || platform === 'darwin') return true;
    return (await this._availableLinuxTerminalLaunchers()).length > 0;
  }

  async isActive() {
    return await this._refreshActiveState();
  }

  async activate(proxyPort) {
    const certPath = getTerminalCaPath(this.ca);
    const proxyUrl = `http://127.0.0.1:${proxyPort}`;

    const env = {
      ...this._environment(),
      ...buildTerminalEnvironment(proxyUrl, certPath)
    };
    delete env.NODE_TLS_REJECT_UNAUTHORIZED;

    let proc;
    const platform = this._platform();
    let shellPid = null;

    if (platform === 'win32') {
      // Open Windows Terminal, PowerShell, or cmd
      const terminals = [
        { cmd: 'wt.exe', args: ['new-tab', '--inheritEnvironment'] },
        { cmd: 'powershell.exe', args: ['-NoExit', '-Command', `Write-Host "HTTP FreeKit proxy active on ${proxyUrl}" -ForegroundColor Green`] },
        { cmd: 'cmd.exe', args: ['/K', `echo HTTP FreeKit proxy active on ${proxyUrl}`] },
      ];

      for (const terminal of terminals) {
        let candidateProc;
        try {
          candidateProc = await this._spawnDetached(terminal.cmd, terminal.args, {
            detached: true,
            stdio: 'ignore',
            env
          });
          await this._confirmLauncherStartup(candidateProc);
          proc = candidateProc;
          proc.unref();
          break;
        } catch {
          try { candidateProc?.kill(); } catch {}
          continue;
        }
      }
    } else if (platform === 'darwin') {
      // macOS: open Terminal.app
      const pidFile = this._createPidFilePath();
      const shellCommand = this._buildPosixShellCommand(proxyUrl, certPath, pidFile);
      const escapedCommand = shellCommand.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const script = `tell application "Terminal" to do script "${escapedCommand}"`;
      ({ proc, shellPid } = await this._launchTrackedPosixTerminal('osascript', ['-e', script], env, pidFile));
    } else {
      // Linux: try common terminals
      for (const terminal of this._linuxTerminalLaunchers()) {
        const pidFile = this._createPidFilePath();
        const shellCommand = this._buildPosixShellCommand(proxyUrl, certPath, pidFile);
        const args = terminal.buildArgs(shellCommand);
        try {
          ({ proc, shellPid } = await this._launchTrackedPosixTerminal(
            terminal.command,
            args,
            env,
            pidFile
          ));
          break;
        } catch {
          continue;
        }
      }
    }

    if (!proc) {
      throw new Error('No supported terminal found');
    }

    const sessionIdentity = shellPid ? await this._adoptSession(shellPid) : null;
    this.processes.push(proc);
    if (sessionIdentity) this.sessions.set(sessionIdentity.pid, sessionIdentity);
    this.active = this.sessions.size > 0 || this.processes.some(isProcessRunning);
    this._emitStatus('active');
    if (this.active) this._startStatusMonitor();

    proc.on('exit', () => {
      this.processes = this.processes.filter(p => p !== proc);
      void this._refreshActiveState('exited', { pid: sessionIdentity?.pid || proc.pid });
    });

    proc.on('error', (err) => {
      console.error('[Interceptor] Fresh terminal error:', err.message);
      this.processes = this.processes.filter(p => p !== proc);
      void this._refreshActiveState('error', { pid: sessionIdentity?.pid || proc.pid, error: err.message });
    });

    console.log(`[Interceptor] Fresh terminal opened with proxy ${proxyUrl}`);
    return { success: true, pid: sessionIdentity?.pid || proc.pid };
  }

  async deactivate() {
    this._stopStatusMonitor();
    for (const [pid, identity] of this.sessions) {
      const observation = await this._observeSessionIdentity(pid);
      if (!this._isSameSession(identity, observation)) continue;
      try { this._killSession(pid); } catch {}
    }
    for (const proc of this.processes) {
      try { proc.kill(); } catch {}
    }
    this.sessions.clear();
    this.processes = [];
    this.active = false;
    this._emitStatus('inactive');
  }

  _emitStatus(reason, extra = {}) {
    if (typeof this.onStatusChange !== 'function') return;
    const sessionPid = this.sessions.keys().next().value;
    this.onStatusChange({
      id: this.id,
      name: this.name,
      type: 'terminal',
      active: this.active,
      pid: sessionPid || this.processes[0]?.pid || null,
      reason,
      ...extra
    });
  }

  toJSON() {
    const sessionPid = this.sessions.keys().next().value;
    return {
      id: this.id,
      name: this.name,
      type: 'terminal',
      active: this.active,
      pid: sessionPid || this.processes[0]?.pid || null
    };
  }
}

export class ExistingTerminalInterceptor {
  constructor() {
    this.id = 'existing-terminal';
    this.name = 'Existing Terminal';
    this.active = false;
    this.ca = null;
    this.proxyPort = null;
  }

  async isActivable() {
    return true;
  }

  async isActive() {
    return false;
  }

  async activate(proxyPort) {
    this.proxyPort = proxyPort;
    this.active = false;
    const certPath = getTerminalCaPath(this.ca);
    const proxyUrl = `http://127.0.0.1:${proxyPort}`;

    console.log(`[Interceptor] Existing terminal interceptor activated — users should set proxy env vars`);

    // Return the setup instructions as metadata
    return {
      success: true,
      metadata: {
        instructionsOnly: true,
        lifecycleNote: 'These variables remain active in the terminal until you unset them or close that shell.',
        nodeProxyNote: NODE_ENV_PROXY_SUPPORT_NOTE,
        proxyUrl,
        certPath,
        instructions: buildExistingTerminalInstructions(proxyUrl, certPath)
      }
    };
  }

  async deactivate() {
    this.active = false;
    this.proxyPort = null;
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      type: 'terminal',
      active: false,
      pid: null
    };
  }
}
