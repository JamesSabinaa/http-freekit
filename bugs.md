# Bug audit

Fresh repository-wide audit of `main` at `a386e4b`. The previous ledger was independently verified as fixed and cleared before this audit began.

## Prior-ledger verification

All 13 findings in the previous `bugs.md` (BUG-424 through BUG-436) are fixed on the audited revision. Their cited fix commits (`13bc3c6`, `aa84ec2`, `5a3df3e`, `5ee8dec`, and `0135c57`) are ancestors of `HEAD`; the original source paths were inspected, and a focused 16-file regression run passed 159/159 tests. Independent checks also passed the BUG-424 delayed-child-exit reproduction 5/5 times, the combined BUG-425 through BUG-432 checks 53/53, and the BUG-433 through BUG-436 source/runtime checks. The resolved entries were intentionally removed rather than carried into this fresh ledger.

## Current status

This audit has **91 open findings**: 1 high, 23 medium, 28 low/medium, and 39 low.

## Audit completion gate

Completion requires two consecutive complete passes with no new findings. A complete pass covers startup/settings, API and MCP, proxy protocols and mocking, certificates, interceptors, Electron and packaging, UI behavior/styling/accessibility, dependencies, documentation, tests, and dead code.

| Pass | Result | Clean-pass streak |
| --- | --- | ---: |
| 1 | 16 new findings confirmed and independently reviewed | 0/2 |
| 2 | 11 new findings confirmed and independently reviewed; static-only | 0/2 |
| 3 | 6 new findings confirmed and independently reviewed; static-only | 0/2 |
| 4 | 9 new findings confirmed and independently reviewed; static-only | 0/2 |
| 5 | 12 new findings confirmed and independently reviewed; static-only | 0/2 |
| 6 | 6 new findings confirmed and independently reviewed; static-only | 0/2 |
| 7 | 7 new findings confirmed and independently reviewed; static-only | 0/2 |
| 8 | 3 new findings confirmed and independently reviewed; static-only | 0/2 |
| 9 | 5 new findings confirmed and independently reviewed; static-only | 0/2 |
| 10 | 8 new findings confirmed and independently reviewed; static-only | 0/2 |
| 11 | 8 new findings confirmed and independently reviewed; static-only | 0/2 |
| 12 | 6 new findings confirmed and independently reviewed; static-only | 0/2 |
| 13 | 3 new findings confirmed and independently reviewed; static-only | 0/2 |
| 14 | 13 new findings confirmed and independently reviewed; static-only | 0/2 |
| 15 | 10 new findings confirmed and independently reviewed; static-only | 0/2 |
| 16 | 6 new findings confirmed and independently reviewed; static-only | 0/2 |
| 17 | 2 new findings confirmed and independently reviewed; static-only | 0/2 |
| 18 | 1 new finding confirmed and independently reviewed; static-only | 0/2 |
| 19 | 2 new findings confirmed and independently reviewed; static-only | 0/2 |
| 20 | No new findings; complete static-only pass | 1/2 |
| 21 | 3 new findings confirmed and independently reviewed; static-only | 0/2 |
| 22 | No new findings; complete static-only pass | 1/2 |
| 23 | 4 new findings confirmed and independently reviewed; static-only | 0/2 |
| 24 | 3 new findings confirmed and independently reviewed; static-only | 0/2 |
| 25 | 1 new finding confirmed and independently reviewed; static-only | 0/2 |
| 26 | 1 new finding confirmed and independently reviewed; static-only | 0/2 |
| 27 | 4 new findings confirmed and independently reviewed; static-only | 0/2 |
| 28 | No new findings; complete static-only pass | 1/2 |
| 29 | 2 new findings confirmed and independently reviewed; static-only | 0/2 |
| 30 | 3 new findings confirmed and independently reviewed; static-only | 0/2 |
| 31 | 3 new findings confirmed and independently reviewed; static-only | 0/2 |
| 32 | 2 new findings confirmed and independently reviewed; static-only | 0/2 |
| 33 | 2 new findings confirmed and independently reviewed; static-only | 0/2 |
| 34 | 1 new finding confirmed and independently reviewed; static-only | 0/2 |
| 35 | 1 new finding confirmed and independently reviewed; static-only | 0/2 |
| 36 | No new findings; complete static-only pass | 1/2 |
| 37 | No new findings; complete static-only pass | 2/2 |

## Desktop packaging and interceptors

### BUG-437 — High — One macOS architecture receives a host-architecture Node backend

- Status: **Open**.
- Evidence: one `build:mac` invocation targets both x64 and arm64 DMG/ZIP artifacts (`package.json:17`; `electron-builder.config.cjs:71-75`), but the direct `node@26.7.0` dependency installs one binary selected from the install host's `process.platform` and `process.arch` (`package.json:30`; `package-lock.json:3558-3568`; `node_modules/node-bin-setup/index.js:5-33`). Packaging disables dependency rebuilds and unpacks that same dependency into every target (`electron-builder.config.cjs:109-120`). Every packaged app then executes `node_modules/node/bin/node` (`electron/asar-path.cjs:29-43`; `electron/main.cjs:93-95`). There is no per-target architecture staging hook.
- Impact: on an arm64 build host the Intel artifact contains an arm64 backend and cannot start on Intel Macs; on an Intel host the arm64 artifact contains x64 Node and depends on Rosetta. The Electron shell can be the advertised architecture while the proxy/API backend fails to start.
- Reproduction: build both macOS targets from either architecture and inspect `Contents/Resources/app.asar.unpacked/node_modules/node/bin/node` in both applications with `file`; both copies come from the build host instead of reporting one x86_64 and one arm64 binary. Existing packaging coverage checks target labels, not the embedded Mach-O architecture (`test/desktop/mac-updater-artifacts.test.js:8-12`).
- Expected: stage a matching standalone Node executable independently for each target architecture and assert the packaged binary architecture.



## Proxy, API, and tests




## UI, accessibility, and styling

### BUG-453 — Medium — Generated controls are mouse-only and rerenders discard focus

- Status: **Open**.
- Evidence: WebSocket expansion is a nonfocusable clickable `span` and its row has `tabindex="-1"` (`src/ui/app.js:1815-1827`); stream-message selection is a clickable `div` (`:3163-3192`); URL breakdown is a clickable `div` (`:3392-3399`); header documentation toggles are clickable `span` elements (`:3935-3953`); and mock-rule/group/detail-card disclosure is click-only (`:2736,7342,7353,7427-7436`). Separately, Send field-type/header changes replace the focused controls through `innerHTML` (`:9718-9743,9769-9777,9908-9915,9950-9953`), as do mock action/mode changes (`:8422-8496,9392-9395`), with no focus restoration.
- Impact: keyboard and switch-device users cannot activate major detail interactions, and keyboard users are unexpectedly thrown out of Send/mock forms when changing a control that rerenders its container.
- Expected: use native buttons or complete keyboard semantics for disclosures, and restore focus to the corresponding control after intentional rerenders.

### BUG-454 — Medium — Generated form controls and actions lack usable accessible names

- Status: **Open**.
- Evidence: icon-only mock-header removal buttons have no text, title, or `aria-label` (`src/ui/app.js:7973,8039,8100,8181,8551,8609,9385`). Settings-list removals expose only `x`/`×`, with no item context, for TLS passthrough, client certificates, trusted CAs, HTTPS whitelist, and API specs (`:12235,12346,12459,12521,12667`). Numerous generated selects, checkboxes, and inputs also have no associated `<label>`, `aria-label`, or `aria-labelledby`, including traffic/API detail and mock editors (`:3352,3417-3420,3477-3480,3669,7788-7793,7820-7880,8333-8361,9718-9741,9908-9913`; `src/ui/index.html:333-334`). Visible neighboring text is often a closed label or plain div, not a programmatic name. The accessibility regression scans static `index.html`, not generated controls (`test/ui/control-accessible-names.test.js:98-123`).
- Impact: screen-reader users encounter unnamed fields and buttons or several indistinguishable actions all announced as “x”.
- Expected: associate every generated field with its visible label and give every action a contextual accessible name such as “Remove trusted CA <path>” or “Remove response header”.


## Additional pass-3 findings

## Dead code and dependencies

### BUG-468 — Low — Backend/interceptor compatibility paths and state have no production consumer

- Status: **Open**.
- Evidence: `ApiServer._transferTrafficGeneration()` is declaration-only (`src/api/api-server.js:2757-2763`) and live paths call `_ensureTrafficGeneration()` directly (`:2765-2783`). `ProxyServer._normalizeNoProxyEntries()` is declaration-only (`src/proxy/proxy-server.js:2758-2760`) while production uses the module helper (`src/proxy/upstream-proxy-config.js:91`). `matchesDefaultExclusion()` is test-only and `filterDefaultExclusions()` has no consumer (`src/traffic/default-exclusions.js:205-212`). Every product caller also excludes breakpoint actions before entering the terminal H1/H2 mock engines (`src/proxy/proxy-server.js:4464-4492,5237-5253,6219-6240,6666-6685`), leaving their older breakpoint branches unreachable (`:7380-7483,9661-9873`); a test directly invokes one dead H2 branch (`test/mocking/breakpoint-validation.test.js:180-215`). Interceptor state is likewise write/reset-only: System Proxy `activeWinHttpSettings` (`src/interceptors/system-proxy-interceptor.js:21,546,618,706,737,797`), Existing Terminal `proxyPort` (`src/interceptors/terminal-interceptors.js:1272,1284,1307`), and JVM's selection-only `active = true`, which the manager immediately replaces from `isActive()` (`src/interceptors/jvm-interceptor.js:325-328,628-658,1380-1395`).
- Impact: misleading alternate APIs, unreachable protocol implementations, tests for dead branches, and write-only state increase maintenance surface without exercising live behavior.
- Expected: remove the wrappers, unreachable breakpoint engines, and unused state; migrate tests to production primitives and live routing paths.

### BUG-469 — Low — Renderer helpers, constants, and legacy stylesheet blocks are orphaned

- Status: **Open**.
- Evidence: production cross-reference finds declaration-only `contentTypeToMonacoLanguage()` (`src/ui/app.js:4083-4094`), `toggleHexView()` (`:5229-5241`), deprecated no-ops `updateSendBodyPreview()`/`toggleSendBodyView()` (`:9598-9602`), and `tryPrettyJson()` (`:13486-13492`). `loadSendHeadersFromJson()` (`:9975-9983`) is used only by test harnesses. `mockBadgeCount` and `manualProxyPort` are queried but no such elements exist in product markup (`:7495-7497,11163-11174`); the latter exists only in a test stub (`test/settings/port-config-renderer.test.js:121,165`). Unused locals/constants include `methodColor` (`src/ui/app.js:2910`), `perspectiveLabels` (`:3338-3343`), `INTERCEPTOR_COLORS` (`:5310-5324`), and `MOCK_MATCHER_TYPES` (`:6708`). Orphan CSS includes the removed top bar (`src/ui/styles.css:481-543`), old detail tabs/sections and headers table (`:1213-1256,1320-1346`), legacy panel/mock-form selectors (`:2213-2267`), `.settings-section` (`:2441`), the old Send form/response (`:2781-2836`), and removed footer children (`:2938-2942`).
- Impact: stale renderer bundle/CSS and test-only pseudo-APIs obscure the live UI paths and make refactors harder to verify.
- Expected: remove the orphan declarations and CSS, and rewrite tests around current production entry points.

## Additional pass-4 findings

### BUG-472 — Low/Medium — Failed macOS terminal adoption can orphan a proxy-configured shell

- Status: **Open**.
- Evidence: the POSIX launch command writes `$$`, exports the proxy and CA environment, and immediately execs a login shell with no acknowledgement or abort handshake (`src/interceptors/terminal-interceptors.js:889-896`). macOS launches it through short-lived `osascript` (`:1065-1071`). If `_adoptSession(shellPid)` cannot verify identity, failure cleanup stops only the launcher handle (`:1096-1111`; `_stopLauncherProcess()` at `:791-823`), never the reported shell. The regression deliberately asserts that an unverified shell PID is not signalled (`test/interceptors/terminal/terminal-restart-ownership.test.js:402-430`), but models a still-killable launcher rather than an exited `osascript` with an independent Terminal shell.
- Impact: activation can report failure and retain no journal or active state while a live Terminal window continues using FreeKit's proxy and trust environment; Stop and restart then have no ownership record with which to clean it up.
- Expected: make the POSIX shell wait for a nonce-bound acknowledgement before entering the interactive session and self-terminate on rejection/timeout, analogous to the Windows handshake.


### BUG-474 — Medium — Direct WebSocket upgrades cannot connect to IPv6 origins

- Status: **Open**.
- Evidence: `_handleHttpUpgrade()` passes bracketed WHATWG `targetUrl.hostname` directly to `http(s).request()` (`src/proxy/proxy-server.js:3859,3884-3888`). The class explicitly documents that socket APIs require brackets to be removed and supplies `_normalizeConnectionHostname()` (`:2762-2767,4944-4947`); normal H1/H2 forwarding applies it (`:1204,1860`), while the WebSocket path normalizes only when replacing the destination with a plain upstream proxy (`:3911`). WebSocket coverage has no IPv6 origin case.
- Impact: direct `ws://[IPv6]` and `wss://[IPv6]` upgrades fail hostname lookup/connection and are captured as 502 even though ordinary HTTP traffic to the same origin is supported.
- Expected: pass the normalized connection hostname to direct HTTP(S) request and TLS options while preserving brackets only in URL/authority text, with direct WS and WSS IPv6 regressions.

### BUG-478 — Low — Upstream-proxy settings misparse IPv6 and malformed ports

- Status: **Open**.
- Evidence: the renderer always treats the last colon as a port delimiter and uses permissive `parseInt()` (`src/ui/app.js:11940-11955`). Thus `[2001:db8::1]` without a port becomes host `[2001:db8:` with port 1, a bare `2001:db8::1` is similarly split, and `proxy.example:8080junk` silently becomes port 8080. Backend normalization accepts bracketed/bare IPv6 and supplies type defaults when the port is omitted (`src/proxy/upstream-proxy-config.js:37-53,71-80`), with backend regressions but no renderer parser coverage (`test/proxy/upstream/upstream-config-validation.test.js:56-63,170-188`; `test/settings/upstream-system-settings.test.js:55-110`).
- Impact: backend-supported default-port IPv6 proxies cannot be configured from the settings UI, while typoed ports can silently select a different endpoint.
- Expected: parse an explicit URI or a bracket-aware host/port grammar, require the entire port token to be decimal and in range, and reuse backend defaults when no port is present.

## Additional pass-5 findings

### BUG-484 — Low/Medium — Failed TLS tunnels are displayed as successful HTTP 200 exchanges

- Status: **Open**.
- Evidence: failed passthrough/CONNECT setup is captured with status 502 and error metadata (`src/proxy/proxy-server.js:4960-4981,5004-5008`). The renderer's tunnel row nevertheless hardcodes `status-2xx` and `200`, and its tunnel detail uses a generic success-oriented representation rather than the captured failure (`src/ui/app.js:1764-1783,3244-3298`). Existing tunnel detail coverage checks port presentation, not failed status/error rendering (`test/traffic/detail-header-arrays.test.js:424-444`).
- Impact: an upstream connection or TLS-passthrough failure appears as a green success in the traffic list and does not expose the useful captured diagnosis in detail.
- Expected: render the captured tunnel status, status class, message, and error metadata, reserving the synthetic 200 presentation for successful CONNECT establishment only.

