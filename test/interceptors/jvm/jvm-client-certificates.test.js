import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { promisify } from 'node:util';
import test from 'node:test';
import { JvmInterceptor } from '../../../src/interceptors/jvm-interceptor.js';
import { CertificateAuthority } from '../../../src/proxy/certificate-authority.js';

const exec = promisify(execFile);
const run = (command, args, cwd) => exec(command, args, { cwd, windowsHide: true, timeout: 30000 });

test('generated agent loads standard JSSE identity properties before installing its TLS context', () => {
  const source = new JvmInterceptor()._getAgentSource();
  for (const property of ['keyStore', 'keyStoreType', 'keyStoreProvider', 'keyStorePassword']) {
    assert.ok(source.includes(`System.getProperty("javax.net.ssl.${property}"`));
  }
  assert.match(source, /context\.init\(configuredKeyManagers\(\),/);
  assert.match(source, /KeyManagerFactory\.getDefaultAlgorithm\(\)/);
  assert.match(source, /Arrays\.fill\(password, '\\0'\)/);
});

test('compiled agent retains JKS and PKCS12 client identities through activation and rollback', { timeout: 120000 }, async t => {
  try { await run('javac', ['-version']); }
  catch (error) { if (error.code === 'ENOENT') return t.skip('JDK javac is unavailable'); throw error; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freekit-jvm-mtls-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const password = 'fixture-password';
  await run('keytool', ['-genkeypair', '-alias', 'client', '-dname', 'CN=fixture-client',
    '-keyalg', 'RSA', '-keysize', '2048', '-validity', '2', '-ext', 'EKU=clientAuth',
    '-keystore', 'client.jks', '-storetype', 'JKS', '-storepass', password, '-keypass', password], dir);
  await run('keytool', ['-exportcert', '-rfc', '-alias', 'client', '-keystore', 'client.jks',
    '-storepass', password, '-file', 'client.pem'], dir);
  await run('keytool', ['-importkeystore', '-srckeystore', 'client.jks', '-srcstoretype', 'JKS',
    '-srcstorepass', password, '-destkeystore', 'client.p12', '-deststoretype', 'PKCS12',
    '-deststorepass', password, '-noprompt'], dir);
  const roots = [];
  const servers = [];
  const identities = [];
  const sockets = new Set();
  t.after(() => { for (const socket of sockets) socket.destroy(); for (const server of servers) server.close(); });
  for (const name of ['baseline', 'freekit']) {
    fs.mkdirSync(path.join(dir, name));
    const ca = new CertificateAuthority(path.join(dir, name));
    await ca.initialize();
    roots.push(ca.getCertInfo().certificatePath);
    const cert = await ca.generateCertForHost('localhost');
    const server = tls.createServer({ ...cert, ca: fs.readFileSync(path.join(dir, 'client.pem')),
      requestCert: true, rejectUnauthorized: true }, socket => {
      identities.push(socket.getPeerCertificate().subject.CN);
      socket.end('ok');
    });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    server.on('tlsClientError', () => {});
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    servers.push(server);
  }
  await run('keytool', ['-importcert', '-alias', 'server-ca', '-file', roots[0],
    '-keystore', 'trust.jks', '-storetype', 'JKS', '-storepass', password, '-noprompt'], dir);
  fs.writeFileSync(path.join(dir, 'ProxyAgent.java'), new JvmInterceptor()._getAgentSource());
  fs.writeFileSync(path.join(dir, 'ClientIdentityHarness.java'), String.raw`
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import javax.net.ssl.*;
public class ClientIdentityHarness {
    private static void connect(int port, boolean httpsFactory) throws Exception {
        SSLSocketFactory factory = httpsFactory ? HttpsURLConnection.getDefaultSSLSocketFactory()
                : SSLContext.getDefault().getSocketFactory();
        try (SSLSocket socket = (SSLSocket) factory.createSocket("127.0.0.1", port)) {
            socket.setSoTimeout(5000);
            socket.startHandshake();
            if (socket.getInputStream().read() != 'o') throw new AssertionError("missing authenticated response");
        }
    }
    public static void main(String[] args) throws Exception {
        int baseline = Integer.parseInt(args[0]);
        int freekit = Integer.parseInt(args[1]);
        String agentArgs = "http.proxyHost=fixture-proxy,http.proxyPort=8080,freekit.caPathBase64="
                + Base64.getEncoder().encodeToString(args[2].getBytes(StandardCharsets.UTF_8));
        SSLContext original = SSLContext.getDefault();
        SSLSocketFactory originalFactory = HttpsURLConnection.getDefaultSSLSocketFactory();
        for (boolean httpsFactory : new boolean[] { false, true }) connect(baseline, httpsFactory);
        ProxyAgent.agentmain(agentArgs, null);
        for (boolean httpsFactory : new boolean[] { false, true }) {
            connect(baseline, httpsFactory);
            connect(freekit, httpsFactory);
        }
        ProxyAgent.agentmain("freekit.action=deactivate", null);
        if (SSLContext.getDefault() != original || HttpsURLConnection.getDefaultSSLSocketFactory() != originalFactory)
            throw new AssertionError("original TLS objects were not restored");
        for (String property : new String[] { "javax.net.ssl.keyStorePassword", "javax.net.ssl.keyStoreProvider", "javax.net.ssl.keyStore" }) {
            String saved = System.getProperty(property);
            System.setProperty(property, "missing-or-invalid");
            boolean failed = false;
            try { ProxyAgent.agentmain(agentArgs, null); } catch (IllegalStateException expected) { failed = true; }
            if (saved == null) System.clearProperty(property); else System.setProperty(property, saved);
            if (!failed || SSLContext.getDefault() != original || System.getProperty("http.proxyHost") != null)
                throw new AssertionError("failed identity loading did not roll back");
            connect(baseline, false);
        }
        connect(baseline, true);
        System.out.println("IDENTITY_OK");
    }
}
`);
  await run('javac', ['-source', '8', '-target', '8', 'ProxyAgent.java', 'ClientIdentityHarness.java'], dir);
  for (const [file, type, provider] of [['client.jks', 'JKS', 'SUN'], ['client.p12', 'PKCS12', '']]) {
    const { stdout } = await run('java', [
      `-Djavax.net.ssl.keyStore=${path.join(dir, file)}`, `-Djavax.net.ssl.keyStoreType=${type}`,
      `-Djavax.net.ssl.keyStoreProvider=${provider}`, `-Djavax.net.ssl.keyStorePassword=${password}`,
      `-Djavax.net.ssl.trustStore=${path.join(dir, 'trust.jks')}`, `-Djavax.net.ssl.trustStorePassword=${password}`,
      '-cp', dir, 'ClientIdentityHarness', String(servers[0].address().port), String(servers[1].address().port), roots[1]
    ], dir);
    assert.match(stdout, /IDENTITY_OK/);
    assert.ok(!stdout.includes(password));
  }
  assert.equal(identities.length, 20);
  assert.ok(identities.every(identity => identity === 'fixture-client'));
});
