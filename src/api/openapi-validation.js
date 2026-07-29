export const OPENAPI_OPERATION_METHODS = [
  'get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'
];

export function isObjectRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalizeApiHostname(hostname) {
  return String(hostname || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

export function getApiSpecBaseHost(baseUrl) {
  if (typeof baseUrl !== 'string') return null;
  const trimmed = baseUrl.trim();
  if (!trimmed) return '';
  if (/^[/?#]/.test(trimmed) || /[\u0000-\u001f\u007f]/.test(trimmed)) return null;

  try {
    const candidate = /^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(trimmed)
      ? trimmed
      : `http://${trimmed}`;
    const parsed = new URL(candidate);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    if (!parsed.hostname || parsed.username || parsed.password) return null;
    return canonicalizeApiHostname(parsed.hostname);
  } catch {
    return null;
  }
}

export function normalizeApiSpecMatchHost(host) {
  if (typeof host !== 'string') return null;
  const trimmed = host.trim();
  if (!trimmed || /[\u0000-\u001f\u007f\/?#@]/.test(trimmed)) return null;
  const parseAuthority = authority => {
    const parsed = new URL(`http://${authority}`);
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      return null;
    }
    return canonicalizeApiHostname(parsed.hostname);
  };
  try {
    return parseAuthority(trimmed);
  } catch {
    // Captured URL.hostname values for IPv6 are bare (`::1`), while URL
    // authorities require brackets. Retry only that unambiguous host shape.
    if (!trimmed.includes(':') || trimmed.startsWith('[') || trimmed.endsWith(']')) return null;
    try {
      return parseAuthority(`[${trimmed}]`);
    } catch {
      return null;
    }
  }
}

export function compileOpenApiPathPattern(pathPattern) {
  if (typeof pathPattern !== 'string') return null;
  const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parameterPattern = /\{[^{}\/]+\}/g;
  for (const segment of pathPattern.split('/')) {
    parameterPattern.lastIndex = 0;
    if (parameterPattern.exec(segment) && parameterPattern.exec(segment)) return null;
  }
  parameterPattern.lastIndex = 0;
  let source = '^';
  let cursor = 0;
  for (const match of pathPattern.matchAll(parameterPattern)) {
    source += escapeRegex(pathPattern.slice(cursor, match.index));
    source += '[^/]+';
    cursor = match.index + match[0].length;
  }
  source += escapeRegex(pathPattern.slice(cursor)) + '$';
  try {
    return new RegExp(source);
  } catch {
    return null;
  }
}

function validateParameters(parameters, location) {
  if (parameters === undefined) return null;
  if (!Array.isArray(parameters)) return `${location} must be an array`;
  if (parameters.some(parameter => !isObjectRecord(parameter))) {
    return `${location} entries must be objects`;
  }
  return null;
}

export function validateOpenApiSubmission(payload) {
  if (!isObjectRecord(payload)) return { error: 'request body must be an object' };

  const { title, baseUrl, spec } = payload;
  if (title !== undefined && typeof title !== 'string') {
    return { error: 'title must be a string' };
  }
  if (baseUrl !== undefined && typeof baseUrl !== 'string') {
    return { error: 'baseUrl must be a string' };
  }

  const normalizedBaseUrl = (baseUrl || '').trim();
  if (getApiSpecBaseHost(normalizedBaseUrl) === null) {
    return { error: 'baseUrl must be empty, an HTTP(S) URL, or a hostname' };
  }
  if (!isObjectRecord(spec)) return { error: 'spec must be an object' };
  if (spec.paths !== undefined && !isObjectRecord(spec.paths)) {
    return { error: 'spec.paths must be an object' };
  }

  for (const [pathPattern, pathItem] of Object.entries(spec.paths || {})) {
    if (!pathPattern.startsWith('/')) {
      return { error: `spec.paths key ${JSON.stringify(pathPattern)} must start with /` };
    }
    if (!compileOpenApiPathPattern(pathPattern)) {
      return {
        error: `spec.paths key ${JSON.stringify(pathPattern)} must contain at most one parameter per path segment`
      };
    }
    if (!isObjectRecord(pathItem)) {
      return { error: `spec.paths[${JSON.stringify(pathPattern)}] must be an object` };
    }

    const pathParameterError = validateParameters(
      pathItem.parameters,
      `spec.paths[${JSON.stringify(pathPattern)}].parameters`
    );
    if (pathParameterError) return { error: pathParameterError };

    for (const method of OPENAPI_OPERATION_METHODS) {
      if (pathItem[method] === undefined) continue;
      const operation = pathItem[method];
      const operationLocation = `spec.paths[${JSON.stringify(pathPattern)}].${method}`;
      if (!isObjectRecord(operation)) return { error: `${operationLocation} must be an object` };

      for (const field of ['operationId', 'summary', 'description']) {
        if (operation[field] !== undefined && typeof operation[field] !== 'string') {
          return { error: `${operationLocation}.${field} must be a string` };
        }
      }
      if (operation.tags !== undefined && (
        !Array.isArray(operation.tags) ||
        operation.tags.some(tag => typeof tag !== 'string')
      )) {
        return { error: `${operationLocation}.tags must be an array of strings` };
      }
      const operationParameterError = validateParameters(
        operation.parameters,
        `${operationLocation}.parameters`
      );
      if (operationParameterError) return { error: operationParameterError };
    }
  }

  return {
    value: {
      title: title || 'Untitled API',
      baseUrl: normalizedBaseUrl,
      spec
    }
  };
}