### BUG-486 — Low — Generated Node.js requests use bracketed IPv6 socket hostnames

- Status: **Open**.
- Evidence: the multipart and raw Node exporters pass WHATWG `target.hostname` directly to `http(s).request()` (`src/ui/request-export.js:344-351,559-567`). For an IPv6 URL that hostname retains brackets, while the proxy implementation explicitly strips brackets before using Node's socket API (`src/proxy/proxy-server.js:4944-4947`). Export coverage contains no IPv6 origin.
- Impact: Node snippets generated for IPv6 requests fail hostname lookup or connection instead of replaying the request.
- Expected: remove URL brackets for the Node request option while retaining them in URL and Host/authority text, and add raw and multipart IPv6 regressions.


### BUG-488 — Low/Medium — Upstream auto-rotation cannot recover WebSocket or passthrough CONNECT handshakes

- Status: **Open**.
- Evidence: a WebSocket upgrade creates one upstream request and handles upgrade, rejection, and error directly without the response/error retry helpers used by ordinary safe requests (`src/proxy/proxy-server.js:3980-4219`, compared with `:518-601`). Its completed traffic update can make the API rotate afterward (`src/api/api-server.js:753-800,3432-3553`), but the original safe GET handshake has already failed and is never replayed. In the passthrough CONNECT path, an upstream proxy's non-200 response becomes an untyped error containing text such as `returned HTTP 410`, then a downstream 502 (`src/proxy/proxy-server.js:4944-5008,8950-8965`). The completion detector recognizes status 410 and selected codes/messages, but not that CONNECT error text (`src/api/api-server.js:871-884`). The settings control makes an unqualified promise to auto-rotate on 410, timeout, or connection failure (`src/ui/index.html:510-513`).
- Impact: a WebSocket client receives a failed handshake even when a replacement proxy is obtained, and a 410 from an upstream proxy during passthrough CONNECT may neither retry nor rotate at all.
- Expected: give safe WebSocket handshakes the same bounded transparent retry path as other GET requests, preserve CONNECT response status/error typing, and apply the configured rotation policy consistently before returning failure downstream.

## Additional pass-6 findings

### BUG-496 — Low — IPv6-literal mock webhooks cannot be delivered

- Status: **Open**.
- Evidence: webhook validation requires only a nonempty URL (`src/proxy/mock-rule-validation.js:254-261`). `_serveWebhookMock()` parses it and passes bracketed WHATWG `webhookTarget.hostname` directly to `http(s).request()` (`src/proxy/proxy-server.js:3567-3587`), despite the class's bracket-removal helper (`:2762-2766`). Existing webhook tests use only IPv4 loopback targets.
- Impact: a valid endpoint such as `http://[::1]:PORT/hook` responds to the intercepted request but records a delivery failure instead of invoking the webhook.
- Expected: use the normalized connection hostname for the socket request while retaining brackets in URL and authority text.

## Additional pass-7 findings

### BUG-497 — Low — Malformed desktop preferences are overwritten by the next save

- Status: **Open**.
- Evidence: `DesktopPreferences._load()` catches every read, parse, or schema failure for an existing file, logs it, and substitutes `{}` without retaining an error state (`electron/desktop-preferences.cjs:29-40`). `setCloseWindowBehavior()` then spreads that fallback and atomically renames the new JSON over the original (`:48-66`). Normal desktop startup always constructs this store (`electron/main.cjs:656-660`). The malformed-file test checks fallback/logging but not preservation after a subsequent save (`test/desktop/desktop-close-behavior.test.js:50-68`).
- Impact: changing the close behavior after a malformed or transiently unreadable `desktop-preferences.json` destroys the original preference and its diagnostic/recovery evidence without warning; future preferences in the same object would also be lost.
- Expected: retain an explicit failed-load state and reject ordinary overwrite, or quarantine/preserve the source before an intentional recovery write.

### BUG-498 — Low — Query, form, and cookie matchers lose repeated-name values

- Status: **Open**.
- Evidence: query matching obtains `URL.searchParams` and compares only `params.get(name)` (`src/proxy/proxy-server.js:9237-9244`); URL-encoded form matching does the same with `new URLSearchParams(body)` (`:9303-9310`). `get()` returns the first occurrence. Cookie matching instead stores pairs in a `Map`, so a later same-name cookie overwrites every earlier value (`:9290-9301`). Repeated headers are matched against every value (`:9227-9235`), and multipart matching iterates all same-name parts (`:9312-9332`). Matcher regressions cover repeated headers/multipart and ordinary cookies, but not duplicate query, form, or cookie names (`test/mocking/matcher-correctness.test.js:36-168`; `test/mocking/cookie-matcher-own-keys.test.js:52-116`).
- Impact: `?tag=first&tag=match` and `tag=first&tag=match` unexpectedly miss a rule for `tag=match`; legitimate same-name cookies from different Path/Domain scopes can match only the last value. Traffic consequently passes through or reaches the wrong mock/breakpoint.
- Expected: preserve presence semantics but compare a specified matcher value against every occurrence, using `getAll(name)` for URL parameters and a multi-value cookie representation.

### BUG-499 — Low — MCP literal searches become a different filter in the renderer

- Status: **Open**.
- Evidence: MCP evaluates `query` as one literal case-insensitive substring across a fixed set of fields (`src/mcp/mcp-server.js:625-636`), but appends the raw text to a space-delimited filter string while promising the UI shows those results (`:657-670`; tool contract at `:404-405`). The renderer parses whitespace as separate AND terms and reinterprets `word:value` as structured syntax over a different set of fields (`src/ui/app.js:1516-1533,1554-1610`), then immediately applies the broadcast (`:1319-1333`).
- Impact: `hello world` is one phrase to MCP but two terms in the UI, while `host:other.test` is literal text to MCP but a host predicate in the renderer; the returned result set and visible rows diverge.
- Expected: broadcast structured filter data evaluated by the same predicate, or define lossless quoting/escaping and align the searched fields on both sides.

### BUG-500 — Medium — Send tabs cannot issue the advertised parallel requests

- Status: **Open**.
- Evidence: the product promises “Multiple tabs for parallel requests” (`README.md:19`), but Send owns one global abort controller (`src/ui/app.js:159-163`) and every invocation silently returns while it exists (`:10969-10970`). Loading and Abort controls are also global (`:10879-10896,11093-11105`), and tab switching has no per-tab in-flight state (`:10806-10813`). Completion is already associated with the initiating tab (`:11017-11038`), showing the rest of the design is tab-aware. Single-flight coverage repeats a request in one context, while background-response coverage switches tabs but never sends from the second (`test/send/send-single-flight.test.js:57-75`; `test/send/send-tab-response.test.js:100-117`).
- Impact: Send or Ctrl+Enter in every other tab does nothing while one request is active, and Abort from another tab cancels the first tab's request.
- Expected: maintain controller/loading/abort state per tab and reject only a duplicate send from the same tab.

### BUG-501 — Low/Medium — Fetch and Go multipart exports discard captured file MIME types

- Status: **Open**.
- Evidence: cURL, Python, Node, PowerShell, wget, and PHP exporters consume `field.file.type || field.fileType` (`src/ui/request-export.js:235-283,322-442`). Fetch appends the newly selected `File` with only the captured filename and never uses the captured MIME type (`:287-318`). Go uses `writer.CreateFormFile()` and likewise never reads `fileType` (`:446-464`), so it emits the helper's generic part type. Fetch tests use typeless stubs and assert only names/order; cross-format coverage checks marker ordering rather than part MIME (`test/import-export/fetch-multipart-files.test.js:53-89`; `test/import-export/multipart-duplicate-fields.test.js:207-223`).
- Impact: replay can change an image, PDF, or vendor-specific multipart part to a different media type and fail server validation or routing.
- Expected: explicitly reproduce the captured part `Content-Type`, or declare exact replay unavailable when the target API cannot do so safely.

### BUG-502 — Low/Medium — Editing a repeated mock header flattens it into one field

- Status: **Open**.
- Evidence: Create Mock deliberately clones repeated response values as arrays, and API/replay coverage preserves separate `Set-Cookie` fields (`src/ui/app.js:13311-13323`; `test/mocking/create-mock-repeated-headers.test.js:132-180`). The editor stringifies an array into one text input for fixed and transform actions (`src/ui/app.js:7967-7973,8034-8039,8095-8100`). Changing it replaces the array with one scalar string (`:8500-8517,9329-9347`).
- Impact: editing a repeated header such as `Set-Cookie` silently converts distinct fields into one comma-delimited value, changing HTTP semantics.
- Expected: render one editable value per array element and preserve arrays through save, or prevent scalar editing with a clear repeated-field workflow.

### BUG-503 — Low — Traffic search cannot find WebSocket frame payloads

- Status: **Open**.
- Evidence: `applyFilter()` excludes every `ws-frame` before invoking the normal filter predicate (`src/ui/app.js:1471-1488`). Expanded frames are inserted afterward, without individual filtering, only when their parent connection matched (`:1502-1510`). Both `body:` and plain search otherwise inspect request/response bodies (`:1576-1620`), while the product advertises body search and individually displayed WebSocket frames (`README.md:13,190`).
- Impact: a unique message payload cannot locate its WebSocket exchange, and if the parent happens to match, all frames appear regardless of their payload.
- Expected: match frame bodies while retaining their parent grouping, and add matching/nonmatching expanded-frame search coverage.

## Additional pass-8 findings

### BUG-504 — Low/Medium — Rule routing and method filters collapse case-sensitive extension methods

- Status: **Open**.
- Evidence: HTTP method tokens are case-sensitive, and the proxy deliberately preserves custom tokens through `_requestWithExactMethod()` (`src/proxy/proxy-server.js:464-475`); coverage proves a body-bearing `gEt` is forwarded unchanged and treated separately from GET (`test/send/custom-methods.test.js:315-397`). Modern method matchers uppercase both sides (`src/proxy/proxy-server.js:9193-9197`), as do legacy rules and the streaming eligibility precheck (`:1150-1159,9166-9168`). Structured method filters repeat the collapse in the renderer, REST Traffic search, MCP search, and MCP HAR export (`src/ui/app.js:1576-1581`; `src/api/routes/traffic-routes.js:207-211`; `src/mcp/mcp-server.js:603-611,1001-1005`).
- Impact: a GET mock or breakpoint can intercept the distinct `gEt` extension method and serve, close, webhook, or pause it instead of forwarding; filtering/export then hides that routing distinction during diagnosis.
- Expected: compare exact method tokens everywhere a specific method is selected, retaining `*` as the sole matcher wildcard. This is distinct from BUG-445's replay-eligibility defect.


### BUG-506 — Low/Medium — Stale WinINet recovery can overwrite a newer proxy configuration

- Status: **Open**.
- Evidence: `_settingsCouldBelongToRecovery()` accepts a snapshot whenever each of `enabled`, `server`, and `override` independently equals either its pre-FreeKit or FreeKit-owned value (`src/interceptors/system-proxy-interceptor.js:422-435`). Startup trusts that Cartesian-product predicate and restores the saved configuration (`:490-506`). Activation writes Enable, Server, Override in that order (`:700-703`); restoration writes Server, Override, Enable (`:572-588`), so many accepted mixtures are impossible products of either transition. For example, previous `{enabled:false,server:'old',override:null}`, owned `{enabled:true,server:'127.0.0.1:8080',override:''}`, and current `{enabled:false,server:'127.0.0.1:8080',override:''}` passes even though FreeKit cannot create it. The class already uses an exact reachable-prefix predicate for restoration retry (`:438-461`). Existing tests cover one real activation prefix and one wholly external value, not an impossible old/owned mix (`test/interceptors/system-proxy/system-proxy-override.test.js:246-323`).
- Impact: after a crash, disabling or reconfiguring the proxy in another tool can be misclassified as FreeKit-owned, and the next launch overwrites that newer state with stale saved values.
- Expected: recognize only the finite states reachable under the documented activation/restoration write order and fail closed on every other mixture.

## Additional pass-9 findings

### BUG-507 — Low/Medium — Electron interception reports success before the launched app proves stable

- Status: **Open**.
- Evidence: `_spawnConfirmed()` resolves on the child process's bare `spawn` event (`src/interceptors/electron-interceptor.js:460-480`). Activation then records ownership, marks the interceptor active, and returns success as soon as the optional identity lookup completes (`:603-648`); the renderer immediately toasts “Electron application launched” (`src/ui/app.js:5823-5840`). Tests require only a spawn event for success and cover an exit in the same microtask, but not a child that exits just after activation resolves (`test/interceptors/electron/electron-spawn-confirmation.test.js:39-61`; `test/interceptors/electron/electron-restart-ownership.test.js:300-330`). Browser interception already waits through a bounded 500 ms stability window (`src/interceptors/browser-interceptor.js:44,81-85`).
- Impact: a single-instance Electron application's new process can spawn and then exit because its already-running unproxied instance owns the lock; FreeKit reports a successful intercepted launch even though no intercepted application survives.
- Expected: require a bounded post-spawn stability period and, where possible, verify or adopt the surviving application process before returning success.





## Additional pass-10 findings

### BUG-512 — Low/Medium — Generic Linux update feeds are presented as package download pages

- Status: **Open**.
- Evidence: when release notes are not themselves a web URL, Linux update prompting falls back to `configuredFeedUrl` verbatim for every non-GitHub provider (`electron/updater.cjs:125-164`). That same `UPDATE_URL` value is updater metadata passed to `autoUpdater.setFeedURL()` (`:425-441`), but the native prompt promises a release page and opens the fallback URL (`:341-355`). The production-shaped regression supplies `https://updates.example.test/linux/latest.yml?...`, requires that YAML feed to be exposed and opened, and simultaneously asserts that the prompt says “release page” (`test/desktop/linux-custom-update-feed.test.js:107-126,165-189,197-210`). The README makes the same release-page promise (`README.md:196-205`).
- Impact: Linux users of a generic custom update provider can be sent to YAML metadata rather than a package or human release page, leaving the application's only manual-update path without an installable download.
- Expected: maintain or require a separate validated human download URL and never present updater metadata as the package/release page.

### BUG-513 — Low/Medium — Forced desktop shutdown completes without confirming backend exit

- Status: **Open**.
- Evidence: both shutdown deadlines call `forceKill()`, which ignores the boolean result and every exception from `proc.kill('SIGKILL')`, removes the process exit listener, and immediately resolves (`electron/server-shutdown.cjs:34-77`). Desktop quit cleanup treats that resolution as completion and exits Electron (`electron/main.cjs:378-386,623-642`). Tests use a fake process whose `kill()` only records the signal and never exits, yet require the shutdown promise to resolve for both deadline paths (`test/desktop/electron-shutdown-deadline.test.js:112-156`).
- Impact: a refused, failed, or delayed kill can leave the backend orphaned and still proxying/listening after the desktop application reports cleanup complete and quits.
- Expected: check signal delivery, retain the exit listener, wait through a bounded post-kill confirmation period, and surface or retain ownership when termination cannot be confirmed.


