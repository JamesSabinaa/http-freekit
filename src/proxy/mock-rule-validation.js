import { validateHeaderName, validateHeaderValue } from 'node:http';

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
const OPTIONAL_VALUE_MATCHER_TYPES = new Set(['wildcard']);
const EMPTY_VALUE_MATCHER_TYPES = new Set(['raw-body-exact', 'exact-query']);
const HTTP_TOKEN_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const MOCK_ACTION_TYPES = new Set([
  'fixed-response',
  'serve-file',
  'forward',
  'passthrough',
  'transform-request',
  'transform-response',
  'breakpoint-request',
  'breakpoint-response',
  'breakpoint-request-response',
  'webhook',
  'close',
  'reset',
  'timeout'
]);
const MOCK_PRE_STEP_TYPES = new Set([
  'delay', 'add-header', 'remove-header', 'rewrite-url', 'rewrite-method'
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(object, property) {
  return Object.prototype.hasOwnProperty.call(object, property);
}

function isHeaderValue(value) {
  return typeof value === 'string' || typeof value === 'number'
    || (Array.isArray(value) && value.every(item =>
      typeof item === 'string' || typeof item === 'number'));
}

function isValidHeader(name, value = '') {
  if (typeof name !== 'string' || !name || !isHeaderValue(value)) return false;
  try {
    validateHeaderName(name);
    validateHeaderValue(name, value);
    return true;
  } catch {
    return false;
  }
}

function validateHeaders(headers, label) {
  if (!isObject(headers)) return `${label} must be an object`;
  if (Object.entries(headers).some(([name, value]) => !isValidHeader(name, value))) {
    return `${label} must contain valid header names and values`;
  }
  return null;
}

function validateOptionalStatus(container, property, label) {
  if (!hasOwn(container, property) || container[property] === undefined) return null;
  const status = container[property];
  return Number.isInteger(status) && status >= 100 && status <= 599
    ? null
    : `${label} must be an integer from 100 to 599`;
}

function validateOptionalBody(container, property, label) {
  if (!hasOwn(container, property) || container[property] === undefined) return null;
  return typeof container[property] === 'string' || Buffer.isBuffer(container[property])
    ? null
    : `${label} must be a string or buffer`;
}

function validateOptionalStringArray(container, property, label) {
  if (!hasOwn(container, property) || container[property] === undefined) return null;
  return Array.isArray(container[property])
    && container[property].every(value => typeof value === 'string' && value.trim())
    ? null
    : `${label} must be an array of non-empty strings`;
}

function validateOptionalEnum(container, property, values, label) {
  if (!hasOwn(container, property) || container[property] === undefined) return null;
  return values.has(container[property])
    ? null
    : `${label} must use a supported value`;
}

function validatePreStep(step) {
  if (!isObject(step) || !MOCK_PRE_STEP_TYPES.has(step.type)) {
    return 'Every mock rule pre-step must use a supported type';
  }
  if (step.type === 'delay') {
    return typeof step.ms === 'number' && Number.isFinite(step.ms) && step.ms >= 0
      ? null
      : 'Delay pre-step milliseconds must be a non-negative number';
  }
  if (step.type === 'add-header' || step.type === 'remove-header') {
    if (!isValidHeader(step.name, step.type === 'add-header' ? (step.value ?? '') : '')) {
      return `${step.type} pre-step name must be a non-empty string`;
    }
    return null;
  }
  if (step.type === 'rewrite-method') {
    return typeof step.value === 'string' && HTTP_TOKEN_PATTERN.test(step.value)
      ? null
      : 'rewrite-method pre-step value must be a valid HTTP method';
  }
  return typeof step.value === 'string' && step.value.trim()
    ? null
    : `${step.type} pre-step value must be a non-empty string`;
}

function validateTransformAction(action) {
  if (hasOwn(action, 'methodMode') && action.methodMode !== undefined
    && (typeof action.methodMode !== 'string' || !HTTP_TOKEN_PATTERN.test(action.methodMode))) {
    return 'Mock transform methodMode must be original or a valid HTTP method';
  }
  const enumFields = [
    ['urlMode', new Set(['original', 'modify'])],
    ['headersMode', new Set(['original', 'update', 'replace'])],
    ['bodyMode', new Set(['original', 'replace-fixed', 'json-merge', 'match-replace'])],
    ['resStatusMode', new Set(['original', 'replace'])],
    ['resHeadersMode', new Set(['original', 'update', 'replace'])],
    ['resBodyMode', new Set(['original', 'replace-fixed', 'json-merge', 'match-replace'])]
  ];
  for (const [property, values] of enumFields) {
    const error = validateOptionalEnum(action, property, values, `Mock transform ${property}`);
    if (error) return error;
  }
  const stringFields = [
    'urlReplace', 'bodyMatchPattern', 'bodyReplaceWith',
    'resBodyMatchPattern', 'resBodyReplaceWith'
  ];
  for (const property of stringFields) {
    if (hasOwn(action, property) && action[property] !== undefined
      && typeof action[property] !== 'string') {
      return `Mock transform ${property} must be a string`;
    }
  }
  if (action.urlMode === 'modify' && (typeof action.urlReplace !== 'string' || !action.urlReplace.trim())) {
    return 'Mock transform urlReplace must be a non-empty string when modifying the URL';
  }
  if (action.bodyMode === 'match-replace'
    && (typeof action.bodyMatchPattern !== 'string' || !action.bodyMatchPattern)) {
    return 'Mock transform bodyMatchPattern is required for match-replace';
  }
  if (action.resBodyMode === 'match-replace'
    && (typeof action.resBodyMatchPattern !== 'string' || !action.resBodyMatchPattern)) {
    return 'Mock transform resBodyMatchPattern is required for match-replace';
  }
  for (const [property, label] of [
    ['headers', 'Mock transform request headers'],
    ['resHeaders', 'Mock transform response headers']
  ]) {
    if (hasOwn(action, property) && action[property] !== undefined) {
      const error = validateHeaders(action[property], label);
      if (error) return error;
    }
  }
  for (const [property, label] of [
    ['removeHeaders', 'Mock transform removed request headers'],
    ['resRemoveHeaders', 'Mock transform removed response headers']
  ]) {
    const error = validateOptionalStringArray(action, property, label);
    if (error) return error;
  }
  for (const [property, label] of [
    ['body', 'Mock transform request body'],
    ['resBody', 'Mock transform response body']
  ]) {
    const error = validateOptionalBody(action, property, label);
    if (error) return error;
  }
  const statusError = validateOptionalStatus(
    action, 'resStatusOverride', 'Mock transform response status'
  );
  if (statusError) return statusError;
  if (action.resStatusMode === 'replace' && action.resStatusOverride === undefined) {
    return 'Mock transform resStatusOverride is required when replacing the response status';
  }
  return null;
}

function validateAction(action) {
  if (!isObject(action) || !MOCK_ACTION_TYPES.has(action.type)) {
    return 'Mock rule action must use a supported type';
  }
  if (hasOwn(action, 'delay') && action.delay !== undefined
    && (typeof action.delay !== 'number' || !Number.isFinite(action.delay) || action.delay < 0)) {
    return 'Mock action delay must be a non-negative number';
  }
  for (const [property, label] of [
    ['addRequestHeaders', 'Additional mock request headers'],
    ['addResponseHeaders', 'Additional mock response headers']
  ]) {
    if (hasOwn(action, property) && action[property] !== undefined) {
      const headersError = validateHeaders(action[property], label);
      if (headersError) return headersError;
    }
  }

  if (action.type === 'fixed-response') {
    const statusError = validateOptionalStatus(action, 'status', 'Mock response status');
    if (statusError) return statusError;
    if (hasOwn(action, 'headers') && action.headers !== undefined) {
      const headersError = validateHeaders(action.headers, 'Mock response headers');
      if (headersError) return headersError;
    }
    return validateOptionalBody(action, 'body', 'Mock response body');
  }
  if (action.type === 'serve-file') {
    if (typeof action.filePath !== 'string' || !action.filePath.trim()) {
      return 'Mock file path must be a non-empty string';
    }
    if (hasOwn(action, 'contentType') && action.contentType !== undefined
      && typeof action.contentType !== 'string') return 'Mock file content type must be a string';
    if (typeof action.contentType === 'string' && !isValidHeader('content-type', action.contentType)) {
      return 'Mock file content type must be a valid header value';
    }
    return validateOptionalStatus(action, 'status', 'Mock file response status');
  }
  if (action.type === 'forward') {
    return typeof action.forwardTo === 'string' && action.forwardTo.trim()
      ? null
      : 'Mock forward target must be a non-empty string';
  }
  if (action.type === 'webhook') {
    if (typeof action.webhookUrl !== 'string' || !action.webhookUrl.trim()) {
      return 'Mock webhook URL must be a non-empty string';
    }
    if (action.webhookHeaders !== undefined) {
      return validateHeaders(action.webhookHeaders, 'Mock webhook headers');
    }
    return null;
  }
  if (action.type === 'transform-request') return validateTransformAction(action);
  if (action.type === 'transform-response') {
    const bodyModeError = validateOptionalEnum(
      action,
      'bodyMode',
      new Set(['original', 'replace-fixed', 'json-merge', 'match-replace']),
      'Legacy response transform bodyMode'
    );
    if (bodyModeError) return bodyModeError;
    for (const property of ['bodyMatchPattern', 'bodyReplaceWith']) {
      if (hasOwn(action, property) && action[property] !== undefined
        && typeof action[property] !== 'string') {
        return `Legacy response transform ${property} must be a string`;
      }
    }
    if (action.bodyMode === 'match-replace'
      && (typeof action.bodyMatchPattern !== 'string' || !action.bodyMatchPattern)) {
      return 'Legacy response transform bodyMatchPattern is required for match-replace';
    }
    if (action.headers !== undefined) {
      const error = validateHeaders(action.headers, 'Legacy response transform headers');
      if (error) return error;
    }
    const removedError = validateOptionalStringArray(
      action, 'removeHeaders', 'Legacy response transform removed headers'
    );
    if (removedError) return removedError;
    const bodyError = validateOptionalBody(action, 'body', 'Legacy response transform body');
    if (bodyError) return bodyError;
    return validateOptionalStatus(action, 'statusOverride', 'Legacy response transform status');
  }
  return null;
}

function validateLegacyResponse(response) {
  if (!isObject(response)) return 'Legacy mock rule response must be an object';
  const statusError = validateOptionalStatus(response, 'status', 'Legacy mock response status');
  if (statusError) return statusError;
  if (hasOwn(response, 'headers') && response.headers !== undefined) {
    const headersError = validateHeaders(response.headers, 'Legacy mock response headers');
    if (headersError) return headersError;
  }
  return validateOptionalBody(response, 'body', 'Legacy mock response body');
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
  if (EMPTY_VALUE_MATCHER_TYPES.has(matcher.type)) {
    return typeof matcher.value === 'string';
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
    for (const step of rule.preSteps) {
      const error = validatePreStep(step);
      if (error) return error;
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
    return validateAction(rule.action);
  }

  const validUrlPattern = rule.urlPattern instanceof RegExp
    || (typeof rule.urlPattern === 'string' && rule.urlPattern.length > 0);
  if (!validUrlPattern) {
    return 'Legacy mock rule urlPattern must be a non-empty string or regular expression';
  }
  if (rule.method !== undefined && typeof rule.method !== 'string') {
    return 'Legacy mock rule method must be a string';
  }
  return validateLegacyResponse(rule.response);
}
