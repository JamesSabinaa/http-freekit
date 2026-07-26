import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const html = fs.readFileSync(new URL('../src/ui/index.html', import.meta.url), 'utf8');
const voidElements = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr'
]);
const formControls = new Set(['button', 'input', 'select', 'textarea']);

function parseAttributes(source) {
  const attributes = new Map();
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = pattern.exec(source))) {
    attributes.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
}

function parseStaticHtml(source) {
  const root = { tagName: '#document', attributes: new Map(), children: [], parent: null };
  const stack = [root];
  const tokens = source.match(/<!--[\s\S]*?-->|<![^>]*>|<\/?[^>]+>|[^<]+/g) || [];

  for (const token of tokens) {
    if (token.startsWith('<!--') || token.startsWith('<!')) continue;
    if (token.startsWith('</')) {
      const closingName = token.slice(2, -1).trim().toLowerCase();
      while (stack.length > 1 && stack.at(-1).tagName !== closingName) stack.pop();
      if (stack.length > 1) stack.pop();
      continue;
    }
    if (token.startsWith('<')) {
      const match = token.match(/^<\s*([^\s/>]+)([\s\S]*?)\/?\s*>$/);
      if (!match) continue;
      const tagName = match[1].toLowerCase();
      const element = {
        tagName,
        attributes: parseAttributes(match[2]),
        children: [],
        parent: stack.at(-1)
      };
      stack.at(-1).children.push(element);
      if (!voidElements.has(tagName) && !token.endsWith('/>')) stack.push(element);
      continue;
    }

    if (token.trim()) stack.at(-1).children.push({ text: token, parent: stack.at(-1) });
  }

  return root;
}

function elements(root) {
  const result = [];
  const visit = node => {
    if (node.tagName && node.tagName !== '#document') result.push(node);
    for (const child of node.children || []) visit(child);
  };
  visit(root);
  return result;
}

function textContent(node) {
  if (node.text !== undefined) return node.text;
  return (node.children || []).map(textContent).join('').replace(/\s+/g, ' ').trim();
}

const documentRoot = parseStaticHtml(html);
const allElements = elements(documentRoot);
const elementsById = new Map(
  allElements
    .filter(element => element.attributes.has('id'))
    .map(element => [element.attributes.get('id'), element])
);
const labels = allElements.filter(element => element.tagName === 'label');

function labelsFor(control) {
  const associated = [];
  const id = control.attributes.get('id');
  if (id) associated.push(...labels.filter(label => label.attributes.get('for') === id));

  for (let ancestor = control.parent; ancestor; ancestor = ancestor.parent) {
    if (ancestor.tagName === 'label') associated.push(ancestor);
  }

  return [...new Set(associated)];
}

function accessibleName(control) {
  const ariaLabel = control.attributes.get('aria-label')?.trim();
  if (ariaLabel) return ariaLabel;
  return labelsFor(control).map(textContent).filter(Boolean).join(' ').trim();
}

test('core Send and Settings controls derive their expected accessible names', () => {
  const expectedNames = new Map([
    ['sendMethod', 'Request method'],
    ['sendUrl', 'Request URL'],
    ['hideTunnelRequestsToggle', 'Hide TUNNEL / CONNECT requests'],
    ['filterSafeFontsToggle', 'Filter Safe Fonts'],
    ['settingsMinPort', 'Minimum proxy port'],
    ['settingsMaxPort', 'Maximum proxy port'],
    ['tlsPassthroughInput', 'TLS passthrough hostname'],
    ['http2Mode', 'HTTP/2 Support'],
    ['tlsFingerprint', 'Upstream TLS Profile'],
    ['upstreamType', 'Upstream Proxy'],
    ['upstreamDetails', 'Proxy details'],
    ['upstreamNoProxy', 'Non-proxied hosts (optional, comma-separated)'],
    ['bottingToolsProvider', 'BottingTools provider'],
    ['autoRotateProxyOnError', 'Auto rotate proxy on 410 Gone, timeout, or connection failure'],
    ['themeSelect', 'Appearance'],
    ['mcpEnabledToggle', 'Enable MCP']
  ]);

  for (const [id, expectedName] of expectedNames) {
    const control = elementsById.get(id);
    assert.ok(control, `${id} must exist`);
    assert.ok(formControls.has(control.tagName), `${id} must be a form control`);
    assert.equal(accessibleName(control), expectedName, `${id} must have its intended accessible name`);
  }
});

test('visible literal labels target controls and auto-rotate remains a wrapping label', () => {
  for (const label of labels) {
    const targetId = label.attributes.get('for');
    const wrappedControls = elements(label).filter(element => formControls.has(element.tagName));
    const target = targetId ? elementsById.get(targetId) : wrappedControls[0];

    assert.ok(target, `Label "${textContent(label)}" must target or wrap a control`);
    assert.ok(formControls.has(target.tagName), `Label "${textContent(label)}" must target a form control`);
  }

  const autoRotate = elementsById.get('autoRotateProxyOnError');
  assert.equal(autoRotate.parent.tagName, 'label');
  assert.equal(autoRotate.parent.attributes.has('for'), false);
});
