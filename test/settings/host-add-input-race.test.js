import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync('src/ui/app.js', 'utf8');
for (const name of ['TlsPassthrough', 'HttpsWhitelist']) {
  test(`${name} Add preserves newer input while clearing an unchanged successful submission`, async () => {
    const start = source.indexOf(`async function add${name}(`);
    const end = source.indexOf(`async function remove${name}(`, start);
    assert.ok(start >= 0 && end > start);
    for (const [newValue, success, expected] of [
      ['second.example', true, 'second.example'],
      [' first.example ', true, ''],
      ['first.example  ', true, 'first.example  '],
      [' first.example ', false, ' first.example ']
    ]) {
      const input = { value: ' first.example ' };
      let release;
      let submitted;
      const context = {
        API_BASE: '', document: { getElementById: () => input },
        beginSettingsMutation: () => ({}), isCurrentSettingsOperation: () => true,
        finishSettingsMutation: () => {}, toast: () => {},
        readSettingsMutationResponse: async response => {
          if (!response.ok) throw new Error('rejected');
          return response.json();
        },
        [`load${name}`]: () => {}, [`render${name}`]: () => {},
        fetch: (_url, options) => {
          submitted = JSON.parse(options.body);
          return new Promise(resolve => { release = resolve; });
        }
      };
      vm.runInNewContext(source.slice(start, end), context);
      const pending = context[`add${name}`]();
      input.value = newValue;
      release({ ok: success, json: async () => ({ hosts: ['first.example'] }) });
      await pending;
      assert.equal(submitted.host, 'first.example');
      assert.equal(input.value, expected);
    }
  });
}
