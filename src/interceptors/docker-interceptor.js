import fs from 'node:fs';
import { execFileAsync } from './command-runner.js';
import {
  NODE_ENV_PROXY_SUPPORT_NOTE,
  NODE_USE_ENV_PROXY_VALUE
} from './node-environment-proxy.js';

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
      await this._exec(['version'], { timeout: 3000 });
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

  _exec(args, options) {
    return execFileAsync('docker', args, options);
  }

  async _getDockerHost() {
    if (this._platform() === 'win32' || this._platform() === 'darwin') {
      return 'host.docker.internal';
    }

    let host = '172.17.0.1';
    try {
      const result = (await this._exec(
        ['network', 'inspect', 'bridge', '--format', '{{(index .IPAM.Config 0).Gateway}}'],
        { encoding: 'utf8', timeout: 5000 }
      )).trim();
      if (result) host = result.replace(/"/g, '');
    } catch {}
    return host;
  }

  _getCombinedCaBundlePath() {
    try {
      if (typeof this.ca?.getTerminalCaBundlePath !== 'function') {
        throw new Error('the combined public and FreeKit CA bundle is not configured');
      }
      const bundlePath = this.ca.getTerminalCaBundlePath();
      if (typeof bundlePath !== 'string' || !bundlePath.trim()) {
        throw new Error('the combined public and FreeKit CA bundle path is empty');
      }
      const stats = fs.statSync(bundlePath);
      if (!stats.isFile()) {
        throw new Error('the combined public and FreeKit CA bundle is not a file');
      }
      fs.accessSync(bundlePath, fs.constants.R_OK);
      if (!fs.readFileSync(bundlePath, 'utf8').trim()) {
        throw new Error('the combined public and FreeKit CA bundle is empty');
      }
      return bundlePath;
    } catch (error) {
      throw new Error(`Combined public and FreeKit CA bundle is unavailable for Docker HTTPS interception: ${error.message}`);
    }
  }

  async activate(proxyPort, options = {}) {
    if (options.containerId) {
      throw new Error(
        'Running Docker containers cannot have proxy or CA environment added; recreate the container with the generated settings'
      );
    }

    // Get host IP that Docker containers can reach
    const hostIp = await this._getDockerHost();

    const proxyUrl = `http://${hostIp}:${proxyPort}`;
    const caBundlePath = this._getCombinedCaBundlePath();
    const containerCaBundlePath = '/etc/http-freekit/ca-bundle.pem';
    const certMount = `--mount type=bind,source="${String(caBundlePath).replace(/"/g, '\\"')}",target=${containerCaBundlePath},readonly`;
    const trustEnvironment = [
      `SSL_CERT_FILE=${containerCaBundlePath}`,
      `REQUESTS_CA_BUNDLE=${containerCaBundlePath}`,
      `CURL_CA_BUNDLE=${containerCaBundlePath}`,
      `NODE_EXTRA_CA_CERTS=${containerCaBundlePath}`,
      `NODE_USE_ENV_PROXY=${NODE_USE_ENV_PROXY_VALUE}`
    ];
    const proxyEnvironment = [
      `HTTP_PROXY=${proxyUrl}`,
      `HTTPS_PROXY=${proxyUrl}`,
      `http_proxy=${proxyUrl}`,
      `https_proxy=${proxyUrl}`,
      'NO_PROXY='
    ];
    const environment = [...proxyEnvironment, ...trustEnvironment];
    const runEnvironment = environment.map(value => `-e ${value}`).join(' ');
    const composeEnvironment = environment.map(value => `  - ${value}`).join('\n');
    const composeMount = JSON.stringify(`${caBundlePath}:${containerCaBundlePath}:ro`);
    const runInstruction = `docker run ${certMount} ${runEnvironment} <image>`;
    const composeInstruction = `volumes:\n  - ${composeMount}\nenvironment:\n${composeEnvironment}`;
    this.active = true;

    console.log(`[Interceptor] Docker interceptor active. Proxy: ${proxyUrl}`);
    console.log(`[Interceptor] Run containers with: ${runInstruction}`);

    return {
      success: true,
      metadata: {
        proxyUrl,
        hostIp,
        caPath: caBundlePath,
        caBundlePath,
        containerCaPath: containerCaBundlePath,
        containerCaBundlePath,
        caBundleDescription: 'The read-only PEM bundle combines public trust roots with the HTTP FreeKit CA; TLS certificate and hostname verification remain enabled.',
        nodeProxyNote: NODE_ENV_PROXY_SUPPORT_NOTE,
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