### BUG-515 — Low/Medium — TLS hostname settings accept values that can never match a connection

- Status: **Open**.
- Evidence: the shared hostname normalizer only trims, case-folds, strips enclosing brackets, and removes a trailing dot; it does not validate hostname syntax (`src/proxy/https-whitelist.js:16-22`). TLS passthrough validation checks only nonempty/control-free strings, then runtime compares a parsed CONNECT hostname by exact value or a leading-`*.` suffix (`src/api/api-server.js:109-120,2074-2095`; `src/proxy/proxy-server.js:2851-2862,4939-4944`). Client-certificate preparation treats any nonempty normalized value without a partial wildcard as a hostname, while lookup supports only exact normalized hosts or global `*` (`src/proxy/proxy-server.js:2870-2874,2936-2967,3132-3137`). HTTPS-whitelist validation has the same grammar gap and runtime is exact-only (`src/proxy/https-whitelist.js:44-85`; `src/proxy/proxy-server.js:3112-3129`); its test accepts `*.Example.Test.` while proving it does not match `api.example.test` (`test/settings/https-whitelist-validation.test.js:105-131`).
- Impact: full URLs, `host:port`, and unsupported wildcard forms return success and persist, yet passthrough, mTLS authentication, or the verification exception remains inactive for the intended server.
- Expected: enforce each feature's actually matchable hostname grammar before runtime mutation or persistence, including explicit and consistent wildcard rules.


### BUG-517 — Low/Medium — Mock method editors misrepresent valid extension methods

- Status: **Open**.
- Evidence: the method matcher editor is a closed select containing only `*` and seven common methods (`src/ui/app.js:7868-7874`); transform-request and rewrite-method controls use similarly closed lists (`:8004-8011,8356-8362`). Backend validation instead accepts every valid HTTP token for all three fields (`src/proxy/mock-rule-validation.js:130-143,308-323`), with tests explicitly accepting extension/custom tokens (`test/mocking/mock-rule-validation.test.js:133-160`; `test/mocking/rule-backup-v2.test.js:399-431`). Create Mock copies the captured method and immediately opens this editor (`src/ui/app.js:13369-13381,13435-13444`).
- Impact: users cannot author supported extension methods, and an imported or captured rule such as `M-SEARCH` has no matching option, so the browser visually displays the first matcher choice, “ANY,” while the hidden draft still retains `M-SEARCH`. The transform and rewrite controls similarly present misleading defaults.
- Expected: use token-capable inputs with common-method suggestions and preserve every valid method. This is distinct from BUG-504's case-folding during matching/filtering.



## Additional pass-11 findings

### BUG-520 — Medium — Failed interceptor cleanup is reported as a completed shutdown

- Status: **Open**.
- Evidence: `InterceptorManager.deactivateAll()` catches and suppresses every deactivation error and returns no failure signal (`src/interceptors/interceptor-manager.js:307-325`). The central shutdown awaits that false success once, stops the proxy and API, emits `http-freekit:shutdown-complete`, and exits with the original code (`src/index.js:258-290`); desktop treats the message as authoritative completion (`electron/server-shutdown.cjs:58-68`; `electron/main.cjs:378-386,623-642`). System Proxy, Android, JVM, and Fresh Terminal cleanup deliberately throw while retaining state for a retry (`src/interceptors/system-proxy-interceptor.js:809-836`; `src/interceptors/android-adb-interceptor.js:1978-2017`; `src/interceptors/jvm-interceptor.js:1584-1661`; `src/interceptors/terminal-interceptors.js:1177-1230`). The manager regression proves recovery only by manually calling `deactivateAll()` again after a first failure (`test/api/shutdown-admission-gate.test.js:234-265`), but production exits after the first call.
- Impact: system/device proxy settings, reverse tunnels, injected JVM settings, or managed processes can remain active after FreeKit stops, while the desktop reports successful cleanup and removes the user's opportunity to retry Stop.
- Expected: aggregate cleanup failures, retry them within a safe bound, and withhold the completion signal/normal exit or surface actionable recovery until every retained ownership record is resolved. This is distinct from BUG-513's failure to confirm that a force-killed backend exited.

### BUG-521 — Low/Medium — Deleting a mock group leaves orphaned drafts and editor state

- Status: **Open**.
- Evidence: group enable and rename actions stage group entries in `mockDraftRules` (`src/ui/app.js:9123-9147`). `deleteMockGroup()` deletes the server group and reloads but clears neither group/descendant drafts nor editor, expansion, or rename state (`:9153-9167`); reload deliberately retains every draft (`:6891-6900`) even though backend deletion removes the complete group tree (`src/api/api-server.js:1923-1935`; `src/proxy/proxy-server.js:10919-10930`). A disappeared edited child is still considered changed (`src/ui/app.js:8627-8641`), and Save All PUTs every orphan ID until the backend returns “Rule not found” (`:8848-8890`). Tests clean up drafts only for an individually deleted rule and check only group-delete locking (`test/mocking/mock-delete-draft.test.js:115-140`; `test/mocking/mock-save-all-lock.test.js:308-314`).
- Impact: the UI keeps an invisible unsaved count/editor after a successful group deletion; an orphan can block later unrelated drafts from saving until Revert or restart, risking their loss.
- Expected: after confirmed deletion, clear state for the group and every descendant and cancel any editor/rename targeting them, while retaining that state only when deletion fails. This is distinct from BUG-465's false draft created while saving an unchanged grouped rule.

### BUG-522 — Medium — The desktop shutdown deadline can interrupt valid cleanup

- Status: **Open**.
- Evidence: one unconditional 30-second timer starts with the shutdown request and force-kills the backend when it expires (`electron/server-shutdown.cjs:3-5,20-28,34-47,77`). Cleanup is serial across interceptors (`src/interceptors/interceptor-manager.js:310-320`) and JVM processes (`src/interceptors/jvm-interceptor.js:1653-1661`); each JVM restore can legitimately complete just under its own 15-second timeout (`:1314-1319,1616-1621`), so three otherwise-successful restores exceed the global deadline. One Android companion can also consume over 30 seconds through app/deactivation work, five bounded VPN polls, and reverse cleanup, with devices processed serially (`src/interceptors/android-adb-interceptor.js:558-600,1199-1229,1458-1494,1999-2017`). Existing desktop coverage manually completes cleanup without advancing the deadline and classifies every over-deadline operation as hung (`test/desktop/electron-shutdown-deadline.test.js:67-130`).
- Impact: desktop SIGKILL can truncate supported, progressing cleanup and leave later process, proxy, certificate, or tunnel ownership active until a later recovery attempt.
- Expected: use progress-aware/per-operation bounds or a total budget sufficient for all admitted bounded cleanup, and force-kill only after work is actually stalled. This is distinct from BUG-513's post-kill exit-confirmation defect and BUG-520's swallowed cleanup failures.

### BUG-523 — Medium — Breakpoint body edits retain stale Content-Encoding headers

- Status: **Open**.
- Evidence: request breakpoints expose decoded body text, then turn an edited string into plain bytes and call `_setContentLength()` (`src/proxy/proxy-server.js:4521-4563`); that helper removes `Content-Length`, `Transfer-Encoding`, and `Trailer` but not `Content-Encoding` (`:1030-1038`). Equivalent request-edit branches cover intercepted TLS H1, native H2, and the H1 fallback (`:5752-5771,6313-6325,6765-6769`). The response breakpoint helper likewise copies the original headers when only the decoded body is edited and removes no content encoding (`:10683-10765`). Request/response transforms correctly strip `Content-Encoding` when replacing body bytes (`:3433-3442,3471-3477`). Breakpoint coverage edits only uncompressed bodies; its gzip case changes the URL rather than the body (`test/mocking/breakpoint-chunked-body.test.js:144-221`; `test/mocking/transform-breakpoint-body.test.js:291-315`).
- Impact: a plain edited request or response remains labelled `gzip`, `br`, or another original coding, so the origin/client attempts to decompress unrelated bytes and rejects or corrupts the message.
- Expected: remove `Content-Encoding` whenever a breakpoint replaces decoded body bytes, unless the editor explicitly supplies correctly encoded replacement bytes and metadata.

### BUG-524 — Medium — A missed body rule makes unrelated large responses fail instead of stream

- Status: **Open**.
- Evidence: any potentially matching body-dependent mock or breakpoint disables the streaming engine before the request body can decide the final match (`src/proxy/proxy-server.js:1118-1167`). This selects buffered handling for plain H1, intercepted TLS H1, native H2, and H1 fallback paths (`:4389-4405,5174,6148,6603`). Even when that body condition ultimately misses or resolves to passthrough, those paths destroy an upstream response beyond the default 32 MiB collector limit (`:431-432,4681-4686,5891-5895,6452-6456,6901-6905,8019-8023`), with the plain-H1 path returning a 502 (`:4790-4836`). The normal streaming engine instead forwards the whole response while bounding only its capture (`:1207-1209,1520-1543`). Body-limit tests cover large uploads and Send's explicit cap, not a missed body rule plus a large transparent response (`test/proxy/core/body-limits.test.js:37-92`).
- Impact: merely enabling an unrelated body matcher or breakpoint can turn a valid download over 32 MiB into a 502 or reset despite no rule applying to it.
- Expected: once request-body matching resolves to no buffering-dependent action, transparently stream the response with bounded capture. This is distinct from BUG-490's oversized request-body rejection and missing traffic record.

### BUG-525 — Low/Medium — Webhook mocks drop Content-Encoding while copying encoded bytes

- Status: **Open**.
- Evidence: `_serveWebhookMock()` copies only `Content-Type`, forwarding metadata, and configured headers (`src/proxy/proxy-server.js:3573-3579`) but sends the original raw request body unchanged (`:3580-3603`). Plain H1, intercepted TLS H1, native H2, and H1 fallback mock paths all converge on that behavior (`:4489,5262,7349-7370,7522-7529`). Body matching/display decode separately without changing the supplied raw buffer (`:10323-10341`). Protocol-parity coverage uses only unencoded text (`test/mocking/webhook-protocol-parity.test.js:258-307`).
- Impact: gzip/Brotli request bytes reach the webhook labelled only as JSON, text, or octet-stream, so ordinary receivers cannot know they must decompress them and parse corrupt-looking data.
- Expected: either preserve the original `Content-Encoding` with the raw body or decode the body and update all representation headers consistently.

### BUG-526 — Low — Failed desktop protocol registration is silently ignored

- Status: **Open**.
- Evidence: both forms of `app.setAsDefaultProtocolClient()` have their boolean result discarded (`electron/main.cjs:190-195`), although the installed Electron declaration defines that result as whether registration succeeded (`node_modules/electron/electron.d.ts:1680-1683`). Startup continues normally (`electron/main.cjs:656-689`), while the README promises that the desktop app registers and can be launched through `http-freekit:` (`README.md:208-227`). Deep-link tests exercise parsing and dispatch but not OS registration or a false result.
- Impact: a ZIP/development launch or Linux environment that refuses registration leaves the advertised integration unavailable with no log, warning, or recovery guidance.
- Expected: inspect a false return, surface an actionable non-fatal registration warning, and cover both packaged and development argument forms. This is distinct from BUG-444's failure after launching an ordinary external web link.

### BUG-527 — Low — Shared-temp browser markers are read without a size limit at startup

- Status: **Open**.
- Evidence: startup synchronously scans `os.tmpdir()` for managed-looking browser profiles (`src/interceptors/browser-lifecycle.js:630-670`; invoked by `src/interceptors/interceptor-manager.js:27`). `inspectProfileOwner()` verifies that the ownership marker is a regular non-symlink but performs an unbounded `readFileSync()` and `JSON.parse()` without checking `stats.size` (`src/interceptors/browser-lifecycle.js:278-304`). On a shared POSIX temporary directory, another local user can create a readable `http-freekit-chrome-*` lookalike containing an attacker-sized marker. Tests cover malformed JSON/fields, marker directories, symlinks, and nesting but not size (`test/interceptors/browser/stale-profile-marker.test.js:42-87`).
- Impact: startup can block, allocate attacker-controlled memory, or terminate from memory pressure before the proxy/API becomes available.
- Expected: enforce a small marker byte ceiling before reading and place a reasonable bound on the number of candidate entries inspected.

## Additional pass-12 findings

### BUG-528 — Medium — Windows HAR deep links accept attacker-controlled UNC paths

- Status: **Open**.
- Evidence: the custom-protocol parser accepts every `file:` URL whose pathname ends in `.har`, without restricting its hostname (`electron/deep-link.cjs:32-44`; `electron/har-deep-link.cjs:7-13`). The loader then passes that URL directly through `fileURLToPath()` and opens the result (`electron/har-deep-link.cjs:22-35`). On Windows, Node explicitly converts `file://nas/share.har` to the UNC path `\\nas\share.har` (`node_modules/@types/node/url.d.ts:317-329`). Existing coverage exercises only drive-local `file:///C:/...` URLs and non-HAR rejection (`test/desktop/har-deep-link.test.js:13-33`).
- Impact: opening an untrusted `http-freekit:` link can make the desktop process contact an attacker-controlled SMB host before the import fails or succeeds, exposing network authentication material and allowing a remote share to stall the main-process import path. This is distinct from BUG-470's HTTP(S) SSRF.
- Expected: accept only genuinely local file URLs, explicitly reject UNC/device paths and nonempty remote hostnames, and add Windows path-policy coverage before calling `fileURLToPath()` or opening the target.

### BUG-529 — Low/Medium — Mock destination validation accepts unusable URLs and silently drops credentials

- Status: **Open**.
- Evidence: shared validation requires only a nonempty `forwardTo` or `webhookUrl` string (`src/proxy/mock-rule-validation.js:249-261`), so create, update, and import paths persist malformed and non-HTTP(S) destinations (`src/api/api-server.js:1716-1734,1758-1776,1779-1788`). Forward targets are parsed only after a request matches, where setup failure becomes a 500 (`src/proxy/proxy-server.js:5366-5394,7172-7203,9462-9492`); the FTP regression codifies that deferred failure (`test/proxy/core/supported-url-schemes.test.js:154-176`). Webhooks acknowledge the client before parsing and record invalid URLs only as asynchronous delivery failures (`src/proxy/proxy-server.js:3550-3570,3609-3628`; `test/mocking/webhook-failure.test.js:130-140`). Valid HTTP(S) URLs containing userinfo are also reconstructed into request options without `auth` or a derived `Authorization` header in both forward and webhook paths (`src/proxy/proxy-server.js:708-770,3580-3587`).
- Impact: broken destinations save successfully and fail only when traffic matches, while `http://user:pass@host/...` targets silently receive unauthenticated requests.
- Expected: validate complete HTTP(S) destinations during create, update, and import; either reject URL userinfo clearly or translate decoded credentials into `Authorization`, with an explicitly configured header taking precedence. This is distinct from BUG-496's bracketed IPv6 transport failure.

### BUG-530 — Medium — POSIX terminal PID handshakes use a raceable shared-temp file

