# Bug audit

This file records reproducible defects found during a repository-wide audit. Findings are grouped by subsystem, not by discovery order. Line numbers refer to the `main` revision current when each finding was recorded and may shift as concurrent fixes land. Findings without a status are open at the latest completed audit pass; explicit Fixed or Partially fixed statuses preserve changes made during the audit.

## Audit completion gate

The requested stopping rule is two consecutive complete repository-wide audit loops with no new findings. A complete loop covers application startup/settings, API/MCP, proxy protocols and mocking, interceptors, Electron/packaging, UI state/rendering, dependencies, and tests.

During Loop 4, HEAD advanced through ten concurrent bug-fix commits. The corresponding resolved entries (BUG-004, BUG-008, BUG-032, BUG-033, BUG-034, BUG-055, BUG-068, BUG-077, BUG-086, and BUG-103) were removed, and Loop 4 restarted against the rebased result at `6ecbfec` rather than treating stale findings as open.

| Loop | Result | Clean-loop streak |
| --- | --- | --- |
| 1 | New bugs found; documented below | 0/2 |
| 2 | New bugs found; documented below | 0/2 |
| 3 | 29 new bugs found; documented below | 0/2 |
| 4 | 31 new bugs found; documented below | 0/2 |
| 5 | 27 new bugs found; documented below | 0/2 |
| 6 | 11 new bugs found; documented below | 0/2 |
| 7 | 13 new bugs found; documented below | 0/2 |
| 8 | 14 new bugs found; documented below | 0/2 |
| 9 | 12 new bugs found; documented below | 0/2 |
| 10 | 13 new bugs found; documented below | 0/2 |
| 11 | 7 new bugs found; documented below | 0/2 |
| 12 | 8 new bugs found; documented below | 0/2 |
| 13 | 4 new bugs found; documented below | 0/2 |
| 14 | No new bugs found | 1/2 |
| 15 | 4 new bugs found; documented below | 0/2 |
| 16 | 4 new bugs found; documented below | 0/2 |
| 17 | 3 new bugs found; documented below | 0/2 |
| 18 | 9 new bugs found; documented below | 0/2 |
| 19 | 11 new bugs found; documented below | 0/2 |
| 20 | 15 new bugs found; documented below | 0/2 |
| 21 | 5 new bugs found; documented below | 0/2 |
| 22 | 8 new bugs found; documented below | 0/2 |
| 23 | 6 new bugs found; documented below | 0/2 |
| 24 | 3 new bugs found; documented below | 0/2 |
| 25 | 8 new bugs found; documented below | 0/2 |
| 26 | 3 new bugs found; documented below | 0/2 |
| 27 | 3 new bugs found; documented below | 0/2 |
| 28 | 1 new bug found; documented below | 0/2 |
| 29 | 2 new bugs found; documented below | 0/2 |
| 30 | 2 new bugs found; documented below | 0/2 |
| 31 | 2 new bugs found; documented below | 0/2 |
| 32 | 1 new bug found; documented below | 0/2 |
| 33 | 1 new bug found; documented below | 0/2 |

## API, MCP, and persistence

### BUG-001 — Critical — Management API and WebSocket ignore the Electron session token

- Status: **Fixed**.

- Evidence: `src/api/api-server.js:482-490` allows every cross-origin caller with `Access-Control-Allow-Origin: *`. The token is checked only by the browser-open route at `:768-770`; traffic, settings, rules, Send, shutdown, WebSocket upgrade, and WebSocket messages have no equivalent check (`:558-577`, `:784-914`, `:1119-1128`, `:1261-1315`).
- Impact: a web page can read captured credentials and bodies, alter proxy behavior, issue requests, clear data, or stop the server. WebSockets are independently exposed because their upgrade path validates neither token nor `Origin`.
- Reproduction: start an `ApiServer` with `authToken: "secret"`, seed a traffic record, and request `/api/traffic` with a foreign `Origin` and no authorization. It returns `200`, `Access-Control-Allow-Origin: *`, and the full record. The current auth test covers only `/api/interceptors/:id/open`.

### BUG-002 — High — MCP SSE exposes captured traffic without authentication

- Status: **Fixed**.

- Evidence: `src/mcp/mcp-server.js:436-470` registers the SSE and message routes without token, `Origin`, or host validation. `get_request_detail` returns full headers and bodies at `:197-216`; the global wildcard CORS middleware applies.
- Impact: an untrusted local or browser client can create an MCP session and read cookies, authorization headers, request bodies, and response bodies.
- Reproduction: connect to `/mcp/sse`, post an MCP `get_request_detail` call to its session, and observe the complete seeded traffic record without credentials.

### BUG-003 — High — `--mcp-stdio` writes non-protocol logs to stdout

- Status: **Partially fixed**.
- Resolution: The direct Node stdio mode redirects application logs before startup. The packaged Electron bridge emits a bare CRLF on stdout before any JSON-RPC response; the SDK attempts to parse the empty line and rejects the transport.

- Evidence: `src/index.js:25-136` prints the banner plus CA, proxy, and API startup logs before `console.log` is redirected to stderr at `:138`.
- Impact: stdio MCP clients receive plain text before JSON-RPC framing and can reject the server as an invalid MCP process.
- Reproduction: launch the generated bridge through Electron and inspect raw stdout before sending JSON-RPC; it begins with bytes `0d0a`, which the SDK reports as `Unexpected end of JSON input`. The direct Node `--mcp-stdio` path remains clean.

### BUG-005 — Medium — Minimally malformed imports poison HAR and MCP consumers

- Status: **Fixed**.

- Evidence: `/api/traffic/import` accepts arbitrary array elements at `src/api/api-server.js:651-660`. `src/api/har-converter.js:33` and MCP detail/search at `src/mcp/mcp-server.js:157,214` unconditionally format timestamps; MCP search also calls `.toLowerCase()` on imported body fields at `:156-157` without type validation.
- Impact: data the API accepts can make HAR export or MCP tools throw `RangeError`/`TypeError` until the traffic log is cleared.
- Reproduction: import `{"requests":[{"id":"x"}]}`, then export HAR or search traffic through MCP.

### BUG-006 — Medium — HAR round trips still lose cookies, form parameters, and request protocol

- Status: **Fixed**.
- Resolution: Binary encoding, duplicate headers, cookies, form parameters, MIME types, and protocol metadata are all preserved.

- Evidence: HAR import ignores standard request/response cookie arrays, `postData.params`, and `request.httpVersion`; export still hard-codes empty cookie arrays and derives protocol only from the internal request record (`src/api/api-server.js` HAR-import mapping and `src/api/har-converter.js:40,55`).
- Impact: cookie metadata and form parameter structure vanish, and imported HTTP/2 requests can re-export as HTTP/1.1.
- Reproduction: import a HAR entry containing cookies, form params, and `httpVersion: "HTTP/2"`, then re-export and compare those fields.

### BUG-007 — Medium — `/api/shutdown` bypasses graceful cleanup

- Status: **Fixed**.

- Evidence: `src/api/api-server.js:1119-1123` calls `process.exit(0)` directly. The actual shutdown path at `src/index.js:164-172` first stops MCP, deactivates interceptors, and closes both servers.
- Impact: the desktop shutdown request can leave interceptor processes, system/device proxy configuration, and temporary profiles behind.
- Reproduction: activate an interceptor and call `/api/shutdown`; the centralized cleanup handler is never invoked.

### BUG-057 — Medium — Settings write failures are reported as successful saves

- Status: **Partially fixed**.
- Resolution: Settings now roll back and return an error when persistence fails, but renderer save handlers that ignore unsuccessful HTTP responses can still report the failed change as saved.

- Evidence: `src/settings.js:25-31` catches write errors, logs them, and returns no failure. `set()`/`setAll()` at `:39-47` therefore complete normally, and API setting routes return success regardless of whether disk persistence worked.
- Impact: on a read-only/full filesystem the UI says settings were saved, the in-memory value works temporarily, and every change disappears on restart.
- Reproduction: make `settings.json` unwritable, change a setting through the API, observe a success response, then restart and observe the old value.

### BUG-058 — Medium — Settings persistence is non-atomic and can destroy all configuration

- Status: **Fixed**.

- Evidence: `src/settings.js:27` writes JSON directly to the sole `settings.json` path with `writeFileSync`, which truncates the existing file before the replacement is complete. `_load()` resets all settings to `{}` after any parse/read failure at `:12-21`.
- Impact: a crash, disk-full condition, or interrupted write can leave a partial file; the next start silently discards every saved proxy, TLS, rule, and UI setting.
- Reproduction: interrupt/truncate `settings.json` during a save and restart; loading logs a parse error and initializes empty settings.

### BUG-009 — Medium — Port-range settings are neither persisted nor used

- Status: **Fixed**.

- Evidence: the UI promises first-free-port selection in `src/ui/index.html:400`; `src/api/api-server.js:1095-1110` only assigns range fields to the current proxy object. Startup always selects `PROXY_PORT` or 8081 at `src/index.js:22,69`.
- Impact: saving 9000-9010 and restarting still binds the proxy to 8081.
- Reproduction: save a non-default range, restart, and inspect `/api/config`.

### BUG-064 — Medium — Send requests can hang forever

- Status: **Fixed**.

- Evidence: `src/api/api-server.js:1174-1208` creates the outbound request without a connection, idle, or total timeout. The middleware's `req.setTimeout()` at `:495-499` applies to the inbound management request, not this outbound socket.
- Impact: an origin that accepts a connection but never responds leaves the API handler and socket pending indefinitely; repeated requests accumulate resources.
- Reproduction: Send a request to a test server that accepts the request and never sends response headers.

## Proxy, TLS, protocols, and mock rules

### BUG-010 — High — Upstream HTTPS certificates are never verified

- Status: **Fixed**.

- Evidence: `_getUpstreamTlsOptions()` forces `rejectUnauthorized: false` at `src/proxy/proxy-server.js:3036-3040`; H2, mock forwarding, webhooks, and Send repeat it at `:1160-1166`, `:2258-2264`, `:2561-2564`, `:3436-3442`, `:3564-3570`, and `src/api/api-server.js:1180-1187`. `httpsWhitelist` is only stored/reported at `proxy-server.js:257-259,4219-4221`.
- Impact: invalid, expired, wrong-host, and self-signed upstream certificates are accepted for every host even when the whitelist is empty, allowing silent upstream interception.
- Reproduction: proxy an HTTPS origin using an untrusted certificate without adding its host to the whitelist; the request succeeds.

### BUG-011 — High — Client certificates and additional trusted CAs are no-ops

- Status: **Fixed**.

- Evidence: `src/proxy/proxy-server.js:247-255` assigns `clientCertificates` and `trustedCAs`, but no outbound connection path reads either collection; they appear again only in status output at `:4219-4221`.
- Impact: configured mTLS credentials are never sent and private-CA endpoints do not gain trust.
- Reproduction: configure a client certificate for an mTLS origin or a CA for a private-PKI origin and connect; behavior is unchanged.

### BUG-012 — High — Filtered proxy credentials and spoofing headers are reintroduced

- Status: **Fixed**.

- Evidence: `_rawHeadersToObject()` removes `proxy-authorization`, `proxy-connection`, `x-forwarded-for`, and related fields at `src/proxy/proxy-server.js:270-309`, but forwarding then merges the unfiltered `clientReq.headers` over that result at `:638-640`, with the same pattern in HTTPS H1 paths around `:1455` and `:2058`.
- Impact: proxy-only credentials can be disclosed to origins and client-supplied forwarding headers can bypass the intended normalization.
- Reproduction: send `Proxy-Authorization` and `X-Forwarded-For` through the proxy to a recording HTTP origin; both arrive unchanged.

### BUG-013 — High — TLS passthrough and plain WebSockets bypass the upstream proxy

- Status: **Fixed**.

- Evidence: passthrough CONNECT uses direct `net.connect()` at `src/proxy/proxy-server.js:855-890`; `ws://` upgrade uses direct `http.request()` at `:382-390`. Neither path checks `this.upstreamProxy`.
- Impact: traffic leaks the user's direct network identity or fails when the destination is reachable only through the configured upstream proxy.
- Reproduction: configure a counting upstream proxy, then open a passthrough TLS or plain WebSocket target; the target is hit and the upstream receives nothing.

### BUG-014 — High — Breakpoint mock actions never perform the real upstream exchange

- Status: **Fixed**.

- Evidence: in plain HTTP, `breakpoint-request` resumes into the default synthetic response and `breakpoint-response` pauses before any upstream request at `src/proxy/proxy-server.js:3596-3770`. Equivalent branches exist for HTTPS at `:1282-1397` and H2 at `:2374-2475`.
- Impact: “resume without changes” can return an empty or `Breakpoint released` synthetic 200, while response breakpoints cannot inspect the actual response.
- Reproduction: attach request/response breakpoint rules in front of a counting origin, resume unchanged, and observe a 200 synthetic body with zero origin hits.

### BUG-015 — High — HTTP/1.1 clients in H2 `all` mode lose almost every mock action

- Status: **Fixed**.

- Evidence: `_serveMockResponseH1OnH2()` at `src/proxy/proxy-server.js:2492-2531` reduces every action to status, headers, and body. It omits close/reset, forward, serve-file, delay/pre-steps, webhook, and breakpoint behavior.
- Impact: identical rules behave differently solely because the client negotiated HTTP/1.1 rather than H2.
- Reproduction: in `http2Enabled: "all"`, apply a `close` rule to an HTTP/1.1 request; it receives an ordinary empty 200 instead of a closed connection.

### BUG-016 — Medium/High — HTTP trailers are never forwarded in either direction

- Status: **Fixed**.

- Evidence: H1 response forwarding reads trailers at `src/proxy/proxy-server.js:719,1533` but never calls `addTrailers`; H2 response forwarding around `:2675-2695` has no trailer listener or `sendTrailers` path. H1 request handlers at `:580-583,1035-1038,1930-1933` and H2 at `:1684-1688` consume only body data/end, never `req.trailers`, a trailer event, or `addTrailers`.
- Impact: gRPC `grpc-status`/`grpc-message`, request digests, and integrity trailers disappear, making exchanges incomplete or invalid.
- Reproduction: proxy a chunked request containing `Trailer: Digest` and a response containing trailers; inspect both sides after forwarding.

### BUG-017 — Medium — HTTP/2 forwarding corrupts multiple `Set-Cookie` fields

- Status: **Fixed**.

- Evidence: `src/proxy/proxy-server.js:1801-1805,1843-1847` joins every array-valued response header with `", "`, including `Set-Cookie`, whose values cannot be safely comma-combined.
- Impact: clients can fail to store one or both cookies, especially when an `Expires` attribute itself contains a comma.
- Reproduction: return two `Set-Cookie` headers over the H2 forwarding path and inspect the forwarded field.

### BUG-018 — Medium — Captured bodies and decompression are unbounded

- Status: **Fixed**.

- Evidence: request and response chunks are accumulated without a cap in multiple H1/H2 paths (`src/proxy/proxy-server.js:580-583`, `:702-705`, `:1035-1038`, `:1522-1525`, `:1684-1688`, `:1830-1833`, `:1930-1933`, `:2067-2070`, `:2673-2691`) and by Send at `src/api/api-server.js:1189-1192`. `_decompressBody()` synchronously expands compressed data at `proxy-server.js:3943-3961` before any display truncation.
- Impact: large transfers or highly expanding compressed bodies can exhaust memory and block the event loop.
- Reproduction: proxy a large/chunked upload or a small, high-ratio compressed response while monitoring process memory and responsiveness.

### BUG-019 — Medium — H2 breakpoint URL and method edits are ignored

- Status: **Fixed**.

- Evidence: `src/proxy/proxy-server.js:1742-1749` explicitly does nothing for method changes and never processes URL changes; forwarding later uses the original method, hostname, and path at `:1794-1825`.
- Impact: the UI reports an edited resumed request while the original request is sent.
- Reproduction: pause an H2 request, change method and URL, resume, and inspect the origin request.

### BUG-020 — Medium — H1 forward actions ignore header pre-steps

- Status: **Fixed**.
- Evidence: plain-HTTP pre-steps mutate `clientReq.headers` at `src/proxy/proxy-server.js:3351-3359`, but `forward` reconstructs headers only from unchanged `clientReq.rawHeaders` at `:3427`. The HTTPS mock-forward path repeats the mismatch at `:1074-1082,1150`; H2 uses the mutated header object.
- Impact: add/remove-header transformations appear in logged data but never reach the forwarded origin.
- Reproduction: create an add-header pre-step plus a forward action and inspect headers at the destination.

### BUG-021 — Medium — WebSocket frame parsing has unbounded quadratic buffering

- Status: **Fixed**.
- Evidence: `src/proxy/ws-frame-parser.js:43` concatenates the complete retained buffer for every incoming chunk; `:75-99` accepts arbitrary 64-bit advertised lengths with no cap. Peer-controlled bytes enter this parser from `src/proxy/proxy-server.js:423-444`.
- Impact: a huge declared frame delivered slowly causes repeated copies of all retained bytes, consuming increasing memory and CPU.
- Reproduction: advertise a very large frame length and trickle payload chunks through a proxied WebSocket.

### BUG-063 — Medium — Corrupt or mismatched CA files are never recovered

- Evidence: `src/proxy/certificate-authority.js:20-38` assumes that any existing `ca.pem` and `ca.key` parse and belong together. Parse failures are not caught, and no public/private key match is verified before the pair is used to sign host certificates.
- Impact: a partial/corrupt file prevents startup entirely; a valid but mismatched key lets startup succeed but produces host certificates clients cannot validate against the advertised CA.
- Reproduction: replace `ca.key` with invalid text to get a fatal startup error, or with a different valid RSA key and verify a generated leaf against `ca.pem`.

### BUG-100 — High — H2 failure fallback replays non-idempotent requests

- Evidence: all upstream-H2 paths catch any `_makeH2Request()` error and fall through to a second H1 request without `_canSafelyReplayRequest()` checks at `src/proxy/proxy-server.js:1496-1519`, `:1791-1822`, and `:2031-2055`.
- Impact: payments, mutations, and uploads can execute twice if the H2 origin processes a POST and resets before responding.
- Reproduction: have an H2 origin count/process a POST then reset its stream; FreeKit sends the same POST again over H1.

### BUG-101 — High — Malformed mock rules are accepted and later crash evaluation

- Status: **Partially fixed**.
- Resolution: Ordinary create/import validation now rejects several malformed rule shapes, but malformed persisted rules and rules nested in groups can still reach runtime matcher evaluation.
- Evidence: API create and replacement-import paths now call `hasCompleteMockMatchers()`, but `loadMockRules()` assigns persisted non-group rule objects without validating them. `_findMockRule()` still assumes `rule.matchers` is an array and calls `.every()`, while individual evaluators call string methods such as `.toLowerCase()` and `.startsWith()` on unvalidated fields.
- Impact: one invalid persisted rule can throw on every matching request and may terminate the Node process through an unhandled rejection.
- Reproduction: persist or otherwise load an enabled rule with `matchers: {}` and an action, then send a request; evaluation throws `rule.matchers.every is not a function`.

### BUG-102 — High/Medium — Transform and timeout actions silently become fixed 200s

- Evidence: plain action dispatch implements selected types at `src/proxy/proxy-server.js:3384-3755` then treats every unknown type as a fixed response at `:3757-3794`; no path implements `transform-request`, `transform-response`, or `timeout`. HTTPS/H2 dispatch at `:1107-1397,2223-2488` omits the same actions and additionally lacks some webhook/combined-breakpoint variants.
- Impact: valid rules displayed as transforming or timing out instead synthesize an empty successful response.
- Reproduction: save each advertised action type and request a matching URL; each returns an empty 200.

### BUG-104 — Medium — Send/mock-forward hang when a response aborts mid-body

- Status: **Partially fixed**.
- Resolution: Send now rejects aborted or errored response streams, but mock-forward still listens only for `data` and `end`, so an upstream partial-response disconnect can leave the forwarded request unsettled.
- Evidence: Send listens only for response `data`/`end` at `src/api/api-server.js:1190-1203`; request `error` does not receive response-stream aborts. Mock-forward repeats this at `src/proxy/proxy-server.js:1167-1195`, `:2265-2300`, and `:3443-3472`, with no response abort/error forwarding or timeout.
- Impact: a common upstream partial-response disconnect leaves clients, API handlers, and sockets unsettled indefinitely.
- Reproduction: send headers and a partial body from an origin, destroy its socket, and observe neither rejection nor a 502.

### BUG-105 — Medium — Breakpoint header editing cannot delete headers

- Evidence: resume paths merge edited headers with `Object.assign()` instead of replacing the original set (`src/proxy/proxy-server.js:628-630`, `:1320`, `:1441-1443`, `:1744`, `:1989`, `:2410`, `:3628`, `:3712`).
- Impact: removing Authorization or another problematic header in the editor has no effect at the origin.
- Reproduction: delete a header from the resume JSON and inspect the forwarded request.

### BUG-106 — Medium — H1 breakpoint URL rewrites retain Host and the old transport

- Evidence: plain H1 changes `targetUrl` at `src/proxy/proxy-server.js:622-624,3624-3626` but builds headers from the old Host at `:638-680`. Request-library selection around `:696` and HTTPS paths at `:1554-1563,2097-2107` does not follow an HTTP↔HTTPS rewrite.
- Impact: rewritten requests reach the wrong virtual host or use TLS/plaintext against the wrong scheme.
- Reproduction: rewrite a request to a second local origin and inspect the Host header; then try a cross-scheme rewrite.

### BUG-107 — Medium — Editing a chunked breakpoint body sends illegal framing

- Evidence: `_setContentLength()` at `src/proxy/proxy-server.js:210-215` removes only old Content-Length and leaves Transfer-Encoding. Body-edit paths then add Content-Length at `:631-634`, `:1321-1324`, `:1444-1447`, `:1745-1748`, `:1990-1993`, `:2411-2414`, `:3629-3632`, and `:3713-3715`.
- Impact: the origin receives both `Content-Length` and `Transfer-Encoding`, commonly rejects the request, and may trigger request-smuggling defenses.
- Reproduction: edit a chunked POST body at a breakpoint; Node origin parsing fails before its handler.

### BUG-108 — Medium — H2 upstreams ignore the selected TLS fingerprint

- Status: **Partially fixed**.
- Resolution: Named TLS fingerprint presets now apply when creating H2 sessions. Passthrough H2 still receives no captured ClientHello, and changing the selected fingerprint does not evict already-cached H2 sessions.
- Evidence: H1 upstreams spread `_getUpstreamTlsOptions()` at `src/proxy/proxy-server.js:1459,1825,2062`; `_getH2Session()` uses only verification/ALPN options at `:2556-2564` and never applies the selected fingerprint/ClientHello behavior.
- Impact: Chrome/Safari/Firefox/passthrough fingerprint settings silently do nothing for H2-capable origins.
- Reproduction: select different fingerprint presets, connect to an H2 fingerprint recorder, and compare ClientHello data.

### BUG-109 — Medium — One transient H2 failure blacklists an origin until restart

- Evidence: `_getH2Session()` immediately rejects blacklisted origins at `src/proxy/proxy-server.js:2541`; any initial error or five-second timeout adds the origin at `:2575-2581,2596-2605`. The set clears only during full shutdown at `:2635-2644`.
- Impact: after a temporary outage, an H2-only origin stays unreachable for the rest of the process because every request tries H1.
- Reproduction: fail the first H2 connection, restore the origin, and retry without restarting FreeKit.

### BUG-110 — Medium — H1 forwarding leaks hop-by-hop headers across connections

- Evidence: `_shouldStripUpstreamHeader()` at `src/proxy/proxy-server.js:289-309` does not remove standard hop-by-hop fields or names nominated by `Connection`; H1 forwarding passes them at `:638-680`, `:1451-1460`, and `:2054-2063`.
- Impact: connection-specific metadata crosses hops and can break pooling/framing or trigger proxy inconsistencies.
- Reproduction: send `Connection: X-Remove` plus `X-Remove: value`; both reach the origin.

### BUG-111 — Medium — Send irreversibly decodes binary responses as UTF-8

- Evidence: `src/api/api-server.js:1194-1200` always calls `responseBody.toString("utf8")` and returns no response encoding metadata.
- Impact: images, archives, protobuf, and arbitrary binary responses gain replacement characters and cannot be inspected/replayed faithfully.
- Reproduction: return bytes `00 ff 80 01`; re-encoding the Send body yields different bytes.

### BUG-112 — Medium — Compressed WebSocket messages are displayed as corrupt text

- Evidence: `src/proxy/ws-frame-parser.js:65-68` discards RSV bits and exposes no compression state. `src/proxy/proxy-server.js:507-526` directly UTF-8 decodes text frames even though the forwarded upgrade can negotiate `permessage-deflate`.
- Impact: common compressed text messages appear as gibberish/replacement characters.
- Reproduction: negotiate per-message deflate and send a compressed text frame through the proxy.

### BUG-113 — Medium — BottingTools hard-codes a non-portable Python command

- Evidence: `src/api/api-server.js:48-50` always executes `python3`, while the same file handles Windows candidates (`py -3`, `python`, `python3`) for generator integration at `:290-306`.
- Impact: provider listing/rotation fails with `ENOENT` on normal Windows Python installs that expose only `py.exe` or `python.exe`.
- Reproduction: use the integration on Windows with only the standard Python launcher installed.

### BUG-114 — Low/Medium — SOCKS passwords containing colons are truncated

- Evidence: `_connectViaSocks()` uses `proxy.auth.split(":")` at `src/proxy/proxy-server.js:3136-3139`, so only the segment before the second colon becomes the password.
- Impact: valid SOCKS credentials such as `user:pa:ss` fail on the plain-HTTP SOCKS path.
- Reproduction: configure that credential and inspect authentication delivered to a test SOCKS server.

### BUG-115 — Low/Medium — Valid multipart, cookie, and JSON matchers fail

- Evidence: multipart parsing retains quotes around `boundary="abc"` at `src/proxy/proxy-server.js:3293-3309`; cookie parsing splits on every `=` at `:3277-3283`; JSON exact matching compares property-order-sensitive `JSON.stringify()` output at `:3256-3261`. Host/hostname matchers compare normalized URL hosts to raw case-sensitive values at `:3206-3220`, and header wildcard conversion leaves regex metacharacters unescaped at `:3224-3233`.
- Impact: quoted multipart boundaries, padded cookie values, semantically equal reordered JSON, uppercase DNS matchers, and literal punctuation in wildcard header values can all produce false results.
- Reproduction: test a quoted boundary, `Cookie: token=abc=def`, reversed-key JSON, matcher `EXAMPLE.COM`, and header wildcard `a.b*` against `axb`.

### BUG-127 — Medium — Nested mock groups make their rules unmanageable

- Status: **Fixed**.

- Evidence: `/api/mock-rules/move-to-group` accepts a group as `ruleId` and permits one-level group nesting at `src/api/api-server.js:865-878`. Matching recurses through arbitrary depth at `src/proxy/proxy-server.js:3145-3153`, but lookup, update, toggle, delete, and ungroup search only one group level at `src/api/api-server.js:1157-1170` and `src/proxy/proxy-server.js:4099-4127`.
- Impact: rules inside a nested group still affect traffic but return not found from management operations, leaving persisted behavior that the UI/API cannot edit, disable, ungroup, or delete individually.
- Reproduction: create groups A and B, move a rule into A, then move A into B and try to toggle or delete the rule by ID.

### BUG-116 — High — Ordinary proxy traffic is buffered until the whole message ends

- Evidence: normal H1/H2 request and response paths accumulate all chunks and only create/write the upstream or client response after `end` (representative paths: `src/proxy/proxy-server.js:580-705`, `:1522-1539`, `:1684-1839`, `:1930-2076`, `:2673-2695`). No tee/streaming path forwards chunks while retaining a bounded capture.
- Impact: SSE, streaming downloads, long-lived H2/gRPC streams, and streaming uploads do not work: the other side sees no headers/data until the stream finishes, and infinite streams appear hung forever.
- Reproduction: proxy an SSE endpoint that writes headers and one event but remains open; the client receives neither before the origin closes.

### BUG-128 — High — Secure WebSockets cannot traverse TLS interception

- Status: **Fixed**.

- Evidence: only the outer plain proxy registers an upgrade listener at `src/proxy/proxy-server.js:321-333`, and `_handleHttpUpgrade()` at `:371-390` always creates a plain HTTP origin request. The HTTPS MITM virtual server at `:1025-1027,1584-1585` and the H2/allowHTTP1 server at `:1654-1672,1918-1924` register no upgrade handler.
- Impact: ordinary `wss://` clients fail unless the hostname is placed in raw TLS passthrough, which also disables WebSocket inspection.
- Reproduction: connect a WebSocket client to a working secure origin through FreeKit with default TLS interception; the handshake closes before the origin receives a connection.

### BUG-129 — Medium — New HTTPS hosts freeze the process during RSA key generation

- Status: **Fixed**.

- Evidence: every uncached CONNECT calls `generateCertForHost()` at `src/proxy/proxy-server.js:894-895`; `src/proxy/certificate-authority.js:88-95` synchronously runs `pki.rsa.generateKeyPair(2048)` on the main event loop and caches only afterward at `:150-155`.
- Impact: each new hostname blocks proxy traffic, the management API, MCP, and UI updates for the full key-generation time; high host churn repeatedly stalls the application.
- Reproduction: request an uncached HTTPS hostname while timing a parallel `/api/version` request; the management request cannot complete until certificate generation returns.

### BUG-130 — Low/Medium — Captured HTTPS records contain pre-handshake TLS metadata

- Status: **Fixed**.

- Evidence: `_handleConnect()` constructs a `TLSSocket` at `src/proxy/proxy-server.js:969-973` and immediately calls `_handleTlsConnection()` at `:985`. That method synchronously reads `getCipher()` and `getProtocol()` at `:991-997`; the later secure listener at `:975-982` never refreshes the stored `tlsDetails`.
- Impact: intercepted H1 records report a null cipher and can claim the fallback TLS 1.2 even when the completed connection negotiated TLS 1.3.
- Reproduction: force a TLS-1.3 request with H2 disabled and inspect the captured `tls` object.

### BUG-131 — Medium — A fragmented ClientHello disables passthrough fingerprinting

- Status: **Partially fixed**.
- Resolution: Capture now buffers arbitrary TCP chunks through the first TLS record. It marks capture complete at that record boundary, so a legal ClientHello handshake split across multiple TLS records is still never reassembled or mirrored upstream.

- Evidence: `_parseClientHello()` returns null until an entire TLS record is available at `src/proxy/proxy-server.js:2717-2724`, but `_createCapturingSocket()` at `:2892-2917` marks capture complete after the first socket chunk without appending data or retrying. `_getUpstreamTlsOptions()` at `:3042-3052` mirrors the client only when the first parse succeeded.
- Impact: clients whose ClientHello spans TCP reads silently use Node's default upstream TLS fingerprint despite selecting passthrough mode.
- Reproduction: send a valid ClientHello in two writes through CONNECT with `tlsFingerprint=passthrough` and compare the upstream fingerprint.

