import fs from 'fs';
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

export function findBrowserPath(browser) {
  const platform = process.platform;
  const paths = BROWSER_PATHS[browser]?.[platform] || [];
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}
