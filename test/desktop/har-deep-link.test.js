import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  isHarTarget,
  isLocalHarFileTarget,
  loadHarTarget
} = require('../../electron/har-deep-link.cjs');
const { parseOpenDeepLink } = require('../../electron/deep-link.cjs');
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

test('recognizes remote and local HAR targets by URL path', () => {
  assert.equal(isHarTarget('https://example.test/capture.har?download=1'), true);
  assert.equal(isHarTarget('https://example.test/CAPTURE.HAR#traffic'), true);
  assert.equal(isHarTarget('file:///C:/captures/session.har'), true);
  assert.equal(isHarTarget('https://example.test/capture.har.json'), false);
  assert.equal(isHarTarget('not a URL'), false);
});

test('deep links accept local HAR files but reject other local file URLs', () => {
  const harTarget = 'file:///C:/captures/session.har';
  assert.equal(
    parseOpenDeepLink(`http-freekit://open?url=${encodeURIComponent(harTarget)}`),
    harTarget
  );
  assert.throws(
    () => parseOpenDeepLink(
      `http-freekit://open?url=${encodeURIComponent('file:///C:/captures/session.json')}`
    ),
    /Only HTTP, HTTPS, and \.har file URLs/
  );
});

test('Windows HAR file targets reject UNC hosts, alternate UNC spellings, and devices', async () => {
  const unsafeTargets = [
    'file://nas/share.har',
    'file:////nas/share.har',
    'file:///%3F/C:/capture.har',
    'file:///C:/NUL.har'
  ];

  assert.equal(isLocalHarFileTarget('file:///C:/captures/session.har', 'win32'), true);
  assert.equal(isLocalHarFileTarget('file:///tmp/session.har', 'linux'), true);
  for (const target of unsafeTargets) {
    assert.equal(isLocalHarFileTarget(target, 'win32'), false, target);
    assert.throws(
      () => parseOpenDeepLink(
        `http-freekit://open?url=${encodeURIComponent(target)}`,
        { platform: 'win32' }
      ),
      /Only HTTP, HTTPS, and \.har file URLs/
    );
    await assert.rejects(
      loadHarTarget(target, { platform: 'win32' }),
      /cannot use UNC or device paths/
    );
  }
});

test('loads a local HAR file and enforces the import size limit', async t => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'http-freekit-har-link-'));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
  const filePath = path.join(tempDir, 'capture.har');
  const contents = '{"log":{"entries":[]}}';
  await fs.writeFile(filePath, contents);

  const target = pathToFileURL(filePath).href;
  assert.equal((await loadHarTarget(target)).toString('utf8'), contents);
  await assert.rejects(loadHarTarget(target, { maxBytes: 5 }), /5 bytes or smaller/);
});

test('downloads a remote HAR and rejects oversized responses', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return new Response('{"log":{"entries":[]}}', {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };

  const target = 'https://example.test/capture.har?download=1';
  assert.equal(
    (await loadHarTarget(target, { fetchImpl, lookupImpl: publicLookup })).toString('utf8'),
    '{"log":{"entries":[]}}'
  );
  assert.equal(calls[0].url, target);
  assert.equal(calls[0].options.redirect, 'manual');
  assert.ok(calls[0].options.signal instanceof AbortSignal);

  await assert.rejects(
    loadHarTarget(target, {
      maxBytes: 5,
      lookupImpl: publicLookup,
      fetchImpl: async () => new Response('oversized', {
        status: 200,
        headers: { 'content-length': '9' }
      })
    }),
    /5 bytes or smaller/
  );
});

test('reports unsuccessful HAR downloads without importing their bodies', async () => {
  await assert.rejects(
    loadHarTarget('https://example.test/missing.har', {
      lookupImpl: publicLookup,
      fetchImpl: async () => new Response('missing', { status: 404 })
    }),
    /HAR download returned HTTP 404/
  );
});

test('remote HAR downloads reject loopback and private destinations before Fetch', async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    return new Response('{}');
  };

  await assert.rejects(
    loadHarTarget('http://127.0.0.1/capture.har', { fetchImpl }),
    /public network addresses/
  );
  await assert.rejects(
    loadHarTarget('https://intranet.test/capture.har', {
      fetchImpl,
      lookupImpl: async () => [{ address: '192.168.1.10', family: 4 }]
    }),
    /public network addresses/
  );
  assert.equal(fetchCalls, 0);
});

test('remote HAR downloads reject IPv4-mapped private IPv6 destinations', async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    return new Response('{}');
  };

  await assert.rejects(
    loadHarTarget('http://[::ffff:7f00:1]/capture.har', { fetchImpl }),
    /public network addresses/
  );
  await assert.rejects(
    loadHarTarget('https://mapped-private.test/capture.har', {
      fetchImpl,
      // Derive the family from the address instead of trusting resolver metadata.
      lookupImpl: async () => [{ address: '::ffff:192.168.1.10', family: 4 }]
    }),
    /public network addresses/
  );
  assert.equal(fetchCalls, 0);
});

