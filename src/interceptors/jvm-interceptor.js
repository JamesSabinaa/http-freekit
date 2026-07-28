import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileAsync } from './command-runner.js';

const AGENT_BYTECODE_POLICY = Object.freeze({
  classMajorVersion: 52,
  preferredJavacArgs: ['--release', '8'],
  legacyJavacArgs: ['-source', '8', '-target', '8']
});
const JVM_RECOVERY_VERSION = 1;
const MAX_JVM_RECOVERY_BYTES = 128 * 1024;
const MAX_JVM_RECOVERY_PROCESSES = 128;
const JVM_AGENT_CACHE_VERSION = 1;
const MAX_JVM_AGENT_JAR_BYTES = 2 * 1024 * 1024;
const MAX_JVM_AGENT_STAMP_BYTES = 4096;

export class JvmInterceptor {
  constructor(options = {}) {
    this.id = 'jvm';
    this.name = 'Java/JVM Application';
    this.active = false;
    this.ca = null;
    this.activatedProcesses = new Map(); // pid -> { name, mainClass, activationUncertain? }
    this.processDiscoveryFailed = false;
    this.recoveryFile = options.dataDir
      ? path.join(options.dataDir, 'jvm-interceptor-recovery.json')
      : options.recoveryFile || null;
    this._processIdentityLookup = options.processIdentityLookup
      || (pid => this._inspectTargetIdentity(pid));
    this.agentDir = options.agentDir
      || (options.dataDir
        ? path.join(options.dataDir, 'jvm-agent')
        : path.join(os.tmpdir(), `http-freekit-jvm-agent-${process.pid}`));
    this._preparedAgentJarPath = null;
    this._adoptRecoveryJournal();
  }

  _platform() {
    return process.platform;
  }

  _isSafeJournalString(value, maxLength = 2048) {
    return typeof value === 'string' && value.length > 0 && value.length <= maxLength &&
      !/[\0\r\n]/.test(value);
  }

  _normalizeExecutableIdentity(executable) {
    const value = String(executable || '').trim();
    if (!this._isSafeJournalString(value)) {
      throw new Error('Process executable identity is missing or invalid');
    }
    if (path.win32.isAbsolute(value)) return path.win32.normalize(value).toLowerCase();
    if (path.posix.isAbsolute(value)) return path.posix.normalize(value);
    throw new Error('Process executable identity is not absolute');
  }

  _normalizeTargetIdentity(identity, expectedPid) {
    const pid = Number(expectedPid);
    if (!identity || typeof identity !== 'object' || Array.isArray(identity) ||
        !Number.isSafeInteger(identity.pid) || identity.pid !== pid || pid <= 0 ||
        pid > 0xffffffff) {
      throw new Error('Process identity PID is missing, invalid, or unexpected');
    }
    const startTime = String(identity.startTime || '').trim();
    const stableStartTime = /^\d{1,32}$/.test(startTime) ||
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/i.test(startTime);
    if (!this._isSafeJournalString(startTime, 128) || !stableStartTime) {
      throw new Error('Process start identity is missing or invalid');
    }
    return Object.freeze({
      pid,
      startTime,
      executable: this._normalizeExecutableIdentity(identity.executable)
    });
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

  async _inspectLinuxTargetIdentity(pid) {
    const procDirectory = `/proc/${pid}`;
    const statBefore = await fs.promises.readFile(path.join(procDirectory, 'stat'), 'utf8');
    const startTime = this._parseLinuxProcessStart(statBefore, pid);
    const executable = await fs.promises.readlink(path.join(procDirectory, 'exe'));
    const statAfter = await fs.promises.readFile(path.join(procDirectory, 'stat'), 'utf8');
    if (this._parseLinuxProcessStart(statAfter, pid) !== startTime) {
      throw new Error('Process identity changed during inspection');
    }
    return { pid, startTime, executable };
  }

  async _inspectDarwinTargetIdentity(pid) {
    const output = await execFileAsync(
      '/bin/ps',
      ['-ww', '-p', String(pid), '-o', 'pid=', '-o', 'lstart=', '-o', 'comm='],
      {
        encoding: 'utf8',
        timeout: 1000,
        maxBuffer: 16 * 1024,
        windowsHide: true,
        env: { ...process.env, LC_ALL: 'C' }
      }
    );
    const lines = String(output).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (lines.length !== 1) throw new Error('macOS process metadata is ambiguous');
    const match = lines[0].match(/^(\d+)\s+(\S+\s+\S+\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
    if (!match || Number(match[1]) !== pid) throw new Error('macOS process metadata is invalid');
    const startedAt = Date.parse(match[2]);
    if (!Number.isFinite(startedAt)) throw new Error('macOS process start time is unavailable');
    return { pid, startTime: String(startedAt), executable: match[3] };
  }

  async _inspectWindowsTargetIdentity(pid) {
    const output = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `$target = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction Stop | Select-Object -First 1
if ($null -eq $target) { [Console]::Out.Write('null') } else {
  $identity = [PSCustomObject]@{
    pid = [int]$target.ProcessId
    startTime = ([DateTime]$target.CreationDate).ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture)
    executable = [string]$target.ExecutablePath
  }
  [Console]::Out.Write(($identity | ConvertTo-Json -Compress))
}`
      ],
      { encoding: 'utf8', timeout: 3000, windowsHide: true, maxBuffer: 16 * 1024 }
    );
    const serialized = String(output).trim();
    if (!serialized) throw new Error('Windows process identity query returned no result');
    const identity = JSON.parse(serialized);
    return identity === null ? null : identity;
  }

  _probeTargetPid(pid) {
    try {
      process.kill(pid, 0);
      return 'running';
    } catch (err) {
      if (err?.code === 'EPERM') return 'running';
      if (err?.code === 'ESRCH') return 'absent';
      return 'unknown';
    }
  }

  async _inspectTargetIdentity(pid) {
    try {
      let identity;
      if (this._platform() === 'win32') identity = await this._inspectWindowsTargetIdentity(pid);
      else if (this._platform() === 'darwin') identity = await this._inspectDarwinTargetIdentity(pid);
      else identity = await this._inspectLinuxTargetIdentity(pid);
      return identity === null
        ? { state: 'absent' }
        : { state: 'running', identity };
    } catch (error) {
      const state = this._probeTargetPid(pid);
      return state === 'absent' ? { state } : { state: 'unknown', error };
    }
  }

  async _observeTargetIdentity(pid) {
    try {
      const observation = await this._processIdentityLookup(Number(pid));
      if (observation === null || observation?.state === 'absent') return { state: 'absent' };
      if (observation?.state === 'unknown') return observation;
      const rawIdentity = observation?.state === 'running'
        ? observation.identity
        : observation;
      return {
        state: 'running',
        identity: this._normalizeTargetIdentity(rawIdentity, Number(pid))
      };
    } catch (error) {
      return { state: 'unknown', error };
    }
  }

  _sameTargetIdentity(left, right) {
    return Boolean(left && right && left.pid === right.pid &&
      left.startTime === right.startTime && left.executable === right.executable);
  }

  _normalizeJournalProcess(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        Object.keys(entry).some(field => ![
          'pid', 'name', 'mainClass', 'state', 'identity'
        ].includes(field)) ||
        !/^\d{1,10}$/.test(entry.pid || '') ||
        String(Number(entry.pid)) !== entry.pid ||
        !this._isSafeJournalString(entry.name, 512) ||
        !this._isSafeJournalString(entry.mainClass, 1024) ||
        !['pending', 'active', 'uncertain'].includes(entry.state) ||
        !entry.identity || typeof entry.identity !== 'object' || Array.isArray(entry.identity) ||
        Object.keys(entry.identity).some(field => ![
          'pid', 'startTime', 'executable'
        ].includes(field))) {
      return null;
    }
    let identity;
    try {
      identity = this._normalizeTargetIdentity(entry.identity, Number(entry.pid));
    } catch {
      return null;
    }
    return {
      name: entry.name,
      mainClass: entry.mainClass,
      targetIdentity: identity,
      recoveryState: entry.state,
      ...(entry.state === 'active' ? {} : { activationUncertain: true })
    };
  }

