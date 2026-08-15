import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DockerInterceptor } from '../../../src/interceptors/docker-interceptor.js';

const CONTAINER_CA_PATH = '/etc/http-freekit/ca-bundle.pem';

function expectedMountValue(source) {
  return `type=bind,"source=${source.replace(/"/g, '""')}",target=${CONTAINER_CA_PATH},readonly`;
}

function parseCsvRecord(record) {
  const fields = [];
  let field = '';
  let quoted = false;
  let atFieldStart = true;

  for (let index = 0; index < record.length; index += 1) {
    const character = record[index];
    if (quoted) {
      if (character !== '"') {
        field += character;
      } else if (record[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = false;
      }
    } else if (character === ',') {
      fields.push(field);
      field = '';
      atFieldStart = true;
    } else if (character === '"' && atFieldStart) {
      quoted = true;
      atFieldStart = false;
    } else {
      assert.notEqual(character, '"', `bare quote in Docker CSV field: ${record}`);
      field += character;
      atFieldStart = false;
    }
  }

  assert.equal(quoted, false, `unterminated Docker CSV field: ${record}`);
  fields.push(field);
  return fields;
}

function assertMountValue(mountValue, source) {
  assert.equal(mountValue, expectedMountValue(source));
  assert.deepEqual(parseCsvRecord(mountValue), [
    'type=bind',
    `source=${source}`,
    `target=${CONTAINER_CA_PATH}`,
    'readonly'
  ]);
}

async function generatedRunInstruction(platform, source) {
  const interceptor = new DockerInterceptor();
  interceptor._platform = () => platform;
  interceptor._getDockerHost = async () => platform === 'win32'
    ? 'host.docker.internal'
    : '172.17.0.1';
  interceptor._getCombinedCaBundlePath = () => source;
  const result = await interceptor.activate(8080);
  return result.metadata.instructions.run;
}

function instructionMountArgument(args) {
  const mountOption = args.indexOf('--mount');
  assert.notEqual(mountOption, -1, 'Docker must receive a --mount option');
  assert.equal(args.filter(argument => argument === '--mount').length, 1);
  assert.ok(args[mountOption + 1], 'Docker must receive one mount operand');
  assert.equal(args[mountOption + 2], '-e', 'the mount must not split into extra shell fields');
  return args[mountOption + 1];
}

test('POSIX Docker instructions preserve normal and hostile CA paths as one mount operand', async t => {
  t.mock.method(console, 'log', () => {});

  for (const [name, source] of [
    ['normal path', '/tmp/http-freekit-ca.pem'],
    [
      'commas, spaces, quotes, and substitutions',
      `/tmp/FreeKit, CA's "$cash" $(printf substituted) \`printf substituted\` bundle.pem`
    ]
  ]) {
    await t.test(name, async t => {
      const instruction = await generatedRunInstruction('linux', source);
      const executableInstruction = instruction.replace(/<image>$/, 'image');
      const shellScript = `docker() { printf '%s\\036' "$@"; }\n${executableInstruction}`;
      const result = spawnSync('sh', ['-c', shellScript], { encoding: 'utf8' });

      if (result.error?.code === 'ENOENT') {
        t.skip('a POSIX sh executable is not available');
        return;
      }

      assert.equal(result.status, 0, result.stderr);
      const args = result.stdout.split('\x1e');
      assert.equal(args.pop(), '');
      assert.equal(args[0], 'run');
      assertMountValue(instructionMountArgument(args), source);
    });
  }
});

test('Windows Docker instructions preserve normal and hostile CA paths in PowerShell 5 and 7', async t => {
  t.mock.method(console, 'log', () => {});
  let windowsHarness = null;
  if (process.platform === 'win32') {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-docker-argv-'));
    t.after(() => fs.rmSync(tempDirectory, { recursive: true, force: true }));
    const captureScript = path.join(tempDirectory, 'capture.cjs');
    fs.copyFileSync(process.execPath, path.join(tempDirectory, 'docker.exe'));
    fs.writeFileSync(captureScript, [
      "const fs = require('node:fs');",
      "fs.writeFileSync(process.env.HTTP_FREEKIT_DOCKER_ARGV, JSON.stringify(process.argv.slice(1)));",
      'process.exit(0);'
    ].join('\n'));
    const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH') || 'Path';
    windowsHarness = {
      capturePath: path.join(tempDirectory, 'argv.json'),
      environment: {
        ...process.env,
        [pathKey]: `${tempDirectory}${path.delimiter}${process.env[pathKey] || ''}`,
        NODE_OPTIONS: `--require=${captureScript.replace(/\\/g, '/')}`,
        HTTP_FREEKIT_DOCKER_ARGV: path.join(tempDirectory, 'argv.json')
      }
    };
  }
  const cases = [
    ['normal path', 'C:\\FreeKit\\ca-bundle.pem'],
    [
      'commas, spaces, quotes, and substitutions',
      'C:\\CA, Bundles\\O\'Brien & Sons\\$cash`tick`\\say"hi".pem'
    ],
    ['percent-delimited environment variable text', 'C:\\%WINDIR%\\FreeKit, CA.pem']
  ];

  for (const [name, source] of cases) {
    const instruction = await generatedRunInstruction('win32', source);
    assert.match(instruction, /^& \{\n/);
    assert.match(instruction, /\$PSNativeCommandArgumentPassing = 'Legacy'\n/);
    assert.match(instruction, /docker --% run --mount /);
    assert.match(instruction, /\n\}$/);

    if (process.platform !== 'win32') continue;

    await t.test(name, async t => {
      const { capturePath, environment } = windowsHarness;
      let executedShells = 0;

      for (const shell of ['powershell.exe', 'pwsh.exe']) {
        fs.rmSync(capturePath, { force: true });
        const command = [
          '$before = Get-Variable PSNativeCommandArgumentPassing -ValueOnly -ErrorAction SilentlyContinue',
          "$beforePercent = [Environment]::GetEnvironmentVariable('HTTP_FREEKIT_DOCKER_LITERAL_PERCENT', 'Process')",
          instruction,
          '$dockerExitCode = $LASTEXITCODE',
          '$after = Get-Variable PSNativeCommandArgumentPassing -ValueOnly -ErrorAction SilentlyContinue',
          "$afterPercent = [Environment]::GetEnvironmentVariable('HTTP_FREEKIT_DOCKER_LITERAL_PERCENT', 'Process')",
          'if ([string]$before -cne [string]$after) { exit 91 }',
          'if ([string]$beforePercent -cne [string]$afterPercent) { exit 92 }',
          'if ($dockerExitCode -ne 0) { exit $dockerExitCode }',
          'exit 0'
        ].join('\n');
        const result = spawnSync(
          shell,
          ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
          { encoding: 'utf8', env: environment, windowsHide: true }
        );

        if (result.error?.code === 'ENOENT') continue;
        executedShells += 1;
        assert.equal(
          result.status,
          0,
          `${shell}: stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)} capture=${fs.existsSync(capturePath)}`
        );
        assert.equal(fs.existsSync(capturePath), true, `${shell} did not invoke Docker`);
        const args = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
        assertMountValue(instructionMountArgument(args), source);
      }

      assert.ok(executedShells > 0, 'no Windows PowerShell executable is available');
    });
  }
});
