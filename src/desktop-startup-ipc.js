export const DESKTOP_API_PORT_IN_USE_MESSAGE_TYPE = 'http-freekit:api-port-in-use';

const DEFAULT_IPC_SEND_TIMEOUT_MS = 250;

/**
 * Tell the Electron parent that the requested API port was claimed before the
 * child could bind it. Waiting for the send callback keeps process.exit() from
 * discarding the retry signal, while the short timeout keeps startup bounded
 * if the IPC channel is broken.
 */
export function reportDesktopApiPortInUse(port, ipcProcess = process, {
  timeoutMs = DEFAULT_IPC_SEND_TIMEOUT_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout
} = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 ||
      typeof ipcProcess?.send !== 'function' || !ipcProcess.connected) {
    return Promise.resolve(false);
  }

  return new Promise(resolve => {
    let settled = false;
    let timeout = null;
    const finish = delivered => {
      if (settled) return;
      settled = true;
      if (timeout !== null) clearTimeoutFn(timeout);
      resolve(delivered);
    };

    timeout = setTimeoutFn(() => finish(false), timeoutMs);
    try {
      ipcProcess.send(
        { type: DESKTOP_API_PORT_IN_USE_MESSAGE_TYPE, port },
        error => finish(!error)
      );
    } catch {
      finish(false);
    }
  });
}
