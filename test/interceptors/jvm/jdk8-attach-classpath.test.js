import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { JvmInterceptor } from '../../../src/interceptors/jvm-interceptor.js';

test('JDK 8 Attach helper runtime includes the owning JDK tools.jar', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-jdk8-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const javaPath = path.join(root, 'jdk', 'jre', 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  const toolsJar = path.join(root, 'jdk', 'lib', 'tools.jar');
  fs.mkdirSync(path.dirname(javaPath), { recursive: true });
  fs.mkdirSync(path.dirname(toolsJar), { recursive: true });
  fs.writeFileSync(javaPath, 'runtime');
  fs.writeFileSync(toolsJar, 'attach api');

  const interceptor = new JvmInterceptor();
  interceptor._findJavaExecutablePath = () => javaPath;
  interceptor._environment = () => ({});

  assert.equal(
    interceptor._getAttachHelperClasspath('attach-helper'),
    `attach-helper${path.delimiter}${toolsJar}`
  );
});

test('modern JDK Attach helper runtime keeps its ordinary classpath', () => {
  const interceptor = new JvmInterceptor();
  interceptor._findJavaExecutablePath = () => process.execPath;
  interceptor._environment = () => ({});

  assert.equal(interceptor._getAttachHelperClasspath('attach-helper'), 'attach-helper');
});
