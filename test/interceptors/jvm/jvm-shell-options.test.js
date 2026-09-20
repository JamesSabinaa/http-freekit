import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { JvmInterceptor } from '../../../src/interceptors/jvm-interceptor.js';

test('Windows JVM fallbacks preserve literal paths in PowerShell and CMD native argv', { skip: process.platform !== 'win32' }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-jvm-argv-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const captureScript = path.join(directory, 'capture.cjs');
  const captureFile = path.join(directory, 'argv.json');
  fs.writeFileSync(captureScript, "require('node:fs').writeFileSync(process.env.FK_CAPTURE, JSON.stringify(process.argv.slice(2)));\n");
  const interceptor = new JvmInterceptor();
  interceptor._platform = () => 'win32';
  interceptor.ca = { getCertInfo: () => ({ certificatePath: 'C:\\CA\\ca.pem' }) };
  for (const agent of [
    "C:\\FreeKit $__missingVariable\\O'Neil & files\\proxy-agent.jar",
    'C:\\FreeKit-%FK_AUDIT_LITERAL%\\proxy-agent.jar',
    "C:\\%FK_AUDIT_LITERAL% !FK_AUDIT_LITERAL! ^ 文件\\O'Neil\\proxy-agent.jar"
  ]) {
    await t.test(agent, () => {
      const expected = `-javaagent:${agent}=${interceptor._getAgentArgs('127.0.0.1', 8080)}`;
      const options = interceptor._getFallbackCommands('127.0.0.1', 8080, agent);
      assert.deepEqual(options.map(option => option.shell), ['powershell', 'cmd']);
      assert.equal(interceptor._getFallbackCommand('127.0.0.1', 8080, agent), options[0].command);
      const quote = value => `'${value.replaceAll("'", "''")}'`;
      const captureCommand = `& ${quote(process.execPath)} ${quote(captureScript)} `;
      const environment = { ...process.env, FK_AUDIT_LITERAL: 'EXPANDED', FK_CAPTURE: captureFile };
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `${captureCommand}${options[0].command}`], { encoding: 'utf8', windowsHide: true, env: environment });
      assert.deepEqual(JSON.parse(fs.readFileSync(captureFile, 'utf8')), [expected]);
      assert.equal(options[1].kind, 'command');
      assert.match(options[1].description, /Replace -jar/);
      assert.match(options[1].command, /& java /);
      const safeCommand = options[1].command.replace('& java ', captureCommand);
      for (const delayedExpansion of ['off', 'on']) {
        execFileSync('cmd.exe', ['/d', `/v:${delayedExpansion}`, '/c', safeCommand], {
          encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true, env: environment
        });
        assert.deepEqual(JSON.parse(fs.readFileSync(captureFile, 'utf8')), [expected, '-jar', 'your-application.jar']);
      }
    });
  }
});

test('JVM renderer labels each shell option and retains a missing-agent explanation', () => {
  const source = fs.readFileSync(new URL('../../../src/ui/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function renderJvmConfig('), end = source.indexOf('async function activateJvmProcess(', start);
  const context = vm.createContext({ esc: value => String(value ?? ''), expandedInterceptorMetadata: {
    processes: [], activatedProcesses: [], fallbackCommand: 'legacy', fallbackCommands: [
      { label: 'PowerShell', command: "'literal $path'" },
      { label: 'Command Prompt (CMD)', command: 'encoded launch command', kind: 'command', description: 'Replace your-application.jar with your app.' }
    ]
  } });
  vm.runInContext(source.slice(start, end), context);
  const container = { innerHTML: '' };
  context.renderJvmConfig(container);
  assert.match(container.innerHTML, /<p>PowerShell<\/p>/);
  assert.match(container.innerHTML, /<p>Command Prompt \(CMD\)<\/p>/);
  assert.ok(container.innerHTML.includes("'literal $path'"));
  assert.ok(container.innerHTML.includes('encoded launch command'));
  assert.match(container.innerHTML, /Copy JVM launch command for Command Prompt/);
  assert.match(container.innerHTML, /Replace your-application.jar with your app/);
  context.expandedInterceptorMetadata.fallbackCommand = null;
  context.renderJvmConfig(container);
  assert.match(container.innerHTML, /could not be prepared/);
  assert.doesNotMatch(container.innerHTML, /literal \$path/);
});
