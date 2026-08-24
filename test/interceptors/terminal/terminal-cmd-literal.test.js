import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import {
  buildExistingTerminalInstructions
} from '../../../src/interceptors/terminal-interceptors.js';

const proxyUrl = 'http://127.0.0.1:8080';
const literalCertPath = String.raw`C:\%WINDIR%\!WINDIR!\caret^\amp&\pipe|\lt<gt>\(group)\ca.pem`;
const trustVariables = [
  'NODE_EXTRA_CA_CERTS'
];
const helperNames = [
  '__HTTP_FREEKIT_CMD_LITERAL_PERCENT_4F91D2A7__',
  '__HTTP_FREEKIT_CMD_LITERAL_BANG_4F91D2A7__',
  '__HTTP_FREEKIT_CMD_LITERAL_CARET_4F91D2A7__'
];

function rendererFallbackBuilder() {
  const source = fs.readFileSync(new URL('../../../src/ui/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function quoteTerminalBashValue(');
  const end = source.indexOf('function renderTerminalConfig(', start);
  assert.ok(start >= 0 && end > start, 'terminal fallback generator must be present');
  const context = {};
  vm.createContext(context);
  vm.runInContext(
    `${source.slice(start, end)}; globalThis.buildFallback = buildTerminalFallbackInstructions;`,
    context
  );
  return context.buildFallback;
}

test('CMD instructions defer literal expansion characters without changing other shells', () => {
  const instructions = buildExistingTerminalInstructions(proxyUrl, literalCertPath);

  assert.ok(instructions.bash.includes(`NODE_EXTRA_CA_CERTS='${literalCertPath}'`));
  assert.ok(instructions.powershell.includes(`$env:NODE_EXTRA_CA_CERTS='${literalCertPath}'`));
  assert.doesNotMatch(instructions.cmd, /%WINDIR%|!WINDIR!/);
  assert.ok(instructions.cmd.includes(
    String.raw`call set ^"NODE_EXTRA_CA_CERTS=C:\^%__HTTP_FREEKIT_CMD_LITERAL_PERCENT_4F91D2A7__^%WINDIR`
  ));
  assert.ok(instructions.cmd.includes(
    String.raw`caret^%__HTTP_FREEKIT_CMD_LITERAL_CARET_4F91D2A7__^%`
  ));
  assert.ok(instructions.cmd.includes(String.raw`amp^&\pipe^|\lt^<gt^>\^(group^)`));
  for (const helperName of helperNames) {
    assert.ok(instructions.cmd.endsWith(`set "${helperName}="`) ||
      instructions.cmd.includes(`set "${helperName}="&& `));
  }

  assert.deepEqual(
    JSON.parse(JSON.stringify(rendererFallbackBuilder()(proxyUrl, literalCertPath))),
    instructions
  );
});

test('CMD instructions retain the simple SET form for ordinary paths', () => {
  const certPath = String.raw`C:\Program Files\HTTP FreeKit\terminal-ca-bundle.pem`;
  const instructions = buildExistingTerminalInstructions(proxyUrl, certPath);

  assert.match(instructions.cmd, /set "NODE_EXTRA_CA_CERTS=C:\\Program Files\\HTTP FreeKit\\terminal-ca-bundle\.pem"/);
  assert.doesNotMatch(instructions.cmd, /call set|CMD_LITERAL/);
});

test('terminal instruction generation rejects quote and control-character injection', () => {
  const buildFallback = rendererFallbackBuilder();
  const invalidValues = [
    String.raw`C:\bad"& set INJECTED=yes & rem "\ca.pem`,
    'C:\\bad\npath\\ca.pem',
    'C:\\bad\rpath\\ca.pem',
    'C:\\bad\tpath\\ca.pem',
    `C:\\bad\0path\\ca.pem`,
    `C:\\bad${String.fromCharCode(0x7f)}path\\ca.pem`
  ];

  for (const value of invalidValues) {
    assert.throws(
      () => buildExistingTerminalInstructions(proxyUrl, value),
      /cannot contain (?:control characters|double quotes)/
    );
    assert.throws(
      () => buildFallback(proxyUrl, value),
      /cannot contain (?:control characters|double quotes)/
    );
  }
});

test('generated assignments survive real interactive CMD expansion modes', {
  skip: process.platform !== 'win32'
}, () => {
  const command = buildExistingTerminalInstructions(proxyUrl, literalCertPath).cmd;
  const inheritedExpansion = 'EXPANDED"& set BUG401_INJECTED=yes & rem "';

  for (const delayedExpansion of ['off', 'on']) {
    const environment = {
      ...process.env,
      WINDIR: inheritedExpansion
    };
    delete environment.BUG401_INJECTED;
    const stdout = execFileSync(
      process.env.ComSpec || 'cmd.exe',
      [
        '/d',
        '/e:on',
        `/v:${delayedExpansion}`,
        '/s',
        '/c',
        `${command}&& ${trustVariables.map(name => `set ${name}`).join('&& ')}`
      ],
      {
        encoding: 'utf8',
        env: environment,
        windowsVerbatimArguments: true
      }
    );

    assert.deepEqual(
      stdout.trimEnd().split(/\r?\n/),
      trustVariables.map(name => `${name}=${literalCertPath}`),
      `delayed expansion ${delayedExpansion}`
    );
  }
});
