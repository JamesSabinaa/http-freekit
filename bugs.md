# Bug audit

This file records reproducible defects found during a fresh repository-wide audit of `main` at `46e0b5d`. The previous completed audit was intentionally removed before this pass. Evidence and line numbers below describe the audited revision and may differ from the fixed implementation on current `main`.

## Current status

All 13 findings from the fresh audit are **Fixed** and committed on current `main`: 0 high, 7 medium, 2 low/medium, and 4 low. The post-fix repository-wide suite, syntax gate, dependency audits, and independent integration reviews are clean; there are no known open findings from this audit.

## Audit completion gate

A clean audit requires one complete repository-wide pass with no new findings. A complete pass covers application startup and settings, API and MCP, proxy protocols and mocking, interceptors, Electron and packaging, UI state and rendering, dependencies, documentation, and tests.

| Pass | Result | Clean-pass streak |
| --- | --- | ---: |
| 1 | 13 new bugs found and independently reproduced | 0/1 |
| 2 | 13/13 fixed; repository-wide tests, syntax checks, dependency audits, and integration reviews passed | 1/1 |

## Process lifecycle and interceptors

### BUG-424 — Low — Browser launch confirmation can miss an already-failed opener

- Status: **Fixed** — committed in `13bc3c6` (`Fix spawn and Send cleanup races`).
- Evidence: `waitForSpawnStability()` declares success when its wall-clock grace timer fires and `child.exitCode`/`signalCode` have not yet been populated (`src/interceptors/command-runner.js:19-85`). Browser URL opening relies on that result before unreferencing the child (`src/interceptors/browser-interceptor.js:88-100`).
- Impact: under backend event-loop delay, Open can report success even though the browser opener exited nonzero and no tab opened.
- Reproduction: spawn `process.execPath` so it exits with code 9, then block the event loop for 750 ms from `setImmediate` during the 500 ms confirmation window. The helper resolved with `exitCode === null` in 5/5 runs; the delayed child exit was delivered only after its listener had been removed.
- Expected: an exit that occurred during the grace period must reject even when event delivery was delayed; deadline handling should allow queued process status to settle before declaring success.

## Proxy, TLS, API, and MCP

### BUG-425 — Medium — Readable but invalid TLS material is persisted as active

- Status: **Fixed** — committed in `aa84ec2` (`Validate TLS settings and buffered captures`).
- Evidence: client-certificate and trusted-CA preparation reads the configured files but does not parse the PFX/passphrase or PEM certificate before mutation (`src/proxy/proxy-server.js:2807-2920`; API mutation paths at `src/api/api-server.js:2062-2133,2169-2203`).
- Impact: settings and UI report TLS material as configured, while matching HTTPS connections fail later when the material is used.
- Reproduction: submit readable files containing ordinary text as a PFX and CA. Both APIs return 200 and persist them; the PFX later fails TLS context creation and the invalid CA does not trust a private origin.
- Expected: validate the complete PFX, passphrase, and CA certificate before atomically installing or persisting them; invalid candidates should return 400 and preserve prior state.

### BUG-426 — Low — Unknown TLS fingerprint IDs silently select Node defaults

- Status: **Fixed** — committed in `aa84ec2` (`Validate TLS settings and buffered captures`).
- Evidence: the fingerprint API accepts any value (`src/api/api-server.js:2348-2361`), `setTlsFingerprint()` stores it (`src/proxy/proxy-server.js:2961-2968`), and an unknown ID falls through to base Node TLS options (`:8184-8187`).
- Impact: persisted and reported state claims an active fingerprint profile that is not applied, changing upstream TLS behavior without warning.
- Reproduction: post `not-a-real-profile`; the API returns 200 and persists it. The prior Chrome preset's fingerprint-specific TLS options disappear from the resulting connection options.
- Expected: accept only defined presets and explicit supported modes such as `default` or `passthrough`; reject unknown IDs without mutation.

### BUG-427 — Low/Medium — Buffering changes compressed request capture into undecoded base64

- Status: **Fixed** — committed in `aa84ec2` (`Validate TLS settings and buffered captures`).
- Evidence: streaming capture passes `Content-Encoding` and `Content-Type` to `_safeBodyString()` (`src/proxy/proxy-server.js:975-987`), while buffered HTTP, TLS, H2, mock, and breakpoint request paths call it with only the body buffer (for example `:4273,5022,5996,8847-8857`).
- Impact: merely enabling a body-aware rule changes an otherwise identical gzip request from readable decoded text into an `application/octet-stream` data URI and loses `requestBodyContentDecoded` provenance.
- Reproduction: proxy the same gzip POST normally and with a nonmatching body rule that forces buffering. The first capture is UTF-8 with `requestBodyContentDecoded: true`; the second is base64 with no decoded marker.
- Expected: all buffered request captures must supply the original content headers and produce the same display/provenance as streaming capture.

