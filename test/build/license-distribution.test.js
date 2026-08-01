import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import test from 'node:test';

const require = createRequire(import.meta.url);
const builderConfig = require('../../electron-builder.config.cjs');
const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const license = fs.readFileSync('LICENSE', 'utf8');
const readme = fs.readFileSync('README.md', 'utf8');

test('MIT terms accompany repository, npm, and desktop distributions', () => {
  assert.equal(packageJson.license, 'MIT');
  assert.match(license, /^MIT License\r?\n/);
  assert.match(license, /Copyright \(c\) 2026 James Sabina and HTTP FreeKit contributors/);
  assert.match(license, /Permission is hereby granted, free of charge/);
  assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS"/);
  assert.ok(builderConfig.files.includes('LICENSE'));
  assert.match(readme, /## License\r?\n\r?\n\[MIT\]\(LICENSE\)/);
});