  _journalProcess(pid, info) {
    return {
      pid,
      name: info.name,
      mainClass: info.mainClass,
      state: info.recoveryState,
      identity: info.targetIdentity
    };
  }

  _adoptRecoveryJournal() {
    if (!this.recoveryFile || !fs.existsSync(this.recoveryFile)) return;
    try {
      const stats = fs.lstatSync(this.recoveryFile);
      if (!stats.isFile() || stats.size > MAX_JVM_RECOVERY_BYTES) {
        throw new Error('Recovery journal is not a trusted regular file');
      }
      const parsed = JSON.parse(fs.readFileSync(this.recoveryFile, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
          parsed.version !== JVM_RECOVERY_VERSION || !Array.isArray(parsed.processes) ||
          parsed.processes.length === 0 ||
          parsed.processes.length > MAX_JVM_RECOVERY_PROCESSES ||
          Object.keys(parsed).some(field => !['version', 'processes'].includes(field))) {
        throw new Error('Recovery journal has an invalid schema');
      }
      const adopted = new Map();
      for (const rawEntry of parsed.processes) {
        const info = this._normalizeJournalProcess(rawEntry);
        if (!info || adopted.has(rawEntry.pid)) {
          throw new Error('Recovery journal contains an invalid process entry');
        }
        adopted.set(rawEntry.pid, {
          ...info,
          recovered: true,
          identityUncertain: true
        });
      }
      this.activatedProcesses = adopted;
      this.active = adopted.size > 0;
    } catch (err) {
      console.warn('[Interceptor] Ignoring invalid JVM recovery journal:', err.message);
    }
  }

  _writeRecoveryJournal(processes) {
    if (!this.recoveryFile) return;
    if (processes.size === 0) {
      try {
        fs.unlinkSync(this.recoveryFile);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      return;
    }
    const payload = {
      version: JVM_RECOVERY_VERSION,
      processes: Array.from(processes.entries()).map(([pid, info]) => this._journalProcess(pid, info))
    };
    const serialized = JSON.stringify(payload, null, 2);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_JVM_RECOVERY_BYTES) {
      throw new Error('JVM recovery journal exceeds its size limit');
    }
    fs.mkdirSync(path.dirname(this.recoveryFile), { recursive: true });
    const tempPath = path.join(
      path.dirname(this.recoveryFile),
      `.${path.basename(this.recoveryFile)}.${process.pid}.${Date.now()}.tmp`
    );
    try {
      fs.writeFileSync(tempPath, serialized, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
        flush: true
      });
      fs.renameSync(tempPath, this.recoveryFile);
    } catch (err) {
      try { fs.unlinkSync(tempPath); } catch {}
      throw err;
    }
  }

  _setTrackedOwnership(pid, info) {
    const next = new Map(this.activatedProcesses);
    next.set(pid, info);
    this._writeRecoveryJournal(next);
    this.activatedProcesses = next;
    this.active = true;
  }

