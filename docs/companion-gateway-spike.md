# Android companion proxy and gateway spike

Status: package D design/spike only. No companion gateway, enrollment registry, device authorization, production wire integration, or new production listener is implemented by this checkpoint. Protocol v1 is not frozen.

Source baseline: desktop `e7243638407efacb6b72c53d7fac893414418f03`. Canonical Android protocol/architecture baseline: `2cc62a593a23c9e8d0f30c830cb7874be49eee1e` in [http-freekit-android](https://github.com/JamesSabinaa/http-freekit-android/tree/2cc62a593a23c9e8d0f30c830cb7874be49eee1e/docs). Source line numbers below refer to that desktop baseline; the tested checkpoint is the Git commit containing this document and its tests.

## Controlled byte compatibility

[companion-byte-stream.test.js](../test/proxy/companion/companion-byte-stream.test.js) sends the proposed explicit-proxy bytes directly to the existing loopback proxy, without a gateway or WebSocket carrier. All fixture servers bind to `127.0.0.1` on ephemeral ports. Temporary test CA material is removed during cleanup. TLS tests trust only that fixture CA and keep hostname/certificate verification enabled.

| Case | Evidence | Limit |
| --- | --- | --- |
| Absolute-form HTTP | Fragmented request line/headers and binary bodies; origin receives the first upload bytes before the rest are written; client receives the first response bytes before the origin is allowed to end | No rules/breakpoints enabled; no carrier backpressure or Android packet proof |
| CONNECT then TLS then HTTP | CONNECT response precedes the TLS exchange; client validates the fixture CA/IP identity; incremental binary upload/download reaches the origin and desktop capture | IP identity throughout; does not prove a DNS site's HTTPS identity |
| WebSocket | Upgrade and a masked binary frame arrive in the same write; origin receives it as binary and the unmasked echo is byte-identical | Plain WebSocket; secure WebSocket behavior is covered by existing regression tests |
| Write-side EOF | Passthrough CONNECT origin receives EOF, then replies while the client keeps reading | Passthrough TCP only; does not establish TLS or carrier half-close semantics |
| IP CONNECT / DNS TLS identity mismatch | With CONNECT `127.0.0.1:443` and SNI `original-app.example.invalid`, the verified client rejects the baseline certificate with `ERR_TLS_CERT_ALTNAME_INVALID` | This is a protocol-freeze blocker, not successful DNS-site interception |

Validation environment: Windows Server 2025 x64, standalone Node `26.7.0`, dependencies installed from the unchanged `package-lock.json` using `npm ci --ignore-scripts --no-audit --no-fund`. The initial PATH Node `25.2.1` produced dev-tool engine warnings during install; all reported tests used the desktop project's standalone Node 26.7.0 binary.

Commands and results:

```powershell
node --test --test-concurrency=1 test/proxy/companion/companion-byte-stream.test.js
```

Five cases passed. Before adding the identity-mismatch case, a combined run of every `test/interceptors/android/*.test.js` plus companion byte tests, core streaming/absolute-Host/forward-header/loopback-bind/downstream-cancellation tests, secure-WebSocket/backpressure tests, upstream-tunnel/SOCKS-DNS tests, and `test/meta/test-layout.test.js` passed 159 tests, with zero failures/skips. The combined run log is in ignored `dist/companion-spike-tests.log`. Android interceptor tests use mocked ADB/process fixtures; no phone, emulator, physical USB capture, WAN, or Android Keystore check ran.

## Desktop integration points

| Source location at the baseline | Current behavior | Required companion boundary |
| --- | --- | --- |
| [ProxyServer constructor](../src/proxy/proxy-server.js#L399), [management listener](../src/api/api-server.js#L3835), [startup bind selection](../src/index.js#L129) | Proxy defaults to loopback; management always binds loopback; ordinary proxy can be explicitly configured otherwise | Preserve these defaults. Add a separately authorized gateway listener, never mobile access to management |
| [_handleHttpRequest](../src/proxy/proxy-server.js#L5012), [_handleConnect](../src/proxy/proxy-server.js#L5769), [_handleHttpUpgrade](../src/proxy/proxy-server.js#L4381) | Independent HTTP, CONNECT and upgrade ingress; no authenticated mobile context | Attach verified device/session policy through a trusted internal interface before parsing bytes |
| [_handleTlsConnection](../src/proxy/proxy-server.js#L5973), [_handleHttp2Connection](../src/proxy/proxy-server.js#L6950) | CONNECT creates nested TLS/HTTP or H2 sessions | Carry the immutable context through every wrapper, request, H2 stream and cancellation path |
| [_canStreamWithoutRequestBuffering](../src/proxy/proxy-server.js#L1300) | Body-dependent rules, transforms, mock actions and breakpoints can require bounded buffering | Transport must remain streaming. Preview behavior for desktop rules must be explicit; do not advertise universal streaming under arbitrary rules |
| [_buildH1UpstreamRequestOptions](../src/proxy/proxy-server.js#L715), [_requestWithExactMethod](../src/proxy/proxy-server.js#L513) | Direct H1 uses HTTP(S) client resolution/dialing; upstream proxy options can replace the physical host | A `_connectTcp` hook alone misses these routes; validate the actual destination selected by the dialer |
| [_connectTcp](../src/proxy/proxy-server.js#L9987), [_connectViaSocks](../src/proxy/proxy-server.js#L9932), [_connectH2Tls](../src/proxy/proxy-server.js#L8838) | Direct TCP, HTTP CONNECT and SOCKS routes; SOCKS4/5 use local DNS while SOCKS4a/5h can delegate DNS | Resolve/validate addresses used for companion egress, pin the checked result to the actual connect, and retain hostname/SNI separately |
| [_applyMockPreSteps](../src/proxy/proxy-server.js#L3626), [_requestMockForward](../src/proxy/proxy-server.js#L758), [_serveWebhookMock](../src/proxy/proxy-server.js#L4032), [_streamMockFile](../src/proxy/proxy-server.js#L2702) | Rules can rewrite/forward network targets, initiate webhook requests, or serve configured local files | Apply policy after transformations and to secondary egress. Do not automatically grant paired phones access to privileged local-only rules |
| [_getH2SessionForRoute](../src/proxy/proxy-server.js#L8698), [_getFingerprintAgent](../src/proxy/proxy-server.js#L9862) | Connection/session pools are keyed by route and TLS profile, with no device/policy key | Separate companion policy contexts so an authorized pooled connection cannot be reused across incompatible grants |
| [_emitRequest](../src/proxy/proxy-server.js#L10986), [_emitRequestUpdate](../src/proxy/proxy-server.js#L11092), [_detectSource](../src/proxy/proxy-server.js#L11180) | Capture callback is an output hook; `source` is guessed from User-Agent | Add authenticated device identity as separate nonsecret capture metadata; never treat User-Agent or an upstream-bound header as identity |
| [ADB reverse ownership](../src/interceptors/android-adb-interceptor.js#L929), [activation transaction](../src/interceptors/android-adb-interceptor.js#L1529) | Existing HTTP Toolkit package/intent, mapping readback, preservation, journaling, rollback and cleanup | Add an independent FreeKit activation path after freeze; retain the existing path and generalize mapping ownership to the gateway port deliberately |

## Gate decisions still required

A raw TCP connection from a gateway into the ordinary loopback proxy cannot, by itself, supply authenticated device metadata or a per-device destination policy. Prefer a trusted in-process attachment of an ordered duplex stream plus an immutable context containing device ID, policy generation, cancellation signal and a separate nonsecret capture-session ID. Retain that context in private socket/request/session state, not a request header or a bearer session ID in traffic records. A dedicated companion proxy instance can help isolate rules/pools, but still needs policy at every actual egress path. No such API is implemented here.

For WAN, deny management listeners permanently, and deny loopback, private/link-local/metadata and IPv6 local targets by default. Validate addresses immediately before the actual connect; checking DNS then allowing a library to resolve again is insufficient. Recheck retries, rewrites, forwards, WebSockets, H2 and secondary webhook targets. Remote-DNS upstream routes cannot prove the final destination from local DNS inspection; keep companion WAN direct-only until an enforceable upstream policy exists. The ordinary local proxy's existing upstream behavior need not change.

The baseline chooses the interception leaf from CONNECT authority before processing ClientHello. Choosing an IP authority therefore loses a site's DNS certificate identity. A narrow compatibility fix may choose the leaf from a bounded, validated SNI name while retaining the original CONNECT egress. That alone will not resolve every logical-authority issue: H1 currently derives its forwarded Host/upstream TLS options from the CONNECT URL, and H2 `_getConnectH2Authority` rejects a `:authority` different from CONNECT. Package A and D must agree how original IP routing, application Host/`:authority`, downstream certificate identity and upstream TLS identity relate before production integration. SNI must never silently retarget the connection or bypass destination policy.

The carrier still needs bounded per-device/global stream and byte queues, `ws.send`/socket backpressure in both directions, no automatic replay, authenticated control/session association, immediate revocation/cancellation, and a tested half-close mapping. Enrollment approval/races, key renewal, persistence, error schemas, origin policy and capability negotiation remain draft. No production contract is changed by this spike, and package D is not complete.
