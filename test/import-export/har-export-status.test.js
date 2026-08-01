import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

function exportHarness({ clickError } = {}) {
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
  const start = source.indexOf('async function exportTraffic(');
  const end = source.indexOf('async function exportHarToGenerator(', start);
  assert.ok(start >= 0 && end > start, 'traffic export function must be present');

  const events = [];
  const anchors = [];
  class FixedDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : ['2026-07-26T12:34:56.000Z']));
    }
  }
  const context = {
    API_BASE: 'http://127.0.0.1:8080',
    Date: FixedDate,
    authenticatedApiUrl(url) {
      events.push(['authenticate', url]);
      return `authenticated:${url}`;
    },
    document: {
      createElement(tagName) {
        assert.equal(tagName, 'a');
        const anchor = {
          click() {
            events.push(['click', this.href, this.download]);
            if (clickError) throw clickError;
          }
        };
        anchors.push(anchor);
        return anchor;
      }
    },
    toast(message, type) {
      events.push(['toast', message, type]);
    }
  };
  vm.createContext(context);
  vm.runInContext(`
    ${source.slice(start, end)}
    globalThis.runExport = exportTraffic;
  `, context);
  return { context, events, anchors };
}

test('HAR export reports authenticated browser download initiation without claiming completion', async () => {
  const { context, events, anchors } = exportHarness();

  await context.runExport('har');

  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].href, 'authenticated:http://127.0.0.1:8080/api/traffic/export.har');
  assert.equal(anchors[0].download, 'http-freekit-2026-07-26.har');
  assert.deepEqual(events, [
    ['authenticate', 'http://127.0.0.1:8080/api/traffic/export.har'],
    [
      'click',
      'authenticated:http://127.0.0.1:8080/api/traffic/export.har',
      'http-freekit-2026-07-26.har'
    ],
    ['toast', 'HAR download started', 'success']
  ]);
  assert.doesNotMatch(events.at(-1)[1], /exported|complete|finished/i);
});

test('HAR export reports a synchronous browser download launch failure without success', async () => {
  const { context, events } = exportHarness({ clickError: new Error('download blocked') });

  await context.runExport('har');

  assert.deepEqual(events, [
    ['authenticate', 'http://127.0.0.1:8080/api/traffic/export.har'],
    [
      'click',
      'authenticated:http://127.0.0.1:8080/api/traffic/export.har',
      'http-freekit-2026-07-26.har'
    ],
    ['toast', 'Export failed: download blocked', 'error']
  ]);
  assert.equal(events.some(event => event[0] === 'toast' && event[2] === 'success'), false);
});
