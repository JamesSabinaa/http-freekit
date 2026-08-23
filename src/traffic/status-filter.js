export function parseTrafficStatusFilter(value) {
  if (typeof value !== 'string') return null;
  if (/^[1-5]xx$/i.test(value)) {
    return { type: 'range', base: Number(value[0]) * 100 };
  }
  if (/^\d{3}$/.test(value)) {
    return { type: 'exact', code: Number(value) };
  }
  return null;
}

export function matchesTrafficStatus(statusCode, filter) {
  if (filter.type === 'range') {
    return statusCode >= filter.base && statusCode < filter.base + 100;
  }
  return statusCode === filter.code;
}
