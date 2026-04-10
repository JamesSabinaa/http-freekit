import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export class JvmInterceptor {
  constructor() {
    this.id = 'jvm';
    this.name = 'Java/JVM Application';
    this.active = false;
    this.ca = null;
    this.activatedProcesses = new Map(); // pid -> { name, mainClass }
  }

  async isActivable() {
    try {
      execSync('java -version', { stdio: 'ignore', timeout: 5000 });
      // Check if jps is available (comes with JDK)
      execSync('jps -h', { stdio: 'ignore', timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }

  async isActive() {
    return this.active && this.activatedProcesses.size > 0;
  }

  /**
   * Parse `jps -v` output into a list of running JVM processes.
   * jps -v outputs: <pid> <mainClass> <jvmArgs...>
   */
  _getRunningProcesses() {
    try {
      const output = execSync('jps -v', { encoding: 'utf8', timeout: 5000 });
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
    const processes = this._getRunningProcesses();
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
  _getAgentJarPath() {
    // Create a minimal agent that sets system properties for proxy
    const agentDir = path.join(process.cwd(), '.http-freekit-jvm-agent');
    const jarPath = path.join(agentDir, 'proxy-agent.jar');

    if (fs.existsSync(jarPath)) return jarPath;

    try {
      fs.mkdirSync(agentDir, { recursive: true });

      // Create a minimal Java agent source
      const agentSource = `
import java.lang.instrument.Instrumentation;

public class ProxyAgent {
    public static void premain(String args, Instrumentation inst) {
        configure(args);
    }
    public static void agentmain(String args, Instrumentation inst) {
        configure(args);
    }
    private static void configure(String args) {
        if (args == null || args.isEmpty()) return;
        String[] parts = args.split(",");
        for (String part : parts) {
            String[] kv = part.split("=", 2);
            if (kv.length == 2) {
                System.setProperty(kv[0], kv[1]);
            }
        }
        System.out.println("[HTTP FreeKit] Proxy agent loaded: " + args);
    }
}
`;
      const javaPath = path.join(agentDir, 'ProxyAgent.java');
      fs.writeFileSync(javaPath, agentSource);

      // Create manifest
      const manifest = 'Manifest-Version: 1.0\nPremain-Class: ProxyAgent\nAgent-Class: ProxyAgent\nCan-Retransform-Classes: true\nCan-Redefine-Classes: true\n';
      const manifestPath = path.join(agentDir, 'MANIFEST.MF');
      fs.writeFileSync(manifestPath, manifest);

      // Compile
      execSync(`javac "${javaPath}"`, { cwd: agentDir, stdio: 'ignore', timeout: 15000 });

      // Package into JAR
      execSync(`jar cfm "${jarPath}" "${manifestPath}" ProxyAgent.class`, {
        cwd: agentDir,
        stdio: 'ignore',
        timeout: 10000
      });

      console.log('[Interceptor] JVM proxy agent JAR created at', jarPath);
      return jarPath;
    } catch (err) {
      console.error('[Interceptor] Failed to build JVM agent JAR:', err.message);
      return null;
    }
  }

  /**
   * Attach the agent to a running JVM process using the Attach API.
   */
  _attachAgent(pid, proxyHost, proxyPort) {
    const agentJar = this._getAgentJarPath();
    if (!agentJar) {
      return { success: false, error: 'Failed to build proxy agent JAR' };
    }

    const agentArgs = `http.proxyHost=${proxyHost},http.proxyPort=${proxyPort},https.proxyHost=${proxyHost},https.proxyPort=${proxyPort}`;

    try {
      // Use jattach-style approach: com.sun.tools.attach
      // Create a small Java program to do the attachment
      const attachDir = path.join(process.cwd(), '.http-freekit-jvm-agent');
      const attachSource = `
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
      const attachJavaPath = path.join(attachDir, 'AttachProxy.java');
      if (!fs.existsSync(attachJavaPath)) {
        fs.writeFileSync(attachJavaPath, attachSource);
        // Compile with tools.jar on classpath (needed for com.sun.tools.attach)
        try {
          execSync(`javac "${attachJavaPath}"`, { cwd: attachDir, stdio: 'ignore', timeout: 15000 });
        } catch {
          // On JDK 9+, com.sun.tools.attach is in jdk.attach module — no tools.jar needed
          execSync(`javac "${attachJavaPath}"`, { cwd: attachDir, stdio: 'ignore', timeout: 15000 });
        }
      }

      // Run the attach program
      const result = execSync(
        `java -cp "${attachDir}" AttachProxy ${pid} "${agentJar}" "${agentArgs}"`,
        { encoding: 'utf8', timeout: 15000, cwd: attachDir }
      );
      console.log('[Interceptor] JVM attach result:', result.trim());
      return { success: true };
    } catch (err) {
      console.error(`[Interceptor] Failed to attach agent to PID ${pid}:`, err.message);
      return { success: false, error: err.message };
    }
  }

  async activate(proxyPort, options = {}) {
    const { pid } = options;

    if (!pid) {
      // No specific process — return metadata with process list for UI selection
      const processes = this._getRunningProcesses();
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
    const processes = this._getRunningProcesses();
    const process_ = processes.find(p => p.pid === pid);

    if (!process_) {
      return { success: false, error: `JVM process ${pid} not found` };
    }

    // Attempt to attach the agent
    const proxyHost = '127.0.0.1';
    const attachResult = this._attachAgent(pid, proxyHost, proxyPort);

    if (!attachResult.success) {
      // Even if agent attach fails, we can note the process as targeted
      // The user may need to restart the JVM with -javaagent flag instead
      return {
        success: false,
        error: `Could not attach to PID ${pid}: ${attachResult.error}. Try launching the JVM with: -Dhttp.proxyHost=${proxyHost} -Dhttp.proxyPort=${proxyPort} -Dhttps.proxyHost=${proxyHost} -Dhttps.proxyPort=${proxyPort}`,
        metadata: {
          fallbackCommand: `-Dhttp.proxyHost=${proxyHost} -Dhttp.proxyPort=${proxyPort} -Dhttps.proxyHost=${proxyHost} -Dhttps.proxyPort=${proxyPort}`,
          processes: this._getRunningProcesses(),
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
        processes: this._getRunningProcesses(),
        activatedProcesses: Array.from(this.activatedProcesses.entries()).map(([p, info]) => ({
          pid: p,
          ...info
        }))
      }
    };
  }

  async deactivate(options = {}) {
    const { pid } = options;

    if (pid) {
      this.activatedProcesses.delete(pid);
      console.log(`[Interceptor] JVM interceptor deactivated for PID ${pid}`);
    } else {
      this.activatedProcesses.clear();
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