### BUG-132 — Low — REST traffic pagination accepts negative values and cannot request zero

- Status: **Fixed**.

- Evidence: `src/api/api-server.js:558-576` parses `limit` and `offset` with `parseInt(...) || default` and passes them directly to `Array.slice()` without bounds validation.
- Impact: `limit=-1` excludes the final record, `offset=-1` returns the final record, and `limit=0` unexpectedly returns 100 records, violating the endpoint's pagination contract.
- Reproduction: seed three records and request `/api/traffic?offset=-1`, `?limit=-1`, and `?limit=0`.

### BUG-145 — High — Generated X.509 serial numbers are randomly negative

- Status: **Partially fixed**.
- Resolution: Newly generated CA and leaf certificates now always receive positive, nonzero serials. Startup still loads a pre-fix persisted CA after checking only its expiry, so an already negative CA serial can remain active for nearly a year; correcting it also requires an explicit trust-store reinstallation strategy.

- Evidence: CA and leaf creation assign `_randomSerial()` at `src/proxy/certificate-authority.js:47-54,88-99`; that helper at `:160-162` returns 16 unconstrained random bytes as hex. node-forge encodes the hex directly as an ASN.1 INTEGER, so values whose first nibble is 8-f have the sign bit set, with no leading zero or masking.
- Impact: roughly half of generated CA and leaf certificates violate the X.509 positive-serial requirement and can be rejected by strict clients, making installs and host interception fail randomly.
- Reproduction: generate certificates until `parseInt(cert.serialNumber[0], 16) >= 8`, then parse or verify one with a strict X.509 implementation.

### BUG-146 — High — The proxy is an unauthenticated open relay on the LAN

- Status: **Fixed**.

- Evidence: `ProxyServer.start()` binds `0.0.0.0` at `src/proxy/proxy-server.js:321-350`; its request, CONNECT, and upgrade handlers at `:323-333` perform no source-address restriction or proxy authentication.
- Impact: any reachable LAN or container peer can relay traffic through the user's IP, reach private HTTP services visible to the host, and consume proxy resources.
- Reproduction: from another machine, configure `http://<freekit-host>:8081` as the proxy and fetch an arbitrary external or private-network URL.

### BUG-147 — High — Malformed breakpoint state can crash the proxy process

- Status: **Partially fixed**.
- Resolution: Non-array matcher state and invalid resume methods/headers are rejected. Matcher objects still receive no field-level type validation, and response resume bodies are not validated, so accepted state can still throw during matcher evaluation or response writes.

- Evidence: breakpoint create/update accepts raw JSON at `src/api/api-server.js:921-929`; `_checkBreakpoint()` calls `.every()` on `matchers` at `src/proxy/proxy-server.js:4071-4075` without validating it is an array. Resume at `api-server.js:937-939` likewise accepts arbitrary method/headers that are merged at `proxy-server.js:625-629` and passed to Node request construction, where invalid tokens throw in an async EventEmitter handler without a rejection boundary.
- Impact: one malformed persisted breakpoint can crash processing on every request, and one invalid resume payload can terminate the Node server.
- Reproduction: POST a breakpoint with `matchers: {}` and proxy a request, or resume with a method containing CRLF.

### BUG-148 — Medium/High — Absolute-form forwarding trusts a conflicting Host header

- Status: **Fixed**.

- Evidence: the HTTP destination is parsed from the absolute request target at `src/proxy/proxy-server.js:566-568`, but outbound headers preserve the original Host at `:638-640` while the TCP destination comes from `targetUrl.hostname` and port at `:642-680`.
- Impact: connection routing and virtual-host routing disagree, enabling misrouting and Host-header/cache confusion at the selected origin.
- Reproduction: send `GET http://127.0.0.1:<port>/ HTTP/1.1` with `Host: other.example`; the local origin receives the conflicting host.

### BUG-149 — Medium — Large valid traffic imports fail or block during trimming

- Status: **Fixed**.

- Evidence: JSON and HAR import spread all entries into the array and repeatedly call `shift()` down to the limit at `src/api/api-server.js:650-659,670-719`.
- Impact: sufficiently large arrays exceed the JavaScript call-argument limit and return 400, while smaller large arrays perform tens of thousands of O(n) shifts synchronously and freeze the API/proxy event loop.
- Reproduction: import about 125,000 empty records to trigger `RangeError`, or 100,000 records and time the synchronous trim.

### BUG-150 — Medium — Completing a pending request undoes Clear Traffic

- Status: **Fixed**.

- Evidence: Clear replaces the log with an empty array at `src/api/api-server.js:581-584`; a later `_update` whose original ID is now absent is pushed back into the log at `:1216-1227`.
- Impact: exchanges started before Clear unexpectedly reappear in backend search and exports after their origins respond, while renderer state can diverge.
- Reproduction: start a slow request, clear after its pending event, let it finish, then GET `/api/traffic`.

### BUG-151 — Medium — A delayed proxy rotation overwrites newer manual configuration

- Status: **Fixed**.

- Evidence: `_rotateBottingToolsProxy()` awaits external Python and then unconditionally sets and persists its result at `src/api/api-server.js:127-137`; background callers are at `:157,208`. Manual set/delete at `:952-962` neither cancels nor generation-guards that in-flight operation.
- Impact: a user can disable or replace a failing proxy, only for an older rotation to complete later and silently re-enable or replace it.
- Reproduction: delay `_getBottingToolsProxy()`, start rotation, manually delete or set another upstream, then resolve the old lookup.

### BUG-152 — Medium — TLS-passthrough hostname matching is case-sensitive

- Status: **Fixed**.

- Evidence: passthrough settings are stored verbatim at `src/proxy/proxy-server.js:237-239`, while CONNECT parses a normalized lowercase URL hostname and compares it with case-sensitive `includes()`/`endsWith()` at `:840-857`.
- Impact: uppercase DNS names and wildcards silently fail to bypass MITM, breaking pinned-certificate applications.
- Reproduction: configure `EXAMPLE.COM` or `*.EXAMPLE.COM`, connect to `example.com`, and observe a generated MITM certificate.

### BUG-153 — Medium — Disconnected breakpoint clients leave ghost pending state

- Status: **Fixed**.

- Evidence: each pause inserts a retained resolver into `pendingBreakpoints` (representative path `src/proxy/proxy-server.js:613-620`); entries are removed only by resume or the fixed five-minute timer at `:4045-4068`. No client request/socket/stream close handler resolves and deletes the entry.
- Impact: aborted clients leave ghost controls, captured bodies, closures, and timers; repeated breakpoint-hit-and-disconnect traffic accumulates memory for five minutes.
- Reproduction: trigger a breakpoint, disconnect before resume, and query `/api/breakpoints/pending`.

### BUG-154 — Medium — Serve-file rules synchronously read whole files on the event loop

- Status: **Fixed**.

- Evidence: HTTP, HTTPS, and H2 serve-file paths use `fs.readFileSync()` at `src/proxy/proxy-server.js:1249,2344,3516`, retain the complete Buffer, and copy/inspect it for capture.
- Impact: large files freeze all proxy/API/MCP work and can exhaust memory instead of streaming with backpressure.
- Reproduction: point a serve-file rule at a multi-gigabyte or sparse file and time an unrelated API request while it matches.

### BUG-155 — Medium — Plain-HTTP webhook actions report success when delivery fails

- Status: **Fixed**.

- Evidence: invalid URL/setup and request errors are only logged at `src/proxy/proxy-server.js:3551-3578`; the handler then unconditionally returns 200 and records `Webhook sent` at `:3579-3591` without awaiting delivery.
- Impact: clients and traffic history claim success even though the webhook was never accepted or sent.
- Reproduction: configure an invalid URL or refused localhost port and trigger the rule.

### BUG-156 — Medium — IPv6 literal upstream proxies produce invalid URLs

- Status: **Fixed**.

- Evidence: upstream hosts are stored raw at `src/proxy/proxy-server.js:218-234`; `_getUpstreamProxyUrl()` interpolates `${p.host}:${p.port}` without IPv6 brackets at `:3070-3082`, and HTTPS/SOCKS agent creation consumes it at `:3086-3112`.
- Impact: an otherwise valid upstream at `::1` or another IPv6 address fails HTTPS/SOCKS forwarding with Invalid URL.
- Reproduction: configure upstream host `::1`; the generated URL is `http://::1:8080` rather than `http://[::1]:8080`.

### BUG-157 — Low/Medium — HAR metadata lookup treats header names as case-sensitive

- Status: **Fixed**.

- Evidence: `src/api/har-converter.js:27-28,63` reads only lowercase `content-type` and `location`, although captured and mock header objects can preserve arbitrary case; fixed-response defaults use `Content-Type` at `src/proxy/proxy-server.js:3330-3333`.
- Impact: valid responses export with blank `content.mimeType` and `redirectURL` despite containing those headers.
- Reproduction: mock `Content-Type: application/json` and `Location: /next`, export HAR, and inspect both metadata fields.

### BUG-158 — Medium — Capture truncation silently corrupts HAR body exports

- Status: **Partially fixed**.
- Resolution: Initial HAR exports now include explicit captured/original sizes and truncation metadata. Both HAR import paths discard that metadata and replace the original response size with the captured size, so re-exporting a truncated capture presents its retained preview as complete; the renderer also uses clipped bodies for viewing, searching, resend, and mock creation without warning.

- Evidence: `_safeBodyString()` truncates text at 512 KiB and replaces binary bodies of at least 2 MiB with a textual placeholder at `src/proxy/proxy-server.js:3988-4010`; only the transformed field is stored. HAR conversion writes it as response content while reporting the original size at `src/api/har-converter.js:29-30,57-65`.
- Impact: exported HARs cannot replay or inspect full large responses and are internally inconsistent, with no truncation flag.
- Reproduction: proxy a 1 MiB text or larger-than-2 MiB binary response and compare HAR `content.text` with `content.size`.

### BUG-159 — Low/Medium — MCP HAR export includes non-HTTP pseudo-events

- Status: **Fixed**.

- Evidence: REST filters WebSocket frames and optional CONNECT tunnels through `_getHarExportTraffic()` at `src/api/api-server.js:257-265,613-617`; MCP filters the raw `trafficLog` only by user criteria and passes everything else to `trafficToHar()` at `src/mcp/mcp-server.js:358-373`.
- Impact: MCP exports contain empty-URL WebSocket-frame or tunnel entries and disagree with UI export settings.
- Reproduction: capture a WebSocket frame, invoke MCP `export_traffic`, and inspect the pseudo-entry in the HAR.

### BUG-160 — Low — HAR import misclassifies uppercase HTTPS schemes

- Status: **Fixed** (already addressed by `a9b335e`).

- Evidence: URL parsing succeeds at `src/api/api-server.js:678-688`, but protocol is derived separately with case-sensitive `entry.request.url?.startsWith("https")` at `:691-695`.
- Impact: a valid `HTTPS://` record is labeled insecure HTTP, affecting display, security scans, and later exports.
- Reproduction: import a minimal HAR containing `HTTPS://example.com/` and inspect the resulting protocol.

### BUG-176 — Medium — Unsupported outbound URL schemes are silently sent as HTTP

- Status: **Fixed**.
- Resolution: Send, absolute-form proxy requests, mock forwards, and webhooks now reject schemes other than HTTP and HTTPS before opening an outbound connection. Absolute-form Upgrade requests explicitly allow HTTP, HTTPS, WS, and WSS while rejecting every other scheme before opening a socket. Absolute-form HTTPS requests are forwarded with TLS instead of being downgraded to plaintext.

- Evidence: `src/api/api-server.js` validates Send URLs before selecting a transport. `src/proxy/proxy-server.js` applies the same HTTP(S)-only validation to absolute-form requests and all mock-forward implementations, and selects HTTPS plus the target's TLS settings for absolute-form HTTPS. Focused socket-level regressions cover each affected route.
- Impact: `ftp:`, `ws:`, and other unsupported URLs send HTTP bytes to unintended endpoints; an absolute-form `https://` request accepted on the plain proxy path can be downgraded to plaintext.
- Reproduction: submit an absolute-form `ftp://127.0.0.1:<listener>/` request with Upgrade headers to the proxy; `_handleHttpUpgrade()` opens a plain HTTP connection to the listener.

### BUG-372 — Medium — Claude MCP bridge survives stdio client disconnects

- Evidence: `startStdioBridge()` wires message/error paths and `remote.onclose` at `src/mcp/stdio-bridge.js:22-45`, but never observes the input stream's `end` or `close`. The installed SDK `StdioServerTransport` listens only for stdin `data` and `error`; its `onclose` fires only when its own `close()` is explicitly called.
- Impact: when Claude stops or restarts and closes stdin normally, the bridge process and its authenticated SSE session remain alive indefinitely. Repeated restarts can accumulate orphan processes and server sessions until FreeKit itself shuts down.
- Reproduction: launch the generated bridge against a live MCP SSE endpoint, wait for its session to connect, call `child.stdin.end()`, and wait; the child has no exit code and the SSE session remains connected until the child is explicitly killed.

### BUG-373 — Low/Medium — MCP runtime descriptor publication and cleanup are racy

- Evidence: `writeMcpRuntimeDescriptor()` writes directly to the final path with a truncating `writeFileSync()` at `src/mcp/launch-config.js:34-36`, so a concurrently launched bridge can read empty or partial JSON. `removeMcpRuntimeDescriptor()` separately reads, checks the instance ID, and unlinks at `:40-44`, leaving a time-of-check/time-of-use window in which an older instance can delete a newer instance's replacement descriptor.
- Impact: a concurrent Claude launch can fail transiently while FreeKit is publishing the credential-bearing descriptor, and a restart or multi-instance cleanup race can remove the live instance's descriptor so all future bridge launches fail.
- Reproduction: pause publication after truncating the final file and call `readRuntimeDescriptor()` to receive `Unexpected end of JSON input`; separately pause old-instance cleanup after its ownership read, replace the descriptor with a new instance's record, then resume cleanup and observe the new record deleted.

### BUG-375 — Medium — Electron-hosted MCP bridge remains alive after transport closure

- Evidence: `electron/bootstrap.cjs` starts the bridge but never terminates Electron after a missing descriptor, a bridge failure, or normal transport cleanup. `startStdioBridge()` closes its SSE and stdio transports when `remote.onclose` fires, but that cannot stop Electron's application event loop.
- Impact: after FreeKit shuts down, restarts, or loses the MCP transport, Claude's child remains alive but permanently disconnected and may prevent the client from spawning a replacement. Invalid invocations without a descriptor likewise hang instead of exiting with their recorded failure status.
- Reproduction: launch the bridge through Electron, establish an authenticated SSE session, then stop the MCP server. One second after the remote-close handler runs, the transports are closed but the Electron child still has no exit code and must be killed explicitly. Launching the flag without a descriptor similarly remains alive after setting `process.exitCode = 1`.

### BUG-177 — Medium — Rule IDs are mutable, non-unique, and ambiguous with indexes

- Status: **Fixed**.
- Resolution: Mock and breakpoint IDs are now generated uniquely by the server and ignored in create, import, and update payloads. Persisted mock IDs are repaired without changing valid unique legacy IDs, breakpoint deletion removes one exact ID, and numeric mock deletion checks a literal ID before falling back to the legacy top-level index behavior.

- Evidence: Mock creation and group insertion recursively assign fresh IDs, import strips submitted IDs before runtime normalization, and updates reconcile nested rule identities while ignoring mutation of the selected rule's ID. Breakpoint create/update/delete apply the same ownership and one-ID semantics, while numeric mock deletion attempts exact recursive ID removal first.
- Impact: duplicate IDs make later rules unreachable, breakpoint delete can remove every duplicate, and a rule with ID `1` can cause index 1 to be deleted instead.
- Reproduction: create two mocks with `id: "dup"` and try to manage the second, then create a rule whose literal ID is `1` and delete it by ID.

### BUG-178 — Medium — Body matchers inspect truncated encoded display text

- Status: **Fixed**.
- Resolution: Request paths now build a separate matcher-only body from the complete buffered request, decoding supported content encodings within the existing decompression ceiling. Mock and breakpoint evaluation receive that bounded decoded text across plain HTTP, intercepted HTTP/1, HTTP/2, and HTTP/1 fallback, while captured bodies continue using the 512 KiB display preview.
- Evidence: request paths call `_findMockRule()` with `_safeBodyString(body)` and no request encoding/type metadata (`src/proxy/proxy-server.js:587,1050,1706,1945`). Body/JSON matchers consume that string at `:3246-3269`, while `_safeBodyString()` truncates text and substitutes large binary at `:3965-4010`.
- Impact: tokens after 512 KiB never match, and compressed JSON/body matchers see gzip bytes instead of the request payload.
- Reproduction: place a searched token after byte 524,288 in a POST, or send gzip JSON, and apply the corresponding matcher.

### BUG-179 — Low/Medium — Response decompression rejects coding case and stacks

- Status: **Fixed**.
- Resolution: Response capture now normalizes content-coding tokens case-insensitively and decodes comma-separated stacks in reverse application order. Every decompression stage retains the configured output ceiling, and unsupported or failed stacks preserve the original bytes.

- Evidence: `_decompressBody()` switches on one exact raw `Content-Encoding` string at `src/proxy/proxy-server.js:3943-3959`; callers pass the header unchanged.
- Impact: valid values such as `GZip` and stacked codings such as `gzip, br` remain compressed and are captured/exported as opaque or corrupt-looking data.
- Reproduction: return a gzipped body with `Content-Encoding: GZip` and inspect its capture.

### BUG-180 — Medium — Client cancellation is not propagated upstream

- Status: **Fixed**.
- Resolution: Each proxy forwarding path now owns a downstream cancellation signal. Early H1 closes destroy active upstream requests, downstream H2 cancellation closes upstream streams with `NGHTTP2_CANCEL`, canceled work cannot retry or fall back, and disconnecting a paused breakpoint terminates the request instead of resuming it. Normal completed responses detach cancellation tracking before their downstream close event.

- Evidence: H1 forwarding creates and buffers the upstream response without an aborted/close handler that destroys `proxyReq`, while `_makeH2Request()` has no downstream cancellation input. The breakpoint disconnect handler additionally resolves a paused request with empty modifications, so its await continues into normal upstream forwarding after the client has gone.
- Impact: after a client disconnects, origins continue streaming and FreeKit continues consuming bandwidth and allocating body buffers; abandoned unsafe requests can still execute.
- Reproduction: close the client early during a slow response and observe the origin continue sending, or disconnect while a request breakpoint is paused and observe the request reach the origin after the pause is released.

### BUG-181 — Medium — Breakpoint rules disappear on restart

- Status: **Fixed**.
- Resolution: Successful breakpoint create, update, and delete operations now persist the complete rule set, and startup restores it through validation that discards malformed entries while repairing missing, duplicate, or non-string IDs without changing valid unique IDs.

- Evidence: Breakpoint CRUD routes call the breakpoint persistence helper, startup loads `breakpointRules` before the proxy begins listening, and `loadBreakpoints()` returns the validated, identity-normalized migration result for repaired settings to be written back.
- Impact: configured breakpoints silently vanish on every application restart.
- Reproduction: create a breakpoint, restart the server, and GET `/api/breakpoints`.

### BUG-182 — Medium — Automatic CA renewal breaks non-Windows trust

- Evidence: startup regenerates an expiring CA and overwrites its files at `src/proxy/certificate-authority.js:19-36,47-85`. Boot installs/replaces trust only on Windows and does nothing equivalent on macOS/Linux at `src/index.js:43-58`.
- Impact: after the one-year renewal, previously configured macOS, Linux, browser, and device clients reject all interception without a warning or re-trust migration.
- Reproduction: trust a near-expiry CA on macOS/Linux, restart inside its renewal window, and make an HTTPS request.

### BUG-183 — Medium — Raw WebSocket relay ignores socket backpressure

- Status: **Fixed**.
- Resolution: Both raw WebSocket directions now pause their readable peer when the destination applies backpressure, resume only after `drain`, apply the same flow control to buffered upgrade heads, and remove relay and pending drain listeners on close or error without changing frame parsing or byte accounting.

- Evidence: both data directions unconditionally call `.write(chunk)` at `src/proxy/proxy-server.js:433-445`, never checking a false return or pausing until drain; initial buffered head writes at `:423-430` are handled the same way.
- Impact: a fast peer and slow or non-reading peer can grow Node writable queues and process memory without bound.
- Reproduction: stop reading the downstream socket while the WebSocket origin floods data and monitor `writableLength`/RSS.

### BUG-184 — Medium — WebSocket and TLS-passthrough setup have no timeout

- Status: **Fixed**.
- Resolution: WebSocket handshakes use the standard upstream connect and idle timeouts. Direct TLS-passthrough sockets now apply the same upstream connect timeout, reject with a connect-phase timeout, destroy the pending socket, and remove their timer and temporary listeners when connection setup settles. Proxied and SOCKS tunnels retain their existing configured timeout handling.
- Evidence: plain WebSocket `http.request()` runs without the normal upstream timeout configuration at `src/proxy/proxy-server.js:372-497`; TLS passthrough uses bare `net.connect()` with no timer at `:879-890`.
- Impact: an accept-but-never-answer WebSocket origin or stalled passthrough connect holds client sockets and closures until long OS-level timeouts.
- Reproduction: point either path at a TCP server that accepts and sends nothing.

### BUG-185 — Medium — WebSocket handshakes are hidden until a successful connection closes

- Status: **Fixed**.
- Resolution: Every supported WebSocket handshake now emits a pending parent before connecting upstream. Rejected responses and upstream failures complete that parent, successful upgrades update it to 101 before buffered frames are parsed, and connection close updates the same parent with final message and byte totals.

- Evidence: `_handleHttpUpgrade()` uses pending and update traffic events throughout the handshake and connection lifecycle, while preserving the existing response and frame forwarding paths.
- Impact: failed handshakes never appear, while long-lived successful connections show orphan frames whose parent ID cannot be inspected until the socket closes.
- Reproduction: return 401 and observe no record; then keep a 101 connection open after one frame and observe only a `ws-frame` child.

### BUG-186 — Medium — Failed TLS passthrough is logged as a successful 200 tunnel

- Status: **Fixed**.
- Resolution: TLS-passthrough traffic now records an explicit tunnel outcome. Upstream TCP failures emit one 502 event with error details, successful 200 events require an established upstream connection, and shared error/close paths are idempotent. A downstream client that closes while connection setup is pending can no longer create a successful tunnel record.
- Evidence: `emitTunnel()` hard-codes status 200 at `src/proxy/proxy-server.js:864-876`; the wire 200 is written only in the successful `net.connect()` callback, but target close still invokes `emitTunnel` and target error only destroys the client at `:879-890`.
- Impact: refused or unreachable destinations appear as established tunnels in logs and stats despite sending no success response.
- Reproduction: enable passthrough for localhost and CONNECT to a closed port.

### BUG-187 — Medium — Upstream WebSocket EOF is not propagated downstream

- Status: **Fixed**.
- Resolution: The successful WebSocket relay now ends the downstream socket when the upstream socket emits EOF, propagating closure before recording cleanup.
- Evidence: `proxySocket.on("end", cleanup)` at `src/proxy/proxy-server.js:474-477` records the session but never calls `socket.end()`; the reverse direction does close the upstream socket.
- Impact: when the origin closes transport, the client TCP connection remains open and hangs after capture is marked complete.
- Reproduction: have an origin send 101 and then end its socket; the proxied client receives neither end nor close.

### BUG-188 — Low/Medium — Informational HTTP responses are dropped

- Status: **Fixed**.
- Resolution: Upstream HTTP/1 `information` events and HTTP/2 informational header blocks are now forwarded immediately with protocol-appropriate HTTP/1 or HTTP/2 writers across plain HTTP, intercepted HTTPS, ALPN fallback, and mock-forward paths. Final responses remain buffered as before, and an upstream 100 is suppressed when Node has already sent the downstream automatic `100 Continue`.
- Evidence: H1 forwarding listens only for the final response at `src/proxy/proxy-server.js:700-754` and analogous HTTPS paths, with no `information` listener. H2 listens for `response` but not interim `headers` at `:2675-2682`.
- Impact: 100 Continue metadata and 103 Early Hints do not reach clients, defeating preload behavior and observability.
- Reproduction: have an origin call `writeEarlyHints()` before its 200; the direct client sees 103 while the proxied client does not.

### BUG-189 — Medium — Concurrent generator exports collide on one file

- Status: **Fixed**.
- Resolution: Each export now atomically reserves its own portable, timestamp-prefixed session directory and uses that exact session name for both its HAR and generator launch. Failed writes or launch setup remove only the newly reserved directory.

- Evidence: `_exportToGenerator()` derives a session name only to whole-second precision and writes a deterministic directory/HAR path; the POST route has no lock or unique suffix (`src/api/api-server.js` generator export helpers and route).
- Impact: two exports in one second race on the same file and launch generator processes against a shared session, with the last writer winning.
- Reproduction: issue two export-generator requests concurrently around a traffic-log change and compare returned session/path values.

### BUG-190 — Low/Medium — HAR unknown-size sentinels corrupt MCP bandwidth stats

- Status: **Fixed**.
- Resolution: HAR imports preserve the standard `-1` unknown-size sentinel for lossless export while normalizing malformed sizes to zero. MCP bandwidth aggregation and formatting ignore unknown or invalid byte counts safely while preserving finite non-negative values.

- Evidence: HAR import preserves the standard `bodySize: -1` sentinel because it is truthy; MCP adds it directly to bandwidth and `formatBytes()` applies `Math.log(bytes)` without a negative guard (`src/api/api-server.js` HAR import; `src/mcp/mcp-server.js:253-274,518-523`).
- Impact: a valid unknown size produces negative totals, `NaN undefined`, or undercounting when combined with other traffic.
- Reproduction: import a HAR with `request.bodySize: -1` and invoke MCP `get_traffic_stats`.

### BUG-191 — Low — Unix-epoch HAR timestamps are replaced with import time

- Status: **Fixed**.
- Resolution: HAR import now distinguishes every finite parsed timestamp, including zero and negative pre-epoch values, from invalid or missing dates. Invalid dates in one import use a single deterministic import-time fallback.

- Evidence: HAR import uses `new Date(entry.startedDateTime).getTime() || Date.now()`, so the valid numeric timestamp zero triggers the fallback (`src/api/api-server.js` HAR mapping).
- Impact: epoch captures receive false current dates and ordering.
- Reproduction: import `startedDateTime: "1970-01-01T00:00:00.000Z"` and inspect the record timestamp.

### BUG-203 — High/Medium — Malformed persisted network settings crash later connections

- Status: **Fixed**.
- Resolution: TLS-passthrough entries are string-normalized before matching. Upstream proxy configuration now accepts only supported types, valid hosts, and integer ports in range, applies documented defaults only when the port is omitted, and validates before mutating live state. Invalid API submissions return 400 without persistence, while invalid saved settings are ignored and safely cleared during startup.
- Evidence: `/api/upstream-proxy` accepts arbitrary port/type and persists it; `setUpstreamProxy()` accepts any truthy parsed port, after which the async H1 path calls `http.request()` without a synchronous exception boundary (`src/api/api-server.js` upstream route; `src/proxy/proxy-server.js:220-235,590-810`). TLS passthrough validates only the outer array, then CONNECT calls `.startsWith()` on each element at `proxy-server.js:863-865`.
- Impact: accepted persisted values such as port 70000 or passthrough host `1` throw in later request handlers, and the crash repeats after restart.
- Reproduction: persist upstream `{ "host":"127.0.0.1", "port":70000 }` and proxy a request, or store passthrough `{ "hosts":[1] }` and issue CONNECT.

### BUG-204 — Medium — Malformed OpenAPI documents can suppress traffic capture

- Status: **Fixed**.
- Resolution: The API now rejects OpenAPI submissions whose base URL, document, paths, path items, or consumed operation metadata have incompatible shapes. Matching skips malformed legacy entries, and traffic capture continues even if enrichment unexpectedly fails.

- Evidence: the API accepts any truthy spec and arbitrary baseUrl; `matchApiSpec()` assumes baseUrl is a string and every path entry is an object (`src/api/api-server.js` spec route; `src/proxy/proxy-server.js:4188-4208`). `onTrafficEvent()` calls it before inserting/broadcasting the exchange, and the proxy emitter only logs callback exceptions.
- Impact: one accepted spec can blind UI/API/MCP capture for every request or a matching path while traffic still forwards normally.
- Reproduction: POST a spec with `baseUrl: {}` or a matching `paths` value of null, then proxy traffic.

### BUG-205 — Low/Medium — Client-aborted uploads vanish from traffic

- Status: **Fixed**.
- Resolution: All four inbound request-body paths now finalize aborted, errored, or pre-end-closed uploads through a shared one-shot lifecycle. The terminal record includes the received partial body and byte count plus a consistent request-body abort diagnostic, while completed uploads retain their existing pending/forwarding flow.

- Evidence: plain H1, intercepted H1, H2, and H1-on-H2 collect request bodies using only data/end at `src/proxy/proxy-server.js:588-590,1043-1045,1692-1695,1938-1940`; pending emission and forwarding occur only inside end, with no aborted/pre-end close completion.
- Impact: partial uploads and client resets are absent from capture despite incrementing request counters, defeating diagnosis and leaving no terminal record.
- Reproduction: declare a large Content-Length, send a short prefix, and close the client socket.

### BUG-214 — Medium — Management WebSocket broadcasts buffer without bound

- Status: **Fixed**.
- Resolution: Broadcasts now enforce a configurable 16 MiB per-client queued-byte ceiling using `bufferedAmount` plus the next message size. Slow, non-open, and send-failing clients are removed and safely terminated without interrupting delivery to healthy clients.

- Evidence: `src/api/api-server.js:1368-1376` serializes every event and calls `client.send()` for every OPEN client with no `bufferedAmount` limit, throttling, send callback/error policy, or slow-client disconnect.
- Impact: one authenticated but non-reading UI/WebSocket client can accumulate an unbounded per-client queue and process memory as large captures arrive.
- Reproduction: authenticate to `/ws`, pause the underlying socket, generate repeated large captures, and monitor `bufferedAmount` and RSS.

### BUG-215 — Medium — MCP HAR export returns invalid truncation after full allocation

- Status: **Fixed**.
- Resolution: MCP HAR export now converts and serializes entries incrementally against the response cap. It rejects a definitely oversized body before conversion, stops before converting later entries when many small entries exceed the cap, and returns a small MCP error with filter-narrowing advice instead of a truncated HAR fragment.

- Evidence: the tool promises HAR 1.2 but builds and pretty-serializes the complete result before its size check at `src/mcp/mcp-server.js:48,358-374`; above 200 KiB it returns prose plus only the first 50 KiB of JSON at `:375-383`.
- Impact: large filtered exports are not parseable HAR, and the guard does not prevent large memory/event-loop work for up to the full traffic cap.
- Reproduction: export one exchange over 200 KiB and pass the returned text to `JSON.parse()`.

### BUG-216 — Low/Medium — Traffic import permits duplicate and colliding IDs

