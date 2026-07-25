import { execFile } from 'child_process';

export function execFileAsync(file, args = [], options = {}) {
  const { stdio: _stdio, ...execOptions } = options;
  return new Promise((resolve, reject) => {
    execFile(file, args, execOptions, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout ?? '');
    });
  });
}
