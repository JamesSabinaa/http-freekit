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

export function parseCurlCommand(curlStr) {
  const result = { method: 'GET', url: '', headers: {}, body: '', hasData: false };
  const dataParts = [];
  const explicitHeaderNames = new Set();

  // Normalize: remove line continuations and extra whitespace
  let cmd = curlStr.replace(/\\\s*\n/g, ' ').trim();

  // Check if it starts with curl
  if (!cmd.toLowerCase().startsWith('curl ')) return null;
  cmd = cmd.substring(5).trim();

  const tokens = [];
  let current = '';
  let inSingle = false, inDouble = false, escaped = false, tokenStarted = false;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (escaped) { current += ch; escaped = false; tokenStarted = true; continue; }
    if (ch === '\\' && !inSingle) {
      const next = cmd[i + 1];
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

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '-X' || token === '--request') {
      result.method = (tokens[++i] || 'GET').toUpperCase();
    } else if (token === '-H' || token === '--header') {
      const header = tokens[++i] || '';
      const colonIndex = header.indexOf(':');
      if (colonIndex > 0) {
        const name = header.slice(0, colonIndex).trim();
        const value = header.slice(colonIndex + 1).trim();
        if (explicitHeaderNames.has(name.toLowerCase())) {
          appendCurlHeader(result.headers, name, value);
        } else {
          setCurlHeader(result.headers, name, value);
          explicitHeaderNames.add(name.toLowerCase());
        }
      }
    } else if (token === '-d' || token === '--data' || token === '--data-ascii' ||
        token === '--data-raw' || token === '--data-binary') {
      const value = tokens[++i] ?? '';
      if (curlDataValueReadsFile(token, value)) {
        return { error: `File-backed ${token} values cannot be imported from a pasted cURL command` };
      }
      dataParts.push(value);
      result.hasData = true;
      if (result.method === 'GET') result.method = 'POST';
    } else if (token === '--data-urlencode') {
      const value = tokens[++i] ?? '';
      if (curlDataValueReadsFile(token, value)) {
        return { error: 'File-backed --data-urlencode values cannot be imported from a pasted cURL command' };
      }
      dataParts.push(encodeCurlDataUrlValue(value));
      result.hasData = true;
      if (result.method === 'GET') result.method = 'POST';
    } else if (token === '-A' || token === '--user-agent') {
      setCurlHeader(result.headers, 'User-Agent', tokens[++i] || '');
      explicitHeaderNames.delete('user-agent');
    } else if (token === '-b' || token === '--cookie') {
      setCurlHeader(result.headers, 'Cookie', tokens[++i] || '');
      explicitHeaderNames.delete('cookie');
    } else if (token === '-u' || token === '--user') {
      setCurlHeader(result.headers, 'Authorization', 'Basic ' + encodeBasicAuthorization(tokens[++i] || ''));
      explicitHeaderNames.delete('authorization');
    } else if (!token.startsWith('-') && !result.url) {
      result.url = token;
    }
  }
  if (dataParts.length && !findCurlHeaderKey(result.headers, 'Content-Type')) {
    setCurlHeader(result.headers, 'Content-Type', 'application/x-www-form-urlencoded');
  }
  result.body = dataParts.reduce((body, part) => {
    return body.length > 0 ? body + '&' + part : body + part;
  }, '');

  return result.url ? result : null;
}