- Status: **Fixed**.
- Resolution: Imported traffic now retains unique nonconflicting IDs and remaps batch or current-log collisions to fresh UUIDs without mutating submitted records. UUID allocation reserves current, submitted, retained, and newly generated IDs, while capped imports preserve only the addressable tail.

- Evidence: JSON validation requires only a nonempty string ID and appends records unchanged at `src/api/api-server.js:295-339,765-780`, including duplicates and collisions with existing traffic. Detail/API/MCP consumers use the first match.
- Impact: later records become unaddressable, selection is ambiguous, and ID-keyed renderer state can alias unrelated exchanges.
- Reproduction: import two valid records with `id: "dup"` and request `/api/traffic/dup` or select it through MCP.

### BUG-217 — Medium — HTTP/2 capture authority differs from actual upstream routing

- Status: **Fixed**.
- Resolution: CONNECT-tunneled HTTP/2 streams now accept only HTTPS pseudo-headers whose normalized hostname and effective port match the CONNECT origin. Equivalent default-port and IPv6 authorities are canonicalized; misdirected streams receive 421 before body collection, matching, breakpoints, or capture. Breakpoint URL edits continue to reroute explicitly, with the final authority, Host header, and capture metadata updated together.

- Evidence: CONNECT-H2 uses inbound `:authority` and `:scheme` for `fullUrl`, capture, and matching at `src/proxy/proxy-server.js:1688-1710`, but opens the upstream session to the original CONNECT target and `_makeH2Request()` rewrites both pseudo-fields to that target at `:1802-1806,2656-2667`.
- Impact: a coalesced/custom H2 request can be logged and mocked as origin B while it is actually delivered to origin A.
- Reproduction: CONNECT to local origin A, negotiate H2, then send `:authority: b.test`; observe capture and destination disagree.

### BUG-227 — High/Medium — Mock forward actions bypass the configured upstream proxy

- Status: **Fixed**.
- Resolution: All mock-forward paths now share the established outbound routing policy: destination-aware noProxy selection, authenticated HTTP/HTTPS proxying, SOCKS connections, destination/proxy TLS options, proxy-header sanitization, request timeouts and downstream cancellation, and safe-method-only retry. Plain H1, intercepted HTTPS H1, native H2, and the H1-on-H2 delegate retain their protocol-specific response and capture handling.

- Evidence: HTTPS H1, native H2, and plain H1 forward actions directly call `fwdLib.request()` for the destination at `src/proxy/proxy-server.js:1153-1215,2253-2323,3430-3499`, without `_getUpstreamAgent()`, SOCKS handling, or any `this.upstreamProxy` branch.
- Impact: a forward rule leaks the host's direct network identity or fails in networks where destinations are reachable only through the configured upstream.
- Reproduction: configure a counting upstream proxy, create a forward rule, and trigger it through H1/HTTPS/H2; the destination is contacted directly.

### BUG-228 — Medium — A hard-coded Chromium filter silently hides traffic

- Evidence: both pending and completed emission call `_shouldSuppressTrafficLog()` at `src/proxy/proxy-server.js:3810,3837`; for Chrome-family UAs, `:3845-3926` always drops many update, Safe Browsing, account, telemetry, Web Store, and Google requests. Only safe-font filtering is configurable.
- Impact: forwarded authentication and failure traffic never reaches API/UI/MCP/HAR, contradicting the promise to inspect every request and providing no indication that records were removed.
- Reproduction: send a Chrome-UA request to `accounts.google.com/ListAccounts` with font filtering off and observe no capture.

### BUG-229 — Low/Medium — MCP request detail silently truncates bodies

- Evidence: `get_request_detail` promises full details including body at `src/mcp/mcp-server.js:25-33`, but the handler slices request and response bodies at 50 KiB at `:198-216`.
- Impact: MCP clients cannot retrieve or analyze the remaining captured data even though storage retains substantially more.
- Reproduction: place a token after byte 51,200 and call `get_request_detail`.

### BUG-230 — Low/Medium — MCP security scan treats header names as case-sensitive

- Status: **Fixed**.
- Resolution: MCP security scanning now resolves response headers case-insensitively without modifying captured/imported records. Cookie, HTML content-type, all security-header, and CORS checks share the lookup, with scalar and repeated header values handled safely while existing status and mock skips remain unchanged.

- Evidence: `src/mcp/mcp-server.js:307-338` reads only lowercase names for Set-Cookie, Content-Type, security headers, and ACAO, while JSON import accepts preserved arbitrary casing.
- Impact: valid imported records with normally capitalized headers evade cookie, content, security-header, and CORS findings.
- Reproduction: import `Content-Type`, `Set-Cookie`, and `Access-Control-Allow-Origin` headers, then run `security_scan`.

### BUG-231 — Medium — Rewrite pre-steps behave differently across HTTPS and H2

- Status: **Fixed**.
- Resolution: URL and method pre-steps now update parsed destinations, paths, Host/authority values, and capture metadata consistently across plain H1, intercepted HTTPS H1, native H2, and H1-on-H2 fallback handling. Relative rewrites resolve against the current request URL, while invalid or unsupported rewrites leave it unchanged.

- Evidence: plain H1 mutates URL/method and forwards them at `src/proxy/proxy-server.js:3369-3377,3430+`. HTTPS `rewrite-url` changes only displayed `fullUrl`, not hostname, port, or `req.url`, at `:1092-1101,1153-1177`; native H2 pre-steps at `:2207-2221` omit URL and method rewrite entirely.
- Impact: one advertised rule routes differently by negotiated protocol, and HTTPS can log a rewritten destination while sending the original.
- Reproduction: rewrite `/old` to another local origin/path and compare plain H1, intercepted H1, and native H2.

### BUG-241 — Medium — Ordinary upstream HTTP/2 requests can hang forever

- Status: **Fixed**.
- Resolution: Ordinary upstream HTTP/2 streams now share the configured response-idle timeout and settle once on success, timeout, downstream cancellation, abort/error, or premature close. Terminal paths remove timers and listeners and cancel only the affected stream, preserving cached sessions, informational responses, trailers, and body limits.

- Evidence: `_makeH2Request()` at `src/proxy/proxy-server.js:2656-2711` handles response, body end, and error but configures no connect/response timeout and no settlement for aborted or premature close. All normal intercepted H2 paths use it, while H1 fallbacks receive configured timeouts.
- Impact: an origin that accepts an H2 stream without response headers, or closes it without error/end, leaves the downstream request pending indefinitely.
- Reproduction: accept an H2 stream and send no response headers.

### BUG-242 — Medium — HAR import bypasses traffic type validation

- Status: **Fixed**.
- Resolution: HAR entries now pass through the same strict traffic-record validation as JSON imports after normalization and before any traffic-log mutation, eviction, ID remapping, or broadcast. Invalid multi-entry HARs are rejected atomically.

- Evidence: `/api/traffic/import-har` maps method, sizes, duration, and other fields verbatim at `src/api/api-server.js:796-835` and never calls the validator used by JSON import. REST/MCP later call string/number methods on them.
- Impact: a HAR accepted with object-valued method/time/bodySize can make traffic search and MCP tools throw until cleared.
- Reproduction: import a HAR with `request.method: {}` and then search by method.

### BUG-243 — Low/Medium — Repeated header arrays crash traffic detail rendering

- Status: **Fixed**.
- Resolution: Detail header inspection now reads names case-insensitively and combines scalar or repeated values without changing the headers displayed to the user.

- Evidence: traffic validation explicitly accepts string-array header values, but the renderer calls `.toLowerCase()` on response Content-Type and `.split(",")` on Cache-Control at `src/ui/app.js:1657,1686`.
- Impact: a valid imported record with repeated forms of either header throws when selected, preventing detail rendering.
- Reproduction: import `"cache-control": ["public","max-age=60"]` and open the exchange.

### BUG-244 — Low/Medium — Plain HTTP collapses SOCKS local/remote DNS variants

- Status: **Fixed**.
- Resolution: Plain HTTP SOCKS connections now resolve destination hostnames asynchronously on the client for `socks4` and `socks5`, while `socks4a` and `socks5h` preserve hostnames for proxy-side DNS. Literal addresses bypass lookup, and SOCKS4 variants reject unsupported IPv6 destinations explicitly.

- Evidence: `_connectViaSocks()` at `src/proxy/proxy-server.js:3129-3150` maps socks4/socks4a to one type and socks5/socks5h to one type, then always passes the unresolved hostname. HTTPS uses an agent that distinguishes local-DNS and remote-DNS schemes.
- Impact: SOCKS4 effectively behaves as SOCKS4a and SOCKS5 delegates DNS remotely, violating configured semantics and cross-protocol parity.
- Reproduction: use hostname-only targets with socks4 versus socks4a and compare DNS behavior for HTTP and HTTPS.

### BUG-245 — Low/Medium — MCP request tools count WebSocket frames as HTTP requests

- Status: **Fixed**.
- Resolution: MCP request search, traffic statistics, and live captured-request totals now share a non-mutating HTTP-request view that excludes WebSocket frame records. Frames remain available in the traffic log and through request-detail/UI workflows.

- Evidence: MCP search, stats, and live summary start from the raw traffic log without protocol filtering (`src/mcp/mcp-server.js:132-133,220-221` and live-summary handler).
- Impact: frames inflate request totals and bandwidth, create undefined methods and other statuses, and appear in tools whose contracts describe HTTP requests.
- Reproduction: capture one WebSocket handshake plus frames, then call search, stats, and live summary.

### BUG-262 — Medium — HTTPS/H2 mocks and breakpoints create duplicate traffic IDs

- Status: **Fixed**.
- Resolution: Every intercepted HTTPS/H2 path now replaces its pending row with request-update events, including mock terminal actions, errors, and breakpoint transitions; non-pending HTTP mocks remain append-only.

- Evidence: intercepted HTTPS H1 emits a pending record before rule evaluation at `src/proxy/proxy-server.js:1103`, then mock/breakpoint paths emit ordinary records with the same ID at `:1171-1464`. Native H2 and H1-on-H2 repeat this pattern at `:1762,1781,2219-2545` and `:2001,2018,2590`. `ApiServer.onTrafficEvent()` appends every event without `_update`.
- Impact: totals, exports, MCP results, and detail lookup contain pending plus completed rows sharing one ID; first-match consumers can return stale data.
- Reproduction: trigger an HTTPS fixed-response mock and inspect `/api/traffic` for duplicate IDs.

### BUG-263 — Medium — HAR export mistakes literal data-URI text for binary

- Status: **Fixed**.
- Evidence: `toHarBody()` at `src/api/har-converter.js:95-107` treats every string matching `data:...;base64,...` as internal binary representation and exports only the suffix with base64 encoding, without separate encoding metadata or content-type context.
- Impact: a legitimate text body equal to a data URI changes semantically on export/replay from that literal string to its decoded bytes.
- Reproduction: capture `text/plain` body `data:text/plain;base64,SGVsbG8=` and inspect the HAR text/encoding.
- Resolution: captured traffic and both HAR import paths now attach explicit request/response body-encoding provenance. HAR export unwraps internal base64 data URIs only when that metadata marks genuine binary data, while literal data-URI-shaped text remains unchanged.

### BUG-264 — Medium — Generated certificates are not backdated for clock skew

- Evidence: CA and leaf `notBefore` values are set to the exact generation time at `src/proxy/certificate-authority.js:55-57,100-102`.
- Impact: devices, VMs, containers, or remote clients whose clocks trail the proxy by a small amount reject newly generated interception certificates as not yet valid.
- Reproduction: set a client clock five minutes behind and request a previously unseen HTTPS hostname.

### BUG-265 — Low/Medium — Send drops credentials embedded in URLs

- Status: **Fixed**.
- Evidence: `_sendRequest()` parses the URL at `src/api/api-server.js:1319`, but options at `:1323-1329` copy host, port, path, method, and headers while omitting username/password or auth.
- Impact: standard credentialed URLs reach Basic-auth endpoints without Authorization and unexpectedly return 401.
- Reproduction: Send `http://user:pass@127.0.0.1:<port>/` to an origin that echoes Authorization.
- Resolution: Send now percent-decodes URL username/password components and emits UTF-8 Basic authentication, including username-only and empty-password URLs. A case-insensitive explicit Authorization header remains authoritative, and userinfo is removed before outbound host/path construction.

### BUG-266 — Medium — Wildcard client certificates never match a host

- Status: **Fixed**.

- Evidence: the UI accepts `*` for all hosts at `src/ui/index.html:498`, and `setClientCertificates()` stores it, but `_getClientCertificateOptions()` uses exact host equality only at `src/proxy/proxy-server.js:251-265,308-311`.
- Impact: an accepted all-host PFX is never sent, so every protected mTLS origin fails while exact-host entries work.
- Reproduction: configure client certificate host `*` and connect to an mTLS origin.

### BUG-267 — Medium — Failed persistence leaves runtime configuration applied

- Status: **Fixed**.
- Evidence: routes mutate proxy/rule state before saving (for example upstream, H2, and mock routes), while `Settings.set()` can restore only its own data object on write failure and cannot roll back the proxy mutation.
- Impact: a request returns an error but the supposedly failed proxy, TLS, H2, or mock change remains active until restart; retries can duplicate rule behavior.
- Reproduction: make settings persistence fail, POST a new upstream or mock, then query/use runtime state.
- Resolution: persisted management mutations now snapshot runtime state, apply the live change, and atomically save cloned settings values; any apply or persistence error restores the prior live state, while apply errors occur before any settings write. Multi-key UI and BottingTools rotation updates use one settings write, and restored rule trees are detached from settings data to prevent reference aliasing.

### BUG-268 — Low/Medium — HAR conversion conflates wire and decoded body sizes

- Status: **Fixed**.

- Evidence: HAR import stores `response.content.size` as internal responseBodySize and ignores `response.bodySize`; export writes that one value into both fields (`src/api/api-server.js` HAR mapping; `src/api/har-converter.js:66,73`).
- Impact: compressed responses lose the distinction between transfer size and decoded content size, corrupting round trips and bandwidth analysis.
- Reproduction: import bodySize 100 with content.size 1000 and re-export; both become 1000.

### BUG-269 — Low — Invalid API ports reach server startup unchecked

- Status: **Fixed**.
- Evidence: `src/index.js` uses unchecked `parseInt(API_PORT) || 8001`; truthy out-of-range values reach `httpServer.listen()` in `src/api/api-server.js`.
- Impact: a simple port typo terminates startup with ERR_SOCKET_BAD_PORT after proxy initialization instead of a validation error/fallback.
- Reproduction: start with `API_PORT=70000` or `API_PORT=-1`.

### BUG-273 — Medium — Management WebSocket peers delay graceful shutdown

- Status: **Fixed**.
- Resolution: API shutdown now rejects upgrade races, closes and terminates every management WebSocket peer, closes the WebSocket server alongside the HTTP listener, and destroys tracked HTTP sockets. Concurrent stop calls share one bounded cleanup and the server can be started again after shutdown.
- Evidence: `ApiServer.stop()` sends `client.close()` and then waits on `httpServer.close()` at `src/api/api-server.js:1552-1559`; it does not terminate peers or explicitly close the WebSocket server. Application shutdown awaits that promise.
- Impact: a peer that ignores the close frame keeps the upgraded socket active until the library's roughly 30-second close timeout, stalling shutdown.
- Reproduction: connect an authenticated raw WebSocket client that ignores close frames and call graceful shutdown.

### BUG-274 — Low/Medium — Management timeout starts after JSON upload parsing

- Status: **Fixed**.
- Evidence: `express.json({ limit: "50mb" })` runs before middleware calling `req.setTimeout(30000)` at `src/api/api-server.js:612-618`, so the timeout is not installed until the complete body has arrived.
- Impact: a slow or incomplete authenticated upload can hold a connection far beyond the advertised 30 seconds.
- Reproduction: send part of a declared JSON body and hold the socket open beyond 30 seconds.
- Resolution: the validated, configurable management request timeout is now installed after CORS/authentication but before JSON parsing, and its timeout handler terminates stalled uploads. The default remains 30 seconds and the existing 50 MiB JSON limit is unchanged.

### BUG-281 — Medium — Fragmented WebSocket messages are captured as separate frames

- Status: **Fixed**.
- Resolution: WebSocket capture now assembles continuation frames into one bounded logical text/binary message per direction while retaining the initial opcode and timestamp. Interleaved control frames remain independently captured, application-message counts increment only when a complete message is emitted, and malformed or oversized fragmentation disables capture for that direction without affecting raw relay.

- Evidence: `src/proxy/ws-frame-parser.js:47-121` parses individual frames but never assembles continuation frames or retains the initial opcode. Proxy capture increments message counters and emits each parsed frame independently.
- Impact: one logical fragmented text/binary message appears as multiple incomplete messages with incorrect counts and no inspectable reconstructed payload.
- Reproduction: send TEXT FIN=0 `hel`, then CONTINUATION FIN=1 `lo`; capture shows two records instead of `hello`.

### BUG-282 — Medium — Sensitive HAR masking leaks structured cookies

- Status: **Fixed**.
- Evidence: `src/api/har-converter.js:1-16` masks Cookie/Set-Cookie header values, but structured requestCookies/responseCookies are copied verbatim at `:47,63`. MCP export enables masking by default and HAR import preserves these arrays.
- Impact: default masked MCP HAR exports expose secret structured cookie values in cleartext.
- Reproduction: import a cookie array containing a secret and call MCP `export_traffic` with default masking.
- Resolution: Masked HAR conversion now clones every structured request and response cookie with a redacted value while preserving its name and metadata. Unmasked API/UI exports retain the original cookie data, malformed cookie fields remain safe to convert, and neither mode mutates captured traffic.

### BUG-289 — Medium — Malformed management WebSocket frames crash the server

- Status: **Fixed**.
- Resolution: Every authenticated management WebSocket receives a peer-scoped error listener at the earliest post-upgrade point, before connection dispatch or initialization. Protocol/parser failures remove and terminate only that peer, while shared close cleanup remains idempotent and normal HTTP/WebSocket clients continue operating.

- Evidence: accepted WebSocket peers receive close and message listeners but no error listener at `src/api/api-server.js:1487-1508`; parser/protocol errors are emitted as unhandled error events.
- Impact: one malformed peer frame can terminate the server abruptly and bypass graceful interceptor/proxy cleanup.
- Reproduction: complete an authenticated `/ws` upgrade and send an unmasked client text frame such as bytes `81 01 61`.

### BUG-293 — Medium — Bypassed direct traffic triggers upstream-proxy rotation and retry

- Status: **Fixed**.
- Resolution: Retry helpers now require the route decision from the failed attempt, and every retrying H1/mock/H2-fallback path recomputes that decision per attempt so provider changes are re-resolved. Captured 410 and failure records carry the same route fact into API auto-rotation, preventing bypassed direct traffic from rotating or replaying while retaining safe retries for genuinely proxied requests.
- Evidence: `_shouldRetryAfterUpstreamResponse()` and `_shouldRetryAfterUpstreamError()` at `src/proxy/proxy-server.js:69-145` gate on the global `upstreamProxy`, but their call sites do not pass whether `_shouldUseUpstreamProxy()` selected that proxy for the request.
- Impact: a response or transient failure from an intentionally direct destination can rotate or consume the proxy provider and replay the request unnecessarily.
- Reproduction: configure an upstream proxy with `example.com` in `noProxy`, make a direct GET to that host return 410, and observe the upstream retry hook and a second request.

### BUG-334 — Medium — Rule-group exports cannot be imported back

- Evidence: `exportMockRules()` includes top-level groups. Replacement import now accepts them through the atomic PUT route, but `importMockRules()` selects Replace only when a mock already exists; an empty app necessarily uses append mode, which posts each group to the ordinary `/api/mock-rules` route and receives 400.
- Impact: a valid `.htkrules` group backup still cannot restore into the normal empty-state destination. The failure is now reported instead of falsely toasted as success, but the group and all of its children remain absent.
- Reproduction: export a group containing a rule, clear every mock, and import the file; append POST rejects the group and nothing is restored. Add an unrelated mock first, choose Replace, and the same file succeeds.

### BUG-339 — Medium — Stale HTTP/2 session events evict a valid replacement

- Evidence: `_getH2Session()` registers each session's close and post-connect error listeners to call `_evictH2Session(origin)` at `src/proxy/proxy-server.js:3099-3118`. Eviction at `:3148-3156` closes and deletes whichever session is currently cached for that origin without checking that it is the session that emitted the event.
- Impact: after session A receives GOAWAY and session B replaces it, A's delayed close event destroys B. Requests on the healthy replacement fail or fall back unnecessarily and can interact with replay-sensitive request handling.
- Reproduction: cache session A, evict it on GOAWAY, cache connected replacement B, then emit A's delayed close; B is closed and removed from the cache.

### BUG-344 — Medium — WebSocket upgrades merge repeated response headers

- Evidence: `_handleHttpUpgrade()` rebuilds the upstream 101 response by iterating `proxyRes.headers` and string-interpolating each value at `src/proxy/proxy-server.js:643-648`. Node represents repeated headers such as `set-cookie` as arrays, which interpolation joins with commas into one field line.
- Impact: handshake metadata loses field boundaries; multiple cookies become a single potentially invalid cookie, especially when an `Expires` attribute itself contains a comma.
- Reproduction: return two `Set-Cookie` fields from a WebSocket origin and inspect the raw proxied 101 response; it contains one comma-joined `set-cookie` line.

### BUG-345 — Low/Medium — Legacy-rule migration write failure aborts startup

- Evidence: startup successfully flattens saved nested groups with `proxy.loadMockRules()`, then immediately calls `settings.set('mockRules', restored.rules)` when migration occurred at `src/index.js:101-106`. A read-only/full settings directory makes that persistence call throw into `main().catch`, even though the usable normalized rules are already loaded in memory.
- Impact: an installation that previously started with readable legacy rules now exits before proxy/API startup solely because it cannot persist the optional migration result.
- Reproduction: save a nested legacy group, make settings replacement fail, and start FreeKit; migration succeeds in memory but the process terminates on the write error.

### BUG-350 — Medium — Matcher hardening disables legacy match-all rules

- Status: **Fixed**.
- Resolution: Runtime matching once again preserves the historical `matchers: []` match-all behavior for persisted rules, while API and UI validation continue to reject new blank rules.
- Evidence: the BUG-138 hardening in `4b1ef28` made `_findMockRule()` reject an empty matcher array, although previously created and persisted rules relied on JavaScript's empty-array `.every()` semantics. Breakpoint, forward, HTTP/1 TLS, and HTTP/2 tests all stopped matching their explicit match-all rules.
- Impact: existing saved match-all mocks silently stopped applying after upgrade, disabling responses, breakpoints, and forwarding behavior.
- Reproduction: load a persisted rule with `matchers: []` on `4b1ef28` and send an otherwise matching request; `_findMockRule()` returns no rule. Commit `809eb87` restores the rule's prior behavior.

### BUG-351 — Medium — Adding a replacement client certificate leaves the old one active

- Evidence: the item route deduplicates only the exact `{host,pfxPath}` pair and appends a different path for the same host. `_getClientCertificateOptions()` then uses the first normalized-host match, so the older entry wins indefinitely.
- Impact: the API and UI report that the new certificate was added, but mTLS connections keep presenting the superseded certificate and continue to fail after certificate rotation.
- Reproduction: add two different PFX paths for the same host, with the old certificate first, then connect to that host; FreeKit loads the first PFX rather than the newly added one.

### BUG-352 — Medium — Client-certificate item workflow cannot configure encrypted PFX files

- Evidence: the client-certificate UI has no passphrase input, and the item POST route stores only `host` and `pfxPath`, silently discarding a supplied `passphrase`. The proxy loader supports a passphrase and the legacy bulk route can retain one, but the normal item workflow cannot provide it.
- Impact: adding a password-protected PKCS#12 file appears to succeed, but every matching mTLS connection fails when Node attempts to load the encrypted PFX without its password.
- Reproduction: add an encrypted PFX through the UI, or include `passphrase` in the item POST, then connect to its host; the saved entry has no passphrase and TLS setup fails.

### BUG-355 — Medium — Aborted non-upgrade WebSocket responses hang clients

- Evidence: `_handleHttpUpgrade()` handles a rejected upgrade by piping `proxyRes` directly to the client at `src/proxy/proxy-server.js:741-748`, without `aborted` or `error` listeners. The request-level error handler does not settle an already-received response stream.
- Impact: if an origin sends a normal 401/404 response and disconnects mid-body, the proxy forwards the partial response but leaves the downstream socket open indefinitely.
- Reproduction: have a WebSocket origin send `401` with `Content-Length: 100`, write `partial`, then destroy its socket; the client receives the partial 401 but emits neither `end` nor `close`.

### BUG-356 — Low/Medium — UI-setting updates can partially commit

- Evidence: `POST /api/ui-settings` performs separate `Settings.set()` calls for `hideTunnelRequests` and `filterSafeFonts` at `src/api/api-server.js:695-704`, although atomic `Settings.setAll()` exists.
- Impact: failure during the second write returns HTTP 500 after the first setting was permanently saved; persisted and runtime settings can disagree with each other and with the failed response.
- Reproduction: make the first `settings.set()` succeed and the second throw; `hideTunnelRequests` retains its new persisted value while `filterSafeFonts` and the proxy retain their old values.

### BUG-357 — Low/Medium — Prototype-named cookie matchers match absent cookies

- Evidence: the cookie matcher builds a normal-prototype object with `Object.fromEntries()` and tests presence using `matcher.name in cookies` at `src/proxy/proxy-server.js:3934-3939`.
- Impact: presence matchers named `constructor`, `toString`, or `__proto__` match requests containing no such cookie, potentially applying a mock to unrelated traffic.
- Reproduction: evaluate `{ type: "cookie", name: "constructor", value: "" }` against empty headers; `_evaluateMatcher()` returns true.

### BUG-358 — Low/Medium — Scalar partial-JSON matchers match every JSON body

- Evidence: `json-body-includes` parses the expected value and checks `Object.keys(expected).every(...)` at `src/proxy/proxy-server.js:3920-3926`, without requiring an object with at least one property.
- Impact: scalar expectations such as `1` or `true`, and an empty array, have no enumerable keys and therefore match every syntactically valid JSON body.
- Reproduction: evaluate `json-body-includes` with matcher values `1`, `true`, or `[]` against body `2`; every evaluation returns true.

### BUG-359 — Low — Prototype keys corrupt MCP traffic counters

- Evidence: `_handleGetTrafficStats()` stores method and host counters in ordinary objects at `src/mcp/mcp-server.js:220-243`; inherited keys are read before incrementing.
- Impact: imported traffic whose method or host is `constructor`, `toString`, or another prototype key produces function-text counts instead of numbers, corrupting MCP statistics.
- Reproduction: seed one record with method `constructor` and host `toString`, then call `get_traffic_stats`; both counts contain native-function text followed by `1`.

### BUG-360 — Low/Medium — MCP live summary exposes upstream-proxy credentials

- Evidence: `ProxyServer.getStats()` returns the complete `upstreamProxy` object, including `auth`, and `_handleGetLiveSummary()` copies it directly into tool output at `src/mcp/mcp-server.js:389-405`.
- Impact: invoking a status-summary tool sends plaintext upstream-proxy usernames and passwords into MCP client/model context although the summary needs only connection metadata.
- Reproduction: configure upstream auth as `user:secret` and invoke `get_live_summary`; its JSON contains `"auth": "user:secret"`.

### BUG-361 — Low/Medium — Cleared pending-request IDs are retained indefinitely

- Evidence: `_clearTraffic()` copies every live pending ID into `_clearedPendingTrafficIds`. Entries are deleted only if a later event reuses or completes the same ID; the set has no size limit, expiry, or other cleanup path.
- Impact: pending requests that never produce a completion leave permanent tombstones. Repeated pending-and-clear cycles can grow backend memory even while the bounded traffic log stays small.
- Reproduction: emit unique pending traffic events and clear after each without emitting their completions; `_clearedPendingTrafficIds` grows once per cycle while `trafficLog` remains empty.

### BUG-364 — Low/Medium — Webhook actions block matched requests despite their fire-and-forget contract

- Evidence: The rule editor labels webhooks `Send a webhook (fire-and-forget)` at `src/ui/app.js:4537`, but `_serveMockResponse()` awaits webhook response headers before it responds to the matched client at `src/proxy/proxy-server.js:4294-4309`.
- Impact: a slow or nonresponsive webhook delays the original client for up to the outbound timeout and can turn an otherwise matched mock response into an error.
- Reproduction: point a webhook rule at a server that accepts the connection without sending headers; the matched request remains pending instead of receiving its mock response immediately.

### BUG-365 — Low/Medium — Interrupted mock-file streams are falsely recorded or omitted

- Evidence: `_streamMockFile()` rejects when a downstream client closes early. The HTTP/1 handlers catch that post-header rejection and record status 500, `File Error`, and a file-not-found message for the existing file at `src/proxy/proxy-server.js:1629-1668,4232-4269`; the HTTP/2 catch at `:2956-2988` emits no traffic record.
- Impact: traffic history falsely diagnoses a valid file as missing on HTTP/1 and loses the request entirely on HTTP/2, obscuring ordinary client cancellations and real delivery failures.
- Reproduction: serve a large existing file, close the client after the first response chunk, and inspect traffic; HTTP/1 records `Premature close` as a missing-file 500 while HTTP/2 records nothing.

## Interceptors and cleanup

### BUG-038 — Critical — The unauthenticated API can launch an arbitrary local executable

- Evidence: `src/api/api-server.js:738-745` passes the request body as interceptor activation options; `src/interceptors/interceptor-manager.js:62-70` forwards it unchanged. `src/interceptors/electron-interceptor.js:23-24,49-54` treats `appPath` as an executable and calls `spawn()` without an allowlist or user confirmation. BUG-001 makes the route cross-origin accessible.
- Impact: a browser page can request that an executable already present on the machine be launched with the user's privileges.
- Reproduction: POST an Electron interceptor activation containing the path to a harmless test executable and observe the new process without any desktop confirmation.

### BUG-039 — High — Electron interception never passes Chromium proxy switches

- Status: **Fixed**.
- Evidence: `src/interceptors/electron-interceptor.js:37-46` places Chromium switches in a nonstandard `ELECTRON_EXTRA_LAUNCH_ARGS` environment variable, then spawns the application with an empty argument array at `:50`. The displayed manual instructions at `:27-31` use the same ineffective variable.
- Impact: Chromium renderer traffic in a normal packaged Electron application continues using its existing network configuration even though activation reports success.
- Reproduction: activate a basic Electron application that makes a renderer request; the request does not arrive at FreeKit.

### BUG-040 — High — JVM HTTPS interception does not trust the FreeKit CA

- Status: **Partially fixed**.
- Resolution: Successful dynamic attachment now installs a combined system-and-FreeKit trust manager. The attach-failure/manual fallback suggests only `-D...proxyHost` and `-D...proxyPort` flags, with no truststore or CA configuration, so its advertised HTTPS path still fails validation.
- Evidence: the comment at `src/interceptors/jvm-interceptor.js:98-101` claims CA trust, but the generated agent at `:112-133` only calls `System.setProperty` for proxy properties; it never updates a trust store or SSL context.
- Impact: attached JVM applications commonly fail intercepted HTTPS with a PKIX/certificate-path error.
- Reproduction: attach to a JVM using the default `HttpsURLConnection` trust manager and request an HTTPS URL.

