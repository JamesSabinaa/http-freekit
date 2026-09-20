# Bug audit

Audited 2026-09-20 against `86c7303ed66b0275a3f9edff34a45ba4d054c357`.
These are open findings, not fixes. Related manifestations share one entry.
Severity describes the demonstrated impact and prerequisites; unverified
candidates are excluded.

## Audit status and validation

The audit remains in progress. Completion requires **two consecutive entire
project passes with no newly verified bugs or material new manifestations**.
Related manifestations are merged in the findings below, but a newly verified
case still prevents that pass from counting as clean. Each pass covers the
**88 first-party production files**: 21 application/API/MCP/traffic/startup,
17 interceptor, 14 proxy, 10 UI, 22 Electron, and four script files, plus
packaging/build/CI configuration, documentation, assets and relevant test coverage.
Earlier passes included full textual reviews; later passes used complete module
and function inventories, fresh reviews of behavior and error handling, targeted
source reads, and independent probes. Tests are not a substitute for source review.

| Pass | Coverage | New distinct bugs | Consecutive clean passes |
| --- | --- | ---: | ---: |
| 1 | Entire project reviewed, including final markup/theme verification | 14 | 0 |
| 2 | Entire project reviewed | 4, plus a new Buffer round-trip case in BUG-012 | 0 |
| 3 | Entire project reviewed | 1, plus a new settings race in BUG-008 | 0 |
| 4 | Entire project reviewed | 2 | 0 |
| 5 | Entire project reviewed | 0 | 1 |
| 6 | Application, desktop and proxy complete; UI and interceptor reviews finishing | 0 distinct; new Compose path case in BUG-004 | 0 |
| 7 | Entire-project review underway | 0 so far | Pending |

Baseline `npm test`: **2,792 tests, 2,787 passed, 0 failed, 5 skipped**.
`npm audit --audit-level=high --json`: **0 vulnerabilities**. The package runtime
is Node **26.7.0**, although the shell's default Node is 25.2.1. The proxy,
management API, and seven UI reproduction groups were verified on 26.7.0.

Production code and tracked tests have not been changed. Reproductions use
isolated local listeners, synthetic traffic, VM-loaded production UI functions,
or stubbed process/device operations. Linux reboot collisions were simulated;
no real process was terminated. No real Android device, system proxy, or host
trust store was modified. Java/Javac, PHP and Go were unavailable; the five
baseline skips comprise three JVM runtime tests and two generated-export runtime
tests. Relevant reproduction limits are stated below. Detailed local evidence is under the
ignored `data/bug-audit/` directory; the descriptions below do not require those
uncommitted files to understand the defects.

## Findings

### BUG-001 — Streaming HTTP/2 forwarding can silently discard request bodies

**Severity: High (request data loss).** Locations:
`src/proxy/proxy-server.js:1815`, `:2592`.

Both streaming HTTP/2 constructors omit `endStream: false`. Node can create
GET/DELETE/HEAD streams already ended; the upload relay then skips writing the
body. The buffered helper at `:9059` already sets this option correctly.

Reproduce with a local TLS HTTP/2 echo origin (`allowHTTP1: true`) trusted by an
isolated proxy.
Send a plain HTTP proxy request with an absolute HTTPS destination, method
DELETE, `Transfer-Encoding: chunked`, and body `abc`. The origin receives an
empty body and returns 200. With `Content-Length: 3`, DELETE instead returns
502/`NGHTTP2_PROTOCOL_ERROR`. POST with the same length/body reaches the origin
correctly; GET with a length unnecessarily falls back to HTTP/1.1.

Expected: forward the exact body irrespective of method. The native HTTP/2
streaming constructor shares the omission; only the ordinary HTTP proxy ingress
was exercised end to end. These variants constitute one framing defect.

### BUG-002 — Tokenless management API accepts an unexpected Host authority

**Severity: Medium (conditional exposure of captured traffic).** Locations:
`src/api/api-server.js:1362-1423`, optional `AUTH_TOKEN` in `src/index.js`.

Management middleware validates Origin when present but permits requests without
Origin; without a configured token it authenticates them unconditionally. It
does not validate Host against the local management authorities.

