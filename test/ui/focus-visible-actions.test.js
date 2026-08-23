import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const appSource = fs.readFileSync(new URL('../../src/ui/app.js', import.meta.url), 'utf8');
const htmlSource = fs.readFileSync(new URL('../../src/ui/index.html', import.meta.url), 'utf8');
const stylesSource = fs.readFileSync(new URL('../../src/ui/styles.css', import.meta.url), 'utf8');

function sourceBetween(startMarker, endMarker) {
  const start = appSource.indexOf(startMarker);
  const end = appSource.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} must precede ${endMarker}`);
  return appSource.slice(start, end);
}

function nextCssDelimiter(source, start) {
  let quote = null;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    const next = source[index + 1];
    if (quote) {
      if (char === '\\') index++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '/' && next === '*') {
      const commentEnd = source.indexOf('*/', index + 2);
      assert.notEqual(commentEnd, -1, 'CSS comments must be closed');
      index = commentEnd + 1;
      continue;
    }
    if (char === '{' || char === ';') return index;
  }
  return -1;
}

function matchingCssBrace(source, open) {
  let depth = 0;
  let quote = null;
  for (let index = open; index < source.length; index++) {
    const char = source[index];
    const next = source[index + 1];
    if (quote) {
      if (char === '\\') index++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '/' && next === '*') {
      const commentEnd = source.indexOf('*/', index + 2);
      assert.notEqual(commentEnd, -1, 'CSS comments must be closed');
      index = commentEnd + 1;
      continue;
    }
    if (char === '{') depth++;
    if (char === '}' && --depth === 0) return index;
  }
  assert.fail('CSS rule block must be closed');
}

function parseDeclarations(body) {
  const declarations = new Map();
  for (const part of body.split(';')) {
    const colon = part.indexOf(':');
    if (colon < 0) continue;
    const property = part.slice(0, colon).trim();
    const value = part.slice(colon + 1).trim();
    if (property && value) declarations.set(property, value.replace(/\s*!important$/, ''));
  }
  return declarations;
}

function parseTopLevelCssRules(source) {
  const rules = [];
  let cursor = 0;
  while (cursor < source.length) {
    const delimiter = nextCssDelimiter(source, cursor);
    if (delimiter < 0) break;
    if (source[delimiter] === ';') {
      cursor = delimiter + 1;
      continue;
    }
    const close = matchingCssBrace(source, delimiter);
    const prelude = source.slice(cursor, delimiter)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .trim();
    if (prelude && !prelude.startsWith('@')) {
      const declarations = parseDeclarations(source.slice(delimiter + 1, close));
      for (const selector of prelude.split(',').map(value => value.trim()).filter(Boolean)) {
        rules.push({ selector, declarations, order: rules.length });
      }
    }
    cursor = close + 1;
  }
  return rules;
}

const cssRules = parseTopLevelCssRules(stylesSource);

function declarationFor(selector, property) {
  const matches = cssRules.filter(rule =>
    rule.selector === selector && rule.declarations.has(property)
  );
  assert.ok(matches.length > 0, `${selector} must define ${property}`);
  return matches.at(-1).declarations.get(property);
}

function openingTagById(id) {
  const tag = htmlSource.match(new RegExp(`<[^>]+\\bid="${id}"[^>]*>`))?.[0];
  assert.ok(tag, `#${id} must exist`);
  return tag;
}

class TestElement {
  constructor(document, classes = [], parent = null) {
    this.ownerDocument = document;
    this.classes = new Set(classes);
    this.parentElement = parent;
    this.children = [];
    if (parent) parent.children.push(this);
  }

  contains(candidate) {
    for (let current = candidate; current; current = current.parentElement) {
      if (current === this) return true;
    }
    return false;
  }

  focus() { this.ownerDocument.tabTo(this); }

  blur() {
    if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null;
  }
}

class KeyboardDocument {
  constructor() {
    this.activeElement = null;
    this.hovered = new Set();
  }

  element(classes, parent = null) {
    return new TestElement(this, classes, parent);
  }

  tabTo(element) { this.activeElement = element; }
}

