    // ============ STATE ============
    let ws = null;
    let requests = [];
    let filteredRequests = [];
    let selectedRequestId = null;
    let selectedRequestLifecycleId = null;
    let isPaused = false;
    let sortField = null;
    let sortDirection = 'desc';
    let config = {};
    let hideTunnelRequests = true;
    let filterSafeFonts = false;
    let protobufSchemaFiles = [];
    let protobufRoot = null;
    let protobufSchemaError = '';
    let mockRules = [];
    let breakpointRules = [];
    /** @type {Map<string, object>} Draft rules — unsaved changes keyed by rule ID */
    const mockDraftRules = new Map();
    /** @type {Set<string>} IDs of rules that are new (not yet on server) */
    const mockNewDraftIds = new Set();
    let mockSaveInProgress = false;
    let autoScroll = true;
    let requestCounter = 0;
    let filterDebounceTimer = null;

    function safeLocalStorageGet(key, fallback = null) {
      try {
        const value = window.localStorage.getItem(key);
        return value === null ? fallback : value;
      } catch (err) {
        console.warn('[Storage] Could not read ' + key + ': ' + err.message);
        return fallback;
      }
    }

    let localStoragePersistenceWarningShown = false;

    function warnLocalStoragePersistenceFailure() {
      if (localStoragePersistenceWarningShown) return;
      if (typeof toast !== 'function' || typeof document === 'undefined' ||
          !document.getElementById?.('toastContainer')) return;
      localStoragePersistenceWarningShown = true;
      toast(
        'Changes could not be saved locally. Check storage permissions or free up browser storage.',
        'error'
      );
    }

    function safeLocalStorageSet(key, value, notifyUser = true) {
      try {
        window.localStorage.setItem(key, value);
        return true;
      } catch (err) {
        console.warn('[Storage] Could not save ' + key + ': ' + err.message);
        if (notifyUser) warnLocalStoragePersistenceFailure();
        return false;
      }
    }

    function safeLocalStorageRemove(key, notifyUser = true) {
      try {
        window.localStorage.removeItem(key);
        return true;
      } catch (err) {
        console.warn('[Storage] Could not remove ' + key + ': ' + err.message);
        if (notifyUser) warnLocalStoragePersistenceFailure();
        return false;
      }
    }

    function buildTrafficViewHash(requestId, trafficLifecycleId = null) {
      const base = '#/view/' + encodeURIComponent(requestId);
      return trafficLifecycleId
        ? base + '?trafficLifecycleId=' + encodeURIComponent(trafficLifecycleId)
        : base;
    }

    function parseTrafficViewIdentityHash(hash) {
      const match = String(hash || '').match(/^#\/view\/([^?]+)(?:\?trafficLifecycleId=([^&]*))?$/);
      if (!match) return null;
      try {
        return {
          requestId: decodeURIComponent(match[1]),
          trafficLifecycleId: match[2] ? decodeURIComponent(match[2]) : null
        };
      } catch {
        return null;
      }
    }

    function parseTrafficViewHash(hash) {
      return parseTrafficViewIdentityHash(hash)?.requestId ?? null;
    }

    function parseTrafficViewLifecycleHash(hash) {
      return parseTrafficViewIdentityHash(hash)?.trafficLifecycleId ?? null;
    }

    // ============ WEBSOCKET FRAMES STATE ============
    /** Map of parent lifecycle keys -> [frame request objects] for WS frame sub-rows */
    let wsFramesByParent = Object.create(null);
    /** Set of WS connection lifecycle keys that are expanded to show frame sub-rows */
    const wsExpandedConnections = new Set();

    function isWebSocketConnection(request) {
      return request?.protocol === 'ws' || request?.protocol === 'wss';
    }

    function isConnectedWebSocket(request) {
      return isWebSocketConnection(request) && request.statusCode === 101 && !request.error;
    }

    function wsConnectionKey(request) {
      return request?.trafficLifecycleId
        ? JSON.stringify(['lifecycle', request.id, request.trafficLifecycleId])
        : JSON.stringify(['legacy', String(request?.id || '')]);
    }

    function wsFrameParentKey(frame) {
      return frame?.parentTrafficLifecycleId
        ? JSON.stringify(['lifecycle', frame.parentId, frame.parentTrafficLifecycleId])
        : JSON.stringify(['legacy', String(frame?.parentId || '')]);
    }

    // ============ VIRTUAL SCROLL STATE ============
    const VS_ROW_HEIGHT = 32;
    const VS_BUFFER = 15;
    const VS_HEADER_HEIGHT = 38;
    let vsRenderStart = -1;
    let vsRenderEnd = -1;
    let vsForceRender = false;
    let vsRafId = null;

    // ============ SEND TABS STATE ============
    let sendTabs = [{ id: 'tab-1', method: 'GET', url: '', headers: [], body: '', bodyType: 'raw', bodyFormat: 'text', urlEncodedFields: [], multipartFields: [], multipartBoundary: '', response: null }];
    let activeSendTab = 'tab-1';
    let sendTabCounter = 1;
    let currentSendAbort = null;
    /** @type {object|null} Active Monaco editor for the Send page request body */
    let sendBodyEditor = null;
    let sendUrlEncodedFields = [];
    let sendMultipartFields = [];
    let sendMultipartBoundary = '';
    let sendExportUpdateTimer = null;
    let sendExportCreating = false;
    const breakpointEditDrafts = new Map();

    function activateOnKeyboard(event) {
      if (event.target !== event.currentTarget) return;
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      if (event.repeat) return;
      event.currentTarget.click();
    }

    const API_BASE = `http://${window.location.hostname}:${window.location.port}`;
    const API_AUTH_TOKEN = new URLSearchParams(window.location.search).get('authToken') || '';
    const nativeFetch = window.fetch.bind(window);

    function authenticatedApiUrl(url) {
      if (!API_AUTH_TOKEN) return url;
      const authenticatedUrl = new URL(url, window.location.href);
      authenticatedUrl.searchParams.set('authToken', API_AUTH_TOKEN);
      return authenticatedUrl.toString();
    }

    window.fetch = (resource, options = {}) => {
      if (!API_AUTH_TOKEN) return nativeFetch(resource, options);
      const requestUrl = new URL(typeof resource === 'string' ? resource : resource.url, window.location.href);
      if (requestUrl.origin !== window.location.origin || !requestUrl.pathname.startsWith('/api/')) {
        return nativeFetch(resource, options);
      }
      const headers = new Headers(resource instanceof Request ? resource.headers : undefined);
      new Headers(options.headers || {}).forEach((value, name) => headers.set(name, value));
      headers.set('Authorization', `Bearer ${API_AUTH_TOKEN}`);
      return nativeFetch(resource, { ...options, headers });
    };

    const authenticatedFetch = window.fetch.bind(window);
    window.fetch = async (resource, options = {}) => {
      const requestUrl = new URL(typeof resource === 'string' ? resource : resource.url, window.location.href);
      const isManagementApi = requestUrl.origin === window.location.origin && requestUrl.pathname.startsWith('/api/');
      const response = await authenticatedFetch(resource, options);
      if (isManagementApi && !response.ok) {
        const payload = await response.clone().json().catch(() => ({}));
        const error = new Error(payload.error || `Management API returned HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      return response;
    };

    // ============ WEBSOCKET ============
    let wsReconnectDelay = 1000;

    function trimTrafficRows(rows, limit = 10_000) {
      const excess = rows.length - limit;
      if (excess <= 0) return rows;

      if (excess === 1) {
        const frameIndex = rows.findIndex(request => request?.protocol === 'ws-frame');
        rows.splice(frameIndex === -1 ? 0 : frameIndex, 1);
        return rows;
      }

      let framesToRemove = 0;
      for (const request of rows) {
        if (request?.protocol === 'ws-frame' && framesToRemove < excess) framesToRemove++;
      }
      let baseRowsToRemove = excess - framesToRemove;
      let writeIndex = 0;
      for (const request of rows) {
        if (request?.protocol === 'ws-frame' && framesToRemove > 0) {
          framesToRemove--;
        } else if (request?.protocol !== 'ws-frame' && baseRowsToRemove > 0) {
          baseRowsToRemove--;
        } else {
          rows[writeIndex++] = request;
        }
      }
      rows.length = writeIndex;
      return rows;
    }

    function normalizeTrafficLifecycleId(trafficLifecycleId) {
      return trafficLifecycleId === undefined || trafficLifecycleId === null || trafficLifecycleId === ''
        ? null
        : String(trafficLifecycleId);
    }

    function trafficRequestMatchesIdentity(request, requestId, trafficLifecycleId) {
      if (request?.id !== requestId) return false;
      if (trafficLifecycleId === undefined) return true;
      return normalizeTrafficLifecycleId(request.trafficLifecycleId) ===
        normalizeTrafficLifecycleId(trafficLifecycleId);
    }

    function findTrafficRequestByIdentity(collection, requestId, trafficLifecycleId) {
      return collection.find(request =>
        trafficRequestMatchesIdentity(request, requestId, trafficLifecycleId)
      ) || null;
    }

    function trafficRequestIdentityKey(request) {
      return JSON.stringify([
        String(request?.id || ''),
        normalizeTrafficLifecycleId(request?.trafficLifecycleId)
      ]);
    }

    function isSelectedTrafficRequest(request) {
      return selectedRequestId !== null && trafficRequestMatchesIdentity(
        request,
        selectedRequestId,
        selectedRequestLifecycleId
      );
    }

    function getSelectedTrafficRequest(collection = requests) {
      if (selectedRequestId === null) return null;
      return findTrafficRequestByIdentity(
        collection,
        selectedRequestId,
        selectedRequestLifecycleId
      );
    }

    function encodeTrafficDomIdentityPart(value) {
      const text = String(value ?? '');
      let encoded = '';
      for (let index = 0; index < text.length; index++) {
        encoded += text.charCodeAt(index).toString(16).padStart(4, '0');
      }
      return encoded;
    }

    function trafficRowDomId(request) {
      const lifecycleId = normalizeTrafficLifecycleId(request?.trafficLifecycleId);
      return lifecycleId === null
        ? 'row-request-' + encodeTrafficDomIdentityPart(request?.id)
        : 'row-lifecycle-' + encodeTrafficDomIdentityPart(request?.id) + '-' +
          encodeTrafficDomIdentityPart(lifecycleId);
    }

    function trafficRowIdentityAttributes(request) {
      return `data-id="${escapeHtmlAttribute(request?.id || '')}" ` +
        `data-lifecycle-id="${escapeHtmlAttribute(request?.trafficLifecycleId || '')}"`;
    }

    function mergeServerTrafficRequest(currentRequest, serverRequest) {
      const restoredRequest = { ...serverRequest };
      if (restoredRequest.trafficLifecycleId === undefined &&
          currentRequest?.trafficLifecycleId !== undefined) {
        restoredRequest.trafficLifecycleId = currentRequest.trafficLifecycleId;
      }
      delete restoredRequest._rendererOnly;
      if (restoredRequest.pinned !== true) delete restoredRequest.pinned;
      return restoredRequest;
    }

    function mergeDeferredTrafficRequest(currentRequest, serverRequest) {
      const hydratedRequest = mergeServerTrafficRequest(currentRequest, serverRequest);
      // Clear snapshots and detail requests can resolve after a newer pin event.
      // The deferred row is the renderer's current authority for that mutation.
      if (currentRequest?.pinned === true) hydratedRequest.pinned = true;
      else delete hydratedRequest.pinned;
      if (Object.hasOwn(currentRequest || {}, '_index')) {
        hydratedRequest._index = currentRequest._index;
      }
      return hydratedRequest;
    }

    function mergeTrafficDumpPins(currentRequests, serverRequests) {
      const existingRequests = Array.isArray(currentRequests) ? currentRequests : [];
      const currentById = new Map(
        existingRequests
          .filter(request => request?.id !== null && request?.id !== undefined)
          .map(request => [trafficRequestIdentityKey(request), request])
      );
      const restoredServerRequests = (Array.isArray(serverRequests) ? serverRequests : [])
        .map(request => mergeServerTrafficRequest(
          currentById.get(trafficRequestIdentityKey(request)),
          request
        ));
      const serverIds = new Set(restoredServerRequests.map(trafficRequestIdentityKey));
      const rendererOnlyPins = [];
      const restoredPinIds = new Set();
      for (let index = existingRequests.length - 1; index >= 0; index--) {
        const request = existingRequests[index];
        if (
          request?.pinned &&
          request._rendererOnly === true &&
          !serverIds.has(trafficRequestIdentityKey(request)) &&
          !restoredPinIds.has(trafficRequestIdentityKey(request))
        ) {
          restoredPinIds.add(trafficRequestIdentityKey(request));
          rendererOnlyPins.push(request);
        }
      }
      rendererOnlyPins.reverse();
      return trimTrafficRows([...restoredServerRequests, ...rendererOnlyPins]);
    }

    function restoreTrafficDump(serverRequests) {
      requests = mergeTrafficDumpPins(requests, serverRequests);
      requestCounter = requests.length;
      const selectedRequest = getSelectedTrafficRequest();
      if (
        selectedRequestId !== null &&
        !selectedRequest
      ) {
        closeDetail(false);
      }
      applyFilter();

      if (selectedRequest) showDetail(selectedRequest);
    }

    const appliedTrafficClearIds = new Set();
    const appliedTrafficPinRevisions = new Map();
    const pendingTrafficClearChunks = new Map();
    let latestTrafficClearRevision = 0;

    function applyTrafficCleared(clearId, retainedTraffic, revision, pinRevision) {
      const selectedBeforeClear = getSelectedTrafficRequest();
      const validRevision = Number.isSafeInteger(revision) && revision > 0 ? revision : null;
      const validPinRevision = Number.isSafeInteger(pinRevision) && pinRevision >= 0
        ? pinRevision
        : null;
      if ((revision !== undefined && validRevision === null) ||
          (pinRevision !== undefined && validPinRevision === null) ||
          (validRevision === null && latestTrafficClearRevision > 0) ||
          (validRevision !== null && validRevision < latestTrafficClearRevision)) {
        return false;
      }
      if (validRevision !== null && validRevision > latestTrafficClearRevision) {
        latestTrafficClearRevision = validRevision;
        for (const [pendingClearId, pending] of pendingTrafficClearChunks) {
          if (pending.revision !== null && pending.revision < validRevision) {
            pendingTrafficClearChunks.delete(pendingClearId);
          }
        }
      }
      const alreadyApplied = clearId && appliedTrafficClearIds.has(clearId);
      const upgradesDeferredSnapshot = alreadyApplied && Array.isArray(retainedTraffic) &&
        requests.some(request => request?._deferredTrafficDetail === true) &&
        retainedTraffic.some(request => request?._deferredTrafficDetail !== true);
      if (alreadyApplied && !upgradesDeferredSnapshot) return false;
      if (clearId && !alreadyApplied) {
        pendingTrafficClearChunks.delete(clearId);
        appliedTrafficClearIds.add(clearId);
        if (appliedTrafficClearIds.size > 32) {
          appliedTrafficClearIds.delete(appliedTrafficClearIds.values().next().value);
        }
      }

      let retainedIdentityKeys;
      if (upgradesDeferredSnapshot) {
        const retainedByIdentity = new Map(
          retainedTraffic.map(request => [trafficRequestIdentityKey(request), request])
        );
        const retainedById = new Map();
        for (const request of retainedTraffic) {
          if (!retainedById.has(request?.id)) retainedById.set(request?.id, []);
          retainedById.get(request?.id).push(request);
        }
        requests = requests.map(currentRequest => {
          if (currentRequest?._deferredTrafficDetail !== true) return currentRequest;
          let retainedRequest = retainedByIdentity.get(trafficRequestIdentityKey(currentRequest));
          if (!retainedRequest && currentRequest.trafficLifecycleId == null) {
            const sameId = retainedById.get(currentRequest.id) || [];
            if (sameId.length === 1) retainedRequest = sameId[0];
          }
          return retainedRequest && retainedRequest._deferredTrafficDetail !== true
            ? mergeDeferredTrafficRequest(currentRequest, retainedRequest)
            : currentRequest;
        });
        retainedIdentityKeys = new Set(requests.map(trafficRequestIdentityKey));
      } else if (Array.isArray(retainedTraffic)) {
        const currentByIdentity = new Map(
          requests.map(request => [trafficRequestIdentityKey(request), request])
        );
        requests = retainedTraffic.flatMap(retainedRequest => {
          const identityKey = trafficRequestIdentityKey(retainedRequest);
          const currentRequest = currentByIdentity.get(identityKey);
          if (retainedRequest?.pinned === true) {
            const appliedPinRevision = appliedTrafficPinRevisions.get(identityKey);
            const pinChangedAfterClear = currentRequest && validPinRevision !== null &&
              Number.isSafeInteger(appliedPinRevision) && appliedPinRevision > validPinRevision;
            return [pinChangedAfterClear
              ? mergeDeferredTrafficRequest(currentRequest, retainedRequest)
              : mergeServerTrafficRequest(currentRequest, retainedRequest)];
          }
          // Compatibility with older servers that returned identities only.
          return currentRequest ? [{ ...currentRequest, pinned: true }] : [];
        });
        retainedIdentityKeys = new Set(requests.map(trafficRequestIdentityKey));
      } else {
        requests = requests.filter(request => request.pinned);
        retainedIdentityKeys = new Set(requests.map(trafficRequestIdentityKey));
      }
      for (const identityKey of appliedTrafficPinRevisions.keys()) {
        if (!retainedIdentityKeys.has(identityKey)) appliedTrafficPinRevisions.delete(identityKey);
      }
      requestCounter = requests.length;
      vsRenderStart = -1;
      vsRenderEnd = -1;
      applyFilter();
      let selectedRequest = getSelectedTrafficRequest();
      if (!selectedRequest && selectedRequestId !== null) {
        const sameIdRequests = requests.filter(request => request?.id === selectedRequestId);
        const canRebindDeferredIdentity = sameIdRequests.length === 1 && (
          (sameIdRequests[0]?._deferredTrafficDetail === true &&
            normalizeTrafficLifecycleId(sameIdRequests[0].trafficLifecycleId) === null) ||
          selectedBeforeClear?._deferredTrafficDetail === true
        );
        if (canRebindDeferredIdentity) {
          selectedRequest = sameIdRequests[0];
          selectedRequestLifecycleId = normalizeTrafficLifecycleId(
            selectedRequest.trafficLifecycleId
          );
        }
      }
      if (selectedRequestId !== null && !selectedRequest) closeDetail();
      else if (selectedRequest?._deferredTrafficDetail === true) {
        void hydrateDeferredTrafficRequest(selectedRequest);
      } else if (selectedRequest) showDetail(selectedRequest);
      return true;
    }

    function applyTrafficClearedMessage(message) {
      const clearId = message?.clearId;
      const revision = Number.isSafeInteger(message?.revision) && message.revision > 0
        ? message.revision
        : null;
      if (typeof clearId !== 'string' || !clearId || !Array.isArray(message.retainedTraffic)) {
        return false;
      }
      const compactDeferred = message.d === 1 || message.deferred === true;
      const rawPinRevision = message.d === 1 ? message.p : message.pinRevision;
      const pinRevision = Number.isSafeInteger(rawPinRevision) && rawPinRevision >= 0
        ? rawPinRevision
        : null;
      if (rawPinRevision !== undefined && pinRevision === null) return false;
      let retainedTraffic = message.retainedTraffic;
      if (compactDeferred) {
        retainedTraffic = retainedTraffic.map(request => {
          if (!request || typeof request.id !== 'string' || !request.id ||
              (request.l !== undefined &&
                (typeof request.l !== 'string' || !request.l))) {
            return null;
          }
          return {
            id: request.id,
            ...(request.l === undefined ? {} : { trafficLifecycleId: request.l }),
            pinned: true,
            _deferredTrafficDetail: true
          };
        });
        if (retainedTraffic.some(request => request === null)) return false;
      }
      if ((message.revision !== undefined && revision === null) ||
          (revision === null && latestTrafficClearRevision > 0) ||
          (revision !== null && revision < latestTrafficClearRevision)) {
        return false;
      }
      if (message.chunkCount === undefined && message.chunkIndex === undefined) {
        return applyTrafficCleared(
          clearId,
          retainedTraffic,
          revision ?? undefined,
          pinRevision ?? undefined
        );
      }
      if (!Number.isSafeInteger(message.chunkCount) || message.chunkCount < 1 ||
          message.chunkCount > 10_000 ||
          !Number.isSafeInteger(message.chunkIndex) || message.chunkIndex < 0 ||
          message.chunkIndex >= message.chunkCount || appliedTrafficClearIds.has(clearId)) {
        return false;
      }

      let pending = pendingTrafficClearChunks.get(clearId);
      if (!pending || pending.chunkCount !== message.chunkCount ||
          pending.revision !== revision || pending.pinRevision !== pinRevision ||
          pending.compactDeferred !== compactDeferred) {
        pending = {
          chunkCount: message.chunkCount,
          chunks: new Array(message.chunkCount),
          received: 0,
          revision,
          pinRevision,
          compactDeferred
        };
        pendingTrafficClearChunks.set(clearId, pending);
        if (pendingTrafficClearChunks.size > 8) {
          pendingTrafficClearChunks.delete(pendingTrafficClearChunks.keys().next().value);
        }
      }
      if (pending.chunks[message.chunkIndex] === undefined) {
        pending.chunks[message.chunkIndex] = retainedTraffic;
        pending.received++;
      }
      if (pending.received !== pending.chunkCount) return false;

      pendingTrafficClearChunks.delete(clearId);
      return applyTrafficCleared(
        clearId,
        pending.chunks.flat(),
        revision ?? undefined,
        pinRevision ?? undefined
      );
    }

    function applyTrafficPinned(requestId, trafficLifecycleId, pinned, revision) {
      const identityKey = trafficRequestIdentityKey({ id: requestId, trafficLifecycleId });
      if (Number.isSafeInteger(revision)) {
        const appliedRevision = appliedTrafficPinRevisions.get(identityKey);
        if (appliedRevision !== undefined && revision <= appliedRevision) return false;
        appliedTrafficPinRevisions.set(identityKey, revision);
      }
      const request = findTrafficRequestByIdentity(requests, requestId, trafficLifecycleId);
      if (!request) return false;
      if (pinned === true) request.pinned = true;
      else delete request.pinned;
      if (isSelectedTrafficRequest(request)) updatePinIcon(request.pinned === true);
      renderTraffic();
      return true;
    }

    function applyTrafficDeleted(
      requestId,
      trafficLifecycleId,
      webSocketConnection = false
    ) {
      const target = findTrafficRequestByIdentity(requests, requestId, trafficLifecycleId);
      const removeFrames = webSocketConnection || isWebSocketConnection(target);
      const originalLength = requests.length;
      requests = requests.filter(request => {
        if (trafficRequestMatchesIdentity(request, requestId, trafficLifecycleId)) return false;
        return !(removeFrames &&
          request.protocol === 'ws-frame' &&
          request.parentId === requestId &&
          normalizeTrafficLifecycleId(request.parentTrafficLifecycleId) ===
            normalizeTrafficLifecycleId(trafficLifecycleId));
      });
      if (requests.length === originalLength) return false;

      if (removeFrames && target) wsExpandedConnections.delete(wsConnectionKey(target));
      requestCounter = requests.length;
      applyFilter();
      if (selectedRequestId !== null && !getSelectedTrafficRequest()) closeDetail();
      return true;
    }

    function connectWebSocket() {
      const wsUrl = authenticatedApiUrl(`ws://${window.location.hostname}:${window.location.port}/ws`);
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        wsReconnectDelay = 1000; // reset on success
        document.getElementById('statusDot')?.classList.add('connected');
        const statusTextEl = document.getElementById('statusText');
        if (statusTextEl) statusTextEl.textContent = 'Connected';
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          handleWsMessage(msg);
        } catch (err) {
          console.error('[WS] Failed to parse message:', err.message);
        }
      };

      ws.onclose = () => {
        document.getElementById('statusDot')?.classList.remove('connected');
        const statusTextEl = document.getElementById('statusText');
        if (statusTextEl) statusTextEl.textContent = 'Disconnected';
        const ss = document.getElementById('settingsStatus');
        if (ss) { ss.textContent = 'Disconnected'; ss.style.color = '#ce3939'; }
        // Reconnect with exponential backoff (max 30s)
        setTimeout(connectWebSocket, wsReconnectDelay);
        wsReconnectDelay = Math.min(wsReconnectDelay * 1.5, 30000);
      };

      ws.onerror = () => {
        document.getElementById('statusDot')?.classList.remove('connected');
        const statusTextEl = document.getElementById('statusText');
        if (statusTextEl) statusTextEl.textContent = 'Error';
      };
    }

    function handleWsMessage(msg) {
      switch (msg.type) {
        case 'init': {
          const proxyPortEl = document.getElementById('proxyPortDisplay');
          if (proxyPortEl) proxyPortEl.textContent = `127.0.0.1:${msg.proxyPort}`;
          const apiPortEl = document.getElementById('apiPortDisplay');
          if (apiPortEl) apiPortEl.textContent = msg.apiPort;
          const settingsProxyEl = document.getElementById('settingsProxyPort');
          if (settingsProxyEl) settingsProxyEl.textContent = msg.proxyPort;
          const settingsApiEl = document.getElementById('settingsApiPort');
          if (settingsApiEl) settingsApiEl.textContent = msg.apiPort;
          const statusEl = document.getElementById('settingsStatus');
          if (statusEl) { statusEl.textContent = 'Connected'; statusEl.style.color = '#4caf7d'; }
          config.proxyPort = msg.proxyPort;
          config.apiPort = msg.apiPort;
          ws.send(JSON.stringify({
            type: 'get-traffic',
            limit: msg.trafficLimit || msg.trafficCount || 100
          }));
          // Load initial data
          loadConfig();
          loadUiSettings();
          loadProtobufSchemas();
          loadInterceptors();
          loadMockRules().then(loaded => {
            if (loaded) ensureDefaultMockRules();
          });
          loadBreakpointRules();
          loadUpstreamProxy();
          loadBottingToolsProxyProviders();
          loadAutoRotateProxyOnError();
          loadTlsPassthrough();
          loadClientCerts();
          loadTrustedCAs();
          loadHttpsWhitelist();
          loadHttp2Config();
          loadTlsFingerprint();
          loadApiSpecs();
          loadMcpStatus();
          // Check for deep-linked request to auto-select after traffic loads
          const deepLinkId = parseTrafficViewHash(window.location.hash);
          const deepLinkLifecycleId = parseTrafficViewLifecycleHash(window.location.hash);
          if (deepLinkId !== null) {
            setTimeout(() => {
              if (findTrafficRequestByIdentity(requests, deepLinkId, deepLinkLifecycleId ?? undefined)) {
                selectRequest(deepLinkId, false, deepLinkLifecycleId ?? undefined);
              }
            }, 1500);
          }
          break;
        }
        case 'request':
          if (!isPaused || msg.data?.source === 'Send') {
            addRequest(msg.data);
          }
          break;
        case 'request-update':
          // Update an existing request in-place (pending → complete)
          if (msg.data?.id) {
            const idx = requests.findIndex(r =>
              r.id === msg.data.id &&
              (msg.data.trafficLifecycleId === undefined ||
                r.trafficLifecycleId === msg.data.trafficLifecycleId)
            );
            if (idx !== -1) {
              msg.data = mergeServerTrafficRequest(requests[idx], msg.data);
              requests[idx] = msg.data;
              applyFilter();
              // If this request is currently selected, refresh the detail view
              const detailPanel = document.getElementById('detailPanel');
              if (isSelectedTrafficRequest(msg.data)) {
                detailPanel._request = msg.data;
                renderDetailCards(msg.data);
              }
            }
          }
          break;
        case 'proxy-auto-rotate':
          handleProxyAutoRotateEvent(msg);
          break;
        case 'interceptor-status':
          handleInterceptorStatusEvent(msg.data);
          break;
        case 'traffic-cleared':
          applyTrafficClearedMessage(msg);
          break;
        case 'traffic-pinned':
          applyTrafficPinned(
            msg.requestId,
            msg.trafficLifecycleId,
            msg.pinned,
            msg.revision
          );
          break;
        case 'traffic-deleted':
          applyTrafficDeleted(
            msg.requestId,
            msg.trafficLifecycleId,
            msg.webSocketConnection === true
          );
          break;
        case 'traffic-dump':
          restoreTrafficDump(msg.requests);
          break;
        case 'traffic-imported':
          addRequests(msg.requests);
          if (msg.chunkCount === undefined || msg.chunkIndex === msg.chunkCount - 1) {
            toast(`Imported ${msg.count} requests`, 'success');
          }
          break;
        case 'breakpoint-hit':
          updateBreakpointBanner();
          {
            const viewTab = document.querySelector('.sidebar-item[data-panel="traffic"]');
            if (viewTab && !document.getElementById('panel-traffic')?.classList.contains('active')) {
              switchPanel(viewTab, 'traffic');
            }
          }
          selectBreakpointRequest(msg.requestId, msg.trafficLifecycleId);
          break;
        case 'breakpoint-resumed':
          clearBreakpointEditDraft(msg.requestId, msg.trafficLifecycleId);
          updateBreakpointBanner();
          break;
        case 'mcp-filter':
          // MCP tool applied a filter — update the search input and re-filter
          const searchInput = document.getElementById('searchInput');
          if (searchInput) {
            searchInput.value = msg.filter || '';
            if (typeof updateSearchClearBtn === 'function') updateSearchClearBtn();
          }
          // Switch to the View tab if not already there
          const viewTab = document.querySelector('.sidebar-item[data-panel="traffic"]');
          if (viewTab && !document.getElementById('panel-traffic')?.classList.contains('active')) {
            switchPanel(viewTab, 'traffic');
          }
          applyFilter();
          toast('Filter applied by AI: ' + (msg.filter || '(cleared)'), 'success');
          break;
        case 'mcp-select':
          // MCP tool selected a request — switch to View tab and select it
          const viewTab2 = document.querySelector('.sidebar-item[data-panel="traffic"]');
          if (viewTab2 && !document.getElementById('panel-traffic')?.classList.contains('active')) {
            switchPanel(viewTab2, 'traffic');
          }
          if (msg.requestId) {
            setTimeout(() => selectRequest(
              msg.requestId,
              false,
              msg.trafficLifecycleId
            ), 200);
          }
          toast('Request selected by AI', 'success');
          break;
      }
    }

    // ============ TRAFFIC ============
    function addRequests(incomingRequests) {
      if (!Array.isArray(incomingRequests) || incomingRequests.length === 0) return;
      for (const req of incomingRequests) {
        if (!req || typeof req !== 'object') continue;
        requestCounter++;
        req._index = requestCounter;
        requests.push(req);
      }

      // Child frames are useful only while their parent row remains inspectable.
      requests = trimTrafficRows(requests);
      if (
        selectedRequestId !== null &&
        !getSelectedTrafficRequest()
      ) {
        closeDetail(false);
      }
      applyFilter();
    }

    function addRequest(req) {
      requestCounter++;
      req._index = requestCounter;
      requests.push(req);

      // Child frames are useful only while their parent row remains inspectable.
      requests = trimTrafficRows(requests);
      // Track a frame only if capacity trimming retained it.
      if (requests.includes(req) && req.protocol === 'ws-frame' && req.parentId) {
        const parentKey = wsFrameParentKey(req);
        if (!wsFramesByParent[parentKey]) wsFramesByParent[parentKey] = [];
        wsFramesByParent[parentKey].push(req);
      }
      if (
        selectedRequestId !== null &&
        !getSelectedTrafficRequest()
      ) {
        closeDetail(false);
      }
      applyFilter();
    }

    function isTunnelRequest(req) {
      return req?.protocol === 'tunnel' || req?.method === 'CONNECT';
    }

    function isSafeFontRequest(req) {
      return ['fonts.gstatic.com', 'fonts.googleapis.com'].includes(String(req?.host || '').toLowerCase());
    }

    function applyFilter() {
      const raw = document.getElementById('searchInput').value.trim();

      // Rebuild wsFramesByParent index (handles clears, imports, etc.)
      wsFramesByParent = Object.create(null);
      requests.forEach(r => {
        if (r.protocol === 'ws-frame' && r.parentId) {
          const parentKey = wsFrameParentKey(r);
          if (!wsFramesByParent[parentKey]) wsFramesByParent[parentKey] = [];
          wsFramesByParent[parentKey].push(r);
        }
      });

      // Filter base list (exclude ws-frame — they appear as sub-rows)
      let baseList;
      if (!raw) {
        baseList = requests.filter(r =>
          r.protocol !== 'ws-frame' &&
          (!hideTunnelRequests || !isTunnelRequest(r)) &&
          (!filterSafeFonts || !isSafeFontRequest(r))
        );
      } else {
        const filters = parseFilters(raw);
        baseList = requests.filter(r =>
          r.protocol !== 'ws-frame' &&
          (!hideTunnelRequests || !isTunnelRequest(r)) &&
          (!filterSafeFonts || !isSafeFontRequest(r)) &&
          matchesAllFilters(r, filters)
        );
      }

      if (sortField) {
        baseList.sort((a, b) => {
          let aVal = a[sortField], bVal = b[sortField];
          if (typeof aVal === 'string') aVal = aVal.toLowerCase();
          if (typeof bVal === 'string') bVal = bVal.toLowerCase();
          if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
          if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
          return 0;
        });
      }

      // Expand WS connections: insert frame sub-rows after expanded parents
      filteredRequests = [];
      for (const r of baseList) {
        filteredRequests.push(r);
        const parentKey = wsConnectionKey(r);
        if (isWebSocketConnection(r) && wsExpandedConnections.has(parentKey)) {
          const frames = wsFramesByParent[parentKey] || [];
          filteredRequests.push(...frames);
        }
      }

      renderTraffic();
    }

    function parseFilters(raw) {
      const filters = [];
      // Match tokens: either "type:value" or plain words
      const regex = /(\w+):("[^"]*"|\S+)|(\S+)/g;
      let match;
      while ((match = regex.exec(raw)) !== null) {
        if (match[1]) {
          // Structured filter: type:value
          const type = match[1].toLowerCase();
          let value = match[2];
          if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
          filters.push({ type, value });
        } else if (match[3]) {
          // Plain text search
          filters.push({ type: 'text', value: match[3] });
        }
      }
      return filters;
    }

    function plainSearchValueIncludes(value, searchText) {
      const values = Array.isArray(value) ? value : [value];
      return values.some(item => {
        if (item === null || item === undefined ||
            typeof item === 'object' || typeof item === 'function') {
          return false;
        }
        return String(item).toLowerCase().includes(searchText);
      });
    }

    function plainSearchHeadersInclude(headers, searchText) {
      if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return false;
      return Object.entries(headers).some(([name, value]) =>
        name.toLowerCase().includes(searchText) || plainSearchValueIncludes(value, searchText)
      );
    }

    function matchesAllFilters(req, filters) {
      return filters.every(f => matchesFilter(req, f));
    }

    function findHeaderValues(headers, targetName) {
      if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return null;
      const normalizedTargetName = String(targetName).toLowerCase();
      const values = [];
      let present = false;
      for (const [name, value] of Object.entries(headers)) {
        if (name.toLowerCase() !== normalizedTargetName) continue;
        present = true;
        const headerValues = Array.isArray(value) ? value : [value];
        values.push(...headerValues.map(item => String(item ?? '')));
      }
      return present ? values : null;
    }

    function getCombinedHeaderValue(headers, targetName) {
      return (findHeaderValues(headers, targetName) || []).join(', ');
    }

    function matchesFilter(req, filter) {
      const val = filter.value.toLowerCase();
      switch (filter.type) {
        case 'method':
          return req.method?.toLowerCase() === val;
        case 'status': {
          if (val.endsWith('xx')) {
            const base = parseInt(val[0]) * 100;
            return req.statusCode >= base && req.statusCode < base + 100;
          }
          return String(req.statusCode) === val;
        }
        case 'host':
          return req.host?.toLowerCase().includes(val);
        case 'path':
          return req.path?.toLowerCase().includes(val);
        case 'source':
          return (req.source || 'proxy').toLowerCase().includes(val);
        case 'body':
          return (req.responseBody || '').toLowerCase().includes(val) ||
                 (req.requestBody || '').toLowerCase().includes(val);
        case 'header': {
          const separatorIndex = val.indexOf('=');
          const hName = separatorIndex === -1 ? val : val.slice(0, separatorIndex);
          const hVal = separatorIndex === -1 ? null : val.slice(separatorIndex + 1);
          const requestValues = findHeaderValues(req.requestHeaders, hName);
          const responseValues = findHeaderValues(req.responseHeaders, hName);
          if (hVal === null) return requestValues !== null || responseValues !== null;
          return [...(requestValues || []), ...(responseValues || [])]
            .some(value => value.toLowerCase().includes(hVal));
        }
        case 'text':
        default:
          // Search across all fields
          return plainSearchValueIncludes(req.url, val) ||
            plainSearchValueIncludes(req.method, val) ||
            plainSearchValueIncludes(req.host, val) ||
            String(req.statusCode).includes(val) ||
            plainSearchValueIncludes(req.path, val) ||
            plainSearchValueIncludes(req.source, val) ||
            plainSearchHeadersInclude(req.requestHeaders, val) ||
            plainSearchHeadersInclude(req.responseHeaders, val) ||
            plainSearchValueIncludes(req.requestBody, val) ||
            plainSearchValueIncludes(req.responseBody, val);
      }
    }

    function showFilterHint() {
      const input = document.getElementById('searchInput');
      const val = input.value;
      const hint = document.getElementById('filterHint');
      if (!hint) return;

      // Show hint when user is typing a filter prefix
      const lastWord = val.split(/\s+/).pop();

      if (!lastWord || lastWord.includes(':')) {
        hint.style.display = 'none';
        return;
      }

      const suggestions = [
        { prefix: 'method', desc: 'Filter by HTTP method (GET, POST...)' },
        { prefix: 'status', desc: 'Filter by status code (200, 4xx...)' },
        { prefix: 'host', desc: 'Filter by hostname' },
        { prefix: 'path', desc: 'Filter by request path' },
        { prefix: 'source', desc: 'Filter by source (Chrome, cURL...)' },
        { prefix: 'body', desc: 'Search in request/response body' },
        { prefix: 'header', desc: 'Filter by header (name=value)' },
      ].filter(s => s.prefix.startsWith(lastWord.toLowerCase()));

      if (suggestions.length === 0 || (suggestions.length === 1 && suggestions[0].prefix === lastWord)) {
        hint.style.display = 'none';
        return;
      }

      hint.style.display = 'block';
      hint.innerHTML = suggestions.map(s =>
        `<div class="filter-hint-item" onmousedown="applyFilterHint('${s.prefix}')">
          <span style="color:var(--pop-color);font-weight:600;">${s.prefix}:</span>
          <span style="color:var(--text-lowlight);font-size:11px;margin-left:8px;">${s.desc}</span>
        </div>`
      ).join('');
    }

    function applyFilterHint(prefix) {
      const input = document.getElementById('searchInput');
      const words = input.value.split(/\s+/);
      words[words.length - 1] = prefix + ':';
      input.value = words.join(' ');
      input.focus();
      document.getElementById('filterHint').style.display = 'none';
      updateSearchClearBtn();
    }

    function debouncedApplyFilter() {
      clearTimeout(filterDebounceTimer);
      filterDebounceTimer = setTimeout(() => {
        applyFilter();
      }, 150);
    }

    function clearSearchFilter() {
      const input = document.getElementById('searchInput');
      if (input) { input.value = ''; input.focus(); }
      document.getElementById('searchClearBtn').style.display = 'none';
      document.getElementById('filterHint').style.display = 'none';
      applyFilter();
    }

    function updateSearchClearBtn() {
      const input = document.getElementById('searchInput');
      const btn = document.getElementById('searchClearBtn');
      if (input && btn) {
        btn.style.display = input.value.trim() ? 'block' : 'none';
      }
    }

    // Source icons — Phosphor icon elements keyed by the source string from _detectSource()
    const _globe = '<i class="ph ph-globe" style="font-size:16px;line-height:1;"></i>';
    const _browser = '<i class="ph ph-globe" style="font-size:16px;line-height:1;"></i>';
    const _terminal = '<i class="ph ph-terminal" style="font-size:16px;line-height:1;"></i>';
    const _gear = '<i class="ph ph-gear-six" style="font-size:16px;line-height:1;"></i>';
    const _folder = '<i class="ph ph-folder-open" style="font-size:16px;line-height:1;"></i>';
    const _cube = '<i class="ph ph-cube" style="font-size:16px;line-height:1;"></i>';
    const SOURCE_ICONS = {
      Chrome: _browser, Firefox: _browser, Edge: _browser, Brave: _browser,
      Safari: _browser, Opera: _browser,
      'cURL': _terminal, wget: _terminal, PowerShell: _terminal,
      'Node.js': _terminal, Python: _terminal, Go: _terminal, Java: _terminal,
      Docker: _cube,
      mock: _gear, import: _folder,
      proxy: _globe, Unknown: _globe, Other: _globe,
      'tls-error': '<i class="ph ph-lock-simple-open" style="font-size:16px;line-height:1;color:#ce3939;"></i>',
      tunnel: '<i class="ph ph-plugs-connected" style="font-size:16px;line-height:1;color:#888;"></i>'
    };

    function formatRemoteEndpoint(address, port, fallbackPort) {
      if (address === null || address === undefined || address === '') return '';
      const rawAddress = String(address);
      const displayAddress = rawAddress.includes(':') &&
        !(rawAddress.startsWith('[') && rawAddress.endsWith(']'))
        ? `[${rawAddress}]`
        : rawAddress;
      const displayPort = port === null || port === undefined ? fallbackPort : port;
      return esc(displayAddress) + (
        displayPort === null || displayPort === undefined
          ? ''
          : ':' + esc(String(displayPort))
      );
    }

    function buildRowHtml(req, index) {
      const rowSelected = isSelectedTrafficRequest(req);
      const selected = rowSelected ? 'selected' : '';
      const rowId = escapeHtmlAttribute(trafficRowDomId(req));
      const identityAttributes = trafficRowIdentityAttributes(req);
      const selectHandler = "selectRequest(this.dataset.id, true, this.dataset.lifecycleId)";
      // ---- WebSocket frame sub-row ----
      if (req.protocol === 'ws-frame') {
        const dirArrow = req.direction === 'client' ? '&rarr;' : '&larr;';
        const dirClass = req.direction === 'client' ? 'ws-frame-client' : 'ws-frame-server';
        const preview = esc((req.requestBody || '').substring(0, 80)) + (req.requestBody && req.requestBody.length > 80 ? '...' : '');
        const byteCount = formatSize(req.requestBodySize);
        const opName = esc(req.opcodeName || 'data');
        return `<tr class="ws-frame-row ${dirClass} ${selected}" id="${rowId}" role="row" aria-rowindex="${index + 1}" aria-selected="${rowSelected}" ${identityAttributes} onclick="${selectHandler}">
          <td role="gridcell" style="padding:0;width:5px;"><div class="row-marker" style="color:#4caf7d;"></div></td>
          <td role="gridcell" colspan="2" style="padding-left:24px;"><span class="ws-frame-dir">${dirArrow}</span> <span class="ws-frame-opcode">${opName}</span></td>
          <td role="gridcell" style="font-size:11px;color:var(--text-lowlight);">${byteCount}</td>
          <td role="gridcell" colspan="2" class="ws-frame-preview" title="${esc(req.requestBody || '')}">${preview || '<span style="color:var(--text-watermark);">empty</span>'}</td>
        </tr>`;
      }

      // ---- TLS error row (italic, 28px, centered text) ----
      if (req.protocol === 'tls-error') {
        const source = req.source || 'tls-error';
        const sourceIcon = SOURCE_ICONS[source] || SOURCE_ICONS['tls-error'];
        return `<tr class="tls-error-row ${selected}" id="${rowId}" role="row" aria-rowindex="${index + 1}" aria-selected="${rowSelected}" ${identityAttributes} onclick="${selectHandler}">
          <td role="gridcell" style="padding:0;width:5px;"><div class="row-marker" style="color:#ce3939;"></div></td>
          <td role="gridcell"><span class="method-badge method-CONNECT">TLS</span></td>
          <td role="gridcell"><span class="status-badge status-5xx">ERR</span></td>
          <td role="gridcell" class="source-cell"><span class="source-icon source-tls-error" title="TLS Error">${sourceIcon}</span></td>
          <td role="gridcell" colspan="2" style="text-align:center;" title="${esc(req.error || req.responseBody || '')}">${esc(req.host || '-')} — ${esc(req.error || req.responseBody || 'TLS Handshake Failed')}</td>
        </tr>`;
      }

      // ---- Tunnel row (italic, 28px, centered text) ----
      if (req.protocol === 'tunnel') {
        const source = req.source || 'tunnel';
        const sourceIcon = SOURCE_ICONS[source] || SOURCE_ICONS.tunnel;
        const bytesSent = formatSize(req.requestBodySize || 0);
        const bytesRecv = formatSize(req.responseBodySize || 0);
        const tunnelEndpoint = formatRemoteEndpoint(
          req.remote?.address || req.host || '-',
          req.remote?.port,
          443
        );
        return `<tr class="tunnel-row ${selected}" id="${rowId}" role="row" aria-rowindex="${index + 1}" aria-selected="${rowSelected}" ${identityAttributes} onclick="${selectHandler}">
          <td role="gridcell" style="padding:0;width:5px;"><div class="row-marker" style="color:#888;"></div></td>
          <td role="gridcell"><span class="method-badge method-CONNECT">TUNNEL</span></td>
          <td role="gridcell"><span class="status-badge status-2xx">200</span></td>
          <td role="gridcell" class="source-cell"><span class="source-icon source-tunnel" title="Tunnel">${sourceIcon}</span></td>
          <td role="gridcell" colspan="2" style="text-align:center;" title="Tunnel to ${tunnelEndpoint}">${esc(req.host || '-')} — ${bytesSent} / ${bytesRecv}</td>
        </tr>`;
      }

      // ---- Standard row ----
      const methodClass = isWebSocketConnection(req) ? 'method-WS' : `method-${req.method}`;
      let statusClass = req.statusCode === null || req.statusCode === undefined ? 'status-pending' :
        req.error ? 'status-err' :
        req.statusCode === 0 ? 'status-err' :
        req.statusCode < 200 ? 'status-1xx' :
        req.statusCode < 300 ? 'status-2xx' :
        req.statusCode < 400 ? 'status-3xx' :
        req.statusCode < 500 ? 'status-4xx' : 'status-5xx';
      if (isConnectedWebSocket(req)) {
        statusClass = 'status-2xx';
      }
      const source = req.source || 'proxy';
      const sourceIcon = SOURCE_ICONS[source] || SOURCE_ICONS.proxy;
      const markerColor = req.source === 'breakpoint' ? '#f1971f' :
        ['POST','PUT','DELETE','PATCH'].includes(req.method) ? '#ce3939' :
        source === 'mock' ? '#6e40aa' : '#888';
      const statusHtml = req.statusCode === null || req.statusCode === undefined
        ? '<span class="status-badge status-pending" title="Pending..."><svg width="14" height="14" viewBox="0 0 16 16" style="animation:spin 0.8s linear infinite;"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="28 10" stroke-linecap="round" opacity="0.8"/></svg></span>'
        : req.breakpointActive === true
        ? '<span class="status-badge status-breakpoint" title="Paused at breakpoint">&#9208;</span>'
        : `<span class="status-badge ${statusClass}">${req.statusCode || 'ERR'}</span>`;
      const pinIcon = req.pinned ? '<span class="row-pin" title="Pinned">&#128204;</span>' : '';
      const truncatedBodyIcon = req.requestBodyTruncated === true || req.responseBodyTruncated === true
        ? '<span class="row-truncated-body" title="Body capture incomplete; viewing and search cover retained bytes only">&#9888;</span>'
        : '';

      // WS connection: add frame count badge and expand toggle
      let wsFrameBadge = '';
      if (isWebSocketConnection(req)) {
        const parentKey = wsConnectionKey(req);
        const frameCount = (wsFramesByParent[parentKey] || []).length;
        const isExpanded = wsExpandedConnections.has(parentKey);
        const expandIcon = isExpanded ? '&#9660;' : '&#9654;';
        if (frameCount > 0) {
          wsFrameBadge = `<span class="ws-expand-toggle" ${identityAttributes} onclick="event.stopPropagation();toggleWsExpand(this.dataset.id,this.dataset.lifecycleId)" title="${isExpanded ? 'Collapse' : 'Expand'} ${frameCount} frames">${expandIcon}</span><span class="ws-frame-count">${frameCount}</span>`;
        }
      }

      return `<tr class="${selected}" id="${rowId}" role="row" aria-rowindex="${index + 1}" aria-selected="${rowSelected}" aria-haspopup="menu" tabindex="-1" ${identityAttributes} onclick="${selectHandler}" oncontextmenu="showTrafficContextMenu(event, this.dataset.id, this, this.dataset.lifecycleId)">
        <td role="gridcell" style="padding:0;width:5px;"><div class="row-marker" style="color:${markerColor};"></div></td>
        <td role="gridcell">${pinIcon}${truncatedBodyIcon}${wsFrameBadge}<span class="method-badge ${methodClass}">${isWebSocketConnection(req) ? 'WS' : esc(req.method)}</span></td>
        <td role="gridcell">${statusHtml}</td>
        <td role="gridcell" class="source-cell"><span class="source-icon source-${source}" title="${source}">${sourceIcon}</span></td>
        <td role="gridcell" title="${esc(req.host)}">${esc(req.host || '-')}</td>
        <td role="gridcell" title="${esc(req.path)}">${esc(req.path || '/')}</td>
      </tr>`;
    }

    // Render the visible virtual-scroll rows into the tbody
    function renderVirtualRows() {
      const tbody = document.getElementById('trafficBody');
      const wrapper = document.getElementById('trafficTableWrapper');
      const totalRows = filteredRequests.length;
      if (totalRows === 0) {
        tbody.innerHTML = '';
        updateTrafficActiveDescendant(null);
        return;
      }

      const scrollTop = wrapper.scrollTop;
      const clientHeight = wrapper.clientHeight;

      const firstVisible = Math.floor(scrollTop / VS_ROW_HEIGHT);
      const lastVisible = Math.min(totalRows, Math.ceil((scrollTop + clientHeight - VS_HEADER_HEIGHT) / VS_ROW_HEIGHT));

      const renderStart = Math.max(0, firstVisible - VS_BUFFER);
      const renderEnd = Math.min(totalRows, lastVisible + VS_BUFFER);

      // Skip re-render if range and selection haven't changed
      if (!vsForceRender && renderStart === vsRenderStart && renderEnd === vsRenderEnd) {
        updateTrafficActiveDescendant(getSelectedTrafficRequest(filteredRequests));
        return;
      }

      let html = '';
      // Top spacer
      if (renderStart > 0) {
        html += `<tr class="vs-spacer"><td colspan="6" style="height:${renderStart * VS_ROW_HEIGHT}px;padding:0;border:none;"></td></tr>`;
      }
      // Visible rows
      for (let i = renderStart; i < renderEnd; i++) {
        html += buildRowHtml(filteredRequests[i], i);
      }
      // Bottom spacer
      if (renderEnd < totalRows) {
        html += `<tr class="vs-spacer"><td colspan="6" style="height:${(totalRows - renderEnd) * VS_ROW_HEIGHT}px;padding:0;border:none;"></td></tr>`;
      }

      tbody.innerHTML = html;
      vsRenderStart = renderStart;
      vsRenderEnd = renderEnd;
      vsForceRender = false;
      updateTrafficActiveDescendant(getSelectedTrafficRequest(filteredRequests));
    }

    function renderTraffic() {
      const tbody = document.getElementById('trafficBody');
      const empty = document.getElementById('emptyState');
      const countEl = document.getElementById('trafficCount');
      const countLabel = document.getElementById('trafficCountLabel');
      const footerCount = document.getElementById('footerRequestCount');
      const footerFilter = document.getElementById('footerFilterCount');

      updateSortHeaders();

      // Update aria-rowcount on the traffic table
      const trafficTable = document.getElementById('trafficGrid');
      if (trafficTable) trafficTable.setAttribute('aria-rowcount', String(filteredRequests.length));

      const query = document.getElementById('searchInput').value.trim();
      const visibleTotal = requests.filter(r =>
        r.protocol !== 'ws-frame' &&
        (!hideTunnelRequests || !isTunnelRequest(r)) &&
        (!filterSafeFonts || !isSafeFontRequest(r))
      ).length;
      const filterSummary = [];
      if (query && filteredRequests.length !== visibleTotal) {
        countEl.textContent = filteredRequests.length + ' / ' + visibleTotal;
        filterSummary.push(filteredRequests.length + ' shown');
      } else {
        countEl.textContent = filteredRequests.length;
      }
      const bodySearchIsIncomplete = query
        && parseFilters(query).some(filter => filter.type === 'body' || filter.type === 'text')
        && requests.some(request => request.requestBodyTruncated === true
          || request.responseBodyTruncated === true);
      if (bodySearchIsIncomplete) filterSummary.push('body search covers captured bytes only');
      if (footerFilter) {
        footerFilter.textContent = filterSummary.length > 0 ? `(${filterSummary.join('; ')})` : '';
      }
      if (countLabel) {
        countLabel.textContent = 'requests';
      }
      if (footerCount) footerCount.textContent = visibleTotal + ' requests';

      if (filteredRequests.length === 0) {
        tbody.innerHTML = '';
        vsRenderStart = -1;
        vsRenderEnd = -1;
        const query = document.getElementById('searchInput')?.value?.trim();
        if (query && requests.length > 0) {
          empty.innerHTML = '<div style="font-size:60px;opacity:0.15;margin-bottom:16px;">?</div><h3>No requests match this search filter</h3>';
        } else if (isPaused) {
          empty.innerHTML = '<div style="font-size:60px;opacity:0.15;margin-bottom:16px;">&#9208;</div><h3>Interception is paused, resume it to collect intercepted requests</h3>';
        } else {
          empty.innerHTML = '<div style="font-size:60px;opacity:0.15;margin-bottom:16px;">&#9783;</div><h3>Connect a client and intercept some requests, and they\'ll appear here</h3>';
        }
        empty.style.display = 'flex';
        updateTrafficActiveDescendant(null);
        return;
      }

      empty.style.display = 'none';

      // Force re-render since data changed (filter, sort, new data)
      vsForceRender = true;
      vsRenderStart = -1;
      vsRenderEnd = -1;

      // Auto-scroll to bottom before rendering so renderVirtualRows uses final scrollTop
      if (autoScroll) {
        const wrapper = document.getElementById('trafficTableWrapper');
        // Set scroll height based on total rows to position scrollbar correctly
        // We need to render first so the spacers create the correct content height
        // Temporarily set a large enough height so scrollTop can be set
        tbody.innerHTML = `<tr class="vs-spacer"><td colspan="6" style="height:${filteredRequests.length * VS_ROW_HEIGHT}px;padding:0;border:none;"></td></tr>`;
        wrapper.scrollTop = wrapper.scrollHeight;
      }

      renderVirtualRows();
    }

    function updateTrafficActiveDescendant(request) {
      const grid = document.getElementById('trafficGrid');
      if (!grid) return;
      const tbody = document.getElementById('trafficBody');
      const row = request ? document.getElementById(trafficRowDomId(request)) : null;
      const rowIsOwned = Boolean(row) && (!tbody?.contains || tbody.contains(row));
      if (rowIsOwned) {
        grid.setAttribute('aria-activedescendant', row.id);
      } else {
        grid.removeAttribute('aria-activedescendant');
      }
    }

    function selectRequest(id, toggle = true, trafficLifecycleId) {
      const req = findTrafficRequestByIdentity(requests, id, trafficLifecycleId);
      if (!req) return;
      if (isSelectedTrafficRequest(req) && toggle) {
        closeDetail();
        return;
      }
      selectedRequestId = id;
      selectedRequestLifecycleId = normalizeTrafficLifecycleId(req.trafficLifecycleId);
      if (window.location.hash.startsWith('#/view') || window.location.hash.startsWith('#/traffic')) {
        history.replaceState(null, '', buildTrafficViewHash(id, selectedRequestLifecycleId));
      }
      // Scroll selected row into view (center alignment)
      const idx = filteredRequests.findIndex(request => isSelectedTrafficRequest(request));
      if (idx !== -1) {
        scrollRowIntoView(idx, 'center');
      }

      // Re-render virtual rows to update selection highlight
      vsForceRender = true;
      renderVirtualRows();

      if (req._deferredTrafficDetail === true) {
        const panel = document.getElementById('detailPanel');
        const emptyEl = document.getElementById('detailEmptyState');
        const activeEl = document.getElementById('detailActive');
        if (panel) panel._request = null;
        if (emptyEl) emptyEl.style.display = 'flex';
        if (activeEl) activeEl.style.display = 'none';
        void hydrateDeferredTrafficRequest(req);
        return;
      }

      showDetail(req);
    }

    async function hydrateDeferredTrafficRequest(req) {
      try {
        const lifecycleId = normalizeTrafficLifecycleId(req.trafficLifecycleId);
        const lifecycleQuery = lifecycleId === null
          ? ''
          : '?trafficLifecycleId=' + encodeURIComponent(lifecycleId);
        const response = await fetch(
          API_BASE + '/api/traffic/' + encodeURIComponent(req.id) + lifecycleQuery
        );
        if (!response.ok) throw new Error('Could not load imported request details');
        const hydrated = await response.json();
        const requestIndex = requests.indexOf(req);
        if (requestIndex === -1) return;
        const wasSelected = isSelectedTrafficRequest(req);
        const mergedRequest = mergeDeferredTrafficRequest(req, hydrated);
        requests[requestIndex] = mergedRequest;
        if (wasSelected) {
          selectedRequestId = mergedRequest.id;
          selectedRequestLifecycleId = normalizeTrafficLifecycleId(
            mergedRequest.trafficLifecycleId
          );
        }
        applyFilter();
        if (wasSelected) showDetail(mergedRequest);
      } catch (error) {
        toast(error.message || 'Could not load imported request details', 'error');
        if (isSelectedTrafficRequest(req)) closeDetail();
      }
    }

    function selectBreakpointRequest(requestId, trafficLifecycleId, attempts = 0) {
      if (!requestId) return;
      const req = findTrafficRequestByIdentity(requests, requestId, trafficLifecycleId);
      if (req) {
        if (!isSelectedTrafficRequest(req)) {
          selectRequest(requestId, false, trafficLifecycleId);
        }
        return;
      }
      if (attempts < 5) {
        setTimeout(() => selectBreakpointRequest(
          requestId,
          trafficLifecycleId,
          attempts + 1
        ), 100);
      }
    }

    // ============ DETAIL PANEL ============
    function showDetail(req) {
      const panel = document.getElementById('detailPanel');
      panel._request = req;
      // Hide empty state, show active detail
      const emptyEl = document.getElementById('detailEmptyState');
      const activeEl = document.getElementById('detailActive');
      if (emptyEl) emptyEl.style.display = 'none';
      if (activeEl) activeEl.style.display = 'flex';
      if (req.protocol === 'ws-frame') {
        const dirLabel = req.direction === 'client' ? 'Client → Server' : 'Server → Client';
        document.getElementById('detailTitle').textContent = 'WS Frame: ' + (req.opcodeName || 'data') + ' (' + dirLabel + ')';
      } else if (req.protocol === 'tls-error') {
        document.getElementById('detailTitle').textContent = 'TLS Error: ' + (req.host || '-');
      } else if (req.protocol === 'tunnel') {
        document.getElementById('detailTitle').textContent = 'Tunnel: ' + (req.host || '-');
      } else {
        document.getElementById('detailTitle').textContent = req.method + ' ' + req.host + req.path;
      }
      updatePinIcon(!!req.pinned);
      renderDetailCards(req);
    }

    function closeDetail(renderSelection = true) {
      const panel = document.getElementById('detailPanel');
      const emptyEl = document.getElementById('detailEmptyState');
      const activeEl = document.getElementById('detailActive');
      if (panel) panel._request = null;
      if (emptyEl) emptyEl.style.display = 'flex';
      if (activeEl) activeEl.style.display = 'none';
      selectedRequestId = null;
      selectedRequestLifecycleId = null;
      updateTrafficActiveDescendant(null);
      // Re-render to remove selection highlight
      if (renderSelection) {
        vsForceRender = true;
        renderVirtualRows();
      }
      if (window.location.hash.startsWith('#/view/')) {
        history.replaceState(null, '', '#/view');
      }
    }

    // ============ DETAIL FOOTER ACTIONS ============
    function scrollToSelectedRequest() {
      if (!selectedRequestId) return;
      const idx = filteredRequests.findIndex(request => isSelectedTrafficRequest(request));
      if (idx === -1) return;
      scrollRowIntoView(idx, 'center');
    }

    // Scroll so that a given row index is visible in the traffic list
    function scrollRowIntoView(index, alignment) {
      const wrapper = document.getElementById('trafficTableWrapper');
      const rowTop = index * VS_ROW_HEIGHT;
      const rowBottom = rowTop + VS_ROW_HEIGHT;
      const viewTop = wrapper.scrollTop;
      const viewBottom = wrapper.scrollTop + wrapper.clientHeight - VS_HEADER_HEIGHT;

      if (alignment === 'center') {
        const viewHeight = wrapper.clientHeight - VS_HEADER_HEIGHT;
        wrapper.scrollTop = Math.max(0, rowTop - viewHeight / 2 + VS_ROW_HEIGHT / 2);
      } else if (rowTop < viewTop) {
        wrapper.scrollTop = rowTop;
      } else if (rowBottom > viewBottom) {
        wrapper.scrollTop = rowBottom - (wrapper.clientHeight - VS_HEADER_HEIGHT);
      }
    }

    function trafficActionRequest(requestId = selectedRequestId, trafficLifecycleId) {
      if (!requestId) return null;
      const resolvedLifecycleId = trafficLifecycleId === undefined && requestId === selectedRequestId
        ? selectedRequestLifecycleId
        : trafficLifecycleId;
      return findTrafficRequestByIdentity(requests, requestId, resolvedLifecycleId);
    }

    const trafficPinInFlight = new Set();

    async function togglePinRequest(requestId = selectedRequestId, trafficLifecycleId) {
      if (!requestId) return;
      const req = trafficActionRequest(requestId, trafficLifecycleId);
      if (!req) return;
      const identityKey = trafficRequestIdentityKey(req);
      if (trafficPinInFlight.has(identityKey)) return;
      const pinned = req.pinned !== true;
      trafficPinInFlight.add(identityKey);
      try {
        const lifecycleId = normalizeTrafficLifecycleId(req.trafficLifecycleId);
        const query = lifecycleId === null
          ? ''
          : '?trafficLifecycleId=' + encodeURIComponent(lifecycleId);
        const response = await fetch(
          API_BASE + '/api/traffic/' + encodeURIComponent(req.id) + '/pin' + query,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pinned })
          }
        );
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.success !== true || data.requestId !== req.id ||
            normalizeTrafficLifecycleId(data.trafficLifecycleId) !== lifecycleId ||
            data.pinned !== pinned || !Number.isSafeInteger(data.revision)) {
          throw new Error(data.error || `Pin exchange returned HTTP ${response.status}`);
        }
        applyTrafficPinned(
          data.requestId,
          data.trafficLifecycleId,
          data.pinned,
          data.revision
        );
        toast(pinned ? 'Exchange pinned' : 'Exchange unpinned', 'success');
      } catch (err) {
        toast('Failed to update pin: ' + err.message, 'error');
      } finally {
        trafficPinInFlight.delete(identityKey);
      }
    }

    function updatePinIcon(pinned) {
      const icon = document.getElementById('pinBtnIcon');
      if (icon) icon.style.transform = pinned ? 'none' : 'rotate(45deg)';
    }

    const trafficDeleteInFlight = new Set();

    async function deleteSelectedRequest(requestId = selectedRequestId, trafficLifecycleId) {
      if (!requestId) return;
      const req = trafficActionRequest(requestId, trafficLifecycleId);
      if (!req) return;
      if (req.pinned) { toast('Unpin this exchange before deleting', 'error'); return; }
      const identityKey = trafficRequestIdentityKey(req);
      if (trafficDeleteInFlight.has(identityKey)) return;
      if (!confirm('Are you sure you want to delete this request?')) return;

      trafficDeleteInFlight.add(identityKey);
      try {
        const lifecycleId = normalizeTrafficLifecycleId(req.trafficLifecycleId);
        const query = lifecycleId === null
          ? ''
          : '?trafficLifecycleId=' + encodeURIComponent(lifecycleId);
        const response = await fetch(
          API_BASE + '/api/traffic/' + encodeURIComponent(req.id) + query,
          { method: 'DELETE' }
        );
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.success !== true || data.requestId !== req.id) {
          throw new Error(data.error || `Delete exchange returned HTTP ${response.status}`);
        }
        applyTrafficDeleted(
          data.requestId,
          data.trafficLifecycleId,
          data.webSocketConnection === true
        );
        toast('Exchange deleted', 'success');
      } catch (err) {
        toast('Failed to delete exchange: ' + err.message, 'error');
      } finally {
        trafficDeleteInFlight.delete(identityKey);
      }
    }

    function resendSelectedRequest(requestId = selectedRequestId, trafficLifecycleId) {
      if (!requestId) return;
      const req = trafficActionRequest(requestId, trafficLifecycleId);
      if (!req) return;
      if (req.requestBodyTruncated === true) {
        toast('Cannot resend this request because its captured body is incomplete.', 'error');
        return;
      }

      // Save current tab state before creating a new one
      saveSendTabState();

      // Build headers list for the new tab
      const newHeaders = [];
      if (req.requestHeaders && Object.keys(req.requestHeaders).length > 0) {
        const skip = ['host', 'proxy-connection', 'content-length', 'connection', 'accept-encoding'];
        for (const [k, v] of Object.entries(req.requestHeaders)) {
          if (!skip.includes(k.toLowerCase())) {
            const values = Array.isArray(v) ? v : [v];
            values.forEach(value => newHeaders.push({ key: k, value: String(value), enabled: true }));
          }
        }
      }

      // Detect body format from content-type
      let bodyType = 'raw';
      let bodyFormat = 'text';
      let urlEncodedFields = [];
      if (req.requestBody) {
        const contentTypeKey = findHeaderKey(req.requestHeaders || {}, 'Content-Type');
        const ct = String(contentTypeKey ? req.requestHeaders[contentTypeKey] : '').toLowerCase();
        if (ct.includes('application/x-www-form-urlencoded')) {
          bodyType = 'urlencoded';
          urlEncodedFields = Array.from(new URLSearchParams(req.requestBody), ([key, value]) => ({ key, value, enabled: true }));
        } else if (ct.includes('json')) bodyFormat = 'json';
        else if (ct.includes('xml')) bodyFormat = 'xml';
        else if (ct.includes('html')) bodyFormat = 'html';
        else if (ct.includes('css')) bodyFormat = 'css';
        else if (ct.includes('javascript')) bodyFormat = 'javascript';
        else if (ct.includes('markdown') || ct.includes('/x-markdown')) bodyFormat = 'markdown';
        else if (ct.includes('yaml') || ct.includes('yml')) bodyFormat = 'yaml';
      }

      // Create a new send tab with the request data
      const newTab = {
        id: allocateSendTabId(),
        method: req.method,
        url: req.url,
        headers: newHeaders,
        body: req.requestBody || '',
        bodyType,
        bodyFormat: bodyFormat,
        urlEncodedFields,
        multipartFields: [],
        multipartBoundary: '',
        response: null
      };
      sendTabs.push(newTab);
      activeSendTab = newTab.id;
      if (typeof safeLocalStorageSet === 'function') {
        safeLocalStorageSet('http-freekit-send-active', activeSendTab);
      }
      if (typeof persistSendTabs === 'function') persistSendTabs([newTab]);

      // Switch to Send panel and load the new tab
      const sendPanelBtn = document.querySelector('.sidebar-item[data-panel="send"]');
      if (sendPanelBtn) switchPanel(sendPanelBtn, 'send');

      loadSendTabState(newTab);
      renderSendTabs();
      toast('Request loaded in new Send tab', 'success');
    }

    // Track collapsed state per card so chevron icon updates
    const _cardCollapsed = {};

    function toggleCardCollapse(cardOrId) {
      const el = typeof cardOrId === 'string' ? document.getElementById(cardOrId) : cardOrId;
      if (!el) return;
      const isCollapsed = el.classList.toggle('collapsed');
      if (el.id) _cardCollapsed[el.id] = isCollapsed;
      el.setAttribute('aria-expanded', String(!isCollapsed));
      const chevron = el.querySelector('.collapse-chevron');
      if (chevron) chevron.innerHTML = isCollapsed ? '&#9660;' : '&#9650;';
    }

    // Delegate clicks on the full header bar, excluding controls within it
    document.addEventListener('click', function(e) {
      const header = e.target.closest('.detail-card-header');
      if (!header || e.target.closest('button, select, input, textarea, a')) return;
      const card = header.closest('.detail-card');
      if (!card) return;
      toggleCardCollapse(card);
    });

    // Track collapsed state for individual headers
    const HEADER_DOCS = {
      'accept': 'Specifies the media types the client can handle. The server uses this to pick the best response format.',
      'accept-charset': 'Indicates which character encodings the client understands.',
      'accept-encoding': 'Lists the content encodings (like gzip, br, deflate) the client supports. Servers use this to compress responses.',
      'accept-language': 'Indicates the preferred languages for the response, used for content negotiation.',
      'accept-ranges': 'Indicates that the server supports range requests for the resource.',
      'access-control-allow-credentials': 'Tells the browser whether to expose the response to frontend JavaScript when credentials are included.',
      'access-control-allow-headers': 'Specifies which HTTP headers can be used in the actual CORS request.',
      'access-control-allow-methods': 'Specifies the HTTP methods allowed when accessing the resource in a CORS request.',
      'access-control-allow-origin': 'Indicates whether the response can be shared with requesting code from the given origin.',
      'access-control-expose-headers': 'Indicates which headers can be exposed as part of the response by listing their names.',
      'access-control-max-age': 'Indicates how long the results of a preflight CORS request can be cached.',
      'access-control-request-headers': 'Used in preflight requests to indicate which HTTP headers will be used in the actual request.',
      'access-control-request-method': 'Used in preflight requests to indicate which HTTP method will be used in the actual request.',
      'age': 'The time in seconds the object has been in a proxy cache.',
      'alt-svc': 'Advertises alternative services through which the same resource can be reached.',
      'authorization': 'Contains credentials for authenticating the client with the server (e.g., Basic, Bearer token).',
      'cache-control': 'Directives for caching mechanisms in both requests and responses (e.g., no-cache, max-age, public, private).',
      'cdn-cache-control': 'Cache directives specifically for CDN/intermediary caches, separate from browser cache directives.',
      'connection': 'Controls whether the network connection stays open after the current transaction finishes.',
      'content-disposition': 'Indicates if the content should be displayed inline or downloaded as an attachment with a filename.',
      'content-encoding': 'Specifies the encoding (compression) applied to the response body (e.g., gzip, br, deflate).',
      'content-language': 'Describes the language(s) intended for the audience of the response.',
      'content-length': 'The size of the response body in bytes.',
      'content-security-policy': 'Controls which resources the browser is allowed to load, helping prevent XSS and injection attacks.',
      'content-type': 'Indicates the media type of the resource (e.g., text/html, application/json, image/png).',
      'cookie': 'Contains stored HTTP cookies previously sent by the server with Set-Cookie.',
      'date': 'The date and time at which the message was sent.',
      'dnt': 'Indicates the user\'s tracking preference (Do Not Track). 1 = opt out, 0 = opt in.',
      'etag': 'A unique identifier for a specific version of a resource, used for cache validation.',
      'expect': 'Indicates expectations that need to be fulfilled by the server to handle the request.',
      'expires': 'The date/time after which the response is considered stale. Superseded by Cache-Control max-age.',
      'forwarded': 'Contains information from the client-facing side of proxy servers (standardized version of X-Forwarded-*).',
      'from': 'The email address of the human user who controls the requesting user agent.',
      'host': 'Specifies the domain name and port number of the server being requested. Required in HTTP/1.1.',
      'if-match': 'Makes the request conditional \u2014 only proceed if the resource matches the given ETag.',
      'if-modified-since': 'Makes the request conditional \u2014 only return the resource if it was modified after the given date.',
      'if-none-match': 'Makes the request conditional \u2014 only return the resource if no ETag matches (used for cache revalidation).',
      'if-unmodified-since': 'Makes the request conditional \u2014 only proceed if the resource has not been modified since the given date.',
      'keep-alive': 'Allows the sender to hint about how the connection may be used (timeout, max requests).',
      'last-modified': 'The date and time at which the resource was last modified.',
      'link': 'Provides relationships between the current document and external resources (preload, prefetch, etc.).',
      'location': 'Used in redirects (3xx) to indicate the URL to redirect to. Also used in 201 Created responses.',
      'origin': 'Indicates the origin (scheme, host, port) that caused the request, used in CORS.',
      'pragma': 'Legacy HTTP/1.0 header. pragma: no-cache behaves like cache-control: no-cache.',
      'proxy-authenticate': 'Defines the authentication method that should be used to access a resource behind a proxy.',
      'proxy-authorization': 'Contains credentials for authenticating with a proxy server.',
      'range': 'Requests only part of a resource (byte range), used for resumable downloads.',
      'referer': 'The URL of the page that linked to the requested resource. Note: intentional misspelling in the spec.',
      'referrer-policy': 'Controls how much referrer information is sent with requests.',
      'retry-after': 'Indicates how long to wait before making a follow-up request (after 503 or 429 responses).',
      'sec-ch-ua': 'Client hint providing the browser\'s brand and version information.',
      'sec-ch-ua-mobile': 'Client hint indicating whether the browser is on a mobile device.',
      'sec-ch-ua-platform': 'Client hint indicating the platform/OS the browser is running on.',
      'sec-fetch-dest': 'Indicates the request\'s destination (document, image, script, etc.).',
      'sec-fetch-mode': 'Indicates the request\'s mode (cors, navigate, no-cors, same-origin).',
      'sec-fetch-site': 'Indicates the relationship between the request origin and target (same-origin, cross-site, etc.).',
      'sec-fetch-user': 'Indicates whether the request was triggered by user activation (e.g., clicking a link).',
      'server': 'Contains information about the software used by the origin server to handle the request.',
      'set-cookie': 'Sends a cookie from the server to the client. The browser stores it and sends it back in future Cookie headers.',
      'strict-transport-security': 'Tells the browser to only access the site using HTTPS (HSTS). Prevents protocol downgrade attacks.',
      'te': 'Specifies the transfer codings the client is willing to accept (e.g., trailers, chunked).',
      'timing-allow-origin': 'Specifies origins that are allowed to see resource timing information.',
      'trailer': 'Indicates that the given set of header fields will be present in the trailer of a chunked transfer.',
      'transfer-encoding': 'Specifies the encoding used to transfer the body (e.g., chunked). Different from content-encoding.',
      'upgrade': 'Used to upgrade a connection to a different protocol (e.g., HTTP/1.1 to WebSocket).',
      'upgrade-insecure-requests': 'Tells the server the client prefers an encrypted and authenticated response (upgrade HTTP to HTTPS).',
      'user-agent': 'Identifies the client software (browser, bot, library) making the request.',
      'vary': 'Determines how to match future request headers to decide whether a cached response can be used.',
      'via': 'Added by proxies (both forward and reverse) to track message forwarding path.',
      'www-authenticate': 'Defines the authentication method that should be used to access the requested resource (401 response).',
      'x-content-type-options': 'Prevents the browser from MIME-sniffing the content type. Usually set to "nosniff".',
      'x-forwarded-for': 'Identifies the originating IP address of a client connecting through a proxy or load balancer.',
      'x-forwarded-host': 'Identifies the original host requested by the client in the Host header.',
      'x-forwarded-proto': 'Identifies the protocol (HTTP or HTTPS) that the client used to connect.',
      'x-frame-options': 'Indicates whether a browser should be allowed to render a page in a frame/iframe (clickjacking prevention).',
      'x-powered-by': 'Specifies the technology/framework powering the web application (e.g., Express, PHP, ASP.NET).',
      'x-request-id': 'A unique identifier for the request, used for tracing and debugging across services.',
      'x-xss-protection': 'Legacy header that enabled the browser\'s built-in XSS filter. Mostly superseded by CSP.',
    };

    const _headerCollapsed = {};

    function toggleHeaderRow(headerId) {
      // _headerCollapsed starts undefined (falsy) = collapsed. Toggle to open.
      const wasOpen = !!_headerCollapsed[headerId];
      _headerCollapsed[headerId] = !wasOpen;
      const descEl = document.getElementById(headerId + '-desc');
      const iconEl = document.getElementById(headerId + '-icon');
      if (descEl) descEl.style.display = _headerCollapsed[headerId] ? 'block' : 'none';
      if (iconEl) iconEl.textContent = _headerCollapsed[headerId] ? '\u2212' : '+';
    }

    // Track collapsed state for URL breakdown
    let _urlBreakdownOpen = false;

    // Track transform perspective for requests modified by mock rules
    let _transformPerspective = 'transformed';

    function switchTransformPerspective(value) {
      _transformPerspective = value;
      const panel = document.getElementById('detailPanel');
      if (panel && panel._request) {
        renderDetailCards(panel._request);
      }
    }

    // Returns the effective request data based on current transform perspective
    function getEffectiveRequest(req) {
      if (!req.originalRequest) return req;
      const showOriginal = _transformPerspective === 'original' || _transformPerspective === 'client';
      if (!showOriginal) return req;
      // Build a view object with original data overlaid
      const orig = req.originalRequest;
      let origHost = req.host;
      let origPath = req.path;
      try {
        const u = new URL(orig.url);
        origHost = u.hostname;
        origPath = u.pathname + u.search;
      } catch { /* keep defaults */ }
      return {
        ...req,
        method: orig.method,
        url: orig.url,
        host: origHost,
        path: origPath,
        requestHeaders: orig.headers,
        requestBody: orig.body != null ? orig.body : req.requestBody
      };
    }

    function toggleUrlBreakdown() {
      _urlBreakdownOpen = !_urlBreakdownOpen;
      const el = document.getElementById('url-breakdown');
      const icon = document.getElementById('url-breakdown-icon');
      if (el) el.style.display = _urlBreakdownOpen ? 'grid' : 'none';
      if (icon) icon.textContent = _urlBreakdownOpen ? '\u2212' : '+';
    }

    function renderDetailCards(req) {
      function renderBodyCaptureWarning(request, side) {
        const field = side + 'Body';
        if (request?.[field + 'Truncated'] !== true) return '';
        const capturedSize = Number.isFinite(request[field + 'CapturedSize'])
          ? request[field + 'CapturedSize']
          : 0;
        const decodedSize = request[field + 'DecodedSize'];
        const originalSize = decodedSize === -1
          ? -1
          : Number.isFinite(decodedSize) && decodedSize >= 0
            ? decodedSize
            : request[field + 'Size'];
        const displaySize = size => size === 0 ? '0B' : formatSize(size);
        const retained = Number.isFinite(originalSize) && originalSize >= 0
          ? `${displaySize(capturedSize)} of ${displaySize(originalSize)}`
          : `${displaySize(capturedSize)}; original size unknown`;
        return `<div class="body-capture-warning" role="note">
          <i class="ph ph-warning" aria-hidden="true"></i>
          <span>Incomplete ${side} body: ${retained} retained. Viewing and body search use only these captured bytes.</span>
        </div>`;
      }

      const content = document.getElementById('detailContent');
      const methodColor = {GET:'#4caf7d',POST:'#ff8c38',DELETE:'#ce3939',PUT:'#6e40aa',PATCH:'#dd3a96',HEAD:'#5a80cc',OPTIONS:'#2fb4e0'}[req.method] || '#888';
      const statusBreakpoint = req.breakpointActive === true;
      const statusPending = req.statusCode === null || req.statusCode === undefined;
      const statusColor = statusBreakpoint ? '#f1971f' : statusPending ? '#888' :
        req.error || req.statusCode === 0 ? '#ce3939' :
        req.statusCode < 200 ? '#888' :
        req.statusCode < 300 ? '#4caf7d' :
        req.statusCode < 400 ? '#5a80cc' :
        req.statusCode < 500 ? '#ff8c38' : '#ce3939';
      const remoteEndpoint = formatRemoteEndpoint(req.remote?.address, req.remote?.port);

      // Reset collapse state for new request
      _urlBreakdownOpen = false;
      // Reset transform perspective only when viewing a new request (not when switching perspective)
      if (!req.originalRequest) _transformPerspective = 'transformed';

      // Dispose any active body Monaco editors before replacing content
      disposeBodyEditor('reqBody-monaco');
      disposeBodyEditor('resBody-monaco');
      disposeBodyEditor('wsFramePayload-monaco');

      // Store headers for context menu lookup
      window._detailHeaders = { request: req.requestHeaders || {}, response: req.responseHeaders || {} };

      let html = '';

      // ---- Breakpoint Card (if paused) ----
      if (req.breakpointActive === true) {
        const draft = getBreakpointEditDraft(req);
        const responsePhase = draft._phase === 'response';
        const breakpointIdentityAttrs = `data-request-id="${escapeHtmlAttribute(req.id)}" data-lifecycle-id="${escapeHtmlAttribute(req.trafficLifecycleId || '')}"`;
        const breakpointFields = responsePhase ? `
              <div class="breakpoint-edit-row">
                <span class="breakpoint-edit-label">Status</span>
                <span id="breakpoint-edit-status" ${breakpointIdentityAttrs} class="breakpoint-edit-value" role="button" tabindex="0" aria-label="Edit response status" aria-describedby="breakpoint-edit-instructions" ondblclick="editBreakpointField(this.dataset.requestId, this.dataset.lifecycleId, 'status')" onkeydown="activateBreakpointFieldOnKeyboard(event, this.dataset.requestId, this.dataset.lifecycleId, 'status')">${draft.status}</span>
              </div>
              <div class="breakpoint-edit-row">
                <span class="breakpoint-edit-label">Headers</span>
                <pre id="breakpoint-edit-headers" ${breakpointIdentityAttrs} class="breakpoint-edit-value breakpoint-edit-pre" role="button" tabindex="0" aria-label="Edit response headers" aria-describedby="breakpoint-edit-instructions" ondblclick="editBreakpointField(this.dataset.requestId, this.dataset.lifecycleId, 'headers')" onkeydown="activateBreakpointFieldOnKeyboard(event, this.dataset.requestId, this.dataset.lifecycleId, 'headers')">${esc(JSON.stringify(draft.headers, null, 2))}</pre>
              </div>
              <div class="breakpoint-edit-row">
                <span class="breakpoint-edit-label">Body</span>
                <pre id="breakpoint-edit-body" ${breakpointIdentityAttrs} class="breakpoint-edit-value breakpoint-edit-pre" role="button" tabindex="0" aria-label="Edit response body" aria-describedby="breakpoint-edit-instructions" ondblclick="editBreakpointField(this.dataset.requestId, this.dataset.lifecycleId, 'body')" onkeydown="activateBreakpointFieldOnKeyboard(event, this.dataset.requestId, this.dataset.lifecycleId, 'body')">${esc(draft.body || '')}</pre>
              </div>` : `
              <div class="breakpoint-edit-row">
                <span class="breakpoint-edit-label">Method</span>
                <span id="breakpoint-edit-method" ${breakpointIdentityAttrs} class="breakpoint-edit-value" role="button" tabindex="0" aria-label="Edit request method" aria-describedby="breakpoint-edit-instructions" ondblclick="editBreakpointField(this.dataset.requestId, this.dataset.lifecycleId, 'method')" onkeydown="activateBreakpointFieldOnKeyboard(event, this.dataset.requestId, this.dataset.lifecycleId, 'method')">${esc(draft.method)}</span>
              </div>
              <div class="breakpoint-edit-row">
                <span class="breakpoint-edit-label">URL</span>
                <span id="breakpoint-edit-url" ${breakpointIdentityAttrs} class="breakpoint-edit-value" role="button" tabindex="0" aria-label="Edit request URL" aria-describedby="breakpoint-edit-instructions" ondblclick="editBreakpointField(this.dataset.requestId, this.dataset.lifecycleId, 'url')" onkeydown="activateBreakpointFieldOnKeyboard(event, this.dataset.requestId, this.dataset.lifecycleId, 'url')">${esc(draft.url)}</span>
              </div>
              <div class="breakpoint-edit-row">
                <span class="breakpoint-edit-label">Headers</span>
                <pre id="breakpoint-edit-headers" ${breakpointIdentityAttrs} class="breakpoint-edit-value breakpoint-edit-pre" role="button" tabindex="0" aria-label="Edit request headers" aria-describedby="breakpoint-edit-instructions" ondblclick="editBreakpointField(this.dataset.requestId, this.dataset.lifecycleId, 'headers')" onkeydown="activateBreakpointFieldOnKeyboard(event, this.dataset.requestId, this.dataset.lifecycleId, 'headers')">${esc(JSON.stringify(draft.headers, null, 2))}</pre>
              </div>
              <div class="breakpoint-edit-row">
                <span class="breakpoint-edit-label">Body</span>
                <pre id="breakpoint-edit-body" ${breakpointIdentityAttrs} class="breakpoint-edit-value breakpoint-edit-pre" role="button" tabindex="0" aria-label="Edit request body" aria-describedby="breakpoint-edit-instructions" ondblclick="editBreakpointField(this.dataset.requestId, this.dataset.lifecycleId, 'body')" onkeydown="activateBreakpointFieldOnKeyboard(event, this.dataset.requestId, this.dataset.lifecycleId, 'body')">${esc(draft.body || '')}</pre>
              </div>`;
        html += `<div class="detail-card" style="border-left:4px solid #f1971f;background:#f1971f11;">
          <div class="detail-card-body" style="padding:16px 20px;">
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
              <span style="font-size:20px;">&#9208;</span>
              <div style="flex:1;">
                <div style="font-weight:bold;color:#f1971f;margin-bottom:4px;">${responsePhase ? 'Response' : 'Request'} Paused at Breakpoint</div>
                <div id="breakpoint-edit-instructions" style="font-size:12px;color:var(--text-lowlight);">Double-click a field, or focus it and press Enter or Space, to edit before resuming.</div>
              </div>
              <button class="btn btn-primary" data-request-id="${escapeHtmlAttribute(req.id)}" data-lifecycle-id="${escapeHtmlAttribute(req.trafficLifecycleId || '')}" onclick="resumeBreakpointRequest(this.dataset.requestId, this.dataset.lifecycleId)" style="padding:8px 20px;">
                Resume
              </button>
            </div>
            <div class="breakpoint-edit-grid">
              ${breakpointFields}
            </div>
          </div>
        </div>`;
      }

      // ---- WebSocket Frame Detail ----
      if (req.protocol === 'ws-frame') {
        const dirLabel = req.direction === 'client' ? 'Client → Server' : 'Server → Client';
        const dirColor = req.direction === 'client' ? '#ff8c38' : '#4caf7d';
        const opName = esc(req.opcodeName || 'data');
        const isTextFrame = req.opcode === 1; // TEXT opcode
        const isBinaryFrame = req.opcode === 2; // BINARY opcode
        const isCloseFrame = req.opcode === 8; // CLOSE opcode

        html += `<div class="detail-card dir-right" style="border-right-color:${dirColor};">
          <div class="detail-card-header">
            <span style="margin-left:auto;display:flex;align-items:center;gap:8px;">
              <span class="detail-pill" style="background:${dirColor};color:#fff;">${dirLabel}</span>
              <span class="detail-pill pill-muted">${opName}</span>
              <span class="detail-card-heading">WebSocket Frame</span>
              <span class="collapse-chevron">&#9650;</span>
            </span>
          </div>
          <div class="detail-card-body">
            <div class="detail-summary">
              <div class="detail-summary-item"><div class="detail-summary-label">Direction</div><div class="detail-summary-value">${dirLabel}</div></div>
              <div class="detail-summary-item"><div class="detail-summary-label">Opcode</div><div class="detail-summary-value">${opName} (0x${(req.opcode || 0).toString(16)})</div></div>
              <div class="detail-summary-item"><div class="detail-summary-label">Size</div><div class="detail-summary-value">${formatSize(req.requestBodySize)}</div></div>
              <div class="detail-summary-item"><div class="detail-summary-label">FIN</div><div class="detail-summary-value">${req.fin ? 'Yes' : 'No'}</div></div>
              <div class="detail-summary-item"><div class="detail-summary-label">Masked</div><div class="detail-summary-value">${req.masked ? 'Yes' : 'No'}</div></div>
              <div class="detail-summary-item"><div class="detail-summary-label">Time</div><div class="detail-summary-value" style="font-size:11px;">${new Date(req.timestamp).toLocaleTimeString()}</div></div>
            </div>
          </div>
        </div>`;

        // Close frame: show code and reason
        if (isCloseFrame && req.requestBody) {
          const closeMatch = req.requestBody.match(/^Close code: (\d+)(?:\s*-\s*(.*))?$/);
          const closeCode = closeMatch ? closeMatch[1] : '';
          const closeReason = closeMatch ? (closeMatch[2] || '') : req.requestBody;
          html += `<div class="detail-card dir-left" style="border-left-color:#ce3939;">
            <div class="detail-card-header">
              <span style="margin-left:auto;display:flex;align-items:center;gap:8px;">
                <span class="detail-pill" style="background:#ce3939;color:#fff;">Close</span>
                <span class="detail-card-heading">Close Frame</span>
                <span class="collapse-chevron">&#9650;</span>
              </span>
            </div>
            <div class="detail-card-body">
              <div class="detail-summary">
                ${closeCode ? '<div class="detail-summary-item"><div class="detail-summary-label">Close Code</div><div class="detail-summary-value">' + esc(closeCode) + '</div></div>' : ''}
                ${closeReason ? '<div class="detail-summary-item"><div class="detail-summary-label">Reason</div><div class="detail-summary-value">' + esc(closeReason) + '</div></div>' : ''}
              </div>
            </div>
          </div>`;
        }

        // Payload card — text frames in Monaco, binary in hex
        if (req.requestBody && req.requestBody.length > 0 && !isCloseFrame) {
          if (isTextFrame) {
            html += `<div class="detail-card dir-left" style="border-left-color:${dirColor};">
              <div class="detail-card-header">
                <span style="margin-left:auto;display:flex;align-items:center;gap:8px;">
                  <span class="detail-pill pill-muted">${formatSize(req.requestBodySize)}</span>
                  <span class="detail-card-heading">Payload</span>
                  <span class="collapse-chevron">&#9650;</span>
                </span>
              </div>
              <div class="detail-card-body">
                <div id="wsFramePayload" data-view-mode="text">
                  <div id="wsFramePayload-monaco" style="display:none;min-height:80px;"></div>
                  <pre class="body-content" id="wsFramePayload-fallback" style="display:block;">${formatBodyAs(req.requestBody, 'text/plain', 'text')}</pre>
                </div>
              </div>
            </div>`;
          } else if (isBinaryFrame) {
            // Binary: show as hex dump
            const hexBody = req.requestBody;
            const hexFormatted = hexBody.replace(/(.{2})/g, '$1 ').replace(/(.{48})/g, '$1\n').trim();
            html += `<div class="detail-card dir-left" style="border-left-color:${dirColor};">
              <div class="detail-card-header">
                <span style="margin-left:auto;display:flex;align-items:center;gap:8px;">
                  <span class="detail-pill pill-muted">${formatSize(req.requestBodySize)}</span>
                  <span class="detail-card-heading">Payload (Binary)</span>
                  <span class="collapse-chevron">&#9650;</span>
                </span>
              </div>
              <div class="detail-card-body">
                <pre class="body-content" style="font-size:12px;">${esc(hexFormatted)}</pre>
              </div>
            </div>`;
          } else {
            // Ping/pong: show as text
            html += `<div class="detail-card dir-left" style="border-left-color:${dirColor};">
              <div class="detail-card-header">
                <span style="margin-left:auto;display:flex;align-items:center;gap:8px;">
                  <span class="detail-pill pill-muted">${formatSize(req.requestBodySize)}</span>
                  <span class="detail-card-heading">Payload</span>
                  <span class="collapse-chevron">&#9650;</span>
                </span>
              </div>
              <div class="detail-card-body">
                <pre class="body-content">${esc(req.requestBody)}</pre>
              </div>
            </div>`;
          }
        }

        content.innerHTML = html;

        // Initialize Monaco for text frame payload
        if (isTextFrame && req.requestBody && req.requestBody.length > 0) {
          // Detect language from content (try JSON first)
          let lang = 'plaintext';
          try { JSON.parse(req.requestBody); lang = 'json'; } catch (e) { /* expected for non-JSON */ }
          renderBodyViewer('wsFramePayload', req.requestBody, 'text/plain', lang === 'json' ? 'json' : 'text');
        }
        return;
      }

      // ---- WebSocket Card ----
      if (isConnectedWebSocket(req)) {
        const wsSourceLabel = req.source || 'Unknown';
        const wsSourceIconHtml = SOURCE_ICONS[wsSourceLabel] || SOURCE_ICONS['Other'] || '';
        const wsProtocolLabel = req.protocol === 'wss' ? 'WSS' : 'WS';
        const wsConnectionLabel = req.protocol === 'wss'
          ? `WSS (${esc(req.tls?.version || 'TLS')})`
          : 'WS (unencrypted)';
        html += `<div class="detail-card dir-right" style="border-right-color:#4caf7d;">
          <div class="detail-card-header">
            <span style="margin-left:auto;display:flex;align-items:center;gap:8px;">
              <span class="source-icon" title="${esc(wsSourceLabel)}" style="display:inline-flex;opacity:0.7;">${wsSourceIconHtml}</span>
              <span class="detail-pill" style="background:#4caf7d;color:#fff;">${wsProtocolLabel}</span>
              <span class="detail-card-heading">WebSocket</span>
              <span class="collapse-chevron">&#9650;</span>
            </span>
          </div>
          <div class="detail-card-body">
            <div class="detail-card-section">
              <div class="section-label">URL</div>
              <div style="font-family:var(--font-mono);font-size:13px;word-break:break-all;">${esc(req.url)}</div>
            </div>
            <div class="detail-card-section">
              <div class="section-label">Host</div>
              <div style="font-family:var(--font-mono);font-size:13px;">${esc(req.host || '-')}</div>
            </div>
            <div class="detail-card-section">
              <div class="section-label">Headers</div>
              ${renderHeadersGrid(req.requestHeaders, 'request')}
            </div>
          </div>
        </div>`;

        html += `<div class="detail-card dir-left" style="border-left-color:#4caf7d;">
          <div class="detail-card-header">
            <span style="margin-left:auto;display:flex;align-items:center;gap:8px;">
              <span class="detail-pill" style="background:#4caf7d;color:#fff;">${req.statusCode || 101}</span>
              <span class="detail-card-heading">Messages</span>
              <span class="collapse-chevron">&#9650;</span>
            </span>
          </div>
          <div class="detail-card-body">
            <div class="detail-summary">
              <div class="detail-summary-item"><div class="detail-summary-label">Client Sent</div><div class="detail-summary-value">${esc(req.requestBody || '0')}</div></div>
              <div class="detail-summary-item"><div class="detail-summary-label">Server Received</div><div class="detail-summary-value">${esc(req.responseBody || '0')}</div></div>
              <div class="detail-summary-item"><div class="detail-summary-label">Client Bytes</div><div class="detail-summary-value">${formatSize(req.requestBodySize)}</div></div>
              <div class="detail-summary-item"><div class="detail-summary-label">Server Bytes</div><div class="detail-summary-value">${formatSize(req.responseBodySize)}</div></div>
              <div class="detail-summary-item"><div class="detail-summary-label">Duration</div><div class="detail-summary-value">${req.duration != null ? Math.round(req.duration) + 'ms' : '-'}</div></div>
              <div class="detail-summary-item"><div class="detail-summary-label">Time</div><div class="detail-summary-value" style="font-size:11px;">${new Date(req.timestamp).toLocaleTimeString()}</div></div>
            </div>
            ${req.responseHeaders && Object.keys(req.responseHeaders).length > 0 ? '<div class="detail-card-section" style="margin-top:12px;"><div class="section-label">Upgrade Response Headers</div>' + renderHeadersGrid(req.responseHeaders, 'response') + '</div>' : ''}
            <div style="margin-top:12px;font-size:12px;color:var(--text-lowlight);">Protocol: ${wsConnectionLabel}</div>
            ${req.protocol === 'wss' && req.tls?.cipher ? '<div style="margin-top:4px;font-size:12px;color:var(--text-lowlight);">Cipher: ' + esc(req.tls.cipher) + '</div>' : ''}
            ${remoteEndpoint ? '<div style="margin-top:4px;font-size:12px;color:var(--text-lowlight);">Remote: ' + remoteEndpoint + '</div>' : ''}
          </div>
        </div>`;

        // ---- Stream Message List Card ----
        const frames = wsFramesByParent[wsConnectionKey(req)] || [];
        if (frames.length > 0) {
          html += `<div class="detail-card dir-left" style="border-left-color:#4caf7d;">
            <div class="detail-card-header">
              <span style="margin-left:auto;display:flex;align-items:center;gap:8px;">
                <span class="detail-pill pill-muted">${frames.length} frames</span>
                <span class="detail-card-heading">Stream Messages</span>
                <span class="collapse-chevron">&#9650;</span>
              </span>
            </div>
            <div class="detail-card-body" style="padding:0;">
              <div class="ws-stream-list">
                ${frames.map((f, i) => {
                  const dirArrow = f.direction === 'client' ? '→' : '←';
                  const dirCls = f.direction === 'client' ? 'ws-msg-client' : 'ws-msg-server';
                  const opLabel = esc(f.opcodeName || 'data');
                  const preview = esc((f.requestBody || '').substring(0, 120));
                  const byteStr = formatSize(f.requestBodySize);
                  const timeStr = new Date(f.timestamp).toLocaleTimeString();
                  const isClose = f.opcode === 8;
                  return `<div class="ws-msg-row ${dirCls}${isClose ? ' ws-msg-close' : ''}" ${trafficRowIdentityAttributes(f)} onclick="selectRequest(this.dataset.id, true, this.dataset.lifecycleId)" title="Click to view details">
                    <span class="ws-msg-index">#${i + 1}</span>
                    <span class="ws-msg-dir">${dirArrow}</span>
                    <span class="ws-msg-opcode">${opLabel}</span>
                    <span class="ws-msg-preview">${preview || '<em>empty</em>'}</span>
                    <span class="ws-msg-size">${byteStr}</span>
                    <span class="ws-msg-time">${timeStr}</span>
                  </div>`;
                }).join('')}
              </div>
            </div>
          </div>`;
        }

        content.innerHTML = html;
        return;
      }

      // ---- TLS Error Card ----
      if (req.protocol === 'tls-error') {
        html += `<div class="detail-card" style="border-left:4px solid #ce3939;background:#ce393911;">
          <div class="detail-card-body" style="padding:16px 20px;">
            <div style="display:flex;align-items:center;gap:12px;">
              <span style="font-size:20px;color:#ce3939;">${SOURCE_ICONS['tls-error']}</span>
              <div style="flex:1;">
                <div style="font-weight:bold;color:#ce3939;margin-bottom:4px;">TLS Handshake Failed</div>
                <div style="font-size:13px;color:var(--text-main);margin-bottom:4px;">${esc(req.host || '-')}</div>
                <div style="font-size:12px;color:var(--text-lowlight);">${esc(req.error || req.responseBody || 'Unknown TLS error')}</div>
              </div>
            </div>
          </div>
        </div>`;

        const errorCodeRow = req.errorCode
          ? `<div class="detail-summary-item"><div class="detail-summary-label">Error Code</div><div class="detail-summary-value" style="font-family:monospace;font-size:12px;color:#ce3939;">${esc(req.errorCode)}</div></div>`
          : '';

        html += `<div class="detail-card dir-right" style="border-right-color:#ce3939;">
          <div class="detail-card-header">
            <span style="margin-left:auto;display:flex;align-items:center;gap:8px;">
              <span class="detail-pill" style="background:#ce3939;color:#fff;">TLS Error</span>
              <span class="detail-card-heading">Details</span>
              <span class="collapse-chevron">&#9650;</span>
            </span>
          </div>
          <div class="detail-card-body">
            <div class="detail-summary">
              <div class="detail-summary-item"><div class="detail-summary-label">Hostname</div><div class="detail-summary-value">${esc(req.host || '-')}</div></div>
              <div class="detail-summary-item"><div class="detail-summary-label">Error</div><div class="detail-summary-value" style="font-size:11px;word-break:break-all;color:#ce3939;">${esc(req.error || req.responseBody || 'Unknown TLS error')}</div></div>
              ${errorCodeRow}
              <div class="detail-summary-item"><div class="detail-summary-label">URL</div><div class="detail-summary-value" style="font-size:11px;word-break:break-all;">${esc(req.url)}</div></div>
              <div class="detail-summary-item"><div class="detail-summary-label">Timestamp</div><div class="detail-summary-value" style="font-size:11px;">${new Date(req.timestamp).toLocaleString()}</div></div>
            </div>
          </div>
        </div>`;

        content.innerHTML = html;
        return;
      }

      // ---- Tunnel Card ----
      if (req.protocol === 'tunnel') {
        const bytesSent = formatSize(req.requestBodySize || 0);
        const bytesRecv = formatSize(req.responseBodySize || 0);
        const durationStr = req.duration >= 1000
          ? (req.duration / 1000).toFixed(1) + 's'
          : req.duration + 'ms';
        const portStr = req.remote?.port === null || req.remote?.port === undefined
          ? 443
          : req.remote.port;
        const tunnelEndpoint = formatRemoteEndpoint(
          req.remote?.address || req.host || '-',
          portStr
        );

        html += `<div class="detail-card" style="border-left:4px solid #888;background:rgba(136,136,136,0.07);">
          <div class="detail-card-body" style="padding:16px 20px;">
            <div style="display:flex;align-items:center;gap:12px;">
              <span style="font-size:20px;color:#888;">${SOURCE_ICONS.tunnel}</span>
              <div style="flex:1;">
                <div style="font-weight:bold;color:var(--text-main);margin-bottom:4px;">Raw Tunnel</div>
                <div style="font-size:13px;color:var(--text-main);margin-bottom:4px;">${tunnelEndpoint}</div>
                <div style="font-size:12px;color:var(--text-lowlight);">CONNECT tunnel — ${bytesSent} sent, ${bytesRecv} received</div>
              </div>
            </div>
          </div>
        </div>`;

        const tlsRow = req.tls
          ? `<div class="detail-summary-item"><div class="detail-summary-label">TLS</div><div class="detail-summary-value">${esc(req.tls.version || '-')} / ${esc(req.tls.cipher || '-')}</div></div>`
          : '';

        html += `<div class="detail-card dir-right" style="border-right-color:#888;">
          <div class="detail-card-header">
            <span style="margin-left:auto;display:flex;align-items:center;gap:8px;">
              <span class="detail-pill" style="background:#888;color:#fff;">Tunnel</span>
              <span class="detail-card-heading">Details</span>
              <span class="collapse-chevron">&#9650;</span>
            </span>
          </div>
          <div class="detail-card-body">
            <div class="detail-summary">
              <div class="detail-summary-item"><div class="detail-summary-label">Hostname</div><div class="detail-summary-value">${esc(req.host || '-')}</div></div>
              <div class="detail-summary-item"><div class="detail-summary-label">Port</div><div class="detail-summary-value">${esc(String(portStr))}</div></div>
              <div class="detail-summary-item"><div class="detail-summary-label">Bytes Sent</div><div class="detail-summary-value">${bytesSent}</div></div>
              <div class="detail-summary-item"><div class="detail-summary-label">Bytes Received</div><div class="detail-summary-value">${bytesRecv}</div></div>
              <div class="detail-summary-item"><div class="detail-summary-label">Duration</div><div class="detail-summary-value">${durationStr}</div></div>
              ${tlsRow}
              <div class="detail-summary-item"><div class="detail-summary-label">Timestamp</div><div class="detail-summary-value" style="font-size:11px;">${new Date(req.timestamp).toLocaleString()}</div></div>
            </div>
          </div>
        </div>`;

        content.innerHTML = html;
        return;
      }

      // ---- API Spec Card ----
      if (req.apiMatch) {
        const apiTagLabel = esc(req.apiMatch.tags?.[0] || 'API');
        const apiOpId = esc(req.apiMatch.operationId || '');
        const apiSummary = req.apiMatch.summary ? '<div style="font-size:13px;color:var(--text-main);margin-bottom:8px;">' + esc(req.apiMatch.summary) + '</div>' : '';
        const apiDesc = req.apiMatch.description ? '<div style="font-size:12px;color:var(--text-lowlight);margin-bottom:8px;line-height:1.5;">' + esc(req.apiMatch.description) + '</div>' : '';
        let apiParams = '';
        if (req.apiMatch.parameters?.length) {
          apiParams = '<div style="margin-top:8px;"><div class="section-label">Parameters</div>' +
            req.apiMatch.parameters.map(p =>
              '<div style="font-size:12px;margin-bottom:4px;"><span style="color:var(--pop-color);font-family:var(--font-mono);">' + esc(p.name) + '</span>' +
              '<span style="color:var(--text-watermark);margin:0 4px;">(' + esc(p.in || 'query') + ')</span>' +
              (p.required ? '<span style="color:#ff8c38;font-size:10px;">required</span>' : '') +
              (p.description ? '<div style="color:var(--text-lowlight);font-size:11px;margin-left:12px;">' + esc(p.description) + '</div>' : '') +
              '</div>'
            ).join('') + '</div>';
        }
        html += `<div class="detail-card" style="border-left:4px solid #2fb4e0;">
          <div class="detail-card-header">
            <span class="detail-pill" style="background:#2fb4e0;color:#fff;font-size:11px;">${apiTagLabel}</span>
            <span style="margin-left:auto;display:flex;align-items:center;gap:8px;">
              <span class="detail-card-heading">API</span>
              <span class="collapse-chevron">&#9650;</span>
            </span>
          </div>
          <div class="detail-card-body">
            <div style="font-size:14px;font-weight:600;margin-bottom:4px;">${apiOpId}</div>
            ${apiSummary}
            ${apiDesc}
            ${apiParams}
            <div style="font-size:11px;color:var(--text-watermark);margin-top:8px;">Path: ${esc(req.apiMatch.pathPattern || '')}</div>
          </div>
        </div>`;
      }

      // ---- Transform Card (shown only for requests modified by mock rules) ----
      if (req.originalRequest) {
        const perspectiveLabels = {
          'original': 'Original (client sent)',
          'transformed': 'Transformed (as modified)',
          'client': 'Client perspective',
          'server': 'Server perspective'
        };
        html += `<div class="detail-card transform-card" id="card-transform">
          <div class="detail-card-body" style="padding:12px 20px;">
            <div style="display:flex;align-items:center;gap:12px;">
              <i class="ph ph-shuffle" style="font-size:18px;color:var(--pop-color);"></i>
              <div style="flex:1;">
                <div style="font-weight:600;font-size:13px;color:var(--pop-color);">Request Modified</div>
                <div style="font-size:11px;color:var(--text-lowlight);">by ${esc(req.transformedBy || 'Mock Rule')}</div>
              </div>
              <select class="body-view-select transform-perspective-select" onchange="switchTransformPerspective(this.value)">
                <option value="transformed"${_transformPerspective === 'transformed' ? ' selected' : ''}>Show transformed content</option>
                <option value="original"${_transformPerspective === 'original' ? ' selected' : ''}>Show original content</option>
                <option value="client"${_transformPerspective === 'client' ? ' selected' : ''}>Client perspective</option>
                <option value="server"${_transformPerspective === 'server' ? ' selected' : ''}>Server perspective</option>
              </select>
              <span class="detail-pill transform-indicator" style="background:${_transformPerspective === 'original' || _transformPerspective === 'client' ? '#ff8c38' : 'var(--pop-color)'};color:#fff;font-size:10px;">
                ${_transformPerspective === 'original' || _transformPerspective === 'client' ? 'ORIGINAL' : 'TRANSFORMED'}
              </span>
            </div>
          </div>
        </div>`;
      }

      // ---- Request Card (border-right, pills left, heading right) ----
      const effReq = getEffectiveRequest(req);
      const effMethodColor = {GET:'#4caf7d',POST:'#ff8c38',DELETE:'#ce3939',PUT:'#6e40aa',PATCH:'#dd3a96',HEAD:'#5a80cc',OPTIONS:'#2fb4e0'}[effReq.method] || '#888';
      const sourceLabel = req.source || 'Unknown';
      const sourceIconHtml = SOURCE_ICONS[sourceLabel] || SOURCE_ICONS['Other'] || '';
      const httpVersion = req.protocol === 'h2'
        ? 'HTTP/2'
        : req.protocol === 'https' || req.protocol === 'wss'
          ? 'HTTPS/1.1'
          : 'HTTP/1.1';
      html += `<div class="detail-card dir-right" id="card-request" aria-expanded="true" style="border-right-color:${effMethodColor};">
        <div class="detail-card-header">
          <span style="margin-left:auto;display:flex;align-items:center;gap:8px;">
            <span class="source-icon" title="${esc(sourceLabel)}" style="display:inline-flex;opacity:0.7;">${sourceIconHtml}</span>
            <span class="detail-pill pill-muted" style="font-size:11px;">${httpVersion}</span>
            <span class="detail-pill" style="background:${effMethodColor};color:#fff;">${esc(effReq.method)} ${esc(effReq.host || '').replace(/\./g, '\u2008.\u2008')}</span>
            <span class="detail-card-heading">Request</span>
            <span class="collapse-chevron">&#9650;</span>
          </span>
        </div>
        <div class="detail-card-body">
          ${renderBodyCaptureWarning(effReq, 'request')}
          <div class="detail-card-section">
            <div class="section-label">URL</div>
            <div class="url-summary" onclick="toggleUrlBreakdown()">
              <span class="url-toggle" id="url-breakdown-icon">+</span>
              <span class="url-text">${esc(effReq.url)}</span>
            </div>
            ${renderUrlBreakdown(effReq)}
          </div>
          <div class="detail-card-section">
            <div class="section-label">Headers</div>
            ${renderHeadersGrid(effReq.requestHeaders, 'request')}
          </div>
        </div>
      </div>`;

      // ---- Request Body Card (separate card) ----
      const effBody = effReq.requestBody;
      if (effBody && effBody !== '' && !effBody.startsWith('[Binary')) {
        const reqCt = getCombinedHeaderValue(effReq.requestHeaders, 'content-type');
        const reqBodyModes = getBodyViewModes(effBody, reqCt);
        const reqDefaultMode = reqBodyModes[0]?.value || 'text';
        const reqUseMonaco = isMonacoViewMode(reqDefaultMode) && !effBody.startsWith('[Binary data:');
        html += `<div class="detail-card dir-right" id="card-req-body" aria-expanded="true" style="border-right-color:${effMethodColor};">
          <div class="detail-card-header">
          <span style="margin-left:auto;display:flex;align-items:center;gap:8px;">
            <select class="body-view-select" onclick="event.stopPropagation()" onchange="switchBodyView('reqBody', this.value, 'request')">
              ${reqBodyModes.map(m => '<option value="' + m.value + '">' + m.label + '</option>').join('')}
            </select>
            <select class="body-view-select protobuf-type-select" id="reqBody-schema" onclick="event.stopPropagation()" onchange="setProtobufBodyType('reqBody', this.value, 'request')" style="display:none;"></select>
            <span class="detail-pill pill-muted">${formatSize(req.requestBodySize)}</span>
            <span class="detail-card-heading">Request Body</span>
            <span class="collapse-chevron">&#9650;</span>
          </span>
          </div>
          <div class="detail-card-body">
            <div id="reqBody" data-view-mode="${reqDefaultMode}" data-body-section="request">
              <div id="reqBody-monaco" style="display:${reqUseMonaco ? 'block' : 'none'};min-height:80px;"></div>
              <pre class="body-content" id="reqBody-fallback" style="display:${reqUseMonaco ? 'none' : 'block'};">${reqUseMonaco ? '' : formatBodyAs(effBody, reqCt, reqDefaultMode, { request: effReq, section: 'request' })}</pre>
            </div>
          </div>
        </div>`;
      }

      // ---- Response Card (border-left, pills left, heading right) ----
      const responseStatus = statusBreakpoint
        ? 'Paused'
        : req.statusCode === null || req.statusCode === undefined
        ? 'Pending'
        : req.statusCode || 'ERR';
      const responseStatusMessage = statusBreakpoint
        ? ''
        : responseStatus === 'Pending' && req.statusMessage === 'Pending'
        ? ''
        : req.statusMessage || '';
      html += `<div class="detail-card dir-left" id="card-response" aria-expanded="true" style="border-left-color:${statusColor};">
        <div class="detail-card-header">
          <span style="margin-left:auto;display:flex;align-items:center;gap:8px;">
            <span class="detail-pill" style="background:${statusColor};color:#fff;">${responseStatus}</span>
            <span class="detail-card-heading">Response</span>
            <span class="collapse-chevron">&#9650;</span>
          </span>
        </div>
        <div class="detail-card-body">
          ${renderBodyCaptureWarning(req, 'response')}
          <div class="detail-card-section">
            <div class="section-label">Status</div>
            <div style="font-family:var(--font-mono);font-size:13px;">${responseStatus}${responseStatusMessage ? ' ' + esc(responseStatusMessage) : ''}</div>
          </div>
          <div class="detail-card-section">
            <div class="section-label">Headers</div>
            ${renderHeadersGrid(req.responseHeaders, 'response')}
          </div>
        </div>
      </div>`;

      // ---- Response Body Card (separate card) ----
      if (req.responseBody && req.responseBody !== '') {
        const ct = getCombinedHeaderValue(req.responseHeaders, 'content-type');
        const resBodyModes = getBodyViewModes(req.responseBody, ct);
        const resDefaultMode = resBodyModes[0]?.value || 'text';
        const resUseMonaco = isMonacoViewMode(resDefaultMode) && !req.responseBody.startsWith('[Binary data:');
        html += `<div class="detail-card dir-left" id="card-resp-body" aria-expanded="true" style="border-left-color:${statusColor};">
          <div class="detail-card-header">
          <span style="margin-left:auto;display:flex;align-items:center;gap:8px;">
            <select class="body-view-select" onclick="event.stopPropagation()" onchange="switchBodyView('resBody', this.value, 'response')">
              ${resBodyModes.map(m => '<option value="' + m.value + '">' + m.label + '</option>').join('')}
            </select>
            <select class="body-view-select protobuf-type-select" id="resBody-schema" onclick="event.stopPropagation()" onchange="setProtobufBodyType('resBody', this.value, 'response')" style="display:none;"></select>
            <span class="detail-pill pill-muted">${formatSize(req.responseBodySize)}</span>
            <span class="detail-card-heading">Response Body</span>
            <span class="collapse-chevron">&#9650;</span>
          </span>
          </div>
          <div class="detail-card-body">
            <div id="resBody" data-view-mode="${resDefaultMode}" data-body-section="response">
              <div class="response-body-resizable" id="resBody-monaco" style="display:${resUseMonaco ? 'block' : 'none'};"></div>
              <pre class="body-content response-body-resizable" id="resBody-fallback" style="display:${resUseMonaco ? 'none' : 'block'};">${resUseMonaco ? '' : formatBodyAs(req.responseBody, ct, resDefaultMode, { request: req, section: 'response' })}</pre>
            </div>
          </div>
        </div>`;
      }

      // ---- Response Trailers Card ----
      if (req.trailers && Object.keys(req.trailers).length > 0) {
        html += `<div class="detail-card dir-left" style="border-left-color:${statusColor};">
          <div class="detail-card-header">
            <span style="margin-left:auto;display:flex;align-items:center;gap:8px;">
              <span class="detail-card-heading">Response Trailers</span>
              <span class="collapse-chevron">&#9650;</span>
            </span>
          </div>
          <div class="detail-card-body">
            ${renderHeadersGrid(req.trailers, 'trailers')}
          </div>
        </div>`;
      }

      // ---- Error Card ----
      if (req.error) {
        html += `<div class="detail-card dir-left" id="card-error" aria-expanded="true" style="border-left-color:#ce3939;">
          <div class="detail-card-header">
            <span class="detail-pill" style="background:#ce3939;color:#fff;">Error</span>
            <span class="detail-card-heading">Error</span>
          </div>
          <div class="detail-card-body">
            <pre class="body-content" style="color:#ce3939;">${esc(req.error)}</pre>
          </div>
        </div>`;
      }

      // ---- Spacer to push Performance to bottom ----
      html += `<div class="detail-card-spacer"></div>`;

      // ---- Performance Card ----
      const maxDuration = 5000;
      const barWidth = Math.min(100, ((req.duration || 0) / maxDuration) * 100);
      const barColor = (req.duration || 0) < 200 ? '#4caf7d' : (req.duration || 0) < 1000 ? '#ff8c38' : '#ce3939';

      html += `<div class="detail-card collapsed" id="card-perf" aria-expanded="false">
        <div class="detail-card-header">
          <span style="margin-left:auto;display:flex;align-items:center;gap:8px;">
            ${req.duration != null ? '<span class="detail-pill pill-muted">' + Math.round(req.duration) + 'ms</span>' : ''}
            <span class="detail-card-heading">Performance</span>
            <span class="collapse-chevron">&#9660;</span>
          </span>
        </div>
        <div class="detail-card-body">
          <div class="detail-summary">
            <div class="detail-summary-item"><div class="detail-summary-label">Duration</div><div class="detail-summary-value">${req.duration != null ? Math.round(req.duration) + 'ms' : '-'}</div></div>
            <div class="detail-summary-item"><div class="detail-summary-label">Protocol</div><div class="detail-summary-value">${(req.protocol||'http').toUpperCase()}</div></div>
            <div class="detail-summary-item"><div class="detail-summary-label">Request Size</div><div class="detail-summary-value">${formatSize(req.requestBodySize)}</div></div>
            <div class="detail-summary-item"><div class="detail-summary-label">Response Size</div><div class="detail-summary-value">${formatSize(req.responseBodySize)}</div></div>
            <div class="detail-summary-item"><div class="detail-summary-label">Source</div><div class="detail-summary-value">${req.source||'proxy'}</div></div>
            <div class="detail-summary-item"><div class="detail-summary-label">Time</div><div class="detail-summary-value" style="font-size:11px;">${new Date(req.timestamp).toLocaleTimeString()}</div></div>
          </div>
          <div class="perf-timing">
            <div class="section-label">Timing</div>
            <div class="timing-bar-track">
              <div class="timing-bar-fill" style="width:${barWidth}%;background:${barColor};"></div>
            </div>
            <div class="timing-bar-labels">
              <span>0ms</span><span>${req.duration || 0}ms</span>
            </div>
          </div>
          `;

      // ---- Compression Analysis ----
      const resEncoding = getCombinedHeaderValue(req.responseHeaders, 'content-encoding').toLowerCase();
      const resCt = getCombinedHeaderValue(req.responseHeaders, 'content-type').toLowerCase();
      const resSize = req.responseBodySize || 0;
      const isCompressible = !resCt.match(/^(image\/(png|jpeg|gif|webp)|video\/|audio\/|application\/(zip|gzip|pdf|octet-stream))/);

      html += '<div style="margin-top:16px;"><div class="section-label">Compression</div>';
      if (resEncoding) {
        const encodingName = {'br':'Brotli','gzip':'Gzip','x-gzip':'Gzip','deflate':'Deflate','zstd':'Zstandard'}[resEncoding] || resEncoding;
        html += '<div style="font-size:12px;color:var(--text-main);margin-bottom:4px;">Response compressed with <strong>' + encodingName + '</strong> (' + formatSize(resSize) + ')</div>';
        if (resEncoding === 'gzip') {
          html += '<div style="font-size:11px;color:var(--text-lowlight);">Brotli (br) typically achieves 15-25% better compression than Gzip for text content.</div>';
        }
      } else if (isCompressible && resSize > 1024) {
        html += '<div style="font-size:12px;color:#ff8c38;margin-bottom:4px;">Response is not compressed (' + formatSize(resSize) + ')</div>';
        html += '<div style="font-size:11px;color:var(--text-lowlight);">This response could benefit from compression. Consider enabling Gzip or Brotli.</div>';
      } else if (!isCompressible) {
        html += '<div style="font-size:12px;color:var(--text-main);">Content type is already in a compressed format.</div>';
      } else {
        html += '<div style="font-size:12px;color:var(--text-main);">Response is small (' + formatSize(resSize) + ') \u2014 compression overhead may not be worthwhile.</div>';
      }
      html += '</div>';

      // ---- Caching Analysis ----
      const cacheControl = getCombinedHeaderValue(req.responseHeaders, 'cache-control');
      const expires = getCombinedHeaderValue(req.responseHeaders, 'expires');
      const etag = getCombinedHeaderValue(req.responseHeaders, 'etag');
      const lastMod = getCombinedHeaderValue(req.responseHeaders, 'last-modified');

      html += '<div style="margin-top:16px;"><div class="section-label">Caching</div>';
      if (cacheControl) {
        const directives = cacheControl.split(',').map(d => d.trim().toLowerCase());
        const maxAge = directives.find(d => d.startsWith('max-age='));
        const isNoStore = directives.includes('no-store');
        const isNoCache = directives.includes('no-cache');
        const isPublic = directives.includes('public');
        const isPrivate = directives.includes('private');

        if (isNoStore) {
          html += '<div style="font-size:12px;color:#ff8c38;">Not cacheable (no-store) \u2014 every request hits the server.</div>';
        } else if (isNoCache) {
          html += '<div style="font-size:12px;color:var(--text-main);">Must revalidate (no-cache) \u2014 cached but checked with server each time.</div>';
        } else if (maxAge) {
          const secs = parseInt(maxAge.split('=')[1]);
          const human = secs >= 86400 ? Math.round(secs/86400) + ' days' : secs >= 3600 ? Math.round(secs/3600) + ' hours' : secs + ' seconds';
          html += '<div style="font-size:12px;color:#4caf7d;">Cacheable for ' + human + ' (' + (isPublic ? 'public' : isPrivate ? 'private' : 'default') + ')</div>';
        } else {
          html += '<div style="font-size:12px;color:var(--text-main);">Cache-Control: ' + esc(cacheControl) + '</div>';
        }
      } else if (expires) {
        html += '<div style="font-size:12px;color:var(--text-main);">Expires: ' + esc(expires) + '</div>';
      } else {
        html += '<div style="font-size:12px;color:var(--text-lowlight);">No explicit caching headers set.</div>';
      }

      if (etag || lastMod) {
        html += '<div style="font-size:11px;color:var(--text-lowlight);margin-top:4px;">Validation: ';
        const parts = [];
        if (etag) parts.push('ETag present');
        if (lastMod) parts.push('Last-Modified present');
        html += parts.join(', ') + '</div>';
      }
      html += '</div>';

      // Connection/TLS info
      if (req.protocol === 'h2' && req.tls) {
        html += `<div style="margin-top:12px;">
            <div class="section-label">Connection</div>
            <div style="display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12px;">
              <span style="color:var(--text-watermark);">Protocol:</span>
              <span style="font-family:var(--font-mono);">HTTP/2 (${esc(req.tls.version || 'TLS')})</span>
              ${req.tls.cipher ? `<span style="color:var(--text-watermark);">Cipher:</span>
              <span style="font-family:var(--font-mono);">${esc(req.tls.cipher)}</span>` : ''}
              ${remoteEndpoint ? `<span style="color:var(--text-watermark);">Remote:</span>
              <span style="font-family:var(--font-mono);">${remoteEndpoint}</span>` : ''}
            </div>
          </div>`;
      } else if ((req.protocol === 'https' && req.tls) || req.protocol === 'wss') {
        const secureProtocol = req.protocol === 'wss' ? 'WSS' : 'HTTPS';
        html += `<div style="margin-top:12px;">
            <div class="section-label">Connection</div>
            <div style="display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12px;">
              <span style="color:var(--text-watermark);">Protocol:</span>
              <span style="font-family:var(--font-mono);">${secureProtocol} (${esc(req.tls?.version || 'TLS')})</span>
              ${req.tls?.cipher ? `<span style="color:var(--text-watermark);">Cipher:</span>
              <span style="font-family:var(--font-mono);">${esc(req.tls.cipher)}</span>` : ''}
              ${remoteEndpoint ? `<span style="color:var(--text-watermark);">Remote:</span>
              <span style="font-family:var(--font-mono);">${remoteEndpoint}</span>` : ''}
            </div>
          </div>`;
      } else if (req.protocol === 'http' || req.protocol === 'ws') {
        const plainProtocol = req.protocol === 'ws' ? 'WS' : 'HTTP';
        html += `<div style="margin-top:12px;">
            <div class="section-label">Connection</div>
            <div style="display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12px;">
              <span style="color:var(--text-watermark);">Protocol:</span>
              <span style="font-family:var(--font-mono);">${plainProtocol} (unencrypted)</span>
              ${remoteEndpoint ? `<span style="color:var(--text-watermark);">Remote:</span>
              <span style="font-family:var(--font-mono);">${remoteEndpoint}</span>` : ''}
            </div>
          </div>`;
      }

      html += `
        </div>
      </div>`;

      // Export Card (collapsed by default)
      html += `<div class="detail-card collapsed" id="card-export" aria-expanded="false">
        <div class="detail-card-header">
          <select id="exportFormat" onchange="updateExportSnippet()" onclick="event.stopPropagation()" style="background:var(--bg-input);border:1px solid var(--text-input-border);border-radius:4px;color:var(--text-main);padding:3px 8px;font-size:11px;cursor:pointer;">
            <option value="curl">cURL</option>
            <option value="python">Python (requests)</option>
            <option value="javascript-fetch">JavaScript (fetch)</option>
            <option value="javascript-node">Node.js (http)</option>
            <option value="powershell">PowerShell</option>
            <option value="wget">wget</option>
            <option value="php">PHP (cURL)</option>
            <option value="go">Go</option>
          </select>
          <span style="margin-left:auto;display:flex;align-items:center;gap:8px;">
            <button class="btn" onclick="event.stopPropagation();copyExportSnippet()" style="padding:3px 8px;font-size:11px;" title="Copy to clipboard">Copy</button>
            <span class="detail-card-heading">Export</span>
            <span class="collapse-chevron">&#9660;</span>
          </span>
        </div>
        <div class="detail-card-body">
          <div id="exportSnippetContent" style="cursor:pointer;" onclick="copyExportSnippet()" title="Click to copy">
            <div id="exportSnippetContent-monaco" style="min-height:120px;"></div>
            <pre class="body-content" id="exportSnippetContent-fallback" style="display:none;max-height:none;"></pre>
          </div>
        </div>
      </div>`;

      content.innerHTML = html;

      // Initialize the request body viewer from the currently selected transform perspective
      if (effBody && effBody !== '' && !effBody.startsWith('[Binary')) {
        const reqCt2 = getCombinedHeaderValue(effReq.requestHeaders, 'content-type');
        const reqModes2 = getBodyViewModes(effBody, reqCt2);
        const reqDefMode2 = reqModes2[0]?.value || 'text';
        renderBodyViewer('reqBody', effBody, reqCt2, reqDefMode2, { request: effReq, section: 'request' });
      }

      // Initialize the response body viewer
      if (req.responseBody && req.responseBody !== '' && !req.responseBody.startsWith('[Binary data:')) {
        const resCt = getCombinedHeaderValue(req.responseHeaders, 'content-type');
        const resModes = getBodyViewModes(req.responseBody, resCt);
        const resDefMode = resModes[0]?.value || 'text';
        renderBodyViewer('resBody', req.responseBody, resCt, resDefMode, { request: req, section: 'response' });
      }

      // Generate initial export snippet
      if (document.getElementById('exportFormat')) {
        window._currentExportRequest = req;
        updateExportSnippet();
      }
    }

    function getExportFormFields(req) {
      return (req.formFields || []).filter(field => field.enabled !== false && field.key);
    }

    function shellSingleQuote(value) {
      return String(value ?? '').replace(/'/g, "'\\''");
    }

    function curlFormQuotedValue(value) {
      return `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }

    function isSafeCurlFormContentType(value) {
      return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(String(value));
    }

    function powerShellStringLiteral(value) {
      return `'${String(value ?? '').replace(/'/g, "''")}'`;
    }

    function phpStringLiteral(value) {
      return `'${String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
    }

    function getExportHeaders(req, omitContentType = false) {
      const headers = [];
      Object.entries(req.requestHeaders || {}).forEach(([key, value]) => {
        const lowerKey = key.toLowerCase();
        if (lowerKey === 'host' || lowerKey === 'proxy-connection' || (omitContentType && lowerKey === 'content-type')) return;
        const values = Array.isArray(value) ? value : [value];
        values.forEach(item => headers.push([key, item]));
      });
      return headers;
    }

    function getRepeatedExportHeaderName(headers) {
      const seen = new Set();
      for (const [key] of headers) {
        const lowerKey = key.toLowerCase();
        if (seen.has(lowerKey)) return key;
        seen.add(lowerKey);
      }
      return '';
    }

    function getRepeatedHeaderUnavailableReason(format, headers) {
      const apiName = {
        python: 'Python Requests',
        'javascript-fetch': 'the browser Fetch API',
        powershell: 'Invoke-WebRequest'
      }[format];
      if (!apiName || !getRepeatedExportHeaderName(headers)) return '';
      return `${apiName} cannot guarantee that repeated request header values are sent as separate wire fields.`;
    }

    function renderNodeExportHeaders(headers, additionalEntries = []) {
      const entries = headers.map(([key, value]) => `${JSON.stringify(key)}, ${JSON.stringify(String(value))}`);
      entries.push(...additionalEntries);
      return `[\n${entries.map(entry => `    ${entry}`).join(',\n')}\n  ]`;
    }

    function isValidExportBase64(value) {
      return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
    }

    function getExportRequestBody(req) {
      if (req.requestBodyTruncated === true) {
        return {
          kind: 'unavailable',
          reason: 'The captured request body is incomplete, so its original bytes cannot be replayed.'
        };
      }

      const value = String(req.requestBody ?? '');
      if (String(req.requestBodyEncoding || '').toLowerCase() !== 'base64') {
        return { kind: 'text', value };
      }

      const match = /^data:[^,\r\n]*;base64,([A-Za-z0-9+/=]*)$/i.exec(value);
      if (!match || !isValidExportBase64(match[1])) {
        return {
          kind: 'unavailable',
          reason: 'The captured request body has invalid base64 metadata, so its original bytes cannot be replayed.'
        };
      }
      return { kind: 'base64', value: match[1] };
    }

    function generateUnavailableExportSnippet(format, reason) {
      const prefix = ['javascript-fetch', 'javascript-node', 'php', 'go'].includes(format) ? '//' : '#';
      return `${prefix} EXACT REPLAY UNAVAILABLE\n${prefix} ${reason}\n${prefix} No request was generated.`;
    }

    function generateMultipartExportSnippet(req, format) {
      const fields = getExportFormFields(req);
      const headers = getExportHeaders(req, true);
      const method = String(req.method || 'POST');
      const url = String(req.url || '');
      const repeatedHeaderReason = getRepeatedHeaderUnavailableReason(format, headers);
      if (repeatedHeaderReason) return generateUnavailableExportSnippet(format, repeatedHeaderReason);

      if (format === 'curl') {
        const unsafeFileField = fields.find((field) => {
          if (field.type !== 'file') return false;
          const fileName = String(field.file?.name || field.fileName || 'file');
          const contentType = field.file?.type || field.fileType;
          return String(field.key).includes('=')
            || fileName === '-'
            || (contentType && !isSafeCurlFormContentType(contentType));
        });
        if (unsafeFileField) {
          return generateUnavailableExportSnippet(
            format,
            'The captured file metadata cannot be represented safely in cURL form syntax.'
          );
        }
        let cmd = `curl -X '${shellSingleQuote(method)}' '${shellSingleQuote(url)}'`;
        headers.forEach(([key, value]) => { cmd += ` \\\n  -H '${shellSingleQuote(key)}: ${shellSingleQuote(value)}'`; });
        fields.forEach((field) => {
          if (field.type === 'file') {
            const contentType = field.file?.type || field.fileType;
            const fileName = curlFormQuotedValue(field.file?.name || field.fileName || 'file');
            const value = `@${fileName}${contentType ? `;type=${contentType}` : ''}`;
            cmd += ` \\\n  -F '${shellSingleQuote(field.key)}=${shellSingleQuote(value)}'`;
          } else {
            cmd += ` \\\n  --form-string '${shellSingleQuote(field.key)}=${shellSingleQuote(field.value || '')}'`;
          }
        });
        return cmd;
      }

      if (format === 'python') {
        const textFields = fields.filter(field => field.type !== 'file');
        const fileFields = fields.filter(field => field.type === 'file');
        let code = 'import requests\n\n';
        if (textFields.length) {
          code += `data = [\n${textFields.map(field => `    (${JSON.stringify(field.key)}, ${JSON.stringify(field.value || '')})`).join(',\n')}\n]\n`;
        }
        if (fileFields.length) {
          code += `files = [\n${fileFields.map(field => {
            const filename = field.file?.name || field.fileName || 'file';
            const contentType = field.file?.type || field.fileType || 'application/octet-stream';
            return `    (${JSON.stringify(field.key)}, (${JSON.stringify(filename)}, open(${JSON.stringify(filename)}, 'rb'), ${JSON.stringify(contentType)}))`;
          }).join(',\n')}\n]\n`;
        }
        code += `\nresponse = requests.request(\n    ${JSON.stringify(method)},\n    ${JSON.stringify(url)}`;
        if (headers.length) code += `,\n    headers={\n${headers.map(([key, value]) => `        ${JSON.stringify(key)}: ${JSON.stringify(String(value))}`).join(',\n')}\n    }`;
        if (textFields.length) code += ',\n    data=data';
        if (fileFields.length) code += ',\n    files=files';
        code += '\n)\n\nprint(response.status_code)\nprint(response.text)';
        return code;
      }

      if (format === 'javascript-fetch') {
        let code = 'const formData = new FormData();\n';
        let fileIndex = 0;
        fields.forEach((field) => {
          if (field.type === 'file') {
            const filename = field.file?.name || field.fileName || 'file';
            const variable = `file${fileIndex++}`;
            code += `const ${variable} = document.querySelector('input[type="file"]').files[0]; // Select ${filename.replace(/[\r\n]/g, ' ')}\n`;
            code += `formData.append(${JSON.stringify(field.key)}, ${variable}, ${JSON.stringify(filename)});\n`;
          } else {
            code += `formData.append(${JSON.stringify(field.key)}, ${JSON.stringify(field.value || '')});\n`;
          }
        });
        code += `\nconst response = await fetch(${JSON.stringify(url)}, {\n  method: ${JSON.stringify(method)}`;
        if (headers.length) code += `,\n  headers: {\n${headers.map(([key, value]) => `    ${JSON.stringify(key)}: ${JSON.stringify(String(value))}`).join(',\n')}\n  }`;
        code += ',\n  body: formData\n});\n\nconsole.log(response.status, await response.text());';
        return code;
      }

      if (format === 'javascript-node') {
        const boundary = req.multipartBoundary || '----HTTPFreeKitBoundary';
        let code = "const fs = require('fs');\nconst http = require('http');\nconst https = require('https');\n\n";
        code += `const boundary = ${JSON.stringify(boundary)};\nconst chunks = [];\nconst append = value => chunks.push(Buffer.from(value));\n`;
        fields.forEach((field) => {
          const safeName = String(field.key).replace(/["\r\n]/g, '_');
          code += `append('--' + boundary + '\\r\\n');\n`;
          if (field.type === 'file') {
            const filename = field.file?.name || field.fileName || 'file';
            const safeFilename = filename.replace(/["\r\n]/g, '_');
            const contentType = field.file?.type || field.fileType || 'application/octet-stream';
            code += `append(${JSON.stringify(`Content-Disposition: form-data; name="${safeName}"; filename="${safeFilename}"\r\n`)});\n`;
            code += `append(${JSON.stringify(`Content-Type: ${contentType}\r\n\r\n`)});\n`;
            code += `chunks.push(fs.readFileSync(${JSON.stringify(filename)}));\nappend('\\r\\n');\n`;
          } else {
            code += `append(${JSON.stringify(`Content-Disposition: form-data; name="${safeName}"\r\n\r\n${field.value || ''}\r\n`)});\n`;
          }
        });
        code += `append('--' + boundary + '--\\r\\n');\nconst body = Buffer.concat(chunks);\nconst target = new URL(${JSON.stringify(url)});\n`;
        const nodeHeaders = renderNodeExportHeaders(headers, [
          `${JSON.stringify('Content-Type')}, 'multipart/form-data; boundary=' + boundary`,
          `${JSON.stringify('Content-Length')}, String(body.length)`
        ]);
        code += `const options = {\n  method: ${JSON.stringify(method)},\n  hostname: target.hostname,\n  port: target.port || undefined,\n  path: target.pathname + target.search,\n  headers: ${nodeHeaders}\n};\n\n`;
        code += `const request = (target.protocol === 'https:' ? https : http).request(options, response => {\n  let data = '';\n  response.on('data', chunk => data += chunk);\n  response.on('end', () => console.log(response.statusCode, data));\n});\nrequest.write(body);\nrequest.end();`;
        return code;
      }

      if (format === 'powershell') {
        let code = '$headers = @{}\n';
        headers.forEach(([key, value]) => { code += `$headers[${powerShellStringLiteral(key)}] = ${powerShellStringLiteral(value)}\n`; });
        code += '\n$form = @{}\n';
        fields.forEach((field) => {
          const value = field.type === 'file'
            ? `Get-Item -LiteralPath ${powerShellStringLiteral(field.file?.name || field.fileName || 'file')}`
            : powerShellStringLiteral(field.value || '');
          code += `$form[${powerShellStringLiteral(field.key)}] = ${value}\n`;
        });
        code += `\n$response = Invoke-WebRequest -Uri ${powerShellStringLiteral(url)} -Method ${powerShellStringLiteral(method)} -Headers $headers -Form $form\n$response.StatusCode\n$response.Content`;
        return code;
      }

      if (format === 'wget') {
        const boundary = req.multipartBoundary || '----HTTPFreeKitBoundary';
        let code = `boundary='${shellSingleQuote(boundary)}'\nbody_file=$(mktemp)\n{\n`;
        fields.forEach((field) => {
          const safeName = String(field.key).replace(/["\r\n]/g, '_');
          code += `  printf '%s\\r\\n' "--$boundary"\n`;
          if (field.type === 'file') {
            const filename = field.file?.name || field.fileName || 'file';
            const safeFilename = filename.replace(/["\r\n]/g, '_');
            const contentType = field.file?.type || field.fileType || 'application/octet-stream';
            code += `  printf '%s\\r\\n' '${shellSingleQuote(`Content-Disposition: form-data; name="${safeName}"; filename="${safeFilename}"`)}'\n`;
            code += `  printf '%s\\r\\n\\r\\n' '${shellSingleQuote(`Content-Type: ${contentType}`)}'\n  cat '${shellSingleQuote(filename)}'\n  printf '\\r\\n'\n`;
          } else {
            code += `  printf '%s\\r\\n\\r\\n' '${shellSingleQuote(`Content-Disposition: form-data; name="${safeName}"`)}'\n`;
            code += `  printf '%s\\r\\n' '${shellSingleQuote(field.value || '')}'\n`;
          }
        });
        code += `  printf '%s--\\r\\n' "--$boundary"\n} > "$body_file"\n\nwget --method='${shellSingleQuote(method)}'`;
        headers.forEach(([key, value]) => { code += ` \\\n  --header='${shellSingleQuote(key)}: ${shellSingleQuote(value)}'`; });
        code += ` \\\n  --header="Content-Type: multipart/form-data; boundary=$boundary" \\\n  --body-file="$body_file" \\\n  '${shellSingleQuote(url)}'\nrm -f "$body_file"`;
        return code;
      }

      if (format === 'php') {
        let code = `<?php\n$ch = curl_init(${phpStringLiteral(url)});\n$postFields = [\n`;
        fields.forEach((field) => {
          const value = field.type === 'file'
            ? `new CURLFile(${phpStringLiteral(field.file?.name || field.fileName || 'file')}, ${phpStringLiteral(field.file?.type || field.fileType || 'application/octet-stream')})`
            : phpStringLiteral(field.value || '');
          code += `    ${phpStringLiteral(field.key)} => ${value},\n`;
        });
        code += `];\ncurl_setopt($ch, CURLOPT_CUSTOMREQUEST, ${phpStringLiteral(method)});\ncurl_setopt($ch, CURLOPT_RETURNTRANSFER, true);\ncurl_setopt($ch, CURLOPT_POSTFIELDS, $postFields);\n`;
        if (headers.length) code += `curl_setopt($ch, CURLOPT_HTTPHEADER, [\n${headers.map(([key, value]) => `    ${phpStringLiteral(`${key}: ${value}`)}`).join(',\n')}\n]);\n`;
        code += `$response = curl_exec($ch);\n$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);\ncurl_close($ch);\necho $httpCode . "\\n" . $response;\n?>`;
        return code;
      }

      if (format === 'go') {
        const hasFiles = fields.some(field => field.type === 'file');
        let code = 'package main\n\nimport (\n\t"bytes"\n\t"fmt"\n\t"mime/multipart"\n\t"net/http"\n';
        if (hasFiles) code += '\t"io"\n\t"os"\n';
        code += ')\n\nfunc main() {\n\tvar body bytes.Buffer\n\twriter := multipart.NewWriter(&body)\n';
        let fileIndex = 0;
        fields.forEach((field) => {
          if (field.type === 'file') {
            const filename = field.file?.name || field.fileName || 'file';
            const index = fileIndex++;
            code += `\tfile${index}, _ := os.Open(${JSON.stringify(filename)})\n\tdefer file${index}.Close()\n`;
            code += `\tpart${index}, _ := writer.CreateFormFile(${JSON.stringify(field.key)}, ${JSON.stringify(filename)})\n\tio.Copy(part${index}, file${index})\n`;
          } else {
            code += `\twriter.WriteField(${JSON.stringify(field.key)}, ${JSON.stringify(field.value || '')})\n`;
          }
        });
        code += `\twriter.Close()\n\n\treq, _ := http.NewRequest(${JSON.stringify(method)}, ${JSON.stringify(url)}, &body)\n`;
        headers.forEach(([key, value]) => { code += `\treq.Header.Add(${JSON.stringify(key)}, ${JSON.stringify(String(value))})\n`; });
        code += '\treq.Header.Set("Content-Type", writer.FormDataContentType())\n\tresp, _ := http.DefaultClient.Do(req)\n\tdefer resp.Body.Close()\n\tfmt.Println(resp.StatusCode)\n}';
        return code;
      }

      return '';
    }

    function generateExportSnippet(req, format) {
      if (req.bodyType === 'urlencoded') {
        const params = new URLSearchParams();
        getExportFormFields(req).forEach(field => params.append(field.key, field.value || ''));
        const headers = { ...(req.requestHeaders || {}) };
        if (!findHeaderKey(headers, 'Content-Type')) headers['Content-Type'] = 'application/x-www-form-urlencoded';
        return generateExportSnippet({
          ...req,
          bodyType: 'raw',
          requestHeaders: headers,
          requestBody: params.toString(),
          requestBodyEncoding: 'utf8',
          requestBodyTruncated: false
        }, format);
      }
      if (req.bodyType === 'multipart') return generateMultipartExportSnippet(req, format);

      const method = String(req.method || 'GET');
      const url = String(req.url || '');
      const exportBody = getExportRequestBody(req);
      if (exportBody.kind === 'unavailable') {
        return generateUnavailableExportSnippet(format, exportBody.reason);
      }
      const body = exportBody.value;
      const isBinaryBody = exportBody.kind === 'base64' && body.length > 0;
      const headers = getExportHeaders(req);
      const hasBody = body.length > 0;
      const repeatedHeaderReason = getRepeatedHeaderUnavailableReason(format, headers);
      if (repeatedHeaderReason) return generateUnavailableExportSnippet(format, repeatedHeaderReason);

      switch (format) {
        case 'curl': {
          let cmd = `curl -X '${shellSingleQuote(method)}' '${shellSingleQuote(url)}'`;
          for (const [key, value] of headers) {
            cmd += ` \\\n  -H '${shellSingleQuote(`${key}: ${value}`)}'`;
          }
          if (hasBody && isBinaryBody) {
            cmd = `printf '%s' '${shellSingleQuote(body)}' | base64 --decode | ${cmd} \\\n  --data-binary @-`;
          } else if (hasBody) {
            cmd += ` \\\n  --data-raw '${shellSingleQuote(body)}'`;
          }
          return cmd;
        }
        case 'python': {
          let code = isBinaryBody ? `import base64\nimport requests\n\n` : `import requests\n\n`;
          code += `response = requests.request(\n    ${JSON.stringify(method)},\n    ${JSON.stringify(url)}`;
          if (headers.length) {
            code += `,\n    headers={\n${headers.map(([key, value]) => `        ${JSON.stringify(key)}: ${JSON.stringify(String(value))}`).join(',\n')}\n    }`;
          }
          if (hasBody) {
            code += isBinaryBody
              ? `,\n    data=base64.b64decode(${JSON.stringify(body)})`
              : `,\n    data=${JSON.stringify(body)}`;
          }
          code += `\n)\n\nprint(response.status_code)\nprint(response.text)`;
          return code;
        }
        case 'javascript-fetch': {
          let code = `const response = await fetch(${JSON.stringify(url)}, {\n  method: ${JSON.stringify(method)}`;
          if (headers.length) {
            code += `,\n  headers: {\n${headers.map(([key, value]) => `    ${JSON.stringify(key)}: ${JSON.stringify(String(value))}`).join(',\n')}\n  }`;
          }
          if (hasBody) {
            code += isBinaryBody
              ? `,\n  body: Uint8Array.from(atob(${JSON.stringify(body)}), character => character.charCodeAt(0))`
              : `,\n  body: ${JSON.stringify(body)}`;
          }
          code += `\n});\n\nconst data = await response.text();\nconsole.log(response.status, data);`;
          return code;
        }
        case 'javascript-node': {
          let code = `const https = require('https');\nconst http = require('http');\n\n`;
          code += `const target = new URL(${JSON.stringify(url)});\n`;
          code += `const options = {\n  method: ${JSON.stringify(method)},\n  hostname: target.hostname,\n  path: target.pathname + target.search,\n  port: target.port || undefined`;
          if (headers.length) {
            code += `,\n  headers: ${renderNodeExportHeaders(headers)}`;
          }
          code += `\n};\n\nconst request = (target.protocol === 'https:' ? https : http).request(options, (response) => {\n  let data = '';\n  response.on('data', chunk => data += chunk);\n  response.on('end', () => console.log(response.statusCode, data));\n});\n`;
          if (hasBody) {
            code += isBinaryBody
              ? `request.write(Buffer.from(${JSON.stringify(body)}, 'base64'));\n`
              : `request.write(${JSON.stringify(body)});\n`;
          }
          code += `request.end();`;
          return code;
        }
        case 'powershell': {
          let code = `$headers = @{}\n`;
          for (const [key, value] of headers) {
            code += `$headers[${powerShellStringLiteral(key)}] = ${powerShellStringLiteral(value)}\n`;
          }
          code += `\n$response = Invoke-WebRequest -Uri ${powerShellStringLiteral(url)} -Method ${powerShellStringLiteral(method)} -Headers $headers`;
          if (hasBody) {
            code += isBinaryBody
              ? ` -Body ([Convert]::FromBase64String(${powerShellStringLiteral(body)}))`
              : ` -Body ${powerShellStringLiteral(body)}`;
          }
          code += `\n$response.StatusCode\n$response.Content`;
          return code;
        }
        case 'wget': {
          let cmd = `wget --method='${shellSingleQuote(method)}'`;
          for (const [key, value] of headers) {
            cmd += ` \\\n  --header='${shellSingleQuote(`${key}: ${value}`)}'`;
          }
          if (hasBody && isBinaryBody) {
            cmd = `body_file=$(mktemp) || exit 1\ntrap 'rm -f "$body_file"' EXIT\ntrap 'exit 1' HUP INT TERM\nprintf '%s' '${shellSingleQuote(body)}' | base64 --decode > "$body_file" || exit 1\n\n${cmd} \\\n  --body-file="$body_file"`;
          } else if (hasBody) {
            cmd += ` \\\n  --body-data='${shellSingleQuote(body)}'`;
          }
          cmd += ` \\\n  '${shellSingleQuote(url)}'`;
          return cmd;
        }
        case 'php': {
          let code = '<?php\n';
          if (hasBody && isBinaryBody) {
            code += `$body = base64_decode(${phpStringLiteral(body)}, true);\nif ($body === false) {\n    throw new RuntimeException('Invalid captured request body');\n}\n`;
          }
          code += `$ch = curl_init();\ncurl_setopt($ch, CURLOPT_URL, ${phpStringLiteral(url)});\ncurl_setopt($ch, CURLOPT_CUSTOMREQUEST, ${phpStringLiteral(method)});\ncurl_setopt($ch, CURLOPT_RETURNTRANSFER, true);\n`;
          if (headers.length) {
            code += `curl_setopt($ch, CURLOPT_HTTPHEADER, [\n${headers.map(([key, value]) => `    ${phpStringLiteral(`${key}: ${value}`)}`).join(',\n')}\n]);\n`;
          }
          if (hasBody) {
            code += isBinaryBody
              ? 'curl_setopt($ch, CURLOPT_POSTFIELDS, $body);\n'
              : `curl_setopt($ch, CURLOPT_POSTFIELDS, ${phpStringLiteral(body)});\n`;
          }
          code += `$response = curl_exec($ch);\n$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);\ncurl_close($ch);\necho $httpCode . "\\n" . $response;\n?>`;
          return code;
        }
        case 'go': {
          let code = `package main\n\nimport (\n\t"fmt"\n\t"io"\n\t"net/http"\n`;
          if (hasBody && isBinaryBody) code += `\t"bytes"\n\t"encoding/base64"\n`;
          else if (hasBody) code += `\t"strings"\n`;
          code += `)\n\nfunc main() {\n`;
          if (hasBody) {
            if (isBinaryBody) {
              code += `\tbodyBytes, err := base64.StdEncoding.DecodeString(${JSON.stringify(body)})\n`;
              code += `\tif err != nil {\n\t\tpanic(err)\n\t}\n`;
              code += `\tbody := bytes.NewReader(bodyBytes)\n`;
            } else {
              code += `\tbody := strings.NewReader(${JSON.stringify(body)})\n`;
            }
            code += `\treq, _ := http.NewRequest(${JSON.stringify(method)}, ${JSON.stringify(url)}, body)\n`;
          } else {
            code += `\treq, _ := http.NewRequest(${JSON.stringify(method)}, ${JSON.stringify(url)}, nil)\n`;
          }
          for (const [key, value] of headers) {
            code += `\treq.Header.Add(${JSON.stringify(key)}, ${JSON.stringify(String(value))})\n`;
          }
          code += `\n\tresp, _ := http.DefaultClient.Do(req)\n\tdefer resp.Body.Close()\n\tdata, _ := io.ReadAll(resp.Body)\n\tfmt.Println(resp.StatusCode, string(data))\n}`;
          return code;
        }
        default:
          return `// Unknown format: ${format}`;
      }
    }

    function autoSizeExportEditor(editor, container) {
      const resizeToContent = () => {
        container.style.height = Math.max(Math.ceil(editor.getContentHeight()), 120) + 'px';
      };
      resizeToContent();
      editor.onDidContentSizeChange((event) => {
        if (event.contentHeightChanged) resizeToContent();
      });
    }

    function updateExportSnippet() {
      const format = document.getElementById('exportFormat')?.value || 'curl';
      const req = window._currentExportRequest;
      if (!req) return;
      const snippet = generateExportSnippet(req, format);
      const monacoId = 'exportSnippetContent-monaco';
      const fallback = document.getElementById('exportSnippetContent-fallback');
      if (fallback) {
        fallback.textContent = snippet;
        fallback.style.display = 'block';
      }
      disposeBodyEditor(monacoId);
      const monacoContainer = document.getElementById(monacoId);
      if (monacoContainer) monacoContainer.style.display = 'none';
      const language = exportFormatToMonacoLanguage(format);
      createMonacoEditor(monacoId, {
        value: snippet,
        language,
        readOnly: true,
        minimap: false,
        lineNumbers: true,
        wordWrap: 'on',
        folding: true,
      }).then(editor => {
        if (!editor || !isMonacoEditorCurrent(monacoId, editor)) {
          disposeMonacoEditor(editor);
          if (fallback) fallback.style.display = 'block';
          return;
        }
        activeBodyEditors[monacoId] = editor;
        if (monacoContainer) monacoContainer.style.display = 'block';
        if (fallback) fallback.style.display = 'none';
        const container = document.getElementById(monacoId);
        if (!container) return;
        autoSizeExportEditor(editor, container);
      }).catch(error => {
        console.warn('[Monaco] Export viewer failed; keeping fallback viewer', error);
        if (monacoContainer) monacoContainer.style.display = 'none';
        if (fallback) fallback.style.display = 'block';
      });
    }

    function getCurrentSendExportRequest() {
      syncSendHeadersToHidden();
      let headers = {};
      try { headers = JSON.parse(document.getElementById('sendHeaders')?.value || '{}'); } catch {}

      const bodyType = getSendBodyType();
      const bodyFormat = document.getElementById('sendBodyFormat')?.value || 'text';
      const requestBody = bodyType === 'urlencoded' ? serializeUrlEncodedFields() : (bodyType === 'raw' ? getSendBodyValue() : '');
      if (bodyType === 'urlencoded') setDefaultHeader(headers, 'Content-Type', 'application/x-www-form-urlencoded');
      if (bodyType === 'multipart') setDefaultHeader(headers, 'Content-Type', 'multipart/form-data');
      if (bodyType === 'raw' && requestBody) setDefaultHeader(headers, 'Content-Type', formatToContentType(bodyFormat));

      const url = document.getElementById('sendUrl')?.value.trim() || '';
      let host = '';
      let path = '';
      try {
        const parsed = new URL(url);
        host = parsed.hostname;
        path = parsed.pathname + parsed.search;
      } catch {}

      return {
        method: document.getElementById('sendMethod')?.value || 'GET',
        url,
        host,
        path,
        requestHeaders: headers,
        requestBody,
        bodyType,
        bodyFormat,
        formFields: cloneSendFormFields(bodyType === 'multipart' ? sendMultipartFields : sendUrlEncodedFields),
        multipartBoundary: sendMultipartBoundary || createMultipartBoundary()
      };
    }

    function scheduleSendExportUpdate() {
      clearTimeout(sendExportUpdateTimer);
      sendExportUpdateTimer = setTimeout(updateSendExportSnippet, 100);
    }

    async function updateSendExportSnippet() {
      const container = document.getElementById('sendExportContent-monaco');
      const fallback = document.getElementById('sendExportContent-fallback');
      if (!container || !fallback) return;

      const format = document.getElementById('sendExportFormat')?.value || 'curl';
      const snippet = generateExportSnippet(getCurrentSendExportRequest(), format);
      fallback.textContent = snippet;

      const existing = activeBodyEditors['sendExportContent-monaco'];
      if (existing) {
        existing.setValue(snippet);
        if (monacoApi) monacoApi.editor.setModelLanguage(existing.getModel(), exportFormatToMonacoLanguage(format));
        fallback.style.display = 'none';
        container.style.display = 'block';
        return;
      }
      if (sendExportCreating) return;

      container.style.display = 'none';
      fallback.style.display = 'block';
      sendExportCreating = true;
      let editor = null;
      try {
        editor = await createMonacoEditor('sendExportContent-monaco', {
          value: snippet,
          language: exportFormatToMonacoLanguage(format),
          readOnly: true,
          minimap: false,
          lineNumbers: true,
          wordWrap: 'on',
          folding: true,
        });

        if (!editor || !isMonacoEditorCurrent('sendExportContent-monaco', editor)) {
          disposeMonacoEditor(editor);
          return;
        }

        activeBodyEditors['sendExportContent-monaco'] = editor;
        const latestFormat = document.getElementById('sendExportFormat')?.value || 'curl';
        const latestSnippet = generateExportSnippet(getCurrentSendExportRequest(), latestFormat);
        editor.setValue(latestSnippet);
        if (monacoApi) monacoApi.editor.setModelLanguage(editor.getModel(), exportFormatToMonacoLanguage(latestFormat));
        container.style.display = 'block';
        fallback.style.display = 'none';
        autoSizeExportEditor(editor, container);
      } catch (error) {
        console.warn('[Monaco] Send export viewer failed; keeping fallback viewer', error);
        disposeMonacoEditor(editor);
      } finally {
        sendExportCreating = false;
        if (!editor || !isMonacoEditorCurrent('sendExportContent-monaco', editor)) {
          container.style.display = 'none';
          fallback.style.display = 'block';
        }
      }
    }

    function copySendExportSnippet() {
      const editor = activeBodyEditors['sendExportContent-monaco'];
      const fallback = document.getElementById('sendExportContent-fallback');
      const text = editor?.getValue ? editor.getValue() : (fallback?.textContent || '');
      if (!text) return;
      navigator.clipboard.writeText(text.trim())
        .then(() => toast('Export snippet copied', 'success'))
        .catch(() => toast('Failed to copy', 'error'));
    }

    function exportFormatToMonacoLanguage(format) {
      const map = {
        curl: 'shell',
        wget: 'shell',
        python: 'python',
        'javascript-fetch': 'javascript',
        'javascript-node': 'javascript',
        powershell: 'powershell',
        php: 'php',
        go: 'go'
      };
      return map[format] || 'plaintext';
    }

    function copyExportSnippet() {
      const editor = activeBodyEditors['exportSnippetContent-monaco'];
      const fallback = document.getElementById('exportSnippetContent-fallback');
      const text = editor?.getValue ? editor.getValue() : (fallback?.textContent || '');
      if (!text) return;
      navigator.clipboard.writeText(text.trim()).then(() => {
        toast('Copied to clipboard!', 'success');
      }).catch(() => toast('Failed to copy', 'error'));
    }

    function renderUrlBreakdown(req) {
      let urlObj;
      try { urlObj = new URL(req.url); } catch { return ''; }
      let rows = '';
      rows += `<div class="url-grid-key">Protocol</div><div class="url-grid-val">${esc(urlObj.protocol.replace(':', ''))}</div>`;
      rows += `<div class="url-grid-key">Host</div><div class="url-grid-val">${esc(urlObj.hostname)}${urlObj.port ? ':' + esc(urlObj.port) : ''}</div>`;
      rows += `<div class="url-grid-key">Path</div><div class="url-grid-val">${esc(urlObj.pathname)}</div>`;
      if (urlObj.search) {
        const params = new URLSearchParams(urlObj.search);
        for (const [k, v] of params) {
          rows += `<div class="url-grid-key">${esc(k)}</div><div class="url-grid-val">${esc(v)}</div>`;
        }
      }
      if (urlObj.hash) {
        rows += `<div class="url-grid-key">Fragment</div><div class="url-grid-val">${esc(urlObj.hash.slice(1))}</div>`;
      }
      return `<div class="url-breakdown-grid" id="url-breakdown" style="display:none;">${rows}</div>`;
    }

    function renderHeadersGrid(headers, section) {
      if (!headers || Object.keys(headers).length === 0) {
        return '<div class="headers-empty">(None)</div>';
      }
      const sectionAttr = section ? ` data-section="${esc(section)}"` : '';
      // Sort headers alphabetically by key (like HTTP Toolkit)
      const sorted = Object.entries(headers).sort(([a], [b]) => a.toLowerCase().localeCompare(b.toLowerCase()));
      return `<div class="headers-grid"${sectionAttr}>${
        sorted.map(([k, v], i) => {
          const val = Array.isArray(v) ? v.join(', ') : String(v);
          const hid = 'hdr-' + k.replace(/[^a-zA-Z0-9]/g, '_') + '-' + i;
          const safeKey = k.replace(/'/g, "\\'");
          const ctxMenu = section ? ` role="button" tabindex="0" aria-haspopup="menu" data-context-header-key="${esc(k)}" data-context-section="${esc(section)}" oncontextmenu="showHeaderContextMenu(event, '${safeKey}', '${section}')"` : '';
          const desc = HEADER_DOCS[k.toLowerCase()] || '';
          const descHtml = desc
            ? '<p style="color:var(--text-lowlight);font-size:12px;line-height:1.5;padding:8px 0;">' + esc(desc) + '</p>'
            : '<p style="color:var(--text-watermark);font-size:12px;font-style:italic;">No documentation available for this header.</p>';
          return `<span class="header-toggle" id="${hid}-icon" onclick="toggleHeaderRow('${hid}')">+</span><span class="header-name"${ctxMenu}>${esc(k)}: </span><span class="header-value"${ctxMenu}>${esc(val)}</span><div class="header-desc" id="${hid}-desc">${descHtml}</div>`;
        }).join('')
      }</div>`;
    }

    // Keep old renderHeaders as alias for any other callers
    function renderHeaders(headers, section) {
      return renderHeadersGrid(headers, section);
    }

    function formatBody(body, contentType) {
      if (!body) return '<span style="color:var(--text-watermark);">Empty</span>';

      // Image detection — show as image
      if (contentType && (contentType.includes('image/png') || contentType.includes('image/jpeg') || contentType.includes('image/gif') || contentType.includes('image/webp') || contentType.includes('image/svg'))) {
        return '<span style="color:var(--text-watermark);">[Image: ' + esc(contentType) + ']</span>';
      }

      // Binary data
      if (body.startsWith('[Binary data:')) {
        return '<span style="color:var(--text-watermark);">' + esc(body) + '</span>';
      }

      // JSON pretty-print with syntax highlighting
      if (contentType?.includes('json') || body.trimStart().startsWith('{') || body.trimStart().startsWith('[')) {
        try {
          const parsed = JSON.parse(body);
          return syntaxHighlightJson(JSON.stringify(parsed, null, 2));
        } catch (e) { console.error('[Error]', e.message); }
      }

      // URL-encoded
      if (contentType?.includes('x-www-form-urlencoded') || (body.includes('=') && body.includes('&') && !body.includes(' ') && body.length < 5000)) {
        try {
          const params = new URLSearchParams(body);
          let result = '';
          for (const [key, value] of params) {
            result += '<span style="color:#4caf7d;">' + esc(key) + '</span>';
            result += '<span style="color:var(--text-watermark);"> = </span>';
            result += '<span style="color:#ff8c38;">' + esc(value) + '</span>\n';
          }
          return result || esc(body);
        } catch (e) { console.error('[Error]', e.message); }
      }

      // XML/HTML — highlight tags
      if (contentType?.includes('xml') || contentType?.includes('html') || body.trimStart().startsWith('<')) {
        return syntaxHighlightXml(body);
      }

      return esc(body);
    }

    function isGrpcContentType(contentType) {
      const ct = (contentType || '').toLowerCase();
      return ct.includes('application/grpc') || ct.includes('application/connect+proto');
    }

    function isConnectContentType(contentType) {
      return (contentType || '').toLowerCase().includes('application/connect+proto');
    }

    function isProtobufContentType(contentType) {
      const ct = (contentType || '').toLowerCase();
      return isGrpcContentType(ct) ||
        ct.includes('protobuf') ||
        ct.includes('x-protobuf') ||
        ct.includes('x-protobuffer') ||
        ct.includes('proto');
    }

    // Determine available view modes based on content type and body content
    function getBodyViewModes(body, contentType) {
      const modes = [];
      const ct = (contentType || '').toLowerCase();

      if (isGrpcContentType(ct)) {
        modes.push({ value: 'grpc', label: 'gRPC' });
        modes.push({ value: 'protobuf', label: 'Protobuf' });
        modes.push({ value: 'hex', label: 'Hex' });
        modes.push({ value: 'text', label: 'Text' });
        return modes;
      }

      if (isProtobufContentType(ct)) {
        modes.push({ value: 'protobuf', label: 'Protobuf' });
        modes.push({ value: 'hex', label: 'Hex' });
        modes.push({ value: 'text', label: 'Text' });
        return modes;
      }

      // Image content types get an image preview mode
      if (ct.includes('image/') && body && !body.startsWith('[Binary data:')) {
        modes.push({ value: 'image', label: 'Image' });
        modes.push({ value: 'text', label: 'Text' });
        modes.push({ value: 'hex', label: 'Hex' });
        return modes;
      }

      if (ct.includes('x-www-form-urlencoded') || (body && body.includes('=') && body.includes('&') && !body.includes(' ') && !body.trimStart().startsWith('{') && body.length < 10000)) {
        modes.push({ value: 'decoded', label: 'Decoded' });
        modes.push({ value: 'raw', label: 'Raw' });
      } else if (ct.includes('json') || (body && (body.trimStart().startsWith('{') || body.trimStart().startsWith('[')))) {
        modes.push({ value: 'json', label: 'JSON' });
        modes.push({ value: 'text', label: 'Text' });
      } else if (ct.includes('javascript') || ct.includes('ecmascript')) {
        modes.push({ value: 'javascript', label: 'JavaScript' });
        modes.push({ value: 'text', label: 'Text' });
      } else if (ct.includes('css')) {
        modes.push({ value: 'css', label: 'CSS' });
        modes.push({ value: 'text', label: 'Text' });
      } else if (ct.includes('xml') || ct.includes('html') || (body && body.trimStart().startsWith('<'))) {
        modes.push({ value: 'markup', label: ct.includes('html') ? 'HTML' : 'XML' });
        modes.push({ value: 'text', label: 'Text' });
      } else if (ct.includes('markdown') || ct.includes('/x-markdown')) {
        modes.push({ value: 'markdown', label: 'Markdown' });
        modes.push({ value: 'text', label: 'Text' });
      } else if (ct.includes('yaml') || ct.includes('yml')) {
        modes.push({ value: 'yaml', label: 'YAML' });
        modes.push({ value: 'text', label: 'Text' });
      } else {
        modes.push({ value: 'text', label: 'Text' });
      }
      modes.push({ value: 'hex', label: 'Hex' });
      return modes;
    }

    /**
     * Map content-type to Monaco editor language identifier.
     * @param {string} contentType
     * @returns {string}
     */
    function contentTypeToMonacoLanguage(contentType) {
      const ct = (contentType || '').toLowerCase();
      if (ct.includes('json')) return 'json';
      if (ct.includes('html')) return 'html';
      if (ct.includes('xml') || ct.includes('svg')) return 'xml';
      if (ct.includes('css')) return 'css';
      if (ct.includes('javascript') || ct.includes('ecmascript')) return 'javascript';
      if (ct.includes('typescript')) return 'typescript';
      if (ct.includes('markdown') || ct.includes('/x-markdown')) return 'markdown';
      if (ct.includes('yaml') || ct.includes('yml')) return 'yaml';
      return 'plaintext';
    }

    /**
     * Map a body view mode to a Monaco language.
     * @param {string} mode - The view mode (json, text, markup, javascript, css, markdown, yaml, raw)
     * @param {string} contentType - The content-type header
     * @returns {string}
     */
    function viewModeToMonacoLanguage(mode, contentType) {
      switch (mode) {
        case 'json': return 'json';
        case 'markup': return (contentType || '').toLowerCase().includes('html') ? 'html' : 'xml';
        case 'javascript': return 'javascript';
        case 'css': return 'css';
        case 'markdown': return 'markdown';
        case 'yaml': return 'yaml';
        case 'grpc':
        case 'protobuf':
        case 'text':
        case 'raw':
        default: return 'plaintext';
      }
    }

    /**
     * Check if a view mode should use Monaco editor (vs HTML rendering).
     * @param {string} mode
     * @returns {boolean}
     */
    function isMonacoViewMode(mode) {
      return ['json', 'text', 'markup', 'javascript', 'css', 'markdown', 'yaml', 'grpc', 'protobuf', 'raw'].includes(mode);
    }

    /**
     * Track active Monaco editors for body panels (keyed by container element id).
     * @type {Object<string, object>}
     */
    const activeBodyEditors = {};
    const standaloneBodyViewers = {};
    const bodySchemaTypeOverrides = {};
    const PROTOBUF_SCHEMA_STORAGE_KEY = 'http-freekit-protobuf-schemas';

    // Format body in a specific view mode
    // Wrap formatted HTML string in line-numbered spans
    function updateProtobufSchemaStatus() {
      const el = document.getElementById('protobufSchemaStatus');
      if (!el) return;
      if (protobufSchemaError) {
        el.textContent = 'Error';
        el.title = protobufSchemaError;
        el.style.color = '#ce3939';
        return;
      }
      el.style.color = '';
      el.title = protobufSchemaFiles.map(f => f.name).join(', ');
      el.textContent = protobufSchemaFiles.length
        ? protobufSchemaFiles.length + ' file' + (protobufSchemaFiles.length === 1 ? '' : 's')
        : 'None';
    }

    function rebuildProtobufRoot() {
      protobufSchemaError = '';
      protobufRoot = null;
      if (!protobufSchemaFiles.length) {
        updateProtobufSchemaStatus();
        return;
      }
      if (!window.protobuf?.parse || !window.protobuf?.Root) {
        protobufSchemaError = 'protobufjs did not load';
        updateProtobufSchemaStatus();
        return;
      }

      try {
        const root = new window.protobuf.Root();
        for (const file of protobufSchemaFiles) {
          window.protobuf.parse(file.content, root, { keepCase: true, alternateCommentMode: true });
        }
        root.resolveAll();
        protobufRoot = root;
      } catch (err) {
        protobufSchemaError = err.message || String(err);
        protobufRoot = null;
      }
      updateProtobufSchemaStatus();
    }

    function loadProtobufSchemas() {
      try {
        const saved = safeLocalStorageGet(PROTOBUF_SCHEMA_STORAGE_KEY);
        protobufSchemaFiles = saved ? JSON.parse(saved) : [];
        if (!Array.isArray(protobufSchemaFiles)) protobufSchemaFiles = [];
      } catch {
        protobufSchemaFiles = [];
      }
      rebuildProtobufRoot();
    }

    function saveProtobufSchemas(nextSchemaFiles) {
      if (!safeLocalStorageSet(
        PROTOBUF_SCHEMA_STORAGE_KEY,
        JSON.stringify(nextSchemaFiles),
        false
      )) return false;
      protobufSchemaFiles = nextSchemaFiles;
      rebuildProtobufRoot();
      return true;
    }

    function refreshVisibleBodyViewers() {
      const req = document.getElementById('detailPanel')?._request;
      if (req && isSelectedTrafficRequest(req)) renderDetailCards(req);
      const sendViewer = standaloneBodyViewers.sendResBody;
      if (sendViewer) renderBodyViewer('sendResBody', sendViewer.body, sendViewer.contentType, sendViewer.mode || 'text', sendViewer.context || {});
    }

    async function importProtobufSchemas() {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.proto,text/plain';
      input.multiple = true;
      input.onchange = async (e) => {
        const files = Array.from(e.target.files || []);
        if (!files.length) return;
        try {
          const imported = [];
          for (const file of files) {
            imported.push({ name: file.name, content: await file.text() });
          }
          const byName = new Map(protobufSchemaFiles.map(file => [file.name, file]));
          for (const file of imported) byName.set(file.name, file);
          if (!saveProtobufSchemas(Array.from(byName.values()))) {
            toast(
              'Schema import failed: local storage is unavailable. Check storage permissions or free up space.',
              'error'
            );
            return;
          }
          if (protobufSchemaError) {
            toast('Schema import failed: ' + protobufSchemaError, 'error');
          } else {
            toast('Imported ' + imported.length + ' protobuf schema file' + (imported.length === 1 ? '' : 's'), 'success');
            refreshVisibleBodyViewers();
          }
        } catch (err) {
          toast('Schema import failed: ' + err.message, 'error');
        }
      };
      input.click();
    }

    function clearProtobufSchemas() {
      if (!safeLocalStorageRemove(PROTOBUF_SCHEMA_STORAGE_KEY, false)) {
        toast(
          'Could not clear protobuf schemas: local storage is unavailable. Check storage permissions or free up space.',
          'error'
        );
        return;
      }
      protobufSchemaFiles = [];
      protobufRoot = null;
      protobufSchemaError = '';
      for (const key of Object.keys(bodySchemaTypeOverrides)) delete bodySchemaTypeOverrides[key];
      updateProtobufSchemaStatus();
      refreshVisibleBodyViewers();
      toast('Protobuf schemas cleared', 'success');
    }

    function updateProtobufTypeSelect(elementId, mode, context = {}) {
      const select = document.getElementById(elementId + '-schema');
      if (!select) return;
      const schemaModes = mode === 'protobuf' || mode === 'grpc';
      const typeOptions = getProtobufTypeOptions();
      if (!schemaModes || !typeOptions.length) {
        select.style.display = 'none';
        select.innerHTML = '';
        return;
      }

      const inferred = mode === 'grpc'
        ? inferGrpcMessageType(context)
        : inferProtobufMessageType({ ...context, manualTypeName: null });
      const selected = bodySchemaTypeOverrides[elementId] || inferred?.fullName || '';
      const autoLabel = inferred?.fullName ? 'Auto: ' + inferred.fullName.replace(/^\./, '') : 'Auto';
      select.innerHTML = '<option value="">' + esc(autoLabel) + '</option>' +
        typeOptions.map(typeName => '<option value="' + esc(typeName) + '">' + esc(typeName.replace(/^\./, '')) + '</option>').join('');
      select.value = selected && typeOptions.includes(selected) ? selected : '';
      select.style.display = 'block';
    }

    function setProtobufBodyType(elementId, typeName, section) {
      if (typeName) {
        bodySchemaTypeOverrides[elementId] = typeName;
      } else {
        delete bodySchemaTypeOverrides[elementId];
      }

      const standalone = standaloneBodyViewers[elementId];
      if (standalone) {
        standalone.context = { ...(standalone.context || {}), manualTypeName: bodySchemaTypeOverrides[elementId] || null };
        renderBodyViewer(elementId, standalone.body, standalone.contentType, standalone.mode || 'protobuf', standalone.context);
        return;
      }

      const req = document.getElementById('detailPanel')?._request;
      if (!req) return;
      const effectiveReq = section === 'request' ? getEffectiveRequest(req) : req;
      const body = section === 'request' ? effectiveReq.requestBody : req.responseBody;
      const ct = section === 'request'
        ? getCombinedHeaderValue(effectiveReq.requestHeaders, 'content-type')
        : getCombinedHeaderValue(req.responseHeaders, 'content-type');
      const wrapper = document.getElementById(elementId);
      const mode = wrapper?.dataset.viewMode || (getBodyViewModes(body, ct)[0]?.value || 'protobuf');
      renderBodyViewer(elementId, body, ct, mode, {
        request: effectiveReq,
        section,
        manualTypeName: bodySchemaTypeOverrides[elementId] || null
      });
    }

    function collectProtobufTypes(namespace = protobufRoot, out = []) {
      if (!namespace?.nestedArray) return out;
      for (const child of namespace.nestedArray) {
        if (child.fieldsArray) out.push(child);
        collectProtobufTypes(child, out);
      }
      return out;
    }

    function getProtobufTypeOptions() {
      return collectProtobufTypes()
        .map(type => type.fullName || type.name)
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
    }

    function lookupProtobufType(typeName) {
      if (!protobufRoot || !typeName) return null;
      try { return protobufRoot.lookupType(typeName); } catch { return null; }
    }

    function inferGrpcMessageType(context = {}) {
      if (!protobufRoot || !context.request) return null;
      let pathname = context.request.path || '';
      if (!pathname && context.request.url) {
        try { pathname = new URL(context.request.url).pathname; } catch {}
      }
      const parts = String(pathname || '').replace(/^\/+/, '').split('/');
      if (parts.length < 2) return null;
      const serviceName = parts[0];
      const methodName = parts[1];

      try {
        const service = protobufRoot.lookupService(serviceName);
        const method = service?.methods?.[methodName];
        if (!method) return null;
        const resolved = context.section === 'request'
          ? method.resolvedRequestType
          : method.resolvedResponseType;
        if (resolved) return resolved;
        const typeName = context.section === 'request' ? method.requestType : method.responseType;
        return typeName ? protobufRoot.lookupType(typeName) : null;
      } catch {
        return null;
      }
    }

    function inferProtobufMessageType(context = {}) {
      const manualType = lookupProtobufType(context.manualTypeName);
      if (manualType) return manualType;
      const grpcType = inferGrpcMessageType(context);
      if (grpcType) return grpcType;
      if (!protobufRoot) return null;
      const types = collectProtobufTypes();
      return types.length === 1 ? types[0] : null;
    }

    function decodeWithProtobufType(bytes, type) {
      const message = type.decode(bytes);
      const object = type.toObject(message, {
        longs: String,
        enums: String,
        bytes: String,
        defaults: false,
        arrays: true,
        objects: true
      });
      return JSON.stringify(object, null, 2);
    }

    function headerValue(headers, name) {
      if (!headers) return '';
      const direct = headers[name] || headers[name.toLowerCase()];
      if (direct != null) return Array.isArray(direct) ? direct.join(', ') : String(direct);
      const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
      if (!entry) return '';
      return Array.isArray(entry[1]) ? entry[1].join(', ') : String(entry[1]);
    }

    function grpcEncodingForContext(context = {}) {
      const headers = context.section === 'request'
        ? context.request?.requestHeaders
        : context.request?.responseHeaders;
      const headerName = isConnectContentType(context.contentType)
        ? 'connect-content-encoding'
        : 'grpc-encoding';
      return headerValue(headers, headerName).toLowerCase().trim();
    }

    function decompressGrpcMessage(bytes, encoding) {
      if (!encoding || encoding === 'identity') return bytes;
      if (!window.pako) throw new Error('pako is not loaded');
      if (encoding === 'gzip') return window.pako.ungzip(bytes);
      if (encoding === 'deflate') return window.pako.inflate(bytes);
      throw new Error('unsupported grpc-encoding: ' + encoding);
    }

    function bodyToBytes(body, context = {}) {
      if (!body) return new Uint8Array();
      const request = context.request || {};
      const bodyEncoding = context.section === 'request'
        ? request.requestBodyEncoding
        : request.responseBodyEncoding;
      const dataUriMatch = String(body).match(/^data:([^;,]+(?:;[^,]*)?);base64,([A-Za-z0-9+/=\r\n]+)$/i);
      if (String(bodyEncoding || '').toLowerCase() === 'base64' && dataUriMatch) {
        const raw = atob(dataUriMatch[2].replace(/\s+/g, ''));
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
        return bytes;
      }
      return new TextEncoder().encode(String(body));
    }

    function readProtoVarint(bytes, offset) {
      let result = 0n;
      let shift = 0n;
      let pos = offset;
      while (pos < bytes.length && shift <= 63n) {
        const byte = bytes[pos++];
        result |= BigInt(byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) return { value: result, next: pos };
        shift += 7n;
      }
      throw new Error('Invalid varint at byte ' + offset);
    }

    function readFixed32(bytes, offset) {
      if (offset + 4 > bytes.length) throw new Error('Truncated fixed32 at byte ' + offset);
      return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
    }

    function readFixed64(bytes, offset) {
      if (offset + 8 > bytes.length) throw new Error('Truncated fixed64 at byte ' + offset);
      const low = BigInt(readFixed32(bytes, offset));
      const high = BigInt(readFixed32(bytes, offset + 4));
      return (high << 32n) | low;
    }

    function bytesToHexPreview(bytes, max = 48) {
      const shown = Array.from(bytes.slice(0, max)).map(b => b.toString(16).padStart(2, '0')).join(' ');
      return shown + (bytes.length > max ? ' ...' : '');
    }

    function tryDecodeUtf8(bytes) {
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (!text) return null;
        let printable = 0;
        for (const ch of text) {
          const code = ch.charCodeAt(0);
          if (code === 9 || code === 10 || code === 13 || code >= 32) printable++;
        }
        return printable / text.length > 0.9 ? text : null;
      } catch {
        return null;
      }
    }

    function decodeProtobufMessage(bytes, depth = 0) {
      const lines = [];
      let offset = 0;
      let fields = 0;
      const indent = '  '.repeat(depth);

      while (offset < bytes.length) {
        if (++fields > 500) {
          lines.push(indent + '... stopped after 500 fields');
          break;
        }

        const fieldOffset = offset;
        const tag = readProtoVarint(bytes, offset);
        offset = tag.next;
        const fieldNo = Number(tag.value >> 3n);
        const wireType = Number(tag.value & 7n);
        if (fieldNo <= 0) throw new Error('Invalid field number at byte ' + fieldOffset);

        if (wireType === 0) {
          const value = readProtoVarint(bytes, offset);
          offset = value.next;
          lines.push(`${indent}${fieldNo}: varint ${value.value.toString()}`);
        } else if (wireType === 1) {
          const value = readFixed64(bytes, offset);
          offset += 8;
          lines.push(`${indent}${fieldNo}: fixed64 ${value.toString()} (0x${value.toString(16)})`);
        } else if (wireType === 2) {
          const length = readProtoVarint(bytes, offset);
          offset = length.next;
          const size = Number(length.value);
          if (!Number.isSafeInteger(size) || offset + size > bytes.length) {
            throw new Error('Invalid length-delimited field at byte ' + fieldOffset);
          }
          const valueBytes = bytes.slice(offset, offset + size);
          offset += size;

          const text = tryDecodeUtf8(valueBytes);
          if (text !== null && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) {
            lines.push(`${indent}${fieldNo}: string ${JSON.stringify(text)}`);
          } else if (depth < 4 && valueBytes.length > 1) {
            try {
              const nested = decodeProtobufMessage(valueBytes, depth + 1);
              lines.push(`${indent}${fieldNo}: message (${size} bytes) {`);
              lines.push(nested);
              lines.push(`${indent}}`);
            } catch {
              lines.push(`${indent}${fieldNo}: bytes[${size}] ${bytesToHexPreview(valueBytes)}`);
            }
          } else {
            lines.push(`${indent}${fieldNo}: bytes[${size}] ${bytesToHexPreview(valueBytes)}`);
          }
        } else if (wireType === 5) {
          const value = readFixed32(bytes, offset);
          offset += 4;
          lines.push(`${indent}${fieldNo}: fixed32 ${value} (0x${value.toString(16)})`);
        } else {
          throw new Error('Unsupported protobuf wire type ' + wireType + ' at byte ' + fieldOffset);
        }
      }

      return lines.join('\n');
    }

    function decodeProtobufBody(body, context = {}) {
      const bytes = bodyToBytes(body, context);
      if (!bytes.length) return '';
      const type = inferProtobufMessageType(context);
      if (type) {
        try {
          return '# schema: ' + type.fullName + '\n' + decodeWithProtobufType(bytes, type);
        } catch (err) {
          try {
            return `Unable to decode with schema ${type.fullName}: ${err.message}\n\nWire format fallback:\n` + decodeProtobufMessage(bytes);
          } catch (wireErr) {
            return `Unable to decode with schema ${type.fullName}: ${err.message}\nUnable to decode protobuf wire format: ${wireErr.message}\n\nHex preview:\n` + bytesToHexPreview(bytes, 256);
          }
        }
      }
      try {
        return decodeProtobufMessage(bytes);
      } catch (err) {
        return 'Unable to decode protobuf wire format: ' + err.message + '\n\nHex preview:\n' + bytesToHexPreview(bytes, 256);
      }
    }

    function decodeGrpcBody(body, context = {}) {
      const bytes = bodyToBytes(body, context);
      if (!bytes.length) return '';
      const chunks = [];
      let offset = 0;
      let index = 0;
      const schemaType = inferGrpcMessageType(context);
      const manualType = lookupProtobufType(context.manualTypeName);
      const decodeType = manualType || schemaType;
      const grpcEncoding = grpcEncodingForContext(context);
      const isConnect = isConnectContentType(context.contentType);

      while (offset + 5 <= bytes.length) {
        const flags = bytes[offset];
        const compressed = (flags & 0x01) !== 0;
        const endStream = isConnect && (flags & 0x02) !== 0;
        const size = ((bytes[offset + 1] << 24) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 8) | bytes[offset + 4]) >>> 0;
        offset += 5;
        const validFlags = isConnect ? (flags & ~0x03) === 0 : (flags === 0 || flags === 1);
        if (offset + size > bytes.length || !validFlags) {
          return 'Unable to decode gRPC frames. Showing as protobuf payload instead.\n\n' + decodeProtobufBody(body, context);
        }

        let message = bytes.slice(offset, offset + size);
        offset += size;
        if (endStream) {
          const endStreamText = tryDecodeUtf8(message);
          chunks.push('end stream:');
          if (endStreamText !== null) {
            try {
              chunks.push(JSON.stringify(JSON.parse(endStreamText), null, 2));
            } catch {
              chunks.push(endStreamText);
            }
          } else {
            chunks.push('  hex: ' + bytesToHexPreview(message));
          }
          continue;
        }

        chunks.push(`message ${++index}: ${decodeType?.fullName || 'protobuf'} compressed=${compressed}${compressed && grpcEncoding ? ' encoding=' + grpcEncoding : ''} size=${size}`);
        if (compressed) {
          try {
            message = decompressGrpcMessage(message, grpcEncoding);
            chunks.push('  decompressed-size=' + message.length);
          } catch (err) {
            chunks.push('  unable to decompress gRPC message: ' + err.message);
            chunks.push('  hex: ' + bytesToHexPreview(message));
            continue;
          }
        }

        if (decodeType) {
          try {
            chunks.push(decodeWithProtobufType(message, decodeType));
          } catch (err) {
            chunks.push('  unable to decode with schema ' + decodeType.fullName + ': ' + err.message);
            chunks.push('  wire format fallback:');
            try {
              chunks.push(decodeProtobufMessage(message, 1));
            } catch (wireErr) {
              chunks.push('  unable to decode protobuf message: ' + wireErr.message);
              chunks.push('  hex: ' + bytesToHexPreview(message));
            }
          }
        } else {
          try {
            chunks.push(decodeProtobufMessage(message, 1));
          } catch (err) {
            chunks.push('  unable to decode protobuf message: ' + err.message);
            chunks.push('  hex: ' + bytesToHexPreview(message));
          }
        }
      }

      if (offset !== bytes.length) {
        chunks.push(`trailing bytes[${bytes.length - offset}]: ${bytesToHexPreview(bytes.slice(offset))}`);
      }

      return chunks.join('\n');
    }

    function beautifyMarkup(code) {
      if (!code || code.includes('\n')) return code;
      if (/<(?:script|style)\b/i.test(code)) return code;

      const voidTags = new Set([
        'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
        'meta', 'param', 'source', 'track', 'wbr'
      ]);
      const tokens = code.replace(/>\s*</g, '>\n<').split('\n').map(t => t.trim()).filter(Boolean);
      let indent = 0;

      return tokens.map(token => {
        const closing = /^<\//.test(token);
        const declaration = /^<!(?:--|doctype)|^<\?/i.test(token);
        const tagMatch = token.match(/^<\/?([a-zA-Z0-9:-]+)/);
        const tagName = tagMatch ? tagMatch[1].toLowerCase() : '';
        const selfClosing = /\/>$/.test(token) || voidTags.has(tagName);
        const sameLinePair = /^<([a-zA-Z0-9:-]+)\b[^>]*>.*<\/\1>$/.test(token);

        if (closing) indent = Math.max(0, indent - 1);
        const line = '  '.repeat(indent) + token;
        if (!closing && !declaration && !selfClosing && !sameLinePair && /^<[^/!?>]/.test(token)) {
          indent += 1;
        }
        return line;
      }).join('\n');
    }

    // Simple JS beautifier — adds newlines and indentation to minified code
    function beautifyJs(code) {
      if (!code || code.includes('\n')) return code; // already formatted

      let result = '';
      let indent = 0;
      let inString = false;
      let stringChar = '';
      let inComment = false;
      let inLineComment = false;
      let escaped = false;
      let inRegex = false;
      let lastNonSpace = '';

      for (let i = 0; i < code.length; i++) {
        const ch = code[i];
        const next = code[i + 1] || '';

        // Handle escape sequences inside strings
        if (escaped) { result += ch; escaped = false; continue; }
        if (ch === '\\' && (inString || inRegex)) { result += ch; escaped = true; continue; }

        // Handle strings
        if (inString) {
          result += ch;
          if (ch === stringChar) inString = false;
          continue;
        }

        // Handle comments
        if (inLineComment) {
          result += ch;
          if (ch === '\n') inLineComment = false;
          continue;
        }
        if (inComment) {
          result += ch;
          if (ch === '*' && next === '/') { result += '/'; i++; inComment = false; }
          continue;
        }

        // Handle regex
        if (inRegex) {
          result += ch;
          if (ch === '/') inRegex = false;
          continue;
        }

        // Start string
        if (ch === '"' || ch === "'" || ch === '`') {
          inString = true; stringChar = ch; result += ch; continue;
        }

        // Start comment
        if (ch === '/' && next === '/') { inLineComment = true; result += ch; continue; }
        if (ch === '/' && next === '*') { inComment = true; result += ch; continue; }

        // Start regex (heuristic: / after operator or start of statement)
        if (ch === '/' && '=(:;,([!&|?{}'.includes(lastNonSpace)) {
          inRegex = true; result += ch; continue;
        }

        // Formatting logic
        if (ch === '{') {
          result += ' {\n' + '  '.repeat(++indent);
          lastNonSpace = ch;
          continue;
        }
        if (ch === '}') {
          indent = Math.max(0, indent - 1);
          result = result.replace(/\s+$/, '');
          result += '\n' + '  '.repeat(indent) + '}';
          // Add newline after } unless followed by else, catch, finally, comma, semicolon, or closing paren
          const afterClose = code.slice(i + 1).match(/^\s*(\S)/);
          if (afterClose && !',;)].'.includes(afterClose[1]) && afterClose[1] !== 'e' && afterClose[1] !== 'c' && afterClose[1] !== 'f') {
            result += '\n' + '  '.repeat(indent);
          }
          lastNonSpace = ch;
          continue;
        }
        if (ch === ';') {
          result += ';\n' + '  '.repeat(indent);
          lastNonSpace = ch;
          continue;
        }

        if (ch !== ' ' && ch !== '\t') lastNonSpace = ch;
        result += ch;
      }

      // Clean up excessive blank lines
      return result.replace(/\n{3,}/g, '\n\n').replace(/\n\s+\n/g, '\n\n').trim();
    }

    // Simple CSS beautifier
    function beautifyCss(code) {
      if (!code || code.includes('\n')) return code;

      let result = '';
      let indent = 0;

      for (let i = 0; i < code.length; i++) {
        const ch = code[i];
        if (ch === '{') {
          result += ' {\n' + '  '.repeat(++indent);
        } else if (ch === '}') {
          indent = Math.max(0, indent - 1);
          result = result.replace(/\s+$/, '');
          result += '\n' + '  '.repeat(indent) + '}\n' + '  '.repeat(indent);
        } else if (ch === ';') {
          result += ';\n' + '  '.repeat(indent);
        } else {
          result += ch;
        }
      }

      return result.replace(/\n{3,}/g, '\n\n').trim();
    }

    function wrapWithLineNumbers(html) {
      const lines = html.split('\n');
      if (lines.length < 2) return html;

      // Track open spans across lines so multi-line syntax spans don't break layout.
      // At each line break, close any open <span> tags and re-open them on the next line.
      let openSpans = []; // stack of full <span ...> opening tags
      return lines.map(line => {
        // Prepend any spans that were open from previous line
        let prefix = openSpans.join('');
        let suffix = '</span>'.repeat(openSpans.length);

        // Now scan this line's content to update the open span stack
        const tagRe = /<span\s[^>]*>|<\/span>/g;
        let m;
        // Work on the raw line content (before prefix/suffix)
        while ((m = tagRe.exec(line)) !== null) {
          if (m[0].startsWith('</')) {
            openSpans.pop();
          } else {
            openSpans.push(m[0]);
          }
        }

        // Close spans carried from previous line, render the line, re-open for next
        return '<span class="body-line">' + prefix + (line || ' ') + suffix + '</span>';
      }).join('');
    }

    function escapeHtmlAttribute(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }

    function getSafeImageDataUri(body) {
      const match = /^data:(image\/[!#$%&'*+\-.^_`|~0-9A-Za-z]+);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(String(body));
      if (!match || match[2].length % 4 !== 0) return '';
      return `data:${match[1].toLowerCase()};base64,${match[2]}`;
    }

    function formatBodyAs(body, contentType, mode, context = {}) {
      if (!body) return '<span style="color:var(--text-watermark);">Empty</span>';
      if (body.startsWith('[Binary data:')) return '<span style="color:var(--text-watermark);">' + esc(body) + '</span>';

      switch (mode) {
        case 'image': {
          const safeImageDataUri = getSafeImageDataUri(body);
          if (safeImageDataUri) {
            return '<div style="display:flex;align-items:center;justify-content:center;padding:20px;background:var(--bg-lowlight);border-radius:4px;">' +
              '<img src="' + escapeHtmlAttribute(safeImageDataUri) + '" style="max-width:100%;max-height:60vh;object-fit:contain;border-radius:4px;box-shadow:0 2px 10px rgba(0,0,0,0.3);" alt="Response image">' +
              '</div>';
          }
          return '<span style="color:var(--text-watermark);">[Image data not available]</span>';
        }
        case 'decoded': {
          // URL-encoded key/value pairs — no line numbers (has its own layout)
          try {
            const params = new URLSearchParams(body);
            let html = '<div class="url-decoded-params">';
            for (const [key, value] of params) {
              html += '<div class="url-decoded-row">';
              const dk = esc(key);
              const dv = esc(value);
              html += '<div class="url-decoded-key"><div class="url-decoded-label">Name <button class="url-decoded-copy" onclick="navigator.clipboard.writeText(this.closest(\'.url-decoded-key\').querySelector(\'.url-decoded-value\').textContent).then(()=>toast(\'Copied\',\'success\'))" title="Copy name">&#128203;</button></div><div class="url-decoded-value">' + dk + '</div></div>';
              html += '<div class="url-decoded-val"><div class="url-decoded-label">Value <button class="url-decoded-copy" onclick="navigator.clipboard.writeText(this.closest(\'.url-decoded-val\').querySelector(\'.url-decoded-value\').textContent).then(()=>toast(\'Copied\',\'success\'))" title="Copy value">&#128203;</button></div><div class="url-decoded-value">' + dv + '</div></div>';
              html += '</div>';
            }
            html += '</div>';
            return html;
          } catch {
            return esc(body);
          }
        }
        case 'json': {
          try {
            const parsed = JSON.parse(body);
            return wrapWithLineNumbers(syntaxHighlightJson(JSON.stringify(parsed, null, 2)));
          } catch {
            return wrapWithLineNumbers(esc(body));
          }
        }
        case 'markup': {
          return wrapWithLineNumbers(syntaxHighlightXml(beautifyMarkup(body)));
        }
        case 'javascript': {
          return wrapWithLineNumbers(syntaxHighlightJs(esc(beautifyJs(body))));
        }
        case 'css': {
          return wrapWithLineNumbers(syntaxHighlightCss(esc(beautifyCss(body))));
        }
        case 'grpc': {
          return wrapWithLineNumbers(esc(decodeGrpcBody(body, context)));
        }
        case 'protobuf': {
          return wrapWithLineNumbers(esc(decodeProtobufBody(body, context)));
        }
        case 'hex': {
          // Hex already has its own offset column — no extra line numbers
          return textToHex(body, context);
        }
        case 'raw':
          return wrapWithLineNumbers(esc(body));
        case 'text':
        default:
          return wrapWithLineNumbers(esc(body));
      }
    }

    /**
     * Dispose an active Monaco editor for a body panel.
     * @param {string} containerId
     */
    function disposeBodyEditor(containerId) {
      disposeMonacoContainer(containerId);
    }

    /**
     * Get the appropriate body content for Monaco (pretty-printed for JSON).
     * @param {string} body
     * @param {string} mode
     * @returns {string}
     */
    function getMonacoBodyValue(body, mode, context = {}) {
      if (mode === 'json') {
        try {
          return JSON.stringify(JSON.parse(body), null, 2);
        } catch {
          return body;
        }
      }
      if (mode === 'javascript') return beautifyJs(body);
      if (mode === 'css') return beautifyCss(body);
      if (mode === 'markup') return beautifyMarkup(body);
      if (mode === 'grpc') return decodeGrpcBody(body, context);
      if (mode === 'protobuf') return decodeProtobufBody(body, context);
      return body;
    }

    /**
     * Initialize a Monaco editor inside a response/request body container.
     * @param {string} containerId - The id of the Monaco container div
     * @param {string} body - The raw body text
     * @param {string} contentType - The content-type header
     * @param {string} mode - The current view mode
     */
    async function initBodyMonacoEditor(containerId, body, contentType, mode, context = {}) {
      disposeBodyEditor(containerId);

      const container = document.getElementById(containerId);
      if (!container) return null;

      const language = viewModeToMonacoLanguage(mode, contentType);
      const value = getMonacoBodyValue(body, mode, { ...context, contentType });

      const editor = await createMonacoEditor(containerId, {
        value: value,
        language: language,
        readOnly: true,
        minimap: false,
        lineNumbers: true,
        wordWrap: 'on',
        folding: true,
      });

      if (!editor) return null;
      if (!isMonacoEditorCurrent(containerId, editor)) {
        disposeMonacoEditor(editor);
        return null;
      }
      activeBodyEditors[containerId] = editor;

      try {
        // Auto-size editor height based on content (capped at 70vh)
        const lineCount = editor.getModel().getLineCount();
        const lineHeight = 18;
        const padding = 16;
        const maxHeight = Math.round(window.innerHeight * 0.7);
        const desiredHeight = Math.min(Math.max(lineCount * lineHeight + padding, 80), maxHeight);
        container.style.height = desiredHeight + 'px';
        return editor;
      } catch (error) {
        console.warn('[Monaco] Body editor initialization failed; using fallback viewer', error);
        disposeMonacoEditor(editor);
        return null;
      }
    }

    function renderBodyViewer(elementId, body, contentType, mode, context = {}) {
      const wrapper = document.getElementById(elementId);
      if (!wrapper) return;
      const ct = contentType || '';
      const renderContext = { ...context, manualTypeName: bodySchemaTypeOverrides[elementId] || context.manualTypeName || null };
      wrapper.dataset.viewMode = mode;

      const monacoId = elementId + '-monaco';
      const fallbackId = elementId + '-fallback';
      updateProtobufTypeSelect(elementId, mode, renderContext);

      // Both request and response body use Monaco for text-based modes
      if (isMonacoViewMode(mode) && body && !body.startsWith('[Binary data:')) {
        const monacoEl = document.getElementById(monacoId);
        const fallbackEl = document.getElementById(fallbackId);
        // Keep a complete viewer visible until editor creation has actually succeeded.
        if (monacoEl) monacoEl.style.display = 'none';
        if (fallbackEl) {
          fallbackEl.style.display = 'block';
          fallbackEl.innerHTML = formatBodyAs(body, ct, mode, renderContext);
        }

        initBodyMonacoEditor(monacoId, body, ct, mode, renderContext).then(editor => {
          if (!editor || !isMonacoEditorCurrent(monacoId, editor) ||
              document.getElementById(elementId) !== wrapper || wrapper.dataset.viewMode !== mode) {
            disposeMonacoEditor(editor);
            return;
          }
          if (monacoEl) monacoEl.style.display = 'block';
          if (fallbackEl) fallbackEl.style.display = 'none';
          editor.layout();
        }).catch(error => {
          console.warn('[Monaco] Body editor failed; keeping fallback viewer', error);
        });
      } else {
        // Dispose any active Monaco editor
        const monacoId2 = elementId + '-monaco';
        disposeBodyEditor(monacoId2);

        const monacoEl = document.getElementById(monacoId);
        const fallbackEl = document.getElementById(fallbackId);
        if (monacoEl) monacoEl.style.display = 'none';

        if (fallbackEl) {
          fallbackEl.style.display = 'block';
          fallbackEl.innerHTML = formatBodyAs(body, ct, mode, renderContext);
        } else {
          // Fallback for request body or old-style rendering
          wrapper.dataset.viewMode = mode;
          wrapper.innerHTML = formatBodyAs(body, ct, mode, renderContext);
        }
      }
    }

    // Switch body view mode — re-renders the body content (Monaco for text modes, HTML for hex/decoded/image)
    function switchBodyView(elementId, mode, section) {
      const standalone = standaloneBodyViewers[elementId];
      if (standalone) {
        standalone.mode = mode;
        renderBodyViewer(elementId, standalone.body, standalone.contentType, mode, standalone.context || {});
        return;
      }

      const req = document.getElementById('detailPanel')?._request;
      if (!req) return;

      const effectiveReq = section === 'request' ? getEffectiveRequest(req) : req;
      const body = section === 'request' ? effectiveReq.requestBody : req.responseBody;
      const ct = section === 'request'
        ? getCombinedHeaderValue(effectiveReq.requestHeaders, 'content-type')
        : getCombinedHeaderValue(req.responseHeaders, 'content-type');

      renderBodyViewer(elementId, body, ct, mode, { request: effectiveReq, section });
    }

    function setStandaloneBodyViewer(elementId, body, contentType, modeSelectId, selectedMode, context = {}) {
      const modes = getBodyViewModes(body, contentType);
      const mode = selectedMode && modes.some(m => m.value === selectedMode)
        ? selectedMode
        : (modes[0]?.value || 'text');
      standaloneBodyViewers[elementId] = { body, contentType, mode, context };

      const select = document.getElementById(modeSelectId);
      if (select) {
        select.innerHTML = modes.map(m => '<option value="' + m.value + '">' + m.label + '</option>').join('');
        select.value = mode;
        select.style.display = modes.length > 1 ? 'block' : 'none';
      }

      renderBodyViewer(elementId, body, contentType, mode, context);
    }

    function syntaxHighlightJson(json) {
      // Single-pass tokenizer for JSON — avoids corrupting spans inside spans
      const escaped = esc(json);
      let result = '';
      let i = 0;
      while (i < escaped.length) {
        // Key string (followed by colon)
        const keyMatch = escaped.substring(i).match(/^("(?:\\.|[^"\\])*")\s*:/);
        if (keyMatch) {
          result += '<span style="color:#e1421f;">' + keyMatch[1] + '</span>:';
          i += keyMatch[0].length;
          continue;
        }
        // Value string (after colon+space)
        const strMatch = escaped.substring(i).match(/^("(?:\\.|[^"\\])*")/);
        if (strMatch) {
          result += '<span style="color:#4caf7d;">' + strMatch[1] + '</span>';
          i += strMatch[0].length;
          continue;
        }
        // Boolean
        const boolMatch = escaped.substring(i).match(/^(true|false)\b/);
        if (boolMatch) {
          result += '<span style="color:#ff8c38;">' + boolMatch[1] + '</span>';
          i += boolMatch[0].length;
          continue;
        }
        // Null
        const nullMatch = escaped.substring(i).match(/^(null)\b/);
        if (nullMatch) {
          result += '<span style="color:#818490;">' + nullMatch[1] + '</span>';
          i += nullMatch[0].length;
          continue;
        }
        // Number
        const numMatch = escaped.substring(i).match(/^(-?\d+\.?\d*(?:e[+-]?\d+)?)\b/);
        if (numMatch) {
          result += '<span style="color:#5a80cc;">' + numMatch[1] + '</span>';
          i += numMatch[0].length;
          continue;
        }
        result += escaped[i];
        i++;
      }
      return result;
    }

    function syntaxHighlightXml(xml) {
      const escaped = esc(xml);

      // First, extract and separately highlight <script> and <style> blocks
      let result = escaped;

      // Highlight <script>...</script> contents as JS
      result = result.replace(
        /(&lt;script(?:[^&]|&(?!lt;\/script))*&gt;)([\s\S]*?)(&lt;\/script&gt;)/gi,
        (m, open, content, close) => {
          return highlightHtmlTag(open) + syntaxHighlightJs(content) + highlightHtmlTag(close);
        }
      );

      // Highlight <style>...</style> contents as CSS
      result = result.replace(
        /(&lt;style(?:[^&]|&(?!lt;\/style))*&gt;)([\s\S]*?)(&lt;\/style&gt;)/gi,
        (m, open, content, close) => {
          return highlightHtmlTag(open) + syntaxHighlightCss(content) + highlightHtmlTag(close);
        }
      );

      // Now highlight remaining HTML tags (but not already-highlighted script/style tags)
      // Match opening/closing tags with attributes
      result = result.replace(
        /&lt;(\/?)([\w:-]+)((?:\s+[\s\S]*?)?)(\/?)\s*&gt;/g,
        (match, slash, tag, attrs, selfClose) => {
          // Skip if this is inside an already-highlighted span
          if (match.includes('style="color:')) return match;
          const highlightedAttrs = attrs.replace(
            /([\w:-]+)(=)(&quot;(?:[^&]|&(?!quot;))*&quot;|&#39;(?:[^&]|&(?!#39;))*&#39;|\S+)/g,
            '<span style="color:#ff8c38;">$1</span>$2<span style="color:#4caf7d;">$3</span>'
          ).replace(
            // Boolean attributes (no value)
            /\s([\w:-]+)(?=\s|$|\/)/g,
            ' <span style="color:#ff8c38;">$1</span>'
          );
          return '&lt;' + slash + '<span style="color:#e1421f;">' + tag + '</span>' + highlightedAttrs + selfClose + '&gt;';
        }
      );

      // Comments
      result = result.replace(
        /&lt;!--[\s\S]*?--&gt;/g,
        m => '<span style="color:#818490;">' + m + '</span>'
      );

      // DOCTYPE
      result = result.replace(
        /&lt;!DOCTYPE[^&]*&gt;/gi,
        m => '<span style="color:#818490;">' + m + '</span>'
      );

      // Entities like &amp; &lt; etc in text content
      result = result.replace(
        /&amp;[\w#]+;/g,
        m => '<span style="color:#6e40aa;">' + m + '</span>'
      );

      return result;
    }

    function highlightHtmlTag(tag) {
      return tag.replace(
        /&lt;(\/?)([\w:-]+)([\s\S]*?)&gt;/,
        (m, slash, name, attrs) => {
          const highlightedAttrs = attrs.replace(
            /([\w:-]+)(=)(&quot;(?:[^&]|&(?!quot;))*&quot;|&#39;(?:[^&]|&(?!#39;))*&#39;|\S+)/g,
            '<span style="color:#ff8c38;">$1</span>$2<span style="color:#4caf7d;">$3</span>'
          );
          return '&lt;' + slash + '<span style="color:#e1421f;">' + name + '</span>' + highlightedAttrs + '&gt;';
        }
      );
    }

    // Single-pass regex highlighter using one combined regex per language.
    // Uses alternation groups — the first match wins, preventing double-highlighting.

    const JS_HIGHLIGHT_RE = /(&quot;(?:[^&]|&(?!quot;))*&quot;|&#39;(?:[^&]|&(?!#39;))*&#39;|`[^`]*`)|(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(?<![.\w$])(var|let|const|function|return|if|else|for|while|do|switch|case|break|continue|new|this|class|extends|import|export|default|from|async|await|try|catch|finally|throw|typeof|instanceof|of|delete|void|yield)(?![\w$])|(?<![.\w$])(true|false|null|undefined|NaN|Infinity)(?![\w$])|(0x[0-9a-fA-F]+|\b\d+\.?\d*(?:e[+-]?\d+)?\b)|([a-zA-Z_$][\w$]*)(?=\s*\()/g;

    const CSS_HIGHLIGHT_RE = /(\/\*[\s\S]*?\*\/)|(&quot;[^&]*&quot;|&#39;[^&]*&#39;)|(#[0-9a-fA-F]{3,8})\b|(!important)|(@[\w-]+)|\b(\d+\.?\d*(?:px|em|rem|%|vh|vw|vmin|vmax|s|ms|deg|fr|ch|ex|pt|cm|mm|in))\b|\b(\d+\.?\d*)\b/g;

    function syntaxHighlightJs(code) {
      if (!code || !code.trim()) return code;
      // Skip highlighting for very large single-line content (minified) — too slow and messy
      if (code.length > 5000 && !code.includes('\n')) return code;
      return code.replace(JS_HIGHLIGHT_RE, function(m, str, comment, kw, builtin, num, func) {
        if (str) return '<span style="color:#4caf7d;">' + str + '</span>';
        if (comment) return '<span style="color:#818490;">' + comment + '</span>';
        if (kw) return '<span style="color:#6e40aa;">' + kw + '</span>';
        if (builtin) return '<span style="color:#ff8c38;">' + builtin + '</span>';
        if (num) return '<span style="color:#5a80cc;">' + num + '</span>';
        if (func) return '<span style="color:#2fb4e0;">' + func + '</span>';
        return m;
      });
    }

    function syntaxHighlightCss(code) {
      if (!code || !code.trim()) return code;
      if (code.length > 5000 && !code.includes('\n')) return code;
      return code.replace(CSS_HIGHLIGHT_RE, function(m, comment, str, hex, imp, atrule, numunit, num) {
        if (comment) return '<span style="color:#818490;">' + comment + '</span>';
        if (str) return '<span style="color:#4caf7d;">' + str + '</span>';
        if (hex) return '<span style="color:#4caf7d;">' + hex + '</span>';
        if (imp) return '<span style="color:#ce3939;">' + imp + '</span>';
        if (atrule) return '<span style="color:#6e40aa;">' + atrule + '</span>';
        if (numunit) return '<span style="color:#ff8c38;">' + numunit + '</span>';
        if (num) return '<span style="color:#5a80cc;">' + num + '</span>';
        return m;
      });
    }

    function toggleHexView(elementId) {
      const el = document.getElementById(elementId);
      if (!el) return;
      if (el.dataset.viewMode === 'hex') {
        el.dataset.viewMode = 'text';
        el.innerHTML = el.dataset.originalHtml;
      } else {
        el.dataset.viewMode = 'hex';
        el.dataset.originalHtml = el.innerHTML;
        const text = el.textContent;
        el.innerHTML = textToHex(text);
      }
    }

    function textToHex(text, context = {}) {
      const bytes = bodyToBytes(text, context);
      let result = '';
      for (let i = 0; i < bytes.length; i += 16) {
        const hex = [];
        const ascii = [];
        for (let j = 0; j < 16; j++) {
          if (i + j < bytes.length) {
            hex.push(bytes[i + j].toString(16).padStart(2, '0'));
            const ch = bytes[i + j];
            ascii.push(ch >= 32 && ch < 127 ? String.fromCharCode(ch) : '.');
          } else {
            hex.push('  ');
            ascii.push(' ');
          }
        }
        const offset = '<span style="color:var(--text-watermark);">' + i.toString(16).padStart(8, '0') + '</span>';
        const hexStr = '<span style="color:#5a80cc;">' + hex.join(' ') + '</span>';
        const asciiStr = '<span style="color:#4caf7d;">' + esc(ascii.join('')) + '</span>';
        result += offset + '  ' + hexStr + '  ' + asciiStr + '\n';
      }
      return result;
    }

    // ============ INTERCEPTORS ============
    async function loadInterceptors() {
      try {
        const res = await fetch(`${API_BASE}/api/interceptors`);
        const data = await res.json();
        renderInterceptors(data.interceptors);
      } catch (err) {
        console.error('Failed to load interceptors:', err);
      }
    }

    const NODE_ENV_PROXY_SUPPORT_NOTE = 'Built-in node:http and node:https proxying requires Node.js 22.21.0+ or 24.5.0+; older Node.js versions need an explicit proxy agent.';

    const INTERCEPTOR_ICONS = {
      chrome: '<svg viewBox="0 0 24 24" width="36" height="36"><circle cx="12" cy="12" r="10" fill="none" stroke="#1da462" stroke-width="1.5"/><circle cx="12" cy="12" r="4" fill="#1da462"/><path d="M12 2a10 10 0 0 1 8.66 5h-5.66" stroke="#1da462" stroke-width="1.5" fill="none"/></svg>',
      'existing-chrome': '<svg viewBox="0 0 24 24" width="36" height="36"><circle cx="12" cy="12" r="10" fill="none" stroke="#1da462" stroke-width="1.5"/><circle cx="12" cy="12" r="4" fill="#1da462"/><circle cx="19" cy="5" r="4.5" fill="var(--bg-main)" stroke="#1da462" stroke-width="1"/><circle cx="19" cy="5" r="2.5" fill="none" stroke="#1da462" stroke-width="1"/><line x1="17.5" y1="6.5" x2="21" y2="3" stroke="#1da462" stroke-width="1"/></svg>',
      firefox: '<svg viewBox="0 0 24 24" width="36" height="36"><circle cx="12" cy="12" r="10" fill="none" stroke="#e66000" stroke-width="1.5"/><circle cx="12" cy="12" r="4" fill="#e66000"/><path d="M5 6c2-3 7-4 10-2" stroke="#e66000" stroke-width="1.5" fill="none"/></svg>',
      edge: '<svg viewBox="0 0 24 24" width="36" height="36"><circle cx="12" cy="12" r="10" fill="none" stroke="#2c75be" stroke-width="1.5"/><circle cx="12" cy="12" r="4" fill="#2c75be"/></svg>',
      brave: '<svg viewBox="0 0 24 24" width="36" height="36"><path d="M12 2L4 6v6c0 5.55 3.84 10.74 8 12 4.16-1.26 8-6.45 8-12V6l-8-4z" fill="none" stroke="#fb542b" stroke-width="1.5"/><circle cx="12" cy="11" r="3" fill="#fb542b"/></svg>',
      'fresh-terminal': '<svg viewBox="0 0 24 24" width="36" height="36"><rect x="3" y="3" width="18" height="18" rx="2" fill="none" stroke="#4caf7d" stroke-width="1.5"/><polyline points="7 8 10 11 7 14" stroke="#4caf7d" stroke-width="1.5" fill="none"/><line x1="12" y1="14" x2="17" y2="14" stroke="#4caf7d" stroke-width="1.5"/></svg>',
      'existing-terminal': '<svg viewBox="0 0 24 24" width="36" height="36"><rect x="3" y="3" width="18" height="18" rx="2" fill="none" stroke="#888" stroke-width="1.5"/><polyline points="7 8 10 11 7 14" stroke="#888" stroke-width="1.5" fill="none"/><line x1="12" y1="14" x2="17" y2="14" stroke="#888" stroke-width="1.5"/></svg>',
      'system-proxy': '<svg viewBox="0 0 24 24" width="36" height="36"><rect x="2" y="3" width="20" height="14" rx="2" fill="none" stroke="#9a9da8" stroke-width="1.5"/><line x1="8" y1="21" x2="16" y2="21" stroke="#9a9da8" stroke-width="1.5"/><line x1="12" y1="17" x2="12" y2="21" stroke="#9a9da8" stroke-width="1.5"/><circle cx="12" cy="10" r="3" fill="none" stroke="#9a9da8" stroke-width="1.5"/></svg>',
      'docker': '<svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="#2fb4e0" stroke-width="1.5"><rect x="3" y="11" width="4" height="4" rx="0.5"/><rect x="8" y="11" width="4" height="4" rx="0.5"/><rect x="13" y="11" width="4" height="4" rx="0.5"/><rect x="8" y="6" width="4" height="4" rx="0.5"/><rect x="13" y="6" width="4" height="4" rx="0.5"/><path d="M2 13c0 0 1-5 10-5s10 5 10 5" stroke-width="1"/></svg>',
      'electron': '<svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="#47848f" stroke-width="1.5"><circle cx="12" cy="12" r="3"/><ellipse cx="12" cy="12" rx="10" ry="4"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(120 12 12)"/></svg>',
      'android-adb': '<svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="#78c257" stroke-width="1.5"><rect x="6" y="2" width="12" height="20" rx="2"/><line x1="10" y1="18" x2="14" y2="18"/><line x1="9" y1="6" x2="15" y2="6"/></svg>',
      'jvm': '<svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="#e76f00" stroke-width="1.5"><path d="M8 17c0 0 1.5 2 4 2s4-2 4-2"/><path d="M9 11c0 0-3 2-3 5 0 2 1.5 4 6 4s6-2 6-4c0-3-3-5-3-5"/><path d="M12 3c-1 0-2 1-2 2.5C10 7.5 12 9 12 9s2-1.5 2-3.5C14 4 13 3 12 3z"/><line x1="12" y1="9" x2="12" y2="15"/></svg>'
    };

    const INTERCEPTOR_DESCRIPTIONS = {
      chrome: ['Intercept a fresh independent Chrome window.', 'Separate from your normal browser profile, with a clean slate.'],
      'existing-chrome': ['Intercept your main Chrome profile globally.', 'Your browser needs to be restarted to enable interception. May interfere with existing browsing.'],
      firefox: ['Intercept a fresh independent Firefox window.', 'Uses a separate temporary profile.'],
      edge: ['Intercept a fresh independent Edge window.', 'Separate from your normal browser profile.'],
      brave: ['Intercept a fresh independent Brave window.', 'Uses a separate temporary profile.'],
      'fresh-terminal': ['Intercept host commands and processes launched from a new terminal.', `Sets proxy and certificate environment variables; use the Docker interceptor for container traffic. ${NODE_ENV_PROXY_SUPPORT_NOTE}`],
      'existing-terminal': ['Configure future processes in an existing terminal window.', `Instructions only: unset the variables or close that shell to stop. ${NODE_ENV_PROXY_SUPPORT_NOTE}`],
      'system-proxy': ['Intercept HTTP traffic from Windows apps using system proxy settings.', 'Configures current-user WinINet and machine WinHTTP; apps with custom proxy settings may bypass it. Administrator permission may be required.'],
      'docker': ['Intercept traffic from Docker containers.', `Set proxy environment variables when running containers. ${NODE_ENV_PROXY_SUPPORT_NOTE}`],
      'electron': ['Launch an Electron application with traffic intercepted.', `Uses proxy routing plus system trust or a FreeKit-CA-only renderer trust flag. ${NODE_ENV_PROXY_SUPPORT_NOTE}`],
      'android-adb': ['Intercept traffic from an Android device connected via ADB.', 'Uses the companion VPN app for HTTPS, with an HTTP-only global proxy fallback.'],
      'jvm': ['Attach to a running JVM process to intercept HTTP traffic.', 'Sets proxy system properties via the Java Attach API.']
    };

    const INTERCEPTOR_COLORS = {
      chrome: '#1da462',
      'existing-chrome': '#1da462',
      firefox: '#e66000',
      edge: '#2c75be',
      brave: '#fb542b',
      'fresh-terminal': '#4caf7d',
      'existing-terminal': '#888',
      'system-proxy': '#9a9da8',
      'docker': '#2fb4e0',
      'electron': '#47848f',
      'android-adb': '#78c257',
      'jvm': '#e76f00',
      'manual-setup': '#4caf7d'
    };

    // Download URLs for browsers that aren't installed
    const BROWSER_DOWNLOAD_URLS = {
      chrome: 'https://www.google.com/chrome/',
      firefox: 'https://www.mozilla.org/firefox/new/',
      edge: 'https://www.microsoft.com/edge/download',
      brave: 'https://brave.com/download/',
    };

    function downloadBrowser(id, name) {
      const url = BROWSER_DOWNLOAD_URLS[id];
      if (!url) return;
      interceptorSelectionGeneration++;
      if (confirm(`${name} is not installed. Would you like to download it now?`)) {
        window.open(url, '_blank');
        toast(`Opening ${name} download page...`, 'success');
      }
    }

    // Tags for search filtering (matching HTTP Toolkit's tag-based filtering)
    const INTERCEPTOR_TAGS = {
      chrome: ['browsers', 'web', 'google'],
      'existing-chrome': ['browsers', 'web', 'google'],
      firefox: ['browsers', 'web', 'mozilla'],
      edge: ['browsers', 'web', 'microsoft'],
      brave: ['browsers', 'web'],
      'fresh-terminal': ['terminal', 'cli', 'node', 'python'],
      'existing-terminal': ['terminal', 'cli', 'node', 'python'],
      'system-proxy': ['system', 'global', 'machine'],
      'docker': ['docker', 'container', 'devops', 'virtualization'],
      'electron': ['electron', 'desktop', 'app', 'application'],
      'android-adb': ['android', 'adb', 'mobile', 'phone', 'device'],
      'jvm': ['java', 'jvm', 'kotlin', 'scala', 'gradle', 'maven', 'spring']
    };

    // Icon for the "Anything" / manual-setup card
    const MANUAL_SETUP_ICON = '<svg viewBox="0 0 24 24" width="36" height="36"><circle cx="12" cy="12" r="10" fill="none" stroke="#4caf7d" stroke-width="1.5"/><line x1="12" y1="8" x2="12" y2="16" stroke="#4caf7d" stroke-width="1.5"/><line x1="8" y1="12" x2="16" y2="12" stroke="#4caf7d" stroke-width="1.5"/></svg>';

    let allInterceptors = [];
    let interceptorsInProgress = new Set();
    let expandedInterceptorId = null;
    let expandedInterceptorMetadata = null;
    let interceptorSelectionGeneration = 0;
    const interceptorOperationGenerations = new Map();
    const androidHostIpSelections = new Map();
    let electronAppPathDraft = '';

    function beginInterceptorOperation(id) {
      const operationGeneration = (interceptorOperationGenerations.get(id) || 0) + 1;
      interceptorOperationGenerations.set(id, operationGeneration);
      return {
        id,
        operationGeneration,
        selectionGeneration: interceptorSelectionGeneration
      };
    }

    function isCurrentInterceptorOperation(operation, requireExpandedCard = true) {
      return interceptorOperationGenerations.get(operation.id) === operation.operationGeneration &&
        operation.selectionGeneration === interceptorSelectionGeneration &&
        (!requireExpandedCard || expandedInterceptorId === operation.id);
    }

    // Interceptors that have expandable config components
    const EXPANDABLE_INTERCEPTORS = new Set(['docker', 'existing-terminal', 'electron', 'android-adb', 'jvm']);

    const ANDROID_INTERCEPTOR_SUMMARY_FIELDS = [
      'interceptionActive',
      'interceptionDeviceCount',
      'activationUncertain',
      'uncertainDeviceCount',
      'cleanupPending',
      'cleanupDeviceCount'
    ];

    function getAndroidSummaryFields(value) {
      const fields = {};
      for (const field of ANDROID_INTERCEPTOR_SUMMARY_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(value || {}, field)) fields[field] = value[field];
      }
      return fields;
    }

    function getAndroidInterceptorSummary(interceptor) {
      const hasSummary = ANDROID_INTERCEPTOR_SUMMARY_FIELDS.some(
        field => Object.prototype.hasOwnProperty.call(interceptor || {}, field)
      );
      if (!hasSummary) {
        return {
          interceptionActive: interceptor?.active === true,
          interceptionDeviceCount: interceptor?.active === true ? 1 : 0,
          activationUncertain: false,
          uncertainDeviceCount: 0,
          cleanupPending: false,
          cleanupDeviceCount: 0
        };
      }

      const count = (field, enabled) => Number.isInteger(interceptor?.[field]) && interceptor[field] >= 0
        ? interceptor[field]
        : enabled ? 1 : 0;
      const interceptionActive = interceptor?.interceptionActive === true;
      const activationUncertain = interceptor?.activationUncertain === true;
      const cleanupPending = interceptor?.cleanupPending === true;
      return {
        interceptionActive,
        interceptionDeviceCount: count('interceptionDeviceCount', interceptionActive),
        activationUncertain,
        uncertainDeviceCount: count('uncertainDeviceCount', activationUncertain),
        cleanupPending,
        cleanupDeviceCount: count('cleanupDeviceCount', cleanupPending)
      };
    }

    function renderAndroidInterceptorStatusPills(interceptor) {
      const summary = getAndroidInterceptorSummary(interceptor);
      const statuses = [];
      if (summary.interceptionActive) {
        statuses.push({ label: 'Activated', count: summary.interceptionDeviceCount, className: 'pill-active' });
      }
      if (summary.activationUncertain) {
        statuses.push({ label: 'Activation uncertain', count: summary.uncertainDeviceCount, className: 'pill-warning' });
      }
      if (summary.cleanupPending) {
        statuses.push({ label: 'Cleanup pending', count: summary.cleanupDeviceCount, className: 'pill-warning' });
      }
      if (statuses.length === 0 && interceptor?.active) {
        statuses.push({ label: 'State uncertain', count: 1, className: 'pill-warning' });
      }

      const showCounts = statuses.length > 1;
      return `<div class="intercept-pill-group">${statuses.map(status => {
        const suffix = showCounts || status.count > 1 ? ` · ${status.count}` : '';
        return `<span class="intercept-pill ${status.className}">${status.label}${suffix}</span>`;
      }).join('')}</div>`;
    }

    function isConnectedInterceptorSource(interceptor) {
      if (!interceptor?.active) return false;
      if (interceptor.id !== 'android-adb') return true;
      return getAndroidInterceptorSummary(interceptor).interceptionActive;
    }

    function updateAndroidInterceptorFromMetadata(metadata) {
      if (!metadata || typeof metadata !== 'object') return;
      const summaryFields = getAndroidSummaryFields(metadata);
      if (Object.keys(summaryFields).length === 0) return;
      const index = allInterceptors.findIndex(interceptor => interceptor.id === 'android-adb');
      if (index === -1) return;
      const summary = getAndroidInterceptorSummary(summaryFields);
      allInterceptors[index] = {
        ...allInterceptors[index],
        ...summaryFields,
        active: summary.interceptionActive || summary.activationUncertain || summary.cleanupPending
      };
    }

    function renderConnectedSources(interceptors = allInterceptors) {
      const active = interceptors.filter(isConnectedInterceptorSource);
      const sourcesList = document.getElementById('connectedSourcesList');
      if (!sourcesList) return;

      if (active.length === 0) {
        sourcesList.innerHTML = '';
        return;
      }

      sourcesList.innerHTML = active.map(i => {
        const canFocus = i.focusable === true;
        return `<div class="connected-source-item${canFocus ? ' focusable' : ''}" ${canFocus ? `onclick="focusInterceptor('${i.id}')"` : ''}>
            ${INTERCEPTOR_ICONS[i.id] || ''}
            <span>${esc(i.name)}</span>
            <button class="connected-source-stop" onclick="event.stopPropagation(); deactivateInterceptor('${i.id}')" title="Stop intercepting ${esc(i.name)}" aria-label="Stop intercepting ${esc(i.name)}">
              <i class="ph ph-x"></i>
            </button>
          </div>`;
      }).join('');
    }

    function renderInterceptors(interceptors) {
      allInterceptors = interceptors;

      // Update connected sources (styled like HTTP Toolkit ConnectedSources)
      renderConnectedSources(interceptors);

      filterInterceptors();
    }

    function handleInterceptorStatusEvent(event) {
      if (!event?.id) {
        loadInterceptors();
        return;
      }

      const idx = allInterceptors.findIndex(i => i.id === event.id);
      if (idx === -1) {
        loadInterceptors();
        return;
      }

      allInterceptors[idx] = {
        ...allInterceptors[idx],
        active: !!event.active,
        pid: event.pid || null,
        ...(event.id === 'android-adb' ? getAndroidSummaryFields(event) : {})
      };
      if (!event.active && expandedInterceptorId === event.id) {
        collapseInterceptorCard();
        return;
      }
      renderConnectedSources(allInterceptors);
      filterInterceptors();
    }

    function activateInterceptorCardOnKeyboard(event) {
      const isSpace = event.key === ' ';
      if ((!isSpace && event.key !== 'Enter') || event.defaultPrevented ||
          event.target !== event.currentTarget) return;
      if (isSpace) event.preventDefault();
      if (event.repeat) return;
      if (!isSpace) event.preventDefault();
      event.currentTarget.click();
    }

    function filterInterceptors() {
      const query = (document.getElementById('interceptSearch')?.value || '').toLowerCase().trim();
      let filtered = [...allInterceptors];

      if (query) {
        filtered = allInterceptors.filter(i => {
          const desc = (INTERCEPTOR_DESCRIPTIONS[i.id] || []).join(' ').toLowerCase();
          const tags = (INTERCEPTOR_TAGS[i.id] || []);
          return i.name.toLowerCase().includes(query) ||
                 i.id.toLowerCase().includes(query) ||
                 desc.includes(query) ||
                 tags.some(t => t.includes(query));
        });
      }

      // Sort: exact tag/name match first (+100), active/activable (+50), supported (+25)
      filtered.sort((a, b) => {
        const exactMatchA = query && (
          (INTERCEPTOR_TAGS[a.id] || []).includes(query) ||
          a.name.toLowerCase().split(' ').includes(query)
        );
        const exactMatchB = query && (
          (INTERCEPTOR_TAGS[b.id] || []).includes(query) ||
          b.name.toLowerCase().split(' ').includes(query)
        );
        const scoreA = (exactMatchA ? 100 : 0) +
                       ((a.active || a.activable) ? 50 : 0) +
                       (a.supported !== false ? 25 : 0);
        const scoreB = (exactMatchB ? 100 : 0) +
                       ((b.active || b.activable) ? 50 : 0) +
                       (b.supported !== false ? 25 : 0);
        return scoreB - scoreA;
      });

      // Build cards into the grid (cards are siblings of the instructions & connected sources divs)
      const grid = document.getElementById('interceptPageGrid');

      // Remove old intercept cards (keep instructions and connected sources)
      grid.querySelectorAll('.intercept-card').forEach(el => el.remove());

      // Render each interceptor card
      filtered.forEach((i, index) => {
        const desc = INTERCEPTOR_DESCRIPTIONS[i.id] || [''];
        const isDisabled = !i.activable;

        let pillHtml = '';
        if (i.active) {
          if (i.id === 'android-adb') {
            pillHtml = renderAndroidInterceptorStatusPills(i);
          } else if (i.id === 'jvm' && expandedInterceptorMetadata?.activatedProcesses?.length > 0) {
            const procNames = expandedInterceptorMetadata.activatedProcesses.map(p => p.name || p.pid).join(', ');
            pillHtml = `<span class="intercept-pill pill-active">Activated \u00b7 ${esc(procNames)}</span>`;
          } else {
            pillHtml = `<span class="intercept-pill pill-active">Activated</span>`;
          }
        } else if (!i.activable) {
          if (BROWSER_DOWNLOAD_URLS[i.id]) {
            pillHtml = `<span class="intercept-pill pill-unavailable" style="cursor:pointer;">Click to install</span>`;
          } else if (i.supported !== false) {
            pillHtml = `<span class="intercept-pill pill-unavailable">Not available</span>`;
          } else {
            pillHtml = `<span class="intercept-pill pill-coming-soon">Coming soon</span>`;
          }
        }
        if (i.experimental && !i.active) {
          pillHtml = '<div style="margin-top:auto;padding-top:10px;"><span class="intercept-pill pill-experimental">Experimental</span></div>';
        }

        const card = document.createElement('div');
        const isExpanded = expandedInterceptorId === i.id;
        card.className = `intercept-card${isDisabled ? ' disabled' : ''}${isExpanded ? ' expanded' : ''}`;
        card.dataset.interceptorId = i.id;
        card.style.order = index;
        if (EXPANDABLE_INTERCEPTORS.has(i.id)) {
          card.setAttribute('aria-expanded', String(isExpanded));
        }
        if (i.activable) {
          card.setAttribute('tabindex', '0');
          card.setAttribute('role', 'button');
          if (EXPANDABLE_INTERCEPTORS.has(i.id)) {
            card.onclick = () => handleExpandableCardClick(i.id, i.active);
          } else if (i.active && i.focusable === true) {
            card.onclick = () => focusInterceptor(i.id, i.name);
          } else {
            card.onclick = () => toggleInterceptor(i.id, i.active);
          }
          card.onkeydown = activateInterceptorCardOnKeyboard;
        } else if (BROWSER_DOWNLOAD_URLS[i.id]) {
          // Not installed — offer to download
          card.classList.remove('disabled');
          card.setAttribute('tabindex', '0');
          card.setAttribute('role', 'button');
          card.style.cursor = 'pointer';
          card.onclick = () => downloadBrowser(i.id, i.name);
          card.onkeydown = activateInterceptorCardOnKeyboard;
        }

        const isLoading = interceptorsInProgress.has(i.id);

        card.innerHTML =
          `<div class="intercept-card-bg-icon">${INTERCEPTOR_ICONS[i.id] || ''}</div>` +
          (isExpanded ? `<button class="intercept-card-close" onclick="event.stopPropagation(); collapseInterceptorCard();" title="Close" aria-label="Close"><i class="ph ph-x"></i></button>` : '') +
          (i.active && !isExpanded ? `<button class="intercept-card-stop" onclick="event.stopPropagation(); deactivateInterceptor('${i.id}');" title="Stop intercepting ${esc(i.name)}" aria-label="Stop intercepting ${esc(i.name)}"><i class="ph ph-x"></i></button>` : '') +
          `<h1>${esc(i.name)}</h1>` +
          desc.map(d => `<p>${esc(d)}</p>`).join('') +
          (pillHtml ? pillHtml : '') +
          (isExpanded ? `<div class="intercept-card-config" id="interceptConfig-${i.id}"></div>` : '') +
          (isLoading ? '<div class="intercept-loading-overlay"><div class="intercept-spinner"></div></div>' : '');

        grid.appendChild(card);

        // Render config content if expanded
        if (isExpanded) {
          const configContainer = document.getElementById(`interceptConfig-${i.id}`);
          if (configContainer) {
            renderInterceptorConfig(i.id, configContainer);
          }
        }
      });

      // Always add the "Anything" manual setup card at the end
      const proxyPort = config.proxyPort || '--';
      const manualCard = document.createElement('div');
      manualCard.className = 'intercept-card';
      manualCard.style.order = filtered.length;
      manualCard.setAttribute('tabindex', '0');
      manualCard.setAttribute('role', 'button');
      manualCard.onclick = () => {
        interceptorSelectionGeneration++;
        toast(`Proxy: 127.0.0.1:${proxyPort} - Configure any HTTP client to use this proxy`, 'success');
      };
      manualCard.onkeydown = activateInterceptorCardOnKeyboard;
      manualCard.innerHTML =
        `<div class="intercept-card-bg-icon">${MANUAL_SETUP_ICON}</div>` +
        `<h1>Anything</h1>` +
        `<p>Manually configure any HTTP client using the proxy settings.</p>` +
        `<span class="intercept-pill pill-proxy-port">Proxy port: ${esc(String(proxyPort))}</span>`;
      grid.appendChild(manualCard);
    }

    async function handleExpandableCardClick(id, isActive) {
      if (interceptorsInProgress.has(id)) return;

      if (expandedInterceptorId === id) {
        // Already expanded — collapse
        collapseInterceptorCard();
        return;
      }

      interceptorSelectionGeneration++;
      const operation = beginInterceptorOperation(id);

      // Activate if not already active, then expand
      // Always refresh for android-adb (device list may change)
      if (id !== 'electron' && (!isActive || id === 'android-adb' || id === 'jvm')) {
        interceptorsInProgress.add(id);
        filterInterceptors();
        try {
          const res = await fetch(`${API_BASE}/api/interceptors/${id}/activate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
          });
          const data = await res.json();
          if (data.error) throw new Error(data.error);
          if (!isCurrentInterceptorOperation(operation, false)) return;
          expandedInterceptorMetadata = data.metadata || null;
        } catch (err) {
          if (isCurrentInterceptorOperation(operation, false)) {
            toast(`Error: ${err.message}`, 'error');
          }
          return;
        } finally {
          interceptorsInProgress.delete(id);
          filterInterceptors();
        }
        // Refresh interceptor state
        try {
          const res = await fetch(`${API_BASE}/api/interceptors`);
          const data = await res.json();
          if (!isCurrentInterceptorOperation(operation, false)) return;
          allInterceptors = data.interceptors;
          renderConnectedSources(allInterceptors);
        } catch (e) {
          if (isCurrentInterceptorOperation(operation, false)) console.error('[Error]', e.message);
        }
      }

      if (!isCurrentInterceptorOperation(operation, false)) return;
      expandedInterceptorId = id;
      filterInterceptors();
    }

    function collapseInterceptorCard() {
      interceptorSelectionGeneration++;
      expandedInterceptorId = null;
      expandedInterceptorMetadata = null;
      filterInterceptors();
    }

    function renderInterceptorConfig(id, container) {
      if (id === 'docker') {
        renderDockerConfig(container);
      } else if (id === 'existing-terminal') {
        renderTerminalConfig(container);
      } else if (id === 'electron') {
        renderElectronConfig(container);
      } else if (id === 'android-adb') {
        renderAndroidConfig(container);
      } else if (id === 'jvm') {
        renderJvmConfig(container);
      }
    }

    function renderElectronConfig(container) {
      container.innerHTML = `
        <div class="config-section">
          <h3>Electron application</h3>
          <p style="color:var(--text-watermark);font-size:12px;margin:0 0 10px;">
            Select the application executable to launch with FreeKit's proxy flags.
          </p>
          <p style="color:var(--text-watermark);font-size:12px;margin:0 0 10px;">${esc(NODE_ENV_PROXY_SUPPORT_NOTE)}</p>
          <div style="display:flex;gap:8px;align-items:center;">
            <input id="electronAppPath" type="text" placeholder="Path to Electron executable" aria-label="Electron application path"
              onclick="event.stopPropagation();" oninput="rememberElectronAppPath(this.value);" style="flex:1;min-width:0;background:var(--bg-input);border:1px solid var(--text-input-border);border-radius:4px;color:var(--text-main);padding:7px 9px;font-family:var(--font-mono);font-size:12px;">
            <button class="android-refresh-btn" onclick="event.stopPropagation(); browseElectronApp();">Browse</button>
          </div>
          <button class="jvm-process-activate" style="margin-top:10px;" onclick="event.stopPropagation(); launchElectronApp();">
            Launch &amp; intercept
          </button>
        </div>
      `;
      const input = container.querySelector('#electronAppPath');
      if (input) input.value = electronAppPathDraft;
    }

    function rememberElectronAppPath(value) {
      electronAppPathDraft = value;
    }

    async function browseElectronApp() {
      const input = document.getElementById('electronAppPath');
      if (!input) return;
      if (!window.electronApi?.selectFilePath) {
        input.focus();
        toast('Enter the Electron executable path', 'success');
        return;
      }
      try {
        const selectedPath = await window.electronApi.selectFilePath({
          title: 'Select Electron application'
        });
        if (selectedPath) {
          rememberElectronAppPath(selectedPath);
          const currentInput = document.getElementById('electronAppPath');
          if (currentInput) currentInput.value = electronAppPathDraft;
        }
      } catch (err) {
        toast('Could not select Electron application: ' +
          (err?.message || String(err || 'unknown error')), 'error');
      }
    }

    async function launchElectronApp() {
      const input = document.getElementById('electronAppPath');
      if (input) rememberElectronAppPath(input.value);
      const appPath = input?.value.trim();
      if (!appPath) {
        toast('Select an Electron application first', 'error');
        return;
      }
      if (interceptorsInProgress.has('electron')) return;
      const operation = beginInterceptorOperation('electron');

      try {
        interceptorsInProgress.add('electron');
        filterInterceptors();
        const response = await fetch(`${API_BASE}/api/interceptors/electron/activate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ appPath })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.error || data.success === false) {
          throw new Error(data.error || `HTTP ${response.status}`);
        }
        if (!isCurrentInterceptorOperation(operation)) return;
        toast('Electron application launched', 'success');
        collapseInterceptorCard();
        const trafficTab = document.querySelector('.sidebar-item[data-panel="traffic"]');
        if (trafficTab) switchPanel(trafficTab, 'traffic');
        setTimeout(loadInterceptors, 300);
      } catch (err) {
        if (isCurrentInterceptorOperation(operation)) toast(`Error: ${err.message}`, 'error');
      } finally {
        interceptorsInProgress.delete('electron');
        filterInterceptors();
      }
    }

    function renderDockerConfig(container) {
      const meta = expandedInterceptorMetadata;
      const proxyUrl = meta?.proxyUrl || `http://172.17.0.1:${config.proxyPort || 8000}`;
      const runCmd = meta?.instructions?.run || `docker run -e HTTP_PROXY=${proxyUrl} -e HTTPS_PROXY=${proxyUrl} -e http_proxy=${proxyUrl} -e https_proxy=${proxyUrl} -e NO_PROXY= -e NODE_USE_ENV_PROXY=1 <image>`;
      const composeCmd = meta?.instructions?.compose || `environment:\n  - HTTP_PROXY=${proxyUrl}\n  - HTTPS_PROXY=${proxyUrl}\n  - http_proxy=${proxyUrl}\n  - https_proxy=${proxyUrl}\n  - NO_PROXY=\n  - NODE_USE_ENV_PROXY=1`;
      const caBundleDescription = meta?.caBundleDescription
        || 'Activate Docker interception to generate a read-only combined public-roots-plus-FreeKit CA bundle mount. This proxy-only fallback does not change TLS verification.';

      container.innerHTML = `
        <p style="color:var(--text-watermark);font-size:12px;margin:0 0 10px;">${esc(meta?.nodeProxyNote || NODE_ENV_PROXY_SUPPORT_NOTE)}</p>
        <p style="color:var(--text-watermark);font-size:12px;margin:0 0 10px;">${esc(caBundleDescription)}</p>
        <div class="config-section">
          <h3>Docker Run</h3>
          <div class="config-code-block" role="button" tabindex="0" aria-label="Copy Docker Run command" title="Copy to clipboard" onkeydown="activateOnKeyboard(event)" onclick="event.stopPropagation(); copyConfigCode(this)">${esc(runCmd)}</div>
        </div>
        <div class="config-section">
          <h3>Docker Compose</h3>
          <div class="config-code-block" role="button" tabindex="0" aria-label="Copy Docker Compose configuration" title="Copy to clipboard" onkeydown="activateOnKeyboard(event)" onclick="event.stopPropagation(); copyConfigCode(this)">${esc(composeCmd)}</div>
        </div>
      `;
    }

    function quoteTerminalBashValue(value) {
      return `'${String(value).replace(/'/g, `'"'"'`)}'`;
    }

    function quoteTerminalPowerShellValue(value) {
      return `'${String(value).replace(/'/g, "''")}'`;
    }

    function terminalCmdSet(variable, value) {
      return `set "${variable}=${String(value)}"`;
    }

    function buildTerminalFallbackInstructions(proxyUrl, certPath) {
      return {
        bash: [
          'unset NODE_TLS_REJECT_UNAUTHORIZED;',
          `export HTTP_PROXY=${quoteTerminalBashValue(proxyUrl)}`,
          `HTTPS_PROXY=${quoteTerminalBashValue(proxyUrl)}`,
          `http_proxy=${quoteTerminalBashValue(proxyUrl)}`,
          `https_proxy=${quoteTerminalBashValue(proxyUrl)}`,
          `NO_PROXY=${quoteTerminalBashValue('')}`,
          `no_proxy=${quoteTerminalBashValue('')}`,
          `NODE_USE_ENV_PROXY=${quoteTerminalBashValue('1')}`,
          `SSL_CERT_FILE=${quoteTerminalBashValue(certPath)}`,
          `NODE_EXTRA_CA_CERTS=${quoteTerminalBashValue(certPath)}`,
          `REQUESTS_CA_BUNDLE=${quoteTerminalBashValue(certPath)}`,
          `CURL_CA_BUNDLE=${quoteTerminalBashValue(certPath)}`
        ].join(' '),
        powershell: [
          'Remove-Item Env:NODE_TLS_REJECT_UNAUTHORIZED -ErrorAction SilentlyContinue',
          `$env:HTTP_PROXY=${quoteTerminalPowerShellValue(proxyUrl)}`,
          `$env:HTTPS_PROXY=${quoteTerminalPowerShellValue(proxyUrl)}`,
          `$env:http_proxy=${quoteTerminalPowerShellValue(proxyUrl)}`,
          `$env:https_proxy=${quoteTerminalPowerShellValue(proxyUrl)}`,
          `$env:NO_PROXY=${quoteTerminalPowerShellValue('')}`,
          `$env:no_proxy=${quoteTerminalPowerShellValue('')}`,
          `$env:NODE_USE_ENV_PROXY=${quoteTerminalPowerShellValue('1')}`,
          `$env:SSL_CERT_FILE=${quoteTerminalPowerShellValue(certPath)}`,
          `$env:NODE_EXTRA_CA_CERTS=${quoteTerminalPowerShellValue(certPath)}`,
          `$env:REQUESTS_CA_BUNDLE=${quoteTerminalPowerShellValue(certPath)}`,
          `$env:CURL_CA_BUNDLE=${quoteTerminalPowerShellValue(certPath)}`
        ].join('; '),
        cmd: [
          terminalCmdSet('NODE_TLS_REJECT_UNAUTHORIZED', ''),
          terminalCmdSet('HTTP_PROXY', proxyUrl),
          terminalCmdSet('HTTPS_PROXY', proxyUrl),
          terminalCmdSet('http_proxy', proxyUrl),
          terminalCmdSet('https_proxy', proxyUrl),
          terminalCmdSet('NO_PROXY', ''),
          terminalCmdSet('no_proxy', ''),
          terminalCmdSet('NODE_USE_ENV_PROXY', '1'),
          terminalCmdSet('SSL_CERT_FILE', certPath),
          terminalCmdSet('NODE_EXTRA_CA_CERTS', certPath),
          terminalCmdSet('REQUESTS_CA_BUNDLE', certPath),
          terminalCmdSet('CURL_CA_BUNDLE', certPath)
        ].join('&& ')
      };
    }

    function renderTerminalConfig(container) {
      const meta = expandedInterceptorMetadata;
      const proxyUrl = meta?.proxyUrl || `http://127.0.0.1:${config.proxyPort || 8000}`;
      const certPath = meta?.certPath || '';
      const instructions = meta?.instructions || buildTerminalFallbackInstructions(proxyUrl, certPath);

      // Detect default shell
      const platform = navigator.platform.toLowerCase();
      let defaultTab = 'bash';
      if (platform.includes('win')) defaultTab = 'powershell';

      container.innerHTML = `
        <div class="config-section">
          <h3>Paste in your terminal</h3>
          <p style="color:var(--text-watermark);font-size:12px;margin:0 0 10px;">${esc(meta?.lifecycleNote || 'These variables remain active until you unset them or close this shell.')}</p>
          <p style="color:var(--text-watermark);font-size:12px;margin:0 0 10px;">${esc(meta?.nodeProxyNote || NODE_ENV_PROXY_SUPPORT_NOTE)}</p>
          <div class="config-tabs">
            <button class="config-tab${defaultTab === 'bash' ? ' active' : ''}" onclick="event.stopPropagation(); switchConfigTab(this, 'bash')">Bash / Zsh</button>
            <button class="config-tab${defaultTab === 'powershell' ? ' active' : ''}" onclick="event.stopPropagation(); switchConfigTab(this, 'powershell')">PowerShell</button>
            <button class="config-tab${defaultTab === 'cmd' ? ' active' : ''}" onclick="event.stopPropagation(); switchConfigTab(this, 'cmd')">CMD</button>
          </div>
          <div class="config-code-block" id="terminalConfigCode" role="button" tabindex="0" aria-label="Copy terminal command" title="Copy to clipboard" onkeydown="activateOnKeyboard(event)" onclick="event.stopPropagation(); copyConfigCode(this)">${esc(instructions[defaultTab])}</div>
        </div>
      `;

      // Store instructions on the container for tab switching
      container._instructions = instructions;
    }

    function switchConfigTab(btn, tab) {
      const tabsContainer = btn.parentElement;
      tabsContainer.querySelectorAll('.config-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const configContainer = btn.closest('.intercept-card-config');
      const codeBlock = configContainer.querySelector('#terminalConfigCode');
      if (configContainer._instructions && configContainer._instructions[tab]) {
        codeBlock.textContent = configContainer._instructions[tab];
      }
    }

    function copyConfigCode(el) {
      const text = el.textContent.trim();
      return navigator.clipboard.writeText(text).then(() => {
        toast('Copied to clipboard!', 'success');
      }).catch(() => {
        toast('Failed to copy', 'error');
      });
    }

    function getAndroidActivationPresentation(mode) {
      switch (mode) {
        case 'global-proxy':
          return { category: 'active', modeLabel: 'Global proxy', statusLabel: 'Activated' };
        case 'http-toolkit-app':
          return { category: 'active', modeLabel: 'VPN app', statusLabel: 'Activated' };
        case 'proxy-uncertain':
          return {
            category: 'warning',
            modeLabel: 'Global proxy state uncertain',
            statusLabel: 'Activation uncertain'
          };
        case 'app-uncertain':
          return {
            category: 'warning',
            modeLabel: 'VPN app state uncertain',
            statusLabel: 'Activation uncertain'
          };
        case 'staging-cleanup':
          return {
            category: 'warning',
            modeLabel: 'Certificate cleanup pending',
            statusLabel: 'Cleanup pending'
          };
        case 'reverse-cleanup':
          return {
            category: 'warning',
            modeLabel: 'ADB tunnel cleanup pending',
            statusLabel: 'Cleanup pending'
          };
        default:
          return { category: 'warning', modeLabel: 'Android state uncertain', statusLabel: 'State uncertain' };
      }
    }

    function renderAndroidConfig(container) {
      const meta = expandedInterceptorMetadata;
      const devices = meta?.devices || [];
      const activatedDevices = meta?.activatedDevices || [];
      const activationBySerial = new Map(activatedDevices.map(d => [d.serial, d]));
      const qrHtml = meta?.qrAvailable && meta?.qrImageDataUrl
        ? `
          <div class="config-section">
            <h3>Scan QR</h3>
            <div class="android-qr-layout">
              <img class="android-qr-image" src="${esc(meta.qrImageDataUrl)}" alt="Android setup QR code">
              <div class="android-qr-details">
                <p class="android-setup-note">${esc(meta.qrAvailabilityNote || 'Open the HTTP Toolkit Android app and scan this code.')}</p>
                <div class="config-code-block android-qr-url" role="button" tabindex="0" aria-label="Copy Android QR connection URL" title="Copy to clipboard" onkeydown="activateOnKeyboard(event)" onclick="event.stopPropagation(); copyConfigCode(this)">${esc(meta.qrConnectUrl || '')}</div>
              </div>
            </div>
          </div>
        `
        : `
          <div class="config-section">
            <h3>Scan QR</h3>
            <p class="android-setup-note">${esc(meta?.qrError || 'QR setup is not available yet.')}</p>
          </div>
        `;

      if (devices.length === 0) {
        container.innerHTML = `
          ${qrHtml}
          <div class="config-section">
            <h3>Connected Devices</h3>
            <p style="color: var(--text-watermark); font-size: 13px;">No Android devices detected. Make sure:</p>
            <ul style="color: var(--text-watermark); font-size: 13px; margin: 8px 0; padding-left: 20px;">
              <li>USB debugging is enabled on your device</li>
              <li>Your device is connected via USB</li>
              <li>ADB is installed and in your PATH</li>
            </ul>
            <button class="android-refresh-btn" onclick="event.stopPropagation(); refreshAndroidDevices();">
              <i class="ph ph-arrows-clockwise"></i> Refresh
            </button>
          </div>
        `;
        return;
      }

      container.innerHTML = `
        ${qrHtml}
        <div class="config-section">
          <h3>Connected Devices</h3>
          <p class="android-setup-note">Uses the HTTP Toolkit Android VPN app for HTTPS when installed, then falls back to an HTTP-only global proxy without installing a persistent CA.</p>
          <div class="android-device-list">
            ${devices.map((d, index) => {
              const activation = activationBySerial.get(d.serial);
              const activationPresentation = activation
                ? getAndroidActivationPresentation(activation.mode)
                : null;
              const isActivated = activationPresentation?.category === 'active';
              const hasOwnedState = activationPresentation !== null;
              const isUnauthorized = d.status === 'unauthorized';
              const isOffline = d.status === 'offline';
              const globalProxyError = d.globalProxyAvailable === false && d.globalProxyError
                ? `<span class="android-device-mode warning">Global proxy unavailable: ${esc(d.globalProxyError)} The companion app can still be activated through ADB when its tunnel is reachable.</span>`
                : '';
              const hostIpCandidates = Array.isArray(d.hostIpCandidates)
                ? d.hostIpCandidates.filter(candidate =>
                    candidate && typeof candidate.address === 'string' &&
                    typeof candidate.name === 'string')
                : [];
              const requiresHostIpSelection = d.requiresHostIpSelection === true &&
                hostIpCandidates.length > 1;
              let selectedHostIp = androidHostIpSelections.get(d.serial) || '';
              if (!hostIpCandidates.some(candidate => candidate.address === selectedHostIp)) {
                androidHostIpSelections.delete(d.serial);
                selectedHostIp = '';
              }
              const hostIpChoice = requiresHostIpSelection
                ? `
                  <div class="android-host-ip-choice">
                    <label for="androidHostIp-${index}">Host network adapter</label>
                    <select id="androidHostIp-${index}"
                            onclick="event.stopPropagation();"
                            onchange="event.stopPropagation(); selectAndroidHostIp(this.closest('.android-device-item')?.dataset.deviceId, this.value);">
                      <option value="">Choose an adapter…</option>
                      ${hostIpCandidates.map(candidate => `
                        <option value="${esc(candidate.address)}"${candidate.address === selectedHostIp ? ' selected' : ''}>
                          ${esc(candidate.name)} · ${esc(candidate.address)}
                        </option>
                      `).join('')}
                    </select>
                    <span>Select the adapter connected to this Android device.</span>
                  </div>
                `
                : '';
              return `
                <div class="android-device-item${isActivated ? ' activated' : hasOwnedState ? ' warning' : ''}" data-device-id="${esc(d.serial)}">
                  <div class="android-device-info">
                    <i class="ph ph-device-mobile"></i>
                    <div class="android-device-details">
                      <span class="android-device-model">${esc(d.model || d.serial)}</span>
                      <span class="android-device-serial">${esc(d.serial)}${d.deviceName ? ' \u00b7 ' + esc(d.deviceName) : ''}</span>
                      ${hasOwnedState ? `<span class="android-device-mode${isActivated ? '' : ' warning'}">${esc(activationPresentation.modeLabel)}</span>` : ''}
                      ${globalProxyError}
                      ${hostIpChoice}
                    </div>
                  </div>
                  <div class="android-device-actions">
                    ${hasOwnedState
                      ? `<span class="intercept-pill ${isActivated ? 'pill-active' : 'pill-warning'}" style="margin:0;">${esc(activationPresentation.statusLabel)}</span>`
                      : isUnauthorized
                        ? '<span class="android-device-status status-warning">Unauthorized</span>'
                        : isOffline
                          ? '<span class="android-device-status status-offline">Offline</span>'
                          : `<button class="android-device-activate"${requiresHostIpSelection && !selectedHostIp ? ' disabled' : ''} onclick="event.stopPropagation(); activateAndroidDevice('${esc(d.serial)}');">Activate</button>`
                    }
                  </div>
                </div>
              `;
            }).join('')}
          </div>
          <button class="android-refresh-btn" onclick="event.stopPropagation(); refreshAndroidDevices();">
            <i class="ph ph-arrows-clockwise"></i> Refresh Devices
          </button>
        </div>
      `;
    }

    function selectAndroidHostIp(deviceId, hostIp) {
      const device = expandedInterceptorMetadata?.devices?.find(candidate => candidate.serial === deviceId);
      const candidates = Array.isArray(device?.hostIpCandidates) ? device.hostIpCandidates : [];
      if (candidates.some(candidate => candidate?.address === hostIp)) {
        androidHostIpSelections.set(deviceId, hostIp);
      } else {
        androidHostIpSelections.delete(deviceId);
      }
      const container = document.getElementById('interceptConfig-android-adb');
      if (container) renderAndroidConfig(container);
    }

    async function activateAndroidDevice(deviceId) {
      if (interceptorsInProgress.has('android-adb')) return;
      const device = expandedInterceptorMetadata?.devices?.find(candidate => candidate.serial === deviceId);
      const hostIpCandidates = Array.isArray(device?.hostIpCandidates) ? device.hostIpCandidates : [];
      const selectedHostIp = androidHostIpSelections.get(deviceId);
      const requiresHostIpSelection = device?.requiresHostIpSelection === true &&
        hostIpCandidates.length > 1;
      if (requiresHostIpSelection &&
          !hostIpCandidates.some(candidate => candidate?.address === selectedHostIp)) {
        androidHostIpSelections.delete(deviceId);
        toast('Choose the host network adapter connected to this Android device', 'error');
        return;
      }
      const operation = beginInterceptorOperation('android-adb');
      interceptorsInProgress.add('android-adb');
      filterInterceptors();

      const item = document.querySelector(`[data-device-id="${deviceId}"]`);
      const btn = item?.querySelector('.android-device-activate');
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<div class="intercept-spinner" style="width:16px;height:16px;border-width:2px;display:inline-block;vertical-align:middle;"></div>';
      }

      try {
        const res = await fetch(`${API_BASE}/api/interceptors/android-adb/activate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            deviceId,
            ...(requiresHostIpSelection ? { hostIp: selectedHostIp } : {})
          })
        });
        const data = await res.json();
        if (!isCurrentInterceptorOperation(operation)) return;

        // Update metadata with fresh device and activation info
        if (data.metadata) {
          expandedInterceptorMetadata = {
            ...expandedInterceptorMetadata,
            ...data.metadata,
            devices: data.metadata.devices || expandedInterceptorMetadata?.devices || [],
            activatedDevices: data.metadata.activatedDevices || expandedInterceptorMetadata?.activatedDevices || []
          };
          updateAndroidInterceptorFromMetadata(data.metadata);
          renderConnectedSources(allInterceptors);
        }

        if (data.metadata?.requiresHostIpSelection === true &&
            Array.isArray(data.metadata.hostIpCandidates) &&
            data.metadata.hostIpCandidates.length > 1) {
          androidHostIpSelections.delete(deviceId);
          const container = document.getElementById('interceptConfig-android-adb');
          if (container) renderAndroidConfig(container);
          toast('Choose the host network adapter connected to this Android device', 'error');
          return;
        }
        if (res.ok === false || data.error) throw new Error(data.error || `HTTP ${res.status}`);
        androidHostIpSelections.delete(deviceId);

        // Re-render the config area
        const container = document.getElementById('interceptConfig-android-adb');
        if (container) {
          renderAndroidConfig(container);
        }

        // Refresh interceptor list for pill update
        try {
          const r = await fetch(`${API_BASE}/api/interceptors`);
          const d = await r.json();
          if (!isCurrentInterceptorOperation(operation)) return;
          allInterceptors = d.interceptors;
          renderConnectedSources(allInterceptors);
        } catch (e) {
          if (isCurrentInterceptorOperation(operation)) console.error('[Error]', e.message);
        }

        if (isCurrentInterceptorOperation(operation)) {
          if (data.metadata?.mode === 'app-uncertain') {
            toast(
              `Android app launched for ${data.metadata?.model || deviceId}; complete the VPN prompts on the device`,
              'warning'
            );
          } else if (data.metadata?.mode === 'global-proxy') {
            toast(
              `Android device ${data.metadata?.model || deviceId} activated for HTTP; install the companion VPN app for HTTPS`,
              'warning'
            );
          } else {
            toast(`Android device ${data.metadata?.model || deviceId} activated`, 'success');
          }
        }
      } catch (err) {
        if (isCurrentInterceptorOperation(operation)) {
          toast(`Error: ${err.message}`, 'error');
          if (btn) {
            btn.disabled = false;
            btn.innerHTML = 'Activate';
          }
          // A failed activation can still retain uncertain or cleanup-only
          // ownership. Refresh the lifecycle snapshot so Stop stays available
          // even when the error response could not include metadata.
          try {
            const response = await fetch(`${API_BASE}/api/interceptors`);
            const data = await response.json();
            if (isCurrentInterceptorOperation(operation)) {
              allInterceptors = data.interceptors;
              renderConnectedSources(allInterceptors);
            }
          } catch (refreshError) {
            if (isCurrentInterceptorOperation(operation)) console.error('[Error]', refreshError.message);
          }
        }
      } finally {
        interceptorsInProgress.delete('android-adb');
        filterInterceptors();
      }
    }

    async function readInterceptorRefreshMetadata(response, listKey, activatedListKey) {
      let data;
      try {
        data = await response.json();
      } catch {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        throw new Error('Refresh response was not valid JSON');
      }

      const serverError = typeof data?.error === 'string' && data.error.trim()
        ? data.error.trim()
        : null;
      if (!response.ok) throw new Error(serverError || `HTTP ${response.status}`);
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('Refresh response was malformed');
      }
      if (serverError) throw new Error(serverError);
      if (data.success === false) throw new Error('Interceptor refresh failed');
      if (data.success !== true || !data.metadata || typeof data.metadata !== 'object' ||
          Array.isArray(data.metadata) || !Array.isArray(data.metadata[listKey]) ||
          !Array.isArray(data.metadata[activatedListKey])) {
        throw new Error('Refresh response was incomplete');
      }
      return data.metadata;
    }

    async function refreshAndroidDevices() {
      const operation = beginInterceptorOperation('android-adb');
      try {
        const res = await fetch(`${API_BASE}/api/interceptors/android-adb/activate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        });
        const metadata = await readInterceptorRefreshMetadata(res, 'devices', 'activatedDevices');
        if (!isCurrentInterceptorOperation(operation)) return;
        expandedInterceptorMetadata = {
          ...expandedInterceptorMetadata,
          ...metadata,
          devices: metadata.devices,
          activatedDevices: metadata.activatedDevices
        };
        updateAndroidInterceptorFromMetadata(metadata);
        renderConnectedSources(allInterceptors);
        const container = document.getElementById('interceptConfig-android-adb');
        if (container) {
          renderAndroidConfig(container);
        }
        toast('Device list refreshed', 'success');
      } catch (err) {
        if (isCurrentInterceptorOperation(operation)) {
          toast(`Error refreshing devices: ${err.message}`, 'error');
        }
      }
    }

    function renderJvmConfig(container) {
      const meta = expandedInterceptorMetadata;
      const processes = meta?.processes || [];
      const activatedPids = new Set(
        (meta?.activatedProcesses || []).map(p => p.pid)
      );

      const fallbackCmd = typeof meta?.fallbackCommand === 'string'
        ? meta.fallbackCommand
        : '';
      const fallbackContent = fallbackCmd
        ? `<div class="config-code-block" role="button" tabindex="0" aria-label="Copy JVM launch option" title="Copy to clipboard" onkeydown="activateOnKeyboard(event)" onclick="event.stopPropagation(); copyConfigCode(this)">${esc(fallbackCmd)}</div>`
        : '<p style="color: var(--text-watermark); font-size: 13px;">The CA-capable JVM launch agent could not be prepared. Install a full JDK and refresh.</p>';

      if (processes.length === 0) {
        container.innerHTML = `
          <div class="config-section">
            <h3>Running JVM Processes</h3>
            <p style="color: var(--text-watermark); font-size: 13px;">No JVM processes detected. Make sure:</p>
            <ul style="color: var(--text-watermark); font-size: 13px; margin: 8px 0; padding-left: 20px;">
              <li>A Java application is running</li>
              <li>Java JDK (not JRE) is installed with <code>jps</code> in your PATH</li>
            </ul>
            <div class="config-section" style="margin-top: 12px;">
              <h3>Or launch with the FreeKit agent</h3>
              ${fallbackContent}
            </div>
            <button class="android-refresh-btn" onclick="event.stopPropagation(); refreshJvmProcesses();">
              <i class="ph ph-arrows-clockwise"></i> Refresh
            </button>
          </div>
        `;
        return;
      }

      container.innerHTML = `
        <div class="config-section">
          <h3>Running JVM Processes</h3>
          <div class="jvm-process-list">
            ${processes.map(p => {
              const isActivated = activatedPids.has(p.pid);
              return `
                <div class="jvm-process-item${isActivated ? ' activated' : ''}" data-jvm-pid="${esc(p.pid)}">
                  <div class="jvm-process-info">
                    <i class="ph ph-coffee"></i>
                    <div class="jvm-process-details">
                      <span class="jvm-process-name">${esc(p.name)}</span>
                      <span class="jvm-process-meta">PID ${esc(p.pid)} · ${esc(p.mainClass)}</span>
                    </div>
                  </div>
                  <div class="jvm-process-actions">
                    ${isActivated
                      ? '<span class="intercept-pill pill-active" style="margin:0;">Activated</span>'
                      : `<button class="jvm-process-activate" onclick="event.stopPropagation(); activateJvmProcess('${esc(p.pid)}');">Attach</button>`
                    }
                  </div>
                </div>
              `;
            }).join('')}
          </div>
          <div class="config-section" style="margin-top: 12px;">
            <h3>Or launch with the FreeKit agent</h3>
            ${fallbackContent}
          </div>
          <button class="android-refresh-btn" onclick="event.stopPropagation(); refreshJvmProcesses();">
            <i class="ph ph-arrows-clockwise"></i> Refresh Processes
          </button>
        </div>
      `;
    }

    async function activateJvmProcess(pid) {
      if (interceptorsInProgress.has('jvm')) return;
      const operation = beginInterceptorOperation('jvm');
      interceptorsInProgress.add('jvm');
      filterInterceptors();

      const item = document.querySelector(`[data-jvm-pid="${pid}"]`);
      const btn = item?.querySelector('.jvm-process-activate');
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<div class="intercept-spinner" style="width:16px;height:16px;border-width:2px;display:inline-block;vertical-align:middle;"></div>';
      }

      try {
        const res = await fetch(`${API_BASE}/api/interceptors/jvm/activate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pid })
        });
        const data = await res.json();
        if (!isCurrentInterceptorOperation(operation)) return;

        // Update metadata with fresh process and activation info
        let metadataUpdated = false;
        if (data.metadata && typeof data.metadata === 'object' && !Array.isArray(data.metadata)) {
          expandedInterceptorMetadata = {
            ...expandedInterceptorMetadata,
            ...data.metadata,
            processes: Array.isArray(data.metadata.processes)
              ? data.metadata.processes
              : expandedInterceptorMetadata?.processes || [],
            activatedProcesses: Array.isArray(data.metadata.activatedProcesses)
              ? data.metadata.activatedProcesses
              : expandedInterceptorMetadata?.activatedProcesses || []
          };
          metadataUpdated = true;
        }

        if (res.ok === false || data.error || data.success === false) {
          // Error responses can contain a newly available or unavailable
          // manual fallback, so render their metadata before surfacing the error.
          const container = document.getElementById('interceptConfig-jvm');
          if (metadataUpdated && container) renderJvmConfig(container);
          throw new Error(data.error || `HTTP ${res.status}`);
        }

        // Re-render the config area
        const container = document.getElementById('interceptConfig-jvm');
        if (container) {
          renderJvmConfig(container);
        }

        // Refresh interceptor list for pill update
        try {
          const r = await fetch(`${API_BASE}/api/interceptors`);
          const d = await r.json();
          if (!isCurrentInterceptorOperation(operation)) return;
          allInterceptors = d.interceptors;
          renderConnectedSources(allInterceptors);
        } catch (e) {
          if (isCurrentInterceptorOperation(operation)) console.error('[Error]', e.message);
        }

        if (isCurrentInterceptorOperation(operation)) {
          toast(`JVM process ${data.metadata?.name || pid} attached`, 'success');
        }
      } catch (err) {
        if (isCurrentInterceptorOperation(operation)) {
          toast(`Error: ${err.message}`, 'error');
          if (btn) {
            btn.disabled = false;
            btn.innerHTML = 'Attach';
          }
        }
      } finally {
        interceptorsInProgress.delete('jvm');
        filterInterceptors();
      }
    }

    async function refreshJvmProcesses() {
      const operation = beginInterceptorOperation('jvm');
      try {
        const res = await fetch(`${API_BASE}/api/interceptors/jvm/activate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        });
        const metadata = await readInterceptorRefreshMetadata(res, 'processes', 'activatedProcesses');
        if (!isCurrentInterceptorOperation(operation)) return;
        expandedInterceptorMetadata = {
          ...expandedInterceptorMetadata,
          ...metadata,
          processes: metadata.processes,
          activatedProcesses: metadata.activatedProcesses
        };
        const container = document.getElementById('interceptConfig-jvm');
        if (container) {
          renderJvmConfig(container);
        }
        toast('Process list refreshed', 'success');
      } catch (err) {
        if (isCurrentInterceptorOperation(operation)) {
          toast(`Error refreshing processes: ${err.message}`, 'error');
        }
      }
    }

    async function focusInterceptor(id) {
      interceptorSelectionGeneration++;
      const operation = beginInterceptorOperation(id);
      const interceptor = allInterceptors.find(i => i.id === id);
      const name = interceptor?.name || id;
      try {
        const res = await fetch(`${API_BASE}/api/interceptors/${id}/focus`, { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
        if (isCurrentInterceptorOperation(operation, false)) toast(`Focused ${name}`, 'success');
      } catch (err) {
        if (isCurrentInterceptorOperation(operation, false)) {
          toast(`Could not focus ${name}: ${err.message}`, 'error');
        }
      }
    }

    async function deactivateInterceptor(id, operation = null) {
      if (interceptorsInProgress.has(id)) return;

      const interceptor = allInterceptors.find(i => i.id === id);
      const name = interceptor?.name || id;
      try {
        interceptorsInProgress.add(id);
        filterInterceptors();
        const requestDeactivation = async body => {
          const response = await fetch(`${API_BASE}/api/interceptors/${id}/deactivate`, {
            method: 'POST',
            ...(body
              ? {
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(body)
                }
              : {})
          });
          return {
            response,
            data: await response.json().catch(() => ({}))
          };
        };
        let { response: res, data } = await requestDeactivation();
        if (data.code === 'ANDROID_CA_REMOVAL_CONFIRMATION_REQUIRED') {
          const deviceList = Array.isArray(data.deviceIds) ? data.deviceIds.join(', ') : 'the Android device';
          const settingsOpened = Array.isArray(data.settingsOpened) && data.settingsOpened.length > 0;
          const confirmed = window.confirm(
            `An older HTTP FreeKit session may have installed its CA on ${deviceList}.\n\n` +
            `${settingsOpened
              ? 'Android Trusted credentials has been opened.'
              : 'Open Android Settings > Security > Trusted credentials > User.'} ` +
            'Uninstall “HTTP FreeKit CA”, then click OK. Stop will remain pending if you click Cancel.'
          );
          if (!confirmed) {
            toast('Android Stop is pending until the legacy CA is removed', 'warning');
            return;
          }
          ({ response: res, data } = await requestDeactivation({ confirmCaRemoved: true }));
        }
        if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
        if (!operation || isCurrentInterceptorOperation(operation, false)) {
          toast(`Stopped ${name}`, 'success');
          setTimeout(loadInterceptors, 300);
        }
      } catch (err) {
        if (!operation || isCurrentInterceptorOperation(operation, false)) {
          toast(`Error: ${err.message}`, 'error');
        }
      } finally {
        interceptorsInProgress.delete(id);
        filterInterceptors();
      }
    }

    async function toggleInterceptor(id, isActive) {
      if (interceptorsInProgress.has(id)) return;
      interceptorSelectionGeneration++;
      const operation = beginInterceptorOperation(id);

      try {
        if (isActive) {
          await deactivateInterceptor(id, operation);
        } else {
          interceptorsInProgress.add(id);
          filterInterceptors(); // re-render to show loading overlay
          try {
            const res = await fetch(`${API_BASE}/api/interceptors/${id}/activate`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({})
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            if (!isCurrentInterceptorOperation(operation, false)) return;

            toast(`Launched ${id}`, 'success');
            // Auto-switch to Traffic view on successful activation (like HTTP Toolkit)
            const trafficTab = document.querySelector('.sidebar-item[data-panel="traffic"]');
            if (trafficTab) switchPanel(trafficTab, 'traffic');
          } finally {
            interceptorsInProgress.delete(id);
          }
        }
        if (isCurrentInterceptorOperation(operation, false)) setTimeout(loadInterceptors, 500);
      } catch (err) {
        interceptorsInProgress.delete(id);
        filterInterceptors();
        if (isCurrentInterceptorOperation(operation, false)) {
          toast(`Error: ${err.message}`, 'error');
          // A failed Start can conservatively retain cleanup ownership (for
          // example when a browser process scan is unavailable). Refresh even
          // if the status WebSocket is disconnected so the card exposes Stop.
          setTimeout(loadInterceptors, 300);
        }
      }
    }

    // ============ MOCK RULES ============
    const MOCK_METHOD_COLORS = {GET:'#4caf7d',POST:'#ff8c38',DELETE:'#ce3939',PUT:'#6e40aa',PATCH:'#dd3a96',HEAD:'#5a80cc',OPTIONS:'#888','*':'#888'};
    const MOCK_MATCHER_GROUPS = [
      { group: 'Basic', items: [
        { value: 'wildcard', label: 'Wildcard (any request)' },
        { value: 'method', label: 'Method' },
        { value: 'host', label: 'Host' },
        { value: 'path', label: 'Path' },
      ]},
      { group: 'URL', items: [
        { value: 'hostname', label: 'Hostname (no port)' },
        { value: 'regex-path', label: 'Regex Path' },
        { value: 'regex-url', label: 'Regex URL (full)' },
        { value: 'url-contains', label: 'URL Contains' },
        { value: 'query', label: 'Query Param' },
        { value: 'exact-query', label: 'Exact Query String' },
        { value: 'port', label: 'Port' },
        { value: 'protocol', label: 'Protocol (HTTP/HTTPS)' },
      ]},
      { group: 'Headers', items: [
        { value: 'header', label: 'Header' },
        { value: 'cookie', label: 'Cookie' },
      ]},
      { group: 'Body', items: [
        { value: 'body-contains', label: 'Body Contains' },
        { value: 'json-body-exact', label: 'JSON Body (exact)' },
        { value: 'json-body-includes', label: 'JSON Body (partial match)' },
        { value: 'regex-body', label: 'Regex Body' },
        { value: 'raw-body-exact', label: 'Raw Body (exact match)' },
        { value: 'form-data', label: 'Form Data Field' },
        { value: 'multipart-form-data', label: 'Multipart Form Data' },
      ]},
    ];
    // Flat list for iteration
    const MOCK_MATCHER_TYPES = MOCK_MATCHER_GROUPS.flatMap(g => g.items);
    const MOCK_ACTION_TYPES = [
      { value: 'fixed-response', label: 'Return a fixed response' },
      { value: 'serve-file', label: 'Serve content from a file' },
      { value: 'forward', label: 'Forward the request to a different host' },
      { value: 'passthrough', label: 'Passthrough (forward with no changes)' },
      { value: 'transform-request', label: 'Transform the request' },
      { value: 'transform-response', label: 'Transform the response' },
      { value: 'breakpoint-request', label: 'Pause and manually edit the request (breakpoint)' },
      { value: 'breakpoint-response', label: 'Pause and manually edit the response (breakpoint)' },
      { value: 'breakpoint-request-response', label: 'Pause and edit both request & response' },
      { value: 'webhook', label: 'Send a webhook (fire-and-forget)' },
      { value: 'close', label: 'Close the connection' },
      { value: 'reset', label: 'Reset connection (send TCP RST)' },
      { value: 'timeout', label: 'Timeout (wait forever)' }
    ];
    const MOCK_PRE_STEP_TYPES = [
      { value: 'delay', label: 'Delay' },
      { value: 'add-header', label: 'Add request header' },
      { value: 'remove-header', label: 'Remove request header' },
      { value: 'rewrite-url', label: 'Rewrite URL' },
      { value: 'rewrite-method', label: 'Rewrite HTTP method' }
    ];

    let mockExpandedRules = new Set();
    let mockEditingRule = null;
    let mockEditDraft = null;
    let mockEditDirty = false;
    let mockWorkRevision = 0;
    let mockDragId = null;
    let mockReorderGeneration = 0;
    let mockReorderQueue = Promise.resolve();
    let mockCollectionMutationCount = 0;
    let mockRenamingRuleId = null;
    let mockRulesLoadGeneration = 0;
    let mockRevertInProgress = false;
    let mockResetInProgress = false;

    async function loadBreakpointRules() {
      try {
        const res = await fetch(API_BASE + '/api/breakpoints');
        const data = await res.json();
        breakpointRules = data.rules || [];
        renderMockRules();
      } catch (e) {
        console.error('[Error]', e.message);
      }
    }

    // Helper: find a mock rule by ID, searching inside groups too
    function _findMockRuleDeep(ruleId) {
      for (const item of mockRules) {
        if (item.id === ruleId) return item;
        if (item.type === 'group' && item.items) {
          const nested = item.items.find(r => r.id === ruleId);
          if (nested) return nested;
        }
      }
      return null;
    }

    function _findContainingMockGroup(ruleId) {
      return mockRules.find(item =>
        item.type === 'group' && (item.items || []).some(rule => rule.id === ruleId)
      ) || null;
    }

    function _createDefaultMockRule() {
      return {
        title: 'Default: Pass through all requests',
        enabled: true,
        priority: 'normal',
        matchers: [{ type: 'method', value: '*' }],
        action: { type: 'passthrough' }
      };
    }

    async function clearAllMockRules() {
      if (mockResetInProgress || mockSaveInProgress || mockRevertInProgress) return;
      mockResetInProgress = true;
      updateMockSaveButtons();
      try {
        // Reorders are serialized client-side. Let every operation already in
        // that queue settle before Reset becomes the final server mutation.
        await mockReorderQueue;
        const response = await fetch(API_BASE + '/api/mock-rules', {
          method: 'PUT',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ rules: [_createDefaultMockRule()], mode: 'replace' })
        });
        const data = await _readMockRulesResponse(response, 'Resetting mock rules');
        if (data?.success !== true || !Array.isArray(data.rules) || data.rules.length !== 1) {
          throw new Error('Resetting mock rules returned an invalid response');
        }
        // A GET started before (or during) Reset must not overwrite this newer
        // authoritative collection after its delayed response arrives.
        mockRulesLoadGeneration++;
        mockReorderGeneration++;
        mockDraftRules.clear();
        mockNewDraftIds.clear();
        mockExpandedRules.clear();
        mockEditingRule = null;
        mockEditDraft = null;
        mockRenamingRuleId = null;
        _replaceMockRulesFromServer(data.rules);
        updateMockSaveButtons();
        renderMockRules();
        safeLocalStorageSet('http-freekit-defaults-created', 'true');
        toast('Rules reset to default', 'success');
      } catch (err) {
        toast('Error: ' + err.message, 'error');
      } finally {
        mockResetInProgress = false;
        updateMockSaveButtons();
      }
    }

    function collapseAllMockRules() {
      if (mockSaveInProgress || mockRevertInProgress || mockResetInProgress || mockCollectionMutationCount > 0) return;
      if (!preserveOpenMockEdit(null)) return;
      mockExpandedRules.clear();
      mockEditingRule = null;
      mockEditDraft = null;
      renderMockRules();
    }

    function mockDragStart(e, ruleId) {
      if (mockSaveInProgress || mockRevertInProgress || mockResetInProgress || mockCollectionMutationCount > 0) return;
      mockDragId = ruleId;
      e.dataTransfer.effectAllowed = 'move';
      e.currentTarget.classList.add('mock-rule-dragging');
    }

    function mockDragOver(e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const card = e.currentTarget.closest('.mock-rule-card');
      if (card) {
        document.querySelectorAll('.mock-rule-card').forEach(c => {
          c.classList.remove('mock-drag-over', 'mock-drag-combine');
        });
        if (e.shiftKey) {
          card.classList.add('mock-drag-combine');
        } else {
          card.classList.add('mock-drag-over');
        }
      }
    }

    function mockGroupDragOver(e, groupId) {
      if (!mockDragId || _findContainingMockGroup(mockDragId)?.id === groupId) return;
      if (e.target.closest('.mock-rule-card')) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      document.querySelectorAll('.mock-group').forEach(group => {
        group.classList.toggle('mock-drag-over', group === e.currentTarget);
      });
    }

    function mockGroupDragLeave(e) {
      if (!e.relatedTarget || !e.currentTarget.contains(e.relatedTarget)) {
        e.currentTarget.classList.remove('mock-drag-over');
      }
    }

    function mockGroupDrop(e, groupId) {
      if (mockResetInProgress || mockSaveInProgress || mockRevertInProgress || mockCollectionMutationCount > 0) {
        mockDragId = null;
        return;
      }
      if (!mockDragId || _findContainingMockGroup(mockDragId)?.id === groupId) return;
      if (e.target.closest('.mock-rule-card')) return;
      e.preventDefault();
      e.stopPropagation();
      const ruleId = mockDragId;
      mockDragId = null;
      document.querySelectorAll('.mock-rule-card, .mock-group').forEach(item => {
        item.classList.remove('mock-drag-over', 'mock-drag-combine', 'mock-rule-dragging');
      });
      return moveRuleToGroup(ruleId, groupId);
    }

    function _replaceMockRulesFromServer(rules) {
      mockRules = rules;
      // Re-add new drafts and overlay edits without changing their unsaved state.
      for (const [draftId, draft] of mockDraftRules) {
        if (mockNewDraftIds.has(draftId)) {
          if (!mockRules.some(r => r.id === draftId)) mockRules.push(draft);
        } else {
          _applyDraftToLocal(draftId, draft);
        }
      }
    }

    function _restoreMockRuleOrder(ids) {
      const currentById = new Map(mockRules.map(rule => [rule.id, rule]));
      const restored = [];
      for (const id of ids) {
        const rule = currentById.get(id);
        if (!rule) continue;
        restored.push(rule);
        currentById.delete(id);
      }
      // Preserve drafts or other rules added while the reorder request was pending.
      for (const rule of mockRules) {
        if (currentById.has(rule.id)) {
          restored.push(rule);
          currentById.delete(rule.id);
        }
      }
      mockRules = restored;
    }

    async function _readMockRulesResponse(res, action) {
      let data;
      try {
        data = await res.json();
      } catch {
        throw new Error(action + ' returned invalid JSON');
      }
      if (!res.ok) {
        throw new Error(data?.error || action + ' failed with HTTP ' + res.status);
      }
      return data;
    }

    async function _fetchAuthoritativeMockRules(action) {
      const res = await fetch(API_BASE + '/api/mock-rules');
      const data = await _readMockRulesResponse(res, action);
      if (!Array.isArray(data?.rules)) {
        throw new Error(action + ' returned an invalid response');
      }
      return data.rules;
    }

    async function _reloadMockRulesAfterRejectedReorder(operation) {
      const rules = await _fetchAuthoritativeMockRules('Reloading mock rules');
      if (operation !== mockReorderGeneration) return false;
      _replaceMockRulesFromServer(rules);
      updateMockSaveButtons();
      renderMockRules();
      return true;
    }

    async function _persistMockRuleOrder(operation, ids, previousIds) {
      try {
        const res = await fetch(API_BASE + '/api/mock-rules/reorder', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ ids })
        });
        const data = await _readMockRulesResponse(res, 'Reordering mock rules');
        if (data?.success !== true || !Array.isArray(data.rules)) {
          throw new Error('Reordering mock rules returned an invalid response');
        }
        if (operation !== mockReorderGeneration) return;
        _replaceMockRulesFromServer(data.rules);
        updateMockSaveButtons();
        renderMockRules();
      } catch (err) {
        // A newer optimistic reorder owns the visible state and is queued to run next.
        if (operation !== mockReorderGeneration) return;

        _restoreMockRuleOrder(previousIds);
        renderMockRules();

        let reloadError = null;
        try {
          await _reloadMockRulesAfterRejectedReorder(operation);
        } catch (reloadErr) {
          reloadError = reloadErr;
          console.error('Mock rule reload failed:', reloadErr);
        }
        if (operation !== mockReorderGeneration) return;

        const errorMessage = err && typeof err.message === 'string' ? err.message : String(err);
        const detail = reloadError
          ? ' Previous order restored; server reload failed: ' + (
              reloadError && typeof reloadError.message === 'string'
                ? reloadError.message
                : String(reloadError)
            )
          : ' Server order restored.';
        toast('Rule reorder failed: ' + errorMessage + '.' + detail, 'error');
      }
    }

    function _queueMockCollectionMutation(mutation) {
      if (mockSaveInProgress || mockRevertInProgress || mockResetInProgress) {
        return Promise.resolve(false);
      }
      mockCollectionMutationCount++;
      updateMockSaveButtons();
      const request = mockReorderQueue.then(mutation);
      // Keep later collection mutations ordered even after a rejected request.
      const trackedRequest = request.finally(() => {
        mockCollectionMutationCount--;
        updateMockSaveButtons();
      });
      mockReorderQueue = trackedRequest.catch(() => {});
      return trackedRequest;
    }

    function mockDrop(e, targetId) {
      e.preventDefault();
      if (mockResetInProgress || mockSaveInProgress || mockRevertInProgress) {
        mockDragId = null;
        return;
      }
      if (!mockDragId || mockDragId === targetId) return;

      // Check if Shift is held — if so, combine into a group
      if (e.shiftKey) {
        combineRulesAsGroup(mockDragId, targetId);
        document.querySelectorAll('.mock-rule-card').forEach(c => c.classList.remove('mock-drag-over', 'mock-drag-combine', 'mock-rule-dragging'));
        return;
      }

      // Normal reorder logic
      const fromIdx = mockRules.findIndex(r => r.id === mockDragId);
      const toIdx = mockRules.findIndex(r => r.id === targetId);
      if (fromIdx === -1 || toIdx === -1) return;

      const previousIds = mockRules.map(r => r.id);
      const [moved] = mockRules.splice(fromIdx, 1);
      mockRules.splice(toIdx, 0, moved);

      const ids = mockRules.map(r => r.id);
      const operation = ++mockReorderGeneration;
      const reorderRequest = _queueMockCollectionMutation(
        () => _persistMockRuleOrder(operation, ids, previousIds)
      );

      renderMockRules();
      document.querySelectorAll('.mock-rule-card').forEach(c => c.classList.remove('mock-drag-over', 'mock-drag-combine', 'mock-rule-dragging'));
      return reorderRequest;
    }

    function combineRulesAsGroup(ruleId1, ruleId2) {
      if (mockResetInProgress) return;
      return _queueMockCollectionMutation(async () => {
        try {
          const res = await fetch(API_BASE + '/api/mock-rules/combine', {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ title: 'New Group', ruleIds: [ruleId1, ruleId2] })
          });
          const data = await res.json();
          if (!res.ok || data.error) throw new Error(data.error || 'Failed to combine rules');
          if (data.success !== true || !data.group?.id || !Array.isArray(data.rules)) {
            throw new Error('Server returned an incomplete combined group');
          }

          _replaceMockRulesFromServer(data.rules);
          updateMockSaveButtons();
          renderMockRules();
          toast('Rules combined into a group (hold Shift + drop)', 'success');
        } catch (err) {
          await loadMockRules();
          toast('Error: ' + err.message, 'error');
        }
      });
    }

    function mockDragEnd(e) {
      mockDragId = null;
      document.querySelectorAll('.mock-rule-card, .mock-group').forEach(c => c.classList.remove('mock-drag-over', 'mock-drag-combine', 'mock-rule-dragging'));
    }

    function renameMockRule(ruleId) {
      startInlineRename(ruleId);
    }

    function startInlineRename(ruleId) {
      if (mockSaveInProgress || mockRevertInProgress || mockResetInProgress || mockCollectionMutationCount > 0) return;
      if (mockRenamingRuleId === ruleId) return;
      mockRenamingRuleId = ruleId;
      renderMockRules();
      setTimeout(() => {
        const input = document.getElementById('mock-rename-input');
        if (input) {
          input.focus();
          input.select();
        }
      }, 0);
    }

    function confirmInlineRename(ruleId) {
      if (mockSaveInProgress || mockRevertInProgress || mockResetInProgress || mockCollectionMutationCount > 0) return;
      if (mockRenamingRuleId !== ruleId) return;
      const input = document.getElementById('mock-rename-input');
      if (!input) { mockRenamingRuleId = null; return; }
      const rule = _findMockRuleDeep(ruleId);
      if (!rule) { mockRenamingRuleId = null; return; }
      const name = input.value.trim();
      rule.title = name || undefined;
      const draft = mockDraftRules.get(ruleId) || JSON.parse(JSON.stringify(rule));
      draft.title = rule.title;
      draft.id = ruleId;
      mockDraftRules.set(ruleId, draft);
      mockRenamingRuleId = null;
      updateMockSaveButtons();
      renderMockRules();
    }

    function cancelInlineRename() {
      if (!mockRenamingRuleId) return;
      mockRenamingRuleId = null;
      renderMockRules();
    }

    function handleRenameKeydown(event, ruleId) {
      if (event.key === 'Enter') {
        event.preventDefault();
        confirmInlineRename(ruleId);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        cancelInlineRename();
      }
    }

    async function loadMockRules() {
      const operation = ++mockRulesLoadGeneration;
      try {
        const rules = await _fetchAuthoritativeMockRules('Loading mock rules');
        if (operation !== mockRulesLoadGeneration) return false;
        _replaceMockRulesFromServer(rules);
        updateMockSaveButtons();
        await loadBreakpointRules();
        renderMockRules();
        return true;
      } catch (e) {
        if (operation === mockRulesLoadGeneration) console.error('[Error]', e.message);
        return false;
      }
    }

    async function ensureDefaultMockRules() {
      if (mockRules.length > 0 || safeLocalStorageGet('http-freekit-defaults-created')) return;
      if (mockSaveInProgress || mockRevertInProgress || mockResetInProgress || mockCollectionMutationCount > 0) return;

      return _queueMockCollectionMutation(async () => {
        // Create a default passthrough rule while owning the empty collection.
        try {
          const response = await fetch(API_BASE + '/api/mock-rules', {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify(_createDefaultMockRule())
          });
          const data = await _readMockRulesResponse(response, 'Creating default mock rules');
          if (data?.success !== true || !data.rule) {
            throw new Error('Creating default mock rules returned an invalid response');
          }
          safeLocalStorageSet('http-freekit-defaults-created', 'true');
          await loadMockRules();
        } catch (e) { console.error('[Error]', e.message); }
      });
    }

    function normalizeMockRule(rule) {
      if (rule.matchers && rule.action) {
        // Ensure preSteps is always an array
        if (!rule.preSteps) rule.preSteps = [];
        return rule;
      }
      const matchers = [];
      if (rule.method) {
        matchers.push({ type: 'method', value: rule.method });
      }
      if (rule.urlPattern) {
        matchers.push({ type: 'url-contains', value: rule.urlPattern });
      }
      return {
        ...rule,
        matchers,
        preSteps: rule.preSteps || [],
        action: {
          type: 'fixed-response',
          status: rule.response?.status || 200,
          headers: rule.response?.headers || { 'Content-Type': 'application/json' },
          body: rule.response?.body || '',
          delay: 0
        }
      };
    }

    function mockRuleSummary(rule) {
      const nr = normalizeMockRule(rule);
      const parts = [];
      let methodStr = '';
      let pathStr = '';
      for (const m of nr.matchers) {
        switch (m.type) {
          case 'method':
            methodStr = m.value === '*' ? 'ANY' : m.value;
            break;
          case 'path':
            pathStr = m.value;
            break;
          case 'host':
            parts.push(esc(m.value));
            break;
          case 'url-contains':
            pathStr = pathStr || m.value;
            break;
          case 'header':
            parts.push(esc(m.name) + (m.value ? ':' + esc(m.value) : ''));
            break;
          case 'query':
            parts.push('?' + esc(m.name) + (m.value ? '=' + esc(m.value) : ''));
            break;
          case 'regex-path':
            pathStr = pathStr || ('/' + m.value);
            break;
          case 'exact-query':
            parts.push('?' + esc((m.value || '').substring(0, 40)));
            break;
          case 'body-contains':
            parts.push('body~' + esc(m.value.substring(0, 30)));
            break;
          case 'json-body-exact':
            parts.push('json=' + esc((m.value || '').substring(0, 30)));
            break;
          case 'json-body-includes':
            parts.push('json\u2287' + esc((m.value || '').substring(0, 30)));
            break;
          case 'port':
            parts.push(':' + esc(m.value || ''));
            break;
          case 'protocol':
            parts.push(esc((m.value || '').toUpperCase()));
            break;
          case 'cookie':
            parts.push('cookie:' + esc(m.name || '') + (m.value ? '=' + esc(m.value) : ''));
            break;
          case 'form-data':
            parts.push('form:' + esc(m.name || '') + (m.value ? '=' + esc(m.value) : ''));
            break;
          case 'regex-url':
            pathStr = pathStr || ('/' + (m.value || '').substring(0, 30));
            break;
          case 'regex-body':
            parts.push('body~/' + esc((m.value || '').substring(0, 25)) + '/');
            break;
          case 'raw-body-exact':
            parts.push('body==' + esc((m.value || '').substring(0, 25)));
            break;
        }
      }
      const matchStr = (pathStr ? esc(pathStr) : '') + (parts.length ? ' ' + parts.join(' ') : '');

      let actionStr = '';
      switch (nr.action.type) {
        case 'fixed-response':
          actionStr = '<span class="status-badge status-' + Math.floor((nr.action.status || 200) / 100) + 'xx">' + (nr.action.status || 200) + '</span> Fixed Response';
          break;
        case 'forward':
          actionStr = 'Forward to ' + esc((nr.action.forwardTo || '').substring(0, 40));
          break;
        case 'close':
          actionStr = 'Close connection';
          break;
        case 'passthrough':
          actionStr = 'Passthrough';
          break;
        case 'transform-request':
          actionStr = 'Transform request';
          break;
        case 'transform-response':
          actionStr = 'Transform response' + (nr.action.statusOverride ? ' (' + nr.action.statusOverride + ')' : '');
          break;
        case 'reset':
          actionStr = 'reset connection (RST)';
          break;
        case 'timeout':
          actionStr = 'Timeout';
          break;
        case 'serve-file':
          actionStr = 'Serve file: ' + esc((nr.action.filePath || '?').substring(0, 40));
          break;
        case 'breakpoint-request':
          actionStr = 'Breakpoint (request)';
          break;
        case 'breakpoint-response':
          actionStr = 'Breakpoint (response)';
          break;
        case 'breakpoint-request-response':
          actionStr = 'Breakpoint (request + response)';
          break;
        case 'webhook':
          actionStr = 'Webhook \u2192 ' + esc((nr.action.webhookUrl || '').substring(0, 40));
          break;
      }
      if (nr.action.delay > 0) {
        actionStr += ' <span style="color:var(--text-watermark);">+' + nr.action.delay + 'ms</span>';
      }

      // Prepend pre-step summary if there are pre-steps
      const preSteps = nr.preSteps || [];
      if (preSteps.length > 0) {
        const stepLabels = preSteps.map(s => {
          switch (s.type) {
            case 'delay': return 'delay ' + (s.ms >= 1000 ? (s.ms / 1000) + 's' : s.ms + 'ms');
            case 'add-header': return '+' + esc(s.name || '?');
            case 'remove-header': return '-' + esc(s.name || '?');
            case 'rewrite-url': return 'url\u2192' + esc((s.value || '').substring(0, 20));
            case 'rewrite-method': return 'method\u2192' + esc(s.value || '?');
            default: return s.type;
          }
        });
        actionStr = '<span style="color:var(--text-watermark);">' + stepLabels.join(' \u2192 ') + ' \u2192</span> ' + actionStr;
      }

      return { methodStr: methodStr || 'ANY', matchStr: matchStr || '*', actionStr, title: rule.title || '' };
    }

    function renderMockRuleRow(rule) {
      const nr = normalizeMockRule(rule);
      const containingGroup = _findContainingMockGroup(rule.id);
      const isExpanded = mockExpandedRules.has(rule.id);
      const isEditing = mockEditingRule === rule.id;
      const isDraft = mockDraftRules.has(rule.id);
      const summary = mockRuleSummary(rule);
      const color = MOCK_METHOD_COLORS[summary.methodStr] || MOCK_METHOD_COLORS['*'];
      const disabledClass = rule.enabled === false ? ' mock-rule-disabled' : '';
      const editingClass = isEditing ? ' mock-rule-editing' : '';
      const draftClass = isDraft ? ' mock-rule-draft' : '';
      const serverMutationDisabled = mockSaveInProgress || mockRevertInProgress ||
        mockResetInProgress || mockCollectionMutationCount > 0;
      const serverMutationDisabledAttr = serverMutationDisabled ? ' disabled' : '';

      let html = '<div class="mock-rule-card' + disabledClass + editingClass + draftClass + '" data-rule-id="' + escapeHtmlAttribute(rule.id) + '" aria-expanded="' + (isExpanded || isEditing) + '" draggable="true" ondragstart="mockDragStart(event, this.dataset.ruleId)" ondragover="mockDragOver(event)" ondrop="mockDrop(event, this.dataset.ruleId)" ondragend="mockDragEnd(event)">';

      html += '<div class="mock-rule-summary" onclick="toggleMockRuleExpand(this.closest(\'.mock-rule-card\').dataset.ruleId)">';
      html += '<span class="mock-drag-handle" title="Drag to reorder">&#10303;</span>';
      html += '<div class="mock-rule-icon" style="background:' + color + ';"></div>';
      html += '<span class="method-badge method-' + (summary.methodStr === 'ANY' ? 'OPTIONS' : summary.methodStr) + '" style="font-size:11px;flex-shrink:0;">' + summary.methodStr + '</span>';
      const isRenaming = mockRenamingRuleId === rule.id;
      if (isRenaming) {
        const inputVal = esc(rule.title || '').replace(/"/g, '&quot;');
        const placeholderVal = esc(summary.matchStr).replace(/"/g, '&quot;');
        html += '<span class="mock-rule-desc" onclick="event.stopPropagation()">';
        html += '<input id="mock-rename-input" class="mock-rename-input" type="text" value="' + inputVal + '" placeholder="' + placeholderVal + '" onkeydown="handleRenameKeydown(event, this.closest(\'.mock-rule-card\').dataset.ruleId)" onblur="confirmInlineRename(this.closest(\'.mock-rule-card\').dataset.ruleId)" onclick="event.stopPropagation()" />';
      } else if (summary.title) {
        html += '<span class="mock-rule-desc" onclick="event.stopPropagation(); startInlineRename(this.closest(\'.mock-rule-card\').dataset.ruleId)" title="Click to rename"><span class="mock-rule-title">' + esc(summary.title) + '</span>';
      } else {
        html += '<span class="mock-rule-desc">' + summary.matchStr;
      }
      html += '<span class="mock-arrow">\u2192</span>' + summary.actionStr;
      html += '</span>';

      html += '<div class="mock-rule-actions" onclick="event.stopPropagation()">';

      // 1. Collapse/Expand (chevron)
      const chevron = isExpanded || isEditing ? '&#9650;' : '&#9660;';
      const collapseTitle = isExpanded || isEditing ? 'Collapse rule' : 'Show rule details';
      html += '<button class="mock-toggle-btn" onclick="toggleMockRuleExpand(this.closest(\'.mock-rule-card\').dataset.ruleId)" title="' + collapseTitle + '" aria-label="' + collapseTitle + '">';
      html += '<span style="font-size:10px;">' + chevron + '</span>';
      html += '</button>';

      // 2. Save to server (when draft) or Save draft (when editing) or Edit (pencil icon)
      if (isDraft && !isEditing) {
        html += '<button class="mock-toggle-btn mock-save-server" onclick="saveOneMockRule(this.closest(\'.mock-rule-card\').dataset.ruleId)" title="Save to server" aria-label="Save to server"' + serverMutationDisabledAttr + '>';
        html += '<i class="ph ph-floppy-disk" style="font-size:14px;"></i>';
        html += '</button>';
      }
      if (isEditing) {
        html += '<button class="mock-toggle-btn mock-enabled" onclick="saveMockRule(this.closest(\'.mock-rule-card\').dataset.ruleId)" title="Save as draft" aria-label="Save as draft">';
        html += '<i class="ph ph-floppy-disk" style="font-size:14px;"></i>';
        html += '</button>';
      } else {
        html += '<button class="mock-toggle-btn" onclick="editMockRule(this.closest(\'.mock-rule-card\').dataset.ruleId)" title="Edit this rule" aria-label="Edit this rule">';
        html += '<i class="ph ph-pencil-simple" style="font-size:14px;"></i>';
        html += '</button>';
      }

      // 3. Enable/Disable
      const toggleLabel = rule.enabled !== false ? 'Disable this rule' : 'Enable this rule';
      html += '<button class="mock-toggle-btn' + (rule.enabled !== false ? ' mock-enabled' : '') + '" onclick="toggleMockRuleEnabled(this.closest(\'.mock-rule-card\').dataset.ruleId)" title="' + toggleLabel + '" aria-label="' + toggleLabel + '">';
      html += rule.enabled !== false
        ? '<i class="ph ph-toggle-right" style="font-size:14px;"></i>'
        : '<i class="ph ph-toggle-left" style="font-size:14px;"></i>';
      html += '</button>';

      // 4. Rename (tag icon)
      html += '<button class="mock-toggle-btn" onclick="renameMockRule(this.closest(\'.mock-rule-card\').dataset.ruleId)" title="Rename this rule" aria-label="Rename this rule">';
      html += '<i class="ph ph-tag" style="font-size:14px;"></i>';
      html += '</button>';

      // 5. Clone
      html += '<button class="mock-toggle-btn" onclick="cloneMockRule(this.closest(\'.mock-rule-card\').dataset.ruleId)" title="Clone this rule" aria-label="Clone this rule">';
      html += '<i class="ph ph-copy-simple" style="font-size:14px;"></i>';
      html += '</button>';

      if (containingGroup) {
        html += '<button class="mock-toggle-btn" onclick="ungroupRule(this.closest(\'.mock-rule-card\').dataset.ruleId)" title="Move rule to top level" aria-label="Move rule to top level">';
        html += '<i class="ph ph-arrow-up" style="font-size:14px;"></i>';
        html += '</button>';
      }

      // 6. Delete
      html += '<button class="mock-toggle-btn mock-rule-delete" onclick="deleteMockRule(this.closest(\'.mock-rule-card\').dataset.ruleId)" title="Delete this rule" aria-label="Delete this rule" style="color:#ce3939;"' + serverMutationDisabledAttr + '>';
      html += '<i class="ph ph-trash-simple" style="font-size:14px;"></i>';
      html += '</button>';

      html += '</div>';
      html += '</div>';

      if (isEditing && mockEditDraft) {
        html += renderMockRuleEditor(mockEditDraft, rule.id);
      } else if (isExpanded) {
        html += renderMockRuleDetail(nr);
      }

      html += '</div>';
      return html;
    }

    function renderMockGroup(group) {
      const isCollapsed = group.collapsed;
      const isDraft = mockDraftRules.has(group.id);
      const disabledClass = group.enabled === false ? ' mock-rule-disabled' : '';
      const draftClass = isDraft ? ' mock-rule-draft' : '';
      let html = '<div class="mock-group' + disabledClass + draftClass + '" data-group-id="' + escapeHtmlAttribute(group.id) + '" aria-expanded="' + !isCollapsed + '" ondragover="mockGroupDragOver(event, this.dataset.groupId)" ondragleave="mockGroupDragLeave(event)" ondrop="mockGroupDrop(event, this.dataset.groupId)">';

      // Group header
      html += '<div class="mock-group-header" onclick="toggleMockGroup(this.closest(\'.mock-group\').dataset.groupId)">';
      html += '<span style="font-size:10px;margin-right:4px;">' + (isCollapsed ? '&#9654;' : '&#9660;') + '</span>';
      html += '<i class="ph ph-folder" style="font-size:14px;flex-shrink:0;opacity:0.5;"></i>';
      html += '<span class="mock-group-title">' + esc(group.title || 'Untitled Group') + '</span>';
      html += '<span style="color:var(--text-watermark);font-size:11px;margin-left:4px;">(' + (group.items || []).length + ' rule' + ((group.items || []).length !== 1 ? 's' : '') + ')</span>';

      html += '<div class="mock-rule-actions" onclick="event.stopPropagation()">';

      // Enable/Disable group
      const grpToggleLabel = group.enabled !== false ? 'Disable group' : 'Enable group';
      html += '<button class="mock-toggle-btn' + (group.enabled !== false ? ' mock-enabled' : '') + '" onclick="toggleMockGroupEnabled(this.closest(\'.mock-group\').dataset.groupId)" title="' + grpToggleLabel + '" aria-label="' + grpToggleLabel + '">';
      html += group.enabled !== false
        ? '<i class="ph ph-toggle-right" style="font-size:14px;"></i>'
        : '<i class="ph ph-toggle-left" style="font-size:14px;"></i>';
      html += '</button>';

      // Rename group
      html += '<button class="mock-toggle-btn" onclick="renameMockGroup(this.closest(\'.mock-group\').dataset.groupId)" title="Rename group" aria-label="Rename group">';
      html += '<i class="ph ph-tag" style="font-size:14px;"></i>';
      html += '</button>';

      // Delete group
      html += '<button class="mock-toggle-btn" onclick="deleteMockGroup(this.closest(\'.mock-group\').dataset.groupId)" title="Delete group" aria-label="Delete group" style="color:#ce3939;">';
      html += '<i class="ph ph-trash-simple" style="font-size:14px;"></i>';
      html += '</button>';

      html += '</div>';
      html += '</div>';

      // Group items
      if (!isCollapsed) {
        if ((group.items || []).length === 0) {
          html += '<div class="mock-group-empty">No rules in this group. Drag a rule here.</div>';
        } else {
          html += '<div class="mock-group-items">';
          for (const rule of (group.items || [])) {
            html += renderMockRuleRow(rule);
          }
          html += '</div>';
        }
      }

      html += '</div>';
      return html;
    }

    function _countAllMockRules(rules) {
      let count = 0;
      for (const item of rules) {
        if (item.type === 'group') {
          count += (item.items || []).length;
        } else {
          count++;
        }
      }
      return count;
    }

    function renderMockRules() {
      const list = document.getElementById('mockRulesList');
      const mockBadge = document.getElementById('mockBadgeCount');
      const totalCount = _countAllMockRules(mockRules) + breakpointRules.length;
      if (mockBadge) mockBadge.textContent = totalCount;

      if (mockRules.length === 0 && breakpointRules.length === 0 && mockEditingRule !== '__new__') {
        list.innerHTML = '<div class="empty-state" style="padding:40px;height:auto;"><div class="icon" style="font-size:60px;opacity:0.15;">&#9881;</div><p style="font-size:16px;">No rules configured yet. Click below to add one.</p></div>';
        return;
      }

      let html = '';

      if (breakpointRules.length > 0) {
        html += '<div class="mock-breakpoint-section">';
        html += '<div class="mock-breakpoint-section-header">Breakpoints</div>';
        for (const rule of breakpointRules) {
          html += renderBreakpointRuleRow(rule);
        }
        html += '</div>';
      }

      for (const item of mockRules) {
        if (item.type === 'group') {
          html += renderMockGroup(item);
        } else {
          html += renderMockRuleRow(item);
        }
      }

      if (mockEditingRule === '__new__' && mockEditDraft) {
        html += '<div class="mock-rule-card mock-rule-editing" data-rule-id="__new__">';
        html += '<div class="mock-rule-summary"><div class="mock-rule-icon" style="background:#888;"></div>';
        html += '<span class="mock-rule-desc" style="color:var(--text-watermark);">New Rule</span></div>';
        html += renderMockRuleEditor(mockEditDraft, '__new__');
        html += '</div>';
      }

      list.innerHTML = html;
    }

    function breakpointRuleSummary(rule) {
      const matchers = rule.matchers || [];
      const parts = [];
      let methodStr = 'ANY';
      for (const m of matchers) {
        switch (m.type) {
          case 'method':
            methodStr = m.value === '*' ? 'ANY' : (m.value || 'ANY');
            break;
          case 'host':
            parts.push('host=' + esc(m.value || ''));
            break;
          case 'path':
            parts.push('path=' + esc(m.value || ''));
            break;
          case 'url-contains':
            parts.push('url~' + esc(m.value || ''));
            break;
          case 'header':
            parts.push('header:' + esc(m.name || '') + (m.value ? '=' + esc(m.value) : ''));
            break;
          default:
            parts.push(esc(m.type || 'match') + (m.value ? '=' + esc(String(m.value)) : ''));
        }
      }
      return {
        methodStr,
        matchStr: parts.length ? parts.join(' ') : '*'
      };
    }

    function renderBreakpointRuleRow(rule) {
      const summary = breakpointRuleSummary(rule);
      const color = '#f1971f';
      const disabledClass = rule.enabled === false ? ' mock-rule-disabled' : '';
      const serverMutationDisabled = mockSaveInProgress || mockRevertInProgress ||
        mockResetInProgress || mockCollectionMutationCount > 0;
      const serverMutationDisabledAttr = serverMutationDisabled
        ? ' disabled data-mock-save-lock-disabled="true"'
        : '';
      let html = '<div class="mock-rule-card mock-breakpoint-rule' + disabledClass + '" data-breakpoint-id="' + escapeHtmlAttribute(rule.id) + '">';
      html += '<div class="mock-rule-summary">';
      html += '<div class="mock-rule-icon" style="background:' + color + ';"></div>';
      html += '<span class="method-badge method-' + (summary.methodStr === 'ANY' ? 'OPTIONS' : summary.methodStr) + '" style="font-size:11px;flex-shrink:0;">' + esc(summary.methodStr) + '</span>';
      html += '<span class="mock-rule-desc">' + summary.matchStr + '<span class="mock-arrow">\u2192</span><span style="color:#f1971f;">Breakpoint</span></span>';
      html += '<div class="mock-rule-actions" onclick="event.stopPropagation()">';
      const toggleLabel = rule.enabled !== false ? 'Disable this breakpoint' : 'Enable this breakpoint';
      html += '<button class="mock-toggle-btn' + (rule.enabled !== false ? ' mock-enabled' : '') + '" onclick="toggleBreakpointRuleEnabled(this.closest(\'.mock-breakpoint-rule\').dataset.breakpointId)" title="' + toggleLabel + '" aria-label="' + toggleLabel + '"' + serverMutationDisabledAttr + '>';
      html += rule.enabled !== false
        ? '<i class="ph ph-toggle-right" style="font-size:14px;"></i>'
        : '<i class="ph ph-toggle-left" style="font-size:14px;"></i>';
      html += '</button>';
      html += '<button class="mock-toggle-btn" onclick="deleteBreakpointRule(this.closest(\'.mock-breakpoint-rule\').dataset.breakpointId)" title="Delete this breakpoint" aria-label="Delete this breakpoint" style="color:#ce3939;"' + serverMutationDisabledAttr + '>';
      html += '<i class="ph ph-trash-simple" style="font-size:14px;"></i>';
      html += '</button>';
      html += '</div></div></div>';
      return html;
    }

    async function toggleBreakpointRuleEnabled(ruleId) {
      if (mockSaveInProgress || mockRevertInProgress || mockResetInProgress || mockCollectionMutationCount > 0) return;
      const rule = breakpointRules.find(r => r.id === ruleId);
      if (!rule) return;
      const enabled = rule.enabled === false;
      return _queueMockCollectionMutation(async () => {
        try {
          const res = await fetch(API_BASE + '/api/breakpoints/' + encodeURIComponent(ruleId), {
            method: 'PATCH',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ enabled })
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.error) throw new Error(data.error || 'Failed to update breakpoint');
          toast(enabled ? 'Breakpoint enabled' : 'Breakpoint disabled', 'success');
        } catch (err) {
          toast('Error: ' + err.message, 'error');
        }
        await loadBreakpointRules();
      });
    }

    async function deleteBreakpointRule(ruleId) {
      if (mockSaveInProgress || mockRevertInProgress || mockResetInProgress || mockCollectionMutationCount > 0) return;
      return _queueMockCollectionMutation(async () => {
        try {
          const res = await fetch(API_BASE + '/api/breakpoints/' + encodeURIComponent(ruleId), { method: 'DELETE' });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.error) throw new Error(data.error || 'Failed to delete breakpoint');
          toast('Breakpoint deleted', 'success');
          await loadBreakpointRules();
        } catch (err) {
          toast('Error: ' + err.message, 'error');
        }
      });
    }

    function renderMockRuleDetail(nr) {
      let html = '<div class="mock-rule-editor">';
      html += '<div class="mock-editor-content">';

      html += '<div class="mock-editor-col">';
      html += '<div class="mock-section-label">When a request matches\u2026</div>';
      for (const m of nr.matchers) {
        html += '<div style="font-size:12px;font-family:var(--font-mono);margin-bottom:4px;color:var(--text-lowlight);">';
        switch (m.type) {
          case 'wildcard': html += '<span style="color:var(--text-watermark);">Wildcard</span> (matches any request)'; break;
          case 'method': html += '<span style="color:var(--text-watermark);">Method</span> = ' + esc(m.value); break;
          case 'path': html += '<span style="color:var(--text-watermark);">Path (' + (m.matchType || 'prefix') + ')</span> = ' + esc(m.value); break;
          case 'host': html += '<span style="color:var(--text-watermark);">Host</span> = ' + esc(m.value); break;
          case 'hostname': html += '<span style="color:var(--text-watermark);">Hostname</span> = ' + esc(m.value); break;
          case 'header': html += '<span style="color:var(--text-watermark);">Header</span> ' + esc(m.name) + (m.value ? ' = ' + esc(m.value) : ' (present)'); break;
          case 'query': html += '<span style="color:var(--text-watermark);">Query</span> ' + esc(m.name) + (m.value ? ' = ' + esc(m.value) : ' (present)'); break;
          case 'regex-path': html += '<span style="color:var(--text-watermark);">Regex Path</span> = ' + esc(m.value); break;
          case 'exact-query': html += '<span style="color:var(--text-watermark);">Exact Query</span> = ' + esc(m.value); break;
          case 'url-contains': html += '<span style="color:var(--text-watermark);">URL contains</span> ' + esc(m.value); break;
          case 'body-contains': html += '<span style="color:var(--text-watermark);">Body contains</span> ' + esc(m.value); break;
          case 'json-body-exact': html += '<span style="color:var(--text-watermark);">JSON Body (exact)</span> = ' + esc((m.value || '').substring(0, 80)); break;
          case 'json-body-includes': html += '<span style="color:var(--text-watermark);">JSON Body (partial)</span> \u2287 ' + esc((m.value || '').substring(0, 80)); break;
          case 'port': html += '<span style="color:var(--text-watermark);">Port</span> = ' + esc(m.value); break;
          case 'protocol': html += '<span style="color:var(--text-watermark);">Protocol</span> = ' + esc((m.value || '').toUpperCase()); break;
          case 'cookie': html += '<span style="color:var(--text-watermark);">Cookie</span> ' + esc(m.name) + (m.value ? ' = ' + esc(m.value) : ' (present)'); break;
          case 'form-data': html += '<span style="color:var(--text-watermark);">Form Data</span> ' + esc(m.name) + (m.value ? ' = ' + esc(m.value) : ' (present)'); break;
          case 'multipart-form-data': html += '<span style="color:var(--text-watermark);">Multipart</span> ' + esc(m.name) + (m.value ? ' = ' + esc(m.value) : ' (present)'); break;
          case 'regex-url': html += '<span style="color:var(--text-watermark);">Regex URL</span> = ' + esc(m.value); break;
          case 'regex-body': html += '<span style="color:var(--text-watermark);">Regex Body</span> = ' + esc((m.value || '').substring(0, 80)); break;
          case 'raw-body-exact': html += '<span style="color:var(--text-watermark);">Raw Body (exact)</span> = ' + esc((m.value || '').substring(0, 80)); break;
        }
        html += '</div>';
      }

      // Show pre-steps in read-only detail view
      const detailPreSteps = nr.preSteps || [];
      if (detailPreSteps.length > 0) {
        html += '<div class="mock-section-label" style="margin-top:12px;">Before responding:</div>';
        for (const step of detailPreSteps) {
          html += '<div style="font-size:12px;font-family:var(--font-mono);margin-bottom:4px;color:var(--text-lowlight);">';
          switch (step.type) {
            case 'delay': html += '<span style="color:var(--text-watermark);">Delay</span> ' + (step.ms || 0) + 'ms'; break;
            case 'add-header': html += '<span style="color:var(--text-watermark);">Add header</span> ' + esc(step.name || '') + ': ' + esc(step.value || ''); break;
            case 'remove-header': html += '<span style="color:var(--text-watermark);">Remove header</span> ' + esc(step.name || ''); break;
            case 'rewrite-url': html += '<span style="color:var(--text-watermark);">Rewrite URL</span> \u2192 ' + esc(step.value || ''); break;
            case 'rewrite-method': html += '<span style="color:var(--text-watermark);">Rewrite method</span> \u2192 ' + esc(step.value || ''); break;
            default: html += esc(step.type); break;
          }
          html += '</div>';
        }
      }

      html += '</div>';

      html += '<div class="mock-editor-col">';
      html += '<div class="mock-section-label">\u2026then respond with:</div>';
      html += '<div style="font-size:12px;color:var(--text-lowlight);margin-bottom:4px;">';
      switch (nr.action.type) {
        case 'fixed-response':
          html += 'Return status <strong>' + (nr.action.status || 200) + '</strong>';
          break;
        case 'forward':
          html += 'Forward to <strong>' + esc(nr.action.forwardTo || '') + '</strong>';
          break;
        case 'close':
          html += 'Close connection immediately';
          break;
        case 'passthrough':
          html += 'Pass through without modification';
          break;
        case 'transform-request':
          html += 'Transform request before forwarding';
          break;
        case 'transform-response':
          html += 'Transform response after forwarding';
          if (nr.action.statusOverride) html += ' (status override: <strong>' + nr.action.statusOverride + '</strong>)';
          break;
        case 'reset':
          html += 'Reset connection (RST)';
          break;
        case 'timeout':
          html += 'Timeout &mdash; never respond';
          break;
        case 'serve-file':
          html += 'Serve file: <strong>' + esc(nr.action.filePath || '?') + '</strong>';
          if (nr.action.contentType) html += ' (' + esc(nr.action.contentType) + ')';
          break;
        case 'breakpoint-request':
          html += 'Breakpoint &mdash; pause and edit request';
          break;
        case 'breakpoint-response':
          html += 'Breakpoint &mdash; pause and edit response';
          break;
        case 'breakpoint-request-response':
          html += 'Breakpoint &mdash; pause and edit both request &amp; response';
          break;
        case 'webhook':
          html += 'Webhook &rarr; <strong>' + esc(nr.action.webhookUrl || '') + '</strong>';
          break;
      }
      if (nr.action.delay > 0) html += ' (delay: ' + nr.action.delay + 'ms)';
      html += '</div>';

      if ((nr.action.type === 'fixed-response' || nr.action.type === 'transform-request' || nr.action.type === 'transform-response') && nr.action.headers) {
        const hdrEntries = Object.entries(nr.action.headers);
        if (hdrEntries.length > 0) {
          const hdrLabel = nr.action.type === 'transform-request' ? 'Add/Replace Request Headers' : nr.action.type === 'transform-response' ? 'Add/Replace Response Headers' : 'Response Headers';
          html += '<div style="margin-top:8px;"><span style="font-size:11px;color:var(--text-watermark);text-transform:uppercase;">' + hdrLabel + '</span>';
          for (const [k, v] of hdrEntries) {
            html += '<div style="font-family:var(--font-mono);font-size:12px;color:var(--text-lowlight);">' + esc(k) + ': ' + esc(v) + '</div>';
          }
          html += '</div>';
        }
      }

      if ((nr.action.type === 'transform-request' || nr.action.type === 'transform-response') && nr.action.removeHeaders && nr.action.removeHeaders.length > 0) {
        const rmLabel = nr.action.type === 'transform-request' ? 'Remove Request Headers' : 'Remove Response Headers';
        html += '<div style="margin-top:8px;"><span style="font-size:11px;color:var(--text-watermark);text-transform:uppercase;">' + rmLabel + '</span>';
        for (const h of nr.action.removeHeaders) {
          html += '<div style="font-family:var(--font-mono);font-size:12px;color:#ce3939;">' + esc(h) + '</div>';
        }
        html += '</div>';
      }

      if (nr.action.type === 'fixed-response' && nr.action.body) {
        html += '<div style="margin-top:8px;"><span style="font-size:11px;color:var(--text-watermark);text-transform:uppercase;">Response Body</span>';
        html += '<div class="body-content" style="max-height:200px;margin-top:4px;">' + formatBody(nr.action.body, nr.action.headers?.['Content-Type']) + '</div>';
        html += '</div>';
      }

      if (nr.action.type === 'transform-request' && nr.action.body) {
        html += '<div style="margin-top:8px;"><span style="font-size:11px;color:var(--text-watermark);text-transform:uppercase;">Replacement Body</span>';
        html += '<div class="body-content" style="max-height:200px;margin-top:4px;">' + formatBody(nr.action.body, 'text/plain') + '</div>';
        html += '</div>';
      }

      if (nr.action.type === 'webhook' && nr.action.webhookHeaders) {
        const whEntries = Object.entries(nr.action.webhookHeaders);
        if (whEntries.length > 0) {
          html += '<div style="margin-top:8px;"><span style="font-size:11px;color:var(--text-watermark);text-transform:uppercase;">Custom Headers</span>';
          for (const [k, v] of whEntries) {
            html += '<div style="font-family:var(--font-mono);font-size:12px;color:var(--text-lowlight);">' + esc(k) + ': ' + esc(v) + '</div>';
          }
          html += '</div>';
        }
      }

      html += '</div>';

      html += '</div>';
      html += '</div>';
      return html;
    }

    function renderMockRuleEditor(draft, ruleId) {
      const eid = ruleId.replace(/[^a-zA-Z0-9_-]/g, '');
      let html = '<div class="mock-rule-editor" id="mockEditor_' + eid + '">';

      html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">';
      html += '<span style="font-size:11px;color:var(--text-watermark);">Priority:</span>';
      html += '<select class="mock-priority-select" onchange="mockEditDraft.priority=this.value">';
      html += '<option value="normal"' + (draft.priority !== 'high' ? ' selected' : '') + '>Normal</option>';
      html += '<option value="high"' + (draft.priority === 'high' ? ' selected' : '') + '>High</option>';
      html += '</select>';
      html += '</div>';

      html += '<div class="mock-editor-content">';

      html += '<div class="mock-editor-col">';
      html += '<div class="mock-section-label">When a request matches\u2026</div>';
      html += '<div id="mockMatchers_' + eid + '">';
      draft.matchers.forEach((m, idx) => {
        html += renderMockMatcherRow(m, idx, eid);
      });
      html += '</div>';
      html += '<button class="mock-add-matcher-btn" onclick="addMockMatcher(\'' + eid + '\')">+ Add condition</button>';

      // Pre-steps section (step chaining)
      const preSteps = draft.preSteps || [];
      html += '<div class="mock-section-label mock-presteps-label" style="margin-top:12px;' + (preSteps.length === 0 ? 'display:none;' : '') + '">Before responding:</div>';
      html += '<div id="mockPreSteps_' + eid + '">';
      preSteps.forEach((step, idx) => {
        html += renderMockPreStepRow(step, idx, eid);
      });
      html += '</div>';
      html += '<button class="mock-add-matcher-btn" onclick="addMockPreStep(\'' + eid + '\')">+ Add pre-step</button>';

      html += '</div>';

      html += '<div class="mock-editor-col">';
      html += '<div class="mock-section-label">\u2026then respond with:</div>';
      html += '<div class="mock-action-config" id="mockActionConfig_' + eid + '">';
      // Group action types: common first, then advanced
      const _primaryActions = ['fixed-response', 'forward', 'passthrough', 'transform-request', 'serve-file'];
      const _advancedActions = ['close', 'reset', 'timeout', 'breakpoint-request', 'breakpoint-response', 'breakpoint-request-response', 'webhook', 'transform-response'];
      html += '<select style="width:100%;margin-bottom:8px;" onchange="changeMockActionType(this.value, \'' + eid + '\')">'; 
      html += '<optgroup label="Common">';
      for (const at of MOCK_ACTION_TYPES.filter(a => _primaryActions.includes(a.value))) {
        html += '<option value="' + at.value + '"' + (draft.action.type === at.value ? ' selected' : '') + '>' + at.label + '</option>';
      }
      html += '</optgroup>';
      html += '<optgroup label="Advanced">';
      for (const at of MOCK_ACTION_TYPES.filter(a => _advancedActions.includes(a.value))) {
        html += '<option value="' + at.value + '"' + (draft.action.type === at.value ? ' selected' : '') + '>' + at.label + '</option>';
      }
      html += '</optgroup>';
      html += '</select>';
      html += renderMockActionFields(draft.action, eid);
      html += '</div>';
      html += '</div>';

      html += '</div>';

      html += '<div class="mock-editor-buttons">';
      html += '<button class="btn btn-primary" onclick="saveMockRule(this.closest(\'.mock-rule-card\').dataset.ruleId)">Save Draft</button>';
      html += '<button class="btn" onclick="cancelMockEdit()">Cancel</button>';
      html += '</div>';

      html += '</div>';
      return html;
    }

    function renderMockMatcherRow(matcher, idx, eid) {
      let html = '<div class="mock-matcher-row" data-idx="' + idx + '">';
      html += '<select onchange="updateMockMatcher(' + idx + ', \'type\', this.value, \'' + eid + '\')">';
      for (const grp of MOCK_MATCHER_GROUPS) {
        html += '<optgroup label="' + grp.group + '">';
        for (const mt of grp.items) {
          html += '<option value="' + mt.value + '"' + (matcher.type === mt.value ? ' selected' : '') + '>' + mt.label + '</option>';
        }
        html += '</optgroup>';
      }
      html += '</select>';

      switch (matcher.type) {
        case 'wildcard':
          html += '<span style="color:var(--text-lowlight);font-size:12px;padding:4px 8px;">Matches any request</span>';
          break;
        case 'method':
          html += '<select onchange="updateMockMatcher(' + idx + ', \'value\', this.value, \'' + eid + '\')">';
          for (const meth of ['*', 'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']) {
            html += '<option value="' + meth + '"' + (matcher.value === meth ? ' selected' : '') + '>' + (meth === '*' ? 'ANY' : meth) + '</option>';
          }
          html += '</select>';
          break;
        case 'path':
          html += '<select class="mock-matcher-extra" onchange="updateMockMatcher(' + idx + ', \'matchType\', this.value, \'' + eid + '\')">';
          for (const pt of ['prefix', 'exact', 'regex']) {
            html += '<option value="' + pt + '"' + ((matcher.matchType || 'prefix') === pt ? ' selected' : '') + '>' + pt + '</option>';
          }
          html += '</select>';
          html += '<input type="text" placeholder="/api/users" value="' + esc(matcher.value || '') + '" onchange="updateMockMatcher(' + idx + ', \'value\', this.value, \'' + eid + '\')">';
          break;
        case 'host':
          html += '<input type="text" placeholder="example.com:8080 or *.example.com" value="' + esc(matcher.value || '') + '" onchange="updateMockMatcher(' + idx + ', \'value\', this.value, \'' + eid + '\')">';
          break;
        case 'hostname':
          html += '<input type="text" placeholder="example.com (hostname only, no port)" value="' + esc(matcher.value || '') + '" onchange="updateMockMatcher(' + idx + ', \'value\', this.value, \'' + eid + '\')">';
          break;
        case 'header':
          html += '<input type="text" style="max-width:140px;" placeholder="Header name" value="' + esc(matcher.name || '') + '" onchange="updateMockMatcher(' + idx + ', \'name\', this.value, \'' + eid + '\')">';
          html += '<input type="text" placeholder="Value (optional, * for wildcard)" value="' + esc(matcher.value || '') + '" onchange="updateMockMatcher(' + idx + ', \'value\', this.value, \'' + eid + '\')">';
          break;
        case 'query':
          html += '<input type="text" style="max-width:140px;" placeholder="Param name" value="' + esc(matcher.name || '') + '" onchange="updateMockMatcher(' + idx + ', \'name\', this.value, \'' + eid + '\')">';
          html += '<input type="text" placeholder="Value (optional)" value="' + esc(matcher.value || '') + '" onchange="updateMockMatcher(' + idx + ', \'value\', this.value, \'' + eid + '\')">';
          break;
        case 'regex-path':
          html += '<input type="text" placeholder="^/api/users/\\d+$" value="' + esc(matcher.value || '') + '" onchange="updateMockMatcher(' + idx + ', \'value\', this.value, \'' + eid + '\')">';
          break;
        case 'exact-query':
          html += '<input type="text" placeholder="page=1&amp;sort=name" value="' + esc(matcher.value || '') + '" onchange="updateMockMatcher(' + idx + ', \'value\', this.value, \'' + eid + '\')">';
          break;
        case 'url-contains':
          html += '<input type="text" placeholder="String to match in URL..." value="' + esc(matcher.value || '') + '" onchange="updateMockMatcher(' + idx + ', \'value\', this.value, \'' + eid + '\')">';
          break;
        case 'body-contains':
          html += '<textarea placeholder="String to match in request body..." style="min-height:60px;font-family:var(--font-mono);font-size:12px;" onchange="updateMockMatcher(' + idx + ', \'value\', this.value, \'' + eid + '\')">' + esc(matcher.value || '') + '</textarea>';
          break;
        case 'json-body-exact':
          html += '<textarea placeholder=\'{"username":"admin","password":"test"}\' style="min-height:40px;font-family:monospace;font-size:12px;" onchange="updateMockMatcher(' + idx + ', \'value\', this.value, \'' + eid + '\')">' + esc(matcher.value || '') + '</textarea>';
          break;
        case 'json-body-includes':
          html += '<textarea placeholder=\'{"username":"admin"}\' style="min-height:40px;font-family:monospace;font-size:12px;" onchange="updateMockMatcher(' + idx + ', \'value\', this.value, \'' + eid + '\')">' + esc(matcher.value || '') + '</textarea>';
          break;
        case 'port':
          html += '<input type="number" placeholder="8080" value="' + esc(matcher.value || '') + '" onchange="updateMockMatcher(' + idx + ', \'value\', this.value, \'' + eid + '\')" style="max-width:100px;">';
          break;
        case 'protocol':
          html += '<select onchange="updateMockMatcher(' + idx + ', \'value\', this.value, \'' + eid + '\')">';
          html += '<option value="http"' + (matcher.value === 'http' ? ' selected' : '') + '>HTTP</option>';
          html += '<option value="https"' + (matcher.value === 'https' ? ' selected' : '') + '>HTTPS</option>';
          html += '</select>';
          break;
        case 'cookie':
          html += '<input type="text" placeholder="Cookie name" value="' + esc(matcher.name || '') + '" onchange="updateMockMatcher(' + idx + ', \'name\', this.value, \'' + eid + '\')" style="flex:1;">';
          html += '<input type="text" placeholder="Value (optional)" value="' + esc(matcher.value || '') + '" onchange="updateMockMatcher(' + idx + ', \'value\', this.value, \'' + eid + '\')" style="flex:1;">';
          break;
        case 'form-data':
          html += '<input type="text" placeholder="Field name" value="' + esc(matcher.name || '') + '" onchange="updateMockMatcher(' + idx + ', \'name\', this.value, \'' + eid + '\')" style="flex:1;">';
          html += '<input type="text" placeholder="Value (optional)" value="' + esc(matcher.value || '') + '" onchange="updateMockMatcher(' + idx + ', \'value\', this.value, \'' + eid + '\')" style="flex:1;">';
          break;
        case 'regex-url':
          html += '<input type="text" placeholder="^https://api\\.example\\.com/.*$" value="' + esc(matcher.value || '') + '" onchange="updateMockMatcher(' + idx + ', \'value\', this.value, \'' + eid + '\')">';
          break;
        case 'regex-body':
          html += '<textarea placeholder="Regular expression to match against body" style="min-height:40px;" onchange="updateMockMatcher(' + idx + ', \'value\', this.value, \'' + eid + '\')">' + esc(matcher.value || '') + '</textarea>';
          break;
        case 'raw-body-exact':
          html += '<textarea placeholder="Exact body content to match" style="min-height:60px;" onchange="updateMockMatcher(' + idx + ', \'value\', this.value, \'' + eid + '\')">' + esc(matcher.value || '') + '</textarea>';
          break;
        case 'multipart-form-data':
          html += '<input type="text" placeholder="Field name" value="' + esc(matcher.name || '') + '" onchange="updateMockMatcher(' + idx + ', \'name\', this.value, \'' + eid + '\')" style="flex:1;">';
          html += '<input type="text" placeholder="Value (optional)" value="' + esc(matcher.value || '') + '" onchange="updateMockMatcher(' + idx + ', \'value\', this.value, \'' + eid + '\')" style="flex:1;">';
          break;
      }

      html += '<button class="mock-remove-btn" onclick="removeMockMatcher(' + idx + ', \'' + eid + '\')" title="Remove condition">';
      html += '<i class="ph ph-x" style="font-size:14px;"></i>';
      html += '</button>';
      html += '</div>';
      return html;
    }

    function renderMockActionFields(action, eid) {
      let html = '';
      switch (action.type) {
        case 'fixed-response':
          html += '<div class="form-row" style="gap:8px;margin-bottom:8px;">';
          html += '<div class="form-group" style="max-width:100px;margin-bottom:0;"><label style="font-size:11px;margin-bottom:3px;">Status</label>';
          html += '<input type="number" min="100" max="599" value="' + (action.status || 200) + '" onchange="mockEditDraft.action.status=parseInt(this.value)||200"></div>';
          html += '<div class="form-group" style="margin-bottom:0;max-width:200px;"><label style="font-size:11px;margin-bottom:3px;">Delay (ms)</label>';
          html += '<input type="number" min="0" value="' + (action.delay || 0) + '" onchange="mockEditDraft.action.delay=parseInt(this.value)||0"></div>';
          html += '</div>';
          html += '<div style="margin-bottom:8px;">';
          html += '<label style="font-size:11px;color:var(--text-watermark);display:block;margin-bottom:4px;">Response Headers</label>';
          html += '<div id="mockRespHeaders_' + eid + '">';
          const headers = action.headers || {};
          const hdrEntries = Object.entries(headers);
          hdrEntries.forEach(([k, v], hi) => {
            html += '<div class="mock-header-row">';
            html += '<input type="text" placeholder="Header name" value="' + esc(k) + '" onchange="updateMockRespHeader(' + hi + ', \'key\', this.value, \'' + eid + '\')">';
            html += '<input type="text" placeholder="Value" value="' + esc(v) + '" onchange="updateMockRespHeader(' + hi + ', \'val\', this.value, \'' + eid + '\')">';
            html += '<button class="mock-remove-btn" onclick="removeMockRespHeader(' + hi + ', \'' + eid + '\')">';
            html += '<i class="ph ph-x" style="font-size:12px;"></i>';
            html += '</button></div>';
          });
          html += '</div>';
          html += '<button class="mock-add-matcher-btn" onclick="addMockRespHeader(\'' + eid + '\')">+ Add header</button>';
          html += '</div>';
          html += '<div class="form-group" style="margin-bottom:0;"><label style="font-size:11px;margin-bottom:3px;">Response Body</label>';
          html += '<textarea placeholder=\'{"message": "Mocked!"}\' onchange="mockEditDraft.action.body=this.value">' + esc(action.body || '') + '</textarea></div>';
          break;

        case 'forward':
          html += '<div class="form-group" style="margin-bottom:8px;"><label style="font-size:11px;margin-bottom:3px;">Forward to URL</label>';
          html += '<input type="text" placeholder="http://localhost:3000" value="' + esc(action.forwardTo || '') + '" onchange="mockEditDraft.action.forwardTo=this.value"></div>';
          html += '<div class="form-group" style="margin-bottom:0;max-width:200px;"><label style="font-size:11px;margin-bottom:3px;">Delay (ms)</label>';
          html += '<input type="number" min="0" value="' + (action.delay || 0) + '" onchange="mockEditDraft.action.delay=parseInt(this.value)||0"></div>';
          break;

        case 'close':
          html += '<div style="font-size:12px;color:var(--text-lowlight);padding:8px 0;">The connection will be dropped immediately without sending a response.</div>';
          html += '<div class="form-group" style="margin-bottom:0;max-width:200px;"><label style="font-size:11px;margin-bottom:3px;">Delay (ms)</label>';
          html += '<input type="number" min="0" value="' + (action.delay || 0) + '" onchange="mockEditDraft.action.delay=parseInt(this.value)||0"></div>';
          break;

        case 'passthrough':
          html += '<div style="font-size:12px;color:var(--text-lowlight);padding:8px 0;">The request will be forwarded to the original server without modification.</div>';
          break;

        case 'transform-request':
          html += '<div style="font-size:13px;font-weight:600;color:var(--text-watermark);margin-bottom:12px;">Request Transformers</div>';

          // 1. Method
          html += '<div class="mock-transform-row">';
          html += '<select class="mock-transform-select" onchange="mockEditDraft.action.methodMode=this.value;rerenderMockActionConfig(\'' + eid + '\')">';
          html += '<option value="original"' + (action.methodMode === 'original' || !action.methodMode ? ' selected' : '') + '>Use the original request method</option>';
          ['GET','POST','PUT','DELETE','PATCH','HEAD','OPTIONS'].forEach(m => {
            html += '<option value="' + m + '"' + (action.methodMode === m ? ' selected' : '') + '>Replace method with ' + m + '</option>';
          });
          html += '</select></div>';

          // 2. URL
          html += '<div class="mock-transform-row">';
          html += '<select class="mock-transform-select" onchange="mockEditDraft.action.urlMode=this.value;rerenderMockActionConfig(\'' + eid + '\')">';
          html += '<option value="original"' + (action.urlMode !== 'modify' ? ' selected' : '') + '>Use the original URL</option>';
          html += '<option value="modify"' + (action.urlMode === 'modify' ? ' selected' : '') + '>Modify the request URL</option>';
          html += '</select>';
          if (action.urlMode === 'modify') {
            html += '<input type="text" class="mock-transform-input" placeholder="https://new-host.com/new-path" value="' + esc(action.urlReplace || '') + '" onchange="mockEditDraft.action.urlReplace=this.value">';
          }
          html += '</div>';

          // 3. Headers
          html += '<div class="mock-transform-row">';
          html += '<select class="mock-transform-select" onchange="mockEditDraft.action.headersMode=this.value;rerenderMockActionConfig(\'' + eid + '\')">';
          html += '<option value="original"' + (action.headersMode !== 'update' && action.headersMode !== 'replace' ? ' selected' : '') + '>Use the original request headers</option>';
          html += '<option value="update"' + (action.headersMode === 'update' ? ' selected' : '') + '>Update the request headers</option>';
          html += '<option value="replace"' + (action.headersMode === 'replace' ? ' selected' : '') + '>Replace the request headers</option>';
          html += '</select>';
          if (action.headersMode === 'update' || action.headersMode === 'replace') {
            html += '<div style="margin-top:6px;">';
            html += '<div id="mockReqHeaders_' + eid + '">';
            const hdrEntries = Object.entries(action.headers || {});
            hdrEntries.forEach(([k, v], hi) => {
              html += '<div class="mock-header-row">';
              html += '<input type="text" placeholder="Header name" value="' + esc(k) + '" onchange="updateMockTransformHeader(\'req\',' + hi + ', \'key\', this.value, \'' + eid + '\')">';
              html += '<input type="text" placeholder="Value" value="' + esc(v) + '" onchange="updateMockTransformHeader(\'req\',' + hi + ', \'val\', this.value, \'' + eid + '\')">';
              html += '<button class="mock-remove-btn" onclick="removeMockTransformHeader(\'req\',' + hi + ', \'' + eid + '\')"><i class="ph ph-x" style="font-size:12px;"></i></button></div>';
            });
            html += '</div>';
            html += '<button class="mock-add-matcher-btn" onclick="addMockTransformHeader(\'req\',\'' + eid + '\')">+ Add header</button>';
            if (action.headersMode === 'update') {
              html += '<label style="font-size:11px;color:var(--text-watermark);display:block;margin:8px 0 4px;">Remove headers (one per line)</label>';
              html += '<textarea placeholder="Authorization\nCookie" style="min-height:40px;" onchange="mockEditDraft.action.removeHeaders=this.value.split(\'\\n\').filter(h=>h.trim())">' + esc((action.removeHeaders || []).join('\n')) + '</textarea>';
            }
            html += '</div>';
          }
          html += '</div>';

          // 4. Body
          html += '<div class="mock-transform-row">';
          html += '<select class="mock-transform-select" onchange="mockEditDraft.action.bodyMode=this.value;rerenderMockActionConfig(\'' + eid + '\')">';
          const reqBodyMode = action.bodyMode || 'original';
          html += '<option value="original"' + (reqBodyMode === 'original' ? ' selected' : '') + '>Use the original request body</option>';
          html += '<option value="replace-fixed"' + (reqBodyMode === 'replace-fixed' ? ' selected' : '') + '>Replace the request body with a fixed value</option>';
          html += '<option value="json-merge"' + (reqBodyMode === 'json-merge' ? ' selected' : '') + '>Update JSON request body by merging data</option>';
          html += '<option value="match-replace"' + (reqBodyMode === 'match-replace' ? ' selected' : '') + '>Match and replace text in the request body</option>';
          html += '</select>';
          if (reqBodyMode === 'replace-fixed') {
            html += '<textarea class="mock-transform-textarea" placeholder="Replacement body content" onchange="mockEditDraft.action.body=this.value">' + esc(action.body || '') + '</textarea>';
          } else if (reqBodyMode === 'json-merge') {
            html += '<textarea class="mock-transform-textarea" placeholder=\'{"key": "new-value"}\' onchange="mockEditDraft.action.body=this.value">' + esc(action.body || '') + '</textarea>';
            html += '<div style="font-size:11px;color:var(--text-watermark);margin-top:4px;">Properties in this JSON will be merged into the request body, overwriting matching keys.</div>';
          } else if (reqBodyMode === 'match-replace') {
            html += '<input type="text" class="mock-transform-input" placeholder="Text to find" value="' + esc(action.bodyMatchPattern || '') + '" onchange="mockEditDraft.action.bodyMatchPattern=this.value">';
            html += '<input type="text" class="mock-transform-input" placeholder="Replace with" value="' + esc(action.bodyReplaceWith || '') + '" onchange="mockEditDraft.action.bodyReplaceWith=this.value">';
          }
          html += '</div>';

          // Response transformers section
          html += '<div style="font-size:13px;font-weight:600;color:var(--text-watermark);margin:16px 0 12px;padding-top:12px;border-top:1px solid var(--border-color);">Response Transformers</div>';

          // Response status
          html += '<div class="mock-transform-row">';
          html += '<select class="mock-transform-select" onchange="mockEditDraft.action.resStatusMode=this.value;rerenderMockActionConfig(\'' + eid + '\')">';
          html += '<option value="original"' + (action.resStatusMode !== 'replace' ? ' selected' : '') + '>Use the original response status</option>';
          html += '<option value="replace"' + (action.resStatusMode === 'replace' ? ' selected' : '') + '>Replace the response status</option>';
          html += '</select>';
          if (action.resStatusMode === 'replace') {
            html += '<input type="number" class="mock-transform-input" min="100" max="599" placeholder="200" value="' + (action.resStatusOverride || '') + '" onchange="mockEditDraft.action.resStatusOverride=parseInt(this.value)" style="max-width:100px;">';
          }
          html += '</div>';

          // Response headers
          html += '<div class="mock-transform-row">';
          html += '<select class="mock-transform-select" onchange="mockEditDraft.action.resHeadersMode=this.value;rerenderMockActionConfig(\'' + eid + '\')">';
          html += '<option value="original"' + (action.resHeadersMode !== 'update' && action.resHeadersMode !== 'replace' ? ' selected' : '') + '>Use the original response headers</option>';
          html += '<option value="update"' + (action.resHeadersMode === 'update' ? ' selected' : '') + '>Update the response headers</option>';
          html += '<option value="replace"' + (action.resHeadersMode === 'replace' ? ' selected' : '') + '>Replace the response headers</option>';
          html += '</select>';
          if (action.resHeadersMode === 'update' || action.resHeadersMode === 'replace') {
            html += '<div style="margin-top:6px;">';
            html += '<div id="mockResHeaders_' + eid + '">';
            const resHdrEntries = Object.entries(action.resHeaders || {});
            resHdrEntries.forEach(([k, v], hi) => {
              html += '<div class="mock-header-row">';
              html += '<input type="text" placeholder="Header name" value="' + esc(k) + '" onchange="updateMockTransformHeader(\'res\',' + hi + ', \'key\', this.value, \'' + eid + '\')">';
              html += '<input type="text" placeholder="Value" value="' + esc(v) + '" onchange="updateMockTransformHeader(\'res\',' + hi + ', \'val\', this.value, \'' + eid + '\')">';
              html += '<button class="mock-remove-btn" onclick="removeMockTransformHeader(\'res\',' + hi + ', \'' + eid + '\')"><i class="ph ph-x" style="font-size:12px;"></i></button></div>';
            });
            html += '</div>';
            html += '<button class="mock-add-matcher-btn" onclick="addMockTransformHeader(\'res\',\'' + eid + '\')">+ Add header</button>';
            if (action.resHeadersMode === 'update') {
              html += '<label style="font-size:11px;color:var(--text-watermark);display:block;margin:8px 0 4px;">Remove headers (one per line)</label>';
              html += '<textarea placeholder="X-Powered-By\nServer" style="min-height:40px;" onchange="mockEditDraft.action.resRemoveHeaders=this.value.split(\'\\n\').filter(h=>h.trim())">' + esc((action.resRemoveHeaders || []).join('\n')) + '</textarea>';
            }
            html += '</div>';
          }
          html += '</div>';

          // Response body
          html += '<div class="mock-transform-row">';
          html += '<select class="mock-transform-select" onchange="mockEditDraft.action.resBodyMode=this.value;rerenderMockActionConfig(\'' + eid + '\')">';
          const resBodyMode = action.resBodyMode || 'original';
          html += '<option value="original"' + (resBodyMode === 'original' ? ' selected' : '') + '>Use the original response body</option>';
          html += '<option value="replace-fixed"' + (resBodyMode === 'replace-fixed' ? ' selected' : '') + '>Replace the response body with a fixed value</option>';
          html += '<option value="json-merge"' + (resBodyMode === 'json-merge' ? ' selected' : '') + '>Update JSON response body by merging data</option>';
          html += '<option value="match-replace"' + (resBodyMode === 'match-replace' ? ' selected' : '') + '>Match and replace text in the response body</option>';
          html += '</select>';
          if (resBodyMode === 'replace-fixed') {
            html += '<textarea class="mock-transform-textarea" placeholder="Replacement body content" onchange="mockEditDraft.action.resBody=this.value">' + esc(action.resBody || '') + '</textarea>';
          } else if (resBodyMode === 'json-merge') {
            html += '<textarea class="mock-transform-textarea" placeholder=\'{"key": "new-value"}\' onchange="mockEditDraft.action.resBody=this.value">' + esc(action.resBody || '') + '</textarea>';
            html += '<div style="font-size:11px;color:var(--text-watermark);margin-top:4px;">Properties will be merged into the response body, overwriting matching keys.</div>';
          } else if (resBodyMode === 'match-replace') {
            html += '<input type="text" class="mock-transform-input" placeholder="Text to find" value="' + esc(action.resBodyMatchPattern || '') + '" onchange="mockEditDraft.action.resBodyMatchPattern=this.value">';
            html += '<input type="text" class="mock-transform-input" placeholder="Replace with" value="' + esc(action.resBodyReplaceWith || '') + '" onchange="mockEditDraft.action.resBodyReplaceWith=this.value">';
          }
          html += '</div>';
          break;

        case 'transform-response':
          html += '<div style="font-size:12px;color:var(--text-lowlight);padding:4px 0;margin-bottom:8px;">This action type has been merged into "Transform the request". Select "Transform the request" to configure both request and response transformers together.</div>';
          break;

        case 'reset':
          html += '<p style="color:var(--text-lowlight);font-size:12px;">Immediately resets the TCP connection with a RST packet. Unlike "Close connection" which does a graceful shutdown, this simulates a hard network failure.</p>';
          break;

        case 'timeout':
          html += '<div style="font-size:12px;color:var(--text-lowlight);padding:8px 0;">The connection will be kept open but no response will ever be sent. The client will eventually time out.</div>';
          break;

        case 'serve-file':
          html += '<div class="form-group" style="margin-bottom:8px;"><label style="font-size:11px;margin-bottom:3px;">File Path</label>';
          html += '<input type="text" placeholder="/path/to/file.json" value="' + esc(action.filePath || '') + '" onchange="mockEditDraft.action.filePath=this.value"></div>';
          html += '<div class="form-row" style="gap:8px;margin-bottom:8px;">';
          html += '<div class="form-group" style="max-width:100px;margin-bottom:0;"><label style="font-size:11px;margin-bottom:3px;">Status</label>';
          html += '<input type="number" min="100" max="599" value="' + (action.status || 200) + '" onchange="mockEditDraft.action.status=parseInt(this.value)"></div>';
          html += '<div class="form-group" style="margin-bottom:0;"><label style="font-size:11px;margin-bottom:3px;">Content-Type</label>';
          html += '<input type="text" placeholder="application/json" value="' + esc(action.contentType || '') + '" onchange="mockEditDraft.action.contentType=this.value"></div>';
          html += '</div>';
          html += '<div class="form-group" style="margin-bottom:0;max-width:200px;"><label style="font-size:11px;margin-bottom:3px;">Delay (ms)</label>';
          html += '<input type="number" min="0" value="' + (action.delay || 0) + '" onchange="mockEditDraft.action.delay=parseInt(this.value)||0"></div>';
          break;

        case 'breakpoint-request':
          html += '<p style="color:var(--text-lowlight);font-size:12px;">When a matching request arrives, it will be paused. You can inspect and modify it in the traffic view before allowing it to continue.</p>';
          break;

        case 'breakpoint-response':
          html += '<p style="color:var(--text-lowlight);font-size:12px;">The request will be forwarded normally, but the response will be paused before being sent back to the client. You can inspect and modify it before releasing.</p>';
          break;

        case 'breakpoint-request-response':
          html += '<p style="color:var(--text-lowlight);font-size:12px;">When a matching request arrives, it will be paused for editing. After you resume the request, the response will also be paused so you can inspect and modify it before sending it back to the client.</p>';
          break;

        case 'webhook':
          html += '<div class="form-group" style="margin-bottom:8px;"><label style="font-size:11px;margin-bottom:3px;">Webhook URL</label>';
          html += '<input type="text" placeholder="https://example.com/webhook" value="' + esc(action.webhookUrl || '') + '" onchange="mockEditDraft.action.webhookUrl=this.value"></div>';
          html += '<div style="margin-bottom:8px;">';
          html += '<label style="font-size:11px;color:var(--text-watermark);display:block;margin-bottom:4px;">Custom Headers (optional)</label>';
          html += '<div id="mockWebhookHeaders_' + eid + '">';
          const whEntries = Object.entries(action.webhookHeaders || {});
          whEntries.forEach(([k, v], hi) => {
            html += '<div class="mock-header-row">';
            html += '<input type="text" placeholder="Header name" value="' + esc(k) + '" onchange="updateMockWebhookHeader(' + hi + ', \'key\', this.value, \'' + eid + '\')">';
            html += '<input type="text" placeholder="Value" value="' + esc(v) + '" onchange="updateMockWebhookHeader(' + hi + ', \'val\', this.value, \'' + eid + '\')">';
            html += '<button class="mock-remove-btn" onclick="removeMockWebhookHeader(' + hi + ', \'' + eid + '\')">';
            html += '<i class="ph ph-x" style="font-size:12px;"></i>';
            html += '</button></div>';
          });
          html += '</div>';
          html += '<button class="mock-add-matcher-btn" onclick="addMockWebhookHeader(\'' + eid + '\')">+ Add header</button>';
          html += '</div>';
          html += '<p style="color:var(--text-lowlight);font-size:12px;margin:0;">A copy of the matching request will be POSTed to this URL. The original client receives a 200 OK response immediately.</p>';
          break;
      }
      return html;
    }

    function preserveOpenMockEdit(nextRuleId) {
      if (!mockEditingRule || !mockEditDraft) return true;
      if (mockEditingRule === nextRuleId && nextRuleId !== '__new__') return true;
      return saveMockRule(mockEditingRule);
    }

    function addNewMockRule() {
      if (mockSaveInProgress || mockRevertInProgress || mockResetInProgress || mockCollectionMutationCount > 0) return;
      if (!preserveOpenMockEdit('__new__')) return;
      mockEditingRule = '__new__';
      mockEditDraft = {
        enabled: true,
        priority: 'normal',
        matchers: [
          { type: 'method', value: 'GET' },
          { type: 'path', value: '/', matchType: 'prefix' }
        ],
        preSteps: [],
        action: {
          type: 'fixed-response',
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: '',
          delay: 0
        }
      };
      mockEditDirty = false;
      renderMockRules();
      setTimeout(() => {
        const el = document.getElementById('mockEditor___new__');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 50);
    }

    function editMockRule(ruleId) {
      if (mockSaveInProgress || mockRevertInProgress || mockResetInProgress || mockCollectionMutationCount > 0) return;
      if (!preserveOpenMockEdit(ruleId)) return;
      const rule = _findMockRuleDeep(ruleId);
      if (!rule) return;
      const nr = normalizeMockRule(rule);
      mockEditingRule = ruleId;
      mockEditDraft = JSON.parse(JSON.stringify(nr));
      mockEditDirty = false;
      mockExpandedRules.add(ruleId);
      renderMockRules();
    }

    function cancelMockEdit() {
      if (mockSaveInProgress || mockRevertInProgress || mockResetInProgress || mockCollectionMutationCount > 0) return;
      mockEditingRule = null;
      mockEditDraft = null;
      mockEditDirty = false;
      renderMockRules();
    }

    function toggleMockRuleExpand(ruleId) {
      if (mockSaveInProgress || mockRevertInProgress || mockResetInProgress || mockCollectionMutationCount > 0) return;
      if (mockExpandedRules.has(ruleId)) {
        // Collapse
        // If we were editing this rule, save as draft on collapse
        if (mockEditingRule === ruleId && mockEditDraft) {
          if (!saveMockRule(ruleId)) return;
        }
        mockExpandedRules.delete(ruleId);
        if (mockEditingRule === ruleId) {
          mockEditingRule = null;
          mockEditDraft = null;
        }
      } else {
        // Expand = edit
        editMockRule(ruleId);
      }
      renderMockRules();
    }

    function toggleMockRuleEnabled(ruleId) {
      if (mockSaveInProgress || mockRevertInProgress || mockResetInProgress || mockCollectionMutationCount > 0) return;
      const rule = _findMockRuleDeep(ruleId);
      if (!rule) return;
      rule.enabled = rule.enabled === false ? true : false;
      // Save as draft change
      const draft = mockDraftRules.get(ruleId) || JSON.parse(JSON.stringify(rule));
      draft.enabled = rule.enabled;
      draft.id = ruleId;
      mockDraftRules.set(ruleId, draft);
      updateMockSaveButtons();
      renderMockRules();
    }

    function updateMockMatcher(idx, field, value, eid) {
      if (!mockEditDraft) return;
      const m = mockEditDraft.matchers[idx];
      if (!m) return;
      if (field === 'type') {
        const newM = { type: value };
        switch (value) {
          case 'wildcard': break; // no properties needed
          case 'method': newM.value = 'GET'; break;
          case 'path': newM.value = '/'; newM.matchType = 'prefix'; break;
          case 'host': newM.value = ''; break;
          case 'hostname': newM.value = ''; break;
          case 'header': newM.name = ''; newM.value = ''; break;
          case 'query': newM.name = ''; newM.value = ''; break;
          case 'exact-query': newM.value = ''; break;
          case 'url-contains': newM.value = ''; break;
          case 'body-contains': newM.value = ''; break;
          case 'raw-body-exact': newM.value = ''; break;
          case 'multipart-form-data': newM.name = ''; newM.value = ''; break;
        }
        mockEditDraft.matchers[idx] = newM;
        rerenderMockMatchers(eid);
      } else {
        m[field] = value;
      }
    }

    function addMockMatcher(eid) {
      if (!mockEditDraft) return;
      mockEditDraft.matchers.push({ type: 'path', value: '/', matchType: 'prefix' });
      rerenderMockMatchers(eid);
    }

    function removeMockMatcher(idx, eid) {
      if (!mockEditDraft) return;
      mockEditDraft.matchers.splice(idx, 1);
      rerenderMockMatchers(eid);
    }

    function rerenderMockMatchers(eid) {
      const container = document.getElementById('mockMatchers_' + eid);
      if (!container || !mockEditDraft) return;
      let html = '';
      mockEditDraft.matchers.forEach((m, idx) => {
        html += renderMockMatcherRow(m, idx, eid);
      });
      container.innerHTML = html;
    }

    // ============ PRE-STEP CHAINING ============
    function renderMockPreStepRow(step, idx, eid) {
      let html = '<div class="mock-matcher-row" data-step-idx="' + idx + '">';
      html += '<select onchange="updateMockPreStep(' + idx + ', \'type\', this.value, \'' + eid + '\')">';
      for (const st of MOCK_PRE_STEP_TYPES) {
        html += '<option value="' + st.value + '"' + (step.type === st.value ? ' selected' : '') + '>' + st.label + '</option>';
      }
      html += '</select>';

      switch (step.type) {
        case 'delay':
          html += '<input type="number" min="0" placeholder="Milliseconds" value="' + (step.ms || 0) + '" onchange="updateMockPreStep(' + idx + ', \'ms\', parseInt(this.value)||0, \'' + eid + '\')" style="max-width:120px;">';
          html += '<span style="font-size:11px;color:var(--text-watermark);white-space:nowrap;">ms</span>';
          break;
        case 'add-header':
          html += '<input type="text" placeholder="Header name" value="' + esc(step.name || '') + '" onchange="updateMockPreStep(' + idx + ', \'name\', this.value, \'' + eid + '\')" style="flex:1;">';
          html += '<input type="text" placeholder="Value" value="' + esc(step.value || '') + '" onchange="updateMockPreStep(' + idx + ', \'value\', this.value, \'' + eid + '\')" style="flex:1;">';
          break;
        case 'remove-header':
          html += '<input type="text" placeholder="Header name to remove" value="' + esc(step.name || '') + '" onchange="updateMockPreStep(' + idx + ', \'name\', this.value, \'' + eid + '\')">';
          break;
        case 'rewrite-url':
          html += '<input type="text" placeholder="https://new-host.com/path" value="' + esc(step.value || '') + '" onchange="updateMockPreStep(' + idx + ', \'value\', this.value, \'' + eid + '\')">';
          break;
        case 'rewrite-method':
          html += '<select onchange="updateMockPreStep(' + idx + ', \'value\', this.value, \'' + eid + '\')">';
          for (const m of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']) {
            html += '<option value="' + m + '"' + (step.value === m ? ' selected' : '') + '>' + m + '</option>';
          }
          html += '</select>';
          break;
      }

      html += '<button class="mock-remove-btn" onclick="removeMockPreStep(' + idx + ', \'' + eid + '\')" title="Remove step">';
      html += '<i class="ph ph-x" style="font-size:14px;"></i>';
      html += '</button>';
      html += '</div>';
      return html;
    }

    function addMockPreStep(eid) {
      if (!mockEditDraft) return;
      if (!mockEditDraft.preSteps) mockEditDraft.preSteps = [];
      mockEditDraft.preSteps.push({ type: 'delay', ms: 1000 });
      rerenderMockPreSteps(eid);
    }

    function removeMockPreStep(idx, eid) {
      if (!mockEditDraft || !mockEditDraft.preSteps) return;
      mockEditDraft.preSteps.splice(idx, 1);
      rerenderMockPreSteps(eid);
    }

    function updateMockPreStep(idx, field, value, eid) {
      if (!mockEditDraft || !mockEditDraft.preSteps) return;
      const step = mockEditDraft.preSteps[idx];
      if (!step) return;
      if (field === 'type') {
        // Reset to defaults when changing type
        const newStep = { type: value };
        switch (value) {
          case 'delay': newStep.ms = 1000; break;
          case 'add-header': newStep.name = ''; newStep.value = ''; break;
          case 'remove-header': newStep.name = ''; break;
          case 'rewrite-url': newStep.value = ''; break;
          case 'rewrite-method': newStep.value = 'GET'; break;
        }
        mockEditDraft.preSteps[idx] = newStep;
        rerenderMockPreSteps(eid);
      } else {
        step[field] = value;
      }
    }

    function rerenderMockPreSteps(eid) {
      const container = document.getElementById('mockPreSteps_' + eid);
      if (!container || !mockEditDraft) return;
      const preSteps = mockEditDraft.preSteps || [];
      // Show or hide the "Before responding:" label
      const label = container.previousElementSibling;
      if (label && label.classList.contains('mock-presteps-label')) {
        label.style.display = preSteps.length > 0 ? '' : 'none';
      }
      let html = '';
      preSteps.forEach((step, idx) => {
        html += renderMockPreStepRow(step, idx, eid);
      });
      container.innerHTML = html;
    }

    function changeMockActionType(newType, eid) {
      if (!mockEditDraft) return;
      const oldAction = mockEditDraft.action;
      mockEditDraft.action = { type: newType, delay: oldAction.delay || 0 };
      switch (newType) {
        case 'fixed-response':
          mockEditDraft.action.status = oldAction.status || 200;
          mockEditDraft.action.headers = oldAction.headers || { 'Content-Type': 'application/json' };
          // Use the original response body if available, otherwise carry over
          mockEditDraft.action.body = mockEditDraft._originalResponseBody || oldAction.body || '';
          break;
        case 'forward':
          mockEditDraft.action.forwardTo = oldAction.forwardTo || '';
          break;
        case 'transform-request':
          mockEditDraft.action.methodMode = oldAction.methodMode || 'original';
          mockEditDraft.action.urlMode = oldAction.urlMode || 'original';
          mockEditDraft.action.urlReplace = oldAction.urlReplace || '';
          mockEditDraft.action.headersMode = oldAction.headersMode || 'original';
          mockEditDraft.action.headers = oldAction.headers || {};
          mockEditDraft.action.removeHeaders = oldAction.removeHeaders || [];
          mockEditDraft.action.bodyMode = oldAction.bodyMode || 'original';
          // Use stored request body if available; DON'T carry over from fixed-response (that's the response body)
          mockEditDraft.action.body = mockEditDraft._originalRequestBody || (oldAction.type === 'transform-request' ? oldAction.body : '') || '';
          mockEditDraft.action.bodyMatchPattern = oldAction.bodyMatchPattern || '';
          mockEditDraft.action.bodyReplaceWith = oldAction.bodyReplaceWith || '';
          // Response transformer defaults
          mockEditDraft.action.resStatusMode = oldAction.resStatusMode || 'original';
          mockEditDraft.action.resStatusOverride = oldAction.resStatusOverride || oldAction.statusOverride || 200;
          mockEditDraft.action.resHeadersMode = oldAction.resHeadersMode || 'original';
          mockEditDraft.action.resHeaders = oldAction.resHeaders || {};
          mockEditDraft.action.resRemoveHeaders = oldAction.resRemoveHeaders || [];
          mockEditDraft.action.resBodyMode = oldAction.resBodyMode || 'original';
          mockEditDraft.action.resBody = oldAction.resBody || mockEditDraft._originalResponseBody || '';
          mockEditDraft.action.resBodyMatchPattern = oldAction.resBodyMatchPattern || '';
          mockEditDraft.action.resBodyReplaceWith = oldAction.resBodyReplaceWith || '';
          break;
        case 'transform-response':
          // Legacy: kept for backward compatibility but UI redirects to transform-request
          mockEditDraft.action.headers = oldAction.headers || {};
          mockEditDraft.action.removeHeaders = oldAction.removeHeaders || [];
          mockEditDraft.action.statusOverride = oldAction.statusOverride || undefined;
          break;
        case 'serve-file':
          mockEditDraft.action.filePath = oldAction.filePath || '';
          mockEditDraft.action.status = oldAction.status || 200;
          mockEditDraft.action.contentType = oldAction.contentType || '';
          break;
        case 'breakpoint-request':
        case 'breakpoint-response':
        case 'breakpoint-request-response':
          // No special fields needed
          break;
        case 'webhook':
          mockEditDraft.action.webhookUrl = oldAction.webhookUrl || '';
          mockEditDraft.action.webhookHeaders = oldAction.webhookHeaders || {};
          break;
      }
      const configEl = document.getElementById('mockActionConfig_' + eid);
      if (configEl) {
        const _primaryActions2 = ['fixed-response', 'forward', 'passthrough', 'transform-request', 'serve-file'];
        const _advancedActions2 = ['close', 'reset', 'timeout', 'breakpoint-request', 'breakpoint-response', 'breakpoint-request-response', 'webhook', 'transform-response'];
        let selectHtml = '<select style="width:100%;margin-bottom:8px;" onchange="changeMockActionType(this.value, \'' + eid + '\')">'; 
        selectHtml += '<optgroup label="Common">';
        for (const at of MOCK_ACTION_TYPES.filter(a => _primaryActions2.includes(a.value))) {
          selectHtml += '<option value="' + at.value + '"' + (mockEditDraft.action.type === at.value ? ' selected' : '') + '>' + at.label + '</option>';
        }
        selectHtml += '</optgroup>';
        selectHtml += '<optgroup label="Advanced">';
        for (const at of MOCK_ACTION_TYPES.filter(a => _advancedActions2.includes(a.value))) {
          selectHtml += '<option value="' + at.value + '"' + (mockEditDraft.action.type === at.value ? ' selected' : '') + '>' + at.label + '</option>';
        }
        selectHtml += '</optgroup>';
        selectHtml += '</select>';
        configEl.innerHTML = selectHtml + renderMockActionFields(mockEditDraft.action, eid);
      }
    }

    function updateMockRespHeader(idx, which, value, eid) {
      if (!mockEditDraft) return;
      const entries = Object.entries(mockEditDraft.action.headers || {});
      if (idx < 0 || idx >= entries.length) return;
      if (which === 'key') {
        const val = entries[idx][1];
        const newHeaders = {};
        entries.forEach(([k, v], i) => {
          if (i === idx) newHeaders[value] = val;
          else newHeaders[k] = v;
        });
        mockEditDraft.action.headers = newHeaders;
      } else {
        entries[idx][1] = value;
        const newHeaders = {};
        entries.forEach(([k, v]) => { newHeaders[k] = v; });
        mockEditDraft.action.headers = newHeaders;
      }
    }

    function addMockRespHeader(eid) {
      if (!mockEditDraft) return;
      if (!mockEditDraft.action.headers) mockEditDraft.action.headers = {};
      let key = 'X-Custom';
      let n = 1;
      while (mockEditDraft.action.headers[key]) { key = 'X-Custom-' + n; n++; }
      mockEditDraft.action.headers[key] = '';
      rerenderMockRespHeaders(eid);
    }

    function removeMockRespHeader(idx, eid) {
      if (!mockEditDraft) return;
      const entries = Object.entries(mockEditDraft.action.headers || {});
      if (idx < 0 || idx >= entries.length) return;
      const newHeaders = {};
      entries.forEach(([k, v], i) => {
        if (i !== idx) newHeaders[k] = v;
      });
      mockEditDraft.action.headers = newHeaders;
      rerenderMockRespHeaders(eid);
    }

    function rerenderMockRespHeaders(eid) {
      const container = document.getElementById('mockRespHeaders_' + eid);
      if (!container || !mockEditDraft) return;
      const entries = Object.entries(mockEditDraft.action.headers || {});
      let html = '';
      entries.forEach(([k, v], hi) => {
        html += '<div class="mock-header-row">';
        html += '<input type="text" placeholder="Header name" value="' + esc(k) + '" onchange="updateMockRespHeader(' + hi + ', \'key\', this.value, \'' + eid + '\')">';
        html += '<input type="text" placeholder="Value" value="' + esc(v) + '" onchange="updateMockRespHeader(' + hi + ', \'val\', this.value, \'' + eid + '\')">';
        html += '<button class="mock-remove-btn" onclick="removeMockRespHeader(' + hi + ', \'' + eid + '\')">';
        html += '<i class="ph ph-x" style="font-size:12px;"></i>';
        html += '</button></div>';
      });
      container.innerHTML = html;
    }

    function updateMockWebhookHeader(idx, which, value, eid) {
      if (!mockEditDraft) return;
      const entries = Object.entries(mockEditDraft.action.webhookHeaders || {});
      if (idx < 0 || idx >= entries.length) return;
      if (which === 'key') {
        const val = entries[idx][1];
        const newHeaders = {};
        entries.forEach(([k, v], i) => {
          if (i === idx) newHeaders[value] = val;
          else newHeaders[k] = v;
        });
        mockEditDraft.action.webhookHeaders = newHeaders;
      } else {
        entries[idx][1] = value;
        const newHeaders = {};
        entries.forEach(([k, v]) => { newHeaders[k] = v; });
        mockEditDraft.action.webhookHeaders = newHeaders;
      }
    }

    function addMockWebhookHeader(eid) {
      if (!mockEditDraft) return;
      if (!mockEditDraft.action.webhookHeaders) mockEditDraft.action.webhookHeaders = {};
      let key = 'X-Custom';
      let n = 1;
      while (mockEditDraft.action.webhookHeaders[key]) { key = 'X-Custom-' + n; n++; }
      mockEditDraft.action.webhookHeaders[key] = '';
      rerenderMockWebhookHeaders(eid);
    }

    function removeMockWebhookHeader(idx, eid) {
      if (!mockEditDraft) return;
      const entries = Object.entries(mockEditDraft.action.webhookHeaders || {});
      if (idx < 0 || idx >= entries.length) return;
      const newHeaders = {};
      entries.forEach(([k, v], i) => {
        if (i !== idx) newHeaders[k] = v;
      });
      mockEditDraft.action.webhookHeaders = newHeaders;
      rerenderMockWebhookHeaders(eid);
    }

    function rerenderMockWebhookHeaders(eid) {
      const container = document.getElementById('mockWebhookHeaders_' + eid);
      if (!container || !mockEditDraft) return;
      const entries = Object.entries(mockEditDraft.action.webhookHeaders || {});
      let html = '';
      entries.forEach(([k, v], hi) => {
        html += '<div class="mock-header-row">';
        html += '<input type="text" placeholder="Header name" value="' + esc(k) + '" onchange="updateMockWebhookHeader(' + hi + ', \'key\', this.value, \'' + eid + '\')">';
        html += '<input type="text" placeholder="Value" value="' + esc(v) + '" onchange="updateMockWebhookHeader(' + hi + ', \'val\', this.value, \'' + eid + '\')">';
        html += '<button class="mock-remove-btn" onclick="removeMockWebhookHeader(' + hi + ', \'' + eid + '\')">';
        html += '<i class="ph ph-x" style="font-size:12px;"></i>';
        html += '</button></div>';
      });
      container.innerHTML = html;
    }

    function mockRuleDraftComparable(rule) {
      return {
        enabled: rule?.enabled !== false,
        priority: rule?.priority || 'normal',
        matchers: rule?.matchers,
        preSteps: (rule?.preSteps || []).filter(step => step && step.type),
        action: rule?.action,
        title: rule?.title || undefined
      };
    }

    function hasOpenMockEditChanges() {
      if (!mockEditDraft) return false;
      if (!mockEditingRule || mockEditingRule === '__new__') return true;
      const original = mockDraftRules.get(mockEditingRule) || _findMockRuleDeep(mockEditingRule);
      if (!original) return true;
      try {
        const modelChanged = JSON.stringify(mockRuleDraftComparable(normalizeMockRule(original))) !==
          JSON.stringify(mockRuleDraftComparable(mockEditDraft));
        return modelChanged || mockEditDirty;
      } catch {
        // If the editor cannot be compared safely, fail closed instead of
        // allowing navigation to discard it silently.
        return true;
      }
    }

    /** Check if there are any locally staged mock rule drafts */
    function hasUnsavedMockChanges() {
      return mockDraftRules.size > 0;
    }

    function hasOpenMockRenameChanges() {
      if (!mockRenamingRuleId) return false;
      const rule = _findMockRuleDeep(mockRenamingRuleId);
      const input = document.getElementById('mock-rename-input');
      if (!rule || !input) return true;
      const nextTitle = input.value.trim() || undefined;
      return nextTitle !== (rule.title || undefined);
    }

    function hasUnsavedMockWork() {
      return hasUnsavedMockChanges() || hasOpenMockEditChanges() || hasOpenMockRenameChanges();
    }

    function mockEditorControlDiffersFromDefault(control) {
      const type = String(control?.type || '').toLowerCase();
      if (type === 'checkbox' || type === 'radio') {
        return control.checked !== control.defaultChecked;
      }
      if (String(control?.tagName || '').toLowerCase() === 'select') {
        return Array.from(control.options || [])
          .some(option => option.selected !== option.defaultSelected);
      }
      if (typeof control?.value === 'string' && typeof control?.defaultValue === 'string') {
        return control.value !== control.defaultValue;
      }
      // Unknown editable controls fail closed so navigation cannot lose input.
      return true;
    }

    function markOpenMockEditDirty(event) {
      const editor = event?.target?.closest?.('.mock-rule-editor');
      if (mockEditDraft && editor?.id?.startsWith('mockEditor_')) {
        const controls = editor.querySelectorAll?.('input, select, textarea');
        mockEditDirty = controls
          ? Array.from(controls).some(mockEditorControlDiffersFromDefault)
          : mockEditorControlDiffersFromDefault(event.target);
        mockWorkRevision++;
      }
      if (mockRenamingRuleId && event?.target?.id === 'mock-rename-input') {
        mockWorkRevision++;
      }
    }

    function guardUnsavedMockChangesBeforeUnload(event) {
      if (!hasUnsavedMockWork()) return true;
      event?.preventDefault?.();
      if (event) event.returnValue = '';
      return false;
    }

    function prepareRendererForQuit() {
      if (hasUnsavedMockWork() &&
          !confirm('You have unsaved mock rule changes. Quit without saving?')) {
        return false;
      }
      return persistActiveSendTabBeforeUnload();
    }

    /** Save current editor state to draft (local only, not to server) */
    function isMockMatcherComplete(matcher) {
      if (!matcher || typeof matcher.type !== 'string') return false;
      if (['header', 'query', 'cookie', 'form-data', 'multipart-form-data'].includes(matcher.type)) {
        return typeof matcher.name === 'string' && matcher.name.trim().length > 0;
      }
      if (matcher.type === 'wildcard') return true;
      if (['raw-body-exact', 'exact-query'].includes(matcher.type)) {
        return typeof matcher.value === 'string';
      }
      return typeof matcher.value === 'string' && matcher.value.trim().length > 0;
    }

    function saveMockRule(ruleId) {
      if (mockSaveInProgress || mockRevertInProgress || mockResetInProgress || mockCollectionMutationCount > 0) return false;
      if (!mockEditDraft) return false;

      if (!Array.isArray(mockEditDraft.matchers) || mockEditDraft.matchers.length === 0
        || !mockEditDraft.matchers.every(isMockMatcherComplete)) {
        toast('Complete every matching condition before saving', 'error');
        return false;
      }

      const preSteps = (mockEditDraft.preSteps || []).filter(s => s && s.type);
      const draft = {
        enabled: mockEditDraft.enabled !== false,
        priority: mockEditDraft.priority || 'normal',
        matchers: mockEditDraft.matchers,
        preSteps: preSteps.length > 0 ? preSteps : [],
        action: mockEditDraft.action,
        title: mockEditDraft.title || undefined
      };

      if (ruleId === '__new__') {
        // Assign a temporary client-side ID for the new draft
        const tempId = '__draft_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
        draft.id = tempId;
        mockDraftRules.set(tempId, draft);
        mockNewDraftIds.add(tempId);
        // Add to local mockRules so it renders
        mockRules.push(draft);
        mockEditingRule = null;
        mockEditDraft = null;
        toast('Rule saved as draft (unsaved)', 'success');
      } else {
        draft.id = ruleId;
        // Compare against the original server rule — only create a draft if something actually changed
        const original = mockRules.find(r => r.id === ruleId);
        const originalJson = original ? JSON.stringify({
          enabled: original.enabled !== false,
          priority: original.priority || 'normal',
          matchers: original.matchers,
          preSteps: (original.preSteps || []).filter(s => s && s.type),
          action: original.action,
          title: original.title || undefined
        }) : null;
        const draftJson = JSON.stringify({
          enabled: draft.enabled,
          priority: draft.priority,
          matchers: draft.matchers,
          preSteps: draft.preSteps,
          action: draft.action,
          title: draft.title
        });

        if (originalJson === draftJson) {
          // No actual changes — don't create a draft
          mockDraftRules.delete(ruleId);
          mockEditingRule = null;
          mockEditDraft = null;
          toast('No changes to save', 'success');
        } else {
          mockDraftRules.set(ruleId, draft);
          _applyDraftToLocal(ruleId, draft);
          mockEditingRule = null;
          mockEditDraft = null;
          toast('Changes saved as draft (unsaved)', 'success');
        }
      }
      updateMockSaveButtons();
      renderMockRules();
      return true;
    }

    /** Apply a draft's data onto the local mockRules array for rendering */
    function _applyDraftToLocal(ruleId, draft) {
      for (let i = 0; i < mockRules.length; i++) {
        if (mockRules[i].id === ruleId) {
          Object.assign(mockRules[i], draft);
          return;
        }
        if (mockRules[i].type === 'group' && mockRules[i].items) {
          for (let j = 0; j < mockRules[i].items.length; j++) {
            if (mockRules[i].items[j].id === ruleId) {
              Object.assign(mockRules[i].items[j], draft);
              return;
            }
          }
        }
      }
    }

    /** Send ALL draft rules to the server */
    async function saveAllMockRules() {
      if (mockSaveInProgress || mockRevertInProgress || mockResetInProgress || mockCollectionMutationCount > 0) return;
      if (hasOpenMockEditChanges() && !saveMockRule(mockEditingRule)) return;
      if (!hasUnsavedMockChanges()) return;
      mockSaveInProgress = true;
      updateMockSaveButtons();
      try {
        const entries = Array.from(mockDraftRules.entries());
        for (const [draftId, draft] of entries) {
          const payload = { ...draft };
          delete payload.id;
          if (mockNewDraftIds.has(draftId)) {
            const res = await fetch(`${API_BASE}/api/mock-rules`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload)
            });
            const data = await res.json();
            if (!res.ok || data.error) throw new Error(data.error || 'Server rejected the rule');
          } else {
            const res = await fetch(`${API_BASE}/api/mock-rules/${encodeURIComponent(draftId)}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload)
            });
            const data = await res.json();
            if (!res.ok || data.error) throw new Error(data.error || 'Server rejected the rule');
          }
          // Clear each completed entry immediately so retrying a later failure is idempotent.
          mockDraftRules.delete(draftId);
          mockNewDraftIds.delete(draftId);
        }
        mockEditingRule = null;
        mockEditDraft = null;
        toast('All changes saved', 'success');
        // Reload from server to get real IDs for all rules
        await loadMockRules();
      } catch (err) {
        // Refresh completed entries while preserving the drafts that still need saving.
        await loadMockRules();
        toast('Error saving rules: ' + err.message, 'error');
      } finally {
        mockSaveInProgress = false;
        updateMockSaveButtons();
      }
    }

    /** Send a single draft rule to the server */
    async function saveOneMockRule(draftId) {
      if (mockSaveInProgress || mockRevertInProgress || mockResetInProgress || mockCollectionMutationCount > 0) return;
      const draft = mockDraftRules.get(draftId);
      if (!draft) return;
      mockSaveInProgress = true;
      updateMockSaveButtons();
      try {
        const payload = { ...draft };
        delete payload.id;
        if (mockNewDraftIds.has(draftId)) {
          const res = await fetch(`${API_BASE}/api/mock-rules`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          const data = await res.json();
          if (!res.ok || data.error) throw new Error(data.error || 'Server rejected the rule');
        } else {
          const res = await fetch(`${API_BASE}/api/mock-rules/${encodeURIComponent(draftId)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          const data = await res.json();
          if (!res.ok || data.error) throw new Error(data.error || 'Server rejected the rule');
        }
        mockDraftRules.delete(draftId);
        mockNewDraftIds.delete(draftId);
        toast('Rule saved to server', 'success');
        await loadMockRules();
      } catch (err) {
        toast('Error: ' + err.message, 'error');
      } finally {
        mockSaveInProgress = false;
        updateMockSaveButtons();
      }
    }

    function _mockRevertStateToken() {
      return JSON.stringify({
        rules: mockRules,
        drafts: Array.from(mockDraftRules.entries()),
        newDraftIds: Array.from(mockNewDraftIds),
        editingRule: mockEditingRule,
        editDraft: mockEditDraft,
        renamingRuleId: mockRenamingRuleId,
        workRevision: mockWorkRevision
      });
    }

    function _captureMockRevertState() {
      return {
        rules: mockRules,
        drafts: Array.from(mockDraftRules.entries()),
        newDraftIds: Array.from(mockNewDraftIds),
        editingRule: mockEditingRule,
        editDraft: mockEditDraft,
        renamingRuleId: mockRenamingRuleId
      };
    }

    function _restoreMockRevertState(state) {
      mockRules = state.rules;
      mockDraftRules.clear();
      for (const [draftId, draft] of state.drafts) mockDraftRules.set(draftId, draft);
      mockNewDraftIds.clear();
      for (const draftId of state.newDraftIds) mockNewDraftIds.add(draftId);
      mockEditingRule = state.editingRule;
      mockEditDraft = state.editDraft;
      mockRenamingRuleId = state.renamingRuleId;
    }

    /** Revert all unsaved draft changes after loading authoritative server state. */
    async function revertMockRules() {
      if (!hasUnsavedMockChanges() || mockRevertInProgress || mockSaveInProgress ||
          mockResetInProgress || mockCollectionMutationCount > 0) return;

      const startingState = _mockRevertStateToken();
      const operation = ++mockRulesLoadGeneration;
      mockRevertInProgress = true;
      updateMockSaveButtons();
      try {
        const rules = await _fetchAuthoritativeMockRules('Reverting mock rules');
        if (operation !== mockRulesLoadGeneration
          || _mockRevertStateToken() !== startingState) {
          throw new Error('Mock rules changed while Revert was loading');
        }

        const rollbackState = _captureMockRevertState();
        try {
          mockDraftRules.clear();
          mockNewDraftIds.clear();
          mockEditingRule = null;
          mockEditDraft = null;
          mockRenamingRuleId = null;
          mockRules = rules;
          updateMockSaveButtons();
          renderMockRules();
        } catch (commitError) {
          _restoreMockRevertState(rollbackState);
          try {
            updateMockSaveButtons();
            renderMockRules();
          } catch (rollbackRenderError) {
            console.error('Could not re-render restored mock rules:', rollbackRenderError);
          }
          throw commitError;
        }
        toast('All unsaved changes discarded', 'success');
      } catch (err) {
        toast('Error reverting rules: ' + err.message, 'error');
      } finally {
        mockRevertInProgress = false;
        updateMockSaveButtons();
      }
    }

    /** Update Save All / Revert button visibility based on draft state */
    function updateMockSaveButtons() {
      const saveAllBtn = document.getElementById('mockSaveAllBtn');
      const revertBtn = document.getElementById('mockRevertBtn');
      const unsavedBadge = document.getElementById('mockUnsavedBadge');
      const rulesList = document.getElementById('mockRulesList');
      const hasDrafts = hasUnsavedMockChanges();
      const serverMutationLocked = mockSaveInProgress || mockRevertInProgress ||
        mockResetInProgress || mockCollectionMutationCount > 0;
      if (saveAllBtn) saveAllBtn.style.display = hasDrafts ? '' : 'none';
      if (saveAllBtn) saveAllBtn.disabled = serverMutationLocked;
      if (revertBtn) revertBtn.style.display = hasDrafts ? '' : 'none';
      if (revertBtn) revertBtn.disabled = serverMutationLocked;
      for (const id of ['mockCreateGroupBtn', 'mockCollapseAllBtn', 'mockImportBtn', 'mockResetBtn']) {
        const control = document.getElementById(id);
        if (control) control.disabled = serverMutationLocked;
      }
      if (rulesList) {
        rulesList.classList?.toggle('mock-server-save-locked', serverMutationLocked);
        rulesList.setAttribute?.('aria-busy', String(serverMutationLocked));
        rulesList.querySelectorAll?.('button, input, select, textarea').forEach(control => {
          if (serverMutationLocked) {
            if (!control.disabled) {
              control.disabled = true;
              control.dataset.mockSaveLockDisabled = 'true';
            }
          } else if (control.dataset.mockSaveLockDisabled === 'true'
              || control.matches?.('.mock-save-server, .mock-rule-delete')) {
            control.disabled = false;
            delete control.dataset.mockSaveLockDisabled;
          }
        });
      }
      if (unsavedBadge) {
        unsavedBadge.style.display = hasDrafts ? '' : 'none';
        unsavedBadge.textContent = mockDraftRules.size + ' unsaved change' + (mockDraftRules.size !== 1 ? 's' : '');
      }
    }

    async function deleteMockRule(ruleId) {
      if (mockSaveInProgress || mockRevertInProgress || mockResetInProgress || mockCollectionMutationCount > 0) return;
      if (mockNewDraftIds.has(ruleId)) {
        // Unsaved draft — remove locally only (it's not on the server yet)
        mockDraftRules.delete(ruleId);
        mockExpandedRules.delete(ruleId);
        mockNewDraftIds.delete(ruleId);
        if (mockEditingRule === ruleId) {
          mockEditingRule = null;
          mockEditDraft = null;
        }
        mockRules = mockRules.filter(r => r.id !== ruleId);
        toast('Draft rule deleted', 'success');
        updateMockSaveButtons();
        renderMockRules();
        return;
      }

      return _queueMockCollectionMutation(async () => {
        try {
          // Saved rule — delete from server AND reload to get fresh state
          const response = await fetch(`${API_BASE}/api/mock-rules/${encodeURIComponent(ruleId)}`, { method: 'DELETE' });
          const data = await response.json().catch(() => ({}));
          if (!response.ok || data?.success === false || data?.error) {
            throw new Error(data?.error || `Could not delete rule (${response.status})`);
          }

          mockDraftRules.delete(ruleId);
          mockExpandedRules.delete(ruleId);
          if (mockEditingRule === ruleId) {
            mockEditingRule = null;
            mockEditDraft = null;
          }
          toast('Rule deleted', 'success');
          updateMockSaveButtons();
          await loadMockRules();
        } catch (err) {
          toast('Error: ' + err.message, 'error');
        }
      });
    }

    function cloneMockRule(ruleId) {
      if (mockSaveInProgress || mockRevertInProgress || mockResetInProgress || mockCollectionMutationCount > 0) return;
      const rule = _findMockRuleDeep(ruleId);
      if (!rule) return;
      const clone = JSON.parse(JSON.stringify(rule));
      // Assign a temporary draft ID
      const tempId = '__draft_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      clone.id = tempId;
      if (clone.title) clone.title = clone.title + ' (copy)';
      mockDraftRules.set(tempId, clone);
      mockNewDraftIds.add(tempId);
      mockRules.push(clone);
      toast('Rule cloned as draft (unsaved)', 'success');
      updateMockSaveButtons();
      renderMockRules();
    }

    // ============ MOCK RULE GROUPS ============
    function toggleMockGroup(groupId) {
      if (mockSaveInProgress || mockRevertInProgress || mockResetInProgress || mockCollectionMutationCount > 0) return;
      const group = mockRules.find(r => r.id === groupId && r.type === 'group');
      if (!group) return;
      const hidesActiveEditor = group.collapsed !== true
        && (group.items || []).some(rule => rule.id === mockEditingRule);
      if (hidesActiveEditor && !preserveOpenMockEdit(null)) return;
      group.collapsed = !group.collapsed;
      renderMockRules();
    }

    function toggleMockGroupEnabled(groupId) {
      if (mockSaveInProgress || mockRevertInProgress || mockResetInProgress || mockCollectionMutationCount > 0) return;
      const group = mockRules.find(r => r.id === groupId && r.type === 'group');
      if (!group) return;
      group.enabled = group.enabled === false ? true : false;
      // Save as draft change
      const draft = mockDraftRules.get(groupId) || JSON.parse(JSON.stringify(group));
      draft.enabled = group.enabled;
      draft.id = groupId;
      mockDraftRules.set(groupId, draft);
      updateMockSaveButtons();
      renderMockRules();
    }

    function renameMockGroup(groupId) {
      if (mockSaveInProgress || mockRevertInProgress || mockResetInProgress || mockCollectionMutationCount > 0) return;
      const group = mockRules.find(r => r.id === groupId && r.type === 'group');
      if (!group) return;
      const name = prompt('Group name:', group.title || '');
      if (name === null) return;
      group.title = name || 'Untitled Group';
      const draft = mockDraftRules.get(groupId) || JSON.parse(JSON.stringify(group));
      draft.title = group.title;
      draft.id = groupId;
      mockDraftRules.set(groupId, draft);
      updateMockSaveButtons();
      renderMockRules();
      toast('Group renamed (unsaved)', 'success');
    }

    async function deleteMockGroup(groupId) {
      if (mockSaveInProgress || mockRevertInProgress || mockResetInProgress || mockCollectionMutationCount > 0) return;
      const group = mockRules.find(r => r.id === groupId && r.type === 'group');
      if (!group) return;
      const itemCount = (group.items || []).length;
      if (itemCount > 0 && !confirm('Delete group "' + (group.title || 'Untitled Group') + '" and its ' + itemCount + ' rule(s)?')) return;
      return _queueMockCollectionMutation(async () => {
        try {
          await fetch(API_BASE + '/api/mock-rules/' + encodeURIComponent(groupId), { method: 'DELETE' });
          toast('Group deleted', 'success');
          await loadMockRules();
        } catch (err) { toast('Error: ' + err.message, 'error'); }
      });
    }

    async function createMockGroup() {
      if (mockSaveInProgress || mockRevertInProgress || mockResetInProgress || mockCollectionMutationCount > 0) return;
      const name = prompt('Group name:', 'New Group');
      if (name === null) return;
      return _queueMockCollectionMutation(async () => {
        try {
          await fetch(API_BASE + '/api/mock-rules/group', {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ title: name || 'New Group' })
          });
          toast('Group created', 'success');
          await loadMockRules();
        } catch (err) { toast('Error: ' + err.message, 'error'); }
      });
    }

    function moveRuleToGroup(ruleId, groupId) {
      if (mockResetInProgress || mockSaveInProgress || mockRevertInProgress || mockCollectionMutationCount > 0) return;
      const targetGroup = mockRules.find(rule => rule.id === groupId && rule.type === 'group');
      if (targetGroup?.collapsed === true && ruleId === mockEditingRule
          && !preserveOpenMockEdit(null)) return;
      return _queueMockCollectionMutation(async () => {
        try {
          const res = await fetch(API_BASE + '/api/mock-rules/move-to-group', {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ ruleId, groupId })
          });
          const data = await res.json();
          if (data.error) throw new Error(data.error);
          toast('Rule moved to group', 'success');
          await loadMockRules();
        } catch (err) { toast('Error: ' + err.message, 'error'); }
      });
    }

    async function ungroupRule(ruleId) {
      if (mockSaveInProgress || mockRevertInProgress || mockResetInProgress || mockCollectionMutationCount > 0) return;
      return _queueMockCollectionMutation(async () => {
        try {
          const res = await fetch(API_BASE + '/api/mock-rules/ungroup', {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ ruleId })
          });
          const data = await res.json();
          if (data.error) throw new Error(data.error);
          toast('Rule moved to top level', 'success');
          await loadMockRules();
        } catch (err) { toast('Error: ' + err.message, 'error'); }
      });
    }

    // ============ RULE IMPORT / EXPORT ============
    function exportMockRules() {
      if (mockRules.length === 0 && breakpointRules.length === 0) {
        toast('No rules to export', 'error');
        return;
      }
      const blob = new Blob([JSON.stringify({
        version: 2,
        mockRules,
        breakpointRules
      }, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'HTTPFreeKit_' + new Date().toISOString().slice(0,16).replace(/[T:]/g,'-') + '.htkrules';
      a.click();
      URL.revokeObjectURL(url);
      toast('Rules exported', 'success');
    }

    function importMockRules() {
      if (mockSaveInProgress || mockRevertInProgress || mockResetInProgress || mockCollectionMutationCount > 0) return;

      const applyImportedMockRules = async (data) => {
        if (data?.version === 2) {
          if (!Array.isArray(data.mockRules) || !Array.isArray(data.breakpointRules)) {
            throw new Error('Invalid version 2 rule backup');
          }
          const existingRuleCount = mockRules.length + breakpointRules.length;
          const importedRuleCount = data.mockRules.length + data.breakpointRules.length;
          const shouldReplace = existingRuleCount > 0 &&
            confirm('Replace existing rules? Click OK to replace, Cancel to append.');
          const response = await fetch(API_BASE + '/api/rules', {
            method: 'PUT',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify({
              mockRules: data.mockRules,
              breakpointRules: data.breakpointRules,
              ...(existingRuleCount > 0 && !shouldReplace ? { mode: 'append' } : {})
            })
          });
          const result = await response.json().catch(() => ({}));
          if (!response.ok) {
            throw new Error(result.error || 'Server rejected imported rules');
          }
          if (result?.success !== true || !Array.isArray(result.mockRules) ||
              !Array.isArray(result.breakpointRules)) {
            throw new Error('Server returned invalid imported rule collections');
          }
          if (shouldReplace || existingRuleCount === 0) {
            mockDraftRules.clear();
            mockNewDraftIds.clear();
          }
          toast((shouldReplace ? 'Replaced with ' : 'Imported ') + importedRuleCount + ' rules', 'success');
          await loadMockRules();
          await loadBreakpointRules();
          return;
        }

        const rules = data.rules || data;
        if (!Array.isArray(rules)) throw new Error('Invalid format');

        const shouldReplace = mockRules.length > 0 && confirm('Replace existing rules? Click OK to replace, Cancel to append.');
        const appendToExistingTree = mockRules.length > 0 && !shouldReplace;
        const response = await fetch(API_BASE + '/api/mock-rules', {
          method: 'PUT',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({
            rules,
            ...(appendToExistingTree ? { mode: 'append' } : {})
          })
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(result.error || 'Server rejected imported rules');
        }
        if (result?.success !== true || !Array.isArray(result.rules)) {
          throw new Error('Server returned an invalid imported rule tree');
        }
        if (!appendToExistingTree) {
          mockDraftRules.clear();
          mockNewDraftIds.clear();
        }
        toast((shouldReplace ? 'Replaced with ' : 'Imported ') + rules.length + ' rules', 'success');
        await loadMockRules();
      };

      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.htkrules,.json';
      input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
          const text = await file.text();
          const data = JSON.parse(text);
          if (mockSaveInProgress || mockRevertInProgress || mockResetInProgress || mockCollectionMutationCount > 0) return;
          await _queueMockCollectionMutation(() => applyImportedMockRules(data));
        } catch (err) {
          toast('Import failed: ' + err.message, 'error');
        }
      };
      input.click();
    }

    // ============ TRANSFORM HEADER HELPERS ============
    function _getTransformHeadersProp(kind) {
      return kind === 'res' ? 'resHeaders' : 'headers';
    }

    function updateMockTransformHeader(kind, idx, which, value, eid) {
      if (!mockEditDraft) return;
      const prop = _getTransformHeadersProp(kind);
      const entries = Object.entries(mockEditDraft.action[prop] || {});
      if (idx < 0 || idx >= entries.length) return;
      if (which === 'key') {
        const val = entries[idx][1];
        const newHeaders = {};
        entries.forEach(([k, v], i) => {
          if (i === idx) newHeaders[value] = val;
          else newHeaders[k] = v;
        });
        mockEditDraft.action[prop] = newHeaders;
      } else {
        entries[idx][1] = value;
        const newHeaders = {};
        entries.forEach(([k, v]) => { newHeaders[k] = v; });
        mockEditDraft.action[prop] = newHeaders;
      }
    }

    function addMockTransformHeader(kind, eid) {
      if (!mockEditDraft) return;
      const prop = _getTransformHeadersProp(kind);
      if (!mockEditDraft.action[prop]) mockEditDraft.action[prop] = {};
      let key = 'X-Custom';
      let n = 1;
      while (mockEditDraft.action[prop][key]) { key = 'X-Custom-' + n; n++; }
      mockEditDraft.action[prop][key] = '';
      rerenderMockTransformHeaders(kind, eid);
    }

    function removeMockTransformHeader(kind, idx, eid) {
      if (!mockEditDraft) return;
      const prop = _getTransformHeadersProp(kind);
      const entries = Object.entries(mockEditDraft.action[prop] || {});
      if (idx < 0 || idx >= entries.length) return;
      const newHeaders = {};
      entries.forEach(([k, v], i) => {
        if (i !== idx) newHeaders[k] = v;
      });
      mockEditDraft.action[prop] = newHeaders;
      rerenderMockTransformHeaders(kind, eid);
    }

    function rerenderMockTransformHeaders(kind, eid) {
      const containerId = kind === 'req' ? 'mockReqHeaders_' : 'mockResHeaders_';
      const container = document.getElementById(containerId + eid);
      if (!container || !mockEditDraft) return;
      const prop = _getTransformHeadersProp(kind);
      const entries = Object.entries(mockEditDraft.action[prop] || {});
      let html = '';
      entries.forEach(([k, v], hi) => {
        html += '<div class="mock-header-row">';
        html += '<input type="text" placeholder="Header name" value="' + esc(k) + '" onchange="updateMockTransformHeader(\'' + kind + '\',' + hi + ', \'key\', this.value, \'' + eid + '\')">';
        html += '<input type="text" placeholder="Value" value="' + esc(v) + '" onchange="updateMockTransformHeader(\'' + kind + '\',' + hi + ', \'val\', this.value, \'' + eid + '\')">';
        html += '<button class="mock-remove-btn" onclick="removeMockTransformHeader(\'' + kind + '\',' + hi + ', \'' + eid + '\')">';
        html += '<i class="ph ph-x" style="font-size:12px;"></i>';
        html += '</button></div>';
      });
      container.innerHTML = html;
    }

    function rerenderMockActionConfig(eid) {
      // Trigger a re-render by simulating a type change to the same type
      changeMockActionType(mockEditDraft.action.type, eid);
    }

    // ============ cURL PASTE PARSER ============
    function encodeCurlDataUrlValue(value) {
      const equalsIndex = value.indexOf('=');
      if (equalsIndex > 0) {
        return value.slice(0, equalsIndex + 1) + encodeURIComponent(value.slice(equalsIndex + 1));
      }
      if (equalsIndex === 0) return encodeURIComponent(value.slice(1));
      return encodeURIComponent(value);
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

    function parseCurlCommand(curlStr) {
      const result = { method: 'GET', url: '', headers: {}, body: '' };
      const dataParts = [];
      const explicitHeaderNames = new Set();
      
      // Normalize: remove line continuations and extra whitespace
      let cmd = curlStr.replace(/\\\s*\n/g, ' ').trim();
      
      // Check if it starts with curl
      if (!cmd.toLowerCase().startsWith('curl ')) return null;
      cmd = cmd.substring(5).trim();
      
      const tokens = [];
      let current = '';
      let inSingle = false, inDouble = false, escaped = false;
      
      for (let i = 0; i < cmd.length; i++) {
        const ch = cmd[i];
        if (escaped) { current += ch; escaped = false; continue; }
        if (ch === '\\' && !inSingle) { escaped = true; continue; }
        if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
        if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
        if (/\s/.test(ch) && !inSingle && !inDouble) {
          if (current) { tokens.push(current); current = ''; }
          continue;
        }
        current += ch;
      }
      if (current) tokens.push(current);
      
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t === '-X' || t === '--request') {
          result.method = (tokens[++i] || 'GET').toUpperCase();
        } else if (t === '-H' || t === '--header') {
          const header = tokens[++i] || '';
          const colonIdx = header.indexOf(':');
          if (colonIdx > 0) {
            const name = header.slice(0, colonIdx).trim();
            const value = header.slice(colonIdx + 1).trim();
            if (explicitHeaderNames.has(name.toLowerCase())) {
              appendCurlHeader(result.headers, name, value);
            } else {
              setCurlHeader(result.headers, name, value);
              explicitHeaderNames.add(name.toLowerCase());
            }
          }
        } else if (t === '-d' || t === '--data' || t === '--data-raw' || t === '--data-binary') {
          dataParts.push(tokens[++i] || '');
          if (result.method === 'GET') result.method = 'POST';
        } else if (t === '--data-urlencode') {
          dataParts.push(encodeCurlDataUrlValue(tokens[++i] || ''));
          if (result.method === 'GET') result.method = 'POST';
        } else if (t === '-A' || t === '--user-agent') {
          setCurlHeader(result.headers, 'User-Agent', tokens[++i] || '');
          explicitHeaderNames.delete('user-agent');
        } else if (t === '-b' || t === '--cookie') {
          setCurlHeader(result.headers, 'Cookie', tokens[++i] || '');
          explicitHeaderNames.delete('cookie');
        } else if (t === '-u' || t === '--user') {
          setCurlHeader(result.headers, 'Authorization', 'Basic ' + encodeBasicAuthorization(tokens[++i] || ''));
          explicitHeaderNames.delete('authorization');
        } else if (!t.startsWith('-') && !result.url) {
          result.url = t;
        }
      }
      if (dataParts.length && !findCurlHeaderKey(result.headers, 'Content-Type')) {
        setCurlHeader(result.headers, 'Content-Type', 'application/x-www-form-urlencoded');
      }
      result.body = dataParts.join('&');
      
      return result.url ? result : null;
    }

    // ============ SEND REQUEST ============
    const METHODS_WITHOUT_BODY = ['GET', 'HEAD', 'OPTIONS'];

    function updateSendMethodColor() {
      const sel = document.getElementById('sendMethod');
      const colors = {GET:'#4caf7d',POST:'#ff8c38',PUT:'#6e40aa',DELETE:'#ce3939',PATCH:'#dd3a96',HEAD:'#5a80cc',OPTIONS:'#2fb4e0'};
      sel.style.borderLeftColor = colors[sel.value] || '#888';

      // Auto-collapse/expand body card based on method (matches HTTP Toolkit behavior)
      const bodyContent = document.getElementById('sendBodyBody');
      if (bodyContent) {
        const hasBody = getSendBodyValue().trim().length > 0;
        if (METHODS_WITHOUT_BODY.includes(sel.value)) {
          // Collapse body card if body is empty
          if (!hasBody) {
            setSendCardExpanded('sendBodyBody', false);
          }
        } else {
          // Expand body card for methods that commonly have bodies
          if (bodyContent.style.display === 'none') {
            setSendCardExpanded('sendBodyBody', true);
          }
        }
      }
    }

    function setSendCardExpanded(contentId, expanded) {
      const content = document.getElementById(contentId);
      const arrowIds = {
        sendHeadersBody: 'sendHeadersArrow',
        sendBodyBody: 'sendBodyArrow',
        sendExportBody: 'sendExportArrow'
      };
      const arrowId = arrowIds[contentId];
      const arrow = document.getElementById(arrowId);
      if (!content) return;
      content.style.display = expanded ? 'block' : 'none';
      if (arrow) arrow.style.transform = expanded ? 'rotate(0deg)' : 'rotate(-90deg)';
      // Update aria-expanded on the card header
      const header = content.previousElementSibling;
      if (header && header.classList.contains('card-header')) {
        header.setAttribute('aria-expanded', String(expanded));
      }
    }

    function toggleSendCard(contentId) {
      const content = document.getElementById(contentId);
      if (!content) return;
      setSendCardExpanded(contentId, content.style.display === 'none');
    }

    function formatToContentType(format) {
      const map = { json: 'application/json', xml: 'application/xml', html: 'text/html', css: 'text/css', javascript: 'application/javascript', markdown: 'text/markdown', yaml: 'application/yaml', text: 'text/plain' };
      return map[format] || 'text/plain';
    }

    /**
     * Map send body format dropdown values to Monaco language ids.
     * @param {string} format
     * @returns {string}
     */
    function sendFormatToMonacoLanguage(format) {
      const map = { json: 'json', xml: 'xml', html: 'html', css: 'css', javascript: 'javascript', markdown: 'markdown', yaml: 'yaml', text: 'plaintext' };
      return map[format] || 'plaintext';
    }

    /**
     * Get the current send body editor content.
     * @returns {string}
     */
    function getSendBodyValue() {
      if (sendBodyEditor) {
        return sendBodyEditor.getValue();
      }
      return document.getElementById('sendBody-fallback')?.value || '';
    }

    /**
     * Set the send body editor content.
     * @param {string} value
     */
    function setSendBodyValue(value) {
      const normalizedValue = value || '';
      const fallback = document.getElementById('sendBody-fallback');
      if (fallback) {
        fallback.value = normalizedValue;
        fallback.dataset.bodyInitialized = 'true';
      }
      if (sendBodyEditor) {
        sendBodyEditor.setValue(normalizedValue);
      }
    }

    function handleSendBodyFallbackKeydown(event) {
      if (event.key !== 'Enter' || (!event.ctrlKey && !event.metaKey)) return;
      event.preventDefault();
      sendRequest();
    }

    function registerSendEditorShortcuts(editor) {
      // Ctrl+Enter sends the request
      editor.addCommand(monacoApi.KeyMod.CtrlCmd | monacoApi.KeyCode.Enter, function () {
        sendRequest();
      });

      // Monaco consumes Escape itself, so retain an explicit route to the shared handler.
      editor.addCommand(monacoApi.KeyCode.Escape, function () {
        handleSendEscapeShortcut();
      });
    }

    /**
     * Initialize or re-initialize the Send page body Monaco editor.
     * @param {string} [initialValue='']
     * @param {string} [format='text']
     */
    async function initSendBodyEditor(initialValue, format) {
      const containerId = 'sendBody-monaco-container';
      const container = document.getElementById(containerId);
      const fallback = document.getElementById('sendBody-fallback');
      if (!container || !fallback) return null;

      // Dispose previous instance if any
      if (sendBodyEditor) {
        disposeMonacoEditor(sendBodyEditor);
      }
      container.innerHTML = '';
      const startingValue = fallback.dataset.bodyInitialized === 'true'
        ? fallback.value
        : (initialValue || '');
      fallback.value = startingValue;
      fallback.dataset.bodyInitialized = 'true';
      fallback.style.display = 'block';
      container.style.display = 'none';

      const language = sendFormatToMonacoLanguage(format || 'text');

      const editor = await createMonacoEditor(containerId, {
        value: startingValue,
        language: language,
        readOnly: false,
        minimap: false,
        lineNumbers: true,
        wordWrap: 'on',
        folding: true,
      });

      if (!editor) return null;
      if (!isMonacoEditorCurrent(containerId, editor)) {
        disposeMonacoEditor(editor);
        return null;
      }
      try {
        // Keep edits made in the textarea while Monaco was loading.
        if (editor.getValue() !== fallback.value) editor.setValue(fallback.value);
        sendBodyEditor = editor;

        editor.onDidChangeModelContent(() => {
          fallback.value = editor.getValue();
          scheduleSendExportUpdate();
        });

        registerSendEditorShortcuts(editor);
        container.style.display = 'block';
        fallback.style.display = 'none';
        editor.layout();
        return editor;
      } catch (error) {
        console.warn('[Monaco] Send editor initialization failed; using textarea fallback', error);
        disposeMonacoEditor(editor);
        container.style.display = 'none';
        fallback.style.display = 'block';
        return null;
      }
    }

    /**
     * Update the Monaco editor language when send body format dropdown changes.
     */
    function updateSendBodyLanguage() {
      const format = document.getElementById('sendBodyFormat')?.value || 'text';
      if (sendBodyEditor && monacoApi) {
        const language = sendFormatToMonacoLanguage(format);
        monacoApi.editor.setModelLanguage(sendBodyEditor.getModel(), language);
      }
      scheduleSendExportUpdate();
    }

    /** @deprecated No longer needed — kept as no-op for any stale references */
    function updateSendBodyPreview() {}

    /** @deprecated No longer needed — kept as no-op for any stale references */
    function toggleSendBodyView() {}

    function formatSendBody() {
      const format = document.getElementById('sendBodyFormat')?.value || 'text';
      const value = getSendBodyValue().trim();
      if (!value) return;

      try {
        if (format === 'json') {
          const parsed = JSON.parse(value);
          setSendBodyValue(JSON.stringify(parsed, null, 2));
          toast('JSON formatted', 'success');
        } else if (format === 'xml' || format === 'html') {
          setSendBodyValue(beautifyMarkup(value));
          toast('Formatted', 'success');
        } else if (format === 'javascript') {
          setSendBodyValue(beautifyJs(value));
          toast('Formatted', 'success');
        } else if (format === 'css') {
          setSendBodyValue(beautifyCss(value));
          toast('Formatted', 'success');
        } else {
          // Try Monaco's built-in formatter for other languages
          sendBodyEditor?.getAction('editor.action.formatDocument')?.run();
        }
        scheduleSendExportUpdate();
      } catch (err) {
        toast('Format error: ' + err.message, 'error');
      }
    }

    function createMultipartBoundary() {
      const suffix = crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Math.random().toString(16).slice(2);
      return '----HTTPFreeKitBoundary' + suffix;
    }

    function getSendBodyType() {
      return document.getElementById('sendBodyType')?.value || 'raw';
    }

    function getActiveSendFormFields() {
      return getSendBodyType() === 'multipart' ? sendMultipartFields : sendUrlEncodedFields;
    }

    function updateSendBodyType() {
      const bodyType = getSendBodyType();
      const rawEditor = document.getElementById('sendRawBodyEditor');
      const monacoEditor = document.getElementById('sendBody-monaco-container');
      const fallbackEditor = document.getElementById('sendBody-fallback');
      const formEditor = document.getElementById('sendFormBodyEditor');
      const formatSelect = document.getElementById('sendBodyFormat');
      const formatButton = document.getElementById('sendBodyFormatBtn');
      const isRaw = bodyType === 'raw';

      if (rawEditor) rawEditor.style.display = isRaw ? 'block' : 'none';
      if (formEditor) formEditor.style.display = isRaw ? 'none' : 'block';
      if (formatSelect) formatSelect.style.display = isRaw ? '' : 'none';
      if (formatButton) formatButton.style.display = isRaw ? '' : 'none';

      if (!isRaw) {
        const fields = getActiveSendFormFields();
        if (fields.length === 0) fields.push({ key: '', value: '', enabled: true, type: 'text' });
        if (bodyType === 'multipart' && !sendMultipartBoundary) sendMultipartBoundary = createMultipartBoundary();
        renderSendFormFields();
      } else if (sendBodyEditor) {
        if (monacoEditor) monacoEditor.style.display = 'block';
        if (fallbackEditor) fallbackEditor.style.display = 'none';
        sendBodyEditor.layout();
      } else {
        if (monacoEditor) monacoEditor.style.display = 'none';
        if (fallbackEditor) fallbackEditor.style.display = 'block';
      }

      scheduleSendExportUpdate();
    }

    function getSendMultipartFilePresentation(field) {
      if (field?.file) {
        const fileName = String(field.file.name || 'Selected file');
        return {
          buttonLabel: 'Replace file',
          displayName: fileName,
          title: fileName,
          missing: false
        };
      }

      const rememberedFileName = String(field?.fileName || '');
      if (rememberedFileName) {
        return {
          buttonLabel: 'Choose file again',
          displayName: `Unavailable after reload: ${rememberedFileName}`,
          title: `The browser did not retain "${rememberedFileName}". Choose it again before sending.`,
          missing: true
        };
      }

      return {
        buttonLabel: 'Choose file',
        displayName: 'No file selected',
        title: 'No file selected',
        missing: false
      };
    }

    function renderSendFormFields() {
      const container = document.getElementById('sendFormBodyRows');
      if (!container) return;
      const bodyType = getSendBodyType();
      const fields = getActiveSendFormFields();

      if (fields.length === 0) {
        container.innerHTML = '<div style="padding:8px 0;color:var(--text-watermark);font-size:12px;">No form fields. Click Add field.</div>';
        return;
      }

      container.innerHTML = fields.map((field, index) => {
        const enabled = field.enabled !== false;
        const typeSelect = bodyType === 'multipart'
          ? `<select onchange="updateSendFormFieldType(${index}, this.value)" aria-label="Field type">
              <option value="text"${field.type !== 'file' ? ' selected' : ''}>Text</option>
              <option value="file"${field.type === 'file' ? ' selected' : ''}>File</option>
            </select>`
          : '<span></span>';
        const filePresentation = bodyType === 'multipart' && field.type === 'file'
          ? getSendMultipartFilePresentation(field)
          : null;
        const valueEditor = filePresentation
          ? `<span class="send-file-picker">
              <label class="send-file-picker-label">${esc(filePresentation.buttonLabel)}<input class="send-file-input" type="file" onchange="updateSendFormFile(${index}, this.files[0])"></label>
              <span class="send-file-name${filePresentation.missing ? ' send-file-name-missing' : ''}" title="${escapeHtmlAttribute(filePresentation.title)}" aria-live="polite">${esc(filePresentation.displayName)}</span>
            </span>`
          : `<input type="text" value="${esc(field.value || '')}" oninput="updateSendFormField(${index}, 'value', this.value)" placeholder="Value">`;

        return `<div class="send-form-row">
          <input type="checkbox" ${enabled ? 'checked' : ''} onchange="updateSendFormField(${index}, 'enabled', this.checked)" title="Enable/disable field">
          <input type="text" value="${esc(field.key || '')}" oninput="updateSendFormField(${index}, 'key', this.value)" placeholder="Field name">
          ${typeSelect}
          ${valueEditor}
          <button class="btn" onclick="removeSendFormField(${index})" style="padding:2px 6px;font-size:12px;color:#ce3939;" title="Remove field">&times;</button>
        </div>`;
      }).join('');
    }

    function addSendFormField() {
      getActiveSendFormFields().push({ key: '', value: '', enabled: true, type: 'text' });
      renderSendFormFields();
      scheduleSendExportUpdate();
      setTimeout(() => {
        const rows = document.querySelectorAll('.send-form-row');
        rows[rows.length - 1]?.querySelector('input[type="text"]')?.focus();
      }, 0);
    }

    function removeSendFormField(index) {
      getActiveSendFormFields().splice(index, 1);
      renderSendFormFields();
      scheduleSendExportUpdate();
    }

    function updateSendFormField(index, property, value) {
      const field = getActiveSendFormFields()[index];
      if (!field) return;
      field[property] = value;
      scheduleSendExportUpdate();
    }

    function updateSendFormFieldType(index, type) {
      const field = sendMultipartFields[index];
      if (!field) return;
      field.type = type;
      field.file = null;
      field.fileName = '';
      field.fileType = '';
      renderSendFormFields();
      scheduleSendExportUpdate();
    }

    function updateSendFormFile(index, file) {
      const field = sendMultipartFields[index];
      if (!field) return;
      field.file = file || null;
      field.fileName = file?.name || '';
      field.fileType = file?.type || 'application/octet-stream';
      renderSendFormFields();
      scheduleSendExportUpdate();
    }

    function serializeUrlEncodedFields(fields = sendUrlEncodedFields) {
      const params = new URLSearchParams();
      fields.forEach((field) => {
        if (field.enabled !== false && field.key) params.append(field.key, field.value || '');
      });
      return params.toString();
    }

    function throwIfSendAborted(signal) {
      if (!signal?.aborted) return;
      if (typeof signal.throwIfAborted === 'function') signal.throwIfAborted();
      const error = new Error('Request aborted');
      error.name = 'AbortError';
      throw error;
    }

    function awaitSendPreparation(promise, signal) {
      if (!signal) return Promise.resolve(promise);
      try {
        throwIfSendAborted(signal);
      } catch (error) {
        return Promise.reject(error);
      }

      return new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => signal.removeEventListener('abort', onAbort);
        const finish = (callback, value) => {
          if (settled) return;
          settled = true;
          cleanup();
          callback(value);
        };
        const onAbort = () => {
          try {
            throwIfSendAborted(signal);
          } catch (error) {
            finish(reject, error);
          }
        };

        signal.addEventListener('abort', onAbort, { once: true });
        Promise.resolve(promise).then(
          value => finish(resolve, value),
          error => finish(reject, error)
        );
        if (signal.aborted) onAbort();
      });
    }

    function bytesToBase64(bytes, signal) {
      let binary = '';
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        throwIfSendAborted(signal);
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
      }
      throwIfSendAborted(signal);
      return btoa(binary);
    }

    async function serializeMultipartFields(fields, boundary, signal) {
      const encoder = new TextEncoder();
      const chunks = [];
      let totalLength = 0;
      const append = (chunk) => {
        throwIfSendAborted(signal);
        const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
        chunks.push(bytes);
        totalLength += bytes.length;
      };

      for (const field of fields) {
        throwIfSendAborted(signal);
        if (field.enabled === false || !field.key) continue;
        const safeName = String(field.key).replace(/["\r\n]/g, '_');
        append(`--${boundary}\r\n`);
        if (field.type === 'file') {
          if (!field.file) throw new Error(`Choose a file for multipart field "${field.key}"`);
          const safeFilename = String(field.file.name).replace(/["\r\n]/g, '_');
          append(`Content-Disposition: form-data; name="${safeName}"; filename="${safeFilename}"\r\n`);
          append(`Content-Type: ${field.file.type || 'application/octet-stream'}\r\n\r\n`);
          throwIfSendAborted(signal);
          const fileBuffer = await awaitSendPreparation(field.file.arrayBuffer(), signal);
          throwIfSendAborted(signal);
          append(new Uint8Array(fileBuffer));
          append('\r\n');
        } else {
          append(`Content-Disposition: form-data; name="${safeName}"\r\n\r\n`);
          append(field.value || '');
          append('\r\n');
        }
      }
      throwIfSendAborted(signal);
      append(`--${boundary}--\r\n`);

      throwIfSendAborted(signal);
      const result = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        throwIfSendAborted(signal);
        result.set(chunk, offset);
        offset += chunk.length;
      }
      throwIfSendAborted(signal);
      return result;
    }

    // ============ SEND HEADERS KEY-VALUE EDITOR ============
    let sendHeadersList = []; // [{key, value, enabled}]

    function renderSendHeaders() {
      const container = document.getElementById('sendHeaderRows');
      if (!container) return;

      if (sendHeadersList.length === 0) {
        container.innerHTML = '<div style="padding:8px 0;color:var(--text-watermark);font-size:12px;">No headers. Click + to add one.</div>';
      } else {
        container.innerHTML = sendHeadersList.map((h, i) =>
          `<div class="send-header-row" style="display:flex;gap:6px;align-items:center;margin-bottom:4px;">
            <input type="checkbox" ${h.enabled !== false ? 'checked' : ''} onchange="toggleSendHeaderEnabled(${i}, this.checked)" title="Enable/disable this header" style="cursor:pointer;">
            <input type="text" value="${esc(h.key)}" oninput="updateSendHeaderKey(${i}, this.value)" placeholder="Header name" style="flex:1;background:var(--bg-input);border:1px solid var(--text-input-border);border-radius:4px;color:${h.enabled !== false ? 'var(--pop-color)' : 'var(--text-watermark)'};padding:5px 8px;font-family:var(--font-mono);font-size:12px;font-weight:600;outline:none;min-width:0;">
            <input type="text" value="${esc(h.value)}" oninput="updateSendHeaderVal(${i}, this.value)" placeholder="Header value" style="flex:2;background:var(--bg-input);border:1px solid var(--text-input-border);border-radius:4px;color:var(--text-main);padding:5px 8px;font-family:var(--font-mono);font-size:12px;outline:none;min-width:0;">
            <button class="btn" onclick="removeSendHeader(${i})" style="padding:2px 6px;font-size:12px;color:#ce3939;flex-shrink:0;" title="Remove header">&times;</button>
          </div>`
        ).join('');
      }
      syncSendHeadersToHidden();
    }

    function addSendHeader(key = '', value = '') {
      sendHeadersList.push({ key, value, enabled: true });
      renderSendHeaders();
      scheduleSendExportUpdate();
      // Focus the new key input
      setTimeout(() => {
        const rows = document.querySelectorAll('.send-header-row');
        const lastRow = rows[rows.length - 1];
        if (lastRow) lastRow.querySelector('input[type="text"]')?.focus();
      }, 50);
    }

    function removeSendHeader(index) {
      sendHeadersList.splice(index, 1);
      renderSendHeaders();
      scheduleSendExportUpdate();
    }

    function updateSendHeaderKey(index, value) {
      sendHeadersList[index].key = value;
      syncSendHeadersToHidden();
      scheduleSendExportUpdate();
    }

    function updateSendHeaderVal(index, value) {
      sendHeadersList[index].value = value;
      syncSendHeadersToHidden();
      scheduleSendExportUpdate();
    }

    function toggleSendHeaderEnabled(index, enabled) {
      sendHeadersList[index].enabled = enabled;
      renderSendHeaders();
      scheduleSendExportUpdate();
    }

    function syncSendHeadersToHidden() {
      const obj = Object.create(null);
      sendHeadersList.forEach(h => {
        if (h.enabled !== false && h.key.trim()) {
          const key = h.key.trim();
          const existingKey = Object.keys(obj).find(candidate => candidate.toLowerCase() === key.toLowerCase());
          if (!existingKey) {
            obj[key] = h.value;
          } else if (Array.isArray(obj[existingKey])) {
            obj[existingKey].push(h.value);
          } else {
            obj[existingKey] = [obj[existingKey], h.value];
          }
        }
      });
      const hidden = document.getElementById('sendHeaders');
      if (hidden) hidden.value = JSON.stringify(obj);
    }

    // Load headers from JSON string into the key-value editor
    function loadSendHeadersFromJson(jsonStr) {
      sendHeadersList = [];
      try {
        const obj = JSON.parse(jsonStr);
        sendHeadersList = normalizeSendHeaderRows(obj);
      } catch (e) { console.error('[Error]', e.message); }
      renderSendHeaders();
    }

    // ============ SEND TAB MANAGEMENT ============
    function renderSendTabs() {
      const bar = document.getElementById('sendTabBar');
      if (!bar) return;
      bar.setAttribute('role', 'tablist');
      bar.setAttribute('aria-label', 'Request tabs');
      bar.textContent = '';
      let activeTabDomId = null;
      sendTabs.forEach((tab, index) => {
        const isActive = tab.id === activeSendTab;
        let label = 'New request';
        if (tab.url) {
          try { label = tab.method + ' ' + new URL(tab.url).hostname; } catch { label = tab.method + ' ' + tab.url.substring(0, 30); }
        }
        const tabItemEl = document.createElement('div');
        tabItemEl.className = 'send-tab-item' + (isActive ? ' active' : '');
        tabItemEl.setAttribute('role', 'presentation');

        const tabEl = document.createElement('div');
        tabEl.className = 'send-tab';
        tabEl.id = 'send-request-tab-' + index;
        tabEl.setAttribute('role', 'tab');
        tabEl.setAttribute('aria-selected', String(isActive));
        tabEl.setAttribute('aria-controls', 'sendTabPanel');
        tabEl.setAttribute('aria-label', label);
        tabEl.tabIndex = isActive ? 0 : -1;
        tabEl.title = tab.url || 'New request';
        tabEl.addEventListener('click', () => switchSendTab(tab.id));
        tabEl.addEventListener('keydown', handleSendTabKeydown);
        if (isActive) activeTabDomId = tabEl.id;

        const labelEl = document.createElement('span');
        labelEl.textContent = label;
        tabEl.appendChild(labelEl);

        const closeEl = document.createElement('button');
        const closeLabel = 'Close request tab ' + (index + 1) + ': ' + label;
        closeEl.type = 'button';
        closeEl.className = 'send-tab-close';
        closeEl.title = closeLabel;
        closeEl.setAttribute('aria-label', closeLabel);
        closeEl.tabIndex = isActive ? 0 : -1;
        closeEl.textContent = '×';
        closeEl.addEventListener('click', (event) => {
          event.stopPropagation();
          closeSendTab(tab.id, event.detail === 0);
        });
        tabItemEl.appendChild(tabEl);
        tabItemEl.appendChild(closeEl);
        bar.appendChild(tabItemEl);
      });

      const panel = document.getElementById('sendTabPanel');
      if (panel && activeTabDomId) panel.setAttribute('aria-labelledby', activeTabDomId);

      const addEl = document.createElement('button');
      addEl.type = 'button';
      addEl.className = 'send-tab-add';
      addEl.title = 'New request tab';
      addEl.setAttribute('aria-label', 'New request tab');
      addEl.textContent = '+';
      addEl.addEventListener('click', addSendTab);
      bar.appendChild(addEl);
    }

    function renderSendResponseStatus(statusCode, statusMessage) {
      const statusEl = document.getElementById('sendResStatus');
      if (!statusEl) return;
      const numericStatus = Number(statusCode);
      const family = Number.isFinite(numericStatus) ? Math.floor(numericStatus / 100) : 0;
      const badge = document.createElement('span');
      badge.className = `status-badge status-${family}xx`;
      badge.textContent = `${statusCode ?? ''} ${statusMessage || ''}`.trim() || '-';
      statusEl.replaceChildren(badge);
    }

    function cloneSendFormFields(fields, includeFiles = true) {
      return (Array.isArray(fields) ? fields : [])
        .filter(field => field && typeof field === 'object' && !Array.isArray(field))
        .map((field) => ({
          key: String(field.key ?? ''),
          value: String(field.value ?? ''),
          enabled: field.enabled !== false,
          type: field.type === 'file' ? 'file' : 'text',
          fileName: String(field.file?.name || field.fileName || ''),
          fileType: String(field.file?.type || field.fileType || ''),
          ...(includeFiles && field.file ? { file: field.file } : {})
        }));
    }

    const SEND_TABS_LEGACY_KEY = 'http-freekit-send-tabs';
    const SEND_TABS_WORKSPACE_KEY = 'http-freekit-send-workspace-v2';
    const SEND_TABS_LOCK_NAME = 'http-freekit-send-workspace';
    const SEND_TAB_JOURNAL_PREFIX = 'http-freekit-send-journal-v1:';
    let sendTabPersistenceQueue = Promise.resolve();
    let sendTabJournalCounter = 0;
    let sendTabJournalTimestamp = 0;
    const pendingSendTabJournals = new Map();

    function normalizeSendHeaderRows(headers) {
      const rows = [];
      if (Array.isArray(headers)) {
        rows.push(...headers);
      } else if (headers && typeof headers === 'object') {
        for (const [key, storedValue] of Object.entries(headers)) {
          const values = Array.isArray(storedValue) ? storedValue : [storedValue];
          values.forEach(value => rows.push({ key, value, enabled: true }));
        }
      }

      return rows
        .filter(row => row && typeof row === 'object' && !Array.isArray(row))
        .map(row => ({
          key: String(row.key ?? ''),
          value: String(row.value ?? ''),
          enabled: row.enabled !== false
        }));
    }

    function parseSendTabId(id) {
      if (typeof id !== 'string') return null;
      const match = /^tab-([1-9]\d*)$/.exec(id);
      if (match) {
        const numericId = Number(match[1]);
        return Number.isSafeInteger(numericId) ? numericId : null;
      }
      return /^tab-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)
        ? 0
        : null;
    }

    function normalizeSendTab(tab, fallbackId, { includeFiles = true, includeResponse = true } = {}) {
      if (!tab || typeof tab !== 'object' || Array.isArray(tab)) return null;
      const bodyTypes = new Set(['raw', 'urlencoded', 'multipart']);
      const bodyFormats = new Set(['text', 'json', 'xml', 'html', 'css', 'javascript', 'markdown', 'yaml']);
      const savedId = parseSendTabId(tab.id) !== null
        ? tab.id
        : (parseSendTabId(fallbackId) !== null ? fallbackId : 'tab-1');
      return {
        id: savedId,
        method: typeof tab.method === 'string' && tab.method ? tab.method : 'GET',
        url: typeof tab.url === 'string' ? tab.url : '',
        headers: normalizeSendHeaderRows(tab.headers),
        body: typeof tab.body === 'string' ? tab.body : '',
        bodyType: bodyTypes.has(tab.bodyType) ? tab.bodyType : 'raw',
        bodyFormat: bodyFormats.has(tab.bodyFormat) ? tab.bodyFormat : 'text',
        urlEncodedFields: cloneSendFormFields(tab.urlEncodedFields, includeFiles),
        multipartFields: cloneSendFormFields(tab.multipartFields, includeFiles),
        multipartBoundary: typeof tab.multipartBoundary === 'string' ? tab.multipartBoundary : '',
        response: includeResponse && tab.response && typeof tab.response === 'object' && !Array.isArray(tab.response)
          ? tab.response
          : null
      };
    }

    function normalizeStoredSendTabs(tabs) {
      if (!Array.isArray(tabs)) return [];
      const reservedIds = new Set(tabs
        .filter(tab => tab && typeof tab === 'object' && !Array.isArray(tab))
        .map(tab => parseSendTabId(tab.id) !== null ? tab.id : null)
        .filter(Boolean));
      const usedIds = new Set();
      let generatedId = 1;

      return tabs.flatMap(tab => {
        if (!tab || typeof tab !== 'object' || Array.isArray(tab)) return [];
        let id = parseSendTabId(tab.id) !== null && !usedIds.has(tab.id) ? tab.id : null;
        if (!id) {
          do { id = `tab-${generatedId++}`; } while (reservedIds.has(id) || usedIds.has(id));
        }
        usedIds.add(id);
        const normalized = normalizeSendTab(tab, id, { includeFiles: false, includeResponse: false });
        normalized.id = id;
        return [normalized];
      });
    }

    function allocateSendTabId() {
      const usedIds = new Set(sendTabs.map(tab => tab.id));
      // A remote tab or permanent tombstone may not have reached this renderer's
      // in-memory snapshot yet. Never allocate an identity already present in
      // the shared workspace, because a tombstoned upsert is intentionally ignored.
      try {
        const storedWorkspace = readStoredSendWorkspace();
        storedWorkspace.tabs.forEach(tab => usedIds.add(tab.id));
        storedWorkspace.deletedTabIds.forEach(id => usedIds.add(id));
      } catch {}
      const randomUUID = globalThis.crypto?.randomUUID;
      if (typeof randomUUID === 'function') {
        for (let attempts = 0; attempts < 10; attempts++) {
          const id = `tab-${randomUUID.call(globalThis.crypto)}`;
          if (!usedIds.has(id)) return id;
        }
      }

      let candidate = Number.isSafeInteger(sendTabCounter) && sendTabCounter >= 0
        ? sendTabCounter + 1
        : 1;
      if (!Number.isSafeInteger(candidate)) candidate = 1;

      for (let attempts = 0; attempts <= usedIds.size; attempts++) {
        const id = `tab-${candidate}`;
        if (!usedIds.has(id)) {
          sendTabCounter = candidate;
          return id;
        }
        candidate++;
        if (!Number.isSafeInteger(candidate)) candidate = 1;
      }
      throw new Error('Could not allocate a unique Send tab ID');
    }

    function createEmptySendTab() {
      return {
        id: allocateSendTabId(),
        method: 'GET',
        url: '',
        headers: [],
        body: '',
        bodyType: 'raw',
        bodyFormat: 'text',
        urlEncodedFields: [],
        multipartFields: [],
        multipartBoundary: '',
        response: null
      };
    }

    function serializeSendTab(tab) {
      const normalized = normalizeSendTab(tab, tab?.id, {
        includeFiles: false,
        includeResponse: false
      });
      if (!normalized || parseSendTabId(normalized.id) === null) return null;
      delete normalized.response;
      return normalized;
    }

    function normalizeStoredSendWorkspace(workspace) {
      if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace) || workspace.version !== 2) {
        return null;
      }
      const deletedTabIds = Array.from(new Set(
        (Array.isArray(workspace.deletedTabIds) ? workspace.deletedTabIds : [])
          .filter(id => parseSendTabId(id) !== null)
      ));
      const deletedIds = new Set(deletedTabIds);
      return {
        version: 2,
        tabs: normalizeStoredSendTabs(workspace.tabs).filter(tab => !deletedIds.has(tab.id)),
        deletedTabIds
      };
    }

    // Each renderer writes only its tab-level changes. The cross-window lock
    // serializes read/merge/write operations, and permanent tombstones make
    // deletion win over any later write from a stale renderer.
    function readStoredSendWorkspace() {
      const savedWorkspace = safeLocalStorageGet(SEND_TABS_WORKSPACE_KEY);
      if (savedWorkspace) {
        try {
          const workspace = normalizeStoredSendWorkspace(JSON.parse(savedWorkspace));
          if (workspace) return workspace;
        } catch {}
      }

      const savedLegacyTabs = safeLocalStorageGet(SEND_TABS_LEGACY_KEY);
      if (savedLegacyTabs) {
        try {
          return {
            version: 2,
            tabs: normalizeStoredSendTabs(JSON.parse(savedLegacyTabs)),
            deletedTabIds: []
          };
        } catch {}
      }
      return { version: 2, tabs: [], deletedTabIds: [] };
    }

    function mergeStoredSendWorkspace(workspace, upserts = [], deletedTabIds = []) {
      const normalizedWorkspace = normalizeStoredSendWorkspace(workspace) || {
        version: 2,
        tabs: [],
        deletedTabIds: []
      };
      const deletedIds = new Set(normalizedWorkspace.deletedTabIds);
      for (const id of deletedTabIds) {
        if (parseSendTabId(id) !== null) deletedIds.add(id);
      }

      const tabs = normalizedWorkspace.tabs.filter(tab => !deletedIds.has(tab.id));
      for (const candidate of upserts) {
        const tab = serializeSendTab(candidate);
        if (!tab || deletedIds.has(tab.id)) continue;
        const existingIndex = tabs.findIndex(existing => existing.id === tab.id);
        if (existingIndex === -1) tabs.push(tab);
        else tabs[existingIndex] = tab;
      }

      return { version: 2, tabs, deletedTabIds: Array.from(deletedIds) };
    }

    function withSendTabStorageLock(callback) {
      const locks = globalThis.navigator?.locks;
      return locks && typeof locks.request === 'function'
        ? locks.request(SEND_TABS_LOCK_NAME, callback)
        : Promise.resolve().then(callback);
    }

    function compareSendTabJournals(first, second) {
      return first.journal.createdAt - second.journal.createdAt ||
        first.journal.token.localeCompare(second.journal.token);
    }

    function createSendTabJournal(id, tab, deleted = false) {
      if (parseSendTabId(id) === null) return null;
      let entropy = '';
      try {
        entropy = globalThis.crypto?.randomUUID?.() || '';
      } catch {}
      if (typeof entropy !== 'string' || !/^[a-z0-9-]{1,80}$/i.test(entropy)) {
        entropy = Math.random().toString(36).slice(2);
      }
      const token = `${entropy}-${(++sendTabJournalCounter).toString(36)}`;
      const clock = globalThis.performance;
      const highResolutionNow = Number.isFinite(clock?.timeOrigin) && typeof clock?.now === 'function'
        ? clock.timeOrigin + clock.now()
        : Date.now();
      const createdAt = Math.max(highResolutionNow, sendTabJournalTimestamp + 0.001);
      sendTabJournalTimestamp = createdAt;
      if (deleted) return { version: 1, token, createdAt, id, deleted: true };
      const serializedTab = serializeSendTab(tab);
      if (!serializedTab || serializedTab.id !== id) return null;
      return { version: 1, token, createdAt, id, deleted: false, tab: serializedTab };
    }

    function normalizeStoredSendTabJournal(candidate) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) ||
          candidate.version !== 1 || parseSendTabId(candidate.id) === null ||
          typeof candidate.token !== 'string' ||
          !/^[a-z0-9-]{1,128}$/i.test(candidate.token) ||
          !Number.isFinite(candidate.createdAt) || candidate.createdAt < 0 ||
          typeof candidate.deleted !== 'boolean') {
        return null;
      }
      if (candidate.deleted) {
        return {
          version: 1,
          token: candidate.token,
          createdAt: candidate.createdAt,
          id: candidate.id,
          deleted: true
        };
      }
      const tab = serializeSendTab(candidate.tab);
      if (!tab || tab.id !== candidate.id) return null;
      return {
        version: 1,
        token: candidate.token,
        createdAt: candidate.createdAt,
        id: candidate.id,
        deleted: false,
        tab
      };
    }

    function getSendTabJournalKey(journal) {
      return SEND_TAB_JOURNAL_PREFIX + encodeURIComponent(journal.id) + ':' +
        encodeURIComponent(journal.token);
    }

    function readStoredSendTabJournals() {
      const storage = globalThis.window?.localStorage;
      if (!storage) return [];
      let keys;
      try {
        keys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
          .filter(key => typeof key === 'string' && key.startsWith(SEND_TAB_JOURNAL_PREFIX));
      } catch {
        return [];
      }

      const entries = [];
      for (const key of keys) {
        const saved = safeLocalStorageGet(key);
        if (!saved) continue;
        let journal = null;
        try {
          journal = normalizeStoredSendTabJournal(JSON.parse(saved));
        } catch {}
        if (!journal || key !== getSendTabJournalKey(journal)) {
          if (typeof safeLocalStorageRemove === 'function') safeLocalStorageRemove(key, false);
          continue;
        }
        entries.push({ key, journal, stored: true });
      }
      return entries;
    }

    function stageSendTabJournal(journal) {
      if (!journal) return null;
      const entry = {
        key: getSendTabJournalKey(journal),
        journal,
        stored: false
      };
      pendingSendTabJournals.set(journal.id, entry);
      entry.stored = safeLocalStorageSet(entry.key, JSON.stringify(journal));
      return entry;
    }

    function latestSendTabJournals(entries) {
      const latest = new Map();
      for (const entry of entries) {
        const current = latest.get(entry.journal.id);
        // Tab IDs are never reused. Once any renderer records a deletion,
        // later writes from a stale renderer must not resurrect that identity.
        const deletionWins = entry.journal.deleted && !current?.journal.deleted;
        const sameOperationTypeIsNewer = current &&
          entry.journal.deleted === current.journal.deleted &&
          compareSendTabJournals(current, entry) < 0;
        if (!current || deletionWins || sameOperationTypeIsNewer) {
          latest.set(entry.journal.id, entry);
        }
      }
      return latest;
    }

    function overlaySendTabJournals(workspace, entries) {
      const latest = latestSendTabJournals(entries);
      const upserts = [];
      const deletions = [];
      for (const entry of latest.values()) {
        if (entry.journal.deleted) deletions.push(entry.journal.id);
        else upserts.push(entry.journal.tab);
      }
      return mergeStoredSendWorkspace(workspace, upserts, deletions);
    }

    function removeCommittedSendTabJournals(entries) {
      const ordered = entries.slice().sort(compareSendTabJournals);
      for (const entry of ordered) {
        // Remove oldest-first. If cleanup fails, retaining the newest entry keeps
        // restore ordering authoritative instead of exposing an older survivor.
        if (!safeLocalStorageRemove(entry.key, false)) return false;
      }
      return true;
    }

    function enqueueSendTabJournalPersistence(operationEntries) {
      const operationIds = new Set(operationEntries.map(entry => entry.journal.id));
      const persist = () => withSendTabStorageLock(() => {
        const storedEntries = readStoredSendTabJournals()
          .filter(entry => operationIds.has(entry.journal.id));
        const entriesById = new Map();
        for (const entry of storedEntries) {
          if (!entriesById.has(entry.journal.id)) entriesById.set(entry.journal.id, []);
          entriesById.get(entry.journal.id).push(entry);
        }
        for (const operationEntry of operationEntries) {
          if (operationEntry.stored || entriesById.has(operationEntry.journal.id)) continue;
          entriesById.set(operationEntry.journal.id, [operationEntry]);
        }

        const effectiveEntries = latestSendTabJournals(
          Array.from(entriesById.values()).flat()
        );
        const upserts = [];
        const deletions = [];
        for (const entry of effectiveEntries.values()) {
          if (entry.journal.deleted) deletions.push(entry.journal.id);
          else upserts.push(entry.journal.tab);
        }
        const workspace = mergeStoredSendWorkspace(readStoredSendWorkspace(), upserts, deletions);
        const saved = safeLocalStorageSet(SEND_TABS_WORKSPACE_KEY, JSON.stringify(workspace));
        if (saved) {
          for (const id of operationIds) {
            const storedForId = entriesById.get(id)?.filter(entry => entry.stored) || [];
            if (storedForId.length > 0) removeCommittedSendTabJournals(storedForId);
            const pendingEntry = pendingSendTabJournals.get(id);
            const resolvedKeys = new Set([
              ...storedForId.map(entry => entry.key),
              ...operationEntries.filter(entry => entry.journal.id === id).map(entry => entry.key)
            ]);
            if (pendingEntry && resolvedKeys.has(pendingEntry.key)) {
              pendingSendTabJournals.delete(id);
            }
          }
        }
        return workspace;
      });
      const pending = sendTabPersistenceQueue.then(persist, persist);
      sendTabPersistenceQueue = pending.catch(() => {});
      return pending;
    }

    function persistSendTabs() {
      const tabsToUpsert = arguments[0] ?? [];
      const deletedTabIds = arguments[1] ?? [];
      const deletions = new Set((Array.isArray(deletedTabIds) ? deletedTabIds : [])
        .filter(id => parseSendTabId(id) !== null));
      const upserts = (Array.isArray(tabsToUpsert) ? tabsToUpsert : [])
        .map(serializeSendTab)
        .filter(tab => tab && !deletions.has(tab.id));
      const operationEntries = [];
      for (const tab of upserts) {
        const entry = stageSendTabJournal(createSendTabJournal(tab.id, tab));
        if (entry) operationEntries.push(entry);
      }
      for (const id of deletions) {
        const entry = stageSendTabJournal(createSendTabJournal(id, null, true));
        if (entry) operationEntries.push(entry);
      }
      if (operationEntries.length === 0) return Promise.resolve(readStoredSendWorkspace());
      return enqueueSendTabJournalPersistence(operationEntries);
    }

    function preserveSendTabTransientState(storedTab, liveTab) {
      if (!liveTab) return storedTab;
      const merged = { ...storedTab, response: liveTab.response || null };
      for (const fieldName of ['urlEncodedFields', 'multipartFields']) {
        merged[fieldName] = storedTab[fieldName].map((field, index) => {
          const liveField = liveTab[fieldName]?.[index];
          return liveField?.file && liveField.key === field.key && liveField.type === field.type
            ? { ...field, file: liveField.file }
            : field;
        });
      }
      return merged;
    }

    function applyStoredSendWorkspace(workspace) {
      const normalizedWorkspace = normalizeStoredSendWorkspace(workspace);
      if (!normalizedWorkspace) return;
      const previousActiveId = activeSendTab;
      const liveTabs = new Map(sendTabs.map(tab => [tab.id, tab]));
      sendTabs = normalizedWorkspace.tabs.map(tab =>
        preserveSendTabTransientState(tab, liveTabs.get(tab.id))
      );
      if (sendTabs.length === 0) sendTabs = [createEmptySendTab()];
      sendTabCounter = sendTabs.reduce(
        (max, tab) => Math.max(max, parseSendTabId(tab.id) || 0),
        0
      );

      if (!sendTabs.some(tab => tab.id === activeSendTab)) {
        activeSendTab = sendTabs[0].id;
        loadSendTabState(sendTabs[0]);
      }
      renderSendTabs();
      if (previousActiveId !== activeSendTab) {
        safeLocalStorageSet('http-freekit-send-active', activeSendTab);
      }
    }

    function handleSendTabStorageEvent(event) {
      if (event.key !== SEND_TABS_WORKSPACE_KEY || !event.newValue) return;
      try {
        applyStoredSendWorkspace(overlaySendTabJournals(
          JSON.parse(event.newValue),
          readStoredSendTabJournals()
        ));
      } catch {}
    }

    function captureActiveSendTabState() {
      const tab = sendTabs.find(t => t.id === activeSendTab);
      if (!tab) return null;
      tab.method = document.getElementById('sendMethod')?.value || 'GET';
      tab.url = document.getElementById('sendUrl')?.value || '';
      tab.headers = sendHeadersList.slice();
      tab.body = getSendBodyValue();
      tab.bodyType = getSendBodyType();
      tab.bodyFormat = document.getElementById('sendBodyFormat')?.value || 'text';
      tab.urlEncodedFields = cloneSendFormFields(sendUrlEncodedFields);
      tab.multipartFields = cloneSendFormFields(sendMultipartFields);
      tab.multipartBoundary = sendMultipartBoundary;
      return tab;
    }

    function saveSendTabState() {
      const tab = captureActiveSendTabState();
      if (!tab) return;
      return persistSendTabs([tab]);
    }

    function persistActiveSendTabBeforeUnload(event) {
      const tab = serializeSendTab(captureActiveSendTabState());
      if (tab) {
        stageSendTabJournal(createSendTabJournal(tab.id, tab));
      }

      let saved = true;
      for (const entry of pendingSendTabJournals.values()) {
        if (!entry.stored) {
          entry.stored = safeLocalStorageSet(entry.key, JSON.stringify(entry.journal));
        }
        if (!entry.stored) saved = false;
      }
      if (!saved) {
        event?.preventDefault?.();
        if (event) event.returnValue = '';
        return false;
      }
      return true;
    }

    function restoreSendTabs() {
      try {
        const journalEntries = readStoredSendTabJournals();
        const workspace = overlaySendTabJournals(readStoredSendWorkspace(), journalEntries);
        let replacementTab = null;
        if (workspace.tabs.length > 0) {
          sendTabs = workspace.tabs;
        } else if (journalEntries.length > 0) {
          sendTabs = [];
          replacementTab = createEmptySendTab();
          sendTabs = [replacementTab];
        }
        if (workspace.tabs.length > 0 || journalEntries.length > 0) {
          sendTabCounter = sendTabs.reduce((max, tab) => Math.max(max, parseSendTabId(tab.id) || 0), 0);
          const savedActive = safeLocalStorageGet('http-freekit-send-active');
          activeSendTab = savedActive && sendTabs.some(tab => tab.id === savedActive)
            ? savedActive
            : sendTabs[0].id;
        }
        if (journalEntries.length > 0) enqueueSendTabJournalPersistence(journalEntries);
        if (replacementTab) persistSendTabs([replacementTab]);
      } catch {}
    }

    function loadSendTabState(tab) {
      tab = normalizeSendTab(tab, activeSendTab || 'tab-1') || normalizeSendTab({}, 'tab-1');
      document.getElementById('sendMethod').value = tab.method || 'GET';
      document.getElementById('sendUrl').value = tab.url || '';
      sendHeadersList = tab.headers.slice();
      renderSendHeaders();
      const fmt = document.getElementById('sendBodyFormat');
      if (fmt) fmt.value = tab.bodyFormat || 'text';
      const bodyType = document.getElementById('sendBodyType');
      if (bodyType) bodyType.value = tab.bodyType || 'raw';
      sendUrlEncodedFields = cloneSendFormFields(tab.urlEncodedFields);
      sendMultipartFields = cloneSendFormFields(tab.multipartFields);
      sendMultipartBoundary = tab.multipartBoundary || '';
      setSendBodyValue(tab.body || '');
      updateSendBodyLanguage();
      updateSendBodyType();
      if (typeof updateSendMethodColor === 'function') updateSendMethodColor();
      // Restore response if any
      const resEl = document.getElementById('sendResponse');
      const emptyEl = document.getElementById('sendEmptyResponse');
      if (tab.response) {
        if (resEl) resEl.style.display = 'block';
        if (emptyEl) emptyEl.style.display = 'none';
        renderSendResponseStatus(tab.response.statusCode, tab.response.statusMessage);
        document.getElementById('sendResDuration').textContent = tab.response.duration || '-';
        document.getElementById('sendResHeaders').innerHTML = tab.response.headersHtml || '';
        let responsePath = '';
        try { responsePath = new URL(tab.response.url || tab.url || '').pathname; } catch {}
        const responseContext = {
          request: {
            id: tab.response.trafficId,
            method: tab.response.method || tab.method || 'GET',
            url: tab.response.url || tab.url || '',
            path: responsePath,
            responseHeaders: tab.response.responseHeaders || {},
            responseBodyEncoding: tab.response.bodyEncoding || 'utf8',
            source: 'Send'
          },
          section: 'response'
        };
        setStandaloneBodyViewer(
          'sendResBody',
          tab.response.body || tab.response.bodyText || '',
          tab.response.contentType || 'text/plain',
          'sendResBodyMode',
          tab.response.mode,
          responseContext
        );
        const viewLink = document.getElementById('sendViewInTraffic');
        if (viewLink) {
          viewLink.style.display = tab.response.trafficId ? 'inline-flex' : 'none';
          viewLink.onclick = tab.response.trafficId ? () => {
            const trafficTab = document.querySelector('.sidebar-item[data-panel="traffic"]');
            if (trafficTab) switchPanel(trafficTab, 'traffic');
            selectRequest(tab.response.trafficId, true);
          } : null;
        }
      } else {
        if (resEl) resEl.style.display = 'none';
        if (emptyEl) emptyEl.style.display = 'flex';
        disposeBodyEditor('sendResBody-monaco');
        delete standaloneBodyViewers.sendResBody;
        const modeSelect = document.getElementById('sendResBodyMode');
        if (modeSelect) modeSelect.style.display = 'none';
        const viewLink = document.getElementById('sendViewInTraffic');
        if (viewLink) viewLink.style.display = 'none';
      }
    }

    function switchSendTab(tabId) {
      saveSendTabState();
      activeSendTab = tabId;
      safeLocalStorageSet('http-freekit-send-active', activeSendTab);
      const tab = sendTabs.find(t => t.id === tabId);
      if (tab) loadSendTabState(tab);
      renderSendTabs();
    }

    function addSendTab() {
      saveSendTabState();
      const newTab = createEmptySendTab();
      sendTabs.push(newTab);
      activeSendTab = newTab.id;
      safeLocalStorageSet('http-freekit-send-active', activeSendTab);
      persistSendTabs([newTab]);
      loadSendTabState(newTab);
      renderSendTabs();
    }

    function closeSendTab(tabId, restoreTabFocus = false) {
      saveSendTabState();
      const idx = sendTabs.findIndex(t => t.id === tabId);
      if (idx === -1) return;
      if (sendTabs.length <= 1) {
        const newTab = createEmptySendTab();
        sendTabs = [newTab];
        activeSendTab = newTab.id;
        safeLocalStorageSet('http-freekit-send-active', activeSendTab);
        loadSendTabState(newTab);
        renderSendTabs();
        if (restoreTabFocus) {
          document.querySelector?.('#sendTabBar [role="tab"][aria-selected="true"]')?.focus();
        }
        persistSendTabs([newTab], [tabId]);
        return;
      }
      sendTabs.splice(idx, 1);
      if (activeSendTab === tabId) {
        activeSendTab = sendTabs[Math.min(idx, sendTabs.length - 1)].id;
        safeLocalStorageSet('http-freekit-send-active', activeSendTab);
        loadSendTabState(sendTabs.find(t => t.id === activeSendTab));
      }
      renderSendTabs();
      if (restoreTabFocus) {
        document.querySelector?.('#sendTabBar [role="tab"][aria-selected="true"]')?.focus();
      }
      persistSendTabs([], [tabId]);
    }

    function initializeSendTabs() {
      renderSendHeaders();
      renderSendTabs();
      const startupTab = sendTabs.find(tab => tab.id === activeSendTab) || sendTabs[0];
      if (startupTab) loadSendTabState(startupTab);

      setTimeout(async () => {
        const tabBeforeEditor = sendTabs.find(tab => tab.id === activeSendTab) || sendTabs[0];
        await initSendBodyEditor(tabBeforeEditor?.body || '', tabBeforeEditor?.bodyFormat || 'text');
        // Tab selection can change while Monaco is loading; always reconcile with current state.
        const currentTab = sendTabs.find(tab => tab.id === activeSendTab) || sendTabs[0];
        if (currentTab) loadSendTabState(currentTab);
      }, 100);
    }

    function prepopulateSendUrl(input) {
      if (!input.value) {
        input.value = 'https://';
        scheduleSendExportUpdate();
      }
    }

    function setSendLoading(loading) {
      const btn = document.getElementById('sendBtn');
      const arrow = document.getElementById('sendBtnArrow');
      const spinner = document.getElementById('sendBtnSpinner');
      if (!btn || !arrow || !spinner) return;
      btn.disabled = loading;
      arrow.style.display = loading ? 'none' : '';
      spinner.style.display = loading ? 'inline-block' : 'none';
      if (loading) {
        btn.style.opacity = '0.7';
        btn.style.cursor = 'not-allowed';
      } else {
        btn.style.opacity = '';
        btn.style.cursor = '';
      }
      const abortBtn = document.getElementById('sendAbortBtn');
      if (abortBtn) abortBtn.style.display = loading ? 'inline-flex' : 'none';
    }

    function findHeaderKey(headers, name) {
      const lowerName = name.toLowerCase();
      return Object.keys(headers).find(key => key.toLowerCase() === lowerName) || null;
    }

    function setDefaultHeader(headers, name, value) {
      if (!findHeaderKey(headers, name)) headers[name] = value;
    }

    function getMultipartDisplayBody(fields) {
      return fields
        .filter(field => field.enabled !== false && field.key)
        .map(field => field.type === 'file'
          ? `${field.key}=@${field.file?.name || field.fileName || 'file'}`
          : `${field.key}=${field.value || ''}`)
        .join('\n');
    }

    async function prepareSendRequestPayload(headers, signal) {
      if (signal) throwIfSendAborted(signal);
      const bodyType = getSendBodyType();
      if (bodyType === 'urlencoded') {
        const body = serializeUrlEncodedFields();
        setDefaultHeader(headers, 'Content-Type', 'application/x-www-form-urlencoded');
        if (signal) throwIfSendAborted(signal);
        return { body, bodyEncoding: 'utf8', displayBody: body, byteLength: new TextEncoder().encode(body).length };
      }

      if (bodyType === 'multipart') {
        const contentTypeKey = findHeaderKey(headers, 'Content-Type');
        const contentType = contentTypeKey ? String(headers[contentTypeKey]) : '';
        const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
        const boundary = boundaryMatch?.[1] || boundaryMatch?.[2] || sendMultipartBoundary || createMultipartBoundary();
        sendMultipartBoundary = boundary;

        if (!contentTypeKey) {
          headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
        } else if (/^multipart\/form-data(?:\s*;.*)?$/i.test(contentType.trim()) && !boundaryMatch) {
          headers[contentTypeKey] = `${contentType}; boundary=${boundary}`;
        }

        const bytes = await serializeMultipartFields(sendMultipartFields, boundary, signal);
        if (signal) throwIfSendAborted(signal);
        return {
          body: bytesToBase64(bytes, signal),
          bodyEncoding: 'base64',
          displayBody: getMultipartDisplayBody(sendMultipartFields),
          byteLength: bytes.length
        };
      }

      const body = getSendBodyValue();
      if (body) setDefaultHeader(headers, 'Content-Type', formatToContentType(document.getElementById('sendBodyFormat')?.value || 'text'));
      if (signal) throwIfSendAborted(signal);
      return { body, bodyEncoding: 'utf8', displayBody: body, byteLength: new TextEncoder().encode(body).length };
    }

    async function sendRequest() {
      if (currentSendAbort) return;

      const initiatingTabId = activeSendTab;
      const method = document.getElementById('sendMethod').value;
      const url = document.getElementById('sendUrl').value.trim();
      const headersStr = document.getElementById('sendHeaders').value.trim();

      if (!url) { toast('URL is required', 'error'); return; }

      let headers = {};
      if (headersStr) {
        try { headers = JSON.parse(headersStr); } catch { toast('Invalid headers JSON', 'error'); return; }
      }

      setSendLoading(true);
      const sendAbort = new AbortController();
      currentSendAbort = sendAbort;
      try {
        const payload = await prepareSendRequestPayload(headers, sendAbort.signal);
        const res = await fetch(`${API_BASE}/api/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, method, headers, body: payload.body, bodyEncoding: payload.bodyEncoding }),
          signal: sendAbort.signal
        });
        const data = await res.json();

        if (data.error) throw new Error(data.error);

        const headersHtml = renderHeaders(data.headers);
        const resCt = data.headers?.['content-type'] || '';
        const modes = getBodyViewModes(data.body, resCt);
        const defaultMode = modes[0]?.value || 'text';
        const duration = data.duration + 'ms';

        const responseTab = sendTabs.find(tab => tab.id === initiatingTabId);
        if (!responseTab) return;
        responseTab.response = {
          statusCode: data.statusCode,
          statusMessage: data.statusMessage || '',
          headersHtml,
          responseHeaders: data.headers || {},
          body: data.body || '',
          bodyEncoding: data.bodyEncoding || 'utf8',
          bodySize: Number.isFinite(data.bodySize) ? data.bodySize : (data.body ? data.body.length : 0),
          contentType: resCt,
          mode: defaultMode,
          duration,
          url,
          method,
          trafficId: data.trafficId
        };
        renderSendTabs();

        // Keep a background response with the tab that initiated it. Loading the
        // tab later will render this response without disturbing the active tab.
        if (activeSendTab !== initiatingTabId) return;

        document.getElementById('sendResponse').style.display = 'block';
        document.getElementById('sendEmptyResponse').style.display = 'none';
        renderSendResponseStatus(data.statusCode, data.statusMessage);
        document.getElementById('sendResDuration').textContent = duration;
        document.getElementById('sendResHeaders').innerHTML = headersHtml;

        // The proxy owns the authoritative traffic row; this object only gives
        // the response body viewer request context.
        const responseRequest = {
          id: data.trafficId,
          protocol: url.startsWith('https') ? 'https' : 'http',
          method, url,
          host: new URL(url).hostname,
          path: new URL(url).pathname + new URL(url).search,
          requestHeaders: headers,
          requestBody: payload.displayBody,
          requestBodySize: payload.byteLength,
          statusCode: data.statusCode,
          statusMessage: data.statusMessage,
          responseHeaders: data.headers,
          responseBody: data.body,
          responseBodyEncoding: data.bodyEncoding || 'utf8',
          responseBodySize: Number.isFinite(data.bodySize) ? data.bodySize : (data.body ? data.body.length : 0),
          duration: data.duration,
          timestamp: Date.now(),
          source: 'Send'
        };
        setStandaloneBodyViewer('sendResBody', data.body || '', resCt, 'sendResBodyMode', defaultMode, { request: responseRequest, section: 'response' });

        // Show "View in traffic" link
        const viewLink = document.getElementById('sendViewInTraffic');
        if (viewLink) {
          viewLink.style.display = data.trafficId ? 'inline-flex' : 'none';
          viewLink.onclick = data.trafficId ? () => {
            const trafficTab = document.querySelector('.sidebar-item[data-panel="traffic"]');
            if (trafficTab) switchPanel(trafficTab, 'traffic');
            selectRequest(data.trafficId, true);
          } : null;
        }

        saveSendTabState();
      } catch (err) {
        if (err.name === 'AbortError') return; // handled by abortSendRequest
        toast(`Error: ${err.message}`, 'error');
      } finally {
        if (currentSendAbort === sendAbort) {
          currentSendAbort = null;
          setSendLoading(false);
        }
      }
    }

    function abortSendRequest() {
      if (currentSendAbort && !currentSendAbort.signal.aborted) {
        currentSendAbort.abort();
        toast('Request aborted', 'success');
        return true;
      }
      return false;
    }

    function handleSendEscapeShortcut(event) {
      const sendPanelActive = document.getElementById('panel-send')?.classList.contains('active') === true;
      if (!sendPanelActive || !currentSendAbort) return false;

      event?.preventDefault?.();
      // Keep consuming Escape while the aborted fetch settles. abortSendRequest itself
      // ensures Monaco and document delivery cannot abort or toast more than once.
      abortSendRequest();
      return true;
    }

    // ============ CONFIG ============
    function renderCaRenewalState(config) {
      const expiry = document.getElementById('settingsCaExpiry');
      if (expiry) {
        const expiryTime = Number(config?.certificateExpiry);
        expiry.textContent = Number.isFinite(expiryTime)
          ? new Date(expiryTime).toLocaleString()
          : '--';
      }

      const notice = document.getElementById('settingsCaRenewalNotice');
      const actions = document.getElementById('settingsCaRenewalActions');
      const schedule = document.getElementById('settingsCaScheduleRenewal');
      const cancel = document.getElementById('settingsCaCancelRenewal');
      const acknowledge = document.getElementById('settingsCaAcknowledgeReplacement');
      const scheduled = config?.certificateRenewalScheduled === true;
      const replacementPending = config?.certificateReplacementPending === true;
      const renewalRequired = config?.certificateRenewalRequired === true;
      const expired = config?.certificateExpired === true;
      const automaticRenewal = config?.certificateAutomaticRenewalEnabled === true;

      let message = '';
      if (scheduled) {
        message = 'CA renewal is scheduled for the next restart. Existing manually configured clients will need to install the replacement certificate.';
      } else if (replacementPending) {
        message = 'The CA was replaced. Download and install this certificate in every manually configured client, remove the previous CA when convenient, then acknowledge the migration here.';
      } else if (renewalRequired) {
        message = automaticRenewal
          ? 'This CA expires within 30 days. Windows will install its replacement automatically during the final 48 hours; manually configured external clients will still need the new certificate.'
          : expired
          ? 'This CA has expired. Automatic replacement is paused so the trusted identity is not changed without your approval.'
          : 'This CA expires within 30 days. Automatic replacement is paused so manually configured clients are not silently disconnected.';
      }

      if (notice) {
        notice.textContent = message;
        notice.style.display = message ? 'block' : 'none';
      }
      if (schedule) {
        schedule.style.display = renewalRequired && !scheduled && !automaticRenewal ? '' : 'none';
      }
      if (cancel) cancel.style.display = scheduled ? '' : 'none';
      if (acknowledge) acknowledge.style.display = replacementPending && !scheduled ? '' : 'none';
      if (actions) {
        const hasActions = scheduled || replacementPending
          || (renewalRequired && !automaticRenewal);
        actions.style.display = hasActions ? 'flex' : 'none';
      }
    }

    async function loadConfig() {
      const portConfigPromise = loadPortConfig();
      try {
        const res = await fetch(`${API_BASE}/api/config`);
        const data = await res.json();
        if (data.config) {
          const fpEl = document.getElementById('settingsCaFingerprint');
          if (fpEl) fpEl.textContent = data.config.certificateFingerprint || '--';
          if (typeof renderCaRenewalState === 'function') renderCaRenewalState(data.config);
          const mpEl = document.getElementById('manualProxyPort');
          if (mpEl) mpEl.textContent = data.config.proxyPort;
        }
      } catch (e) {
        console.error('[Error]', e.message);
        toast('Error: ' + e.message, 'error');
      }
      await portConfigPromise;
    }

    let uiSettingsSaveGeneration = 0;

    async function parseUiSettingsResponse(response, requireSaveConfirmation = false) {
      let data;
      try {
        data = await response.json();
      } catch {
        throw new Error('UI settings response was not valid JSON');
      }
      if (!response.ok) {
        throw new Error(data?.error || `UI settings returned HTTP ${response.status}`);
      }
      if (requireSaveConfirmation && data?.success !== true) {
        throw new Error(data?.error || 'UI settings save was not confirmed');
      }
      if (typeof data?.hideTunnelRequests !== 'boolean' || typeof data?.filterSafeFonts !== 'boolean') {
        throw new Error('UI settings response was incomplete');
      }
      return data;
    }

    function synchronizeUiSettings(data) {
      hideTunnelRequests = data.hideTunnelRequests;
      filterSafeFonts = data.filterSafeFonts;
      const toggle = document.getElementById('hideTunnelRequestsToggle');
      if (toggle) toggle.checked = hideTunnelRequests;
      const fontsToggle = document.getElementById('filterSafeFontsToggle');
      if (fontsToggle) fontsToggle.checked = filterSafeFonts;
      applyFilter();
    }

    async function loadUiSettings() {
      const loadGeneration = uiSettingsSaveGeneration;
      try {
        const res = await fetch(API_BASE + '/api/ui-settings');
        const data = await parseUiSettingsResponse(res);
        if (loadGeneration === uiSettingsSaveGeneration) synchronizeUiSettings(data);
      } catch (e) {
        console.error('[Error]', e.message);
      }
    }

    async function saveUiSettingsChange(changes, previousSettings, saveGeneration) {
      try {
        const response = await fetch(API_BASE + '/api/ui-settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(changes)
        });
        const data = await parseUiSettingsResponse(response, true);
        if (saveGeneration !== uiSettingsSaveGeneration) return;
        synchronizeUiSettings(data);
        toast('Traffic display setting saved', 'success');
      } catch (err) {
        if (saveGeneration !== uiSettingsSaveGeneration) return;
        synchronizeUiSettings(previousSettings);
        toast('Error: ' + err.message, 'error');
      }
    }

    async function saveHideTunnelRequests(enabled) {
      const previousSettings = { hideTunnelRequests, filterSafeFonts };
      const saveGeneration = ++uiSettingsSaveGeneration;
      hideTunnelRequests = !!enabled;
      const toggle = document.getElementById('hideTunnelRequestsToggle');
      if (toggle) toggle.checked = hideTunnelRequests;
      applyFilter();
      await saveUiSettingsChange({ hideTunnelRequests }, previousSettings, saveGeneration);
    }

    async function saveFilterSafeFonts(enabled) {
      const previousSettings = { hideTunnelRequests, filterSafeFonts };
      const saveGeneration = ++uiSettingsSaveGeneration;
      filterSafeFonts = !!enabled;
      const toggle = document.getElementById('filterSafeFontsToggle');
      if (toggle) toggle.checked = filterSafeFonts;
      applyFilter();
      await saveUiSettingsChange({ filterSafeFonts }, previousSettings, saveGeneration);
    }

    // ============ ROW NAVIGATION ============
    function selectRequestByIndex(delta) {
      if (filteredRequests.length === 0) return;
      let currentIdx = selectedRequestId
        ? filteredRequests.findIndex(request => isSelectedTrafficRequest(request))
        : -1;
      let newIdx;
      if (delta === 'first') newIdx = 0;
      else if (delta === 'last') newIdx = filteredRequests.length - 1;
      else newIdx = Math.max(0, Math.min(filteredRequests.length - 1, currentIdx + delta));

      const req = filteredRequests[newIdx];
      selectedRequestId = req.id;
      selectedRequestLifecycleId = normalizeTrafficLifecycleId(req.trafficLifecycleId);
      if (window.location.hash.startsWith('#/view') || window.location.hash.startsWith('#/traffic')) {
        history.replaceState(null, '', buildTrafficViewHash(req.id, selectedRequestLifecycleId));
      }
      // Scroll the selected row into view
      scrollRowIntoView(newIdx);
      // Re-render to update selection
      vsForceRender = true;
      renderVirtualRows();
      showDetail(req);
    }

    // ============ WS FRAME EXPAND/COLLAPSE ============
    function toggleWsExpand(parentId, parentTrafficLifecycleId = '') {
      const parentKey = wsConnectionKey({
        id: parentId,
        trafficLifecycleId: parentTrafficLifecycleId
      });
      if (wsExpandedConnections.has(parentKey)) {
        wsExpandedConnections.delete(parentKey);
      } else {
        wsExpandedConnections.add(parentKey);
      }
      applyFilter();
    }

    // ============ SCROLL TO END ============
    function scrollToEnd() {
      const wrapper = document.getElementById('trafficTableWrapper');
      wrapper.scrollTop = wrapper.scrollHeight;
      autoScroll = true;
    }

    // ============ HAR IMPORT ============
    function normalizeHarBodySize(value) {
      return Number.isSafeInteger(value) && (value >= 0 || value === -1)
        ? value
        : 0;
    }

    function assertHarObject(value, fieldPath) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${fieldPath} must be an object`);
      }
      return value;
    }

    function normalizeHarString(value, fieldPath, options = {}) {
      if (value === undefined && options.optional) return options.defaultValue || '';
      if (typeof value !== 'string') throw new Error(`${fieldPath} must be a string`);
      if (!options.allowEmpty && value.length === 0) throw new Error(`${fieldPath} must not be empty`);
      return value;
    }

    function normalizeHarNonNegativeNumber(value, fieldPath, options = {}) {
      if (value === undefined && options.optional) return options.defaultValue || 0;
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${fieldPath} must be a finite number`);
      }
      if (value < 0) throw new Error(`${fieldPath} must be non-negative`);
      return value;
    }

    function normalizeHarSize(value, fieldPath) {
      if (value === undefined) return 0;
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${fieldPath} must be a finite number`);
      }
      if (!Number.isSafeInteger(value)) {
        throw new Error(`${fieldPath} must be a safe integer`);
      }
      if (value < 0 && value !== -1) {
        throw new Error(`${fieldPath} must be non-negative or -1 for an unknown size`);
      }
      return normalizeHarBodySize(value);
    }

    function normalizeHarTimestamp(value, fieldPath) {
      if (typeof value !== 'string') throw new Error(`${fieldPath} must be a date string`);
      const timestamp = new Date(value).getTime();
      if (!Number.isFinite(timestamp)) throw new Error(`${fieldPath} must be a valid date`);
      if (timestamp < 0) throw new Error(`${fieldPath} must be non-negative`);
      return timestamp;
    }

    function normalizeHarHeaders(headers, fieldPath) {
      if (!Array.isArray(headers)) throw new Error(`${fieldPath} must be an array`);
      const normalized = Object.create(null);
      headers.forEach((header, index) => {
        const headerPath = `${fieldPath}[${index}]`;
        assertHarObject(header, headerPath);
        const name = normalizeHarString(header.name, `${headerPath}.name`).toLowerCase();
        const value = normalizeHarString(header.value, `${headerPath}.value`, { allowEmpty: true });
        if (!Object.hasOwn(normalized, name)) {
          normalized[name] = value;
        } else if (Array.isArray(normalized[name])) {
          normalized[name].push(value);
        } else {
          normalized[name] = [normalized[name], value];
        }
      });
      return normalized;
    }

    function normalizeHarBody(body, fieldPath) {
      if (body === undefined) return { body: '', encoding: 'utf8' };
      assertHarObject(body, fieldPath);
      if (body.text === undefined) return { body: '', encoding: 'utf8' };
      const text = normalizeHarString(body.text, `${fieldPath}.text`, { allowEmpty: true });
      const encoding = normalizeHarString(body.encoding, `${fieldPath}.encoding`, {
        optional: true,
        allowEmpty: true
      });
      if (encoding.toLowerCase() !== 'base64') return { body: text, encoding: 'utf8' };
      const mimeType = normalizeHarString(body.mimeType, `${fieldPath}.mimeType`, {
        optional: true,
        allowEmpty: true,
        defaultValue: 'application/octet-stream'
      }).replace(/[\r\n,]/g, '') || 'application/octet-stream';
      return {
        body: `data:${mimeType};base64,${text.replace(/\s+/g, '')}`,
        encoding: 'base64'
      };
    }

    function normalizeHarTruncation(body, fieldPath) {
      if (body === undefined || !Object.hasOwn(body, '_truncated')) return null;
      if (typeof body._truncated !== 'boolean') {
        throw new Error(`${fieldPath}._truncated must be a boolean`);
      }
      if (!body._truncated) return null;

      const capturedSize = body._capturedSize;
      if (!Number.isSafeInteger(capturedSize) || capturedSize < 0) {
        throw new Error(`${fieldPath}._capturedSize must be a non-negative safe integer`);
      }
      const originalSize = body._originalSize;
      if (!Number.isSafeInteger(originalSize) || originalSize < -1) {
        throw new Error(
          `${fieldPath}._originalSize must be a non-negative safe integer or -1`
        );
      }
      if (originalSize >= 0 && capturedSize > originalSize) {
        throw new Error(`${fieldPath}._capturedSize cannot exceed _originalSize`);
      }
      return {
        capturedSize,
        originalSize
      };
    }

    function normalizeHarEntry(entry, index) {
      const entryPath = `log.entries[${index}]`;
      assertHarObject(entry, entryPath);
      const request = assertHarObject(entry.request, `${entryPath}.request`);
      const response = assertHarObject(entry.response, `${entryPath}.response`);
      const method = normalizeHarString(request.method, `${entryPath}.request.method`);
      const url = normalizeHarString(request.url, `${entryPath}.request.url`);
      let parsedUrl;
      try {
        parsedUrl = new URL(url);
      } catch {
        throw new Error(`${entryPath}.request.url must be a valid absolute URL`);
      }
      const requestHttpVersion = normalizeHarString(
        request.httpVersion,
        `${entryPath}.request.httpVersion`,
        { optional: true, allowEmpty: true }
      );
      const status = response.status;
      if (!Number.isInteger(status) || (status !== 0 && (status < 100 || status > 999))) {
        throw new Error(`${entryPath}.response.status must be 0 or an integer from 100 to 999`);
      }
      const content = response.content === undefined
        ? undefined
        : assertHarObject(response.content, `${entryPath}.response.content`);
      const requestBodySize = normalizeHarSize(
        request.bodySize,
        `${entryPath}.request.bodySize`
      );
      const responseBodySize = normalizeHarSize(
        response.bodySize,
        `${entryPath}.response.bodySize`
      );
      const timestamp = normalizeHarTimestamp(entry.startedDateTime, `${entryPath}.startedDateTime`);
      const duration = normalizeHarNonNegativeNumber(entry.time, `${entryPath}.time`, { optional: true });
      const requestPostData = request.postData === undefined
        ? undefined
        : assertHarObject(request.postData, `${entryPath}.request.postData`);
      const statusMessage = normalizeHarString(response.statusText, `${entryPath}.response.statusText`, {
        optional: true,
        allowEmpty: true
      });
      const responseHttpVersion = normalizeHarString(
        response.httpVersion,
        `${entryPath}.response.httpVersion`,
        { optional: true, allowEmpty: true }
      );
      const requestPostDataMimeType = requestPostData === undefined
        ? ''
        : normalizeHarString(requestPostData.mimeType, `${entryPath}.request.postData.mimeType`, {
            optional: true,
            allowEmpty: true
          });
      const responseContentMimeType = content === undefined
        ? ''
        : normalizeHarString(content.mimeType, `${entryPath}.response.content.mimeType`, {
            optional: true,
            allowEmpty: true
          });
      const normalizedRequestBody = normalizeHarBody(
        requestPostData,
        `${entryPath}.request.postData`
      );
      const normalizedResponseBody = normalizeHarBody(
        content,
        `${entryPath}.response.content`
      );
      const requestTruncation = normalizeHarTruncation(
        requestPostData,
        `${entryPath}.request.postData`
      );
      const responseTruncation = normalizeHarTruncation(
        content,
        `${entryPath}.response.content`
      );
      const responseBodyDecodedSize = responseTruncation?.originalSize
        ?? (content?.size === undefined
          ? undefined
          : normalizeHarSize(content.size, `${entryPath}.response.content.size`));

      return {
        id: crypto.randomUUID(),
        protocol: /^HTTP\/2(?:\.\d+)?$/i.test(requestHttpVersion)
          ? 'h2'
          : parsedUrl.protocol.toLowerCase() === 'https:' ? 'https' : 'http',
        method,
        url,
        host: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        requestHeaders: normalizeHarHeaders(request.headers, `${entryPath}.request.headers`),
        requestBody: normalizedRequestBody.body,
        requestBodyEncoding: normalizedRequestBody.encoding,
        requestCookies: Array.isArray(request.cookies) ? request.cookies : [],
        requestPostDataParams: Array.isArray(requestPostData?.params) ? requestPostData.params : undefined,
        requestPostDataMimeType,
        requestHttpVersion,
        requestBodySize,
        ...(requestTruncation ? {
          requestBodyTruncated: true,
          requestBodyCapturedSize: requestTruncation.capturedSize,
          requestBodyDecodedSize: requestTruncation.originalSize
        } : {}),
        statusCode: status,
        statusMessage,
        responseHeaders: normalizeHarHeaders(response.headers, `${entryPath}.response.headers`),
        responseBody: normalizedResponseBody.body,
        responseBodyEncoding: normalizedResponseBody.encoding,
        responseCookies: Array.isArray(response.cookies) ? response.cookies : [],
        responseContentMimeType,
        responseHttpVersion,
        responseBodySize,
        ...(responseBodyDecodedSize === undefined ? {} : { responseBodyDecodedSize }),
        ...(responseTruncation ? {
          responseBodyTruncated: true,
          responseBodyCapturedSize: responseTruncation.capturedSize
        } : {}),
        duration,
        timestamp,
        source: 'import'
      };
    }

    function normalizeHarEntries(har) {
      assertHarObject(har, 'HAR root');
      const log = assertHarObject(har.log, 'log');
      if (!Array.isArray(log.entries)) throw new Error('log.entries must be an array');
      return log.entries.map((entry, index) => normalizeHarEntry(entry, index));
    }

    function importHar() {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.har,application/har,application/har+json';
      input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
          const text = await file.text();
          const har = JSON.parse(text);
          const imported = normalizeHarEntries(har);
          const response = await fetch(API_BASE + '/api/traffic/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ requests: imported })
          });
          const result = await response.json().catch(() => ({}));
          if (!response.ok || result.success !== true) {
            throw new Error(result.error || `Traffic import returned HTTP ${response.status}`);
          }
        } catch (err) {
          toast('Failed to import HAR: ' + err.message, 'error');
        }
      };
      input.click();
    }

    // ============ ACTIONS ============
    let trafficClearInFlight = false;

    async function clearTraffic() {
      if (trafficClearInFlight) return;
      trafficClearInFlight = true;
      try {
        const response = await fetch(API_BASE + '/api/traffic/clear', { method: 'POST' });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.success !== true || typeof data.clearId !== 'string' ||
            !Array.isArray(data.retainedTraffic)) {
          throw new Error(data.error || `Clear Traffic returned HTTP ${response.status}`);
        }
        applyTrafficCleared(
          data.clearId,
          data.retainedTraffic,
          data.revision,
          data.pinRevision
        );
        toast('Traffic cleared', 'success');
      } catch (err) {
        toast('Failed to clear traffic: ' + err.message, 'error');
      } finally {
        trafficClearInFlight = false;
      }
    }

    async function exportTraffic(format = 'json') {
      try {
        if (format === 'har') {
          // Download HAR from server (proper HAR 1.2 format)
          const a = document.createElement('a');
          a.href = authenticatedApiUrl(`${API_BASE}/api/traffic/export.har`);
          a.download = `http-freekit-${new Date().toISOString().slice(0,10)}.har`;
          a.click();
          toast('HAR download started', 'success');
        } else {
          const blob = new Blob([JSON.stringify({
            exported: new Date().toISOString(),
            tool: 'HTTP FreeKit',
            version: '1.0.0',
            requests
          }, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `http-freekit-${new Date().toISOString().slice(0,10)}.json`;
          a.click();
          URL.revokeObjectURL(url);
          toast('JSON exported', 'success');
        }
      } catch (err) {
        toast(`Export failed: ${err.message}`, 'error');
      }
    }

    async function exportHarToGenerator() {
      try {
        const res = await fetch(`${API_BASE}/api/traffic/export-generator`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.success === false) {
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        toast(`Opened ${data.requestCount || 0} requests in Generator`, 'success');
      } catch (err) {
        toast(`Generator export failed: ${err.message}`, 'error');
      }
    }

    // ============ UPSTREAM PROXY ============
    function setSettingsStatus(statusEl, message, color) {
      if (!statusEl) return;
      const span = document.createElement('span');
      span.style.color = color;
      span.textContent = message;
      statusEl.replaceChildren(span);
    }

    function updateUpstreamFields() {
      const type = document.getElementById('upstreamType').value;
      const fields = document.getElementById('upstreamDetailsFields');
      const label = document.getElementById('upstreamDetailsLabel');
      const input = document.getElementById('upstreamDetails');

      if (type === 'none') {
        fields.style.display = 'none';
        // Auto-save when selecting a direct connection.
        saveUpstreamProxy();
      } else {
        fields.style.display = 'block';
        const placeholders = {
          http: 'The HTTP proxy details, e.g. proxy.example.com:8080 or user:pwd@proxy:8080',
          https: 'The HTTPS proxy details, e.g. proxy.example.com:443',
          socks4: 'The SOCKS4 proxy details, e.g. proxy.example.com:1080',
          socks4a: 'The SOCKS4a proxy details, e.g. proxy.example.com:1080',
          socks5: 'The SOCKS5 proxy details, e.g. user:pwd@proxy.example.com:1080',
          socks5h: 'The SOCKS5h proxy details, e.g. user:pwd@proxy.example.com:1080',
        };
        label.textContent = type.toUpperCase() + ' proxy details';
        input.placeholder = placeholders[type] || 'hostname:port';
      }
    }

    async function saveUpstreamProxy() {
      const type = document.getElementById('upstreamType').value;
      const statusEl = document.getElementById('upstreamStatus');

      if (type === 'none') {
        // Disable upstream proxy
        try {
          const res = await fetch(API_BASE + '/api/upstream-proxy', { method: 'DELETE' });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.success === false) {
            throw new Error(data.error || `HTTP ${res.status}`);
          }
          updateUpstreamProxyUi(null);
          toast('Upstream proxy disabled', 'success');
        } catch (err) {
          toast('Error: ' + err.message, 'error');
          await loadUpstreamProxy();
        }
        return;
      }

      const details = document.getElementById('upstreamDetails').value.trim();
      const noProxy = document.getElementById('upstreamNoProxy').value
        .split(',')
        .map(hostname => hostname.trim())
        .filter(Boolean);
      if (!details) { toast('Enter proxy details first', 'error'); return; }

      // Parse host:port and optional auth from the details string
      let host, port, auth;
      const atIdx = details.lastIndexOf('@');
      let hostPort = details;
      if (atIdx > 0) {
        auth = details.substring(0, atIdx);
        hostPort = details.substring(atIdx + 1);
      }
      const colonIdx = hostPort.lastIndexOf(':');
      if (colonIdx > 0) {
        host = hostPort.substring(0, colonIdx);
        port = parseInt(hostPort.substring(colonIdx + 1));
      } else {
        host = hostPort;
        port = type === 'https' ? 443 : type.startsWith('socks') ? 1080 : 8080;
      }

      try {
        const res = await fetch(API_BASE + '/api/upstream-proxy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ host, port, auth: auth || null, type, noProxy })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        setSettingsStatus(statusEl, `Active: ${type.toUpperCase()} proxy at ${host}:${port}`, 'var(--status-2xx)');
        toast('Upstream proxy configured', 'success');
      } catch (err) { toast('Error: ' + err.message, 'error'); }
    }

    function updateUpstreamProxyUi(proxy, provider) {
      const typeEl = document.getElementById('upstreamType');
      const fieldsEl = document.getElementById('upstreamDetailsFields');
      const detailsEl = document.getElementById('upstreamDetails');
      const noProxyEl = document.getElementById('upstreamNoProxy');
      const statusEl = document.getElementById('upstreamStatus');

      if (!proxy) {
        if (typeEl) typeEl.value = 'none';
        if (fieldsEl) fieldsEl.style.display = 'none';
        if (detailsEl) detailsEl.value = '';
        if (noProxyEl) noProxyEl.value = '';
        setSettingsStatus(statusEl, 'Direct connection (no upstream proxy)', 'var(--status-2xx)');
        return;
      }

      if (typeEl) typeEl.value = proxy.type || 'http';
      updateUpstreamFields();

      if (detailsEl) {
        let details = proxy.host + ':' + proxy.port;
        if (proxy.auth) details = proxy.auth + '@' + details;
        detailsEl.value = details;
      }

      if (statusEl) {
        const providerText = provider ? ' from ' + provider : '';
        setSettingsStatus(
          statusEl,
          `Active: ${(proxy.type || 'HTTP').toUpperCase()} proxy at ${proxy.host}:${proxy.port}${providerText}`,
          'var(--status-2xx)'
        );
      }
      if (noProxyEl) noProxyEl.value = (proxy.noProxy || []).join(', ');
    }

    async function loadBottingToolsProxyProviders() {
      const listEl = document.getElementById('bottingToolsProviders');
      if (!listEl) return;

      try {
        const res = await fetch(API_BASE + '/api/bottingtools/proxy-providers');
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        listEl.innerHTML = '';
        (data.providers || []).forEach(provider => {
          const option = document.createElement('option');
          option.value = provider;
          listEl.appendChild(option);
        });
      } catch (err) {
        console.warn('[BottingTools]', err.message);
      }
    }

    async function rotateBottingToolsProxy() {
      const providerEl = document.getElementById('bottingToolsProvider');
      const buttonEl = document.getElementById('bottingToolsRotateBtn');
      const provider = (providerEl?.value || 'lemonprime').trim() || 'lemonprime';

      if (buttonEl) {
        buttonEl.disabled = true;
        buttonEl.textContent = 'Rotating...';
      }

      try {
        const res = await fetch(API_BASE + '/api/bottingtools/rotate-proxy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider, refill: true })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        updateUpstreamProxyUi(data.upstreamProxy, data.provider);
        toast('BottingTools proxy rotated', 'success');
      } catch (err) {
        toast('BottingTools: ' + err.message, 'error');
      } finally {
        if (buttonEl) {
          buttonEl.disabled = false;
          buttonEl.textContent = 'Rotate with BottingTools';
        }
      }
    }

    async function loadAutoRotateProxyOnError() {
      try {
        const res = await fetch(API_BASE + '/api/bottingtools/auto-rotate-proxy');
        const data = await res.json();
        const checkbox = document.getElementById('autoRotateProxyOnError');
        const providerEl = document.getElementById('bottingToolsProvider');
        if (checkbox) checkbox.checked = !!data.enabled;
        if (providerEl && data.provider) providerEl.value = data.provider;
      } catch (err) {
        console.warn('[BottingTools auto-rotate]', err.message);
      }
    }

    async function saveAutoRotateProxyOnError(showToast = true) {
      const checkbox = document.getElementById('autoRotateProxyOnError');
      const providerEl = document.getElementById('bottingToolsProvider');
      const enabled = !!checkbox?.checked;
      const provider = (providerEl?.value || 'lemonprime').trim() || 'lemonprime';

      try {
        const res = await fetch(API_BASE + '/api/bottingtools/auto-rotate-proxy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled, provider })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        if (showToast) {
          toast(enabled ? 'Auto proxy rotation enabled' : 'Auto proxy rotation disabled', 'success');
        }
      } catch (err) {
        if (showToast) toast('Auto rotate setting failed: ' + err.message, 'error');
      }
    }

    function handleProxyAutoRotateEvent(msg) {
      if (msg.status === 'started') {
        toast((msg.reason || 'Proxy error') + ' detected; rotating BottingTools proxy...', 'success');
        return;
      }
      if (msg.status === 'success') {
        if (msg.upstreamProxy) updateUpstreamProxyUi(msg.upstreamProxy, msg.provider);
        toast('BottingTools proxy auto-rotated', 'success');
        return;
      }
      if (msg.status === 'cancelled') {
        if (Object.hasOwn(msg, 'upstreamProxy')) {
          updateUpstreamProxyUi(msg.upstreamProxy);
        }
        toast('Auto proxy rotation cancelled; current proxy settings retained', 'info');
        return;
      }
      if (msg.status === 'error') {
        toast('Auto proxy rotation failed: ' + (msg.error || 'unknown error'), 'error');
      }
    }

    async function loadUpstreamProxy() {
      try {
        const res = await fetch(API_BASE + '/api/upstream-proxy');
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        if (!Object.hasOwn(data, 'upstreamProxy')) {
          throw new Error('Upstream proxy response was incomplete');
        }
        updateUpstreamProxyUi(data.upstreamProxy);
      } catch (e) {
        console.error('[Error]', e.message);
        toast('Error: ' + e.message, 'error');
      }
    }

    // ============ PORT CONFIG ============
    let portConfigLoadGeneration = 0;
    let portConfigSaveGeneration = 0;
    let portConfigSavesInFlight = 0;

    async function parsePortConfigResponse(response, requireSaveConfirmation = false) {
      let data;
      try {
        data = await response.json();
      } catch {
        throw new Error('Port configuration response was not valid JSON');
      }
      if (!response.ok) {
        throw new Error(data?.error || `Port configuration returned HTTP ${response.status}`);
      }
      if (requireSaveConfirmation && data?.success !== true) {
        throw new Error(data?.error || 'Port configuration save was not confirmed');
      }
      const minPort = Number(data?.minPort);
      const maxPort = Number(data?.maxPort);
      if (!Number.isInteger(minPort) || !Number.isInteger(maxPort) ||
          minPort < 1 || maxPort > 65535 || minPort > maxPort) {
        throw new Error('Port configuration response was incomplete');
      }
      return { minPort, maxPort };
    }

    async function loadPortConfig() {
      if (portConfigSavesInFlight > 0) return;
      const loadGeneration = ++portConfigLoadGeneration;
      const saveGeneration = portConfigSaveGeneration;
      const minEl = document.getElementById('settingsMinPort');
      const maxEl = document.getElementById('settingsMaxPort');
      const initialMin = minEl?.value;
      const initialMax = maxEl?.value;
      try {
        const response = await fetch(API_BASE + '/api/port-config');
        const range = await parsePortConfigResponse(response);
        if (loadGeneration !== portConfigLoadGeneration || saveGeneration !== portConfigSaveGeneration) return;

        const currentMinEl = document.getElementById('settingsMinPort');
        const currentMaxEl = document.getElementById('settingsMaxPort');
        if (!currentMinEl || !currentMaxEl ||
            currentMinEl.value !== initialMin || currentMaxEl.value !== initialMax) return;
        currentMinEl.value = String(range.minPort);
        currentMaxEl.value = String(range.maxPort);
      } catch (err) {
        if (loadGeneration !== portConfigLoadGeneration || saveGeneration !== portConfigSaveGeneration) return;
        console.error('[Error]', err.message);
        toast('Error: ' + err.message, 'error');
      }
    }

    async function savePortConfig() {
      const minEl = document.getElementById('settingsMinPort');
      const maxEl = document.getElementById('settingsMaxPort');
      if (!minEl || !maxEl) return;
      const min = minEl.value;
      const max = maxEl.value;
      const saveGeneration = ++portConfigSaveGeneration;
      portConfigSavesInFlight++;
      portConfigLoadGeneration++;
      try {
        const response = await fetch(API_BASE + '/api/port-config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ minPort: min, maxPort: max })
        });
        const range = await parsePortConfigResponse(response, true);
        if (saveGeneration !== portConfigSaveGeneration) return;
        if (minEl.value === min && maxEl.value === max) {
          minEl.value = String(range.minPort);
          maxEl.value = String(range.maxPort);
        }
        toast('Port range saved (takes effect on restart)', 'success');
      } catch (err) {
        if (saveGeneration !== portConfigSaveGeneration) return;
        toast('Error: ' + err.message, 'error');
      } finally {
        portConfigSavesInFlight--;
      }
    }

    // ============ TLS PASSTHROUGH ============
    async function loadTlsPassthrough() {
      try {
        const res = await fetch(API_BASE + '/api/tls-passthrough');
        const data = await res.json();
        renderTlsPassthrough(data.hosts || []);
      } catch (e) {
        console.error('[Error]', e.message);
        toast('Error: ' + e.message, 'error');
      }
    }

    let renderedTlsPassthroughHosts = [];

    function renderTlsPassthrough(hosts) {
      renderedTlsPassthroughHosts = [...hosts];
      const list = document.getElementById('tlsPassthroughList');
      if (!list) return;
      if (hosts.length === 0) {
        list.innerHTML = '<div style="font-size:12px;color:var(--text-watermark);padding:4px 0;">No passthrough hosts configured</div>';
        return;
      }
      list.innerHTML = hosts.map((h, i) =>
        `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--border-color);">
          <span style="font-family:var(--font-mono);font-size:12px;flex:1;">${esc(h)}</span>
          <button class="btn btn-danger" onclick="removeTlsPassthrough(${i})" style="padding:2px 6px;font-size:10px;">&times;</button>
        </div>`
      ).join('');
    }

    async function addTlsPassthrough() {
      const input = document.getElementById('tlsPassthroughInput');
      const host = input.value.trim();
      if (!host) return;
      try {
        const response = await fetch(API_BASE + '/api/tls-passthrough/items', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ host })
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Could not add host');
        input.value = '';
        loadTlsPassthrough();
        toast('Added ' + host, 'success');
      } catch (err) { toast('Error: ' + err.message, 'error'); }
    }

    async function removeTlsPassthrough(index) {
      const host = renderedTlsPassthroughHosts[index];
      if (host === undefined) return;
      try {
        const response = await fetch(API_BASE + '/api/tls-passthrough/items', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ host })
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Could not remove host');
        loadTlsPassthrough();
        toast('Removed', 'success');
      } catch (err) { toast('Error: ' + err.message, 'error'); }
    }

    // ============ HTTP/2 CONFIG ============
    async function loadHttp2Config() {
      try {
        const res = await fetch(API_BASE + '/api/http2');
        const data = await res.json();
        const sel = document.getElementById('http2Mode');
        if (sel) sel.value = data.mode || 'all';
      } catch (e) {
        console.error('[Error]', e.message);
        toast('Error: ' + e.message, 'error');
      }
    }

    async function saveHttp2Config() {
      const mode = document.getElementById('http2Mode')?.value || 'all';
      try {
        await fetch(API_BASE + '/api/http2', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode })
        });
        toast('HTTP/2 setting saved', 'success');
      } catch (err) { toast('Error: ' + err.message, 'error'); }
    }

    // ============ TLS FINGERPRINT ============
    async function loadTlsFingerprint() {
      try {
        const res = await fetch(API_BASE + '/api/tls-fingerprint');
        const data = await res.json();
        const sel = document.getElementById('tlsFingerprint');
        if (sel) sel.value = data.fingerprint || 'chrome-136';
      } catch (e) {
        console.error('[Error]', e.message);
      }
    }

    async function saveTlsFingerprint() {
      const fingerprint = document.getElementById('tlsFingerprint')?.value || 'chrome-136';
      try {
        await fetch(API_BASE + '/api/tls-fingerprint', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fingerprint })
        });
        toast('TLS fingerprint saved: ' + fingerprint, 'success');
      } catch (err) { toast('Error: ' + err.message, 'error'); }
    }

    // ============ CLIENT CERTIFICATES ============
    async function loadClientCerts() {
      try {
        const res = await fetch(API_BASE + '/api/client-certificates');
        const data = await res.json();
        renderClientCerts(data.certificates || []);
      } catch (e) {
        console.error('[Error]', e.message);
        toast('Error: ' + e.message, 'error');
      }
    }

    let renderedClientCertificates = [];

    function renderClientCerts(certs) {
      renderedClientCertificates = certs.map(cert => ({ ...cert }));
      const el = document.getElementById('clientCertList');
      if (!el) return;
      if (!certs.length) {
        el.innerHTML = '<div style="font-size:12px;color:var(--text-watermark);padding:4px 0;">No client certificates configured</div>';
        return;
      }
      el.innerHTML = certs.map((c, i) =>
        `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--border-color);">
          <span style="font-family:var(--font-mono);font-size:12px;flex:1;">${esc(c.host)} &rarr; ${esc(c.pfxPath)}</span>
          <button class="btn btn-danger" onclick="removeClientCert(${i})" style="padding:2px 6px;font-size:10px;">&times;</button>
        </div>`
      ).join('');
    }

    async function selectCertificatePath(targetId, title, extensions) {
      const pathInput = document.getElementById(targetId);
      if (!pathInput) return;

      if (window.electronApi?.selectFilePath) {
        try {
          const selectedPath = await window.electronApi.selectFilePath({
            title,
            filters: [{ name: 'Certificate files', extensions }]
          });
          if (selectedPath) pathInput.value = selectedPath;
        } catch (err) {
          toast('Could not select certificate: ' + err.message, 'error');
        }
        return;
      }

      const input = document.createElement('input');
      input.type = 'file';
      input.accept = extensions.map(ext => '.' + ext).join(',');
      input.onchange = (event) => {
        const file = event.target.files[0];
        if (file) pathInput.value = file.path || file.name;
      };
      input.click();
    }

    function browseClientCert() {
      return selectCertificatePath(
        'clientCertPath',
        'Select client certificate',
        ['pfx', 'p12', 'pem', 'crt', 'cert']
      );
    }

    function browseTrustedCA() {
      return selectCertificatePath(
        'trustedCAPath',
        'Select trusted CA certificate',
        ['pem', 'crt', 'cert', 'der']
      );
    }

    async function addClientCert() {
      const host = document.getElementById('clientCertHost')?.value?.trim();
      const path = document.getElementById('clientCertPath')?.value?.trim();
      const passphraseInput = document.getElementById('clientCertPassphrase');
      const passphrase = passphraseInput?.value ?? '';
      if (!host || !path) { toast('Both host and path required', 'error'); return; }
      try {
        const response = await fetch(API_BASE + '/api/client-certificates/items', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            host,
            pfxPath: path,
            ...(passphrase === '' ? {} : { passphrase })
          })
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Could not add certificate');
        document.getElementById('clientCertHost').value = '';
        document.getElementById('clientCertPath').value = '';
        if (passphraseInput) passphraseInput.value = '';
        loadClientCerts();
        toast('Client certificate added', 'success');
      } catch (err) { toast('Error: ' + err.message, 'error'); }
    }

    async function removeClientCert(idx) {
      const certificate = renderedClientCertificates[idx];
      if (!certificate) return;
      try {
        const response = await fetch(API_BASE + '/api/client-certificates/items', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(certificate)
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Could not remove certificate');
        loadClientCerts();
        toast('Removed', 'success');
      } catch (err) { toast('Error: ' + err.message, 'error'); }
    }

    // ============ TRUSTED CAs ============
    async function loadTrustedCAs() {
      try {
        const res = await fetch(API_BASE + '/api/trusted-cas');
        const data = await res.json();
        renderTrustedCAs(data.cas || []);
      } catch (e) {
        console.error('[Error]', e.message);
        toast('Error: ' + e.message, 'error');
      }
    }

    let renderedTrustedCAs = [];

    function renderTrustedCAs(cas) {
      renderedTrustedCAs = [...cas];
      const el = document.getElementById('trustedCAList');
      if (!el) return;
      if (!cas.length) {
        el.innerHTML = '<div style="font-size:12px;color:var(--text-watermark);padding:4px 0;">No additional CA certificates configured</div>';
        return;
      }
      el.innerHTML = cas.map((c, i) =>
        `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--border-color);">
          <span style="font-family:var(--font-mono);font-size:12px;flex:1;">${esc(c)}</span>
          <button class="btn btn-danger" onclick="removeTrustedCA(${i})" style="padding:2px 6px;font-size:10px;">&times;</button>
        </div>`
      ).join('');
    }

    async function addTrustedCA() {
      const input = document.getElementById('trustedCAPath');
      const path = input?.value?.trim();
      if (!path) { toast('Path required', 'error'); return; }
      try {
        const response = await fetch(API_BASE + '/api/trusted-cas/items', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ca: path })
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Could not add CA');
        input.value = '';
        loadTrustedCAs();
        toast('Trusted CA added', 'success');
      } catch (err) { toast('Error: ' + err.message, 'error'); }
    }

    async function removeTrustedCA(idx) {
      const ca = renderedTrustedCAs[idx];
      if (ca === undefined) return;
      try {
        const response = await fetch(API_BASE + '/api/trusted-cas/items', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ca })
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Could not remove CA');
        loadTrustedCAs();
        toast('Removed', 'success');
      } catch (err) { toast('Error: ' + err.message, 'error'); }
    }

    // ============ HTTPS WHITELIST ============
    async function loadHttpsWhitelist() {
      try {
        const res = await fetch(API_BASE + '/api/https-whitelist');
        const data = await res.json();
        renderHttpsWhitelist(data.hosts || []);
      } catch (e) {
        console.error('[Error]', e.message);
        toast('Error: ' + e.message, 'error');
      }
    }

    let renderedHttpsWhitelistHosts = [];

    function renderHttpsWhitelist(hosts) {
      renderedHttpsWhitelistHosts = [...hosts];
      const el = document.getElementById('httpsWhitelistList');
      if (!el) return;
      if (!hosts.length) {
        el.innerHTML = '<div style="font-size:12px;color:var(--text-watermark);padding:4px 0;">No whitelisted hosts configured</div>';
        return;
      }
      el.innerHTML = hosts.map((h, i) =>
        `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--border-color);">
          <span style="font-family:var(--font-mono);font-size:12px;flex:1;">${esc(h)}</span>
          <button class="btn btn-danger" onclick="removeHttpsWhitelist(${i})" style="padding:2px 6px;font-size:10px;">&times;</button>
        </div>`
      ).join('');
    }

    async function addHttpsWhitelist() {
      const input = document.getElementById('httpsWhitelistHost');
      const host = input?.value?.trim();
      if (!host) { toast('Hostname required', 'error'); return; }
      try {
        const response = await fetch(API_BASE + '/api/https-whitelist/items', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ host })
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Could not add host');
        input.value = '';
        loadHttpsWhitelist();
        toast('Host added to whitelist', 'success');
      } catch (err) { toast('Error: ' + err.message, 'error'); }
    }

    async function removeHttpsWhitelist(idx) {
      const host = renderedHttpsWhitelistHosts[idx];
      if (host === undefined) return;
      try {
        const response = await fetch(API_BASE + '/api/https-whitelist/items', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ host })
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Could not remove host');
        loadHttpsWhitelist();
        toast('Removed', 'success');
      } catch (err) { toast('Error: ' + err.message, 'error'); }
    }

    // ============ MCP SERVER ============
    let mcpAuthoritativeEnabled = null;
    let mcpToggleInFlight = null;

    async function loadMcpStatus() {
      try {
        const res = await fetch(API_BASE + '/api/mcp/status');
        const data = await res.json();
        if (typeof data.enabled !== 'boolean') throw new Error('MCP status returned an invalid response');
        mcpAuthoritativeEnabled = data.enabled;
        const statusEl = document.getElementById('mcpStatus');
        if (statusEl) {
          statusEl.textContent = data.degraded ? 'Degraded' : (data.enabled ? 'Running' : 'Stopped');
          statusEl.style.color = data.degraded
            ? '#d99a3e'
            : (data.enabled ? '#4caf7d' : 'var(--text-lowlight)');
          statusEl.title = data.degraded ? (data.degradedReason || 'MCP cleanup is incomplete') : '';
        }
        const endpointEl = document.getElementById('mcpSseEndpoint');
        if (endpointEl) endpointEl.textContent = data.sseEndpoint || '--';
        const clientEl = document.getElementById('mcpClientCount');
        if (clientEl) clientEl.textContent = data.connectedClients || 0;
        const toggleEl = document.getElementById('mcpEnabledToggle');
        if (toggleEl) toggleEl.checked = data.enabled;
        const configEl = document.getElementById('mcpClaudeConfig');
        if (configEl) {
          configEl.textContent = data.claudeDesktopConfig
            ? JSON.stringify({ mcpServers: { 'http-freekit': data.claudeDesktopConfig } }, null, 2)
            : 'Launch configuration is unavailable in this runtime.';
        }
      } catch (e) {
        console.error('[Error]', e.message);
        toast('Error: ' + e.message, 'error');
      }
    }

    async function toggleMcp(enabled) {
      const toggleEl = document.getElementById('mcpEnabledToggle');
      if (mcpToggleInFlight) {
        if (toggleEl) {
          toggleEl.checked = mcpToggleInFlight.enabled;
          toggleEl.disabled = true;
        }
        return;
      }

      const requestedEnabled = enabled === true;
      const previousEnabled = typeof mcpAuthoritativeEnabled === 'boolean'
        ? mcpAuthoritativeEnabled
        : !requestedEnabled;
      mcpToggleInFlight = { enabled: requestedEnabled };
      if (toggleEl) {
        toggleEl.checked = requestedEnabled;
        toggleEl.disabled = true;
      }

      let degradedFailureStatus = null;
      try {
        const response = await fetch(API_BASE + '/api/mcp/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: requestedEnabled })
        });
        const data = await response.json().catch(() => null);
        if (!response.ok || data?.success !== true || data.enabled !== requestedEnabled) {
          if (data?.degraded === true && typeof data.enabled === 'boolean') {
            degradedFailureStatus = data;
          }
          throw new Error(data?.error || 'MCP toggle returned an invalid response');
        }
        mcpAuthoritativeEnabled = data.enabled;
        if (toggleEl) toggleEl.checked = data.enabled;
        toast(requestedEnabled ? 'MCP server enabled' : 'MCP server disabled', 'success');
        await loadMcpStatus();
      } catch (err) {
        const authoritativeEnabled = degradedFailureStatus?.enabled ?? previousEnabled;
        mcpAuthoritativeEnabled = authoritativeEnabled;
        if (toggleEl) toggleEl.checked = authoritativeEnabled;
        toast('Error: ' + err.message, 'error');
        if (degradedFailureStatus) await loadMcpStatus();
      } finally {
        mcpToggleInFlight = null;
        if (toggleEl) toggleEl.disabled = false;
      }
    }

    // ============ API SPECS ============
    async function loadApiSpecs() {
      try {
        const res = await fetch(API_BASE + '/api/specs');
        const data = await res.json();
        renderApiSpecs(data.specs || []);
      } catch (e) {
        console.error('[Error]', e.message);
        toast('Error: ' + e.message, 'error');
      }
    }

    function renderApiSpecs(specs) {
      const el = document.getElementById('apiSpecsList');
      if (!el) return;
      if (!specs.length) {
        el.innerHTML = '<div style="font-size:12px;color:var(--text-watermark);padding:4px 0;">No API specs loaded</div>';
        return;
      }
      el.innerHTML = specs.map(s =>
        '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border-color);">' +
        '<span style="font-weight:600;font-size:13px;flex:1;">' + esc(s.title) + '</span>' +
        '<span style="font-family:var(--font-mono);font-size:11px;color:var(--text-lowlight);">' + esc(s.baseUrl || 'any host') + '</span>' +
        '<button class="btn btn-danger" onclick="removeApiSpec(\'' + s.id + '\')" style="padding:2px 6px;font-size:10px;">x</button>' +
        '</div>'
      ).join('');
    }

    async function readApiSpecUploadResponse(response) {
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(data?.error || 'API spec upload failed with HTTP ' + response.status);
      }
      if (!data || data.success !== true) {
        throw new Error(data?.error || 'API spec upload returned an invalid response');
      }
      return data;
    }

    function uploadApiSpec() {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,.yaml,.yml';
      input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
          const text = await file.text();
          let spec;
          try { spec = JSON.parse(text); } catch {
            toast('Please use JSON format for OpenAPI specs', 'error');
            return;
          }

          const title = spec.info?.title || file.name;
          const baseUrl = prompt('Base URL for this API (e.g. https://api.example.com):',
            spec.servers?.[0]?.url || spec.host || '');
          if (baseUrl === null) return;

          const response = await fetch(API_BASE + '/api/specs', {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ title, baseUrl, spec })
          });
          await readApiSpecUploadResponse(response);
          toast('API spec loaded: ' + title, 'success');
          loadApiSpecs();
        } catch (err) {
          toast('Failed to load spec: ' + err.message, 'error');
        }
      };
      input.click();
    }

    async function removeApiSpec(id) {
      try {
        const response = await fetch(
          API_BASE + '/api/specs/' + encodeURIComponent(String(id)),
          { method: 'DELETE' }
        );
        let result;
        try {
          result = await response.json();
        } catch {
          throw new Error(response.ok
            ? 'Server returned an invalid deletion response'
            : `API spec deletion returned HTTP ${response.status}`);
        }
        if (!response.ok) {
          throw new Error(result?.error || `API spec deletion returned HTTP ${response.status}`);
        }
        if (result?.success !== true) {
          throw new Error(result?.error || 'Server did not confirm API spec deletion');
        }
        await loadApiSpecs();
        toast('Spec removed', 'success');
      } catch (err) {
        toast('Failed to remove spec: ' + (err?.message || String(err)), 'error');
      }
    }

    function togglePause() {
      isPaused = !isPaused;
      const btn = document.getElementById('pauseBtn');
      if (!btn) return;
      if (isPaused) {
        btn.innerHTML = '<i class="ph ph-play" style="font-size:14px;"></i>';
        btn.title = 'Resume capture';
        btn.style.color = 'var(--warning-color)';
      } else {
        btn.innerHTML = '<i class="ph ph-pause" style="font-size:14px;"></i>';
        btn.title = 'Pause capture';
        btn.style.color = '';
      }
      // Re-render to update empty state if needed
      renderTraffic();
    }

    function downloadCert() {
      window.open(authenticatedApiUrl(`${API_BASE}/api/certificate`), '_blank');
    }

    async function updateCaRenewal(method, path, successMessage) {
      try {
        const response = await fetch(API_BASE + path, { method });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `CA renewal request failed (${response.status})`);
        toast(successMessage, 'success');
        await loadConfig();
      } catch (error) {
        toast(error.message, 'error');
      }
    }

    async function scheduleCaRenewal() {
      const confirmed = confirm(
        'Renew the CA on the next restart? Manually configured browsers, devices, and operating systems will reject intercepted HTTPS until they install the replacement certificate.'
      );
      if (!confirmed) return;
      await updateCaRenewal(
        'POST',
        '/api/certificate/renewal',
        'CA renewal scheduled for the next restart'
      );
    }

    async function cancelCaRenewal() {
      await updateCaRenewal(
        'DELETE',
        '/api/certificate/renewal',
        'Scheduled CA renewal cancelled'
      );
    }

    async function acknowledgeCaReplacement() {
      const confirmed = confirm(
        'Confirm that the current CA has been installed in your manually configured clients?'
      );
      if (!confirmed) return;
      await updateCaRenewal(
        'POST',
        '/api/certificate/replacement-acknowledgement',
        'CA trust migration acknowledged'
      );
    }

    // ============ SORTING ============
    function sortBy(field) {
      if (sortField === field) {
        if (sortDirection === 'desc') {
          sortDirection = 'asc';
        } else {
          sortField = null;
          sortDirection = 'desc';
        }
      } else {
        sortField = field;
        sortDirection = 'desc';
      }
      applyFilter();
    }

    function updateSortHeaders() {
      document.querySelectorAll('.traffic-table th.sortable').forEach(th => {
        const isActive = th.dataset.sortField === sortField;
        th.classList.toggle('sorted', isActive);
        th.classList.toggle('sorted-asc', isActive && sortDirection === 'asc');
        th.classList.toggle('sorted-desc', isActive && sortDirection === 'desc');
        th.setAttribute('aria-sort', isActive ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none');
      });
    }

    // ============ PANELS ============
    const SETTINGS_SECTION_TITLES = Object.freeze({
      general: 'General',
      traffic: 'Traffic',
      proxy: 'Proxy & Network',
      tls: 'TLS & Certificates',
      lists: 'Lists',
      schemas: 'Schemas',
      integrations: 'Integrations',
      about: 'About'
    });

    function switchSettingsSection(sectionId, updateHash = true) {
      const nextSection = Object.hasOwn(SETTINGS_SECTION_TITLES, sectionId) ? sectionId : 'general';

      document.querySelectorAll('[data-settings-nav]').forEach(item => {
        const isActive = item.dataset.settingsNav === nextSection;
        item.classList.toggle('is-active', isActive);
        if (isActive) item.setAttribute('aria-current', 'page');
        else item.removeAttribute('aria-current');
      });

      document.querySelectorAll('[data-settings-section]').forEach(card => {
        card.classList.toggle('is-active', card.dataset.settingsSection === nextSection);
      });

      const title = document.getElementById('settingsSectionTitle');
      if (title) title.textContent = SETTINGS_SECTION_TITLES[nextSection];

      safeLocalStorageSet('settingsActiveSection', nextSection);
      const panel = document.getElementById('panel-settings');
      if (panel) panel.scrollTop = 0;

      if (nextSection === 'tls') void loadConfig();

      if (updateHash) {
        window.location.hash = '#/settings/' + nextSection;
      }

      return nextSection;
    }

    // Map from hash routes to panel IDs (and vice versa)
    const HASH_TO_PANEL = {
      'intercept': 'intercept',
      'view': 'traffic',
      'mock': 'mock',
      'send': 'send',
      'settings': 'settings'
    };
    const PANEL_TO_HASH = {
      'intercept': 'intercept',
      'traffic': 'view',
      'mock': 'mock',
      'send': 'send',
      'settings': 'settings'
    };

    function handleTablistKeydown(event, previousKey, nextKey) {
      const currentTab = event.currentTarget;
      if (event.target !== currentTab) return;
      const tablist = currentTab.closest('[role="tablist"]');
      if (!tablist) return;
      const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));
      const currentIndex = tabs.indexOf(currentTab);
      if (currentIndex === -1) return;

      let targetTab = null;
      if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
        targetTab = currentTab;
      } else if (event.key === previousKey) {
        targetTab = tabs[(currentIndex - 1 + tabs.length) % tabs.length];
      } else if (event.key === nextKey) {
        targetTab = tabs[(currentIndex + 1) % tabs.length];
      } else if (event.key === 'Home') {
        targetTab = tabs[0];
      } else if (event.key === 'End') {
        targetTab = tabs[tabs.length - 1];
      }
      if (!targetTab) return;

      event.preventDefault();
      targetTab.click();
      const activeTab = tablist.querySelector('[role="tab"][aria-selected="true"]');
      (activeTab || targetTab).focus();
    }

    function handleSidebarTabKeydown(event) {
      handleTablistKeydown(event, 'ArrowUp', 'ArrowDown');
    }

    function handleSendTabKeydown(event) {
      handleTablistKeydown(event, 'ArrowLeft', 'ArrowRight');
    }

    function setActiveSidebarTab(el) {
      document.querySelectorAll('.sidebar-item').forEach(item => {
        item.classList.remove('active');
        item.setAttribute('aria-selected', 'false');
        item.tabIndex = -1;
      });
      el.classList.add('active');
      el.setAttribute('aria-selected', 'true');
      el.tabIndex = 0;
    }

    function switchPanel(el, panelId) {
      // Warn if leaving mock page with unsaved changes
      const currentPanel = document.querySelector('.sidebar-item.active')?.dataset?.panel;
      if (currentPanel === 'mock' && panelId !== 'mock' && hasUnsavedMockWork()) {
        if (!confirm('You have unsaved mock rule changes. Leave without saving?')) {
          return;
        }
      }
      // Save traffic scroll position when switching away from traffic panel
      if (currentPanel === 'traffic') {
        const wrapper = document.getElementById('trafficTableWrapper');
        if (wrapper) {
          safeLocalStorageSet('trafficScrollTop', String(wrapper.scrollTop));
          safeLocalStorageSet('trafficAutoScroll', String(autoScroll));
        }
      }

      setActiveSidebarTab(el);
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      document.getElementById(`panel-${panelId}`).classList.add('active');

      // Restore traffic scroll position when switching to traffic panel
      if (panelId === 'traffic') {
        restoreTrafficScrollPosition();
      }

      // Update URL hash for bookmarkability
      let hashRoute = PANEL_TO_HASH[panelId] || panelId;
      if (panelId === 'settings') {
        const savedSection = safeLocalStorageGet('settingsActiveSection', 'general');
        const activeSection = switchSettingsSection(savedSection, false);
        hashRoute += '/' + activeSection;
      }
      window.location.hash = '#/' + hashRoute;
    }

    // Restore traffic list scroll position from localStorage
    function restoreTrafficScrollPosition() {
      requestAnimationFrame(() => {
        const wrapper = document.getElementById('trafficTableWrapper');
        if (!wrapper) return;
        const savedAutoScroll = safeLocalStorageGet('trafficAutoScroll');
        if (savedAutoScroll === 'true') {
          autoScroll = true;
          wrapper.scrollTop = wrapper.scrollHeight;
        } else {
          const savedScrollTop = safeLocalStorageGet('trafficScrollTop');
          if (savedScrollTop !== null) {
            autoScroll = false;
            wrapper.scrollTop = parseFloat(savedScrollTop);
          }
        }
        vsForceRender = true;
        renderVirtualRows();
      });
    }

    // Navigate to panel by hash route on page load or hash change
    function navigateFromHash() {
      const hash = window.location.hash.replace(/^#\/?/, '');

      // Check for deep-linked request: #/view/<requestId>
      const viewMatch = window.location.hash.match(/^#\/view\/(.+)$/);
      if (viewMatch) {
        // Switch to traffic panel
        const el = document.querySelector('.sidebar-item[data-panel="traffic"]');
        if (el) {
          setActiveSidebarTab(el);
          document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
          document.getElementById('panel-traffic').classList.add('active');
        }
        // Try to select the request after traffic loads
        const requestId = parseTrafficViewHash(window.location.hash);
        const trafficLifecycleId = parseTrafficViewLifecycleHash(window.location.hash);
        if (requestId !== null) {
          setTimeout(() => {
            if (findTrafficRequestByIdentity(requests, requestId, trafficLifecycleId ?? undefined)) {
              selectRequest(requestId, false, trafficLifecycleId ?? undefined);
            }
          }, 1000);
        }
        return;
      }

      const settingsMatch = hash.match(/^settings(?:\/([^/]+))?$/);
      if (settingsMatch) {
        const el = document.querySelector('.sidebar-item[data-panel="settings"]');
        if (el) {
          setActiveSidebarTab(el);
          document.querySelectorAll('.panel').forEach(panel => panel.classList.remove('active'));
          document.getElementById('panel-settings')?.classList.add('active');
        }
        const requestedSection = settingsMatch[1] || safeLocalStorageGet('settingsActiveSection', 'general');
        switchSettingsSection(requestedSection, false);
        return;
      }

      const panelId = HASH_TO_PANEL[hash];
      if (panelId) {
        const el = document.querySelector(`.sidebar-item[data-panel="${panelId}"]`);
        if (el) {
          setActiveSidebarTab(el);
          document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
          document.getElementById(`panel-${panelId}`).classList.add('active');
        }
        if (panelId === 'traffic') {
          restoreTrafficScrollPosition();
        }
      }
    }

    window.addEventListener('hashchange', navigateFromHash);

    // ============ CONTEXT MENUS ============
    let activeContextMenu = null;

    function showContextMenu(x, y, items, options = {}) {
      hideContextMenu();
      const menu = document.createElement('div');
      menu.className = 'context-menu';
      menu.setAttribute('role', 'menu');
      menu._contextMenuInvoker = options.invoker || null;
      let firstMenuItem = null;

      items.forEach(item => {
        if (item.separator) {
          const sep = document.createElement('div');
          sep.className = 'context-menu-separator';
          sep.setAttribute('role', 'separator');
          menu.appendChild(sep);
          return;
        }
        const el = document.createElement('div');
        el.className = 'context-menu-item';
        el.setAttribute('role', 'menuitem');
        el.tabIndex = firstMenuItem ? -1 : 0;
        el.textContent = item.label;
        let activated = false;
        el.addEventListener('click', () => {
          if (activated) return;
          activated = true;
          hideContextMenu();
          item.action();
        });
        if (!firstMenuItem) firstMenuItem = el;
        menu.appendChild(el);
      });

      document.body.appendChild(menu);

      // Position: ensure it stays within viewport
      const rect = menu.getBoundingClientRect();
      if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 8;
      if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 8;
      menu.style.left = x + 'px';
      menu.style.top = y + 'px';

      activeContextMenu = menu;
      if (options.focusFirst && firstMenuItem) firstMenuItem.focus();
      return menu;
    }

    function hideContextMenu(options = {}) {
      if (activeContextMenu) {
        const menu = activeContextMenu;
        const invoker = menu._contextMenuInvoker;
        menu.remove();
        activeContextMenu = null;
        if (options.restoreFocus && invoker?.focus && invoker.isConnected !== false) {
          invoker.focus();
        }
      }
    }

    function focusContextMenuItem(menu, item) {
      menu.querySelectorAll('[role="menuitem"]').forEach(menuItem => {
        menuItem.tabIndex = menuItem === item ? 0 : -1;
      });
      item.focus();
    }

    function consumeContextMenuKey(event) {
      event.preventDefault();
      event.stopImmediatePropagation?.();
    }

    function handleActiveContextMenuKeydown(event) {
      const menu = activeContextMenu;
      if (!menu) return false;

      if (event.key === 'Escape') {
        consumeContextMenuKey(event);
        hideContextMenu({ restoreFocus: true });
        return true;
      }

      const menuItems = Array.from(menu.querySelectorAll('[role="menuitem"]'));
      if (menuItems.length === 0) return false;
      const currentIndex = menuItems.indexOf(document.activeElement);
      let nextItem = null;

      if (event.key === 'ArrowDown') {
        nextItem = menuItems[(currentIndex + 1) % menuItems.length];
      } else if (event.key === 'ArrowUp') {
        nextItem = menuItems[currentIndex <= 0 ? menuItems.length - 1 : currentIndex - 1];
      } else if (event.key === 'Home') {
        nextItem = menuItems[0];
      } else if (event.key === 'End') {
        nextItem = menuItems[menuItems.length - 1];
      } else if ((event.key === 'Enter' || event.key === ' ') && currentIndex !== -1) {
        consumeContextMenuKey(event);
        menuItems[currentIndex].click();
        return true;
      } else {
        return false;
      }

      consumeContextMenuKey(event);
      focusContextMenuItem(menu, nextItem);
      return true;
    }

    function isContextMenuKeyboardEvent(event) {
      if (event.ctrlKey || event.metaKey || event.altKey) return false;
      return event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey);
    }

    function contextMenuAnchorFor(invoker) {
      const rect = invoker?.getBoundingClientRect?.();
      if (!rect) return { x: 0, y: 0 };
      return { x: rect.left, y: rect.bottom };
    }

    function selectedTrafficRow() {
      if (!selectedRequestId) return null;
      return Array.from(document.querySelectorAll('#trafficBody tr[data-id]'))
        .find(row =>
          row.dataset.id === selectedRequestId &&
          normalizeTrafficLifecycleId(row.dataset.lifecycleId) === selectedRequestLifecycleId
        ) || null;
    }

    function handleContextMenuShortcut(event) {
      if (!isContextMenuKeyboardEvent(event) || isEditableKeyboardTarget(event.target)) return false;

      const trafficPanel = document.getElementById('panel-traffic');
      if (!trafficPanel?.classList.contains('active')) return false;

      const headerTarget = event.target?.closest?.('[data-context-header-key][data-context-section]');
      if (headerTarget && trafficPanel.contains(headerTarget)) {
        consumeContextMenuKey(event);
        showHeaderContextMenu(event, headerTarget.dataset.contextHeaderKey, headerTarget.dataset.contextSection, headerTarget);
        return true;
      }

      const wrapper = document.getElementById('trafficTableWrapper');
      const grid = document.getElementById('trafficGrid');
      let row = event.target?.closest?.('#trafficBody tr[data-id]') || null;
      if (!row && (event.target === grid || event.target === wrapper)) row = selectedTrafficRow();
      if (!row || row.dataset.id !== selectedRequestId ||
          normalizeTrafficLifecycleId(row.dataset.lifecycleId) !== selectedRequestLifecycleId) return false;

      consumeContextMenuKey(event);
      showTrafficContextMenu(event, selectedRequestId, row, selectedRequestLifecycleId);
      return true;
    }

    // One document-level listener handles click-away, menu navigation and scoped invocation.
    document.addEventListener('click', hideContextMenu);
    document.addEventListener('keydown', (event) => {
      if (handleActiveContextMenuKeydown(event)) return;
      handleContextMenuShortcut(event);
    });

    // --- Traffic row context menu ---
    function showTrafficContextMenu(e, requestId, menuInvoker, trafficLifecycleId) {
      e.preventDefault();
      const req = trafficActionRequest(requestId, trafficLifecycleId);
      if (!req) return;

      if (!isSelectedTrafficRequest(req)) {
        selectRequest(requestId, false, req.trafficLifecycleId);
      }

      const invoker = menuInvoker || e.currentTarget || e.target;
      const keyboardInvoked = e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey);
      const anchor = keyboardInvoked ? contextMenuAnchorFor(invoker) : { x: e.clientX, y: e.clientY };
      showContextMenu(anchor.x, anchor.y, [
        { label: 'Copy URL', action: () => navigator.clipboard.writeText(req.url).then(() => toast('URL copied', 'success')) },
        { label: 'Copy as cURL', action: () => {
          const snippet = generateExportSnippet(req, 'curl');
          navigator.clipboard.writeText(snippet).then(() => toast('cURL command copied', 'success'));
        }},
        { separator: true },
        { label: 'Resend in Send tab', action: () => resendSelectedRequest(requestId, req.trafficLifecycleId) },
        { label: 'Create mock rule', action: () => createMockFromRequest(requestId, req.trafficLifecycleId) },
        { label: 'Create breakpoint', action: () => createBreakpointFromRequest(requestId, req.trafficLifecycleId) },
        { separator: true },
        { label: 'Pin exchange', action: () => togglePinRequest(requestId, req.trafficLifecycleId) },
        { label: 'Delete exchange', action: () => deleteSelectedRequest(requestId, req.trafficLifecycleId) },
      ], { invoker, focusFirst: keyboardInvoked });
    }

    function copyResponseHeadersForMock(headers) {
      const skipHeaders = new Set([
        'transfer-encoding', 'connection', 'keep-alive', 'proxy-connection',
        'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'upgrade',
        'content-encoding', 'content-length'
      ]);
      const copiedHeaders = {};
      for (const [name, value] of Object.entries(headers || {})) {
        if (!skipHeaders.has(name.toLowerCase())) {
          copiedHeaders[name] = Array.isArray(value) ? [...value] : value;
        }
      }
      return copiedHeaders;
    }

    function createMockFromRequest(requestId = selectedRequestId, trafficLifecycleId) {
      const req = trafficActionRequest(requestId, trafficLifecycleId);
      if (!req) return;
      if (req.requestBodyTruncated === true || req.responseBodyTruncated === true) {
        toast('Cannot create a mock because this exchange contains an incomplete body capture.', 'error');
        return;
      }
      if (mockSaveInProgress || mockRevertInProgress || mockResetInProgress || mockCollectionMutationCount > 0) return;

      // Build rich matchers from the request
      const matchers = [
        { type: 'method', value: req.method }
      ];

      // Add host matcher
      if (req.host) {
        matchers.push({ type: 'host', value: req.host });
      }

      // Add path matcher
      if (req.path) {
        matchers.push({ type: 'path', value: req.path.split('?')[0], matchType: 'exact' });
      }

      // Add body matcher if there's a request body (for POST/PUT/PATCH)
      if (req.requestBody && req.requestBody.length > 0 && !req.requestBody.startsWith('[Binary')) {
        // Try JSON body match first
        try {
          JSON.parse(req.requestBody);
          matchers.push({ type: 'json-body-includes', value: req.requestBody });
        } catch {
          // Fall back to body-contains with first 200 chars
          matchers.push({ type: 'body-contains', value: req.requestBody.substring(0, 200) });
        }
      }

      // Build the response headers from the actual response, excluding hop-by-hop headers
      const respHeaders = copyResponseHeadersForMock(req.responseHeaders);

      // Build the action — use fixed-response with the actual response data
      // Request body goes into matchers (above), response data goes into the action
      const action = {
        type: 'fixed-response',
        status: req.statusCode || 200,
        headers: respHeaders,
        body: req.responseBody || ''
      };

      return _queueMockCollectionMutation(async () => {
        const response = await fetch(API_BASE + '/api/mock-rules', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({
            title: req.method + ' ' + req.host + (req.path ? req.path.split('?')[0] : ''),
            matchers,
            action,
            _originalRequestBody: req.requestBody || '',
            _originalResponseBody: req.responseBody || ''
          })
        });
        const data = await response.json();
        if (!response.ok || data.error) throw new Error(data.error || 'Server rejected the rule');
        await loadMockRules();
        return data;
      }).then(data => {
        if (!data) return;
        toast('Mock rule created from exchange', 'success');
        // Switch to Mock tab
        const mockTab = document.querySelector('.sidebar-item[data-panel="mock"]');
        if (mockTab) switchPanel(mockTab, 'mock');
        // The shared mutation lock has released, so the new rule can open safely.
        if (data.rule?.id) {
          editMockRule(data.rule.id);
          setTimeout(() => {
            const el = Array.from(document.querySelectorAll('[data-rule-id]'))
              .find(candidate => candidate.dataset.ruleId === data.rule.id);
            if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
          }, 100);
        }
      }).catch(err => toast('Error: ' + err.message, 'error'));
    }

    // --- Header context menu ---
    // Store current detail headers for safe lookup (avoids quote-escaping issues in inline handlers)
    window._detailHeaders = { request: {}, response: {} };

    function showHeaderContextMenu(e, headerKey, section, menuInvoker) {
      e.preventDefault();
      e.stopPropagation();
      const headers = section === 'request' ? window._detailHeaders.request : window._detailHeaders.response;
      const value = headers ? (Array.isArray(headers[headerKey]) ? headers[headerKey].join(', ') : String(headers[headerKey] || '')) : '';
      const invoker = menuInvoker || e.currentTarget || e.target;
      const keyboardInvoked = e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey);
      const anchor = keyboardInvoked ? contextMenuAnchorFor(invoker) : { x: e.clientX, y: e.clientY };
      showContextMenu(anchor.x, anchor.y, [
        { label: 'Copy header value', action: () => navigator.clipboard.writeText(value).then(() => toast('Value copied', 'success')) },
        { label: 'Copy header name', action: () => navigator.clipboard.writeText(headerKey).then(() => toast('Name copied', 'success')) },
        { label: 'Copy as "name: value"', action: () => navigator.clipboard.writeText(headerKey + ': ' + value).then(() => toast('Header copied', 'success')) },
      ], { invoker, focusFirst: keyboardInvoked });
    }

    // ============ HELPERS ============
    function esc(str) {
      if (!str) return '';
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }

    function formatSize(bytes) {
      if (bytes == null || bytes <= 0) return '-';
      if (bytes < 1024) return bytes + 'B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
      return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
    }

    function tryPrettyJson(str) {
      try {
        return JSON.stringify(JSON.parse(str), null, 2);
      } catch {
        return str;
      }
    }

    // ============ BREAKPOINT FUNCTIONS ============
    async function updateBreakpointBanner() {
      try {
        const res = await fetch(API_BASE + '/api/breakpoints/pending');
        const data = await res.json();
        const banner = document.getElementById('breakpointBanner');
        if (!banner) return;
        if (data.pending && data.pending.length > 0) {
          banner.style.display = 'flex';
          const bannerText = document.getElementById('breakpointBannerText');
          if (bannerText) bannerText.textContent =
            data.pending.length + ' request' + (data.pending.length > 1 ? 's' : '') + ' paused';
        } else {
          banner.style.display = 'none';
        }
      } catch (e) { console.error('[Error]', e.message); }
    }

    async function resumeAllBreakpoints() {
      const failures = [];
      try {
        const res = await fetch(API_BASE + '/api/breakpoints/pending');
        const data = await res.json();
        for (const bp of (data.pending || [])) {
          try {
            const lifecycleQuery = bp.trafficLifecycleId
              ? '?trafficLifecycleId=' + encodeURIComponent(bp.trafficLifecycleId)
              : '';
            const resumeRes = await fetch(
              API_BASE + '/api/breakpoints/pending/' + encodeURIComponent(bp.id) + '/resume' + lifecycleQuery,
              {
              method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}'
              }
            );
            let resumeData = null;
            try { resumeData = await resumeRes.json(); } catch { /* ignore non-json error bodies */ }
            if (resumeRes.status === 404) {
              clearBreakpointEditDraft(bp.id, bp.trafficLifecycleId);
              continue;
            }
            if (!resumeRes.ok || resumeData?.success === false) {
              throw new Error(resumeData?.error || `Resume failed (${resumeRes.status})`);
            }
            clearBreakpointEditDraft(bp.id, bp.trafficLifecycleId);
          } catch (err) {
            if (err?.status === 404) {
              clearBreakpointEditDraft(bp.id, bp.trafficLifecycleId);
              continue;
            }
            failures.push(err);
          }
        }
        if (failures.length > 0) {
          toast(
            failures.length + ' breakpoint' + (failures.length > 1 ? 's' : '') +
              ' could not be resumed: ' + failures[0].message,
            'error'
          );
        } else {
          toast('All breakpoints resumed', 'success');
        }
      } catch (err) {
        toast('Error: ' + err.message, 'error');
      } finally {
        await updateBreakpointBanner();
      }
    }

    function breakpointDraftKey(requestId, trafficLifecycleId = '') {
      return JSON.stringify([String(requestId), String(trafficLifecycleId || '')]);
    }

    function clearBreakpointEditDraft(requestId, trafficLifecycleId = '') {
      breakpointEditDrafts.delete(breakpointDraftKey(requestId, trafficLifecycleId));
    }

    function getBreakpointEditDraft(req) {
      const draftKey = breakpointDraftKey(req.id, req.trafficLifecycleId);
      const responsePhase = req.breakpointPhase === 'response';
      const expectedPhase = responsePhase ? 'response' : 'request';
      if (breakpointEditDrafts.get(draftKey)?._phase !== expectedPhase) {
        breakpointEditDrafts.set(draftKey, responsePhase ? {
          _phase: 'response',
          status: req.upstreamStatusCode || 200,
          headers: { ...(req.responseHeaders || {}) },
          body: req.responseBody || '',
          _dirty: {}
        } : {
          _phase: 'request',
          method: req.method || 'GET',
          url: req.url || '',
          headers: { ...(req.requestHeaders || {}) },
          body: req.requestBody || '',
          _dirty: {}
        });
      }
      const draft = breakpointEditDrafts.get(draftKey);
      if (!draft._dirty) draft._dirty = {};
      return draft;
    }

    function activateBreakpointFieldOnKeyboard(event, requestId, trafficLifecycleId, field) {
      if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault();
      if (event.repeat) return;
      editBreakpointField(requestId, trafficLifecycleId, field);
    }

    function editBreakpointField(requestId, trafficLifecycleId, field) {
      const req = requests.find(r =>
        r.id === requestId &&
        (!trafficLifecycleId || r.trafficLifecycleId === trafficLifecycleId)
      );
      if (!req) return;
      const draft = getBreakpointEditDraft(req);

      if (field === 'status') {
        const value = prompt('Response status:', String(draft.status || 200));
        if (value === null) return;
        const status = Number(value);
        if (!Number.isInteger(status) || status < 200 || status > 599) {
          toast('Status must be an integer from 200 to 599', 'error');
          return;
        }
        draft.status = status;
        draft._dirty.status = true;
      } else if (field === 'method') {
        const value = prompt('Request method:', draft.method || 'GET');
        if (value === null) return;
        draft.method = value.trim().toUpperCase() || draft.method;
        draft._dirty.method = true;
      } else if (field === 'url') {
        const value = prompt('Request URL:', draft.url || '');
        if (value === null) return;
        draft.url = value.trim() || draft.url;
        draft._dirty.url = true;
      } else if (field === 'headers') {
        const label = draft._phase === 'response' ? 'Response headers as JSON:' : 'Request headers as JSON:';
        const value = prompt(label, JSON.stringify(draft.headers || {}, null, 2));
        if (value === null) return;
        try {
          const parsed = JSON.parse(value);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected a JSON object');
          draft.headers = parsed;
        } catch (err) {
          toast('Invalid headers JSON: ' + err.message, 'error');
          return;
        }
        draft._dirty.headers = true;
      } else if (field === 'body') {
        const value = prompt(draft._phase === 'response' ? 'Response body:' : 'Request body:', draft.body || '');
        if (value === null) return;
        draft.body = value;
        draft._dirty.body = true;
      }

      renderDetailCards(req);
      document.getElementById('breakpoint-edit-' + field)?.focus();
    }

    async function resumeBreakpointRequest(requestId, trafficLifecycleId = '') {
      try {
        const draftKey = breakpointDraftKey(requestId, trafficLifecycleId);
        const draft = breakpointEditDrafts.get(draftKey) || {};
        const dirty = draft._dirty || {};
        const modifications = {};
        const editableFields = draft._phase === 'response'
          ? ['status', 'headers', 'body']
          : ['method', 'url', 'headers', 'body'];
        for (const field of editableFields) {
          if (dirty[field]) modifications[field] = draft[field];
        }
        const lifecycleQuery = trafficLifecycleId
          ? '?trafficLifecycleId=' + encodeURIComponent(trafficLifecycleId)
          : '';
        const res = await fetch(
          API_BASE + '/api/breakpoints/pending/' + encodeURIComponent(requestId) + '/resume' + lifecycleQuery,
          {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify(modifications)
          }
        );
        let data = null;
        try { data = await res.json(); } catch { /* ignore non-json error bodies */ }
        if (!res.ok || data?.success === false) {
          throw new Error(data?.error || `Resume failed (${res.status})`);
        }
        clearBreakpointEditDraft(requestId, trafficLifecycleId);
        toast('Request resumed', 'success');
        updateBreakpointBanner();
      } catch (err) {
        if (err?.status === 404) {
          clearBreakpointEditDraft(requestId, trafficLifecycleId);
          toast('Request is no longer paused', 'success');
          updateBreakpointBanner();
          return;
        }
        toast('Error: ' + err.message, 'error');
      }
    }

    function createBreakpointFromRequest(requestId = selectedRequestId, trafficLifecycleId) {
      if (!requestId) return;
      const req = trafficActionRequest(requestId, trafficLifecycleId);
      if (!req) return;
      if (mockSaveInProgress || mockRevertInProgress || mockResetInProgress || mockCollectionMutationCount > 0) return;

      return _queueMockCollectionMutation(async () => {
        const res = await fetch(API_BASE + '/api/breakpoints', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({
            matchers: [
              { type: 'method', value: req.method },
              { type: 'host', value: req.host }
            ]
          })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || 'Failed to create breakpoint');
        toast('Breakpoint created for ' + req.method + ' ' + req.host, 'success');
        await loadBreakpointRules();
      }).catch(err => toast('Error: ' + err.message, 'error'));
    }

    function toast(message, type = 'success') {
      const container = document.getElementById('toastContainer');
      const t = document.createElement('div');
      t.className = `toast toast-${type}`;
      t.textContent = message;
      container.appendChild(t);
      setTimeout(() => {
        t.classList.add('toast-exit');
        t.addEventListener('animationend', () => t.remove());
        // Fallback removal in case animationend doesn't fire
        setTimeout(() => { if (t.parentNode) t.remove(); }, 400);
      }, 2700);
    }

    function setupSplitPaneResizer(options) {
      const resizer = options.resizer;
      const pane = options.pane;
      if (!resizer || !pane || !resizer.parentElement) return null;
      const container = resizer.parentElement;
      const keyboardStep = options.keyboardStep || 10;
      const originalStyle = {
        flex: pane.style.flex || '',
        width: pane.style.width || '',
        height: pane.style.height || ''
      };
      const axisSizes = { x: null, y: null };
      let activeAxis = null;
      let drag = null;

      function prepareAxis() {
        const flexDirection = getComputedStyle(container).flexDirection || 'row';
        const axis = flexDirection.startsWith('column') ? 'y' : 'x';
        if (axis !== activeAxis) {
          const sizeProperty = axis === 'x' ? 'width' : 'height';
          const otherSizeProperty = axis === 'x' ? 'height' : 'width';
          pane.style[otherSizeProperty] = originalStyle[otherSizeProperty];
          if (axisSizes[axis] === null) {
            pane.style.flex = originalStyle.flex;
            pane.style[sizeProperty] = originalStyle[sizeProperty];
          } else {
            pane.style.flex = 'none';
            pane.style[sizeProperty] = `${Math.round(axisSizes[axis])}px`;
          }
          activeAxis = axis;
        }
        return axis;
      }

      function metrics() {
        const axis = prepareAxis();
        const isHorizontalSeparator = axis === 'y';
        const totalProperty = axis === 'x' ? 'clientWidth' : 'clientHeight';
        const offsetProperty = axis === 'x' ? 'offsetWidth' : 'offsetHeight';
        const sizeProperty = axis === 'x' ? 'width' : 'height';
        const otherSizeProperty = axis === 'x' ? 'height' : 'width';
        const minControlled = axis === 'x' ? options.minWidth : options.minHeight;
        const minOther = axis === 'x' ? options.otherMinWidth : options.otherMinHeight;
        const initialSize = axis === 'x' ? options.initialWidth : options.initialHeight;
        const maxFraction = axis === 'x' ? options.maxWidthFraction : options.maxHeightFraction;
        const separatorSize = Number(resizer[offsetProperty]) || 11;
        const renderedPaneSize = Number(pane[offsetProperty]) || initialSize || minControlled;
        let totalSize = Number(container[totalProperty]);
        if (!Number.isFinite(totalSize) || totalSize <= separatorSize) {
          totalSize = Math.max(renderedPaneSize, minControlled) + minOther + separatorSize;
        }
        let maxControlled = Math.max(minControlled, totalSize - minOther - separatorSize);
        if (Number.isFinite(maxFraction)) {
          maxControlled = Math.max(
            minControlled,
            Math.min(maxControlled, Math.floor(totalSize * maxFraction))
          );
        }
        const minPosition = options.controlledAfter
          ? totalSize - separatorSize - maxControlled
          : minControlled;
        const maxPosition = options.controlledAfter
          ? totalSize - separatorSize - minControlled
          : maxControlled;
        const renderedPosition = options.controlledAfter
          ? totalSize - separatorSize - renderedPaneSize
          : renderedPaneSize;
        const position = Math.min(maxPosition, Math.max(minPosition, renderedPosition));
        return {
          axis,
          orientation: isHorizontalSeparator ? 'horizontal' : 'vertical',
          totalSize,
          separatorSize,
          sizeProperty,
          otherSizeProperty,
          minPosition,
          maxPosition,
          position
        };
      }

      function updateAria(currentMetrics, position) {
        const controlledSize = options.controlledAfter
          ? currentMetrics.totalSize - currentMetrics.separatorSize - position
          : position;
        resizer.setAttribute('aria-orientation', currentMetrics.orientation);
        resizer.setAttribute('aria-valuemin', String(Math.round(currentMetrics.minPosition)));
        resizer.setAttribute('aria-valuemax', String(Math.round(currentMetrics.maxPosition)));
        resizer.setAttribute('aria-valuenow', String(Math.round(position)));
        resizer.setAttribute('aria-valuetext', `${Math.round(controlledSize)} pixels`);
      }

      function applyPosition(position, currentMetrics = metrics()) {
        const clampedPosition = Math.min(
          currentMetrics.maxPosition,
          Math.max(currentMetrics.minPosition, position)
        );
        const controlledSize = options.controlledAfter
          ? currentMetrics.totalSize - currentMetrics.separatorSize - clampedPosition
          : clampedPosition;
        pane.style.flex = 'none';
        pane.style[currentMetrics.otherSizeProperty] = '';
        pane.style[currentMetrics.sizeProperty] = `${Math.round(controlledSize)}px`;
        axisSizes[currentMetrics.axis] = controlledSize;
        updateAria(currentMetrics, clampedPosition);
      }

      function syncAria() {
        const currentMetrics = metrics();
        if (axisSizes[currentMetrics.axis] === null) {
          updateAria(currentMetrics, currentMetrics.position);
        } else {
          applyPosition(currentMetrics.position, currentMetrics);
        }
      }

      function onMouseMove(event) {
        if (!drag) return;
        const coordinate = drag.axis === 'x' ? event.clientX : event.clientY;
        applyPosition(drag.position + coordinate - drag.coordinate, drag.metrics);
      }

      function onMouseUp() {
        drag = null;
        resizer.classList.remove('active');
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        syncAria();
      }

      resizer.addEventListener('mousedown', (event) => {
        const currentMetrics = metrics();
        drag = {
          axis: currentMetrics.axis,
          coordinate: currentMetrics.axis === 'x' ? event.clientX : event.clientY,
          position: currentMetrics.position,
          metrics: currentMetrics
        };
        resizer.classList.add('active');
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        event.preventDefault();
      });

      resizer.addEventListener('keydown', (event) => {
        const currentMetrics = metrics();
        let nextPosition = currentMetrics.position;
        if (event.key === 'Home') nextPosition = currentMetrics.minPosition;
        else if (event.key === 'End') nextPosition = currentMetrics.maxPosition;
        else if (currentMetrics.axis === 'x' && event.key === 'ArrowLeft') nextPosition -= keyboardStep;
        else if (currentMetrics.axis === 'x' && event.key === 'ArrowRight') nextPosition += keyboardStep;
        else if (currentMetrics.axis === 'y' && event.key === 'ArrowUp') nextPosition -= keyboardStep;
        else if (currentMetrics.axis === 'y' && event.key === 'ArrowDown') nextPosition += keyboardStep;
        else return;
        applyPosition(nextPosition, currentMetrics);
        event.preventDefault();
      });

      window.addEventListener('resize', syncAria);
      if (typeof ResizeObserver === 'function') {
        new ResizeObserver(syncAria).observe(container);
      }
      syncAria();
      return { sync: syncAria, applyPosition };
    }

    // ============ RESIZE DETAIL ============
    (function setupResizer() {
      setupSplitPaneResizer({
        resizer: document.getElementById('detailResizer'),
        pane: document.getElementById('detailPanel'),
        controlledAfter: true,
        minWidth: 300,
        otherMinWidth: 300,
        minHeight: 150,
        otherMinHeight: 200,
        initialWidth: 300,
        initialHeight: 250,
        maxHeightFraction: 0.5
      });
    })();

    // Virtual scroll: re-render visible rows on scroll + auto-scroll detection
    document.getElementById('trafficTableWrapper').addEventListener('scroll', function() {
      const el = this;
      autoScroll = el.scrollTop + el.clientHeight >= el.scrollHeight - 50;
      // Debounce virtual scroll rendering with requestAnimationFrame
      if (vsRafId) cancelAnimationFrame(vsRafId);
      vsRafId = requestAnimationFrame(() => {
        vsRafId = null;
        renderVirtualRows();
      });
    });

    // Search input
    document.getElementById('searchInput').addEventListener('input', () => {
      debouncedApplyFilter();
      showFilterHint();
      updateSearchClearBtn();
    });
    document.getElementById('searchInput').addEventListener('blur', () => {
      setTimeout(() => {
        const hint = document.getElementById('filterHint');
        if (hint) hint.style.display = 'none';
      }, 200);
    });

    function isEditableKeyboardTarget(element) {
      const tagName = element?.tagName?.toUpperCase();
      if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') return true;
      if (element?.isContentEditable) return true;
      return Boolean(element?.closest?.('.monaco-editor, [contenteditable]:not([contenteditable="false"])'));
    }

    function isTrafficNavigationKeyboardTarget(element) {
      if (isEditableKeyboardTarget(element)) return false;
      const tagName = element?.tagName?.toUpperCase();
      if (tagName === 'BUTTON' || tagName === 'SUMMARY') return false;
      if (tagName === 'A' && element?.hasAttribute?.('href')) return false;
      if (element?.id === 'trafficGrid' || element?.id === 'trafficTableWrapper' ||
          element?.matches?.('#trafficBody tr[data-id]')) {
        return true;
      }
      return !element?.closest?.([
        'button', 'a[href]', 'summary', 'audio[controls]', 'video[controls]',
        '[role="menuitem"]', '[role="menuitemcheckbox"]', '[role="menuitemradio"]',
        '[role="option"]', '[role="radio"]', '[role="scrollbar"]',
        '[role="separator"]', '[role="slider"]', '[role="spinbutton"]',
        '[role="tab"]', '[role="treeitem"]', '[tabindex]:not([tabindex="-1"])'
      ].join(', '));
    }

    function isClearTrafficShortcut(event, activeElement, trafficPanelActive) {
      return event.key === 'Delete'
        && (event.ctrlKey || event.metaKey)
        && !event.altKey
        && trafficPanelActive
        && !isEditableKeyboardTarget(activeElement);
    }

    function focusTrafficSearch() {
      const trafficPanel = document.getElementById('panel-traffic');
      if (!trafficPanel?.classList.contains('active')) {
        const trafficNav = document.querySelector('.sidebar-item[data-panel="traffic"]');
        if (!trafficNav) return false;
        switchPanel(trafficNav, 'traffic');
      }

      if (!trafficPanel?.classList.contains('active')) return false;
      const searchInput = document.getElementById('searchInput');
      if (!searchInput) return false;
      searchInput.focus();
      return true;
    }

    function handleTrafficSearchShortcut(event, editableTarget) {
      const commandShortcut = (event.ctrlKey || event.metaKey)
        && (event.key === 'f' || event.key === 'k');
      const slashShortcut = event.key === '/' && !editableTarget;
      if (!commandShortcut && !slashShortcut) return false;

      event.preventDefault();
      focusTrafficSearch();
      return true;
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      const activeEl = document.activeElement;
      const isInput = isEditableKeyboardTarget(activeEl);
      const trafficPanelActive = document.getElementById('panel-traffic')?.classList.contains('active') === true;
      const trafficNavigationTarget = e.target?.closest ? e.target : activeEl;

      if (e.key === 'Escape') {
        if (!handleSendEscapeShortcut(e)) closeDetail();
        return;
      }

      // Panel switching: Ctrl+1..4, Ctrl+9 (matches HTTP Toolkit)
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        const panelShortcuts = { '1': 'intercept', '2': 'traffic', '3': 'mock', '4': 'send', '9': 'settings' };
        if (panelShortcuts[e.key]) {
          e.preventDefault();
          const panelId = panelShortcuts[e.key];
          const el = document.querySelector(`.sidebar-item[data-panel="${panelId}"]`);
          if (el) switchPanel(el, panelId);
          return;
        }
      }

      // Ctrl+F, Ctrl+K, or /: switch to Traffic and focus its search input.
      if (handleTrafficSearchShortcut(e, isInput)) return;

      // Ctrl+Delete or Ctrl+Shift+Delete: Clear all traffic
      if (isClearTrafficShortcut(e, activeEl, trafficPanelActive)) {
        e.preventDefault();
        clearTraffic();
        return;
      }

      // Delete: Confirm deletion of the selected exchange
      if (e.key === 'Delete' && !e.shiftKey && !e.altKey && !isInput && selectedRequestId) {
        e.preventDefault();
        deleteSelectedRequest();
        return;
      }


      // Ctrl+Shift+N: Create a new send tab
      if (e.key === 'N' && (e.ctrlKey || e.metaKey) && e.shiftKey && !isInput) {
        e.preventDefault();
        addSendTab();
        return;
      }

      // Send tab shortcuts (only when send panel is active)
      if ((e.ctrlKey || e.metaKey) && e.key === 'Tab' && document.getElementById('panel-send')?.classList.contains('active')) {
        e.preventDefault();
        if (!sendTabs || sendTabs.length < 2) return;
        const currentIdx = sendTabs.findIndex(t => t.id === activeSendTab);
        if (e.shiftKey) {
          // Previous tab
          const newIdx = (currentIdx - 1 + sendTabs.length) % sendTabs.length;
          switchSendTab(sendTabs[newIdx].id);
        } else {
          // Next tab
          const newIdx = (currentIdx + 1) % sendTabs.length;
          switchSendTab(sendTabs[newIdx].id);
        }
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key === 'w') {
        e.preventDefault();
        if (document.getElementById('panel-send')?.classList.contains('active') && sendTabs.length > 1) {
          closeSendTab(activeSendTab, true);
        }
        return;
      }

      // Ctrl+P: Pin/unpin selected exchange
      if (e.key === 'p' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !isInput) {
        e.preventDefault();
        if (selectedRequestId) togglePinRequest();
        return;
      }

      // Ctrl+R: Resend selected request
      if (e.key === 'r' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !isInput) {
        e.preventDefault();
        if (selectedRequestId) resendSelectedRequest();
        return;
      }

      // Ctrl+M: Create mock rule from selected exchange
      if (e.key === 'm' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !isInput) {
        e.preventDefault();
        if (selectedRequestId) createMockFromRequest();
        return;
      }

      // Ctrl+[: Focus traffic list pane (left side)
      if (e.key === '[' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
        e.preventDefault();
        const trafficList = document.getElementById('trafficGrid') ||
          document.getElementById('trafficTableWrapper');
        if (trafficList) trafficList.focus();
        return;
      }

      // Ctrl+]: Focus detail pane (right side)
      if (e.key === ']' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
        e.preventDefault();
        const detailPane = document.getElementById('detailPanel');
        if (detailPane) detailPane.focus();
        return;
      }

      // Arrow / vim navigation applies only to the active Traffic panel's
      // non-interactive surface. Controls retain their native key behavior.
      if (trafficPanelActive && isTrafficNavigationKeyboardTarget(trafficNavigationTarget)) {
        const direction = e.key === 'ArrowDown' || e.key === 'j' ? 1
          : e.key === 'ArrowUp' || e.key === 'k' ? -1
          : e.key === 'PageDown' ? 10
          : e.key === 'PageUp' ? -10
          : e.key === 'Home' ? 'first'
          : e.key === 'End' ? 'last'
          : null;
        if (direction !== null) {
          e.preventDefault();
          const grid = document.getElementById('trafficGrid');
          if (grid && document.activeElement !== grid) grid.focus({ preventScroll: true });
          selectRequestByIndex(direction);
        }
      }
    });

    // ============ MONACO EDITOR ============
    /** @type {typeof import('monaco-editor')|null} */
    let monacoApi = null;
    const MONACO_LOAD_TIMEOUT_MS = 5000;
    /** @type {Promise<typeof import('monaco-editor')|null>} */
    const monacoReady = new Promise((resolve) => {
      let settled = false;
      const settle = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        resolve(value);
      };
      const timeoutId = setTimeout(() => {
        console.warn(`[Monaco] Load timed out after ${MONACO_LOAD_TIMEOUT_MS}ms; using fallback editors`);
        settle(null);
      }, MONACO_LOAD_TIMEOUT_MS);

      if (typeof require !== 'function') {
        console.warn('[Monaco] AMD require unavailable; using fallback editors');
        settle(null);
        return;
      }

      try {
        require(['vs/editor/editor.main'], function (monaco) {
          if (settled) return;
          try {
            if (!monaco?.editor?.create || !monaco.editor.defineTheme) {
              throw new Error('Monaco editor API is incomplete');
            }

          // Define custom dark theme matching HTTP Toolkit
          monaco.editor.defineTheme('httptoolkit-dark', {
            base: 'vs-dark',
            inherit: true,
            rules: [
              { token: 'string', foreground: '4caf7d' },
              { token: 'string.key.json', foreground: 'e1421f' },
              { token: 'string.value.json', foreground: '4caf7d' },
              { token: 'keyword', foreground: '6e40aa' },
              { token: 'number', foreground: '5a80cc' },
              { token: 'comment', foreground: '818490' },
              { token: 'type', foreground: '2fb4e0' },
              { token: 'delimiter', foreground: '9a9da8' },
              { token: 'tag', foreground: 'e1421f' },
              { token: 'attribute.name', foreground: '6e40aa' },
              { token: 'attribute.value', foreground: '4caf7d' },
              { token: 'metatag', foreground: '818490' },
              { token: 'variable', foreground: 'e4e8ed' },
              { token: 'operator', foreground: '9a9da8' },
            ],
            colors: {
              'editor.background': '#16181e',
              'editor.foreground': '#e4e8ed',
              'editor.lineHighlightBackground': '#1e202800',
              'editor.selectionBackground': '#53565e80',
              'editorCursor.foreground': '#e1421f',
              'editorLineNumber.foreground': '#818490',
              'editorLineNumber.activeForeground': '#e4e8ed',
              'editor.inactiveSelectionBackground': '#53565e40',
              'editorWidget.background': '#1e2028',
              'editorWidget.border': '#53565e',
              'input.background': '#16181e',
              'input.border': '#53565e',
              'input.foreground': '#e4e8ed',
              'dropdown.background': '#1e2028',
              'dropdown.border': '#53565e',
              'list.activeSelectionBackground': '#53565e',
              'list.hoverBackground': '#25262e',
              'scrollbarSlider.background': '#53565e80',
              'scrollbarSlider.hoverBackground': '#818490',
              'scrollbarSlider.activeBackground': '#9a9da8',
            }
          });

          // Define custom light theme matching HTTP Toolkit
          monaco.editor.defineTheme('httptoolkit-light', {
            base: 'vs',
            inherit: true,
            rules: [
              { token: 'string', foreground: '117733' },
              { token: 'string.key.json', foreground: 'c22f2f' },
              { token: 'string.value.json', foreground: '117733' },
              { token: 'keyword', foreground: '6e40aa' },
              { token: 'number', foreground: '2d4cbd' },
              { token: 'comment', foreground: '818490' },
              { token: 'type', foreground: '1976d2' },
              { token: 'delimiter', foreground: '53565e' },
              { token: 'tag', foreground: 'c22f2f' },
              { token: 'attribute.name', foreground: '6e40aa' },
              { token: 'attribute.value', foreground: '117733' },
              { token: 'metatag', foreground: '818490' },
              { token: 'variable', foreground: '1e2028' },
              { token: 'operator', foreground: '53565e' },
            ],
            colors: {
              'editor.background': '#ffffff',
              'editor.foreground': '#1e2028',
              'editor.lineHighlightBackground': '#f2f2f200',
              'editor.selectionBackground': '#6284fa30',
              'editorCursor.foreground': '#e1421f',
              'editorLineNumber.foreground': '#818490',
              'editorLineNumber.activeForeground': '#1e2028',
              'editor.inactiveSelectionBackground': '#6284fa18',
              'editorWidget.background': '#fafafa',
              'editorWidget.border': '#9a9da8',
              'input.background': '#ffffff',
              'input.border': '#9a9da8',
              'input.foreground': '#1e2028',
              'dropdown.background': '#fafafa',
              'dropdown.border': '#9a9da8',
              'list.activeSelectionBackground': '#6284fa30',
              'list.hoverBackground': '#f2f2f2',
              'scrollbarSlider.background': '#c0c2c880',
              'scrollbarSlider.hoverBackground': '#9a9da8',
              'scrollbarSlider.activeBackground': '#818490',
            }
          });

            monacoApi = monaco;
            settle(monaco);
          } catch (error) {
            monacoApi = null;
            console.warn('[Monaco] Initialization failed; using fallback editors', error);
            settle(null);
          }
        }, function (error) {
          if (settled) return;
          console.warn('[Monaco] AMD load failed; using fallback editors', error);
          settle(null);
        });
      } catch (error) {
        console.warn('[Monaco] AMD loader threw; using fallback editors', error);
        settle(null);
      }
    });

    /**
     * Track all active Monaco editor instances for theme switching.
     * @type {Array<{editor: object, container: HTMLElement, containerId: string,
     * generation: number, resizeObserver: ResizeObserver, mutationObserver: MutationObserver|null}>}
     */
    const monacoInstances = [];
    const disposedMonacoEditors = new WeakSet();
    const monacoContainerGenerations = new Map();
    let nextMonacoContainerGeneration = 0;

    function claimMonacoContainer(containerId) {
      const generation = ++nextMonacoContainerGeneration;
      monacoContainerGenerations.set(containerId, generation);
      return generation;
    }

    /**
     * Invalidate pending initialization and dispose every editor owned by a container.
     * @param {string} containerId
     */
    function disposeMonacoContainer(containerId) {
      claimMonacoContainer(containerId);
      const editors = new Set(
        monacoInstances
          .filter(instance => instance.containerId === containerId)
          .map(instance => instance.editor)
      );
      const activeBodyEditor = activeBodyEditors[containerId];
      if (activeBodyEditor) editors.add(activeBodyEditor);
      for (const editor of editors) disposeMonacoEditor(editor);
    }

    function isMonacoEditorCurrent(containerId, editor) {
      if (!editor) return false;
      const instance = monacoInstances.find(candidate => candidate.editor === editor);
      return Boolean(instance &&
        instance.containerId === containerId &&
        monacoContainerGenerations.get(containerId) === instance.generation &&
        document.getElementById(containerId) === instance.container &&
        document.body.contains(instance.container));
    }

    /**
     * Dispose an editor and every resource retained for its lifecycle.
     * Safe to call repeatedly or from a container-removal observer.
     * @param {object|null} editor
     */
    function disposeMonacoEditor(editor) {
      if (!editor) return;

      const instanceIndex = monacoInstances.findIndex(instance => instance.editor === editor);
      if (instanceIndex !== -1) {
        const [instance] = monacoInstances.splice(instanceIndex, 1);
        instance.resizeObserver.disconnect();
        instance.mutationObserver?.disconnect();
      }

      for (const [containerId, activeEditor] of Object.entries(activeBodyEditors)) {
        if (activeEditor === editor) delete activeBodyEditors[containerId];
      }
      if (sendBodyEditor === editor) sendBodyEditor = null;

      if (!disposedMonacoEditors.has(editor)) {
        disposedMonacoEditors.add(editor);
        try {
          editor.dispose();
        } catch (error) {
          console.warn('[Monaco] Editor cleanup failed', error);
        }
      }
    }

    /**
     * Creates a Monaco Editor instance inside the given container element.
     * @param {string} containerId - The DOM id of the container element.
     * @param {object} [options] - Editor options.
     * @param {string} [options.language='plaintext'] - Language mode.
     * @param {boolean} [options.readOnly=false] - Read-only mode.
     * @param {string} [options.theme] - Theme name (auto-detected from current app theme if omitted).
     * @param {string} [options.value=''] - Initial editor content.
     * @param {boolean} [options.minimap=false] - Show minimap.
     * @param {boolean|string} [options.lineNumbers=true] - Show line numbers ('on','off','relative').
     * @param {string} [options.wordWrap='on'] - Word wrap mode.
     * @param {boolean} [options.folding=true] - Enable code folding.
     * @returns {Promise<object|null>} The Monaco editor instance, or null if Monaco failed to load.
     */
    async function createMonacoEditor(containerId, options = {}) {
      const generation = claimMonacoContainer(containerId);
      const container = document.getElementById(containerId);
      if (!container) {
        console.warn('[Monaco] Container not found:', containerId);
        return null;
      }

      const monaco = await monacoReady;
      if (!monaco) return null;
      if (monacoContainerGenerations.get(containerId) !== generation ||
          document.getElementById(containerId) !== container ||
          !document.body.contains(container)) {
        const detachedEditors = monacoInstances
          .filter(instance => instance.containerId === containerId &&
            !document.body.contains(instance.container))
          .map(instance => instance.editor);
        for (const editor of detachedEditors) disposeMonacoEditor(editor);
        return null;
      }

      const replacedEditors = monacoInstances
        .filter(instance => instance.containerId === containerId)
        .map(instance => instance.editor);
      for (const editor of replacedEditors) disposeMonacoEditor(editor);

      // Determine current theme
      const resolvedTheme = options.theme || getMonacoTheme();

      const lineNumbers = options.lineNumbers === false ? 'off'
        : options.lineNumbers === true ? 'on'
        : (options.lineNumbers || 'on');

      let editor = null;
      let resizeObserver = null;
      let mutationObserver = null;
      try {
        editor = monaco.editor.create(container, {
          value: options.value || '',
          language: options.language || 'plaintext',
          readOnly: options.readOnly || false,
          theme: resolvedTheme,
          minimap: { enabled: options.minimap === true },
          lineNumbers: lineNumbers,
          wordWrap: options.wordWrap || 'on',
          folding: options.folding !== false,
          automaticLayout: false,
          scrollBeyondLastLine: false,
          fontSize: 12,
          fontFamily: "'DM Mono', monospace",
          renderLineHighlight: 'none',
          overviewRulerBorder: false,
          hideCursorInOverviewRuler: true,
          scrollbar: {
            verticalScrollbarSize: 10,
            horizontalScrollbarSize: 10,
          },
          padding: { top: 8, bottom: 8 },
        });

        // Auto-resize when container resizes
        resizeObserver = new ResizeObserver(() => {
          if (!disposedMonacoEditors.has(editor)) editor.layout();
        });
        resizeObserver.observe(container);

        // Track instance for theme switching and cleanup
        const instance = {
          editor,
          container,
          containerId,
          generation,
          resizeObserver,
          mutationObserver: null
        };
        monacoInstances.push(instance);

        // Cleanup when container is removed from DOM
        mutationObserver = new MutationObserver(() => {
          if (!document.body.contains(container)) {
            disposeMonacoEditor(editor);
          }
        });
        instance.mutationObserver = mutationObserver;
        mutationObserver.observe(document.body, { childList: true, subtree: true });

        return editor;
      } catch (error) {
        console.warn('[Monaco] Editor creation failed; using fallback editor', error);
        resizeObserver?.disconnect();
        mutationObserver?.disconnect();
        disposeMonacoEditor(editor);
        return null;
      }
    }

    /**
     * Returns the Monaco theme name for the current app theme.
     * @returns {string}
     */
    function getMonacoTheme() {
      const dataTheme = document.documentElement.getAttribute('data-theme');
      if (dataTheme === 'light') return 'httptoolkit-light';
      return 'httptoolkit-dark';
    }

    /**
     * Update all active Monaco editors to use the given theme.
     * @param {string} monacoThemeName
     */
    function setMonacoTheme(monacoThemeName) {
      if (monacoApi) {
        monacoApi.editor.setTheme(monacoThemeName);
      }
    }

    // ============ INIT ============
    // Restore send tabs from localStorage
    restoreSendTabs();
    initializeSendTabs();
    document.addEventListener('input', markOpenMockEditDirty);
    document.addEventListener('change', markOpenMockEditDirty);
    window.addEventListener('storage', handleSendTabStorageEvent);
    window.prepareSendTabPersistenceForQuit = persistActiveSendTabBeforeUnload;
    window.prepareRendererForQuit = prepareRendererForQuit;
    window.addEventListener('beforeunload', persistActiveSendTabBeforeUnload);
    window.addEventListener('beforeunload', guardUnsavedMockChangesBeforeUnload);

    // Apply hash-based routing on initial page load
    if (window.location.hash) {
      navigateFromHash();
    } else {
      // Default: set hash to match the initially active panel
      window.location.hash = '#/intercept';
    }

    // Replace empty state content with a proper SVG plug/connection icon (HTTP Toolkit style)
    (function initEmptyState() {
      const el = document.getElementById('emptyState');
      if (el) {
        el.innerHTML = '<div class="empty-icon">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M18 8h1a4 4 0 0 1 0 8h-1"/>' +
            '<path d="M6 8H5a4 4 0 0 0 0 8h1"/>' +
            '<line x1="6" y1="12" x2="18" y2="12"/>' +
          '</svg>' +
        '</div>' +
        '<p style="font-size:16px;line-height:1.3;max-width:420px;">' +
          'Connect a client and intercept some requests,<br>and they\'ll appear here' +
        '</p>';
      }
    })();

    // ============ CUSTOM THEME ============

    // The custom theme <style> element injected into <head>
    var _customThemeStyleEl = null;

    // Known CSS variable names that a custom theme file can override
    var _themeOverridableVars = [
      'bg-main','bg-lowlight','bg-container','bg-input','bg-highlight',
      'highlight-color','border-color','text-main','text-lowlight','text-watermark',
      'text-input-border','pop-color','pop-overlay-color','warning-color','warning-background',
      'primary-input-bg','primary-input-color','secondary-input-border','secondary-input-color',
      'input-hover-bg','input-placeholder-color','input-warning-placeholder',
      'container-watermark','container-border',
      'link-color','visited-link-color',
      'lowlight-text-opacity','box-shadow-alpha','pill-contrast','pill-default-color',
      'modal-color',
      'status-1xx','status-2xx','status-3xx','status-4xx','status-5xx',
      'method-get','method-post','method-delete','method-put','method-patch','method-head','method-options',
      'ink-black','ink-grey','darker-grey','dark-grey','darkish-grey','medium-grey','light-grey',
      'ghost-grey','grey-white','almost-white','darker-blue','lighter-blue',
      'accent','error','success','warning','info'
    ];

    var _themeNumericVars = ['lowlight-text-opacity', 'box-shadow-alpha', 'pill-contrast'];

    function normalizeCustomThemeVarName(key) {
      return String(key).replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase().replace(/^-+/, '');
    }

    function isSafeCustomThemeValue(varName, value) {
      if (typeof value !== 'string') return false;
      var trimmed = value.trim();
      if (!trimmed || trimmed.length > 100 || /[;{}<>"'\\]/.test(trimmed) || /(?:url|var|expression)\s*\(/i.test(trimmed)) {
        return false;
      }
      if (_themeNumericVars.indexOf(varName) !== -1) {
        if (!/^(?:0|1|0?\.\d+)$/.test(trimmed)) return false;
        var numeric = Number(trimmed);
        return Number.isFinite(numeric) && numeric >= 0 && numeric <= 1;
      }
      return typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('color', trimmed);
    }

    function sanitizeCustomThemeData(themeData) {
      var sanitized = {};
      if (!themeData || typeof themeData !== 'object' || Array.isArray(themeData)) return sanitized;
      var keys = Object.keys(themeData);
      for (var i = 0; i < keys.length; i++) {
        var varName = normalizeCustomThemeVarName(keys[i]);
        var value = themeData[keys[i]];
        if (_themeOverridableVars.indexOf(varName) !== -1 && isSafeCustomThemeValue(varName, value)) {
          sanitized[varName] = value.trim();
        }
      }
      return sanitized;
    }

    /**
     * Apply a custom theme object by injecting CSS variable overrides.
     * themeData: object mapping CSS variable names (with or without --) to values.
     */
    function applyCustomThemeData(themeData) {
      var sanitizedTheme = sanitizeCustomThemeData(themeData);
      // Remove old custom style
      if (_customThemeStyleEl) {
        _customThemeStyleEl.remove();
        _customThemeStyleEl = null;
      }
      var lines = [];
      var keys = Object.keys(sanitizedTheme);
      for (var i = 0; i < keys.length; i++) {
        var varName = keys[i];
        lines.push('  --' + varName + ': ' + sanitizedTheme[varName] + ';');
      }
      if (lines.length === 0) return;
      var css = '[data-theme="custom"] {\n' + lines.join('\n') + '\n}';
      _customThemeStyleEl = document.createElement('style');
      _customThemeStyleEl.id = 'custom-theme-style';
      _customThemeStyleEl.textContent = css;
      document.head.appendChild(_customThemeStyleEl);
    }

    /**
     * Render 10 color swatches from a custom theme data object.
     */
    function renderCustomThemeSwatches(themeData) {
      var container = document.getElementById('customThemeSwatches');
      if (!container) return;
      themeData = sanitizeCustomThemeData(themeData);

      // Pick up to 10 color values for preview
      var swatchColors = [];
      var colorKeys = ['bg-main','bg-container','bg-input','text-main','text-lowlight',
        'pop-color','status-2xx','status-5xx','method-get','method-post',
        'warning-color','link-color','darker-blue','lighter-blue','highlight-color'];
      var keys = Object.keys(themeData);
      for (var i = 0; i < keys.length && swatchColors.length < 10; i++) {
        var key = keys[i];
        var varName = normalizeCustomThemeVarName(key);
        var val = themeData[key];
        // Only show values that look like colors
        if (_themeNumericVars.indexOf(varName) === -1 && isSafeCustomThemeValue(varName, val)) {
          swatchColors.push({ name: varName, color: val });
        }
      }
      // If fewer than 10 from user keys, fill from preferred order
      if (swatchColors.length < 10) {
        for (var j = 0; j < colorKeys.length && swatchColors.length < 10; j++) {
          var ck = colorKeys[j];
          var v = themeData[ck] || themeData['--' + ck];
          if (v && isSafeCustomThemeValue(ck, v)) {
            var already = swatchColors.some(function(s) { return s.name === ck; });
            if (!already) swatchColors.push({ name: ck, color: v });
          }
        }
      }

      if (swatchColors.length === 0) {
        container.style.display = 'none';
        return;
      }

      container.textContent = '';
      var previewLabel = document.createElement('div');
      previewLabel.style.cssText = 'font-size:11px;color:var(--text-lowlight);margin-bottom:6px;';
      previewLabel.textContent = 'Theme Preview';
      container.appendChild(previewLabel);
      var swatchRow = document.createElement('div');
      swatchRow.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';
      for (var k = 0; k < swatchColors.length; k++) {
        var s = swatchColors[k];
        var swatch = document.createElement('div');
        swatch.title = s.name + ': ' + s.color;
        swatch.style.cssText = 'width:32px;height:32px;border-radius:4px;' +
          'border:1px solid var(--text-input-border);cursor:default;';
        swatch.style.backgroundColor = s.color;
        swatchRow.appendChild(swatch);
      }
      container.appendChild(swatchRow);
      container.style.display = 'block';
    }

    /**
     * Upload a custom theme file (.htktheme, .htk-theme, .json).
     */
    function uploadCustomTheme() {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = '.htktheme,.htk-theme,.json';
      input.onchange = function(e) {
        var file = e.target.files[0];
        if (!file) return;
        file.text().then(function(text) {
          var themeData;
          try {
            themeData = JSON.parse(text);
          } catch (err) {
            toast('Invalid theme file: not valid JSON', 'error');
            return;
          }
          if (typeof themeData !== 'object' || themeData === null || Array.isArray(themeData)) {
            toast('Invalid theme file: expected a JSON object with color overrides', 'error');
            return;
          }
          // Keep only recognized variables with safe CSS values.
          var sanitizedTheme = sanitizeCustomThemeData(themeData);
          var validCount = Object.keys(sanitizedTheme).length;
          if (validCount === 0) {
            toast('No recognized CSS variable overrides found in theme file', 'error');
            return;
          }
          // Persist both values before applying the theme in memory. If the
          // second write fails, restore the previous custom theme best-effort.
          var previousCustomTheme = safeLocalStorageGet('http-freekit-custom-theme');
          if (!safeLocalStorageSet(
            'http-freekit-custom-theme',
            JSON.stringify(sanitizedTheme),
            false
          )) {
            toast(
              'Custom theme was not saved: local storage is unavailable. Check storage permissions or free up space.',
              'error'
            );
            return;
          }
          if (!safeLocalStorageSet('http-freekit-theme', 'custom', false)) {
            if (previousCustomTheme === null) {
              safeLocalStorageRemove('http-freekit-custom-theme', false);
            } else {
              safeLocalStorageSet('http-freekit-custom-theme', previousCustomTheme, false);
            }
            toast(
              'Custom theme was not saved: local storage is unavailable. Check storage permissions or free up space.',
              'error'
            );
            return;
          }
          applyCustomThemeData(sanitizedTheme);
          renderCustomThemeSwatches(sanitizedTheme);
          setTheme('custom', false);
          var removeBtn = document.getElementById('removeCustomThemeBtn');
          if (removeBtn) removeBtn.style.display = '';
          toast('Custom theme loaded (' + validCount + ' overrides applied)', 'success');
        }).catch(function(err) {
          toast('Failed to read theme file: ' + err.message, 'error');
        });
      };
      input.click();
    }

    /**
     * Remove the current custom theme and revert to dark.
     */
    function removeCustomTheme() {
      var previousTheme = safeLocalStorageGet('http-freekit-theme', 'dark');
      if (!safeLocalStorageSet('http-freekit-theme', 'dark', false) ||
          !safeLocalStorageRemove('http-freekit-custom-theme', false)) {
        safeLocalStorageSet('http-freekit-theme', previousTheme, false);
        toast(
          'Custom theme was not removed: local storage is unavailable. Check storage permissions or free up space.',
          'error'
        );
        return;
      }
      if (_customThemeStyleEl) {
        _customThemeStyleEl.remove();
        _customThemeStyleEl = null;
      }
      var swatches = document.getElementById('customThemeSwatches');
      if (swatches) { swatches.innerHTML = ''; swatches.style.display = 'none'; }
      var removeBtn = document.getElementById('removeCustomThemeBtn');
      if (removeBtn) removeBtn.style.display = 'none';
      setTheme('dark', false);
      toast('Custom theme removed', 'success');
    }

    /**
     * Show/hide the custom theme section based on dropdown value.
     */
    function updateCustomThemeSection(theme) {
      var section = document.getElementById('customThemeSection');
      if (!section) return;
      section.style.display = (theme === 'custom') ? 'block' : 'none';
      if (theme === 'custom') {
        var saved = safeLocalStorageGet('http-freekit-custom-theme');
        if (saved) {
          try {
            var data = JSON.parse(saved);
            renderCustomThemeSwatches(data);
            var removeBtn = document.getElementById('removeCustomThemeBtn');
            if (removeBtn) removeBtn.style.display = '';
          } catch (e) { /* ignore */ }
        }
      }
    }

    function setTheme(theme, persist = true) {
      if (persist) safeLocalStorageSet('http-freekit-theme', theme);
      var resolved = theme;
      if (theme === 'auto') {
        resolved = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
      }
      if (theme === 'custom') {
        resolved = 'custom';
        // Ensure custom theme CSS is injected
        var savedCustom = safeLocalStorageGet('http-freekit-custom-theme');
        if (savedCustom) {
          try { applyCustomThemeData(JSON.parse(savedCustom)); } catch (e) { /* ignore */ }
        }
      } else {
        // Remove custom theme style when switching away
        if (_customThemeStyleEl) {
          _customThemeStyleEl.remove();
          _customThemeStyleEl = null;
        }
      }
      document.documentElement.setAttribute('data-theme', resolved);
      var sel = document.getElementById('themeSelect');
      if (sel) sel.value = theme;

      // Show/hide custom theme section
      updateCustomThemeSection(theme);

      // Sync Monaco editor theme
      setMonacoTheme(resolved === 'light' ? 'httptoolkit-light' : 'httptoolkit-dark');
    }

    function loadTheme() {
      var saved = safeLocalStorageGet('http-freekit-theme', 'dark');
      // If custom was saved but no theme data exists, fall back to dark
      if (saved === 'custom' && !safeLocalStorageGet('http-freekit-custom-theme')) {
        saved = 'dark';
      }
      setTheme(saved, false);
    }

    // Re-apply theme when OS color scheme changes (for "auto" mode)
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', function() {
      var saved = safeLocalStorageGet('http-freekit-theme', 'dark');
      if (saved === 'auto') setTheme('auto', false);
    });

    loadTheme();
    connectWebSocket();

    // ============ AUTO-UPDATER UI ============
    (function initAutoUpdaterUI() {
      if (!window.electronApi || !window.electronApi.onUpdaterStatus) return;

      let updateVersion = null;
      let lastUpdaterStatusKey = null;
      let installUpdateRequestPending = false;

      function setInstallUpdateActionPending(pending, label) {
        installUpdateRequestPending = pending;
        const button = document.getElementById('installUpdateBtn');
        if (!button) return;
        button.setAttribute('aria-disabled', pending ? 'true' : 'false');
        button.textContent = label || 'Restart to install';
      }

      function handleUpdaterStatus(data) {
        if (!data || typeof data.status !== 'string') return;
        const statusKey = JSON.stringify(data);
        if (statusKey === lastUpdaterStatusKey) return;
        lastUpdaterStatusKey = statusKey;
        switch (data.status) {
          case 'checking':
            if (data.manual) toast('Checking for updates...', 'success');
            break;
          case 'check-deferred':
            if (data.manual) toast('Update check queued until the current update action finishes', 'success');
            break;
          case 'update-available':
            updateVersion = data.version;
            toast('Update v' + data.version + ' available', 'success');
            break;
          case 'update-available-linux':
            updateVersion = data.version;
            showLinuxUpdateToast(data.version, data.url);
            break;
          case 'download-started':
            toast('Downloading update v' + data.version + '...', 'success');
            break;
          case 'downloading':
            // Optionally show download progress (silent for now to avoid spam)
            break;
          case 'update-downloaded':
            showUpdateReadyToast(data.version);
            break;
          case 'up-to-date':
            if (data.manual) toast('HTTP FreeKit is up to date', 'success');
            break;
          case 'update-dismissed':
            if (data.manual) toast('Update postponed', 'success');
            break;
          case 'install-canceled':
            setInstallUpdateActionPending(false);
            showUpdateReadyToast(data.version || updateVersion);
            if (data.manual) toast('Update restart canceled', 'success');
            break;
          case 'error':
            setInstallUpdateActionPending(false);
            if (data.manual) toast('Update check failed: ' + (data.error || 'unknown error'), 'error');
            break;
        }
      }

      window.electronApi.onUpdaterStatus(handleUpdaterStatus);
      if (window.electronApi.getUpdaterStatus) {
        window.electronApi.getUpdaterStatus()
          .then(handleUpdaterStatus)
          .catch(function(err) { console.error('[Updater]', err.message); });
      }

      function showUpdateReadyToast(version) {
        if (document.getElementById('installUpdateBtn')) return;
        var container = document.getElementById('toastContainer');
        var t = document.createElement('div');
        t.className = 'toast toast-success';
        t.innerHTML = 'Update v' + escapeHtml(version) + ' ready. <a href="#" class="toast-action" id="installUpdateBtn">Restart to install</a>';
        container.appendChild(t);
        var btn = t.querySelector('#installUpdateBtn');
        if (btn) {
          btn.addEventListener('click', async function(e) {
            e.preventDefault();
            if (installUpdateRequestPending) return;
            setInstallUpdateActionPending(true, 'Preparing restart…');
            try {
              const result = await window.electronApi.installUpdate();
              if (result?.started) {
                setInstallUpdateActionPending(true, 'Restarting…');
              } else if (result?.inProgress) {
                setInstallUpdateActionPending(true, 'Restart pending…');
              } else {
                setInstallUpdateActionPending(false);
              }
            } catch (error) {
              setInstallUpdateActionPending(false);
              toast('Could not restart for update: ' + error.message, 'error');
            }
          });
        }
        // Don't auto-dismiss — let user decide when to restart
      }

      function showLinuxUpdateToast(version, url) {
        var container = document.getElementById('toastContainer');
        var t = document.createElement('div');
        t.className = 'toast toast-success';
        t.innerHTML = 'Update v' + escapeHtml(version) + ' available. <a href="' + escapeHtml(url) + '" target="_blank" rel="noopener" class="toast-action">Download</a>';
        container.appendChild(t);
        setTimeout(function() {
          t.classList.add('toast-exit');
          t.addEventListener('animationend', function() { t.remove(); });
          setTimeout(function() { if (t.parentNode) t.remove(); }, 400);
        }, 15000);
      }

      function escapeHtml(str) {
        var d = document.createElement('div');
        d.textContent = str;
        return d.innerHTML;
      }

      // Expose manual check for Settings page
      window._checkForUpdates = function() {
        window.electronApi.checkForUpdates();
      };

      // Show the "Check for Updates" button in Settings
      var updateRow = document.getElementById('updateCheckRow');
      if (updateRow) updateRow.style.display = '';
    })();

    // cURL paste detection on Send URL input
    document.getElementById('sendUrl')?.addEventListener('paste', (e) => {
      const text = (e.clipboardData || window.clipboardData).getData('text').trim();
      if (text.toLowerCase().startsWith('curl ')) {
        e.preventDefault();
        const parsed = parseCurlCommand(text);
        if (parsed) {
          document.getElementById('sendUrl').value = parsed.url;
          document.getElementById('sendMethod').value = parsed.method;
          if (typeof updateSendMethodColor === 'function') updateSendMethodColor();
          if (Object.keys(parsed.headers).length > 0) {
            loadSendHeadersFromJson(JSON.stringify(parsed.headers));
          }
          if (parsed.body) {
            setSendBodyValue(parsed.body);
          }
          saveSendTabState();
          renderSendTabs();
          scheduleSendExportUpdate();
          toast('cURL command parsed!', 'success');
        }
      }
    });

    // Resizer for Send panel split pane
    (function setupSendResizer() {
      const resizer = document.getElementById('sendResizer');
      setupSplitPaneResizer({
        resizer,
        pane: resizer?.previousElementSibling,
        controlledAfter: false,
        minWidth: 250,
        otherMinWidth: 250,
        minHeight: 200,
        otherMinHeight: 200,
        initialWidth: 350,
        initialHeight: 300
      });
    })();
