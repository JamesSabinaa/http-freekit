import assert from 'node:assert/strict';
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
