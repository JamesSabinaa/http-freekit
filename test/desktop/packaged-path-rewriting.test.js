import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import asarPathModule from '../../electron/asar-path.cjs';
import mcpLaunchModule from '../../electron/mcp-launch.cjs';

const {
  resolveBundledNodeExecutable,
  resolveBundledServerScript,
  rewriteResourcesAsarToUnpacked
} = asarPathModule;
const { resolveBundledMcpBridgeScript } = mcpLaunchModule;

test('archive rewriting targets only the last exact resources/app.asar segment', () => {
  const cases = [
    {
      input: '/opt/app.asar-builds/HTTP FreeKit/resources/app.asar/src/index.js',
      expected: '/opt/app.asar-builds/HTTP FreeKit/resources/app.asar.unpacked/src/index.js'
    },
    {
      input: '/opt/app.asar/HTTP FreeKit/resources/app.asar/src/index.js',
      expected: '/opt/app.asar/HTTP FreeKit/resources/app.asar.unpacked/src/index.js'
    },
    {
      input: '/opt/resources/app.asar/build/resources/app.asar/src/index.js',
      expected: '/opt/resources/app.asar/build/resources/app.asar.unpacked/src/index.js'
    },
    {
      input: '/opt/app.asar-builds/HTTP FreeKit/resources/app.asar.unpacked/src/index.js',
      expected: '/opt/app.asar-builds/HTTP FreeKit/resources/app.asar.unpacked/src/index.js'
    },
    {
      input: '/opt/app.asar-builds/http-freekit/src/index.js',
      expected: '/opt/app.asar-builds/http-freekit/src/index.js'
    },
    {
      input: 'C:\\apps\\app.asar-builds\\HTTP FreeKit\\resources\\app.asar\\src\\index.js',
      expected: 'C:\\apps\\app.asar-builds\\HTTP FreeKit\\resources\\app.asar.unpacked\\src\\index.js'
    },
    {
      input: 'C:\\apps\\app.asar\\HTTP FreeKit\\resources\\app.asar\\src\\index.js',
      expected: 'C:\\apps\\app.asar\\HTTP FreeKit\\resources\\app.asar.unpacked\\src\\index.js'
    },
    {
      input: 'C:\\resources\\app.asar\\build\\resources\\app.asar\\src\\index.js',
      expected: 'C:\\resources\\app.asar\\build\\resources\\app.asar.unpacked\\src\\index.js'
    },
    {
      input: 'C:\\apps\\app.asar-builds\\HTTP FreeKit\\resources\\app.asar.unpacked\\src\\index.js',
      expected: 'C:\\apps\\app.asar-builds\\HTTP FreeKit\\resources\\app.asar.unpacked\\src\\index.js'
    },
    {
      input: 'C:\\apps\\app.asar-builds\\http-freekit\\src\\index.js',
      expected: 'C:\\apps\\app.asar-builds\\http-freekit\\src\\index.js'
    }
  ];

  for (const { input, expected } of cases) {
    assert.equal(rewriteResourcesAsarToUnpacked(input), expected, input);
  }
});

test('desktop server and MCP resolution share terminal archive semantics', () => {
  const platforms = [
    {
      name: 'POSIX',
      pathApi: path.posix,
      root: '/opt/app.asar-builds/HTTP FreeKit'
    },
    {
      name: 'Windows',
      pathApi: path.win32,
      root: 'C:\\apps\\app.asar-builds\\HTTP FreeKit'
    }
  ];

  for (const { name, pathApi, root } of platforms) {
    const platform = name === 'Windows' ? 'win32' : 'linux';
    const nodeExecutable = platform === 'win32' ? 'node.exe' : 'node';
    const packedAppDirectory = pathApi.join(root, 'app.asar', 'ancestor', 'resources', 'app.asar', 'electron');
    const unpackedAppDirectory = pathApi.join(root, 'app.asar', 'ancestor', 'resources', 'app.asar.unpacked', 'electron');
    const developmentAppDirectory = pathApi.join(root, 'app.asar', 'ancestor', 'electron');

    assert.equal(
      resolveBundledServerScript(packedAppDirectory, pathApi),
      pathApi.join(root, 'app.asar', 'ancestor', 'resources', 'app.asar.unpacked', 'src', 'index.js'),
      `${name} packaged server path`
    );
    assert.equal(
      resolveBundledNodeExecutable(packedAppDirectory, platform, pathApi),
      pathApi.join(
        root,
        'app.asar',
        'ancestor',
        'resources',
        'app.asar.unpacked',
        'node_modules',
        'node',
        'bin',
        nodeExecutable
      ),
      `${name} packaged Node path`
    );
    assert.equal(
      resolveBundledMcpBridgeScript(packedAppDirectory, pathApi),
      pathApi.join(root, 'app.asar', 'ancestor', 'resources', 'app.asar.unpacked', 'src', 'mcp', 'stdio-bridge.js'),
      `${name} packaged MCP path`
    );
    assert.equal(
      resolveBundledServerScript(unpackedAppDirectory, pathApi),
      pathApi.join(root, 'app.asar', 'ancestor', 'resources', 'app.asar.unpacked', 'src', 'index.js'),
      `${name} unpacked server path`
    );
    assert.equal(
      resolveBundledMcpBridgeScript(unpackedAppDirectory, pathApi),
      pathApi.join(root, 'app.asar', 'ancestor', 'resources', 'app.asar.unpacked', 'src', 'mcp', 'stdio-bridge.js'),
      `${name} unpacked MCP path`
    );
    assert.equal(
      resolveBundledServerScript(developmentAppDirectory, pathApi),
      pathApi.join(root, 'app.asar', 'ancestor', 'src', 'index.js'),
      `${name} development server path`
    );
    assert.equal(
      resolveBundledNodeExecutable(developmentAppDirectory, platform, pathApi),
      pathApi.join(
        root,
        'app.asar',
        'ancestor',
        'node_modules',
        'node',
        'bin',
        nodeExecutable
      ),
      `${name} development Node path`
    );
    assert.equal(
      resolveBundledMcpBridgeScript(developmentAppDirectory, pathApi),
      pathApi.join(root, 'app.asar', 'ancestor', 'src', 'mcp', 'stdio-bridge.js'),
      `${name} development MCP path`
    );
  }
});

test('desktop startup uses the packaged server resolver instead of replacing an app.asar substring', () => {
  const mainSource = fs.readFileSync(new URL('../../electron/main.cjs', import.meta.url), 'utf8');
  const start = mainSource.indexOf('async function startServer()');
  const end = mainSource.indexOf('function registerProtocolHandler()', start);
  const startServerSource = mainSource.slice(start, end);

  assert.match(
    mainSource,
    /resolveBundledNodeExecutable,[\s\S]*resolveBundledServerScript[\s\S]*require\('\.\/asar-path\.cjs'\);/
  );
  assert.match(startServerSource, /const serverScript = resolveBundledServerScript\(__dirname\);/);
  assert.match(startServerSource, /const serverExecutable = resolveBundledNodeExecutable\(__dirname\);/);
  assert.match(startServerSource, /spawn\(serverExecutable, \[serverScript\]/);
  assert.doesNotMatch(startServerSource, /ELECTRON_RUN_AS_NODE:\s*'1'/);
  assert.doesNotMatch(startServerSource, /\.replace\([^\n]*app\.asar/);
});
