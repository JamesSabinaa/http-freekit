import { execFile } from 'child_process';

export const PROCESS_STARTUP_EXIT_ERROR_CODE = 'PROCESS_EXITED_DURING_STARTUP';

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
  const acceptZeroExit = options.acceptZeroExit === true;

  return new Promise((resolve, reject) => {
    let spawned = false;
    let settled = false;
    let timer = null;
    let observation = null;
    let preSpawnExit = null;
    const cleanup = () => {
      clearTimeout(timer);
      clearImmediate(observation);
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
      const error = new Error(`${label} exited during startup (${detail})`);
      error.code = PROCESS_STARTUP_EXIT_ERROR_CODE;
      error.exitCode = code ?? null;
      error.signal = signal ?? null;
      return error;
    };
    const onExit = (code, signal) => {
      if (!spawned) {
        preSpawnExit = { code, signal };
        return;
      }
      if (acceptZeroExit && signal == null && code === 0) {
        finish(resolve);
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
        // A long synchronous task can make this timer runnable before libuv has
        // delivered an already-completed child's exit callback. Give queued
        // process events one bounded event-loop turn before declaring success.
        observation = setImmediate(() => {
          if (child.signalCode !== null || child.exitCode !== null) {
            onExit(child.exitCode, child.signalCode);
          } else {
            finish(resolve);
          }
        });
      }, graceMs);
    };

    child.once('spawn', onSpawn);
    child.on('exit', onExit);
    child.once('error', onError);
  });
}
