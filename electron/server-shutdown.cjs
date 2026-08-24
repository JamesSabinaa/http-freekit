const http = require('http');

const SHUTDOWN_COMPLETE_MESSAGE = 'http-freekit:shutdown-complete';
const SHUTDOWN_FAILED_MESSAGE = 'http-freekit:shutdown-failed';
const SHUTDOWN_PROGRESS_MESSAGE = 'http-freekit:shutdown-progress';
const DEFAULT_SHUTDOWN_DEADLINE_MS = 30_000;
const DEFAULT_EXIT_AFTER_CLEANUP_MS = 1_000;
const DEFAULT_FORCE_KILL_CONFIRMATION_MS = 2_000;
const MAX_SHUTDOWN_PROGRESS_TIMEOUT_MS = (2 * 60 * 60 * 1000) + 5_000;

function hasExited(proc) {
  return (proc.exitCode !== null && proc.exitCode !== undefined)
    || (proc.signalCode !== null && proc.signalCode !== undefined);
}

/**
 * Ask the backend to shut down and wait for its cleanup to finish.
 *
 * The backend reports when cleanup is complete over the child-process IPC
 * channel. At that point it is safe to force a process that fails to exit.
 * The initial deadline covers admission and setup. Once the backend reports a
 * bounded cleanup operation, its advertised timeout becomes a stall deadline.
 * A forced kill is only considered successful after process exit is observed.
 */
function shutdownServerProcess({
  proc,
  apiPort,
  authToken,
  request = http.request,
  deadlineMs = DEFAULT_SHUTDOWN_DEADLINE_MS,
  exitAfterCleanupMs = DEFAULT_EXIT_AFTER_CLEANUP_MS,
  forceKillConfirmationMs = DEFAULT_FORCE_KILL_CONFIRMATION_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout
}) {
  if (!proc || hasExited(proc)) {
    return Promise.resolve({ reason: 'already-exited', cleanupComplete: false });
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let cleanupComplete = false;
    let deadlineTimer = null;
    let exitAfterCleanupTimer = null;
    let forceKillConfirmationTimer = null;
    let forcedReason = null;

    const finish = (reason) => {
      if (settled) return;
      settled = true;
      if (deadlineTimer !== null) clearTimeoutFn(deadlineTimer);
      if (exitAfterCleanupTimer !== null) clearTimeoutFn(exitAfterCleanupTimer);
      if (forceKillConfirmationTimer !== null) clearTimeoutFn(forceKillConfirmationTimer);
      proc.removeListener('exit', onExit);
      proc.removeListener('message', onMessage);
      resolve({ reason, cleanupComplete });
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      if (deadlineTimer !== null) clearTimeoutFn(deadlineTimer);
      if (exitAfterCleanupTimer !== null) clearTimeoutFn(exitAfterCleanupTimer);
      if (forceKillConfirmationTimer !== null) clearTimeoutFn(forceKillConfirmationTimer);
      proc.removeListener('exit', onExit);
      proc.removeListener('message', onMessage);
      reject(error);
    };

    const forceKill = (reason) => {
      if (hasExited(proc)) {
        finish(reason);
        return;
      }
      forcedReason = reason;
      try {
        if (proc.kill('SIGKILL') === false) {
          fail(new Error(`Backend shutdown failed: SIGKILL was not delivered after ${reason}`));
          return;
        }
      } catch (error) {
        fail(new Error(
          `Backend shutdown failed: SIGKILL could not be delivered after ${reason}: ${error.message}`,
          { cause: error }
        ));
        return;
      }
      if (hasExited(proc)) {
        finish(reason);
        return;
      }
      forceKillConfirmationTimer = setTimeoutFn(() => {
        if (hasExited(proc)) finish(reason);
        else fail(new Error(`Backend shutdown failed: exit was not confirmed after ${reason}`));
      }, forceKillConfirmationMs);
    };

    const armDeadline = (timeoutMs) => {
      if (deadlineTimer !== null) clearTimeoutFn(deadlineTimer);
      deadlineTimer = setTimeoutFn(() => forceKill('deadline'), timeoutMs);
    };

    const onExit = () => finish(forcedReason || 'exit');
    const onMessage = (message) => {
      if (forcedReason) return;
      if (message?.type === SHUTDOWN_PROGRESS_MESSAGE && !cleanupComplete) {
        const timeoutMs = Number(message.timeoutMs);
        if (Number.isSafeInteger(timeoutMs) && timeoutMs > 0) {
          armDeadline(Math.min(timeoutMs, MAX_SHUTDOWN_PROGRESS_TIMEOUT_MS));
        }
        return;
      }
      if (message?.type === SHUTDOWN_FAILED_MESSAGE) {
        fail(new Error(message.error || 'Backend reported incomplete shutdown cleanup'));
        return;
      }
      if (message?.type === SHUTDOWN_COMPLETE_MESSAGE && !cleanupComplete) {
        cleanupComplete = true;
        if (deadlineTimer !== null) {
          clearTimeoutFn(deadlineTimer);
          deadlineTimer = null;
        }
        exitAfterCleanupTimer = setTimeoutFn(
          () => forceKill('cleanup-complete-exit-timeout'),
          exitAfterCleanupMs
        );
      }
    };

    proc.once('exit', onExit);
    proc.on('message', onMessage);
    if (hasExited(proc)) {
      finish('exit');
      return;
    }
    armDeadline(deadlineMs);

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
  DEFAULT_FORCE_KILL_CONFIRMATION_MS,
  DEFAULT_SHUTDOWN_DEADLINE_MS,
  MAX_SHUTDOWN_PROGRESS_TIMEOUT_MS,
  SHUTDOWN_COMPLETE_MESSAGE,
  SHUTDOWN_FAILED_MESSAGE,
  SHUTDOWN_PROGRESS_MESSAGE,
  shutdownServerProcess
};
