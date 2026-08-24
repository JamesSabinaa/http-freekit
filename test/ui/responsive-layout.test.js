import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const html = fs.readFileSync(new URL('../../src/ui/index.html', import.meta.url), 'utf8');
const styles = fs.readFileSync(new URL('../../src/ui/styles.css', import.meta.url), 'utf8');

test('client-certificate controls can shrink and wrap at supported window widths', () => {
  assert.match(html, /<div class="client-cert-editor">[\s\S]*?id="clientCertHost"[\s\S]*?id="clientCertPath"[\s\S]*?id="clientCertPassphrase"[\s\S]*?<\/div>/);
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
