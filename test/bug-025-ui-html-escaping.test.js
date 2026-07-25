import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(repoRoot, 'src/ui/app.js'), 'utf8');

function functionSource(name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(`function ${nextName}(`, start + 1);
  assert.notEqual(start, -1, `${name} should exist`);
  assert.notEqual(end, -1, `${nextName} should follow ${name}`);
  return source.slice(start, end);
}

test('Send tabs and response status render untrusted text through DOM properties', () => {
  const tabs = functionSource('renderSendTabs', 'renderSendResponseStatus');
  const status = functionSource('renderSendResponseStatus', 'cloneSendFormFields');

  assert.doesNotMatch(tabs, /innerHTML/);
  assert.match(tabs, /labelEl\.textContent = label/);
  assert.match(tabs, /tabEl\.title = tab\.url/);
  assert.match(status, /badge\.textContent =/);
  assert.match(status, /statusEl\.replaceChildren\(badge\)/);
  assert.doesNotMatch(source, /statusHtml[^\n]*statusMessage/);
});

test('persisted TLS settings are escaped before list markup is parsed', () => {
  assert.match(source, /\$\{esc\(h\)\}<\/span>/);
  assert.match(source, /\$\{esc\(c\.host\)\} &rarr; \$\{esc\(c\.pfxPath\)\}/);
  assert.match(source, /\$\{esc\(c\)\}<\/span>/);
});

test('custom themes discard unknown or unsafe values and build previews with DOM APIs', () => {
  const sanitizer = functionSource('sanitizeCustomThemeData', 'applyCustomThemeData');
  const preview = functionSource('renderCustomThemeSwatches', 'uploadCustomTheme');

  assert.match(sanitizer, /_themeOverridableVars\.indexOf\(varName\) !== -1/);
  assert.match(sanitizer, /isSafeCustomThemeValue\(varName, value\)/);
  assert.doesNotMatch(preview, /innerHTML/);
  assert.match(preview, /swatch\.title =/);
  assert.match(preview, /swatch\.style\.backgroundColor = s\.color/);
  assert.match(source, /JSON\.stringify\(sanitizedTheme\)/);
});
