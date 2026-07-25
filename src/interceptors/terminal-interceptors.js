import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

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

export class FreshTerminalInterceptor {
  constructor() {
    this.id = 'fresh-terminal';
    this.name = 'Fresh Terminal';
    this.active = false;
    this.processes = [];
    this.sessionPids = new Set();
    this.ca = null;
    this.onStatusChange = null;
    this.statusMonitor = null;
  }

  _platform() {
    return process.platform;
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

  _isSessionRunning(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  _killSession(pid) {
    process.kill(pid, 'SIGTERM');
  }

  _refreshActiveState(reason = 'exited', extra = {}) {
    const wasActive = this.active;
    for (const pid of this.sessionPids) {
      if (!this._isSessionRunning(pid)) this.sessionPids.delete(pid);
    }
    this.active = this.sessionPids.size > 0 || this.processes.some(isProcessRunning);
    if (wasActive && !this.active) {
      this._stopStatusMonitor();
      this._emitStatus(reason, extra);
    }
    return this.active;
  }

  _startStatusMonitor() {
    this._stopStatusMonitor();
    this.statusMonitor = setInterval(() => this._refreshActiveState(), 1000);
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
      `export HTTP_PROXY=${shellQuote(proxyUrl)}`,
      `export HTTPS_PROXY=${shellQuote(proxyUrl)}`,
      `export http_proxy=${shellQuote(proxyUrl)}`,
      `export https_proxy=${shellQuote(proxyUrl)}`,
      `export SSL_CERT_FILE=${shellQuote(certPath)}`,
      `export NODE_EXTRA_CA_CERTS=${shellQuote(certPath)}`,
      `export REQUESTS_CA_BUNDLE=${shellQuote(certPath)}`,
      `export CURL_CA_BUNDLE=${shellQuote(certPath)}`,
      'export NODE_TLS_REJECT_UNAUTHORIZED=0',
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
    return true; // Terminals are always available
  }

  async isActive() {
    return this._refreshActiveState();
  }

  async activate(proxyPort) {
    const certPath = this.ca ? this.ca.getCertInfo().certificatePath : '';
    const proxyUrl = `http://127.0.0.1:${proxyPort}`;

    const env = {
      ...process.env,
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      SSL_CERT_FILE: certPath,
      NODE_EXTRA_CA_CERTS: certPath,
      REQUESTS_CA_BUNDLE: certPath,
      CURL_CA_BUNDLE: certPath,
      // Disable strict SSL in common tools
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
    };

    let proc;
    const platform = this._platform();
    let shellPid = null;

    if (platform === 'win32') {
      // Open Windows Terminal, PowerShell, or cmd
      const terminals = [
        { cmd: 'wt.exe', args: ['new-tab'] },
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
      const terminals = ['gnome-terminal', 'xterm', 'konsole'];

      for (const terminal of terminals) {
        const pidFile = this._createPidFilePath();
        const shellCommand = this._buildPosixShellCommand(proxyUrl, certPath, pidFile);
        const args = terminal === 'gnome-terminal'
          ? ['--wait', '--', 'sh', '-c', shellCommand]
          : terminal === 'xterm'
            ? ['-e', 'sh', '-c', shellCommand]
            : ['--separate', '--nofork', '-e', 'sh', '-c', shellCommand];
        try {
          ({ proc, shellPid } = await this._launchTrackedPosixTerminal(terminal, args, env, pidFile));
          break;
        } catch {
          continue;
        }
      }
    }

    if (!proc) {
      throw new Error('No supported terminal found');
    }

    this.processes.push(proc);
    if (shellPid) this.sessionPids.add(shellPid);
    this.active = true;
    this._emitStatus('active');
    this._startStatusMonitor();

    proc.on('exit', () => {
      this.processes = this.processes.filter(p => p !== proc);
      this._refreshActiveState('exited', { pid: shellPid || proc.pid });
    });

    proc.on('error', (err) => {
      console.error('[Interceptor] Fresh terminal error:', err.message);
      this.processes = this.processes.filter(p => p !== proc);
      this._refreshActiveState('error', { pid: shellPid || proc.pid, error: err.message });
    });

    console.log(`[Interceptor] Fresh terminal opened with proxy ${proxyUrl}`);
    return { success: true, pid: shellPid || proc.pid };
  }

  async deactivate() {
    this._stopStatusMonitor();
    for (const pid of this.sessionPids) {
      try { this._killSession(pid); } catch {}
    }
    for (const proc of this.processes) {
      try { proc.kill(); } catch {}
    }
    this.sessionPids.clear();
    this.processes = [];
    this.active = false;
    this._emitStatus('inactive');
  }

  _emitStatus(reason, extra = {}) {
    if (typeof this.onStatusChange !== 'function') return;
    const sessionPid = this.sessionPids.values().next().value;
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
    const sessionPid = this.sessionPids.values().next().value;
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
    const certPath = this.ca ? this.ca.getCertInfo().certificatePath : '';
    const proxyUrl = `http://127.0.0.1:${proxyPort}`;

    console.log(`[Interceptor] Existing terminal interceptor activated — users should set proxy env vars`);

    // Return the setup instructions as metadata
    return {
      success: true,
      metadata: {
        instructionsOnly: true,
        lifecycleNote: 'These variables remain active in the terminal until you unset them or close that shell.',
        proxyUrl,
        certPath,
        instructions: {
          bash: `export HTTP_PROXY=${proxyUrl} HTTPS_PROXY=${proxyUrl} NODE_EXTRA_CA_CERTS="${certPath}" NODE_TLS_REJECT_UNAUTHORIZED=0`,
          powershell: `$env:HTTP_PROXY="${proxyUrl}"; $env:HTTPS_PROXY="${proxyUrl}"; $env:NODE_EXTRA_CA_CERTS="${certPath}"; $env:NODE_TLS_REJECT_UNAUTHORIZED="0"`,
          cmd: `set HTTP_PROXY=${proxyUrl}&& set HTTPS_PROXY=${proxyUrl}&& set NODE_EXTRA_CA_CERTS=${certPath}&& set NODE_TLS_REJECT_UNAUTHORIZED=0`,
        }
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
