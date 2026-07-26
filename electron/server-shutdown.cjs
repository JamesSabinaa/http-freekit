const http = require('http');

const SHUTDOWN_COMPLETE_MESSAGE = 'http-freekit:shutdown-complete';
const DEFAULT_SHUTDOWN_DEADLINE_MS = 30_000;
const DEFAULT_EXIT_AFTER_CLEANUP_MS = 1_000;

function hasExited(proc) {
  return (proc.exitCode !== null && proc.exitCode !== undefined)
    || (proc.signalCode !== null && proc.signalCode !== undefined);
}

/**
 * Ask the backend to shut down and wait for its cleanup to finish.
 *
 * The backend reports when cleanup is complete over the child-process IPC
 * channel. At that point it is safe to force a process that fails to exit.
 * The overall deadline is the sole earlier force-kill boundary, preserving a
 * bounded desktop exit even if an interceptor cleanup operation hangs.
 */
function shutdownServerProcess({
  proc,
  apiPort,
  authToken,
  request = http.request,
  deadlineMs = DEFAULT_SHUTDOWN_DEADLINE_MS,
  exitAfterCleanupMs = DEFAULT_EXIT_AFTER_CLEANUP_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout
}) {
  if (!proc || hasExited(proc)) {
    return Promise.resolve({ reason: 'already-exited', cleanupComplete: false });
  }

  return new Promise((resolve) => {
    let settled = false;
    let cleanupComplete = false;
    let deadlineTimer = null;
    let exitAfterCleanupTimer = null;

    const finish = (reason) => {
      if (settled) return;
      settled = true;
      if (deadlineTimer !== null) clearTimeoutFn(deadlineTimer);
      if (exitAfterCleanupTimer !== null) clearTimeoutFn(exitAfterCleanupTimer);
      proc.removeListener('exit', onExit);
      proc.removeListener('message', onMessage);
      resolve({ reason, cleanupComplete });
    };

    const forceKill = (reason) => {
      if (!hasExited(proc)) {
        try { proc.kill('SIGKILL'); } catch {}
      }
      finish(reason);
    };

    const onExit = () => finish('exit');
    const onMessage = (message) => {
      if (message?.type !== SHUTDOWN_COMPLETE_MESSAGE || cleanupComplete) return;
      cleanupComplete = true;
      if (deadlineTimer !== null) {
        clearTimeoutFn(deadlineTimer);
        deadlineTimer = null;
      }
      exitAfterCleanupTimer = setTimeoutFn(
        () => forceKill('cleanup-complete-exit-timeout'),
        exitAfterCleanupMs
      );
    };

    proc.once('exit', onExit);
    proc.on('message', onMessage);
    if (hasExited(proc)) {
      finish('exit');
      return;
    }
    deadlineTimer = setTimeoutFn(() => forceKill('deadline'), deadlineMs);

    try {
      const req = request({
        hostname: '127.0.0.1',
        port: apiPort,
        path: '/api/shutdown',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${authToken}`,
          'Content-Type': 'application/json'
        }
      }, res => res.resume());
      req.on('error', () => {
        // The backend may already be exiting. Its exit event or the overall
        // deadline remains authoritative.
      });
      req.end();
    } catch {
      // Synchronous request setup failures are handled by the same bounded
      // process-exit protocol.
    }
  });
}

module.exports = {
  DEFAULT_EXIT_AFTER_CLEANUP_MS,
  DEFAULT_SHUTDOWN_DEADLINE_MS,
  SHUTDOWN_COMPLETE_MESSAGE,
  shutdownServerProcess
};
