import fs from 'node:fs';
import net from 'node:net';
import { execFileAsync } from './command-runner.js';
import {
  NODE_ENV_PROXY_SUPPORT_NOTE,
  NODE_USE_ENV_PROXY_VALUE
} from './node-environment-proxy.js';
import {
  canAdvertisedHostReachProxy,
  createProxyBindUnreachableError
} from './proxy-bind-reachability.js';

function quoteDockerCsvField(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function quotePosixShellArgument(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function quoteWindowsNativeArgument(value) {
  // Encode one argv value for the Windows native command-line parser. This is
  // consumed after PowerShell's stop-parsing token, not by PowerShell itself.
  const escaped = String(value)
    .replace(/(\\*)"/g, (_match, backslashes) => `${backslashes}${backslashes}\\"`)
    .replace(/(\\+)$/, (_match, backslashes) => `${backslashes}${backslashes}`);
  return `"${escaped}"`;
}

function buildWindowsPowerShellRunInstruction(mountValue, runEnvironment) {
  const percentVariable = 'HTTP_FREEKIT_DOCKER_LITERAL_PERCENT';
  const protectedMountValue = mountValue.replace(/%/g, `%${percentVariable}%`);
  const dockerCommand = `docker --% run --mount ${quoteWindowsNativeArgument(protectedMountValue)} ${runEnvironment} <image>`;
  const commonLines = [
    // PowerShell 5 removes embedded native quotes and PowerShell 7 uses a
    // different argv mode. Scope Legacy mode and stop parsing so both versions
    // deliver the same literal, single mount operand to Docker.
    "  $PSNativeCommandArgumentPassing = 'Legacy'",
    `  ${dockerCommand}`
  ];

  if (protectedMountValue === mountValue) {
    return ['& {', ...commonLines, '}'].join('\n');
  }

  // PowerShell expands %NAME% even after --%. Replace each literal percent
  // with one non-recursively expanded helper value, then restore the process
  // environment after Docker exits.
  return [
    '& {',
    `  $previousLiteralPercent = [Environment]::GetEnvironmentVariable('${percentVariable}', 'Process')`,
    `  [Environment]::SetEnvironmentVariable('${percentVariable}', '%', 'Process')`,
    '  try {',
    ...commonLines.map(line => `  ${line}`),
    '  } finally {',
    `    [Environment]::SetEnvironmentVariable('${percentVariable}', $previousLiteralPercent, 'Process')`,
    '  }',
    '}'
  ].join('\n');
}

export class DockerInterceptor {
  constructor(options = {}) {
    this.id = 'docker';
    this.name = 'Docker Container';
    this.active = false;
    this.ca = null;
    this.proxyBindHost = options.proxyBindHost || null;
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
    return this.active;
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

  _getFreeKitCaPath() {
    try {
      const certInfo = typeof this.ca?.getCertInfo === 'function'
        ? this.ca.getCertInfo()
        : null;
      const certificatePath = certInfo?.certificatePath || this.ca?.caCertPath;
      if (typeof certificatePath !== 'string' || !certificatePath.trim()) {
        throw new Error('the FreeKit CA certificate path is not configured');
      }
      const stats = fs.statSync(certificatePath);
      if (!stats.isFile()) {
        throw new Error('the FreeKit CA certificate is not a file');
      }
      fs.accessSync(certificatePath, fs.constants.R_OK);
      if (!fs.readFileSync(certificatePath, 'utf8').trim()) {
        throw new Error('the FreeKit CA certificate is empty');
      }
      return certificatePath;
    } catch (error) {
      throw new Error(`FreeKit CA certificate is unavailable for Docker HTTPS interception: ${error.message}`);
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
    if (!canAdvertisedHostReachProxy(this.proxyBindHost, hostIp)) {
      return {
        success: false,
        error: createProxyBindUnreachableError(
          'Docker containers',
          this.proxyBindHost,
          hostIp
        ).message
      };
    }

    const proxyHost = net.isIP(hostIp) === 6 ? `[${hostIp}]` : hostIp;
    const proxyUrl = `http://${proxyHost}:${proxyPort}`;
    const caPath = this._getFreeKitCaPath();
    const containerCaPath = '/etc/http-freekit/http-freekit-ca.pem';
    // Docker parses --mount as CSV, so quotes must surround the complete
    // source=<path> field and must still be present after shell tokenization.
    const mountValue = [
      'type=bind',
      quoteDockerCsvField(`source=${caPath}`),
      `target=${containerCaPath}`,
      'readonly'
    ].join(',');
    const trustEnvironment = [
      `NODE_EXTRA_CA_CERTS=${containerCaPath}`,
      `NODE_USE_ENV_PROXY=${NODE_USE_ENV_PROXY_VALUE}`
    ];
    const proxyEnvironment = [
      `HTTP_PROXY=${proxyUrl}`,
      `HTTPS_PROXY=${proxyUrl}`,
      `http_proxy=${proxyUrl}`,
      `https_proxy=${proxyUrl}`,
      'NO_PROXY=',
      'no_proxy='
    ];
    const environment = [...proxyEnvironment, ...trustEnvironment];
    const runEnvironment = environment.map(value => `-e ${value}`).join(' ');
    const composeEnvironment = environment.map(value => `  - ${value}`).join('\n');
    // Compose interpolates YAML string values even when they are quoted.
    const composeMount = JSON.stringify(`${caPath}:${containerCaPath}:ro`.replace(/\$/g, () => '$$'));
    const runInstruction = this._platform() === 'win32'
      ? buildWindowsPowerShellRunInstruction(mountValue, runEnvironment)
      : `docker run --mount ${quotePosixShellArgument(mountValue)} ${runEnvironment} <image>`;
    const composeInstruction = `volumes:\n  - ${composeMount}\nenvironment:\n${composeEnvironment}`;
    this.active = true;

    console.log(`[Interceptor] Docker interceptor active. Proxy: ${proxyUrl}`);
    console.log(`[Interceptor] Run containers with: ${runInstruction}`);

    return {
      success: true,
      metadata: {
        proxyUrl,
        hostIp,
        caPath,
        caBundlePath: caPath,
        containerCaPath,
        containerCaBundlePath: containerCaPath,
        caBundleDescription: 'The read-only HTTP FreeKit CA is added to Node trust with NODE_EXTRA_CA_CERTS. Image and tool trust stores remain unchanged; install this CA into the image trust store when non-Node HTTPS clients need interception.',
        nodeProxyNote: NODE_ENV_PROXY_SUPPORT_NOTE,
        instructions: {
          run: runInstruction,
          compose: composeInstruction
        }
      }
    };
  }

  async deactivate() {
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
