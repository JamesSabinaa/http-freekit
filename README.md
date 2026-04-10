# HTTP FreeKit

A free, open-source HTTP(S) debugging, interception, and testing toolkit. Inspired by [HTTP Toolkit](https://httptoolkit.com), built from scratch as a fully free alternative with no paywalls or account requirements.

## Features

### Intercept
Launch pre-configured browsers, terminals, Docker containers, or Electron apps with all HTTP(S) traffic routed through the proxy. Supports Chrome, Firefox, Edge, Brave, system proxy, and more.

### View
Inspect every HTTP request and response in real-time with a searchable, filterable traffic table. See headers, bodies (with syntax highlighting for JSON, HTML, XML, JS, CSS), timing, TLS details, and compression analysis.

### Mock & Modify
Create rules to intercept and rewrite HTTP traffic. Match requests by method, path, host, headers, body, cookies, query params, and more. Return fixed responses, forward to different hosts, transform request/response headers and bodies, serve files, add delays, or trigger breakpoints for manual inspection.

### Send
Build and send HTTP requests with a Postman-like interface. Multiple tabs, key-value header editor, body format selection with syntax highlighting, cURL paste support, and full response inspection.

### Settings
Configure proxy ports, upstream proxies (HTTP/HTTPS/SOCKS), TLS passthrough, HTTP/2 mode, client certificates, trusted CAs, HTTPS validation whitelist, OpenAPI spec management, and theme selection.

## Quick Start

```bash
# Install dependencies
npm install

# Start the server
npm start
```

Then open **http://127.0.0.1:8001** in your browser.

The proxy runs on port **8081** by default. Configure your browser or application to use `127.0.0.1:8081` as its HTTP proxy, or use the Intercept page to launch a pre-configured browser.

### Custom Ports

```bash
PROXY_PORT=9090 API_PORT=9001 npm start
```

## Architecture

```
http-freekit/
  src/
    index.js                  # Boot, static serving, startup
    proxy/
      proxy-server.js         # HTTP/HTTPS/H2 MITM proxy engine
      certificate-authority.js # CA certificate generation
    api/
      api-server.js           # REST API + WebSocket server
      har-converter.js        # HAR 1.2 export
    interceptors/
      interceptor-manager.js  # Interceptor orchestrator
      browser-interceptor.js  # Chrome/Firefox/Edge/Brave (fresh profile)
      existing-browser-interceptor.js
      terminal-interceptors.js # Fresh + Existing terminal
      docker-interceptor.js   # Docker container interception
      electron-interceptor.js # Electron app interception
      system-proxy-interceptor.js
      browser-paths.js        # Cross-platform browser detection
    ui/
      index.html              # SPA entry point
      styles.css              # Full design system (dark/light/high-contrast)
      app.js                  # Frontend application logic
  data/
    ca.key                    # Generated CA private key
    ca.pem                    # Generated CA certificate
```

## Proxy Capabilities

- **HTTP/1.1** full request/response capture
- **HTTPS** man-in-the-middle via dynamic per-host certificate generation
- **HTTP/2** with ALPN negotiation (configurable in Settings)
- **WebSocket** frame-level interception with message counting
- **TLS passthrough** for configured hostnames (bypass interception)
- **Upstream proxy** chaining (HTTP, HTTPS, SOCKS4, SOCKS5)
- **Body decompression** (gzip, brotli, deflate, zstd)
- **Source detection** from User-Agent (Chrome, Firefox, cURL, Python, etc.)

## Mock Rules

Rules support rich matching and actions:

**Matchers** (AND logic — all must match):
Method, Path (exact/prefix/regex), Host, Hostname, Port, Protocol, Header, Cookie, Query Param, Exact Query, URL Contains, Body Contains, JSON Body (exact/partial), Regex Body, Regex URL, Form Data, Raw Body Exact

**Actions:**
Fixed Response, Forward to Host, Passthrough, Transform Request/Response (with per-field dropdowns for method, URL, headers, body), Serve from File, Close Connection, Reset Connection (RST), Timeout, Request Breakpoint, Response Breakpoint

**Pre-steps** (executed before the main action):
Delay, Add Header, Remove Header, Rewrite URL, Rewrite Method

Rules can be organized into **collapsible groups**, **drag-and-drop reordered** (Shift+Drop to combine into groups), **cloned**, **renamed**, **enabled/disabled**, and **imported/exported** as `.htkrules` files.

## Export Formats

**Traffic export:**
- HAR 1.2 (`.har`)
- JSON

**Code snippets** (per-request, from the Export card):
- cURL
- Python (requests)
- JavaScript (fetch)
- Node.js (http)
- PowerShell
- wget
- PHP (cURL)
- Go

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+1` | Intercept page |
| `Ctrl+2` | View/Traffic page |
| `Ctrl+3` | Mock page |
| `Ctrl+4` | Send page |
| `Ctrl+9` | Settings |
| `Ctrl+F` or `/` | Focus search filter |
| `Ctrl+K` | Focus search filter |
| `Arrow Up/Down` or `j/k` | Navigate traffic rows |
| `Page Up/Down` | Skip 10 rows |
| `Home/End` | First/last row |
| `Escape` | Close detail pane / dismiss menu |
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

- **Dark** (default) — matches HTTP Toolkit's dark theme
- **Light** — full light mode
- **High Contrast** — black background, white text, maximum contrast
- **Automatic** — follows OS light/dark preference

## Filter Syntax

The traffic search supports structured filters:

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

Multiple filters combine with AND logic. Plain text searches across all fields.

## API

The management API runs on the same port as the UI (default 8001):

```
GET  /api/version              # Server version
GET  /api/config               # Proxy configuration + CA cert info
GET  /api/stats                # Proxy statistics
GET  /api/traffic              # Traffic log (with ?limit, ?offset, ?filter)
GET  /api/traffic/search       # Advanced search (?method, ?status, ?host, ?path)
GET  /api/traffic/export       # Export as JSON
GET  /api/traffic/export.har   # Export as HAR 1.2
POST /api/traffic/import-har   # Import HAR file
POST /api/traffic/clear        # Clear traffic log
GET  /api/interceptors         # List all interceptors
POST /api/interceptors/:id/activate
POST /api/interceptors/:id/deactivate
GET  /api/mock-rules           # List mock rules
POST /api/mock-rules           # Create mock rule
PUT  /api/mock-rules/:id       # Update mock rule
DELETE /api/mock-rules/:id     # Delete mock rule
POST /api/mock-rules/reorder   # Reorder rules
GET  /api/breakpoints          # List breakpoint rules
POST /api/breakpoints          # Create breakpoint
GET  /api/breakpoints/pending  # List paused requests
POST /api/breakpoints/pending/:id/resume
POST /api/send                 # Send an HTTP request
GET  /api/certificate          # Download CA certificate (.pem)
WS   /ws                       # WebSocket for real-time traffic
```

## Certificate Trust

To intercept HTTPS traffic, the proxy generates a CA certificate on first run. For browsers launched from the Intercept page, the certificate is automatically trusted. For manually configured clients:

1. Download the CA certificate from Settings or `GET /api/certificate`
2. Install it in your OS or browser trust store
3. On Windows, the certificate is automatically installed in the user trust store on startup

## Tech Stack

- **Backend:** Node.js, Express, node-forge (certificates), ws (WebSocket)
- **Frontend:** Vanilla HTML/CSS/JS (no framework), Phosphor Icons
- **Proxy:** Custom MITM implementation with HTTP/1.1, HTTP/2, and WebSocket support
- **Design:** HTTP Toolkit's design system (DM Sans, DM Mono, Saira fonts)

## License

MIT
