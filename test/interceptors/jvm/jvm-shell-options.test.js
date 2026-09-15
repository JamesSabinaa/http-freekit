import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { JvmInterceptor } from '../../../src/interceptors/jvm-interceptor.js';

test('Windows JVM options preserve dollar signs and quotes in the advertised shells', { skip: process.platform !== 'win32' }, () => {
  const interceptor = new JvmInterceptor();
  interceptor._platform = () => 'win32';
  interceptor.ca = { getCertInfo: () => ({ certificatePath: 'C:\\CA\\ca.pem' }) };
  const agent = "C:\\FreeKit $__missingVariable\\O'Neil & files\\proxy-agent.jar";
  const expected = `-javaagent:${agent}=${interceptor._getAgentArgs('127.0.0.1', 8080)}`;
  const options = interceptor._getFallbackCommands('127.0.0.1', 8080, agent);
  assert.deepEqual(options.map(option => option.shell), ['powershell', 'cmd']);
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `[Console]::Write(${options[0].command})`], { encoding: 'utf8', windowsHide: true });
  assert.equal(output, expected);
  const cmdOutput = execFileSync('cmd.exe', ['/d', '/v:off', '/c', `echo ${options[1].command}`], { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true });
  assert.equal(cmdOutput.trim(), `"${expected}"`);
});

test('JVM renderer labels each shell option and retains a missing-agent explanation', () => {
  const source = fs.readFileSync(new URL('../../../src/ui/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function renderJvmConfig('), end = source.indexOf('async function activateJvmProcess(', start);
  const context = vm.createContext({ esc: value => String(value ?? ''), expandedInterceptorMetadata: {
    processes: [], activatedProcesses: [], fallbackCommand: 'legacy', fallbackCommands: [
      { label: 'PowerShell', command: "'literal $path'" },
      { label: 'Command Prompt (CMD)', command: '"literal $path"' }
    ]
  } });
  vm.runInContext(source.slice(start, end), context);
  const container = { innerHTML: '' };
  context.renderJvmConfig(container);
  assert.match(container.innerHTML, /<p>PowerShell<\/p>/);
  assert.match(container.innerHTML, /<p>Command Prompt \(CMD\)<\/p>/);
  assert.ok(container.innerHTML.includes("'literal $path'"));
  assert.ok(container.innerHTML.includes('"literal $path"'));
  context.expandedInterceptorMetadata.fallbackCommand = null;
  context.renderJvmConfig(container);
  assert.match(container.innerHTML, /could not be prepared/);
  assert.doesNotMatch(container.innerHTML, /literal \$path/);
});