- Status: **Open**.
- Evidence: macOS and Linux Fresh Terminal activation invents a pathname directly under shared `os.tmpdir()` but neither creates nor privately contains it before launch (`src/interceptors/terminal-interceptors.js:307-309,1065-1084`). The child shell follows that path with ordinary `>`, while the parent follows and unboundedly reads it with `readFileSync()` (`:337-347,889-896`). The only value is a PID: adoption accepts any currently inspectable live identity for that PID, with no nonce, child relationship, or expected POSIX executable (`:618-626,1096-1118`). The Windows path already uses a private `mkdtemp` directory, bounded identity report, nonce acknowledgement, and executable check (`:311-385,1015-1045`).
- Impact: a same-host attacker who wins the filename race can redirect the shell write through a symlink, feed an oversized file to the backend, or substitute the PID of another process owned by the victim account. The latter process is then journaled as FreeKit-owned and can be signalled on Stop, while the actual proxy-configured shell is left untracked.
- Expected: use a mode-0700 private handshake directory on POSIX, exchange a bounded identity plus cryptographic nonce without following links, verify the reported process belongs to the launched session, and require acknowledgement before the shell enters its proxy-configured login session.

### BUG-531 — Medium — Transform-request actions discard original-request provenance

- Status: **Open**.
- Evidence: dedicated `transform-request` actions mutate method, URL, headers, and body in the four buffered protocol handlers (`src/proxy/proxy-server.js:4494-4507,5674-5692,6243-6261,6689-6707`). Their final proxy captures contain only those transformed fields and never attach `originalRequest` or `transformedBy` (`:4753-4780,5775-5789,6332-6346,6781-6795`). Those provenance fields are constructed only for pre-step transformations inside the separate terminal-action engines (`:5318-5326,7140-7148,9412-9420`). The renderer exposes the modification card and original/client perspectives exclusively when `req.originalRequest` exists (`src/ui/app.js:2853-2875,3336-3364`).
- Impact: traffic changed by the core Transform Request action is presented as ordinary client-originated proxy traffic; the original URL, method, headers, and body are unrecoverable in the detail view, so users cannot audit what the rule changed.
- Expected: snapshot the original request before every dedicated transform action, propagate that snapshot and the rule identity through pending, success, and error captures in every protocol path, and add protocol-parity UI coverage.

### BUG-532 — Low — Transform perspective leaks into the next selected request

- Status: **Open**.
- Evidence: the detail view stores one global `_transformPerspective` (`src/ui/app.js:2842-2851`). `renderDetailCards()` says it resets that state for a new request, but actually resets only when the incoming request lacks `originalRequest` (`:2921-2924`). Selecting another transformed request calls the same renderer after replacing `detailPanel._request` (`:2158-2168`), making that case indistinguishable from the same-request rerender used by the perspective selector. There is no transform-perspective state or selection regression coverage.
- Impact: after choosing Original or Client on one transformed capture, directly selecting a different transformed capture opens it in the stale perspective instead of the documented transformed default, which can make its displayed request look unlike what was sent upstream.
- Expected: track the last rendered request identity and reset to Transformed when that identity changes, while preserving the selected perspective only for rerenders of the same request.

### BUG-533 — Low — Client-certificate settings overflow at the supported minimum window width

- Status: **Open**.
- Evidence: the client-certificate editor places three intrinsic-width inputs and two buttons in one non-wrapping flex row; the inputs have `flex:1` but no `min-width:0`, and the row has no responsive class (`src/ui/index.html:521-533`). At the settings breakpoint, CSS stacks only the outer layout and selected traffic-list toolbars (`src/ui/styles.css:2321-2385,2742-2776`); cards retain 20px padding (`:1294-1300`). Electron permits a 700px-wide window (`electron/main.cjs:423-429`), where the 75px sidebar, 56px settings-shell padding, and 40px card padding leave roughly 529px for three default text-input intrinsic widths, two buttons, and four gaps. Existing responsive settings coverage checks navigation only (`test/settings/settings-navigation.test.js:47-53`).
- Impact: at a supported desktop size, the TLS settings card extends horizontally or clips its Browse/Add controls, making client-certificate configuration awkward or inaccessible without widening the window.
- Expected: give the row a responsive class, allow its fields to shrink with `min-width:0`, and wrap or stack the fields and buttons at the narrow settings breakpoint.

## Additional pass-13 findings

### BUG-534 — Low/Medium — Terminal and Docker interception replace environment-specific trust roots

- Status: **Open**.
- Evidence: the generated CA bundle consists only of Node's compiled `tls.rootCertificates` plus the FreeKit CA (`src/proxy/terminal-ca-bundle.js:17-23`). Both terminal modes point the overriding `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, and `CURL_CA_BUNDLE` variables at that file (`src/interceptors/terminal-interceptors.js:134-169,970-977`). Docker mounts the same host-generated bundle into every image and assigns those variables there as well (`src/interceptors/docker-interceptor.js:151-183`). Tests deliberately assert exact Node-root composition rather than preservation of host or image trust (`test/interceptors/terminal/terminal-ca-bundle.test.js:51-72`; `test/interceptors/docker/docker-ca-bundle.test.js:70-121`). Electron's Node path, by contrast, uses only the additive `NODE_EXTRA_CA_CERTS` mechanism (`src/interceptors/electron-interceptor.js:125-145`).
- Impact: a host command or container that normally trusts an organization/private CA through the OS, language runtime, or image-specific bundle can lose that trust only while intercepted, causing unrelated enterprise HTTPS endpoints to fail. Container trust can also differ legitimately from the host Node release's compiled roots.
- Expected: append the FreeKit CA to each target environment's actual trust bundle or use an additive mechanism for each supported client; do not replace tool-specific and container-specific roots with the backend's compiled list.

### BUG-535 — Medium — Valid User-Agent transform values can abort request handling

- Status: **Open**.
- Evidence: mock header validation accepts numeric values and arrays of strings or numbers, including in request transforms (`src/proxy/mock-rule-validation.js:60-80,178-185`). `_applyMockHeaderTransform()` and `_applyMockRequestTransform()` preserve those values verbatim (`src/proxy/proxy-server.js:3326-3350,3388-3444`), but `_detectSource()` directly invokes `.toLowerCase()` on `headers['user-agent']` (`:10228-10244`). A plain-H1 transform reaches source detection while emitting its post-transform pending row (`:4494-4507,4648-4658,10108-10127`); native H2 calls it before upstream forwarding (`:6243-6261,6321-6329`), and the other buffered paths call it during final `_emitRequest()`/`_emitRequestUpdate()` (`:10036-10045,10141-10151`). Transform coverage uses string-valued headers only (`test/mocking/mock-transform-timeout.test.js:121-168`).
- Impact: an API-valid or imported rule that updates `User-Agent` to a repeated-value array or nonzero number throws a `TypeError`; depending on the protocol path, the matched exchange is aborted, left hanging after its pending record, or forwarded without a completed capture.
- Expected: normalize User-Agent through the shared repeated-header/string conversion helpers before source classification, or consistently reject non-string values for headers whose consumers require scalars. This is distinct from BUG-495's response Content-Type/body-formatting sink.

### BUG-536 — Low — The Mock toolbar is clipped at the supported minimum window width

- Status: **Open**.
- Evidence: Electron permits a 700px-wide window (`electron/main.cjs:423-429`), but the Mock panel hides overflow and places its heading, unsaved badge, tip, and a seven-button action row in one header (`src/ui/index.html:180-211`). That header is a single non-wrapping flex row with 80px of horizontal padding (`src/ui/styles.css:3341-3352`), while every button is non-wrapping (`:1475-1489`). At the 768px responsive breakpoint the sidebar still consumes 44px, and the responsive rules adapt Traffic, Intercept, and Send but never the Mock header or action row (`:3914-3956`). Showing Save All and Revert for a draft makes the row's minimum content substantially wider than the roughly 576px left inside the header at the supported minimum. Existing Mock tests cover button state and transactions, not narrow layout (`test/mocking/mock-revert-transaction.test.js`; `test/mocking/mock-save-all-lock.test.js`).
- Impact: at a supported desktop size, the non-wrapping row overflows into content that cannot expand and the panel clips its rightmost actions, including import/export or Reset, precisely when draft-only Save/Revert controls are visible.
- Expected: wrap or stack the Mock header/action row at narrow widths, or collapse suitable button labels while keeping every action reachable. This is distinct from BUG-533's client-certificate form overflow.

## Additional pass-14 findings

### BUG-537 — Low — Header consumers can lose or copy the wrong valid value

- Status: **Open**.
- Evidence: detail rendering stores only request and response header maps for later context-menu lookup (`src/ui/app.js:2931-2932`), then separately renders `req.trailers` using the section name `trailers` (`:3495-3506`). `renderHeadersGrid()` exposes that exact section and stringifies scalar values for display (`:3935-3953`), but `showHeaderContextMenu()` treats every section other than `request` as the ordinary response map and converts scalars through the falsy fallback `String(headers[headerKey] || '')` (`:13452-13468`). Consequently trailers are looked up in the wrong map, while a numeric-zero header accepted from fixed/transform/webhook mocks (`src/proxy/mock-rule-validation.js:50-80,178-185,229-236`) visibly renders as `0` but copies as blank. The same accepted zero disappears entirely from Mock rule-detail header summaries because both action and webhook headers pass through `esc(v)` (`src/ui/app.js:7733-7741,7766-7773`), and `esc()` returns an empty string for every falsy value (`:13472-13476`). HAR conversion stringifies the header row itself but repeats the falsy fallback in its first-value helper, so a valid numeric `Location: 0` is exported as a visible header while `response.redirectURL` is blank (`src/api/har-converter.js:13-31,108-111`). Existing keyboard-context and HAR header coverage exercises ordinary string values only (`test/ui/keyboard-context-menu.test.js:241-266,400`; `test/import-export/har-header-case.test.js`).
- Impact: header summaries can hide a configured zero value; context-menu copy can return blank or a same-named ordinary response header instead of the selected trailer/value; and one HAR can contradict itself about the redirect target.
- Expected: retain and select the exact section's map, preserve validated falsy scalar values with nullish-safe rendering/conversion everywhere, and cover request, response, trailer, Mock-summary, and HAR redirect consumers. This is distinct from BUG-514, where a pre-step destroys numeric zero before capture.

### BUG-538 — Low — Response status overrides retain the upstream reason phrase in traffic

- Status: **Open**.
- Evidence: `_applyMockResponseTransform()` replaces `statusCode` while spreading the original response's `statusMessage` unchanged (`src/proxy/proxy-server.js:3447-3488`). Response breakpoints similarly choose the edited status but return the original message (`:10683-10765`). Every buffered H1/H2 path then emits the resulting pair into the final capture (for example `:4738-4765,5850-5864,6408-6425,6489-6508`). H1 wire output supplies only the numeric status and headers, so Node chooses the new status's reason phrase, while H2 has no reason phrase (`:2651-2667`); the renderer nevertheless displays both captured fields together (`src/ui/app.js:3435-3459`). Existing response-breakpoint and transform tests assert edited numeric statuses but never the captured message (`test/mocking/breakpoint-mock-forwarding.test.js:108-154`; `test/mocking/mock-transform-timeout.test.js:121-173`).
- Impact: changing an upstream `200 OK` response to 404 can make Traffic display and export the impossible pair `404 OK`, which disagrees with the response actually sent to the client.
- Expected: whenever a transform or breakpoint changes the status code, recompute the capture label from the new final status or clear it consistently for protocol-neutral capture.

### BUG-539 — Low — Header-documentation toggles collide across detail sections

- Status: **Open**.
- Evidence: `renderHeadersGrid()` restarts its index for each request, response, and trailer grid, then derives every disclosure ID from only the normalized header name and that local index (`src/ui/app.js:3935-3953`). A request and response that each contain `content-type`, for example, both emit `hdr-content_type-0-icon` and `hdr-content_type-0-desc`. `toggleHeaderRow()` stores one module-global state key and uses global `document.getElementById()` lookup (`:2827-2837`), which returns the first duplicate rather than the controls beside the activated row. That map also survives request changes, although every detail rerender replaces the DOM and emits a literal `+` plus a default-hidden description without restoring the stored state (`:3693,3935-3953`). Existing detail/header tests do not exercise the same header name in multiple sections or consecutive requests.
- Impact: clicking a response or trailer header's disclosure can alter the matching request-header row instead, leaving the selected description closed and creating contradictory icons and state. After an ID was opened on one exchange, selecting another exchange with the same ID makes the first click appear inert because stale `true` state is changed to `false` on markup that is already visually collapsed.
- Expected: include the exact section (and, if state should survive rerenders, request identity) in each ID/state key, or toggle elements relative to the invoked row; assert unique IDs across the rendered detail view.

### BUG-540 — Low — A manual Protobuf type selection leaks into unrelated bodies

- Status: **Open**.
- Evidence: manual schema choices are stored in `bodySchemaTypeOverrides` by stable viewer element ID alone (`src/ui/app.js:4127-4134,4284-4311`), such as `reqBody`, `resBody`, or `sendResBody`. Every later viewer render gives that saved choice precedence over context-specific inference (`:4262-4281,4978-4987`). Selecting another Traffic exchange rebuilds those same viewer IDs without clearing or rekeying the overrides (`:2886-2932`), and later Send responses likewise reuse their stable ID; only clearing every imported schema empties the map (`:4245-4257`). Existing schema tests cover import atomicity and storage failure, not selection state across different message bodies (`test/ui/protobuf-schema-import-atomic.test.js`; `test/ui/storage-failure-feedback.test.js`).
- Impact: after manually decoding one Protobuf/gRPC body as a chosen message type, unrelated later captures or Send responses can be decoded using that stale type and the selector misleadingly continues to present it as the active choice.
- Expected: scope manual type overrides to the body/request/tab identity, or reset them whenever the viewer's content identity changes. This is distinct from BUG-532's transform-perspective state leak.

### BUG-541 — Low/Medium — Body-forbidden mock responses are captured as if their payload was sent

- Status: **Open**.
- Evidence: backend validation independently accepts every final status from 200 through 599 and any string/buffer fixed body (`src/proxy/mock-rule-validation.js:85-97,229-247`); the editor likewise exposes an unrestricted 200–599 status beside independent body/file controls (`src/ui/app.js:7954-7982,8145-8155,8719-8749`). Plain and CONNECT-intercepted H1 fixed paths call `writeHead(204|304, headers)` followed by `end(body)`, then unconditionally capture that body and byte count; their native-H2 counterpart calls `respond()`/`end(mockBody)`, swallows send errors, and records it too (`src/proxy/proxy-server.js:5646-5667,7485-7515,9875-9905`). Serve-file paths have the same issue: `_streamMockFile()` counts every source byte before the destination (`:2468-2562`), and H1/H2 handlers report the file content/size after a body-forbidden status or HEAD request (`:5460-5502,7271-7317,9558-9601`). Response transforms and breakpoints also permit 204/304 while retaining the body, after which final protocol paths send and capture it unchanged (`:3447-3488,4738-4771,5850-5864,6408-6425,10744-10765`). HTTP HEAD, 204, and 304 responses cannot carry those payloads. Existing final-status coverage uses 200/599 and an empty-body 204 object, never a body-forbidden mock with content (`test/mocking/fixed-response-status.test.js:114-167`).
- Impact: fixed, file, transformed, and breakpoint responses can deliver no configured payload—or fail an H2 stream—while Traffic asserts that the body and its full size were successfully delivered, defeating mock verification and protocol parity.
- Expected: normalize every mock response against its final method/status, reject or clear bodies and incompatible representation/framing headers for body-forbidden responses, and capture only bytes actually sent.

