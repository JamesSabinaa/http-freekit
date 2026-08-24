import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  applyManualSystemCaTrustAcknowledgement,
  isManualSystemCaTrustAcknowledged
} from '../../src/proxy/manual-system-ca-trust.js';

test('non-Windows system CA trust requires one exact explicit acknowledgement', () => {
  for (const platform of ['darwin', 'linux']) {
    assert.equal(isManualSystemCaTrustAcknowledged(platform, {
      HTTP_FREEKIT_SYSTEM_CA_TRUSTED: '1'
    }), true);
    for (const value of [undefined, '', '0', 'true', 'yes', ' 1 ']) {
      assert.equal(isManualSystemCaTrustAcknowledged(platform, {
        HTTP_FREEKIT_SYSTEM_CA_TRUSTED: value
      }), false);
    }
  }
});

test('the manual acknowledgement cannot bypass Windows trust installation', () => {
  assert.equal(isManualSystemCaTrustAcknowledged('win32', {
    HTTP_FREEKIT_SYSTEM_CA_TRUSTED: '1'
  }), false);
});

function createCa({ fingerprint = 'current-fingerprint', replacementPending = false } = {}) {
  return {
    systemTrustInstalled: false,
    acknowledged: 0,
    getCertInfo() {
      return {
        certificateFingerprint: fingerprint,
        certificateReplacementPending: replacementPending
      };
    },
    acknowledgeReplacementMigration() {
      this.acknowledged++;
      replacementPending = false;
    }
  };
}

test('a manual acknowledgement never trusts a CA generated during the same startup', () => {
  const ca = createCa({ replacementPending: true });
  const warnings = [];
  const result = applyManualSystemCaTrustAcknowledgement({
    ca,
    initialization: { fingerprint: 'current-fingerprint', generatedCa: true },
    platform: 'darwin',
    environment: { HTTP_FREEKIT_SYSTEM_CA_TRUSTED: '1' },
    logger: { warn: message => warnings.push(message) }
  });

  assert.equal(result.trusted, false);
  assert.equal(ca.systemTrustInstalled, false);
  assert.equal(ca.acknowledged, 0);
  assert.equal(ca.getCertInfo().certificateReplacementPending, true);
  assert.match(warnings[0], /generated during this startup/);
});

test('a later fingerprint-matched acknowledgement trusts the CA and clears migration state', () => {
  const ca = createCa({ replacementPending: true });
  const result = applyManualSystemCaTrustAcknowledgement({
    ca,
    initialization: { fingerprint: 'current-fingerprint', generatedCa: false },
    platform: 'linux',
    environment: { HTTP_FREEKIT_SYSTEM_CA_TRUSTED: '1' }
  });

  assert.equal(result.trusted, true);
  assert.equal(ca.systemTrustInstalled, true);
  assert.equal(ca.acknowledged, 1);
  assert.equal(ca.getCertInfo().certificateReplacementPending, false);
});

test('a stale initialization fingerprint cannot authorize system trust', () => {
  const ca = createCa({ fingerprint: 'replacement-fingerprint', replacementPending: true });
  const result = applyManualSystemCaTrustAcknowledgement({
    ca,
    initialization: { fingerprint: 'stale-fingerprint', generatedCa: false },
    platform: 'linux',
    environment: { HTTP_FREEKIT_SYSTEM_CA_TRUSTED: '1' },
    logger: { warn() {} }
  });

  assert.equal(result.trusted, false);
  assert.equal(ca.systemTrustInstalled, false);
  assert.equal(ca.acknowledged, 0);
});

test('startup applies the fingerprint-safe acknowledgement helper', () => {
  const source = fs.readFileSync('src/index.js', 'utf8');
  assert.match(source, /applyManualSystemCaTrustAcknowledgement\(\{/);
  assert.match(source, /HTTP_FREEKIT_SYSTEM_CA_TRUSTED=1 was explicitly set/);
});