function compoundMatches(element, compound) {
  for (const className of compound.matchAll(/\.([\w-]+)/g)) {
    if (!element.classes.has(className[1])) return false;
  }
  const document = element.ownerDocument;
  if (compound.includes(':focus-within') &&
      (!document.activeElement || !element.contains(document.activeElement))) return false;
  if (compound.includes(':focus-visible') && document.activeElement !== element) return false;
  if (compound.includes(':hover') && !document.hovered.has(element)) return false;
  const unsupportedPseudo = [...compound.matchAll(/:([\w-]+)/g)]
    .some(match => !['focus-within', 'focus-visible', 'hover'].includes(match[1]));
  const unsupportedSyntax = compound
    .replace(/\.[\w-]+/g, '')
    .replace(/:[\w-]+/g, '')
    .replaceAll('*', '')
    .trim();
  return !unsupportedPseudo && unsupportedSyntax === '';
}

function selectorMatches(element, selector) {
  if (/[>+~]/.test(selector)) return false;
  const compounds = selector.trim().split(/\s+/);
  let candidate = element;
  if (!compoundMatches(candidate, compounds.at(-1))) return false;
  for (let index = compounds.length - 2; index >= 0; index--) {
    candidate = candidate.parentElement;
    while (candidate && !compoundMatches(candidate, compounds[index])) {
      candidate = candidate.parentElement;
    }
    if (!candidate) return false;
  }
  return true;
}

function specificity(selector) {
  const ids = (selector.match(/#[\w-]+/g) || []).length;
  const classes = (selector.match(/\.[\w-]+/g) || []).length;
  const attributes = (selector.match(/\[[^\]]+\]/g) || []).length;
  const pseudos = (selector.match(/:(?!:)[\w-]+/g) || []).length;
  const classesAndPseudos = classes + attributes + pseudos;
  return ids * 100 + classesAndPseudos * 10;
}

function computedCssValue(element, property) {
  let winner = null;
  for (const rule of cssRules) {
    if (!rule.declarations.has(property) || !selectorMatches(element, rule.selector)) continue;
    const candidate = { value: rule.declarations.get(property), specificity: specificity(rule.selector), order: rule.order };
    if (!winner || candidate.specificity > winner.specificity ||
        (candidate.specificity === winner.specificity && candidate.order > winner.order)) {
      winner = candidate;
    }
  }
  return winner?.value;
}

function actionGroup(document, containerClass) {
  const container = document.element([containerClass]);
  const actions = document.element(['mock-rule-actions'], container);
  const button = document.element(['mock-toggle-btn'], actions);
  return { container, actions, button };
}

function decodedFields(document) {
  const row = document.element(['url-decoded-row']);
  const key = document.element(['url-decoded-key'], row);
  const keyCopy = document.element(['url-decoded-copy'], key);
  const value = document.element(['url-decoded-val'], row);
  const valueCopy = document.element(['url-decoded-copy'], value);
  return { key, keyCopy, value, valueCopy };
}

test('Send method and URL fields retain a visible keyboard focus indicator', () => {
  for (const id of ['sendMethod', 'sendUrl']) {
    assert.doesNotMatch(openingTagById(id), /\bstyle="[^"]*\boutline\s*:/i);
    assert.equal(declarationFor(`#${id}:focus-visible`, 'outline'), '2px solid var(--pop-color)');
    assert.equal(declarationFor(`#${id}:focus-visible`, 'outline-offset'), '-2px');
  }
});

