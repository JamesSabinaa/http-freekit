# IP CONNECT logical-authority gate

Status: implemented for the existing desktop proxy. Controlled desktop tests cover the route binding below. Android packet-engine/device integration, companion transport, authenticated destination policy and protocol freeze remain separate gates. No gateway listener or companion wire route is introduced.

Implementation commit: `91c9b544051028a286d6fb8eb9eca1ec3a5a66bf`, based on `59023d0b7c250d28e0ddef6693999c411aaa1b9d` (the preceding characterization). Earlier raw-IP H2 verification and SNI leaf fixes are `bf3530a9e739d9af31a42bc83af8a734eeaac65a` and `cad06c0cb1300e9b5e7e26201d1962cfc5e6d62c`. The original [gateway spike](companion-gateway-spike.md) is anchored to `e7243638407efacb6b72c53d7fac893414418f03`. No Android contract file changes in this work.

## Implemented route model

| Value | Meaning and use |
| --- | --- |
| Original CONNECT IP and port | Physical socket destination, upstream CONNECT/SOCKS destination and existing noProxy selection |
| Validated DNS SNI and original port | Application URL, H1 Host, H2 `:authority`, upstream TLS SNI, standard certificate name verification and client-certificate selection |

[connect-route.js](../src/proxy/connect-route.js) implements an immutable internal binding, authority/target validation, same-origin selection and physical/logical pool identity. The proxy stores trusted context in a per-request/stream WeakMap. HTTP headers and rule data cannot create a binding. Ordinary DNS CONNECT, no-SNI and IP-literal SNI retain the existing CONNECT-authority fallback.

H1 accepts an unambiguous Host for the logical name and original port, plus origin-form targets or `OPTIONS *`. H2 accepts the bound HTTPS authority and rejects conflicting regular Host. Authority conflicts return 421; malformed targets/ambiguous Host return 400, or Node rejects malformed H2 fields before dispatch. Rejection precedes HTTP matching/capture and egress. A request rejected by the parser itself can retain the existing non-body raw-tunnel diagnostic metadata.

SNI never becomes a DNS dial target. Same-origin path/method/header transformations, forwards and breakpoints preserve the IP. An explicit desktop rule or breakpoint changing origin uses the existing route for that new origin. The next request on the intercepted CONNECT retains its original binding. This is desktop rule behavior, not permission for a future paired device to bypass destination policy.

## Source boundaries

Locations refer to the implementation commit in [proxy-server.js](../src/proxy/proxy-server.js), rather than the earlier characterization line numbers:

| Boundary | Implementation |
| --- | --- |
| Ingress | `_handleTlsConnection` (5942), `_handleHttp2Connection` (6932), including H1 fallback, and `_handleHttpUpgrade` (4368) validate identity before processing |
| Streaming | `_streamH1Exchange` (1335) and `_streamH2Exchange` (2039) retrieve trusted context |
| H1 egress | `_buildH1UpstreamRequestOptions` (722) supplies physical hostname separately from logical TLS options; `_requestMockForward` (768) and WebSocket upgrades reuse it |
| Buffered egress | Transforms, request/response breakpoints, mock forwards and H1 fallback carry the same context into shared egress helpers |
| H2 routing/pools | `_getH2Session` (8699), `_getH2SessionForRoute` (8707) and `_connectH2Tls` (8847) retain physical IP, logical identity, port, TLS/H2 profiles and upstream generation in connection/cache identity |
| H1 pools/recovery | HTTPS agents retain physical host plus logical SNI in existing pool keys; `_enableCertificateDiscovery` (9813) keys recovery by both identities |

Mock forwards keep their existing H1 upstream behavior; the H2-origin forward fixture permits H1. Body-buffering limits, non-replayable request handling, cancellations and optional TLS verification exceptions remain governed by normal proxy settings.

## Standard TLS verification through upstream agents

New no-SNI upstream tests exposed another existing verification-host bug: HTTP/SOCKS tunnel dependencies remove `host` when wrapping a connected socket. Without DNS SNI, Node then checked `localhost` instead of the original IP. A trusted localhost certificate could pass for an IP route, while a correct IP SAN failed.

