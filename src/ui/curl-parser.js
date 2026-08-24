import { normalizeCurlDestination } from './send-url.js';

function encodeCurlComponent(value) {
  let encoded = '';
  for (const byte of new TextEncoder().encode(value)) {
    if (byte === 0x20) {
      encoded += '+';
      continue;
    }
    const isUnreserved =
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      (byte >= 0x30 && byte <= 0x39) ||
      byte === 0x2d || byte === 0x2e || byte === 0x5f || byte === 0x7e;
    encoded += isUnreserved
      ? String.fromCharCode(byte)
      : '%' + byte.toString(16).toUpperCase().padStart(2, '0');
  }
  return encoded;
}

function encodeCurlDataUrlValue(value) {
  const equalsIndex = value.indexOf('=');
  if (equalsIndex > 0) {
    return value.slice(0, equalsIndex + 1) + encodeCurlComponent(value.slice(equalsIndex + 1));
  }
  if (equalsIndex === 0) return encodeCurlComponent(value.slice(1));
  return encodeCurlComponent(value);
}

function curlDataValueReadsFile(option, value) {
  if (option === '--data-raw') return false;
  if (option === '--data-urlencode') {
    return !value.includes('=') && value.includes('@');
  }
  return value.startsWith('@');
}

function encodeBasicAuthorization(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function findCurlHeaderKey(headers, name) {
  const lowerName = name.toLowerCase();
  return Object.keys(headers).find(key => key.toLowerCase() === lowerName) || null;
}

function appendCurlHeader(headers, name, value) {
  const existingKey = findCurlHeaderKey(headers, name);
  if (!existingKey) {
    headers[name] = value;
  } else if (Array.isArray(headers[existingKey])) {
    headers[existingKey].push(value);
  } else {
    headers[existingKey] = [headers[existingKey], value];
  }
}

function setCurlHeader(headers, name, value) {
  headers[findCurlHeaderKey(headers, name) || name] = value;
}

const CURL_SHORT_VALUE_OPTIONS = new Set(['-X', '-H', '-d', '-A', '-b', '-u']);
const CURL_LONG_VALUE_OPTIONS = new Set([
  '--request',
  '--header',
  '--data',
  '--data-ascii',
  '--data-raw',
  '--data-binary',
  '--data-urlencode',
  '--user-agent',
  '--cookie',
  '--user'
]);

function isHttpMethodToken(value) {
  return typeof value === 'string' && value.length > 0 &&
    !/[^!#$%&'*+\-.^_`|~0-9A-Za-z]/.test(value);
}

function parseCurlValueOptionToken(token) {
  if (token.startsWith('--')) {
    const equalsIndex = token.indexOf('=', 2);
    const option = equalsIndex === -1 ? token : token.slice(0, equalsIndex);
    if (!CURL_LONG_VALUE_OPTIONS.has(option)) return null;
    return {
      option,
      hasAttachedValue: equalsIndex !== -1,
      value: equalsIndex === -1 ? '' : token.slice(equalsIndex + 1)
    };
  }

  const option = token.slice(0, 2);
  if (!CURL_SHORT_VALUE_OPTIONS.has(option)) return null;
  return {
    option,
    hasAttachedValue: token.length > 2,
    value: token.slice(2)
  };
}

function curlUnsupportedOptionName(token) {
  if (token.startsWith('--')) {
    const equalsIndex = token.indexOf('=', 2);
    return equalsIndex === -1 ? token : token.slice(0, equalsIndex);
  }
  return token.slice(0, 2);
}

export function parseCurlCommand(curlStr) {
  const result = {
    method: 'GET',
    url: '',
    headers: Object.create(null),
    body: '',
    hasData: false
  };
  const dataParts = [];
  const explicitHeaderNames = new Set();
  let hasExplicitMethod = false;
  let hasUrl = false;

  let cmd = curlStr.trim();

  // Check if it starts with curl
  if (!/^curl(?=\s)/i.test(cmd)) return null;
  cmd = cmd.substring(4).trim();

  const tokens = [];
  let current = '';
  let inSingle = false, inDouble = false, escaped = false, tokenStarted = false;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (escaped) { current += ch; escaped = false; tokenStarted = true; continue; }
    if (ch === '\\' && !inSingle) {
      const next = cmd[i + 1];
      if (next === '\n') {
        i++;
        continue;
      }
      if (next === '\r' && cmd[i + 2] === '\n') {
        i += 2;
        continue;
      }
      if (inDouble && next && !['\\', '"', '$', '`'].includes(next)) {
        current += ch;
        tokenStarted = true;
      } else {
        escaped = true;
        tokenStarted = true;
      }
      continue;
    }
    if (ch === "'" && !inDouble) { inSingle = !inSingle; tokenStarted = true; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; tokenStarted = true; continue; }
    if (/\s/.test(ch) && !inSingle && !inDouble) {
      if (tokenStarted) { tokens.push(current); current = ''; tokenStarted = false; }
      continue;
    }
    current += ch;
    tokenStarted = true;
  }
  if (escaped) current += '\\';
  if (tokenStarted) tokens.push(current);
  if (inSingle || inDouble) {
    return { error: 'Cannot import cURL command: an argument has an unterminated quote' };
  }

  let optionsEnded = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!optionsEnded && token === '--') {
      optionsEnded = true;
      continue;
    }

    if (!optionsEnded && token.startsWith('-') && token !== '-') {
      const parsedOption = parseCurlValueOptionToken(token);
      if (!parsedOption) {
        const option = curlUnsupportedOptionName(token);
        return {
          error: `Unsupported cURL option: ${option}. Remove it before pasting the command.`
        };
      }
      const { option } = parsedOption;
      let value = parsedOption.value;
      if (!parsedOption.hasAttachedValue) {
        if (i + 1 >= tokens.length) {
          return { error: `Missing value for cURL option: ${option}` };
        }
        value = tokens[++i];
      }

      if (option === '-X' || option === '--request') {
        if (!value) return { error: `Missing value for cURL option: ${option}` };
        if (!isHttpMethodToken(value)) {
          return { error: `Invalid HTTP method for cURL option ${option}: expected an HTTP token` };
        }
        result.method = value;
        hasExplicitMethod = true;
      } else if (option === '-H' || option === '--header') {
        if (value.startsWith('@')) {
          return { error: `File- or stdin-backed ${option} values cannot be imported from a pasted cURL command` };
        }
        const colonIndex = value.indexOf(':');
        if (colonIndex > 0) {
          const name = value.slice(0, colonIndex).trim();
          const headerValue = value.slice(colonIndex + 1).trim();
          if (headerValue === '') {
            return {
              error: `Suppressed cURL header ${name}: cannot be imported exactly; use ${name}; for an explicit empty header`
            };
          }
          if (explicitHeaderNames.has(name.toLowerCase())) {
            appendCurlHeader(result.headers, name, headerValue);
          } else {
            setCurlHeader(result.headers, name, headerValue);
            explicitHeaderNames.add(name.toLowerCase());
          }
        } else if (colonIndex === -1 && value.endsWith(';')) {
          const name = value.slice(0, -1).trim();
          if (!name) return { error: `Invalid empty header for cURL option: ${option}` };
          if (explicitHeaderNames.has(name.toLowerCase())) {
            appendCurlHeader(result.headers, name, '');
          } else {
            setCurlHeader(result.headers, name, '');
            explicitHeaderNames.add(name.toLowerCase());
          }
        } else {
          return { error: `Invalid header syntax for cURL option ${option}` };
        }
      } else if (option === '-d' || option === '--data' || option === '--data-ascii' ||
          option === '--data-raw' || option === '--data-binary') {
        if (curlDataValueReadsFile(option, value)) {
          return { error: `File-backed ${option} values cannot be imported from a pasted cURL command` };
        }
        dataParts.push(value);
        result.hasData = true;
        if (!hasExplicitMethod) result.method = 'POST';
      } else if (option === '--data-urlencode') {
        if (curlDataValueReadsFile(option, value)) {
          return { error: 'File-backed --data-urlencode values cannot be imported from a pasted cURL command' };
        }
        dataParts.push(encodeCurlDataUrlValue(value));
        result.hasData = true;
        if (!hasExplicitMethod) result.method = 'POST';
      } else if (option === '-A' || option === '--user-agent') {
        setCurlHeader(result.headers, 'User-Agent', value);
        explicitHeaderNames.delete('user-agent');
      } else if (option === '-b' || option === '--cookie') {
        if (value !== '' && !value.includes('=')) {
          return { error: `File- or stdin-backed ${option} values cannot be imported from a pasted cURL command` };
        }
        setCurlHeader(result.headers, 'Cookie', value);
        explicitHeaderNames.delete('cookie');
      } else if (option === '-u' || option === '--user') {
        if (!value.includes(':')) {
          return {
            error: `Prompt-dependent ${option} credentials cannot be imported; include an explicit password separator (for example, USER:)`
          };
        }
        setCurlHeader(result.headers, 'Authorization', 'Basic ' + encodeBasicAuthorization(value));
        explicitHeaderNames.delete('authorization');
      }
      continue;
    }

    if (hasUrl) {
      return {
        error: 'Multiple cURL URLs cannot be imported into one Send request'
      };
    }
    if (!token) {
      return { error: 'The cURL destination URL cannot be empty' };
    }
    try {
      result.url = normalizeCurlDestination(token);
    } catch (error) {
      return { error: `Cannot import cURL destination: ${error.message}` };
    }
    hasUrl = true;
  }
  if (dataParts.length && !findCurlHeaderKey(result.headers, 'Content-Type')) {
    setCurlHeader(result.headers, 'Content-Type', 'application/x-www-form-urlencoded');
  }
  result.body = dataParts.reduce((body, part) => {
    return body.length > 0 ? body + '&' + part : body + part;
  }, '');

  return hasUrl ? result : { error: 'cURL command is missing a destination URL' };
}
