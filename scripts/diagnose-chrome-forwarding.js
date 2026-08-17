import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http2 from 'node:http2';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { trackClientHellos } from 'read-tls-client-hello';

import { CertificateAuthority } from '../src/proxy/certificate-authority.js';
import { ProxyServer } from '../src/proxy/proxy-server.js';

const CHROME_PATH = process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

async function listen(server, hostname = '127.0.0.1') {
  server.listen(0, hostname);
  await once(server, 'listening');
  return server.address().port;
}

function runChrome(url, profileDir, proxyPort) {
  const args = [
    '--headless=new',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-gpu',
    '--disable-sync',
    '--ignore-certificate-errors',
    '--metrics-recording-only',
    '--no-default-browser-check',
    '--no-first-run',
    `--user-data-dir=${profileDir}`,
    ...(proxyPort
      ? [
          `--proxy-server=http://127.0.0.1:${proxyPort}`,
          '--proxy-bypass-list=<-loopback>'
        ]
      : []),
    '--dump-dom',
    url
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(CHROME_PATH, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', chunk => {
      if (stderr.length < 4096) stderr += chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`Chrome exited with ${code}: ${stderr.trim()}`));
    });
  });
}

function summarizeHello(hello) {
  if (!hello) return null;
  const ecPointFormats = hello.extensions
    ?.find(extension => extension.id === 11)?.data?.formats;
  return {
    ja3: hello.ja3,
    ja4: hello.ja4,
    cipherSuites: hello.cipherSuites,
    extensionIds: hello.extensions?.map(extension => extension.id),
    ecPointFormats
  };
}

async function main() {
  try {
    os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    // Priority changes are best-effort on restricted hosts.
  }

  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'http-freekit-chrome-diag-'));
  const directProfile = path.join(dataDir, 'chrome-direct');
  const proxiedProfile = path.join(dataDir, 'chrome-proxied');
  const ca = new CertificateAuthority(dataDir);
  await ca.initialize();
  const certificate = await ca.generateCertForHost('localhost');
  const observations = new Map();
  const settingsBySession = new WeakMap();

  const origin = http2.createSecureServer({
    key: certificate.key,
    cert: certificate.cert,
    allowHTTP1: true
  });
  trackClientHellos(origin);
  origin.on('session', session => {
    settingsBySession.set(session, session.remoteSettings);
    session.on('remoteSettings', settings => settingsBySession.set(session, settings));
  });
  origin.on('stream', (stream, headers) => {
    const label = headers[':path']?.slice(1);
    observations.set(label, {
      tls: summarizeHello(stream.session.socket.tlsClientHello),
      h2Settings: settingsBySession.get(stream.session),
      connectionWindowSize: stream.session.state?.remoteWindowSize,
      headerOrder: Object.keys(headers)
    });
    stream.respond({ ':status': 200, 'content-type': 'text/plain' });
    stream.end('ok');
  });
  const originPort = await listen(origin);

  const proxy = new ProxyServer(ca, { port: 0 });
  proxy.setTlsFingerprint('passthrough');
  proxy.setHttp2Config('h2-only');
  proxy.setHttpsWhitelist(['localhost']);
  await proxy.start();
  const proxyPort = proxy.server.address().port;

  try {
    await runChrome(`https://localhost:${originPort}/direct`, directProfile);
    await runChrome(`https://localhost:${originPort}/proxied`, proxiedProfile, proxyPort);
    console.log(JSON.stringify({
      runtime: { node: process.version, openssl: process.versions.openssl },
      direct: observations.get('direct'),
      proxied: observations.get('proxied')
    }, null, 2));
  } finally {
    await proxy.stop();
    await new Promise(resolve => origin.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
}

await main();
