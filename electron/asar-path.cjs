const path = require('path');

const PACKED_RESOURCES_PATTERN = /(?:^|[\\/])resources[\\/]app\.asar(?=$|[\\/])/g;

/**
 * Rewrite the last exact resources/app.asar segment in a path to the
 * corresponding unpacked archive. Earlier matching ancestors are preserved.
 */
function rewriteResourcesAsarToUnpacked(targetPath) {
  let terminalMatch = null;
  for (const match of targetPath.matchAll(PACKED_RESOURCES_PATTERN)) {
    terminalMatch = match;
  }

  if (!terminalMatch) return targetPath;

  const archiveEnd = terminalMatch.index + terminalMatch[0].length;
  const archiveStart = archiveEnd - 'app.asar'.length;
  return targetPath.slice(0, archiveStart) +
    'app.asar.unpacked' +
    targetPath.slice(archiveEnd);
}

function resolveBundledServerScript(appDirectory, pathApi = path) {
  const packedServer = pathApi.resolve(appDirectory, '..', 'src', 'index.js');
  return rewriteResourcesAsarToUnpacked(packedServer);
}

function resolveBundledNodeExecutable(
  appDirectory,
  platform = process.platform,
  pathApi = path
) {
  const executableName = platform === 'win32' ? 'node.exe' : 'node';
  const packedExecutable = pathApi.resolve(
    appDirectory,
    '..',
    'node_modules',
    'node',
    'bin',
    executableName
  );
  return rewriteResourcesAsarToUnpacked(packedExecutable);
}

module.exports = {
  resolveBundledNodeExecutable,
  resolveBundledServerScript,
  rewriteResourcesAsarToUnpacked
};