  _forgetTrackedOwnership(pid) {
    if (!this.activatedProcesses.has(pid)) return;
    const next = new Map(this.activatedProcesses);
    next.delete(pid);
    this._writeRecoveryJournal(next);
    this.activatedProcesses = next;
    this.active = next.size > 0;
  }

  _runAvailabilityCommand(file, args, options) {
    return execFileAsync(file, args, options);
  }

  async isActivable() {
    try {
      await this._runAvailabilityCommand('java', ['-version'], { timeout: 5000 });
      // Check if jps is available (comes with JDK)
      await this._runAvailabilityCommand('jps', ['-q'], { timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }

  async isActive() {
    const processes = await this._getRunningProcesses();
    await this._syncActivatedProcesses(processes);
    return this.active && this.activatedProcesses.size > 0;
  }

  /**
   * Parse `jps -v` output into a list of running JVM processes.
   * jps -v outputs: <pid> <mainClass> <jvmArgs...>
   */
  async _getRunningProcesses() {
    try {
      const output = await execFileAsync('jps', ['-v'], { encoding: 'utf8', timeout: 5000 });
      this.processDiscoveryFailed = false;
      const lines = output.split('\n');
      const processes = [];

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const spaceIdx = trimmed.indexOf(' ');
        if (spaceIdx === -1) continue;

        const pid = trimmed.substring(0, spaceIdx);
        const rest = trimmed.substring(spaceIdx + 1);

        // Skip jps itself and processes with no useful name
        const mainClassEnd = rest.indexOf(' ');
        const mainClass = mainClassEnd === -1 ? rest : rest.substring(0, mainClassEnd);
        const jvmArgs = mainClassEnd === -1 ? '' : rest.substring(mainClassEnd + 1);

        if (mainClass === 'Jps' || mainClass === 'sun.tools.jps.Jps') continue;

        // Extract a friendly display name from the main class
        const name = this._getDisplayName(mainClass, jvmArgs);

        processes.push({
          pid,
          mainClass,
          name,
          jvmArgs: jvmArgs.length > 200 ? jvmArgs.substring(0, 200) + '...' : jvmArgs
        });
      }

      return processes;
    } catch (err) {
      this.processDiscoveryFailed = true;
      console.error('[Interceptor] JPS process list failed:', err.message);
      return [];
    }
  }

  /**
   * Derive a friendly display name from main class and JVM args.
   */
  _getDisplayName(mainClass, jvmArgs) {
    // Use short class name (last segment)
    if (mainClass && mainClass !== '') {
      const parts = mainClass.split('.');
      return parts[parts.length - 1] || mainClass;
    }
    return 'Unknown JVM Process';
  }

  async getMetadata() {
    const processes = await this._getRunningProcesses();
    await this._syncActivatedProcesses(processes);
    return {
      processes,
      activatedProcesses: this._getActivatedProcessMetadata(),
      activationUncertain: this._hasUncertainActivation(),
      recoveryUncertain: this._hasRecoveryUncertainty()
    };
  }

  _getActivatedProcessMetadata() {
    return Array.from(this.activatedProcesses.entries()).map(([pid, info]) => ({
      pid,
      name: info.name,
      mainClass: info.mainClass,
      ...(info.activationUncertain ? { activationUncertain: true } : {}),
      ...(info.recovered ? { recovered: true } : {}),
      ...(info.identityUncertain ? { recoveryUncertain: true } : {})
    }));
  }

  _hasUncertainActivation() {
    return Array.from(this.activatedProcesses.values())
      .some(info => info.activationUncertain === true);
  }

  _hasRecoveryUncertainty() {
    return Array.from(this.activatedProcesses.values())
      .some(info => info.identityUncertain === true);
  }

  /**
   * Build a Java agent JAR that sets proxy system properties and trusts our CA.
   * Returns the path to the agent JAR, or null if unable.
   */
  _getAgentSource() {
    return `
import java.io.FileInputStream;
import java.io.InputStream;
import java.lang.instrument.Instrumentation;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.cert.Certificate;
import java.security.cert.CertificateException;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;

public class ProxyAgent {
    private static final String[] PROXY_PROPERTIES = {
        "http.proxyHost", "http.proxyPort", "http.nonProxyHosts",
        "https.proxyHost", "https.proxyPort"
    };
    private static final Map<String, String> originalProperties = new HashMap<String, String>();
    private static final Map<String, String> installedProperties = new HashMap<String, String>();
    private static SSLContext originalSslContext;
    private static SSLContext installedSslContext;
    private static SSLSocketFactory originalSslSocketFactory;
    private static SSLSocketFactory installedSslSocketFactory;
    private static boolean configured;

    public static void premain(String args, Instrumentation inst) {
        configure(args);
    }
    public static void agentmain(String args, Instrumentation inst) {
        configure(args);
    }
    private static synchronized void configure(String args) {
        if (args == null || args.isEmpty()) return;
        String caPath = null;
        Map<String, String> values = new HashMap<String, String>();
        String[] parts = args.split(",");
        for (String part : parts) {
            String[] kv = part.split("=", 2);
            if (kv.length != 2) continue;
            if (kv[0].equals("freekit.caPathBase64")) {
                caPath = new String(Base64.getDecoder().decode(kv[1]), StandardCharsets.UTF_8);
            } else {
                values.put(kv[0], kv[1]);
            }
        }
        if ("deactivate".equals(values.get("freekit.action"))) {
            restore();
            System.out.println("[HTTP FreeKit] Proxy agent deactivated");
            return;
        }
        if (!configured) {
            for (String property : PROXY_PROPERTIES) {
                originalProperties.put(property, System.getProperty(property));
            }
            try {
                originalSslContext = SSLContext.getDefault();
            } catch (Exception error) {
                throw new IllegalStateException("Unable to capture the JVM SSL context", error);
            }
            originalSslSocketFactory = HttpsURLConnection.getDefaultSSLSocketFactory();
            configured = true;
        }
        for (String property : PROXY_PROPERTIES) {
            String value = values.get(property);
            if (value != null) {
                System.setProperty(property, value);
                installedProperties.put(property, value);
            }
        }
        if (caPath != null && !caPath.isEmpty()) {
            try {
                installCa(caPath);
            } catch (Exception error) {
                restore();
                throw new IllegalStateException("Unable to trust the HTTP FreeKit CA", error);
            }
        }
        System.out.println("[HTTP FreeKit] Proxy agent loaded: " + args);
    }
    private static void restore() {
        if (!configured) return;
        for (String property : PROXY_PROPERTIES) {
            String installedValue = installedProperties.get(property);
            if (installedValue == null || !installedValue.equals(System.getProperty(property))) {
                continue;
            }
            String originalValue = originalProperties.get(property);
            if (originalValue == null) {
                System.clearProperty(property);
            } else {
                System.setProperty(property, originalValue);
            }
        }
        try {
            if (installedSslContext != null
                    && SSLContext.getDefault() == installedSslContext
                    && originalSslContext != null) {
                SSLContext.setDefault(originalSslContext);
            }
        } catch (Exception error) {
            throw new IllegalStateException("Unable to inspect the JVM SSL context", error);
        }
        if (installedSslSocketFactory != null
                && HttpsURLConnection.getDefaultSSLSocketFactory() == installedSslSocketFactory
                && originalSslSocketFactory != null) {
            HttpsURLConnection.setDefaultSSLSocketFactory(originalSslSocketFactory);
        }
        originalProperties.clear();
        installedProperties.clear();
        originalSslContext = null;
        installedSslContext = null;
        originalSslSocketFactory = null;
        installedSslSocketFactory = null;
        configured = false;
    }
    private static X509TrustManager findX509TrustManager(TrustManager[] managers) {
        for (TrustManager manager : managers) {
            if (manager instanceof X509TrustManager) return (X509TrustManager) manager;
        }
        throw new IllegalStateException("No X509 trust manager is available");
    }
    private static void installCa(String caPath) throws Exception {
        CertificateFactory certificates = CertificateFactory.getInstance("X.509");
        Certificate caCertificate;
        try (InputStream input = new FileInputStream(caPath)) {
            caCertificate = certificates.generateCertificate(input);
        }

        KeyStore caStore = KeyStore.getInstance(KeyStore.getDefaultType());
        caStore.load(null, null);
        caStore.setCertificateEntry("http-freekit", caCertificate);

        TrustManagerFactory caFactory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        caFactory.init(caStore);
        final X509TrustManager caTrust = findX509TrustManager(caFactory.getTrustManagers());

        TrustManagerFactory systemFactory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        systemFactory.init((KeyStore) null);
        final X509TrustManager systemTrust = findX509TrustManager(systemFactory.getTrustManagers());

        X509TrustManager combinedTrust = new X509TrustManager() {
            public X509Certificate[] getAcceptedIssuers() {
                X509Certificate[] systemIssuers = systemTrust.getAcceptedIssuers();
                X509Certificate[] caIssuers = caTrust.getAcceptedIssuers();
                X509Certificate[] combined = Arrays.copyOf(systemIssuers, systemIssuers.length + caIssuers.length);
                System.arraycopy(caIssuers, 0, combined, systemIssuers.length, caIssuers.length);
                return combined;
            }
            public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                try {
                    systemTrust.checkClientTrusted(chain, authType);
                } catch (CertificateException systemError) {
                    caTrust.checkClientTrusted(chain, authType);
                }
            }
            public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                try {
                    systemTrust.checkServerTrusted(chain, authType);
                } catch (CertificateException systemError) {
                    caTrust.checkServerTrusted(chain, authType);
                }
            }
        };

        SSLContext context = SSLContext.getInstance("TLS");
        context.init(null, new TrustManager[] { combinedTrust }, null);
        SSLSocketFactory socketFactory = context.getSocketFactory();
        SSLContext.setDefault(context);
        installedSslContext = context;
        HttpsURLConnection.setDefaultSSLSocketFactory(socketFactory);
        installedSslSocketFactory = socketFactory;
    }
}
`;
  }

  async _classifyTrackedTarget(pid, activated, processes) {
    const running = processes.find(process_ => String(process_.pid) === String(pid));
    if (!activated.targetIdentity) {
      if (this.processDiscoveryFailed) return 'unknown';
      if (!running) return 'gone';
      return running.mainClass === activated.mainClass ? 'same' : 'replaced';
    }

    const jvmState = this.processDiscoveryFailed || !running
      ? 'unknown'
      : running.mainClass === activated.mainClass ? 'same' : 'replaced';

    // Keep the strong OS observation last so a matching result immediately
    // precedes any restore attach authorized by this classification.
    const observation = await this._observeTargetIdentity(pid);
    if (observation.state === 'absent') return 'gone';
    if (observation.state !== 'running') return 'unknown';
    if (!this._sameTargetIdentity(activated.targetIdentity, observation.identity)) {
      return 'replaced';
    }
    return jvmState;
  }

  async _authorizeTrackedTarget(pid, activated) {
    const state = await this._classifyTrackedTarget(
      pid,
      activated,
      await this._getRunningProcesses()
    );
    if (state === 'same') return;
    const error = new Error(
      `JVM process ${pid} is not an exact verified target immediately before attach`
    );
    error.code = 'JVM_TARGET_AUTHORIZATION_FAILED';
    error.targetState = state;
    throw error;
  }

  async _syncActivatedProcesses(processes) {
    for (const [pid, activated] of Array.from(this.activatedProcesses.entries())) {
      const state = await this._classifyTrackedTarget(pid, activated, processes);
      if (state === 'gone' || state === 'replaced') {
        try {
          this._forgetTrackedOwnership(pid);
        } catch (err) {
          console.warn(`[Interceptor] Could not clear stale JVM recovery for PID ${pid}:`, err.message);
          this.activatedProcesses.set(pid, { ...activated, identityUncertain: true });
        }
      } else if (state === 'unknown' && activated.targetIdentity && !activated.identityUncertain) {
        this.activatedProcesses.set(pid, { ...activated, identityUncertain: true });
      } else if (state === 'same' && activated.identityUncertain) {
        const verified = { ...activated };
        delete verified.identityUncertain;
        this.activatedProcesses.set(pid, verified);
      }
    }
    this.active = this.activatedProcesses.size > 0;
  }

  _getAgentArgs(proxyHost, proxyPort, action = 'activate') {
    const args = [`freekit.action=${action}`];
    if (action === 'deactivate') return args.join(',');

    args.push(
      `http.proxyHost=${proxyHost}`,
      `http.proxyPort=${proxyPort}`,
      'http.nonProxyHosts=',
      `https.proxyHost=${proxyHost}`,
      `https.proxyPort=${proxyPort}`
    );
    const caPath = this.ca?.getCertInfo()?.certificatePath;
    if (caPath) {
      args.push(`freekit.caPathBase64=${Buffer.from(caPath, 'utf8').toString('base64')}`);
    }
    return args.join(',');
  }

  _getAgentBytecodePolicy() {
    return JSON.stringify(AGENT_BYTECODE_POLICY);
  }

  _runJavac(args, cwd) {
    return execFileAsync('javac', args, { cwd, timeout: 15000 });
  }

  _isUnsupportedReleaseFlag(error) {
    const output = `${error?.message || ''}\n${error?.stderr || ''}`;
    return /(?:invalid|unrecognized|unknown|illegal)\s+(?:flag|option)(?::|\s)[^\n]*--release|--release[^\n]*(?:not recognized|not supported)/i.test(output)
      || (error?.code === 2 && output.includes('--release'));
  }

  async _compileAgentJava(sourcePath, cwd) {
    try {
      await this._runJavac([...AGENT_BYTECODE_POLICY.preferredJavacArgs, sourcePath], cwd);
    } catch (error) {
      if (!this._isUnsupportedReleaseFlag(error)) throw error;
      await this._runJavac([...AGENT_BYTECODE_POLICY.legacyJavacArgs, sourcePath], cwd);
    }
  }

  _packageAgentJar(jarPath, manifestPath, cwd) {
    return execFileAsync('jar', ['cfm', jarPath, manifestPath, 'ProxyAgent.class'], {
      cwd,
      timeout: 10000
    });
  }

  _quoteManualJvmOption(option) {
    if (this._platform() === 'win32') {
      return `"${option.replaceAll('"', '\\"')}"`;
    }
    return `'${option.replaceAll("'", "'\\''")}'`;
  }

  _getFallbackCommand(proxyHost, proxyPort, agentJar = this._preparedAgentJarPath) {
    const caPath = this.ca?.getCertInfo?.()?.certificatePath;
    if (!agentJar || !caPath) return null;
    return this._quoteManualJvmOption(
      `-javaagent:${agentJar}=${this._getAgentArgs(proxyHost, proxyPort)}`
    );
  }

  _readAgentJarBytes(jarPath) {
    const stat = fs.lstatSync(jarPath);
    if (!stat.isFile() || stat.size < 4 || stat.size > MAX_JVM_AGENT_JAR_BYTES) {
      throw new Error('cached JVM agent JAR is not a bounded regular file');
    }
    const bytes = fs.readFileSync(jarPath);
    if (bytes.length !== stat.size || bytes.readUInt32BE(0) !== 0x504b0304) {
      throw new Error('cached JVM agent JAR is not a valid JAR archive');
    }
    return bytes;
  }

  _getAgentJarCacheStamp(jarPath, sourceHash) {
    const jarBytes = this._readAgentJarBytes(jarPath);
    return {
      version: JVM_AGENT_CACHE_VERSION,
      sourceHash,
      jarHash: crypto.createHash('sha256').update(jarBytes).digest('hex')
    };
  }

  _agentJarCacheIsValid(jarPath, stampPath, sourceHash) {
    const stampStat = fs.lstatSync(stampPath);
    if (!stampStat.isFile() || stampStat.size <= 0 || stampStat.size > MAX_JVM_AGENT_STAMP_BYTES) {
      throw new Error('JVM agent cache stamp is not a bounded regular file');
    }
    const stamp = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
    if (stamp?.version !== JVM_AGENT_CACHE_VERSION || stamp.sourceHash !== sourceHash ||
        !/^[a-f0-9]{64}$/.test(stamp.jarHash || '')) {
      return false;
    }
    const actualStamp = this._getAgentJarCacheStamp(jarPath, sourceHash);
    return actualStamp.jarHash === stamp.jarHash;
  }

  async _getAgentJarPath() {
    const agentDir = this.agentDir;
    const jarPath = path.join(agentDir, 'proxy-agent.jar');
    const javaPath = path.join(agentDir, 'ProxyAgent.java');
    const manifestPath = path.join(agentDir, 'MANIFEST.MF');
    const stampPath = path.join(agentDir, 'source.sha256');
    const agentSource = this._getAgentSource();
    const manifest = 'Manifest-Version: 1.0\nPremain-Class: ProxyAgent\nAgent-Class: ProxyAgent\nCan-Retransform-Classes: true\nCan-Redefine-Classes: true\n';
    const sourceHash = crypto.createHash('sha256')
      .update(agentSource)
      .update(manifest)
      .update(this._getAgentBytecodePolicy())
      .digest('hex');

    try {
      if (fs.existsSync(jarPath) && fs.existsSync(stampPath)
          && this._agentJarCacheIsValid(jarPath, stampPath, sourceHash)) {
        this._preparedAgentJarPath = jarPath;
        return jarPath;
      }
    } catch (err) {
      console.warn('[Interceptor] Ignoring invalid cached JVM agent JAR:', err.message);
    }

    try {
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(javaPath, agentSource);
      fs.writeFileSync(manifestPath, manifest);

      // Compile
      await this._compileAgentJava(javaPath, agentDir);

      // Package into JAR
      await this._packageAgentJar(jarPath, manifestPath, agentDir);
      fs.writeFileSync(
        stampPath,
        JSON.stringify(this._getAgentJarCacheStamp(jarPath, sourceHash))
      );

      console.log('[Interceptor] JVM proxy agent JAR created at', jarPath);
      this._preparedAgentJarPath = jarPath;
      return jarPath;
    } catch (err) {
      this._preparedAgentJarPath = null;
      console.error('[Interceptor] Failed to build JVM agent JAR:', err.message);
      return null;
    }
  }

  _getAttachSource() {
    return `
import com.sun.tools.attach.VirtualMachine;

public class AttachProxy {
    public static void main(String[] args) throws Exception {
        if (args.length < 3) {
            System.err.println("Usage: AttachProxy <pid> <agentJar> <agentArgs>");
            System.exit(1);
        }
        String pid = args[0];
        String jar = args[1];
        String agentArgs = args[2];
        VirtualMachine vm = VirtualMachine.attach(pid);
        try {
            vm.loadAgent(jar, agentArgs);
            System.out.println("Agent loaded successfully into PID " + pid);
        } finally {
            vm.detach();
        }
    }
}
`;
  }

  _compileJava(sourcePath, cwd) {
    return this._runJavac([sourcePath], cwd);
  }

  async _ensureAttachHelper() {
    const attachDir = this.agentDir;
    const attachSource = this._getAttachSource();
    const attachJavaPath = path.join(attachDir, 'AttachProxy.java');
    const attachClassPath = path.join(attachDir, 'AttachProxy.class');
    const attachStampPath = path.join(attachDir, 'attach-source.sha256');
    const sourceHash = crypto.createHash('sha256').update(attachSource).digest('hex');
    const cachedHash = fs.existsSync(attachStampPath)
      ? fs.readFileSync(attachStampPath, 'utf8')
      : null;

    if (fs.existsSync(attachClassPath) && cachedHash === sourceHash) return attachDir;

    fs.mkdirSync(attachDir, { recursive: true });
    for (const stalePath of [attachClassPath, attachStampPath]) {
      try { fs.unlinkSync(stalePath); } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
    fs.writeFileSync(attachJavaPath, attachSource);
    await this._compileJava(attachJavaPath, attachDir);
    if (!fs.existsSync(attachClassPath)) {
      throw new Error('javac did not produce AttachProxy.class');
    }
    fs.writeFileSync(attachStampPath, sourceHash);
    return attachDir;
  }

  _runAttachHelper(attachDir, pid, agentJar, agentArgs, onSpawn) {
    return execFileAsync(
      'java',
      ['-cp', attachDir, 'AttachProxy', String(pid), agentJar, agentArgs],
      { encoding: 'utf8', timeout: 15000, cwd: attachDir, onSpawn }
    );
  }

  /**
   * Attach the agent to a running JVM process using the Attach API.
   */
  async _attachAgent(pid, proxyHost, proxyPort, action = 'activate', options = {}) {
    const agentJar = await this._getAgentJarPath();
    if (!agentJar) {
      return {
        success: false,
        error: 'Failed to build proxy agent JAR',
        targetMutationPossible: false
      };
    }

    const agentArgs = this._getAgentArgs(proxyHost, proxyPort, action);

    let attachDir;
    try {
      attachDir = await this._ensureAttachHelper();
    } catch (err) {
      console.error(`[Interceptor] Failed to prepare JVM attach helper for PID ${pid}:`, err.message);
      return { success: false, error: err.message, targetMutationPossible: false };
    }

    if (typeof options.authorizeBeforeRun === 'function') {
      try {
        await options.authorizeBeforeRun();
      } catch (err) {
        console.error(`[Interceptor] Refusing JVM attach to PID ${pid}:`, err.message);
        return {
          success: false,
          error: err.message,
          targetMutationPossible: false,
          ...(err.targetState ? { authorizationState: err.targetState } : {})
        };
      }
    }

    let helperStarted = false;
    try {
      // Run the attach program
      const result = await this._runAttachHelper(
        attachDir,
        pid,
        agentJar,
        agentArgs,
        () => { helperStarted = true; }
      );
      console.log('[Interceptor] JVM attach result:', result.trim());
      return { success: true };
    } catch (err) {
      console.error(`[Interceptor] Failed to attach agent to PID ${pid}:`, err.message);
      return { success: false, error: err.message, targetMutationPossible: helperStarted };
    }
  }

  async activate(proxyPort, options = {}) {
    const pid = options.pid == null ? null : String(options.pid);

    if (!pid) {
      // No specific process — return metadata with process list for UI selection
      const processes = await this._getRunningProcesses();
      const proxyHost = '127.0.0.1';
      const fallbackAgentJar = await this._getAgentJarPath();
      this.active = true;
      return {
        success: true,
        metadata: {
          processes,
          activatedProcesses: this._getActivatedProcessMetadata(),
          activationUncertain: this._hasUncertainActivation(),
          fallbackCommand: this._getFallbackCommand(proxyHost, proxyPort, fallbackAgentJar),
          requiresProcessSelection: true
        }
      };
    }

    // Verify process exists
    const processes = await this._getRunningProcesses();
    const process_ = processes.find(p => p.pid === pid);

    if (!process_) {
      return { success: false, error: `JVM process ${pid} not found` };
    }

    const proxyHost = '127.0.0.1';
    let fallbackCommand = this._getFallbackCommand(proxyHost, proxyPort);
    let pendingOwnership = null;
    if (this.recoveryFile) {
      const observation = await this._observeTargetIdentity(pid);
      if (observation.state !== 'running') {
        return {
          success: false,
          error: `Could not verify the identity of JVM process ${pid}; no attach was attempted`,
          metadata: {
            fallbackCommand,
            processes,
            activatedProcesses: this._getActivatedProcessMetadata(),
            activationUncertain: this._hasUncertainActivation(),
            recoveryUncertain: this._hasRecoveryUncertainty()
          }
        };
      }
      pendingOwnership = {
        name: process_.name,
        mainClass: process_.mainClass,
        targetIdentity: observation.identity,
        recoveryState: 'pending',
        activationUncertain: true
      };
      if (!this._normalizeJournalProcess(this._journalProcess(pid, pendingOwnership))) {
        return { success: false, error: `JVM process ${pid} has invalid recovery identity metadata` };
      }
      try {
        this._setTrackedOwnership(pid, pendingOwnership);
      } catch (err) {
        return {
          success: false,
          error: `Could not persist JVM recovery ownership before attach: ${err.message}`,
          metadata: {
            fallbackCommand,
            processes,
            activatedProcesses: this._getActivatedProcessMetadata(),
            activationUncertain: this._hasUncertainActivation(),
            recoveryUncertain: this._hasRecoveryUncertainty()
          }
        };
      }

      const currentProcesses = await this._getRunningProcesses();
      const targetState = await this._classifyTrackedTarget(pid, pendingOwnership, currentProcesses);
      if (targetState !== 'same') {
        let discardError = null;
        try {
          this._forgetTrackedOwnership(pid);
        } catch (err) {
          discardError = err;
          this.activatedProcesses.set(pid, { ...pendingOwnership, identityUncertain: true });
          this.active = true;
        }
        return {
          success: false,
          error: `JVM process ${pid} could not be revalidated before attach; no attach was attempted` +
            (discardError ? `, and pending recovery ownership could not be cleared: ${discardError.message}` : ''),
          metadata: {
            fallbackCommand,
            processes: currentProcesses,
            activatedProcesses: this._getActivatedProcessMetadata(),
            activationUncertain: this._hasUncertainActivation(),
            recoveryUncertain: this._hasRecoveryUncertainty()
          }
        };
      }
    }

    // Attempt to attach only after any durable recovery record is in place.
    const attachResult = pendingOwnership
      ? await this._attachAgent(pid, proxyHost, proxyPort, 'activate', {
          authorizeBeforeRun: () => this._authorizeTrackedTarget(pid, pendingOwnership)
        })
      : await this._attachAgent(pid, proxyHost, proxyPort);

    if (!attachResult.success) {
      fallbackCommand = this._getFallbackCommand(proxyHost, proxyPort);
      if (attachResult.targetMutationPossible) {
        const uncertainOwnership = {
          name: process_.name,
          mainClass: process_.mainClass,
          ...(pendingOwnership ? {
            targetIdentity: pendingOwnership.targetIdentity,
            recoveryState: 'uncertain'
          } : {}),
          activationUncertain: true
        };
        if (pendingOwnership) {
          try {
            this._setTrackedOwnership(pid, uncertainOwnership);
          } catch (err) {
            console.warn(`[Interceptor] Could not promote uncertain JVM recovery for PID ${pid}:`, err.message);
            this.activatedProcesses.set(pid, uncertainOwnership);
            this.active = true;
          }
        } else {
          this.activatedProcesses.set(pid, uncertainOwnership);
        }
      } else if (pendingOwnership) {
        try {
          this._forgetTrackedOwnership(pid);
        } catch (err) {
          console.warn(`[Interceptor] Could not discard pending JVM recovery for PID ${pid}:`, err.message);
          this.activatedProcesses.set(pid, { ...pendingOwnership, identityUncertain: true });
          this.active = true;
        }
      }
      this.active = this.activatedProcesses.size > 0;

      const uncertaintyNotice = attachResult.targetMutationPossible
        ? ' The attach helper started before failing, so the target may have changed; Stop will retry restoration.'
        : '';
      return {
        success: false,
        error: `Could not attach to PID ${pid}: ${attachResult.error}.${uncertaintyNotice}` +
          (fallbackCommand
            ? ` Try launching the JVM with: ${fallbackCommand}`
            : ' A CA-capable manual launch fallback could not be prepared.'),
        metadata: {
          fallbackCommand,
          processes: await this._getRunningProcesses(),
          activatedProcesses: this._getActivatedProcessMetadata(),
          activationUncertain: this._hasUncertainActivation(),
          recoveryUncertain: this._hasRecoveryUncertainty()
        }
      };
    }

    const activeOwnership = {
      name: process_.name,
      mainClass: process_.mainClass,
      ...(pendingOwnership ? {
        targetIdentity: pendingOwnership.targetIdentity,
        recoveryState: 'active'
      } : {})
    };
    try {
      if (pendingOwnership) this._setTrackedOwnership(pid, activeOwnership);
      else {
        this.activatedProcesses.set(pid, activeOwnership);
        this.active = true;
      }
    } catch (err) {
      const uncertainOwnership = { ...pendingOwnership, activationUncertain: true };
      this.activatedProcesses.set(pid, uncertainOwnership);
      this.active = true;
      return {
        success: false,
        error: `Attached to PID ${pid}, but could not finalize durable recovery ownership: ${err.message}. Stop will retry restoration.`,
        metadata: {
          fallbackCommand,
          processes: await this._getRunningProcesses(),
          activatedProcesses: this._getActivatedProcessMetadata(),
          activationUncertain: true,
          recoveryUncertain: this._hasRecoveryUncertainty()
        }
      };
    }

    console.log(`[Interceptor] JVM interceptor activated for PID ${pid} (${process_.name})`);

    return {
      success: true,
      metadata: {
        pid,
        name: process_.name,
        mainClass: process_.mainClass,
        proxyUrl: `http://${proxyHost}:${proxyPort}`,
        processes: await this._getRunningProcesses(),
        activatedProcesses: this._getActivatedProcessMetadata(),
        activationUncertain: this._hasUncertainActivation(),
        recoveryUncertain: this._hasRecoveryUncertainty()
      }
    };
  }

  async deactivate(options = {}) {
    const pid = options.pid == null ? null : String(options.pid);
    const deactivatePid = async processId => {
      const tracked = this.activatedProcesses.get(processId);
      if (!tracked) return null;
      if (tracked.targetIdentity) {
        const targetState = await this._classifyTrackedTarget(
          processId,
          tracked,
          await this._getRunningProcesses()
        );
        if (targetState === 'gone' || targetState === 'replaced') {
          try {
            this._forgetTrackedOwnership(processId);
          } catch (err) {
            return `PID ${processId}: stale recovery ownership could not be cleared: ${err.message}`;
          }
          console.log(`[Interceptor] Cleared stale JVM recovery ownership for PID ${processId}`);
          return null;
        }
        if (targetState !== 'same') {
          this.activatedProcesses.set(processId, { ...tracked, identityUncertain: true });
          this.active = true;
          return `PID ${processId}: target identity could not be verified; no restore was attempted and Stop can be retried`;
        }
        if (tracked.identityUncertain) {
          const verified = { ...tracked };
          delete verified.identityUncertain;
          this.activatedProcesses.set(processId, verified);
        }
      }

      const result = tracked.targetIdentity
        ? await this._attachAgent(processId, null, null, 'deactivate', {
            authorizeBeforeRun: () => this._authorizeTrackedTarget(processId, tracked)
          })
        : await this._attachAgent(processId, null, null, 'deactivate');
      if (!result.success) {
        if (result.authorizationState === 'gone' || result.authorizationState === 'replaced') {
          try {
            this._forgetTrackedOwnership(processId);
          } catch (err) {
            return `PID ${processId}: stale recovery ownership could not be cleared: ${err.message}`;
          }
          console.log(`[Interceptor] Cleared stale JVM recovery ownership for PID ${processId}`);
          return null;
        }
        if (result.authorizationState === 'unknown') {
          this.activatedProcesses.set(processId, { ...tracked, identityUncertain: true });
          this.active = true;
          return `PID ${processId}: target identity could not be verified immediately before attach; no restore was attempted and Stop can be retried`;
        }
        return `PID ${processId}: ${result.error}`;
      }
      try {
        this._forgetTrackedOwnership(processId);
      } catch (err) {
        return `PID ${processId}: target was restored but recovery ownership could not be cleared: ${err.message}`;
      }
      console.log(`[Interceptor] JVM interceptor deactivated for PID ${processId}`);
      return null;
    };

    if (pid) {
      if (!this.activatedProcesses.has(pid)) return;
      const error = await deactivatePid(pid);
      this.active = this.activatedProcesses.size > 0;
      if (error) throw new Error(`Could not deactivate JVM interceptor: ${error}`);
    } else {
      const errors = [];
      for (const processId of Array.from(this.activatedProcesses.keys())) {
        const error = await deactivatePid(processId);
        if (error) errors.push(error);
      }
      this.active = this.activatedProcesses.size > 0;
      if (errors.length > 0) {
        throw new Error(`Could not deactivate JVM interceptor: ${errors.join('; ')}`);
      }
      console.log('[Interceptor] JVM interceptor deactivated (all processes)');
    }

    this.active = this.activatedProcesses.size > 0;
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      type: 'jvm',
      active: this.active,
      activationUncertain: this._hasUncertainActivation(),
      ...(this._hasRecoveryUncertainty() ? { recoveryUncertain: true } : {}),
      pid: null
    };
  }
}