### BUG-542 — Medium — High Contrast renders core controls and states white-on-white

- Status: **Open**.
- Evidence: the High Contrast theme assigns `--bg-input`, `--bg-highlight`, `--text-main`, `--text-lowlight`, and `--text-watermark` all to white (`src/ui/styles.css:227-239`). A later theme selector attempts to force form text to black (`:312-317`), but its non-`!important` declarations lose the author cascade to inline `background:var(--bg-input); color:var(--text-main)` declarations on the Send URL and many core Settings controls (`src/ui/index.html:239,425-427,440,448,462,483,496,500,507,528-530,542,554`). Other components directly combine the colliding highlight/text tokens without a High Contrast correction: muted detail pills, the detail-close hover, and context-menu/filter-hint hover states (`src/ui/styles.css:1194,3076-3079,4081-4092,4121-4129`). The selected Traffic row has an explicit black-text override (`:280-289`), confirming that the general tokens alone are insufficient. Theme coverage checks selection/storage and safe values, not the resulting cascade.
- Impact: in the advertised High Contrast theme, typed values and current selections in Send and core proxy/TLS settings disappear; protocol pills and hovered detail/menu controls also become white-on-white.
- Expected: separate foreground tokens for white input/highlight surfaces, remove conflicting inline colors, and apply effective High Contrast overrides with computed-style coverage for normal, selected, focused, and hovered states.


### BUG-544 — Medium — Disclosure button roles contain interactive descendants

- Status: **Open**.
- Evidence: Send card headers use `role="button"` while containing independent Add, Format, and Copy buttons plus body/export selects (`src/ui/index.html:250-315`). Activatable interceptor cards likewise receive `role="button"` and keyboard behavior (`src/ui/app.js:5617-5635`) before Close/Stop actions and full interactive configuration content are inserted inside them (`:5648-5665`). Interactive descendants of an ARIA button are an invalid nested interaction and may be flattened or exposed ambiguously by accessibility APIs. Existing keyboard tests assert event activation/propagation, not the resulting accessibility tree (`test/ui/keyboard-controls.test.js:17-33`; `test/interceptors/core/interceptor-card-keyboard.test.js:175-195`).
- Impact: screen-reader and keyboard users can lose or ambiguously encounter the nested controls, and activating a child control can be interpreted as operating the surrounding disclosure/card.
- Expected: make a dedicated native disclosure button controlling a sibling content region, with independent actions/selects outside that button.


### BUG-546 — Medium — Built-in themes use multiple low-contrast normal-text color pairs

- Status: **Open**.
- Evidence: several built-in foreground/background pairs miss the 4.5:1 normal-text threshold. Dark-theme `--text-lowlight: #818490` on `--bg-main: #32343B` is about 3.34:1 for repeated 11–13px settings/help text (`src/ui/styles.css:9,17,1294-1300,2423-2434,2492-2510`; representative `src/ui/index.html:373-380,417,430-435,454,473,511-523`). Every built-in theme uses `--pop-color: #e1421f`; 12px primary buttons render white on it at about 4.20:1 and brighten it further on hover (`src/ui/styles.css:20-21,129-130,239-240,1475-1503`; visible actions at `src/ui/index.html:187,240,392,401,502`). JVM Attach is 12px white on `#e76f00`, about 3.15:1 (`src/ui/styles.css:2190-2202`; `src/ui/app.js:6420-6433`). Response status pills are 12px white on 2xx green, 3xx blue, or 4xx orange at about 2.72:1, 3.89:1, or 2.32:1 (`src/ui/styles.css:3067-3079`; `src/ui/app.js:2911-2918,3435-3451`). Light-theme 11px watermark text is about 3.57:1 on the main surface and 3.03:1 on containers (`src/ui/styles.css:118-130,1294-1308,3341-3352`; `src/ui/index.html:185,250-330,368-647`). There is no contrast regression.
- Impact: primary actions, final response status, and widespread instructional/metadata text can be difficult to read for low-vision users across the built-in dark and light themes; none of these 11–13px examples qualifies for a large-text exemption.
- Expected: replace the shared accent/status/text palette with surface-specific pairs that meet normal-text contrast in every built-in state, including hover, and add automated contrast coverage. This is distinct from BUG-542's complete white-on-white High Contrast cascade collision.

### BUG-547 — Low/Medium — Breakpoint method edits collapse case-sensitive extension tokens

- Status: **Open**.
- Evidence: breakpoint validation accepts every case-preserving HTTP token (`src/proxy/proxy-server.js:10428-10437`), and plain H1/intercepted-H1 engines assign API-supplied edits verbatim (`:4552-4554,5575-5577,5745-5747,6760-6762,9695-9699`). The renderer nevertheless uppercases every method entered through its breakpoint prompt (`src/ui/app.js:13620-13624`), while both native-H2 backend paths independently trim and uppercase API-supplied edits (`src/proxy/proxy-server.js:6310-6312,7416-7420`). H2 breakpoint coverage edits only to uppercase `POST` (`test/mocking/h2-breakpoint-edits.test.js:32-60`), and no renderer test covers extension-method editing.
- Impact: a legitimate case-sensitive extension method such as `Foo` or `gEt` is changed to `FOO` or `GET` in every UI-driven breakpoint; even direct API clients that preserve it get different behavior on H2 versus H1.
- Expected: validate and preserve the exact token in the renderer and every protocol engine, with mixed-case extension-method breakpoint parity coverage. This is distinct from BUG-445's unsafe replay classification and BUG-504's rule/filter case folding.

### BUG-548 — Low — Oversized rejected WebSocket responses masquerade as complete captures

- Status: **Open**.
- Evidence: rejected WebSocket handshakes are transparently forwarded while their body collector tracks the full byte count (`src/proxy/proxy-server.js:3781-3848`). Once the collector exceeds its limit, finalization substitutes a literal omission message but sets no `responseBodyTruncated`, captured-size, or decoded-size metadata (`:3793-3816`). Shared capture instead represents overflow with `TruncatedBodyString` (`:1066-1077`), whose normalization sets the truncation fields (`:10247-10267`). Rejected-upgrade coverage exercises an aborted small body, not an oversized completed rejection (`test/proxy/websocket/aborted-websocket-response.test.js:63-87`).
- Impact: the detail warning is absent, body search sees the omission message as real content, and HAR/JSON consumers can treat it as a complete response body even though `responseBodySize` describes unretained upstream bytes.
- Expected: use the shared truncated-body representation and publish zero captured bytes plus the known original size for an over-limit rejected handshake.

### BUG-549 — Low/Medium — Forward mocks capture pre-forward request headers

- Status: **Open**.
- Evidence: the intercepted-H1 forward action copies the inbound headers, applies `addRequestHeaders`, and sends that temporary map (`src/proxy/proxy-server.js:5365-5407`), but its success record stores the original `req.headers` (`:5419-5430`). Native H2 similarly sends `fwdHeaders` with additions and captures the earlier `reqHeaders` (`:7171-7215,7229-7240`); the generic H1 engine sends its augmented temporary map and records `clientReq.headers` (`:9461-9505,9517-9530`), which also covers H1-on-H2 fallback (`:7521-7535`). `_requestMockForward()` additionally strips hop-by-hop/proxy fields and rewrites Host only on its outbound map (`:708-770`). Existing parity coverage proves the destination receives `x-mock-request` and stripped proxy headers, but asserts only the protocol of captured mock events (`test/mocking/mock-forward-upstream.test.js:195-296`).
- Impact: Traffic, exports, and MCP omit request headers added by the Forward action and can retain stale Host or proxy/hop-by-hop fields that were not sent to the destination, so the recorded request is not the forwarded request.
- Expected: capture the sanitized final destination-request header map used by the successful attempt, while retaining the client input separately as `originalRequest` when needed. This is distinct from BUG-451's native-H2 response delivery/capture mismatch.

## Additional pass-15 findings

### BUG-550 — Low/Medium — The MCP security scan silently omits vulnerable forwarded and mixed-case HTML responses

- Status: **Open**.
- Evidence: `security_scan` promises to scan captured traffic for HTTPS, cookie, token, response-header, and CORS issues (`src/mcp/mcp-server.js:469-471`), but `_handleSecurityScan()` blanket-skips every record whose source is `mock` (`:922-932`). Successful Forward actions call a real destination through `_requestMockForward()` yet still label the captured response `source: 'mock'` in generic H1 and native H2 paths (`src/proxy/proxy-server.js:9495-9528,7206-7238`), so none of that origin's vulnerabilities is inspected. Independently, HTML recognition applies case-sensitive `value.includes('text/html')` without normalizing header values (`src/mcp/mcp-server.js:965-967,1378-1381`), even though media types are case-insensitive; valid `Text/HTML` and `TEXT/HTML; charset=utf-8` responses therefore bypass every missing-security-header check. Existing coverage fixes header-name case but uses lowercase media-type values and only a synthetic skipped mock (`test/mcp/mcp-security-header-case.test.js:72-107,123-128`).
- Impact: the scanner can return a clean or materially incomplete report for genuine upstream traffic routed through a Forward rule, and it misses missing CSP, HSTS, frame, and MIME-sniffing protections whenever an HTML response uses valid mixed casing.
- Expected: distinguish generated mock responses from real Forward destinations instead of excluding the entire source class, and compare normalized media types case-insensitively. Add forward-action and mixed-case media-type coverage.

### BUG-551 — Low — Invalid matcher syntax and options save as enabled rules with different or impossible behavior

- Status: **Open**.
- Evidence: shared matcher validation checks regex-path, regex-url, regex-body, json-body-exact, json-body-includes, port, protocol, and path options only for broadly shaped/nonempty strings (`src/proxy/mock-rule-validation.js:308-323`); mock-rule validation relies entirely on that predicate (`:326-363`), and breakpoint validation reuses it (`src/proxy/proxy-server.js:10412-10421`). It never compiles regexes, parses expected JSON, bounds a decimal port, restricts protocol to a supported value, or validates path `matchType`, although the editor exposes only prefix/exact/regex and HTTP/HTTPS choices (`src/ui/app.js:7875-7881,7915-7922`). Runtime catches failed `new RegExp()`/`JSON.parse()` and returns false, compares impossible port/protocol strings forever, and silently treats every unknown path mode as prefix (`src/proxy/proxy-server.js:9199-9205,9248-9288,9335-9341`). Thus values such as `[`, malformed JSON, port `70000`, protocol `invalid`, or match mode `exactly` pass create, update, import, and restoration validation but are inert or behave differently from their saved representation. Existing breakpoint coverage directly installs an invalid regex and asserts only fail-closed runtime behavior (`test/mocking/breakpoint-validation.test.js:81-92`); API validation coverage checks absent values rather than invalid syntax/options (`:46-60`).
- Impact: the UI/API reports a semantically impossible or misconfigured mock/breakpoint as successfully saved and enabled, while matching traffic silently passes through or uses prefix semantics the stored rule did not request.
- Expected: compile regexes, parse expected JSON, and validate every matcher-specific option during shared validation; reject failures atomically with an actionable field error and cover mock, breakpoint, import, and persisted-restoration paths.

### BUG-552 — Low — Server-side HAR import accepts malformed URLs that the renderer rejects

- Status: **Open**.
- Evidence: the `/api/traffic/import-har` mapper catches every failed `new URL(entry.request.url)`, substitutes an empty host plus the raw value as the path, and continues (`src/api/api-server.js:1468-1491`). It then classifies that fallback as HTTP and builds a traffic record (`:1523-1534`); generic import validation checks only that URL/host/path values are strings, never that the URL is absolute or has a supported scheme (`:967-1009`). Electron deep-link imports send the raw HAR to this permissive route (`electron/main.cjs:283-304`). In contrast, the ordinary renderer importer requires a string that parses as an absolute HTTP(S)/WS(S) URL (`src/ui/har-import.js:145-160`), with explicit object/relative-URL regressions (`test/import-export/renderer-har-import.test.js:127-128`). Server coverage rejects unsupported absolute schemes but has no malformed or relative URL case (`test/import-export/har-import-validation.test.js:111-140`).
- Impact: the same HAR rejected through the normal UI is silently accepted through the REST or desktop deep-link path as an invalid empty-host traffic row, polluting display, search, detail actions, and later exports with a request that cannot represent HAR traffic.
- Expected: apply one shared HAR normalizer on both paths and atomically reject non-string, non-absolute, malformed, and unsupported request URLs.

### BUG-553 — Medium — Pre-step chains are silently skipped for several selectable mock actions

- Status: **Open**.
- Evidence: the product describes delay/header/URL/method steps as running before the main action (`README.md:16,131`), and the Mock editor exposes “+ Add pre-step” unconditionally beside passthrough, transform, timeout, and all breakpoint action choices (`src/ui/app.js:7807-7840`). Runtime executes pre-steps only after entering the terminal H1/H2 response helpers (`src/proxy/proxy-server.js:7102-7138,9370-9409`). Every protocol dispatcher handles timeout before those helpers, applies transforms directly, and routes breakpoint actions through the ordinary pause path instead (plain H1 at `:4464-4517`; intercepted H1 at `:5237-5253`; native H2 at `:6219-6268`; H1-on-H2 at `:6666-6719`). Passthrough is removed even earlier: `_findMockRule()` converts a matching passthrough rule to `undefined` (`:9178-9180`), while streaming eligibility stops at it without executing any steps (`:1138-1147`). Existing protocol-parity chaining coverage uses Forward, and transform/breakpoint tests provide no pre-steps (`test/mocking/rewrite-prestep-parity.test.js:160-178`).
- Impact: configured delays, header edits, URL rewrites, and method rewrites simply do nothing when paired with visible Passthrough, Transform, Timeout, or Breakpoint actions, across H1, CONNECT-intercepted H1, native H2, and H1 fallback.
- Expected: centralize pre-step execution before terminal-action dispatch and propagate the transformed request into every action, or reject/disable combinations the runtime does not support; add action-by-protocol parity coverage.

### BUG-554 — Medium — Automatic gRPC previews decompress messages without an output limit

- Status: **Open**.
- Evidence: the renderer passes each compressed gRPC frame directly to `pako.ungzip()` or `pako.inflate()` without an expanded-size or compression-ratio ceiling (`src/ui/app.js:4403-4408`). `decodeGrpcBody()` retains the returned byte array, reports its full length, and proceeds to schema or wire-format decoding (`:4558-4618`); gRPC content selects that preview automatically (`:4023-4032`), including when Traffic details and Send results render (`:3695-3708,11040-11068`). The proxy's 32 MiB capture ceiling limits the compressed envelope retained by the backend, not this renderer-side message expansion (`src/proxy/proxy-server.js:431,1040-1053`). Existing gRPC coverage has no high-ratio compressed payload or expanded-size assertion.
- Impact: opening a captured or Send-result gRPC body containing a small high-ratio gzip/deflate message can freeze the renderer or exhaust its memory; fallback and editor rendering can repeat the expansion.
- Expected: enforce a conservative expanded-byte and compression-ratio limit before retaining or decoding each message, then show bounded truncation/error metadata instead of expanding it fully.


### BUG-556 — Medium — Valid FreeKit HAR exports can exceed their own importer’s request ceiling

