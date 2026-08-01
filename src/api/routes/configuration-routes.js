import os from 'node:os';

import {
  DEFAULT_EXCLUSIONS,
  normalizeDefaultExclusions
} from '../../traffic/default-exclusions.js';
import {
  DEFAULT_TRAFFIC_LIST_ID,
  normalizeTrafficLists
} from '../../traffic/traffic-lists.js';

export function registerConfigurationRoutes(router, api) {
  router.get('/api/version', (req, res) => {
    res.json({ version: '1.0.0', name: 'HTTP FreeKit' });
  });

  router.get('/api/config', (req, res) => {
    const certInfo = api.ca.getCertInfo();
    const networkInterfaces = os.networkInterfaces();
    res.json({
      config: {
        ...certInfo,
        networkInterfaces,
        proxyPort: api.proxy.port,
        apiPort: api.port
      }
    });
  });

  router.get('/api/ui-settings', (req, res) => {
    const filterSafeFonts = api.settings?.get('filterSafeFonts', false) === true;
    api.proxy.filterSafeFonts = filterSafeFonts;
    res.json({
      hideTunnelRequests: api.settings?.get('hideTunnelRequests', true) !== false,
      filterSafeFonts
    });
  });

  router.post('/api/ui-settings', (req, res) => {
    const hideTunnelRequests = Object.prototype.hasOwnProperty.call(req.body || {}, 'hideTunnelRequests')
      ? req.body.hideTunnelRequests !== false
      : api.settings?.get('hideTunnelRequests', true) !== false;
    const filterSafeFonts = Object.prototype.hasOwnProperty.call(req.body || {}, 'filterSafeFonts')
      ? req.body.filterSafeFonts === true
      : api.settings?.get('filterSafeFonts', false) === true;
    api._runPersistedMutation({
      capture: () => api.proxy.filterSafeFonts,
      apply: () => { api.proxy.filterSafeFonts = filterSafeFonts; },
      persist: () => api._persistSettings({ hideTunnelRequests, filterSafeFonts }),
      restore: previous => { api.proxy.filterSafeFonts = previous; }
    });
    res.json({ success: true, hideTunnelRequests, filterSafeFonts });
  });

  router.get('/api/default-exclusions', (req, res) => {
    const config = api._getDefaultExclusionsConfig();
    res.json({
      ...config,
      defaults: [...DEFAULT_EXCLUSIONS]
    });
  });

  router.put('/api/default-exclusions', (req, res) => {
    if (typeof req.body?.enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }
    let patterns;
    try {
      patterns = normalizeDefaultExclusions(req.body?.patterns);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    try {
      const lists = api._getTrafficListsConfig().lists.map(list =>
        list.id === DEFAULT_TRAFFIC_LIST_ID
          ? { ...list, enabled: req.body.enabled, mode: 'blacklist', patterns }
          : list
      );
      api._persistSettings(api._trafficListsPersistenceValues(lists));
    } catch (error) {
      return res.status(500).json({ error: error.message || 'Failed to save Default Exclusions' });
    }
    res.json({ success: true, enabled: req.body.enabled, patterns });
  });

  router.get('/api/traffic-lists', (req, res) => {
    res.json({
      ...api._getTrafficListsConfig(),
      defaultPatterns: [...DEFAULT_EXCLUSIONS]
    });
  });

  router.put('/api/traffic-lists', (req, res) => {
    let lists;
    try {
      lists = normalizeTrafficLists(req.body?.lists);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    try {
      api._persistSettings(api._trafficListsPersistenceValues(lists));
    } catch (error) {
      return res.status(500).json({ error: error.message || 'Failed to save traffic lists' });
    }
    res.json({ success: true, lists });
  });
}
