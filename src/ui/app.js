    // ============ STATE ============
    let ws = null;
    let requests = [];
    let filteredRequests = [];
    let selectedRequestId = null;
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

    // ============ WEBSOCKET FRAMES STATE ============
    /** Map of parentId -> [frame request objects] for WS frame sub-rows */
    let wsFramesByParent = {};
    /** Set of WS connection IDs that are expanded to show frame sub-rows */
    const wsExpandedConnections = new Set();

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
        throw new Error(payload.error || `Management API returned HTTP ${response.status}`);
      }
      return response;
    };

    // ============ WEBSOCKET ============
    let wsReconnectDelay = 1000;

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
          loadMockRules().then(() => ensureDefaultMockRules());
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
          const deepLinkMatch = window.location.hash.match(/^#\/view\/(.+)$/);
          if (deepLinkMatch) {
            const deepLinkId = deepLinkMatch[1];
            setTimeout(() => {
              if (requests.find(r => r.id === deepLinkId)) {
                selectRequest(deepLinkId);
              }
            }, 1500);
          }
          break;
        }
        case 'request':
          if (!isPaused) {
            addRequest(msg.data);
          }
          break;
        case 'request-update':
          // Update an existing request in-place (pending → complete)
          if (msg.data?.id) {
            const idx = requests.findIndex(r => r.id === msg.data.id);
            if (idx !== -1) {
              requests[idx] = msg.data;
              applyFilter();
              // If this request is currently selected, refresh the detail view
              if (selectedRequestId === msg.data.id) {
                document.getElementById('detailPanel')._request = msg.data;
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
          requests = requests.filter(r => r.pinned);
          wsFramesByParent = {};
          filteredRequests = [];
          requestCounter = requests.length;
          vsRenderStart = -1;
          vsRenderEnd = -1;
          renderTraffic();
          if (!requests.find(r => r.id === selectedRequestId)) closeDetail();
          break;
        case 'traffic-dump':
          requests = msg.requests;
          requestCounter = requests.length;
          applyFilter();
          break;
        case 'traffic-imported':
          toast(`Imported ${msg.count} requests`, 'success');
          break;
        case 'breakpoint-hit':
          updateBreakpointBanner();
          {
            const viewTab = document.querySelector('.sidebar-item[data-panel="traffic"]');
            if (viewTab && !document.getElementById('panel-traffic')?.classList.contains('active')) {
              switchPanel(viewTab, 'traffic');
            }
          }
          selectBreakpointRequest(msg.requestId);
          break;
        case 'breakpoint-resumed':
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
            setTimeout(() => selectRequest(msg.requestId, false), 200);
          }
          toast('Request selected by AI', 'success');
          break;
      }
    }

    // ============ TRAFFIC ============
    function addRequest(req) {
      requestCounter++;
      req._index = requestCounter;
      requests.push(req);

      // Track WS frames by parent for sub-row rendering
      if (req.protocol === 'ws-frame' && req.parentId) {
        if (!wsFramesByParent[req.parentId]) wsFramesByParent[req.parentId] = [];
        wsFramesByParent[req.parentId].push(req);
      }

      // Keep max 10000
      if (requests.length > 10000) requests.shift();
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
      wsFramesByParent = {};
      requests.forEach(r => {
        if (r.protocol === 'ws-frame' && r.parentId) {
          if (!wsFramesByParent[r.parentId]) wsFramesByParent[r.parentId] = [];
          wsFramesByParent[r.parentId].push(r);
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
        if (r.protocol === 'ws' && wsExpandedConnections.has(r.id)) {
          const frames = wsFramesByParent[r.id] || [];
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

    function matchesAllFilters(req, filters) {
      return filters.every(f => matchesFilter(req, f));
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
          const [hName, hVal] = val.split('=');
          if (hVal !== undefined) {
            const reqHeader = req.requestHeaders?.[hName] || req.responseHeaders?.[hName] || '';
            return reqHeader.toLowerCase().includes(hVal);
          }
          return !!(req.requestHeaders?.[hName] || req.responseHeaders?.[hName]);
        }
        case 'text':
        default:
          // Search across all fields
          return req.url?.toLowerCase().includes(val) ||
            req.method?.toLowerCase().includes(val) ||
            req.host?.toLowerCase().includes(val) ||
            String(req.statusCode).includes(val) ||
            req.path?.toLowerCase().includes(val) ||
            (req.source || '').toLowerCase().includes(val);
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

    function buildRowHtml(req, index) {
      // ---- WebSocket frame sub-row ----
      if (req.protocol === 'ws-frame') {
        const selected = req.id === selectedRequestId ? 'selected' : '';
        const dirArrow = req.direction === 'client' ? '&rarr;' : '&larr;';
        const dirClass = req.direction === 'client' ? 'ws-frame-client' : 'ws-frame-server';
        const preview = esc((req.requestBody || '').substring(0, 80)) + (req.requestBody && req.requestBody.length > 80 ? '...' : '');
        const byteCount = formatSize(req.requestBodySize);
        const opName = esc(req.opcodeName || 'data');
        return `<tr class="ws-frame-row ${dirClass} ${selected}" id="row-${req.id}" role="row" aria-rowindex="${index + 1}" aria-selected="${req.id === selectedRequestId}" data-id="${req.id}" onclick="selectRequest('${req.id}')">
          <td role="gridcell" style="padding:0;width:5px;"><div class="row-marker" style="color:#4caf7d;"></div></td>
          <td role="gridcell" colspan="2" style="padding-left:24px;"><span class="ws-frame-dir">${dirArrow}</span> <span class="ws-frame-opcode">${opName}</span></td>
          <td role="gridcell" style="font-size:11px;color:var(--text-lowlight);">${byteCount}</td>
          <td role="gridcell" colspan="2" class="ws-frame-preview" title="${esc(req.requestBody || '')}">${preview || '<span style="color:var(--text-watermark);">empty</span>'}</td>
        </tr>`;
      }

      // ---- TLS error row (italic, 28px, centered text) ----
      if (req.protocol === 'tls-error') {
        const selected = req.id === selectedRequestId ? 'selected' : '';
        const source = req.source || 'tls-error';
        const sourceIcon = SOURCE_ICONS[source] || SOURCE_ICONS['tls-error'];
        return `<tr class="tls-error-row ${selected}" id="row-${req.id}" role="row" aria-rowindex="${index + 1}" aria-selected="${req.id === selectedRequestId}" data-id="${req.id}" onclick="selectRequest('${req.id}')">
          <td role="gridcell" style="padding:0;width:5px;"><div class="row-marker" style="color:#ce3939;"></div></td>
          <td role="gridcell"><span class="method-badge method-CONNECT">TLS</span></td>
          <td role="gridcell"><span class="status-badge status-5xx">ERR</span></td>
          <td role="gridcell" class="source-cell"><span class="source-icon source-tls-error" title="TLS Error">${sourceIcon}</span></td>
          <td role="gridcell" colspan="2" style="text-align:center;" title="${esc(req.error || req.responseBody || '')}">${esc(req.host || '-')} — ${esc(req.error || req.responseBody || 'TLS Handshake Failed')}</td>
        </tr>`;
      }

      // ---- Tunnel row (italic, 28px, centered text) ----
      if (req.protocol === 'tunnel') {
        const selected = req.id === selectedRequestId ? 'selected' : '';
        const source = req.source || 'tunnel';
        const sourceIcon = SOURCE_ICONS[source] || SOURCE_ICONS.tunnel;
        const bytesSent = formatSize(req.requestBodySize || 0);
        const bytesRecv = formatSize(req.responseBodySize || 0);
        return `<tr class="tunnel-row ${selected}" id="row-${req.id}" role="row" aria-rowindex="${index + 1}" aria-selected="${req.id === selectedRequestId}" data-id="${req.id}" onclick="selectRequest('${req.id}')">
          <td role="gridcell" style="padding:0;width:5px;"><div class="row-marker" style="color:#888;"></div></td>
          <td role="gridcell"><span class="method-badge method-CONNECT">TUNNEL</span></td>
          <td role="gridcell"><span class="status-badge status-2xx">200</span></td>
          <td role="gridcell" class="source-cell"><span class="source-icon source-tunnel" title="Tunnel">${sourceIcon}</span></td>
          <td role="gridcell" colspan="2" style="text-align:center;" title="Tunnel to ${esc(req.host || '-')}:${req.remote?.port || 443}">${esc(req.host || '-')} — ${bytesSent} / ${bytesRecv}</td>
        </tr>`;
      }

      // ---- Standard row ----
      const methodClass = req.protocol === 'ws' ? 'method-WS' : `method-${req.method}`;
      let statusClass = req.statusCode === null || req.statusCode === undefined ? 'status-pending' :
        req.error ? 'status-err' :
        req.statusCode < 200 ? 'status-1xx' :
        req.statusCode < 300 ? 'status-2xx' :
        req.statusCode < 400 ? 'status-3xx' :
        req.statusCode < 500 ? 'status-4xx' : 'status-5xx';
      if (req.protocol === 'ws') {
        statusClass = 'status-2xx';
      }
      const source = req.source || 'proxy';
      const sourceIcon = SOURCE_ICONS[source] || SOURCE_ICONS.proxy;
      const selected = req.id === selectedRequestId ? 'selected' : '';
      const markerColor = req.source === 'breakpoint' ? '#f1971f' :
        ['POST','PUT','DELETE','PATCH'].includes(req.method) ? '#ce3939' :
        source === 'mock' ? '#6e40aa' : '#888';
      const statusHtml = req.statusCode === null || req.statusCode === undefined
        ? '<span class="status-badge status-pending" title="Pending..."><svg width="14" height="14" viewBox="0 0 16 16" style="animation:spin 0.8s linear infinite;"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="28 10" stroke-linecap="round" opacity="0.8"/></svg></span>'
        : req.source === 'breakpoint' && req.statusCode === 0
        ? '<span class="status-badge status-breakpoint" title="Paused at breakpoint">&#9208;</span>'
        : `<span class="status-badge ${statusClass}">${req.statusCode || 'ERR'}</span>`;
      const pinIcon = req.pinned ? '<span class="row-pin" title="Pinned">&#128204;</span>' : '';

      // WS connection: add frame count badge and expand toggle
      let wsFrameBadge = '';
      if (req.protocol === 'ws') {
        const frameCount = (wsFramesByParent[req.id] || []).length;
        const isExpanded = wsExpandedConnections.has(req.id);
        const expandIcon = isExpanded ? '&#9660;' : '&#9654;';
        if (frameCount > 0) {
          wsFrameBadge = `<span class="ws-expand-toggle" onclick="event.stopPropagation();toggleWsExpand('${req.id}')" title="${isExpanded ? 'Collapse' : 'Expand'} ${frameCount} frames">${expandIcon}</span><span class="ws-frame-count">${frameCount}</span>`;
        }
      }

      return `<tr class="${selected}" id="row-${req.id}" role="row" aria-rowindex="${index + 1}" aria-selected="${req.id === selectedRequestId}" data-id="${req.id}" onclick="selectRequest('${req.id}')" oncontextmenu="showTrafficContextMenu(event, '${req.id}')">
        <td role="gridcell" style="padding:0;width:5px;"><div class="row-marker" style="color:${markerColor};"></div></td>
        <td role="gridcell">${pinIcon}${wsFrameBadge}<span class="method-badge ${methodClass}">${req.protocol === 'ws' ? 'WS' : esc(req.method)}</span></td>
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
      if (totalRows === 0) { tbody.innerHTML = ''; return; }

      const scrollTop = wrapper.scrollTop;
      const clientHeight = wrapper.clientHeight;

      const firstVisible = Math.floor(scrollTop / VS_ROW_HEIGHT);
      const lastVisible = Math.min(totalRows, Math.ceil((scrollTop + clientHeight - VS_HEADER_HEIGHT) / VS_ROW_HEIGHT));

      const renderStart = Math.max(0, firstVisible - VS_BUFFER);
      const renderEnd = Math.min(totalRows, lastVisible + VS_BUFFER);

      // Skip re-render if range and selection haven't changed
      if (!vsForceRender && renderStart === vsRenderStart && renderEnd === vsRenderEnd) return;

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
      const trafficTable = document.querySelector('.traffic-table');
      if (trafficTable) trafficTable.setAttribute('aria-rowcount', String(filteredRequests.length));

      const query = document.getElementById('searchInput').value.trim();
      const visibleTotal = requests.filter(r =>
        r.protocol !== 'ws-frame' &&
        (!hideTunnelRequests || !isTunnelRequest(r)) &&
        (!filterSafeFonts || !isSafeFontRequest(r))
      ).length;
      if (query && filteredRequests.length !== visibleTotal) {
        countEl.textContent = filteredRequests.length + ' / ' + visibleTotal;
        if (footerFilter) {
          footerFilter.textContent = '(' + filteredRequests.length + ' shown)';
        }
      } else {
        countEl.textContent = filteredRequests.length;
        if (footerFilter) footerFilter.textContent = '';
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

    function updateTrafficActiveDescendant(id) {
      const tbody = document.getElementById('trafficBody');
      if (tbody) tbody.setAttribute('aria-activedescendant', id ? 'row-' + id : '');
    }

    function selectRequest(id, toggle = true) {
      if (selectedRequestId === id && toggle) {
        closeDetail();
        return;
      }
      selectedRequestId = id;
      updateTrafficActiveDescendant(id);
      if (window.location.hash.startsWith('#/view') || window.location.hash.startsWith('#/traffic')) {
        history.replaceState(null, '', '#/view/' + id);
      }
      const req = requests.find(r => r.id === id);
      if (!req) return;

      // Scroll selected row into view (center alignment)
      const idx = filteredRequests.findIndex(r => r.id === id);
      if (idx !== -1) {
        scrollRowIntoView(idx, 'center');
      }

      // Re-render virtual rows to update selection highlight
      vsForceRender = true;
      renderVirtualRows();

      showDetail(req);
    }

    function selectBreakpointRequest(requestId, attempts = 0) {
      if (!requestId) return;
      const req = requests.find(r => r.id === requestId);
      if (req) {
        if (selectedRequestId !== requestId) {
          selectRequest(requestId);
        }
        return;
      }
      if (attempts < 5) {
        setTimeout(() => selectBreakpointRequest(requestId, attempts + 1), 100);
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

    function closeDetail() {
      const emptyEl = document.getElementById('detailEmptyState');
      const activeEl = document.getElementById('detailActive');
      if (emptyEl) emptyEl.style.display = 'flex';
      if (activeEl) activeEl.style.display = 'none';
      selectedRequestId = null;
      // Re-render to remove selection highlight
      vsForceRender = true;
      renderVirtualRows();
      if (window.location.hash.startsWith('#/view/')) {
        history.replaceState(null, '', '#/view');
      }
    }

    // ============ DETAIL FOOTER ACTIONS ============
    function scrollToSelectedRequest() {
      if (!selectedRequestId) return;
      const idx = filteredRequests.findIndex(r => r.id === selectedRequestId);
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

    function togglePinRequest() {
      if (!selectedRequestId) return;
      const req = requests.find(r => r.id === selectedRequestId);
      if (req) {
        req.pinned = !req.pinned;
        updatePinIcon(req.pinned);
        renderTraffic();
        toast(req.pinned ? 'Exchange pinned' : 'Exchange unpinned', 'success');
      }
    }

    function updatePinIcon(pinned) {
      const icon = document.getElementById('pinBtnIcon');
      if (icon) icon.style.transform = pinned ? 'none' : 'rotate(45deg)';
    }

    function deleteSelectedRequest() {
      if (!selectedRequestId) return;
      const idx = requests.findIndex(r => r.id === selectedRequestId);
      if (idx !== -1) {
        const req = requests[idx];
        if (req.pinned) { toast('Unpin this exchange before deleting', 'error'); return; }
        if (!confirm('Are you sure you want to delete this request?')) return;
        requests.splice(idx, 1);
        closeDetail();
        applyFilter();
        toast('Exchange deleted', 'success');
      }
    }

    function resendSelectedRequest(requestId = selectedRequestId) {
      if (!requestId) return;
      const req = requests.find(r => r.id === requestId);
      if (!req) return;

      // Save current tab state before creating a new one
      saveSendTabState();

      // Build headers list for the new tab
      const newHeaders = [];
      if (req.requestHeaders && Object.keys(req.requestHeaders).length > 0) {
        const skip = ['host', 'proxy-connection', 'content-length', 'connection', 'accept-encoding'];
        for (const [k, v] of Object.entries(req.requestHeaders)) {
          if (!skip.includes(k.toLowerCase())) {
            newHeaders.push({ key: k, value: Array.isArray(v) ? v.join(', ') : String(v), enabled: true });
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
      sendTabCounter++;
      const newTab = {
        id: 'tab-' + sendTabCounter,
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
      const content = document.getElementById('detailContent');
      const methodColor = {GET:'#4caf7d',POST:'#ff8c38',DELETE:'#ce3939',PUT:'#6e40aa',PATCH:'#dd3a96',HEAD:'#5a80cc',OPTIONS:'#2fb4e0'}[req.method] || '#888';
      const statusColor = req.error ? '#ce3939' : req.statusCode < 200 ? '#888' : req.statusCode < 300 ? '#4caf7d' : req.statusCode < 400 ? '#5a80cc' : req.statusCode < 500 ? '#ff8c38' : '#ce3939';

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
      if (req.source === 'breakpoint' && req.statusCode === 0) {
        const draft = getBreakpointEditDraft(req);
        const responsePhase = draft._phase === 'response';
        const breakpointFields = responsePhase ? `
              <div class="breakpoint-edit-row">
                <span class="breakpoint-edit-label">Status</span>
                <span class="breakpoint-edit-value" ondblclick="editBreakpointField('${req.id}', 'status')">${draft.status}</span>
              </div>
              <div class="breakpoint-edit-row">
                <span class="breakpoint-edit-label">Headers</span>
                <pre class="breakpoint-edit-value breakpoint-edit-pre" ondblclick="editBreakpointField('${req.id}', 'headers')">${esc(JSON.stringify(draft.headers, null, 2))}</pre>
              </div>
              <div class="breakpoint-edit-row">
                <span class="breakpoint-edit-label">Body</span>
                <pre class="breakpoint-edit-value breakpoint-edit-pre" ondblclick="editBreakpointField('${req.id}', 'body')">${esc(draft.body || '')}</pre>
              </div>` : `
              <div class="breakpoint-edit-row">
                <span class="breakpoint-edit-label">Method</span>
                <span class="breakpoint-edit-value" ondblclick="editBreakpointField('${req.id}', 'method')">${esc(draft.method)}</span>
              </div>
              <div class="breakpoint-edit-row">
                <span class="breakpoint-edit-label">URL</span>
                <span class="breakpoint-edit-value" ondblclick="editBreakpointField('${req.id}', 'url')">${esc(draft.url)}</span>
              </div>
              <div class="breakpoint-edit-row">
                <span class="breakpoint-edit-label">Headers</span>
                <pre class="breakpoint-edit-value breakpoint-edit-pre" ondblclick="editBreakpointField('${req.id}', 'headers')">${esc(JSON.stringify(draft.headers, null, 2))}</pre>
              </div>
              <div class="breakpoint-edit-row">
                <span class="breakpoint-edit-label">Body</span>
                <pre class="breakpoint-edit-value breakpoint-edit-pre" ondblclick="editBreakpointField('${req.id}', 'body')">${esc(draft.body || '')}</pre>
              </div>`;
        html += `<div class="detail-card" style="border-left:4px solid #f1971f;background:#f1971f11;">
          <div class="detail-card-body" style="padding:16px 20px;">
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
              <span style="font-size:20px;">&#9208;</span>
              <div style="flex:1;">
                <div style="font-weight:bold;color:#f1971f;margin-bottom:4px;">${responsePhase ? 'Response' : 'Request'} Paused at Breakpoint</div>
                <div style="font-size:12px;color:var(--text-lowlight);">Double-click a field to edit it before resuming.</div>
              </div>
              <button class="btn btn-primary" onclick="resumeBreakpointRequest('${req.id}')" style="padding:8px 20px;">
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
                <div id="wsFramePayload-monaco" style="min-height:80px;"></div>
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
          initBodyMonacoEditor('wsFramePayload-monaco', req.requestBody, 'text/plain', lang === 'json' ? 'json' : 'text');
        }
        return;
      }

      // ---- WebSocket Card ----
      if (req.protocol === 'ws') {
        const wsSourceLabel = req.source || 'Unknown';
        const wsSourceIconHtml = SOURCE_ICONS[wsSourceLabel] || SOURCE_ICONS['Other'] || '';
        html += `<div class="detail-card dir-right" style="border-right-color:#4caf7d;">
          <div class="detail-card-header">
            <span style="margin-left:auto;display:flex;align-items:center;gap:8px;">
              <span class="source-icon" title="${esc(wsSourceLabel)}" style="display:inline-flex;opacity:0.7;">${wsSourceIconHtml}</span>
              <span class="detail-pill" style="background:#4caf7d;color:#fff;">WS</span>
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
            ${req.remote?.address ? '<div style="margin-top:12px;font-size:12px;color:var(--text-lowlight);">Remote: ' + esc(req.remote.address) + ':' + (req.remote.port || '') + '</div>' : ''}
          </div>
        </div>`;

        // ---- Stream Message List Card ----
        const frames = wsFramesByParent[req.id] || [];
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
                  return `<div class="ws-msg-row ${dirCls}${isClose ? ' ws-msg-close' : ''}" onclick="selectRequest('${f.id}')" title="Click to view details">
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
        const portStr = req.remote?.port || 443;

        html += `<div class="detail-card" style="border-left:4px solid #888;background:rgba(136,136,136,0.07);">
          <div class="detail-card-body" style="padding:16px 20px;">
            <div style="display:flex;align-items:center;gap:12px;">
              <span style="font-size:20px;color:#888;">${SOURCE_ICONS.tunnel}</span>
              <div style="flex:1;">
                <div style="font-weight:bold;color:var(--text-main);margin-bottom:4px;">Raw Tunnel</div>
                <div style="font-size:13px;color:var(--text-main);margin-bottom:4px;">${esc(req.host || '-')}:${portStr}</div>
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
              <div class="detail-summary-item"><div class="detail-summary-label">Port</div><div class="detail-summary-value">${portStr}</div></div>
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
      const httpVersion = req.protocol === 'h2' ? 'HTTP/2' : req.protocol === 'https' ? 'HTTPS/1.1' : 'HTTP/1.1';
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
        const reqCt = effReq.requestHeaders?.['content-type'] || '';
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
              <pre class="body-content" id="reqBody-fallback" style="display:${reqUseMonaco ? 'none' : 'block'};">${reqUseMonaco ? '' : formatBodyAs(effBody, reqCt, reqDefaultMode)}</pre>
            </div>
          </div>
        </div>`;
      }

      // ---- Response Card (border-left, pills left, heading right) ----
      html += `<div class="detail-card dir-left" id="card-response" aria-expanded="true" style="border-left-color:${statusColor};">
        <div class="detail-card-header">
          <span style="margin-left:auto;display:flex;align-items:center;gap:8px;">
            <span class="detail-pill" style="background:${statusColor};color:#fff;">${req.statusCode || 'ERR'}</span>
            <span class="detail-card-heading">Response</span>
            <span class="collapse-chevron">&#9650;</span>
          </span>
        </div>
        <div class="detail-card-body">
          <div class="detail-card-section">
            <div class="section-label">Status</div>
            <div style="font-family:var(--font-mono);font-size:13px;">${req.statusCode || 'ERR'} ${esc(req.statusMessage || '')}</div>
          </div>
          <div class="detail-card-section">
            <div class="section-label">Headers</div>
            ${renderHeadersGrid(req.responseHeaders, 'response')}
          </div>
        </div>
      </div>`;

      // ---- Response Body Card (separate card) ----
      if (req.responseBody && req.responseBody !== '') {
        const ct = req.responseHeaders?.['content-type'] || '';
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
              <pre class="body-content response-body-resizable" id="resBody-fallback" style="display:${resUseMonaco ? 'none' : 'block'};">${resUseMonaco ? '' : formatBodyAs(req.responseBody, ct, resDefaultMode)}</pre>
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
      const resEncoding = req.responseHeaders?.['content-encoding'] || '';
      const resCt = (req.responseHeaders?.['content-type'] || '').toLowerCase();
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
      const cacheControl = req.responseHeaders?.['cache-control'] || '';
      const expires = req.responseHeaders?.['expires'] || '';
      const etag = req.responseHeaders?.['etag'] || '';
      const lastMod = req.responseHeaders?.['last-modified'] || '';

      html += '<div style="margin-top:16px;"><div class="section-label">Caching</div>';
      if (cacheControl) {
        const directives = cacheControl.split(',').map(d => d.trim());
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
              ${req.remote?.address ? `<span style="color:var(--text-watermark);">Remote:</span>
              <span style="font-family:var(--font-mono);">${esc(req.remote.address)}:${req.remote.port || ''}</span>` : ''}
            </div>
          </div>`;
      } else if (req.protocol === 'https' && req.tls) {
        html += `<div style="margin-top:12px;">
            <div class="section-label">Connection</div>
            <div style="display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12px;">
              <span style="color:var(--text-watermark);">Protocol:</span>
              <span style="font-family:var(--font-mono);">HTTPS (${esc(req.tls.version || 'TLS')})</span>
              ${req.tls.cipher ? `<span style="color:var(--text-watermark);">Cipher:</span>
              <span style="font-family:var(--font-mono);">${esc(req.tls.cipher)}</span>` : ''}
              ${req.remote?.address ? `<span style="color:var(--text-watermark);">Remote:</span>
              <span style="font-family:var(--font-mono);">${esc(req.remote.address)}:${req.remote.port || ''}</span>` : ''}
            </div>
          </div>`;
      } else if (req.protocol === 'http') {
        html += `<div style="margin-top:12px;">
            <div class="section-label">Connection</div>
            <div style="display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12px;">
              <span style="color:var(--text-watermark);">Protocol:</span>
              <span style="font-family:var(--font-mono);">HTTP (unencrypted)</span>
              ${req.remote?.address ? `<span style="color:var(--text-watermark);">Remote:</span>
              <span style="font-family:var(--font-mono);">${esc(req.remote.address)}:${req.remote.port || ''}</span>` : ''}
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
        const reqCt2 = effReq.requestHeaders?.['content-type'] || '';
        const reqModes2 = getBodyViewModes(effBody, reqCt2);
        const reqDefMode2 = reqModes2[0]?.value || 'text';
        renderBodyViewer('reqBody', effBody, reqCt2, reqDefMode2, { request: effReq, section: 'request' });
      }

      // Initialize the response body viewer
      if (req.responseBody && req.responseBody !== '' && !req.responseBody.startsWith('[Binary data:')) {
        const resCt = req.responseHeaders?.['content-type'] || '';
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

    function powerShellStringLiteral(value) {
      return `'${String(value ?? '').replace(/'/g, "''")}'`;
    }

    function phpStringLiteral(value) {
      return `'${String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
    }

    function getExportHeaders(req, omitContentType = false) {
      return Object.entries(req.requestHeaders || {}).filter(([key]) => {
        const lowerKey = key.toLowerCase();
        return lowerKey !== 'host' && lowerKey !== 'proxy-connection' && (!omitContentType || lowerKey !== 'content-type');
      });
    }

    function generateMultipartExportSnippet(req, format) {
      const fields = getExportFormFields(req);
      const headers = getExportHeaders(req, true);
      const method = String(req.method || 'POST');
      const url = String(req.url || '');

      if (format === 'curl') {
        let cmd = `curl -X '${shellSingleQuote(method)}' '${shellSingleQuote(url)}'`;
        headers.forEach(([key, value]) => { cmd += ` \\\n  -H '${shellSingleQuote(key)}: ${shellSingleQuote(value)}'`; });
        fields.forEach((field) => {
          const value = field.type === 'file'
            ? `@${field.file?.name || field.fileName || 'file'}${field.fileType ? `;type=${field.fileType}` : ''}`
            : (field.value || '');
          cmd += ` \\\n  -F '${shellSingleQuote(field.key)}=${shellSingleQuote(value)}'`;
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
        code += `const options = {\n  method: ${JSON.stringify(method)},\n  hostname: target.hostname,\n  port: target.port || undefined,\n  path: target.pathname + target.search,\n  headers: {\n`;
        headers.forEach(([key, value]) => { code += `    ${JSON.stringify(key)}: ${JSON.stringify(String(value))},\n`; });
        code += `    'Content-Type': 'multipart/form-data; boundary=' + boundary,\n    'Content-Length': body.length\n  }\n};\n\n`;
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
        headers.forEach(([key, value]) => { code += `\treq.Header.Set(${JSON.stringify(key)}, ${JSON.stringify(String(value))})\n`; });
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
        return generateExportSnippet({ ...req, bodyType: 'raw', requestHeaders: headers, requestBody: params.toString() }, format);
      }
      if (req.bodyType === 'multipart') return generateMultipartExportSnippet(req, format);

      const method = String(req.method || 'GET');
      const url = String(req.url || '');
      const body = String(req.requestBody ?? '');
      const headers = getExportHeaders(req);
      const hasBody = body.length > 0;

      switch (format) {
        case 'curl': {
          let cmd = `curl -X '${shellSingleQuote(method)}' '${shellSingleQuote(url)}'`;
          for (const [key, value] of headers) {
            cmd += ` \\\n  -H '${shellSingleQuote(`${key}: ${value}`)}'`;
          }
          if (hasBody) cmd += ` \\\n  -d '${shellSingleQuote(body)}'`;
          return cmd;
        }
        case 'python': {
          let code = `import requests\n\n`;
          code += `response = requests.request(\n    ${JSON.stringify(method)},\n    ${JSON.stringify(url)}`;
          if (headers.length) {
            code += `,\n    headers={\n${headers.map(([key, value]) => `        ${JSON.stringify(key)}: ${JSON.stringify(String(value))}`).join(',\n')}\n    }`;
          }
          if (hasBody) code += `,\n    data=${JSON.stringify(body)}`;
          code += `\n)\n\nprint(response.status_code)\nprint(response.text)`;
          return code;
        }
        case 'javascript-fetch': {
          let code = `const response = await fetch(${JSON.stringify(url)}, {\n  method: ${JSON.stringify(method)}`;
          if (headers.length) {
            code += `,\n  headers: {\n${headers.map(([key, value]) => `    ${JSON.stringify(key)}: ${JSON.stringify(String(value))}`).join(',\n')}\n  }`;
          }
          if (hasBody) code += `,\n  body: ${JSON.stringify(body)}`;
          code += `\n});\n\nconst data = await response.text();\nconsole.log(response.status, data);`;
          return code;
        }
        case 'javascript-node': {
          let code = `const https = require('https');\nconst http = require('http');\n\n`;
          code += `const target = new URL(${JSON.stringify(url)});\n`;
          code += `const options = {\n  method: ${JSON.stringify(method)},\n  hostname: target.hostname,\n  path: target.pathname + target.search,\n  port: target.port || undefined`;
          if (headers.length) {
            code += `,\n  headers: {\n${headers.map(([key, value]) => `    ${JSON.stringify(key)}: ${JSON.stringify(String(value))}`).join(',\n')}\n  }`;
          }
          code += `\n};\n\nconst request = (target.protocol === 'https:' ? https : http).request(options, (response) => {\n  let data = '';\n  response.on('data', chunk => data += chunk);\n  response.on('end', () => console.log(response.statusCode, data));\n});\n`;
          if (hasBody) code += `request.write(${JSON.stringify(body)});\n`;
          code += `request.end();`;
          return code;
        }
        case 'powershell': {
          let code = `$headers = @{}\n`;
          for (const [key, value] of headers) {
            code += `$headers[${powerShellStringLiteral(key)}] = ${powerShellStringLiteral(value)}\n`;
          }
          code += `\n$response = Invoke-WebRequest -Uri ${powerShellStringLiteral(url)} -Method ${powerShellStringLiteral(method)} -Headers $headers`;
          if (hasBody) code += ` -Body ${powerShellStringLiteral(body)}`;
          code += `\n$response.StatusCode\n$response.Content`;
          return code;
        }
        case 'wget': {
          let cmd = `wget --method='${shellSingleQuote(method)}'`;
          for (const [key, value] of headers) {
            cmd += ` \\\n  --header='${shellSingleQuote(`${key}: ${value}`)}'`;
          }
          if (hasBody) cmd += ` \\\n  --body-data='${shellSingleQuote(body)}'`;
          cmd += ` \\\n  '${shellSingleQuote(url)}'`;
          return cmd;
        }
        case 'php': {
          let code = `<?php\n$ch = curl_init();\ncurl_setopt($ch, CURLOPT_URL, ${phpStringLiteral(url)});\ncurl_setopt($ch, CURLOPT_CUSTOMREQUEST, ${phpStringLiteral(method)});\ncurl_setopt($ch, CURLOPT_RETURNTRANSFER, true);\n`;
          if (headers.length) {
            code += `curl_setopt($ch, CURLOPT_HTTPHEADER, [\n${headers.map(([key, value]) => `    ${phpStringLiteral(`${key}: ${value}`)}`).join(',\n')}\n]);\n`;
          }
          if (hasBody) code += `curl_setopt($ch, CURLOPT_POSTFIELDS, ${phpStringLiteral(body)});\n`;
          code += `$response = curl_exec($ch);\n$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);\ncurl_close($ch);\necho $httpCode . "\\n" . $response;\n?>`;
          return code;
        }
        case 'go': {
          let code = `package main\n\nimport (\n\t"fmt"\n\t"io"\n\t"net/http"\n`;
          if (hasBody) code += `\t"strings"\n`;
          code += `)\n\nfunc main() {\n`;
          if (hasBody) {
            code += `\tbody := strings.NewReader(${JSON.stringify(body)})\n`;
            code += `\treq, _ := http.NewRequest(${JSON.stringify(method)}, ${JSON.stringify(url)}, body)\n`;
          } else {
            code += `\treq, _ := http.NewRequest(${JSON.stringify(method)}, ${JSON.stringify(url)}, nil)\n`;
          }
          for (const [key, value] of headers) {
            code += `\treq.Header.Set(${JSON.stringify(key)}, ${JSON.stringify(String(value))})\n`;
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
        fallback.style.display = 'none';
      }
      disposeBodyEditor(monacoId);
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
        if (!editor) {
          if (fallback) fallback.style.display = 'block';
          return;
        }
        activeBodyEditors[monacoId] = editor;
        const container = document.getElementById(monacoId);
        if (!container) return;
        autoSizeExportEditor(editor, container);
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

      sendExportCreating = true;
      const editor = await createMonacoEditor('sendExportContent-monaco', {
        value: snippet,
        language: exportFormatToMonacoLanguage(format),
        readOnly: true,
        minimap: false,
        lineNumbers: true,
        wordWrap: 'on',
        folding: true,
      });
      sendExportCreating = false;

      if (!editor) {
        container.style.display = 'none';
        fallback.style.display = 'block';
        return;
      }

      activeBodyEditors['sendExportContent-monaco'] = editor;
      const latestFormat = document.getElementById('sendExportFormat')?.value || 'curl';
      const latestSnippet = generateExportSnippet(getCurrentSendExportRequest(), latestFormat);
      editor.setValue(latestSnippet);
      if (monacoApi) monacoApi.editor.setModelLanguage(editor.getModel(), exportFormatToMonacoLanguage(latestFormat));
      fallback.style.display = 'none';
      autoSizeExportEditor(editor, container);
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
          const ctxMenu = section ? ` oncontextmenu="showHeaderContextMenu(event, '${safeKey}', '${section}')"` : '';
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
            result += '<span style="color:#4caf7d;">' + esc(decodeURIComponent(key)) + '</span>';
            result += '<span style="color:var(--text-watermark);"> = </span>';
            result += '<span style="color:#ff8c38;">' + esc(decodeURIComponent(value)) + '</span>\n';
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
        const saved = localStorage.getItem(PROTOBUF_SCHEMA_STORAGE_KEY);
        protobufSchemaFiles = saved ? JSON.parse(saved) : [];
        if (!Array.isArray(protobufSchemaFiles)) protobufSchemaFiles = [];
      } catch {
        protobufSchemaFiles = [];
      }
      rebuildProtobufRoot();
    }

    function saveProtobufSchemas() {
      localStorage.setItem(PROTOBUF_SCHEMA_STORAGE_KEY, JSON.stringify(protobufSchemaFiles));
      rebuildProtobufRoot();
    }

    function refreshVisibleBodyViewers() {
      const req = document.getElementById('detailPanel')?._request;
      if (req && selectedRequestId === req.id) renderDetailCards(req);
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
          protobufSchemaFiles = Array.from(byName.values());
          saveProtobufSchemas();
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
      protobufSchemaFiles = [];
      protobufRoot = null;
      protobufSchemaError = '';
      for (const key of Object.keys(bodySchemaTypeOverrides)) delete bodySchemaTypeOverrides[key];
      localStorage.removeItem(PROTOBUF_SCHEMA_STORAGE_KEY);
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
        ? (effectiveReq.requestHeaders?.['content-type'] || '')
        : (req.responseHeaders?.['content-type'] || '');
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

    function bodyToBytes(body) {
      if (!body) return new Uint8Array();
      const dataUriMatch = String(body).match(/^data:([^;,]+(?:;[^,]*)?);base64,([A-Za-z0-9+/=\r\n]+)$/);
      if (dataUriMatch) {
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
      const bytes = bodyToBytes(body);
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
      const bytes = bodyToBytes(body);
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

    function formatBodyAs(body, contentType, mode) {
      if (!body) return '<span style="color:var(--text-watermark);">Empty</span>';
      if (body.startsWith('[Binary data:')) return '<span style="color:var(--text-watermark);">' + esc(body) + '</span>';

      switch (mode) {
        case 'image': {
          if (body.startsWith('data:image/')) {
            return '<div style="display:flex;align-items:center;justify-content:center;padding:20px;background:var(--bg-lowlight);border-radius:4px;">' +
              '<img src="' + body + '" style="max-width:100%;max-height:60vh;object-fit:contain;border-radius:4px;box-shadow:0 2px 10px rgba(0,0,0,0.3);" alt="Response image">' +
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
              const dk = esc(decodeURIComponent(key));
              const dv = esc(decodeURIComponent(value));
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
          return wrapWithLineNumbers(esc(decodeGrpcBody(body)));
        }
        case 'protobuf': {
          return wrapWithLineNumbers(esc(decodeProtobufBody(body)));
        }
        case 'hex': {
          // Hex already has its own offset column — no extra line numbers
          return textToHex(body);
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
      const existing = activeBodyEditors[containerId];
      if (existing) {
        existing.dispose();
        delete activeBodyEditors[containerId];
      }
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
      if (!container) return;

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

      if (editor) {
        activeBodyEditors[containerId] = editor;

        // Auto-size editor height based on content (capped at 70vh)
        const lineCount = editor.getModel().getLineCount();
        const lineHeight = 18;
        const padding = 16;
        const maxHeight = Math.round(window.innerHeight * 0.7);
        const desiredHeight = Math.min(Math.max(lineCount * lineHeight + padding, 80), maxHeight);
        container.style.height = desiredHeight + 'px';
        editor.layout();
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
        // Show Monaco container, hide fallback
        const monacoEl = document.getElementById(monacoId);
        const fallbackEl = document.getElementById(fallbackId);
        if (monacoEl) monacoEl.style.display = 'block';
        if (fallbackEl) fallbackEl.style.display = 'none';

        initBodyMonacoEditor(monacoId, body, ct, mode, renderContext);
      } else {
        // Dispose any active Monaco editor
        const monacoId2 = elementId + '-monaco';
        disposeBodyEditor(monacoId2);

        const monacoEl = document.getElementById(monacoId);
        const fallbackEl = document.getElementById(fallbackId);
        if (monacoEl) monacoEl.style.display = 'none';

        if (fallbackEl) {
          fallbackEl.style.display = 'block';
          fallbackEl.innerHTML = formatBodyAs(body, ct, mode);
        } else {
          // Fallback for request body or old-style rendering
          wrapper.dataset.viewMode = mode;
          wrapper.innerHTML = formatBodyAs(body, ct, mode);
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
        ? (effectiveReq.requestHeaders?.['content-type'] || '')
        : (req.responseHeaders?.['content-type'] || '');

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

    function textToHex(text) {
      const bytes = bodyToBytes(text);
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
      'fresh-terminal': ['Open a new terminal that intercepts all processes & Docker containers.', 'Sets HTTP_PROXY, HTTPS_PROXY and certificate trust environment variables.'],
      'existing-terminal': ['Configure future processes in an existing terminal window.', 'Instructions only: unset the variables or close that shell to stop.'],
      'system-proxy': ['Intercept all HTTP traffic on this machine.', 'Routes all system traffic through the proxy.'],
      'docker': ['Intercept traffic from Docker containers.', 'Set proxy environment variables when running containers.'],
      'electron': ['Launch an Electron application with traffic intercepted.', 'Uses proxy and certificate flags to intercept all HTTPS traffic.'],
      'android-adb': ['Intercept traffic from an Android device connected via ADB.', 'Pushes a CA certificate and configures the device proxy settings.'],
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
      'fresh-terminal': ['terminal', 'cli', 'docker', 'node', 'python'],
      'existing-terminal': ['terminal', 'cli', 'docker', 'node', 'python'],
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

    // Interceptors that have expandable config components
    const EXPANDABLE_INTERCEPTORS = new Set(['docker', 'existing-terminal', 'electron', 'android-adb', 'jvm']);
    function renderConnectedSources(interceptors = allInterceptors) {
      const active = interceptors.filter(i => i.active);
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
        pid: event.pid || null
      };
      if (!event.active && expandedInterceptorId === event.id) {
        collapseInterceptorCard();
        return;
      }
      renderConnectedSources(allInterceptors);
      filterInterceptors();
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
          if (i.id === 'android-adb' && expandedInterceptorMetadata?.activatedDevices?.length > 0) {
            const deviceNames = expandedInterceptorMetadata.activatedDevices.map(d => d.model || d.serial).join(', ');
            pillHtml = `<span class="intercept-pill pill-active">Activated \u00b7 ${esc(deviceNames)}</span>`;
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
          card.onkeydown = (e) => { if (e.key === 'Enter') card.click(); };
        } else if (BROWSER_DOWNLOAD_URLS[i.id]) {
          // Not installed — offer to download
          card.classList.remove('disabled');
          card.setAttribute('tabindex', '0');
          card.setAttribute('role', 'button');
          card.style.cursor = 'pointer';
          card.onclick = () => downloadBrowser(i.id, i.name);
          card.onkeydown = (e) => { if (e.key === 'Enter') card.click(); };
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
        toast(`Proxy: 127.0.0.1:${proxyPort} - Configure any HTTP client to use this proxy`, 'success');
      };
      manualCard.onkeydown = (e) => { if (e.key === 'Enter') manualCard.click(); };
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
          expandedInterceptorMetadata = data.metadata || null;
        } catch (err) {
          interceptorsInProgress.delete(id);
          filterInterceptors();
          toast(`Error: ${err.message}`, 'error');
          return;
        } finally {
          interceptorsInProgress.delete(id);
        }
        // Refresh interceptor state
        try {
          const res = await fetch(`${API_BASE}/api/interceptors`);
          const data = await res.json();
          allInterceptors = data.interceptors;
          renderConnectedSources(allInterceptors);
        } catch (e) { console.error('[Error]', e.message); }
      }

      expandedInterceptorId = id;
      filterInterceptors();
    }

    function collapseInterceptorCard() {
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
          <div style="display:flex;gap:8px;align-items:center;">
            <input id="electronAppPath" type="text" placeholder="Path to Electron executable" aria-label="Electron application path"
              onclick="event.stopPropagation();" style="flex:1;min-width:0;background:var(--bg-input);border:1px solid var(--text-input-border);border-radius:4px;color:var(--text-main);padding:7px 9px;font-family:var(--font-mono);font-size:12px;">
            <button class="android-refresh-btn" onclick="event.stopPropagation(); browseElectronApp();">Browse</button>
          </div>
          <button class="jvm-process-activate" style="margin-top:10px;" onclick="event.stopPropagation(); launchElectronApp();">
            Launch &amp; intercept
          </button>
        </div>
      `;
    }

    async function browseElectronApp() {
      const input = document.getElementById('electronAppPath');
      if (!input) return;
      if (!window.electronApi?.selectFilePath) {
        input.focus();
        toast('Enter the Electron executable path', 'success');
        return;
      }
      const selectedPath = await window.electronApi.selectFilePath({
        title: 'Select Electron application'
      });
      if (selectedPath) input.value = selectedPath;
    }

    async function launchElectronApp() {
      const input = document.getElementById('electronAppPath');
      const appPath = input?.value.trim();
      if (!appPath) {
        toast('Select an Electron application first', 'error');
        return;
      }
      if (interceptorsInProgress.has('electron')) return;

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
        toast('Electron application launched', 'success');
        collapseInterceptorCard();
        const trafficTab = document.querySelector('.sidebar-item[data-panel="traffic"]');
        if (trafficTab) switchPanel(trafficTab, 'traffic');
        setTimeout(loadInterceptors, 300);
      } catch (err) {
        toast(`Error: ${err.message}`, 'error');
      } finally {
        interceptorsInProgress.delete('electron');
        filterInterceptors();
      }
    }

    function renderDockerConfig(container) {
      const meta = expandedInterceptorMetadata;
      const proxyUrl = meta?.proxyUrl || `http://172.17.0.1:${config.proxyPort || 8000}`;
      const runCmd = meta?.instructions?.run || `docker run -e HTTP_PROXY=${proxyUrl} -e HTTPS_PROXY=${proxyUrl} -e NODE_TLS_REJECT_UNAUTHORIZED=0 <image>`;
      const composeCmd = meta?.instructions?.compose || `environment:\n  - HTTP_PROXY=${proxyUrl}\n  - HTTPS_PROXY=${proxyUrl}\n  - NODE_TLS_REJECT_UNAUTHORIZED=0`;

      container.innerHTML = `
        <div class="config-section">
          <h3>Docker Run</h3>
          <div class="config-code-block" onclick="copyConfigCode(this)" title="Click to copy">${esc(runCmd)}</div>
        </div>
        <div class="config-section">
          <h3>Docker Compose</h3>
          <div class="config-code-block" onclick="copyConfigCode(this)" title="Click to copy">${esc(composeCmd)}</div>
        </div>
      `;
    }

    function renderTerminalConfig(container) {
      const meta = expandedInterceptorMetadata;
      const proxyUrl = meta?.proxyUrl || `http://127.0.0.1:${config.proxyPort || 8000}`;
      const certPath = meta?.certPath || '';
      const instructions = meta?.instructions || {
        bash: `export HTTP_PROXY=${proxyUrl} HTTPS_PROXY=${proxyUrl} NODE_EXTRA_CA_CERTS="${certPath}" NODE_TLS_REJECT_UNAUTHORIZED=0`,
        powershell: `$env:HTTP_PROXY="${proxyUrl}"; $env:HTTPS_PROXY="${proxyUrl}"; $env:NODE_EXTRA_CA_CERTS="${certPath}"; $env:NODE_TLS_REJECT_UNAUTHORIZED="0"`,
        cmd: `set HTTP_PROXY=${proxyUrl}&& set HTTPS_PROXY=${proxyUrl}&& set NODE_EXTRA_CA_CERTS=${certPath}&& set NODE_TLS_REJECT_UNAUTHORIZED=0`
      };

      // Detect default shell
      const platform = navigator.platform.toLowerCase();
      let defaultTab = 'bash';
      if (platform.includes('win')) defaultTab = 'powershell';

      container.innerHTML = `
        <div class="config-section">
          <h3>Paste in your terminal</h3>
          <p style="color:var(--text-watermark);font-size:12px;margin:0 0 10px;">${esc(meta?.lifecycleNote || 'These variables remain active until you unset them or close this shell.')}</p>
          <div class="config-tabs">
            <button class="config-tab${defaultTab === 'bash' ? ' active' : ''}" onclick="event.stopPropagation(); switchConfigTab(this, 'bash')">Bash / Zsh</button>
            <button class="config-tab${defaultTab === 'powershell' ? ' active' : ''}" onclick="event.stopPropagation(); switchConfigTab(this, 'powershell')">PowerShell</button>
            <button class="config-tab${defaultTab === 'cmd' ? ' active' : ''}" onclick="event.stopPropagation(); switchConfigTab(this, 'cmd')">CMD</button>
          </div>
          <div class="config-code-block" id="terminalConfigCode" onclick="copyConfigCode(this)" title="Click to copy">${esc(instructions[defaultTab])}</div>
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
      navigator.clipboard.writeText(text).then(() => {
        toast('Copied to clipboard!', 'success');
      }).catch(() => {
        toast('Failed to copy', 'error');
      });
    }

    function renderAndroidConfig(container) {
      const meta = expandedInterceptorMetadata;
      const devices = meta?.devices || [];
      const activatedDevices = meta?.activatedDevices || [];
      const activatedSerials = new Set(
        activatedDevices.map(d => d.serial)
      );
      const activationBySerial = new Map(activatedDevices.map(d => [d.serial, d]));
      const qrHtml = meta?.qrAvailable && meta?.qrImageDataUrl
        ? `
          <div class="config-section">
            <h3>Scan QR</h3>
            <div class="android-qr-layout">
              <img class="android-qr-image" src="${esc(meta.qrImageDataUrl)}" alt="Android setup QR code">
              <div class="android-qr-details">
                <p class="android-setup-note">Open the HTTP Toolkit Android app and scan this code.</p>
                <div class="config-code-block android-qr-url" onclick="copyConfigCode(this)" title="Click to copy">${esc(meta.qrConnectUrl || '')}</div>
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
          <p class="android-setup-note">Uses the HTTP Toolkit Android VPN app when installed, then falls back to Android's global proxy setting.</p>
          <div class="android-device-list">
            ${devices.map(d => {
              const isActivated = activatedSerials.has(d.serial);
              const activation = activationBySerial.get(d.serial);
              const isUnauthorized = d.status === 'unauthorized';
              const isOffline = d.status === 'offline';
              const modeLabel = activation?.mode === 'http-toolkit-app' ? 'VPN app' : 'Global proxy';
              return `
                <div class="android-device-item${isActivated ? ' activated' : ''}" data-device-id="${esc(d.serial)}">
                  <div class="android-device-info">
                    <i class="ph ph-device-mobile"></i>
                    <div class="android-device-details">
                      <span class="android-device-model">${esc(d.model || d.serial)}</span>
                      <span class="android-device-serial">${esc(d.serial)}${d.deviceName ? ' \u00b7 ' + esc(d.deviceName) : ''}</span>
                      ${isActivated ? `<span class="android-device-mode">${esc(modeLabel)}</span>` : ''}
                    </div>
                  </div>
                  <div class="android-device-actions">
                    ${isActivated
                      ? '<span class="intercept-pill pill-active" style="margin:0;">Activated</span>'
                      : isUnauthorized
                        ? '<span class="android-device-status status-warning">Unauthorized</span>'
                        : isOffline
                          ? '<span class="android-device-status status-offline">Offline</span>'
                          : `<button class="android-device-activate" onclick="event.stopPropagation(); activateAndroidDevice('${esc(d.serial)}');">Activate</button>`
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

    async function activateAndroidDevice(deviceId) {
      if (interceptorsInProgress.has('android-adb')) return;
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
          body: JSON.stringify({ deviceId })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        // Update metadata with fresh device and activation info
        if (data.metadata) {
          expandedInterceptorMetadata = {
            ...expandedInterceptorMetadata,
            devices: data.metadata.devices || expandedInterceptorMetadata?.devices || [],
            activatedDevices: data.metadata.activatedDevices || expandedInterceptorMetadata?.activatedDevices || []
          };
        }

        // Re-render the config area
        const container = document.getElementById('interceptConfig-android-adb');
        if (container) {
          renderAndroidConfig(container);
        }

        // Refresh interceptor list for pill update
        try {
          const r = await fetch(`${API_BASE}/api/interceptors`);
          const d = await r.json();
          allInterceptors = d.interceptors;
          renderConnectedSources(allInterceptors);
        } catch (e) { console.error('[Error]', e.message); }

        toast(`Android device ${data.metadata?.model || deviceId} activated`, 'success');
      } catch (err) {
        toast(`Error: ${err.message}`, 'error');
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = 'Activate';
        }
      } finally {
        interceptorsInProgress.delete('android-adb');
        filterInterceptors();
      }
    }

    async function refreshAndroidDevices() {
      try {
        const res = await fetch(`${API_BASE}/api/interceptors/android-adb/activate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        });
        const data = await res.json();
        if (data.metadata) {
          expandedInterceptorMetadata = {
            ...expandedInterceptorMetadata,
            devices: data.metadata.devices || [],
            activatedDevices: data.metadata.activatedDevices || expandedInterceptorMetadata?.activatedDevices || []
          };
        }
        const container = document.getElementById('interceptConfig-android-adb');
        if (container) {
          renderAndroidConfig(container);
        }
        toast('Device list refreshed', 'success');
      } catch (err) {
        toast(`Error refreshing devices: ${err.message}`, 'error');
      }
    }

    function renderJvmConfig(container) {
      const meta = expandedInterceptorMetadata;
      const processes = meta?.processes || [];
      const activatedPids = new Set(
        (meta?.activatedProcesses || []).map(p => p.pid)
      );

      const proxyPort = config.proxyPort || 8000;
      const fallbackCmd = `-Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=${proxyPort} -Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort=${proxyPort}`;

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
              <h3>Or launch with proxy flags</h3>
              <div class="config-code-block" onclick="copyConfigCode(this)" title="Click to copy">${esc(fallbackCmd)}</div>
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
            <h3>Or launch with proxy flags</h3>
            <div class="config-code-block" onclick="copyConfigCode(this)" title="Click to copy">${esc(fallbackCmd)}</div>
          </div>
          <button class="android-refresh-btn" onclick="event.stopPropagation(); refreshJvmProcesses();">
            <i class="ph ph-arrows-clockwise"></i> Refresh Processes
          </button>
        </div>
      `;
    }

    async function activateJvmProcess(pid) {
      if (interceptorsInProgress.has('jvm')) return;
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
        if (data.error) throw new Error(data.error);

        // Update metadata with fresh process and activation info
        if (data.metadata) {
          expandedInterceptorMetadata = {
            ...expandedInterceptorMetadata,
            processes: data.metadata.processes || expandedInterceptorMetadata?.processes || [],
            activatedProcesses: data.metadata.activatedProcesses || expandedInterceptorMetadata?.activatedProcesses || []
          };
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
          allInterceptors = d.interceptors;
          renderConnectedSources(allInterceptors);
        } catch (e) { console.error('[Error]', e.message); }

        toast(`JVM process ${data.metadata?.name || pid} attached`, 'success');
      } catch (err) {
        toast(`Error: ${err.message}`, 'error');
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = 'Attach';
        }
      } finally {
        interceptorsInProgress.delete('jvm');
        filterInterceptors();
      }
    }

    async function refreshJvmProcesses() {
      try {
        const res = await fetch(`${API_BASE}/api/interceptors/jvm/activate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        });
        const data = await res.json();
        if (data.metadata) {
          expandedInterceptorMetadata = {
            ...expandedInterceptorMetadata,
            processes: data.metadata.processes || [],
            activatedProcesses: data.metadata.activatedProcesses || expandedInterceptorMetadata?.activatedProcesses || []
          };
        }
        const container = document.getElementById('interceptConfig-jvm');
        if (container) {
          renderJvmConfig(container);
        }
        toast('Process list refreshed', 'success');
      } catch (err) {
        toast(`Error refreshing processes: ${err.message}`, 'error');
      }
    }

    async function focusInterceptor(id) {
      const interceptor = allInterceptors.find(i => i.id === id);
      const name = interceptor?.name || id;
      try {
        const res = await fetch(`${API_BASE}/api/interceptors/${id}/focus`, { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
        toast(`Focused ${name}`, 'success');
      } catch (err) {
        toast(`Could not focus ${name}: ${err.message}`, 'error');
      }
    }

    async function deactivateInterceptor(id) {
      if (interceptorsInProgress.has(id)) return;

      const interceptor = allInterceptors.find(i => i.id === id);
      const name = interceptor?.name || id;
      try {
        interceptorsInProgress.add(id);
        filterInterceptors();
        const res = await fetch(`${API_BASE}/api/interceptors/${id}/deactivate`, { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
        toast(`Stopped ${name}`, 'success');
        setTimeout(loadInterceptors, 300);
      } catch (err) {
        toast(`Error: ${err.message}`, 'error');
      } finally {
        interceptorsInProgress.delete(id);
        filterInterceptors();
      }
    }

    async function toggleInterceptor(id, isActive) {
      if (interceptorsInProgress.has(id)) return;

      try {
        if (isActive) {
          await deactivateInterceptor(id);
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

            toast(`Launched ${id}`, 'success');
            // Auto-switch to Traffic view on successful activation (like HTTP Toolkit)
            const trafficTab = document.querySelector('.sidebar-item[data-panel="traffic"]');
            if (trafficTab) switchPanel(trafficTab, 'traffic');
          } finally {
            interceptorsInProgress.delete(id);
          }
        }
        setTimeout(loadInterceptors, 500);
      } catch (err) {
        interceptorsInProgress.delete(id);
        filterInterceptors();
        toast(`Error: ${err.message}`, 'error');
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
    let mockDragId = null;
    let mockRenamingRuleId = null;

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

    async function clearAllMockRules() {
      if (mockRules.length === 0) return;
      try {
        await fetch(API_BASE + '/api/mock-rules', { method: 'DELETE' });
        mockDraftRules.clear();
        mockNewDraftIds.clear();
        toast('All rules cleared', 'success');
        loadMockRules();
      } catch (err) {
        toast('Error: ' + err.message, 'error');
      }
    }

    function collapseAllMockRules() {
      mockExpandedRules.clear();
      mockEditingRule = null;
      mockEditDraft = null;
      renderMockRules();
    }

    function mockDragStart(e, ruleId) {
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

    function mockDrop(e, targetId) {
      e.preventDefault();
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

      const [moved] = mockRules.splice(fromIdx, 1);
      mockRules.splice(toIdx, 0, moved);

      const ids = mockRules.map(r => r.id);
      fetch(API_BASE + '/api/mock-rules/reorder', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ ids })
      }).catch(err => console.error('Reorder failed:', err));

      renderMockRules();
      document.querySelectorAll('.mock-rule-card').forEach(c => c.classList.remove('mock-drag-over', 'mock-drag-combine', 'mock-rule-dragging'));
    }

    async function combineRulesAsGroup(ruleId1, ruleId2) {
      try {
        // Create a new group
        const res = await fetch(API_BASE + '/api/mock-rules/group', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ title: 'New Group' })
        });
        const data = await res.json();
        const groupId = data.group?.id;
        if (!groupId) throw new Error('Failed to create group');

        // Move both rules into the group
        await fetch(API_BASE + '/api/mock-rules/move-to-group', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ ruleId: ruleId1, groupId })
        });
        await fetch(API_BASE + '/api/mock-rules/move-to-group', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ ruleId: ruleId2, groupId })
        });

        toast('Rules combined into a group (hold Shift + drop)', 'success');
        loadMockRules();
      } catch (err) {
        toast('Error: ' + err.message, 'error');
      }
    }

    function mockDragEnd(e) {
      mockDragId = null;
      document.querySelectorAll('.mock-rule-card').forEach(c => c.classList.remove('mock-drag-over', 'mock-drag-combine', 'mock-rule-dragging'));
    }

    function renameMockRule(ruleId) {
      startInlineRename(ruleId);
    }

    function startInlineRename(ruleId) {
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
      try {
        const res = await fetch(`${API_BASE}/api/mock-rules`);
        const data = await res.json();
        mockRules = data.rules || [];
        // Re-add any new draft rules that haven't been saved to server yet
        for (const [draftId, draft] of mockDraftRules) {
          if (mockNewDraftIds.has(draftId)) {
            // New draft not on server — add to local list
            if (!mockRules.some(r => r.id === draftId)) {
              mockRules.push(draft);
            }
          } else {
            // Existing rule with unsaved changes — overlay draft onto local copy
            _applyDraftToLocal(draftId, draft);
          }
        }
        updateMockSaveButtons();
        await loadBreakpointRules();
        renderMockRules();
      } catch (e) { console.error('[Error]', e.message); }
    }

    async function ensureDefaultMockRules() {
      if (mockRules.length > 0 || localStorage.getItem('http-freekit-defaults-created')) return;

      // Create a default passthrough rule
      try {
        await fetch(API_BASE + '/api/mock-rules', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({
            title: 'Default: Pass through all requests',
            enabled: true,
            priority: 'normal',
            matchers: [{ type: 'method', value: '*' }],
            action: { type: 'passthrough' }
          })
        });
        localStorage.setItem('http-freekit-defaults-created', 'true');
        await loadMockRules();
      } catch (e) { console.error('[Error]', e.message); }
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
      const isExpanded = mockExpandedRules.has(rule.id);
      const isEditing = mockEditingRule === rule.id;
      const isDraft = mockDraftRules.has(rule.id);
      const summary = mockRuleSummary(rule);
      const color = MOCK_METHOD_COLORS[summary.methodStr] || MOCK_METHOD_COLORS['*'];
      const disabledClass = rule.enabled === false ? ' mock-rule-disabled' : '';
      const editingClass = isEditing ? ' mock-rule-editing' : '';
      const draftClass = isDraft ? ' mock-rule-draft' : '';

      let html = '<div class="mock-rule-card' + disabledClass + editingClass + draftClass + '" data-rule-id="' + rule.id + '" aria-expanded="' + (isExpanded || isEditing) + '" draggable="true" ondragstart="mockDragStart(event, \'' + rule.id + '\')" ondragover="mockDragOver(event)" ondrop="mockDrop(event, \'' + rule.id + '\')" ondragend="mockDragEnd(event)">';

      html += '<div class="mock-rule-summary" onclick="toggleMockRuleExpand(\'' + rule.id + '\')">';
      html += '<span class="mock-drag-handle" title="Drag to reorder">&#10303;</span>';
      html += '<div class="mock-rule-icon" style="background:' + color + ';"></div>';
      html += '<span class="method-badge method-' + (summary.methodStr === 'ANY' ? 'OPTIONS' : summary.methodStr) + '" style="font-size:11px;flex-shrink:0;">' + summary.methodStr + '</span>';
      const isRenaming = mockRenamingRuleId === rule.id;
      if (isRenaming) {
        const inputVal = esc(rule.title || '').replace(/"/g, '&quot;');
        const placeholderVal = esc(summary.matchStr).replace(/"/g, '&quot;');
        html += '<span class="mock-rule-desc" onclick="event.stopPropagation()">';
        html += '<input id="mock-rename-input" class="mock-rename-input" type="text" value="' + inputVal + '" placeholder="' + placeholderVal + '" onkeydown="handleRenameKeydown(event, \'' + rule.id + '\')" onblur="confirmInlineRename(\'' + rule.id + '\')" onclick="event.stopPropagation()" />';
      } else if (summary.title) {
        html += '<span class="mock-rule-desc" onclick="event.stopPropagation(); startInlineRename(\'' + rule.id + '\')" title="Click to rename"><span class="mock-rule-title">' + esc(summary.title) + '</span>';
      } else {
        html += '<span class="mock-rule-desc">' + summary.matchStr;
      }
      html += '<span class="mock-arrow">\u2192</span>' + summary.actionStr;
      html += '</span>';

      html += '<div class="mock-rule-actions" onclick="event.stopPropagation()">';

      // 1. Collapse/Expand (chevron)
      const chevron = isExpanded || isEditing ? '&#9650;' : '&#9660;';
      const collapseTitle = isExpanded || isEditing ? 'Collapse rule' : 'Show rule details';
      html += '<button class="mock-toggle-btn" onclick="toggleMockRuleExpand(\'' + rule.id + '\')" title="' + collapseTitle + '" aria-label="' + collapseTitle + '">';
      html += '<span style="font-size:10px;">' + chevron + '</span>';
      html += '</button>';

      // 2. Save to server (when draft) or Save draft (when editing) or Edit (pencil icon)
      if (isDraft && !isEditing) {
        html += '<button class="mock-toggle-btn mock-save-server" onclick="saveOneMockRule(\'' + rule.id + '\')" title="Save to server" aria-label="Save to server">';
        html += '<i class="ph ph-floppy-disk" style="font-size:14px;"></i>';
        html += '</button>';
      }
      if (isEditing) {
        html += '<button class="mock-toggle-btn mock-enabled" onclick="saveMockRule(\'' + rule.id + '\')" title="Save as draft" aria-label="Save as draft">';
        html += '<i class="ph ph-floppy-disk" style="font-size:14px;"></i>';
        html += '</button>';
      } else {
        html += '<button class="mock-toggle-btn" onclick="editMockRule(\'' + rule.id + '\')" title="Edit this rule" aria-label="Edit this rule">';
        html += '<i class="ph ph-pencil-simple" style="font-size:14px;"></i>';
        html += '</button>';
      }

      // 3. Enable/Disable
      const toggleLabel = rule.enabled !== false ? 'Disable this rule' : 'Enable this rule';
      html += '<button class="mock-toggle-btn' + (rule.enabled !== false ? ' mock-enabled' : '') + '" onclick="toggleMockRuleEnabled(\'' + rule.id + '\')" title="' + toggleLabel + '" aria-label="' + toggleLabel + '">';
      html += rule.enabled !== false
        ? '<i class="ph ph-toggle-right" style="font-size:14px;"></i>'
        : '<i class="ph ph-toggle-left" style="font-size:14px;"></i>';
      html += '</button>';

      // 4. Rename (tag icon)
      html += '<button class="mock-toggle-btn" onclick="renameMockRule(\'' + rule.id + '\')" title="Rename this rule" aria-label="Rename this rule">';
      html += '<i class="ph ph-tag" style="font-size:14px;"></i>';
      html += '</button>';

      // 5. Clone
      html += '<button class="mock-toggle-btn" onclick="cloneMockRule(\'' + rule.id + '\')" title="Clone this rule" aria-label="Clone this rule">';
      html += '<i class="ph ph-copy-simple" style="font-size:14px;"></i>';
      html += '</button>';

      // 6. Delete
      html += '<button class="mock-toggle-btn" onclick="deleteMockRule(\'' + rule.id + '\')" title="Delete this rule" aria-label="Delete this rule" style="color:#ce3939;">';
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
      let html = '<div class="mock-group' + disabledClass + draftClass + '" data-group-id="' + group.id + '" aria-expanded="' + !isCollapsed + '">';

      // Group header
      html += '<div class="mock-group-header" onclick="toggleMockGroup(\'' + group.id + '\')">';
      html += '<span style="font-size:10px;margin-right:4px;">' + (isCollapsed ? '&#9654;' : '&#9660;') + '</span>';
      html += '<i class="ph ph-folder" style="font-size:14px;flex-shrink:0;opacity:0.5;"></i>';
      html += '<span class="mock-group-title">' + esc(group.title || 'Untitled Group') + '</span>';
      html += '<span style="color:var(--text-watermark);font-size:11px;margin-left:4px;">(' + (group.items || []).length + ' rule' + ((group.items || []).length !== 1 ? 's' : '') + ')</span>';

      html += '<div class="mock-rule-actions" onclick="event.stopPropagation()">';

      // Enable/Disable group
      const grpToggleLabel = group.enabled !== false ? 'Disable group' : 'Enable group';
      html += '<button class="mock-toggle-btn' + (group.enabled !== false ? ' mock-enabled' : '') + '" onclick="toggleMockGroupEnabled(\'' + group.id + '\')" title="' + grpToggleLabel + '" aria-label="' + grpToggleLabel + '">';
      html += group.enabled !== false
        ? '<i class="ph ph-toggle-right" style="font-size:14px;"></i>'
        : '<i class="ph ph-toggle-left" style="font-size:14px;"></i>';
      html += '</button>';

      // Rename group
      html += '<button class="mock-toggle-btn" onclick="renameMockGroup(\'' + group.id + '\')" title="Rename group" aria-label="Rename group">';
      html += '<i class="ph ph-tag" style="font-size:14px;"></i>';
      html += '</button>';

      // Delete group
      html += '<button class="mock-toggle-btn" onclick="deleteMockGroup(\'' + group.id + '\')" title="Delete group" aria-label="Delete group" style="color:#ce3939;">';
      html += '<i class="ph ph-trash-simple" style="font-size:14px;"></i>';
      html += '</button>';

      html += '</div>';
      html += '</div>';

      // Group items
      if (!isCollapsed) {
        if ((group.items || []).length === 0) {
          html += '<div class="mock-group-empty">No rules in this group. Drag rules here or use the move-to-group option.</div>';
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
        html += '<div class="mock-rule-card mock-rule-editing">';
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
      let html = '<div class="mock-rule-card mock-breakpoint-rule' + disabledClass + '" data-breakpoint-id="' + rule.id + '">';
      html += '<div class="mock-rule-summary">';
      html += '<div class="mock-rule-icon" style="background:' + color + ';"></div>';
      html += '<span class="method-badge method-' + (summary.methodStr === 'ANY' ? 'OPTIONS' : summary.methodStr) + '" style="font-size:11px;flex-shrink:0;">' + esc(summary.methodStr) + '</span>';
      html += '<span class="mock-rule-desc">' + summary.matchStr + '<span class="mock-arrow">\u2192</span><span style="color:#f1971f;">Breakpoint</span></span>';
      html += '<div class="mock-rule-actions" onclick="event.stopPropagation()">';
      const toggleLabel = rule.enabled !== false ? 'Disable this breakpoint' : 'Enable this breakpoint';
      html += '<button class="mock-toggle-btn' + (rule.enabled !== false ? ' mock-enabled' : '') + '" onclick="toggleBreakpointRuleEnabled(\'' + rule.id + '\')" title="' + toggleLabel + '" aria-label="' + toggleLabel + '">';
      html += rule.enabled !== false
        ? '<i class="ph ph-toggle-right" style="font-size:14px;"></i>'
        : '<i class="ph ph-toggle-left" style="font-size:14px;"></i>';
      html += '</button>';
      html += '<button class="mock-toggle-btn" onclick="deleteBreakpointRule(\'' + rule.id + '\')" title="Delete this breakpoint" aria-label="Delete this breakpoint" style="color:#ce3939;">';
      html += '<i class="ph ph-trash-simple" style="font-size:14px;"></i>';
      html += '</button>';
      html += '</div></div></div>';
      return html;
    }

    async function toggleBreakpointRuleEnabled(ruleId) {
      const rule = breakpointRules.find(r => r.id === ruleId);
      if (!rule) return;
      const enabled = rule.enabled === false;
      rule.enabled = enabled;
      renderMockRules();
      try {
        const res = await fetch(API_BASE + '/api/breakpoints/' + ruleId, {
          method: 'PATCH',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ enabled })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || 'Failed to update breakpoint');
        toast(enabled ? 'Breakpoint enabled' : 'Breakpoint disabled', 'success');
        loadBreakpointRules();
      } catch (err) {
        toast('Error: ' + err.message, 'error');
        loadBreakpointRules();
      }
    }

    async function deleteBreakpointRule(ruleId) {
      try {
        await fetch(API_BASE + '/api/breakpoints/' + ruleId, { method: 'DELETE' });
        breakpointRules = breakpointRules.filter(r => r.id !== ruleId);
        renderMockRules();
        toast('Breakpoint deleted', 'success');
      } catch (err) {
        toast('Error: ' + err.message, 'error');
      }
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
      html += '<button class="btn btn-primary" onclick="saveMockRule(\'' + ruleId + '\')">Save Draft</button>';
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
      renderMockRules();
      setTimeout(() => {
        const el = document.getElementById('mockEditor___new__');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 50);
    }

    function editMockRule(ruleId) {
      if (!preserveOpenMockEdit(ruleId)) return;
      const rule = _findMockRuleDeep(ruleId);
      if (!rule) return;
      const nr = normalizeMockRule(rule);
      mockEditingRule = ruleId;
      mockEditDraft = JSON.parse(JSON.stringify(nr));
      mockExpandedRules.add(ruleId);
      renderMockRules();
    }

    function cancelMockEdit() {
      mockEditingRule = null;
      mockEditDraft = null;
      renderMockRules();
    }

    function toggleMockRuleExpand(ruleId) {
      if (mockExpandedRules.has(ruleId)) {
        // Collapse
        mockExpandedRules.delete(ruleId);
        // If we were editing this rule, save as draft on collapse
        if (mockEditingRule === ruleId && mockEditDraft) {
          saveMockRule(ruleId);
        }
        mockEditingRule = null;
        mockEditDraft = null;
      } else {
        // Expand = edit
        mockExpandedRules.add(ruleId);
        editMockRule(ruleId);
      }
      renderMockRules();
    }

    function toggleMockRuleEnabled(ruleId) {
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
          case 'url-contains': newM.value = ''; break;
          case 'body-contains': newM.value = ''; break;
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

    /** Check if there are any unsaved mock rule drafts */
    function hasUnsavedMockChanges() {
      return mockDraftRules.size > 0;
    }

    /** Save current editor state to draft (local only, not to server) */
    function isMockMatcherComplete(matcher) {
      if (!matcher || typeof matcher.type !== 'string') return false;
      if (['header', 'query', 'cookie', 'form-data', 'multipart-form-data'].includes(matcher.type)) {
        return typeof matcher.name === 'string' && matcher.name.trim().length > 0;
      }
      if (['wildcard', 'raw-body-exact', 'exact-query'].includes(matcher.type)) return true;
      return typeof matcher.value === 'string' && matcher.value.trim().length > 0;
    }

    function saveMockRule(ruleId) {
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
      if (!hasUnsavedMockChanges() || mockSaveInProgress) return;
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
            const res = await fetch(`${API_BASE}/api/mock-rules/${draftId}`, {
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
      const draft = mockDraftRules.get(draftId);
      if (!draft) return;
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
          if (data.error) throw new Error(data.error);
        } else {
          const res = await fetch(`${API_BASE}/api/mock-rules/${draftId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          const data = await res.json();
          if (data.error) throw new Error(data.error);
        }
        mockDraftRules.delete(draftId);
        mockNewDraftIds.delete(draftId);
        toast('Rule saved to server', 'success');
        loadMockRules();
      } catch (err) {
        toast('Error: ' + err.message, 'error');
      }
    }

    /** Revert all unsaved draft changes (reload from server) */
    function revertMockRules() {
      if (!hasUnsavedMockChanges()) return;
      mockDraftRules.clear();
      mockNewDraftIds.clear();
      mockEditingRule = null;
      mockEditDraft = null;
      toast('All unsaved changes discarded', 'success');
      loadMockRules();
    }

    /** Update Save All / Revert button visibility based on draft state */
    function updateMockSaveButtons() {
      const saveAllBtn = document.getElementById('mockSaveAllBtn');
      const revertBtn = document.getElementById('mockRevertBtn');
      const unsavedBadge = document.getElementById('mockUnsavedBadge');
      const hasDrafts = hasUnsavedMockChanges();
      if (saveAllBtn) saveAllBtn.style.display = hasDrafts ? '' : 'none';
      if (saveAllBtn) saveAllBtn.disabled = mockSaveInProgress;
      if (revertBtn) revertBtn.style.display = hasDrafts ? '' : 'none';
      if (unsavedBadge) {
        unsavedBadge.style.display = hasDrafts ? '' : 'none';
        unsavedBadge.textContent = mockDraftRules.size + ' unsaved change' + (mockDraftRules.size !== 1 ? 's' : '');
      }
    }

    async function deleteMockRule(ruleId) {
      try {
        // Clean up local draft state
        mockDraftRules.delete(ruleId);
        mockExpandedRules.delete(ruleId);
        if (mockEditingRule === ruleId) {
          mockEditingRule = null;
          mockEditDraft = null;
        }

        if (mockNewDraftIds.has(ruleId)) {
          // Unsaved draft — remove locally only (it's not on the server yet)
          mockNewDraftIds.delete(ruleId);
          mockRules = mockRules.filter(r => r.id !== ruleId);
          toast('Draft rule deleted', 'success');
          updateMockSaveButtons();
          renderMockRules();
        } else {
          // Saved rule — delete from server AND reload to get fresh state
          await fetch(`${API_BASE}/api/mock-rules/${ruleId}`, { method: 'DELETE' });
          toast('Rule deleted', 'success');
          updateMockSaveButtons();
          await loadMockRules();
        }
      } catch (err) {
        toast('Error: ' + err.message, 'error');
      }
    }

    function cloneMockRule(ruleId) {
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
      const group = mockRules.find(r => r.id === groupId && r.type === 'group');
      if (group) { group.collapsed = !group.collapsed; renderMockRules(); }
    }

    function toggleMockGroupEnabled(groupId) {
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
      const group = mockRules.find(r => r.id === groupId && r.type === 'group');
      if (!group) return;
      const itemCount = (group.items || []).length;
      if (itemCount > 0 && !confirm('Delete group "' + (group.title || 'Untitled Group') + '" and its ' + itemCount + ' rule(s)?')) return;
      try {
        await fetch(API_BASE + '/api/mock-rules/' + groupId, { method: 'DELETE' });
        toast('Group deleted', 'success');
        loadMockRules();
      } catch (err) { toast('Error: ' + err.message, 'error'); }
    }

    async function createMockGroup() {
      const name = prompt('Group name:', 'New Group');
      if (name === null) return;
      try {
        await fetch(API_BASE + '/api/mock-rules/group', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ title: name || 'New Group' })
        });
        toast('Group created', 'success');
        loadMockRules();
      } catch (err) { toast('Error: ' + err.message, 'error'); }
    }

    async function moveRuleToGroup(ruleId, groupId) {
      try {
        const res = await fetch(API_BASE + '/api/mock-rules/move-to-group', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ ruleId, groupId })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        toast('Rule moved to group', 'success');
        loadMockRules();
      } catch (err) { toast('Error: ' + err.message, 'error'); }
    }

    async function ungroupRule(ruleId) {
      try {
        const res = await fetch(API_BASE + '/api/mock-rules/ungroup', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ ruleId })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        toast('Rule moved to top level', 'success');
        loadMockRules();
      } catch (err) { toast('Error: ' + err.message, 'error'); }
    }

    // ============ MOCK RULE IMPORT / EXPORT ============
    function exportMockRules() {
      if (mockRules.length === 0) {
        toast('No rules to export', 'error');
        return;
      }
      const blob = new Blob([JSON.stringify({
        version: 1,
        rules: mockRules
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
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.htkrules,.json';
      input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
          const text = await file.text();
          const data = JSON.parse(text);
          const rules = data.rules || data;
          if (!Array.isArray(rules)) throw new Error('Invalid format');

          const shouldReplace = mockRules.length > 0 && confirm('Replace existing rules? Click OK to replace, Cancel to append.');

          if (shouldReplace) {
            const response = await fetch(API_BASE + '/api/mock-rules', {
              method: 'PUT',
              headers: {'Content-Type':'application/json'},
              body: JSON.stringify({ rules })
            });
            if (!response.ok) {
              const result = await response.json().catch(() => ({}));
              throw new Error(result.error || 'Server rejected imported rules');
            }
            mockDraftRules.clear();
            mockNewDraftIds.clear();
          } else {
            for (const rule of rules) {
              const response = await fetch(API_BASE + '/api/mock-rules', {
                method: 'POST',
                headers: {'Content-Type':'application/json'},
                body: JSON.stringify(rule)
              });
              if (!response.ok) {
                const result = await response.json().catch(() => ({}));
                throw new Error(result.error || 'Server rejected an imported rule');
              }
            }
          }
          toast((shouldReplace ? 'Replaced with ' : 'Imported ') + rules.length + ' rules', 'success');
          loadMockRules();
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
    function parseCurlCommand(curlStr) {
      const result = { method: 'GET', url: '', headers: {}, body: '' };
      
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
        if (ch === '\\') { escaped = true; continue; }
        if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
        if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
        if (ch === ' ' && !inSingle && !inDouble) {
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
            result.headers[header.slice(0, colonIdx).trim()] = header.slice(colonIdx + 1).trim();
          }
        } else if (t === '-d' || t === '--data' || t === '--data-raw' || t === '--data-binary') {
          result.body = tokens[++i] || '';
          if (result.method === 'GET') result.method = 'POST';
        } else if (t === '--data-urlencode') {
          result.body = tokens[++i] || '';
          if (result.method === 'GET') result.method = 'POST';
          if (!result.headers['Content-Type']) {
            result.headers['Content-Type'] = 'application/x-www-form-urlencoded';
          }
        } else if (t === '-A' || t === '--user-agent') {
          result.headers['User-Agent'] = tokens[++i] || '';
        } else if (t === '-b' || t === '--cookie') {
          result.headers['Cookie'] = tokens[++i] || '';
        } else if (t === '-u' || t === '--user') {
          result.headers['Authorization'] = 'Basic ' + btoa(tokens[++i] || '');
        } else if (!t.startsWith('-') && !result.url) {
          result.url = t;
        }
      }
      
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
      const bodyArrow = document.getElementById('sendBodyArrow');
      if (bodyContent && bodyArrow) {
        const hasBody = getSendBodyValue().trim().length > 0;
        if (METHODS_WITHOUT_BODY.includes(sel.value)) {
          // Collapse body card if body is empty
          if (!hasBody) {
            bodyContent.style.display = 'none';
            bodyArrow.style.transform = 'rotate(-90deg)';
          }
        } else {
          // Expand body card for methods that commonly have bodies
          if (bodyContent.style.display === 'none') {
            bodyContent.style.display = 'block';
            bodyArrow.style.transform = 'rotate(0deg)';
          }
        }
      }
    }

    function toggleSendCard(contentId) {
      const content = document.getElementById(contentId);
      const arrowIds = {
        sendHeadersBody: 'sendHeadersArrow',
        sendBodyBody: 'sendBodyArrow',
        sendExportBody: 'sendExportArrow'
      };
      const arrowId = arrowIds[contentId];
      const arrow = document.getElementById(arrowId);
      if (!content) return;
      const isHidden = content.style.display === 'none';
      content.style.display = isHidden ? 'block' : 'none';
      if (arrow) arrow.style.transform = isHidden ? 'rotate(0deg)' : 'rotate(-90deg)';
      // Update aria-expanded on the card header
      const header = content.previousElementSibling;
      if (header && header.classList.contains('card-header')) {
        header.setAttribute('aria-expanded', String(isHidden));
      }
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
      return '';
    }

    /**
     * Set the send body editor content.
     * @param {string} value
     */
    function setSendBodyValue(value) {
      if (sendBodyEditor) {
        sendBodyEditor.setValue(value || '');
      }
    }

    /**
     * Initialize or re-initialize the Send page body Monaco editor.
     * @param {string} [initialValue='']
     * @param {string} [format='text']
     */
    async function initSendBodyEditor(initialValue, format) {
      const containerId = 'sendBody-monaco-container';
      const container = document.getElementById(containerId);
      if (!container) return;

      // Dispose previous instance if any
      if (sendBodyEditor) {
        sendBodyEditor.dispose();
        sendBodyEditor = null;
      }
      container.innerHTML = '';

      const language = sendFormatToMonacoLanguage(format || 'text');

      const editor = await createMonacoEditor(containerId, {
        value: initialValue || '',
        language: language,
        readOnly: false,
        minimap: false,
        lineNumbers: true,
        wordWrap: 'on',
        folding: true,
      });

      if (editor) {
        sendBodyEditor = editor;

        editor.onDidChangeModelContent(() => scheduleSendExportUpdate());

        // Ctrl+Enter sends the request
        editor.addCommand(monacoApi.KeyMod.CtrlCmd | monacoApi.KeyCode.Enter, function () {
          sendRequest();
        });

        // Escape aborts the request
        editor.addCommand(monacoApi.KeyCode.Escape, function () {
          abortSendRequest();
        });
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
      if (!sendBodyEditor) return;
      const format = document.getElementById('sendBodyFormat')?.value || 'text';
      const value = sendBodyEditor.getValue().trim();
      if (!value) return;

      try {
        if (format === 'json') {
          const parsed = JSON.parse(value);
          sendBodyEditor.setValue(JSON.stringify(parsed, null, 2));
          toast('JSON formatted', 'success');
        } else if (format === 'xml' || format === 'html') {
          sendBodyEditor.setValue(beautifyMarkup(value));
          toast('Formatted', 'success');
        } else {
          // Try Monaco's built-in formatter for other languages
          sendBodyEditor.getAction('editor.action.formatDocument')?.run();
        }
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
      const rawEditor = document.getElementById('sendBody-monaco-container');
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
        sendBodyEditor.layout();
      }

      scheduleSendExportUpdate();
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
        const valueEditor = bodyType === 'multipart' && field.type === 'file'
          ? `<span class="send-file-picker">
              <label class="send-file-picker-label">Choose file<input type="file" hidden onchange="updateSendFormFile(${index}, this.files[0])"></label>
              <span class="send-file-name" title="${esc(field.file?.name || field.fileName || 'No file selected')}">${esc(field.file?.name || field.fileName || 'No file selected')}</span>
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

    function bytesToBase64(bytes) {
      let binary = '';
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
      }
      return btoa(binary);
    }

    async function serializeMultipartFields(fields, boundary) {
      const encoder = new TextEncoder();
      const chunks = [];
      let totalLength = 0;
      const append = (chunk) => {
        const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
        chunks.push(bytes);
        totalLength += bytes.length;
      };

      for (const field of fields) {
        if (field.enabled === false || !field.key) continue;
        const safeName = String(field.key).replace(/["\r\n]/g, '_');
        append(`--${boundary}\r\n`);
        if (field.type === 'file') {
          if (!field.file) throw new Error(`Choose a file for multipart field "${field.key}"`);
          const safeFilename = String(field.file.name).replace(/["\r\n]/g, '_');
          append(`Content-Disposition: form-data; name="${safeName}"; filename="${safeFilename}"\r\n`);
          append(`Content-Type: ${field.file.type || 'application/octet-stream'}\r\n\r\n`);
          append(new Uint8Array(await field.file.arrayBuffer()));
          append('\r\n');
        } else {
          append(`Content-Disposition: form-data; name="${safeName}"\r\n\r\n`);
          append(field.value || '');
          append('\r\n');
        }
      }
      append(`--${boundary}--\r\n`);

      const result = new Uint8Array(totalLength);
      let offset = 0;
      chunks.forEach((chunk) => {
        result.set(chunk, offset);
        offset += chunk.length;
      });
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
            <input type="text" value="${esc(h.key)}" onchange="updateSendHeaderKey(${i}, this.value)" placeholder="Header name" style="flex:1;background:var(--bg-input);border:1px solid var(--text-input-border);border-radius:4px;color:${h.enabled !== false ? 'var(--pop-color)' : 'var(--text-watermark)'};padding:5px 8px;font-family:var(--font-mono);font-size:12px;font-weight:600;outline:none;min-width:0;">
            <input type="text" value="${esc(h.value)}" onchange="updateSendHeaderVal(${i}, this.value)" placeholder="Header value" style="flex:2;background:var(--bg-input);border:1px solid var(--text-input-border);border-radius:4px;color:var(--text-main);padding:5px 8px;font-family:var(--font-mono);font-size:12px;outline:none;min-width:0;">
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
      const obj = {};
      sendHeadersList.forEach(h => {
        if (h.enabled !== false && h.key.trim()) {
          obj[h.key.trim()] = h.value;
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
        for (const [k, v] of Object.entries(obj)) {
          sendHeadersList.push({ key: k, value: String(v), enabled: true });
        }
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
      sendTabs.forEach(tab => {
        const isActive = tab.id === activeSendTab;
        let label = 'New request';
        if (tab.url) {
          try { label = tab.method + ' ' + new URL(tab.url).hostname; } catch { label = tab.method + ' ' + tab.url.substring(0, 30); }
        }
        const tabEl = document.createElement('div');
        tabEl.className = 'send-tab' + (isActive ? ' active' : '');
        tabEl.setAttribute('role', 'tab');
        tabEl.setAttribute('aria-selected', String(isActive));
        tabEl.title = tab.url || 'New request';
        tabEl.addEventListener('click', () => switchSendTab(tab.id));

        const labelEl = document.createElement('span');
        labelEl.textContent = label;
        tabEl.appendChild(labelEl);

        const closeEl = document.createElement('button');
        closeEl.type = 'button';
        closeEl.className = 'send-tab-close';
        closeEl.title = 'Close tab';
        closeEl.setAttribute('aria-label', 'Close tab');
        closeEl.textContent = '×';
        closeEl.addEventListener('click', (event) => {
          event.stopPropagation();
          closeSendTab(tab.id);
        });
        tabEl.appendChild(closeEl);
        bar.appendChild(tabEl);
      });

      const addEl = document.createElement('div');
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
      return (fields || []).map((field) => ({
        key: field.key || '',
        value: field.value || '',
        enabled: field.enabled !== false,
        type: field.type === 'file' ? 'file' : 'text',
        fileName: field.file?.name || field.fileName || '',
        fileType: field.file?.type || field.fileType || '',
        ...(includeFiles && field.file ? { file: field.file } : {})
      }));
    }

    function createEmptySendTab() {
      sendTabCounter++;
      return {
        id: 'tab-' + sendTabCounter,
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

    function saveSendTabState() {
      const tab = sendTabs.find(t => t.id === activeSendTab);
      if (!tab) return;
      tab.method = document.getElementById('sendMethod')?.value || 'GET';
      tab.url = document.getElementById('sendUrl')?.value || '';
      tab.headers = sendHeadersList.slice();
      tab.body = getSendBodyValue();
      tab.bodyType = getSendBodyType();
      tab.bodyFormat = document.getElementById('sendBodyFormat')?.value || 'text';
      tab.urlEncodedFields = cloneSendFormFields(sendUrlEncodedFields);
      tab.multipartFields = cloneSendFormFields(sendMultipartFields);
      tab.multipartBoundary = sendMultipartBoundary;
      // Persist tabs to localStorage
      persistSendTabs();
    }

    function persistSendTabs() {
      try {
        const toSave = sendTabs.map(t => ({
          id: t.id, method: t.method, url: t.url,
          headers: t.headers, body: t.body, bodyType: t.bodyType || 'raw', bodyFormat: t.bodyFormat,
          urlEncodedFields: cloneSendFormFields(t.urlEncodedFields, false),
          multipartFields: cloneSendFormFields(t.multipartFields, false),
          multipartBoundary: t.multipartBoundary || ''
        }));
        localStorage.setItem('http-freekit-send-tabs', JSON.stringify(toSave));
        localStorage.setItem('http-freekit-send-active', activeSendTab);
      } catch {}
    }

    function restoreSendTabs() {
      try {
        const saved = localStorage.getItem('http-freekit-send-tabs');
        if (saved) {
          const parsed = JSON.parse(saved);
          if (Array.isArray(parsed) && parsed.length > 0) {
            sendTabs = parsed.map(t => ({
              ...t,
              bodyType: t.bodyType || 'raw',
              urlEncodedFields: cloneSendFormFields(t.urlEncodedFields, false),
              multipartFields: cloneSendFormFields(t.multipartFields, false),
              multipartBoundary: t.multipartBoundary || '',
              response: null
            }));
            sendTabCounter = sendTabs.reduce((max, tab) => Math.max(max, Number(String(tab.id).replace('tab-', '')) || 0), 0);
            const savedActive = localStorage.getItem('http-freekit-send-active');
            if (savedActive && sendTabs.find(t => t.id === savedActive)) {
              activeSendTab = savedActive;
            } else {
              activeSendTab = sendTabs[0].id;
            }
          }
        }
      } catch {}
    }

    function loadSendTabState(tab) {
      document.getElementById('sendMethod').value = tab.method || 'GET';
      document.getElementById('sendUrl').value = tab.url || '';
      sendHeadersList = (tab.headers || []).slice();
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
            method: tab.response.method || tab.method || 'GET',
            url: tab.response.url || tab.url || '',
            path: responsePath,
            responseHeaders: tab.response.responseHeaders || {}
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
        // Hide "View in traffic" when restoring tab (no synthetic entry linkage)
        const viewLink = document.getElementById('sendViewInTraffic');
        if (viewLink) viewLink.style.display = 'none';
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
      const tab = sendTabs.find(t => t.id === tabId);
      if (tab) loadSendTabState(tab);
      renderSendTabs();
    }

    function addSendTab() {
      saveSendTabState();
      const newTab = createEmptySendTab();
      sendTabs.push(newTab);
      activeSendTab = newTab.id;
      loadSendTabState(newTab);
      renderSendTabs();
    }

    function closeSendTab(tabId) {
      saveSendTabState();
      const idx = sendTabs.findIndex(t => t.id === tabId);
      if (idx === -1) return;
      if (sendTabs.length <= 1) {
        const newTab = createEmptySendTab();
        sendTabs = [newTab];
        activeSendTab = newTab.id;
        loadSendTabState(newTab);
        renderSendTabs();
        persistSendTabs();
        return;
      }
      sendTabs.splice(idx, 1);
      if (activeSendTab === tabId) {
        activeSendTab = sendTabs[Math.min(idx, sendTabs.length - 1)].id;
        loadSendTabState(sendTabs.find(t => t.id === activeSendTab));
      }
      renderSendTabs();
      persistSendTabs();
    }

    // Initialize with empty state on page load
    setTimeout(async () => {
      renderSendHeaders();
      renderSendTabs();
      // Initialize the Send body Monaco editor
      const initialTab = sendTabs.find(tab => tab.id === activeSendTab) || sendTabs[0];
      await initSendBodyEditor(initialTab?.body || '', initialTab?.bodyFormat || 'text');
      if (initialTab) loadSendTabState(initialTab);
    }, 100);

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

    async function prepareSendRequestPayload(headers) {
      const bodyType = getSendBodyType();
      if (bodyType === 'urlencoded') {
        const body = serializeUrlEncodedFields();
        setDefaultHeader(headers, 'Content-Type', 'application/x-www-form-urlencoded');
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

        const bytes = await serializeMultipartFields(sendMultipartFields, boundary);
        return {
          body: bytesToBase64(bytes),
          bodyEncoding: 'base64',
          displayBody: getMultipartDisplayBody(sendMultipartFields),
          byteLength: bytes.length
        };
      }

      const body = getSendBodyValue();
      if (body) setDefaultHeader(headers, 'Content-Type', formatToContentType(document.getElementById('sendBodyFormat')?.value || 'text'));
      return { body, bodyEncoding: 'utf8', displayBody: body, byteLength: new TextEncoder().encode(body).length };
    }

    async function sendRequest() {
      const method = document.getElementById('sendMethod').value;
      const url = document.getElementById('sendUrl').value.trim();
      const headersStr = document.getElementById('sendHeaders').value.trim();

      if (!url) { toast('URL is required', 'error'); return; }

      let headers = {};
      if (headersStr) {
        try { headers = JSON.parse(headersStr); } catch { toast('Invalid headers JSON', 'error'); return; }
      }

      setSendLoading(true);
      currentSendAbort = new AbortController();
      try {
        const payload = await prepareSendRequestPayload(headers);
        const res = await fetch(`${API_BASE}/api/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, method, headers, body: payload.body, bodyEncoding: payload.bodyEncoding }),
          signal: currentSendAbort.signal
        });
        const data = await res.json();

        if (data.error) throw new Error(data.error);

        const headersHtml = renderHeaders(data.headers);
        const resCt = data.headers?.['content-type'] || '';
        const modes = getBodyViewModes(data.body, resCt);
        const defaultMode = modes[0]?.value || 'text';
        const duration = data.duration + 'ms';

        document.getElementById('sendResponse').style.display = 'block';
        document.getElementById('sendEmptyResponse').style.display = 'none';
        renderSendResponseStatus(data.statusCode, data.statusMessage);
        document.getElementById('sendResDuration').textContent = duration;
        document.getElementById('sendResHeaders').innerHTML = headersHtml;

        // Add to traffic log as synthetic entry
        const syntheticReq = {
          id: crypto.randomUUID ? crypto.randomUUID() : 'send-' + Date.now(),
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
          responseBodySize: data.body ? data.body.length : 0,
          duration: data.duration,
          timestamp: Date.now(),
          source: 'Send'
        };
        setStandaloneBodyViewer('sendResBody', data.body || '', resCt, 'sendResBodyMode', defaultMode, { request: syntheticReq, section: 'response' });
        addRequest(syntheticReq);

        // Show "View in traffic" link
        const viewLink = document.getElementById('sendViewInTraffic');
        if (viewLink) {
          viewLink.style.display = 'inline-flex';
          viewLink.onclick = () => {
            const trafficTab = document.querySelector('.sidebar-item[data-panel="traffic"]');
            if (trafficTab) switchPanel(trafficTab, 'traffic');
            selectRequest(syntheticReq.id);
          };
        }

        // Save response to current tab
        const currentTab = sendTabs.find(t => t.id === activeSendTab);
        if (currentTab) {
          currentTab.response = {
            statusCode: data.statusCode,
            statusMessage: data.statusMessage || '',
            headersHtml,
            responseHeaders: data.headers || {},
            body: data.body || '',
            contentType: resCt,
            mode: defaultMode,
            duration,
            url,
            method
          };
        }
        saveSendTabState();
        renderSendTabs();
      } catch (err) {
        if (err.name === 'AbortError') return; // handled by abortSendRequest
        toast(`Error: ${err.message}`, 'error');
      } finally {
        currentSendAbort = null;
        setSendLoading(false);
      }
    }

    function abortSendRequest() {
      if (currentSendAbort) {
        currentSendAbort.abort();
        currentSendAbort = null;
        toast('Request aborted', 'success');
      }
    }

    // ============ CONFIG ============
    async function loadConfig() {
      try {
        const res = await fetch(`${API_BASE}/api/config`);
        const data = await res.json();
        if (data.config) {
          const fpEl = document.getElementById('settingsCaFingerprint');
          if (fpEl) fpEl.textContent = data.config.certificateFingerprint || '--';
          if (data.config.proxyPort) {
            const minEl = document.getElementById('settingsMinPort');
            const maxEl = document.getElementById('settingsMaxPort');
            if (minEl && !minEl.value) minEl.value = data.config.proxyPort;
            if (maxEl && !maxEl.value) maxEl.value = data.config.proxyPort;
          }
          const mpEl = document.getElementById('manualProxyPort');
          if (mpEl) mpEl.textContent = data.config.proxyPort;
        }
      } catch (e) {
        console.error('[Error]', e.message);
        toast('Error: ' + e.message, 'error');
      }
    }

    async function loadUiSettings() {
      try {
        const res = await fetch(API_BASE + '/api/ui-settings');
        const data = await res.json();
        hideTunnelRequests = data.hideTunnelRequests !== false;
        filterSafeFonts = data.filterSafeFonts === true;
        const toggle = document.getElementById('hideTunnelRequestsToggle');
        if (toggle) toggle.checked = hideTunnelRequests;
        const fontsToggle = document.getElementById('filterSafeFontsToggle');
        if (fontsToggle) fontsToggle.checked = filterSafeFonts;
        applyFilter();
      } catch (e) {
        console.error('[Error]', e.message);
      }
    }

    async function saveHideTunnelRequests(enabled) {
      hideTunnelRequests = !!enabled;
      applyFilter();
      try {
        await fetch(API_BASE + '/api/ui-settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hideTunnelRequests, filterSafeFonts })
        });
        toast('Traffic display setting saved', 'success');
      } catch (err) {
        toast('Error: ' + err.message, 'error');
      }
    }

    async function saveFilterSafeFonts(enabled) {
      filterSafeFonts = !!enabled;
      applyFilter();
      try {
        await fetch(API_BASE + '/api/ui-settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hideTunnelRequests, filterSafeFonts })
        });
        toast('Traffic display setting saved', 'success');
      } catch (err) {
        toast('Error: ' + err.message, 'error');
      }
    }

    // ============ ROW NAVIGATION ============
    function selectRequestByIndex(delta) {
      if (filteredRequests.length === 0) return;
      let currentIdx = selectedRequestId
        ? filteredRequests.findIndex(r => r.id === selectedRequestId)
        : -1;
      let newIdx;
      if (delta === 'first') newIdx = 0;
      else if (delta === 'last') newIdx = filteredRequests.length - 1;
      else newIdx = Math.max(0, Math.min(filteredRequests.length - 1, currentIdx + delta));

      const req = filteredRequests[newIdx];
      selectedRequestId = req.id;
      updateTrafficActiveDescendant(req.id);
      if (window.location.hash.startsWith('#/view') || window.location.hash.startsWith('#/traffic')) {
        history.replaceState(null, '', '#/view/' + req.id);
      }
      // Scroll the selected row into view
      scrollRowIntoView(newIdx);
      // Re-render to update selection
      vsForceRender = true;
      renderVirtualRows();
      showDetail(req);
    }

    // ============ WS FRAME EXPAND/COLLAPSE ============
    function toggleWsExpand(parentId) {
      if (wsExpandedConnections.has(parentId)) {
        wsExpandedConnections.delete(parentId);
      } else {
        wsExpandedConnections.add(parentId);
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
          if (!har.log?.entries) throw new Error('Invalid HAR file');

          const imported = har.log.entries.map(entry => ({
            id: crypto.randomUUID(),
            protocol: entry.request.url.startsWith('https') ? 'https' : 'http',
            method: entry.request.method,
            url: entry.request.url,
            host: new URL(entry.request.url).hostname,
            path: new URL(entry.request.url).pathname + new URL(entry.request.url).search,
            requestHeaders: Object.fromEntries(entry.request.headers.map(h => [h.name.toLowerCase(), h.value])),
            requestBody: entry.request.postData?.text || '',
            requestBodySize: entry.request.bodySize || 0,
            statusCode: entry.response.status,
            statusMessage: entry.response.statusText,
            responseHeaders: Object.fromEntries(entry.response.headers.map(h => [h.name.toLowerCase(), h.value])),
            responseBody: entry.response.content?.text || '',
            responseBodySize: entry.response.content?.size || 0,
            duration: entry.time || 0,
            timestamp: new Date(entry.startedDateTime).getTime(),
            source: 'import'
          }));

          imported.forEach(r => addRequest(r));
          toast('Imported ' + imported.length + ' requests from HAR', 'success');
        } catch (err) {
          toast('Failed to import HAR: ' + err.message, 'error');
        }
      };
      input.click();
    }

    // ============ ACTIONS ============
    function clearTraffic() {
      if (ws?.readyState === 1) {
        ws.send(JSON.stringify({ type: 'clear-traffic' }));
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
          toast('HAR file exported', 'success');
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

      if (type === 'none' || type === 'system') {
        fields.style.display = 'none';
        // Auto-save when selecting "none" or "system"
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
          await fetch(API_BASE + '/api/upstream-proxy', { method: 'DELETE' });
          setSettingsStatus(statusEl, 'Direct connection (no proxy)', 'var(--status-2xx)');
          toast('Upstream proxy disabled', 'success');
        } catch (err) { toast('Error: ' + err.message, 'error'); }
        return;
      }

      if (type === 'system') {
        try {
          const res = await fetch(API_BASE + '/api/upstream-proxy', { method: 'DELETE' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          setSettingsStatus(statusEl, 'Using system proxy settings', 'var(--text-lowlight)');
          toast('Using system proxy settings', 'success');
        } catch (err) {
          toast('Could not disable the custom proxy: ' + err.message, 'error');
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
      const detailsEl = document.getElementById('upstreamDetails');
      const noProxyEl = document.getElementById('upstreamNoProxy');
      const statusEl = document.getElementById('upstreamStatus');

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
      if (msg.status === 'error') {
        toast('Auto proxy rotation failed: ' + (msg.error || 'unknown error'), 'error');
      }
    }

    async function loadUpstreamProxy() {
      try {
        const res = await fetch(API_BASE + '/api/upstream-proxy');
        const data = await res.json();
        if (data.upstreamProxy) {
          const p = data.upstreamProxy;
          updateUpstreamProxyUi(p);
        }
      } catch (e) {
        console.error('[Error]', e.message);
        toast('Error: ' + e.message, 'error');
      }
    }

    // ============ PORT CONFIG ============
    async function savePortConfig() {
      const min = document.getElementById('settingsMinPort').value;
      const max = document.getElementById('settingsMaxPort').value;
      try {
        await fetch(API_BASE + '/api/port-config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ minPort: min, maxPort: max })
        });
        toast('Port range saved (takes effect on restart)', 'success');
      } catch (err) { toast('Error: ' + err.message, 'error'); }
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
      if (!host || !path) { toast('Both host and path required', 'error'); return; }
      try {
        const response = await fetch(API_BASE + '/api/client-certificates/items', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ host, pfxPath: path })
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Could not add certificate');
        document.getElementById('clientCertHost').value = '';
        document.getElementById('clientCertPath').value = '';
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
    async function loadMcpStatus() {
      try {
        const res = await fetch(API_BASE + '/api/mcp/status');
        const data = await res.json();
        const statusEl = document.getElementById('mcpStatus');
        if (statusEl) {
          statusEl.textContent = data.enabled ? 'Running' : 'Stopped';
          statusEl.style.color = data.enabled ? '#4caf7d' : 'var(--text-lowlight)';
        }
        const endpointEl = document.getElementById('mcpSseEndpoint');
        if (endpointEl) endpointEl.textContent = data.sseEndpoint || '--';
        const clientEl = document.getElementById('mcpClientCount');
        if (clientEl) clientEl.textContent = data.connectedClients || 0;
        const toggleEl = document.getElementById('mcpEnabledToggle');
        if (toggleEl) toggleEl.checked = data.enabled;
        const configEl = document.getElementById('mcpClaudeConfig');
        if (configEl) {
          configEl.textContent = JSON.stringify({
            mcpServers: {
              'http-freekit': {
                command: 'node',
                args: ['src/index.js', '--mcp-stdio'],
                env: { API_PORT: String(config.apiPort || 8001) }
              }
            }
          }, null, 2);
        }
      } catch (e) {
        console.error('[Error]', e.message);
        toast('Error: ' + e.message, 'error');
      }
    }

    async function toggleMcp(enabled) {
      try {
        await fetch(API_BASE + '/api/mcp/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled })
        });
        toast(enabled ? 'MCP server enabled' : 'MCP server disabled', 'success');
        loadMcpStatus();
      } catch (err) {
        toast('Error: ' + err.message, 'error');
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

          await fetch(API_BASE + '/api/specs', {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ title, baseUrl, spec })
          });
          toast('API spec loaded: ' + title, 'success');
          loadApiSpecs();
        } catch (err) {
          toast('Failed to load spec: ' + err.message, 'error');
        }
      };
      input.click();
    }

    async function removeApiSpec(id) {
      await fetch(API_BASE + '/api/specs/' + id, { method: 'DELETE' });
      loadApiSpecs();
      toast('Spec removed', 'success');
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

      localStorage.setItem('settingsActiveSection', nextSection);
      const panel = document.getElementById('panel-settings');
      if (panel) panel.scrollTop = 0;

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

    function setActiveSidebarTab(el) {
      document.querySelectorAll('.sidebar-item').forEach(item => {
        item.classList.remove('active');
        item.setAttribute('aria-selected', 'false');
      });
      el.classList.add('active');
      el.setAttribute('aria-selected', 'true');
    }

    function switchPanel(el, panelId) {
      // Warn if leaving mock page with unsaved changes
      const currentPanel = document.querySelector('.sidebar-item.active')?.dataset?.panel;
      if (currentPanel === 'mock' && panelId !== 'mock' && hasUnsavedMockChanges()) {
        if (!confirm('You have unsaved mock rule changes. Leave without saving?')) {
          return;
        }
      }
      // Save traffic scroll position when switching away from traffic panel
      if (currentPanel === 'traffic') {
        const wrapper = document.getElementById('trafficTableWrapper');
        if (wrapper) {
          localStorage.setItem('trafficScrollTop', String(wrapper.scrollTop));
          localStorage.setItem('trafficAutoScroll', String(autoScroll));
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
        const savedSection = localStorage.getItem('settingsActiveSection') || 'general';
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
        const savedAutoScroll = localStorage.getItem('trafficAutoScroll');
        if (savedAutoScroll === 'true') {
          autoScroll = true;
          wrapper.scrollTop = wrapper.scrollHeight;
        } else {
          const savedScrollTop = localStorage.getItem('trafficScrollTop');
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
        const requestId = viewMatch[1];
        setTimeout(() => {
          if (requests.find(r => r.id === requestId)) {
            selectRequest(requestId);
          }
        }, 1000);
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
        const requestedSection = settingsMatch[1] || localStorage.getItem('settingsActiveSection') || 'general';
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

    function showContextMenu(x, y, items) {
      hideContextMenu();
      const menu = document.createElement('div');
      menu.className = 'context-menu';

      items.forEach(item => {
        if (item.separator) {
          const sep = document.createElement('div');
          sep.className = 'context-menu-separator';
          menu.appendChild(sep);
          return;
        }
        const el = document.createElement('div');
        el.className = 'context-menu-item';
        el.textContent = item.label;
        el.onclick = () => { hideContextMenu(); item.action(); };
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
    }

    function hideContextMenu() {
      if (activeContextMenu) {
        activeContextMenu.remove();
        activeContextMenu = null;
      }
    }

    // Close context menu on click anywhere or Escape
    document.addEventListener('click', hideContextMenu);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideContextMenu(); });

    // --- Traffic row context menu ---
    function showTrafficContextMenu(e, requestId) {
      e.preventDefault();
      const req = requests.find(r => r.id === requestId);
      if (!req) return;

      if (selectedRequestId !== requestId) {
        selectRequest(requestId);
      }

      showContextMenu(e.clientX, e.clientY, [
        { label: 'Copy URL', action: () => navigator.clipboard.writeText(req.url).then(() => toast('URL copied', 'success')) },
        { label: 'Copy as cURL', action: () => {
          const snippet = generateExportSnippet(req, 'curl');
          navigator.clipboard.writeText(snippet).then(() => toast('cURL command copied', 'success'));
        }},
        { separator: true },
        { label: 'Resend in Send tab', action: () => resendSelectedRequest(requestId) },
        { label: 'Create mock rule', action: () => createMockFromRequest(requestId) },
        { label: 'Create breakpoint', action: () => createBreakpointFromRequest() },
        { separator: true },
        { label: 'Pin exchange', action: () => togglePinRequest() },
        { label: 'Delete exchange', action: () => deleteSelectedRequest() },
      ]);
    }

    function createMockFromRequest(requestId) {
      const req = requests.find(r => r.id === requestId);
      if (!req) return;

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
      const skipHeaders = ['transfer-encoding', 'connection', 'keep-alive', 'proxy-connection',
        'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'upgrade',
        'content-encoding', 'content-length'];
      const respHeaders = {};
      if (req.responseHeaders) {
        for (const [k, v] of Object.entries(req.responseHeaders)) {
          if (!skipHeaders.includes(k.toLowerCase())) {
            respHeaders[k] = Array.isArray(v) ? v.join(', ') : v;
          }
        }
      }

      // Build the action — use fixed-response with the actual response data
      // Request body goes into matchers (above), response data goes into the action
      const action = {
        type: 'fixed-response',
        status: req.statusCode || 200,
        headers: respHeaders,
        body: req.responseBody || ''
      };

      fetch(API_BASE + '/api/mock-rules', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
          title: req.method + ' ' + req.host + (req.path ? req.path.split('?')[0] : ''),
          matchers,
          action,
          _originalRequestBody: req.requestBody || '',
          _originalResponseBody: req.responseBody || ''
        })
      }).then(r => r.json()).then(data => {
        toast('Mock rule created from exchange', 'success');
        // Switch to Mock tab
        const mockTab = document.querySelector('.sidebar-item[data-panel="mock"]');
        if (mockTab) switchPanel(mockTab, 'mock');
        // Reload rules then expand the new one in edit mode
        loadMockRules().then(() => {
          if (data.rule?.id) {
            editMockRule(data.rule.id);
            setTimeout(() => {
              const el = document.querySelector('[data-rule-id="' + data.rule.id + '"]');
              if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
            }, 100);
          }
        });
      }).catch(err => toast('Error: ' + err.message, 'error'));
    }

    // --- Header context menu ---
    // Store current detail headers for safe lookup (avoids quote-escaping issues in inline handlers)
    window._detailHeaders = { request: {}, response: {} };

    function showHeaderContextMenu(e, headerKey, section) {
      e.preventDefault();
      e.stopPropagation();
      const headers = section === 'request' ? window._detailHeaders.request : window._detailHeaders.response;
      const value = headers ? (Array.isArray(headers[headerKey]) ? headers[headerKey].join(', ') : String(headers[headerKey] || '')) : '';
      showContextMenu(e.clientX, e.clientY, [
        { label: 'Copy header value', action: () => navigator.clipboard.writeText(value).then(() => toast('Value copied', 'success')) },
        { label: 'Copy header name', action: () => navigator.clipboard.writeText(headerKey).then(() => toast('Name copied', 'success')) },
        { label: 'Copy as "name: value"', action: () => navigator.clipboard.writeText(headerKey + ': ' + value).then(() => toast('Header copied', 'success')) },
      ]);
    }

    // ============ HELPERS ============
    function esc(str) {
      if (!str) return '';
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }

    function formatSize(bytes) {
      if (bytes == null || bytes === 0) return '-';
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
      try {
        const res = await fetch(API_BASE + '/api/breakpoints/pending');
        const data = await res.json();
        for (const bp of (data.pending || [])) {
          const resumeRes = await fetch(API_BASE + '/api/breakpoints/pending/' + bp.id + '/resume', {
            method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}'
          });
          let resumeData = null;
          try { resumeData = await resumeRes.json(); } catch { /* ignore non-json error bodies */ }
          if (!resumeRes.ok || resumeData?.success === false) {
            throw new Error(resumeData?.error || `Resume failed (${resumeRes.status})`);
          }
        }
        toast('All breakpoints resumed', 'success');
        updateBreakpointBanner();
      } catch (err) { toast('Error: ' + err.message, 'error'); }
    }

    function getBreakpointEditDraft(req) {
      if (!breakpointEditDrafts.has(req.id)) {
        const responsePhase = req.breakpointPhase === 'response';
        breakpointEditDrafts.set(req.id, responsePhase ? {
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
      const draft = breakpointEditDrafts.get(req.id);
      if (!draft._dirty) draft._dirty = {};
      return draft;
    }

    function editBreakpointField(requestId, field) {
      const req = requests.find(r => r.id === requestId);
      if (!req) return;
      const draft = getBreakpointEditDraft(req);

      if (field === 'status') {
        const value = prompt('Response status:', String(draft.status || 200));
        if (value === null) return;
        const status = Number(value);
        if (!Number.isInteger(status) || status < 100 || status > 599) {
          toast('Status must be an integer from 100 to 599', 'error');
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
    }

    async function resumeBreakpointRequest(requestId) {
      try {
        const draft = breakpointEditDrafts.get(requestId) || {};
        const dirty = draft._dirty || {};
        const modifications = {};
        const editableFields = draft._phase === 'response'
          ? ['status', 'headers', 'body']
          : ['method', 'url', 'headers', 'body'];
        for (const field of editableFields) {
          if (dirty[field]) modifications[field] = draft[field];
        }
        const res = await fetch(API_BASE + '/api/breakpoints/pending/' + requestId + '/resume', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify(modifications)
        });
        let data = null;
        try { data = await res.json(); } catch { /* ignore non-json error bodies */ }
        if (!res.ok || data?.success === false) {
          throw new Error(data?.error || `Resume failed (${res.status})`);
        }
        breakpointEditDrafts.delete(requestId);
        toast('Request resumed', 'success');
        updateBreakpointBanner();
      } catch (err) { toast('Error: ' + err.message, 'error'); }
    }

    function createBreakpointFromRequest() {
      if (!selectedRequestId) return;
      const req = requests.find(r => r.id === selectedRequestId);
      if (!req) return;

      fetch(API_BASE + '/api/breakpoints', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
          matchers: [
            { type: 'method', value: req.method },
            { type: 'host', value: req.host }
          ]
        })
      }).then(() => {
        toast('Breakpoint created for ' + req.method + ' ' + req.host, 'success');
        loadBreakpointRules();
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

    // ============ RESIZE DETAIL ============
    (function setupResizer() {
      const resizer = document.getElementById('detailResizer');
      let startX, startWidth;

      resizer.addEventListener('mousedown', (e) => {
        const panel = document.getElementById('detailPanel');
        startX = e.clientX;
        startWidth = panel.offsetWidth;
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        e.preventDefault();
      });

      function onMouseMove(e) {
        const panel = document.getElementById('detailPanel');
        const diff = startX - e.clientX;
        panel.style.width = Math.max(300, startWidth + diff) + 'px';
      }

      function onMouseUp() {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      }
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

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      const activeEl = document.activeElement;
      const isInput = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT');

      if (e.key === 'Escape') closeDetail();

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

      if (e.key === 'k' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        document.getElementById('searchInput').focus();
      }

      // Ctrl+F or / : Focus search input in traffic view
      if ((e.key === 'f' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !isInput)) {
        e.preventDefault();
        document.getElementById('searchInput').focus();
      }

      // Ctrl+Delete or Ctrl+Shift+Delete: Clear all traffic
      if (e.key === 'Delete' && (e.ctrlKey || e.metaKey)) {
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
          closeSendTab(activeSendTab);
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
        if (selectedRequestId) createMockFromRequest(selectedRequestId);
        return;
      }

      // Ctrl+[: Focus traffic list pane (left side)
      if (e.key === '[' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
        e.preventDefault();
        const trafficList = document.getElementById('trafficList') || document.querySelector('.traffic-list');
        if (trafficList) trafficList.focus();
        return;
      }

      // Ctrl+]: Focus detail pane (right side)
      if (e.key === ']' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
        e.preventDefault();
        const detailPane = document.getElementById('detailPanel') || document.querySelector('.detail-pane');
        if (detailPane) detailPane.focus();
        return;
      }

      // Arrow / vim navigation for traffic rows (only when not in an input)
      if (!isInput) {
        if (e.key === 'ArrowDown' || e.key === 'j') {
          e.preventDefault();
          selectRequestByIndex(1);
        }
        if (e.key === 'ArrowUp' || e.key === 'k') {
          e.preventDefault();
          selectRequestByIndex(-1);
        }
        if (e.key === 'PageDown') {
          e.preventDefault();
          selectRequestByIndex(10);
        }
        if (e.key === 'PageUp') {
          e.preventDefault();
          selectRequestByIndex(-10);
        }
        if (e.key === 'Home') {
          e.preventDefault();
          selectRequestByIndex('first');
        }
        if (e.key === 'End') {
          e.preventDefault();
          selectRequestByIndex('last');
        }
      }
    });

    // ============ MONACO EDITOR ============
    /** @type {typeof import('monaco-editor')|null} */
    let monacoApi = null;
    /** @type {Promise<typeof import('monaco-editor')>} */
    const monacoReady = new Promise((resolve) => {
      if (typeof require !== 'undefined' && typeof require.config === 'function') {
        require(['vs/editor/editor.main'], function (monaco) {
          monacoApi = monaco;

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

          resolve(monaco);
        });
      }
    });

    /**
     * Track all active Monaco editor instances for theme switching.
     * @type {Array<{editor: object, container: HTMLElement}>}
     */
    const monacoInstances = [];

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
      const monaco = await monacoReady;
      if (!monaco) return null;

      const container = document.getElementById(containerId);
      if (!container) {
        console.warn('[Monaco] Container not found:', containerId);
        return null;
      }

      // Determine current theme
      const resolvedTheme = options.theme || getMonacoTheme();

      const lineNumbers = options.lineNumbers === false ? 'off'
        : options.lineNumbers === true ? 'on'
        : (options.lineNumbers || 'on');

      const editor = monaco.editor.create(container, {
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
      const resizeObserver = new ResizeObserver(() => {
        editor.layout();
      });
      resizeObserver.observe(container);

      // Track instance for theme switching and cleanup
      const instance = { editor, container, resizeObserver };
      monacoInstances.push(instance);

      // Cleanup when container is removed from DOM
      const mutationObserver = new MutationObserver(() => {
        if (!document.body.contains(container)) {
          editor.dispose();
          resizeObserver.disconnect();
          mutationObserver.disconnect();
          const idx = monacoInstances.indexOf(instance);
          if (idx !== -1) monacoInstances.splice(idx, 1);
        }
      });
      mutationObserver.observe(document.body, { childList: true, subtree: true });

      return editor;
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
          // Save and apply
          localStorage.setItem('http-freekit-custom-theme', JSON.stringify(sanitizedTheme));
          applyCustomThemeData(sanitizedTheme);
          renderCustomThemeSwatches(sanitizedTheme);
          setTheme('custom');
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
      localStorage.removeItem('http-freekit-custom-theme');
      if (_customThemeStyleEl) {
        _customThemeStyleEl.remove();
        _customThemeStyleEl = null;
      }
      var swatches = document.getElementById('customThemeSwatches');
      if (swatches) { swatches.innerHTML = ''; swatches.style.display = 'none'; }
      var removeBtn = document.getElementById('removeCustomThemeBtn');
      if (removeBtn) removeBtn.style.display = 'none';
      setTheme('dark');
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
        var saved = localStorage.getItem('http-freekit-custom-theme');
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

    function setTheme(theme) {
      localStorage.setItem('http-freekit-theme', theme);
      var resolved = theme;
      if (theme === 'auto') {
        resolved = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
      }
      if (theme === 'custom') {
        resolved = 'custom';
        // Ensure custom theme CSS is injected
        var savedCustom = localStorage.getItem('http-freekit-custom-theme');
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
      var saved = localStorage.getItem('http-freekit-theme') || 'dark';
      // If custom was saved but no theme data exists, fall back to dark
      if (saved === 'custom' && !localStorage.getItem('http-freekit-custom-theme')) {
        saved = 'dark';
      }
      setTheme(saved);
    }

    // Re-apply theme when OS color scheme changes (for "auto" mode)
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', function() {
      var saved = localStorage.getItem('http-freekit-theme') || 'dark';
      if (saved === 'auto') setTheme('auto');
    });

    loadTheme();
    connectWebSocket();

    // ============ AUTO-UPDATER UI ============
    (function initAutoUpdaterUI() {
      if (!window.electronApi || !window.electronApi.onUpdaterStatus) return;

      let updateVersion = null;

      window.electronApi.onUpdaterStatus(function(data) {
        switch (data.status) {
          case 'checking':
            if (data.manual) toast('Checking for updates...', 'success');
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
          case 'error':
            if (data.manual) toast('Update check failed: ' + (data.error || 'unknown error'), 'error');
            break;
        }
      });

      function showUpdateReadyToast(version) {
        var container = document.getElementById('toastContainer');
        var t = document.createElement('div');
        t.className = 'toast toast-success';
        t.innerHTML = 'Update v' + escapeHtml(version) + ' ready. <a href="#" class="toast-action" id="installUpdateBtn">Restart to install</a>';
        container.appendChild(t);
        var btn = t.querySelector('#installUpdateBtn');
        if (btn) {
          btn.addEventListener('click', function(e) {
            e.preventDefault();
            window.electronApi.installUpdate();
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

    // Draggable resizer for Send panel split pane
    (function setupSendResizer() {
      var resizer = document.getElementById('sendResizer');
      if (!resizer) return;
      var startX, leftWidth;

      resizer.addEventListener('mousedown', function(e) {
        var leftPane = resizer.previousElementSibling;
        startX = e.clientX;
        leftWidth = leftPane.offsetWidth;

        function onMouseMove(ev) {
          var diff = ev.clientX - startX;
          var newWidth = Math.max(250, leftWidth + diff);
          leftPane.style.flex = 'none';
          leftPane.style.width = newWidth + 'px';
        }

        function onMouseUp() {
          resizer.classList.remove('active');
          document.removeEventListener('mousemove', onMouseMove);
          document.removeEventListener('mouseup', onMouseUp);
        }

        resizer.classList.add('active');
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        e.preventDefault();
      });
    })();
