# Repository bug audit

This ledger records findings from a repository-wide audit of `main` at `4c184e7`.
The audit covers startup and settings, the management API and MCP, proxy protocols
and mocking, certificates, interceptors, Electron lifecycle and packaging, renderer
behavior, styling and accessibility, dependencies, documentation, tests, and dead
code. The original audit documented findings without changing product code;
the statuses below now track their skeptical review and remediation.

## Original audit completion gate

Completion requires two consecutive complete passes over the current candidate with
no new bugs, broken features, broken styling, or dead code. A pass that finds
anything resets the clean-pass streak.

| Pass | Result | Clean-pass streak |
| --- | --- | ---: |
| 1 | Complete; 21 new findings from source review, browser/API/device-lifecycle probes, and protocol parity checks | 0/2 |
| 2 | Complete; 20 new findings from full source review, protocol/API/browser probes, platform fixtures, and dependency audit | 0/2 |
| 3 | Complete; 10 new functional findings, plus updated dependency advisory evidence | 0/2 |
| 4 | Complete; 11 new findings from full source and contract review, with independent browser, process and proxy reproduction checks | 0/2 |
| 5 | Complete; 11 new findings from full source review, renderer/proxy/lifecycle probes and support-file cross-checks | 0/2 |
| 6 | Complete; 4 new findings from full source and contract review, independently verified with proxy/browser and desktop-handler controls | 0/2 |
| 7 | Complete; 6 new findings from whole-repository contract/caller review, including five independently reproduced functional issues and one independently checked unused parser | 0/2 |
| 8 | Complete; 2 new findings from whole-repository contract/caller review, independently verified with a local proxy exchange and simulated JVM cache/runtime control | 0/2 |
| 9 | Complete; 5 new findings from full source/caller review, independently verified with local proxy/browser/JVM controls and simulated System Proxy recovery | 0/2 |
| 10 | Complete; 2 new findings from full source/caller review, independently reproduced with real local browser and HTTPS Forward controls | 0/2 |
| 11 | Complete; 4 new findings from full source/caller review, independently checked with local proxy/browser controls and isolated Windows Node children | 0/2 |
| 12 | Complete; 2 new findings from full source/caller review, independently checked with isolated manual-command and production-browser theme controls | 0/2 |
| 13 | Complete; 2 new findings from full source/caller review, independently verified with a generated shell-command control and a production-browser mock-load race | 0/2 |
| 14 | Complete; 1 new finding from whole-repository source/caller review, independently reproduced through native cURL and the production paste/Send flow | 0/2 |
| 15 | Complete; 3 new findings from whole-repository source/caller review, independently checked with production-browser and native PowerShell controls | 0/2 |
| 16 | Complete; 1 new finding from whole-repository source/caller review, independently reproduced with equivalent encoded responses through the production proxy | 0/2 |
| 17 | Complete; 2 new findings from whole-repository source/caller review, independently verified with WebSocket/browser and HTTP/1-versus-HTTP/2 webhook controls | 0/2 |
| 18 | Complete; 2 new findings from whole-repository source/caller review, independently verified with native multipart assembly and production HAR-import/browser controls | 0/2 |
| 19 | Complete; 1 new finding from whole-repository source/caller review, independently reproduced through the production mock API and local proxy | 0/2 |
| 20 | Complete; 1 new finding from whole-repository source/caller review, independently verified with production Send-tab browser and concurrency controls | 0/2 |
| 21 | **Clean**; complete whole-repository source, caller, test-contract and support review; no new findings | **1/2** |
| 22 | **Clean**; complete whole-repository source, caller, test-contract and support review; no new findings | **2/2** |

The previous audit's pass count does not apply to this revision. All seven
existing findings were rechecked against that source and remained open;
there were no solved entries to delete.

Passes 21 and 22 satisfy the completion gate. This revision records 111 new
findings and retained the seven original findings: 118 open entries at audit
completion. Current remediation statuses are recorded with each finding.

## Findings

### BUG-001 — Medium — Built-in Dark and Light theme text fails WCAG AA contrast

- **Status:** Awaiting user review.
- **Review:** the normal-text contrast failure is valid, but the remedy changes
  the visual palette. Asked whether to use separate accessible text colors,
  change the accent shades throughout both themes, or defer the design decision.
  No palette change is made pending that choice.
- **Evidence:** live Lighthouse accessibility audits of Intercept, View, Mock,
  Send, and every Settings section in Dark report contrast failures. The orange
  `--pop-color` text is only 3.58:1 against the footer, 2.95:1 against Settings
  cards, and 2.65:1 on an active Settings navigation item; the Mock “Add a new
  rule” label is 3.69:1. Light also renders the active navigation item at 3.32:1
  and footer values at 3.75:1. Normal text requires 4.5:1. These combinations
  come from the theme tokens and contextual rules in `src/ui/styles.css`, plus
  inline `color:var(--pop-color)` uses in `src/ui/index.html:671-672`.
- **Impact:** port values, active Settings navigation, Settings values, and the
  primary add-rule affordance are hard to read for low-vision users and fail
  WCAG 1.4.3. Depending on the route, Lighthouse's accessibility score falls to
  0.91–0.97.
- **Coverage gap:** `test/ui/theme-contrast.test.js` checks selected token pairs,
  but not the actual `color-mix()` backgrounds or inline foreground/background
  combinations rendered in these controls.
- **Expected:** every normal-text foreground/background pair in each built-in
  theme should have a contrast ratio of at least 4.5:1, including active,
  footer, and card states.

### BUG-002 — Medium — Generated primary controls override their visible labels with different accessible names

- **Status:** Open.
- **Evidence:** Interceptor cards render a button containing the interceptor name,
  description, and state, then replace that content's accessible name with an
  action-only `aria-label` such as “Start intercepting Chrome”
  (`src/ui/app.js:6300-6320`). The manual “Anything” card is similarly renamed
  “Show manual proxy setup instructions” (`:6353-6359`). Mock-rule disclosure
  buttons visibly contain method, matcher, and action text but are renamed only
  “Show rule details” or “Collapse rule details” (`:7990-8018`). Lighthouse's
  `label-content-name-mismatch` audit flags the live Intercept cards and default
  Mock rule.
- **Impact:** speech-input users cannot reliably activate these controls using
  their full visible labels, while screen-reader users hear a different label
  from the information shown on screen. This fails the WCAG 2.5.3 label-in-name
  requirement.
- **Expected:** keep the visible identifying text in the computed accessible name
  and expose action/state without replacing it (for example, with a label that
  contains the visible text or with separately associated descriptive text).

### BUG-003 — Medium — Mock and Send expose invalid ARIA control structures

- **Status:** Open.
- **Evidence:** each `.mock-rule-card` is a plain draggable `div` with
  `aria-expanded`, although that attribute is not permitted for its implicit
  generic role; the nested disclosure button already carries the valid expanded
  state (`src/ui/app.js:8004-8018`). The Send tab list contains presentation
  wrappers with both a tab and a close button and appends a “New request tab”
  button directly to the tab list (`src/ui/app.js:10872-10933`), although a
  `tablist` requires owned `tab` children. Lighthouse reports
  `aria-allowed-attr` on Mock and `aria-required-children` on Send.
- **Impact:** assistive technologies can ignore or misrepresent expansion state
  and tab membership, making rule navigation and request-tab management
  unreliable.
- **Expected:** put expanded state only on a control/role that supports it, and
  structure the request tabs so the tab list owns only tabs while close/add
  actions remain valid, separately operable controls.

### BUG-004 — Low — Backend and interceptor compatibility APIs and state have no production consumer

- **Status:** Open (dead code).
- **Evidence:** `ApiServer._transferTrafficGeneration()` is declaration-only
  (`src/api/api-server.js:2703-2709`). `ProxyServer._normalizeNoProxyEntries()`
  and `_normalizeTlsHostname()` are declaration-only while live code calls the
  imported normalization helpers directly (`src/proxy/proxy-server.js:2992-2994,
  3372-3374`). `filterDefaultExclusions()` has no caller, and
  `matchesDefaultExclusion()` is used only by tests
  (`src/traffic/default-exclusions.js:205-212`). System Proxy's
  `activeWinHttpSettings` and Existing Terminal's `proxyPort` are only assigned
  or cleared and are never read
  (`src/interceptors/system-proxy-interceptor.js:23,649,734,843,874,951`;
  `src/interceptors/terminal-interceptors.js:1582,1594,1617`).
- **Impact:** unused alternate APIs and write-only state enlarge the maintenance
  and test surface while suggesting lifecycle behavior that the product does not
  implement through those fields.
- **Expected:** remove the wrappers, unused export, and write-only fields; test
  the production normalization and filtering entry points directly.

### BUG-005 — Low — Renderer declarations and legacy stylesheet blocks are orphaned

- **Status:** Open (dead code).
- **Evidence:** production cross-reference finds declaration-only
  `parseTrafficViewHash()`, `parseTrafficViewLifecycleHash()`,
  `contentTypeToMonacoLanguage()`, `toggleHexView()`, deprecated no-ops
  `updateSendBodyPreview()`/`toggleSendBodyView()`, and `tryPrettyJson()` in
  `src/ui/app.js`. `loadSendHeadersFromJson()` is called only by test harnesses.
  `INTERCEPTOR_COLORS`, renderer `MOCK_MATCHER_TYPES`, `methodColor`, and
  `perspectiveLabels` are unused. Queries for nonexistent `mockBadgeCount` and
  `manualProxyPort` elements remain, with the latter supplied only by a test
  stub. Orphan CSS includes the old header/search/sidebar fragments
  (`src/ui/styles.css:520-566,620-635,677-690`), detail tabs/sections/header tables
  (`:1241-1258,1266-1277,1382-1406`), legacy panel/mock form selectors
  (`:2320-2338,2347-2374`), `.settings-section` (`:2548-2562`), and the removed
  Send form/response and footer-child selectors (`:2924-2980,3081-3085`).
- **Impact:** stale code is shipped to every renderer, tests preserve pseudo-APIs
  that users cannot reach, and obsolete CSS obscures which layout rules still
  affect the product.
- **Expected:** remove orphan declarations and selectors, and migrate tests from
  test-only renderer helpers to live production entry points.

### BUG-006 — Medium — Pako fails to load, breaking every compressed gRPC preview

- **Status:** Fixed.
- **Review:** reproduced with the actual shipped vendor bundles and fresh Chrome;
  both Protobuf and Pako register anonymous AMD modules after Monaco loads.
  This is an initialization defect, not an intentional decompression limit.
- **Resolution:** load the UMD codecs before Monaco installs its AMD loader,
  preserving their browser globals and leaving Monaco's module queue clean.
- **Verification:** all 14 focused bootstrap, gRPC-limit and Monaco-fallback
  tests pass, including the new actual-bundle and Chrome bootstrap regressions.
  A fresh shipped-UI browser check also confirms Monaco initializes, gzip and
  deflate gRPC messages decode to field 1 = 150, and no startup exception occurs.
- **Evidence (before fix):** the page loads Monaco's AMD loader before the Pako UMD bundle
  (`src/ui/index.html:679-692`). In a live Chrome renderer, Pako's anonymous AMD
  registration throws `Error: Can only have one anonymous define call per script
  file` from Monaco's loader, leaving `typeof window.pako === "undefined"` on
  every route. `decompressGrpcMessage()` requires `window.pako.Inflate` and
  otherwise throws “streaming pako decompression is not available”
  (`src/ui/app.js:4962-4985`). The same startup also logs a duplicate
  `vs/editor/editor.main` module warning, showing that the foreign UMD registration
  is contaminating Monaco's module queue.
- **Impact:** any gRPC or Connect message whose compressed flag is set and whose
  encoding is gzip or deflate cannot be decompressed or decoded in the body
  viewer. Users receive only an “unable to decompress” diagnostic for valid
  captured traffic.
- **Coverage gap:** `test/ui/grpc-decompression-limits.test.js` imports Pako as a
  Node module and injects a handcrafted `window.pako`, while dependency tests
  check that the bundle exists but never load the real script sequence from
  `index.html`.
- **Expected:** load Pako without registering it into Monaco's AMD loader (for
  example, before the loader is installed or as an explicit module) and add a
  browser-level bootstrap test that proves `window.pako.Inflate` is available
  without uncaught startup exceptions.

### BUG-007 — Medium — The advertised High Contrast theme cannot be selected

- **Status:** Fixed.
- **Review:** the shipped Settings option and README explicitly promise this
  existing palette. Fresh Chrome and a regression test reproduced rejection
  before any CSS or editor design change was considered.
- **Resolution:** accept and restore `high-contrast`, register a Monaco theme
  inheriting its built-in `hc-black` palette, and select it for both live theme
  changes and newly created editors. Storage failures retain the prior theme.
- **Verification:** 27 focused theme, storage, Monaco readiness and cleanup tests
  pass. The shipped-UI browser check exercises the Settings change handler,
  reloads the persisted selection, creates a real high-contrast Monaco editor,
  and switches back to Light and Dark successfully.
- **Evidence (before fix):** Settings offers `<option value="high-contrast">High Contrast</option>`
  (`src/ui/index.html:580-584`) and the README advertises it as a built-in theme
  (`README.md:182-189`), but `VALID_THEME_SELECTIONS` contains only `dark`,
  `light`, `auto`, and `custom` (`src/ui/app.js:16739`). `setTheme()`
  rejects anything outside that list before applying or persisting it
  (`:17041-17049`). A live selection attempt returns `false`, retains the prior
  `data-theme` and stored selection, and shows “Theme selection is invalid”. In
  addition, only Dark and Light Monaco themes are defined (`:16388,16432`), and
  both `getMonacoTheme()` and `setTheme()` map every non-Light palette to the
  Dark editor theme (`:16679-16682,17074`).
- **Impact:** the accessibility-oriented theme is unreachable from the product
  despite its complete CSS palette and visible Settings option. The dropdown can
  temporarily display High Contrast while the page still uses the prior colors,
  which makes the setting actively misleading.
- **Coverage gap:** `test/ui/theme-contrast.test.js` validates the dormant
  high-contrast CSS variables but never exercises the Settings option through
  `setTheme()` or verifies persistence and reload behavior.
- **Expected:** accept, apply, persist, and restore `high-contrast`, define a
  matching high-contrast editor theme, and cover the real selection path in
  addition to auditing its CSS tokens.

### BUG-008 — Medium — Formatting Send bodies corrupts valid CSS strings and JavaScript regexes

- **Status:** Open.
- **Evidence:** `beautifyCss()` inserts newlines at every semicolon and brace,
  including inside quoted strings (`src/ui/app.js:5406-5429`).
  `beautifyJs()` recognizes regex literals only after selected punctuation,
  missing a literal following `return` (`:5312-5403`). The Send Format action
  replaces the editable request body with these results (`:10388-10400`);
  body previews use the same formatters (`:5519-5522,5564-5565`).
- **Reproduction:** in Send, choose CSS, enter `p::before{content:"a;b";}`,
  and click Format. A literal newline is inserted inside `"a;b"`; Chrome's
  CSS parser changes the rule's `content` from `"a;b"` to an empty value.
  Choose JavaScript and format `function f(){return /a{2}/.test("aa");}`:
  newlines are inserted inside the regex and compiling the result throws
  `Invalid regular expression: missing /`. Both were reproduced through the
  shipped renderer in Chrome with Monaco loaded.
- **Impact:** a formatting operation changes or invalidates the body that will
  be sent; formatted captured-body previews can also misrepresent valid content.
- **Expected:** use syntax-aware formatting that preserves string and regex
  contents, or retain the original body when safe formatting is unavailable.

### BUG-009 — Medium — Native menus retain a destroyed window after shutdown recovery

- **Status:** Fixed.
- **Review:** confirmed that menu callbacks capture a specific window and that
  shutdown recovery can replace it without rebuilding the menu. The regression
  failed for replacement windows on all three simulated desktop platforms;
  surviving-window controls passed before the fix.
- **Resolution:** rebuild and install the application menu during failed-quit
  recovery, binding its callbacks to the recovered window.
- **Verification:** 32 focused desktop tests pass, including real menu callbacks
  for Reload, About, documentation failures and macOS Close after recovery.
  These tests mock native Electron boundaries; no native macOS run was performed.
- **Evidence (before fix):** `runQuitCleanup()` destroys the prepared window before backend
  cleanup (`electron/quit-cleanup.cjs:80`). On cleanup failure,
  `restoreWindowAfterFailedQuit()` creates another window and rebuilds the tray
  and updater, but leaves the application menu unchanged
  (`electron/main.cjs:421-439`). `buildAppMenu()` is called only during startup;
  its Reload, About, and macOS Close actions capture the original window
  (`electron/menu.cjs:46,69,103`).
- **Reproduction:** make managed-interceptor restoration fail during Quit, then
  use View > Reload or Help > About in the recovered window. Evaluating the
  real main/menu/quit-cleanup modules with a native-window test double produces
  `Object has been destroyed` for both actions; macOS File > Close fails too.
  A live replacement exists but receives zero reload calls.
- **Impact:** the recovery window's native actions break precisely when the app
  remains open to let the user address cleanup failures.
- **Expected:** rebuild the menu for the replacement window or resolve the live
  window when each action runs.

### BUG-010 — High — Packaged macOS paths never resolve to the unpacked backend

- **Status:** Fixed.
- **Review:** the macOS packaging hook explicitly stages `Contents/Resources`,
  confirming a resolver mismatch rather than an unsupported bundle layout.
  A new macOS-layout regression fails before the fix.
- **Resolution:** recognize both `resources` and `Resources` while preserving
  exact archive names, already-unpacked paths and earlier matching ancestors.
- **Verification:** 38 focused path, startup, MCP-host and test-layout checks
  pass. The new test covers all three resolvers with the actual macOS spelling;
  native macOS package execution was not performed on this Windows host.
- **Evidence (before fix):** `PACKED_RESOURCES_PATTERN` matches only lowercase `resources`
  (`electron/asar-path.cjs:3`), but the macOS packaging hook stages the backend
  beneath `Contents/Resources/app.asar.unpacked`
  (`scripts/mac-node-architecture.cjs:55`). For
  `/Applications/HTTP FreeKit.app/Contents/Resources/app.asar/electron`, the Node,
  server, and MCP resolvers all return paths still inside `app.asar`.
  `startServer()` uses these paths for the standalone executable, script and
  working directory (`electron/main.cjs:110-111,149-153`).
- **Reproduction:** call all three resolvers with the macOS application path.
  Each result contains `/Resources/app.asar/`, rather than
  `/Resources/app.asar.unpacked/`. In a macOS-layout filesystem fixture with an
  archive file and an unpacked backend, standalone Node reports
  `MODULE_NOT_FOUND` for the returned script and successfully runs the actual
  unpacked script. This confirms the path failure without a native macOS run.
- **Impact:** both advertised macOS architectures cannot launch the packaged
  backend; the MCP bridge path is affected as well.
- **Coverage gap:** the POSIX packaged-path tests use Linux's lowercase
  `resources` directory, missing macOS's actual bundle layout.
- **Expected:** recognize the real macOS resource-directory spelling while
  retaining exact archive-segment matching and ancestor preservation.

### BUG-011 — Low — MCP labels complete HAR-imported response bodies as truncated

- **Status:** Fixed.
- **Review:** complete HAR bodies legitimately carry decoded size; modern
  truncated captures have an explicit flag. Legacy boxed capture strings still
  use size properties as their truncation marker, so that fallback is retained.
- **Resolution:** derive normal-body truncation from the explicit provenance
  flag and restrict the size-property fallback to legacy boxed bodies.
- **Verification:** 42 focused MCP, HAR and test-layout checks pass. The new
  export/import-to-MCP regression failed before the fix and now distinguishes
  complete and truncated empty, ASCII and Unicode bodies. Existing production
  boxed-body and interrupted-capture tests also pass.
- **Evidence (before fix):** `retainedBody()` treats any defined decoded size as proof of
  truncation (`src/mcp/mcp-server.js:240-254`). A normal HAR response's
  `content.size` becomes `responseBodyDecodedSize` even when no truncation
  occurred (`src/ui/har-import.js:366-369,402`).
- **Reproduction:** capture a complete five-byte `hello` response, export it to
  HAR, and import that HAR through `/api/traffic/import-har`. The import returns
  200 and retains all five bytes with no `responseBodyTruncated` flag. A real
  SDK MCP `get_request_detail` call changes from `truncated:false` before the
  round trip to `truncated:true` afterward, alongside `totalLength:5`,
  `previewLength:5`, and `hasMore:false`.
- **Impact:** MCP consumers are told that a complete imported capture is missing
  bytes, undermining body analysis and replay decisions.
- **Expected:** derive truncation from actual capture provenance, preserving
  compatibility with genuinely truncated boxed bodies.

### BUG-012 — Medium — Batched traffic import rejects WebSocket parents in earlier batches

- **Status:** Fixed.
- **Review:** the route already validates the assembled transaction before
  atomic commit. Per-batch relationship validation incorrectly treats that
  batch as the entire import; row-shape validation can still run immediately.
- **Resolution:** defer parent-reference validation for transaction batches
  until assembly, retaining full validation for standalone imports and commits.
- **Verification:** 26 focused API/import and test-layout checks pass. Four new
  HTTP regressions fail before the fix and pass afterward, covering parents in
  earlier/later batches with lifecycle and legacy IDs. Missing or mismatched
  parents still discard the transaction without retaining any rows.
- **Evidence (before fix):** the import route validates each batch before staging it
  (`src/api/routes/traffic-routes.js:314-331`). WebSocket parent validation
  considers only retained traffic and the current batch
  (`src/api/api-server.js:1092-1113`), excluding earlier staged transaction rows.
- **Reproduction:** importing a WebSocket parent and its frame together returns
  200 with two imported rows. Submit the same parent as transaction batch 0 of 2:
  it returns 202 with one staged row. Submit the frame as batch 1, referencing
  that parent's lifecycle: the route returns 400,
  `ERR_TRAFFIC_IMPORT_TRANSACTION`, and
  `parentTrafficLifecycleId does not match an imported or retained WebSocket parent`.
  The transaction is discarded and neither row is retained.
- **Impact:** valid JSON traffic imports fail whenever a WebSocket parent and
  its frame fall on opposite sides of a batch boundary.
- **Expected:** validate parent references against the assembled transaction
  before its atomic commit, including parents staged by preceding batches.

### BUG-013 — Medium — Fresh Firefox profiles bypass interception for localhost traffic

- **Status:** Fixed.
- **Review:** Mozilla's current proxy implementation confirms a separate
  loopback bypass even with an empty explicit bypass list. This conflicts with
  the isolated interception profile's intended coverage of local development.
- **Resolution:** enable `network.proxy.allow_hijacking_localhost` in generated
  interception profiles, retaining the existing proxy and certificate settings.
