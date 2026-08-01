import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BrowserInterceptor } from '../../../src/interceptors/browser-interceptor.js';

const EXPECTED_FIREFOX_PREFS = [
  'user_pref("network.proxy.type", 1);',
  'user_pref("network.proxy.http", "127.0.0.1");',
  'user_pref("network.proxy.http_port", 8123);',
  'user_pref("network.proxy.ssl", "127.0.0.1");',
  'user_pref("network.proxy.ssl_port", 8123);',
  'user_pref("network.proxy.no_proxies_on", "");',
  'user_pref("security.enterprise_roots.enabled", true);',
  'user_pref("browser.shell.checkDefaultBrowser", false);',
  'user_pref("browser.startup.homepage_override.mstone", "ignore");',
  'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
  'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);',
  'user_pref("app.normandy.first_run", false);',
  'user_pref("browser.aboutwelcome.enabled", false);'
];

const REMOVED_SECURITY_PREFS = [
  'security.cert_pinning.enforcement_level',
  'security.mixed_content.block_active_content',
  'security.OCSP.enabled',
  'security.OCSP.require'
];

function createFirefoxInterceptor(t, { systemTrustInstalled, runCertutil }) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-firefox-security-'));
  t.after(() => fs.rmSync(profileDir, { recursive: true, force: true }));

  const interceptor = new BrowserInterceptor('firefox', 'Firefox', 'firefox');
  interceptor.profileDir = profileDir;
  interceptor.ca = {
    systemTrustInstalled,
    getCertInfo: () => ({ certificatePath: path.join(profileDir, 'freekit-ca.pem') })
  };
  interceptor._runCertutil = runCertutil;
  return { interceptor, profileDir };
}

function assertExactSafeProfile(profileDir) {
  const prefs = fs.readFileSync(path.join(profileDir, 'user.js'), 'utf8');
  assert.deepEqual(prefs.split('\n'), EXPECTED_FIREFOX_PREFS);
  for (const pref of REMOVED_SECURITY_PREFS) {
    assert.equal(prefs.includes(`user_pref("${pref}"`), false, `${pref} must use the Firefox default`);
  }
}

test('isolated Firefox keeps exact proxy and CA trust prefs without global security relaxations', async (t) => {
  const certutilCalls = [];
  const { interceptor, profileDir } = createFirefoxInterceptor(t, {
    systemTrustInstalled: false,
    runCertutil: async args => { certutilCalls.push(args); }
  });

  const args = await interceptor._getFirefoxArgs(8123, { url: 'https://example.test/' });

  assertExactSafeProfile(profileDir);
  assert.deepEqual(args, [
    '-profile', profileDir,
    '-no-remote',
    '-url', 'https://example.test/'
  ]);
  assert.deepEqual(certutilCalls, [
    ['-d', `sql:${profileDir}`, '-N', '--empty-password'],
    [
      '-d', `sql:${profileDir}`,
      '-A',
      '-t', 'CT,,',
      '-n', 'HTTP FreeKit CA',
      '-i', path.join(profileDir, 'freekit-ca.pem')
    ]
  ]);
});

test('system-trusted Firefox fallback retains the safe exact profile when certutil is unavailable', async (t) => {
  let certutilCalls = 0;
  const { interceptor, profileDir } = createFirefoxInterceptor(t, {
    systemTrustInstalled: true,
    runCertutil: async () => {
      certutilCalls++;
      throw new Error('certutil unavailable');
    }
  });

  const args = await interceptor._getFirefoxArgs(8123, {});

  assertExactSafeProfile(profileDir);
  assert.deepEqual(args, ['-profile', profileDir, '-no-remote']);
  assert.equal(certutilCalls, 1);
});
