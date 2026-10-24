# IP CONNECT logical-authority gate

Status: open. The downstream SNI certificate fix is implemented, and the raw-IP H2 verification-host bug is fixed in this checkpoint. Full logical HTTP Host/upstream TLS/H2 authority support over an original-IP CONNECT is not implemented. No companion wire contract or gateway route is introduced.

The source baseline for the new probes is `cad06c0cb1300e9b5e7e26201d1962cfc5e6d62c`; earlier [gateway spike evidence](companion-gateway-spike.md) is anchored to `e7243638407efacb6b72c53d7fac893414418f03`. The canonical Android draft baseline used for coordination is `2cc62a593a23c9e8d0f30c830cb7874be49eee1e`. Package A owns subsequent draft changes and freeze.

## Controlled scenarios

[ip-connect-authority-gate.test.js](../test/proxy/companion/ip-connect-authority-gate.test.js) deliberately characterizes the remaining failures. Its `open gate` assertions are expected failure scenarios, not acceptance tests claiming the feature works. All origins/proxy listeners bind to loopback on ephemeral ports. The DNS hostname `logical-app.example.invalid` is blocked by a scoped test DNS hook if used as a dial target; no external DNS request is needed. The downstream and upstream TLS clients keep verification enabled and trust only the fixture CA. Dual-SAN fixtures are checked with `X509Certificate.checkHost` and `checkIP`, rather than assuming the generated fixture is correct.

| Scenario | Observed result | Required behavior before real-app integration |
| --- | --- | --- |
| IP CONNECT, DNS SNI, DNS-only trusted origin certificate, H1 Host matching SNI | Downstream certificate validates; original IP is dialed; upstream rejects with `ERR_TLS_CERT_ALTNAME_INVALID` and returns 502 | Dial the original IP while validating the origin certificate against the logical DNS name and sending that name as SNI |
| IP CONNECT, DNS SNI, origin certificate valid for both the IP and logical name, H1 logical Host | Request succeeds, but origin receives the CONNECT IP as Host and no logical upstream SNI | Preserve the validated logical Host/port and upstream SNI without DNS retargeting |
| Same H1 setup, conflicting Host | Request is also coerced to the IP and forwarded | A new IP/SNI binding must reject a conflicting logical authority before matching or egress; do not replace the existing normal-proxy coercion behavior globally |
| IP CONNECT, DNS SNI, H2 `:authority` matching the logical name | Rejected with 421 before matching/capture/egress | Accept the bound logical name/port, retaining the original-IP route |
| Different H2 hostname, port, or non-HTTPS scheme | Rejected with 421 before matching/capture/egress | Keep this rejection after accepting the one bound logical authority |
| No SNI, IP Host/`:authority`, trusted IP SAN certificate | H1 and H2 succeed after the narrow H2 verification-host fix | Preserve the existing IP identity fallback |

## Narrow H2 verification-host fix

The raw H2 TLS helper previously called `tls.connect` with a connected socket and no verification `host` for IP destinations. Node defaulted name verification to `localhost`. A trusted certificate containing the correct IP SAN therefore failed, even though `_connectTcp` had dialed the correct address. An H2-only origin then surfaced a secondary ALPN error after H1 fallback, hiding the original identity error.

`_connectH2Tls` now supplies the original normalized hostname explicitly to TLS while reusing the already connected socket. It does not add DNS SNI for an IP, change the dial target, or disable verification. This narrow fix is committed as `bf3530a9e739d9af31a42bc83af8a734eeaac65a`. [h2-ip-certificate-validation.test.js](../test/proxy/http2/h2-ip-certificate-validation.test.js) covers trusted IPv4/IPv6 IP SANs, unchanged dial arguments, successful H2 requests, rejection of a trusted DNS-only certificate lacking that IP SAN, and rejection of an untrusted CA.

## Why a logical-authority patch needs an explicit route model

The proxy currently uses a URL hostname for both application identity and network routing. Merely changing the accepted H2 authority or the URL in the H1 ingress would cause the HTTP client/H2 dialer to resolve the logical hostname. Changing only the common streaming helpers would leave rule/breakpoint, upgrade, and fallback paths with different identities or routes.

The relevant code is in [proxy-server.js](../src/proxy/proxy-server.js): `_handleTlsConnection` (baseline line 5975), `_handleHttp2Connection` (6952), `_streamH1Exchange` (1353), `_streamH2Exchange` (2055), `_buildH1UpstreamRequestOptions` (716), `_requestMockForward` (759), `_handleHttpUpgrade` (4382), `_getH2SessionForRoute` (8700), and `_connectH2Tls` (8840). The H2 virtual server also owns an H1 fallback path, separate from the ordinary H1 virtual server. Rules can intentionally replace a URL, and each later request on the same CONNECT must retain its original binding.