- Status: **Open**.
- Evidence: the renderer importer reads the complete selected file, parses the complete HAR, maps every entry into a second normalized collection, and serializes that collection as one JSON request (`src/ui/app.js:11761-11780`; `src/ui/har-import.js:278-284`). Every management JSON route is capped at 50 MiB (`src/api/api-server.js:1453-1461`), including the receiving `/api/traffic/import` route (`src/api/routes/traffic-routes.js:302-315`). Export emits the complete retained collection with bodies (`:193-197`), retention permits 10,000 rows (`src/api/api-server.js:285-302`), and individual captured request and response bodies can each approach the 32 MiB capture limit (`src/proxy/proxy-server.js:431,1040-1053`). No renderer preflight, batching, or streaming path aligns these capacities.
- Impact: an ordinary HAR generated by FreeKit can be impossible to import back into FreeKit, even with only a few large exchanges; before the inevitable 413, the renderer also materializes several simultaneous full-size representations and may stall or run out of memory.
- Expected: make export/import capacities round-trip by using bounded streaming or batches, retaining only the rows the backend can keep, and applying an explicit file/expanded-memory policy before full parsing and normalization.

### BUG-557 — Low — Stale breakpoint fetches can overwrite newer UI state

- Status: **Open**.
- Evidence: every completed `loadBreakpointRules()` request unconditionally replaces `breakpointRules` and rerenders (`src/ui/app.js:6746-6755`). Startup begins one load directly while its simultaneous `loadMockRules()` begins another after the mock response (`:1215-1218,7130-7138`); toggles and deletes initiate further reloads after mutations (`:7593-7627`), and import redundantly reloads through both functions (`:9273-9274`). Mock-rule loading has an operation-generation guard, but breakpoint loading has no equivalent (`:7130-7142`). Existing breakpoint UI coverage does not reorder fetch completions.
- Impact: a delayed earlier GET can finish after a successful toggle, delete, or import and restore obsolete breakpoint rows or enabled states in the UI until another refresh, despite the server mutation having succeeded.
- Expected: protect breakpoint loads with a generation/cancellation token, invalidate older reads when a mutation starts, remove redundant loads, and cover out-of-order completion.

### BUG-558 — Low/Medium — WinINet System Proxy leaves PAC and WPAD configuration active

- Status: **Open**.
- Evidence: the WinINet snapshot reads only `ProxyEnable`, `ProxyServer`, and `ProxyOverride` (`src/interceptors/system-proxy-interceptor.js:207-222`). Activation changes only those three registry values before reporting success (`:700-709`), while Stop restores only the same fields (`:572-600`); `AutoConfigURL` and `AutoDetect` are neither disabled, journaled, ownership-checked, nor restored. The separate WinHTTP path does explicitly normalize and disable `autoConfigUrl`/`autoDetect` (`:102-159,673-704`), and automatic-proxy coverage exercises only that WinHTTP state (`test/interceptors/system-proxy/system-proxy-winhttp.test.js:436-459`).
- Impact: WinINet clients following an existing PAC file or WPAD result can continue routing selected traffic around FreeKit while the interceptor reports active; attempting to fix this later without a saved snapshot would also risk destroying the user's automatic-proxy configuration.
- Expected: transactionally snapshot and disable WinINet automatic configuration as part of activation, include it in ownership/recovery checks, and restore it exactly on Stop—or reject activation with a clear conflict.


## Additional pass-16 findings

### BUG-560 — Low — Valid rule backups can exceed their own restore endpoint’s size limit

- Status: **Open**.
- Evidence: rule export serializes the entire accumulated mock and breakpoint collection into one `.htkrules` JSON Blob without a size check (`src/ui/app.js:9220-9236`). Restore reads and parses that complete file, then PUTs the whole collection in one request to `/api/rules` or the legacy `/api/mock-rules` path (`:9239-9317`), both behind the global 50 MiB JSON-parser ceiling (`src/api/api-server.js:1460,1660-1714,1758-1777`). Shared rule validation imposes no aggregate count or collection-size bound, and individually valid rules can be created and accumulated through separate sub-limit requests (`src/proxy/mock-rule-validation.js:326-371`; `src/api/api-server.js:1716-1756`). Backup coverage uses only small fixtures and has no aggregate boundary case (`test/mocking/rule-backup-v2.test.js`).
- Impact: FreeKit can successfully produce an advertised backup of valid rules that a fresh FreeKit instance rejects with 413 and cannot restore, defeating the backup precisely for large fixed bodies or long-lived rule collections.
- Expected: make backup and restore capacities agree through bounded streaming/batching, or enforce and clearly warn about one aggregate limit before producing an unrestorable file. This is distinct from BUG-556's HAR/traffic export and import path.


### BUG-562 — Low — Unordered settings reloads can replace newer UI state

- Status: **Open**.
- Evidence: every WebSocket config snapshot starts many unawaited settings/list loads (`src/ui/app.js:1210-1229`). TLS passthrough, client-certificate, trusted-CA, and HTTPS-whitelist loaders unconditionally render whichever GET finishes, with no generation or mutation guard (`:12211-12237,12322-12349,12435-12461,12497-12523`); successful item mutations ignore the authoritative returned collection and start another unawaited GET (`:12240-12269,12394-12431,12464-12493,12526-12555`), although the API supplies the resulting arrays (`src/api/api-server.js:2085-2108,2189-2215,2236-2276,2300-2317`). The same ordering hole affects scalar HTTP/2 and TLS-fingerprint loaders versus saves (`src/ui/app.js:12273-12318`) and API-spec loads versus upload/deletion (`:12645-12764`). Only port configuration implements load/save generations and edit-state guards (`:12127-12207`). Existing renderer coverage checks stable TLS item identities, not reordered responses (`test/settings/atomic-list-settings.test.js:67-112`).
- Impact: a slower startup/reconnect or earlier GET can finish after a newer successful save/add/remove and visually revert a scalar setting, hide an added item, or resurrect a removed certificate/host/spec until another refresh; acting on a phantom row can then yield a misleading not-found failure.
- Expected: version or cancel every affected settings load, invalidate old reads at mutation start, and use authoritative mutation responses so only the newest operation can update each control or list. This is distinct from BUG-557's breakpoint-rule loader.

### BUG-563 — Low — cURL continuation preprocessing changes quoted argument bytes

- Status: **Open**.
- Evidence: before quote-aware tokenization, `parseCurlCommand()` globally replaces every backslash followed by arbitrary whitespace and a newline with one literal space (`src/ui/curl-parser.js:112-139`). In POSIX shell syntax, an immediate backslash-newline is removed with **no** replacement when unquoted or double-quoted, while both characters remain literal inside single quotes; spaces between the backslash and newline also prevent continuation. The global regex therefore turns `--data "foo\\\nbar"` from `foobar` into `foo bar`, changes a single-quoted literal, and can greedily consume additional blank whitespace/newlines before tokenization. Existing parser coverage exercises quoting and data variants but has no continuation or quoted-newline case (`test/send/curl-parser.test.js:137-400`).
- Impact: importing a valid multiline cURL command can silently alter request bodies, headers, credentials, or URLs even though the UI reports successful parsing, producing a request different from the pasted command.
- Expected: handle immediate backslash-newline context-sensitively during tokenization—remove it only where the source shell would, without inserting a byte—and preserve single-quoted content exactly.

### BUG-564 — Low — Invalid transform payloads save successfully and silently no-op

- Status: **Open**.
- Evidence: action validation checks transform modes and broad field types but never parses a configured `json-merge` body or rejects a rewrite URL that can never resolve to supported HTTP(S) (`src/proxy/mock-rule-validation.js:140-209,263-293`); pre-step validation likewise accepts every nonempty rewrite string (`:130-137`). Both request and response editors expose JSON Merge as a normal mode (`src/ui/app.js:8057-8065,8118-8126`). At runtime `_transformMockBody()` catches malformed configured JSON and also rejects scalar/array merge values by returning the original body with `changed: false`; no failure is surfaced (`src/proxy/proxy-server.js:3353-3386`). `_resolveRewriteUrl()` converts every malformed or unsupported rewrite into `null`, after which transform actions and both pre-step engines retain the original URL (`:3316-3324,3388-3444,7123-7132,9395-9402`). There is no invalid-transform/rewrite save or import regression.
- Impact: rules reported as valid, saved, and enabled can leave bodies or URLs unchanged for every matching request without any Traffic diagnosis or editor warning, making a broken test transformation look as though it ran.
- Expected: validate configured JSON merge syntax and object shape plus statically invalid/unsupported rewrite targets during create, update, import, and restoration; if a request-dependent transform still fails at runtime, expose an explicit action failure. This is distinct from BUG-551's matcher validation and BUG-529's Forward/Webhook destinations.

### BUG-565 — Low/Medium — Response capture looks up transformed semantic headers case-sensitively

- Status: **Open**.
- Evidence: `_applyMockHeaderTransform()` removes prior fields case-insensitively but stores replacements with the user-supplied spelling (`src/proxy/proxy-server.js:3326-3351`), and response transforms preserve that map (`:3447-3488`). Response-breakpoint edits likewise copy submitted header keys verbatim (`:10683-10765`). Final plain H1, intercepted-H1, native-H2, and H1-on-H2 capture paths then pass only literal lowercase `responseHeaders['content-encoding']` and `['content-type']` into `_safeBodyString()` (`:4738-4770,5754-5784,6310-6344,6760-6793`), despite the module's existing case-insensitive multi-value helper (`:147-157`). `_safeBodyString()` relies on those values for decompression, decoded-body provenance, and image/Protobuf representation (`:10334-10410`). Existing transform/breakpoint coverage uses lowercase semantic header names or does not assert captured representation.
- Impact: a valid edit such as `Content-Encoding: gzip` or `Content-Type: image/png` is delivered with that spelling but capture can retain compressed bytes or label binary content generically; Traffic, MCP, and exports then describe or expose a different body representation from the response sent to the client.
- Expected: retrieve all semantic response headers case-insensitively through the shared repeated-value policy before body normalization, across every protocol and breakpoint/transform path. This is distinct from BUG-495's array-value crash and BUG-537's renderer/trailer lookups.

## Additional pass-17 findings

### BUG-566 — Low — Invalid explicit update feeds silently fall back to the default publisher

- Status: **Open**.
- Evidence: the updater advertises `UPDATE_URL` as its configurable feed override (`electron/updater.cjs:5-10`). `getWebUrl()` maps malformed, empty, and non-HTTP(S) values to the same `null` as absence (`:125-137`); initialization then skips `setFeedURL()` with no warning and leaves electron-updater on the packaged/default provider (`:415-446`). Regression coverage explicitly supplies malformed, `file:`, and `javascript:` overrides, asserts that no custom feed is set, and routes Linux users to the project's default release page without a diagnostic (`test/desktop/linux-custom-update-feed.test.js:231-250`).
- Impact: a deployment that intends to pin updates to a controlled feed can unknowingly check, advertise, and on supported platforms download from the default publisher after a typo or unsupported URL, violating its update-source policy while appearing normally configured.
- Expected: distinguish absence from an explicit invalid override, report the configuration error at startup, and disable update checks rather than silently falling back. This is analogous to but distinct from BUG-561's proxy-listener override.


## Additional pass-18 findings


## Additional pass-19 findings

### BUG-569 — Low — Failed MCP SSE admission drops the only cleanup ownership

- Status: **Open**.
- Evidence: the SSE GET route creates a per-session transport and server, records both, then handles `server.connect(transport)` rejection by only logging and deleting the map entry (`src/mcp/mcp-server.js:1123-1149`). The bundled SDK's `connect()` takes ownership of the transport before awaiting `transport.start()` (`node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js:210-247`). SSE startup writes the 200 stream and endpoint before recording its response/close handler, while explicit `close()` is the operation that ends a recorded response (`node_modules/@modelcontextprotocol/sdk/dist/esm/server/sse.js:49-77,145-149`). The product's Stop path can close only sessions still in `sseSessions` or its retained cleanup queue (`src/mcp/mcp-server.js:1223-1269`); the rejection branch places the failed resources in neither. Existing MCP tests exercise successful SSE connections and other transport cleanup paths, not SSE `connect()` rejection.
- Impact: a response-write or transport-start failure can leave a partially opened SSE GET and its per-session server/transport unclosed; removing the entry also makes later MCP disable or shutdown unable to reclaim it.
- Expected: on connection failure, explicitly close the server and transport, end/destroy the HTTP response as needed even when transport startup did not finish, and retain any failed cleanup resource for Stop to retry.

### BUG-570 — Low — Aggregate interceptor refreshes can overwrite newer live status events

- Status: **Open**.
- Evidence: `loadInterceptors()` performs an unversioned GET whose completion replaces the complete renderer snapshot (`src/ui/app.js:5268-5275,5504-5511`). Live `interceptor-status` messages independently patch that same snapshot (`:1269-1271,5513-5537`), while startup/reconnect, fallback events, and delayed post-operation refreshes can all start aggregate loads without a load/event generation (`:1210-1229,5513-5522,6617-6620,6660-6669`). The backend builds the GET response by awaiting each interceptor sequentially (`src/api/api-server.js:1587-1595`; `src/interceptors/interceptor-manager.js:180-192`), so one state can be sampled before a transition event while later interceptors delay the now-stale aggregate response. Existing renderer and backend tests cover operation locking and status broadcasts separately, not an older aggregate completion after a newer event (`test/interceptors/core/interceptor-activation-lock.test.js:16-34`; `test/interceptors/core/interceptor-status-broadcasts.test.js:175-207`).
- Impact: a newly active interceptor can disappear from Connected Sources or appear stopped, while a newly stopped interceptor can reappear active; card actions can then fail or no-op until another refresh or transition repairs the display.
- Expected: associate aggregate snapshots and status transitions with monotonic revisions, or invalidate/merge every outstanding aggregate load when a newer status event is applied. This is distinct from BUG-562's settings read/write races.

## Additional pass-21 findings

### BUG-571 — Low — Editing a resent binary body cannot change it out of base64 mode

- Status: **Open**.
- Evidence: `resendResolvedRequest()` validates and copies a capture's `requestBodyEncoding` into the new Send tab (`src/ui/app.js:2620-2643,2684-2697`). Thereafter `getActiveSendBodyEncoding()` trusts that retained tab flag (`:2584-2588`); Monaco edits only copy text to the fallback and refresh export, while fallback input likewise only refreshes export (`:9562-9570`; `src/ui/index.html:287-290`). Saving explicitly preserves `base64` whenever the previous flag is base64 and the body type remains raw (`src/ui/app.js:10596-10614`), but the UI offers body type and syntax format with no encoding control (`src/ui/index.html:263-290`). Send and export therefore continue down the binary path; ordinary replacement text is rejected as a noncanonical data URI (`src/ui/app.js:3770-3815,10949-10962`). Existing binary regressions cover unchanged exact replay and malformed captured/base64 data, not editing a valid binary tab into text (`test/send/resend-binary-body.test.js:252-317`).
- Impact: the normal edit-and-resend workflow for any binary capture becomes invisibly locked to the original data-URI representation; replacing it with valid text cannot be sent or exported until the user creates a fresh tab or triggers an unrelated full-tab replacement.
- Expected: expose an explicit encoding choice or transition the raw editor to UTF-8 when its binary representation is replaced, while retaining byte-exact base64 semantics for untouched captures.

