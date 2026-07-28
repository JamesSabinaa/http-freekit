const MOCK_MATCHER_TYPES = new Set([
  'wildcard',
  'method',
  'host',
  'path',
  'hostname',
  'regex-path',
  'regex-url',
  'url-contains',
  'query',
  'exact-query',
  'port',
  'protocol',
  'header',
  'cookie',
  'body-contains',
  'json-body-exact',
  'json-body-includes',
  'regex-body',
  'raw-body-exact',
  'form-data',
  'multipart-form-data'
]);

const NAME_MATCHER_TYPES = new Set([
  'header', 'query', 'cookie', 'form-data', 'multipart-form-data'
]);
const OPTIONAL_VALUE_MATCHER_TYPES = new Set(['wildcard', 'raw-body-exact', 'exact-query']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isCompleteMockMatcher(matcher) {
  if (!isObject(matcher) || !MOCK_MATCHER_TYPES.has(matcher.type)) return false;
  if (NAME_MATCHER_TYPES.has(matcher.type)) {
    return typeof matcher.name === 'string' && matcher.name.trim().length > 0
      && (matcher.value === undefined || typeof matcher.value === 'string');
  }
  if (OPTIONAL_VALUE_MATCHER_TYPES.has(matcher.type)) {
    return matcher.value === undefined || typeof matcher.value === 'string';
  }
  return typeof matcher.value === 'string' && matcher.value.trim().length > 0;
}

export function validateMockRule(rule, {
  allowGroup = true,
  allowEmptyMatchers = false
} = {}) {
  if (!isObject(rule)) return 'Mock rule must be an object';
  if (Object.prototype.hasOwnProperty.call(rule, 'enabled') && typeof rule.enabled !== 'boolean') {
    return 'Mock rule enabled must be a boolean';
  }

  if (rule.type === 'group') {
    if (!allowGroup) return 'Mock groups cannot contain other groups';
    if (!Array.isArray(rule.items)) return 'Mock group items must be an array';
    for (const item of rule.items) {
      const error = validateMockRule(item, { allowGroup: false, allowEmptyMatchers });
      if (error) return error;
    }
    return null;
  }

  if (Object.prototype.hasOwnProperty.call(rule, 'preSteps') && rule.preSteps !== undefined) {
    if (!Array.isArray(rule.preSteps)) return 'Mock rule preSteps must be an array';
    if (rule.preSteps.some(step => !isObject(step) || typeof step.type !== 'string')) {
      return 'Every mock rule pre-step must be an object with a type';
    }
  }

  const hasNewFormat = Object.prototype.hasOwnProperty.call(rule, 'matchers')
    || Object.prototype.hasOwnProperty.call(rule, 'action');
  if (hasNewFormat) {
    if (!Array.isArray(rule.matchers)) return 'Mock rule matchers must be an array';
    if (!allowEmptyMatchers && rule.matchers.length === 0) {
      return 'At least one complete matcher is required';
    }
    if (!rule.matchers.every(isCompleteMockMatcher)) {
      return 'Every mock rule matcher must be complete';
    }
    if (!isObject(rule.action) || typeof rule.action.type !== 'string' || !rule.action.type) {
      return 'Mock rule action must be an object with a type';
    }
    return null;
  }

  const validUrlPattern = rule.urlPattern instanceof RegExp
    || (typeof rule.urlPattern === 'string' && rule.urlPattern.length > 0);
  if (!validUrlPattern) {
    return 'Legacy mock rule urlPattern must be a non-empty string or regular expression';
  }
  if (rule.method !== undefined && typeof rule.method !== 'string') {
    return 'Legacy mock rule method must be a string';
  }
  if (!isObject(rule.response)) return 'Legacy mock rule response must be an object';
  return null;
}