test('remote HAR downloads reject deprecated and translated special-use addresses', async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    return new Response('{}');
  };

  for (const target of [
    'http://[fec0::1]/capture.har',
    'http://[100::1]/capture.har',
    'http://[64:ff9b::7f00:1]/capture.har',
    'http://[::ffff:0:7f00:1]/capture.har',
    'http://[2002:7f00:1::]/capture.har',
    'http://[3fff::1]/capture.har'
  ]) {
    await assert.rejects(
      loadHarTarget(target, { fetchImpl }),
      /public network addresses/,
      target
    );
  }
  await assert.rejects(
    loadHarTarget('https://deprecated-relay.test/capture.har', {
      fetchImpl,
      lookupImpl: async () => [{ address: '192.88.99.1', family: 4 }]
    }),
    /public network addresses/
  );
  assert.equal(fetchCalls, 0);
});

test('the HAR download deadline also bounds an unresolved DNS lookup', async () => {
  let fetchCalls = 0;
  const startedAt = Date.now();
  await assert.rejects(
    loadHarTarget('https://never-resolves.test/capture.har', {
      timeoutMs: 20,
      lookupImpl: () => new Promise(() => {}),
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response('{}');
      }
    }),
    /Timed out downloading HAR file/
  );
  assert.ok(Date.now() - startedAt < 1000, 'DNS timeout should return promptly');
  assert.equal(fetchCalls, 0);
});

test('remote HAR connections use only the validated DNS result and close their dispatcher', async () => {
  let lookupCalls = 0;
  const dispatcherStates = [];
  const dispatcherFactory = lookup => {
    const state = { closed: false, dispatcher: null, pinnedAddresses: null };
    state.pinnedAddresses = new Promise((resolve, reject) => {
      lookup('rebind.test', { all: true }, (error, addresses) => {
        if (error) reject(error);
        else resolve(addresses);
      });
    });
    state.dispatcher = {
      async close() { state.closed = true; }
    };
    dispatcherStates.push(state);
    return state.dispatcher;
  };
  const lookupImpl = async () => {
    lookupCalls += 1;
    return lookupCalls === 1
      ? [{ address: '93.184.216.34', family: 4 }]
      : [{ address: '127.0.0.1', family: 4 }];
  };

  const body = await loadHarTarget('https://rebind.test/capture.har', {
    lookupImpl,
    dispatcherFactory,
    fetchImpl: async (_url, options) => {
      const state = dispatcherStates.at(-1);
      assert.equal(options.dispatcher, state.dispatcher);
      assert.deepEqual(
        await state.pinnedAddresses,
        [{ address: '93.184.216.34', family: 4 }]
      );
      return new Response('{"log":{"entries":[]}}');
    }
  });

  assert.equal(body.toString('utf8'), '{"log":{"entries":[]}}');
  assert.equal(lookupCalls, 1);
  assert.equal(dispatcherStates.length, 1);
  assert.equal(dispatcherStates[0].closed, true);
});

test('every remote HAR redirect is resolved and private redirect hops are rejected', async () => {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    return new Response(null, {
      status: 302,
      headers: { location: 'http://localhost/internal.har' }
    });
  };

  await assert.rejects(
    loadHarTarget('https://example.test/capture.har', {
      fetchImpl,
      lookupImpl: publicLookup
    }),
    /public network addresses/
  );
  assert.deepEqual(calls, ['https://example.test/capture.har']);
});

test('remote HAR downloads follow a bounded public redirect manually', async () => {
  const calls = [];
  const dispatcherStates = [];
  const dispatcherFactory = lookup => {
    const state = { closed: false, dispatcher: null };
    state.dispatcher = {
      lookup,
      async close() { state.closed = true; }
    };
    dispatcherStates.push(state);
    return state.dispatcher;
  };
  const fetchImpl = async (url, options) => {
    assert.equal(options.dispatcher, dispatcherStates.at(-1).dispatcher);
    calls.push([url, options.redirect]);
    if (calls.length === 1) {
      return new Response(null, {
        status: 302,
        headers: { location: 'https://cdn.example.test/final.har' }
      });
    }
    return new Response('{"log":{"entries":[]}}');
  };

  const body = await loadHarTarget('https://example.test/capture.har', {
    fetchImpl,
    lookupImpl: publicLookup,
    dispatcherFactory
  });
  assert.equal(body.toString('utf8'), '{"log":{"entries":[]}}');
  assert.deepEqual(calls, [
    ['https://example.test/capture.har', 'manual'],
    ['https://cdn.example.test/final.har', 'manual']
  ]);
  assert.equal(dispatcherStates.length, 2);
  assert.equal(dispatcherStates.every(state => state.closed), true);
});
