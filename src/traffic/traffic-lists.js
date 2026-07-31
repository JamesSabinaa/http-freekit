import {
  DEFAULT_EXCLUSIONS,
  createDefaultExclusionMatcher,
  normalizeDefaultExclusions
} from './default-exclusions.js';

export const DEFAULT_TRAFFIC_LIST_ID = 'default-exclusions';
export const MAX_TRAFFIC_LISTS = 50;
const MAX_LIST_NAME_LENGTH = 80;
const LIST_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const LIST_MODES = new Set(['blacklist', 'whitelist']);

export function createDefaultTrafficList({ enabled = true, patterns = DEFAULT_EXCLUSIONS } = {}) {
  return {
    id: DEFAULT_TRAFFIC_LIST_ID,
    name: 'Default Exclusions',
    enabled: enabled !== false,
    mode: 'blacklist',
    patterns: normalizeDefaultExclusions(patterns),
    builtIn: true
  };
}

export function normalizeTrafficLists(lists, { requireDefault = true } = {}) {
  if (!Array.isArray(lists)) throw new TypeError('lists must be an array');
  if (lists.length > MAX_TRAFFIC_LISTS) {
    throw new TypeError(`lists must contain no more than ${MAX_TRAFFIC_LISTS} entries`);
  }

  const normalized = [];
  const ids = new Set();
  for (let index = 0; index < lists.length; index++) {
    const list = lists[index];
    if (!list || typeof list !== 'object' || Array.isArray(list)) {
      throw new TypeError(`lists[${index}] must be an object`);
    }
    const id = String(list.id || '');
    if (!LIST_ID_PATTERN.test(id)) {
      throw new TypeError(`lists[${index}].id is invalid`);
    }
    if (ids.has(id)) throw new TypeError(`lists[${index}].id must be unique`);
    ids.add(id);

    if (typeof list.name !== 'string') {
      throw new TypeError(`lists[${index}].name must be a string`);
    }
    const name = list.name.trim();
    if (!name || name.length > MAX_LIST_NAME_LENGTH || /[\r\n\0]/.test(name)) {
      throw new TypeError(
        `lists[${index}].name must be between 1 and ${MAX_LIST_NAME_LENGTH} characters`
      );
    }
    if (typeof list.enabled !== 'boolean') {
      throw new TypeError(`lists[${index}].enabled must be a boolean`);
    }
    if (!LIST_MODES.has(list.mode)) {
      throw new TypeError(`lists[${index}].mode must be blacklist or whitelist`);
    }

    normalized.push({
      id,
      name,
      enabled: list.enabled,
      mode: list.mode,
      patterns: normalizeDefaultExclusions(list.patterns),
      builtIn: id === DEFAULT_TRAFFIC_LIST_ID
    });
  }

  if (requireDefault && !ids.has(DEFAULT_TRAFFIC_LIST_ID)) {
    throw new TypeError('The Default Exclusions list is required');
  }
  return normalized;
}

export function filterTrafficLists(requests, lists) {
  const enabledLists = lists
    .filter(list => list.enabled)
    .map(list => ({
      mode: list.mode,
      matches: createDefaultExclusionMatcher(list.patterns)
    }));
  const blacklists = enabledLists.filter(list => list.mode === 'blacklist');
  const whitelists = enabledLists.filter(list => list.mode === 'whitelist');
  const isVisible = request => {
    if (blacklists.some(list => list.matches(request))) return false;
    if (whitelists.length > 0 && !whitelists.some(list => list.matches(request))) return false;
    return true;
  };
  const identity = (id, lifecycleId) => JSON.stringify([String(id || ''), lifecycleId ?? null]);
  const parentVisibility = new Map();
  for (const request of requests) {
    if (request?.protocol === 'ws-frame' || !request?.id) continue;
    parentVisibility.set(identity(request.id, request.trafficLifecycleId), isVisible(request));
  }
  return requests.filter(request => {
    if (request?.protocol !== 'ws-frame') return isVisible(request);
    const parentKey = identity(request.parentId, request.parentTrafficLifecycleId);
    return parentVisibility.has(parentKey) ? parentVisibility.get(parentKey) : isVisible(request);
  });
}
