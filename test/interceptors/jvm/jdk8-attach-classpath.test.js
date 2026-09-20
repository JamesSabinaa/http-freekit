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

test('POSIX JDK 8 lookup preserves literal PATH and JAVA_HOME values in the helper working directory', async t => {
  const cwd = '/fixture/attach';
  const fixtures = [
    ...['/opt/jdk/bin', '/opt/jdk tools/bin', '/opt/jdk/bin ', ' jdk/bin', '/opt/jdk/bin"', '"jdk/bin']
      .map(directory => ({ env: { PATH: directory }, directory })),
    ...['', ':/missing', '/missing:', '/missing::/unused']
      .map(PATH => ({ env: { PATH }, directory: '.' })),
    { env: { path: '/wrong', PATH: '/opt/jdk/bin' }, directory: '/opt/jdk/bin' },
    { env: { path: '/wrong' }, directory: '/usr/bin' },
    ...['/opt/jdk ', ' jdk', '/opt/jdk tools', '/opt/jdk"', '"jdk']
      .map(JAVA_HOME => ({ env: { PATH: '/fixture/launcher', JAVA_HOME }, directory: '/fixture/launcher' }))
  ];
  for (const { env, directory } of fixtures) {
    await t.test(JSON.stringify(env), t => {
      const executable = path.posix.resolve(cwd, directory, 'java');
      const realExecutable = env.JAVA_HOME ? executable : '/opt/owning-jdk/bin/java';
      const toolsJar = env.JAVA_HOME
        ? path.posix.resolve(cwd, env.JAVA_HOME, 'lib/tools.jar')
        : '/opt/owning-jdk/lib/tools.jar';
      t.mock.method(fs, 'statSync', candidate => {
        if (candidate === executable || candidate === toolsJar) return { isFile: () => true };
        throw new Error('ENOENT fixture');
      });
      t.mock.method(fs, 'realpathSync', candidate => {
        assert.equal(candidate, executable);
        return realExecutable;
      });
      const interceptor = new JvmInterceptor();
      interceptor._platform = () => 'linux';
      interceptor._environment = () => env;
      assert.equal(interceptor._getAttachHelperClasspath(cwd), `${cwd}:${toolsJar}`);
    });
  }
});

test('Windows JDK 8 lookup retains Path casing and quoted-directory support', t => {
  const executable = 'C:\\Program Files\\JDK\\bin\\java.exe';
  const toolsJar = 'C:\\Program Files\\JDK\\lib\\tools.jar';
  t.mock.method(fs, 'statSync', candidate => {
    if (candidate === executable || candidate === toolsJar) return { isFile: () => true };
    throw new Error('ENOENT fixture');
  });
  t.mock.method(fs, 'realpathSync', () => executable);
  const interceptor = new JvmInterceptor();
  interceptor._platform = () => 'win32';
  interceptor._environment = () => ({ Path: '"C:\\Program Files\\JDK\\bin";C:\\Other' });
  assert.equal(interceptor._getAttachHelperClasspath('C:\\attach'), `C:\\attach;${toolsJar}`);
});
