import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const uiDir = path.join(process.cwd(), 'src', 'ui');

function buttonById(html, id) {
  const match = html.match(new RegExp(`<button\\b[^>]*\\bid="${id}"[^>]*>[\\s\\S]*?</button>`));
  assert.ok(match, `${id} must be a visible native button`);
  return match[0];
}

function exportHarness() {
  const source = fs.readFileSync(path.join(uiDir, 'app.js'), 'utf8');
  const start = source.indexOf('async function exportTraffic(');
  const end = source.indexOf('async function exportHarToGenerator(', start);
  assert.ok(start >= 0 && end > start, 'traffic export function must be present');

  const anchors = [];
  const blobs = [];
  const revokedUrls = [];
  const toasts = [];
  class CapturedBlob {
    constructor(parts, options) {
      this.parts = parts;
      this.type = options.type;
      blobs.push(this);
    }
  }
  class FixedDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : ['2026-07-26T12:34:56.000Z']));
    }
  }
  const context = {
    API_BASE: 'http://127.0.0.1:8080',
    Blob: CapturedBlob,
    Date: FixedDate,
    URL: {
      createObjectURL(blob) {
        assert.equal(blob, blobs.at(-1));
        return `blob:traffic-${blobs.length}`;
      },
      revokeObjectURL(url) {
        revokedUrls.push(url);
      }
    },
    authenticatedApiUrl: url => `authenticated:${url}`,
    document: {
      createElement(tagName) {
        assert.equal(tagName, 'a');
        const anchor = {
          clicked: false,
          click() { this.clicked = true; }
        };
        anchors.push(anchor);
        return anchor;
      }
    },
    requests: [{ id: 'request-1', method: 'GET', url: 'http://localhost:3000/' }],
    toast: (...args) => toasts.push(args)
  };
  vm.createContext(context);
  vm.runInContext(`
    ${source.slice(start, end)}
    globalThis.runExport = exportTraffic;
  `, context);
  return { context, anchors, blobs, revokedUrls, toasts };
}

test('Traffic toolbar exposes independent accessible JSON and HAR export buttons', () => {
  const html = fs.readFileSync(path.join(uiDir, 'index.html'), 'utf8');
  const styles = fs.readFileSync(path.join(uiDir, 'styles.css'), 'utf8');
  const jsonButton = buttonById(html, 'exportJsonBtn');
  const harButton = buttonById(html, 'exportHarBtn');

  assert.match(jsonButton, /onclick="exportTraffic\('json'\)"/);
  assert.match(jsonButton, /title="Export traffic as JSON"/);
  assert.match(jsonButton, /aria-label="Export traffic as JSON"/);
  assert.match(jsonButton, /class="ph ph-brackets-curly"/);
  assert.match(harButton, /onclick="exportTraffic\('har'\)"/);
  assert.match(harButton, /title="Export traffic as HAR"/);
  assert.match(harButton, /aria-label="Export traffic as HAR"/);
  assert.ok(html.indexOf(jsonButton) < html.indexOf(harButton));

  for (const existingAction of ['exportHarToGenerator()', 'importHar()', 'clearTraffic()']) {
    assert.match(html, new RegExp(`onclick="${existingAction.replace(/[()]/g, '\\$&')}"`));
  }
  assert.match(html, /class="traffic-toolbar-actions" role="toolbar" aria-label="Traffic actions"/);
  assert.match(styles, /\.traffic-toolbar-actions\s*\{[\s\S]*?display:\s*flex;/);
  assert.match(styles, /@media \(max-width: 768px\)[\s\S]*?\.traffic-toolbar-actions\s*\{[\s\S]*?flex-wrap:\s*wrap;/);
});

test('JSON traffic export downloads the existing named JSON payload', async () => {
  const { context, anchors, blobs, revokedUrls, toasts } = exportHarness();

  await context.runExport('json');

  assert.equal(anchors.length, 1);
  assert.deepEqual(anchors[0], {
    href: 'blob:traffic-1',
    download: 'http-freekit-2026-07-26.json',
    clicked: true,
    click: anchors[0].click
  });
  assert.equal(blobs.length, 1);
  assert.equal(blobs[0].type, 'application/json');
  assert.deepEqual(JSON.parse(blobs[0].parts.join('')), {
    exported: '2026-07-26T12:34:56.000Z',
    tool: 'HTTP FreeKit',
    version: '1.0.0',
    requests: [{ id: 'request-1', method: 'GET', url: 'http://localhost:3000/' }]
  });
  assert.deepEqual(revokedUrls, ['blob:traffic-1']);
  assert.deepEqual(toasts, [['JSON exported', 'success']]);
});

test('HAR traffic export remains independently reachable and server-backed', async () => {
  const { context, anchors, blobs, revokedUrls, toasts } = exportHarness();

  await context.runExport('har');

  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].href, 'authenticated:http://127.0.0.1:8080/api/traffic/export.har');
  assert.equal(anchors[0].download, 'http-freekit-2026-07-26.har');
  assert.equal(anchors[0].clicked, true);
  assert.deepEqual(blobs, []);
  assert.deepEqual(revokedUrls, []);
  assert.deepEqual(toasts, [['HAR file exported', 'success']]);
});
