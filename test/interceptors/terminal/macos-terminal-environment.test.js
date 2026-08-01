import assert from 'node:assert/strict';
import test from 'node:test';
import { FreshTerminalInterceptor } from '../../../src/interceptors/terminal-interceptors.js';

test('POSIX Fresh Terminal shells receive the complete proxy and CA environment', () => {
  const interceptor = new FreshTerminalInterceptor();
  const command = interceptor._buildPosixShellCommand(
    'http://127.0.0.1:8080',
    '/tmp/FreeKit CA.pem',
    '/tmp/freekit.pid'
  );

  for (const variable of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'http_proxy',
    'https_proxy',
    'SSL_CERT_FILE',
    'NODE_EXTRA_CA_CERTS',
    'REQUESTS_CA_BUNDLE',
    'CURL_CA_BUNDLE'
  ]) {
    assert.match(command, new RegExp(`export ${variable}=`), variable);
  }
  assert.match(command, /'\/tmp\/FreeKit CA\.pem'/);
});
