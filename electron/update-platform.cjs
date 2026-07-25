function shouldForceLinuxUpdateChecks(platform, isPackaged, env = {}) {
  return platform === 'linux' &&
    isPackaged === true &&
    !env.APPIMAGE &&
    !env.SNAP;
}

module.exports = { shouldForceLinuxUpdateChecks };
