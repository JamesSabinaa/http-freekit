'use strict';

const SERVER_READY_MESSAGE_TYPE = 'http-freekit:server-ready';
const SERVER_API_PORT_IN_USE_MESSAGE_TYPE = 'http-freekit:api-port-in-use';
const DEFAULT_STARTUP_TERMINATION_TIMEOUT_MS = 5_000;

function hasExited(proc) {
  return (proc.exitCode !== null && proc.exitCode !== undefined)
    || (proc.signalCode !== null && proc.signalCode !== undefined);
}

/**
 * Force-stop a child whose startup failed and confirm it has exited before a
 * replacement is spawned. A false result means callers must keep tracking the
 * child and must not retry alongside it.
 */
function terminateServerStartupProcess(proc, timeoutMs = DEFAULT_STARTUP_TERMINATION_TIMEOUT_MS, {
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout
} = {}) {
  if (!proc || hasExited(proc)) return Promise.resolve(true);

  return new Promise(resolve => {
    let settled = false;
    let timeout = null;
    const finish = stopped => {
      if (settled) return;
      settled = true;
      proc.removeListener('exit', onExit);
      if (timeout !== null) clearTimeoutFn(timeout);
      resolve(stopped);
    };
    const onExit = () => finish(true);

    proc.once('exit', onExit);
    if (hasExited(proc)) {
      finish(true);
      return;
    }

    try {
      proc.kill('SIGKILL');
    } catch {}

    if (settled) return;
    if (hasExited(proc)) {
      finish(true);
    } else {
      // kill() can return false when the process raced to a natural exit before
      // Node updated exitCode. Keep the exit listener for the bounded deadline
      // so that harmless race does not suppress a safe retry.
      timeout = setTimeoutFn(() => finish(false), timeoutMs);
    }
  });
}

/**
 * Wait for the exact spawned server process to report that its API listener is ready.
 */
function waitForServer(port, proc, timeoutMs = 30000, {
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout
} = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout = null;

    const cleanup = () => {
      proc.removeListener('message', onMessage);
      proc.removeListener('exit', onExit);
      if (timeout !== null) clearTimeoutFn(timeout);
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onMessage = message => {
      if (!message || typeof message !== 'object' || Array.isArray(message)) return;
      if (!Object.hasOwn(message, 'type') || !Object.hasOwn(message, 'port')) return;
      if (message.type === SERVER_API_PORT_IN_USE_MESSAGE_TYPE &&
          Number.isInteger(message.port) && message.port === port) {
        const error = new Error(`API port ${port} was claimed before the server could bind it`);
        error.code = 'EADDRINUSE';
        error.apiPort = port;
        settle(reject, error);
        return;
      }
      if (message.type !== SERVER_READY_MESSAGE_TYPE) return;
      if (!Number.isInteger(message.port) || message.port !== port) return;
      settle(resolve);
    };
    const onExit = code => {
      settle(reject, new Error(`Server process exited with code ${code} before becoming ready`));
    };

    proc.on('message', onMessage);
    proc.once('exit', onExit);
    timeout = setTimeoutFn(() => {
      settle(reject, new Error(`Server did not start within ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

module.exports = {
  DEFAULT_STARTUP_TERMINATION_TIMEOUT_MS,
  SERVER_API_PORT_IN_USE_MESSAGE_TYPE,
  SERVER_READY_MESSAGE_TYPE,
  terminateServerStartupProcess,
  waitForServer
};
