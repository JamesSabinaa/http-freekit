const path = require('path');

function resolveDesktopMcpExecutable({
  platform = process.platform,
  execPath = process.execPath,
  appImage = process.env.APPIMAGE,
  isPackaged = false
} = {}) {
  const executable = platform === 'linux' && isPackaged && appImage
    ? appImage
    : execPath;
  return path.resolve(executable);
}

module.exports = { resolveDesktopMcpExecutable };