test('brace-aware CSS audit scopes focus reveals to the existing hover containers', () => {
  assert.equal(declarationFor('.url-decoded-copy', 'opacity'), '0');
  assert.equal(declarationFor('.url-decoded-key:hover .url-decoded-copy', 'opacity'), '1');
  assert.equal(declarationFor('.url-decoded-key:focus-within .url-decoded-copy', 'opacity'), '1');
  assert.equal(declarationFor('.url-decoded-val:hover .url-decoded-copy', 'opacity'), '1');
  assert.equal(declarationFor('.url-decoded-val:focus-within .url-decoded-copy', 'opacity'), '1');
  assert.equal(declarationFor('.url-decoded-copy:focus-visible', 'color'), 'var(--pop-color)');

  assert.equal(declarationFor('.mock-rule-actions', 'opacity'), '0');
  assert.equal(declarationFor('.mock-rule-summary:hover .mock-rule-actions', 'opacity'), '1');
  assert.equal(declarationFor('.mock-rule-summary:focus-within .mock-rule-actions', 'opacity'), '1');
  assert.equal(declarationFor('.mock-group-header .mock-rule-actions', 'opacity'), '1');
  assert.equal(declarationFor('*:focus-visible', 'outline'), '2px solid var(--pop-color)');

  const decodedSource = sourceBetween("case 'decoded':", "case 'json':");
  assert.match(decodedSource, /url-decoded-key[\s\S]*?<button class="url-decoded-copy"/);
  assert.match(decodedSource, /url-decoded-val[\s\S]*?<button class="url-decoded-copy"/);
  const mockRowSource = sourceBetween('function renderMockRuleRow', 'function renderMockGroup');
  assert.match(mockRowSource, /mock-rule-summary[\s\S]*?mock-rule-actions[\s\S]*?<button class="mock-toggle-btn"/);
  const mockGroupSource = sourceBetween('function renderMockGroup', 'function _countAllMockRules');
  assert.match(mockGroupSource, /mock-group-header[\s\S]*?mock-rule-actions[\s\S]*?<button class="mock-toggle-btn/);
  const breakpointSource = sourceBetween(
    'function renderBreakpointRuleRow',
    'async function toggleBreakpointRuleEnabled'
  );
  assert.match(breakpointSource, /mock-rule-summary[\s\S]*?mock-rule-actions[\s\S]*?<button class="mock-toggle-btn/);
});

test('Tab focus reveals only the active mock action group and blur hides it again', () => {
  const document = new KeyboardDocument();
  const first = actionGroup(document, 'mock-rule-summary');
  const second = actionGroup(document, 'mock-rule-summary');
  const groupHeader = actionGroup(document, 'mock-group-header');

  assert.equal(computedCssValue(first.actions, 'opacity'), '0');
  assert.equal(computedCssValue(second.actions, 'opacity'), '0');
  assert.equal(computedCssValue(groupHeader.actions, 'opacity'), '1');

  first.button.focus();
  assert.equal(document.activeElement, first.button);
  assert.equal(computedCssValue(first.actions, 'opacity'), '1');
  assert.equal(computedCssValue(second.actions, 'opacity'), '0');
  assert.equal(computedCssValue(first.button, 'outline'), '2px solid var(--pop-color)');

  first.button.blur();
  assert.equal(computedCssValue(first.actions, 'opacity'), '0');
  second.button.focus();
  assert.equal(computedCssValue(first.actions, 'opacity'), '0');
  assert.equal(computedCssValue(second.actions, 'opacity'), '1');
  second.button.blur();
  document.hovered.add(first.container);
  assert.equal(computedCssValue(first.actions, 'opacity'), '1');
  document.hovered.clear();
  assert.equal(computedCssValue(first.actions, 'opacity'), '0');
});

test('Tab focus reveals one decoded copy control and blur restores both hidden states', () => {
  const document = new KeyboardDocument();
  const fields = decodedFields(document);

  assert.equal(computedCssValue(fields.keyCopy, 'opacity'), '0');
  assert.equal(computedCssValue(fields.valueCopy, 'opacity'), '0');

  fields.keyCopy.focus();
  assert.equal(computedCssValue(fields.keyCopy, 'opacity'), '1');
  assert.equal(computedCssValue(fields.valueCopy, 'opacity'), '0');
  assert.equal(computedCssValue(fields.keyCopy, 'color'), 'var(--pop-color)');
  assert.equal(computedCssValue(fields.keyCopy, 'outline'), '2px solid var(--pop-color)');

  fields.keyCopy.blur();
  assert.equal(computedCssValue(fields.keyCopy, 'opacity'), '0');
  fields.valueCopy.focus();
  assert.equal(computedCssValue(fields.keyCopy, 'opacity'), '0');
  assert.equal(computedCssValue(fields.valueCopy, 'opacity'), '1');
  fields.valueCopy.blur();
  assert.equal(computedCssValue(fields.valueCopy, 'opacity'), '0');

  document.hovered.add(fields.key);
  assert.equal(computedCssValue(fields.keyCopy, 'opacity'), '1');
  assert.equal(computedCssValue(fields.valueCopy, 'opacity'), '0');
});
