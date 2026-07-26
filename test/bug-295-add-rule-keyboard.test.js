import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../src/ui/index.html', import.meta.url), 'utf8');
const styles = fs.readFileSync(new URL('../src/ui/styles.css', import.meta.url), 'utf8');

function blockFor(selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...styles.matchAll(new RegExp(`${escapedSelector}\\s*\\{([\\s\\S]*?)\\}`, 'g'))];
  assert.ok(matches.length, `${selector} styles must exist`);
  return matches.at(-1)[1];
}

test('Add Rule is one native button with standard keyboard activation semantics', () => {
  const controls = [...html.matchAll(/<button\b[^>]*\bid="addRuleTrigger"[^>]*>[\s\S]*?<\/button>/g)];

  assert.equal(controls.length, 1);
  const control = controls[0][0];
  assert.match(control, /\btype="button"/);
  assert.match(control, /\bclass="mock-add-rule-row"/);
  assert.match(control, /\bonclick="addNewMockRule\(\)"/);
  assert.match(control, />[\s\S]*Add a new rule to rewrite requests or responses[\s\S]*<\/button>/);
  assert.doesNotMatch(control, /\b(?:role|tabindex|onkeydown|onkeyup)=/);
  assert.doesNotMatch(html, /<div\b[^>]*\bid="addRuleTrigger"/);
  assert.equal((control.match(/addNewMockRule\(\)/g) || []).length, 1);
});

test('each native click activation invokes the existing Add Rule action exactly once', () => {
  const control = html.match(/<button\b[^>]*\bid="addRuleTrigger"[^>]*>/)?.[0];
  assert.ok(control);
  const inlineAction = control.match(/\bonclick="([^"]+)"/)?.[1];
  assert.equal(inlineAction, 'addNewMockRule()');

  let additions = 0;
  const context = { addNewMockRule: () => { additions += 1; } };
  vm.createContext(context);

  for (const activation of ['pointer', 'Enter', 'Space']) {
    vm.runInContext(inlineAction, context, { filename: `${activation}-native-click.js` });
  }
  assert.equal(additions, 3);
});

test('Add Rule preserves its themed layout and has an explicit visible focus treatment', () => {
  const base = blockFor('.mock-add-rule-row');
  const focus = blockFor('.mock-add-rule-row:focus-visible');

  assert.match(base, /appearance:\s*none/);
  assert.match(base, /-webkit-appearance:\s*none/);
  assert.match(base, /font:\s*inherit/);
  assert.match(base, /display:\s*flex/);
  assert.match(base, /width:\s*100%/);
  assert.match(base, /background:\s*transparent/);
  assert.match(focus, /outline:\s*2px solid var\(--pop-color\)/);
  assert.match(focus, /outline-offset:\s*2px/);
  assert.match(focus, /border-color:\s*var\(--pop-color\)/);

  assert.match(styles, /\[data-theme="light"\] \.mock-add-rule-row\s*\{/);
  assert.match(styles, /\[data-theme="high-contrast"\] \.mock-add-rule-row\s*\{/);
});
