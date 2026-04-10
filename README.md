# HTTP FreeKit

A free, open-source HTTP(S) debugging, interception, and testing toolkit. Inspired by [HTTP Toolkit](https://httptoolkit.com), built from scratch as a fully free alternative with no paywalls or account requirements.

Available as a **standalone desktop app** (Electron) for Windows, macOS, and Linux, or as a web-based tool running in the browser.

## Features

### Intercept
Launch pre-configured browsers, terminals, Docker containers, Electron apps, Android devices (via ADB), or JVM processes with all HTTP(S) traffic routed through the proxy. Supports Chrome, Firefox, Edge, Brave, system proxy, and more. Interceptor cards expand in-grid to show custom configuration (device lists, process selection, setup instructions).

### View
Inspect every HTTP request and response in real-time with a **virtualized traffic table** that handles 100,000+ rows at 60fps. Full **Monaco Editor** integration for viewing request/response bodies with syntax highlighting, code folding, search, and bracket matching. See headers (with per-header documentation for 80+ standard headers), timing, TLS/connection details, compression analysis, and caching analysis. WebSocket frames are individually captured and displayed. TLS failures and raw tunnels appear as distinct event types with their own detail views.

### Mock & Modify
Create rules to intercept and rewrite HTTP traffic with a powerful rule editor. Match requests using ~20 matcher types (method, path, host, headers, body, cookies, query params, form data, regex, JSON body matching, and more). Actions include fixed responses, forward to host, transform request/response (with per-field dropdowns for method, URL, headers, body), serve from file, breakpoints (request, response, or both), webhooks, close/reset connection, and timeout. Rules support **pre-step chaining** (delay, add/remove headers, rewrite URL/method before the main action). Organize rules into **collapsible groups** with drag-and-drop reordering (Shift+Drop to combine). Draft-based save model with batch save/revert. Import/export as `.htkrules` files.

### Send
Build and send HTTP requests with a Postman-like interface. **Multiple tabs** for parallel requests. Key-value header editor with per-header enable/disable. **Monaco Editor** for request body with format selection (JSON, XML, HTML, CSS, JavaScript). cURL paste detection auto-populates all fields. Resizable split pane with full response inspection. Abort in-flight requests with Escape. Sent requests automatically appear in the traffic view.

### Settings
Configure proxy ports (with port range), upstream proxies (HTTP, HTTPS, SOCKS4, SOCKS4a, SOCKS5, SOCKS5h), TLS passthrough, HTTP/2 mode, client certificates (per-host PKCS12), trusted CA certificates, HTTPS validation whitelist, OpenAPI/Swagger spec management (auto-documentation in detail view), and theme selection (Dark, Light, High Contrast, Automatic, Custom .htktheme upload).

## Quick Start

### Web Mode (no install)

```bash
npm install
npm start
```

Open **http://127.0.0.1:8001** in your browser. The proxy runs on port **8081**.

### Desktop App

```bash
npm install
npm run electron
```

### Build Desktop Installers

```bash
npm run build:win    # Windows .exe installer
npm run build:mac    # macOS .dmg
npm run build:linux  # Linux .AppImage, .deb, .rpm
npm run build        # All platforms
```

### Custom Ports

```bash
PROXY_PORT=9090 API_PORT=9001 npm start
```

## Architecture

```
http-freekit/
  electron/                    # Electron desktop app
    main.cjs                   # Window management, server lifecycle
    preload.cjs                # Context bridge (secure IPC)
    menu.cjs                   # Application menu (File, Edit, View, Help)
    tray.cjs                   # System tray icon + context menu
    updater.cjs                # Auto-update via electron-updater
  src/
    index.js                   # Boot, static serving, startup
    proxy/
      proxy-server.js          # HTTP/HTTPS/H2/WebSocket MITM proxy
      certificate-authority.js # CA certificate generation (node-forge)
      ws-frame-parser.js       # WebSocket frame parser (RFC 6455)
    api/
      api-server.js            # REST API + WebSocket server
      har-converter.js         # HAR 1.2 export
    interceptors/
      interceptor-manager.js   # Interceptor orchestrator
      browser-interceptor.js   # Chrome/Firefox/Edge/Brave (fresh profile)
      existing-browser-interceptor.js # Global browser (existing profile)
      terminal-interceptors.js # Fresh + Existing terminal
      docker-interceptor.js    # Docker container interception
      electron-interceptor.js  # Electron app interception
      android-adb-interceptor.js # Android device/emulator via ADB
      jvm-interceptor.js       # Java/Kotlin/Scala process attachment
      system-proxy-interceptor.js # Windows system-wide proxy
      browser-paths.js         # Cross-platform browser detection
    ui/
      index.html               # SPA entry point
      styles.css               # Full design system (dark/light/high-contrast)
      app.js                   # Frontend application logic
  build/                       # App icons (16x16 to 1024x1024)
  electron-builder.config.cjs  # Cross-platform packaging config
  data/                        # Generated CA certs (auto-created)
```

## Proxy Capabilities

- **HTTP/1.1** full request/response capture with body decompression
- **HTTPS** man-in-the-middle via dynamic per-host certificate generation
- **HTTP/2** with ALPN negotiation — h2 sessions cached per origin with fallback to h1.1
- **WebSocket** frame-level interception — individual messages parsed (text, binary, ping, pong, close)
- **TLS passthrough** for configured hostnames (bypass interception)
- **TLS failure capture** — handshake failures shown as distinct traffic events
- **Upstream proxy** chaining (HTTP, HTTPS, SOCKS4, SOCKS4a, SOCKS5, SOCKS5h)
- **Body decompression** (gzip, brotli, deflate, zstd)
- **Source detection** from User-Agent (Chrome, Firefox, cURL, Python, Node.js, Go, Java, etc.)
- **Connection timeout** (30s default, configurable)

## Mock Rules

Rules support rich matching and actions:

**Matchers** (AND logic — all must match):
Wildcard, Method, Path (exact/prefix/regex), Host, Hostname, Port, Protocol, Header, Cookie, Query Param, Exact Query, URL Contains, Body Contains, JSON Body (exact/partial), Regex Body, Regex URL, Form Data, Multipart Form Data, Raw Body Exact

**Actions:**
Fixed Response, Forward to Host, Passthrough, Transform Request/Response (method, URL, headers, body — each with dropdown options), Serve from File, Close Connection, Reset Connection (RST), Timeout, Request Breakpoint, Response Breakpoint, Request+Response Breakpoint, Webhook, Delay (as chainable pre-step)

**Pre-steps** (executed before the main action):
Delay, Add Header, Remove Header, Rewrite URL, Rewrite Method

**Organization:**
Collapsible groups, drag-and-drop reorder (Shift+Drop to combine into groups), clone, inline rename, enable/disable, priority (normal/high), draft save/revert, import/export (`.htkrules`)

## Export Formats

**Traffic export:** HAR 1.2 (`.har`), JSON

**Code snippets** (per-request, from the Export card):
cURL, Python (requests), JavaScript (fetch), Node.js (http), PowerShell, wget, PHP (cURL), Go

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+1` | Intercept page |
| `Ctrl+2` | View/Traffic page |
| `Ctrl+3` | Mock page |
| `Ctrl+4` | Send page |
| `Ctrl+9` | Settings |
| `Ctrl+F` or `/` | Focus search filter |
| `Arrow Up/Down` or `j/k` | Navigate traffic rows |
| `Page Up/Down` | Skip 10 rows |
| `Home/End` | First/last row |
| `Escape` | Close detail pane / dismiss menu / abort send |
| `Ctrl+P` | Pin/unpin selected exchange |
| `Ctrl+R` | Resend selected request |
| `Ctrl+M` | Create mock rule from selected |
| `Ctrl+Delete` | Clear all traffic |
| `Ctrl+[` / `Ctrl+]` | Focus list / detail pane |
| `Ctrl+Enter` | Send request (Send page) |
| `Ctrl+Tab` | Next send tab |
| `Ctrl+Shift+Tab` | Previous send tab |
| `Ctrl+W` | Close send tab |
| `Ctrl+Shift+N` | New send tab |

## Themes

- **Dark** (default) — matches HTTP Toolkit's dark theme exactly
- **Light** — full light mode with matching design tokens
- **High Contrast** — black background, white text, maximum contrast
- **Automatic** — follows OS light/dark preference, live-updates on change
- **Custom** — upload a `.htktheme` JSON file with color overrides

## Filter Syntax

The traffic search supports structured filters with autocomplete:

```
method:GET              # Filter by HTTP method
status:4xx              # Filter by status range
status:404              # Filter by exact status
host:example.com        # Filter by hostname
path:/api               # Filter by path
source:Chrome           # Filter by traffic source
body:error              # Search in request/response body
header:content-type=json # Filter by header value
```

Multiple filters combine with AND logic. Plain text searches across all fields. 150ms debounce for performance.

## Desktop App

The Electron desktop app provides:

- **Native window** with persistent size/position (1366x768 default, min 700x600)
- **Application menu** — File (New Session, Quit), Edit (undo/redo/cut/copy/paste), View (zoom, fullscreen, devtools), Help
- **System tray** — minimize to tray, context menu (Show/Hide, Quit)
- **Bundled server** — proxy starts automatically on launch, graceful shutdown on close
- **Auto-updates** — checks on launch and every 6 hours, downloads in background
- **Cross-platform** — Windows (.exe), macOS (.dmg), Linux (.AppImage, .deb, .rpm)
- **Secure IPC** — context isolation enabled, preload script with contextBridge API

## API

The management API runs on the same port as the UI (default 8001):

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/version` | Server version |
| GET | `/api/config` | Proxy config + CA cert info |
| GET | `/api/stats` | Proxy statistics |
| GET | `/api/traffic` | Traffic log (`?limit`, `?offset`, `?filter`) |
| GET | `/api/traffic/search` | Advanced search (`?method`, `?status`, `?host`, `?path`) |
| GET | `/api/traffic/export` | Export as JSON |
| GET | `/api/traffic/export.har` | Export as HAR 1.2 |
| POST | `/api/traffic/import-har` | Import HAR file |
| POST | `/api/traffic/clear` | Clear traffic log |
| GET | `/api/interceptors` | List all interceptors |
| POST | `/api/interceptors/:id/activate` | Activate an interceptor |
| POST | `/api/interceptors/:id/deactivate` | Deactivate an interceptor |
| GET | `/api/mock-rules` | List mock rules |
| POST | `/api/mock-rules` | Create mock rule |
| PUT | `/api/mock-rules/:id` | Update mock rule |
| DELETE | `/api/mock-rules/:id` | Delete mock rule |
| POST | `/api/mock-rules/reorder` | Reorder rules |
| POST | `/api/mock-rules/group` | Create rule group |
| GET | `/api/breakpoints` | List breakpoint rules |
| POST | `/api/breakpoints` | Create breakpoint |
| GET | `/api/breakpoints/pending` | List paused requests |
| POST | `/api/breakpoints/pending/:id/resume` | Resume paused request |
| GET | `/api/specs` | List loaded API specs |
| POST | `/api/specs` | Upload OpenAPI spec |
| DELETE | `/api/specs/:id` | Remove API spec |
| POST | `/api/send` | Send an HTTP request |
| GET | `/api/certificate` | Download CA certificate (.pem) |
| WS | `/ws` | Real-time traffic streaming |

## Certificate Trust

The proxy generates a CA certificate on first run (`data/ca.pem`). For browsers launched from the Intercept page, the certificate is trusted automatically. For manually configured clients:

1. Download the CA certificate from Settings or `GET /api/certificate`
2. Install it in your OS or browser trust store
3. On Windows, the certificate is automatically added to the user trust store on startup

## Tech Stack

- **Runtime:** Node.js 18+
- **Desktop:** Electron with electron-builder packaging
- **Backend:** Express, node-forge (certificates), ws (WebSocket), socks (SOCKS proxy)
- **Frontend:** Vanilla HTML/CSS/JS, Monaco Editor (code viewing/editing), Phosphor Icons
- **Proxy:** Custom MITM implementation with HTTP/1.1, HTTP/2, and WebSocket frame support
- **Design:** HTTP Toolkit's design system (DM Sans, DM Mono, Saira fonts, exact color palette)

## License

MIT