### BUG-041 — High — JVM deactivation changes only FreeKit's bookkeeping

- Status: **Fixed**.
- Evidence: activation changes global properties inside the target through `System.setProperty` at `src/interceptors/jvm-interceptor.js:123-130`. Deactivation at `:296-310` only deletes local map entries and never clears the target properties.
- Impact: the target JVM continues sending traffic to a stopped proxy for the rest of its lifetime.
- Reproduction: activate a JVM, deactivate FreeKit, and make another request from the JVM.

### BUG-042 — High — Android fallback destroys the device's previous global proxy

- Status: **Fixed**.
- Evidence: `src/interceptors/android-adb-interceptor.js:308-319` overwrites `global http_proxy` without reading its prior value; cleanup at `:325-335` always writes `:0`.
- Impact: a corporate, VPN, or other debugging proxy configured before FreeKit is permanently disabled on Stop.
- Reproduction: configure a different Android global proxy, activate the FreeKit fallback, deactivate it, and read `global http_proxy`.

### BUG-043 — High — Failed Android cleanup is forgotten and cannot be retried

- Status: **Fixed**.
- Evidence: proxy clearing, app deactivation, tunnel removal, and certificate removal catch/log their own failures, but `src/interceptors/android-adb-interceptor.js:497-525` unconditionally deletes the device record or clears the whole map and reports inactive.
- Impact: if a device disconnects during Stop, it can reconnect still pointing at FreeKit while the application has discarded the state required to retry cleanup.
- Reproduction: activate the global fallback, disconnect the device, deactivate, reconnect it, and inspect its proxy setting.

### BUG-044 — High — System-proxy restore failures are reported as success

- Status: **Partially fixed**.
- Resolution: Restore failures are now propagated and retained for retry, except failure to delete an originally absent `ProxyServer` value is still swallowed and the recovery state is then cleared.
- Evidence: `src/interceptors/system-proxy-interceptor.js:90-100` catches registry restoration failures and returns normally; the API interprets that fulfilled call as a successful deactivation.
- Impact: Windows can remain routed through FreeKit while the UI says the interceptor stopped.
- Reproduction: force the registry restore command to fail, deactivate, and inspect the API response and registry values.

### BUG-045 — High — Abnormal exit leaves Windows using a dead system proxy

- Status: **Fixed**.
- Evidence: original values are held only in the in-memory `previousSettings` field and captured at `src/interceptors/system-proxy-interceptor.js:72-78`; restoration occurs only through a normal `deactivate()` call.
- Impact: a crash, force-quit, or power loss can persist `127.0.0.1:<old-port>` as the enabled Windows proxy across application restarts.
- Reproduction: activate the system interceptor, terminate the process without its shutdown handler, and read the Internet Settings registry key.

### BUG-046 — High — Browser activation failures leak managed profiles

- Status: **Fixed**.
- Evidence: `src/interceptors/browser-interceptor.js:53-62` creates and stores a managed profile before later argument/CA operations, without failure cleanup. `src/interceptors/interceptor-manager.js:109-117` deactivates only interceptors whose `isActive()` returns true.
- Impact: a launch-time exception leaves the profile directory behind for the remainder of the run.
- Reproduction: make `ca.getSpkiFingerprint()` throw; activation rejects with `active=false`, and `deactivateAll()` leaves the created profile in place.

### BUG-047 — High — Repeated Electron activation loses earlier child processes

- Status: **Fixed**.
- Evidence: `src/interceptors/electron-interceptor.js:23-67` has no already-active guard and overwrites `this.process`; `deactivate()` at `:70-75` kills only the newest handle. Exit/error listeners from every child unconditionally change the shared active flag.
- Impact: activating app A then app B leaves A running after Stop, and either child exiting can make status incorrect for the other.
- Reproduction: activate two long-running test programs sequentially and deactivate the interceptor.

### BUG-048 — Medium — Electron activation reports success before spawn is confirmed

- Status: **Fixed**.
- Evidence: `src/interceptors/electron-interceptor.js:50-67` installs an asynchronous error listener but immediately sets active and returns success, without awaiting the `spawn` event.
- Impact: missing, invalid, or non-executable paths briefly produce a successful API/UI result before later flipping inactive.
- Reproduction: activate a nonexistent executable; the call returns success before the `ENOENT` event.

### BUG-049 — High — Fresh-terminal lifecycle tracks launcher helpers, not shells

- Status: **Partially fixed**.
- Resolution: macOS and Linux now wait for and monitor the interactive shell PID. Windows still records the short-lived `wt.exe` client rather than the terminal tab or shell it creates.
- Evidence: macOS tracks `osascript` at `src/interceptors/terminal-interceptors.js:83-86`; Linux often tracks the short-lived `gnome-terminal` client at `:88-99`. Their exit handlers mark the interceptor inactive at `:113-122`, and Stop can kill only stored handles at `:128-133`.
- Impact: FreeKit reports inactive while the terminal session remains open and cannot close or otherwise clean up that session during Stop/shutdown.
- Reproduction: activate on macOS; `osascript` exits after opening Terminal.app while the shell remains running.

### BUG-050 — High — Docker Desktop instructions use an unreachable bridge address

- Status: **Fixed**.
- Evidence: `src/interceptors/docker-interceptor.js:25-32` derives the Linux bridge gateway (default `172.17.0.1`) on every platform. On Docker Desktop for Windows/macOS this gateway is inside its VM, not the host; the supported host name is normally `host.docker.internal`.
- Impact: containers started from the generated command cannot connect to the proxy on Windows/macOS.
- Reproduction: use the displayed command on Docker Desktop and attempt an HTTP request from the container.

### BUG-051 — Medium — Docker HTTPS setup supports only Node with validation disabled

- Status: **Fixed**.
- Evidence: `src/interceptors/docker-interceptor.js:46-54` does not mount or install the FreeKit CA and only adds `NODE_TLS_REJECT_UNAUTHORIZED=0`.
- Impact: curl, Python, Java, Go, and other validating clients reject intercepted HTTPS even when proxy routing works.
- Reproduction: run the generated command with curl or Python and request an HTTPS URL.

### BUG-052 — Medium — Firefox CA fallback is ineffective on macOS/Linux

- Status: **Fixed**.
- Evidence: `src/interceptors/browser-interceptor.js:204-225` ignores `certutil` failures and claims `security.enterprise_roots.enabled` is sufficient. `src/index.js:43-57` installs the CA into the OS store only on Windows, leaving no enterprise root for Firefox to import on macOS/Linux.
- Impact: Firefox interception works for HTTP but HTTPS is untrusted when NSS `certutil` is unavailable.
- Reproduction: launch isolated Firefox on macOS/Linux without `certutil` and browse to an HTTPS site.

### BUG-053 — Medium — Browser focus is offered on Linux but cannot succeed

- Status: **Fixed**.
- Evidence: `src/ui/app.js:3622-3636` treats active isolated browsers as focusable on every platform; `src/interceptors/browser-interceptor.js:430-493` implements focus only for Windows/macOS and always throws on Linux.
- Impact: clicking an active browser source on Linux consistently returns an error.
- Reproduction: activate Chrome/Firefox on Linux and use the UI focus action.

### BUG-054 — Medium — Synchronous interceptor discovery can stall all proxy traffic

- Status: **Partially fixed**.
- Resolution: Runtime browser, Docker, JVM, and ADB discovery moved off the event loop. Windows System Proxy activation, discovery, recovery, notification, and restoration still use synchronous registry and PowerShell calls with multi-second timeouts.
- Evidence: browser monitoring invokes synchronous process snapshots with five-second timeouts (`src/interceptors/browser-lifecycle.js:92-131`) from a recurring monitor. Docker, JVM, and ADB discovery/activation also use multi-second `execSync`/`execFileSync` calls on the proxy's single Node event loop.
- Impact: slow WMI, `ps`, Docker, ADB, or JDK commands freeze proxy forwarding and the management UI until completion/timeout.
- Reproduction: delay one of the external discovery commands while proxying traffic and observe the event-loop pause.

### BUG-061 — High — “Global Chrome” does not intercept an already-running Chrome

- Status: **Fixed**.
- Evidence: `src/interceptors/existing-browser-interceptor.js:27-45` launches Chrome with proxy flags but no separate profile. Chromium forwards such a launch to the existing single-instance process, which retains the flags it started with; the source comment at `:47` acknowledges it works only when Chrome is fully closed. The short-lived launcher exiting then marks the interceptor inactive at `:56-59`.
- Impact: the normal “existing browser” scenario reports activation briefly but the user's running Chrome continues direct, un-intercepted traffic.
- Reproduction: leave Chrome running, activate Global Chrome, and request a page in either the old or newly opened window; no request reaches FreeKit and the interceptor soon becomes inactive.

### BUG-088 — High — Failed isolated-browser shutdown is forgotten and cannot be retried

- Status: **Fixed**.
- Evidence: `src/interceptors/browser-interceptor.js:237-260` preserves the profile when inspection fails or processes survive termination, but then always calls `_resetLifecycleState()`, which discards the process, profile, port, and PID state at `:406-414`.
- Impact: a surviving proxied browser remains running while the UI reports inactive; subsequent Stop/shutdown calls have no handle or profile with which to retry cleanup.
- Reproduction: make process inspection fail or termination leave a PID alive, deactivate, and call deactivate again.

### BUG-089 — Medium — Per-device/per-process deactivation options are dropped

- Status: **Fixed**.
- Evidence: `src/api/api-server.js:747-750` ignores the request body, and `src/interceptors/interceptor-manager.js:80-84` calls `deactivate()` with no options. This makes the targeted Android (`android-adb-interceptor.js:497-525`) and JVM (`jvm-interceptor.js:296-307`) branches unreachable through the API.
- Impact: with multiple devices/JVMs active, asking to stop one silently stops all tracked targets.
- Reproduction: activate A and B, POST deactivation with `{deviceId: "A"}` or `{pid: "A"}`, and inspect both states.

### BUG-090 — High — Failed Windows proxy reads are saved as real disabled settings

- Status: **Fixed**.
- Evidence: both registry reads suppress every error and return defaults at `src/interceptors/system-proxy-interceptor.js:21-43`; activation stores that result at `:75`, and Stop later deletes `ProxyServer`/disables the proxy at `:56-69`.
- Impact: a transient query timeout or parse failure followed by successful writes permanently destroys the user's prior proxy configuration.
- Reproduction: force `reg query` to fail while `reg add/delete` succeed, activate, then Stop.

### BUG-091 — Medium — System-proxy Stop overwrites newer external settings

- Status: **Partially fixed**.
- Resolution: Normal Stop now verifies that the current settings still belong to FreeKit. Startup recovery restores a stale journal without comparing its saved `proxyServer` to the current registry state, so it can still overwrite a newer post-crash change.
- Evidence: activation snapshots settings once at `src/interceptors/system-proxy-interceptor.js:75`; deactivation at `:90-99` blindly restores that snapshot without checking whether current values still belong to FreeKit.
- Impact: a VPN/corporate proxy change made while FreeKit is active is replaced with stale pre-activation values.
- Reproduction: activate, change the Windows proxy externally, then Stop FreeKit.

### BUG-092 — High — JVM helper artifacts are written inside packaged app resources

- Status: **Fixed**.
- Evidence: `src/interceptors/jvm-interceptor.js:103-109,175` builds under `process.cwd()`. Electron starts the child with cwd set to the unpacked `src` resources at `electron/main.cjs:92-106`; packaged application/AppImage resources are commonly not writable.
- Impact: Java/JDK discovery succeeds, but every attach fails when it tries to create `.http-freekit-jvm-agent` under `/Applications`, `/opt`, or a read-only AppImage mount.
- Reproduction: run a packaged install from a non-writable application directory and attempt JVM attach.

### BUG-093 — Medium — Failed JVM helper compilation poisons all retries

- Status: **Fixed**.
- Evidence: `src/interceptors/jvm-interceptor.js:198-208` writes `AttachProxy.java` but recompiles only if the source does not exist; `:106` similarly trusts any existing `proxy-agent.jar`. A timeout/failure after creation leaves partial/stale artifacts that every later call reuses.
- Impact: one transient compiler/disk failure makes JVM attach permanently fail until the hidden directory is manually deleted.
- Reproduction: fail `javac` after the source write, restore it, and retry without deleting the artifact directory.

### BUG-094 — Medium — Exited JVMs remain marked active forever

- Status: **Partially fixed**.
- Resolution: Refresh now removes missing PIDs and PIDs whose reported main class changed. PID reuse by another JVM with the same main class is indistinguishable and remains falsely marked active.
- Evidence: `src/interceptors/jvm-interceptor.js:25-27` checks only the in-memory map; PIDs inserted at `:272-276` are never pruned by process/metadata refresh.
- Impact: a closed JVM leaves the interceptor active indefinitely, and PID reuse can label a different, unproxied JVM as already activated.
- Reproduction: attach successfully, exit the target JVM, and refresh interceptor metadata.

### BUG-095 — Medium — Android fallback selects an arbitrary host adapter

- Status: **Fixed**.
- Evidence: `_getHostIps()` includes every non-loopback IPv4 in OS enumeration order at `src/interceptors/android-adb-interceptor.js:368-380`; `_getHostIp()` chooses only the first or device-local `127.0.0.1` at `:359-366` and installs it at `:422,447`.
- Impact: VPN/Hyper-V/Docker addresses can be chosen instead of Wi-Fi/Ethernet; a physical device then cannot reach the reported proxy although activation succeeds.
- Reproduction: make a non-device-reachable virtual adapter enumerate first and activate the global fallback.

### BUG-096 — Medium — Electron/terminal exits are not broadcast to the UI

- Status: **Fixed**.
- Evidence: status reaches clients only through interceptor `onStatusChange` callbacks (`src/interceptors/interceptor-manager.js:47-52`, `src/api/api-server.js:38-41`). Electron changes only local state at `electron-interceptor.js:58-65`, and Fresh Terminal does the same at `terminal-interceptors.js:113-122`.
- Impact: cards/sources remain shown as Activated after the child/launcher exits until an unrelated full refresh.
- Reproduction: activate either interceptor, close its tracked process, and watch the connected UI.

### BUG-097 — Medium — macOS Fresh Terminal omits most promised environment

- Status: **Fixed**.
- Evidence: the full environment at `src/interceptors/terminal-interceptors.js:44-56` is passed only to short-lived `osascript`. The actual Terminal command at `:82-86` exports only uppercase HTTP/HTTPS proxy, `NODE_EXTRA_CA_CERTS`, and Node TLS disable, omitting lowercase proxy variables and the curl/Python CA variables.
- Impact: tools such as curl can bypass the HTTP proxy or reject HTTPS even though the terminal is labeled intercepted.
- Reproduction: open Fresh Terminal on macOS and inspect relevant variables/use curl.

### BUG-098 — Medium — Selecting a running Docker container is a no-op

- Status: **Fixed**.
- Evidence: `src/interceptors/docker-interceptor.js:33-40` merely adds `containerId` to a Set; it executes no Docker command and changes no container state. `isActive()` and activation then report success at `:21-23,46-56`.
- Impact: a user selecting a running container sees Active while that container's network environment is unchanged.
- Reproduction: activate with a running container ID and inspect its environment/traffic.

### BUG-099 — Medium — Android CA file is leaked when fallback proxy setup fails

- Status: **Fixed**.
- Evidence: `src/interceptors/android-adb-interceptor.js:442-451` pushes the CA before setting the proxy, but the `_setProxy()` failure return does not call `_removeCaCert()` or store the device for later cleanup.
- Impact: a disconnect/failure between the two ADB operations leaves an untracked certificate file in `/data/local/tmp`.
- Reproduction: allow the push to succeed, fail the settings command, and inspect the device file afterward.

### BUG-117 — High — The Electron interceptor cannot be configured from the desktop UI

- Status: **Fixed**.
- Evidence: `src/interceptors/electron-interceptor.js:23-32` returns manual instructions when `appPath` is absent, but Electron is not one of the expandable interceptors at `src/ui/app.js:3621`. Its card therefore posts an empty options object at `:3758-3766,4297-4301`, discards the response metadata, and unconditionally shows a Launched toast at `:4302-4308`.
- Impact: clicking Electron App launches nothing and offers no application picker or instructions; only a direct API caller can supply the required path.
- Reproduction: click Electron App in the desktop UI, then refresh interceptor status and observe that it is still inactive.

### BUG-118 — High — Windows proxy changes are not published to running WinINet clients

