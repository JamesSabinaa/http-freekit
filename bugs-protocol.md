# Protocol interception bug audit

This file records bugs found while auditing the TLS impersonation, HTTP/2 forwarding,
upstream-proxy, and pending-traffic work on `main` at `35a0158`. This is an initial
scoped pass, not a claim that the protocol work is exhaustively clean.

No implementation fixes were made as part of this audit. Every finding below is open.

## Current status

| ID | Severity | Area | Finding | Status |
| --- | --- | --- | --- | --- |
| PROTO-001 | Medium | TLS impersonation | Full mode remains distinguishable from Chrome at the raw ClientHello layer | Open |
| PROTO-002 | Medium | TLS/ALPN | Full mode removes the client's HTTP/1.1 ALPN fallback on H2 connections | Open |
| PROTO-003 | Medium | HTTP/2 fingerprinting | Every forwarded H2 request uses Chrome pseudo-header order | Open |
| PROTO-004 | Medium | H2 connection lifecycle | H2 probes ignore the configured upstream connect timeout | Open |
| PROTO-005 | Low/Medium | Pending traffic | Streaming uploads remain blank while a long-lived response is open | Open |
| PROTO-006 | Low/Medium | Traffic metadata | Pre-response H2 failures through an upstream proxy are recorded as direct | Open |

## Findings

### PROTO-001 — Medium — Full mode remains distinguishable from Chrome at the raw ClientHello layer

- Status: **Open**.
- Evidence: passthrough mode is described as mirroring cipher order, extension order,
  GREASE, groups, signature algorithms, ALPN, and ALPS
  (`src/proxy/proxy-server.js:8557-8588`). The existing regression test asserts JA4
  equality only (`test/proxy/tls/tls-fingerprint-mirroring.test.js:65-146`).
- Reproduction: run the bundled-runtime diagnostic:
  `node_modules/node/bin/node.exe scripts/diagnose-chrome-forwarding.js`.
  With Chrome 151, Node 26.7.0, and OpenSSL 3.5.7, the direct ClientHello had
  `ec_point_formats: [0]` and a GREASE cipher (`64250`). The intercepted upstream
  ClientHello had `ec_point_formats: [0,1,2]` and no GREASE cipher. Direct JA3 was
  `6905d15deed2bf198a261b29755e4d2c`; intercepted JA3 was
  `7615caea27e082d46019d3024a2af427`. JA4 remained equal. The proxy also logged that
  extension `0xb` is controlled by OpenSSL and cannot be reproduced.
- Impact: a server inspecting raw ClientHello fields or JA3-class signals can still
  distinguish intercepted Chrome traffic even though the setting is labelled
  `Client impersonation (full)`. This can contribute to bot/WAF decisions that do not
  rely on JA4 alone.
- Expected: full mode should reproduce the relevant raw browser signals, or clearly
  expose the remaining runtime limitation instead of presenting the mode as complete.

### PROTO-002 — Medium — Full mode removes the client's HTTP/1.1 ALPN fallback on H2 connections

- Status: **Open**.
- Evidence: `_getUpstreamTlsOptions()` intersects the captured ALPN list with the
  single protocol requested by the selected upstream transport
  (`src/proxy/proxy-server.js:8574-8580`). Both direct and proxied H2 session creation
  then force `ALPNProtocols: ['h2']` (`:7521`, `:7720`).
- Reproduction: connect an H2 client with `ALPNProtocols: ['h2', 'http/1.1']` directly
  to a `trackClientHellos()` origin, then send the same client through FreeKit in full
  mode. The origin observed:

  ```json
  {"direct":["h2","http/1.1"],"proxied":["h2"]}
  ```

- Impact: the origin sees a different ClientHello and a different fallback capability
  from the intercepted client. This is another server-visible fingerprint mismatch,
  even in cases where JA4 remains equal.
- Expected: preserve the client's ordered ALPN offer when it is compatible with the
  selected forwarding path, and handle a non-H2 negotiation as an explicit fallback.

### PROTO-003 — Medium — Every forwarded H2 request uses Chrome pseudo-header order

- Status: **Open**.
- Evidence: all H2 forwarding helpers construct pseudo-headers in the fixed order
  `:method`, `:authority`, `:scheme`, `:path`
  (`src/proxy/proxy-server.js:1560-1564,2299-2303,7814-7818`). The inbound stream
  handler discards every pseudo-header before building `requestHeaders`
  (`:6077-6080`), so the original order is unavailable to the forwarding code. The
  current regression asserts the Chrome order rather than parity with the client
  (`test/proxy/http2/h2-upstream-proxy.test.js:172-176`).
