import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const PYTHON_PROBE = `
import importlib.util, json, sys
missing = [name for name in ("PySide6", "bottingtools", "config") if importlib.util.find_spec(name) is None]
if missing:
    raise RuntimeError("Missing Generator dependencies: " + ", ".join(missing))
print(json.dumps({"executable": sys.executable}))
`;

const CONFIG_PROBE = `
import json
from PySide6.QtWidgets import QApplication
import config
config.load_config()
print(json.dumps({"harsBaseDir": str(config.HARS_BASE_DIR)}))
`;

// Run the unmodified Generator entry point, acknowledging startup only once its
// Qt event loop is running and a top-level window is visible. pythonw otherwise
// hides import errors, and a successful OS spawn says nothing about GUI startup.
export const GENERATOR_LAUNCH_SCRIPT = `
import json, os, runpy, sys, traceback
ready_path, log_path, entry_point = sys.argv[1:4]
app_args = sys.argv[4:]
with open(log_path, "a", encoding="utf-8", buffering=1) as log:
    sys.stdout = log
    sys.stderr = log
    try:
        from PySide6.QtCore import QTimer
        from PySide6.QtWidgets import QApplication
        original_exec = QApplication.exec
        def acknowledge_window():
            windows = [w for w in QApplication.topLevelWidgets() if w.isVisible() and w.isWindow()]
            if not windows:
                QTimer.singleShot(50, acknowledge_window)
                return
            windows[0].raise_()
            windows[0].activateWindow()
            with open(ready_path, "w", encoding="utf-8") as ready:
                json.dump({"ready": True, "pid": os.getpid()}, ready)
        def exec_with_acknowledgement():
            QTimer.singleShot(0, acknowledge_window)
            return original_exec()
        QApplication.exec = staticmethod(exec_with_acknowledgement)
        sys.argv = [entry_point, *app_args]
        runpy.run_path(entry_point, run_name="__main__")
    except SystemExit:
        raise
    except BaseException:
        traceback.print_exc(file=log)
        raise SystemExit(1)
`;

function pythonJson(command, args, script, { cwd, timeout, env }) {
  return new Promise((resolve, reject) => {
    execFile(command, [...args, '-c', script], {
      cwd, timeout, env, windowsHide: true, maxBuffer: 64 * 1024
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = error.killed
          ? 'Python check timed out.'
          : (stderr || error.message).trim().split(/\r?\n/).at(-1).slice(-500);
        reject(new Error(detail));
        return;
      }
      const lines = stdout.split(/\r?\n/).reverse();
      for (const rawLine of lines) {
        const line = rawLine.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
        try {
          const result = JSON.parse(line.slice(line.indexOf('{'), line.lastIndexOf('}') + 1));
          if (result && typeof result === 'object') return resolve(result);
        } catch {}
      }
      reject(new Error('Generator did not return its configuration.'));
    });
  });
}

export async function resolveGeneratorRuntime(candidates, {
  cwd, harsBaseDir, env = process.env, probeTimeoutMs = 2000, configTimeoutMs = 10000
} = {}) {
  // Probe launchers together so a stale/hung launcher cannot delay a working
  // interpreter by 30 seconds per fallback. Deduplicate their actual runtimes.
  const probes = await Promise.allSettled(candidates.map(candidate => pythonJson(
    candidate.command, candidate.args, PYTHON_PROBE,
    { cwd, env, timeout: probeTimeoutMs }
  )));
  const errors = [];
  const seen = new Set();
  const deadline = Date.now() + configTimeoutMs;
  for (let index = 0; index < probes.length; index++) {
    const probe = probes[index];
    const label = [candidates[index].command, ...candidates[index].args].join(' ');
    if (probe.status === 'rejected') {
      errors.push(`${label}: ${probe.reason.message}`);
      continue;
    }
    const executable = probe.value.executable;
    if (typeof executable !== 'string' || !path.isAbsolute(executable)) {
      errors.push(`${label}: Python did not identify its executable`);
      continue;
    }
    const key = process.platform === 'win32' ? executable.toLowerCase() : executable;
    if (seen.has(key)) continue;
    seen.add(key);
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const result = await pythonJson(executable, [], CONFIG_PROBE, { cwd, env, timeout: remaining });
      const directory = harsBaseDir || result.harsBaseDir;
      if (typeof directory !== 'string' || !directory.trim()) {
        throw new Error('Generator did not identify its HAR directory.');
      }
      return { executable, harsBaseDir: directory };
    } catch (error) {
      errors.push(`${executable}: ${error.message}`);
    }
  }
  throw new Error(`Could not find Python with Generator's GUI dependencies. ${errors.join('; ')}`);
}

export async function getGeneratorLaunchExecutable(executable, platform = process.platform) {
  if (platform === 'win32' && /^python(?:\d+(?:\.\d+)*)?\.exe$/i.test(path.basename(executable))) {
    const windowed = path.join(path.dirname(executable), 'pythonw.exe');
    try {
      if ((await fs.stat(windowed)).isFile()) return windowed;
    } catch {}
  }
  // Never fall back to unqualified pyw: it may select a different Python version.
  return executable;
}

async function startupLog(logPath) {
  let handle;
  try {
    handle = await fs.open(logPath, 'r');
    const { size } = await handle.stat();
    const buffer = Buffer.alloc(Math.min(size, 4000));
    await handle.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
    return buffer.toString('utf8').trim();
  } catch {
    return '';
  } finally {
    await handle?.close();
  }
}

export async function waitForGeneratorWindow(child, readyPath, logPath, timeoutMs = 15000) {
  let failure = null;
  let exited = child.exitCode !== null || child.signalCode !== null;
  const onError = error => { failure = error; };
  const onExit = (code, signal) => {
    exited = true;
    failure ||= new Error(`Generator exited before opening its window (${signal || `code ${code}`}).`);
  };
  child.on('error', onError);
  child.once('exit', onExit);
  const deadline = Date.now() + timeoutMs;
  try {
    while (true) {
      if (failure || exited) throw failure || new Error('Generator exited before opening its window.');
      try {
        const ready = JSON.parse(await fs.readFile(readyPath, 'utf8'));
        if (failure || exited) throw failure || new Error('Generator exited before opening its window.');
        if (ready.ready === true && ready.pid === child.pid) return;
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      }
      if (Date.now() >= deadline) throw new Error('Generator did not open its window within 15 seconds.');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  } catch (error) {
    if (!exited && child.pid) {
      try { child.kill(); } catch {}
      const stopDeadline = Date.now() + 2000;
      while (!exited && Date.now() < stopDeadline) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      if (!exited) error.keepGeneratorSession = true;
    }
    const log = await startupLog(logPath);
    if (log) error.message += `\n${log}`;
    throw error;
  } finally {
    child.removeListener('exit', onExit);
    // Retain an error listener on the detached process after successful startup.
  }
}

export async function launchGenerator(executable, args, { cwd, sessionDir, env = process.env } = {}) {
  const command = await getGeneratorLaunchExecutable(executable);
  const readyPath = path.join(sessionDir, '.freekit-generator-ready.json');
  const logPath = path.join(sessionDir, '.freekit-generator-startup.log');
  await fs.writeFile(logPath, '', { mode: 0o600 });
  const child = spawn(command, [
    '-c', GENERATOR_LAUNCH_SCRIPT, readyPath, logPath, path.resolve(cwd, args[0]), ...args.slice(1)
  ], { cwd, env, detached: true, stdio: 'ignore', windowsHide: true });
  await waitForGeneratorWindow(child, readyPath, logPath);
  await fs.unlink(readyPath).catch(() => {});
  child.unref();
  return child;
}
