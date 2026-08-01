import assert from 'node:assert/strict';
import test from 'node:test';

import { ElectronInterceptor } from '../../../src/interceptors/electron-interceptor.js';

const BROAD_TLS_BYPASSES = [
  '--ignore-certificate-errors',
  '--allow-insecure-localhost',
  '--test-type',
  '--ignore-ssl-errors',
  '--disable-web-security',
  '--allow-running-insecure-content'
];

function assertNoBroadTlsBypasses(args) {
  for (const bypass of BROAD_TLS_BYPASSES) {
    assert.equal(args.includes(bypass), false, `${bypass} must not be present`);
  }
}

test('Electron uses only FreeKit SPKI-scoped renderer trust when system trust is unavailable', () => {
  const interceptor = new ElectronInterceptor();
  interceptor.ca = {
    systemTrustInstalled: false,
    getSpkiFingerprint: () => '  freekit-spki  '
  };

  const args = interceptor._getLaunchArgs(8080);

  assert.deepEqual(args, [
    '--proxy-server=http://127.0.0.1:8080',
    '--ignore-certificate-errors-spki-list=freekit-spki'
  ]);
  assertNoBroadTlsBypasses(args);
});

test('system-trusted Electron launch emits no certificate switches', async () => {
  const interceptor = new ElectronInterceptor();
  let fingerprintReads = 0;
  interceptor.ca = {
    systemTrustInstalled: true,
    getSpkiFingerprint: () => {
      fingerprintReads += 1;
      return 'unused-spki';
    }
  };

  const args = interceptor._getLaunchArgs(8080);
  const manual = await interceptor.activate(8080);

  assert.deepEqual(args, ['--proxy-server=http://127.0.0.1:8080']);
  assert.equal(
    args.some(argument => argument.toLowerCase().includes('certificate')),
    false
  );
  assertNoBroadTlsBypasses(args);
  assert.equal(fingerprintReads, 0);
  assert.equal(
    manual.metadata.instructions,
    'Launch your Electron app with:\n  your-app --proxy-server=http://127.0.0.1:8080'
  );
});

test('untrusted Electron launch fails safely when its scoped SPKI is unavailable', async () => {
  const missingFingerprints = [
    null,
    { systemTrustInstalled: false },
    { systemTrustInstalled: false, getSpkiFingerprint: () => '' },
    { systemTrustInstalled: false, getSpkiFingerprint: () => '   ' },
    { systemTrustInstalled: false, getSpkiFingerprint: () => null }
  ];

  for (const ca of missingFingerprints) {
    const interceptor = new ElectronInterceptor();
    interceptor.ca = ca;

    await assert.rejects(
      interceptor.activate(8080),
      /FreeKit CA SPKI fingerprint is unavailable for scoped Electron renderer trust/
    );
  }
});

test('missing scoped SPKI prevents an Electron process from spawning', async () => {
  const interceptor = new ElectronInterceptor();
  interceptor.ca = {
    systemTrustInstalled: false,
    getSpkiFingerprint: () => '',
    getTerminalCaBundlePath: () => process.execPath
  };
  let spawnCalls = 0;
  interceptor._spawn = () => {
    spawnCalls += 1;
    assert.fail('Electron must not spawn without renderer trust');
  };

  await assert.rejects(
    interceptor.activate(8080, { appPath: 'sample-electron-app' }),
    /FreeKit CA SPKI fingerprint is unavailable for scoped Electron renderer trust/
  );
  assert.equal(spawnCalls, 0);
  assert.equal(interceptor.activating, false);
  assert.equal(interceptor.active, false);
  assert.equal(interceptor.process, null);
});