Reproduce against an isolated default/tokenless ApiServer containing a synthetic
traffic record: connect to its loopback port and request `/api/traffic` with
`Host: untrusted.example:<port>` and no Origin. It returns 200 and the record,
including its synthetic Authorization header. The same request with a foreign
Origin returns 403; enabling the API token returns 401 without that token.

Expected: reject unexpected management authorities even when Origin is absent.
This leaves a DNS-rebinding exposure where browser/network conditions permit
such requests. Only the missing authority guard was demonstrated; an actual
browser rebinding exploit was not attempted. Desktop session-token protection
worked and is outside the demonstrated tokenless case.

### BUG-003 — Recovered Linux JVM/Electron ownership is not bound to a boot

**Severity: Medium (wrong process may be modified/stopped after a collision).**
Locations: `src/interceptors/jvm-interceptor.js:73-103`, `:175-176`, `:682-703`,
`:1744-1795`; `src/interceptors/electron-interceptor.js:209-253`, `:686-733`;
`src/interceptors/process-identity.js:71-139`.

Linux start ticks are relative to boot. These two interceptors do not request
or preserve a boot ID and compare recovered ownership by PID, start ticks, and
executable. A persisted record can therefore match an unrelated process after
reboot if those values repeat (and the JVM's displayed main class also matches).

Reproduce with stubbed process inspection and a journal from boot A: use PID
424242, start time `1000`, and the same executable on boot B, with different
valid boot UUIDs. Load the recovered record and invoke Stop. The JVM restore
attach stub is called once and the Electron signal stub is called once; expected
both zero. Identity normalization drops the boot UUID. No real process was
attached to or signalled, and no real cross-boot collision was observed.

Expected: discard ownership from another boot. Terminal recovery already
implements boot-bound ownership. Both affected interceptor families share this
identity defect.

### BUG-004 — Interceptor commands and configuration fail to preserve literal values

**Severity: Medium (activation/restoration can fail or use a different value).**
Locations: `src/interceptors/jvm-interceptor.js:803-824`;
`src/interceptors/android-adb-interceptor.js:102-104`, `:183`, `:871-875`,
`:1305-1331`; `src/interceptors/docker-interceptor.js:179-183`.

The Windows JVM Command Prompt fallback quotes an agent path without protecting
percent expansion. Generate the fallback for
`C:\FreeKit-%FK_AUDIT_LITERAL%\proxy-agent.jar`, set the synthetic environment
variable to `EXPANDED`, and evaluate the generated option using an isolated
`cmd.exe /d /v:off /c echo`. The path becomes
`C:\FreeKit-EXPANDED\proxy-agent.jar`. Expected: the literal existing path.
The PowerShell alternative does not exhibit this case.

Android restoration passes the saved proxy as an unquoted operand to
`adb shell settings put`. ADB joins these operands into a remote shell command,
so local `execFile` argument separation does not preserve the value. A shell
stub mirroring that join, with saved value
`proxy.$FK_AUDIT_SUBDOMAIN.example:8080` and variable value `expanded`, records
`proxy.expanded.example:8080`; restoration nevertheless reports success.
Expected: restore the original string, or reject unsupported values before
replacing the original setting. No physical device was used.

Pass 6 verified a related Docker Compose path case. With a valid Linux CA path
`/tmp/project:blue/data/ca.pem` (for example, a source checkout containing `:`),
the generator emits the short volume string
`/tmp/project:blue/data/ca.pem:/etc/http-freekit/http-freekit-ca.pem:ro`.
YAML quotes preserve the string, but the
[Compose volume parser](https://github.com/compose-spec/compose-go/blob/75fb1aba98ff8a944ebc5ea54f1054f1329e999c/format/volume.go#L57-L92)
then splits its colon separators and rejects it as `too many colons`.
Expected: represent the literal source path using separate source/target fields.

Production instruction generation, actual YAML parsing, and a bounded translation
of that primary parser's separator logic establish the rejection for two colon
paths; ordinary Linux and Windows-drive controls pass. Go and Docker Compose
were unavailable, so this is source-backed validation, not a Compose execution.
These related literal-value handling failures share one entry; the new Compose
case still prevents pass 6 from counting as clean.

### BUG-005 — Mock transform rerenders overwrite edited replacement bodies

**Severity: Medium (draft edits lost and an unintended body may be saved).**
Locations: `src/ui/app.js:9110`, `:9120`, `:10163-10165`; triggering handlers
`:8663`, `:8674`, `:8701`, `:8724`, `:8735`, `:8762`.

Create a transform mock from captured traffic, which retains original body
metadata (`:15704-15705`). Edit its replacement request body, or deliberately
clear a previously nonempty replacement response body. Change an unrelated
header/URL/status/body mode control that rerenders the action configuration.

The renderer calls `changeMockActionType` even when the action type is unchanged.
It prefers `_originalRequestBody` over the edited request, and uses a truthy
fallback for the response. Executing these production functions changes
`USER NEW BODY` back to `ORIGINAL` and the deliberately empty response back to
`RESPONSE`. Expected: preserve the current draft, including explicit empty
strings. Request and response variants share this rerender data-loss defect.

### BUG-006 — Malformed optional API metadata in traffic imports crashes details

**Severity: Medium (accepted traffic cannot be inspected).** Locations:
`src/api/api-server.js:923-1119`, `:2576` onward;
`src/ui/app.js:3799`.

Import an otherwise valid HTTP traffic row with
`"apiMatch":{"parameters":"invalid"}` or `"apiMatch":{"parameters":[null]}`,
then select it.
The real import validator accepts both and appending preserves the metadata.
Detail rendering assumes an array of non-null parameter objects: the string
throws `parameters.map is not a function`; the null member throws on `p.name`.

Expected: reject malformed metadata atomically or safely normalize/omit invalid
optional fields. Both shapes share the missing validation boundary. The renderer
failure was reproduced by invoking the full production `renderDetailCards`.

### BUG-007 — Send loses successful responses with repeated Content-Type fields

**Severity: Medium (response unavailable in Send).** Locations:
`src/ui/app.js:12876-12891`, `:4519`.

Have a local HTTP origin emit two `Content-Type: text/plain` fields and a body.
The real Send backend returns `headers['content-type']` as
`['text/plain','text/plain']`. The UI passes that array directly to
`getBodyViewModes`, which calls `.toLowerCase()` and throws before assigning the
response to the tab. The successful request is presented as a Send failure.

Expected: display the response and retain its repeated headers. Traffic details
already use `getCombinedHeaderValue` for this purpose. Existing repeated-header
Send tests cover Set-Cookie/Warning but only a singleton Content-Type.

### BUG-008 — Out-of-order settings responses overwrite newer saved UI values

**Severity: Medium (displayed settings disagree with the latest saved values).**
Location: `src/ui/app.js:13899-13944`, especially `:13914`.

Choose None to disable the upstream proxy and delay the DELETE response. Enter
and save HTTP proxy `new.test:8080`; let that POST complete. Finally deliver the
older DELETE response. Executing the real settings functions with controlled
fetch completions resets the selector to None, clears fields, and displays
Direct connection, although the newer save had succeeded.

Expected: an older operation's completion must not replace the state of a newer
successful operation. Existing read-generation guards do not order two mutation
responses. The demonstrated case is upstream disable versus a subsequent save.

Pass 3 also verified a read-during-write race in `loadUiSettings`
(`src/ui/app.js:13096-13104`): it snapshots
only `uiSettingsSaveGeneration`. Start saving `hideTunnelRequests: false`, then
start a reconnect GET while that save is pending. Complete the POST, then return
the GET's older `hideTunnelRequests: true` value. The production renderer restores
the old checkbox/filter state and `uiSettingsConfirmed`, despite the newer
successful save. Both operations shared the same generation. This related case
needs a pending-mutation/read guard in addition to ordering mutation completions.

### BUG-009 — Certificate add completion erases a newer unsent form draft

**Severity: Medium (unsent input loss).** Locations:
`src/ui/app.js:14599-14601`, `:14687`;
editable controls in `src/ui/index.html:533-535`, `:548`.

Begin adding a client certificate or trusted CA. While its POST is pending,
enter the next certificate's values in the still-editable form. Complete the
first POST successfully. Its completion clears the new host/path/passphrase or
CA path. Both real add functions and their operation-state helpers reproduce
this behavior; those helpers do not track unsent edits.

Expected: clear only the values submitted by that operation, or preserve changed
fields. The TLS passthrough/HTTPS whitelist handlers already compare submitted
values before clearing. Client-certificate and CA variants are one draft-loss
bug.

### BUG-010 — Python and Fetch exports change HTTP method casing

**Severity: Medium (exported request differs from captured request).** Locations:
`src/ui/request-export.js:474`, `:518`, `:740`, `:761`.

Export and execute a request with method `MiXeD` as Python Requests, or `pOsT`
as JavaScript Fetch, against a local raw TCP listener. Python sends `MIXED` and
Fetch sends `POST`. This was verified for both raw and multipart generated
snippets (Python Requests 2.34.2; Fetch on bundled Node 26.7.0).

HTTP method tokens are case-sensitive. Expected: preserve the token or clearly
report that exact export is unsupported. The application and Node HTTP exporter
preserve casing, but the generated Requests/Fetch calls normalize these methods.
All body-format variants are grouped as one export-fidelity defect.

### BUG-011 — PHP cURL exports suppress explicitly empty headers

**Severity: Medium (exported request differs from captured request).** Locations:
`src/ui/request-export.js:648-650`, `:842`; correct cURL helper at `:83`.

Export a request containing `X-Empty: ''` as PHP. Both raw and multipart branches
put `'X-Empty: '` in `CURLOPT_HTTPHEADER`. Libcurl interprets a colon with an
empty value as header suppression; the literal empty-header syntax is
`X-Empty;`. A real local curl wire probe receives no header for the generated
colon form and receives an empty header for the semicolon form.

Expected: preserve the explicitly empty header, including empty members of
repeated headers. PHP itself was unavailable: validation consists of inspecting
the generated PHP and executing the equivalent libcurl header syntax through
curl, not running the PHP snippet.

### BUG-012 — Accepted Buffer bodies are corrupted or lost across rule operations

**Severity: Medium (binary data/rule loss; programmatic API).**
Locations: `src/proxy/proxy-server.js:3801`;
`src/proxy/mock-rule-validation.js:159`, `:280`, `:369`.

Create a programmatic transform-request or transform-response rule with
`bodyMode: 'replace-fixed'` and `body: Buffer.from([0,255,128])`. Validation
explicitly accepts it. Send through an isolated live proxy and echo origin:
both transform directions yield hex `00efbfbdefbfbd`, rather than `00ff80`.
`String(fixedBody)` decodes invalid UTF-8 bytes before they are re-encoded.

Expected: retain accepted Buffer values byte for byte, as fixed-response
normalization already does. This finding concerns the supported programmatic
Buffer input; ordinary JSON text values from the UI do not demonstrate it.

Pass 2 also verified that an accepted Buffer fixed-response rule disappears on
`loadMockRules(proxy.mockRules)`: `structuredClone` at
`src/proxy/proxy-server.js:10238` converts Buffer to Uint8Array, which validation
then rejects at `:10253`. A JSON round trip creates `{type:'Buffer',data:[...]}`
and is likewise discarded. The rule count falls from 1 to 0; a normal string-body
control survives. Both cases belong to the accepted binary-body preservation
problem and are not counted as separate bugs.

### BUG-013 — Early HEAD rejection records a body that was never sent

**Severity: Low (incorrect capture/export evidence).** Locations:
`src/proxy/proxy-server.js:5645-5646`, oversized buffered request path `:5094`.

Start an isolated proxy with `maxBufferedBodyBytes: 4` and a wildcard
fixed-response mock to select request buffering. Send HEAD with
`Content-Length: 6` and body `123456`. The actual response is 413 with zero body
bytes, but the traffic record contains `Request body too large` and response
body size 22. No origin is contacted.

Expected: capture the empty HEAD response body and size 0. Early replies record
their unconditional error buffer before Node suppresses HEAD response bytes.

### BUG-014 — High Contrast hides response summary text on white backgrounds

**Severity: Medium (response details unreadable in an accessibility theme).**
Locations: `src/ui/styles.css:247`, `:251-253`, `:331-336`, `:1190-1207`;
`src/ui/index.html:331`; `src/ui/app.js:12917`.

Choose High Contrast in Appearance settings and send a request. Status/Duration
labels and the duration value in the response summary are white on white.
The theme makes both `--bg-input` and main/watermark text white, but its black
foreground override applies only to form controls. Summary display panels reuse
that background without the foreground override.

Headless Chrome with the production HTML/CSS and real status-rendering function
confirms foreground and background `rgb(255,255,255)` for a visible `15 ms`
duration (1:1 contrast). Dark and Light controls remain readable, and High
Contrast inputs correctly use black text. Expected: readable summary text.
Other display surfaces with the same token combination are related candidates,
not additional independently rendered findings.

### BUG-015 — Idle MCP sessions and their stdio bridge disconnect after 30 seconds

**Severity: Medium (routine connection loss).** Locations:
`src/api/api-server.js:1424-1429`; `src/mcp/mcp-server.js:1192-1200`;
`src/mcp/stdio-bridge.js:46`, `:60-70`, `:79`.

The management middleware sets a 30,000 ms request/socket timeout to stop
incomplete uploads. It also applies to the long-lived `/mcp/sse` GET response.
That route neither disables the timeout nor sends keepalive events. An idle
established SSE connection is destroyed and its session removed.

Reproduce by opening an authenticated SSE connection to an isolated ApiServer
and leaving it idle after receiving its endpoint event. With the default
configuration it closes after 30,066 ms, response `complete: false`, and POST to
the issued message endpoint returns 404 `Session not found`. A second probe uses
the production stdio bridge, open stdin, and a shortened 100 ms server timeout:
the bridge closes after 179 ms with an SSE termination error and exit code 1.
Both run on bundled Node 26.7.0.

Expected: keep an idle MCP connection and its bridge usable until the client
disconnects. Existing upload-timeout and SSE-admission tests do not leave a
successfully admitted SSE session idle beyond the timeout.

### BUG-016 — cURL HEAD exports report failure for a normal successful response

**Severity: Medium (common request export falsely fails).** Location:
`src/ui/request-export.js:727`; analogous multipart construction at `:447`.

Export an empty-body HEAD request as cURL and run it against a local server that
returns 200, `Content-Length: 5`, `Connection: close`, and no body. The generated
`curl -X 'HEAD' ...` command exits 18: `end of response with 5 bytes missing`.
The control with `--head` receives the same HEAD response and exits 0.

Expected: a successful HEAD exchange completes successfully. Setting only a
custom method does not enable cURL's no-response-body handling; HEAD can legally
advertise the GET representation's length while sending no body. This differs
from method-case normalization because both probes send the same HEAD token.
Only the ordinary raw HEAD export was executed; PHP's similar source pattern
and multipart variants were not independently verified.

### BUG-017 — Original/client body perspective shows the transformed body size

**Severity: Low (misleading displayed byte count).** Locations:
`src/ui/app.js:3903`, effective original size at `:3290`.

Capture a request whose original body is `abc` with size 3, transformed to
`expanded-body` with size 13. Choose Show original content or Client perspective
in Traffic details. The body viewer correctly displays `abc`, but its size pill
says `13B`. Transformed/server perspectives correctly show `expanded-body` and
`13B`. These four cases were checked with the real detail renderer and helper.

Expected: the pill says `3B` with the original body. It uses
`req.requestBodySize` instead of the effective request's size. The body bytes and
forwarding are unaffected by this presentation error.

### BUG-018 — Global Chrome rejects Debian Chromium's supported launcher

**Severity: Medium (activation fails on a supported Linux installation).**
Locations: `src/interceptors/browser-paths.js:46`, `:103`;
`src/interceptors/existing-browser-interceptor.js:244-255`, `:463-490`.

On Debian with Chromium discovered as `/usr/bin/chromium`, Global Chrome starts
the browser but then rejects ownership because the observed process executable
is `/usr/lib/chromium/chromium`. Its failed-launch path terminates the child.
The check equates a supported launcher path with the eventual executable path.

The actual wrapper transition is established by the official
[Debian Chromium source archive](https://deb.debian.org/debian/pool/main/c/chromium/chromium_153.0.8010.52-1.debian.tar.xz):
`debian/scripts/chromium:9,12,153` executes the binary under `/usr/lib/chromium`,
and `debian/rules` installs the wrapper under `/usr/bin`. It does not preserve the
wrapper as argv[0]. Google's different Chrome wrapper uses `exec -a` and is not
claimed to exhibit this case.

A fixture invoking production discovery, POSIX snapshot parsing and activation
with the Debian paths gets `Launched Global browser executable identity does not
match the selected browser`, `active: false`, and a mocked SIGTERM. A direct
binary-path control succeeds without a signal; already-running detection also
works. Expected: accept the legitimate launcher-to-binary transition while
retaining process ownership checks. No Linux browser was actually launched here;
the package source and fully mocked activation establish the failure together.

### BUG-019 — Equivalent IPv6 proxy-bypass addresses fail to select the direct route

**Severity: Medium (incorrect upstream routing).** Locations:
`src/proxy/proxy-server.js:3062-3105`;
`src/proxy/upstream-proxy-config.js:27-33`.

Configure an upstream proxy and `noProxy: ['[0:0:0:0:0:0:0:1]']`, then request
`http://[0:0:0:0:0:0:0:1]:<port>/` through FreeKit. URL parsing compresses the
request hostname to `[::1]`, while the bypass matcher strips brackets and
lowercases without canonicalizing IPv6 literals. The equivalent strings fail
to match and the request goes through the upstream.

An isolated `::1` origin and `127.0.0.1` upstream confirm zero origin hits and one
upstream hit. Changing only the bypass entry to `[::1]` gives one origin hit and
zero upstream hits. Expanded unbracketed and expanded bracket-plus-port entries
fail the same way. Expected: equivalent addresses select the same route.
All forms are one normalization bug; no additional security impact is asserted.

### BUG-020 — Empty multipart forms lose their body in cURL and Python exports

**Severity: Medium (exported request differs from Send).** Locations:
`src/ui/request-export.js:403-480`; `src/ui/app.js:12766-12788`.

Choose POST and multipart body mode, leaving the default unnamed row or no
enabled named fields. Send still produces a multipart Content-Type with a
boundary and the closing boundary as its body. The cURL and Python generators
remove that Content-Type, then add multipart options only while iterating fields.
With zero fields, neither generator supplies a body or multipart Content-Type.

A loopback listener confirms that both generated exports send no multipart
header and an empty body. Executing the real Send preparation and generated
Node export with boundary `----audit-empty-form` produces the correct 26-byte
closing boundary and multipart header. A server requiring multipart therefore
returns 415 for the cURL/Python requests and 200 for the Node control.

Expected: preserve the empty multipart entity, or explicitly report that the
target cannot replay it. Silently changing it to a bodyless POST is incorrect.
Both affected generators share one empty-collection handling defect.

### BUG-021 — Delayed cross-window storage events revert a saved Send editor

**Severity: Medium (the editor silently displays stale request data).** Location:
`src/ui/app.js:12305-12384`, especially `:12369-12371`.

Open two FreeKit windows sharing a Send workspace with tabs A and B. In the
second window, edit B and switch tabs to persist it, delaying delivery of that
window's storage event to the first window. In the first window, edit A's URL
and body and click its already selected A tab to finish its save
(`switchSendTab`, `:12645-12651`) before delivering the queued event.

The event contains a snapshot from before A's save. The handler trusts
`event.newValue`, treats the now-saved editor as clean, and reloads A from that
old snapshot. Executing the production persistence and event functions changes
the visible URL from `https://saved-a.test` back to `https://original-a.test`
and its body from `new saved body` to empty, with no notification. Current
localStorage still contains saved A and the other window's updated B.

Expected: reconcile against the current persisted workspace or reject obsolete
revisions before replacing the editor. The preserved on-disk data limits the
immediate loss, but the user sees and can send the wrong request. This is a
workspace event reconciliation defect, distinct from the HTTP settings response
ordering in BUG-008.
