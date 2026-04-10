# PRD: HTTP FreeKit — Pixel-Perfect HTTP Toolkit Clone

## Introduction

HTTP FreeKit is a free, open-source clone of [HTTP Toolkit](https://httptoolkit.com) — a professional HTTP(S) debugging, interception, and testing tool. The goal is to replicate HTTP Toolkit's full feature set, visual design, and user experience as a standalone desktop application (Electron + Node.js server + web UI), with our own "HTTP FreeKit" branding but using HTTP Toolkit's exact design system (colors, fonts, spacing, components).

**The only feature explicitly excluded is account/subscription management** — HTTP FreeKit is completely free with no paywalls.

### Reference Repositories

Use these HTTP Toolkit open-source repos as the authoritative reference for every feature, layout, and interaction:

| Repo | Purpose | Key Files |
|------|---------|-----------|
| [httptoolkit/httptoolkit](https://github.com/httptoolkit/httptoolkit) | Meta repo — architecture overview, orchestration | README, docker-compose |
| [httptoolkit/httptoolkit-ui](https://github.com/httptoolkit/httptoolkit-ui) | React web UI — all pages, components, styles | `src/styles.ts`, `src/components/`, `src/model/` |
| [httptoolkit/httptoolkit-server](https://github.com/httptoolkit/httptoolkit-server) | Node.js backend — proxy, interceptors, API | `src/interceptors/`, `src/api/`, `src/index.ts` |
| [httptoolkit/httptoolkit-desktop](https://github.com/httptoolkit/httptoolkit-desktop) | Electron shell — window management, auto-update | `src/index.ts`, `src/menu.ts`, `electron-builder.config.cjs` |

**When in doubt about any behavior, fetch the corresponding source file from the UI repo and replicate it.**

### Existing Codebase

We already have a working HTTP FreeKit codebase at `C:\Users\Administrateur\http-freekit` with ~12,600 lines of code:

```
src/
  index.js                    (113 lines)   — Boot + static serving
  proxy/
    proxy-server.js           (2364 lines)  — MITM proxy with HTTP/2
    certificate-authority.js  (184 lines)   — CA cert generation
  api/
    api-server.js             (701 lines)   — REST API + WebSocket
    har-converter.js          (69 lines)    — HAR 1.2 export
  interceptors/
    interceptor-manager.js    (78 lines)    — Orchestrator
    browser-interceptor.js    (192 lines)   — Fresh browser (temp profile)
    existing-browser-interceptor.js (80 lines)
    terminal-interceptors.js  (175 lines)   — Fresh + Existing terminal
    docker-interceptor.js     (74 lines)
    electron-interceptor.js   (86 lines)
    system-proxy-interceptor.js (54 lines)
    browser-paths.js          (48 lines)    — Browser detection
  ui/
    index.html                (454 lines)   — HTML structure
    styles.css                (2647 lines)  — Full CSS design system
    app.js                    (5293 lines)  — Frontend logic
```

Dependencies: `express`, `node-forge`, `ws`, `uuid`

**The PRD builds on this existing code.** Each user story identifies what exists and what needs to change.

---

## Goals

- Achieve visual and functional parity with HTTP Toolkit (excluding account management)
- Match HTTP Toolkit's design system exactly: colors, fonts (DM Sans, DM Mono, Saira), spacing, shadows, animations
- Package as a standalone Electron desktop app for Windows, macOS, and Linux
- Support all HTTP Toolkit interceptor types (browsers, terminals, Docker, Android, iOS, JVM, Electron, system proxy)
- Support all HTTP Toolkit proxy capabilities (HTTP/1.1, HTTP/2, WebSocket frame capture, TLS interception)
- Support all HTTP Toolkit mock/modify capabilities (matchers, handlers, step chaining, rule grouping)
- Use HTTP FreeKit branding (logo, name, about text) while maintaining visual fidelity to HTTP Toolkit's layout

---

## User Stories

### Phase 1: Visual Pixel-Perfection

#### US-001: Integrate Monaco Editor for body viewing
**Description:** As a user, I want syntax-highlighted, searchable, foldable code viewing for request/response bodies so I can inspect them as easily as in HTTP Toolkit.

**Acceptance Criteria:**
- [ ] Install `monaco-editor` npm package and bundle it
- [ ] Replace all `<pre class="body-content">` body viewers with Monaco Editor instances
- [ ] Monaco uses HTTP Toolkit's custom dark theme (`vs-dark-custom`) with our color palette: strings=#4caf7d, keywords=#6e40aa, numbers=#5a80cc, comments=#818490
- [ ] Support languages: JSON, XML, HTML, CSS, JavaScript, YAML, Markdown, plain text, hex
- [ ] Body view mode dropdown (JSON/Text/Hex/Image/URL-Encoded) switches Monaco language
- [ ] Editor is read-only for response viewing, editable for Send page request body
- [ ] Line numbers, minimap (optional), bracket matching, code folding all work
- [ ] Ctrl+F opens Monaco's built-in search within the body
- [ ] Image content types render as `<img>` preview instead of Monaco
- [ ] URL-encoded bodies render as key-value pair grid (existing `url-decoded-params` approach)
- [ ] Reference: `httptoolkit-ui/src/components/editor/content-viewer.tsx`, `httptoolkit-ui/src/components/editor/base-editor.tsx`

#### US-002: Implement virtualized traffic list
**Description:** As a user, I want smooth scrolling through 100,000+ traffic rows without performance degradation.

**Acceptance Criteria:**
- [ ] Replace innerHTML-based row rendering with a virtual scrolling implementation
- [ ] Only DOM nodes for visible rows (~50) exist at any time, plus a buffer of ~10 above/below
- [ ] Row height fixed at 32px (existing)
- [ ] Scroll position preserved when switching panels and back
- [ ] Scroll position saved to localStorage and restored on page reload
- [ ] Auto-scroll to bottom behavior maintained (scrolls when user is near bottom, stops when user scrolls up)
- [ ] Selection persists correctly during virtual scroll
- [ ] No visible flicker or blank rows during fast scrolling
- [ ] Performance: 60fps scroll at 100,000 rows
- [ ] Reference: `httptoolkit-ui/src/components/view/view-event-list.tsx` (uses `react-window`)

#### US-003: Match every CSS value to HTTP Toolkit's design tokens
**Description:** As a developer, I want our CSS to use the exact same values as HTTP Toolkit's `styles.ts` so the visual output is indistinguishable (except for branding).

**Acceptance Criteria:**
- [ ] Audit every CSS variable in `styles.css` against `httptoolkit-ui/src/styles.ts`
- [ ] All 8 font size tokens match: smallPrintSize=12px, textInputFontSize=13px, textSize=14.5px, subHeadingSize=17px, headingSize=20px, largeHeadingSize=24px, loudHeadingSize=38px, screamingHeadingSize=80px
- [ ] All named color constants match for dark theme, light theme, and high-contrast theme
- [ ] Box shadow alpha is 0.4 for dark theme, 0.3 for light theme consistently
- [ ] All border-radius values are 4px (cards, inputs, pills)
- [ ] All spacing/padding matches: cards=20px, little-cards=15px, big-cards=30px
- [ ] Sidebar width=75px, items=72x72px, logo padding=13px, margin=3px auto 4px
- [ ] Header/footer heights=38px
- [ ] Traffic row height=32px, TLS row height=28px
- [ ] NARROW_LAYOUT_BREAKPOINT=1100px
- [ ] Split pane resizer=11px with 5px transparent borders
- [ ] Reference: `httptoolkit-ui/src/styles.ts` (the single source of truth)

#### US-004: Implement all Phosphor icons matching HTTP Toolkit
**Description:** As a user, I want to see the same icons HTTP Toolkit uses so the interface feels identical.

**Acceptance Criteria:**
- [ ] Install `@phosphor-icons/web` or `@phosphor-icons/core` npm package
- [ ] Replace all inline SVG icons in sidebar, buttons, and cards with Phosphor icons
- [ ] Sidebar icons: Intercept=Plug, View=MagnifyingGlass, Mock=Pencil, Send=PaperPlaneTilt, Settings=Gear
- [ ] Sidebar icon size=34px (currently 28px)
- [ ] Traffic source icons use Phosphor equivalents
- [ ] Detail pane action buttons use Phosphor icons
- [ ] All icon weights match HTTP Toolkit (regular weight, not bold/fill)
- [ ] Reference: `httptoolkit-ui/src/icons.ts`

### Phase 2: Complete Proxy & Protocol Support

#### US-005: Full WebSocket frame interception
**Description:** As a user, I want to see individual WebSocket frames (not just connection open/close) so I can debug real-time communication.

**Acceptance Criteria:**
- [ ] Parse WebSocket frames (opcode, payload, mask) in both directions
- [ ] Each frame appears as a sub-row under the WebSocket connection in the traffic list
- [ ] Frame detail shows: direction (client->server or server->client), opcode (text/binary/ping/pong/close), payload, timestamp
- [ ] Text frames show decoded UTF-8 content with syntax highlighting (JSON detection)
- [ ] Binary frames show hex view
- [ ] WebSocket close frames show close code and reason
- [ ] Stream message list card in detail view (like HTTP Toolkit's `StreamMessageListCard`)
- [ ] Frame count shown in the connection summary row
- [ ] Reference: `httptoolkit-ui/src/components/view/http/stream-message-list-card.tsx`

#### US-006: Full HTTP/2 upstream support
**Description:** As a developer, I want the proxy to speak HTTP/2 to upstream servers (not just to clients) for accurate performance measurement.

**Acceptance Criteria:**
- [ ] When forwarding to upstream, use `http2.connect()` to establish h2 sessions
- [ ] Cache h2 sessions per origin for connection reuse
- [ ] Fall back to HTTP/1.1 if h2 negotiation fails
- [ ] h2 pseudo-headers (`:method`, `:path`, `:authority`, `:scheme`) handled correctly
- [ ] h2 server push frames captured (if any)
- [ ] Protocol shown as "HTTP/2" in traffic for both client->proxy and proxy->upstream h2
- [ ] Reference: `httptoolkit-server/src/rules/http-agents.ts`

#### US-007: TLS failure and tunnel event types
**Description:** As a user, I want to see TLS handshake failures and raw tunnels as distinct event types in the traffic list.

**Acceptance Criteria:**
- [ ] TLS failures shown as italic, 28px-height rows (matching HTTP Toolkit's `TlsListRow`)
- [ ] TLS failure detail pane shows: hostname, error message, certificate chain info
- [ ] Raw (non-HTTP) tunnels shown as distinct rows: "Non-HTTP connection to hostname:port"
- [ ] TLS tunnel events shown when a CONNECT tunnel is established but no HTTP follows
- [ ] Each event type has its own detail pane component
- [ ] Reference: `httptoolkit-ui/src/components/view/tls-failure-details-pane.tsx`, `tls-tunnel-details-pane.tsx`

### Phase 3: Complete Interceptor Coverage

#### US-008: Android ADB interceptor
**Description:** As a mobile developer, I want to intercept HTTP traffic from Android devices/emulators connected via ADB.

**Acceptance Criteria:**
- [ ] Detect connected Android devices via `adb devices`
- [ ] Push CA certificate to device system store (requires root or Android 10+ with cert injection)
- [ ] Configure device proxy settings via `adb shell settings put global http_proxy`
- [ ] Show device list in an expandable interceptor card config UI
- [ ] Support both physical devices and emulators
- [ ] Clean up proxy settings on deactivation
- [ ] Reference: `httptoolkit-server/src/interceptors/android/android-adb-interceptor.ts`

#### US-009: JVM/Java interceptor
**Description:** As a Java developer, I want to attach to running JVM processes to intercept their HTTP traffic.

**Acceptance Criteria:**
- [ ] List running JVM processes via `jps` or Java Attach API
- [ ] Inject a Java agent that configures proxy and certificate trust
- [ ] Show process list in expandable interceptor card
- [ ] Support Java, Kotlin, Scala, Clojure, Groovy processes
- [ ] Reference: `httptoolkit-server/src/interceptors/jvm.ts`

#### US-010: Expandable interceptor card config UI
**Description:** As a user, I want some interceptor cards to expand in-grid to show custom configuration (device selection, process list, etc.).

**Acceptance Criteria:**
- [ ] Cards with `configComponent` expand to span multiple grid columns/rows
- [ ] Expanded card shows a close button (X) in the top-right
- [ ] Card smoothly animates between collapsed and expanded states
- [ ] Expanded card scrolls into view
- [ ] Other cards reflow around the expanded card (CSS Grid `grid-auto-flow: row dense`)
- [ ] Android ADB, Docker, JVM, and Electron interceptors use expandable cards
- [ ] Reference: `httptoolkit-ui/src/components/intercept/intercept-option.tsx`

### Phase 4: Complete Mock/Modify Features

#### US-011: Draft-based save model for mock rules
**Description:** As a user, I want to edit multiple rules and save all changes at once (or revert) instead of each edit being saved immediately.

**Acceptance Criteria:**
- [ ] Rule edits are stored as drafts in memory (not sent to server until explicit save)
- [ ] "Save changes" button in the header activates when there are unsaved changes
- [ ] Per-rule save button (floppy disk icon) saves individual rules
- [ ] "Revert" button (undo icon) discards all unsaved changes
- [ ] Unsaved rules have a visual indicator (highlighted border or badge)
- [ ] Navigating away from Mock page prompts "You have unsaved changes"
- [ ] Reference: `httptoolkit-ui/src/model/rules/rules-store.ts`

#### US-012: Inline rule title editing
**Description:** As a user, I want to click on a rule's title to edit it in-place instead of using a browser prompt dialog.

**Acceptance Criteria:**
- [ ] Clicking the rule title (or rename button) turns the title into an editable text input
- [ ] Enter confirms the edit, Escape cancels
- [ ] Clicking away confirms the edit
- [ ] Empty title reverts to auto-generated summary
- [ ] Reference: `httptoolkit-ui/src/components/modify/rule-row.tsx`

#### US-013: Complete matcher and handler types
**Description:** As a power user, I want access to all the same matchers and handlers that HTTP Toolkit offers.

**Acceptance Criteria:**
- [ ] All ~20 matcher types implemented: Wildcard, per-Method, Host, Hostname, Port, FlexiblePath, RegexPath, RegexUrl, Header, ExactQuery, Query, FormData, MultipartFormData, RawBody, RawBodyIncludes, RegexBody, JsonBody, JsonBodyFlexible, Cookie, Protocol
- [ ] All ~13 handler types implemented: StaticResponse, FromFile, Passthrough, ForwardToHost, Transformer, RequestBreakpoint, ResponseBreakpoint, RequestAndResponseBreakpoint, CloseConnection, ResetConnection, Timeout, Delay (as chainable step), Webhook
- [ ] Matcher dropdown shows grouped options (by category)
- [ ] Handler dropdown shows "Common" and "Advanced" optgroups
- [ ] Reference: `httptoolkit-ui/src/model/rules/rule-definitions.ts`

### Phase 5: Electron Desktop App

#### US-014: Electron wrapper with window management
**Description:** As a user, I want HTTP FreeKit as a native desktop application with a proper window, menu bar, and system tray.

**Acceptance Criteria:**
- [ ] Electron main process manages window lifecycle (create, minimize, close)
- [ ] Window size 1366x768 default, min 700x600, state persisted via `electron-window-state`
- [ ] Application menu with: File (New Session, Close/Quit), Edit (undo/redo/cut/copy/paste), View (zoom, fullscreen, devtools), Help
- [ ] Platform-specific shortcuts (Cmd on macOS, Ctrl on Windows/Linux)
- [ ] Close button minimizes to tray (optional setting)
- [ ] Tray icon with context menu (Show/Hide, Quit)
- [ ] Reference: `httptoolkit-desktop/src/index.ts`, `httptoolkit-desktop/src/menu.ts`

#### US-015: Bundled server with auto-start
**Description:** As a user, I want the HTTP proxy server to start automatically when I launch the desktop app.

**Acceptance Criteria:**
- [ ] Server binary bundled inside the Electron app resources
- [ ] Server spawned as a child process on app launch
- [ ] Random auth token generated per session for API security
- [ ] Server stdout/stderr captured to log file
- [ ] Graceful shutdown via HTTP POST to `/api/shutdown` on app close
- [ ] 3-second timeout before force-kill on shutdown
- [ ] Server port auto-detected (first available in configured range)
- [ ] Reference: `httptoolkit-desktop/src/index.ts`

#### US-016: Auto-update system
**Description:** As a user, I want the app to check for updates and install them automatically.

**Acceptance Criteria:**
- [ ] Use `electron-updater` for auto-update on Windows/macOS
- [ ] Check for updates on launch and periodically (every 6 hours)
- [ ] Show notification when update is available
- [ ] Download and install on next restart
- [ ] Linux: check GitHub releases and prompt user
- [ ] Reference: `httptoolkit-desktop/electron-builder.config.cjs`

#### US-017: Cross-platform packaging
**Description:** As a developer, I want to build distributable packages for all major platforms.

**Acceptance Criteria:**
- [ ] Windows: `.exe` installer (NSIS) and portable `.zip`
- [ ] macOS: `.dmg` with app bundle, code signed
- [ ] Linux: `.AppImage`, `.deb`, `.rpm`
- [ ] Electron Builder configured with proper metadata (name, icon, description)
- [ ] App icon in all required sizes (16x16 through 1024x1024)
- [ ] Build scripts in package.json: `build:win`, `build:mac`, `build:linux`
- [ ] Reference: `httptoolkit-desktop/electron-builder.config.cjs`

### Phase 6: Advanced Features & Polish

#### US-018: Content perspective toggle
**Description:** As a user debugging mock rules, I want to switch between seeing the original request vs the transformed request that was sent upstream.

**Acceptance Criteria:**
- [ ] When a request was modified by a mock rule, show a "Transform" card at the top of the detail pane
- [ ] Dropdown with options: "Show original content", "Show transformed content", "Show client's perspective", "Show server's perspective"
- [ ] Switching perspective updates all cards (headers, body, URL)
- [ ] Visual indicator showing which perspective is active
- [ ] Reference: `httptoolkit-ui/src/components/view/http/transform-card.tsx`

#### US-019: WebRTC interception
**Description:** As a developer, I want to see WebRTC connections and data channel messages in the traffic list.

**Acceptance Criteria:**
- [ ] WebRTC connections appear as distinct row type
- [ ] Data channel messages captured and displayed
- [ ] Media track info shown (direction, type, codec)
- [ ] Detail pane for each WebRTC event type
- [ ] Reference: `httptoolkit-ui/src/components/view/rtc-*`

#### US-020: Custom theme file upload
**Description:** As a user, I want to upload a `.htktheme` file to customize the app's colors.

**Acceptance Criteria:**
- [ ] Settings page allows uploading `.htktheme` / `.htk-theme` / `.json` files
- [ ] Custom theme overrides CSS variables from the file
- [ ] Theme color preview grid shows 10 color swatches
- [ ] Invalid theme files show error message
- [ ] Custom theme persists in localStorage
- [ ] Reference: `httptoolkit-ui/src/components/settings/settings-page.tsx`

#### US-021: ARIA accessibility compliance
**Description:** As a user with assistive technology, I want the app to be fully keyboard-navigable and screen-reader compatible.

**Acceptance Criteria:**
- [ ] All interactive elements have proper ARIA roles (`role="grid"`, `role="row"`, `role="button"`, etc.)
- [ ] `aria-label` on all icon-only buttons
- [ ] `aria-expanded` on collapsible cards and groups
- [ ] `aria-selected` on traffic rows and tabs
- [ ] `aria-activedescendant` for keyboard navigation in the traffic list
- [ ] Focus management: Tab/Shift+Tab moves between major regions, arrows within regions
- [ ] Skip-to-content link for keyboard users
- [ ] Color contrast ratios meet WCAG 2.1 AA (4.5:1 for text, 3:1 for large text)
- [ ] Reference: `httptoolkit-ui/src/components/view/view-event-list.tsx` (ARIA attributes)

---

## Functional Requirements

### Proxy Engine
- FR-1: HTTP/1.1 proxy with full request/response capture
- FR-2: HTTPS MITM via dynamic per-host certificate generation (node-forge CA)
- FR-3: HTTP/2 support with ALPN negotiation (client-side h2, upstream h1 or h2)
- FR-4: WebSocket frame-level interception (parse opcodes, payloads, direction)
- FR-5: TLS passthrough for configured hostnames (bypass MITM)
- FR-6: Upstream proxy chaining (HTTP, HTTPS, SOCKS4, SOCKS4a, SOCKS5, SOCKS5h)
- FR-7: Request/response body decompression (gzip, brotli, deflate, zstd)
- FR-8: Connection timeout (30s default)
- FR-9: WebSocket passthrough with frame counting
- FR-10: TLS failure event capture
- FR-11: Source detection from User-Agent header

### Mock/Modify Engine
- FR-12: ~20 matcher types with AND logic (all matchers must match)
- FR-13: ~13 handler/action types including transform, breakpoint, file serve
- FR-14: Pre-step chaining (delay, add-header, remove-header, rewrite-url, rewrite-method)
- FR-15: Rule grouping with hierarchical folders
- FR-16: Rule priority (high/normal) with high-priority rules checked first
- FR-17: Rule enable/disable without deletion
- FR-18: Drag-and-drop reordering (including cross-group, Shift+Drop to combine)
- FR-19: Import/export as `.htkrules` JSON format
- FR-20: Default passthrough rule on first launch

### API Server
- FR-21: REST API on configurable port (default 8001)
- FR-22: WebSocket for real-time traffic streaming
- FR-23: CORS for localhost access
- FR-24: HAR 1.2 import and export
- FR-25: Traffic search with structured filters (method, status range, host, path, headers, body)
- FR-26: Breakpoint API (create, list pending, resume with modifications)
- FR-27: OpenAPI spec management (upload, match against traffic, auto-documentation)
- FR-28: Client certificate, trusted CA, and HTTPS whitelist configuration

### UI
- FR-29: 75px icon sidebar with 5 tabs (Intercept, View, Mock, Send, Settings)
- FR-30: Intercept page with 4-column CSS Grid, card-based interceptors, connected sources
- FR-31: Traffic table with virtual scrolling, 6 columns, row markers, selection, keyboard nav
- FR-32: Detail pane with collapsible cards (Request, Body, Response, API, Trailers, Performance, Export)
- FR-33: Monaco Editor for all body viewing/editing
- FR-34: Mock page with full rule editor, groups, drag-drop, inline editing
- FR-35: Send page with tabs, method selector, key-value headers, body format dropdown, split pane
- FR-36: Settings with proxy, connection, TLS, HTTP/2, certificates, API specs, themes
- FR-37: Right-click context menus on traffic rows and headers
- FR-38: Keyboard shortcuts matching HTTP Toolkit (Ctrl+1-4, arrows/jk, Ctrl+P/R/M/F, etc.)
- FR-39: Responsive layout at 1100px and 768px breakpoints
- FR-40: Dark, Light, High-Contrast, and Automatic themes

### Desktop App (Electron)
- FR-41: Cross-platform packaging (Windows .exe, macOS .dmg, Linux .AppImage)
- FR-42: Bundled server with auto-start and graceful shutdown
- FR-43: Application menu (File, Edit, View, Help)
- FR-44: Window state persistence (size, position, maximized)
- FR-45: Auto-update via electron-updater

---

## Non-Goals (Out of Scope)

- **No account management** — no login, subscription, billing, or Pro/Free tier distinction
- **No hosted web UI** — the UI is served locally by the bundled server, not from app.httptoolkit.tech
- **No telemetry/analytics** — no Sentry, Mixpanel, or any external data collection
- **No Docker deployment** — desktop app only (server can be run standalone for development)
- **No mobile apps** — desktop only (Windows, macOS, Linux)
- **No backwards compatibility with HTTP Toolkit's data formats** — we use our own config/data paths

---

## Design Considerations

### Branding
- App name: "HTTP FreeKit"
- Logo: Custom icon (current globe+cross SVG or a new design), color #e1421f
- All references to "HTTP Toolkit" in UI text replaced with "HTTP FreeKit"
- About section shows HTTP FreeKit version, MIT license, GitHub link

### Design System (from `httptoolkit-ui/src/styles.ts`)
- **Fonts:** DM Sans (body), DM Mono (code), Saira (headings) — loaded from Google Fonts
- **Dark theme primary:** #32343B bg, #1e2028 container, #16181e input, #ffffff text
- **Light theme primary:** #fafafa bg, #e4e8ed container, #ffffff input, #1e2028 text
- **Accent (popColor):** #e1421f — used for active states, CTAs, focus indicators
- **Status colors:** 1xx=#888, 2xx=#4caf7d, 3xx=#5a80cc, 4xx=#ff8c38, 5xx=#ce3939
- **Method colors:** GET=#4caf7d, POST=#ff8c38, DELETE=#ce3939, PUT=#6e40aa, PATCH=#dd3a96, HEAD=#5a80cc, OPTIONS=#2fb4e0

### Component Library
- Use HTTP Toolkit's component patterns: Card, CollapsibleCard, LittleCard, BigCard, MediumCard
- Pill/Badge components for status codes, methods, content types
- EmptyState component (150px icon, 38px text, watermark color)
- Context menu system (floating positioned menu with separator support)

---

## Technical Considerations

### Architecture
```
http-freekit/
  electron/              # Electron main process
    main.js              # Window management, server lifecycle
    preload.js           # Context bridge API
    menu.js              # Application menu
  server/                # Node.js backend (runs as child process)
    proxy/               # MITM proxy engine
    api/                 # REST API + WebSocket
    interceptors/        # Browser, terminal, Docker, Android, JVM
  ui/                    # Frontend (served by Express)
    index.html           # SPA entry point
    styles.css           # Design system
    app.js               # Application logic
    vendor/              # Monaco Editor, Phosphor icons
  package.json           # Electron + server dependencies
  electron-builder.config.cjs  # Build configuration
```

### Dependencies to Add
- `electron` + `electron-builder` — desktop packaging
- `electron-window-state` — window state persistence
- `electron-updater` — auto-updates
- `monaco-editor` — code editor for body viewing
- `@phosphor-icons/web` — icon library
- `http2` — already in Node.js stdlib (imported)

### Performance Targets
- App launch to usable UI: < 3 seconds
- Traffic list: 60fps scroll at 100,000 rows
- Body viewer: < 200ms to render 1MB JSON
- Memory: < 500MB at 10,000 captured requests

### Security
- CA certificate installed in user trust store (not system-wide)
- CA certificate removed on uninstall
- Auth token per session for API access
- No external network calls except for update checks
- All proxy traffic stays local

---

## Success Metrics

- A user familiar with HTTP Toolkit cannot distinguish the UI layout from the original (aside from branding)
- All HTTP Toolkit interceptor types work on all supported platforms
- HTTP/2 requests display correctly with h2 protocol label
- WebSocket frames are individually visible and inspectable
- Mock rules import/export is compatible (`.htkrules` format)
- Desktop app installs and auto-updates on all three platforms
- WCAG 2.1 AA accessibility compliance on all interactive elements

---

## Open Questions

1. Should we support the `mockttp` library directly (HTTP Toolkit's underlying proxy) or keep our custom proxy? — Our proxy works but mockttp has more mature h2/WebSocket support
2. Should Monaco Editor be bundled or loaded from CDN? — Bundled is better for offline use but adds ~5MB to package size
3. Should we match HTTP Toolkit's exact Electron version or use latest? — Latest for security, but test compatibility
4. Do we need the web extension (httptoolkit-browser-extension) for existing browser interception? — Nice to have but not essential for v1
5. Should the server be TypeScript or keep JavaScript? — TypeScript would improve maintainability for a project this size
