import { execFile } from 'child_process';

export function execFileAsync(file, args = [], options = {}) {
  const { stdio: _stdio, onSpawn, ...execOptions } = options;
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, execOptions, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout ?? '');
    });
    if (onSpawn) child.once('spawn', onSpawn);
  });
}
