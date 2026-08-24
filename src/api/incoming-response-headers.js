function appendHeaderValue(result, keysByLowerName, rawName, rawValue) {
  const name = String(rawName);
  const lowerName = name.toLowerCase();
  const key = keysByLowerName.get(lowerName) || name;
  const value = String(rawValue);
  if (!keysByLowerName.has(lowerName)) {
    keysByLowerName.set(lowerName, key);
    result[key] = value;
  } else if (Array.isArray(result[key])) {
    result[key].push(value);
  } else {
    result[key] = [result[key], value];
  }
}

export function normalizeIncomingResponseHeaders(message) {
  const result = Object.create(null);
  const keysByLowerName = new Map();
  const distinct = message?.headersDistinct;
  if (distinct && typeof distinct === 'object' && !Array.isArray(distinct)) {
    for (const [name, storedValues] of Object.entries(distinct)) {
      const values = Array.isArray(storedValues) ? storedValues : [storedValues];
      for (const value of values) appendHeaderValue(result, keysByLowerName, name, value);
    }
    return result;
  }

  if (Array.isArray(message?.rawHeaders)) {
    for (let index = 0; index + 1 < message.rawHeaders.length; index += 2) {
      appendHeaderValue(
        result,
        keysByLowerName,
        message.rawHeaders[index],
        message.rawHeaders[index + 1]
      );
    }
    return result;
  }

  for (const [name, storedValues] of Object.entries(message?.headers || {})) {
    const values = Array.isArray(storedValues) ? storedValues : [storedValues];
    for (const value of values) appendHeaderValue(result, keysByLowerName, name, value);
  }
  return result;
}
