import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const appSource = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'index.html'), 'utf8');

function extractFunction(name, nextMarker) {
  const start = appSource.indexOf(`function ${name}(`);
  const end = appSource.indexOf(nextMarker, start);
  assert.ok(start >= 0 && end > start, `${name} must be present`);
  return appSource.slice(start, end);
}

test('all sortable and collapsible headers are focusable keyboard controls', () => {
  const sortableHeaders = [...html.matchAll(/<th role="columnheader" class="sortable"[^>]*>/g)].map(match => match[0]);
  assert.equal(sortableHeaders.length, 4);
  for (const header of sortableHeaders) {
    assert.match(header, /aria-sort="none"/);
    assert.match(header, /tabindex="0"/);
    assert.match(header, /onclick="sortBy\('[^']+'\)"/);
    assert.match(header, /onkeydown="activateOnKeyboard\(event\)"/);
  }

  const sendHeaders = [...html.matchAll(/<div class="card-header"[^>]*role="button"[^>]*aria-controls="send(?:Headers|Body|Export)Body"[^>]*>/g)].map(match => match[0]);
  assert.equal(sendHeaders.length, 3);
  for (const header of sendHeaders) {
    assert.match(header, /tabindex="0"/);
    assert.match(header, /aria-expanded="(?:true|false)"/);
    assert.match(header, /onkeydown="activateOnKeyboard\(event\)"/);
  }
});

test('keyboard activation clicks once and ignores repeats and nested controls', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(`
    ${extractFunction('activateOnKeyboard', 'const API_BASE')}
    globalThis.activate = activateOnKeyboard;
  `, context);

  let clicks = 0;
  let prevented = 0;
  const control = { click: () => { clicks++; } };
  const event = key => ({
    key,
    target: control,
    currentTarget: control,
    repeat: false,
    preventDefault: () => { prevented++; }
  });

  context.activate(event('Enter'));
  context.activate(event(' '));
  context.activate({ ...event('Enter'), repeat: true });
  context.activate({ ...event('Enter'), target: {} });
  context.activate(event('Escape'));

  assert.equal(clicks, 2);
  assert.equal(prevented, 3);
});

test('Send card visibility and aria-expanded stay synchronized', () => {
  const attributes = new Map();
  const header = {
    classList: { contains: value => value === 'card-header' },
    setAttribute: (name, value) => attributes.set(name, value)
  };
  const content = { style: { display: 'block' }, previousElementSibling: header };
  const arrow = { style: {} };
  const context = {
    document: {
      getElementById: id => id === 'sendBodyBody' ? content : id === 'sendBodyArrow' ? arrow : null
    }
  };
  vm.createContext(context);
  vm.runInContext(`
    ${extractFunction('setSendCardExpanded', 'function formatToContentType')}
    globalThis.setExpanded = setSendCardExpanded;
    globalThis.toggle = toggleSendCard;
  `, context);

  context.toggle('sendBodyBody');
  assert.equal(content.style.display, 'none');
  assert.equal(arrow.style.transform, 'rotate(-90deg)');
  assert.equal(attributes.get('aria-expanded'), 'false');

  context.toggle('sendBodyBody');
  assert.equal(content.style.display, 'block');
  assert.equal(arrow.style.transform, 'rotate(0deg)');
  assert.equal(attributes.get('aria-expanded'), 'true');

  assert.match(appSource, /updateSendMethodColor\(\)[\s\S]*?setSendCardExpanded\('sendBodyBody', false\)[\s\S]*?setSendCardExpanded\('sendBodyBody', true\)/);
});
