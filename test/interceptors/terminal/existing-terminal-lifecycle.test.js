import assert from 'node:assert/strict';
import test from 'node:test';
import { ExistingTerminalInterceptor } from '../../../src/interceptors/terminal-interceptors.js';

test('Existing Terminal returns instructions without claiming an active lifecycle', async () => {
  const interceptor = new ExistingTerminalInterceptor();
  interceptor.ca = { getCertInfo: () => ({ certificatePath: '/tmp/freekit-ca.pem' }) };

  const result = await interceptor.activate(8080);

  assert.equal(result.success, true);
  assert.equal(result.metadata.instructionsOnly, true);
  assert.match(result.metadata.lifecycleNote, /until you unset them or close that shell/);
  assert.equal(await interceptor.isActive(), false);
  assert.equal(interceptor.toJSON().active, false);
});
