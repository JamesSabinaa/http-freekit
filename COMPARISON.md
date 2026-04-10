# HTTP FreeKit vs HTTP Toolkit — Feature Comparison (Updated)

## Summary

| Area | Match | Partial | Missing |
|------|-------|---------|---------|
| Sidebar & Intercept | 8 | 5 | 1 |
| Traffic/View | 16 | 5 | 0 |
| Mock/Modify | 7 | 7 | 2 |
| Send & Settings | 8 | 4 | 2 |
| Visual/CSS/General | 21 | 1 | 0 |
| **Total** | **60** | **22** | **5** |

---

## Remaining Missing Features (5)

1. **Step chaining** in mock rules — multi-step pipelines (delay -> forward -> webhook)
2. **Rule grouping** — hierarchical folders for mock rules with drag-to-combine
3. **OpenAPI spec management** — upload/manage API specs with auto-documentation in detail view
4. **Interceptor card config expansion** — cards expanding in-grid for custom setup UI (e.g. Android ADB, Docker container selection)
5. **Additional interceptor types** — Android (ADB), iOS, JVM, Python, Ruby (currently have browsers, terminal, docker, electron)

## Remaining Partial Features (22)

### Traffic/View (5 partial)
1. **Virtualized scrolling** — capped at 500 rows (vs react-window true windowing)
2. **Body viewer** — regex-based highlighting (vs Monaco Editor)
3. **Detail card types** — 7 types (vs 10+ including API, Trailers, WebSocket, Transform)
4. **Filter system** — type-prefix filters (vs rich FilterSet with filter-class objects)
5. **Performance card** — has compression + caching analysis now, but missing encoding re-compression comparison

### Mock/Modify (7 partial)
1. **Rule row layout** — single-line summary (vs two-column card)
2. **Expanded state** — separate read-only + edit modes (vs inline editing)
3. **Matcher types** — 11 types (vs ~20 including cookie, form data, multipart, port, protocol)
4. **Handler types** — 8 types (vs ~13 including file response, breakpoints, JSON-RPC, webhook)
5. **Save behavior** — immediate per-rule (vs draft-based batch save)
6. **Rename** — browser prompt dialog (vs inline editable field)
7. **Drag-drop** — flat list only (vs cross-group drag and combine-to-group)

### Send & Settings (4 partial)
1. **Request body editor** — textarea + preview (vs Monaco Editor)
2. **Response display** — cards (vs Monaco Editor + link to view page)
3. **Upstream proxy** — 6 types (vs 8 including SOCKS4a, SOCKS5h)
4. **Theme toggle** — 3 options (vs 5 including Automatic, Custom .htktheme upload)

### Visual/General (1 partial)
1. **Line numbers** — custom span-based (vs Monaco built-in gutter)

---

## What's Been Implemented (60 Matches)

### Recently Completed
- Send page tabs (multi-tab with add/close/switch)
- Loading overlay on interceptor activation (spinner)
- Keyboard shortcuts: Ctrl+P pin, Ctrl+R resend, Ctrl+M mock, Ctrl+[/] pane focus, Ctrl+Shift+N new tab
- URL deep linking for selected exchanges (#/view/requestId)
- Filter debounce (150ms) + search clear button
- Compression analysis (encoding detection, suggestions, comparison)
- Caching analysis (cache-control parsing, TTL, validation headers)
- Click-to-deselect on traffic rows
- Pin indicator (thumbtack) in traffic table
- Clear traffic preserves pinned exchanges
- Three empty state variants (no traffic, paused, filter empty)
- Pause button icon toggle (pause/play SVGs)
- High-contrast theme
- Default mock rules (passthrough on first launch)
- Client certificates, trusted CAs, HTTPS whitelist in settings
- Row pin indicator in traffic table
- Transform rule editor with HTTP Toolkit-style dropdowns (method/URL/headers/body for both request and response)

### Core Features (all matching)
- Dark/light/high-contrast themes with full color palette match
- DM Sans + DM Mono + Saira fonts
- 75px sidebar with correct tab order, icons, active indicator
- Intercept page with grid layout, card styling, connected sources, search
- 10 interceptor types (Chrome, Global Chrome, Firefox, Edge, Brave, Terminal, Existing Terminal, System Proxy, Docker, Electron)
- Traffic table with 6 columns, 32px rows, row markers, source detection
- Detail pane with collapsible cards (Request, Body, Response, Performance, Export)
- Header grid with per-header docs (80+ headers), context menus
- Body syntax highlighting (JSON, XML, HTML, JS, CSS) with line numbers
- Export snippets in 8 languages (cURL, Python, JS, Node, PowerShell, wget, PHP, Go)
- HAR import/export
- Mock rules with 11 matcher types, 8 action types, drag-drop reorder, clone, rename
- Breakpoint system (create, pause, resume, banner, detail card)
- Upstream proxy with type selector (Direct, System, HTTP, HTTPS, SOCKS4, SOCKS5)
- TLS passthrough, HTTP/2 config, port range
- Responsive layout (1100px, 900px, 768px breakpoints)
- Toast notifications, context menus, keyboard shortcuts
- WebSocket connection with auto-reconnect
- cURL paste detection on Send page
