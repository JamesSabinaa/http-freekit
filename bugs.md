# Bug audit

Audit baseline: `5f10ce5`. Findings describe the current implementation; this audit does not apply fixes. Similar findings are grouped, with related triggers documented together. Review focuses on functional behavior; already-confirmed findings are retained even if they also have security implications.

Findings: **31 groups — 1 High, 22 Medium, 8 Low**.

## Audit progress

Completion requires two consecutive entire-project passes with no new confirmed bugs. A pass covers application source, desktop integration, build/configuration, and relevant tests; dependencies and generated artifacts are not treated as project source. Platform-specific behavior is inspected statically or with isolated probes where the host cannot exercise it.

| Pass | Coverage / method | New bugs | Status |
| --- | --- | --- | --- |
| 1 | Complete source review of proxy, UI, interceptors, API/MCP, desktop, build/configuration, and relevant tests; focused reproduction probes | 12 grouped bugs | Complete |
| 2 | Fresh review of every subsystem, emphasizing state transitions, data round trips, and contracts between components | 3 (BUG-013–015) | Complete |
| 3 | Feature-path and regression-coverage review across every subsystem | 1 (BUG-016) | Complete |
| 4 | Fresh review of feature interactions, state ownership, cancellation, and ordinary failure/recovery paths across every subsystem | 1 (BUG-017) | Complete |
| 5 | Fresh interface and ordinary edge-case review across every subsystem | 3 (BUG-018–020), plus the SVG variant of BUG-006 | Complete |
| 6 | Comprehensive repeat review of main/alternate paths, component contracts, and regression gaps across the complete inventory | 1 (BUG-021, three related settings flows) | Complete |
| 7 | Fresh complete review of functional paths, cross-component consistency, and ordinary failure/recovery behavior | 2 (BUG-022–023), plus the restored-selection variant of BUG-008 | Complete |
| 8 | Full inventory review of user workflows, state restoration, ownership boundaries, and regression contracts | New activation-refresh variant of BUG-015; no new group | Complete |
| 9 | Fresh full inventory review of cross-component data flow, recovery, and regression coverage | 0 | Complete |
| 10 | Independent repeat review of the full inventory, checking ordinary workflows, alternate paths, and regression contracts | 1 (BUG-024) | Complete |
| 11 | Complete inventory review of data representation, lifecycle transitions, persistence, and recovery contracts | 1 (BUG-025) | Complete |
| 12 | Fresh complete review of ordinary feature workflows, state ownership, component boundaries, and regression coverage | New expanded-card exit variant of BUG-015; no new group | Complete |
| 13 | Independent full inventory review of end-to-end feature contracts, alternate paths, and state consistency | 0 | Complete |
| 14 | Complete repeat review of functional paths and regression contracts, with a different reviewer for UI helpers and layout | 2 (BUG-026–027) | Complete |
| 15 | Full inventory review of ordinary workflows, lifecycle ownership, configuration contracts, and failure recovery | 0 | Complete |
| 16 | Complete repeat review of initialization, reconnect/retry, persistence, data representation, and component handoffs | 1 (BUG-028, two related first-run Send flows) | Complete |
| 17 | Fresh full inventory review of feature workflows, cancellation, state restoration, and regression contracts | 0 | Complete |
| 18 | Complete repeat review of end-to-end feature contracts, alternate paths, persistence, and component lifecycle ownership | New recovered-process exit variant of BUG-015; no new group | Complete |
| 19 | Fresh full inventory review of ordinary workflows, cleanup/recovery, persistence, and user-visible feature contracts | 2 (BUG-029–030) | Complete |
| 20 | Complete repeat review of component contracts, external entry points, state publication, and failure/recovery paths | New focus-capability variant of BUG-015; no new group | Complete |
| 21 | Fresh complete review of main/alternate workflows, state ownership, persistence, and regression contracts | 0 | Complete |
| 22 | Independent repeat review of the complete inventory, checking user controls, data round trips, lifecycle ownership, and recovery | New Global Chrome cleanup variant of BUG-030; no new group | Complete |
| 23 | Fresh complete review of ordinary failure/retry paths, configuration, component interfaces, and persistence | 1 (BUG-031, startup and footer displays) | Complete |
| 24 | Complete repeat review of control-to-action paths, initialization/restoration, component boundaries, and regression contracts | 0 | Complete |
| 25 | Fresh complete inventory review of feature contracts, alternate paths, data representation, and cleanup/recovery | 0 | Complete |

Consecutive completed passes with no new bugs: **2** (passes 24 and 25). Every review scope is closed, with no unresolved candidates.

Every pass includes the same source inventory: **16 proxy modules; 8 UI JavaScript files plus HTML/CSS; 32 API/MCP/traffic/interceptor/uninstall modules; and 33 bootstrap/desktop/build modules**. Configuration, package metadata, documentation, build assets, and relevant regression tests are reviewed alongside their owning subsystem. Later passes trace different feature/state matrices through that inventory rather than merely repeating the test command.

## Validation

- Full `npm test` completed successfully on the bundled Node.js 26.7.0 runtime: **3,206 tests, 3,201 passed, 0 failed, 5 skipped**, in approximately 614 seconds. Skips require Go, PHP, or Java/JDK tools unavailable on this host.
- Syntax checks passed for all **89** tracked application/build JavaScript and CommonJS files. All **131** literal relative imports resolved; all **13** preload invocation channels had matching main-process handlers. Package/lock root dependencies and packaged PNG/ICO dimensions were consistent.
- Focused probes described below exercise gaps not covered by the passing regression suite. Existing tests passing does not invalidate these reproductions.

## BUG-001 — Unhandled downstream protocol errors terminate the server

- **Severity:** High.
- **Location:** `src/proxy/proxy-server.js:4401`, `6901`, `7036`–`7052`, `7611`–`7615`; temporary body-completion listener near `1100`.
- **Trigger:** Send an HTTP/1 WebSocket upgrade through an intercepted HTTPS connection with request target `http://[` (for example, `GET http://[ HTTP/1.1`, a valid Host header, `Connection: Upgrade`, and `Upgrade: websocket`).
- **Actual:** The initial URL parser throws, then the catch block invokes a second `new URL(...)` without guarding its failure. The exception escapes the upgrade event listener and terminates the process with `ERR_INVALID_URL`, disconnecting unrelated sessions.
- **Expected:** Reject the malformed target on that connection and keep the proxy running.
- **Evidence:** An isolated probe using Node's HTTP parser and the actual upgrade handler reproduced the uncaught exception at line 4401.
- **Related HTTP/2 failure:** The fast streaming path returns before installing the permanent stream error listener. After a GET request body ends, the temporary listener is removed. A client stream reset with `NGHTTP2_INTERNAL_ERROR` while the upstream response is pending then emits an unhandled `ERR_HTTP2_STREAM_ERROR` and terminates the process. An isolated real HTTP/2 stream probe reproduced this. Both failures need connection/stream-scoped error handling on every dispatch path; they are grouped as one process-stability bug.

