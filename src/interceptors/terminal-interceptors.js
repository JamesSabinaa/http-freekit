import { spawn } from 'child_process';

export class FreshTerminalInterceptor {
  constructor() {
    this.id = 'fresh-terminal';
    this.name = 'Fresh Terminal';
    this.active = false;
    this.processes = [];
    this.ca = null;
  }

  async isActivable() {
    return true; // Terminals are always available
  }

  async isActive() {
    return this.processes.some(p => !p.killed);
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
    const platform = process.platform;

    if (platform === 'win32') {
      // Open Windows Terminal, PowerShell, or cmd
      const terminals = [
        { cmd: 'wt.exe', args: ['new-tab'] },
        { cmd: 'powershell.exe', args: ['-NoExit', '-Command', `Write-Host "HTTP FreeKit proxy active on ${proxyUrl}" -ForegroundColor Green`] },
        { cmd: 'cmd.exe', args: ['/K', `echo HTTP FreeKit proxy active on ${proxyUrl}`] },
      ];

      for (const terminal of terminals) {
        try {
          proc = spawn(terminal.cmd, terminal.args, {
            detached: true,
            stdio: 'ignore',
            env
          });
          proc.unref();
          break;
        } catch {
          continue;
        }
      }
    } else if (platform === 'darwin') {
      // macOS: open Terminal.app
      const script = `tell application "Terminal" to do script "export HTTP_PROXY=${proxyUrl} HTTPS_PROXY=${proxyUrl} NODE_EXTRA_CA_CERTS='${certPath}' NODE_TLS_REJECT_UNAUTHORIZED=0; echo 'HTTP FreeKit proxy active'"`;
      proc = spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore', env });
      proc.unref();
    } else {
      // Linux: try common terminals
      const terminals = [
        { cmd: 'gnome-terminal', args: ['--'] },
        { cmd: 'xterm', args: ['-e', 'bash'] },
        { cmd: 'konsole', args: [] },
      ];

      for (const terminal of terminals) {
        try {
          proc = spawn(terminal.cmd, terminal.args, { detached: true, stdio: 'ignore', env });
          proc.unref();
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
    this.active = true;

    proc.on('exit', () => {
      this.processes = this.processes.filter(p => !p.killed);
      if (this.processes.length === 0) this.active = false;
    });

    console.log(`[Interceptor] Fresh terminal opened with proxy ${proxyUrl}`);
    return { success: true, pid: proc.pid };
  }

  async deactivate() {
    for (const proc of this.processes) {
      try { proc.kill(); } catch {}
    }
    this.processes = [];
    this.active = false;
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      type: 'terminal',
      active: this.active,
      pid: this.processes[0]?.pid || null
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
    return this.active;
  }

  async activate(proxyPort) {
    this.proxyPort = proxyPort;
    this.active = true;
    const certPath = this.ca ? this.ca.getCertInfo().certificatePath : '';
    const proxyUrl = `http://127.0.0.1:${proxyPort}`;

    console.log(`[Interceptor] Existing terminal interceptor activated — users should set proxy env vars`);

    // Return the setup instructions as metadata
    return {
      success: true,
      metadata: {
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
      active: this.active,
      pid: null
    };
  }
}