### BUG-428 — Medium — Malformed TLS-passthrough replacement clears the saved list

- Status: **Fixed** — committed in `5a3df3e` (`Validate traffic management inputs`).
- Evidence: `POST /api/tls-passthrough` forwards `hosts || []` without requiring an array (`src/api/api-server.js:2022-2029`), and the setter converts every non-array into an empty list (`src/proxy/proxy-server.js:2722-2726`).
- Impact: a malformed replacement request silently disables TLS passthrough and durably overwrites a working configuration.
- Reproduction: seed `['before.test']`, then post `{ "hosts": "malformed.test" }`. The API returns 200, runtime becomes `[]`, and settings persist `[]`.
- Expected: return 400 before runtime or persistence mutation when `hosts` is not a valid array.

### BUG-429 — Medium — Repeated breakpoint lifecycle queries resume the wrong request

- Status: **Fixed** — committed in `5a3df3e` (`Validate traffic management inputs`).
- Evidence: the pending-breakpoint resume route treats every non-string `trafficLifecycleId` as omitted (`src/api/api-server.js:1928-1940`). Express supplies an array for duplicate query keys, causing ID-only selection.
- Impact: a malformed request intended for one paused lifecycle can resume and modify a different request that reused the same ID.
- Reproduction: queue `duplicate/life-1` then `duplicate/life-2`; post `...?trafficLifecycleId=life-2&trafficLifecycleId=life-2`. The API returns 200, resolves `life-1`, and leaves `life-2` pending.
- Expected: require a scalar lifecycle query and return 400 for duplicate or nested forms before resuming anything.

### BUG-430 — Medium — Invalid base64 traffic provenance is accepted and exported as different bytes

- Status: **Fixed** — committed in `5a3df3e` (`Validate traffic management inputs`) with canonical URI hardening in `5ee8dec` (`Require canonical traffic data URIs`).
- Evidence: native traffic import validates the encoding label but not the body's canonical data-URI/base64 form (`src/api/api-server.js:900-966`). HAR conversion recognizes base64 only when that form can be unwrapped (`src/api/har-converter.js:128-143`).
- Impact: a record accepted as binary can later be exported as ordinary UTF-8 text, silently changing the represented request bytes.
- Reproduction: import a POST with `requestBody: "AQID"` and `requestBodyEncoding: "base64"`. Import returns 200, but HAR output contains text `AQID` without `encoding: "base64"`, representing four ASCII bytes instead of `01 02 03`.
- Expected: reject noncanonical base64 bodies atomically or preserve their exact binary meaning across every export path.

### BUG-431 — Low/Medium — MCP selection silently chooses the first reused request ID

- Status: **Fixed** — committed in `5a3df3e` (`Validate traffic management inputs`).
- Evidence: `select_request` accepts a lifecycle discriminator but an ID-only call selects the first match (`src/mcp/mcp-server.js:1032-1074`), unlike the ambiguity handling already used by detail and REST traffic operations.
- Impact: an MCP client can visibly select the wrong exchange when request IDs have been reused.
- Reproduction: store `duplicate/life-1` and `duplicate/life-2`, then call `select_request` with only `request_id: "duplicate"`. It reports success and broadcasts selection of `life-1`.
- Expected: reject ambiguous ID-only selection and require `traffic_lifecycle_id`, while retaining legacy behavior only for a unique ID.

### BUG-432 — Low — Synchronous Send construction errors retain internal proxy contexts

- Status: **Fixed** — committed in `13bc3c6` (`Fix spawn and Send cleanup races`).
- Evidence: `_sendRequest()` registers its internal Send token/request ID before constructing the Node request (`src/api/api-server.js:3143-3220`), but synchronous construction failures do not call the cancellation cleanup used by later failures.
- Impact: each malformed Send request retains internal authentication/routing entries and a timer until the roughly 65-second TTL expires; repeated failures create avoidable transient state growth.
- Reproduction: call Send with an invalid header name such as `bad header`. Node rejects synchronously after one internal-context registration; the request rejects with zero cancellation calls and both context maps remain populated until expiry.
- Expected: every failure after registration must immediately cancel and remove the internal context.