## BUG-002 — Multiline syntax highlighting corrupts fallback body rows

- **Severity:** Medium.
- **Location:** `src/ui/app.js:5533`–`5549` (`wrapWithLineNumbers`).
- **Trigger:** Display a highlighted multiline token, such as a JavaScript/CSS block comment, while Monaco is unavailable or the fallback viewer is active.
- **Actual:** The closing-span suffix is computed before the current line updates the open-span stack. A token starting on one line and ending on the next produces nested `.body-line` elements instead of independent rows, breaking line numbers and alignment. The same cause affects multiline XML comments/attributes.
- **Expected:** Close the spans open at the end of each line, then reopen their styling inside the next independent row.
- **Evidence:** Executing the actual function with `<span style="color:red">/* first\nsecond */</span>\nconst x=1;` leaves the first row open around the second row.

## BUG-003 — cURL convenience-header import changes cookies and empty-header semantics

- **Severity:** Medium.
- **Location:** `src/ui/curl-parser.js:340`–`349` (`setCurlHeader` calls for convenience options).
- **Trigger:** Paste `curl http://example.test/ -b 'a=1' -b 'b=2'` into Send.
- **Actual:** The parser overwrites the first cookie and retains only `Cookie: b=2`. Related empty options (`-b ''`, `-A ''`) become explicit empty headers even though cURL omits those fields.
- **Expected:** Preserve cURL's combined cookie string (`a=1; b=2`) and its header suppression semantics.
- **Impact:** Imported requests can lose session cookies and behave differently from the original command.
- **Evidence:** A local HTTP capture with installed `curl.exe` 8.21.0 observed both cookies; the actual parser returned only the last. The existing repeated-cookie test expects the incorrect result, so it does not protect wire equivalence.

## BUG-004 — System Proxy fails to restore Windows automatic proxy detection

- **Severity:** Medium.
- **Location:** `src/interceptors/system-proxy-interceptor.js:221`, `229`, `696`–`704`, `755`, `836`, `899`–`907`.
- **Trigger:** Start with WinINet automatic detection enabled and no top-level `Internet Settings\AutoDetect` DWORD, with preexisting machine-scope WinHTTP settings; activate and then stop System Proxy.
- **Actual:** Snapshotting reads only the DWORD, so it records `null` instead of the effective enabled setting. Activation writes `0`; WinINet consumes/removes that temporary value and persists the effective setting in `Connections\DefaultConnectionSettings`. Stop interprets the missing DWORD as an external change, skips automatic-settings restoration, and clears recovery state while detection remains disabled. The same preservation branch also skips restoring an original PAC URL.
- **Expected:** Snapshot and restore the effective WinINet per-connection automatic-detection state, recognizing the operating system's own normalization.
- **Evidence:** Native Windows observation confirmed the absent-DWORD/enabled-state combination and DWORD consumption after notification. An in-memory fixture executing real activate/deactivate with that behavior produced `before=true`, `afterStop=false`, and no retained recovery record. The native observation's original settings were restored and verified. Do not reproduce by modifying a working system proxy; use an isolated fixture/VM.

## BUG-005 — Capture pause leaks lifecycles and can strand Pending rows

- **Severity:** Medium.
- **Location:** `src/api/api-server.js:3458`–`3475`, `3530`–`3562`, `4082`–`4098`; `src/proxy/proxy-server.js:1483`–`1486`, `2176`–`2179`, `11041`–`11043`, `11063`–`11091`, `11148`–`11150`.
- **Trigger:** Capture a pending request; delete its row (or let retention evict it); pause capture before that request completes.
- **Actual:** Completion returns at the paused-capture check before removing the pending lifecycle and active identity. A deleted request also keeps its `Infinity` deletion tombstone, which is exempt from expiry and the completed-identity cap.
- **Expected:** Suppress display of the completion while still releasing its lifecycle bookkeeping and giving any deletion tombstone a finite expiry.
- **Impact:** Repeated delete/evict-and-pause cycles accumulate completed requests in supposedly live tracking until Clear or restart.
- **Evidence:** A local probe wired a real `ProxyServer` to `ApiServer`, emitted a pending lifecycle, deleted it through the actual HTTP route (200), paused, and emitted completion. Proxy pending decisions fell to zero, but API pending IDs and active identities still contained the request; pruning at `Number.MAX_SAFE_INTEGER` left its `Infinity` tombstone. A separate retention-eviction probe left the same pending/active entries.
- **Related streaming trigger:** Pause capture before a streaming request starts. Its first pending notification is rejected, leaving `pendingEmitted` false. At response headers, the HTTP/1 and HTTP/2 streaming helpers try the same pending lifecycle again, creating a second decision. Completion consumes only the first decision.
- **Streaming impact/evidence:** With real proxy/API callbacks and a delayed local HTTP origin, a fully completed request while paused left one proxy decision behind. Resuming capture before the origin replied also produced a visible row whose status remained `null`/Pending after the client received `ok`, with API pending/active tracking retained. Pending admission must run once per lifecycle even when display is suppressed, and every completion must release bookkeeping.

## BUG-006 — Body display and editing mishandle valid representations

- **Severity:** Medium.
- **Location:** `src/ui/app.js:16093`–`16112`, `16166`–`16170`, `4570`, `8527`–`8535`, `9005`–`9010`; `src/proxy/proxy-server.js:5292`–`5294`, `11704`–`11706`.
- **Breakpoint trigger:** Pause a binary response, click its body editor, accept the unchanged default, and resume.
- **Actual:** The draft copies the capture's base64 data URI without its encoding. Accepting the prompt marks it dirty, and resume sends a plain `body` string that the proxy encodes as UTF-8. Four original bytes `00 ff 80 01` become the 45 ASCII bytes of `data:application/octet-stream;base64,AP+AAQ==`. Request-body editing has the same representation mismatch.
- **Related mock trigger:** Import a valid binary-body mock such as `action.body = {"type":"Buffer","data":[0,255,128,1]}`, open its editor, then Cancel while the rule remains expanded.
- **Actual:** The read-only body formatter receives the Buffer-shaped object and throws `body.startsWith is not a function`; editor fields also coerce it to `[object Object]`.
- **Expected:** Honor each body's valid representation and encoding across preview, draft, and resume/save boundaries; opening or accepting an unchanged body must not corrupt it, and valid bodies must render successfully.
- **Evidence:** A local origin plus actual proxy breakpoint flow and actual UI functions reproduced the byte change. A separate VM execution of the real mock validator, cancel path, renderer, and formatter accepted the binary rule then reproduced the exception.
- **Related preview trigger (pass 5):** Send or import a valid SVG body stored as UTF-8 text. `src/api/api-server.js:3327`–`3343` returns SVG text from Send, and `src/ui/app.js:4650`–`4654` automatically chooses Image, but `5562`–`5581` accepts only base64 image data URIs. The viewer displays `[Image data not available]` for the valid SVG. A real local SVG origin plus the actual Send API and UI renderer reproduced this; the same SVG using the proxy capture's base64 representation rendered successfully. `src/ui/har-import.js:226`–`235` also retains textual image bodies. This is another UI boundary assuming one representation instead of honoring the body encoding.

