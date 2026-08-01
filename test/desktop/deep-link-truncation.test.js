import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const mainSource = fs.readFileSync(path.join(process.cwd(), 'electron', 'main.cjs'), 'utf8');
const requestStart = mainSource.indexOf('function requestOpenInProxiedChrome(url)');
const requestEnd = mainSource.indexOf('function handleDeepLink(', requestStart);
assert.ok(requestStart >= 0 && requestEnd > requestStart, 'deep-link request functions must be present');
const requestSource = mainSource.slice(requestStart, requestEnd);

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function withTimeout(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('deep-link queue did not advance')), milliseconds);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('a truncated deep-link response rejects once and lets the queued link proceed', async t => {
  const receivedUrls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      receivedUrls.push(JSON.parse(Buffer.concat(chunks).toString('utf8')).url);
      if (receivedUrls.length === 1) {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Length': '64',
          'Connection': 'close'
        });
        res.write('{"success":');
        setImmediate(() => res.destroy());
        return;
      }

      const responseBody = JSON.stringify({ success: true });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(responseBody)
      });
      res.end(responseBody);
    });
  });
  const port = await listen(server);
  t.after(() => new Promise(resolve => server.close(resolve)));

  const reportedErrors = [];
  const context = {
    Buffer,
    console,
    http,
    isHarTarget: () => false,
    showMainWindow: () => {},
    reportDeepLinkError: err => reportedErrors.push(err?.message || String(err))
  };
  vm.createContext(context);
  vm.runInContext(`
    let apiPort = ${port};
    const authToken = 'test-token';
    let deepLinkProcessing = Promise.resolve();
    ${requestSource}
    globalThis.enqueueDeepLink = scheduleDeepLink;
    globalThis.waitForDeepLinks = () => deepLinkProcessing;
  `, context);

  context.enqueueDeepLink('https://first.example/truncated');
  context.enqueueDeepLink('https://second.example/complete');
  await withTimeout(context.waitForDeepLinks(), 2000);

  assert.deepEqual(receivedUrls, [
    'https://first.example/truncated',
    'https://second.example/complete'
  ]);
  assert.equal(reportedErrors.length, 1);
  assert.match(reportedErrors[0], /aborted|closed|ended before completion/i);
});