## Send, import/export, and UI

### BUG-433 — Medium — Multipart snippets retain stale captured Content-Length

- Status: **Fixed** — committed in `0135c57` (`Harden request import and export semantics`).
- Evidence: multipart generation omits captured `Content-Type` but keeps `Content-Length` through `getExportHeaders(req, true)` (`src/ui/request-export.js:33-44,151-154`). The Node generator then adds a second computed Content-Length (`:263-287`); other formats keep the stale value while rebuilding a different body/boundary.
- Impact: generated snippets can be rejected, truncated, or hang because their framing describes the captured body rather than the generated MIME body.
- Reproduction: export a multipart POST with captured `Content-Length: 3` and a longer field. The Node snippet emits both length 3 and `String(body.length)`; a loopback Node server rejects it with `HPE_UNEXPECTED_CONTENT_LENGTH` before its request handler runs.
- Expected: remove captured framing whenever reconstructing multipart data, then let the client compute it or emit exactly one byte-accurate length.

### BUG-434 — Medium — JavaScript snippets mishandle credentials embedded in URLs

- Status: **Fixed** — committed in `0135c57` (`Harden request import and export semantics`).
- Evidence: the Fetch generator keeps URL userinfo (`src/ui/request-export.js:474-483`), while the Node generator decomposes the URL into hostname/port/path without adding authentication (`:487-513`). The Send API separately implements the correct Basic-auth conversion (`src/api/api-server.js:3109-3124`).
- Impact: Fetch snippets fail before sending, while Node snippets silently omit credentials and can replay a materially different request.
- Reproduction: export `GET http://alice:secret@127.0.0.1:<port>/private`. Fetch throws because credential-bearing request URLs are forbidden; the Node snippet succeeds but the origin receives no `Authorization` header.
- Expected: when no explicit Authorization exists, synthesize Basic authorization and strip URL userinfo before generating JavaScript requests.

### BUG-435 — Medium — cURL import silently changes file-backed cookie and header options

- Status: **Fixed** — committed in `0135c57` (`Harden request import and export semantics`).
- Evidence: header parsing silently ignores `-H/--header` operands without a colon, including cURL's `@file`/`@-` forms (`src/ui/curl-parser.js:197-208`), while cookie parsing always turns `-b/--cookie` operands into a literal Cookie value (`:227-229`).
- Impact: a pasted command can send different headers or credentials from the original without any warning.
- Reproduction: real cURL with `-H @-` reads and sends `X-Probe: from-file`, but the importer produces no header. Real cURL with `-b -` reads a cookie record and sends `session=from-file`, while the importer produces literal `Cookie: -`.
- Expected: reject file/stdin-backed operands atomically, as data options already do, or explicitly resolve their input before importing.

### BUG-436 — Low — Unsupported HAR URL schemes are mislabeled as HTTP

- Status: **Fixed** — committed in `0135c57` (`Harden request import and export semantics`).
- Evidence: renderer HAR normalization maps every scheme other than HTTPS/WS/WSS to `http` (`src/ui/har-import.js:62-68,230-236`); backend HAR import has the same fallback (`src/api/api-server.js:132-142,1473-1483`).
- Impact: imported protocol metadata contradicts the URL, producing misleading rows and downstream actions that later reject the actual scheme.
- Reproduction: import a valid HAR entry for `ftp://example.test/file`. The normalized record contains `protocol: "http"` while retaining the FTP URL; Send later rejects it as unsupported.
- Expected: reject unsupported schemes during HAR import, or preserve only a protocol the application genuinely supports.

## Verification

- Full post-fix `npm test`: 2,154 tests; 2,151 passed, 0 failed, 3 environment-dependent skips.
- Independent integrated review for BUG-424 and BUG-428–436: 139/139 focused tests passed, with no remaining concrete blocker.
- Independent review approved BUG-425–427; 19/19 focused real TLS/fingerprint/provenance tests and 593/593 broad proxy/certificate/settings/mocking tests passed.
- Syntax validation passed for all 474 tracked JavaScript/CJS files.
- `npm audit --audit-level=high` and `npm audit --omit=dev --audit-level=high` both report 0 vulnerabilities.
- Runtime regressions use real child processes, cryptographically valid and invalid PFX/PEM material, loopback HTTP/TLS servers, real cURL, and API/MCP harnesses. They cover every original reproduction plus cross-format and cross-protocol edge cases discovered during fix review.
