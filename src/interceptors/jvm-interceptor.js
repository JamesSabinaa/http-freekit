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

export class JvmInterceptor {
  constructor(options = {}) {
    this.id = 'jvm';
    this.name = 'Java/JVM Application';
    this.active = false;
    this.ca = null;
    this.activatedProcesses = new Map(); // pid -> { name, mainClass }
    this.processDiscoveryFailed = false;
    this.agentDir = options.agentDir
      || (options.dataDir
        ? path.join(options.dataDir, 'jvm-agent')
        : path.join(os.tmpdir(), `http-freekit-jvm-agent-${process.pid}`));
  }

  async isActivable() {
    try {
      await execFileAsync('java', ['-version'], { timeout: 5000 });
      // Check if jps is available (comes with JDK)
      await execFileAsync('jps', ['-h'], { timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }

  async isActive() {
    const processes = await this._getRunningProcesses();
    this._syncActivatedProcesses(processes);
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
    this._syncActivatedProcesses(processes);
    return {
      processes,
      activatedProcesses: Array.from(this.activatedProcesses.entries()).map(([pid, info]) => ({
        pid,
        ...info
      }))
    };
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
        "http.proxyHost", "http.proxyPort", "https.proxyHost", "https.proxyPort"
    };
    private static final Map<String, String> originalProperties = new HashMap<String, String>();
    private static SSLContext originalSslContext;
    private static SSLSocketFactory originalSslSocketFactory;
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
            if (value != null) System.setProperty(property, value);
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
            String originalValue = originalProperties.get(property);
            if (originalValue == null) {
                System.clearProperty(property);
            } else {
                System.setProperty(property, originalValue);
            }
        }
        if (originalSslContext != null) SSLContext.setDefault(originalSslContext);
        if (originalSslSocketFactory != null) {
            HttpsURLConnection.setDefaultSSLSocketFactory(originalSslSocketFactory);
        }
        originalProperties.clear();
        originalSslContext = null;
        originalSslSocketFactory = null;
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
        SSLContext.setDefault(context);
        HttpsURLConnection.setDefaultSSLSocketFactory(context.getSocketFactory());
    }
}
`;
  }

  _syncActivatedProcesses(processes) {
    if (this.processDiscoveryFailed) return;
    const runningByPid = new Map(processes.map(process_ => [String(process_.pid), process_]));
    for (const [pid, activated] of this.activatedProcesses) {
      const running = runningByPid.get(String(pid));
      if (!running || running.mainClass !== activated.mainClass) {
        this.activatedProcesses.delete(pid);
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

    if (fs.existsSync(jarPath) && fs.existsSync(stampPath)
      && fs.readFileSync(stampPath, 'utf8') === sourceHash) {
      return jarPath;
    }

    try {
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(javaPath, agentSource);
      fs.writeFileSync(manifestPath, manifest);

      // Compile
      await this._compileAgentJava(javaPath, agentDir);

      // Package into JAR
      await this._packageAgentJar(jarPath, manifestPath, agentDir);
      fs.writeFileSync(stampPath, sourceHash);

      console.log('[Interceptor] JVM proxy agent JAR created at', jarPath);
      return jarPath;
    } catch (err) {
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

  _runAttachHelper(attachDir, pid, agentJar, agentArgs) {
    return execFileAsync(
      'java',
      ['-cp', attachDir, 'AttachProxy', String(pid), agentJar, agentArgs],
      { encoding: 'utf8', timeout: 15000, cwd: attachDir }
    );
  }

  /**
   * Attach the agent to a running JVM process using the Attach API.
   */
  async _attachAgent(pid, proxyHost, proxyPort, action = 'activate') {
    const agentJar = await this._getAgentJarPath();
    if (!agentJar) {
      return { success: false, error: 'Failed to build proxy agent JAR' };
    }

    const agentArgs = this._getAgentArgs(proxyHost, proxyPort, action);

    try {
      const attachDir = await this._ensureAttachHelper();

      // Run the attach program
      const result = await this._runAttachHelper(attachDir, pid, agentJar, agentArgs);
      console.log('[Interceptor] JVM attach result:', result.trim());
      return { success: true };
    } catch (err) {
      console.error(`[Interceptor] Failed to attach agent to PID ${pid}:`, err.message);
      return { success: false, error: err.message };
    }
  }

  async activate(proxyPort, options = {}) {
    const pid = options.pid == null ? null : String(options.pid);

    if (!pid) {
      // No specific process — return metadata with process list for UI selection
      const processes = await this._getRunningProcesses();
      this.active = true;
      return {
        success: true,
        metadata: {
          processes,
          activatedProcesses: Array.from(this.activatedProcesses.entries()).map(([p, info]) => ({
            pid: p,
            ...info
          })),
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

    // Attempt to attach the agent
    const proxyHost = '127.0.0.1';
    const attachResult = await this._attachAgent(pid, proxyHost, proxyPort);

    if (!attachResult.success) {
      // Even if agent attach fails, we can note the process as targeted
      // The user may need to restart the JVM with -javaagent flag instead
      return {
        success: false,
        error: `Could not attach to PID ${pid}: ${attachResult.error}. Try launching the JVM with: -Dhttp.proxyHost=${proxyHost} -Dhttp.proxyPort=${proxyPort} -Dhttps.proxyHost=${proxyHost} -Dhttps.proxyPort=${proxyPort}`,
        metadata: {
          fallbackCommand: `-Dhttp.proxyHost=${proxyHost} -Dhttp.proxyPort=${proxyPort} -Dhttps.proxyHost=${proxyHost} -Dhttps.proxyPort=${proxyPort}`,
          processes: await this._getRunningProcesses(),
          activatedProcesses: Array.from(this.activatedProcesses.entries()).map(([p, info]) => ({
            pid: p,
            ...info
          }))
        }
      };
    }

    this.activatedProcesses.set(pid, {
      name: process_.name,
      mainClass: process_.mainClass
    });
    this.active = true;

    console.log(`[Interceptor] JVM interceptor activated for PID ${pid} (${process_.name})`);

    return {
      success: true,
      metadata: {
        pid,
        name: process_.name,
        mainClass: process_.mainClass,
        proxyUrl: `http://${proxyHost}:${proxyPort}`,
        processes: await this._getRunningProcesses(),
        activatedProcesses: Array.from(this.activatedProcesses.entries()).map(([p, info]) => ({
          pid: p,
          ...info
        }))
      }
    };
  }

  async deactivate(options = {}) {
    const { pid } = options;
    const deactivatePid = async processId => {
      const result = await this._attachAgent(processId, null, null, 'deactivate');
      if (!result.success) {
        return `PID ${processId}: ${result.error}`;
      }
      this.activatedProcesses.delete(processId);
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
      pid: null
    };
  }
}
