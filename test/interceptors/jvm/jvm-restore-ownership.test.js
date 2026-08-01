import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { JvmInterceptor } from '../../../src/interceptors/jvm-interceptor.js';
import { CertificateAuthority } from '../../../src/proxy/certificate-authority.js';

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}

async function commandAvailable(command, args) {
  try {
    await run(command, args);
    return true;
  } catch (error) {
    return error.code !== 'ENOENT';
  }
}

test('generated JVM agent restores only proxy and TLS settings it still owns', () => {
  const source = new JvmInterceptor()._getAgentSource();

  assert.match(source, /installedProperties\.put\(property, value\)/);
  assert.match(source, /installedValue\.equals\(System\.getProperty\(property\)\)/);
  assert.match(source, /SSLContext\.getDefault\(\) == installedSslContext/);
  assert.match(source, /getDefaultSSLSocketFactory\(\) == installedSslSocketFactory/);
  assert.match(source, /installedSslContext = context/);
  assert.match(source, /installedSslSocketFactory = socketFactory/);
  assert.doesNotMatch(source, /setDefaultHostnameVerifier/);
});

test('compiled JVM agent preserves external proxy and TLS changes during Stop', async t => {
  if (!await commandAvailable('javac', ['-version'])
      || !await commandAvailable('java', ['-version'])) {
    t.skip('javac and java are required for the generated-agent runtime harness');
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-jvm-ownership-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  t.mock.method(console, 'log', () => {});

  const caDir = path.join(tempDir, 'ca');
  fs.mkdirSync(caDir);
  const ca = new CertificateAuthority(caDir);
  const certInfo = await ca.initialize();
  fs.writeFileSync(path.join(tempDir, 'ProxyAgent.java'), new JvmInterceptor()._getAgentSource());
  fs.writeFileSync(path.join(tempDir, 'OwnershipHarness.java'), String.raw`
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSession;
import javax.net.ssl.SSLSocketFactory;

public class OwnershipHarness {
    private static final String[] PROPERTIES = {
        "http.proxyHost", "http.proxyPort", "http.nonProxyHosts",
        "https.proxyHost", "https.proxyPort"
    };

    private static final class RejectingVerifier implements HostnameVerifier {
        public boolean verify(String hostname, SSLSession session) {
            return false;
        }
    }

    private static final class Baseline {
        private final String[] properties;
        private final SSLContext context;
        private final SSLSocketFactory socketFactory;
        private final HostnameVerifier hostnameVerifier;

        private Baseline(String[] properties, SSLContext context,
                SSLSocketFactory socketFactory, HostnameVerifier hostnameVerifier) {
            this.properties = properties;
            this.context = context;
            this.socketFactory = socketFactory;
            this.hostnameVerifier = hostnameVerifier;
        }
    }

    private static SSLContext newContext() throws Exception {
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(null, null, null);
        return context;
    }

    private static Baseline installBaseline(String tag) throws Exception {
        String[] values = {
            tag + "-http-host", null, tag + "-non-proxy",
            tag + "-https-host", tag + "-https-port"
        };
        for (int index = 0; index < PROPERTIES.length; index++) {
            if (values[index] == null) {
                System.clearProperty(PROPERTIES[index]);
            } else {
                System.setProperty(PROPERTIES[index], values[index]);
            }
        }
        SSLContext context = newContext();
        SSLSocketFactory socketFactory = context.getSocketFactory();
        HostnameVerifier verifier = new RejectingVerifier();
        SSLContext.setDefault(context);
        HttpsURLConnection.setDefaultSSLSocketFactory(socketFactory);
        HttpsURLConnection.setDefaultHostnameVerifier(verifier);
        return new Baseline(values, context, socketFactory, verifier);
    }

    private static String activationArgs(String caPath, String tag) {
        String encodedPath = Base64.getEncoder().encodeToString(
            caPath.getBytes(StandardCharsets.UTF_8)
        );
        return "freekit.action=activate"
            + ",http.proxyHost=" + tag + "-http-host"
            + ",http.proxyPort=" + tag + "-http-port"
            + ",http.nonProxyHosts="
            + ",https.proxyHost=" + tag + "-https-host"
            + ",https.proxyPort=" + tag + "-https-port"
            + ",freekit.caPathBase64=" + encodedPath;
    }

    private static void deactivate() {
        ProxyAgent.agentmain("freekit.action=deactivate", null);
    }

    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    private static void checkProperty(String name, String expected) {
        String actual = System.getProperty(name);
        check(expected == null ? actual == null : expected.equals(actual),
            name + " expected " + expected + " but was " + actual);
    }

    private static void checkBaseline(Baseline baseline) throws Exception {
        for (int index = 0; index < PROPERTIES.length; index++) {
            checkProperty(PROPERTIES[index], baseline.properties[index]);
        }
        check(SSLContext.getDefault() == baseline.context, "SSLContext was not restored");
        check(HttpsURLConnection.getDefaultSSLSocketFactory() == baseline.socketFactory,
            "HTTPS socket factory was not restored");
        check(HttpsURLConnection.getDefaultHostnameVerifier() == baseline.hostnameVerifier,
            "hostname verifier changed");
    }

    private static void unchangedSettingsAreRestored(String caPath) throws Exception {
        Baseline baseline = installBaseline("unchanged");
        ProxyAgent.agentmain(activationArgs(caPath, "freekit-one"), null);
        checkProperty("http.proxyHost", "freekit-one-http-host");
        check(SSLContext.getDefault() != baseline.context, "agent did not install SSLContext");
        check(HttpsURLConnection.getDefaultSSLSocketFactory() != baseline.socketFactory,
            "agent did not install HTTPS socket factory");
        check(HttpsURLConnection.getDefaultHostnameVerifier() == baseline.hostnameVerifier,
            "activation changed hostname verification");
        deactivate();
        checkBaseline(baseline);
        deactivate();
        checkBaseline(baseline);
    }

    private static void mixedExternalChangesArePreserved(String caPath) throws Exception {
        Baseline baseline = installBaseline("mixed");
        ProxyAgent.agentmain(activationArgs(caPath, "freekit-two"), null);
        SSLSocketFactory installedFactory = HttpsURLConnection.getDefaultSSLSocketFactory();

        System.setProperty("http.proxyHost", "application-http-host");
        SSLContext applicationContext = newContext();
        SSLContext.setDefault(applicationContext);
        HostnameVerifier applicationVerifier = new RejectingVerifier();
        HttpsURLConnection.setDefaultHostnameVerifier(applicationVerifier);
        deactivate();

        checkProperty("http.proxyHost", "application-http-host");
        for (int index = 1; index < PROPERTIES.length; index++) {
            checkProperty(PROPERTIES[index], baseline.properties[index]);
        }
        check(SSLContext.getDefault() == applicationContext,
            "application SSLContext was overwritten");
        check(HttpsURLConnection.getDefaultSSLSocketFactory() == baseline.socketFactory,
            "owned HTTPS socket factory was not restored");
        check(installedFactory != baseline.socketFactory, "test did not observe installed factory");
        check(HttpsURLConnection.getDefaultHostnameVerifier() == applicationVerifier,
            "application hostname verifier was overwritten");
        deactivate();
        check(SSLContext.getDefault() == applicationContext,
            "repeated Stop changed the application SSLContext");
    }

    private static void independentFactoryChangeIsPreserved(String caPath) throws Exception {
        Baseline baseline = installBaseline("factory");
        ProxyAgent.agentmain(activationArgs(caPath, "freekit-three"), null);
        SSLSocketFactory applicationFactory = newContext().getSocketFactory();
        HttpsURLConnection.setDefaultSSLSocketFactory(applicationFactory);
        System.setProperty("https.proxyPort", "application-https-port");
        deactivate();

        check(SSLContext.getDefault() == baseline.context, "owned SSLContext was not restored");
        check(HttpsURLConnection.getDefaultSSLSocketFactory() == applicationFactory,
            "application HTTPS socket factory was overwritten");
        checkProperty("https.proxyPort", "application-https-port");
        for (int index = 0; index < PROPERTIES.length - 1; index++) {
            checkProperty(PROPERTIES[index], baseline.properties[index]);
        }
        check(HttpsURLConnection.getDefaultHostnameVerifier() == baseline.hostnameVerifier,
            "hostname verifier changed while preserving a socket factory");
    }

    private static void allExternalProxyChangesArePreserved(String caPath) throws Exception {
        Baseline baseline = installBaseline("properties");
        ProxyAgent.agentmain(activationArgs(caPath, "freekit-four"), null);
        String[] applicationValues = {
            "application-http-host", "application-http-port", "application-non-proxy",
            "application-https-host", null
        };
        for (int index = 0; index < PROPERTIES.length; index++) {
            if (applicationValues[index] == null) {
                System.clearProperty(PROPERTIES[index]);
            } else {
                System.setProperty(PROPERTIES[index], applicationValues[index]);
            }
        }
        deactivate();

        for (int index = 0; index < PROPERTIES.length; index++) {
            checkProperty(PROPERTIES[index], applicationValues[index]);
        }
        check(SSLContext.getDefault() == baseline.context, "owned SSLContext was not restored");
        check(HttpsURLConnection.getDefaultSSLSocketFactory() == baseline.socketFactory,
            "owned HTTPS socket factory was not restored");
        check(HttpsURLConnection.getDefaultHostnameVerifier() == baseline.hostnameVerifier,
            "hostname verifier changed while preserving proxy properties");
    }

    private static void failedAndRepeatedActivationRemainSafe(String caPath) throws Exception {
        Baseline baseline = installBaseline("retry");
        boolean failed = false;
        try {
            ProxyAgent.agentmain(activationArgs(caPath + ".missing", "broken"), null);
        } catch (IllegalStateException expected) {
            failed = true;
        }
        check(failed, "invalid CA path unexpectedly activated");
        checkBaseline(baseline);

        ProxyAgent.agentmain(activationArgs(caPath, "first"), null);
        ProxyAgent.agentmain(activationArgs(caPath, "second"), null);
        checkProperty("http.proxyHost", "second-http-host");
        deactivate();
        checkBaseline(baseline);
    }

    public static void main(String[] args) throws Exception {
        unchangedSettingsAreRestored(args[0]);
        mixedExternalChangesArePreserved(args[0]);
        independentFactoryChangeIsPreserved(args[0]);
        allExternalProxyChangesArePreserved(args[0]);
        failedAndRepeatedActivationRemainSafe(args[0]);
        System.out.println("ownership harness passed");
    }
}
`);

  await run('javac', ['ProxyAgent.java', 'OwnershipHarness.java'], {
    cwd: tempDir,
    timeout: 30_000
  });
  const output = await run('java', ['-cp', tempDir, 'OwnershipHarness', certInfo.certPath], {
    cwd: tempDir,
    timeout: 30_000
  });
  assert.match(output, /ownership harness passed/);
});