- **Verification:** 12 focused profile, certificate, lifecycle and test-layout
  checks pass; the profile regressions fail before the change. Installed Firefox
  also sent HTTP requests for `localhost`, `127.0.0.1` and `[::1]` through a local
  test proxy using three fresh production-generated profiles.
- **Evidence (before fix):** the generated Firefox `user.js` clears
  `network.proxy.no_proxies_on` but never sets
  `network.proxy.allow_hijacking_localhost` (`src/interceptors/browser-interceptor.js:592-610`).
  Firefox independently excludes loopback destinations unless that preference
  is enabled; see [Mozilla's proxy implementation](https://raw.githubusercontent.com/mozilla-firefox/firefox/main/netwerk/base/nsProtocolProxyService.cpp)
  and [Mozilla issue 1535581](https://bugzilla.mozilla.org/show_bug.cgi?id=1535581).
- **Reproduction:** generate a fresh profile using the production profile helper:
  the explicit bypass list is empty and the loopback opt-in is absent. Launch
  that profile and visit a local HTTP service through `localhost`, `127.0.0.1`,
  or `::1`; Firefox's documented implicit bypass routes it directly. Profile
  generation was tested here; the bypass conclusion follows Mozilla's source.
- **Impact:** local development traffic is absent from View and cannot be mocked
  despite Firefox being presented as intercepted.
- **Expected:** configure the isolated interception profile to proxy loopback
  requests as well as external destinations.

### BUG-014 — High — Failed repeat JVM activation forgets an already-intercepted process

- **Status:** Fixed.
- **Review:** confirmed that definite pre-mutation failure on a retry deletes
  ownership from the earlier attach. Preserve that record rather than changing
  the existing repeat-activation behavior.
- **Resolution:** restore prior ownership after failed preparation or target
  revalidation, retaining it in memory if journal restoration fails.
- **Verification:** 27 focused JVM and test-layout checks pass; one compiled-agent
  runtime check skips because Java tools are unavailable. New regressions verify
  journal preservation and a restore action after interceptor restart for both
  failure paths. The preparation regression failed before the fix.
- **Evidence (before fix):** `activate(pid)` replaces the existing PID's active ownership with
  pending state (`src/interceptors/jvm-interceptor.js:1501`). When repeated
  preparation fails before a new mutation, `_forgetTrackedOwnership(pid)` removes
  that state and its recovery journal (`:1572-1578`). Later deactivation has no
  tracked target to restore (`:1659-1661,1720-1727`).
- **Reproduction:** successfully activate a JVM PID, then activate the same PID
  again while helper preparation fails before changing the target. A production
  `activate()`/`_attachAgent()` probe with simulated external helpers reports
  `trackedTargets:0`, `journalExists:false`, `targetProxied:true` and
  `restoreAttempts:0` after Stop.
- **Impact:** the JVM retains its existing proxy configuration while FreeKit
  loses both live ownership and durable recovery information; Stop cannot restore
  it and exiting FreeKit can leave its network requests pointed at a dead proxy.
- **Expected:** preserve the earlier active ownership on repeat-activation failure,
  or reject/return the current active state before replacing it.

### BUG-015 — Medium — Android refresh reports unreachable recovered proxies as active

- **Status:** Fixed.
- **Review:** recovery already treats incompatible listener binds as uncertain;
  refresh was incorrectly promoting the same endpoint based only on ownership.
- **Resolution:** apply the existing bind-reachability check during global-proxy
  reconciliation, retain cleanup ownership and clear stale bind errors once the
  endpoint becomes reachable.
- **Verification:** 15 focused Android recovery, presentation and test-layout
  checks pass. The new regression failed before the fix and now covers an
  unreachable recovered LAN endpoint, a reachable bind and a return to loopback.
  Device readback is simulated; no physical-device network test was performed.
- **Evidence (before fix):** recovery correctly marks a saved LAN proxy endpoint uncertain
  when the current proxy binds only to loopback
  (`src/interceptors/android-adb-interceptor.js:240-262`). Once the device is
  connected, metadata refresh promotes that entry to `global-proxy` solely
  because the device's proxy string matches the saved value (`:492-509`), without
  rechecking endpoint reachability.
- **Reproduction:** recover an Android journal with a LAN proxy host while the
  current bind is `127.0.0.1`; simulate reconnecting the device with the matching
  saved proxy setting. Production recovery and metadata methods change
  `initialMode:proxy-uncertain` to `afterRefreshMode:global-proxy` and report
  `interceptionActive:true`, `activationUncertain:false`, although
  `_isProxyHostReachable()` remains false.
- **Impact:** the UI declares interception active while the device cannot reach
  the proxy, concealing the cause of its failed network requests.
- **Expected:** retain uncertain status until both ownership and endpoint
  reachability are established.

### BUG-016 — Medium — Failed update shutdown leaves updater IPC permanently unavailable

- **Status:** Awaiting user review.
- **Review:** missing IPC is confirmed, but clearing the local handoff flag is
  not cancellation of the native installer. The installed electron-updater
  BaseUpdater calls installation before app.quit, and NsisUpdater starts the
  installer process. Its handoff guard protects against untagged late events.
  User decision requested: move managed cleanup before installer launch, retain
  launch order with an explicit recovery/restart state, or defer this finding.
- **Evidence:** install sets `installerHandoffMayEmit = true`
  (`electron/updater.cjs:618`). Quit cleanup stops the updater, releases
  `activeInstallRequest`, and removes its IPC handlers (`:660-685`). After a
  backend cleanup failure, main calls `cancelUpdateInstall()`
  (`electron/main.cjs:721`), which returns early because that request is gone
  (`electron/updater.cjs:114-118`). Recovery cannot initialize the updater because
  the handoff flag remains true (`:438`).
- **Reproduction:** download an update, choose Restart to install, and encounter
  a managed-interceptor cleanup failure. A probe using the real updater and
  `runQuitCleanup()` with simulated native operations confirms one install call,
  `canceled:false`, `reinitialized:false`, and no remaining updater IPC handlers.
- **Impact:** Check for Updates, updater status, and Restart to install stop
  working in the recovered window until the entire process is restarted.
- **Expected:** retain enough install state through failed shutdown to cancel
  the handoff and restore the updater's handlers safely.

### BUG-017 — Medium — TLS settings silently miss equivalent IPv6 address spellings

- **Status:** Fixed.
- **Review:** equivalent addresses produce different textual keys despite
  identifying the same destination; shared normalization is the appropriate fix.
- **Resolution:** canonicalize IPv6 addresses through URL parsing while retaining
  distinct zone suffixes and the existing hostname and IPv4 validation.
- **Verification:** 15 focused TLS, client-certificate, settings and test-layout
  checks pass. New regressions failed before the change. Matching tests cover
  expanded/compressed, IPv4-mapped and scoped IPv6 forms in both directions,
  nonmatching addresses/zones, and exact client-certificate selection.
- **Evidence (before fix):** `normalizeExactTlsHostname()` strips IPv6 brackets and lowercases
  text without canonicalizing the address (`src/proxy/https-whitelist.js:35-38`).
  TLS passthrough, the verification whitelist, and exact client-certificate
  selection use those textual keys (`src/proxy/proxy-server.js:3108,3376,3381`).
- **Reproduction:** configure `[0:0:0:0:0:0:0:1]` in TLS passthrough and the
  HTTPS verification whitelist. Both settings are accepted and match that text.
  URL parsing normalizes the same destination to `[::1]`; production matching
  methods then return false for both settings and upstream TLS options retain
  `rejectUnauthorized:true`. The probe confirms both URLs identify the same IP.
- **Impact:** valid saved IPv6 settings are ignored for requests to the identical
  endpoint when compressed and expanded spellings differ.
- **Expected:** compare canonical IP identities for all TLS host settings.

### BUG-018 — Medium — Mock header renaming makes later edits update the wrong header

- **Status:** Fixed.
- **Review:** duplicate grouping changes flattened indexes while controls keep
  their original positions. This is data corruption, not a header ordering choice.
- **Resolution:** retain draft header row order in a WeakMap keyed by each
  generated header object, and preserve that order through edit/add/remove.
  Serialized headers retain the existing grouped format without editor metadata.
- **Verification:** 14 focused header and test-layout checks pass. Four new
  regressions failed before the fix and cover all shared editor variants. A
  shipped-UI Chrome check exercises generated change/remove handlers and confirms
  duplicate renames, later edits and additions preserve the intended values.
- **Evidence (before fix):** `updateMockHeaderEditorRow()` rebuilds a grouped header object
  after each edit; duplicate names change the flattened row indexes, but the
  visible controls retain their earlier indexes (`src/ui/app.js:9182-9226`).
  The shared helper also edits webhook and transform headers.
- **Reproduction:** open fixed-response headers `X-A=one`, `X-B=two`,
  `X-C=three`. Rename the third visible header to `X-A`, then change the visible
  middle `X-B` value to `edited-B`. Save and Save All. Real Chrome controls and
  the API confirm the saved result is `X-A:[one,edited-B]`, `X-B:two`, rather
  than `X-A:[one,three]`, `X-B:edited-B`.
- **Impact:** ordinary header edits silently change another field's value.
- **Expected:** retain stable row identity through duplicate-name edits or
  synchronize the displayed row order before accepting subsequent edits.

### BUG-019 — Medium — Saving an open mock editor overwrites its inline title rename

- **Status:** Fixed.
- **Review:** confirmed that the accepted rename updates collection state but
  leaves the same rule's open editor stale; Save then restores the old title.
- **Resolution:** synchronize the matching open editor's title on confirmed
  inline rename, preserving its other pending fields.
- **Verification:** 43 focused editor, Save All, unload and test-layout checks
  pass. New rename and title-removal regressions failed before the fix; both
  now retain unrelated field edits. A different-rule rename control also passes.
- **Evidence (before fix):** inline rename updates the rule and collection draft but leaves
  `mockEditDraft.title` unchanged (`src/ui/app.js:7766-7781`). Saving the editor
  then replaces the draft with its stale title (`:9444-9514`).
- **Reproduction:** open a rule titled `Original title`, rename it inline to
  `New title`, then click Save and Save All. A real browser/API probe confirms
  the displayed rule and collection draft initially contain `New title`, the
  editor still contains `Original title`, and the persisted title reverts to
  `Original title`.
- **Impact:** saving other rule fields silently loses an accepted rename.
- **Expected:** synchronize the open editor's title when renaming or preserve
  the newer title when merging editor changes.

### BUG-020 — Medium — Certificate browsing in web mode loses the selected file's directory

- **Status:** Awaiting user review.
- **Review:** confirmed that browser file selection supplies only a basename to
  an API that reads server-side paths. User choice requested between explicitly
  entering a server-readable path and uploading certificates into managed
  server-side storage; no storage workflow has been selected yet.
- **Evidence:** the browser fallback in `selectCertificatePath()` uses
  `file.path || file.name` (`src/ui/app.js:14430-14452`). Ordinary browser `File`
  objects have no filesystem path, so it supplies only the basename to the
  server-side certificate configuration. Trusted CAs and client certificates
  share this fallback.
- **Reproduction:** in browser Settings > TLS > Additional Trusted CAs, Browse
  to an existing valid `ca.pem` outside the server working directory and click
  Add. A real Chrome chooser supplies only `ca.pem`; the API fails with `ENOENT`
  while looking in the repository root. Entering the same certificate's full
  absolute path manually succeeds in the same isolated session.
- **Impact:** the advertised Browse workflow fails for files outside the server
  working directory and may select the wrong file when basenames collide.
- **Expected:** implement certificate upload for web mode or explicitly request
  a server-readable path instead of treating a browser basename as a full path.

### BUG-021 — Medium — Request exports generate unusable code for unsupported HTTP methods

- **Status:** Open.
- **Evidence:** PowerShell raw and multipart exports always use
  `Invoke-WebRequest -Method` (`src/ui/request-export.js:474,675`), whose method
  parameter accepts a finite enum. Fetch exports only guard GET/HEAD bodies,
  omitting Fetch's unsupported methods (`:273-280,293-295,625-651`).
- **Reproduction:** export a `PROPFIND` request to PowerShell and execute it.
  Both raw and multipart snippets fail parameter binding before any loopback
  origin request. Export `TRACE`, `TRACK`, or `CONNECT` to JavaScript Fetch:
  real Chrome rejects each generated snippet with `HTTP method is unsupported`.
- **Impact:** requests supported by Send cannot be replayed using these export
  formats, and the generated code gives no explanation of the incompatibility.
- **Expected:** use a supported custom-method API where possible, and otherwise
  emit the existing unavailable-replay diagnostic instead of unusable code.

### BUG-022 — Low — Tray close helper retains an unreachable minimize-restoration branch

- **Status:** Fixed.
- **Review:** the helper is private, has exactly one argument-free caller, and
  has no exported compatibility contract. Its restore flag can never be true.
- **Resolution:** remove the unused option, flag and conditional restore call.
- **Verification:** all seven existing tray-lifecycle and test-layout checks
  pass, including native minimize, delayed close, restoration and quit behavior.
- **Evidence (before fix):** `restoreBeforeHide`, the `restoreMinimizedWindow` option, and
  the conditional restore operation remain in `electron/window-to-tray.cjs:36-55`.
  The local `hideAfterNativeTransition()` function has exactly one caller
  (`:70`), which supplies no arguments. The option and accumulated condition
  therefore remain false and the restore branch cannot execute.
- **Impact:** removed minimize-to-tray behavior leaves misleading state and
  unreachable logic in the active close handler; tests explicitly keep native
  minimization behavior.
- **Expected:** remove the unreachable branch and its associated state.

### BUG-023 — Medium — Mock responses incorrectly treat mixed-case methods as HEAD

- **Status:** Fixed.
- **Review:** confirmed that the shared helper collapses distinct custom method
  tokens into HEAD, unlike exact method matching elsewhere in the application.
- **Resolution:** suppress HEAD response bodies only for the exact `HEAD` token.
- **Verification:** 15 focused response-engine, file-streaming and test-layout
  checks pass. New helper and live HTTP/2 regressions failed before the fix and
  now retain bodies for `head` and `HeAd`; exact HEAD, 204 and 304 remain bodyless.
- **Evidence (before fix):** `_isMockResponseBodyForbidden()` uppercases the method before
  comparing it with `HEAD` (`src/proxy/proxy-server.js:3659-3662`), although Send
  preserves custom HTTP method case and the mock matcher compares exact tokens.
- **Reproduction:** create a wildcard fixed response with status 200 and body
  `expected-body`. Send the same URL through `/api/send` using `GET`, `HEAD`,
  `head`, and `HeAd`. A real API/proxy probe returns `expected-body` for GET and
  an empty body for all three other tokens. Only exact uppercase HEAD should
  suppress the response body; the other tokens are distinct extension methods.
- **Impact:** fixed/file mock responses silently lose their bodies for valid
  custom methods, contradicting the exact method behavior elsewhere in Send.
- **Expected:** apply HEAD semantics only to the case-sensitive `HEAD` token.

### BUG-024 — High — Response transforms resurrect request headers removed by pre-steps

- **Status:** Fixed.
- **Review:** all three H1 transform paths overwrite prior header-mutation
  state, enabling reconstruction from raw headers that still contain removals.
- **Resolution:** accumulate transformation flags so later no-op request
  transforms cannot undo pre-step header changes.
- **Verification:** 11 focused protocol-parity, breakpoint and test-layout checks
  pass. New local-origin regressions reproduced leakage in plain H1, TLS H1 and
  H1-on-H2 fallback before the fix. All now omit the removed header, preserve
  the body and apply response changes; native H2 remains a passing control.
- **Evidence (before fix):** a Transform request action overwrites the flag recording earlier
  header changes (`src/proxy/proxy-server.js:5189,6594,7862`). When request headers
  and body remain Original, buffered H1 forwarding reconstructs the headers
  from the original `rawHeaders` (`:5302,6701,8091`), undoing Remove Header
  pre-steps while captured request headers still show the removal.
- **Reproduction:** configure a matching transform rule with pre-step Remove
  Header `X-Remove`, leave request headers/body Original, and modify a response
  header. Send a request containing `X-Remove`. Real local origins receive it
  through plain H1, TLS H1, and H1-on-H2 fallback, but View's capture omits it.
  Native H2 and a control without the response transform remove it correctly.
- **Impact:** request fields, including credentials if such a header is selected,
  reach the destination despite an explicit removal rule and misleading capture.
- **Expected:** preserve pre-step mutation state through later transformations
  and forward the resulting header collection.

### BUG-025 — Medium — Native H2 streaming times out during regular informational responses

- **Status:** Fixed.
- **Review:** informational headers are upstream activity; other response paths
  already refresh their idle timers when receiving them.
- **Resolution:** reset the native H2 streaming idle timer on upstream headers.
- **Verification:** four focused informational-response and test-layout checks
  pass. A new live TLS/H2 regression fails before the fix and now completes an
  800 ms response with 50 ms hints despite a 300 ms idle limit. A response that
  sends one hint and then stalls still times out with 502.
- **Evidence (before fix):** `_streamH2Exchange()` forwards informational headers without
  refreshing its idle timer (`src/proxy/proxy-server.js:2594-2603,2176-2187`).
  The equivalent H1-to-H2 streaming and buffered H2 handlers reset their timers
  (`:1837,9298`).
- **Reproduction:** set upstream idle timeout to 200 ms; a local TLS/H2 origin
  sends 103 every 60 ms and its final 200 response after 500 ms. Native H2
  streaming forwards three hints then returns 502 with
  `Upstream response timeout after 0.2s`. Buffered H2 receives eight hints and
  the final 200 body from the same origin.
- **Impact:** an active upstream response is terminated as idle, with behavior
  depending on whether the selected path buffers the exchange.
- **Expected:** reset the idle deadline for informational responses consistently
  with other received upstream activity.

### BUG-026 — Medium — WebSocket capture drops compression history and silently corrupts later messages

- **Status:** Fixed.
- **Review:** omitted compressed messages can contribute dictionary history to
  later messages when context takeover is enabled. Reusing that history is unsafe.
- **Resolution:** use an unavailable-context decoder for later compressed
  captures in the affected direction. Already queued captures retain their valid
  decoder; no-context-takeover streams can resume normally after overload.
- **Verification:** 15 focused WebSocket and test-layout checks pass. The new
  takeover-overload regression failed before the fix and now reports explicit
  decompression errors after omission while all 64 preceding captures remain
  correct. The no-context-takeover recovery control and shutdown checks pass.
- **Evidence:** capture queue overflow omits compressed messages without advancing
  or invalidating the permessage-deflate decoder history
  (`src/proxy/proxy-server.js:4615-4619`). Later accepted messages reuse that stale
  history when context takeover is enabled.
- **Reproduction:** negotiate permessage-deflate with context takeover and send
  a burst of 66 compressed messages, then another after the 64-slot capture queue
  drains. A real loopback relay probe records two omitted messages; message 67
  is displayed as text from an earlier message instead of its actual content,
  with no `decompressionError`. An independent decoder fed all 67 original
  messages reproduces every expected payload. No artificial capture delay is
  needed to trigger the queue overflow.
- **Impact:** the captured message body is silently incorrect after overload;
  an omission warning for earlier messages does not identify the later corruption.
- **Expected:** preserve the required decoder history or mark subsequent
  dependent captures undecodable until a valid compression context is available.

### BUG-027 — Low — Obsolete breakpoint implementations survive behind excluding dispatch guards

- **Status:** Fixed.
- **Review:** Confirmed all production callers exclude breakpoint actions; the
  webhook-only call cannot reach them either. The direct helper test did not
  represent production behavior.
- **Resolution:** Removed all three obsolete implementations. Replaced the direct
  helper test with a real TLS/H2 response-breakpoint exchange. That test exposed
  forbidden edited headers remaining in capture metadata despite being stripped
  from the wire; live H2 captures now use the same header conversion as delivery.
- **Verification:** 61 focused breakpoint, fixed-response, serve-file, transform,
  and test-layout checks passed. The new live test reproduced the capture mismatch
  before correction and verifies both delivered and captured headers afterward.
- **Evidence:** legacy breakpoint branches remain in the TLS handler
  (`src/proxy/proxy-server.js:6416-6527`), native H2 mock helper (`:8652-8762`),
  and shared H1 mock helper (`:11010-11226`). Every production caller reaches
  those blocks only after excluding all three breakpoint action types with
  `_getMockBreakpointPhase()` (`:6118-6119,7248-7250,7826-7828,5161`);
  the helper recognizes all three types (`:12043-12048`). The remaining special
  shared-helper call is webhook-only.
- **Impact:** unreachable alternate breakpoint behavior complicates maintenance,
  and `test/mocking/breakpoint-validation.test.js:239-297` directly exercises
  one orphan branch instead of its live dispatch path.
- **Expected:** remove the obsolete implementations and cover breakpoint
  validation through reachable request handlers.

### BUG-028 — Medium — Fingerprint cache eviction aborts active HTTPS requests

- **Status:** Fixed.
- **Review:** Confirmed unconditional eviction destroys an agent with a live
  HTTPS request; the regression failed with `ECONNRESET` before correction.
  Queued requests and asynchronous CONNECT setup also need to survive eviction.
- **Resolution:** Track each agent's outstanding requests, retire evicted agents
  without interrupting them, disable idle pooling, and destroy retired agents
  after their last request closes. Shutdown includes retired agents.
- **Verification:** 17 focused checks passed, including real direct and CONNECT
  HTTPS exchanges, a queued request, idle socket disposal, retired-agent shutdown,
  fingerprint mirroring, configuration changes, and test layout.
- **Evidence:** `_getFingerprintAgent()` destroys the oldest HTTPS agent when
  the cache grows beyond 128 identities (`src/proxy/proxy-server.js:10086-10106`).
  `Agent.destroy()` closes its active sockets as well as idle ones. The cache
  identity includes cipher and extension ordering (`:9547-9571`), and eviction
  never checks whether an agent still serves a request.
- **Reproduction:** hold a real local HTTPS response open using the first agent,
  then allocate 128 additional fingerprint identities through the production
  cache helper. The held request fails with `ECONNRESET` / `socket hang up`
  before the origin has responded. Fingerprint keys were supplied directly to
  isolate the cache behavior; this was not a 129-browser connection experiment.
- **Impact:** unrelated traffic that fills the fingerprint cache can terminate
  an active long request or streaming response.
- **Expected:** retire evicted agents without destroying active requests, and
  release their sockets after the affected exchanges finish.

### BUG-029 — High — Locked dependencies fail the repository's dependency audit gate

- **Status:** Fixed.
- **Review (2026-09-14):** Reproduced five affected packages (three high and
  two moderate). Compatible fixes are available within the existing dependency
  ranges; no major-version changes or new overrides are needed.
- **Resolution:** Updated locked fast-uri to 3.1.7, qs to 6.16.0, Hono to 4.13.7,
  xmldom to 0.8.15, and all four nested js-yaml copies to 4.3.2. Raised the
  existing dependency version guards to exclude the affected releases.
- **Verification:** Full suite on Node 26.7.0: 2,506 passed, four skipped, zero
  failures. All nine updated dependency security checks also passed separately.
  `npm run audit` and `npm run audit:prod` both exited zero with no vulnerabilities;
  `npm ls` confirmed the installed versions match the updated lockfile.
- **Evidence:** the lockfile installs `fast-uri@3.1.5` through MCP SDK / Ajv,
  `qs@6.15.3` through Express / body-parser, and development-only
  `@xmldom/xmldom@0.8.13` through electron-builder / plist
  (`package-lock.json:2004,3621,561`). On 2026-09-08, `npm audit --json`
  reports one high and two moderate vulnerable packages. `npm run audit:prod
  -- --json` exits 1 with the high `fast-uri` and moderate `qs` findings.
- **Pass 3 update (2026-09-10):** the registry audit now reports five affected
  packages: three high and two moderate. It additionally flags `hono@4.13.2`
  through MCP and nested `js-yaml@4.3.1` through electron-updater/build tooling
  (`package-lock.json:2403,1723`); xmldom now has high-rated advisories too.
  This expands the existing dependency finding; product dependencies remain
  unchanged. See the [Hono advisory](https://github.com/advisories/GHSA-g6gw-c38x-mqfc)
  and [js-yaml advisory](https://github.com/advisories/GHSA-2883-xcg3-v3hh).
- **Impact:** the configured CI dependency-audit step
  (`.github/workflows/ci.yml:33`) fails for the committed dependency graph.
  The high severity is the dependency advisory's rating; an exploitable
  application route has not been demonstrated by this audit.
- **Sources:** [fast-uri advisory](https://github.com/advisories/GHSA-5jgf-p345-68v8),
  [qs advisory](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx), and
  [xmldom advisory](https://github.com/advisories/GHSA-6gmq-8vp8-gcm6).
- **Expected:** update the affected locked dependency versions to compatible
  patched releases and retain passing dependency audits in CI.

### BUG-030 — Medium — HTTP/2 fallback loses GET, DELETE, and OPTIONS request bodies

- **Status:** Fixed.
- **Review:** Real TLS/H2 exchanges reproduced 400 responses for GET, DELETE,
  OPTIONS, and HEAD, with and without Content-Length and late trailers. POST
  and PATCH passed as controls. The fallback relied on method-specific Node
  defaults after deliberately removing Content-Length.
- **Resolution:** Explicitly select chunked transfer encoding for the streaming
  HTTP/1.1 fallback so all methods carry their bodies and late trailers.
- **Verification:** 37 focused checks passed, including all 12 method/framing
  combinations, bidirectional streaming, trailers, replay safety, upstream
  CONNECT routing, and test layout. Eight method/framing cases failed before
  the correction.
- **Evidence:** `_streamH2Exchange()` removes `content-length` when selecting
  its HTTP/1.1 fallback (`src/proxy/proxy-server.js:2455-2463`), then relays the
  body (`:2355-2360`). `_requestWithExactMethod()` retains Node's disabled
  default chunked encoding for GET, DELETE, and OPTIONS (`:519-525`). The
  resulting request has neither a length nor chunked framing.
- **Reproduction:** send JSON bodies from an actual HTTP/2 client through the
  proxy to a local HTTPS origin supporting HTTP/1.1 only. POST delivers the
  complete JSON and returns 200. GET, DELETE, and OPTIONS return 400; the origin
  sees an empty body while the capture still displays the complete JSON.
- **Expected:** select valid HTTP/1.1 body framing for every forwarded method
  when downgrading HTTP/2 requests.

### BUG-031 — Medium — Request-only transforms buffer responses when original response modes are explicit

- **Status:** Fixed.
- **Review:** Confirmed `original` performs no response edit but was classified
  as one by the streaming gate. A live SSE regression withheld its event until
  the origin closed; an oversized response hit the buffering limit.
- **Resolution:** Treat explicit `original` response modes as unchanged, like
  omitted modes and the existing `none` mode, preserving response streaming.
- **Verification:** Streaming checks cover oversized responses across all four
  ingress paths and an SSE event received while its origin response remains open.
  Focused streaming, transform, fixed-response, and test-layout checks passed;
  separate pre-step parity checks verify response-header edits still apply.
- **Evidence:** `_mockActionTransformsResponse()` treats every response mode
  other than `none` as an edit (`src/proxy/proxy-server.js:3946-3950`), including
  `original`. The renderer sets `resStatusMode`, `resHeadersMode`, and
  `resBodyMode` to `original` for unchanged responses (`src/ui/app.js:9115-9120`).
  This sends request-only transforms through buffered response handling.
- **Reproduction:** use a request-header transform against a local SSE origin
  that writes immediately and ends after 400 ms. With response modes omitted,
  the first chunk arrives in about 46 ms; with the renderer's explicit
  `original` modes, it arrives only after the response ends, about 409 ms.
- **Impact:** ongoing SSE responses cannot deliver events as they arrive;
  sufficiently large responses can hit the buffering limit despite no response
  edit being requested.
- **Expected:** unchanged response modes should preserve streaming behavior.

### BUG-032 — Medium — Configuring API port 80 rejects valid browser origins

- **Status:** Fixed.
- **Review:** Confirmed URL parsing normalizes explicit default ports to an
  empty string. The authenticated POST regression returned 403 before correction.
- **Resolution:** Compare effective HTTP/HTTPS ports when checking loopback
  browser origins, including implicit ports 80 and 443.
- **Verification:** Seven focused API, MCP, desktop-origin, and test-layout
  checks passed. Live POST and WebSocket tests exercise configured port 80 with
  an ephemeral listener, with implicit and explicit default ports. Wrong-port,
  foreign-host, and missing-token controls remain rejected.
- **Evidence:** startup accepts API port 80 (`src/startup-config.js:11-17`), but
  `_isAllowedBrowserOrigin()` compares `URL.port` with `String(this.port)`
  (`src/api/api-server.js:1358-1364`). The URL parser normalizes the default
  HTTP port to an empty string, so the browser's own origin fails the check.
- **Reproduction:** configure API port 80 and open its browser UI. A focused
  production-middleware probe with configured port 80 and an ephemeral listener
  returns 403 `Forbidden origin` for a Settings POST with origin
  `http://127.0.0.1`; the same no-Origin request returns 200. The origin helper
  also rejects an explicitly written `http://127.0.0.1:80`.
- **Impact:** browser mutations and the WebSocket origin check fail on an
  explicitly supported port.
- **Expected:** compare effective ports, including HTTP's default port.

### BUG-033 — Medium — Linux browser recovery misses profile paths containing spaces

- **Status:** Fixed.
- **Review:** Real-format Linux ps fixtures reproduced empty exact and ambiguous
  process sets for Chromium and Firefox profile paths containing spaces.
- **Resolution:** Apply the existing POSIX flattened-path matching and on-disk
  ambiguity checks to Linux. Use recognized comm names for executable paths with
  spaces, retaining argv[0] fallback for truncated Linux comm names and quoted
  argument matching when no flattened match exists.
- **Verification:** 31 focused process-identity, cleanup, ownership-marker, and
  test-layout checks passed. Updated process fixtures also passed separately,
  including descendants, truncated names, executable paths with spaces, unrelated
  processes, profile suffixes, and ambiguous longer directories. These are
  simulated Linux snapshots on Windows, not live Linux browser processes.
- **Evidence:** process snapshots flatten command arguments, but
  `browserProfileCommandMatch()` handles flattened profile paths only for
  Darwin (`src/interceptors/browser-lifecycle.js:179-221`). Linux's ordinary
  token comparison splits a profile path at its spaces and reports no match.
  Cleanup can then regard that profile as unused (`:728-786`).
- **Reproduction:** supply real-format Linux `ps` rows for Chromium and Firefox
  with profiles under `TMPDIR='/tmp/FreeKit Temp'` to the production snapshot
  matcher. Both yield empty process and ambiguity sets. Artificially quoted
  versions of those rows match. No live Linux process or profile was deleted
  during this isolated check.
- **Impact:** recovery can forget a running intercepted browser and cleanup can
  delete a profile that is still in use.
- **Expected:** preserve or safely resolve Linux argument boundaries and retain
  ownership when process identification is uncertain.

### BUG-034 — Medium — Docker Compose instructions interpolate dollar signs in CA paths

- **Status:** Fixed.
- **Review:** Confirmed against Docker's interpolation documentation and a
  failing generated-YAML regression: JSON/YAML quoting does not escape `$project`.
- **Resolution:** Double literal dollar signs in the Compose mount before YAML
  serialization, preserving the original CA path metadata and docker-run quoting.
- **Verification:** 25 Docker and layout checks passed, including parsed YAML
  cases for unbraced/braced variables, repeated/trailing dollars, Windows paths,
  and quoted names, plus existing POSIX and PowerShell argument checks. Docker
  is unavailable on this host; no native Compose execution is claimed.
- **Evidence:** Docker instructions serialize the certificate bind mount with
  `JSON.stringify()` (`src/interceptors/docker-interceptor.js:178`), which does
  not escape Compose interpolation. A CA path such as
  `/home/dev/$project/ca.pem` is emitted with the literal `$project` token.
- **Impact:** Compose substitutes an environment value or an empty string,
  changing the source path and preventing the intended CA file from mounting.
  The separate `docker run` instruction quotes the same path correctly.
- **Verification:** the production instruction generator preserves the token;
  [Docker's interpolation rules](https://docs.docker.com/reference/compose-file/interpolation/)
  require `$$` to represent a literal dollar sign. Docker was not installed on
  this audit host, so no container execution is claimed.
- **Expected:** escape Compose interpolation in generated literal paths.

### BUG-035 — Medium — Multipart matchers remove a real trailing newline from field values

- **Status:** Fixed.
- **Review:** Confirmed the splitter already removes the framing CRLF. Eight
  native FormData cases reproduced incorrect matches or misses from the second
  trim, while plain values passed as controls.
- **Resolution:** Compare the field content directly after its part headers,
  preserving trailing newlines that belong to the submitted value.
- **Verification:** 41 focused matcher, multipart, and layout checks passed;
  two optional Go/PHP execution checks were skipped because those tools are
  unavailable. Ten live proxy cases cover first/last fields, plain text, one or
  two trailing CRLFs, newline-only values, and Unicode text.
- **Evidence:** `splitMultipartBody()` already removes the delimiter's preceding
  CRLF (`src/proxy/proxy-server.js:332-335`), then `_evaluateMatcher()` strips
  another trailing CRLF from the field data (`:10640`). That second newline
  belongs to the submitted value.
- **Reproduction:** submit native FormData with `comment='hello\r\n'` through
  the actual proxy. An exact multipart field-value matcher for `hello\r\n`
  incorrectly falls through to the origin; a matcher for `hello` incorrectly
  returns the mock response.
- **Expected:** preserve field bytes when removing multipart framing so exact
  matchers distinguish values with and without a trailing newline.

### BUG-036 — High — HTTPS server-wide OPTIONS requests terminate the backend

- **Status:** Fixed.
- **Review:** The live TLS regression reproduced an uncaught `ERR_INVALID_URL`.
  Native H2 used the same invalid authority/asterisk concatenation. Buffered
  mock processing also converted unchanged asterisk targets into slash paths.
- **Resolution:** Validate routable URLs within request error guards, represent
  the asterisk as `/*` in the URL, and preserve `*` separately in forwarded
  request targets and capture paths. Unchanged pre-steps/transforms retain the
  asterisk; URL rewrites can still replace it. Invalid targets receive 400.
- **Verification:** 36 focused checks passed, including 12 live TLS/H2 asterisk
  combinations across both upstream protocols and streaming/buffered handling,
  malformed-request and subsequent healthy-request controls, capture paths,
  breakpoint rewrites, pre-step parity, streaming, and test layout.
- **Evidence:** the TLS HTTP/1.1 handlers construct a URL by concatenating the
  CONNECT authority and request target (`src/proxy/proxy-server.js:5968,7676`).
  For the valid server-wide target `*`, a non-default port produces a URL such
  as `https://localhost:8443*`. Parsing it throws outside a request error guard
  (`:5977,7685`).
- **Reproduction:** an isolated backend child receives a real CONNECT and TLS
  handshake followed by `OPTIONS * HTTP/1.1`. It exits 1 with uncaught
  `ERR_INVALID_URL`. Both HTTP/2-disabled mode and HTTP/2-All mode with an
  HTTP/1.1 client reproduce the failure. No upstream connection is required.
- **Impact:** an ordinary protocol request stops the backend and unrelated
  traffic it is handling.
- **Expected:** preserve server-wide request-target semantics and contain URL
  parsing failures within the affected exchange.

### BUG-037 — Medium — Original transformed-body metadata is lost on JSON boundaries

- **Status:** Fixed.
- **Review:** Four capture-normalization/JSON regressions reproduced missing
  original-body encoding metadata. The renderer inherited transformed-body
  provenance, while MCP only read metadata attached to boxed original strings.
- **Resolution:** Normalize original bodies into explicit bodyEncoding,
  bodyTruncated, bodyCapturedSize, bodyDecodedSize, and bodyContentDecoded fields,
  retaining original wire size as bodySize. Renderer original views and MCP
  details now use that original provenance instead of transformed-body metadata.
- **Verification:** 52 focused checks passed. The four new cases also passed
  through live JSON import/export endpoints and production renderer/MCP helpers:
  binary bytes, gzip-decoded binary, truncated text, and complete text all retain
  their own representation and completeness state.
- **Evidence:** `_snapshotMockRequest()` stores `originalRequest.body` as a
  boxed string carrying encoding and truncation metadata
  (`src/proxy/proxy-server.js:3580-3588`). `_normalizeCapturedBodies()` promotes
  metadata only for top-level bodies (`:11612-11632`); JSON serialization drops
  the nested string's properties. The renderer's original perspective then
  uses the transformed body's encoding (`src/ui/app.js:3261-3282`).
- **Reproduction:** transform a binary request with original bytes `00ff1080`
  into text `changed` through a real local proxy/API. In-memory MCP reports
  original encoding `base64`; JSON export/import changes it to `utf8`. The
  production renderer helpers decode 45 ASCII data-URI bytes instead of the
  four original bytes. A separate 524,305-byte text original becomes a
  524,288-byte capture after import without its original truncation marker
  or decoded-size metadata.
- **Impact:** the original perspective can display or export the wrong bytes,
  and imported original bodies can appear complete despite missing data.
- **Expected:** serialize original-body provenance explicitly and select its
  own encoding and size metadata when rendering or exporting the original.

### BUG-038 — Medium — JVM and Android can write recovery journals they cannot reload

- **Status:** Awaiting user review.
- **Review:** Reader/writer inspection confirms the entry-count mismatch. Asked
  whether to enforce the existing 128-target admission limit before mutations
  (recommended), or support larger target sets with bounded journal sizes.
- **Evidence:** JVM and Android journal readers reject more than 128 entries
  (`src/interceptors/jvm-interceptor.js:227-236` and
  `src/interceptors/android-adb-interceptor.js:211-223`), while their writers and
  activation paths impose no equivalent admission cap
  (`jvm-interceptor.js:254-291`, `android-adb-interceptor.js:275-307,346`).
- **Reproduction:** public activation paths with simulated attach/ADB seams
  successfully activate 129 distinct targets and write real 129-entry journals
  under an isolated directory. New interceptor instances reject both journals
  with `Recovery journal has an invalid schema` and recover zero targets.
  No real JVM, device, trust, or proxy settings are changed by the probe.
- **Impact:** after a sufficiently large session, restart loses restoration
  ownership for every journaled target, including the first 128.
- **Expected:** enforce supported capacity before modifying another target,
  or support reloading every journal that successful activation can persist.

### BUG-039 — Medium — Group operations can put enabled mock rules behind catch-all passthrough

- **Status:** Awaiting user review.
- **Review:** Confirmed new groups bypass the before-passthrough insertion rule
  and ungrouping appends at the end. Extracting a middle child requires a choice:
  keep its group intact and place it immediately after that group (recommended),
  or split the group to preserve the exact matching order. Asked the user before
  choosing that behavior.
- **Evidence:** `addMockRule()` inserts ordinary rules before catch-all
  passthrough rules but excludes groups from that placement
  (`src/proxy/proxy-server.js:12268-12275`). The ungroup API also appends an
  ungrouped rule at the end (`src/api/api-server.js:1833-1836`). Matching flattens
  groups in collection order, so the earlier catch-all wins
  (`proxy-server.js:10373-10385,10456-10465`).
- **Reproduction:** with a default passthrough rule and an enabled ordinary
  mock, a real API/proxy fixture first returns `MOCK`. Create a group and move
  that rule into it: the same request returns `ORIGIN`. Reorder the group before
  the catch-all: `MOCK` returns. Ungroup it: the request returns `ORIGIN` again,
  while the mock remains enabled.
- **Expected:** create groups in an effective position and preserve relative
  rule priority when ungrouping, so organization alone does not make their
  enabled rules unreachable.

### BUG-040 — Medium — Buffered HTTP/2 forwarding cannot send GET and DELETE bodies

- **Status:** Fixed.
- **Review:** A live TLS/H2 helper regression reproduced GET/DELETE write-after-end
  errors with bodies and lost trailers even without bodies. POST passed as a
  control. The helper always ends its own stream, so method-based pre-closing
  is inappropriate.
- **Resolution:** Explicitly keep the writable side open until the buffered
  helper sends its body and optional trailers and ends the request.
- **Verification:** 35 focused checks passed, including 12 GET/DELETE/POST
  body/trailer combinations, replay safety, breakpoint edits, asterisk targets,
  trailer forwarding, and test layout. Six combinations failed before the fix.
- **Evidence:** `_makeH2Request()` calls `session.request()` without explicitly
  keeping its write side open (`src/proxy/proxy-server.js:9217`), then sends the
  buffered body with `stream.end(body)` (`:9398-9399`). The pinned runtime
  defaults GET and DELETE streams to `endStream: true`.
- **Reproduction:** direct GET and DELETE requests with JSON bodies succeed
  against a real HTTP/2-only TLS origin. Through the proxy, an ordinary response
  header transform selects buffered forwarding: POST still succeeds, DELETE
  returns 502 `write after end`, and GET returns 502 after its attempted
  HTTP/1.1 fallback is rejected by the HTTP/2-only origin. Neither failing
  request body reaches the origin; both remain visible in the capture.
- **Expected:** set the stream's end state from the actual body/trailer
  requirements, including methods for which Node defaults to an empty body.
  This is separate from BUG-030's HTTP/1.1 fallback framing error.

### BUG-041 — Medium — Pasted cURL commands give special header options the wrong precedence

- **Status:** Fixed.
- **Review:** Native cURL against a loopback origin confirmed explicit normal,
  empty, and duplicate headers win in both option orders for all three special
  options (18 combinations), consistent with the
  [cURL header documentation](https://curl.se/docs/manpage.html#-H).
- **Resolution:** Preserve explicit header ownership when processing special
  options, including intervening options between repeated explicit headers.
- **Verification:** All 247 Send and test-layout checks passed. New regression
  coverage exercises short/long options, ordering, empty values, and duplicates;
  it failed before the fix. Corrected an existing expectation that encoded the bug.
- **Evidence:** after parsing explicit `-H` headers, the cURL parser overwrites
  them with later `-A`, `-u`, or `-b` values
  (`src/ui/curl-parser.js:252-268`). cURL gives an explicit header precedence
  over the corresponding automatic header, regardless of option ordering.
- **Reproduction:** execute ordinary commands against a loopback origin and
  parse the same commands for the Send editor. With an explicit User-Agent,
  Authorization, or Cookie header followed by its corresponding special option,
  actual cURL sends the explicit value; the parser substitutes the automatic
  user agent, Basic authorization, or cookie value instead.
- **Impact:** pasting a working cURL command into Send changes the request's
  identity or authentication headers.
- **Expected:** reproduce cURL's explicit-header precedence when combining
  header options.

### BUG-042 — Medium — cURL exports omit explicitly empty headers

- **Status:** Fixed.
- **Review:** Executing generated commands with native cURL confirmed that raw,
  URL-encoded, and multipart exports all omitted explicit empty headers.
  The distinction from an absent header requires no product design choice.
- **Resolution:** Both cURL export paths use `Name;` for empty values, retaining
  shell quoting and the order of repeated header fields.
- **Verification:** 242 import/export, snippet-byte, and test-layout checks
  passed; two runtime-dependent checks were skipped. The new live-origin
  regression failed in all three body modes before the fix and now verifies
  empty, repeated, quoted, ordinary, and absent headers on the wire.
- **Evidence:** cURL header generation uses `Name: value` for every entry,
  including an empty value (`src/ui/request-export.js:601-602`). For an empty
  value, the resulting `-H 'X-Empty: '` suppresses the header in cURL.
- **Reproduction:** export a request containing `X-Empty: ''` and execute its
  emitted header argument with cURL against a local origin. It receives no `X-Empty`
  header. A control using cURL's `-H 'X-Empty;'` syntax receives the intended
  empty header.
- **Expected:** generate cURL's empty-header syntax so exported requests retain
  the distinction between an absent header and a present empty header.

### BUG-043 — Medium — Generated Node.js requests lose bodies for GET, DELETE, and OPTIONS

- **Status:** Fixed.
- **Review:** Executing generated snippets against a live HTTP origin reproduced
  missing bodies and HTTP 400 for GET, DELETE, OPTIONS, HEAD, and TRACE with
  text and binary payloads. POST and PATCH passed as controls.
- **Resolution:** Supply a byte-accurate Content-Length before creating the
  Node.js request when a nonempty body has no explicit length or transfer
  encoding. Preserve explicit framing and case-sensitive methods.
- **Verification:** 299 import/export, snippet-byte, and test-layout checks
  passed, with two runtime-dependent skips. The new live regression covers
  56 method/encoding/header combinations, including absent headers, Content-Type
  only, explicit length, and explicit chunked encoding.
- **Evidence:** the raw-body Node.js exporter calls `request.write()` without
  providing body framing when the input headers omit `Content-Length`
  (`src/ui/request-export.js:646-667`). Its method-repair helper explicitly
  disables default chunked encoding for these methods (`:198-203`).
- **Reproduction:** generate and run snippets containing `hello` with only a
  `Content-Type` header against a real local HTTP origin, using the pinned
  runtime. POST returns 200 and delivers the body. GET, DELETE, and OPTIONS
  return 400; the origin sees empty bodies and no length or chunked framing.
- **Expected:** generated requests should preserve supplied body bytes for all
  supported methods by choosing valid framing. This exporter bug is independent
  of the proxy forwarding errors in BUG-030 and BUG-040.

### BUG-044 — Medium — Request detail hides valid text beginning with `[Binary`

- **Status:** Fixed.
- **Review:** The broad prefix condition discards ordinary text. Current binary
  placeholders carry zero retained bytes and truncation metadata; legacy ones
  can be recognized by their exact format when encoding metadata is absent.
- **Resolution:** Use metadata-aware placeholder detection for request card
  visibility and request/response viewer initialization and rendering. Explicit
  UTF-8 text remains visible even when it matches the placeholder format.
- **Verification:** 585 traffic, UI, Send, and test-layout checks passed. A live
  Chromium probe verified three binary-prefixed text cases in both viewers;
  regressions also cover legacy and metadata-marked placeholders.
- **Evidence:** request-body rendering rejects every body with this prefix
  (`src/ui/app.js:3881,4169`), without considering explicit UTF-8 encoding.
- **Reproduction:** render a valid captured `text/plain` request with
  `requestBodyEncoding: 'utf8'` and body `[Binary search]` in the real browser.
  Its Request Body card is absent even though the full text is retained.
  Changing only the text to `Binary search` restores the card. The response
  body remains visible in both cases.
- **Expected:** distinguish legacy binary placeholders from actual text using
  capture metadata, preserving bodies whose literal content has that prefix.

### BUG-045 — Medium — First server save discards new mock-rule titles

- **Status:** Fixed.
- **Review:** The create route omits title from its candidate while existing-rule
  updates preserve it. A live API regression reproduced the missing title
  before any persistence or renderer refresh could affect the result.
- **Resolution:** Include title in both modern and legacy create candidates.
- **Verification:** 24 focused validation, group, persistence, and test-layout
  checks passed. The regression verifies named, cloned-style, generated-style,
  empty, and omitted titles in API responses, live rules, and rules restored
  from freshly read settings in both formats.
- **Evidence:** POST `/api/mock-rules` builds a candidate without its `title`
  (`src/api/api-server.js:1634-1640`). The renderer sends named new and cloned
  drafts through this route (`src/ui/app.js:9541-9560,9787-9800`); Create Mock
  from Traffic also supplies a title (`:15595`).
- **Reproduction:** clone a saved rule named `Source rule`. The renderer shows
  `Source rule (copy)`, but Save All succeeds and reloads a titleless clone.
  The original rule keeps its title. A browser/API probe also confirms that a
  generated Create Mock title is absent from the stored rule.
- **Expected:** preserve supported names on initial save, consistently with
  updating existing rules. No inline-rename race is needed for this failure.

### BUG-046 — Medium — Saving group drafts overwrites newer child-rule edits

- **Status:** Fixed.
- **Review:** Live API tests using the production renderer save functions
  reproduced stale child replacement for both toggle and rename drafts through
  Save All and individual saves. Group property changes need not submit children;
  the existing update API already supports partial group updates.
- **Resolution:** Exclude child items from group property drafts, preserving
  independent child edits during both draft overlays and server updates.
- **Verification:** 63 draft, save-lock, editor, group, and test-layout checks
  passed. Four live API regressions cover toggles/renames, both save paths,
  and a reload before saving. All four failed before the fix.
- **Evidence:** group drafts deep-copy `items` (`src/ui/app.js:9822,9837`),
  while later child edits update the live collection (`:9523-9535`). Save All
  submits drafts in insertion order (`:9548-9577`), allowing a stale group
  update to replace the just-saved child (`src/proxy/proxy-server.js:12310-12322`).
- **Reproduction:** edit a grouped rule body to `FIRST` and Save Draft; toggle
  the group off/on; edit that child body to `LATEST` and Save Draft; then Save
  All. A real browser/API/proxy probe shows both drafts clear and “All changes
  saved”, but the persisted body and actual mock response are `FIRST`.
- **Expected:** reconcile parent and child drafts before persisting them so a
  successful save retains the latest child edits.

### BUG-047 — Medium — Connect body previews fail when Monaco falls back to plain rendering

- **Status:** Fixed.
- **Review:** The plain formatter receives the content type but drops it from
  decoder context, unlike the Monaco path. A regression reproduced the invalid
  frame/protobuf errors with an ordinary uncompressed Connect EndStream.
- **Resolution:** Include the formatter's content type in decoder context for
  every plain-rendering call, including direct and editor-fallback rendering.
- **Verification:** 132 focused UI, fallback, detail, and test-layout checks
  passed. A live Chromium probe with Monaco creation forced unavailable displayed
  the protobuf field and `Try later` EndStream error correctly.
- **Evidence:** fallback rendering omits `contentType` from its context
  (`src/ui/app.js:5625,5643`), which passes through `formatBodyAs()` (`:5525`)
  to a decoder that needs it to recognize Connect framing (`:5200`).
- **Reproduction:** force the supported Monaco initialization failure path in
  the real browser and display an uncompressed `application/connect+proto`
  message with a flag-2 EndStream. The visible fallback reports invalid gRPC
  frames and an invalid protobuf field number. The same production decoder
  given the content type shows the message and JSON `Try later` error.
- **Expected:** pass protocol context through both editor and fallback paths.
  This uncompressed case is independent of the Pako bootstrap failure.

### BUG-048 — Medium — Compressed Connect EndStream previews skip decompression

- **Status:** Fixed.
- **Review:** The protocol explicitly allows independent compression and
  EndStream flags. Regressions confirmed the decoder skipped both decompression
  and its bounded-error diagnostics for these envelopes.
- **Resolution:** Decompress envelopes before interpreting EndStream JSON,
  reusing the existing output limits and malformed-compression diagnostics.
- **Verification:** 116 UI, Monaco fallback, and test-layout checks passed,
  including gzip, deflate, uncompressed, oversized, and malformed EndStream
  payloads. A live Chromium probe displayed the gzip-compressed error correctly.
- **Evidence:** the decoder records the compression flag (`src/ui/app.js:5204`)
  but handles EndStream and continues (`:5215`) before its decompression branch
  (`:5232`). Connect defines compression and EndStream as independent bits in
  its [protocol reference](https://connectrpc.com/docs/protocol/#streaming-request).
- **Reproduction:** display a gzip-compressed flag-3 EndStream with a JSON
  error and trailing metadata in the real Monaco viewer. It shows only an
  abbreviated gzip hex dump. Loading the installed Pako ESM module explicitly
  removes BUG-006 as a confounder: the production decompression helper recovers
  the full error and metadata, but the viewer still skips it.
- **Expected:** decompress an envelope before decoding its EndStream payload,
  retaining the error and trailing metadata in the preview.

### BUG-049 — Medium — Regex Body never matches an empty request body

- **Status:** Fixed.
- **Review:** A live proxy regression reproduced the incorrect rejection of
  `^$` against an empty body. BUG-062 was fixed first so unavailable decoded
  bodies cannot become false empty-string matches.
- **Resolution:** Evaluate regex patterns against empty text using ordinary
  regex semantics, retaining validation and unavailable-body guards.
- **Verification:** 56 focused body, validation, breakpoint, streaming, and
  test-layout checks passed. Regressions cover plain/gzip empty bodies,
  nonempty and malformed compressed bodies, and matching/nonmatching/invalid
  patterns. The live empty-body case failed before the fix.
- **Evidence:** the regex-body matcher returns false for an empty subject
  before evaluating its configured expression
  (`src/proxy/proxy-server.js:10648-10650`).
- **Reproduction:** configure a valid Regex Body pattern `^$` through the
  management API and send POST with `Content-Length: 0` to the real proxy. The
  request falls through to the origin, although `^$` matches an empty string.
  An exact raw-body matcher with value `''` correctly returns the mock for the
  identical request.
- **Expected:** evaluate valid expressions against the empty string as well
  as nonempty bodies.

### BUG-050 — Medium — An unmatched text replacement corrupts binary body bytes

- **Status:** Awaiting user review.
- **Review:** The shared helper unconditionally round-trips bytes through UTF-8.
  Preserving unmatched bytes is clear, but matching text inside invalid UTF-8
  needs a policy: skip non-text bodies (recommended), or replace UTF-8 byte
  sequences while preserving surrounding binary bytes. Asked for this choice;
  implementation remains pending.
- **Evidence:** Match/Replace always decodes and re-encodes a body as UTF-8,
  even when its pattern does not occur (`src/proxy/proxy-server.js:3811-3814`).
  Request and response transforms share this helper (`:3855,3895`).
- **Reproduction:** a real origin returns bytes `00ff1080`. They pass through
  unchanged without a transform. Add a response Match/Replace with an absent
  pattern: the client receives `00efbfbd10efbfbd` with status 200 despite no
  match. This changes actual wire bytes, independently of captured-body views.
- **Expected:** preserve the original bytes when no replacement is made and
  avoid silently transcoding binary bodies through a text operation.

### BUG-051 — Medium — A stale Electron status refresh reverses the visible result of Stop

- **Status:** Fixed.
- **Review:** Deferred process observations reproduced both reactivation after
  Stop and deactivation of a newly launched app by a stale absent result.
- **Resolution:** Discard awaited status observations when the captured
  ownership record is no longer current.
- **Verification:** All 37 Electron and test-layout checks passed. Six race
  cases exercise running, absent, and unknown observations after public Stop,
  with and without a subsequent public activation. Three cases failed before
  the fix; tests also verify ownership and journal state.
- **Evidence:** `ElectronInterceptor._refreshOwnedProcess()` applies an awaited
  observation without checking that ownership still refers to the same lifecycle
  (`src/interceptors/electron-interceptor.js:339-360`). Manager listing calls
  `isActive()` outside activation/deactivation locks
  (`src/interceptors/interceptor-manager.js:213-223`).
- **Reproduction:** begin a status refresh, successfully deactivate through the
  public method, then release the earlier observation that the child was running.
  An isolated native-process simulation reports `isActive() === true` and
  `{ active: true, pid: null }`, while `needsDeactivation()` is false and the
  real ownership fields/journal have already been cleared.
- **Expected:** discard observations for retired process ownership so a late
  refresh cannot mark a stopped interceptor active again.

### BUG-052 — Medium — Copying an original request header returns its transformed value

- **Status:** Fixed.
- **Review:** Production renderer and context-menu functions reproduced copying
  transformed values after switching to Original. The header grid and lookup
  store were derived from different request objects.
- **Resolution:** Populate the request header lookup from the same effective
  request used to render the selected perspective.
- **Verification:** 258 traffic, context-menu, escaping, provenance, and
  test-layout checks passed. The regression exercises value and name/value
  copying in Original, Transformed, and Client views with repeated headers;
  it failed before the fix.
- **Evidence:** the context-menu header store is populated from transformed
  headers (`src/ui/app.js:3365`), while Original perspective renders the
  effective original headers (`:3874`). Copy looks up the value in that stale
  store (`:15639-15652`).
- **Reproduction:** transform `x-audit: original-value` to `transformed-value`
  through a real proxy, select Original in the browser, and choose Copy header
  value on the visible original header. The clipboard operation receives
  `transformed-value`. Only the clipboard sink is simulated in this probe.
- **Expected:** context actions should use the same headers as the displayed
  perspective.

### BUG-053 — Medium — Reopening active Docker configuration replaces working connection instructions

- **Status:** Fixed.
- **Review:** The renderer clears metadata on collapse and skips regeneration
  for active Docker. Docker activation without a container ID generates
  instructions without mutating containers, so refreshing it is appropriate.
- **Resolution:** Regenerate Docker connection metadata whenever its card opens.
- **Verification:** All 28 Docker, interceptor-load, and test-layout checks
  passed. The regression uses production renderer functions and the Windows
  instruction generator to verify reopen retains host, CA mount, and Node trust
  settings while refreshing a changed proxy port. It failed before the fix;
  no container was launched.
- **Evidence:** collapsing a card clears activation metadata
  (`src/ui/app.js:6423`), but reopening active Docker skips retrieving it
  (`:6381`). The renderer then uses fallback instructions (`:6529-6532`) with
  `172.17.0.1` and no CA mount or Node trust configuration.
- **Reproduction:** on Windows, use the production Docker instruction generator
  with an isolated CA and open the real browser card. Initial instructions use
  `host.docker.internal`, a CA bind mount, and `NODE_EXTRA_CA_CERTS`. Collapse
  and reopen the active card: the host changes to `172.17.0.1` and those trust
  instructions disappear. Only availability/manager seams are simulated;
  no Docker command is executed.
- **Expected:** retain or retrieve authoritative connection metadata when
  reopening an active interceptor's configuration.

### BUG-054 — Medium — Grouped mock rules ignore their advertised drag reordering

- **Status:** Fixed.
- **Review:** Both drop handling and the reorder API were limited to top-level
  rules. Reordering within a group has the same priority semantics as the
  existing sibling reorder behavior.
- **Resolution:** Support an optional group scope in reorder requests, reorder
  child IDs without replacing their contents, and scope optimistic rollback
  to the affected sibling list.
- **Verification:** 27 reorder, save-lock, draft, group, and test-layout checks
  passed. A renderer-to-live-API test verifies persisted child order and matching
  priority while retaining local drafts. Failure coverage verifies sibling
  rollback when both persistence and reload fail; invalid group scopes reject.
- **Evidence:** child rows remain draggable with a “Drag to reorder” tooltip
  (`src/ui/app.js:8011,8018`), but drop handling searches only top-level rules
  (`:7698-7700`) and returns when either child is absent from that list.
- **Reproduction:** create a saved group ordered FIRST, SECOND. In the real
  browser, drag SECOND onto FIRST: valid drag feedback appears, but the reorder
  generation, local order, and persisted order remain unchanged. An actual
  matching request still receives FIRST. The probe dispatches the production
  drag events and handlers.
- **Expected:** reorder child rules within their group, preserving the visible
  priority change after save.

### BUG-055 — Medium — Suggested legacy response-transform migration discards response changes

- **Status:** Fixed.
- **Review:** The generic action conversion assigns legacy response fields to
  request options and leaves response modes inactive. A backend parity
  regression reproduced loss of the status override after conversion.
- **Resolution:** Explicitly migrate legacy response status, header updates and
  removals, and all body modes to their response fields while leaving request
  transform modes unchanged and retaining delay.
- **Verification:** 34 migration, transform, validation, status, and test-layout
  checks passed. Sixteen conversion combinations compare backend response
  behavior before/after migration and verify requests remain unmodified.
- **Evidence:** the legacy editor directs users to select Transform the request
  (`src/ui/app.js:8800`), but that conversion maps legacy fields into modes
  still set to `original` and discards the response body replacement
  (`:9102-9123`).
- **Reproduction:** load a supported legacy response-transform rule returning
  status 201, body `LEGACY`, and an added header. Follow the editor's migration
  instruction, Save Draft, then save to the server. A real browser/proxy/origin
  probe changes from `201 LEGACY` with that header to `200 ORIGIN` without it.
- **Expected:** preserve the legacy response transformation when converting to
  the combined editor, including status, headers, body, and their active modes.

### BUG-056 — Low — Completed Add requests erase newer settings input

- **Status:** Fixed.
- **Review:** Deferred-response tests reproduced both handlers erasing a newer
  host after successful submission. Their existing operation guards do not
  track edits to the still-enabled input.
- **Resolution:** Clear the field only if its value still equals the exact
  submitted input; continue trimming the host sent to the server.
- **Verification:** All 97 settings and test-layout checks passed. Both forms
  cover newer hosts, whitespace edits, unchanged successful submissions, and
  failed submissions. The newer-host cases failed before the fix.
- **Evidence:** TLS passthrough and HTTPS whitelist Add handlers clear the
  still-editable input unconditionally after success
  (`src/ui/app.js:14259-14271,14655-14667`), without comparing it with the
  submitted value.
- **Reproduction:** add `first.audit.example`, delay delivery of the real
  successful API response, and type `second.audit.example` into the enabled
  field. Releasing the response empties the field; the server stores only the
  first host. Both forms reproduce with real browser input events and isolated
  API persistence.
- **Expected:** clear only the submitted value; retain newer unsubmitted input.

### BUG-057 — Medium — Native storage denial causes uncaught errors in Send tab actions

- **Status:** Fixed.
- **Review:** The journal reader acquires localStorage outside its existing
  exception guard. A throwing-getter regression reproduced the uncaught error.
- **Resolution:** Guard storage acquisition together with journal enumeration,
  retaining the existing unavailable-storage fallback without altering records.
- **Verification:** All 250 Send, storage-error, and test-layout checks passed.
  A real Chrome profile with site data blocked still reported native SecurityError
  on storage access, but Add Send Tab succeeded and increased the tab count.
- **Evidence:** the Send journal reader accesses `window.localStorage` before
  entering its error handler (`src/ui/app.js:11540-11543`). The native property
  getter can itself throw. Add, switch, and close call this reader through
  their save path (`:12596,12605,12616`).
- **Reproduction:** launch an isolated Chrome profile with site data blocked
  using `profile.default_content_setting_values.cookies=2`. The native getter
  throws `SecurityError: Access is denied for this document`. New Send tab
  throws and leaves the tab count at one, while the central safe-storage reader
  correctly returns its fallback. No storage getter or product function is
  replaced in the final probe.
- **Expected:** guard storage acquisition as well as storage methods and handle
  denied persistence without uncaught tab-action exceptions.

### BUG-058 — Medium — Imported HAR form parameters disappear from Resend and request snippets

- **Status:** Awaiting user review.
- **Review:** Parameters are retained but replay only uses the absent raw body.
  Asked whether to reconstruct available fields with a semantic-replay notice
  (stopping when file contents are missing), or require raw bytes and explain
  why replay is unavailable. Implementation remains pending that choice.
- **Evidence:** the HAR importer retains `postData.params` as
  `requestPostDataParams`, while absent `postData.text` becomes an empty body
  (`src/ui/har-import.js:226-229,342-345,379-383`). Resend and export use only
  the empty body (`src/ui/app.js:3021-3029,3045-3049`;
  `src/ui/request-export.js:224-226,591-594,662-667`). The renderer never reads
  the retained parameter collection.
- **Reproduction:** import a form request whose HAR post data contains
  `params: [{ name: 'q', value: 'hello' }]` and no text. The real API accepts it
  and retains those parameters. Production Resend creates an empty raw body
  with no URL-encoded fields; the generated Node snippet sends an empty POST
  to a local origin instead of the supplied form data.
- **Expected:** preserve available form parameters when preparing a replay,
  or clearly explain missing raw-body information instead of silently treating
  the request as having no body.

### BUG-059 — Medium — Signal shutdown exits on cleanup failure before recovery can be retried

- **Status:** Fixed.
- **Review:** Isolated Node children executing the production shutdown block
  reproduced unhandled rejection exits for both SIGINT and SIGTERM before retry.
- **Resolution:** Catch signal-triggered shutdown failures and report the error
  with retry instructions, retaining the existing retryable shutdown lifecycle.
- **Verification:** All 22 signal, graceful shutdown, admission, desktop deadline,
  and test-layout checks passed. Child-process regressions verify no server stop
  occurs on cleanup failure and a second signal completes shutdown successfully.
- **Evidence:** the shutdown handler resets its promise and rethrows an
  interceptor cleanup failure (`src/index.js:324-327`). SIGINT and SIGTERM
  register that promise-returning handler directly (`:339-340`); their event
  dispatcher does not handle a rejected return value.
- **Reproduction:** run the unmodified production shutdown block and signal
  registrations in an isolated child under pinned Node.js 26.7.0, with a
  simulated failing interceptor cleanup. Emitting SIGINT exits the child with
  code 1 from an unhandled rejection, before either server stop callback or a
  subsequent retry marker can run. This uses real Node event and rejection
  behavior; native interceptor cleanup is simulated.
- **Impact:** Ctrl+C can terminate the proxy while interceptor cleanup remains
  incomplete, preventing an in-process retry and leaving affected clients
  configured to use a stopped proxy.
- **Expected:** observe signal-triggered shutdown failures and preserve the
  intended cleanup recovery path instead of terminating on an unhandled promise.

### BUG-060 — Medium — Apostrophes in Windows profile paths prevent browser recovery matching

- **Status:** Fixed.
- **Review:** Regression fixtures reproduced missed unquoted Chromium and
  Firefox profile paths containing apostrophes. Windows command-line arguments
  retain these apostrophes literally rather than treating them as quotes.
- **Resolution:** Apply single-quote grouping only to non-Windows command lines.
- **Verification:** All 135 browser lifecycle and test-layout checks passed.
  A harmless native Windows child and Win32_Process command-line observation
  confirmed exact matching after substituting only the executable identity;
  quoted-path, suffix, and unrelated-executable controls also passed.
- **Evidence:** the process command-line splitter treats a single quote as a
  quoting delimiter on Windows (`src/interceptors/browser-lifecycle.js:92-94`).
  Windows permits literal apostrophes in unquoted arguments; a profile path
  such as `C:\Users\O'Neil\AppData\Local\Temp\http-freekit-chrome-example`
  is consequently split incorrectly and fails related-process matching.
- **Reproduction:** spawn a harmless Node child with that profile argument and
  read its native command line using `Get-CimInstance Win32_Process`. The child
  receives the complete path and Windows leaves the argument unquoted. Feed
  that observed command line to the production browser matcher, changing only
  its executable name to `chrome.exe`: neither exact nor ambiguous matching
  finds the child. Double-quoting the argument restores the match. No browser
  or user profile is modified by this probe.
- **Impact:** browser recovery can miss a still-running managed profile under
  a Windows account or temporary directory containing an apostrophe, leaving
  the browser untracked and its profile eligible for stale-profile cleanup.
- **Expected:** use Windows quoting rules for Windows command lines, preserving
  literal apostrophes in unquoted profile arguments.

### BUG-061 — Medium — Browser recovery loses proxy ports for IPv6 and specific LAN bindings

- **Status:** Fixed.
- **Review:** Recovery hard-codes IPv4 loopback despite the launcher's broader
  authority support. A managed-profile recovery regression reproduced a null
  port for a valid IPv6 loopback proxy.
- **Resolution:** Parse and validate proxy authorities before extracting the
  explicit port, retaining the requirement for one unambiguous valid port.
- **Verification:** All 136 browser lifecycle and test-layout checks passed.
  Recovery fixtures cover IPv4, IPv6, LAN, hostname, explicit default port,
  malformed authority, credentials, paths, invalid port, and conflicting ports.
- **Evidence:** browser launch formats the configured proxy host into
  `--proxy-server` (`src/interceptors/browser-interceptor.js:31,569`), but
  recovery recognizes only `127.0.0.1` in that argument
  (`src/interceptors/browser-lifecycle.js:546`). Recovered profiles using other
  supported local binding addresses therefore have a null proxy port, which
  prevents opening another URL (`src/interceptors/browser-interceptor.js:512`).
- **Reproduction:** create isolated managed profiles and supply simulated
  running-browser snapshots with proxy authorities `127.0.0.1:8000`,
  `[::1]:8000`, and `192.0.2.10:8000`. Production profile recovery retains all
  three, but only the IPv4 loopback record retains port 8000. The subsequent
  production `openUrl` call rejects the other two with “Could not recover the
  proxy port”; the loopback control reaches the URL-opening callback. Browser
  processes and launch callbacks are simulated; no network binding is changed.
- **Expected:** recover and validate the port for every proxy authority the
  browser launcher supports.

### BUG-062 — Medium — Requests beyond the decode limit incorrectly match an empty-body mock

- **Status:** Fixed.
- **Review:** Reviewed ahead of BUG-049 because regex matching of empty strings
  would also expose this ambiguity. A live proxy regression reproduced a false
  empty-body match for gzip expanding beyond the production 32 MiB limit.
- **Resolution:** Represent unavailable matcher content separately from empty
  text and reject body-dependent matchers for unavailable content.
- **Verification:** 55 focused body, validation, breakpoint, streaming, and
  test-layout checks passed. Live requests cover empty and gzip-empty bodies,
  ordinary gzip, over-limit expansion, malformed gzip, and unsupported encoding.
- **Evidence:** unsuccessful bounded request decompression returns the original
  compressed buffer (`src/proxy/proxy-server.js:11648-11680`), which the body
  matching helper converts to an empty string (`:11688-11696`). The
  `raw-body-exact` matcher then accepts an empty value (`:10652-10653`) even
  though the request contains a nonempty body.
- **Reproduction:** save an empty-body fixed-response rule through the real API
  and send three POST requests through the local proxy. An actually empty body
  receives `EMPTY MOCK`, and a small nonempty gzip body reaches the origin.
  A valid gzip body expanding to 33,554,433 bytes also receives `EMPTY MOCK`:
  its compressed size is only 32,635 bytes, but decoding exceeds the unchanged
  production ceiling of 33,554,432 bytes. Only the small request reaches the
  origin. No buffer or decode limits are overridden.
- **Expected:** distinguish unavailable decoded content from an empty body;
  skip an unevaluable body match or report the limit explicitly instead of
  applying an unrelated empty-body mock.

### BUG-063 — Low — An incomplete method edit falsely marks a valid Send workspace as corrupt

- **Status:** Awaiting user review.
- **Review:** The null draft is a real error, but persisted Send tabs reject
  invalid methods. Asked whether reconciliation should preserve the unfinished
  editor in a temporary local fork or wait until the method becomes valid.
- **Evidence:** an empty or invalid method makes the active Send snapshot null
  (`src/ui/app.js:12225-12230`). The storage-event handler passes it to draft
  preservation without checking (`:12301-12330`), which dereferences `draft.id`
  (`:12248`). Its catch then diagnoses the valid incoming workspace as corrupt.
- **Reproduction:** open the same saved Send tab in two real browser targets.
  Delete `GET` from the first method field while editing, then save a URL change
  in the second target. The native storage event records “Cannot read properties
  of null (reading 'id')” against “Stored Send workspace”, although the stored
  workspace validates successfully and contains the remote URL.
- **Impact:** the incoming update is not reconciled and the user receives a
  false corruption diagnosis. The probe does not show permanent stored-data
  corruption; a subsequent rescan can clear the diagnosis.
- **Expected:** handle temporarily invalid editor state independently of
  persisted workspace validation and preserve it during remote reconciliation.

### BUG-064 — Medium — Multipart Send includes body edits made after submission

- **Status:** Fixed.
- **Review:** A held file read reproduced later text, enabled-state, and row
  additions leaking into the submitted payload. This violates submission-time
  capture and does not require changing the editor's interaction policy.
- **Resolution:** Copy multipart rows before preflight and asynchronous
  serialization, retaining references to the originally selected immutable files.
- **Verification:** All 249 Send and test-layout checks passed. The regression
  inspects the submitted management-request body after edits during a held read,
  then verifies that the next preparation includes those newer edits instead.
- **Evidence:** request preparation aliases the live `sendMultipartFields`
  array (`src/ui/app.js:12717`). Serialization awaits a file read before
  reading subsequent text rows (`:10742-10763`), while enabled editor controls
  mutate those same field objects (`:10543-10547`).
- **Reproduction:** submit a multipart POST with a file followed by a text field
  containing `ORIGINAL`. Hold completion of the real file read, type
  `NEWER_UNSUBMITTED` into the still-editable text row, then release the read.
  The actual local origin receives `NEWER_UNSUBMITTED` and no `ORIGINAL`,
  without a second Send. The probe delays the file-read result to make the
  asynchronous editing window deterministic.
- **Expected:** snapshot the submitted multipart rows before awaiting file
  reads so later edits apply to the next request.

### BUG-065 — Medium — Overlapping failed display-setting saves restore an uncommitted value

- **Status:** Fixed.
- **Review:** The regression reproduced rollback to an optimistic value after
  both writes failed. Confirmed settings must be tracked independently of edits.
- **Resolution:** Retain validated server settings for rollback, account for
  older successful saves when the latest fails, and protect pending newer edits
  and newer confirmations from older responses.
- **Verification:** All 99 settings and test-layout checks passed. Regression
  coverage exercises both response orders, both toggles and mixed changes,
  older success/failure with latest failure, and the loaded rollback baseline.
- **Evidence:** Hide Tunnel Requests and Safe Fonts capture their rollback
  state from optimistic renderer globals (`src/ui/app.js:13067-13084`). Older
  completions are discarded, and the latest failure restores that captured
  state (`:13057-13062`), which can itself come from an earlier failed save.
- **Reproduction:** start with authoritative Hide Tunnel Requests enabled.
  Submit false then true before either response arrives, and make both writes
  fail in the isolated Settings persistence layer. Deliver both real API
  failures: the renderer and checkbox end at false, while the authoritative
  GET still returns true. Backend persistence rollback works correctly.
- **Expected:** reconcile a failed latest save against confirmed server state,
  preserving the correct display/filter state when earlier saves also failed.

### BUG-066 — Medium — Delayed reconnect reads overwrite newly saved proxy settings in the UI

- **Status:** Fixed.
- **Review:** A held reconnect read reproduced the saved upstream being
  replaced by direct-mode controls. Both loaders lacked read invalidation.
- **Resolution:** Invalidate older reads on mutations, skip reads while writes
  are pending, and retain the newest read or rotation update. Failed upstream
  deletion still reloads server state after its write completes.
- **Verification:** All 139 settings, upstream, and test-layout checks passed.
  Renderer regressions cover upstream POST/DELETE, manual rotation, automatic
  rotation events, auto-rotate configuration, overlapping reads, pending writes,
  and fresh reads after completion.
- **Evidence:** upstream and auto-rotate loaders apply every completed GET
  without invalidating reads started before a newer save
  (`src/ui/app.js:14043-14051,13968-13976`). Both run during WebSocket init,
  including reconnect (`:1312,1314`).
- **Reproduction:** close and reconnect the real browser WebSocket, hold the
  completed initial upstream GET reporting no proxy, then successfully save
  `HTTP 127.0.0.1:9`. Releasing the older GET changes the controls to None,
  empties the details and displays “Direct connection”, while the real API
  still reports the active upstream. The same sequence for auto-rotate
  restores an unchecked control and remembered false value after the server
  successfully saved true. No request uses the dummy upstream, and no external
  rotation is invoked.
- **Expected:** ignore stale settings reads after newer mutations so displayed
  proxy behavior remains consistent with the confirmed server state.

### BUG-067 — Medium — Uncertain JVM activation is displayed as confirmed interception

- **Status:** Awaiting user review.
- **Review:** Confirmed that ownership entries with uncertain activation are
  presented as active. Asked whether uncertain JVMs should appear only in
  configuration with warning/cleanup controls or remain in Connected Sources
  with an explicit uncertainty warning.
- **Evidence:** a JVM helper failure after attachment begins returns an
  unsuccessful result with `activationUncertain: true`, retaining cleanup
  ownership (`src/interceptors/jvm-interceptor.js:1549-1597`). The renderer
  nevertheless assigns the Activated state and Connected Sources membership
  (`src/ui/app.js:7053-7055,7090-7103,6264-6271,6138-6141`).
- **Reproduction:** a simulated native helper times out after `onSpawn` in
  production JVM activation. The real browser/API flow shows green “Activated”
  and lists the JVM as connected while also showing the activation error.
  This establishes contradictory status reporting; it does not establish
  whether interception actually started or that cleanup ownership was lost.
- **Expected:** visibly distinguish uncertain activation and pending cleanup
  from confirmed active interception.

### BUG-068 — Medium — Manual proxy setup advertises an unreachable address for IPv6 binding

- **Status:** Fixed.
- **Review:** The manual-card regression reproduced IPv4 instructions despite
  a supplied IPv6 authority. The server already has bind-aware address helpers.
- **Resolution:** Advertise a local proxy authority in WebSocket initialization
  using the shared bind helper, retain it in renderer configuration, and use it
  for manual setup instructions.
- **Verification:** All 89 focused management WebSocket, interceptor-core,
  traffic-init, and test-layout checks passed. Live WebSocket initialization
  advertised reachable HTTP listeners for IPv4/IPv6 loopback and wildcard binds;
  renderer fixtures verify IPv6 brackets and specific addresses.
- **Evidence:** manual setup hardcodes `127.0.0.1` into its proxy address
  (`src/ui/app.js:6362`), although startup supports an explicitly configured
  bind address (`src/index.js:130-150`).
- **Reproduction:** load the shipped UI against an isolated proxy actually
  bound to `::1`. The displayed IPv4 address returns `ECONNREFUSED`; sending
  the same request to `[::1]` at the same port returns HTTP 200. This occurs
  in a fresh session and does not depend on recovered browser profiles.
- **Expected:** generate manual setup instructions from a reachable address
  for the configured proxy binding.

### BUG-069 — Medium — Replacement rule import leaves a deleted editor draft that blocks Save All

- **Status:** Fixed.
- **Review:** The regression reproduced a retained editor ID after successful
  replacement. Clearing it matches the existing replacement of all draft state.
- **Resolution:** Clear the active editor, its draft, and inline rename state
  after successful replacement in both backup formats. Append and rejected
  imports preserve the existing editor.
- **Verification:** All 348 mocking and test-layout checks passed. Renderer/API
  integration covers both backup formats, replacement/append/rejection, and
  saving an imported rule's newer response body through Save All.
- **Evidence:** replacement import clears draft maps but retains the open
  editor (`src/ui/app.js:10026-10029,10055-10057`), while the API regenerates
  imported IDs (`src/api/api-server.js:172-173`). Opening an imported rule
  saves the obsolete editor as a draft for its deleted ID
  (`src/ui/app.js:8896,8860-8863,9482-9510`). Save All submits that draft first
  (`:9548-9567`) and receives “Rule not found”.
- **Reproduction:** leave a rule editor open, replace all rules by importing a
  backup, then open the imported rule, edit its response and save. The real
  browser retains two drafts, including the deleted ID; Save All fails before
  persisting the new edit. Real proxied traffic still returns `IMPORTED BODY`
  while the editor shows `NEW EDIT`. Revert can clear the obsolete draft.
- **Expected:** clear or rebind the open editor when replacement import changes
  rule identities, so deleted drafts cannot block subsequent saves.

### BUG-070 — Medium — WebSocket ping and pong captures lose non-text payload bytes

- **Status:** Fixed.
- **Review:** Real proxied control frames reproduced UTF-8 replacement bytes in
  captured payloads despite byte-for-byte forwarding. Control payloads are not
  constrained to text.
- **Resolution:** Preserve valid UTF-8 controls as text and encode other control
  payloads as base64 with explicit encoding metadata. Render binary controls
  through the existing hex payload view.
- **Verification:** All 86 WebSocket, detail-renderer, and test-layout checks
  passed. Real proxy coverage checks ping/pong in both directions with invalid
  UTF-8, Unicode text, and empty payloads, plus exact forwarded wire bytes;
  renderer tests verify lossless hex display.
- **Evidence:** ping and pong payloads are converted unconditionally to UTF-8
  (`src/proxy/proxy-server.js:4905-4907`) and retained only as that string
  (`:4910-4919`), although control-frame payloads can contain non-text bytes.
  The renderer displays this lossy string as the payload
  (`src/ui/app.js:3516-3526`).
- **Reproduction:** a real loopback WebSocket peer sends payload `ff008041` in
  a ping through the proxy. The client receives the exact bytes and its
  automatic pong returns them intact. Both captures instead contain the UTF-8
  replacement sequence `efbfbd00efbfbd41`, marked as UTF-8 with size 4, with
  no original byte field. An ASCII ping/pong control is preserved exactly.
- **Expected:** retain a lossless representation of control-frame payloads
  and choose text or binary display without discarding the original bytes.

### BUG-071 — Medium — Resend drops empty-name fields from complete URL-encoded bodies

- **Status:** Awaiting user review.
- **Review:** Confirmed that serialization drops empty names, while the editor
  also creates enabled blank placeholder rows. Asked whether to preserve such
  captured bodies in raw mode or add explicit empty-name support to the editor.
- **Evidence:** Resend converts a captured URL-encoded body into form fields
  (`src/ui/app.js:3027-3029`), including valid empty names. Send serialization
  discards fields whose key is empty (`:10571-10576`); the corresponding form
  snippet exporter applies the same exclusion (`src/ui/request-export.js:1-2,568-579`).
- **Reproduction:** send `=alpha&name=beta` through the local proxy and confirm
  the origin receives the complete body. The production Resend and serializer
  functions, extracted unchanged into an isolated renderer fixture, produce
  an enabled empty-name field but replay only `name=beta` to the real origin.
  The resulting Send cURL snippet also omits `alpha`. A named-field control
  round-trips exactly. This request has complete raw capture data.
- **Expected:** retain enabled empty-name fields during replay and export,
  or preserve the original raw body when structured editing cannot do so.

### BUG-072 — Medium — The context menu's Pin exchange action unpins an already pinned row

- **Status:** Fixed.
- **Review:** The menu action is intentionally a toggle, matching the detail
  button, but its label did not reflect the current state.
- **Resolution:** Show Unpin exchange for pinned rows and Pin exchange otherwise.
- **Verification:** All 69 context-menu, keyboard, pin/clear, and test-layout
  checks passed. The renderer regression pins, reopens the menu, unpins via the
  correctly labeled action, and verifies that another selected row is unaffected.
- **Evidence:** the context menu always says “Pin exchange” but calls the
  state-inverting toggle (`src/ui/app.js:15475-15477,2524`). The detail button
  correctly changes its label to “Unpin this exchange” for the same row.
- **Reproduction:** pin a retained exchange through the real renderer/API,
  open its row context menu and click “Pin exchange”. The authoritative API
  changes from pinned true to false; a subsequent Clear removes the exchange.
  The probe uses the production menu and actions, with an isolated traffic row.
- **Expected:** show the operation that will actually run, changing the menu
  label to Unpin for pinned rows.

### BUG-073 — Medium — Resume All silently discards visible breakpoint edits

- **Status:** Fixed.
- **Review:** The regression confirmed that bulk resume submitted empty objects
  for dirty drafts. Applying edits matches individual Resume behavior.
- **Resolution:** Share lifecycle-specific, phase-aware dirty-field selection
  between individual and bulk resume, retaining existing failure handling.
- **Verification:** All 79 breakpoint and test-layout checks passed. The bulk
  regression verifies request/response edits, duplicate IDs across lifecycles,
  untouched requests, and draft retention on a rejected resume.
- **Evidence:** bulk resume posts an empty modifications object for every
  pending breakpoint (`src/ui/app.js:15702-15710`) and clears its draft
  (`:15722`). Individual Resume instead includes dirty edits (`:15841-15859`).
  The banner label gives no indication that bulk resume discards changes.
- **Reproduction:** pause real local POST requests at a request breakpoint.
  Edit the displayed body through the production body editor. Individual
  Resume forwards `EDITED_SINGLE` to the origin. For the second request,
  the editor displays `EDITED_ALL`, but clicking Resume All forwards
  `ORIGINAL` and deletes the draft. Only the prompt return supplying the
  entered text is stubbed; proxy, API, renderer and origin behavior are real.
- **Expected:** apply each pending request's visible edits during bulk resume,
  or explicitly obtain a decision before discarding those edits.

### BUG-074 — Medium — A concurrent browser status read suppresses profile cleanup after exit

- **Status:** Fixed.
- **Review:** A held exit inspection reproduced a concurrent status read
  suppressing cleanup. The status flag must not bypass lifecycle retirement.
- **Resolution:** Route confirmed closure from isActive through the existing
  lifecycle cleanup and status notification path.
- **Verification:** All 137 browser lifecycle and test-layout checks passed.
  The simulated-child race verifies exactly one cleanup attempt and terminal
  notification, released ownership on success, and retryable state on failure.
- **Evidence:** `isActive()` sets `active=false` when it observes closure
  (`src/interceptors/browser-interceptor.js:155-164`). The asynchronous child
  exit handler then skips cleanup if that flag is already false (`:468-470`),
  and the status monitor stops without cleaning the lifecycle (`:845-856`).
- **Reproduction:** activate the production interceptor with a simulated child
  and an isolated managed profile. Emit exit while active, hold the exit
  handler's asynchronous process inspection, allow a concurrent inventory
  `isActive()` inspection to resolve false, then release the exit handler and
  tick the monitor. The profile remains, cleanup is never called,
  `cleanupPending` is false, `needsDeactivation()` is true and no exited status
  is emitted. The no-inventory control removes the profile and emits exited.
  Process behavior is simulated; the temporary profile lifecycle is real.
- **Expected:** route closure observations through lifecycle cleanup so a
  concurrent status read cannot cancel cleanup or its completion notification.

### BUG-075 — Medium — The JVM launch option changes dollar-sign paths in PowerShell

- **Status:** Awaiting user review.
- **Review:** Confirmed that Windows fallback quoting is CMD-oriented and the
  UI does not specify a shell. Asked whether to offer separate PowerShell/CMD
  options or standardize on a labeled PowerShell option.
- **Evidence:** Windows manual JVM options use expandable double quotes
  (`src/interceptors/jvm-interceptor.js:770-782`), without PowerShell escaping
  for dollar signs. The renderer presents the option without a CMD-only
  restriction (`src/ui/app.js:7057-7062,7110-7113`).
- **Reproduction:** generate the production option for an existing isolated
  placeholder JAR whose directory contains `$__auditJvmPathSegment`. Evaluate
  only the quoted argument in PowerShell with that variable unset. The literal
  path segment disappears and the argument points to a nonexistent JAR;
  a single-quoted literal control preserves the complete path. No JVM or agent
  is executed and no target process is changed.
- **Expected:** quote the option for the advertised shell or provide distinct
  shell-specific commands that preserve literal Windows paths.

### BUG-076 — Medium — The automatically selected gRPC viewer rejects valid gRPC-Web trailers

- **Status:** Fixed.
- **Review:** Verified binary gRPC-Web trailer flags against the linked protocol
  specification and reproduced rejection of a data frame followed by trailers.
- **Resolution:** Recognize binary gRPC-Web trailer frames, display their header
  text without protobuf decoding, and reuse bounded decompression for compressed
  trailers. Require trailers to end the stream.
- **Verification:** All 117 UI, fallback-editor, and test-layout checks passed.
  Regressions cover message preservation, repeated trailers, identity/gzip/deflate,
  misplaced trailers, native gRPC flag rejection, and decompression limits.
- **Evidence:** `application/grpc-web+proto` selects the gRPC viewer
  (`src/ui/app.js:4481-4483,4504-4509`), but its parser accepts only flags 0/1
  and abandons decoded messages on the valid `0x80` trailer (`:5208-5210`).
  That trailer framing is defined by the
  [gRPC-Web protocol](https://raw.githubusercontent.com/grpc/grpc/master/doc/PROTOCOL-WEB.md).
- **Reproduction:** serve a protobuf message containing varint 150 followed by
  a `0x80` frame carrying `grpc-status: 0`. Capture the real local response
  through the proxy and pass it to the production detail renderer in Chrome.
  The automatically selected viewer displays a decode error and hex instead
  of the decoded message. A native gRPC framing control displays the field.
  No compression is involved; this probe does not cover gRPC-Web-text or the
  traffic-list selection path.
- **Expected:** decode the recognized format's data and trailer frames, or
  identify the format as unsupported instead of reporting valid framing as
  malformed gRPC.

### BUG-077 — Low — Hostname-restricted mocks display the same summary as wildcard rules

- **Status:** Fixed.
- **Review:** The collapsed-row regression reproduced omission of a supported
  hostname matcher. Displaying the constraint matches existing host summaries.
- **Resolution:** Include hostname matchers in the escaped summary text.
- **Verification:** All 19 summary/escaping, matcher, and test-layout checks
  passed. Renderer regressions distinguish hostname-only rules from wildcards,
  retain combined path/port constraints, and verify IPv6 and HTML escaping.
- **Evidence:** the live rule-summary switch omits the supported `hostname`
  matcher (`src/ui/app.js:7865-7926`) and falls back to `*` (`:7992`).
- **Reproduction:** create one hostname-only fixed-response rule and one
  wildcard rule through the API. Both real collapsed rows display
  `ANY * → 200 Fixed Response`, although local proxy requests match the first
  only for its configured hostname; another host reaches the fallback rule.
  Opening the first editor confirms the hostname restriction is still stored.
- **Expected:** include the hostname constraint in the collapsed summary so
  a restricted rule is distinguishable from a catch-all rule.

### BUG-078 — High — Uninstall deletes interrupted system-proxy recovery state without restoring settings

- **Status:** Awaiting user review.
- **Review:** Confirmed unconditional deletion of the directory containing proxy
  recovery journals. Asked whether uninstall should attempt ownership-checked
  restoration and preserve data on failure, or preserve data whenever a recovery
  journal exists and report that recovery is required.
- **Evidence:** true NSIS uninstall invokes the cleanup helper
  (`build/installer.nsh:2-4`), which removes certificates and the entire data
  directory without restoring pending WinINET/WinHTTP journals
  (`src/windows-uninstall-cleanup.js:66-80`). Those journals contain the previous
  proxy settings and normally drive startup recovery
  (`src/interceptors/system-proxy-interceptor.js:817-841,668-672`).
- **Reproduction:** production activation writes both journals in an isolated
  directory using in-memory Windows adapters. After simulating an interrupted
  owner, ordinary restart restores the previous settings. With the same state,
  production uninstall instead deletes both journals, leaves both routes set
  to `127.0.0.1:8081`, performs zero restoration writes and prevents subsequent
  automatic recovery. The fixture validates its ignored directory and performs
  no native Windows changes or real uninstall.
- **Impact:** uninstalling after an interrupted active session can leave
  affected applications using an absent proxy while deleting the saved
  information needed to restore their previous configuration.
- **Expected:** restore or preserve pending interception recovery state before
  removing the data directory.

### BUG-079 — Low — The icon-generation command overwrites the shipped artwork with a different design

- **Status:** Awaiting user review.
- **Review:** Confirmed that the generator draws obsolete artwork rather than
  reading the shipped design. Asked whether to generate sizes from the current
  1024px artwork or remove the obsolete command.
- **Evidence:** `npm run generate-icons` draws a blue circle and white H
  (`scripts/generate-icons.js:132-177`), then overwrites every packaged PNG and
  the ICO (`:200,206,213`). The shipped icons instead contain a cyan `://`
  smile design on a dark rounded square. The generator reads no source artwork.
- **Verification:** source inspection and independent visual/decoded-asset
  inspection establish the mismatch: the shipped main icon's center is
  RGBA `[196,253,252,255]`, while the generator's white crossbar sets that
  pixel to `[255,255,255,255]`. The build and tray consume these output paths.
  The generator was not run and no assets were regenerated.
- **Expected:** derive sizes from the current canonical artwork or remove the
  obsolete generation command. Current image files themselves are valid.

### BUG-080 — Medium — Interceptor card CSS displaces Close buttons and collapses loading overlays

- **Status:** Fixed.
- **Review:** A Chrome layout probe reproduced relative-positioned controls,
  a 32x32 overlay, and a Close button displaced from the top-right corner.
- **Resolution:** Scope relative content positioning to primary/configuration
  children so overlay and Close positioning and stacking rules take effect.
- **Verification:** The same live Chrome probe measured a full 300x240 overlay,
  an 8px top/right Close inset, and the intended content/overlay/Close stacking.
  All four interceptor-card and test-layout checks passed.
- **Evidence:** the broad direct-child rule sets `position: relative` with
  higher specificity (`src/ui/styles.css:1773-1775`) than the loading-overlay
  and Close-button rules that require absolute positioning (`:1832-1844,1931-1947`).
- **Reproduction:** in the shipped UI, hold an Existing Terminal activation
  response using a simulated interceptor. The overlay becomes a 32×32 flex
  item at the bottom of a roughly 250×267 card. After expansion, Close sits
  near the left edge, 507 pixels from the right edge of its 540-pixel card.
  Real browser measurements and screenshots confirm both; a temporary scoped
  CSS control restores a full-card overlay and an 8-pixel top/right Close inset.
  Product styles and native interceptor settings are unchanged by the probe.
- **Expected:** preserve absolute positioning and intended stacking for these
  controls so the busy overlay covers its card and Close occupies its corner.

### BUG-081 — Medium — HTTP/2 to HTTP/1 HEAD responses lose representation size metadata

- **Status:** Fixed.
- **Review:** HEAD has no response body, so chunked framing cannot justify
  dropping its representation length. The wire regression also exposed a HEAD
  failure when advertised trailers reached Node's H1 response writer.
- **Resolution:** Preserve Content-Length for HEAD while omitting trailer
  framing; retain chunked framing for other streaming H2 responses.
- **Verification:** All 16 streaming, trailer, and test-layout checks passed.
  A real CONNECT/TLS/H1 client receives an H2 origin's length of 321 with zero
  body bytes, and final capture metadata retains it. Late GET trailers still pass.
- **Evidence:** the streaming H2-origin to H1-client bridge unconditionally removes
  `Content-Length` before sending and capturing response headers
  (`src/proxy/proxy-server.js:1860-1862`). This selects chunked framing for possible
  late trailers, but also removes the representation length from HEAD responses,
  which carry no response body.
- **Reproduction:** a local HTTPS/H2 origin responds to HEAD with status 200 and
  `Content-Length: 321`. A direct H2 client receives 321. The same request through
  FreeKit over a real CONNECT/TLS/H1 connection receives 200 without the header,
  and the traffic record also omits it. An HTTPS/H1-origin control through the
  same proxy preserves 321. Both responses correctly have zero body bytes.
- **Impact:** HEAD requests used to inspect resource size lose that metadata when
  the upstream service supports H2; both the client and captured headers differ
  from the origin response.
- **Expected:** preserve HEAD representation metadata while selecting framing
  appropriate to a response without a body. This is a fidelity finding, not a
  claim that every HEAD response must include Content-Length.

### BUG-082 — Medium — macOS Dock activation does not reopen a window hidden by Close

- **Status:** Fixed. Dock activation restores and focuses an existing window through
  the shared readiness-aware helper, or creates a missing/destroyed window after
  server startup. Production-handler regression fixtures cover Close → activation,
  pending window readiness, minimization, and missing/destroyed windows. Native
  macOS execution remains unavailable on this Windows host.
- **Evidence:** the desktop's default Close action hides the live window
  (`electron/window-to-tray.cjs:59-70`), but the macOS `activate` handler acts only
  when `mainWindow === null` (`electron/main.cjs:774-778`). It never shows the
  existing hidden window. Electron documents Dock clicks as a trigger for this
  event in its [application event documentation](https://www.electronjs.org/docs/latest/api/app#event-activate-macos).
- **Reproduction:** install the production close-to-tray helper and production
  activation handler with a simulated native window. Close hides the window;
  emitting `activate` with `hasVisibleWindows: false` leaves it hidden, with zero
  show/focus/create calls. Calling the production tray Show helper restores and
  focuses the same window. This is a production-handler fixture; macOS was not
  executed on the Windows audit host.
- **Impact:** after an ordinary Close on macOS, clicking the Dock icon does not
  return the user to the application. The tray Show action is a working fallback.
- **Expected:** activation should show and focus an existing hidden window, or
  create one when none exists.

### BUG-083 — Medium — JSON formatting silently changes large integer values

- **Status:** Fixed. Send and JSON previews use a shared formatter that validates
  JSON but writes the original tokens with new whitespace. Regression tests cover
  large integers, precise decimals, exponent notation, negative zero, escaped
  strings, duplicate keys, nested/empty containers, and invalid JSON. All 359 UI,
  Send, and related checks passed. The original Chrome/Monaco reproduction also
  passed: the preview, Format button, and subsequent real proxied POST preserve
  `9007199254740993` exactly.
- **Evidence:** Send's JSON Format button parses the body into JavaScript Numbers
  before serializing it (`src/ui/app.js:10381-10386`). Both Monaco JSON previews
  (`:5556-5560`) and the fallback viewer (`:5507-5512`) perform the same conversion.
  Integers outside the exact Number range can be rounded during this formatting.
- **Reproduction:** enter `{"orderId":9007199254740993,"safeId":12345}` in Send's
  JSON body editor. An initial POST reaches a local origin with the exact original
  bytes. The origin echoes that JSON; the captured body still contains
  `9007199254740993`, but its formatted response preview shows `9007199254740992`.
  Clicking the actual Format button changes the editable request to the rounded
  value, and the next POST delivers that changed ID to the origin. The smaller
  control ID remains 12345. Verified in the shipped Chrome/Monaco UI through the
  real API and proxy.
- **Impact:** inspecting JSON can show a different resource ID from the captured
  traffic, and a formatting action can silently change the subsequent request.
- **Expected:** preserve numeric tokens when pretty-printing JSON, including
  64-bit IDs. Formatting should change whitespace without changing values.

### BUG-084 — Medium — Form detection overrides an explicit JSON response type

- **Status:** Fixed. Recognized media types now take priority over fallback content
  heuristics; JSON arrays and markup also take priority over the form heuristic.
  Regression tests cover JSON arrays/strings, structured JSON media types, other
  recognized formats, and fallback controls. All 362 UI, Send, and layout checks
  passed. The original real Chrome/API/proxy reproduction now opens query-bearing
  JSON arrays as JSON and keeps genuine form responses in Decoded mode.
- **Evidence:** body-view selection applies a heuristic for strings containing
  `=` and `&` before checking an explicit JSON Content-Type
  (`src/ui/app.js:4527-4530`). It excludes leading `{` but allows JSON arrays
  and strings, and returns only Decoded, Raw and Hex modes for those responses.
- **Reproduction:** a real local origin returns `application/json` with
  `["https://example.com/?a=1&b=2"]` to Send. The captured bytes remain exact, but
  the response opens as two decoded form fields and the mode dropdown offers no
  JSON option. A JSON array containing a URL without query parameters opens
  correctly as JSON; a genuine `application/x-www-form-urlencoded` response
  also selects its correct Decoded view. Verified in the shipped browser UI
  through the real API and proxy.
- **Impact:** ordinary JSON containing query URLs loses JSON inspection and is
  initially shown as misleading form names and values. Raw remains available.
- **Expected:** honor the explicit media type before applying fallback content
  heuristics, and retain JSON view for valid JSON arrays and strings.

### BUG-085 — Low — Whole-buffer ClientHello parser is used only by a test

- **Status:** Fixed. Removed the unused whole-buffer helper after confirming it
  had no production callers. Its regression now exercises the live capturing
  socket with the handshake header split at each internal byte boundary, both
  across incoming chunks and in coalesced initial data, asserting capture and
  unchanged byte forwarding. All 29 proxy TLS and test-layout checks passed.
- **Evidence:** `ProxyServer._parseClientHello()` remains at
  `src/proxy/proxy-server.js:9411-9443`, but a repository-wide caller search finds
  only its definition and a direct test call in
  `test/proxy/tls/fragmented-client-hello.test.js:72`. No production or dynamic
  dispatch caller exists. The live capturing socket assembles the handshake
  itself and calls `_parseClientHelloHandshake()` directly
  (`src/proxy/proxy-server.js:9774-9776`).
- **Impact:** the shipped proxy retains a separate unused parsing path and a
  test that protects that path rather than exercising the active socket path.
  This does not indicate a failure of live fragmented ClientHello handling.
- **Expected:** remove the unused whole-buffer helper and exercise the live
  capture entry point for its intended regression coverage.

### BUG-086 — Medium — Original response-header mode still applies hidden removals

- **Status:** Fixed. The shared header transformer now preserves headers unless
  Update or Replace is selected. A real HTTP regression switches repeatedly
  between modes while retaining hidden replacements/removals and keeping a status
  override active, verifying headers, status, and body. All 350 mocking and
  test-layout checks passed.
- **Evidence:** the transform editor changes `resHeadersMode` to `original`
  without clearing `resRemoveHeaders`, then hides the removal field
  (`src/ui/app.js:8753-8772`). `_applyMockResponseTransform()` still passes those
  removals to `_applyMockHeaderTransform()`, which removes names regardless of
  mode (`src/proxy/proxy-server.js:3762-3768,3889-3894`).
- **Reproduction:** configure a validated combined transform with response-header
  mode `update` and remove `x-origin`. Switch only that mode to “Use the original
  response headers,” as the editor does. A real local HTTP exchange still loses
  the origin's `x-origin: preserve-me` in both the client response and capture.
  Clearing the saved removal list restores the header; status and body are
  unchanged in all three cases.
- **Impact:** a disabled header transformation continues modifying responses.
- **Expected:** original mode preserves the original response headers even when
  the draft retains settings for another mode.

### BUG-087 — Medium — Send cannot preview HTTP-compressed response bodies

- **Status:** Awaiting user review. The bug is valid; choosing whether to retain
  Send's reversible raw API body and add decoded preview fields (recommended), or
  change that body to decoded content with explicit metadata, affects API consumers.
  Either approach should use bounded decoding and preserve raw data on failure.
- **Evidence:** the Send API serializes raw response bytes without decoding
  `Content-Encoding` (`src/api/api-server.js:3241-3256`). The renderer selects
  a body mode from the original content type and feeds these bytes directly
  into the viewer (`src/ui/app.js:12825-12888`).
- **Reproduction:** send requests through the real API/proxy to a local origin
  returning the same JSON uncompressed and with `Content-Encoding: gzip`.
  Uncompressed Send preview shows the JSON. Gzip Send preview selects JSON mode
  but displays `data:application/json;base64,H4sI...`. The associated traffic
  record has the correctly decoded JSON and `responseBodyContentDecoded: true`;
  clicking “View in traffic” displays that JSON correctly.
- **Impact:** compressed HTTP responses cannot be inspected normally in Send,
  although their wire bytes and authoritative traffic capture are correct.
- **Expected:** Send applies HTTP content decoding before presenting the response
  in its JSON/text viewer.

### BUG-088 — Medium — Failed System Proxy cleanup has no Stop control

- **Status:** Fixed. System Proxy inventory exposes cleanup ownership while inactive.
  Its card shows Cleanup pending and offers Stop even when activation is unavailable,
  routing to the existing deactivation path. All 147 interceptor and layout checks
  passed, including simulated partial activation/rollback and card action tests.
  No native system proxy settings were changed during verification.
- **Evidence:** failed activation can retain rollback ownership while setting
  `active = false` (`src/interceptors/system-proxy-interceptor.js:847-882`).
  Its inventory omits the remaining cleanup state (`:995-1001`), and the card
  exposes Stop only when active (`src/ui/app.js:6304-6333`). A new activation
  instead rejects the operation with an instruction to retry Stop.
- **Reproduction:** with all native operations simulated, fail activation at
  ProxyOverride and its rollback at ProxyServer. The real interceptor retains
  a recovery journal and simulated enabled proxy, with `isActive() === false`
  and `needsDeactivation() === true`. The actual API/browser card displays Start
  and no Stop. Clicking again retries activation and reports “cleanup is still
  pending; retry Stop.” A direct manager deactivation control restores the exact
  baseline and removes the journal. No real system settings were changed.
- **Impact:** users cannot retry this required cleanup from its card while
  proxy settings can remain changed. The cleanup routine itself is available.
- **Expected:** expose a retryable Stop/cleanup action whenever the interceptor
  retains cleanup ownership, including after failed activation.

### BUG-089 — Low — Update-ready toast keeps the previous downloaded version

- **Status:** Open.
- **Evidence:** downloaded-update events update the renderer's version, but
  `showUpdateReadyToast()` returns when the earlier install button exists
  (`src/ui/app.js:17161-17163,17199-17204`). Its persistent text is never refreshed.
- **Reproduction:** exercise the production updater's manual check, download and
  status flow with simulated release events, delivering them to the actual
  renderer in Chrome. Download v2.0.0, defer restart, then check and download
  v3.0.0. Backend status reports v3.0.0 while the toast still says “Update v2.0.0
  ready. Restart to install.” No native installation was performed.
- **Impact:** the restart action identifies an older version than the downloaded
  update. This reproduction does not establish an installation failure.
- **Expected:** refresh the existing update-ready message for each newly
  downloaded version.

### BUG-090 — Medium — Installed Firefox is misreported as missing

- **Status:** Open.
- **Evidence:** Firefox `isActivable()` also returns false when the browser is
  installed but both system CA trust and NSS certutil are unavailable
  (`src/interceptors/browser-interceptor.js:53-58`). The renderer interprets
  every unavailable browser as missing, displaying “Click to install” and
  wiring its primary action to Download (`src/ui/app.js:6273-6275,6291-6330`).
  That action explicitly claims Firefox is not installed (`:6003`).
- **Reproduction:** use the production availability method, manager inventory,
  API and browser card with native discovery simulated. An inert installed
  executable marker exists, but NSS and trust are unavailable. The card offers
  Download Firefox; clicking it displays “Firefox is not installed.” Enabling
  only simulated NSS, or only simulated system trust, changes the same installed
  browser's card to Start. No native launch or download was performed.
- **Impact:** users are directed to reinstall an existing browser and receive
  no explanation of the missing certificate prerequisite that prevents starting.
- **Expected:** distinguish missing browser installation from missing Firefox
  certificate prerequisites and show the applicable remediation.

### BUG-091 — Medium — Interrupted WebSocket rejection bodies lack incomplete-capture metadata

- **Status:** Open.
- **Evidence:** `_forwardRejectedUpgradeResponse()` finalizes aborted handshake
  responses using the ordinary streamed-body conversion, without the incomplete
  body fields used by other response paths
  (`src/proxy/proxy-server.js:4276-4297,4344`). Below the capture-size limit,
  the retained partial body is consequently unmarked.
- **Reproduction:** a real local origin returns `401 Unauthorized` with
  `Content-Length: 100`, sends seven bytes (`partial`), and closes. An ordinary
  HTTP request records `responseBodyTruncated: true`, captured size 7 and expected
  size 100. The same response to a WebSocket upgrade records the abort error but
  none of those body fields. HAR export of the HTTP control includes the
  truncation comment and provenance; the failed-upgrade export contains only
  size 7, MIME type and text, matching the body metadata of a complete seven-byte
  rejected-upgrade control.
- **Impact:** body consumers and exported HAR lose the distinction between a
  complete rejection body and an interrupted one. The live record still reports
  the abort error, and the seven received bytes are preserved.
- **Expected:** mark incomplete rejected-upgrade response captures and propagate
  their captured/expected sizes consistently with ordinary HTTP responses.

### BUG-092 — Medium — JVM attach-helper cache survives an incompatible Java runtime change

- **Status:** Open.
- **Evidence:** `AttachProxy.class` is compiled with the host `javac` defaults
  (`src/interceptors/jvm-interceptor.js:742-743,1240-1241`). Cache validation checks
  source/content hashes and bytecode magic, but neither runtime identity nor class
  version (`:1244-1303`). The cached class is later run using `java` from the new
  process environment (`:1373-1377`).
- **Reproduction:** in an isolated cache, exercise the production cache and attach
  orchestration with compiler/runtime operations simulated. A first interceptor
  creates major-version-61 bytecode; a restarted interceptor supporting at most
  major 52 reuses it with zero compiler calls and fails to attach. Removing only
  the fixture cache stamp makes the production repair path rebuild a compatible
  helper and succeed. No real JVM was launched or attached.
- **Impact:** switching FreeKit's host JDK from 17 to 8/11 can leave attachment
  unusable across restarts until the cache is invalidated. This runtime consequence
  follows the [javac default compilation rules](https://docs.oracle.com/en/java/javase/17/docs/specs/man/javac.html)
  and [JVM class-version requirements](https://docs.oracle.com/javase/specs/jvms/se17/html/jvms-4.html#jvms-4.1):
  Java 17 uses major 61, while Java 8 and 11 accept at most 52 and 55 respectively.
- **Expected:** validate the cached helper against the selected Java runtime and
  rebuild incompatible bytecode, or include its runtime compatibility in the
  cache policy.

### BUG-093 — Medium — Quit retries retain an obsolete System Proxy owner blocker

- **Status:** Open.
- **Evidence:** startup recovery caches a blocking reason when another live owner
  holds the proxy journals. `deactivate()` throws those cached reasons without
  refreshing recovery (`src/interceptors/system-proxy-interceptor.js:963-981`).
  Activation does refresh them (`:766-770`), but the manager intentionally closes
  activation admissions after the first shutdown attempt
  (`src/interceptors/interceptor-manager.js:225-240,337-343`).
- **Reproduction:** simulate two owners and Windows proxy stores with real isolated
  journal files. The second owner observes the first owner's journals and attempts
  manager shutdown. The first owner then successfully restores both stores and
  removes both journals. Two further shutdown attempts by the second still fail
  with the old owner-blocking reasons. Explicitly calling the existing recovery
  method clears the now-absent journals' blockers, and the same shutdown succeeds.
  Process identity and all native operations are simulated; no system settings change.
- **Impact:** ordinary Quit retries remain blocked after the actual obstruction
  is gone, requiring process termination or another recovery intervention. This
  reproduction does not leave modified proxy settings behind.
- **Expected:** revalidate recovery ownership during cleanup retries and allow
  shutdown once the other owner has released its journals.

### BUG-094 — Medium — JVM interception drops configured TLS client certificates

- **Status:** Open.
- **Evidence:** the generated agent installs a replacement default SSL context
  with null key managers (`src/interceptors/jvm-interceptor.js:637-642`). It
  preserves server trust but drops the client identity supplied by the original
  default context. The [Java 8 JSSE reference](https://docs.oracle.com/javase/8/docs/technotes/guides/security/jsse/JSSERefGuide.html)
  distinguishes an empty key manager from the default context's configured key store.
- **Reproduction:** compile the unchanged generated agent and run it inside a
  disposable Java 8 process configured with `javax.net.ssl.keyStore` and a password.
  A direct connection to a local TLS server requiring a client certificate succeeds.
  Calling the production agent activation method makes the same connection fail:
  the server reports `ERR_SSL_PEER_DID_NOT_RETURN_A_CERTIFICATE`. Calling the
  agent's deactivation method restores successful client authentication. All
  certificates and stores belong to the fixture; no existing JVM is attached.
- **Impact:** activation breaks new default TLS connections that require a client
  certificate, including direct TLS sockets outside the HTTP proxy route.
- **Expected:** retain the application's configured client identity while adding
  FreeKit's CA trust.

### BUG-095 — Medium — Forward capture retains a header value that was replaced on the wire

- **Status:** Open.
- **Evidence:** the HTTP/1 Forward action copies raw-case request headers and
  assigns `addRequestHeaders` using case-sensitive object keys
  (`src/proxy/proxy-server.js:10767-10770`). Its helper snapshots those keys before
  Node normalizes the outgoing headers (`:789,868`), then uses that snapshot for
  the modified request capture (`:3600-3606,10814-10823`). The action property is
  supported by validation (`src/proxy/mock-rule-validation.js:302-307`).
- **Reproduction:** install a validated Forward rule containing
  `addRequestHeaders: {"x-color":"new"}` and send `X-Color: old` through a real
  local HTTP/1 proxy/origin. The origin receives only `x-color: new`, but terminal
  capture and HAR export contain both `X-Color: old` and `x-color: new`. Using the
  same spelling `X-Color` in the override produces correct capture and wire data.
  The fixture installs the rule through the production object; the supported
  user-facing scope is API/imported rules, since this property has no editor field.
- **Impact:** inspection and HAR export misrepresent the effective forwarded
  request. The header override itself reaches the origin correctly.
- **Expected:** capture the effective case-insensitive header collection actually
  sent to the forwarding destination.

### BUG-096 — Medium — Expanded interceptor refresh overwrites newer live status

- **Status:** Open.
- **Evidence:** after expanding a configurable interceptor, the renderer fetches
  the whole inventory and checks only card-operation ownership before assigning
  it (`src/ui/app.js:6399-6412`). It omits the global status-generation check used
  by `loadInterceptors()` (`:5917-5932`), although live status events advance that
  generation (`:6190-6192`).
- **Reproduction:** with Chrome active in simulated interceptor metadata, click
  Configure Existing Terminal in the real browser UI and delay its inventory
  response. Deliver a Chrome exit through the production API WebSocket channel:
  Chrome becomes inactive and leaves Connected Sources. Release the older HTTP
  inventory response: Chrome becomes active and reappears in Connected Sources,
  while backend metadata remains inactive. The same ordering through the shared
  loader correctly preserves the inactive state. No native interceptor is started.
- **Impact:** cards and Connected Sources display stale active state until a later
  refresh, despite having already received the correct live update.
- **Expected:** every whole-inventory refresh should reject or reconcile state
  superseded by a newer status event.

### BUG-097 — Low — Read-only mock details hide a numeric zero header value

- **Status:** Open.
- **Evidence:** the add-header pre-step detail renders `step.value || ''`
  (`src/ui/app.js:8347`), while its editor uses `step.value ?? ''` (`:9018`).
  Numeric zero is explicitly supported
  (`test/mocking/mock-rule-validation.test.js:362-367`).
- **Reproduction:** import or create through the API a rule whose add-header
  pre-step sets `X-Counter` to numeric `0`. Expand it: the editor displays `0`.
  Open another rule while leaving the first expanded: its read-only detail now
  shows `Add header X-Counter: ` with no value. A real local origin still receives
  `0`. A string `"0"` control displays and forwards correctly.
- **Impact:** the detail view makes a valid zero value look empty. The stored rule,
  editable field and forwarded header remain correct.
- **Expected:** preserve supported numeric zero values in the read-only description.

### BUG-098 — Low — A delayed breakpoint refresh restores a stale paused banner

- **Status:** Open.
- **Evidence:** `updateBreakpointBanner()` applies every completed pending-list
  response without checking whether a newer refresh has superseded it
  (`src/ui/app.js:15680-15694`). Breakpoint hit/resume events and successful Resume
  actions all call it (`:1391,1402,15869`).
- **Reproduction:** pause one real local request and hold delivery of a pending-list
  response containing that request. Run the production Resume function in the
  browser. The origin response completes, the proxy has zero pending breakpoints,
  and newer refreshes hide the banner. Release the older response: the banner
  reappears with “1 request paused.” A fresh pending-list read hides it again.
  The fixture uses the actual browser/API/proxy and changes only response timing.
- **Impact:** the UI falsely reports paused traffic after the request has already
  completed. Request forwarding and breakpoint cleanup succeed.
- **Expected:** prevent superseded pending-list responses from replacing the latest
  aggregate breakpoint state.

### BUG-099 — Medium — HTTPS Forward rules discard the captured client TLS profile

- **Status:** Open.
- **Evidence:** `_requestMockForward()` accepts no captured ClientHello context
  and calls the TLS option/agent helpers without it
  (`src/proxy/proxy-server.js:758-760,801-803`). Ordinary forwarding supplies that
  context (`:716-735`); client fingerprint mirroring requires it (`:9948-9952`).
  The intercepted HTTPS Forward action uses the context-free helper (`:6238-6245`).
- **Reproduction:** select client fingerprint mirroring and send a custom TLS
  cipher profile to a local HTTPS origin using HTTP/1. Direct and ordinary
  intercepted requests produce the same JA4 fingerprint. Add a validated Forward
  rule targeting that same origin and repeat: its JA4 now matches a separate
  default-Node connection, rather than the custom-client control. All four
  requests succeed. The probe runs on the pinned Node 26.7 runtime with isolated
  certificates and no system trust changes.
- **Impact:** enabling a Forward rule silently removes client-profile mirroring
  from the outbound TLS connection. This is separate from the documented
  limitations of otherwise active fingerprint mirroring.
- **Expected:** carry the captured client profile through HTTPS Forward actions
  when selecting outbound TLS options and agents.

### BUG-100 — Medium — Unicode hostnames are silently ignored in upstream-proxy exclusions

- **Status:** Open.
- **Evidence:** the “Non-proxied hosts” field accepts hostname text and submits it
  unchanged (`src/ui/index.html:503-504`, `src/ui/app.js:13843-13854`).
  `normalizeNoProxyEntries()` preserves Unicode spellings
  (`src/proxy/upstream-proxy-config.js:29-34`), while routing compares these
  literal strings with the destination's ASCII URL hostname
  (`src/proxy/proxy-server.js:3050-3089`).
- **Reproduction:** configure a local HTTP upstream proxy and exclude
  `bücher.example`. Request that internationalized hostname through FreeKit:
  the accepted exclusion is ignored and the upstream receives the request.
  Change only the exclusion to its ASCII form, `xn--bcher-kva.example`: the
  same request reaches the origin directly. Both responses are 200. The real
  local proxy/origin/upstream fixture maps only the test hostname's DNS lookup
  to loopback; no system DNS or proxy settings are changed.
- **Impact:** traffic for an accepted excluded hostname still passes through the
  upstream proxy. Users must supply the ASCII hostname as a workaround.
- **Expected:** compare internationalized hostname exclusions using the same
  canonical representation as request destinations.

### BUG-101 — Medium — A retired upstream response can abort a healthy HTTP retry

- **Status:** Open.
- **Evidence:** HTTP/1 streaming retries a 410 response after resuming its body,
  leaving the old request's idle timeout and error handler active
  (`src/proxy/proxy-server.js:1662-1665,1766-1773`). The shared failure handler
  does not reject errors from a superseded request; it can destroy the downstream
  using the newer response's metadata (`:1564-1617`). The old timeout destroys
  its request with `ETIMEDOUT` (`:685-691`).
- **Reproduction:** make a local upstream return 410 headers and leave that
  response open. Acknowledge the retry and have the second attempt return 200,
  sending a chunk every 20 ms. The old response becomes idle and its timeout
  aborts the healthy 200 response. With the idle limit shortened from 30 seconds
  to 120 ms, the independent run retained 25 bytes and reported `ETIMEDOUT`.
  Ending the first response normally lets the identical retry complete all
  68 bytes. All HTTP transport is real and local; the fixture supplies the retry
  acknowledgement callback without contacting an external provider.
- **Impact:** a successful streaming retry is cut short by a timeout belonging
  to the discarded attempt, even while the current response keeps delivering data.
- **Expected:** retire abandoned attempt timers and prevent stale callbacks from
  failing the current exchange.

### BUG-102 — Medium — A stale configuration read hides scheduled CA renewal and its Cancel action

- **Status:** Open.
- **Evidence:** `loadConfig()` applies every completed configuration response
  without a generation check (`src/ui/app.js:12988-13004`). Renewal actions call
  it after a successful mutation (`:14982-14988`), while the renderer uses the
  returned scheduled flag to select its message and show Cancel (`:12953-12984`).
- **Reproduction:** initialize an isolated CA requiring manual renewal and hold
  delivery of a real configuration response with renewal unscheduled. Run the
  production Schedule action: the API writes the renewal marker and a newer
  read shows the scheduled message and Cancel. Release the old response: the UI
  says automatic replacement is paused, hides Cancel, and offers Schedule again.
  The backend still reports renewal scheduled and retains the marker. A fresh
  configuration read restores the correct controls. The real browser/API probe
  performs no CA replacement or system trust changes.
- **Impact:** the displayed renewal state is wrong and the cancellation control
  disappears while replacement remains scheduled for the next restart.
- **Expected:** prevent superseded configuration reads from replacing the state
  confirmed after a renewal action.

### BUG-103 — Medium — Windows Fresh Terminal preserves a case variant of Node's TLS validation override

- **Status:** Open.
- **Evidence:** Fresh Terminal copies the inherited environment into an ordinary
  object and deletes only `NODE_TLS_REJECT_UNAUTHORIZED`
  (`src/interceptors/terminal-interceptors.js:1244-1251`). A lowercase Windows
  environment name survives that deletion. Electron's equivalent preparation
  already removes case variants (`src/interceptors/electron-interceptor.js:142-147`).
- **Reproduction:** supply inherited `node_tls_reject_unauthorized=0` during a
  simulated Windows Fresh Terminal launch, then pass its actual prepared
  environment to a disposable Node child. On Windows, that child reads
  `process.env.NODE_TLS_REJECT_UNAUTHORIZED` as `"0"`. An otherwise identical
  uppercase-input control reads no value. The probe simulates terminal launch
  and ownership; it starts only two harmless Node children and changes no system
  environment, trust or proxy settings.
- **Impact:** Node programs launched in that terminal can retain disabled TLS
  certificate validation from the inherited environment. Node documents this
  effect of value `0` in its [CLI reference](https://nodejs.org/api/cli.html#node_tls_reject_unauthorizedvalue).
- **Coverage gap:** the Fresh Terminal environment test checks removal of only
  the uppercase spelling (`test/interceptors/terminal/terminal-ca-bundle.test.js:152-203`).
- **Expected:** remove the override using Windows environment-name comparison
  rules before launching the terminal.

### BUG-104 — Medium — Manual Electron launch commands retain an inherited TLS validation override

- **Status:** Open.
- **Evidence:** Electron's automatic environment removes all case variants of
  `NODE_TLS_REJECT_UNAUTHORIZED` (`src/interceptors/electron-interceptor.js:142-147`).
  Its manual environment keeps only eight positive assignments (`:153-165`),
  and the generated shell command never removes the inherited override
  (`:167-183`). Activation without `appPath` explicitly returns these instructions
  (`:609-621`) through the supported API (`src/api/api-server.js:1509-1515`).
  In an independently repeated Windows control, executing the generated setup
  with an inherited uppercase value `0` left the launched child's value at `0`;
  using the automatic environment removed it. The placeholder executable was
  replaced with an owned Node environment printer. CA/platform preparation was
  simulated; no Electron application, TLS connection or native setting was changed.
- **Impact:** API users running the returned manual command in a shell with this
  pre-existing override retain disabled Node TLS certificate validation, despite
  automatic interception clearing it. The effect of value `0` is documented in
  the [Node CLI reference](https://nodejs.org/api/cli.html#node_tls_reject_unauthorizedvalue).
  The renderer's normal executable-picker flow is outside this finding. FreeKit
  does not create the override; only the generated Windows command was executed.
- **Coverage gap:** `test/interceptors/electron/electron-launch-args.test.js:55-103`
  checks manual assignments and quoting without inherited-key removal.
- **Expected:** manual launch commands explicitly remove the inherited override
  before starting the application, matching automatic launch behavior. This
  command-serialization omission is distinct from BUG-103's case-sensitive deletion.

### BUG-105 — Low — Body-matcher textareas ignore the Dark theme

- **Status:** Open.
- **Evidence:** the Body Contains, JSON Body exact/partial, Regex Body and Raw Body
  matcher editors generate textareas directly inside `.mock-matcher-row`
  (`src/ui/app.js:8577-8584`, `:8606-8610`). The corresponding theme rules style
  only selects and inputs (`src/ui/styles.css:3815-3829`). An independently
  repeated production-browser check shows all five textareas as black text on
  white in Dark, while the adjacent matcher input and response-body textarea
  use white on `#16181e`. Switching themes changes those controls but leaves
  the matcher textareas at browser defaults. The screenshot confirms the mismatch.
- **Impact:** these body-matching controls visibly ignore the selected Dark
  appearance and use inconsistent default borders and spacing. This is a styling
  defect; the probe does not establish a contrast failure or changed request behavior.
- **Coverage gap:** the theme and responsive-layout tests do not check computed
  styles of generated body-matcher textareas.
- **Expected:** apply the matcher input surface, text, border and spacing rules to
  textareas as well, as the action editor already does (`src/ui/styles.css:3878-3897`).

### BUG-106 — Medium — macOS Fresh Terminal clears the TLS override in the launcher instead of the target shell

- **Status:** Open.
- **Evidence:** Fresh Terminal removes `NODE_TLS_REJECT_UNAUTHORIZED` from the
  launcher environment (`src/interceptors/terminal-interceptors.js:1244-1251`).
  On macOS that environment belongs to `osascript`, which sends the generated
  command to Terminal.app's login shell (`:1340-1355`). The command exports proxy
  and CA variables but never unsets the TLS override (`:1129-1157`). A pre-existing
  override set by that shell's login script therefore survives. Apple's
  [shell environment documentation](https://developer.apple.com/library/archive/documentation/OpenSource/Conceptual/ShellScripting/CommandLInePrimer/CommandLine.html)
  confirms that shells have separate environments and login scripts can persist
  variables across Terminal windows.
- **Verification:** capture the actual macOS activation command with Apple Events
  and session ownership simulated. Its launcher environment omits the override,
  but executing the unchanged command in a disposable POSIX shell that already
  has the uppercase variable set to `0` leaves it at `0`. An explicit-unset
  control removes it. Two reviewers independently obtained this result using
  profile-free Git Bash children; native macOS execution was not performed.
- **Impact:** Node processes started in the affected shell retain disabled TLS
  certificate verification. This requires a pre-existing override; FreeKit does
  not create it. The macOS consequence follows from the production launch path
  and shell semantics, rather than a native macOS reproduction.
- **Coverage gap:** the platform-loop test checks only the launcher's environment
  (`test/interceptors/terminal/terminal-ca-bundle.test.js:152-203`); the generated
  POSIX-command test checks positive exports without requiring an unset
  (`test/interceptors/terminal/macos-terminal-environment.test.js:5-30`).
- **Expected:** clear the override inside the target shell, as Existing Terminal
  instructions already do (`src/interceptors/terminal-interceptors.js:169`). This
  process-boundary defect is separate from BUG-103's case-sensitive deletion and
  BUG-104's manual Electron command serialization.

### BUG-107 — Medium — A delayed rule load hides a successfully combined mock group

- **Status:** Open.
- **Evidence:** `loadMockRules()` checks completed responses against its
  load-generation token (`src/ui/app.js:7800-7808`). A successful Combine applies
  the server's new rule tree without invalidating pending loads (`:7717-7735`).
  An older GET can subsequently restore the previous flat collection. Reset
  explicitly invalidates those loads (`:7472-7475`), but Combine does not.
- **Reproduction:** start with two saved rules and hold an older rules GET, such
  as the load initiated on WebSocket reconnect (`src/ui/app.js:1308-1310`). Combine
  the rules successfully, then release that GET. Two independent production-browser
  runs displayed one group with two children immediately after Combine, then zero
  groups and two top-level rules after the old response arrived. The real API still
  returned the combined group; another fresh load restored it in the renderer.
  The probe delayed response delivery without fabricating payloads.
- **Impact:** the completed grouping appears undone and its group controls
  disappear until another load. Server persistence remains correct; this is
  separate from BUG-046's group/child draft overwrite and requires no draft edits.
- **Coverage gap:** the Combine test verifies its immediate response but no
  overlapping older load (`test/mocking/atomic-rule-combine.test.js:205-232`).
  The analogous delayed-load test covers Reset only
  (`test/mocking/reset-default-rules.test.js:215-235`).
- **Expected:** accepting a successful collection mutation makes older collection
  reads obsolete, preserving the confirmed group in the renderer.

### BUG-108 — Medium — cURL paste silently changes ANSI-C quoted request bodies

- **Status:** Open.
- **Evidence:** the cURL tokenizer recognizes ordinary single and double quotes
  but treats the dollar sign in Bash's `$'…'` syntax as literal text and retains
  the enclosed backslash escapes (`src/ui/curl-parser.js:132-172`). It accepts
  this altered argument as the body (`:237-246`). The real paste handler reports
  success and replaces the Send tab with those bytes
  (`src/ui/app.js:17279-17295`, `:12569-12592`).
- **Reproduction:** paste `curl 'http://127.0.0.1:8080/' --data-raw $'first\nsecond'`
  into Send's URL field, with a local HTTP server listening on that port, then
  send it. An isolated browser/API/proxy reproduction and independent rerun both
  sent the literal body `$first\nsecond` and received HTTP 200. Executing the
  same command with profile-free Bash/cURL against the same origin instead sent
  `first`, a newline, and `second`. This matches the documented
  [Bash ANSI-C quoting rules](https://www.gnu.org/software/bash/manual/html_node/ANSI_002dC-Quoting.html).
- **Impact:** an accepted pasted command sends different request content from
  the original command, potentially changing structured or multiline payloads.
  This is separate from the header-precedence and export-syntax issues in
  BUG-041 and BUG-042.
- **Coverage gap:** `test/send/curl-parser.test.js:316-346` checks ordinary
  quoting, backslashes and line continuations, but not ANSI-C quoted arguments.
- **Expected:** decode supported ANSI-C quoted arguments accurately, or reject
  that quoting syntax before replacing the request and reporting success.

### BUG-109 — Medium — HTML Format adds visible spaces between inline elements

- **Status:** Open.
- **Evidence:** `beautifyMarkup()` inserts a newline at every adjacent tag
  boundary and joins the tokens with newlines (`src/ui/app.js:5283-5309`).
  Send's HTML Format action replaces the editable request body with that result
  (`:10387-10391`), without preserving significant inline whitespace.
- **Reproduction:** in the production browser UI, send a raw HTML POST containing
  `<span>Hello</span><span>world</span>` to a local origin, click Format, then Send
  again. The origin first receives the original body, then receives
  `<span>Hello</span>\n<span>world</span>` (an actual intervening newline).
  Chromium renders their text as `Helloworld` and `Hello world`, respectively;
  an explicit-space control also renders `Hello world`. An independent reviewer
  repeated the actual Format/Send and rendered-text checks successfully.
- **Impact:** formatting changes the HTML's displayed content, and the next Send
  transmits that change. The result remains valid HTML; this is a semantic
  whitespace defect distinct from BUG-008's JavaScript/CSS formatting algorithms.
- **Coverage gap:** `test/send/monaco-fallback.test.js:270-348` exercises the
  Format caller but substitutes an identity markup formatter at line 301;
  its format-and-payload assertions at lines 326-337 cover JSON only.
- **Expected:** preserve significant inline HTML whitespace, or leave the body
  unchanged when the formatter cannot safely preserve its meaning.

### BUG-110 — Low — Empty whitelist cards falsely report that all traffic is hidden

- **Status:** Open.
- **Evidence:** changing a list's mode or rendering its empty state displays
  “This whitelist is empty, so it currently hides every request.” without
  considering whether it is enabled or another whitelist matches
  (`src/ui/app.js:13401-13416`). The shared filter correctly ignores disabled
  lists and unions enabled whitelists (`src/traffic/traffic-lists.js:95-114`).
- **Reproduction:** import one traffic record and open an empty whitelist card
  in Settings. With that whitelist disabled, both the REST traffic response
  and renderer retain the record while the expanded card says it hides every
  request. The same contradiction occurs with the empty whitelist enabled
  alongside another enabled whitelist matching the record. A sole enabled
  empty whitelist correctly hides it. All three configurations and the visible
  card text were independently repeated against the production browser/API.
- **Impact:** users receive an incorrect explanation of the current list
  configuration. Filtering itself works correctly; this does not lose traffic.
- **Coverage gap:** `test/settings/default-exclusions.test.js:255-290` checks
  whitelist union behavior, and `test/settings/traffic-lists-concurrency.test.js:289-331`
  checks editing transitions, but neither verifies this empty-state message.
- **Expected:** describe the empty list's own matching behavior accurately, or
  account for its enabled state and the combined whitelist configuration.

### BUG-111 — Medium — PowerShell export changes UTF-8 raw bodies on Windows PowerShell 5.1

- **Status:** Open.
- **Evidence:** the PowerShell exporter passes raw text as a string to
  `Invoke-WebRequest -Body` without selecting its byte encoding; its base64
  branch instead supplies explicit bytes (`src/ui/request-export.js:670-681`).
  Ordinary Send export supplies UTF-8 raw text through
  `getCurrentSendExportRequest()` and `updateSendExportSnippet()`
  (`src/ui/app.js:4243-4303`), with Text defaulting to `text/plain` without a
  charset (`:10212-10214`). PowerShell's default request encoding changed to
  UTF-8 in version 7.4 ([Microsoft documentation](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/invoke-webrequest?view=powershell-7.6)).
- **Reproduction:** generate the production PowerShell snippet for a UTF-8 POST
  body `café ✓` with `Content-Type: text/plain`, then execute it against an
  owned local origin in profile-free Windows PowerShell 5.1.26100.33296. The
  successful POST sends hex `636166e9203f`, replacing the check mark with `?`,
  instead of UTF-8 `636166c3a920e29c93`. The exporter's byte-array branch on
  that same runtime and the raw snippet on PowerShell 7.6.5 both send the
  expected bytes. An independent reviewer repeated all three controls.
  Script transport preserved Unicode; the observed difference is in raw
  request bytes. Browser reachability was checked in source.
- **Impact:** a supported POST export can silently change non-ASCII body data
  on Windows PowerShell 5.1. This is separate from BUG-021's unsupported
  methods and does not affect the tested base64 or PowerShell 7 controls.
- **Coverage gap:** `test/import-export/export-snippet-escaping.test.js:16-66`
  checks literal syntax, and `test/send/request-snippet-bytes.test.js:85-100`
  checks ASCII text inclusion; neither executes a non-ASCII raw body on 5.1.
- **Expected:** encode raw UTF-8 bodies explicitly so generated requests
  preserve their bytes on the supported Windows PowerShell runtime.

### BUG-112 — Medium — Repeated Content-Encoding fields prevent response capture decoding

- **Status:** Open.
- **Evidence:** the streamed and buffered capture helpers pass only the first
  `Content-Encoding` field value to `_safeBodyString()`
  (`src/proxy/proxy-server.js:1224-1252`). The decoder already accepts arrays
  and stacked comma-separated codings (`:11636-11682`), but these callers
  discard the remaining values. Repeated list field lines have the same
  semantics as their ordered comma-separated combination
  ([RFC 9110, sections 5.3 and 8.4](https://datatracker.ietf.org/doc/html/rfc9110#section-5.3)).
- **Reproduction:** serve the same 84-byte gzip-then-Brotli text response
  through the production plain-HTTP proxy using either one
  `Content-Encoding: gzip, br` field or two fields, `Content-Encoding: gzip`
  followed by `Content-Encoding: br`. Both requests return 200 and deliver
  identical, correctly decodable bytes. The combined-field control captures
  the original UTF-8 text with `responseBodyContentDecoded: true`; the
  repeated-field case preserves both header values but captures the compressed
  bytes as a base64 data URI without that flag. An independent reviewer
  repeated the complete origin/proxy exchange and byte/metadata checks.
- **Impact:** valid stacked encoding is not decoded in the captured response,
  so the capture lacks the expected text. Delivered response bytes remain
  intact. This is separate from BUG-062's decompression-size ceiling.
- **Coverage gap:** `test/proxy/core/response-decompression.test.js:73-80`
  checks only the single-field `gzip, br` representation.
- **Expected:** supply all ordered encoding values to the existing decoder
  so equivalent header representations produce equivalent captured content.

### BUG-113 — Low — Multiline WebSocket close reasons hide the separate close-code field

- **Status:** Open.
- **Evidence:** the proxy preserves a Close frame's code and UTF-8 reason in
  `Close code: 1012 - ...` (`src/proxy/proxy-server.js:4896-4901`). The renderer
  reparses that string with an anchored expression whose `.*` cannot span an
  internal newline (`src/ui/app.js:3461-3463`). On failure it omits the separate
  Close Code item and puts the entire serialized description under Reason
  (`:3474-3475`). A reason may contain UTF-8 data, including a line break;
  [RFC 6455 section 5.5.1](https://datatracker.ietf.org/doc/html/rfc6455#section-5.5.1)
  imposes no single-line restriction.
- **Reproduction:** connect a WebSocket client through the proxy to a server
  that closes with code `1012` and reason `Server restart\nTry again`, where
  `\n` is an actual newline. Select the captured server Close frame in View.
  The visible card has only Reason, starting with `Close code: 1012 -`.
  A single-line `Server restart; try again` control instead shows Close Code
  `1012` and the clean reason in separate fields. Two independent runs using
  a real local WebSocket exchange and the shipped browser UI confirmed this.
- **Impact:** the Close Frame card inconsistently labels valid close metadata.
  The code remains readable inside Reason; the received close code/reason and
  captured text are preserved. This is a presentation defect.
- **Coverage gap:** `test/proxy/websocket/websocket-fragmentation.test.js:51-76`
  uses a code-only Close frame and checks parser ordering, without exercising
  the renderer's code/reason split for multiline reasons.
- **Expected:** display the code and complete reason in their respective fields
  for every valid close reason, including one containing a line break.

### BUG-114 — Low — HTTP/2 webhook mocks bypass the security scan's synthetic-response exclusion

- **Status:** Open.
- **Evidence:** HTTP/2 webhook captures set `mockResponseSource: 'upstream'`
  (`src/proxy/proxy-server.js:8640-8646`), while the equivalent HTTP/1 branch
  leaves it unset (`:10995-11005`). Both use `_serveWebhookMock()`, which
  responds locally, discards the webhook endpoint's response body, and records
  an empty synthetic `text/plain` response (`:4025,4061-4068,4082-4094`).
  MCP `security_scan` excludes synthetic mock rows unless that upstream flag
  is present (`src/mcp/mcp-server.js:980-982`).
- **Reproduction:** create a webhook rule, then send equivalent HTTPS POSTs
  with `?token=fixture` over HTTP/1.1 and native HTTP/2. Both clients receive
  an empty 200 response and both webhook deliveries contain the same body and
  forwarded URL. Scan their captured traffic: the HTTP/1 row is excluded,
  while the HTTP/2 row produces an `Exposed Token in URL` issue. Two independent
  runs through the production proxy, traffic ingestion and MCP scan confirmed
  the difference. An owned original HTTPS server received no connection;
  the webhook endpoint's actual HTML response was not relayed or captured.
- **Impact:** response provenance is incorrect and synthetic-mock exclusion
  depends on the ingress protocol. The original URL, including its query,
  intentionally reaches the webhook in `x-forwarded-url`
  (`src/proxy/proxy-server.js:4048-4050`). The demonstrated defect is the
  protocol-dependent scan exclusion.
- **Coverage gap:** `test/mocking/webhook-protocol-parity.test.js:291-318`
  compares delivery, response and capture outcomes without checking response
  provenance or MCP results. `test/mcp/mcp-security-header-case.test.js:87-94,147`
  checks synthetic versus upstream mock exclusion using supplied metadata,
  without exercising the webhook producer.
- **Expected:** give equivalent synthetic webhook responses the same provenance
  and apply the security scan's mock-exclusion policy consistently.

### BUG-115 — Medium — Leading-dash filenames corrupt Wget multipart exports

- **Status:** Open.
- **Evidence:** the Wget multipart generator reads each file with `cat 'filename'`
  (`src/ui/request-export.js:489`), without making a leading-dash filename a
  literal path. Shell quoting does not prevent `cat` from interpreting options.
  The script continues to the Wget invocation after a failed file read
  (`:495-497`). Send retains the selected file's basename
  (`src/ui/app.js:10561-10568`) and passes it through the export snapshot
  (`:4243-4288`).
- **Reproduction:** select an existing multipart file named `-payload.bin` or
  `--version`, export as Wget, and run the generated body assembly from its
  directory. With an 11-byte file, `-payload.bin` produces an empty file part
  after a `cat` option error; `--version` instead inserts 331 bytes of GNU
  coreutils 8.32 version text without an error. The script reaches Wget in both
  cases. An ordinary `payload.bin` and an explicit `./--version` path preserve
  the original 11 bytes. Two independent runs used the production generator
  and real Bash/`cat`, with a Wget boundary spy copying the assembled body file;
  native Wget and network delivery were not exercised.
- **Impact:** the generated multipart body contains missing or substituted file
  content. Wget's `--body-file` sends the contents of the assembled file, so the
  export cannot replay the selected upload correctly.
  [GNU Wget HTTP options](https://www.gnu.org/software/wget/manual/html_node/HTTP-Options.html)
  documents that input contract.
- **Coverage gap:** `test/import-export/multipart-duplicate-fields.test.js:207-224`
  checks Wget snippet marker order with an ordinary filename, without executing
  its file reads or checking leading-dash names.
- **Expected:** read filenames as literal paths and stop body assembly when a
  selected file cannot be read, before invoking Wget with incomplete content.

### BUG-116 — Low — Empty base64 HAR bodies display URI-wrapper bytes in Hex

- **Status:** Open.
- **Evidence:** importing a HAR response with empty `content.text` and
  `encoding: 'base64'` produces `data:application/octet-stream;base64,`
  (`src/ui/har-import.js:226-244`). This is accepted by the API's canonical
  base64 validation (`src/api/api-server.js:57-59,107-112`). The renderer's
  `bodyToBytes()` requires at least one payload character, then falls back to
  encoding the URI text when that match fails (`src/ui/app.js:5043-5057`).
  Hex displays those returned bytes (`:5889-5911`).
- **Reproduction:** import a HAR containing that zero-byte response, select it
  in View, and choose the Response body Hex mode. The stored body size remains
  zero, but Hex displays 37 ASCII bytes beginning `64 61 74 61 3a` (`data:`).
  A `/w==` base64 control correctly displays `ff`; an empty UTF-8 control shows
  no body viewer. Two independent runs used the actual Import HAR button/file
  chooser, production API and visible Hex control, with screenshots checked.
- **Impact:** the byte inspector shows metadata as payload for an empty imported
  binary body. The stored representation and zero size remain intact; this is
  a display defect.
- **Coverage gap:** `test/send/send-binary-response.test.js:83-99` distinguishes
  base64 provenance from literal UTF-8 data-URI text using a nonempty payload,
  without checking the empty base64 case.
- **Expected:** reconstruct zero bytes for an empty base64 payload and display
  an empty Hex view or the normal empty-body state.

### BUG-117 — Medium — Unicode Host and Hostname mock conditions silently miss their destinations

- **Status:** Open.
- **Evidence:** the Host and Hostname editor accepts text without canonicalizing
  the hostname (`src/ui/app.js:8554-8558,8952-8977`). The creation API validates
  and retains those values (`src/api/api-server.js:1628-1646`), but the matching
  engine compares only their lowercased spelling with `new URL(url).host` or
  `.hostname` (`src/proxy/proxy-server.js:10515-10531`). The URL parser converts
  internationalized hostnames to their ASCII form; the condition remains Unicode.
- **Reproduction:** create an enabled fixed-response rule with a Hostname
  condition of `bücher.example`, followed by a different wildcard response.
  A request for `http://bücher.example:8080/owned-idn-control` uses
  `xn--bcher-kva.example` as its canonical hostname and receives the fallback.
  Replacing only the condition with `xn--bcher-kva.example` selects the intended
  response; uppercase ASCII also works. A Host condition of
  `bücher.example:8080` fails in the same way, while its ASCII equivalent works.
  Production API and local proxy controls returned 200 for every rule creation,
  preserved the supplied values, and produced fallback 202 versus intended 201.
  Both responses were fixed mocks, requiring no external DNS or origin access.
  Editor reachability was source-confirmed; these controls did not drive a browser.
- **Impact:** a valid internationalized destination does not activate an accepted
  manually configured mock condition. Users must enter its ASCII spelling.
  [Node's URL documentation](https://github.com/nodejs/node/blob/main/doc/api/url.md#new-urlinput-base)
  describes the hostname conversion underlying the mismatch.
- **Coverage gap:** `test/mocking/derived-rule-hostname.test.js:156-249` checks
  conditions derived from already-canonical captured hostnames, ordinary DNS and
  IPv6, without manually entered internationalized spellings.
- **Expected:** compare internationalized hostname conditions and destinations
  using the same canonical form, preserving Host's port requirement.

### BUG-118 — Medium — Send conflict recovery overwrites edits made while a save is pending

- **Status:** Open.
- **Evidence:** cURL paste replaces the active tab and queues its snapshot for
  persistence (`src/ui/app.js:12552-12592`, `:17280-17295`). Persistence waits for
  the shared workspace lock (`:11383-11387`, `:12064-12090`). When that snapshot
  conflicts with another window's revision, synchronization switches to the
  stored conflict fork and calls `loadSendTabState()` without first preserving
  further editor changes (`:12023-12050`). Loading the older snapshot replaces
  the URL and body controls (`:12439-12456`).
- **Reproduction:** open the same saved Send tab in two browser windows. Hold
  the isolated profile's native Send workspace lock to make the pending-save
  interval deterministic. Paste `curl 'https://remote.test/'` in one window
  and `curl 'https://queued.test/'` in the other before their queued storage
  events run. While persistence waits, change the latter URL to
  `https://later-typing.test/`, then release the lock. With the shipped UI,
  real Web Locks and unsuppressed storage events, the URL reverts to
  `https://queued.test/`; the newer value is absent from both live tabs and
  persisted tabs. A toast says the draft was preserved in a new tab. The
  otherwise identical no-conflict control retains the newer editor text.
  An independent current-source helper probe reproduces the same distinction.
  No request to any example destination is sent.
- **Impact:** continued editing during a contended save can lose newer work
  when another window changed the same tab. The original queued snapshot is
  preserved, but the recovery message obscures the lost edits.
- **Expected:** preserve edits newer than the queued snapshot before switching
  to the conflict fork, or leave the current editor intact until they are
  safely reconciled.
- **Test gap:** `test/send/send-tab-concurrency.test.js:487-529` checks stale
  revisions and a pending journal across a storage event, but does not change
  the editor again between snapshot creation and conflict commit.

## Pass coverage

- Pass 1 covered every production module: API/MCP/startup/settings/traffic,
  all interceptor families, all proxy helpers and the complete proxy-server
  method inventory, renderer helpers and workflows, Electron, scripts and
  packaging. Related test domains, tracked documentation/configuration and
  static assets were reviewed. Three subagents supplied independent domain
  reviews; large protocol handlers were split into explicit source ranges.
- Runtime evidence includes all five renderer routes at widths 1366 and 700,
  real browser edits and file selection, API/MCP round trips, local H1/H2/TLS
  and WebSocket exchanges, and simulated native/device lifecycle failures.
  All 18 checked HTML/bootstrap/vendor/font URLs resolved with correct MIME;
  all 10 tracked PNG files had valid dimensions.
- Pass 2 covered the same entire repository. All 21 backend modules, 17
  interceptor modules, 14 proxy modules, 21 Electron modules, and renderer
  JavaScript were reviewed; the full proxy and renderer monoliths were divided
  into explicit ranges with no gaps. All related test domains were inventoried
  and contracts checked. Scripts, build/CI/dependencies, documentation, assets,
  HTML and styles were rechecked. Browser checks included 48 Settings
  section/theme/width combinations and all 13 mock actions and 21 matcher types
  at the minimum desktop width. Independent ledger review corrected stale
  source references without removing any still-open finding.
- Pass 3 again covered every production domain, supporting scripts/configuration,
  documentation/assets and related test contracts. Explicit renderer ranges
  overlapped at whole function boundaries; all 87 production source/HTML/CSS
  files were included. A cross-reference scan checked 744 renderer function
  declarations; singleton results were already documented or immediately invoked
  initializers. Browser layout checks and all new ordinary-flow probes were
  repeated independently. There were no unresolved candidates at pass completion.

- Pass 4 covered the same complete module inventory and all renderer ranges,
  with overlapping whole-function boundaries. Related test contracts, scripts,
  build/CI/dependencies, documentation/assets, HTML and styles were rechecked.
  New findings were independently reproduced by a different auditor from their
  author. Additional browser checks validated all static inline handlers,
  keyboard tab navigation with reduced motion and certificate-path layout.
  All candidates were resolved before completing the pass.

- Pass 5 again covered every production module and support file. Renderer
  coverage was split at 1-1810, 1798-3076, 3001-6018, 5999-8458,
  8459-10525 and 10486-17313; helper modules and related test contracts were
  included. All HTML and CSS lines were reviewed, with live geometry and
  screenshot checks for the positioning finding. All 27 scripts/configuration/
  documentation/icon files were reviewed; 10 PNGs and all four ICO records
  passed structural checks. Independent reviewers verified every new finding.
  The 2026-09-11 dependency audit still reports the same five affected packages
  recorded under BUG-029. No candidates remained unresolved at pass completion.

- Pass 6 covered all 87 production files and supporting configuration, scripts,
  documentation and assets. Renderer ranges were 1-3076, 2960-8458,
  8459-10525 and 10486-17313; proxy-server.js was split at 9410/9411 with no
  gaps. Every related test domain was mapped and relevant assertion bodies
  checked. All four additions were independently reproduced; other candidates
  were resolved before closing the pass. An independent review checked every
  ledger entry and corrected three citations and one group-operation description.
  The unchanged dependency graph, asset checks and full-suite results remain
  applicable; they were not represented as new test executions.

- Pass 7 freshly traced contracts and callers across the complete 87-file
  inventory and supporting scripts/configuration/docs/assets. Function-group
  matrices covered the complete renderer and proxy monoliths, with the same
  explicit overlapping boundaries as Pass 6. This was a fresh contract review,
  informed by earlier source passes, rather than a repeated literal read of
  every line. All related test domains were mapped and relevant assertions
  reopened. Five functional additions were independently reproduced; the
  unused-parser addition was independently checked for production and dynamic
  callers. All other candidates were resolved before closing the pass.

- Pass 8 freshly reviewed contracts, callers, state transitions and error paths
  across all 87 production files and the complete supporting inventory. Renderer
  coverage was split at 1-3076, 2960-7337, 7340-10525 and 10486-17313;
  the intervening two lines are a blank line and section comment. Proxy coverage
  retained the 9410/9411 split. All related test domains were freshly mapped,
  with focused assertion bodies reopened. Both additions were independently
  verified; JVM compiler/runtime behavior was simulated and its compatibility
  consequence checked against the Java specifications. No candidates remained
  unresolved at pass completion.

- Pass 9 again covered all 87 production files, the complete renderer and proxy
  monoliths, supporting configuration/scripts/docs/assets and related test
  contracts. Three subagents also took supplemental source slices, with
  overlapping renderer boundaries and full proxy coverage reconciled before
  closure. All five additions were independently verified. The JVM client-key
  probe ran the unchanged generated agent inside its own disposable Java process;
  it did not attach to an existing application. System Proxy native behavior was
  simulated. Other candidates were resolved before completing the pass.

- Pass 10 freshly reviewed every production module, both complete monoliths,
  all HTML/CSS sections and the supporting inventory. All 444 tracked test files
  were mapped to current contract reviews, with focused assertion bodies,
  shared fixtures and the meta check reopened. Both additions were independently
  reproduced and their final descriptions peer-reviewed. All candidates were
  resolved before closing the pass; the two additions reset the clean streak.

- Pass 11 freshly reviewed all 87 production files, the complete renderer and
  proxy monoliths, every HTML/CSS section, and the supporting inventory. All 444
  tracked test files were mapped to current contract reviews, with focused
  assertions and shared fixtures reopened. The four additions were independently
  verified and their final descriptions peer-reviewed. Native terminal launch
  was simulated; only disposable Node children received the prepared environment.
  All candidates were resolved before closing the pass.

- Pass 12 freshly reviewed every production module and renderer/proxy function
  group, all HTML/CSS sections, the complete support inventory and all 444 test
  files' contracts with focused assertions. Shared fixtures and meta checks were
  reopened. The manual Electron command and matcher-textarea additions were
  independently verified. All candidates and transferred review scopes were
  resolved before closing the pass; the two additions reset the clean streak.

- Pass 13 freshly reviewed all 87 production files, every renderer/proxy function
  group, all HTML/CSS, the complete support inventory and all 444 test files'
  contracts with focused assertions. Meta and both shared fixtures were reopened.
  The macOS terminal-command and stale mock-group display findings were independently
  verified; native macOS execution was simulated and its consequence source-derived.
  All candidates and transferred scopes were resolved before closure. The fresh
  2026-09-12 dependency audit still reports the same five affected packages in
  BUG-029. The two additions reset the clean streak.

- Pass 14 freshly reviewed all 87 production files, both complete monoliths,
  all HTML/CSS and generated-control contracts, the 27 support entries and all
  444 tracked test files' contracts with focused assertions. Meta and both
  shared fixtures were reopened. The cURL quoting finding was independently
  reproduced against an owned local origin using profile-free Bash/cURL and
  the production browser paste/Send flow. All candidates were resolved before
  closure. The one addition reset the clean streak.

- Pass 15 freshly reviewed all 87 production files, both complete monoliths,
  all HTML/CSS and generated controls, the 27 support entries and all 444
  tracked test files' contracts with focused assertions. Meta and both shared
  fixtures were reopened. The HTML formatting, empty-whitelist wording and
  Windows PowerShell raw-body findings were independently verified, and their
  final descriptions peer-reviewed. All candidates were resolved before closure.
  The three additions reset the clean streak.

- Pass 16 freshly reviewed all 87 production files, both complete monoliths,
  all HTML/CSS and generated controls, the 27 support entries and all 444
  tracked test files' contracts with focused assertions. Meta and both shared
  fixtures were reopened. A supplemental reviewer checked three complete proxy
  concurrency/lifecycle test files against their callers. The repeated-encoding
  capture finding was independently reproduced and its final wording checked.
  All candidates and supplemental scopes were resolved before closure. The one
  addition reset the clean streak.

- Pass 17 freshly reviewed all 87 production files, both complete monoliths,
  all HTML/CSS and generated controls, the 27 support entries and all 444
  tracked test files' contracts with focused assertions. Meta and both shared
  fixtures were reopened. The WebSocket Close-card presentation and HTTP/2
  webhook provenance findings were independently reproduced and their final
  wording checked. An additional source reviewer checked the webhook/MCP
  boundary, and a supplemental ledger review checked consistency. All
  candidates and scopes were resolved before closure. The two additions reset
  the clean streak.

- Pass 18 freshly reviewed all 87 production files, both complete monoliths,
  all HTML/CSS and generated controls, the 27 support entries and all 444
  tracked test files' contracts with focused assertions. Meta and both shared
  fixtures were reopened. Wget multipart assembly was independently reproduced
  using real Bash/cat and a Wget call-boundary spy; native Wget and network
  delivery were not executed. Empty binary HAR Hex rendering was independently
  reproduced through actual browser imports. Both descriptions passed wording
  review, and all candidates were resolved before closure. The 2026-09-13
  dependency audit reports the same five affected packages under BUG-029,
  with unchanged advisory details. The two additions reset the clean streak.

- Pass 19 freshly reviewed all 87 production files, both complete monoliths,
  all HTML/CSS and generated controls, the 27 support entries and all 444
  tracked test files' contracts with focused assertions. Meta and both shared
  fixtures were reopened. Root took the proxy tail at 9411-12507 during the pass;
  the source transfer was fully reconciled before closure. The internationalized
  mock-condition finding was independently reproduced with production API and
  local HTTP proxy controls, and its wording peer-reviewed. No external DNS or
  origin access was needed. All candidates were resolved before closure. The
  one addition reset the clean streak.

- Pass 20 freshly reviewed all 87 production files, both complete monoliths,
  all HTML/CSS and generated controls, the 27 support entries and all 444
  tracked test files' contracts with focused assertions. Meta and both shared
  fixtures were reopened. Support and final generated-control scope transfers
  were reconciled before closure. The Send conflict finding was independently
  reproduced with current-source helpers and the shipped UI in two browser
  windows, using native Web Locks and a no-conflict control. The final wording
  passed independent review. All candidates were resolved before closure. The
  one addition reset the clean streak.

- Pass 21 freshly reviewed all 87 production files, both complete monolith
  function-group scopes, all HTML/CSS and generated controls, the 27 support
  entries and all 444 tracked test files' contracts with focused assertions.
  Meta and both shared fixtures were reopened. Generated-control and import/export
  transfers were completed and independently reconciled before closure. All
  candidates were resolved; there were no new findings. This is the first
  consecutive clean pass. Unchanged binary, runtime and dependency evidence was
  retained without claiming new execution.

- Pass 22 freshly reviewed all 87 production files, both complete monolith
  function-group scopes, all HTML/CSS and generated controls, the 27 support
  entries and all 444 tracked test files' contracts with focused assertions.
  Meta and both shared fixtures were reopened. All assigned scopes and shared
  markup/import/export coverage were reconciled, including independent report
  consistency review. All candidates were resolved; there were no new findings.
  This is the second consecutive clean pass. The final two passes used current
  source and assertion review, with complete small-module and interacting-body
  reads alongside systematic branch/caller views; they do not claim every test
  body or ordinary monolith assignment was reread. Unchanged binary, runtime
  and dependency evidence was retained without claiming fresh execution.

## Original audit validation notes

- Repository-pinned runtime: Node.js 26.7.0.
- Current serialized full suite: 2,470 tests; 2,466 passed; 0 failed;
  4 intentional environment skips.
- Syntax checks passed for all 532 tracked JavaScript/CommonJS files.
- Final documentation validation uses `node --test test/meta/test-layout.test.js`
  with the repository-pinned runtime, plus ledger ID/status, source-reference
  and Git whitespace checks. The final source-reference check covers 417 spans.
- The 2026-09-13 dependency audit exits 1 with five affected packages
  (three high, two moderate), documented in BUG-029. Its advisory details are
  unchanged from the previous check; this remains an open finding.
- Browser probes load the shipped UI and vendor assets against an isolated API
  and proxy. Native process/device behavior is simulated for destructive or
  platform-specific lifecycle cases; no real interceptor settings are changed.
- Audit probes and raw logs are local ignored artifacts under
  `data/audit-20260907/`; each finding above includes its reproduction without
  requiring those artifacts.
