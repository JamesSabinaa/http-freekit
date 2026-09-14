import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { FreshTerminalInterceptor } from '../../../src/interceptors/terminal-interceptors.js';

test('POSIX Fresh Terminal shells add Node trust without replacing tool trust roots', () => {
  const interceptor = new FreshTerminalInterceptor();
  const command = interceptor._buildPosixShellCommand(
    'http://127.0.0.1:8080',
    '/tmp/FreeKit CA.pem',
    {
      reportFile: '/private/freekit/identity.json',
      acknowledgementFile: '/private/freekit/acknowledgement.txt',
      nonce: '0123456789abcdef'
    }
  );

  for (const variable of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'http_proxy',
    'https_proxy',
    'NODE_EXTRA_CA_CERTS'
  ]) {
    assert.match(command, new RegExp(`export ${variable}=`), variable);
  }
  assert.doesNotMatch(command, /export (?:SSL_CERT_FILE|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE)=/);
  assert.match(command, /'\/tmp\/FreeKit CA\.pem'/);
  assert.match(command, /"nonce":"0123456789abcdef","pid":/);
  assert.ok(command.indexOf('freeKitAcknowledged') < command.indexOf('export HTTP_PROXY='));
});

test('macOS target shell clears an override already set by its login environment', t => {
  const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/sh';
  if (!fs.existsSync(shell)) return t.skip('POSIX shell unavailable');
  const interceptor = new FreshTerminalInterceptor();
  const handshake = interceptor._createPosixHandshake();
  t.after(() => interceptor._cleanupTerminalHandshake(handshake));
  fs.writeFileSync(handshake.acknowledgementFile, handshake.nonce);
  const command = interceptor._buildPosixShellCommand('http://127.0.0.1:8080', '/tmp/FreeKit CA.pem', {
    ...handshake,
    reportFile: path.basename(handshake.reportFile),
    acknowledgementFile: path.basename(handshake.acknowledgementFile)
  }, {
    relaunchLoginShell: false,
    ownershipMarkerFile: path.basename(handshake.ownershipMarkerFile)
  });
  const script = 'export NODE_TLS_REJECT_UNAUTHORIZED=0; ' + command +
    '; printf "TLS=%s PROXY=%s\\n" "${NODE_TLS_REJECT_UNAUTHORIZED-unset}" "$HTTP_PROXY"';
  const child = spawnSync(shell, process.platform === 'win32'
    ? ['--noprofile', '--norc', '-c', script] : ['-c', script], {
    cwd: handshake.directory, encoding: 'utf8', windowsHide: true
  });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /TLS=unset PROXY=http:\/\/127\.0\.0\.1:8080/);
});
