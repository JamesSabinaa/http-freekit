import assert from 'node:assert/strict';
import test from 'node:test';
import { SystemProxyInterceptor } from '../src/interceptors/system-proxy-interceptor.js';

test('system proxy activation does not mutate settings after a failed snapshot', async () => {
  const interceptor = new SystemProxyInterceptor({ ca: { systemTrustInstalled: true } });
  interceptor._isWindows = () => true;
  interceptor._usesPerMachineProxyPolicy = () => false;
  interceptor._processIdentityLookup = () => ({
    pid: process.pid,
    startedAt: '2026-01-02T03:04:05.000Z',
    executablePath: 'C:\\Program Files\\HTTP FreeKit\\freekit.exe'
  });
  const commands = [];
  interceptor._execRegistry = args => {
    commands.push(args);
    throw new Error('registry query timed out');
  };

  await assert.rejects(interceptor.activate(8080), /registry query timed out/);

  assert.deepEqual(commands, [[
    'query',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
  ]]);
  assert.equal(interceptor.previousSettings, null);
  assert.equal(interceptor.active, false);
});

test('missing proxy values in a readable key are captured as disabled', async () => {
  const interceptor = new SystemProxyInterceptor();
  interceptor._execRegistry = () => `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    MigrateProxy    REG_DWORD    0x1
`;

  assert.deepEqual(await interceptor._readCurrentSettings(), {
    enabled: false,
    server: null,
    override: null
  });
});