## BUG-007 — Resend silently re-encodes captured form bodies

- **Severity:** Medium.
- **Location:** `src/ui/app.js:3139`–`3146`, `10720`–`10726`.
- **Trigger:** Resend an ordinary captured `application/x-www-form-urlencoded` request without editing its fields.
- **Actual:** Converting the raw body through `URLSearchParams` and the form editor changes `sig=%2f&space=%20&tilde=~&literal=%41` to `sig=%2F&space=+&tilde=%7E&literal=A`. With `charset=iso-8859-1`, `q=%E9` becomes `q=%EF%BF%BD`, losing the original character.
- **Expected:** Retain the captured body bytes until the user edits/re-encodes the form, including its declared character encoding.
- **Impact:** Signed or byte-sensitive requests fail, and legacy-charset form values change even on an unedited resend.
- **Evidence:** Execution of the actual resend and form serialization functions reproduced both transformations. The existing byte-preserving branch only handles decoded/notice-bearing replays, leaving ordinary form captures affected.

## BUG-008 — Deferred traffic summaries break searching and restored selection

- **Severity:** Medium.
- **Location:** `src/api/api-server.js:2806`–`2833`, `3644`–`3717`; `src/ui/app.js:386`–`389`, `626`–`629`, `691`–`692`, `733`–`734`, `1578`–`1634`, `1749`–`1785`.
- **Trigger:** Reload/reconnect with a retained large exchange, then search its body, headers, or a path suffix beyond the summary's truncation limit before selecting that row.
- **Actual:** Large traffic dumps replace full records with `_deferredTrafficDetail` summaries that omit bodies/headers and truncate path/URL. Filtering treats those summaries as complete; it does not fetch the missing searchable fields. Matches disappear until the row is manually opened and hydrated.
- **Expected:** Search authoritative retained data, or fetch required deferred fields before deciding that a row does not match.
- **Evidence:** The actual API dump builder summarized a record with a 9 MiB response. Actual UI matchers returned true on its full record and false on its summary for body/header/path searches. Detail hydration is initiated by selection, not search.
- **Related restored-selection failure (pass 7):** Reload a link to a retained large exchange, such as `#/view/large-1?trafficLifecycleId=life-1`. Both chunked and unchunked dump handlers restore selection before setting `trafficDumpReady` to true, so the detail hydrator rejects the selection as still synchronizing. An actual server-generated deferred summary and actual renderer selection/dump/hydration functions reproduced a cleared selection, hash reset to `#/view`, zero detail fetches, and a synchronization-error toast after the completed dump. Manually selecting the same row afterward fetched and displayed it successfully. The probe stubbed DOM and the successful hydration response; the failing path never fetched. Reconnecting with an existing large-row selection also traverses this ordering. Search and restored selection must both obtain the deferred detail when needed, after synchronization permits hydration.

## BUG-009 — Selected request title stays stale after a live rewrite

- **Severity:** Low.
- **Location:** `src/ui/app.js:1359`–`1376`, `2420`–`2426`.
- **Trigger:** Select a pending request, then change its method or URL at a breakpoint and resume it.
- **Actual:** The request-update handler refreshes the selected record and detail cards but not `detailTitle`, so the title continues to describe the original method/host/path until the row is selected again.
- **Expected:** Refresh the selected title together with the updated detail cards.
- **Evidence:** A VM execution of the actual update handler changed a selected `GET before.test/old` to `POST after.test/new`; cards received the new record while the title retained the old text.

## BUG-010 — High Contrast hides text on several white panels

- **Severity:** Medium.
- **Location:** `src/ui/styles.css:243`–`251`, `996`–`1000`, `1848`–`1854`, `1960`, `1993`–`1996`, `2124`, `2152`–`2155`.
- **Trigger:** Select Settings → Appearance → High Contrast, then inspect a paused breakpoint, terminal configuration instructions, Android device names, or JVM process names.
- **Actual:** These components combine `--bg-input` and `--text-main`, both `#ffffff` in High Contrast, producing white text on a white background (1:1 contrast). The input-specific theme override does not apply to these spans, preformatted blocks, and divs.
- **Expected:** Use the contrasting input foreground on white panels so values, instructions, and device/process names remain readable.
- **Evidence:** A CSS variable/selector resolution probe confirmed the white foreground/background pair on all four component families; the stylesheet has no applicable override.

## BUG-011 — Send response view mode resets when changing tabs

- **Severity:** Low.
- **Location:** `src/ui/app.js:5774`–`5778`, `12392`–`12418`, `12684`–`12690`.
- **Trigger:** In Send, receive a JSON response, choose Text in the response viewer, switch to another Send tab, then return.
- **Actual:** The response switches back to JSON. Changing the viewer updates only its standalone state; saving the tab omits that mode, and reloading restores the stale `tab.response.mode`.
- **Expected:** Preserve each Send tab's selected response view when switching tabs.
- **Evidence:** A VM probe executing the actual view-switch, tab snapshot/save, tab-switch, and restore functions reproduced Text → JSON without a new request.

## BUG-012 — gRPC-Web text bodies are passed to the binary decoder

- **Severity:** Medium.
- **Location:** `src/ui/app.js:4603`–`4605`, `4634`, `5165`–`5179`, `5323`.
- **Trigger:** Inspect a valid `application/grpc-web-text+proto` request or response, whose transport body contains base64-encoded gRPC-Web frames.
- **Actual:** The viewer automatically selects gRPC, but removes only the capture encoding and passes the transport's base64 characters to the binary frame decoder. It then reports frame/protobuf errors. The trailer detection expression also excludes `grpc-web-text`.
- **Expected:** Decode the text transport before parsing frames and recognize its trailer frames, as specified by the [gRPC-Web protocol](https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-WEB.md).
- **Evidence:** A probe using actual proxy body capture and UI decoding successfully decoded binary gRPC-Web containing protobuf value `150` and `grpc-status: 0` trailers. The same valid frames in text transport instead produced `Unsupported protobuf wire type 7`.

