import { spawn, execSync } from 'child_process';

export class DockerInterceptor {
  constructor() {
    this.id = 'docker';
    this.name = 'Docker Container';
    this.active = false;
    this.ca = null;
    this.interceptedContainers = new Set();
  }

  async isActivable() {
    try {
      execSync('docker version', { stdio: 'ignore', timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }

  async isActive() {
    return this.active && this.interceptedContainers.size > 0;
  }

  async activate(proxyPort, options = {}) {
    // Get host IP that Docker containers can reach
    let hostIp = '172.17.0.1'; // Default Docker bridge gateway
    try {
      const result = execSync('docker network inspect bridge --format "{{(index .IPAM.Config 0).Gateway}}"', { encoding: 'utf8', timeout: 5000 }).trim();
      if (result) hostIp = result.replace(/"/g, '');
    } catch {}

    // If a specific container is specified, set its env vars
    if (options.containerId) {
      // We can't modify env vars of a running container, but we can restart it with proxy settings
      // For now, just record that we want to intercept it
      this.interceptedContainers.add(options.containerId);
    }

    this.active = true;
    const proxyUrl = `http://${hostIp}:${proxyPort}`;

    console.log(`[Interceptor] Docker interceptor active. Proxy: ${proxyUrl}`);
    console.log(`[Interceptor] Run containers with: docker run -e HTTP_PROXY=${proxyUrl} -e HTTPS_PROXY=${proxyUrl} <image>`);

    return {
      success: true,
      metadata: {
        proxyUrl,
        hostIp,
        instructions: {
          run: `docker run -e HTTP_PROXY=${proxyUrl} -e HTTPS_PROXY=${proxyUrl} -e NODE_TLS_REJECT_UNAUTHORIZED=0 <image>`,
          compose: `environment:\n  - HTTP_PROXY=${proxyUrl}\n  - HTTPS_PROXY=${proxyUrl}\n  - NODE_TLS_REJECT_UNAUTHORIZED=0`
        }
      }
    };
  }

  async deactivate() {
    this.interceptedContainers.clear();
    this.active = false;
    console.log('[Interceptor] Docker interceptor deactivated');
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      type: 'docker',
      active: this.active,
      pid: null
    };
  }
}
