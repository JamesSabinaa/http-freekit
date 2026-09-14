import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const renderStart = source.indexOf('function filterInterceptors(');
const renderEnd = source.indexOf('async function handleExpandableCardClick(', renderStart);
assert.ok(renderStart >= 0 && renderEnd > renderStart, 'interceptor renderer must exist');

class FakeCard {
  constructor() {
    this.attributes = new Map();
    this.className = '';
    this.dataset = {};
    this.style = {};
    this.classList = { remove: name => {
      this.className = this.className.split(/\s+/).filter(value => value !== name).join(' ');
    } };
    this.innerHTML = '';
    this.primaryAction = null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  querySelector(selector) {
    if (selector !== 'button.intercept-card-primary' && selector !== '.intercept-card-primary') return null;
    if (!/<button\b[^>]*class="intercept-card-primary"/.test(this.innerHTML)) return null;
    this.primaryAction ||= { onclick: null };
    return this.primaryAction;
  }
}

function renderCards({ expanded = false, proxyAddress, toast = () => {} } = {}) {
  const cards = [];
  const grid = {
    querySelectorAll: () => [],
    appendChild: card => cards.push(card)
  };
  const interceptor = {
    id: 'terminal',
    name: 'Existing Terminal',
    active: true,
    activable: true,
    focusable: false,
    supported: true
  };
  const context = {
    allInterceptors: [interceptor],
    BROWSER_DOWNLOAD_URLS: {},
    EXPANDABLE_INTERCEPTORS: new Set(['terminal']),
    INTERCEPTOR_DESCRIPTIONS: { terminal: ['Configure a terminal session.'] },
    INTERCEPTOR_ICONS: { terminal: '<svg></svg>' },
    INTERCEPTOR_TAGS: { terminal: [] },
    MANUAL_SETUP_ICON: '<svg></svg>',
    config: { proxyPort: 8310, proxyAddress },
    expandedInterceptorId: expanded ? 'terminal' : null,
    expandedInterceptorMetadata: null,
    interceptorsInProgress: new Set(),
    interceptorSelectionGeneration: 0,
    document: {
      createElement: () => new FakeCard(),
      getElementById: id => id === 'interceptPageGrid' ? grid : {}
    },
    esc: String,
    escapeHtmlAttribute: String,
    handleExpandableCardClick: () => {},
    toggleInterceptor: () => {},
    focusInterceptor: () => {},
    downloadBrowser: () => {},
    renderAndroidInterceptorStatusPills: () => '',
    renderInterceptorConfig: () => {},
    toast
  };
  vm.createContext(context);
  vm.runInContext(`${source.slice(renderStart, renderEnd)}; globalThis.render = filterInterceptors;`, context);
  context.render();
  return cards;
}

function primaryButtonHtml(card) {
  return card.innerHTML.match(/<button\b[^>]*class="intercept-card-primary"[\s\S]*?<\/button>/)?.[0] || '';
}

test('manual setup uses the server-advertised proxy authority', () => {
  for (const authority of ['[::1]:8310', '192.0.2.10:8310', '127.0.0.1:8310']) {
    const messages = [];
    const cards = renderCards({ proxyAddress: authority, toast: message => messages.push(message) });
    cards.at(-1).primaryAction.onclick();
    assert.equal(messages[0], `Proxy: ${authority} - Configure any HTTP client to use this proxy`);
  }
});

test('interceptor cards expose dedicated native primary buttons without nested controls', () => {
  for (const card of renderCards()) {
    assert.equal(card.attributes.has('role'), false);
    assert.equal(card.attributes.has('tabindex'), false);
    const primary = primaryButtonHtml(card);
    assert.ok(primary, 'each activatable card needs a native primary button');
    assert.match(primary, /\baria-label="[^"]+"/);
    assert.doesNotMatch(primary.replace(/^<button\b[^>]*>|<\/button>$/g, ''), /<(?:button|input|select|textarea|a)\b/);
  }
  assert.doesNotMatch(source, /activateInterceptorCardOnKeyboard|\.onkeydown = activateInterceptorCardOnKeyboard/);
});

test('expanded interceptor configuration and close action are siblings of its disclosure', () => {
  const [card] = renderCards({ expanded: true });
  const primary = primaryButtonHtml(card);
  assert.match(primary, /aria-expanded="true"/);
  assert.match(primary, /aria-controls="interceptConfig-terminal"/);
  assert.doesNotMatch(primary, /intercept-card-close|intercept-card-config/);
  assert.match(card.innerHTML, /<button[^>]*class="intercept-card-close"[^>]*aria-label="Close Existing Terminal configuration"/);
  assert.match(card.innerHTML, /<div class="intercept-card-config" id="interceptConfig-terminal"><\/div>/);
});