## BUG-013 — Repeated View in traffic navigation closes the request details

- **Severity:** Low.
- **Location:** `src/ui/app.js:2209`, `12698`, `13102`.
- **Trigger:** Send a request, click View in traffic, return to Send, then click View in traffic again while that exchange is still selected in Traffic.
- **Actual:** The second navigation clears the selection and closes its details. Both Send handlers pass `true` to the table-row toggle behavior of `selectRequest`.
- **Expected:** A navigation link should select and show its target even when it is already selected.
- **Evidence:** A VM probe executed the handler generated by `loadSendTabState` and the actual selection function. The first click selected `sent-1`; the second set selection to `null` and called the detail-close path. The freshly completed Send response uses the same toggle argument.

## BUG-014 — HTTP/1 streaming loses framing for chunked GET and DELETE bodies

- **Severity:** Medium.
- **Location:** `src/proxy/proxy-server.js:150`–`152`, `516`–`528`, `1378`–`1394`, `1982`–`1992`, `2890`–`2903`, `3555`–`3574`.
- **Trigger:** Forward a valid HTTP/1 GET or DELETE with a chunked request body to an HTTP/1 origin through the ordinary streaming path.
- **Actual:** Hop-by-hop filtering removes incoming `Transfer-Encoding`, while the exact-method request helper disables automatic chunked framing for these methods. The outgoing request has neither content length nor transfer encoding. The origin sees an empty body, and the remaining body bytes cause HTTP 400, even though the capture shows the intended body.
- **Expected:** Recreate valid HTTP/1 body framing after removing the incoming transfer encoding, independently of the method.
- **Related transform trigger:** A GET rewrite that replaces headers, removing `Content-Length`, while preserving the original body has the same missing-framing result.
- **Evidence:** Real local origin/proxy probes on bundled Node.js 26.7.0 forwarded chunked GET/DELETE body `abc` as an empty origin body with HTTP 400; a POST control forwarded `abc` successfully with HTTP 200. A header-replacement probe reproduced the same failure with the preserved GET body. Existing HTTP/1-to-HTTP/2 method-body tests do not exercise this HTTP/1-to-HTTP/1 path.

## BUG-015 — Interceptor status updates can leave stale source state and actions

- **Severity:** Medium.
- **Location:** `src/ui/app.js:5997`–`6021`, `6231`–`6236`, `6254`–`6279`, `6320`–`6323`, `6378`–`6380`, `6404`–`6408`, `6499`–`6504`, `7025`, `7060`, `7281`, `7304`–`7326`; `src/interceptors/interceptor-manager.js:113`–`121`, `159`–`205`, `210`–`221`; `src/interceptors/jvm-interceptor.js:737`–`767`; `src/interceptors/electron-interceptor.js:19`–`39`, `286`–`307`, `354`–`376`, `545`–`564`; `src/interceptors/existing-browser-interceptor.js:42`–`45`, `119`–`135`, `227`–`252`; `src/interceptors/browser-interceptor.js:468`, `1011`–`1025`, `1288`.
- **Trigger:** Attach a JVM, let its process exit, then click Refresh in the expanded JVM interceptor card.
- **Actual:** Refresh updates the expanded process metadata but leaves the interceptor summary in `allInterceptors` active/connected. The manager's initial `isActive()` check already removes the exited process, so its before/after comparison sees no change and emits no status event to repair that summary.
- **Expected:** Keep source activity and available actions consistent with current process metadata and status events, including when a configuration card is open, a surviving process was recovered after a restart, or activation occurs outside the UI.
- **Evidence:** A probe executed the actual JVM interceptor, manager transition, UI refresh, metadata, and connectivity functions with only OS discovery/agent artifacts mocked. Backend activity became false and `activatedProcesses` was empty, but no event was emitted and the UI retained active/interceptionActive/connected as true.
- **Related activation-refresh race (pass 8):** During Android or JVM activation, an older aggregate interceptor-list response can overwrite a newer live status event for another source. These refresh paths check only the selected activation operation and ignore `interceptorStateGeneration`, unlike normal `loadInterceptors`. A VM probe executed the actual JVM activation, status handler, operation checks and Connected Sources renderer: a Chrome exit event correctly removed Chrome, then the delayed older list made Chrome active/visible again. The same sequence through normal `loadInterceptors` preserved the correct inactive/hidden state. Transport/device activation and unrelated DOM were stubbed; no live device was used. The manager samples interceptors sequentially and awaits later Android/JVM discovery, so its source permits Chrome to exit after being sampled but before the aggregate response completes. Refresh results must not replace newer connected-status information.
- **Related expanded-card exit failure (pass 12):** In a window wider than 1,100 pixels, after activation refresh has settled, reopen the configuration of an active intercepted Electron app and close that app externally. The inactive status handler updates its model, collapses the expanded card, and returns before rendering Connected Sources. Collapse only rebuilds configuration cards, preserving the stale connected-source item. A probe executed the actual card-open, status, collapse, filter, and connected-source functions with an exit event produced by the real Electron interceptor's child-lifecycle handler: afterward `expandedInterceptorId` was `null` and model activity was false, but the source remained visible. An otherwise identical control with the card already collapsed removed the source; explicitly rendering Connected Sources repaired the failing case. Child spawn/CA artifacts and DOM surfaces were mocked; no native app or HTTP/WebSocket transport was exercised. This adds a live-event rendering failure to the same stale connected-status group.
- **Related recovered-process exit failure (pass 18):** Restart FreeKit while a journaled Electron app or Global Chrome process survives, then close that app externally. Recovery adopts ownership with `active=true` but no child-process handle or monitor; the UI and manager have no periodic interceptor refresh. A probe used actual journal adoption, manager listing, and UI list/status/source renderers. After simulated process disappearance and 1.7 seconds, both recovered sources still had backend/UI activity true, remained visible, and had emitted no event or additional identity query. Explicit Electron `isActive()` detected the exit and repaired the UI; Global Chrome `isActive()` cleared backend state silently, leaving the source visible until an explicit UI list reload. A positive control tracking a newly launched child emitted its exit event and removed the source immediately. The absence of scheduled reconciliation supports persistence until a later query, action, or reconnect; only the stated 1.7-second interval was observed. OS discovery, browser availability, child events, DOM, and fetch were simulated, with real temporary ownership journals; no native process or transport was used. Existing recovery tests manually reconcile state and miss this automatic-notification gap.
- **Related focus-capability failure (pass 20):** Load the UI while isolated Chrome is inactive, then launch it through the documented external API/deep-link path. The actual activation event publishes activity/PID but omits `focusable`; the UI retains its earlier `false` capability even though the backend now reports `true`. The card's primary action consequently offers Stop instead of Focus, and Connected Sources also lacks Focus. A probe executed actual browser activation, manager `openUrl`/listing, status handling, and card/source rendering: clicking the generated primary action called `toggleInterceptor('chrome', true)`. Explicitly reloading the interceptor list changed that action to `focusInterceptor` and restored source focusability. Assertions passed on an independent rerun. OS availability, profile/spawn/monitoring, DOM, and action endpoints were simulated; no native focus/stop or network request occurred. External launch bypasses the UI toggle's delayed list reload, leaving this incomplete status update unrepaired until a later refresh.