- Reproduction: send an H2 request directly with pseudo-headers ordered
  `:method`, `:path`, `:scheme`, `:authority`, then send the same request through
  FreeKit. A local H2 origin observed:

  ```json
  {
    "direct":[":method",":path",":scheme",":authority"],
    "proxied":[":method",":authority",":scheme",":path"]
  }
  ```

- Impact: Chrome currently benefits from the hard-coded order, but Firefox, custom H2
  clients, and future Chrome versions can be fingerprinted incorrectly. The behavior
  conflicts with client impersonation because it applies a Chrome trait globally.
- Expected: capture and forward each inbound client's pseudo-header order, with a
  documented fallback only when the order cannot be observed.

### PROTO-004 — Medium — H2 probes ignore the configured upstream connect timeout

- Status: **Open**.
- Evidence: the proxy stores `upstreamConnectTimeoutMs` as a configurable value
  (`src/proxy/proxy-server.js:399`), and TCP/H1 paths use it (`:584-590,8823-8834`).
  Direct and proxied H2 session probes instead hard-code 5000 ms
  (`:7587`, `:7705`).
- Reproduction: construct a proxy with `upstreamConnectTimeoutMs: 123`, configure an
  upstream proxy, hold `_connectTcp()` pending, and record scheduled timers while
  calling `_getH2Session()`. The result was:

  ```json
  {"configuredMs":123,"scheduledDelays":[5000]}
  ```

- Impact: slow upstream proxies can force an unexpected H2-to-H1 fallback after five
  seconds, followed by a 60-second H2 negative cache. Conversely, a deliberately short
  timeout or disabled timeout is not honored. This can silently remove the H2
  fingerprint that was added for Cloudflare compatibility.
- Expected: H2 connection establishment should use the same validated connect-timeout
  setting as TCP and H1, including its disabled semantics.

### PROTO-005 — Low/Medium — Streaming uploads remain blank while a long-lived response is open

- Status: **Open**.
- Evidence: streaming paths now emit their pending snapshot before connecting upstream
  (`src/proxy/proxy-server.js:1784-1787,2401-2404`). Request chunks are captured later
  (`:1203-1206,1855-1858`), but request completion does not publish a merge update
  (`:1747-1763,2107-2121`). The next UI-visible update is finalization, which may never
  occur for a long-lived response.
- Reproduction: send a 12-byte POST through the plain streaming path to an origin that
  consumes the complete upload, starts an event-stream response, and keeps it open.
  After the origin had received the body, FreeKit had emitted only this pending state:

  ```json
  {
    "receivedBody":"uploaded-now",
    "pendingRequestBody":"",
    "pendingRequestBodySize":0,
    "eventCountWhileOpen":1
  }
  ```

- Impact: pending rows now appear reliably, but request-body inspection is stale for
  SSE, gRPC, hanging requests, and other long responses. A fully uploaded body can look
  as if the client sent nothing until the response eventually closes.
- Expected: publish an in-place pending update when the request upload completes,
  without waiting for response completion or creating another traffic row.

### PROTO-006 — Low/Medium — Pre-response H2 failures through an upstream proxy are recorded as direct

- Status: **Open**.
- Evidence: a successful H2 response obtains `usedUpstreamProxy` from the session
  (`src/proxy/proxy-server.js:2356`), but `startH2()` does not copy the session's route
  or generation onto the request. Pre-response failure finalization therefore defaults
  `usedUpstreamProxy` to false and cannot read an upstream generation
  (`:1963-1970`).
- Reproduction: route an intercepted H2 POST through a local HTTP CONNECT proxy to an
  H2 origin that cancels the stream before response headers. The CONNECT proxy was
  used once, but the final traffic record reported:

  ```json
  {
    "connects":1,
    "statusCode":502,
    "usedUpstreamProxy":false,
    "errorCode":"ECONNRESET"
  }
  ```

- Impact: failed requests can misleadingly look as though they bypassed the configured
  proxy, and the missing generation weakens diagnosis of proxy rotation and transient
  egress failures. Successful H2 requests are labelled correctly.
- Expected: propagate the H2 session's route and proxy generation into every terminal
  record, including failures before response headers.

## Audit notes

- The focused probes used the bundled Node 26.7.0 runtime and loopback origins/proxies.
- The Chrome fingerprint diagnostic ran at below-normal priority and cleaned its
  temporary profiles and certificates.
- No production source, tests, settings, installed application, or external service was
  modified during this audit.
- A later pass should inspect H2 frame-order/priority behavior, TLS resumption, protocol
  fallback after proxy rotation, and extended CONNECT/WebSocket support.