The proposed internal model is an immutable per-CONNECT binding:

```text
physical destination = original CONNECT IP + port
logical origin       = validated DNS SNI + original port
fallback origin      = original CONNECT authority when DNS SNI is absent
```

This is an internal design proposal, not a new client-supplied forwarding field. The original IP remains subject to the eventual companion destination policy. SNI identifies the logical TLS origin; it is not authenticated device identity or permission to dial another destination.

Implementation should cover these boundaries together:

1. Build the binding after TLS handshake completion. Enable the new logical-name behavior only for an IP CONNECT with valid DNS SNI. Preserve ordinary DNS CONNECT and no-SNI/IP behavior unless deliberately changed with separate evidence.
2. Validate H1 origin-form/asterisk request targets and an unambiguous Host, or H2 HTTPS `:authority`, against the bound logical origin and port before matching/capture/egress. Reject conflicting or malformed authorities; accepting every Host would reintroduce retargeting through another input.
3. Represent the application URL/Host/capture identity separately from the physical dial target. Feed the logical hostname into upstream SNI, certificate verification, client-certificate selection and HTTP authority; feed only the physical IP into the actual connect.
4. Carry the binding explicitly through H1/H2 streaming, bounded body-dependent rules, request/response breakpoints, mock forwards, secure WebSocket upgrades, H2's H1 fallback, TLS certificate recovery and retries. Avoid a global DNS override or mutable proxy-wide hostname map.
5. Preserve the binding for same-origin path/method/header transformations. An explicit desktop rule that changes origin creates a new route for that request, which must be checked at final egress; it must not mutate the next request on the CONNECT session. Define whether a same-origin `forward` action keeps the binding rather than relying on accidental URL-copy behavior.
6. Include physical address, logical identity, port, TLS profile and upstream proxy generation in session/pool keys. Otherwise two original IPs sharing one logical name can reuse the wrong connection, or different logical names on one IP can reuse an incompatible TLS session.
7. Verify configured HTTP/SOCKS upstream paths preserve the original IP in their tunnel destination while retaining logical end-to-end TLS/HTTP identity. Do not silently bypass existing upstream configuration. Remote-DNS and companion destination restrictions remain separate WAN gates.

The implementation requires coordinated changes across those paths and pool boundaries. A streaming-only change would appear to fix a simple GET while violating rule, WebSocket, or connection-reuse semantics; this checkpoint therefore records the failing scenarios and patch plan without partially changing authority routing.

## Acceptance matrix for the subsequent route-binding change

- Trusted DNS-only certificate with an unresolvable logical name over original IPv4 and IPv6 addresses: H1, H2, H1 over the H2 server, and secure WebSocket must use the logical SNI/Host/`:authority`, with no logical DNS dial.
- Wrong logical certificate, untrusted CA, conflicting Host/`:authority`, wrong port, wrong scheme, duplicate/malformed Host, and invalid request targets must fail before unauthorized egress. No-SNI/IP and ordinary DNS CONNECT must retain their tested behavior.
- Same-origin rule transforms, explicit cross-origin rewrites, forwards, request/response breakpoints and keep-alive requests must retain correct per-request routing and subsequent-request isolation.
- HTTP/SOCKS upstream routes, H2 capability fallback, TLS recovery/retry, and pools sharing a logical name across different original IPs must not cross identities or targets. Existing non-replayable request and cancellation behavior must remain intact.

## Validation

On Windows Server 2025 x64 with standalone Node 26.7.0, the final run covered all proxy and Android interceptor tests plus test-layout validation: 90 files, 470 passing tests, zero failures/cancellations/skips, in 124.0 seconds. This includes the four new H2 certificate cases and five authority characterization cases. The log is in ignored `dist/companion-ip-authority-tests.log`.

```powershell
$files = @(Get-ChildItem test/proxy,test/interceptors/android -Recurse -Filter '*.test.js' -File |
  Sort-Object FullName | ForEach-Object { $_.FullName })
node --test --test-concurrency=1 @files test/meta/test-layout.test.js
```

JavaScript syntax checks, local documentation links, and `git diff --check` passed. The characterization cases establish the observed limitations, not successful logical-authority support. No device, packet-engine-to-desktop integration, physical USB, WAN, or production gateway validation is claimed.