### BUG-572 — Medium — WebSocket capture failures permanently disable one direction without disclosure

- Status: **Open**.
- Evidence: compressed WebSocket capture serializes asynchronous decoding behind one queue (`src/proxy/proxy-server.js:4042-4065`). When a direction reaches 64 pending messages or its pending-byte ceiling, `enqueue()` sets `state.disabled = true` and returns, but the drain path only decrements counters and never clears that flag (`:4066-4103`). The frame parser independently clears its buffers and permanently sets `_disabled` when it sees an oversized frame/message, excessive fragments, malformed fragmentation/control framing, or unsupported reserved bits (`src/proxy/ws-frame-parser.js:228-317`). Relay callbacks swallow those parser errors and continue forwarding/counting all wire bytes (`src/proxy/proxy-server.js:4108-4137`), while the final connection update offers no truncation/omission marker (`:4139-4159`). Tests require permanent parser disable and cover small successful decode queues, but not integrated omission disclosure or overload recovery (`test/proxy/websocket/ws-frame-buffering.test.js:9-18`; `test/proxy/websocket/websocket-fragmentation.test.js:82-130`; `test/proxy/websocket/websocket-compression.test.js:212-419`).
- Impact: one short decompression backlog or one uncapturable frame on a long-lived socket silently removes every later frame in that direction from Traffic, search, MCP, and exports; the parent summary still includes their wire bytes, so it looks complete while the inspectable message history is permanently partial.
- Expected: apply bounded backpressure or resume capture where framing permits; whenever capture must remain disabled, track the omitted counts/bytes and mark the connection and exports explicitly truncated. This is distinct from rejected-upgrade truncation in BUG-548 and display counting in BUG-516.

### BUG-573 — Medium — Mock Close and Reset actions do not implement their advertised distinction

- Status: **Open**.
- Evidence: the editor says Reset sends an immediate TCP RST while Close performs graceful shutdown (`src/ui/app.js:8137-8139`). In intercepted H1, Close calls `res.destroy()` and Reset calls `res.socket?.destroy()` (`src/proxy/proxy-server.js:5328-5357`); plain/fallback H1 has the equivalent `clientRes.destroy()` versus `clientRes.socket?.destroy()` (`:9422-9453`). A response destroy delegates to the same underlying socket-abort behavior, and no `resetAndDestroy()` or orderly `end()` implementation distinguishes them. Native H2 is explicit: both action types execute the identical `stream.destroy()` branch (`:7150-7163`). Existing mock-action coverage checks H1 fallback delegation and traffic lifecycle, not FIN-versus-RST or H2 error-code behavior (`test/mocking/h1-h2-mock-actions.test.js:5-33`; `test/traffic/pending-traffic-lifecycle.test.js:246-247,485-486`).
- Impact: two separately selectable network-failure simulations behave alike; clients cannot test graceful peer closure versus an immediate reset, and captures merely label identical transport behavior differently.
- Expected: make Close perform an orderly protocol shutdown and make Reset use the platform's explicit RST/error primitive (`resetAndDestroy()` for TCP where supported and an intentional nonzero H2 reset code), with wire-level regressions. This is distinct from BUG-510's ignored Close delay.

## Additional pass-23 findings

### BUG-574 — Low/Medium — Some Traffic selection paths bypass retained-row hydration

- Status: **Open**.
- Evidence: size-bounded Clear and traffic-dump messages can retain or restore exchanges as sparse `_deferredTrafficDetail` stubs (`src/ui/app.js:955-976`; `src/api/api-server.js:3631-3651`). Mouse selection detects such a stub, hides the active detail view, and hydrates the exact exchange before rendering it (`src/ui/app.js:1975-2008,2013-2127`). Keyboard row navigation instead assigns the sparse request and calls `showDetail(req)` directly (`:11715-11736`), via the active Traffic shortcuts (`:14138-14153`). Reconnect dump restoration likewise calls `showDetail(selectedRequest)` directly for a still-selected summarized row (`:495-508,551-610,1178-1208`). `showDetail()` immediately formats fields that a stub does not contain (`:2149-2168`). Existing keyboard regressions use ordinary complete rows only (`test/traffic/traffic-grid-focus.test.js:238-280`), and traffic-dump tests do not retain a selected deferred row.
- Impact: after Clear or a same-session reconnect, keyboard navigation or dump restoration can open an empty or misleading detail view, including an `undefined` title, while pointer-selecting the same row correctly loads the exchange.
- Expected: centralize all selection and selected-row restoration through one helper that performs deferred hydration before rendering details.

### BUG-575 — Low — Corrupt renderer-owned JSON is silently discarded and overwritten

- Status: **Open**.
- Evidence: the renderer has an explicit stored-workspace rejection warning (`src/ui/app.js:10093-10097`), and `restoreSendTabs()` requests invalid-state reporting at startup (`:10653-10674`). `readStoredSendWorkspace(true)` does report parsed-but-invalid content, but silently swallows JSON parse failures for both current and legacy storage before returning an empty workspace (`:10277-10295`). A later edit again reads that empty fallback, merges the live tab into it, and replaces the corrupt current-format value (`:10470-10540`). Recovery journals encode unsent tab upserts and deletion tombstones (`:10351-10384`), yet their loader likewise swallows malformed JSON and immediately deletes every unparsable, invalid, or key-mismatched entry (`:10392-10418`). Protobuf schema loading silently maps malformed JSON or a non-array value to an empty collection, and the next ordinary import builds from and persists that replacement (`:4179-4204,4214-4235`). Malformed custom-theme JSON is also ignored without a diagnostic (`:14778-14802`). Coverage asserts a warning for parsed invalid Send methods and silent fallback for malformed workspace JSON, but not preservation or informed recovery; journal and schema tests cover valid replay/import atomicity rather than corrupt durable bytes (`test/send/send-tab-storage.test.js:124-133,222-229`; `test/send/send-unload-persistence.test.js:145-337`; `test/ui/protobuf-schema-import-atomic.test.js:77-134`).
- Impact: truncated or partially written local storage can make saved request drafts, unsent edits, deletion recovery, imported Protobuf schemas, or a custom theme disappear with no explanation. Startup can destroy a corrupt Send journal immediately, while the next ordinary edit or schema import can overwrite bytes that might otherwise have been inspected or recovered.
- Expected: report parsing and structural failures, preserve or quarantine corrupt renderer-owned values, and require an explicit reset or recovery decision before deleting or overwriting them. This is distinct from BUG-479 and BUG-497, which concern backend settings and desktop preferences.


### BUG-577 — Low/Medium — Buffered downstream disconnects leave stale or false traffic records

- Status: **Open**.
- Evidence: the buffered plain-H1, intercepted-H1, native-H2, and H1-on-H2 paths create downstream cancellation trackers and emit Pending lifecycles before ordinary forwarding (`src/proxy/proxy-server.js:4454-4465,4648-4658,5217-5235,6201-6217,6649-6664`). Once a tracker aborts, their response and error continuations return without a terminal traffic update (`:4663-4697,4790-4798,5816-5831,5868-5905,6371-6389,6429-6466,6821-6836,6871-6915`). Non-webhook mock pre-step/action delays expose the same missing terminalizer: the shared wait is a bare timer unless given webhook-only preparation, and intercepted H1 duplicates bare timers (`:3530-3547,5279-5286,5360-5363,7108-7115,7166-7169,9376-9383,9456-9459`). After a disconnect, common H1 blindly writes and emits `Mocked`, while native H2 skips the closed stream write but still emits `Mocked` (`:9875-9912,7485-7515`); plain H1 had no Pending row, so it can create a ghost success, while the intercepted paths replace Pending with a false success or leave it Pending if a dead write throws. Terminal emission is what removes the proxy's stored decision (`:10004-10212`) and completes the API's pending identity (`src/api/api-server.js:3352-3371,3430-3569`). Existing downstream-cancellation coverage exercises streaming and checks origin cancellation only (`test/proxy/core/downstream-cancellation.test.js:57-95`); timeout, breakpoint, and serve-file paths have explicit disconnect terminalizers.
- Impact: disconnecting during buffered handling can leave a false Pending row indefinitely, create a completed exchange that was never delivered, and retain otherwise unbounded proxy/API lifecycle bookkeeping. Repeated aborted requests can accumulate stale state, while delayed mock captures can claim success after the client has gone.
- Expected: give every buffered downstream-abort path one idempotent terminalizer that cancels outstanding delays, records Client Disconnected, and clears its pending decision and API lifecycle without attempting another downstream write or emitting a configured success. This is distinct from BUG-490's missing oversized-request record and BUG-524's forced response buffering.

## Additional pass-24 findings

### BUG-578 — Medium — Resend and exporters silently discard intentional end-to-end request headers

- Status: **Open**.
- Evidence: export normalization removes every `Host` field before format-specific generation (`src/ui/request-export.js:41-52`). This affects cURL, wget, PowerShell, PHP, Python, Go, and Node, even though only browser Fetch is unable to set that forbidden header; the Node generators then explicitly substitute the URL authority (`:330-351,559-567`). Resend drops `Host` while constructing the new Send tab and also unconditionally drops end-to-end `Accept-Encoding` alongside hop-by-hop and framing fields (`src/ui/app.js:2643-2660`); the Send backend otherwise preserves caller-supplied headers (`src/api/api-server.js:3150-3183`). Tests codify `Host` absence as an ignored header rather than covering a URL whose authority intentionally differs from the captured host, and do not cover Resend's `Accept-Encoding` loss (`test/import-export/repeated-export-headers.test.js:69-100,148-155`; `test/send/repeated-send-headers.test.js:151-200`).
- Impact: virtual-host routing, reverse-proxy tests, signature inputs, and origin behavior can change silently when a captured request used an intentional `Host` override. Resend can additionally negotiate an identity response instead of the captured compression/cache variant. The generated or resent request is presented as a replay but targets different application semantics.
- Expected: preserve one valid `Host` value in Resend and every exporter whose runtime permits it, and preserve `Accept-Encoding` in Resend; Fetch should explicitly refuse exact replay or disclose the browser rewrite. This is distinct from BUG-485, which covers other browser-forbidden fields that Fetch currently retains.


### BUG-580 — Low — Desktop “New Session” is only a duplicate Reload command

- Status: **Open**.
- Evidence: the File menu labels an action “New Session,” but its handler only reloads the existing renderer (`electron/menu.cjs:42-55`). The separate View > Reload action performs the identical `webContents.reload()` operation (`:73-84`), and the README presents both menu families without explaining that no new session exists (`README.md:196-204`). The menu regression explicitly requires both handlers to reload and never asserts a new backend session, traffic reset, or isolated window (`test/desktop/electron-menu-shortcuts.test.js:8-18`).
- Impact: users can choose New Session expecting a clean or isolated capture and unknowingly continue with the same traffic, rules, settings, and backend session, mixing work they intended to separate.
- Expected: implement a defined fresh-session/reset workflow with appropriate unsaved-work handling, or relabel/remove the command so it does not promise behavior identical to Reload.

## Additional pass-25 findings

### BUG-581 — Medium — Windows uninstall leaves FreeKit's private root CA trusted and its signing key on disk

- Status: **Open**.
- Evidence: desktop startup places the generated CA certificate and key under persistent per-user application data, then installs that CA into the Windows CurrentUser Root store on every launch (`src/index.js:33-37,64-85`). The trust helper only installs the current root and removes exact fingerprints from CA-replacement journals; it exposes no removal path for the current root (`src/proxy/windows-ca-trust.js:24-60`). The NSIS configuration supplies no include/custom-uninstall macro and does not enable application-data deletion (`electron-builder.config.cjs:61-68`). The bundled builder defaults `deleteAppDataOnUninstall` to false and invokes certificate-aware uninstall behavior only when an application supplies a `customUnInstall` macro (`node_modules/app-builder-lib/scheme.json:4270-4274`; `node_modules/app-builder-lib/templates/nsis/uninstaller.nsh:156-157,216-243`). No other uninstall cleanup exists in the repository.
- Impact: a normal Windows uninstall leaves both an active trusted interception root and its signing private key behind. Software running under that user can continue minting certificates the user's browsers and other CurrentUser-trusting clients accept, even though the product that established the trust relationship is gone.
- Expected: on a true uninstall—not an updater's replace-in-place cycle—remove the exact current FreeKit root fingerprint from the CurrentUser Root store and offer or perform coordinated deletion of its private key and data directory. Preserve both during ordinary updates. This is distinct from BUG-491's missing-certificate regeneration residue and BUG-559's permissions on retained secret files.

## Additional pass-26 findings


## Additional pass-27 findings


### BUG-584 — Low/Medium — Generated Node.js snippets change case-sensitive extension methods

- Status: **Open**.
- Evidence: both multipart and raw Node.js generators feed the captured method directly to ordinary `http(s).request()` (`src/ui/request-export.js:350-351,561-567`). The product's own exact-method helper documents that Node's `ClientRequest` uppercases extension tokens, then reassigns both `request.method` and `useChunkedEncodingByDefault` before the request line is generated (`src/proxy/proxy-server.js:464-475`); the generated snippets omit both repairs. Product coverage proves that body-bearing `gEt` is distinct from GET and must reach the wire unchanged (`test/send/custom-methods.test.js:315-397`), while exporter coverage with a mixed/punctuation token checks only generated text and compilation (`test/import-export/export-snippet-escaping.test.js:15-54`).
- Impact: an advertised replay can turn a case-sensitive extension token into a standard method such as GET, changing routing and matching; without explicit framing it can also inherit GET's body-framing decision and transmit a different or invalid request.
- Expected: generate the same post-construction exact-method and framing repair used by the proxy, or disclose that exact Node.js replay is unavailable. This is distinct from BUG-445's retry eligibility, BUG-504's matcher/filter case folding, BUG-517's editor representation, and BUG-547's breakpoint editing.

### BUG-585 — Low/Medium — Expired persisted CAs remain active and continue signing certificates

- Status: **Open**.
- Evidence: product startup disables automatic expiry renewal with `ca.initialize({ autoRenewExpiring: false })` (`src/index.js:64-68`). `CertificateAuthority.initialize()` treats an already-expired identity like one merely inside the renewal window and retains either when automatic renewal is disabled (`src/proxy/certificate-authority.js:86-117`); `_validateCaPair()` checks not-before but never rejects an expired `notAfter` (`:411-435`). New leaf certificates are still issued for a full year from the current time and signed by that expired issuer (`:507-569`). The only remediation is inside TLS Settings, where the renderer says replacement is paused and offers scheduling for the next restart (`src/ui/app.js:11115-11154`); startup emits only the generic near-expiry warning.
- Impact: strict TLS clients that enforce issuer validity reject intercepted HTTPS until the user discovers the TLS settings, schedules renewal, and restarts. Trust-anchor expiry behavior differs between clients, so other clients may continue accepting the stale identity and mask the failure.
- Expected: distinguish expired from merely near-expiry CAs; automatically replace an expired identity, or block affected interception/startup with prominent immediate remediation. This is distinct from BUG-491's missing-certificate regeneration residue, BUG-559's permissions, and BUG-581's uninstall residue.


## Additional pass-29 findings


