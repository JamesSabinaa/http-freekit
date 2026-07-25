import { execSync } from 'child_process';

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

  _platform() {
    return process.platform;
  }

  _exec(command, options) {
    return execSync(command, options);
  }

  _getDockerHost() {
    if (this._platform() === 'win32' || this._platform() === 'darwin') {
      return 'host.docker.internal';
    }

    let host = '172.17.0.1';
    try {
      const result = this._exec(
        'docker network inspect bridge --format "{{(index .IPAM.Config 0).Gateway}}"',
        { encoding: 'utf8', timeout: 5000 }
      ).trim();
      if (result) host = result.replace(/"/g, '');
    } catch {}
    return host;
  }

  async activate(proxyPort, options = {}) {
    // Get host IP that Docker containers can reach
    const hostIp = this._getDockerHost();

    const proxyUrl = `http://${hostIp}:${proxyPort}`;
    const certPath = this.ca?.getCertInfo?.()?.certificatePath;
    if (!certPath) {
      throw new Error('FreeKit CA certificate is not available for Docker HTTPS interception');
    }
    const containerCertPath = '/etc/http-freekit/ca.pem';
    const certMount = `--mount type=bind,source="${String(certPath).replace(/"/g, '\\"')}",target=${containerCertPath},readonly`;
    const trustEnvironment = [
      `SSL_CERT_FILE=${containerCertPath}`,
      `REQUESTS_CA_BUNDLE=${containerCertPath}`,
      `CURL_CA_BUNDLE=${containerCertPath}`,
      `NODE_EXTRA_CA_CERTS=${containerCertPath}`
    ];
    const runEnvironment = trustEnvironment.map(value => `-e ${value}`).join(' ');
    const composeEnvironment = trustEnvironment.map(value => `  - ${value}`).join('\n');
    const composeMount = JSON.stringify(`${certPath}:${containerCertPath}:ro`);
    const runInstruction = `docker run ${certMount} -e HTTP_PROXY=${proxyUrl} -e HTTPS_PROXY=${proxyUrl} ${runEnvironment} <image>`;
    const composeInstruction = `volumes:\n  - ${composeMount}\nenvironment:\n  - HTTP_PROXY=${proxyUrl}\n  - HTTPS_PROXY=${proxyUrl}\n${composeEnvironment}`;
    // Running container environments cannot be changed, but retain the selected
    // container so the UI can represent the requested interception state.
    if (options.containerId) this.interceptedContainers.add(options.containerId);
    this.active = true;

    console.log(`[Interceptor] Docker interceptor active. Proxy: ${proxyUrl}`);
    console.log(`[Interceptor] Run containers with: ${runInstruction}`);

    return {
      success: true,
      metadata: {
        proxyUrl,
        hostIp,
        caPath: certPath,
        containerCaPath: containerCertPath,
        instructions: {
          run: runInstruction,
          compose: composeInstruction
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