The certificate-discovery agent wrapper now calls standard `tls.checkServerIdentity` against its selected origin identity at connection creation, after pool selection, preserving CA-chain verification. Distinct request-level callbacks cause Node 26 to isolate requests into separate pools; the pool-reuse regression caught that implementation error before commit. The final implementation retains reuse and adds no IP SNI. HTTPS upstream outer-proxy and inner-origin TLS retain independent identities.

## Controlled acceptance evidence

All final fixtures bind explicit loopback addresses on ephemeral ports. Pool tests use separate listeners on `127.0.0.1` and `127.0.0.2` with the same port, and fixture guards reject non-loopback binds. Certificates are generated in temporary directories and removed. New TLS clients keep verification enabled and trust only the fixture CA. Scoped DNS hooks reject `.example.invalid` dial attempts without an external DNS query.

| Test source | Coverage |
| --- | --- |
| [connect-route.test.js](../test/proxy/companion/connect-route.test.js) | Immutable binding, origin selection, authority/port/target rejection and distinct pool keys |
| [ip-connect-authority-gate.test.js](../test/proxy/companion/ip-connect-authority-gate.test.js) | Former characterization converted to acceptance: DNS-only certificate, logical H1/H2 identity, hostile authorities before egress, no-SNI fallback |
| [ip-connect-route-paths.test.js](../test/proxy/companion/ip-connect-route-paths.test.js) | IPv4/IPv6 H1, H1 on H2 ingress, H2/H1 fallback; wrong certificate/untrusted CA; malformed Host/targets; secure WS; same-origin transforms/forwards/both breakpoints; cross-origin rules; normal DNS CONNECT; physical/logical pool separation and reuse |
| [ip-connect-upstream-routes.test.js](../test/proxy/companion/ip-connect-upstream-routes.test.js) | HTTP/HTTPS/SOCKS5h logical TLS/HTTP identity with streamed/buffered paths; physical-IP bypass policy; trusted-IP/no-SNI and wrong-localhost rejection; rotated retry; H2 CANCEL fallback/no POST replay; live missing-intermediate recovery before HTTP; keep-alive request isolation; native fingerprint mode |
| [h2-ip-certificate-validation.test.js](../test/proxy/http2/h2-ip-certificate-validation.test.js) | Original raw-IP H2 verification fix, IPv4/IPv6 IP SANs, wrong-name and untrusted-CA rejection |

Older informational/streaming fixtures combined DNS SNI `localhost` with IP Host/`:authority`. They now explicitly omit SNI, preserving their intended IP-fallback coverage. Dedicated binding tests cover matching DNS identities and authority rejection. The original SNI routing test now uses a trusted DNS certificate and the original non-default port in Host.

## Validation and remaining gates

On Windows Server 2025 x64 with standalone Node 26.7.0, all proxy and Android interceptor tests plus intermediate-certificate and test-layout checks passed: 94 files, 576 tests, zero failures/cancellations/skips, in 148.3 seconds. The six configured-upstream native-H2 assertions also passed in a focused run. The full log is `dist/route-binding-full.log`; validation metadata is `dist/companion-route-binding-validation.json`.

```powershell
$files = @(Get-ChildItem test/proxy,test/interceptors/android -Recurse -Filter '*.test.js' -File |
  Sort-Object FullName | ForEach-Object { $_.FullName })
node --test --test-concurrency=1 @files test/certificates/intermediate-certificates.test.js test/meta/test-layout.test.js
```

JavaScript syntax, local documentation links and `git diff --check` also pass. Logs/metadata are ignored deliverables directly in `dist/`. Android interceptor regressions use controlled ADB/process fixtures. No phone, emulator, physical USB, WAN, production gateway or packet-engine-to-desktop integration is claimed.

The logical route binding is not device attribution or destination authorization. A future gateway still needs trusted device/policy context at every actual egress, including rules and secondary webhook targets, revocation/cancellation, bounded transport queues and enforceable policy for upstream remote DNS. Pairing certificate export/renewal, transport and protocol freeze remain owned by the canonical Android plan and package A. The [gateway spike](companion-gateway-spike.md) records those separate blockers.
