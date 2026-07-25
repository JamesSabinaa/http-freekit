import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const helpersStart = source.indexOf('function safeLocalStorageGet');
const helpersEnd = source.indexOf('// ============ WEBSOCKET FRAMES STATE', helpersStart);
const helpers = source.slice(helpersStart, helpersEnd);

test('storage helpers absorb blocked and quota-exceeded operations', () => {
  const warnings = [];
  const context = {
    window: {
      localStorage: {
        getItem() { throw new Error('blocked'); },
        setItem() { throw new Error('quota exceeded'); },
        removeItem() { throw new Error('blocked'); }
      }
    },
    console: { warn: message => warnings.push(message) }
  };
  vm.createContext(context);
  vm.runInContext(helpers, context);

  assert.equal(context.safeLocalStorageGet('missing', 'fallback'), 'fallback');
  assert.equal(context.safeLocalStorageSet('key', 'value'), false);
  assert.equal(context.safeLocalStorageRemove('key'), false);
  assert.equal(warnings.length, 3);
});

test('navigation and startup use guarded storage access exclusively', () => {
  assert.doesNotMatch(source, /(?<!window\.)localStorage\.(?:getItem|setItem|removeItem)/);
  const switchPanel = source.slice(source.indexOf('function switchPanel'), source.indexOf('function restoreTrafficScrollPosition'));
  const theme = source.slice(source.indexOf('function setTheme'), source.indexOf('// Re-apply theme'));

  assert.match(switchPanel, /safeLocalStorageSet\('trafficScrollTop'/);
  assert.match(theme, /safeLocalStorageSet\('http-freekit-theme'/);
  assert.match(source, /loadTheme\(\);\s*connectWebSocket\(\);/);
});
