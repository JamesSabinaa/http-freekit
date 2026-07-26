import assert from 'node:assert/strict';
import test from 'node:test';

import { restoreSavedRuleSettings } from '../src/startup-rule-restoration.js';

const savedMockRules = [{ id: 'legacy-mock-group' }];
const savedBreakpointRules = [{ id: 'legacy-breakpoint' }];
const normalizedMockRules = [{ id: 'normalized-mock' }];
const normalizedBreakpointRules = [{ id: 'normalized-breakpoint' }];

function createHarness({
  mockMigrated = true,
  breakpointMigrated = true,
  failWrites = [],
  failLoader = null,
  savedMocks = savedMockRules,
  savedBreakpoints = savedBreakpointRules,
  includeMocks = true,
  includeBreakpoints = true
} = {}) {
  const saved = new Map();
  if (includeMocks) saved.set('mockRules', savedMocks);
  if (includeBreakpoints) saved.set('breakpointRules', savedBreakpoints);
  const writeAttempts = [];
  const persisted = new Map();
  const loads = [];
  const warnings = [];
  const logs = [];
  const loaderErrors = {
    mockRules: new Error('mock rule validation failed'),
    breakpointRules: new Error('breakpoint rule validation failed')
  };
  const writeErrors = {
    mockRules: new Error('mock migration disk full'),
    breakpointRules: new Error('breakpoint migration permission denied')
  };
  const settings = {
    get: key => saved.get(key),
    set(key, value) {
      writeAttempts.push({ key, value });
      if (failWrites.includes(key)) throw writeErrors[key];
      persisted.set(key, value);
    }
  };
  const proxy = {
    mockRules: [],
    breakpointRules: [],
    loadMockRules(rules) {
      loads.push({ key: 'mockRules', rules });
      if (failLoader === 'mockRules') throw loaderErrors.mockRules;
      this.mockRules = normalizedMockRules;
      return { migrated: mockMigrated, rules: normalizedMockRules };
    },
    loadBreakpoints(rules) {
      loads.push({ key: 'breakpointRules', rules });
      if (failLoader === 'breakpointRules') throw loaderErrors.breakpointRules;
      this.breakpointRules = normalizedBreakpointRules;
      return { migrated: breakpointMigrated, rules: normalizedBreakpointRules };
    }
  };
  const logger = {
    log: message => logs.push(message),
    warn: message => warnings.push(message)
  };

  return {
    loaderErrors,
    loads,
    logs,
    persisted,
    proxy,
    run: () => restoreSavedRuleSettings(proxy, settings, logger),
    warnings,
    writeAttempts,
    writeErrors
  };
}

test('successful startup migration installs and persists both normalized rule collections', () => {
  const harness = createHarness();

  harness.run();

  assert.deepEqual(harness.loads, [
    { key: 'mockRules', rules: savedMockRules },
    { key: 'breakpointRules', rules: savedBreakpointRules }
  ]);
  assert.equal(harness.proxy.mockRules, normalizedMockRules);
  assert.equal(harness.proxy.breakpointRules, normalizedBreakpointRules);
  assert.deepEqual(harness.writeAttempts, [
    { key: 'mockRules', value: normalizedMockRules },
    { key: 'breakpointRules', value: normalizedBreakpointRules }
  ]);
  assert.equal(harness.persisted.get('mockRules'), normalizedMockRules);
  assert.equal(harness.persisted.get('breakpointRules'), normalizedBreakpointRules);
  assert.deepEqual(harness.warnings, []);
  assert.deepEqual(harness.logs, [
    '[Boot] Restored 1 mock rules from settings',
    '[Boot] Restored 1 breakpoint rules from settings'
  ]);
});

test('migration write failures are independent and retain normalized runtime rules', async t => {
  for (const [label, failWrites] of [
    ['mock only', ['mockRules']],
    ['breakpoint only', ['breakpointRules']],
    ['both collections', ['mockRules', 'breakpointRules']]
  ]) {
    await t.test(label, () => {
      const harness = createHarness({ failWrites });

      assert.doesNotThrow(harness.run);

      assert.deepEqual(
        harness.loads.map(load => load.key),
        ['mockRules', 'breakpointRules'],
        'both runtime loaders are attempted'
      );
      assert.deepEqual(
        harness.writeAttempts.map(write => write.key),
        ['mockRules', 'breakpointRules'],
        'both migrated writes are attempted'
      );
      assert.equal(harness.proxy.mockRules, normalizedMockRules);
      assert.equal(harness.proxy.breakpointRules, normalizedBreakpointRules);
      assert.equal(harness.warnings.length, failWrites.length);

      if (failWrites.includes('mockRules')) {
        assert.match(
          harness.warnings.find(warning => warning.includes('"mockRules"')),
          /\[Boot\] WARNING: Mock rules.*"mockRules".*mock migration disk full.*continue.*normalized runtime rules/i
        );
        assert.equal(harness.persisted.has('mockRules'), false);
      } else {
        assert.equal(harness.persisted.get('mockRules'), normalizedMockRules);
      }

      if (failWrites.includes('breakpointRules')) {
        assert.match(
          harness.warnings.find(warning => warning.includes('"breakpointRules"')),
          /\[Boot\] WARNING: Breakpoint rules.*"breakpointRules".*permission denied.*continue.*normalized runtime rules/i
        );
        assert.equal(harness.persisted.has('breakpointRules'), false);
      } else {
        assert.equal(harness.persisted.get('breakpointRules'), normalizedBreakpointRules);
      }
    });
  }
});

test('already-normalized or absent collections do not trigger migration writes', () => {
  const normalized = createHarness({
    mockMigrated: false,
    breakpointMigrated: false
  });

  normalized.run();

  assert.deepEqual(normalized.writeAttempts, []);
  assert.equal(normalized.proxy.mockRules, normalizedMockRules);
  assert.equal(normalized.proxy.breakpointRules, normalizedBreakpointRules);

  const absent = createHarness({ includeMocks: false, includeBreakpoints: false });
  absent.run();
  assert.deepEqual(absent.loads, []);
  assert.deepEqual(absent.writeAttempts, []);
});

test('rule loader and validation failures still propagate without broad startup catches', async t => {
  await t.test('mock loader', () => {
    const harness = createHarness({ failLoader: 'mockRules' });

    assert.throws(harness.run, error => error === harness.loaderErrors.mockRules);
    assert.deepEqual(harness.loads.map(load => load.key), ['mockRules']);
    assert.deepEqual(harness.writeAttempts, []);
    assert.deepEqual(harness.warnings, []);
  });

  await t.test('breakpoint loader', () => {
    const harness = createHarness({ failLoader: 'breakpointRules' });

    assert.throws(harness.run, error => error === harness.loaderErrors.breakpointRules);
    assert.deepEqual(
      harness.loads.map(load => load.key),
      ['mockRules', 'breakpointRules']
    );
    assert.deepEqual(harness.writeAttempts.map(write => write.key), ['mockRules']);
    assert.equal(harness.persisted.get('mockRules'), normalizedMockRules);
    assert.deepEqual(harness.warnings, []);
  });
});
