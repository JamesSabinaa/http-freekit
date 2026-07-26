import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import {
  ExistingTerminalInterceptor,
  buildExistingTerminalInstructions
} from '../src/interceptors/terminal-interceptors.js';

const proxyUrl = 'http://127.0.0.1:8080';
const certPath = "C:\\Users\\O'Brien & Sons (QA)\\$cash`tick` ^caret <cert> | final.pem";

function rendererHarness(metadata) {
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
  const start = source.indexOf('function quoteTerminalBashValue(');
  const end = source.indexOf('function switchConfigTab(', start);
  assert.ok(start >= 0 && end > start, 'terminal fallback generator must be present');

  const context = {
    expandedInterceptorMetadata: metadata,
    config: { proxyPort: 9090 },
    navigator: { platform: 'Win32' },
    esc: value => String(value)
  };
  vm.createContext(context);
  vm.runInContext(`
    ${source.slice(start, end)}
    globalThis.renderFallback = renderTerminalConfig;
    globalThis.buildFallback = buildTerminalFallbackInstructions;
  `, context);
  return context;
}

test('Existing Terminal metadata quotes certificate paths for each shell', async () => {
  const interceptor = new ExistingTerminalInterceptor();
  interceptor.ca = { getCertInfo: () => ({ certificatePath: certPath }) };

  const result = await interceptor.activate(8080);
  const instructions = result.metadata.instructions;

  assert.deepEqual(instructions, buildExistingTerminalInstructions(proxyUrl, certPath));
  assert.match(
    instructions.bash,
    /NODE_EXTRA_CA_CERTS='C:\\Users\\O'"'"'Brien & Sons \(QA\)\\\$cash`tick` \^caret <cert> \| final\.pem'/
  );
  assert.match(
    instructions.powershell,
    /\$env:NODE_EXTRA_CA_CERTS='C:\\Users\\O''Brien & Sons \(QA\)\\\$cash`tick` \^caret <cert> \| final\.pem'/
  );
  assert.ok(instructions.cmd.includes(`set "NODE_EXTRA_CA_CERTS=${certPath}"`));
  assert.doesNotMatch(instructions.cmd, /&& set NODE_EXTRA_CA_CERTS=/);
});

test('renderer fallback uses the same shell-specific quoting when instructions are absent', () => {
  const context = rendererHarness({ proxyUrl, certPath });
  const container = {};

  context.renderFallback(container);

  assert.deepEqual(
    JSON.parse(JSON.stringify(container._instructions)),
    buildExistingTerminalInstructions(proxyUrl, certPath)
  );
});

test('renderer fallback safely represents an absent certificate path', () => {
  const context = rendererHarness(null);
  const container = {};

  context.renderFallback(container);

  const instructions = JSON.parse(JSON.stringify(container._instructions));
  assert.deepEqual(instructions, buildExistingTerminalInstructions('http://127.0.0.1:9090', ''));
  assert.match(instructions.bash, /NODE_EXTRA_CA_CERTS=''/);
  assert.match(instructions.powershell, /\$env:NODE_EXTRA_CA_CERTS=''/);
  assert.match(instructions.cmd, /set "NODE_EXTRA_CA_CERTS="/);
});