- Status: **Partially fixed**. Normal activation and restoration now publish WinINet notifications, but a failed restoration notification cannot be retried because the next Stop misclassifies the restored registry values as an external change.
- Evidence: `src/interceptors/system-proxy-interceptor.js:46-53,72-80,90-99` changes registry values only and never sends the WinINet settings-changed and refresh notifications required after a global configuration change ([Microsoft option flags](https://learn.microsoft.com/en-us/windows/win32/wininet/option-flags)).
- Impact: already-running WinINet clients can continue using cached direct/proxy settings after both Start and Stop even though FreeKit reports success.
- Reproduction: keep a WinINet client open, activate System Proxy, and make another request without restarting the client.

### BUG-119 — High — Windows per-machine proxy policy makes System Proxy a silent no-op

- Status: **Fixed**.
- Evidence: the registry key is hard-coded to HKCU at `src/interceptors/system-proxy-interceptor.js:3,46-53,72-80,90-99`; the interceptor neither checks `ProxySettingsPerUser` nor changes the machine-wide configuration ([Microsoft per-machine proxy documentation](https://learn.microsoft.com/en-us/windows-hardware/customize/desktop/unattend/microsoft-windows-ie-clientnetworkprotocolimplementation-hklmproxyenable)).
- Impact: on managed systems configured for per-machine proxy settings, FreeKit returns success while changing an ineffective user key.
- Reproduction: enable the per-machine proxy policy, activate FreeKit, and compare the effective proxy with the modified HKCU values.

### BUG-120 — High — Repeated Global Chrome activation loses the real browser handle

- Status: **Fixed**.
- Resolution: The interceptor rejects sequential repeats, while the manager now reserves the interceptor ID across discovery and activation so overlapping Starts cannot replace its handle.
- Evidence: `src/interceptors/existing-browser-interceptor.js:23-70` has no active guard, replaces `this.process` on every activation, and lets each child's exit listener mutate shared state. `deactivate()` at `:73-78` can kill only the newest handle.
- Impact: a second short-lived Chromium launcher can replace the original proxied-browser handle, mark the interceptor inactive on exit, and leave the real browser running after Stop.
- Reproduction: activate Global Chrome while Chrome is closed, activate it again, then Stop; the original proxied browser remains.

### BUG-121 — Medium — Existing Terminal reports a lifecycle it cannot observe or stop

- Status: **Fixed**.
- Evidence: merely expanding the card calls activation (`src/ui/app.js:3828-3841`), which immediately records an active terminal at `src/interceptors/terminal-interceptors.js:164-184` before the user pastes anything. Deactivation at `:187-190` only clears local fields and cannot unset variables in that shell.
- Impact: closing the instructions can report a nonexistent connection, while pressing Stop after following them leaves later shell commands routed through FreeKit.
- Reproduction: expand Existing Terminal without copying commands and inspect status; then follow the commands, Stop, and inspect the shell environment again.

### BUG-122 — High — Switching Android activation modes strands the old mode

- Status: **Fixed**.
- Resolution: Normal replacement cleans the recorded mode first, and manager-level serialization now prevents concurrent replacements from racing that cleanup and overwriting device ownership.
- Evidence: `src/interceptors/android-adb-interceptor.js:383-465` never cleans an existing `activatedDevices` entry before replacing it. Stop at `:497-525` consults only the last stored mode.
- Impact: switching between global-proxy and companion-app modes can leave the prior global proxy/CA or VPN app/reverse tunnel active, while Stop cleans only the newer half.
- Reproduction: activate a device in global mode, make the companion app available, activate the same serial again, then Stop and inspect the global proxy.

### BUG-123 — Medium — Android Stop leaves the user-installed CA trusted

- Evidence: fallback activation instructs the user to install `/data/local/tmp/http-freekit-ca.pem` into Android's credential store at `src/interceptors/android-adb-interceptor.js:483-487`. `_removeCaCert()` at `:342-351` deletes only the staging file, and Stop supplies no credential-removal step.
- Impact: a user who follows the setup instructions retains the FreeKit root CA after the interceptor is reported stopped.
- Reproduction: install the fallback CA as instructed, Stop the interceptor, and inspect Android's user credentials.

### BUG-124 — Medium — The JVM API rejects numeric process IDs

- Status: **Partially fixed**. Activation normalizes a numeric PID to the stored string form, but targeted deactivation still tests the raw numeric value and silently leaves the JVM attached.

- Evidence: `_getRunningProcesses()` stores PIDs as strings at `src/interceptors/jvm-interceptor.js:46-60`; activation compares the caller's value with strict equality at `:223-249` without normalization.
- Impact: the natural JSON body `{ "pid": 1234 }` returns process not found even though `{ "pid": "1234" }` selects the same running JVM.
- Reproduction: submit both forms for an existing JVM and compare the results.

### BUG-125 — Medium — The UI permits duplicate concurrent interceptor activations

- Status: **Fixed**.

- Evidence: `interceptorsInProgress` adds only a visual overlay at `src/ui/app.js:3779-3786,4294-4311`; neither activation click handler exits when the ID is already present. The overlay accepts pointer events at `src/ui/styles.css:1692-1704`, allowing another click to reach the card.
- Impact: rapid clicks start concurrent activation work, spawning duplicate terminals or triggering lost-handle and inconsistent-state defects in process-based interceptors.
- Reproduction: rapidly double-click Fresh Terminal and observe two detached spawn attempts.

### BUG-126 — Low/Medium — Browser discovery ignores PATH and user-local installations

- Status: **Fixed**.

- Evidence: `src/interceptors/browser-paths.js:5-46` tests only a small fixed list of absolute paths and never searches PATH or macOS `~/Applications`.
- Impact: valid installations such as Linux `chromium`/`chromium-browser`, PATH-managed browsers, and user-local macOS application bundles are shown as unavailable.
- Reproduction: install Chromium only on PATH at a location outside the hard-coded list and refresh interceptor metadata.

### BUG-161 — High — Android companion setup destroys an existing ADB reverse mapping

- Status: **Partially fixed**.
- Resolution: Normal activation snapshots and restores an existing reverse mapping. If ADB applies the replacement and then times out, activation records neither the previous mapping nor tunnel ownership, so Stop cannot restore it and the original mapping remains lost.

- Evidence: `src/interceptors/android-adb-interceptor.js:124-136` creates `adb reverse tcp:<proxyPort> tcp:<proxyPort>` without checking `adb reverse --list` or using `--no-rebind`; Stop at `:139-153` removes the port instead of restoring a prior destination.
- Impact: FreeKit can overwrite and then delete another Android development workflow's reverse tunnel.
- Reproduction: create `adb reverse tcp:8080 tcp:9000`, activate companion interception on FreeKit port 8080, then Stop; the original mapping is gone.

### BUG-162 — Medium — Browser interceptors report success before spawn is confirmed

- Status: **Partially fixed**.
- Resolution: Activation now waits for the child `spawn` event and catches errors such as ENOENT and EACCES. A corrupt or otherwise unusable browser that spawns successfully and exits immediately can still be returned as active/successful before its exit handler reverses the state.
- Evidence: `src/interceptors/browser-paths.js:41-47` verifies only that the path exists. Isolated browsers at `browser-interceptor.js:65-92` and Global Chrome at `existing-browser-interceptor.js:51-70` mark active and return immediately after `spawn()`, while launch failure is handled only by a later error listener.
- Impact: API/UI confirms activation for a non-executable or corrupt browser binary and only silently changes state afterward.
- Reproduction: leave a non-executable file at a detected browser path and activate its interceptor.

### BUG-163 — Medium — Electron Stop marks inactive before the application exits

- Status: **Fixed**.

- Evidence: `src/interceptors/electron-interceptor.js:19-20,70-75` sends one signal and immediately clears active state; later `process.killed` is treated as proof of exit even though Node defines it only as successful signal delivery.
- Impact: an Electron app that delays or handles SIGTERM remains alive and proxy-configured while FreeKit reports it stopped, and a second Stop will not retry.
- Reproduction: intercept an app with a SIGTERM handler that stays alive, then click Stop and inspect its PID/status.

### BUG-164 — Medium — Fresh Terminal never falls back after an early launcher failure

- Status: **Partially fixed**.
- Resolution: Candidate launchers now fall back when they fail within a fixed 100 ms grace period. A launcher that exits nonzero just after that window is returned as a successful activation and later becomes inactive without trying the next working candidate.

- Evidence: the spawn helper resolves on the child's spawn event at `src/interceptors/terminal-interceptors.js:3-16`; candidate loops at `:69-81,95-103` stop at that point without checking for an immediate nonzero exit, and `:110-125` reports success.
- Impact: an installed but unusable first-choice terminal prevents later working candidates from being attempted.
- Reproduction: make `gnome-terminal` spawn but immediately fail for lack of a display while `xterm` works, then activate Fresh Terminal.

### BUG-165 — Medium — System Proxy omits WinHTTP despite claiming all machine traffic

- Evidence: `src/interceptors/system-proxy-interceptor.js:3,46-53,72-80` changes only current-user Internet Settings. The UI promises “Intercept all HTTP traffic on this machine” at `src/ui/app.js:3561`, but no WinHTTP proxy is configured.
- Impact: Windows services and machine clients using WinHTTP continue bypassing FreeKit while the interceptor reports active.
- Reproduction: activate System Proxy and run `netsh winhttp show proxy`; its setting remains unchanged.

### BUG-166 — Low/Medium — Failed interceptor activations return HTTP 200

- Status: **Fixed**.
- Evidence: Android returns `{ success: false, error }` at `src/interceptors/android-adb-interceptor.js:411-419,449-450`, and JVM does the same at `jvm-interceptor.js:247-269`. `interceptor-manager.js:70-78` passes these through while `src/api/api-server.js:738-744` always uses `res.json()` with the default success status.
- Impact: API clients that rely on `response.ok` treat a rejected device or process activation as successful.
- Reproduction: POST activation for a nonexistent Android serial or JVM PID and observe HTTP 200 with `success: false`.

### BUG-167 — Low — Stale browser cleanup trusts reused PIDs indefinitely

- Status: **Fixed**.

- Evidence: `src/interceptors/browser-lifecycle.js:68-72` stores only the FreeKit process PID in the profile marker; `:80-89,226-230` preserves the profile whenever any current process has that PID, without checking executable identity or process start time.
- Impact: after a crash and PID reuse, large abandoned profiles can survive every startup because an unrelated process is mistaken for their owner.
- Reproduction: leave a managed profile marker containing an unrelated live PID and run startup cleanup; the directory is classified as active.

### BUG-197 — Medium — Android remains active after interception disappears

- Evidence: `src/interceptors/android-adb-interceptor.js:26-27` checks only the in-memory activation map. Entries added at `:454-465` are never reconciled with connected devices, Android's global proxy, the VPN app, or reverse-tunnel state.
- Impact: unplugging a device, stopping the VPN, or changing its proxy leaves FreeKit reporting it active; reconnecting the same serial can suppress activation even though no interception exists.
- Reproduction: activate a device, unplug it or reset `settings global http_proxy`, then refresh interceptor status.

### BUG-198 — Medium — Existing Windows proxy bypasses remain active

- Status: **Fixed**.
- Resolution: System Proxy now snapshots `ProxyOverride` with distinct missing and empty states, journals both the prior and FreeKit-owned settings, and clears the override while active. Normal Stop, activation rollback, and stale-session recovery restore the exact prior override state; ownership checks preserve any newer external proxy or bypass change, while recovery still recognizes partial activation left by a crash.
- Evidence: `src/interceptors/system-proxy-interceptor.js:21-43` reads only `ProxyEnable` and `ProxyServer`; activation at `:72-80` changes only those values and never snapshots or clears `ProxyOverride`.
- Impact: every host in the user's existing bypass list continues connecting directly while the UI promises all machine HTTP traffic is intercepted.
- Reproduction: set `ProxyOverride` to `example.com`, activate System Proxy, and request that host from a WinINet client.

### BUG-199 — Medium — Windows Fresh Terminal can open an unproxied tab

- Status: **Fixed**.
- Resolution: Windows Terminal launches now pass the supported `new-tab --inheritEnvironment` option so a tab opened in an existing instance inherits FreeKit's supplied proxy and CA environment. PowerShell and Command Prompt fallbacks are unchanged.

- Evidence: `src/interceptors/terminal-interceptors.js:44-56,64,69-77` supplies transient proxy variables to `wt.exe` but invokes only `new-tab`, without `--inheritEnvironment` or an explicit shell command.
- Impact: Windows Terminal can create the shell from a freshly loaded environment, dropping FreeKit's proxy/CA variables while activation reports success and skips later fallbacks.
- Reproduction: use an existing Windows Terminal window, activate Fresh Terminal, and inspect `HTTP_PROXY` in the new tab.

### BUG-200 — Medium — Concurrent interceptor-card responses restore the wrong card

- Status: **Fixed**.
- Resolution: Interceptor card selections and per-card operations now carry generation tokens. Stale activation, failure, child action, and metadata-refresh completions cannot replace a newer selection or emit obsolete UI feedback, while independent cards retain separate progress and may operate concurrently.

- Evidence: `src/ui/app.js:3853-3892` uses one shared `expandedInterceptorMetadata` and `expandedInterceptorId`; every asynchronous response overwrites both without verifying that its card is still the latest selection, and earlier requests are not aborted.
- Impact: a slow earlier activation/metadata response can replace the user's newer expanded card and contents.
- Reproduction: delay Android's response, click Android and then JVM; when Android finishes, it switches the UI back.

### BUG-201 — Low/Medium — macOS browser Focus can raise the wrong profile

- Evidence: `src/interceptors/browser-interceptor.js:479-490` only runs `tell application "<browser>" to activate`; it does not identify the managed profile directory, process, or window. Windows uses profile-specific selection at `:435-476`.
- Impact: when normal and isolated windows coexist, Focus can raise the unproxied normal profile instead of FreeKit's browser.
- Reproduction: run normal and isolated Chrome windows on macOS and invoke Focus with the normal window foremost inside Chrome.

### BUG-202 — Low/Medium — Terminal setup commands do not escape certificate paths

- Status: **Fixed**.
- Resolution: Existing Terminal metadata and the renderer fallback now generate shell-specific literal assignments: POSIX-safe single quoting for Bash/Zsh, doubled single quotes for PowerShell, and CMD's quoted `set "NAME=value"` form. Paths containing spaces and shell metacharacters are no longer split or executed as command syntax.

- Evidence: `src/interceptors/terminal-interceptors.js:84,179-181` interpolates the path directly into AppleScript, Bash, PowerShell, and CMD commands; CMD is unquoted and the others do not escape their shell's interpolation characters. UI fallback commands repeat this at `src/ui/app.js:3936-3938`.
- Impact: valid data paths containing `&`, `$`, backticks, or apostrophes create truncated or invalid commands, leaving HTTPS trust unconfigured.
- Reproduction: use an APPDATA path under `C:\Temp\A&B`, choose CMD in Existing Terminal, and paste the generated command.

### BUG-206 — Medium — Android activation can fail after committing active state

- Status: **Fixed**.
- Resolution: Device-specific activation now generates fallible QR response metadata immediately after device validation and before replacement cleanup or device mutation. The successful response reuses that metadata and the validated device list, so no response-only await remains after activation ownership is committed.

- Evidence: `src/interceptors/android-adb-interceptor.js:454-465` records the device and sets active after configuring proxy/VPN, but response construction still awaits `_getQrMetadata()` at `:481`; QR generation can reject at `:181-189`. The API then returns an error without rollback.
- Impact: UI/API reports failure while the device proxy, VPN/reverse tunnel, and in-memory activation remain active.
- Reproduction: force `QRCode.toDataURL()` to reject during a valid activation and inspect `isActive()` and `activatedDevices` afterward.

### BUG-207 — Medium — Non-browser interceptor transitions are never broadcast

- Status: **Fixed**.
- Resolution: Interceptor operations now compare aggregate active state before and after successful activation or deactivation. The manager synthesizes a status event when callback-free interceptors transition, coalesces callbacks from process interceptors that already report lifecycle changes, and suppresses metadata-only, no-op, partial-target, and unsuccessful transitions.

- Evidence: `src/interceptors/interceptor-manager.js:47-52` installs `onStatusChange`, and the API broadcasts only callbacks it receives. Android, JVM, System Proxy, Docker, Electron, and terminal implementations do not invoke normal activate/deactivate status callbacks, and their API routes do not publish after success.
- Impact: other open UI sessions remain indefinitely stale after one client starts or stops these interceptors and can offer invalid actions against outdated state.
- Reproduction: open two UI sessions, activate System Proxy or Android in one, and observe no connected-source change in the other until reload.

### BUG-218 — High/Medium — Restart preserves orphaned browsers but discards their ownership

- Scope update: Global Chrome has the same restart-ownership failure without a managed-profile marker. A fresh `ExistingBrowserInterceptor` has no handle for the surviving default-profile browser, reports inactive, and cannot stop it.
- Evidence: startup cleanup classifies a profile with a related live browser as `skippedActive` at `src/interceptors/browser-lifecycle.js:223-230`. `InterceptorManager` invokes cleanup at `interceptor-manager.js:17-23` but ignores that result, then constructs new browser interceptors with empty process/profile state at `:25-37`.
- Impact: after a server crash, restart leaves surviving isolated or Global browsers running while reporting them inactive and unable to be stopped; isolated profiles additionally remain orphaned after their browser exits.
- Reproduction: activate isolated or Global Chrome, hard-kill only the server, restart while the browser remains open, and call Stop from the fresh interceptor.

### BUG-219 — Medium — Android treats `am start -W` timeout output as success

- Status: **Fixed**.
- Resolution: HTTP Toolkit Android activation and deactivation now require an explicit successful `Status: ok` from `am start -W`. Failed activation rolls back its reverse tunnel; failed deactivation retains the device and tunnel ownership so Stop can be retried safely.

- Evidence: activation and deactivation ignore `_adb()` stdout at `src/interceptors/android-adb-interceptor.js:216-234,251-261` and infer success only from exit status, although `am start -W` can print `Status: timeout` with a zero exit.
- Impact: a timed-out launch is marked active; a timed-out stop clears local ownership and removes the reverse tunnel even though the VPN app may still be active.
- Reproduction: make the companion activity return `Status: timeout` and observe both helpers return success.

### BUG-232 — High — Failed System Proxy activation can survive graceful shutdown

- Status: **Fixed**.

- Evidence: `src/interceptors/system-proxy-interceptor.js:75-84` writes ProxyEnable before ProxyServer. If the second write and rollback both fail, it reports an error with `active=false` but retains `previousSettings`; shutdown at `interceptor-manager.js:109-114` deactivates only entries whose `isActive()` is true.
- Impact: Windows can remain pointed at a dead partial proxy even after failed activation and orderly application shutdown.
- Reproduction: fail the ProxyServer write and rollback, then run manager shutdown and inspect registry state.

### BUG-233 — Medium — Existing Terminal instructions omit advertised client support

- Status: **Fixed**.

- Evidence: `src/interceptors/terminal-interceptors.js:179-181` sets only uppercase HTTP/HTTPS proxy, `NODE_EXTRA_CA_CERTS`, and Node TLS bypass. It omits lowercase proxy names plus SSL_CERT_FILE, REQUESTS_CA_BUNDLE, and CURL_CA_BUNDLE despite advertising general/Python/Docker processes.
- Impact: curl can bypass HTTP and curl/Python HTTPS can reject FreeKit's CA on macOS/Linux; the instructions effectively support Node only.
- Reproduction: follow Existing Terminal instructions and use curl/Python without adding variables manually.

### BUG-234 — Low/Medium — Fresh Terminal is advertised on unsupported Linux systems

- Status: **Fixed**.

- Evidence: `src/interceptors/terminal-interceptors.js:32-34` always returns true from `isActivable()`, while Linux activation supports only gnome-terminal, xterm, and konsole at `:88-107` and otherwise throws.
- Impact: headless and minimal Linux installations show an available actionable interceptor that cannot activate.
- Reproduction: run on Linux with none of the three launchers installed and refresh interceptor metadata.

### BUG-246 — High — Chromium interceptors silently bypass localhost traffic

- Status: **Fixed**.

- Evidence: isolated Chromium arguments at `src/interceptors/browser-interceptor.js:136-160` and Global Chrome at `existing-browser-interceptor.js:31-47` set proxy-server but omit Chromium's `--proxy-bypass-list=<-loopback>` override.
- Impact: Chrome, Edge, Brave, and Global Chrome bypass common localhost and link-local development traffic while reporting successful interception.
- Reproduction: activate an affected browser and request a localhost service.

### BUG-247 — High/Medium — Startup cleanup deletes markerless lookalike directories

- Status: **Fixed**.
- Resolution: Startup cleanup now requires a valid regular, non-symlink FreeKit ownership marker before recursively removing a stale browser profile.

- Evidence: `src/interceptors/browser-lifecycle.js:80-89` yields no owner for a missing/malformed marker, but cleanup at `:223-235` recursively deletes any direct temp child matching the FreeKit browser-profile name pattern without requiring ownership proof.
- Impact: a renamed backup or unrelated colliding directory can be recursively erased at startup.
- Reproduction: create a markerless direct temp child named `http-freekit-chrome-backup` and run startup cleanup.

### BUG-248 — High/Medium — Browser shutdown can kill unrelated substring matches

- Status: **Fixed**.
- Resolution: Browser process ownership now requires a supported browser executable plus an exact Chromium `--user-data-dir=<profile>` or Firefox `-profile <profile>` launch argument, with quote-aware parsing and Windows-only case folding. Explicit launch roots and their descendant trees remain tracked, while suffixes, prefixes, and incidental or diagnostic uses of the profile are excluded from shutdown and startup-cleanup decisions.
- Evidence: `collectRelatedProcessIds()` at `src/interceptors/browser-lifecycle.js:138-168` treats any command containing the profile path substring as owned and recursively includes descendants; shutdown kills every returned PID.
- Impact: backup, indexing, or diagnostic commands mentioning `<profile>-backup` can be terminated with their process trees.
- Reproduction: run an unrelated process whose argument contains the managed profile path plus a suffix, then stop the browser interceptor.

### BUG-249 — High — Restart loses ownership of persistent Android interception

- Status: **Fixed**.
- Resolution: Android global-proxy activation now atomically journals validated per-device cleanup ownership under the configured data directory before staging the CA or changing proxy settings. New manager instances adopt valid records, retain them across failed cleanup, and remove them only after restoring the exact prior proxy and removing the staged CA; invalid journals are ignored safely.

- Evidence: global activation writes persistent `settings global http_proxy` at `src/interceptors/android-adb-interceptor.js:308-319`, but ownership exists only in constructor maps and activation records. Startup performs browser cleanup only and never detects/adopts Android proxy/VPN state.
- Impact: after a crash/hard restart, the device remains proxied while FreeKit reports Android inactive and Stop cannot restore it.
- Reproduction: activate global Android interception, hard-kill the server, restart, and inspect status/device proxy.

### BUG-253 — High/Medium — System Proxy activates without working HTTPS trust

- Status: **Fixed**.
- Resolution: Windows System Proxy discovery and activation now require confirmed FreeKit CA installation while recovery and Stop remain available independently.

- Evidence: Windows CA installation failures are treated as non-critical at `src/index.js:49-60`, leaving system trust false. `SystemProxyInterceptor.isActivable()` and activation check only the platform and registry writes at `src/interceptors/system-proxy-interceptor.js:13-15,72-80`.
- Impact: the UI reports active system interception while HTTPS clients reject every generated certificate.
- Reproduction: force Windows CA installation to fail, then activate System Proxy and browse HTTPS.

### BUG-254 — Medium — Fresh Terminal preserves inherited proxy bypass rules

- Status: **Fixed**.
- Resolution: The shared terminal environment now explicitly clears both `NO_PROXY` and `no_proxy`, overriding inherited bypasses in every Fresh Terminal launcher and emitting matching empty assignments in Bash/Zsh, PowerShell, CMD, and renderer-fallback instructions.
- Evidence: the environment spreads all of `process.env` and overrides proxy variables at `src/interceptors/terminal-interceptors.js:44-56`, but never clears or replaces NO_PROXY/no_proxy.
- Impact: `NO_PROXY=*` makes activation a complete no-op for compliant clients, and common exclusions silently bypass capture despite the all-processes promise.
- Reproduction: launch FreeKit with `NO_PROXY=*`, activate Fresh Terminal, and make a request with curl.

### BUG-255 — Medium — Fresh Terminal cannot intercept Docker as advertised

- Status: **Fixed**.
- Evidence: the UI promises all processes and Docker containers, but Fresh Terminal only gives the host shell loopback proxy variables at `src/ui/app.js:3592` and `src/interceptors/terminal-interceptors.js:40-56`; it neither configures Docker client proxies nor adds container environment flags.
- Impact: normal docker run/Compose workloads launched from that shell bypass FreeKit, and propagating 127.0.0.1 would point at the container itself.
- Reproduction: activate Fresh Terminal, launch a container that makes HTTP requests, and inspect FreeKit traffic.
- Resolution: Fresh Terminal now describes only host commands and processes launched from its shell, directs container traffic to the dedicated Docker interceptor, and no longer appears in Docker-tagged interceptor searches; README copy makes the same capability boundary explicit.

### BUG-270 — Medium — Fresh Terminal replaces public CA trust

- Status: **Fixed**.
- Resolution: Terminal certificate variables now share an atomically refreshed PEM bundle, written with restrictive permissions, containing Node's bundled public roots followed by the current FreeKit CA. The stable bundle survives terminal deactivation, and terminal setup restores normal Node certificate verification instead of disabling it.
- Evidence: `src/interceptors/terminal-interceptors.js:50-53` points SSL_CERT_FILE, REQUESTS_CA_BUNDLE, and CURL_CA_BUNDLE directly at FreeKit's one-certificate CA file; those variables override rather than extend the clients' normal trust bundles.
- Impact: curl/Python can validate intercepted certificates but reject genuine public certificates for TLS-passthrough hosts.
- Reproduction: configure a public host for TLS passthrough, activate Fresh Terminal on Linux, and access it with curl or Requests.

### BUG-275 — Medium — JVM agent bytecode can be newer than the target JVM

- Status: **Fixed**.
- Resolution: ProxyAgent now targets Java 8 bytecode with `--release 8` on modern javac and a Java 8-compatible `-source 8 -target 8` fallback for legacy javac. The bytecode policy participates in the agent cache hash, while the separately executed attach helper retains host-JDK compilation defaults.
- Evidence: `src/interceptors/jvm-interceptor.js:143-151` invokes the PATH-selected javac without `--release`, source, or target, then attaches the JAR to any JVM listed at `:223-275`.
- Impact: a current JDK compiling for an older target fails during agent load with UnsupportedClassVersionError.
- Reproduction: put JDK 21 first on PATH, run a Java 8 target, and attach it.

### BUG-276 — Medium — JVM interception keeps the localhost bypass

- Status: **Fixed**.
- Evidence: the generated agent and fallback flags set proxy hosts/ports but never clear or override `http.nonProxyHosts` (`src/interceptors/jvm-interceptor.js:112-132,170,260-263`; UI JVM flags).
- Impact: Java's default localhost/loopback exclusions bypass FreeKit while the target is reported attached.
- Reproduction: attach a JVM and request a localhost service using default networking properties.
- Resolution: JVM activation now captures `http.nonProxyHosts` with the other proxy properties and sets it to an empty value, so both HTTP and HTTPS loopback traffic use FreeKit. Agent detach restores the prior value or absence, and backend/UI fallback launch flags now include the same empty override.

### BUG-277 — Low/Medium — Global Chrome activation bypasses URL validation

- Status: **Fixed**.
- Evidence: isolated browsers normalize activation URLs, but `src/interceptors/existing-browser-interceptor.js:45-46` appends arbitrary `options.url` directly to Chromium arguments.
- Impact: activation accepts strings beginning with `--` as switches and accepts local/custom schemes rejected by the browser-open path.
- Reproduction: activate Global Chrome with URL `--incognito` or a file URL.
- Resolution: Global Chrome now normalizes its activation URL before browser discovery or process checks, allowing only valid HTTP(S) URLs and passing the canonical trimmed URL as a single launch argument. Invalid values fail before any browser process is inspected or spawned.

### BUG-283 — Medium — Java 8 JDKs are falsely reported unavailable

- Status: **Fixed**.
- Evidence: `src/interceptors/jvm-interceptor.js:14-22` probes with `jps -h`; OpenJDK 8 supports `-?`/`-help` but rejects `-h` nonzero, which `isActivable()` converts to false.
- Impact: a normal Java 8 JDK on PATH cannot use JVM interception despite providing Java and jps.
- Reproduction: put JDK 8 first on PATH, run `jps -h`, and refresh interceptor status.
- Resolution: JVM discovery retains its bounded `java -version` check but now probes `jps -q`, the quiet process-list option documented by the [Java SE 8 tools reference](https://docs.oracle.com/javase/8/docs/technotes/tools/windows/jps.html). A successful probe is accepted even when its output is empty, while missing or failing Java/JPS tools still make the interceptor unavailable.

### BUG-284 — Medium — Chromium interceptors disable all certificate validation

- Status: **Fixed**.
- Evidence: isolated and Global Chrome argument construction adds the scoped SPKI trust flag plus unconditional `--ignore-certificate-errors`; macOS/Linux commonly use this path because system CA installation is Windows-only.
- Impact: these browsers accept expired, self-signed, hostname-invalid, and passthrough/direct certificates unrelated to FreeKit; Global Chrome can apply this to the user's normal session.
- Reproduction: activate on macOS/Linux and visit an invalid-certificate origin through passthrough/direct access.
- Resolution: Isolated Chromium browsers now use only the FreeKit CA's SPKI allowlist with their explicit managed user-data directory; broad certificate-error, insecure-localhost, and test-mode switches were removed. Because [Chromium requires an explicit user-data-dir for scoped SPKI trust](https://chromium.googlesource.com/chromium/src/+/HEAD/services/network/ignore_errors_cert_verifier.h), Global Chrome's default-profile mode is now available and activatable only when the FreeKit CA is confirmed in system trust, and its launch needs no certificate bypass flags.

### BUG-286 — Medium — Terminal interceptors disable all Node TLS verification

- Status: **Fixed**.
- Resolution: The BUG-270 terminal trust changes cover every Fresh and Existing Terminal path. Fresh terminals remove any inherited `NODE_TLS_REJECT_UNAUTHORIZED` value before launching, while Bash, PowerShell, and CMD setup instructions explicitly clear it. All terminal trust variables use the stable, atomically refreshed bundle containing Node's public roots plus the FreeKit CA, so Node keeps normal certificate and hostname verification while trusting intercepted certificates.

- Evidence: Fresh Terminal injects `NODE_TLS_REJECT_UNAUTHORIZED=0` at `src/interceptors/terminal-interceptors.js:55,84`; Existing Terminal instructions and UI fallback repeat it at `:179-181` and `src/ui/app.js:3957-3959`.
- Impact: Node programs accept expired, self-signed, and wrong-host certificates for bypassed, direct, and passthrough destinations unrelated to FreeKit.
- Reproduction: activate/paste terminal setup and request a self-signed wrong-host HTTPS endpoint with Node.

### BUG-287 — High — Electron force-kill can interrupt proxy restoration

- Status: **Fixed**.
- Resolution: Desktop shutdown now uses an IPC completion handshake with the backend. Electron waits for the backend to finish all interceptor, proxy, and API cleanup and exit naturally; it force-kills only after cleanup has explicitly completed but exit stalls, or after one deliberate 30-second overall deadline if cleanup hangs. This replaces the three-second timer that raced normal isolated-browser shutdown before System Proxy and Android restoration.

- Evidence: `shutdownServer()` force-kills the child after three seconds at `electron/main.cjs:225-264`, while one isolated-browser shutdown can wait two seconds after SIGTERM plus two after SIGKILL at `src/interceptors/browser-interceptor.js:383-404` before later System Proxy/Android cleanup runs.
- Impact: closing the desktop with a resistant browser can terminate graceful cleanup before registry/device proxy restoration, leaving clients pointed at a dead proxy.
- Reproduction: activate a resistant isolated browser plus System Proxy, close the desktop window, and inspect registry state after the child is killed.

### BUG-290 — High/Medium — Browser activation can race Stop and lose the new browser

- Status: **Fixed**.
- Resolution: Manager-level per-interceptor serialization prevents activation and Stop from overlapping through application APIs.

- Evidence: `BrowserInterceptor.deactivate()` sets active false before its awaited termination loop at `src/interceptors/browser-interceptor.js:230-259`. Concurrent activation then passes the guard and overwrites process/profile/tracked state at `:35-72`; the old deactivation continues through mutable fields and finally resets them.
- Impact: the old Stop can kill or forget a newly reported-successful isolated browser.
- Reproduction: keep the old browser alive, begin Stop, then activate again before Stop resolves.

### BUG-291 — Medium — Electron interception disables all Node TLS verification

- Status: **Fixed**.
- Resolution: Electron main processes now receive the same stable public-roots-plus-FreeKit CA bundle as terminal interception through `NODE_EXTRA_CA_CERTS`, while any inherited `NODE_TLS_REJECT_UNAUTHORIZED` value is removed. App launch fails before spawn if that bundle cannot be refreshed or read, preserving normal certificate and hostname validation without changing renderer launch flags.
- Evidence: `src/interceptors/electron-interceptor.js:35-47` injects `NODE_TLS_REJECT_UNAUTHORIZED=0` into the launched application.
- Impact: main-process HTTPS clients accept expired, self-signed, and wrong-host certificates for direct/bypassed destinations unrelated to FreeKit.
- Reproduction: activate an Electron test app and have its main process request a wrong-host/self-signed endpoint.

### BUG-294 — Medium — Global Chrome Stop reports inactive before the browser exits

- Status: **Fixed**.
- Resolution: Global Chrome Stop now waits for actual child exit after SIGTERM, escalates to SIGKILL after a bounded grace period, and waits again for confirmed exit. Signal errors, rejected signals, and processes that ignore both signals retain the exact child handle and active state so Stop can be retried; stale exit/error events are identity-checked and cannot clear a newer browser.

- Evidence: `ExistingBrowserInterceptor.deactivate()` at `src/interceptors/existing-browser-interceptor.js:73-79` sends one signal, immediately marks the interceptor inactive, and does not wait for exit. Node marks `child.killed` when the signal is sent, so a later Stop will not retry a process that ignored the signal.
- Impact: FreeKit reports Global Chrome stopped while the tracked browser and its proxy configuration can remain running, with no further cleanup attempt available through the UI.
- Reproduction: suspend the tracked Chrome process so it cannot handle termination, click Stop, and observe that the interceptor becomes inactive while the PID remains alive.

### BUG-296 — High — Node core HTTP(S) bypasses every environment-based Node interceptor

- Status: **Fixed**.
- Resolution: Fresh and Existing Terminal, automatic Electron launches, and generated Docker settings now enable Node's built-in environment proxy agent, explicitly clear bypasses, and disclose the Node 22.21.0+/24.5.0+ requirement and explicit-agent fallback for older runtimes. The renderer fallbacks mirror the generated settings.

- Evidence: Fresh Terminal sets proxy and TLS environment variables at `src/interceptors/terminal-interceptors.js:44-56`, Existing Terminal at `:179-181`, Electron at `src/interceptors/electron-interceptor.js:47-52`, and Docker in its generated commands at `src/interceptors/docker-interceptor.js:52-53`; none enables Node's environment-proxy support or installs a proxy agent.
- Impact: built-in `node:http` and `node:https` requests from terminal children, Electron main processes, and containers connect directly and never appear in FreeKit despite those paths being advertised for Node interception.
- Reproduction: activate any affected path and issue a request with `node:http.get()` and no custom agent; the origin receives it directly, while enabling `NODE_USE_ENV_PROXY=1` on a supporting Node release routes it through the proxy.

### BUG-297 — Medium — Generated Docker configuration makes curl HTTP traffic bypass FreeKit

- Status: **Fixed**.
- Resolution: Generated Docker run and Compose settings, plus the renderer fallback, now set lowercase `http_proxy` and `https_proxy` to the same container-reachable URL as their uppercase variants. Existing empty `NO_PROXY`, Node environment-proxy enablement, and CA settings remain unchanged, so curl HTTP traffic and clients that prefer uppercase variables share the same proxy configuration.

- Evidence: `src/interceptors/docker-interceptor.js:44,52-53` and the UI fallback at `src/ui/app.js:3937-3938` emit only uppercase `HTTP_PROXY`/`HTTPS_PROXY`. On case-sensitive container environments curl deliberately ignores uppercase `HTTP_PROXY` and recognizes lowercase `http_proxy` for HTTP.
- Impact: HTTP curl requests launched with the exact displayed Docker run or Compose configuration connect directly and are not captured.
- Reproduction: use the generated command with `curlimages/curl` against an HTTP origin and observe that the origin, rather than FreeKit, receives the connection.

### BUG-298 — Medium — Isolated Firefox disables unrelated web security

- Status: **Fixed**.
- Resolution: Isolated Firefox profiles now keep stock certificate-pinning, active mixed-content, and OCSP behavior. FreeKit still configures the isolated profile proxy and trusts its CA through an explicit NSS `certutil` import, with `security.enterprise_roots.enabled` retained solely for the existing operating-system trust fallback.
- Evidence: the generated Firefox profile at `src/interceptors/browser-interceptor.js:173-178` disables certificate pinning, active mixed-content blocking, and OCSP checking in addition to configuring the FreeKit CA.
- Impact: the isolated browser permits insecure active content and suppresses pinning/revocation protections even for unrelated direct or passthrough traffic; trusting the interception CA does not require those global relaxations.
- Reproduction: launch isolated Firefox and visit an HTTPS page that embeds an HTTP script; the generated profile allows content that a stock Firefox profile blocks.

### BUG-299 — Low — Browser-open can lose its URL when the browser closes mid-request

- Status: **Fixed**.
- Resolution: Browser open now reports a specific inactive-during-open state with the already-normalized URL. The manager serializes the full Open operation and retries only that state through its internal activation path, so the URL reaches one replacement browser without recursively acquiring the interceptor lock.

- Evidence: `InterceptorManager.openUrl()` checks `isActive()` at `src/interceptors/interceptor-manager.js:102`, then `BrowserInterceptor.openUrl()` checks again at `src/interceptors/browser-interceptor.js:101-103` and throws if the process exited between the checks. The manager does not catch that transition and fall back to activation.
- Impact: closing the browser during an API trigger or deep link produces a 400 response and drops the requested URL instead of launching a replacement browser as promised for inactive interceptors.
- Reproduction: make the manager's first active check return true and the browser's second check return false, then call the open route; it returns “Chrome is not running” without activating.

### BUG-300 — Medium — Electron renderer interception disables all certificate validation

- Status: **Fixed**.
- Resolution: Electron launches now omit all certificate switches when the FreeKit CA is installed in system trust. Otherwise they require a nonempty FreeKit CA SPKI fingerprint and use only Chromium's scoped `--ignore-certificate-errors-spki-list`; the broad `--ignore-certificate-errors` switch was removed. Electron 42.3.0 [pins Chromium 148.0.7778.180](https://github.com/electron/electron/blob/v42.3.0/DEPS#L4-L5), whose [network context explicitly supplies no user-data-dir switch requirement](https://github.com/chromium/chromium/blob/148.0.7778.180/services/network/network_context.cc#L2583-L2584) to the scoped verifier. That verifier [bypasses errors only for a matching SPKI and delegates all other chains to normal verification](https://github.com/chromium/chromium/blob/148.0.7778.180/services/network/ignore_errors_cert_verifier.cc#L30-L44), so Electron's embedder path reliably honors the scoped flag without FreeKit creating or changing an application profile. Main-process CA-bundle validation and proxy environment settings remain unchanged.
- Evidence: `_getLaunchArgs()` at `src/interceptors/electron-interceptor.js:21-27` includes both a scoped SPKI allowlist and unconditional `--ignore-certificate-errors`, and activation passes the flags as real process arguments at `:55`.
- Impact: intercepted Electron renderers accept expired, self-signed, and wrong-host certificates unrelated to FreeKit, including bypassed or passthrough destinations; the unconditional switch makes the scoped SPKI flag ineffective as a boundary.
- Reproduction: activate an Electron app and load a wrong-host or self-signed HTTPS origin in a BrowserWindow; the renderer accepts it.

### BUG-301 — Medium — Android Stop overwrites proxy changes made after activation

- Status: **Fixed**.
- Resolution: Android global-proxy cleanup now reads the current device setting and restores the saved prior value only when it exactly matches the `hostIp:proxyPort` owned by that activation. A newer external proxy is preserved while FreeKit relinquishes its journal and staged CA; failed or ambiguous reads perform no proxy write and retain retryable recovery ownership.

- Evidence: activation snapshots the previous global proxy at `src/interceptors/android-adb-interceptor.js:465-469` and stores it at `:482-492`; cleanup at `:533-544` restores that stale value without first checking whether the current proxy still belongs to FreeKit.
- Impact: a VPN, administrator, or second debugging tool that changes the device proxy while FreeKit is active has its newer setting silently overwritten on Stop.
- Reproduction: start with `old:1`, activate FreeKit, set Android's global proxy to `new:2`, then Stop; the setting becomes `old:1`.

### BUG-302 — Low/Medium — Uninstalling the Android companion app makes Stop fail forever

- Status: **Fixed**.
- Resolution: Companion-app cleanup now treats only a confirmed missing package as already deactivated and still restores or removes FreeKit's reverse tunnel. Package-query and ADB transport failures remain retryable failures with device and tunnel ownership preserved.

- Evidence: `_deactivateHttpToolkitApp()` at `src/interceptors/android-adb-interceptor.js:247-267` treats an absent package as a failed app deactivation even when tunnel cleanup succeeds. Deactivation then retains the record and throws at `:525-554`, so every retry repeats the same false failure.
- Impact: uninstalling the companion app after activation leaves FreeKit permanently reporting that device as active and can make graceful shutdown report cleanup failure although the app/VPN is already gone.
- Reproduction: activate a device through the companion app, uninstall `tech.httptoolkit.android.v1`, and click Stop; the interceptor remains active on every retry.

### BUG-305 — Medium — PID reuse prevents stale system-proxy recovery

- Status: **Fixed**.
- Resolution: New Windows System Proxy recovery journals atomically persist a validated strong owner identity containing the PID, normalized executable path, and process start timestamp obtained through a bounded synchronous Windows process query. Startup skips restoration only when all three fields match the current process; an absent process or identity mismatch is treated as stale and still passes the existing registry-ownership checks before restoration. Query failures or malformed identities preserve both settings and journal for retry, and activation now refuses to mutate the registry unless its own identity was established before journaling. Legacy journals restore only when their PID is definitely dead; a live or ambiguous legacy PID is deliberately preserved without registry access because PID alone cannot prove ownership.
- Evidence: `_isProcessRunning()` at `src/interceptors/system-proxy-interceptor.js:65-72` checks only `process.kill(pid, 0)`, and `recoverStaleSettings()` at `:101-105` skips restoration whenever that raw PID exists. The recovery journal records no executable identity or process start time.
- Impact: after FreeKit crashes and Windows reuses its PID for an unrelated long-lived process, every startup treats the stale journal as live and leaves Windows pointing at the dead FreeKit proxy.
- Reproduction: leave Windows configured for FreeKit, seed `system-proxy-recovery.json` with an unrelated live PID and valid prior settings, then start FreeKit; recovery returns false without restoring the registry.

### BUG-306 — High/Medium — Electron activation can outlive Stop or shutdown

- Status: **Fixed**.
- Resolution: Direct Stop now returns an operation conflict while spawn is pending, and bulk shutdown waits for pre-existing activation before deactivating the resulting child.

- Evidence: `ElectronInterceptor.activate()` at `src/interceptors/electron-interceptor.js:86-101` marks `activating`, awaits spawn confirmation, and only then stores the process and active state. `deactivate()` at `:119-125` sees no process during that wait, while `InterceptorManager.deactivateAll()` skips it because `isActive()` is false.
- Impact: stopping or quitting during spawn can complete successfully before a newly launched Electron app becomes active and remains orphaned with proxy and TLS-bypass configuration.
- Reproduction: delay a fake child's `spawn` event, start activation, await Stop, then emit `spawn`; activation finishes active with a live, un-killed child.

### BUG-307 — High — Fresh Terminal PID reuse can kill an unrelated process

- Evidence: Fresh Terminal stores only the reported shell PID; `_isSessionRunning()` at `src/interceptors/terminal-interceptors.js:64-80` accepts any process answering `kill(pid, 0)`, and Stop sends SIGTERM to that PID at `:213-220` without checking executable identity or start time.
- Impact: after the terminal closes and its PID is reused, Refresh continues to report the interceptor active and Stop can terminate an unrelated user process.
- Reproduction: close a tracked shell, arrange for another long-lived process to reuse its PID, then refresh and Stop; the unrelated process receives SIGTERM.

### BUG-308 — Medium — Fresh Terminal Stop forgets shells that survive SIGTERM

- Evidence: `FreshTerminalInterceptor.deactivate()` at `src/interceptors/terminal-interceptors.js:213-223` sends one SIGTERM, swallows errors, and immediately clears every PID/process handle and reports inactive without waiting for exit or escalating.
- Impact: a resistant shell remains open with proxy environment variables while FreeKit discards the ownership needed to retry cleanup.
- Reproduction: activate a POSIX shell that traps or ignores SIGTERM and click Stop; the shell remains alive, but the interceptor becomes inactive and a second Stop has no target.

### BUG-309 — Medium — Android fallback can strand a failed companion reverse tunnel

- Evidence: companion activation creates and tracks the reverse tunnel at `src/interceptors/android-adb-interceptor.js:211`; on intent failure, cleanup at `:235-241` ignores a false tunnel-removal result. Activation can then commit global-proxy fallback at `:463-493`, whose Stop path at `:527-533` never retries reverse-tunnel removal.
- Impact: a partial companion failure can leave an ADB reverse mapping active after the successful fallback is stopped, exposing or conflicting with the reused device port.
- Reproduction: let reverse creation succeed, make the companion intent and reverse removal fail, allow global-proxy fallback to succeed, then Stop; the interceptor becomes inactive while the reverse mapping remains tracked and installed.

### BUG-310 — Medium — Docker CA configuration replaces public trust roots

- Evidence: generated Docker setup at `src/interceptors/docker-interceptor.js:59-64` mounts a file containing only the FreeKit CA and points `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, and `CURL_CA_BUNDLE` at it. Those variables replace the clients' normal trust bundles; only `NODE_EXTRA_CA_CERTS` is additive.
- Impact: direct, bypassed, or passthrough public HTTPS requests from OpenSSL, Requests, and curl can fail issuer validation even though their normal system roots trust the destination.
- Reproduction: start a container with the generated configuration and request a public HTTPS origin through a direct/no-proxy path; the client cannot build the issuer chain from the one-certificate bundle.

### BUG-311 — High/Medium — A stale browser monitor can erase a replacement during launch

- Evidence: `BrowserInterceptor.activate()` at `src/interceptors/browser-interceptor.js:54-84` can determine that the old browser is dead, overwrite `profileDir`, and await asynchronous launch preparation before invalidating the old monitor. The generation check at `:319-344` therefore still accepts an already-pending old result during that window.
- Impact: the old monitor or exit callback can mark a replacement inactive, delete its new profile, and clear its process state while the replacement activation is still progressing.
- Reproduction: hold replacement activation in `_getBrowserArgs()`, resolve a pending old lifecycle check as false, and observe that the new profile is cleaned and the interceptor reset before launch completes.

### BUG-312 — High/Medium — Pending device and JVM activations can commit after Stop

- Status: **Fixed**.
- Resolution: Direct Stop rejects overlap and bulk shutdown awaits each pre-existing manager operation before checking and deactivating its resulting state.

- Evidence: Android activation awaits discovery and configuration before recording ownership at `src/interceptors/android-adb-interceptor.js:428-493`, while Stop returns when no record exists at `:536-544`. JVM activation similarly awaits discovery/attach at `src/interceptors/jvm-interceptor.js:400-409`, records at `:428-432`, and Stop returns for an unrecorded PID at `:464-468`. Docker has the same bookkeeping race at `src/interceptors/docker-interceptor.js:49-74,94-97`.
- Impact: Stop or graceful shutdown can report completion, after which a pending operation modifies an Android proxy or attaches a JVM agent and only then records itself active.
- Reproduction: delay the first discovery call, start activation, complete Stop while no target is recorded, then release discovery; activation finishes active and externally configured after Stop returned.

### BUG-316 — Low/Medium — Global Chrome detection false-positives on command arguments

- Evidence: `_isBrowserRunning()` at `src/interceptors/existing-browser-interceptor.js:33-42` searches each entire process command line for the selected browser's full path or executable basename instead of checking the process executable/argv0.
- Impact: an unrelated editor, installer, or script that merely mentions `chrome.exe` can block Global Chrome activation with an instruction to close a browser that is not running.
- Reproduction: return a process snapshot containing `notepad.exe "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"`; `_isBrowserRunning()` returns true.

### BUG-317 — Medium — Cleanup-only browser state is accepted as a live browser

- Evidence: `BrowserInterceptor.isActive()` at `src/interceptors/browser-interceptor.js:54-55` returns true solely for `cleanupPending`. `openUrl()` at `:129-154` therefore spawns an opener with the retained profile even when the tracked browser is dead; `toJSON()` also exposes the state as active and focusable without identifying cleanup failure.
- Impact: the UI claims interception is Connected/Activated, and an open trigger can relaunch an untracked browser into the profile that Stop was trying to clean. Focus can instead target a dead PID or an ordinary unproxied browser.
- Reproduction: make profile cleanup fail after child exit, then invoke browser-open; it returns success and launches an opener while cleanup remains pending and the original tracked process is dead.

### BUG-318 — Medium — JVM Stop overwrites target changes made after activation

- Evidence: the generated agent snapshots proxy properties and default SSL objects once at `src/interceptors/jvm-interceptor.js:169-179`, then restoration at `:195-212` unconditionally writes those stale originals without verifying that the current values still belong to FreeKit.
- Impact: a target application that deliberately changes its proxy or default SSL context while interception is active loses the newer configuration when FreeKit stops.
- Reproduction: activate a JVM, have it set a new `http.proxyHost` or default `SSLContext`, then Stop; the agent restores the pre-FreeKit value instead of preserving the application's change.

### BUG-319 — Medium — Ambiguous Android adapters cannot be selected in the UI

- Evidence: Android activation at `src/interceptors/android-adb-interceptor.js:400-430,462,522` rejects equally reachable adapters unless the caller supplies `hostIp`, but `activateAndroidDevice()` at `src/ui/app.js:4077,4091-4104` posts only `deviceId` and renders no adapter choice.
- Impact: the visible Android fallback is unusable on common dual-homed systems where Ethernet and Wi-Fi are equally suitable for the device subnet.
- Reproduction: expose two host adapters on the device's subnet and activate through the UI; the API requires `hostIp`, but the interface offers no way to provide it.

### BUG-320 — High/Medium — Fresh Terminal activation can outlive Stop or shutdown

- Status: **Fixed**.
- Resolution: Manager serialization makes direct Stop conflict with a pending launch and makes bulk shutdown await it before terminating the recorded shell.

- Evidence: POSIX activation holds its launched process and shell PID only in local variables while awaiting terminal launch, then records them at `src/interceptors/terminal-interceptors.js:214-218`. `deactivate()` at `:233-245` sees empty arrays during that wait and returns without canceling activation.
- Impact: Stop or graceful shutdown can finish before a pending launch records itself, after which a new terminal opens and remains proxy-configured and active.
- Reproduction: delay `_launchTrackedPosixTerminal()`, start activation, await Stop, then resolve the launch; the interceptor changes from inactive/empty to active with a live process and session PID.

### BUG-325 — High/Medium — Android proxy setup can apply but be treated as untracked failure

- Evidence: `_setProxy()` collapses every ADB timeout or disconnect into `false`, even when the device applied the command first. The failure branch at `src/interceptors/android-adb-interceptor.js:533-551` rolls back only the staged CA and discards the already captured `previousProxy` without recording the device.
- Impact: activation can return failure and remain locally inactive while the device continues pointing at FreeKit; Stop then has no ownership record with which to restore the prior proxy.
- Reproduction: make the ADB settings command apply FreeKit's proxy and then time out so `_setProxy()` returns false; activation fails, the map stays empty, and Stop leaves the changed device proxy in place.

### BUG-326 — High/Medium — Global Chrome activation can outlive Stop

- Status: **Fixed**.
- Resolution: Manager serialization prevents Stop from completing during the pending browser scan and bulk shutdown waits before cleaning the resulting activation.

- Evidence: `ExistingBrowserInterceptor.activate()` checks `active`/`process` before awaiting `_isBrowserRunning()` and records no `activating` reservation. `deactivate()` can therefore complete while the scan is pending, after which activation resumes and spawns the browser.
- Impact: Stop or graceful shutdown can report success before Global Chrome launches and remains active with the user's normal profile and proxy flags.
- Reproduction: defer `_isBrowserRunning()`, start activation, await Stop, then resolve the scan as false; activation finishes active with a live un-killed child.

### BUG-330 — Medium — Failed Android mode replacement destroys the working mode

- Evidence: Android replacement cleans and deletes the current activation at `src/interceptors/android-adb-interceptor.js:509-518` before validating the new mode's host selection and prerequisites later in `activate()`.
- Impact: a typo, ambiguous/unreachable adapter, missing companion prerequisite, or other replacement error stops a working interception even though the requested replacement reports failure.
- Reproduction: activate the companion mode, request global replacement with an invalid `hostIp`, and observe that activation throws after the companion was stopped and its ownership removed.

### BUG-331 — High/Medium — A timed-out JVM attach can leave an untracked interception

- Evidence: `_runAttachHelper()` kills the helper after 15 seconds at `src/interceptors/jvm-interceptor.js:396-403`, even though the target's `agentmain()` may already have applied proxy and SSL changes before the helper exits. `_attachAgent()` converts that timeout into failure at `:407-425`, and `activate()` records the PID only after a successful result at `:458-481`.
- Impact: activation reports failure and FreeKit retains no ownership, but the live target can remain routed through FreeKit with its default SSL state replaced; Stop performs no detach and cannot restore it.
- Reproduction: make the attach helper apply the agent and then exceed its host timeout; activation returns false with an empty `activatedProcesses` map, while the target is configured and Stop issues no deactivate attach.

### BUG-332 — Medium — JVM interception ownership is lost across a FreeKit restart

- Evidence: the Java agent's proxy properties and SSL defaults persist inside the target JVM, but a new `JvmInterceptor` constructs an empty in-memory `activatedProcesses` map at `src/interceptors/jvm-interceptor.js:8-15`. `isActive()` and `deactivate()` consult only that map at `:32-36,501-531`; there is no journal or target-side adoption handshake.
- Impact: after FreeKit restarts while the target JVM survives, the UI reports it inactive and Stop cannot restore the target's original proxy and trust state.
- Reproduction: attach to a JVM, terminate and restart only FreeKit, then refresh and Stop; the target remains configured while the new interceptor has no tracked PID to detach.

### BUG-333 — Medium — Electron child ownership is lost across a FreeKit restart

- Evidence: Electron applications are spawned with `detached: false` but no exit-time kill guarantee or recovery record at `src/interceptors/electron-interceptor.js:90-100`. A new interceptor starts with `process = null` at `:4-11`, and `deactivate()` can kill only that stored handle at `:123-131`.
- Impact: a child that survives a server crash or restart continues using FreeKit proxy and certificate-bypass switches, while the new instance reports inactive and Stop leaves it running.
- Reproduction: launch a long-lived child, terminate only the FreeKit Node process, construct a fresh interceptor, and call Stop; the child remains alive and the new interceptor never adopts it.

### BUG-336 — Medium — Fresh Terminal shell ownership is lost across a FreeKit restart

- Evidence: launched process handles and shell PIDs exist only in `processes` and `sessionPids` at `src/interceptors/terminal-interceptors.js:31-36,220-224`. The one-shot PID file is deleted after launch at `:132`, and a new interceptor has no journal or adoption scan before `deactivate()` consults its empty collections at `:233-245`.
- Impact: a detached shell that survives a server crash keeps its proxy and CA environment, while restarted FreeKit reports it inactive and Stop cannot close it or clear the stale session.
- Reproduction: activate a detached terminal, terminate and restart only FreeKit, then query and Stop the fresh interceptor; it reports inactive with no recovered PID and the shell remains running.

### BUG-337 — High/Medium — Ambiguous Android companion activation can leave an untracked VPN

- Evidence: `_activateHttpToolkitApp()` treats any ADB exception as failure and removes the reverse tunnel at `src/interceptors/android-adb-interceptor.js:219-260`, even when the activation intent enabled the VPN before the host-side timeout. `activate()` then falls back to global proxy and records only that replacement mode at `:530-580`; later cleanup never sends the companion-app deactivate intent.
- Impact: activation can report fallback success and Stop can remove every tracked fallback change while the device's companion VPN remains active and unowned.
- Reproduction: make the activation intent enable the VPN and then time out; allow global fallback to succeed, then Stop. The proxy and reverse tunnel are gone, but the VPN stays active because no companion activation was recorded.

### BUG-338 — Medium — Android cleanup-only state is displayed as an active proxy

- Evidence: when proxy setup and staged-CA removal both fail, the interceptor records `mode: 'staging-cleanup'` and sets itself active at `src/interceptors/android-adb-interceptor.js:554-568`. The renderer maps every non-companion mode to “Global proxy” and displays “Activated” at `src/ui/app.js:4126-4143`.
- Impact: an activation that explicitly failed without configuring a proxy appears as a successful global interception; the only retained state is a cleanup retry for a staged certificate.
- Reproduction: fail `_setProxy()` and `_removeCaCert()`, refresh Android metadata, and inspect the device row; it shows an activated Global proxy despite having no proxy configured.

### BUG-346 — High/Medium — Shutdown accepts activations after their cleanup turn

- Evidence: `deactivateAll()` walks interceptors sequentially and waits only for the operation already registered for the current ID at `src/interceptors/interceptor-manager.js:133-145`. It sets no global closing flag, and `_runExclusive()` at `:87-105` continues admitting new work for IDs whose turn has passed while the API remains available.
- Impact: graceful shutdown can finish with a newly activated browser, terminal, device proxy, or attached process still active and unowned by the exiting server.
- Reproduction: let shutdown finish the first interceptor and block on a later one, then start activation for the first ID; release the blocker and observe shutdown complete without deactivating the new state.

### BUG-347 — High/Medium — Browser open actions bypass lifecycle serialization

- Evidence: `InterceptorManager.openUrl()` calls an active browser's `openUrl()` outside `_runExclusive()` at `src/interceptors/interceptor-manager.js:115-127`; `focus()` bypasses the lock similarly at `:107-113`. Stop can clear the browser's process, profile, and proxy state while the open path is between its active checks and launch.
- Impact: a URL action can finish after Stop and spawn an untracked browser using cleared `profileDir` or `proxyPort` values. Focus can likewise target stale or already terminated process state.
- Reproduction: pause the browser's second active check, complete manager Stop, then release the open; it reports success and launches after Stop with null lifecycle configuration while no manager operation was tracked.

### BUG-353 — High/Medium — Loopback binding makes remote interceptors report unreachable proxies

- Evidence: `ProxyServer` now listens on `127.0.0.1` by default, while Docker activation still advertises `host.docker.internal` or a bridge-gateway address and Android global-proxy/QR activation still configures a LAN adapter address. The interceptors cannot inspect the bind host and perform no reachability check before returning success.
- Impact: default Docker bridge/Desktop and physical-device global/QR interception appear activated but cannot connect to FreeKit. The Android companion path remains viable through ADB reverse, and an undocumented-in-UI environment override can make the other paths reachable.
- Reproduction: start with the default bind, activate Docker or Android global interception, and connect to the advertised gateway/LAN address; the loopback listener refuses or times out while `127.0.0.1` succeeds. Starting with `PROXY_BIND_HOST=0.0.0.0` makes the same advertised address reachable.

### BUG-370 — Medium — Startup cleanup can delete a concurrently created live browser profile

- Evidence: `cleanupStaleBrowserProfiles()` captures one process snapshot before enumerating profile directories at `src/interceptors/browser-lifecycle.js:272-296`; owner verification and related-process detection for every later directory use only that earlier snapshot.
- Impact: another FreeKit instance that starts and creates a marked browser profile after the snapshot can have its live profile deleted as stale, disrupting activation or leaving its browser on a recreated markerless profile.
- Reproduction: capture the cleanup process snapshot, start a live FreeKit child that creates a managed profile, then let cleanup enumerate; the child is absent from the snapshot and its live profile is removed.

## Electron, updater, and renderer

### BUG-022 — Critical — Electron IPC origin validation accepts a remote URL

- Status: **Fixed**.
- Evidence: `electron/main.cjs:327-330` uses a string `startsWith()` check. A URL shaped as `http://127.0.0.1:<port>@remote-host/` passes the prefix check even though URL parsing identifies `remote-host` as the hostname. Privileged handlers at `:333-399` rely on this check.
- Impact: remote content loaded in the renderer can obtain the API token, invoke native file dialogs/context menus, or restart the application.
- Reproduction: evaluate the predicate against the user-info URL and compare `new URL(value).hostname`; the predicate is true while the hostname is remote.

### BUG-023 — High — The Electron window permits unrestricted navigation and popups

- Status: **Fixed**.
- Evidence: the BrowserWindow installs the privileged preload at `electron/main.cjs:291-310`, but no `will-navigate` handler or `setWindowOpenHandler` exists. UI actions open URLs at `src/ui/app.js:3587,8235`.
- Impact: renderer injection or an unsafe link can navigate/open remote content in Electron with the preload bridge present, enabling chains with the IPC validation defects.
- Reproduction: navigate the main webContents or open a target URL; Electron does not deny it or route it exclusively through `shell.openExternal`.

### BUG-024 — High — Updater IPC does not validate its sender

- Status: **Fixed**.
- Evidence: `electron/updater.cjs:163-171` registers `updater-check-now` and `updater-install` without accepting or checking an IPC event; both are exposed by `electron/preload.cjs:94-105`.
- Impact: any document with that preload can trigger update checks or `quitAndInstall()`.
- Reproduction: invoke the exposed updater methods from a non-application document loaded in the same webContents.

### BUG-059 — High — “Restart app” abandons the server child without cleanup

- Status: **Fixed**.
- Resolution: Renderer restart now calls the cleanup-aware `app.quit()` path, and the shared `before-quit` gate stops the child server before relaunch completes.

- Evidence: the `restart-app` IPC handler at `electron/main.cjs:395-399` calls `app.relaunch()` followed by immediate `app.exit(0)`. It does not call `shutdownServer()` (`:226-260`), and immediate exit does not run the later `window-all-closed` cleanup path at `:441-445`.
- Impact: the original proxy/API child and any active interceptors can survive the desktop shell restart; the relaunched app starts a second server/proxy and loses ownership of the first.
- Reproduction: note the server PID, invoke the exposed restart action, and observe the original child after the new desktop process launches.

### BUG-060 — Low — The advertised minimize-to-tray behavior is not implemented

- Evidence: `README.md:188` promises minimize to tray. `electron/main.cjs:291-321` creates the window without `minimize` or `close` interception, while `:441-445` shuts down when the window closes. `electron/tray.cjs:91-105` can hide the window only when the user explicitly selects Hide from the tray menu.
- Impact: minimizing leaves a taskbar window, and closing quits the server instead of moving the application to the tray as documented.
- Reproduction: minimize or close the desktop window and inspect its taskbar/tray and process state.

### BUG-062 — Low — README advertises an unsupported Node.js baseline

- Evidence: `package.json:38-39` declares `node >=22.12.0`, while `README.md:315` advertises “Runtime: Node.js 18+”.
- Impact: users following the README can install/run with a runtime the package explicitly rejects, leading to engine warnings or dependency/runtime failures.
- Reproduction: follow Quick Start on Node 18 and compare the npm engine check with the documented requirement.

### BUG-025 — High — Multiple persisted/server values reach `innerHTML` unescaped

- Status: **Partially fixed**.
- Resolution: The originally identified status, settings, tab, and theme values are now rendered safely. Caller-controlled mock and breakpoint IDs are still interpolated raw into `innerHTML` attributes and inline handlers, allowing the same persisted script-injection class through rule APIs.
- Evidence: Send status text incorporates upstream `statusMessage` and is assigned with `innerHTML` at `src/ui/app.js:7278-7289`; the value originates at `src/api/api-server.js:1197`. Certificate, CA, whitelist, and passthrough settings are interpolated at `app.js:7798`, `:7908`, `:8000`, and `:8061`. Send tab labels derived from arbitrary URLs are interpolated at `:6966-6977`. Custom-theme preview names and color values from uploaded JSON are concatenated into markup at `:9275-9283,9302-9314`; the upload validation at `:9340-9354` requires one recognized key but preserves and previews arbitrary extra keys. There is no restrictive application CSP.
- Impact: crafted response metadata or persisted settings can execute script in the UI origin; in Electron this can reach the preload bridge.
- Reproduction: store markup containing an event handler in one of the unescaped settings, or upload a theme containing one valid key plus an extra markup-bearing key whose value begins with `#`; observe it being parsed as DOM instead of displayed as text.

### BUG-026 — High — macOS releases omit the ZIP required by `MacUpdater`

- Status: **Fixed**.
- Evidence: `electron-builder.config.cjs:70-75` builds only DMG targets. The installed `electron-updater/out/MacUpdater.js:77-80` searches for a ZIP and throws `ERR_UPDATER_ZIP_FILE_NOT_FOUND` when one is absent.
- Impact: macOS users can be notified of an update but accepting the download fails.
- Reproduction: publish the configured mac artifacts and call `downloadUpdate()` on macOS.

### BUG-027 — Medium — Update checks are inactive in DEB/RPM installations

- Status: **Fixed**.
- Evidence: `electron-builder.config.cjs:85-91` publishes AppImage, DEB, and RPM, while all Linux checks go through `electron-updater` (`electron/updater.cjs:33`). Its installed `AppImageUpdater.isUpdaterActive()` returns false when the `APPIMAGE` environment variable is absent.
- Impact: DEB/RPM users do not reach the Linux update notification flow, including manual checks.
- Reproduction: install the DEB/RPM and trigger Check for Updates in an environment without `APPIMAGE`.

### BUG-028 — Medium — Certificate pickers persist only a basename

- Status: **Fixed**.
- Evidence: `src/ui/app.js:7916-7942` displays `file.name` and puts a possible full path only in `dataset.fullPath`; `addClientCert()` and `addTrustedCA()` later read `.value` and ignore that dataset at `:7946-7957,8008-8019`. A native absolute-path picker already exists in `electron/preload.cjs:65-81` but is unused.
- Impact: selecting an absolute certificate path persists a basename the child server cannot resolve.
- Reproduction: select a certificate outside the server working directory and inspect the saved configuration.

### BUG-029 — Medium — “Use system proxy settings” leaves the custom proxy enabled

- Status: **Fixed**.
- Evidence: `src/ui/app.js:7593-7596` changes status text and returns without deleting the current upstream proxy or its persisted setting.
- Impact: traffic continues through the prior custom proxy, including after restart, despite the UI claiming system settings are active.
- Reproduction: configure a custom proxy, choose the system option, and query `/api/upstream-proxy`.

### BUG-030 — Medium — “Non-proxied hosts” is never saved or enforced

- Status: **Fixed**.
- Evidence: the input is rendered at `src/ui/index.html:469`, but `src/ui/app.js:7619-7625` submits only host, port, auth, and type. No backend forwarding path implements a bypass list.
- Impact: hosts listed by the user still traverse the upstream proxy.
- Reproduction: enter a bypass host, save, and request that host through the proxy.

### BUG-031 — Medium — Send Abort does not cancel the outbound request

- Status: **Fixed**.
- Fix: `/api/send` now aborts its outbound socket when the renderer-facing request is disconnected.
- Evidence: `src/ui/app.js:7340-7346` aborts only the renderer-to-API fetch. `src/api/api-server.js:1125-1134,1174-1208` continues its independent outbound request and never ties it to the inbound connection closing.
- Impact: a slow or state-changing request can still reach and complete at the destination after the UI reports it aborted.
- Reproduction: send a slow POST, abort after the destination receives headers, and observe the destination complete the request.

### BUG-075 — Medium — Deleting an exchange removes only the renderer copy

- Evidence: `src/ui/app.js:786-797` splices the selected item from local arrays and reports success without sending an API/WebSocket mutation. Server detail, search, and export continue reading `trafficLog` (`src/api/api-server.js:613-647`).
- Impact: a record the user deleted remains available in API/MCP results and exports and returns after any future full synchronization.
- Reproduction: delete a captured exchange in View, then request `/api/traffic/:id` or export HAR.

### BUG-076 — Medium — Pinned rows become backend-less ghosts after Clear

- Evidence: the `traffic-cleared` handler preserves locally pinned entries at `src/ui/app.js:167-175`, but the server replaces its entire log with `[]` at `src/api/api-server.js:1314-1316`. Pin state itself is changed only in the renderer at `app.js:770-777`.
- Impact: the UI retains a row that detail API, MCP, search, stats, and HAR export no longer know about; it disappears on reload.
- Reproduction: pin an exchange, Clear traffic, and compare the visible pinned row with `/api/traffic`.

### BUG-078 — Medium — Slow Send responses are written into whichever tab is active later

- Evidence: `sendRequest()` does not capture the initiating tab before awaiting fetch at `src/ui/app.js:7252-7274`; after completion, it updates the current DOM and finds the then-current `activeSendTab` at `:7285-7330`.
- Impact: switching from tab A to B while A is in flight displays and saves A's response against B.
- Reproduction: start a slow request in A, switch to B, and wait for A to finish.

### BUG-079 — Medium — Current Send edits are lost on reload/exit

- Evidence: URL/body edits update only current DOM/editor state (`src/ui/index.html:230-235`, `src/ui/app.js:6651,6780-6821`). `saveSendTabState()` persists only during selected tab operations, sending, or cURL paste (`app.js:7009-7036,7124-7160,7329,9553`); there is no unload save.
- Impact: unsent edits in the active tab silently revert after Reload, New Session, or application exit.
- Reproduction: edit the active URL/body without switching or sending, reload, and reopen the tab.

### BUG-080 — Low/Medium — Restored multipart tabs display files they no longer contain

- Evidence: persistence deliberately strips `File` objects but retains filenames at `src/ui/app.js:6980-6989,7025-7033`. Restore renders the old name at `:7039-7051,6763-6767`, while serialization requires `field.file` at `:6851-6857`.
- Impact: the tab looks ready to send but fails with “Choose a file”.
- Reproduction: choose a multipart file, persist by switching tabs, reload, return, and Send.

### BUG-081 — Medium — Reload/New Session discards mock drafts without warning

- Evidence: draft state is memory-only (`src/ui/app.js:17-20,6020-6023`). The unsaved-change warning runs only in `switchPanel()` at `:8321-8328`; Electron's New Session and Reload commands directly reload at `electron/menu.cjs:24-31,56-60`, and no `beforeunload` guard exists.
- Impact: users can lose an entire unsaved rule edit despite the application having a warning mechanism.
- Reproduction: create an unsaved draft and choose Reload or New Session.

### BUG-082 — Medium — MCP enabled state always resets to enabled

- Evidence: the toggle routes at `src/ui/app.js:8137-8145` and `src/api/api-server.js:1144-1151` never write settings. Startup hard-codes `{ enabled: true }` at `src/index.js:128-136`.
- Impact: users who disable the network MCP server find it enabled again after every restart.
- Reproduction: disable MCP, restart, and query `/api/mcp/status`.

### BUG-083 — Medium — Re-enabling MCP cannot restore stdio transport

- Evidence: disabling closes the server and clears `stdioTransport` at `src/mcp/mcp-server.js:482-493`; enabling creates only a server at `:496-503`, and the API restarts only SSE (`src/api/api-server.js:1147-1149`). `startStdio()` is called only during process startup (`src/index.js:138-143`).
- Impact: in `--mcp-stdio` mode, an off/on toggle permanently disconnects the stdio client until the entire process restarts.
- Reproduction: launch with `--mcp-stdio`, disable and re-enable, then inspect `stdioActive` and the original client connection.

### BUG-084 — Medium — Concurrent MCP disable/enable can end disabled after enable succeeds

- Evidence: `setEnabled(false)` awaits transport/server closure before nulling state (`src/mcp/mcp-server.js:482-493`). An overlapping `setEnabled(true)` sees the still-present server and does nothing at `:496-503`, but the API immediately reports the requested enabled value at `src/api/api-server.js:1144-1151`.
- Impact: rapid toggles or two clients can receive a successful enable response while final bridge state is disabled/null.
- Reproduction: hold an SSE close pending, issue disable and immediate enable requests, then inspect final status.

### BUG-085 — Medium — Overlapping update checks lose manual/automatic attribution

- Evidence: every check writes one global `currentCheckIsManual` at `electron/updater.cjs:33-40`; result handlers consume that shared flag at `:120-140,154-159`. Scheduled checks at `:174-182` can overlap, and installed `AppUpdater` coalesces concurrent calls to its existing promise.
- Impact: a scheduled check can relabel an in-progress manual check as automatic, suppressing the result/error feedback the user requested.
- Reproduction: begin a slow manual check just before the scheduled launch check fires.

### BUG-087 — Low — Sidebar and Send tabs are missing keyboard focus behavior

- Evidence: sidebar controls are clickable `<div role="tab">` nodes without `tabindex` at `src/ui/index.html:29-50`; generated Send tabs/add control repeat the pattern at `src/ui/app.js:6973-6977` and provide no Enter/Space handler.
- Impact: keyboard-only users cannot reach or activate the application's primary tab navigation using normal focus controls.
- Reproduction: traverse with Tab/Shift+Tab and attempt to activate sidebar/Send tabs with Enter or Space.

### BUG-133 — High — Normal desktop Quit paths bypass server cleanup

- Status: **Fixed**.

- Evidence: `shutdownServer()` exists at `electron/main.cjs:226-260` but is called for window closure only from `window-all-closed` at `:441-445`. File/App Quit uses the Electron quit role at `electron/menu.cjs:20,35-37`, tray Quit calls `app.quit()` at `electron/tray.cjs:97-101`, the updater quits at `electron/updater.cjs:167-170`, and startup failure quits at `electron/main.cjs:435-437`; those flows do not first close every window and invoke the handler.
- Impact: the child server can survive normal Quit or restart-to-install, leaving interceptor processes and system/device proxy settings active.
- Reproduction: activate an interceptor, choose File or tray Quit, and inspect the server child PID and proxy settings.

### BUG-134 — High — Generated request snippets permit shell and code injection

- Status: **Partially fixed**.
- Resolution: Language and shell literals are now escaped. cURL raw-body snippets still use `-d`, so a body beginning with `@` reads a local file, and multipart text fields still use `-F`, where `name=@path` has the same file-upload semantics; literal values require `--data-raw` and `--form-string`.

- Evidence: `generateExportSnippet()` interpolates captured URLs and headers directly into single-quoted cURL at `src/ui/app.js:1962-1968` despite the safe `shellSingleQuote()` helper at `:1778-1780`. Python, JavaScript, PowerShell, wget, PHP, and Go output similarly interpolates values without language-specific escaping at `:1971-2055`; the context menu copies these snippets at `:8498-8503`.
- Impact: running a snippet copied from an untrusted captured request can execute attacker-controlled shell commands or source code.
- Reproduction: capture a URL containing `' ; touch /tmp/freekit-pwn ; '` and inspect Copy as cURL before running it.

### BUG-135 — High — Replace import can erase every mock while reporting success

- Status: **Fixed**.

- Evidence: `src/ui/app.js:6374-6381` deletes all current rules before validating the imported rules. POST responses at `:6383-6388` are not checked, and `:6390` always shows success; the API rejects an empty object at `src/api/api-server.js:789-810`.
- Impact: a malformed or partially incompatible import destroys existing rules, creates none or only some replacements, and still claims the full replacement succeeded.
- Reproduction: create rules, import `{ "rules": [{}] }`, choose Replace, and observe an empty rule list plus a success toast.

### BUG-136 — Medium — Concurrent or retried Save All duplicates new mock rules

- Status: **Partially fixed**.
- Resolution: Save All itself is serialized, but per-rule Save controls share no lock with it or with each other; overlapping Save-to-server actions can still POST the same new draft twice, and revert/delete remain enabled during the snapshot.

- Evidence: the button invokes `saveAllMockRules()` without being disabled at `src/ui/index.html:184-185`. Every invocation snapshots all drafts and POSTs new ones without IDs at `src/ui/app.js:6117-6148`; drafts clear only after the whole batch succeeds.
- Impact: double-clicking creates equivalent rules with different IDs, and retrying after a later batch item fails duplicates every earlier successful new rule.
- Reproduction: throttle the API, create one new draft, and double-click Save All.

### BUG-137 — Medium — Opening another mock editor silently discards the current edit

- Status: **Partially fixed**.
- Resolution: Direct editor switching now preserves valid edits. Collapse All still clears the live editor without saving, and a single-rule collapse ignores a failed validation result before clearing the invalid edit.

- Evidence: `addNewMockRule()` overwrites `mockEditingRule` and `mockEditDraft` at `src/ui/app.js:5617-5635`; `editMockRule()` repeats this at `:5642-5649`. The previous edit becomes a saved draft only when that same rule is collapsed at `:5658-5667`.
- Impact: switching directly from rule A's editor to rule B or Add Rule loses A's changes, and the unsaved-changes warning cannot see them.
- Reproduction: edit rule A, then click Edit on rule B without collapsing or saving A.

### BUG-138 — Medium — A blank matcher creates a match-everything mock

- Status: **Partially fixed**.
- Resolution: Blank broad matchers and new empty matcher arrays are rejected, while legacy explicit match-all arrays remain compatible. `raw-body-exact` and `exact-query` are still accepted without a `value`; the runtime distinguishes a missing value from the intended empty string, leaving the visually blank exact rule inert.

- Evidence: `saveMockRule()` rejects blank conditions only if the matcher array is also empty at `src/ui/app.js:6026-6036`; a nonempty blank matcher passes. URL Contains then evaluates `url.includes("")` at `src/proxy/proxy-server.js:3222-3223`, which is true for every URL.
- Impact: a visually blank rule can unexpectedly return its mock response for all traffic.
- Reproduction: add a URL Contains condition, leave it blank, select a fixed response, save, and request an unrelated URL.

### BUG-139 — Medium — List-setting read/modify/write races lose or mis-delete entries

- Status: **Fixed**.

- Evidence: TLS passthrough (`src/ui/app.js:7806-7836`), client certificates (`:7946-7977`), trusted CAs (`:8008-8038`), and HTTPS whitelist (`:8069-8099`) each GET the entire array and POST a replacement. Remove handlers apply a stale rendered index to the newly fetched array.
- Impact: concurrent windows or rapid operations overwrite one another, and a stale Remove action can delete a different entry after another client changes the list.
- Reproduction: let two tabs read the same list and concurrently add different entries; only the last POST survives.

### BUG-140 — Medium — Electron menu accelerators override documented renderer shortcuts

- Status: **Fixed**.

- Evidence: File New Session registers `CmdOrCtrl+Shift+N` to reload at `electron/menu.cjs:25-31`, while the renderer maps the same chord to New Send Tab at `src/ui/app.js:8877-8881`. The View reload role at `electron/menu.cjs:55-60` conflicts with renderer resend on `CmdOrCtrl+R` at `app.js:8916-8920`; on macOS, File close conflicts with close-tab on `Cmd+W` at `:8901-8906`. README documents the renderer meanings at `README.md:147,154-155`.
- Impact: packaged desktop shortcuts reload or close the application window instead of performing the advertised Send/Traffic action, losing unsaved UI state.
- Reproduction: press Ctrl/Cmd+Shift+N in the packaged app and observe a session reload instead of a new Send tab.

### BUG-141 — Medium — Send editor startup can mix one tab's form with another active ID

- Status: **Partially fixed**.
- Resolution: Active-tab changes during Monaco startup are reconciled, but startup still renders a usable form before awaiting Monaco and then reloads the stored tab. Edits made during a slow load are overwritten when initialization finishes.

- Evidence: startup captures `initialTab`, awaits Monaco initialization, then unconditionally reloads the captured tab at `src/ui/app.js:7163-7171`. During the await, `switchSendTab()` or `addSendTab()` can change `activeSendTab` at `:7124-7138`, while body loading before the editor exists is ineffective at `:6613-6617`.
- Impact: the active tab ID and visible form diverge; later save/send actions can write the first tab's request into the newly active tab.
- Reproduction: delay Monaco loading and switch or add a tab before it resolves.

### BUG-142 — Medium — cURL paste corrupts valid multi-data commands

- Status: **Partially fixed**.
- Resolution: Repeated data, single-quoted backslashes, and Unicode Basic auth are improved. Quoted Windows paths still lose backslashes, an empty data argument consumes the following option, lowercase content-type can gain a conflicting default, `--data-urlencode` is not curl-compatible, and `@file` modes are treated as literal text.

- Evidence: every `-d`, `--data`, `--data-raw`, or `--data-binary` overwrites `result.body` at `src/ui/app.js:6511-6513`, although cURL joins repeated data options with `&`. `--data-urlencode` is copied without encoding at `:6514-6519`; the tokenizer strips backslashes inside single quotes at `:6487-6492`, and Unicode basic-auth values can throw through `btoa()` at `:6524-6525`.
- Impact: the Send request differs from the pasted command, and some valid cURL input aborts paste handling entirely.
- Reproduction: paste `curl https://example.test -d 'a=1' -d 'b=2'`; the body becomes only `b=2` instead of `a=1&b=2`.

### BUG-143 — Medium — Reloading during an update download can lose the install control

- Status: **Partially fixed**.
- Resolution: The renderer can replay the latest updater event after reload, but `currentStatus` stores only one transient event. A later check, up-to-date result, or error overwrites `update-downloaded`, so another reload again cannot recreate Restart to install even though the package remains ready.

- Evidence: updater state is emitted only as transient IPC events at `electron/updater.cjs:142-152`. The renderer registers its listener at `src/ui/app.js:9454-9478` and creates Restart to install only upon `update-downloaded` at `:9492-9507`; preload/updater exposes no current-status query or replay.
- Impact: if completion occurs while the renderer reloads, the event is dropped and that session never offers installation even though the package is ready.
- Reproduction: begin an update download, reload the renderer, and have completion occur before the status listener is reattached.

### BUG-144 — Low — Storage quota errors can abort navigation and startup

- Status: **Fixed**.

- Evidence: `switchPanel()` writes traffic state before changing panels at `src/ui/app.js:8321-8345`, `switchSettingsSection()` writes at `:8294`, and `setTheme()` writes at `:9403-9404`; none catches storage exceptions. Theme loading calls `setTheme()` before `connectWebSocket()` at `:9449-9450`.
- Impact: full or blocked localStorage can prevent leaving Traffic, break theme changes, and throw during startup before live traffic initialization.
- Reproduction: make `Storage.prototype.setItem` throw, then navigate away from Traffic or reload the app.

### BUG-354 — Low — Guarded storage failures report success and silently lose state

- Evidence: `safeLocalStorageSet()` and `safeLocalStorageRemove()` return `false` on blocked or quota-exceeded storage, but every caller ignores the result. Protobuf schema and custom-theme actions still show success or apply in memory; Send tabs, active tab, settings section, theme, and Traffic scroll state likewise continue without reporting that persistence failed.
- Impact: users believe state was saved or cleared, but reload restores the previous state or discards the apparent change without any warning.
- Reproduction: make `Storage.prototype.setItem` and `removeItem` throw, import or clear a protobuf schema or save/remove a custom theme, observe the success/applied UI, then reload and see the change disappear or the removed data return.

### BUG-362 — Low/Medium — Cancelled automatic proxy rotation leaves the interface stale

- Evidence: the server broadcasts `proxy-auto-rotate` with status `cancelled` and the current proxy, but `handleProxyAutoRotateEvent()` handles only `started`, `success`, and `error`.
- Impact: the interface announces that rotation started but never confirms cancellation or refreshes to the current proxy configuration. A window that did not originate the intervening manual change can display the old proxy until reload.
- Reproduction: start automatic rotation, change the proxy before lookup finishes, and let the rotation cancel; the backend retains and broadcasts the new manual proxy, but the renderer performs no cancellation update.

### BUG-363 — Low/Medium — Breakpoint timeout leaves an outdated pause banner

- Evidence: `_setBreakpointTimeout()` resolves and removes an expired breakpoint without publishing a resumed event, while the renderer refreshes its banner only for breakpoint-hit and breakpoint-resumed messages or manual resume actions.
- Impact: the interface continues showing a paused request after it resumed automatically, and a later Resume attempt fails because the pending breakpoint no longer exists.
- Reproduction: leave a paused request untouched until its five-minute timeout expires; the server removes it but the pause banner remains visible.

### BUG-366 — Low/Medium — Desktop startup can accept an unrelated local service as ready

- Evidence: `findFreePort()` releases its temporary listener before the server child binds at `electron/main.cjs:34-42`, and `waitForServer()` resolves on any HTTP response from `/api/config` at `:48-80` without checking its status or validating that it is FreeKit.
- Impact: another local process can claim the selected port during the race, after which the desktop loads an unrelated response or error page and treats failed FreeKit startup inconsistently.
- Reproduction: claim the selected port after `findFreePort()` returns and respond 503 to `/api/config`; `waitForServer()` still reports readiness.

### BUG-367 — Low — Core Send and Settings controls lack accessible names

- Evidence: The Send method and URL controls and multiple Settings toggles, selects, and port fields use adjacent text rather than associated `<label for>` elements, wrapping labels, or ARIA names at `src/ui/index.html:230,235,363-371,393-398,416-440,530-538,578-580`; renderer code never assigns names programmatically.
- Impact: screen-reader users hear only generic control roles and current values, without the purpose of essential request and configuration controls.
- Reproduction: inspect `hideTunnelRequestsToggle.labels.length` and its ARIA attributes, or navigate Send and Settings with a screen reader; the control purpose is not announced.

### BUG-368 — Medium — Request snippets merge repeated header fields

- Evidence: `getExportHeaders()` returns each array-valued header as one `[name, array]` pair at `src/ui/app.js:1874-1878`; all eight raw request snippet generators interpolate or stringify that array at `:2058-2139`, producing one comma-delimited scalar instead of repeated fields.
- Impact: copied cURL, Python, JavaScript, PowerShell, wget, PHP, and Go replays differ from the request shown and sent by FreeKit. Headers that are not safely comma-combinable can change meaning or become invalid.
- Reproduction: add two `X-Test` rows with values `one` and `two`, open the request snippet exporter, and inspect every format; each contains one `X-Test: one,two` value instead of two fields.

### BUG-369 — Low/Medium — Send silently drops the valid header name `__proto__`

- Evidence: `syncSendHeadersToHidden()` builds a normal object and assigns each user header with `obj[key] = value` at `src/ui/app.js:7164-7180`. Assigning `__proto__` invokes the inherited legacy setter rather than creating an own property, so `JSON.stringify()` omits the visible row.
- Impact: a syntactically valid request header disappears before `/api/send`, making the editor and actual wire request disagree without an error.
- Reproduction: add an enabled `__proto__: kept` row and send to a raw-header echo server; the row remains visible but is absent on the wire.

### BUG-371 — Low/Medium — Send Abort cannot cancel multipart preparation

- Evidence: `sendRequest()` installs the single-flight controller before awaiting `prepareSendRequestPayload()` at `src/ui/app.js:7623-7639`, but multipart serialization reads every file and copies/encodes the complete payload at `:7096-7132` without receiving that signal. Abort affects only the later fetch, and the controller is retained until preparation settles at `:7717-7728`.
- Impact: aborting a slow or large multipart request still reads and assembles its local files, keeps the loading state active, and silently blocks Send in every tab until preparation finishes.
- Reproduction: hold a multipart file's `arrayBuffer()` promise pending, start Send, then Abort and try another Send; no fetch occurs, the first call and loading state remain pending, and the second call is ignored until the file promise resolves.

### BUG-168 — Medium — Concurrent Send actions corrupt abort ownership

- Status: **Fixed**.

- Evidence: `sendRequest()` has no in-flight guard and replaces the one global `currentSendAbort` on each invocation at `src/ui/app.js:7257-7277`. Every request's `finally` clears the same global at `:7340`, while `abortSendRequest()` at `:7345-7349` aborts only its current value; Ctrl+Enter can invoke the disabled button's function again.
- Impact: starting B while A is pending loses A's controller, and A finishing can clear B's controller so neither later Escape nor the abort UI can stop the correct request.
- Reproduction: send twice rapidly to a slow origin, let the first invocation finish, then press Escape.

### BUG-169 — Medium — Send silently drops repeated request headers

- Status: **Fixed**.
- Evidence: the editor stores header rows as an array at `src/ui/app.js:6880-6896`, but `syncSendHeadersToHidden()` converts them to an object at `:6942-6949`; each `obj[h.key.trim()]` assignment overwrites an earlier row with the same name.
- Impact: valid repeated headers cannot be sent, and the displayed request differs from the wire request.
- Reproduction: add two `X-Test` rows with values `one` and `two`, send to an echo origin, and observe only the second.

### BUG-170 — Medium — Corrupt Send-tab storage can break Send initialization forever

- Status: **Fixed**.
- Evidence: `restoreSendTabs()` accepts any nonempty JSON array and spreads its elements without schema validation at `src/ui/app.js:7044-7067`. `loadSendTabState()` then assumes `tab.headers` is an array and calls `.slice()` at `:7070-7074`.
- Impact: valid but stale/corrupt localStorage throws an uncaught TypeError, leaving Send partially initialized on every reload.
- Reproduction: set `http-freekit-send-tabs` to `[{"id":"tab-1","headers":{}}]` and reload.

### BUG-171 — Medium — Monaco disposal leaks observers and editor instances

- Status: **Fixed**.
- Resolution: Centralized disposal remains idempotent, and each container now has generation-based initialization ownership. A newer create or explicit disposal invalidates pending work, replaces any current owner through the same cleanup path, and prevents stale work or a replaced DOM container from creating retained editors and observers after Monaco loads.

- Evidence: `createMonacoEditor()` claims a unique generation before awaiting `monacoReady`, validates both generation and container identity before creation, and centrally disposes the prior owner. `disposeMonacoContainer()` invalidates pending work and routes every registered editor through `disposeMonacoEditor()`, which disconnects both observers and disposes the editor once.
- Impact: switching body modes, tabs, or details accumulates live observers and retained disposed editors, multiplying callbacks on every DOM mutation and resize.
- Reproduction: repeatedly alternate text body modes and inspect retained Monaco instances and observers in a heap profile.

### BUG-172 — Low/Medium — WebSocket restoration silently removes every pin

- Status: **Fixed**.

- Evidence: pin state exists only on renderer request objects and is toggled at `src/ui/app.js:775-783`. A restored `traffic-dump` replaces the complete array with server objects at `:182-185`, which have no renderer-only `pinned` property.
- Impact: any transient WebSocket reconnect unpins all exchanges, so a later Clear removes records the user believed were protected.
- Reproduction: pin an exchange, interrupt and restore the UI WebSocket, and inspect its pin after the traffic dump.

### BUG-173 — Medium — Displayed Claude Desktop configuration cannot launch a packaged server

- Status: **Partially fixed**.
- Resolution: Packaged configurations now invoke the stable installed application with a dedicated MCP bridge flag, and the bootstrap resolves the unpacked bridge from each current AppImage mount. In an actual Windows Electron runtime, the bridge establishes its authenticated SSE session but does not consume and relay piped JSON-RPC input; the Node-based integration test does not exercise that runtime.
- Evidence: Settings generates `command: "node"` with relative `args: ["src/index.js", "--mcp-stdio"]` at `src/ui/app.js:8124-8133`. Claude resolves the path from its own working directory, and an installed desktop build cannot assume a system Node executable.
- Impact: copying the application-provided MCP configuration yields module-not-found or node-not-found instead of a connection.
- Reproduction: launch the generated configuration with the Electron executable, wait for its authenticated SSE session, then write a valid initialize request to stdin. The write succeeds, but no JSON-RPC response is returned; the equivalent test launched with `process.execPath` returns one.

### BUG-174 — Medium — Ctrl+Delete clears traffic while editing text

- Status: **Fixed**.

- Evidence: the document-wide shortcut at `src/ui/app.js:8864-8869` does not test input focus or the active panel. It invokes `clearTraffic()`, which sends `clear-traffic` without confirmation at `:7507-7511`.
- Impact: the normal Windows shortcut for deleting the next word destroys the complete server traffic log when used in a Send or settings input.
- Reproduction: focus the Send URL between path words and press Ctrl+Delete.

### BUG-175 — Low — Collapsible and sortable controls remain mouse-only

- Status: **Fixed**.

- Evidence: Send collapsible headers use `role="button"` with click handlers but no `tabindex` or keyboard handler at `src/ui/index.html:246,259,292`; Traffic sortable column headers likewise expose only `onclick` at `:73-77`.
- Impact: keyboard-only users cannot focus, expand/collapse, or sort these controls despite their advertised semantic roles.
- Reproduction: Tab through Send and Traffic and try Enter/Space on the relevant headers.

### BUG-192 — Medium — Header filtering crashes on multi-valued headers

- Status: **Fixed**.
- Resolution: Header filters now look up names case-insensitively across both request and response collections, distinguish absent headers from empty values, safely search scalar and multi-valued headers, and preserve equals signs in filter values.

- Evidence: `matchesFilter()` calls `.toLowerCase()` directly on header values at `src/ui/app.js:383-387`, although fields such as `set-cookie` can be arrays. It also chooses a same-named request header before the response header.
- Impact: a valid multi-cookie response can make `header:` filtering throw, and a request header can mask a matching response value.
- Reproduction: capture multiple Set-Cookie values and filter with `header:set-cookie=value`.

### BUG-193 — Low/Medium — Completing a pending request removes its pin

- Status: **Fixed**.

- Evidence: pin state is renderer-only at `src/ui/app.js:802-809`, but `request-update` replaces the complete object with server data at `:178-188` rather than preserving that local property.
- Impact: pinning a slow exchange before its response arrives provides no protection once completion replaces it.
- Reproduction: pin a pending exchange and let its response complete.

### BUG-374 — Low/Medium — Pinned renderer-only traffic bypasses the row cap

- Evidence: `mergeTrafficDumpPins()` appends every pinned renderer-only row after the complete server dump at `src/ui/app.js:139-152`, without applying the 10,000-row renderer limit. `addRequest()` at `:343-355` removes only one row when oversized, so it cannot restore the cap after a dump has already exceeded it.
- Impact: each add, pin, and reconnect cycle can retain another local Send/import record beyond the cap. Renderer memory and the cost of filtering, sorting, rendering, and exporting can grow indefinitely even though the backend log remains bounded.
- Reproduction: start with a 10,000-row server dump, add and pin one renderer-only Send record, then reconnect; the array has 10,001 rows. Repeat the add/pin/reconnect cycle and observe 10,002, 10,003, and higher rather than a stable maximum.

### BUG-194 — Low/Medium — Plain search omits headers and bodies despite its all-fields contract

- Status: **Fixed**.
- Resolution: Unscoped renderer searches now compare safely and case-insensitively against request and response header names, scalar or array header values, and request and response bodies in addition to the existing request fields. Null and object values are ignored without changing structured-filter parsing or matching.
- Evidence: README promises all-field search at `README.md:180`, while `src/ui/app.js:391-399` searches only URL, method, host, status, path, and source unless a scoped filter is used.
- Impact: a unique token present only in a header or body is invisible to ordinary search.
- Reproduction: capture a token only in a response body; plain search misses it while `body:<token>` finds it.

### BUG-195 — Low — Traffic eviction leaves orphaned selected details

- Status: **Fixed**.
- Resolution: Capacity eviction now detects when the selected exchange was actually removed and resets its detail reference, visibility, hash, and active-descendant state before the normal filter render. Retained selections remain open, and WebSocket frame indexing continues through the existing filter pass.

- Evidence: `addRequest()` evicts the oldest of 10,000 rows with unconditional `requests.shift()` at `src/ui/app.js:260-273`, without clearing `selectedRequestId` or closing the detail panel.
- Impact: the evicted row disappears while stale details remain selected and later actions cannot resolve it in the request array.
- Reproduction: select the oldest record at capacity and capture one more exchange.

### BUG-196 — Low/Medium — UI tabs overwrite unrelated display settings

- Status: **Fixed**.
- Resolution: Each display toggle now sends only its changed field, validates the save response, and synchronizes both cached values and controls from the server's canonical settings. Optimistic filtering remains immediate, while failed saves restore the prior local state and cannot display a success toast.

- Evidence: each settings toggle submits both locally cached values at `src/ui/app.js:7419-7442`; the server persists both supplied fields at `src/api/api-server.js:647-656`.
- Impact: changing one setting in a stale tab reverts a different setting that another tab changed later.
- Reproduction: change Filter Safe Fonts in tab A, then change Hide Tunnel Requests in stale tab B.

### BUG-208 — Medium — Failed mock reorder leaves renderer and proxy priority inconsistent

- Status: **Fixed**.
- Resolution: Mock reorders now validate HTTP and JSON responses, serialize overlapping optimistic writes, and reconcile only the latest rejected order from the server while retaining unsaved drafts. Failures restore a safe prior order and report whether authoritative reload also failed.

- Evidence: `mockDrop()` mutates the local `mockRules` order before posting at `src/ui/app.js:4493-4508`. A rejected reorder is only logged; the old order is neither restored nor reloaded.
- Impact: the UI displays one priority order while proxy matching continues with the server's previous order.
- Reproduction: make `/api/mock-rules/reorder` fail and drag a rule.

### BUG-209 — Medium — Shift-combine leaves hidden partial server mutations

- Status: **Fixed**.
- Resolution: Shift-combine now calls one atomic server operation that validates both distinct source rules before constructing the complete group, persists the final rule tree once, and restores the prior in-memory tree on persistence failure. The renderer consumes the returned authoritative rules on success and reloads them after failure.

- Evidence: `combineRulesAsGroup()` creates a group and moves two rules through three independent requests at `src/ui/app.js:4512-4540`; the API persists each step separately, and the catch path does not reload.
- Impact: failure after one move leaves a persisted partial group while the UI keeps showing the old layout until reload.
- Reproduction: delay the operation and delete the second rule before its move completes.

### BUG-210 — Medium — Failed mock deletion discards unsaved edits first

- Status: **Fixed**.
- Resolution: Saved-rule deletion now validates both the HTTP response and returned error state before clearing its local draft, expansion, and editor data. Brand-new drafts still delete immediately without contacting the server.

- Evidence: `deleteMockRule()` removes the draft and clears editor state at `src/ui/app.js:6244-6252` before awaiting server deletion at `:6262-6266`; failure only shows a toast.
- Impact: when DELETE fails, the server rule remains but the user's unsaved draft is irrecoverably erased.
- Reproduction: edit a saved rule, force DELETE to fail, and click Delete.

### BUG-211 — Medium — Browser tabs overwrite the shared Send workspace

- Status: **Fixed**.
- Resolution: New Send tabs now use UUID identities and a versioned shared workspace updated through locked tab-level merges instead of whole-window snapshots. Cross-window storage events synchronize additions, updates, and deletion tombstones; tombstones prevent stale renderers from resurrecting closed tabs, while legacy arrays still migrate and persisted multipart fields still omit local file objects.

- Evidence: each renderer owns an independent `sendTabs` array, while `persistSendTabs()` replaces the shared localStorage value wholesale at `src/ui/app.js:7047-7074`. Switching, creating, closing, and sending all trigger writes without storage-event synchronization or merging.
- Impact: any stale UI tab can overwrite another tab's complete Send workspace, losing requests on reload.
- Reproduction: create different Send requests in two browser tabs, then switch or send from the stale tab and reload both.

### BUG-212 — Low/Medium — Truncated deep-link responses block every later link

- Status: **Fixed**.
- Resolution: Desktop deep-link requests now settle through one guarded path for normal completion, aborts, response errors, premature closes, request errors, and timeouts. A truncated response rejects the current link so the serialized queue can continue with later links.

- Evidence: `requestOpenInProxiedChrome()` listens only for response data/end at `electron/main.cjs:161-193`, with no response aborted, error, or close rejection. Later links serialize behind that promise at `:196-199`.
- Impact: a partial local API response that closes early leaves the first promise pending forever and permanently queues subsequent desktop links.
- Reproduction: return headers plus partial JSON and destroy the response, then open a second `http-freekit:` link.

### BUG-213 — Low — Deep-link launch failures leave the desktop window hidden

- Status: **Fixed**.
- Resolution: Startup and queued launch links now carry a startup-only failure-recovery flag through parsing and proxied-browser requests. A failure reveals and focuses the main window immediately when ready, or queues that reveal until `ready-to-show`; successful startup links remain hidden and later links retain their existing behavior.

- Evidence: any startup deep-link sets `showOnReady: false` at `electron/main.cjs:425-429`. Parse/request failure paths at `:152-159,196-208` report the error but never call `showMainWindow()`.
- Impact: after dismissing a failed startup link, the main window remains hidden and must be recovered from the tray.
- Reproduction: launch the stopped app with an invalid target or force proxied-Chrome opening to fail.

### BUG-220 — Medium — Traffic context actions can target a different row

- Status: **Fixed**.
- Resolution: Every row-specific context action now passes the request ID captured when the menu opens. Breakpoint, pin, and delete helpers accept that explicit target while retaining selected-row defaults for toolbar and keyboard callers; pinning or deleting another row no longer changes the selected detail panel or its pin icon.

- Evidence: the menu captures `requestId`, but Create Breakpoint, Pin, and Delete call selection-global functions at `src/ui/app.js:8524-8545`; only Resend and Create Mock pass the captured ID.
- Impact: keyboard navigation while the menu is open can make a destructive action operate on another selected exchange.
- Reproduction: right-click row A, press Arrow Down to select B, then choose Delete or Pin.

### BUG-221 — Low/Medium — Escape-to-abort works only inside Monaco

- Status: **Fixed**.
- Resolution: The document shortcut path now gives an active Send request first priority for Escape from every Send-page focus target, while the Monaco command delegates to the same idempotent handler. Once aborting, repeated delivery is consumed without a second abort or toast; with no active Send request, existing context-menu and detail closing behavior is preserved.

- Evidence: Send registers Escape abort on Monaco at `src/ui/app.js:6696-6699`; document-level Escape only closes details at `:8872`, despite the README promising a general abort shortcut.
- Impact: pressing Escape while focus is in the URL, headers, Send button, or response pane leaves the request running.
- Reproduction: start Send with focus on the URL input and press Escape.

### BUG-222 — Medium — Create Mock corrupts repeated response headers

- Status: **Fixed**.
- Resolution: Create Mock now copies repeated response headers into distinct, independent arrays while preserving scalar headers and continuing to omit hop-by-hop, content-encoding, and content-length fields.

- Evidence: mock-from-exchange flattens response header arrays with `join(", ")` at `src/ui/app.js:8580-8600`, including Set-Cookie, although the fixed-response path can preserve arrays.
- Impact: replay turns distinct cookie fields into one comma-combined value with different semantics.
- Reproduction: capture two Set-Cookie fields, create a mock, and trigger it.

### BUG-223 — Low/Medium — URL-encoded body views decode values twice

- Status: **Fixed**.
- Resolution: Both compact and decoded body views now render the names and values already decoded once by `URLSearchParams`, passing them directly through the existing HTML escaping. Literal percent text, plus-to-space conversion, repeated fields, and decoded-view text copying are preserved.

- Evidence: `URLSearchParams` already decodes entries, but both body formatters call `decodeURIComponent()` again at `src/ui/app.js:2319-2330,3145-3162`.
- Impact: displayed/copied form values differ from the request and can throw for percent text after the first decode.
- Reproduction: inspect `token=%252Fadmin`; the UI shows `/admin` instead of `%2Fadmin`.

### BUG-224 — Low — Opaque traffic IDs are not encoded consistently in hashes

- Status: **Fixed**.
- Resolution: Traffic selection and keyboard navigation now percent-encode each raw request ID exactly once when writing a `#/view/` fragment, while WebSocket initialization and hash-route navigation safely decode it before lookup. Malformed encoded fragments still route to Traffic but skip selection without throwing.

- Evidence: imports accept any nonempty string ID; selection writes it directly into the fragment at `src/ui/app.js:705-713,7469-7470`, while routing compares the browser-encoded fragment directly at `:8429-8445`.
- Impact: imported IDs containing spaces or fragment-significant characters cannot restore selection after reload.
- Reproduction: import ID `id with space`, select it, and reload the resulting hash.

### BUG-225 — Low — Global search shortcuts are swallowed outside Traffic

- Status: **Fixed**.
- Resolution: Ctrl+F, Ctrl+K, and non-editable `/` now share one handled shortcut path that switches to Traffic through `switchPanel()` when needed, verifies the panel is visible, focuses its search input, and returns before row navigation. `/` inside inputs, textareas, selects, contenteditable elements, and Monaco remains available for editing.

- Evidence: Ctrl+F, `/`, and Ctrl+K prevent the default and focus the hidden Traffic search input without checking/switching the active panel at `src/ui/app.js:8886-8895`.
- Impact: browser/editor find is suppressed in Send or Settings, but the focused Traffic filter is invisible.
- Reproduction: focus a Send or Settings field and press Ctrl+F.

### BUG-226 — Low — The 100,000-row claim contradicts the 10,000-record cap

- Status: **Fixed**.
- Resolution: README now describes the virtualized traffic table as supporting up to 10,000 retained rows, matching the API and renderer caps without changing product behavior.

- Evidence: `README.md:13` promises a table handling 100,000+ rows, while the API caps traffic at 10,000 and the renderer independently evicts beyond 10,000 (`src/api/api-server.js:51`; `src/ui/app.js:277-278`).
- Impact: the advertised scale is impossible because older records are discarded before the table can contain them.
- Reproduction: capture or import more than 10,000 exchanges and observe eviction.

### BUG-235 — Low/Medium — Reset rules to default restores no defaults

- Evidence: the visible control promises Reset rules to default at `src/ui/index.html:202`, but `clearAllMockRules()` only deletes everything at `src/ui/app.js:4446-4453`. Default creation is startup-only and blocked by the retained `http-freekit-defaults-created` key at `:4627-4645`.
- Impact: Reset permanently leaves an empty rule list across reloads instead of restoring the shipped defaults.
- Reproduction: start with defaults, click Reset, and reload.

### BUG-236 — Low/Medium — Saved port ranges reload as one active port

- Status: **Fixed**.
- Resolution: Settings now loads the canonical saved range from `/api/port-config` independently of the active proxy-port display. Delayed loads cannot overwrite edits or saves started while they were pending, and failed or malformed load/save responses retain explicit error feedback.

- Evidence: `/api/port-config` exposes persisted min/max, but the UI never calls it. `loadConfig()` writes the currently bound `proxyPort` into both fields at `src/ui/app.js:7387-7399`.
- Impact: opening Settings after restart displays a collapsed range, and pressing Save destroys the original range.
- Reproduction: save 19000–19010, restart on 19000, open Settings, and save the displayed 19000–19000.

### BUG-237 — Low — JSON traffic export is unreachable from the UI

- Status: **Fixed**.

- Evidence: README advertises JSON and HAR export, and `exportTraffic()` implements a JSON branch at `src/ui/app.js:7546-7568`; the sole visible action is the HAR button at `src/ui/index.html:103`.
- Impact: desktop/browser users cannot invoke the documented JSON export without using developer tools or the API directly.
- Reproduction: inspect all Traffic controls and context menus; none calls `exportTraffic("json")`.

### BUG-238 — Low — Connection timeout is documented as configurable but is not

- Status: **Fixed**.
- Resolution: README now describes the built-in 15-second upstream connection and 30-second idle-response limits without claiming that users can configure them.

- Evidence: README calls the 30-second connection timeout configurable, while values are constructor defaults at `src/proxy/proxy-server.js:60-61`; no CLI option, API route, persisted setting, or UI control changes them.
- Impact: users cannot tune the documented setting for slow or failure-testing environments.
- Reproduction: search Settings, CLI help, and management routes for timeout configuration.

### BUG-239 — Low/Medium — HAR export reports success before any file response

- Status: **Fixed**.
- Resolution: HAR export now reports only that the authenticated browser download started, while synchronous launch failures produce an error instead of a success message.

- Evidence: the UI launches an authenticated navigation and immediately displays HAR file exported at `src/ui/app.js:7548-7554`, without observing the HTTP response or download result.
- Impact: an API failure/error download is presented as a successfully produced HAR file.
- Reproduction: force `/api/traffic/export.har` to return an error and click Export HAR.

### BUG-240 — Low — Clear Traffic silently no-ops while WebSocket is disconnected

- Status: **Fixed**.
- Resolution: Clear Traffic now uses the authenticated REST endpoint, reports confirmed success or failure, and shares an ID-deduplicated local state update with WebSocket broadcasts so disconnected and connected clients stay consistent without duplicate clearing.

- Evidence: `clearTraffic()` sends only when `ws.readyState === 1` and has no REST fallback or error state at `src/ui/app.js:7540-7544`; the button remains enabled.
- Impact: the user believes traffic was cleared, but reconnect restores every server record without any feedback.
- Reproduction: disconnect the management WebSocket, click Clear, and reconnect.

### BUG-250 — Low/Medium — Malformed HAR primitives poison renderer search

- Status: **Fixed**.
- Resolution: Renderer HAR import now validates and normalizes every entry before atomically adding safe traffic records.

- Evidence: `importHar()` checks only for a truthy entries value and preserves fields such as method without type validation at `src/ui/app.js:7498-7534`; filtering later calls `req.method?.toLowerCase()` at `:374,400`, which still throws when method is a number.
- Impact: a HAR reported as successfully imported can make Traffic search fail on every keystroke until the row is removed or cleared.
- Reproduction: import a complete entry with `request.method: 1`, then type a method/plain filter.

### BUG-251 — Low/Medium — Failed MCP toggles leave the switch inverted

- Status: **Fixed**.
- Resolution: MCP toggles now disable the switch while one request is active, validate the confirmed server state, restore the last authoritative checkbox state on any request or response failure, and refresh status only after a confirmed success.
- Evidence: the checkbox passes its new state directly to `toggleMcp()`; success reloads authoritative status, but the failure branch at `src/ui/app.js:8175-8187` only shows a toast and never restores the control.
- Impact: Settings can show Running with an unchecked switch or Stopped with a checked switch after a rejected request.
- Reproduction: force the MCP toggle POST to fail and click the switch.

### BUG-252 — Low/Medium — The all-platform build always fails on Windows

- Status: **Fixed**.
- Evidence: README calls `npm run build` an all-platform command, while `package.json` always requests win, mac, and linux; electron-builder rejects macOS targets when running on Windows.
- Impact: the documented aggregate release command cannot complete on the project's Windows development platform.
- Reproduction: run `npm run build` on Windows and observe the macOS-target rejection.
- Resolution: the default build now selects only the electron-builder target supported by the current host, reports unsupported hosts clearly, and the README documents its host-specific behavior while retaining the explicit platform commands.

### BUG-256 — Medium — Failed Revert destroys mock draft ownership

- Status: **Fixed**.
- Resolution: Revert now fetches and validates authoritative rules before discarding draft/editor ownership, rejects overlapping or stale completions, and rolls the exact local state back if replacement rendering fails.

- Evidence: `revertMockRules()` clears every draft before asynchronously calling `loadMockRules()` at `src/ui/app.js:6226-6234`. Existing drafts have already mutated local `mockRules`; if GET fails, the loader only logs at `:4604-4625`.
- Impact: unsaved changes remain displayed as if clean, Save/Revert controls disappear, and the recoverable draft is lost while the server retains old data.
- Reproduction: edit a rule into a draft, fail the rules GET, and click Revert.

### BUG-257 — Low/Medium — Existing mock groups cannot receive or release rules in the UI

- Status: **Fixed**.
- Resolution: Mock groups are now drop targets for existing rules, and grouped rules expose an action that moves them back to the top level.

- Evidence: empty groups instruct users to drag or use a move option at `src/ui/app.js:4937`, but group markup has no drop handler and no move/ungroup controls are rendered. `moveRuleToGroup()` and `ungroupRule()` exist only as unreachable definitions at `:6354-6378`.
- Impact: toolbar groups stay empty, and rules in imported/combined groups cannot move to another group or back to top level.
- Reproduction: create a group and try every visible action to move an existing rule into it.

### BUG-258 — Low — Documented pane-focus shortcuts are no-ops

- Status: **Fixed**.
- Resolution: The shortcuts now address the rendered traffic-list and detail containers directly, and both labeled pane regions are programmatically focusable without adding them to the normal Tab order.

- Evidence: the list shortcut searches for nonexistent `#trafficList`/`.traffic-list` at `src/ui/app.js:8965-8970`; the actual container is `#trafficTableWrapper`. The detail shortcut focuses a non-focusable div without tabindex at `:8973-8979`.
- Impact: Ctrl+[ and Ctrl+] do not move keyboard focus as documented.
- Reproduction: press both and inspect `document.activeElement`.

### BUG-259 — Low/Medium — Resume All stops at the first stale breakpoint

- Status: **Fixed**.
- Evidence: `resumeAllBreakpoints()` processes entries sequentially and throws on the first failed response at `src/ui/app.js:8687-8704`; later entries are skipped and banner refresh occurs only on total success.
- Impact: one concurrently removed breakpoint prevents every later request from resuming and leaves the displayed count stale.
- Reproduction: return pending A/B, make A resume return 404, and click Resume All.
- Resolution: Resume All now treats a stale 404 as already cleared, continues after per-breakpoint failures, reports any remaining failures, and refreshes the pending banner after every attempt.

### BUG-260 — Medium — Visible HAR import still discards standard metadata

- Status: **Fixed**.
- Evidence: the UI uses its own mapping at `src/ui/app.js:7498-7534` rather than the corrected server importer. `Object.fromEntries()` collapses repeated headers, while cookies, form params, HTTP versions, MIME metadata, and base64 encoding are omitted.
- Impact: importing through the visible control loses cookies, repeated Set-Cookie, structured forms, protocol information, and binary body encoding.
- Reproduction: import a HAR containing all of those fields through Traffic and inspect/re-export it.
- Resolution: BUG-250's validated renderer importer already preserves duplicate request and response headers, request and response cookies, post-data parameters, both HTTP versions, request and response MIME metadata, and base64 request and response bodies through the visible file-import flow.

### BUG-261 — Medium — Server-log write failures can crash Electron

- Status: **Fixed**.
- Resolution: Electron now waits for the log destination and startup banner before spawning, races startup against later log/pipe failures, and safely disables failed logging after readiness. Child output pipes no longer independently end the shared stream, and every failure/exit path unpipes and closes or destroys the destination while startup failures terminate the child and reach the existing startup dialog.

- Evidence: `startServer()` creates a WriteStream and pipes/writes to it at `electron/main.cjs:90-112` and later process handlers, but never registers a log-stream error handler; asynchronous stream errors escape the startup catch.
- Impact: an unwritable or full log destination can terminate the desktop shell instead of showing a startup failure.
- Reproduction: make the logs path unwritable or simulate ENOSPC and launch Electron.

### BUG-271 — Medium — Monaco load failures stall every text editor forever

- Status: **Fixed**.

- Evidence: `src/ui/index.html:617-623` assumes the AMD loader exists, while `monacoReady` at `src/ui/app.js:9014-9110` has no reject path, loader error callback, timeout, or resolution when require is unavailable. Editors wait on it at `:9132-9134`, after body fallback is hidden.
- Impact: a missing/corrupt packaged asset leaves Send editing and captured text/JSON views blank forever with no fallback or error.
- Reproduction: remove or block Monaco's editor main asset and open Send or a captured JSON body.

### BUG-272 — Low/Medium — Prototype-key WebSocket parent IDs poison rendering

- Status: **Fixed**.
- Evidence: traffic validation omits parentId, while the renderer indexes frames into a plain object and assumes any existing key is an array at `src/ui/app.js:290-300`; inherited keys such as `__proto__` and `constructor` are truthy.
- Impact: one accepted ws-frame record can make initial Traffic rendering and later filtering throw repeatedly until cleared externally.
- Reproduction: import a valid ws-frame with `parentId: "__proto__"` and reload.
- Resolution: the renderer now builds its WebSocket frame index with a null prototype during both live updates and filter/reload rebuilds, so every string parent ID is an own data key. Generic traffic import also rejects WebSocket frames whose parent ID is missing, empty, or not a string.

### BUG-278 — Low/Medium — Canceling the OpenAPI prompt still uploads the spec

- Status: **Fixed**.
- Resolution: Canceling the base-URL prompt now exits before issuing a request, while submitting an intentionally empty value is preserved. Upload success is reported only after a successful HTTP response containing the API's success result; error payloads and status failures stay on the failure path without refreshing the spec list.

- Evidence: the UI does not test `prompt()` for null before POST at `src/ui/app.js:8232-8241`; the API converts null baseUrl to an empty string, which matches any host.
- Impact: clicking Cancel reports the spec loaded and can annotate unrelated traffic.
- Reproduction: select a valid spec file and cancel the base-URL prompt.

### BUG-279 — Low — API-spec deletion failures are invisible

- Status: **Fixed**.
- Resolution: API-spec removal now requires an HTTP-successful, valid `{success:true}` response before reloading the list and showing success. Network, HTTP, malformed-response, and explicit server failures keep the existing list and display the reported error.
- Evidence: `src/ui/app.js:8250-8253` awaits DELETE without try/catch/finally; the fetch wrapper rejects non-2xx/network errors.
- Impact: removal failure produces no toast or reload, leaving the user unaware that the spec remains.
- Reproduction: disconnect the server or force DELETE 500 and click remove.

### BUG-280 — Low — Split-pane resizers are mouse-only

- Status: **Fixed**.
- Resolution: Both split-pane handles are focusable ARIA separators with labelled controls, live orientation/range/value state, spatial Arrow-key movement, Home/End bounds, and clamped mouse resizing. Their axis follows the parent flex direction, including the distinct responsive Traffic and Send stacking breakpoints.
- Evidence: the two resizers are plain divs without separator role, tabindex, or value ARIA at `src/ui/index.html:118,317`; handlers at `src/ui/app.js:8817-8840,9596-9624` listen only for mouse events.
- Impact: keyboard users cannot resize Traffic detail or Send response panes.
- Reproduction: attempt to focus and resize either separator with the keyboard.

### BUG-285 — Medium — Use system settings actually connects directly

- Status: **Fixed**.
- Resolution: Removed the unsupported upstream “Use system settings” option and its misleading DELETE-and-success path. A null upstream configuration is now rendered explicitly as a direct connection, including after startup and failed changes; the separate downstream System Proxy interceptor remains unchanged.
- Evidence: the setting is advertised as using OS proxy configuration, but the UI implements it by deleting `/api/upstream-proxy`; the API sets `upstreamProxy` to null, which the proxy treats as direct. No backend/Electron path reads OS proxy settings.
- Impact: users behind corporate/VPN system proxies are told the mode is active while traffic bypasses it or fails directly.
- Reproduction: configure a counting OS proxy, choose Use system settings, and make a proxied request; upstream configuration is null and the OS proxy receives nothing.

### BUG-288 — Low — Android/JVM Refresh ignores API failures

- Status: **Fixed**.
- Resolution: Android and JVM refreshes now require an HTTP-success response with `success: true` and complete array metadata before replacing the visible lists or showing success. HTTP, server-reported, malformed/incomplete, and network failures preserve the last-known lists and report an error; valid empty lists clear stale entries normally.
- Evidence: `refreshAndroidDevices()` and `refreshJvmProcesses()` at `src/ui/app.js:4143-4165,4285-4307` parse JSON without testing `res.ok` or `data.error`, then always toast refreshed.
- Impact: a 500/network-shape error retains stale device/process data while reporting success.
- Reproduction: force the metadata endpoint to return 500 with `{ "error": "failed" }` and click Refresh.

### BUG-292 — Low — Reopening Existing Terminal loses its CA path

- Status: **Fixed**. Existing Terminal is now instructions-only and always refreshes its metadata when reopened.

- Evidence: collapsing a card clears shared metadata at `src/ui/app.js:3916-3919`, but reopening an already-active Existing Terminal skips activation/metadata fetch at `:3874-3913`. Terminal rendering then falls back to an empty certPath at `:3952-3960`.
- Impact: copied commands contain a blank NODE_EXTRA_CA_CERTS path after the card is reopened.
- Reproduction: expand Existing Terminal, collapse it, reopen it, and inspect the generated command.

### BUG-295 — Low — Add Rule is keyboard-inaccessible

- Status: **Fixed**.
- Resolution: Add Rule is now a native `type="button"` control, preserving the existing click handler and presentation while gaining standard Tab focus and single Enter/Space activation. Its browser-default appearance and typography are normalized, and keyboard focus receives the same visible accent outline used by the rest of the UI.

- Evidence: the sole `addNewMockRule()` trigger is a clickable `div` at `src/ui/index.html:214` with no button role, tabindex, or keyboard handler.
- Impact: keyboard-only users cannot create a mock rule through the visible interface.
- Reproduction: navigate the Mock panel using only Tab and Enter/Space; the Add Rule control never receives focus and cannot be invoked.

### BUG-303 — Low — Breakpoint fields are keyboard-inaccessible

- Status: **Fixed**.
- Resolution: Every request- and response-phase breakpoint field now exposes a named, focusable button interaction while retaining double-click editing. Enter and Space activate the same edit flow once, Space cannot scroll the page, and successful edits restore focus after the detail card rerenders; the visible instructions describe both mouse and keyboard operation.

- Evidence: `src/ui/app.js:1093-1122` renders every editable breakpoint field as a `span` or `pre` with only an `ondblclick` handler and no tabindex, semantic role, or keyboard handler.
- Impact: keyboard-only users can resume a paused request but cannot edit its method, URL, status, headers, or body first.
- Reproduction: pause a request and Tab through the detail card; focus reaches Resume but skips every editable field.

### BUG-304 — Low — Custom context menus cannot be operated by keyboard

- Evidence: `showContextMenu()` at `src/ui/app.js:8581-8604` creates items as plain `div` elements with only `onclick`; it provides no menu roles, focus targets, arrow-key handling, or Enter/Space activation. Traffic exposes the menu only through pointer context-menu handlers.
- Impact: keyboard-only users cannot access actions such as Copy URL, Copy as cURL, or header-copy operations.
- Reproduction: select a Traffic row with the keyboard, press Shift+F10/Menu, and try to focus or activate a menu item; no usable keyboard menu is available.

### BUG-313 — Low/Medium — Traffic navigation keys hijack every panel

- Evidence: the global key handler at `src/ui/app.js:8987-8990` excludes only input-like elements, while the unscoped block at `:9101-9126` prevents Arrow Up/Down, `j`/`k`, Page Up/Down, Home, and End and drives Traffic selection without checking which panel is active.
- Impact: normal keyboard scrolling and navigation is blocked in Settings, Intercept, Mock, and Send, and captured traffic can be selected invisibly behind those panels.
- Reproduction: open a long Settings page, focus its background or a button, and press Page Down, Home, or End; the page does not perform its normal keyboard navigation.

### BUG-314 — Low — Distributions declare MIT but include no license terms

- Evidence: `package.json:45` and `README.md:322-324` declare the MIT license, but the repository has no LICENSE, COPYING, or NOTICE file. `npm pack --dry-run --json` includes no license text, and Electron packaging has none available to bundle.
- Impact: downstream and offline recipients do not receive the permission grant and conditions represented by the package metadata.
- Reproduction: run `git ls-files | rg -i '(^|/)(licen[sc]e|copying|notice)(\.|$)'`; it returns no files.

### BUG-315 — Low/Medium — Native external-link failures become unhandled rejections

- Evidence: `electron/menu.cjs:77` and `electron/updater.cjs:68` call `shell.openExternal()` without awaiting or catching its Promise. The updater's surrounding synchronous try/catch cannot catch an asynchronous rejection, unlike the explicit `.catch()` handling in `electron/main.cjs`.
- Impact: a missing URL handler, OS policy denial, or invalid updater URL gives no user-facing error and raises an unhandled rejection in the Electron main process, which can terminate under the default rejection policy.
- Reproduction: mock `shell.openExternal()` to return `Promise.reject(new Error('no URL handler'))` and invoke Help → Documentation; the main process emits `unhandledRejection`.

### BUG-321 — Medium — Linux custom update feeds open the wrong download source

- Evidence: `initAutoUpdater()` accepts `UPDATE_URL` at `electron/updater.cjs:111-114`, but `getGitHubReleasesUrl()` at `:205-228` later reads `autoUpdater.getFeedURL()`. Installed `electron-updater` returns the literal deprecated-getter message, URL parsing fails, and the code falls back to the hard-coded project GitHub releases page.
- Impact: Linux users notified through a custom release channel are sent to an unrelated build instead of the feed or artifact that produced the notification.
- Reproduction: configure a generic custom `UPDATE_URL` containing a newer Linux release with ordinary text release notes, trigger the update notice, and inspect its link; it targets the hard-coded GitHub latest page.

### BUG-322 — Low — Toast feedback is silent to screen readers

- Evidence: the toast container at `src/ui/index.html:616` has no status/alert role, `aria-live`, or `aria-atomic`. `toast()` at `src/ui/app.js:8922-8933` and updater notifications at `:9678-9704` insert non-focusable messages and remove them shortly afterward without another announcement mechanism.
- Impact: blind users receive no confirmation or error for many saves, activations, copies, and update actions.
- Reproduction: trigger a failed activation or save while using a screen reader; the visible toast appears but no live-region announcement or focus change occurs.

### BUG-323 — Low — Traffic active-descendant is attached to an unfocusable owner

- Evidence: the Traffic grid is the table at `src/ui/index.html:70`, but `updateTrafficActiveDescendant()` at `src/ui/app.js:700-703` writes `aria-activedescendant` to the unfocusable `tbody`. The table, body, and generated rows never receive keyboard or programmatic focus.
- Impact: keyboard selection changes visually, but assistive technology receives no active-row focus or selection announcement.
- Reproduction: navigate Traffic with Arrow keys and inspect `document.activeElement` and the accessibility tree; the active descendant belongs to no focused composite.

### BUG-324 — Low — Packaged UI version text is hard-coded

- Evidence: `src/ui/index.html:19,590` embeds `1.0.0`. Although the preload exposes `getDesktopVersion()` and main returns `app.getVersion()`, the renderer never requests it.
- Impact: after any release bump, Settings and the logo tooltip report an obsolete version while native About and the updater report the actual one.
- Reproduction: package version 1.0.1 and launch it; both renderer locations still display 1.0.0.

### BUG-327 — Low/Medium — Electron launcher paths are destroyed by rerenders

- Evidence: the selected path exists only in the input created by `renderElectronConfig()` at `src/ui/app.js:3934-3951`. `filterInterceptors()` recreates the cards, and `launchElectronApp()` invokes it immediately after capturing the path and again in `finally` at `:3975-3996`; status and search rerenders do the same.
- Impact: every failed launch returns to an empty field and forces the user to browse or type again; a rerender while the native picker is open can make its result write into a detached input and disappear.
- Reproduction: enter a path, force activation to fail, and click Launch; the error toast appears but the path field has been reset.

### BUG-328 — Low — Electron Browse failures are unhandled

- Evidence: `browseElectronApp()` at `src/ui/app.js:3953-3965` directly awaits `window.electronApi.selectFilePath()` without try/catch, unlike the caught and toasted certificate picker path.
- Impact: an IPC or native dialog rejection becomes an unhandled renderer Promise and gives the user no error feedback.
- Reproduction: make `selectFilePath()` reject and click Browse; no toast appears and the renderer reports an unhandled rejection.

### BUG-329 — Medium — Electron Browse cannot launch macOS application bundles

- Evidence: the generic picker at `electron/main.cjs:382-391` returns a selected `.app` bundle path, while `ElectronInterceptor` passes that directory verbatim to `spawn()` at `src/interceptors/electron-interceptor.js:36-44` instead of resolving `Contents/MacOS/<executable>` or using a macOS application launcher.
- Impact: the normal Browse workflow on macOS selects `/Applications/Foo.app` but Launch fails, unless the user manually discovers and types the inner executable path.
- Reproduction: on macOS, Browse to an Electron `.app` bundle and click Launch; spawning the bundle directory fails.

### BUG-335 — Low/Medium — Enter inside interceptor controls activates the parent card

- Evidence: every activable card installs a bubbling keydown handler that calls `card.click()` for Enter without checking the event target at `src/ui/app.js:3818`. Expanded Electron, Android, and JVM cards insert inputs and buttons inside that card at `:3935-3949,4111-4155,4267-4304`; their click-only propagation guards do not stop the earlier keydown from bubbling.
- Impact: pressing Enter in a path field or on Browse, Launch, Refresh, or process/device actions instead invokes the expanded parent, collapses it, and destroys the current configuration before the intended control behavior completes.
- Reproduction: expand Electron, enter an application path, focus the input or Launch button, and press Enter; the card collapses and the path/control is removed.

### BUG-340 — Low/Medium — The delayed update check survives updater shutdown

- Evidence: `initAutoUpdater()` schedules the startup check with an untracked ten-second `setTimeout` at `electron/updater.cjs:191-197`. `stopAutoUpdater()` at `:234-241` clears only the recurring interval, so it cannot cancel that pending callback.
- Impact: quitting shortly after launch can still contact the update feed and emit updater state during asynchronous cleanup, after the updater was stopped and its window may already be gone.
- Reproduction: initialize and immediately stop the updater, then allow the captured startup timer to fire; `checkForUpdates()` still runs once after shutdown.

### BUG-341 — Low/Medium — Rule exports omit every breakpoint rule

- Evidence: renderer counts and empty-state logic include both `mockRules` and `breakpointRules` at `src/ui/app.js:5068-5078`, but `exportMockRules()` refuses when `mockRules` alone is empty and serializes only `{ rules: mockRules }` at `:6483-6491`. The UI labels the action generically as Export Rules at `src/ui/index.html:199`.
- Impact: users cannot back up breakpoint-only configurations, and mixed exports silently omit every breakpoint despite the interface presenting both kinds as rules.
- Reproduction: configure only a breakpoint and click Export Rules; the UI reports “No rules to export” and creates no backup.

### BUG-342 — Low — Interceptor copy controls are unavailable from the keyboard

- Evidence: terminal, Docker, Android, and JVM instructions render “Click to copy” `.config-code-block` divs with only `onclick` handlers at `src/ui/app.js:4011,4015,4044,4088,4265,4302`. They have no focusability, role, or key handler and sit inside a non-selectable interceptor card.
- Impact: keyboard-only users cannot focus, select, or invoke the controls that copy proxy URLs, commands, and setup instructions.
- Reproduction: expand each interceptor and navigate with Tab; focus skips every copy block and no keyboard action calls `copyConfigCode()`.

### BUG-343 — Low — Button-role interceptor cards ignore Space

- Evidence: custom and manual interceptor cards declare `role="button"` and `tabindex="0"`, but their key handlers activate only for Enter at `src/ui/app.js:3808-3826,3854-3862`.
- Impact: the controls violate expected button keyboard behavior; pressing Space scrolls or does nothing instead of expanding or activating the focused card.
- Reproduction: focus a collapsed interceptor card with Tab and press Space; the advertised button does not activate.

### BUG-348 — Medium — Request snippets replay display text instead of original bytes

- Evidence: `_safeBodyString()` converts binary bodies to data URIs, truncates large text, substitutes large-binary placeholders, and decompresses encoded bodies for display at `src/proxy/proxy-server.js:4620-4669`. All eight raw snippet generators use `requestBody` literally while retaining the original request headers at `src/ui/app.js:2014-2110`.
- Impact: copied replays send data-URI text, truncated text, or a placeholder rather than the captured bytes. Compressed request bytes are normally represented as display text while the original `Content-Encoding` header remains, so the destination cannot decode the replay correctly.
- Reproduction: capture bytes `00 ff 41 80 0a` and generate any raw snippet; its body is the literal `data:application/octet-stream;base64,AP9BgAo=` string. A compressed request likewise replays the display representation with its encoding header intact.

### BUG-349 — Medium — Append import partially commits and duplicates on retry

- Evidence: the append branch of `importMockRules()` posts rules sequentially at `src/ui/app.js:6528-6541`. A later rejection throws only after every earlier POST has already mutated runtime and persisted; rules without IDs receive fresh UUIDs from the API on each attempt.
- Impact: one invalid or unsupported item leaves a partial import despite the overall error. Retrying the same file creates another copy of the successful prefix and can compound the rule set on every attempt.
- Reproduction: append `[validRule, {}]`; the valid rule persists before the second request fails. Retry and observe another UUID-backed copy of that rule.

### BUG-056 — Medium — Pause changes only the renderer and does not pause capture

- Evidence: `src/ui/app.js:8218-8232` only flips a local boolean and button state. Incoming `request` events are discarded locally at `:142-146`; no API/proxy pause is sent, so `src/api/api-server.js:1212-1235` continues recording and broadcasting all traffic.
- Impact: while the UI says capture is paused, sensitive/large traffic continues accumulating and remains available to exports/API/MCP. The UI never backfills those discarded events when resuming.
- Reproduction: click Pause, send traffic, verify the table stays unchanged, then query `/api/traffic` and observe the supposedly paused requests.

### BUG-065 — Medium — The OpenAPI picker offers YAML files that it always rejects

- Evidence: `src/ui/app.js:8180-8191` sets the picker to `.json,.yaml,.yml`, then uses only `JSON.parse()` and immediately rejects any parse failure with “Please use JSON format”.
- Impact: valid YAML OpenAPI/Swagger documents exposed as supported choices cannot be loaded.
- Reproduction: select a valid `.yaml` OpenAPI 3 document in Settings.

### BUG-066 — Medium — Uploaded API specifications disappear on restart

- Evidence: API specs live only in `ProxyServer.apiSpecs` and are added/removed through `src/proxy/proxy-server.js:4159-4172`. Unlike mock/TLS settings, `src/index.js:77-105` has no spec restore and the API routes at `src/api/api-server.js:1042-1057` never persist them.
- Impact: every configured OpenAPI/Swagger document must be re-uploaded after each application restart.
- Reproduction: upload a spec, verify it in `/api/specs`, restart, and query the list again.

### BUG-067 — Medium — OpenAPI host/path matching interprets literals as substrings and regex

- Evidence: `src/proxy/proxy-server.js:4175-4189` accepts a host when `host.includes(configuredHost)` and builds a regex by replacing only `{parameters}`; it does not escape regex metacharacters in literal path text.
- Impact: a spec for `api.example.com` can annotate `api.example.com.evil` traffic, and paths containing `.`, `+`, `(`, or similar characters match the wrong requests or fail to match their literal paths.
- Reproduction: configure base URL `https://api.example.com` with path `/v1/a.b`; test a lookalike host or `/v1/aXb`.

### BUG-069 — High — Imported and Send traffic exists only in one browser tab

- Evidence: the HAR picker at `src/ui/app.js:7459-7493` parses entries and calls local `addRequest()` instead of the existing `/api/traffic/import-har` route. Send similarly creates a synthetic object and calls only `addRequest()` at `:7291-7330`; `src/api/api-server.js:1125-1134,1174-1208` sends directly with Node HTTP/HTTPS instead of using the proxy or adding to `trafficLog`.
- Impact: these requests appear in the table but are absent from server HAR export, API search/stats, MCP tools, and every other UI client; they also vanish on reload. Send additionally bypasses configured upstream routing and all matching mock rules.
- Reproduction: import a HAR or complete a Send request, confirm it in the table, then query `/api/traffic` or export HAR. A Send request matching a fixed-response mock reaches the real origin instead.

## Dependency and build-chain vulnerabilities

### BUG-035 — High — Production updater dependency can leak credentials across redirects

- Status: **Fixed**.
- Evidence: `package-lock.json:2150-2152` resolves `builder-util-runtime` 9.5.1, below the fixed 9.7.0. `npm audit --omit=dev --audit-level=high` reports [GHSA-p2f4-r6v6-j797](https://github.com/advisories/GHSA-p2f4-r6v6-j797) through the direct `electron-updater` dependency.
- Impact: cross-origin updater redirects can receive protected token/authorization headers.
- Reproduction: run `npm run audit:prod`; it exits nonzero with two high-severity dependency nodes for this advisory.

### BUG-036 — High — Built AppImages contain a vulnerable updater search path

- Status: **Fixed**.
- Evidence: `package-lock.json:1753-1755` resolves `app-builder-lib` 26.8.1, below the fixed 26.15.0. Full `npm audit` reports [GHSA-7g7r-gx96-252g](https://github.com/advisories/GHSA-7g7r-gx96-252g).
- Impact: the configured AppImage artifact is affected by uncontrolled executable search-path elements, enabling local code execution in the updater context.
- Reproduction: run `npm audit --audit-level=high` and inspect the `app-builder-lib` advisory.

### BUG-037 — High — Build dependencies contain an unbounded brace-expansion DoS

- Evidence: The top-level `brace-expansion` is 5.0.8, but `package-lock.json` still resolves vulnerable nested 1.1.16 and 2.1.2 copies under Electron/build tooling. Full `npm audit` reports [GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg) through those paths.
- Impact: attacker-controlled or accidentally extreme patterns processed by the build dependency graph can exhaust memory.
- Reproduction: run `npm audit --audit-level=high`; the full audit exits nonzero and reports this advisory.

## Existing test evidence

- `npm test`: 32 passed, 0 failed. The passing suite does not exercise the findings above.
- `npm run audit:prod`: fails with 2 high-severity vulnerable dependency nodes.
- `npm audit --audit-level=high`: fails with 24 high-severity dependency nodes representing the three root advisories documented above.
- `node --check` passed for all 35 JavaScript/CJS files under `src`, `electron`, `scripts`, and `test`.
