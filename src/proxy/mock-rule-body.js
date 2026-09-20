import { deserialize, serialize } from 'node:v8';

export function isSerializedMockBody(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== 2 || !Object.hasOwn(value, 'type') ||
      !Object.hasOwn(value, 'data') || value.type !== 'Buffer' || !Array.isArray(value.data)) {
    return false;
  }
  if (Object.keys(value.data).length !== value.data.length) return false;
  for (let index = 0; index < value.data.length; index++) {
    if (!Object.hasOwn(value.data, index) || !Number.isInteger(value.data[index]) ||
        value.data[index] < 0 || value.data[index] > 255) return false;
  }
  return true;
}

export function mockBodyToBuffer(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (isSerializedMockBody(value)) return Buffer.from(value.data);
  return Buffer.from(String(value ?? ''));
}

export function cloneMockRuleData(value) {
  // structuredClone turns Buffers into Uint8Arrays. V8's clone also preserves
  // legacy RegExp matchers while retaining Buffer identity and independent bytes.
  const cloned = deserialize(serialize(value));
  const visited = new Set();
  const visit = rule => {
    if (!rule || typeof rule !== 'object' || visited.has(rule)) return;
    visited.add(rule);
    if (Array.isArray(rule)) {
      for (const item of rule) visit(item);
      return;
    }
    for (const [container, properties] of [
      [rule.action, ['body', 'resBody']], [rule.response, ['body']]
    ]) {
      if (!container || typeof container !== 'object' || Array.isArray(container)) continue;
      for (const property of properties) {
        if (isSerializedMockBody(container[property])) {
          container[property] = Buffer.from(container[property].data);
        }
      }
    }
    if (Array.isArray(rule.items)) visit(rule.items);
  };
  visit(cloned);
  return cloned;
}