### BUG-588 — Low/Medium — Manual Electron setup omits main-process proxy and CA configuration

- Status: **Open**.
- Evidence: the documented generic activation API passes its body directly to the selected interceptor (`README.md:287-288`; `src/api/api-server.js:1597-1603`). With a missing/empty `appPath`, Electron activation intentionally returns a manual command containing only Chromium's `--proxy-server` and optional scoped-SPKI flags (`src/interceptors/electron-interceptor.js:85-99,581-590`). Automatic launching separately obtains the combined CA bundle and injects `HTTP_PROXY`, `HTTPS_PROXY`, both lowercase spellings, cleared `NO_PROXY`/`no_proxy`, `NODE_USE_ENV_PROXY=1`, and `NODE_EXTRA_CA_CERTS` before spawning (`:101-145,593-607`). Manual regressions explicitly require only the Chromium flags, while automatic main-process TLS coverage exercises the environment path (`test/interceptors/electron/electron-launch-args.test.js:51-64`; `test/interceptors/electron/electron-renderer-certificate-scope.test.js:46-63`; `test/interceptors/electron/electron-main-tls.test.js:139-178`).
- Impact: following FreeKit's returned manual setup captures Chromium renderer requests, but Electron main-process Node `http`/`https` traffic is neither routed through FreeKit nor given its CA. Users receive silently incomplete interception.
- Expected: return platform-appropriate manual launch instructions that reproduce the automatic environment, including both proxy spellings, cleared bypasses, `NODE_USE_ENV_PROXY`, the additive CA bundle, and any supported-Node caveat. This is distinct from BUG-481's Chromium loopback bypass, BUG-507's post-spawn stability, BUG-534's terminal/Docker trust-root contents, and BUG-468's dead compatibility paths.

## Additional pass-30 findings

### BUG-589 — Low/Medium — Manual non-Windows CA trust can never unlock Global Chrome interception

- Status: **Open**.
- Evidence: startup sets `ca.systemTrustInstalled = true` only after successful Windows trust-store installation, while every non-Windows startup unconditionally sets it to false (`src/index.js:81-105`). Global Chrome requires that in-memory flag both for availability and activation (`src/interceptors/existing-browser-interceptor.js:36-38,402-406`), and no later assignment or manual-trust acknowledgement exists. This conflicts with the documented manual OS/browser trust workflow (`README.md:311-317`), the platform-neutral Global Chrome UI (`src/ui/app.js:5295-5298`), and explicit macOS Global Chrome lifecycle coverage (`test/interceptors/browser/browser-restart-ownership.test.js:189-218`).
- Impact: macOS and Linux users can correctly install the CA yet Global Chrome remains unavailable; only isolated-browser alternatives work.
- Expected: detect or explicitly acknowledge manual trust on supported platforms, or clearly restrict and hide Global Chrome as Windows-only. This is distinct from BUG-441's Firefox NSS prerequisite, BUG-471's bind-address failure, and BUG-588's manual Electron environment omission.


### BUG-591 — Low — Synthetic proxy error captures disagree with the response sent on the wire

- Status: **Open**.
- Evidence: intercepted-H1 and common-H1 mock-forward setup and delivery failures send a nonempty `text/plain` error response, then capture the same body with `responseHeaders: {}` and `responseBodySize: 0` (`src/proxy/proxy-server.js:5377-5390,5432-5445,9475-9487,9533-9545`). Native H2 repeats the zero-size mismatch (`:7183-7198,7245-7257`); ordinary buffered proxy failures do likewise (`:4802-4825`); and streaming finalizers synthesize a `Proxy Error` body while their byte counter remains zero (`:1434-1451,2033-2055`). Mock-forward coverage checks the client-visible error text but not the recorded headers or size (`test/mocking/mock-forward-upstream.test.js:513-536`).
- Impact: Traffic statistics, HAR, JSON, and MCP data report a zero-byte response and can omit a wire header despite showing or exporting the real body delivered to the client, corrupting byte metrics and replay metadata exactly on failure paths.
- Expected: build the wire response and capture from one normalized representation and record the actual delivered headers and byte length. This is distinct from BUG-541's body-forbidden responses, BUG-548 and BUG-572's undisclosed truncation, and BUG-576's serve-file media-type loss.

## Additional pass-31 findings


### BUG-593 — Low — Send accepts invalid destinations and reports them as internal failures

- Status: **Open**.
- Evidence: `sendRequest()` trims the destination but checks only that it is nonempty; its button and Ctrl+Enter handlers bypass the `<input type="url">` element's constraint validation (`src/ui/app.js:10969-11016`; `src/ui/index.html:239-243`). The cURL parser likewise accepts the first non-option destination verbatim, and paste stores it unchanged while reporting “cURL command parsed!” (`src/ui/curl-parser.js:159-255`; `src/ui/app.js:10770-10803,15015-15029`). Backend Send then applies `new URL(url)` and an HTTP(S)-only check (`src/api/api-server.js:3150-3160`), but the route maps only body/method validation codes to 400 and returns 500 for malformed or unsupported destinations (`:2522-2555`). Thus common cURL-valid schemeless targets such as `example.com/path` or `localhost:3000` are accepted by import yet cannot be sent, and direct destination typos are classified as server faults. Existing cURL fixtures use absolute URLs, and no Send test covers a malformed, schemeless, or unsupported destination.
- Impact: a successful cURL import can produce an unusable request, while users and API clients receive a misleading internal-server failure for ordinary input mistakes.
- Expected: apply cURL's supported scheme inference during import or reject before success; prevalidate an absolute HTTP(S) URL in the direct UI; and return a JSON 400 for every malformed or unsupported Send destination. This is distinct from BUG-475's port-zero routing, BUG-496's IPv6 transport, BUG-529's mock destinations, and BUG-563/BUG-579's other paste semantics.

### BUG-594 — Low — Timed raw-tunnel classification creates false and frozen captures

- Status: **Open**.
- Evidence: intercepted H1 starts a five-second timer and emits a completed `Raw Tunnel` record whenever no parsed HTTP request has arrived, regardless of whether the connection is merely idle or a request is still arriving (`src/proxy/proxy-server.js:5130-5153`). A later request or upgrade only clears the already-fired timer and proceeds with a separate real exchange; it never retracts or updates the tunnel row (`:5156-5168,6004-6013`). The emitted byte counts are a one-time snapshot, and `tunnelBytesOut` is initialized and recorded but never incremented. Native H2 repeats the timer with permanently zero byte counts (`:6060-6086`); later H2 streams, H1 fallback requests, or upgrades clear the timer but do not reconcile an already emitted row (`:6104-6110,6585-6591,7018-7024`). No regression delays the first parsed request beyond the classification deadline or checks continued raw-tunnel byte accounting.
- Impact: a valid slow or initially idle HTTP client can create both a misleading Raw Tunnel entry and its eventual real exchange. Genuine long-lived raw traffic is frozen at its five-second byte snapshot, corrupting Traffic counts, statistics, filters, and exports.
- Expected: keep tunnel classification provisional until close or definitive protocol activity, then update/remove it when HTTP is recognized; for genuine raw tunnels, track both directions through termination and publish current or final byte counts. This is distinct from BUG-484, which concerns rendering an already captured failed tunnel as HTTP 200.

## Additional pass-32 findings

### BUG-595 — Medium — Multipart Send exhausts renderer memory before a predictable size rejection

- Status: **Open**.
- Evidence: multipart file controls impose no per-file or aggregate size limit, and selection retains each unrestricted `File` (`src/ui/app.js:9726-9733,9780-9787`). Sending reads every enabled file completely with `arrayBuffer()`, retains those byte chunks, and allocates a second aggregate `Uint8Array` (`:9851-9895`). It then constructs a whole binary string and base64 string, embeds that expanded body in another JSON string, and posts it to the API (`:9840-9849,10926-10946,10969-11005`). The API's JSON parser has a fixed 50 MiB input ceiling (`src/api/api-server.js:1453-1461`), so multipart bytes around 37.5 MiB already exceed it after base64 and JSON overhead. Existing multipart tests cover cancellation, fidelity, and restored file selection, but no size boundary or allocation ceiling (`test/send/multipart-preparation-abort.test.js:122-185`; `test/send/send-tab-storage.test.js:136-146`).
- Impact: an ordinary large file is guaranteed to fail only after several simultaneous full-size renderer allocations; larger selections can stall or exhaust the renderer before the server returns its unavoidable payload-too-large response. The UI provides no advance limit or actionable size diagnostic.
- Expected: preflight the aggregate encoded request against the management limit before reading files, with an explicit user-facing error, or stream multipart data to a bounded backend upload path instead of materializing and base64-wrapping it. This is distinct from BUG-556's HAR processing ceiling and BUG-593's destination/error classification.

### BUG-596 — Low — The documented unpackaged desktop updater action is inert

- Status: **Open**.
- Evidence: the Desktop App quick start documents `npm run electron` (`README.md:35-40`), while desktop startup always initializes the updater and its scheduled checks (`electron/main.cjs:677-689`; `electron/updater.cjs:415-453,594-607`). Whenever the Electron bridge exists, the renderer exposes and reveals “Check for Updates” (`src/ui/app.js:15004-15011`; `src/ui/index.html:647`). In an unpackaged run, the bundled updater's `isUpdaterActive()` is false and `checkForUpdates()` returns a resolved `null` without emitting checking, up-to-date, or error (`node_modules/electron-updater/out/AppUpdater.js:251-281`). FreeKit's wrapper consequently settles with `statusReported` false and publishes no feedback (`electron/updater.cjs:294-320`). Existing updater harnesses set `isPackaged: true` (`test/desktop/updater-check-attribution.test.js:53-55`; `test/desktop/updater-startup-timer.test.js:72-75`).
- Impact: the update button shown by the documented source desktop mode silently does nothing, and its automatic timers repeatedly perform equally inert checks. Developers cannot tell whether the action succeeded, failed, or was unsupported.
- Expected: hide or disable update controls and schedules when the updater is inactive, or publish a clear manual status explaining that update checks require a packaged build. This is distinct from BUG-443's missing architecture awareness, BUG-512's Linux URL fallback, and BUG-566's dismissed-update replay.

## Additional pass-33 findings

### BUG-597 — Low — A stale Send window can silently overwrite another window's active-tab edit

- Status: **Open**.
- Evidence: a Send-workspace storage event replaces `sendTabs` with the newly stored models (`src/ui/app.js:10557-10564,10581-10593`), but it reloads the visible editor only when the active tab ID has disappeared (`:10571-10578`). When another window updates the same active tab, this window therefore shows its old controls over the newly replaced model. The next capture copies those stale controls back into that model and persists it (`:10596-10623`); switching, adding, or closing a tab, a successful Send, and unload all trigger such capture/save paths (`:10626-10650,10806-10827,11081`). The cross-window lock is documented as making tab-level sharing safe (`:10274-10276`), but concurrency tests stub `loadSendTabState()` and cover separate-tab merges and deletion rather than same-active-tab synchronization or conflicts (`test/send/send-tab-concurrency.test.js:58-97,122-207`).
- Impact: one window's valid saved edit can be invisibly reverted when a stale second window next performs an ordinary Send/tab action or closes. The receiving UI gives no indication that its displayed controls and underlying tab model diverged.
- Expected: track per-tab dirty/version state and refresh a clean active editor from remote storage, or preserve the local draft and surface a resolvable conflict before either version is persisted. This is distinct from BUG-500's same-renderer Send concurrency, BUG-562's settings reload races, and BUG-575's corrupt-storage recovery.


## Additional pass-34 findings

### BUG-599 — Low — Incoming response normalization loses repeated header fields

- Status: **Open**.
- Evidence: the proxy's shared incoming-header helper seeds its result from Node's normalized `message.headers` and consults `rawHeaders` only for names absent from that map (`src/proxy/proxy-server.js:3200-3224`). It therefore does not recover distinct field instances that Node has already joined or duplicate singleton fields it discarded; streaming, buffered, intercepted, H2-fallback, and rejected-upgrade response paths use that helper for forwarding and capture (`:1483-1513,2301-2309,3788-3805,4702-4713,5910-5918,6920-6928`). Send is independently lossy: `_sendRequest()` returns `res.headers` directly, and the renderer treats it as authoritative for inline display and response context (`src/api/api-server.js:3284-3314`; `src/ui/app.js:11007-11023,11046-11063`). The supported Node baseline exposes `rawHeaders` and `headersDistinct` (`package.json:42-43`), while existing repeated-header Send coverage verifies only outbound request fields (`test/send/repeated-send-headers.test.js:82-115`).
- Impact: repeated response-field boundaries can be merged ambiguously, and a duplicate singleton field can disappear from the response forwarded or shown by FreeKit. Traffic, Send inspection, export, and downstream behavior can therefore differ from the origin's actual header block.
- Expected: construct the response map from `headersDistinct` or `rawHeaders`, preserving ordered repeated values as arrays, then derive forwarding and capture from that one lossless representation. This is distinct from BUG-502's mock-editor flattening, BUG-537's renderer lookup/copy semantics, and BUG-565's semantic-header lookup.

## Additional pass-35 findings

### BUG-600 — Low — Permanent Send-tab tombstones grow local persistence without bound

- Status: **Open**.
- Evidence: stored Send workspaces retain every valid `deletedTabIds` entry, and normalization only deduplicates them (`src/ui/app.js:10256-10271`). Merging copies the complete existing tombstone set and can only add deletions; there is no acknowledgement, expiry, or compaction path (`:10274-10320`). Every tab close records another deletion (`:10826-10853`), while new IDs deliberately avoid all tombstones and normally use fresh UUIDs (`:10194-10226`). Each subsequent operation serializes and rewrites the entire accumulated workspace (`:10470-10510`). Concurrency and restart tests require tombstones to defeat stale writes and survive journal replay but cover no bounded reclamation scheme (`test/send/send-tab-concurrency.test.js:176-207`; `test/send/send-unload-persistence.test.js:282-315`).
- Impact: ordinary create/close churn monotonically increases both the localStorage record and every future persistence write. Under any finite renderer storage quota, the application's own history can eventually prevent otherwise small unsent tabs and edits from being saved.
- Expected: retain deletion ordering only while a stale writer can still exist, then safely compact acknowledged or expired tombstones through bounded generations, renderer leases, or an equivalent coordination scheme. This is distinct from BUG-575's corrupt-JSON recovery and BUG-597's stale-active-tab overwrite.

## Verification notes

- Easiest-bug pass resolved and removed: BUG-438, BUG-439, BUG-443, BUG-445, BUG-446, BUG-447, BUG-455, BUG-457, BUG-459, BUG-462, BUG-465, BUG-473, BUG-482, BUG-487, BUG-492, BUG-493, BUG-505, BUG-508, BUG-509, BUG-510, BUG-511, BUG-514, BUG-516, BUG-518, BUG-519, BUG-543, BUG-545, BUG-555, BUG-559, BUG-561, BUG-567, BUG-568, BUG-576, BUG-579, BUG-582, BUG-583, BUG-586, BUG-587, BUG-590, BUG-592, BUG-598.
- Final verification used the repository-pinned Node 26.7.0 runtime: the complete test suite passed 2,221/2,224 tests with 3 skipped and 0 failures, and syntax validation passed for all 491 JavaScript/CJS files.
