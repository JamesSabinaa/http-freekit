import { execSync } from 'child_process';

export class SystemProxyInterceptor {
  constructor() {
    this.id = 'system-proxy';
    this.name = 'System Proxy';
    this.active = false;
    this.previousSettings = null;
  }

  async isActivable() {
    return process.platform === 'win32';
  }

  async isActive() {
    return this.active;
  }

  async activate(proxyPort) {
    if (process.platform === 'win32') {
      try {
        execSync(`reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 1 /f`, { stdio: 'ignore' });
        execSync(`reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer /t REG_SZ /d "127.0.0.1:${proxyPort}" /f`, { stdio: 'ignore' });
        this.active = true;
        console.log(`[Interceptor] System proxy set to 127.0.0.1:${proxyPort}`);
        return { success: true };
      } catch (err) {
        throw new Error(`Failed to set system proxy: ${err.message}`);
      }
    }
    throw new Error('System proxy interception not supported on this platform');
  }

  async deactivate() {
    if (process.platform === 'win32') {
      try {
        execSync(`reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f`, { stdio: 'ignore' });
        this.active = false;
        console.log('[Interceptor] System proxy disabled');
      } catch (err) {
        console.error('[Interceptor] Failed to disable system proxy:', err.message);
      }
    }
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      type: 'system',
      active: this.active
    };
  }
}
