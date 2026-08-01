import { trafficToHar } from '../har-converter.js';

function parsePaginationValue(value, fallback) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(String(value))) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function resolveTrafficRequest(api, req) {
  const lifecycleProvided = Object.hasOwn(req.query, 'trafficLifecycleId');
  if (lifecycleProvided &&
      (typeof req.query.trafficLifecycleId !== 'string' || !req.query.trafficLifecycleId)) {
    return { status: 400, error: 'trafficLifecycleId must be a non-empty string' };
  }

  const candidates = api.trafficLog.filter(request =>
    request.id === req.params.id &&
    (!lifecycleProvided || request.trafficLifecycleId === req.query.trafficLifecycleId)
  );
  if (candidates.length === 0) return { status: 404, error: 'Request not found' };
  if (candidates.length > 1) {
    return {
      status: 409,
      error: lifecycleProvided
        ? 'Multiple requests have this traffic identity'
        : 'Multiple request lifecycles have this ID; provide trafficLifecycleId'
    };
  }
  return { request: candidates[0] };
}

function resolvedRequestOrRespond(api, req, res) {
  const resolved = resolveTrafficRequest(api, req);
  if (!resolved.request) res.status(resolved.status).json({ error: resolved.error });
  return resolved.request || null;
}

export function registerTrafficRoutes(router, api) {
  router.get('/api/stats', (req, res) => {
    res.json({
      proxy: api.proxy.getStats(),
      traffic: {
        total: api._getTrafficWithoutDefaultExclusions().length,
        clients: api.clients.size,
        capturePaused: api.capturePaused
      }
    });
  });

  router.get('/api/traffic', (req, res) => {
    const limit = parsePaginationValue(req.query.limit, 100);
    const offset = parsePaginationValue(req.query.offset, 0);
    if (limit === null || offset === null) {
      return res.status(400).json({ error: 'limit and offset must be non-negative integers' });
    }
    const filter = req.query.filter || '';

    const visibleTraffic = api._getTrafficWithoutDefaultExclusions();
    let filtered = visibleTraffic;
    if (filter) {
      const lowerFilter = filter.toLowerCase();
      filtered = visibleTraffic.filter(request =>
        request.url?.toLowerCase().includes(lowerFilter) ||
        request.method?.toLowerCase().includes(lowerFilter) ||
        request.host?.toLowerCase().includes(lowerFilter) ||
        String(request.statusCode).includes(lowerFilter)
      );
    }

    res.json({
      total: filtered.length,
      requests: filtered.slice(offset, offset + limit)
    });
  });

  router.get('/api/traffic/capture', (req, res) => {
    res.json({
      paused: api.capturePaused,
      sessionId: api.captureStateSessionId,
      revision: api.captureStateRevision
    });
  });

  router.put('/api/traffic/capture', (req, res) => {
    if (typeof req.body?.paused !== 'boolean') {
      return res.status(400).json({ error: 'paused must be a boolean' });
    }
    api._setCapturePaused(req.body.paused);
    res.json({
      success: true,
      paused: api.capturePaused,
      sessionId: api.captureStateSessionId,
      revision: api.captureStateRevision
    });
  });

  router.post('/api/traffic/clear', (req, res) => {
    const result = api._clearTraffic();
    res.json({ success: true, ...result });
  });

  router.get('/api/traffic/export', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename=http-freekit-export.json');
    res.json({
      exported: new Date().toISOString(),
      tool: 'HTTP FreeKit',
      version: '1.0.0',
      requests: api._getTrafficWithoutDefaultExclusions()
    });
  });

  router.post('/api/traffic/export-generator', async (req, res) => {
    try {
      const result = await api._exportToGenerator();
      res.json({ success: true, ...result });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to export HAR to generator'
      });
    }
  });

  router.get('/api/traffic/export.har', (req, res) => {
    const har = trafficToHar(api._getHarExportTraffic(), { maskSensitive: false });
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename=http-freekit-export.har');
    res.json(har);
  });

  router.get('/api/traffic/search', (req, res) => {
    const { method, status, host, path: pathFilter, source } = req.query;
    let results = api._getTrafficWithoutDefaultExclusions();

    if (method) results = results.filter(request =>
      request.method?.toUpperCase() === method.toUpperCase()
    );
    if (status) {
      const statusNumber = parseInt(status);
      if (status.endsWith('xx')) {
        const base = parseInt(status[0]) * 100;
        results = results.filter(request =>
          request.statusCode >= base && request.statusCode < base + 100
        );
      } else {
        results = results.filter(request => request.statusCode === statusNumber);
      }
    }
    if (host) results = results.filter(request => request.host?.includes(host));
    if (pathFilter) results = results.filter(request => request.path?.includes(pathFilter));
    if (source) results = results.filter(request => request.source === source);

    res.json({ total: results.length, requests: results });
  });

  router.get('/api/traffic/:id', (req, res) => {
    const request = resolvedRequestOrRespond(api, req, res);
    if (request) res.json(request);
  });

  router.put('/api/traffic/:id/pin', (req, res) => {
    if (typeof req.body?.pinned !== 'boolean') {
      return res.status(400).json({ error: 'pinned must be a boolean' });
    }
    const request = resolvedRequestOrRespond(api, req, res);
    if (!request) return;
    if (req.body.pinned && request.protocol === 'ws-frame') {
      return res.status(400).json({
        error: 'WebSocket frames cannot be pinned; pin the parent connection instead'
      });
    }

    request.pinned = req.body.pinned;
    const pin = {
      requestId: request.id,
      trafficLifecycleId: request.trafficLifecycleId ?? null,
      pinned: request.pinned,
      revision: ++api._trafficPinRevision
    };
    api._broadcast({ type: 'traffic-pinned', ...pin });
    res.json({ success: true, ...pin });
  });

  router.delete('/api/traffic/:id', (req, res) => {
    const request = resolvedRequestOrRespond(api, req, res);
    if (!request) return;

    const trafficLifecycleId = request.trafficLifecycleId ?? null;
    const webSocketConnection = request.protocol === 'ws' || request.protocol === 'wss';
    const isMatchingFrame = row => webSocketConnection &&
      row.protocol === 'ws-frame' &&
      row.parentId === request.id &&
      (row.parentTrafficLifecycleId ?? null) === trafficLifecycleId;
    const removed = api.trafficLog.reduce(
      (count, row) => count + (row === request || isMatchingFrame(row) ? 1 : 0),
      0
    );
    api.trafficLog = api.trafficLog.filter(row => row !== request && !isMatchingFrame(row));

    const identityKey = api._trafficIdentityKey(request.id, trafficLifecycleId);
    api._retainedTrafficGenerations.delete(identityKey);
    const expiresAt = api._activeTrafficIdentities.has(identityKey)
      ? Infinity
      : api._clearedPendingTrafficNow() + api.clearedPendingTrafficTtlMs;
    api._deletedTrafficIdentities.delete(identityKey);
    api._deletedTrafficIdentities.set(identityKey, expiresAt);
    api._pruneDeletedTrafficIdentities();

    const deletion = {
      requestId: request.id,
      trafficLifecycleId,
      webSocketConnection,
      removed
    };
    api._broadcast({ type: 'traffic-deleted', ...deletion });
    res.json({ success: true, ...deletion });
  });

  router.post('/api/traffic/import', (req, res) => {
    try {
      const { requests } = req.body;
      const validationError = api._getTrafficImportValidationError(requests);
      if (validationError) {
        return res.status(400).json({ error: `Invalid import format: ${validationError}` });
      }
      const retainedRequests = api._appendImportedTraffic(requests);
      api._broadcastImportedTraffic(retainedRequests, requests.length);
      res.json({ success: true, imported: requests.length });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });
}
