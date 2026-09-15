import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = fs.readFileSync(path.join(repoRoot, 'src/ui/app.js'), 'utf8');

test('certificate browse buttons use Electron absolute-path selection when available', () => {
  assert.match(source, /window\.electronApi\?\.selectFilePath/);
  assert.match(source, /await window\.electronApi\.selectFilePath\(\{/);
  assert.match(source, /if \(selectedPath\) pathInput\.value = selectedPath/);
  assert.match(source, /'clientCertPath',[\s\S]*\['pfx', 'p12', 'pem', 'crt', 'cert'\]/);
  assert.match(source, /'trustedCAPath',[\s\S]*\['pem', 'crt', 'cert', 'der'\]/);
});

test('browser path selection preserves entered server paths and never opens a local file picker', async () => {
  const selected = { value: '/server/certs/client.p12', focus() { this.focused = true; } };
  const button = { style: {} };
  const messages = [];
  const context = vm.createContext({
    window: {},
    document: { getElementById: id => id.endsWith('Browse') ? button : selected },
    toast: message => messages.push(message)
  });
  const start = source.indexOf('async function selectCertificatePath(');
  const end = source.indexOf('async function addClientCert(', start);
  vm.runInContext(source.slice(start, end), context);
  context.initializeCertificatePathPickers();
  assert.equal(button.style.display, 'none');
  await context.browseClientCert();
  await context.browseTrustedCA();
  assert.equal(selected.value, '/server/certs/client.p12');
  assert.equal(selected.focused, true);
  assert.equal(messages.length, 2);
  assert.match(messages[0], /machine running FreeKit/);

  context.window.electronApi = { selectFilePath: async () => 'C:\\certs\\selected.pem' };
  context.initializeCertificatePathPickers();
  assert.equal(button.style.display, '');
  await context.browseTrustedCA();
  assert.equal(selected.value, 'C:\\certs\\selected.pem');
  context.window.electronApi.selectFilePath = async () => null;
  await context.browseClientCert();
  assert.equal(selected.value, 'C:\\certs\\selected.pem', 'cancel preserves the current path');
});
