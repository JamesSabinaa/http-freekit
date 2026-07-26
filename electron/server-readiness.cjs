'use strict';

const SERVER_READY_MESSAGE_TYPE = 'http-freekit:server-ready';

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
  SERVER_READY_MESSAGE_TYPE,
  waitForServer
};
