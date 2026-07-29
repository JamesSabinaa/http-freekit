import fs from 'fs';
import os from 'os';
import path from 'path';

// Browser path detection for Windows, macOS, Linux
export const BROWSER_PATHS = {
  chrome: {
    win32: [
      path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ],
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/snap/bin/chromium']
  },
  firefox: {
    win32: [
      path.join(process.env.PROGRAMFILES || '', 'Mozilla Firefox', 'firefox.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || '', 'Mozilla Firefox', 'firefox.exe'),
    ],
    darwin: ['/Applications/Firefox.app/Contents/MacOS/firefox'],
    linux: ['/usr/bin/firefox', '/snap/bin/firefox']
  },
  edge: {
    win32: [
      path.join(process.env.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ],
    darwin: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
    linux: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable']
  },
  brave: {
    win32: [
      path.join(process.env.PROGRAMFILES || '', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    ],
    darwin: ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
    linux: ['/usr/bin/brave-browser']
  }
};

const BROWSER_EXECUTABLES = {
  chrome: {
    win32: ['chrome.exe'],
    darwin: ['google-chrome', 'chrome'],
    linux: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']
  },
  firefox: {
    win32: ['firefox.exe'],
    darwin: ['firefox'],
    linux: ['firefox']
  },
  edge: {
    win32: ['msedge.exe'],
    darwin: ['microsoft-edge'],
    linux: ['microsoft-edge', 'microsoft-edge-stable']
  },
  brave: {
    win32: ['brave.exe'],
    darwin: ['brave-browser'],
    linux: ['brave-browser', 'brave-browser-stable']
  }
};

const MACOS_USER_APPLICATIONS = {
  chrome: 'Google Chrome.app/Contents/MacOS/Google Chrome',
  firefox: 'Firefox.app/Contents/MacOS/firefox',
  edge: 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  brave: 'Brave Browser.app/Contents/MacOS/Brave Browser'
};

function getPathValue(env) {
  const entry = Object.entries(env).find(([key]) => key.toLowerCase() === 'path');
  return entry?.[1] || '';
}

export function findBrowserPath(browser, options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const existsSync = options.existsSync || fs.existsSync;
  const realpathSync = options.realpathSync || fs.realpathSync;
  const homeDir = options.homeDir || os.homedir();
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const delimiter = platform === 'win32' ? ';' : ':';
  const candidates = [...(BROWSER_PATHS[browser]?.[platform] || [])];

  const userApplication = MACOS_USER_APPLICATIONS[browser];
  if (platform === 'darwin' && userApplication) {
    candidates.unshift(pathApi.join(homeDir, 'Applications', userApplication));
  }

  const executableNames = BROWSER_EXECUTABLES[browser]?.[platform] || [];
  for (const entry of getPathValue(env).split(delimiter)) {
    const directory = entry.trim().replace(/^"|"$/g, '');
    if (!directory) continue;
    for (const executable of executableNames) {
      candidates.push(pathApi.join(directory, executable));
    }
  }

  for (const p of new Set(candidates)) {
    if (!existsSync(p)) continue;
    if (platform !== 'darwin' || p.includes('.app/Contents/MacOS/')) return p;
    try {
      const resolved = realpathSync(p);
      if (resolved.includes('.app/Contents/MacOS/')) return resolved;
    } catch {
      // A PATH entry that cannot be resolved to an application bundle cannot
      // be launched safely through LaunchServices.
    }
  }
  return null;
}
