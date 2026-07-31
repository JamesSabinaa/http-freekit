import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(repoRoot, 'src/ui/index.html'), 'utf8');
const app = fs.readFileSync(path.join(repoRoot, 'src/ui/app.js'), 'utf8');
const styles = fs.readFileSync(path.join(repoRoot, 'src/ui/styles.css'), 'utf8');

const expectedSections = [
  'general',
  'traffic',
  'proxy',
  'tls',
  'lists',
  'schemas',
  'integrations',
  'about'
];

test('settings sidebar exposes the expected sections in order', () => {
  const sections = [...html.matchAll(/data-settings-nav="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(sections, expectedSections);
});

test('existing settings cards are categorized and Lists contains Default Exclusions', () => {
  const cardSections = [...html.matchAll(/class="card settings-card[^"]*" data-settings-section="([^"]+)"/g)]
    .map(match => match[1]);

  assert.equal(cardSections.length, 16);
  assert.equal(cardSections.includes('lists'), true);
  assert.match(html, /data-settings-section="lists"[\s\S]*?Default Exclusions/);
  for (const section of expectedSections) {
    assert.equal(cardSections.includes(section), true, `No settings cards assigned to ${section}`);
  }
});

test('settings sections have responsive styling and deep-link routing', () => {
  assert.match(styles, /\.settings-layout\s*\{/);
  assert.match(styles, /@media \(max-width: 900px\)[\s\S]*?\.settings-nav\s*\{/);
  assert.match(app, /function switchSettingsSection\(sectionId, updateHash = true\)/);
  assert.match(app, /#\/settings\/['"]? \+ nextSection/);
  assert.match(app, /\^settings\(\?:\\\/\(\[\^\/\]\+\)\)\?\$/);
});