## BUG-016 — HTTPS mock forwarding through the plain proxy is labeled HTTP

- **Severity:** Low.
- **Location:** `src/proxy/proxy-server.js:5200`–`5206`, `10459`; `src/ui/app.js:4244`–`4250`.
- **Trigger:** Send a supported absolute-form HTTPS target through the plain proxy and match a forward mock whose destination is also HTTPS.
- **Actual:** The mock caller omits `capture.protocol`; the shared mock responder defaults it to `http` despite the target URL retaining its `https:` scheme and the actual origin connection using TLS. The detail panel consequently describes the exchange as HTTP (unencrypted). Normal forwarding derives the protocol from the target.
- **Expected:** Classify the mocked exchange consistently with the target scheme and ordinary forwarding.
- **Impact:** Protocol details and consumers of the captured protocol receive inconsistent metadata.
- **Evidence:** A local actual-proxy probe on bundled Node.js forwarded `https://example.test/resource` to an ephemeral HTTPS origin. The client received 200/`tls-origin`, and the origin socket reported `encrypted: true` and TLSv1.3, while the captured upstream mock response had `protocol: 'http'`. Certificates were generated in memory and trusted only by the isolated proxy instance; no system trust setting changed. A fixed response without an upstream TLS connection was excluded as ambiguous evidence.

## BUG-017 — API specification imports infer incorrect base URLs

