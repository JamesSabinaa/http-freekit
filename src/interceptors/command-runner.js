import { execFile } from 'child_process';

export function execFileAsync(file, args = [], options = {}) {
  const { stdio: _stdio, onSpawn, ...execOptions } = options;
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, execOptions, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout ?? '');
    });
    if (onSpawn) child.once('spawn', onSpawn);
  });
}

export function waitForSpawnStability(child, options = {}) {
  const graceMs = Number.isFinite(options.graceMs) && options.graceMs >= 0
    ? options.graceMs
    : 500;
  const label = options.label || 'Process';

  return new Promise((resolve, reject) => {
    let spawned = false;
    let settled = false;
    let timer = null;
    let preSpawnExit = null;
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener('spawn', onSpawn);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const startupExitError = (code, signal) => {
      const detail = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`;
      return new Error(`${label} exited during startup (${detail})`);
    };
    const onExit = (code, signal) => {
      if (!spawned) {
        preSpawnExit = { code, signal };
        return;
      }
      finish(reject, startupExitError(code, signal));
    };
    const onError = error => finish(reject, error);
    const onSpawn = () => {
      spawned = true;
      if (preSpawnExit) {
        onExit(preSpawnExit.code, preSpawnExit.signal);
        return;
      }
      if (child.signalCode !== null || child.exitCode !== null) {
        onExit(child.exitCode, child.signalCode);
        return;
      }
      timer = setTimeout(() => {
        if (child.signalCode !== null || child.exitCode !== null) {
          onExit(child.exitCode, child.signalCode);
        } else {
          finish(resolve);
        }
      }, graceMs);
    };

    child.once('spawn', onSpawn);
    child.on('exit', onExit);
    child.once('error', onError);
  });
}
