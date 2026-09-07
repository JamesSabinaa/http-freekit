import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const html = fs.readFileSync(new URL('../../src/ui/index.html', import.meta.url), 'utf8');
const styles = fs.readFileSync(new URL('../../src/ui/styles.css', import.meta.url), 'utf8');

test('client-certificate controls can shrink and wrap at supported window widths', () => {
  const editor = [...html.matchAll(/<div class="client-cert-editor">([\s\S]*?)<\/div>/g)]
    .map(match => match[1])
    .find(content => content.includes('id="clientCertHost"'));
  assert.ok(editor, 'Client Certificates must use the responsive editor wrapper');
  for (const id of ['clientCertHost', 'clientCertPath', 'clientCertPassphrase']) {
    const input = editor.match(new RegExp(`<input\\b[^>]*id="${id}"[^>]*>`))?.[0];
    assert.ok(input, `${id} must belong to the responsive editor`);
    assert.doesNotMatch(input, /\bstyle="[^"]*\bflex(?:-basis)?\s*:/,
      `${id} must not override the responsive flex basis`);
  }
  assert.match(editor, /onclick="browseClientCert\(\)"/);
  assert.match(editor, /onclick="addClientCert\(\)"/);
  assert.match(styles, /\.client-cert-editor\s*\{[\s\S]*?flex-wrap:\s*wrap;[\s\S]*?gap:\s*8px;[\s\S]*?\}/);
  assert.match(styles, /\.client-cert-editor input\s*\{[\s\S]*?flex:\s*1 1 150px;[\s\S]*?min-width:\s*0;[\s\S]*?\}/);
});

test('Mock page actions wrap into a reachable narrow-width toolbar', () => {
  assert.match(html, /class="mock-page-title"/);
  assert.match(html, /class="mock-page-tip"/);
  assert.match(html, /class="mock-page-actions"/);
  assert.match(styles, /\.mock-page-header\s*\{[\s\S]*?flex-wrap:\s*wrap;[\s\S]*?\}/);
  assert.match(styles, /\.mock-page-actions\s*\{[\s\S]*?flex-wrap:\s*wrap;[\s\S]*?\}/);
  assert.match(styles, /@media \(max-width:\s*768px\)[\s\S]*?\.mock-page-title,[\s\S]*?\.mock-page-actions\s*\{[\s\S]*?flex-basis:\s*100%;/);
});