- **Severity:** Medium.
- **Location:** `src/ui/app.js:15169`–`15170`; `src/proxy/proxy-server.js:12031`–`12040`.
- **Trigger:** Import a Swagger 2 document with `host: 'api.example.test'`, `basePath: '/v1'`, and a `GET /items` operation, accepting the suggested Base URL.
- **Actual:** The suggestion contains only `spec.host`, omitting `basePath`. The matcher strips only the path in the stored Base URL and never consults the document's `basePath`. Valid `/v1/items` traffic fails to match, while `/items` incorrectly matches the operation.
- **Expected:** Include the Swagger scheme/host/base path in the inferred Base URL, or apply the document's base path when matching.
- **Evidence:** A probe executing the actual UI upload/parser/response functions, API validator, and proxy matcher submitted `baseUrl: 'api.example.test'` and displayed a success toast. Matching `/v1/items` returned `null`; matching `/items` returned `getItems`. The API review independently confirmed the contract mismatch.
- **Related OpenAPI 3 trigger:** A server URL such as `https://{environment}.example.test/{version}` with defaults `environment=api` and `version=v1` is suggested and accepted literally. The same probe confirmed successful import but no match for `api.example.test/v1/items`. Server-variable defaults must be substituted when no alternate value is supplied, per the [OpenAPI Server Variable specification](https://spec.openapis.org/oas/v3.0.3.html#server-variable-object). Both variants lose information already present in the imported document. Relative server URLs without an origin were excluded because those require user-supplied context.

## BUG-018 — Declined WebSocket upgrades advertise a connection the proxy closes

- **Severity:** Medium.
- **Location:** `src/proxy/proxy-server.js:4366`, `4374`–`4380` (`_forwardRejectedUpgradeResponse`).
- **Trigger:** An origin declines a valid WebSocket upgrade with an ordinary HTTP 200 response and `Connection: keep-alive`; the client immediately sends another HTTP request using the same keep-alive agent.
- **Actual:** The proxy forwards the origin's keep-alive header, then ends the downstream socket when piping/finishing the response. The client reuses the advertised connection before observing its closure, and the next request fails with `ECONNRESET`.
- **Expected:** Advertise `Connection: close` when deliberately ending the downstream HTTP connection, or preserve it for subsequent requests.
- **Evidence:** A real local origin/proxy probe using `http.Agent({keepAlive: true, maxSockets: 1})` returned 200 for the upgrade attempt and failed the next ordinary request with `ECONNRESET`. The direct-origin control returned 200 for both requests and confirmed socket reuse.

## BUG-019 — Dock activation during startup creates duplicate desktop windows

- **Severity:** Medium.
- **Location:** `electron/main.cjs:127`, `190`, `474`–`508`, `761`–`765`, `795`–`801`.
- **Trigger:** On macOS, click the application's Dock icon while startup has allocated an API port but the backend has not yet reported readiness.
- **Actual:** The `activate` handler checks only that `apiPort` exists and creates a window while the server is still starting. When startup completes, its continuation unconditionally creates another window. The first window can load before the API is listening, leaving an extra failed/blank window alongside the working one.
- **Expected:** Defer activation until backend readiness and reuse the single startup window.
- **Evidence:** A VM probe executed the actual startup and activation handlers with a delayed backend, recording two window creations: first with `serverReady: false`, then with `serverReady: true`. An independent source review confirmed no enclosing readiness/window guard prevents this sequence. Installed Electron's type documentation confirms macOS Dock clicks emit `activate`; native macOS interaction was not exercised on this Windows host.

## BUG-020 — Importing an evicted pending snapshot reuses a live request's identity

- **Severity:** Medium.
- **Location:** `src/api/api-server.js:2650`–`2716`, `3563`–`3585`.
- **Trigger:** Export a pending request as JSON, let retention evict its visible row while the request is still running, then re-import that unmodified export before the original request completes.
- **Actual:** Import collision detection checks retained rows but not active lifecycles whose rows were evicted, so it reuses the original ID/lifecycle. The original request's completion then overwrites the imported historical snapshot, preserving the import's new generation, rather than recording a distinct live exchange.
- **Expected:** Remap imported identities that collide with active requests, including requests absent from the retained traffic list, so imports remain independent snapshots.
- **Evidence:** At the normal 10,000-row retention limit, a probe used real proxy/API callbacks and actual export/import HTTP routes (both 200). After exporting a pending lifecycle, adding 10,000 completed captures, and importing the export, the original completion changed the imported row from pending to status 201/body `live-result`. Only one combined row for that request remained and a request-update event was broadcast. Pending bookkeeping did clear correctly, distinguishing this collision from BUG-005.

## BUG-021 — Concurrent settings saves leave the UI inconsistent with saved values

- **Severity:** Medium.
- **Location:** `src/ui/app.js:13260`–`13308`, `13727`–`13760`, `14380`–`14409`; `src/api/routes/configuration-routes.js:40`–`59`, `99`–`112`; `src/api/api-server.js:2468`–`2489`.
- **Trigger:** Quickly change both traffic-display settings while the first save request reaches the server after the second. The event handlers issue independent requests without serializing them.
- **Actual:** Starting from `{hideTunnelRequests: true, filterSafeFonts: false}`, turn off tunnel hiding, then turn on font filtering. If the second request applies first, its response restores the old tunnel-hiding value in the renderer. The first request then correctly persists the combined changes, but the renderer discards that final canonical response because its client generation is older. Both toggles remain checked even though tunnel hiding is saved as false; the UI reports success.
- **Expected:** Once overlapping saves settle, display the canonical saved settings and apply the same filters. Client click order alone cannot establish the order in which the server applied requests.
- **Evidence:** Two independent probes executed the actual renderer functions against a real loopback API server with an in-memory settings store and a controlled transport delay before sending the first request. After both successful responses, persisted settings were `{hideTunnelRequests: false, filterSafeFonts: true}` but renderer state was `{hideTunnelRequests: true, filterSafeFonts: true}`. This demonstrates the ordering failure; browser timing was not measured. Existing concurrency tests reorder responses while assuming requests applied in click order. The upstream-proxy settings code already reconciles after overlapping writes for this reason.
- **Related port-configuration failure:** Save `19100–19110`, then change the fields and save `19200–19210` while the first request is delayed. A probe using actual `savePortConfig` and API handlers confirmed that applying the second request first leaves `19100–19110` persisted but `19200–19210` displayed, with a success toast. This flow likewise discards older client generations and decrements its pending count without reconciling server state after overlapping writes.
- **Related Traffic Lists failure:** Save patterns `['first.example.test']`, edit them to `['second.example.test']`, and save again while the first request is delayed. Actual renderer functions plus the real API reproduced the same mismatch: the older patterns persisted last, while the renderer retained the newer patterns, `trafficListsDirty` was false, and the status said `All changes saved`. These settings flows share the same missing reconciliation after overlapping writes.

## BUG-022 — Breakpoint banner state is lost or stale after reconnecting

- **Severity:** Medium.
- **Location:** `src/ui/app.js:1297`–`1353`, `1420`, `1431`; `src/api/api-server.js:3938`–`3949`.
- **Trigger:** Reload the UI while requests are paused at breakpoints, or disconnect its WebSocket while another client resumes a paused request and then reconnect.
- **Actual:** Initial connection/reconnection reloads breakpoint rules but never refreshes the pending-breakpoint banner. The server's initial message does not contain pending breakpoints or replay their events. A fresh page leaves the banner and Resume All hidden despite pending requests; a reconnect can retain an obsolete paused count after those requests have resumed.
- **Expected:** Reconcile the pending-breakpoint state when each connection initializes, so the banner and Resume All reflect current paused requests even when live events were missed.
- **Evidence:** A real loopback `ProxyServer`/`ApiServer` WebSocket session fed the actual renderer message handler with its initial `init` and `traffic-dump` messages. With one pending breakpoint, the banner remained hidden and no pending-list fetch occurred. Calling the actual banner refresh explicitly fetched the endpoint and displayed `1 request paused`. After disconnecting, resuming through the real proxy, and reconnecting the same renderer, that banner remained visible with a stale count although the proxy had zero pending breakpoints. Unrelated initial loaders were stubbed; the real rule loader and an independent API review confirmed neither hydrates the pending state.

## BUG-023 — An abandoned HTTP/1 attempt can abort a healthy retry for an HTTP/2 client

- **Severity:** Medium.
- **Location:** `src/proxy/proxy-server.js:2258`–`2299`, `2520`–`2523`, `2545`–`2565`.
- **Trigger:** A native HTTP/2 request uses a passthrough pre-step to rewrite its target to HTTP and forwards through an HTTP upstream proxy. The provider returns retryable 410 headers but delays that response's body beyond the idle timeout; the retry hook permits another request, which returns 200 and streams normally. Both upstream attempts use HTTP/1.
- **Actual:** The HTTP/1 fallback starts the replacement without canceling the rejected attempt. When the old request times out, its error handler does not check that it still owns the active attempt. It finalizes the exchange using the replacement's response metadata, destroys the active replacement, and resets the downstream HTTP/2 stream. A healthy successful response is truncated and recorded with the abandoned attempt's timeout error.
- **Expected:** Retire the rejected attempt and ignore its late events once a replacement owns the exchange. Only the active attempt may finalize or abort the current response.
- **Evidence:** An isolated actual-proxy/loopback-provider probe on bundled Node.js 26.7.0 set `upstreamIdleTimeoutMs: 60` to accelerate the normal 30-second timeout and `upstreamRetryDelayMs: 0`. The first response delayed its four-byte body for 180 ms; the replacement streamed a chunk every 15 ms and would finish at 165 ms. The client received status 200 and four `part` chunks before `ERR_HTTP2_STREAM_ERROR`; final capture reported `Upstream response timeout after 0.06s`. An otherwise identical control that finished the rejected response body immediately received all eleven chunks plus `done` without error. Both runs made two provider requests and invoked the retry hook once. The probe used valid responses and in-memory certificates; no system trust or proxy settings changed.

## BUG-024 — Management idle timeout cuts off healthy long-running Send requests

- **Severity:** Medium.
- **Location:** `src/api/api-server.js:57`, `289`–`294`, `1498`–`1503`, `2556`–`2595`, `3218`–`3220`, `3317`–`3355`.
- **Trigger:** Use Send against an origin that keeps delivering response chunks but takes more than 30 seconds to finish, within Send's default 60-second total timeout and 30-second upstream idle timeout.
- **Actual:** Management middleware applies a separate 30-second socket inactivity timeout to `/api/send`. The route buffers the entire upstream response before returning JSON, so upstream progress never resets the management socket's inactivity timer. That timer destroys the UI's connection; the route's close handler then aborts the healthy outbound request. Send fails before its own request timeout budget is exhausted.
- **Expected:** Once the Send request body has arrived, let Send's own connection, upstream inactivity, total-duration, and client-cancellation controls govern its lifetime. A progressing upstream response should not be canceled merely because the management route buffers it.
- **Evidence:** An actual loopback `ProxyServer`/`ApiServer` HTTP probe on bundled Node.js 26.7.0 accelerated the management timeout to 120 ms, with Send connection/total timeouts of 1,000 ms and upstream idle timeout of 100 ms. The origin sent a chunk every 20 ms for approximately 300 ms. The API client received `ECONNRESET`/`socket hang up`, and the origin was aborted after four chunks. An otherwise identical control with a 1,000-ms management timeout returned HTTP 200 and the complete 100-byte body, reporting a Send duration of 331 ms. The default-duration consequence follows from the source; a separate 30-second probe was not run. Existing management/SSE timeout tests cover stalled ordinary routes and incomplete uploads; Send timeout tests invoke `_sendRequest` directly and bypass the conflicting management middleware.

## BUG-025 — Reordering new mock-rule drafts silently discards their placement

- **Severity:** Low.
- **Location:** `src/ui/app.js:7663`–`7668`, `7788`–`7825`, `8124`, `9605`–`9613`, `9922`–`9933`; `src/proxy/proxy-server.js:11927`–`11945`.
- **Trigger:** Create or clone a mock rule, leave it as an unsaved draft, and drag its row ahead of existing rules.
- **Actual:** Draft rows advertise dragging and move optimistically, but the reorder request includes their temporary client-only IDs. The server ignores IDs that are not saved rules and returns success. The renderer replaces the collection with that response, then appends new drafts at the end, silently undoing their placement. No error explains the rejected move.
- **Expected:** Preserve draft placement locally and honor it when saving, or clearly disable/reject reordering until the draft has been saved to the server.
- **Evidence:** Actual clone, drag-start, drop, persistence, and reconciliation functions were executed against a real loopback `ApiServer`/`ProxyServer` reorder route. Starting with `[a, b, draft]`, dragging the draft first produced optimistic `[draft, a, b]` and POST 200, then reverted to `[a, b, draft]`; the server retained `[a, b]` and no error was shown. A positive control dragging saved rule `b` before `a` retained `[b, a, draft]` and saved `[b, a]`. DOM/rendering/toasts were stubbed; native dragging was not exercised, while the actual row renderer was checked to expose `draggable="true"` for new drafts. Existing reorder tests cover edits to saved rules, not new draft IDs.

## BUG-026 — The selective HTTP/2 setting instead rejects HTTP/1.1 clients

- **Severity:** Medium.
- **Location:** `src/ui/index.html:452`–`460`; `src/proxy/proxy-server.js:5885`–`5893`, `6964`–`6967`.
- **Trigger:** Choose HTTP/2 Support > “Enabled only for HTTP/2-only clients”, then connect an HTTPS client that offers only `http/1.1` through the proxy.
- **Actual:** The `h2-only` mode advertises only `h2` and disables HTTP/1.1 fallback, so the TLS handshake fails before a request can be sent. A client offering both protocols also negotiates HTTP/2, despite the label limiting HTTP/2 use to clients that require it.
- **Expected:** Honor the stated selective behavior, retaining HTTP/1.1 for clients that support it and HTTP/2 for clients that require it, or explicitly label this mode as requiring HTTP/2 and rejecting HTTP/1.1 clients.
- **Evidence:** An actual loopback `ProxyServer` probe on bundled Node.js 26.7.0 used an in-memory certificate and a fixed-response mock. A CONNECT tunnel with ALPN `['http/1.1']` returned HTTP 200 and `mock-ok` in both `all` and `disabled` modes, but failed with `ERR_SSL_TLSV1_ALERT_NO_APPLICATION_PROTOCOL` (TLS alert 120) in `h2-only`. Offering `['h2', 'http/1.1']` in `h2-only` negotiated `h2` and returned 200; an H2-only offer also succeeded. Existing `test/proxy/http2/proxy-http2.test.js` cases cover H2-only clients in `h2-only` and H1-only clients in `all`, leaving the mismatched selective-client contract untested. No system proxy, trust, or settings files were changed.

## BUG-027 — Windows uninstall discards Android proxy recovery without restoring the device

- **Severity:** Medium.
- **Location:** `src/windows-uninstall-cleanup.js:73`–`88`, `97`; `build/installer.nsh:1`–`11`; `src/interceptors/android-adb-interceptor.js:99`–`104`, `211`–`281`, `1310`–`1340`, `1885`, `1905`, `2027`–`2033`.
- **Trigger:** Activate Android interception in global-proxy mode, then lose the FreeKit process before deactivation and uninstall the Windows application.
- **Actual:** Uninstall checks only Windows system/WinHTTP proxy journals before deleting the entire shared data directory. It deletes the Android recovery journal without restoring the device or reporting incomplete recovery. The device remains pointed at FreeKit's now-unavailable proxy. Reinstalling cannot recover the prior setting; activating again records the orphaned FreeKit proxy as the baseline and restores that wrong baseline on Stop.
- **Expected:** Restore journaled Android state before deleting its recovery data, or retain the journal and report incomplete cleanup so the device can be reconnected and recovery retried.
- **Evidence:** An isolated bundled-Node.js 26.7.0 probe used actual Android activation, journal writing/adoption, deactivation, and Windows cleanup code with temporary data directories. Only ADB/device discovery, host-address discovery, and QR generation were simulated. Starting from `corporate.proxy:8888`, activation set `192.0.2.10:8080`. A crash/restart control adopted one target and Stop restored the corporate proxy. Uninstall instead returned `{fingerprints:[], removed:true}`, deleted the journal, and made zero device calls. A fresh interceptor adopted zero targets and Stop did nothing; reactivation followed by Stop retained `192.0.2.10:8080`. Assertions passed; no actual device, installer, system-proxy, or trust changes occurred. Existing uninstall tests preserve Windows recovery journals on failure, and Android tests cover restart recovery separately, but neither covers this interaction.

## BUG-028 — First-run Send windows can silently discard each other's requests

- **Severity:** Medium.
- **Location:** `src/ui/app.js:186`, `11558`–`11570`, `12347`–`12364`, `12470`–`12480`, `12589`–`12623`, `12800`–`12825`.
- **Trigger:** Open two browser windows at the same FreeKit origin before any Send tabs have been saved. Edit the default request in one window, then close the default Send tab in the other window.
- **Actual:** Both initial tabs use `tab-1`, but empty-workspace restoration gives them no committed metadata or pending create journal. The storage-event handler treats absent local metadata as unchanged and bypasses the dirty-editor conflict check. Closing the remote tab replaces the local dirty editor with an empty tab without warning. In the related first-save flow, the remote window saves a different request by opening a new tab; the local window adopts its revision while retaining its own editor controls, and its next save silently overwrites the remote request.
- **Expected:** Give the initial tab the same identity/conflict protection as persisted tabs, preserving independent dirty drafts when another window saves or closes its tab.
- **Evidence:** Two isolated probes on bundled Node.js 26.7.0 executed actual restoration, editor loading, storage reconciliation, journaling, and New/Close tab functions through the existing concurrency-test harness. With initially empty shared storage, closing the remote default tab cleared the local URL/body and emitted no warning. In the first-save variant, storage initially held `https://remote-saved.test` and its body; after the local New tab action, that request was gone and `https://local-draft.test` occupied `tab-1`. Otherwise identical controls seeded with one saved tab preserved the local draft in a new tab, emitted the existing conflict warning, and retained both requests in the save case. Assertions passed on independent reruns. Storage/locking, DOM, rendering, and editor surfaces were simulated; no native browser was exercised or network ordering manipulated. Existing concurrency coverage does not cover two initially uncommitted default tabs.

## BUG-029 — The Send shortcut does nothing from method, header, and form controls

- **Severity:** Low.
- **Location:** `README.md:178`; `src/ui/index.html:240`–`241`, `349`; `src/ui/app.js:10429`–`10438`, `10662`–`10667`, `10944`–`10946`, `16543`–`16681`.
- **Trigger:** Enter a valid request URL, edit a header or form value on the Send page, and press the advertised Ctrl+Enter shortcut while that field remains focused.
- **Actual:** Nothing happens. Only the URL input and body editors implement the shortcut; method, header, and form controls have no handler, and the document-level listener has no Send branch. Moving focus to the URL or body makes the same shortcut send the request.
- **Expected:** The advertised Send-page shortcut should work while editing any request control, without requiring the user to change focus.
- **Evidence:** An isolated VM probe executed the actual document keydown listener, URL inline handler, textarea handler, and Monaco shortcut registration with Send active and `sendRequest` counted. Method/header/form controls and the page surface each produced zero sends; URL, textarea, and Monaco positive controls each produced one. Assertions passed on an independent rerun. DOM/event delivery and editor registration were simulated; no native browser or network request was used. The page has no native form submission route, and the desktop code has no alternate accelerator for this shortcut.

## BUG-030 — Browser cleanup failures hide pending work and Stop retries

- **Severity:** Low.
- **Location:** `src/interceptors/browser-interceptor.js:675`–`727`, `821`–`847`, `1279`–`1294`; `src/ui/app.js:6269`–`6273`, `6326`–`6329`, `6380`, `6389`, `6408`, `7438`; `src/interceptors/existing-browser-interceptor.js:42`–`48`, `151`–`162`, `227`–`252`, `404`–`409`, `450`–`464`, `528`–`563`, `643`–`664`.
- **Trigger:** Close an isolated browser after interception starts, and let removal of its managed temporary profile fail, for example because a file remains locked.
- **Actual:** The backend retains the profile with `active:false` and `cleanupPending:true` so Stop can retry removal. The UI recognizes cleanup-only state only for System Proxy; the browser card shows neither a cleanup warning nor Stop and instead offers Start. Start can retry cleanup but then launches another browser, so it does not provide the intended cleanup-only action. Status events also omit the retained cleanup flag.
- **Expected:** Show retained browser cleanup ownership and offer Stop to retry cleanup without starting interception again.
- **Evidence:** An isolated probe on bundled Node.js 26.7.0 executed actual browser activation/exit handling, manager listing/deactivation, and the UI card renderer. Simulated profile removal failed once with `profile locked`. The backend reported inactive with cleanup pending, but the rendered Chrome card had no Stop/warning and its primary action called `toggleInterceptor('chrome', false)`. An inactive System Proxy control with the same flag rendered both Stop and the warning. Calling the actual manager Stop then removed the profile and cleared cleanup ownership. Assertions passed on an independent rerun. Process discovery/events, cleanup and DOM were simulated; no native browser or locked-directory experiment was run. Existing cleanup-only tests verify backend Stop/restart behavior but do not exercise this renderer contract.
- **Related Global Chrome journal failure (pass 22):** After a launched Global Chrome process exits, failure to remove its ownership journal leaves `needsDeactivation=true` and a retained recovery error, but the emitted event says only `active:false, reason:'exited'`. No cleanup state is exposed to the card, so it offers Start and loses Stop. A separate probe executed actual activation/journal persistence, child-exit handling, manager operations, and UI status/card functions, simulating `EBUSY` only for deletion of a temporary fixture journal. The card lacked Stop; an attempted Start with the simulated lock retained silently changed backend activity to true during reconciliation, then rejected with an ownership-journal error and emitted no corrective status event. Explicit Stop after releasing the lock removed the journal and cleared ownership. Assertions passed on an independent rerun; OS processes and DOM were simulated, with no native browser or system-state changes. This is a temporarily hidden cleanup action, not permanent blockage: the UI's failed-Start handler schedules a list reload, and a full refresh can restore Stop while removal still fails or finish cleanup after the lock clears.

## BUG-031 — Startup instructions and the footer ignore the configured proxy bind address

- **Severity:** Low.
- **Location:** `src/index.js:130`–`134`, `150`, `263`, `273`; `src/proxy/proxy-server.js:406`, `4174`–`4175`; `src/interceptors/proxy-bind-reachability.js:46`–`58`; `src/ui/app.js:1301`–`1312`; `src/ui/index.html:674`.
- **Trigger:** Start the standalone server with a supported specific bind address, such as `PROXY_BIND_HOST=127.0.0.2`, and configure a client using the proxy address printed in the startup summary/instructions.
- **Actual:** The proxy listens on the configured address, but the startup summary and final configuration instruction hardcode `127.0.0.1`. The UI's Proxy footer does the same, ignoring the correct `proxyAddress` supplied by its initialization message. Connecting to that advertised address fails because the proxy is bound elsewhere. The lower-level proxy log and manual-setup/API address formatting use the configured host, leaving contradictory displays.
- **Expected:** Derive the advertised local proxy address from the actual bind host, using the existing wildcard-to-loopback and IPv6 formatting helpers.
- **Evidence:** A bundled-Node.js 26.7.0 probe resolved `127.0.0.2` with the actual helper, started an actual loopback `ProxyServer` with a fixed-response mock, and executed the actual startup-summary block with its assigned port. The printed instruction named `127.0.0.1`; an HTTP request to that address returned `ECONNREFUSED`, while the otherwise identical request to `127.0.0.2` returned HTTP 200 and body `ok`. The summary block was extracted into a VM; the full application startup was not run. No certificate, trust, system-proxy, or saved settings changes occurred. Existing bind tests cover default and wildcard listener addresses without checking these startup instructions.
- **Related footer evidence:** The actual UI `handleWsMessage` initialization handler received `proxyAddress:'127.0.0.2:8081'` and stored it correctly in configuration, but rendered `127.0.0.1:8081` in the visible footer. A default-address control matched correctly. Assertions passed on an independent rerun with DOM, WebSocket send, and unrelated initialization loaders stubbed. Source inspection found no other footer setter; `loadConfig` does not repair it. No native UI or WebSocket transport was exercised.
