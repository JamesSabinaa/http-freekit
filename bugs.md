# Bug audit

Audited 2026-09-20 against `86c7303ed66b0275a3f9edff34a45ba4d054c357`.
Findings describe that audited revision. Resolution notes record subsequent fixes;
findings without a resolution note remain open. Related manifestations share one entry.
Severity describes the demonstrated impact and prerequisites; unverified
candidates are excluded.

## Audit status and validation

The audit is complete. Passes **13 and 14** were consecutive entire-project
reviews with **no newly verified bugs or material new manifestations**.
The audit produced **23 merged findings** below. A newly verified manifestation
reset the clean-pass count even when merged into an existing entry. Each pass covered the
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
| 6 | Entire project reviewed | 0 distinct; new Compose path case in BUG-004 | 0 |
| 7 | Entire project reviewed | 1, plus a new host-matcher case in BUG-019 | 0 |
| 8 | Entire project reviewed | 0 | 1 |
| 9 | Entire project reviewed | 0 distinct; new browser PATH cases in BUG-004 | 0 |
| 10 | Entire project reviewed | 1 (BUG-023) | 0 |
| 11 | Entire project reviewed | 0 distinct; new API-annotation case in BUG-010 | 0 |
| 12 | Entire project reviewed | 0 distinct; new JDK 8 path cases in BUG-004 | 0 |
| 13 | Entire project reviewed | 0 | 1 |
| 14 | Entire project reviewed | 0 | 2 |

Baseline `npm test`: **2,792 tests, 2,787 passed, 0 failed, 5 skipped**.
`npm audit --audit-level=high --json`: **0 vulnerabilities**. The package runtime
is Node **26.7.0**, although the shell's default Node is 25.2.1. Focused
verification also used the bundled Node 26.7.0 runtime.

The audit itself did not change production code or tracked tests. Reproductions used
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

**Resolution: Fixed.** Both streaming HTTP/2 request constructors now explicitly
keep the request stream open until the upload relay ends it. Regression tests
exercise HTTP/1 and native HTTP/2 ingress with GET, DELETE, HEAD and POST, empty
and Content-Length bodies, and chunked/data-frame bodies with trailers. All 24
wire-level cases preserve bytes and trailers without falling back to HTTP/1.
Validation: 63 tests passed across the new streaming-method suite and existing
streaming, replay and HTTP/2 settlement suites. Change reviewed before commit.

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

**Resolution: Fixed.** Tokenless HTTP and WebSocket admission now requires one
well-formed loopback Host authority matching the actual management listener port.
Foreign, malformed, duplicate and missing authorities are rejected before routing
or preflight; forwarded headers cannot authorize them. Valid loopback/IPv6 forms
and existing token authentication retain their behavior. Validation: 42 targeted
API/MCP tests passed, including real loopback HTTP/WebSocket controls. Root
reviewed the patch and independently reran all seven auth tests before commit.

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

**Resolution: Fixed.** Linux JVM/Electron inspection, persisted ownership and
pre-action identity checks now require a validated boot ID. Cross-boot records
are retired without attaching or signalling; unknown current identity retains
ownership for retry. Legacy Linux journals without a usable boot ID remain
untouched and cannot authorize recovery. Windows/macOS journal formats are
unchanged. Validation: 99 targeted tests passed, including 20 new stub-only
regressions; root reviewed the source and independently reran all 20 before commit.

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

**Resolution: Fixed.** CMD JVM fallback instructions now decode the literal
option after shell parsing and clearly identify the complete launch command;
PowerShell retains an inline option. Android restoration quotes remote-shell
operands. Compose uses separate bind-mount fields. POSIX browser/JDK discovery
preserves PATH/JAVA_HOME spelling, empty entries and case-sensitive variable
lookup. All five manifestations have regressions: 53 previously failed, all
73 focused checks now pass, and 401 surrounding interceptor tests pass. Review
reran the 73 checks, including native CMD/PowerShell argv captures. Java attach,
Android devices and a Docker engine were not used; those checks use isolated
filesystem/process fixtures, a print-only shell and parsed Compose configuration.

**Severity: Medium (activation/restoration can fail or use a different value).**
Locations: `src/interceptors/jvm-interceptor.js:803-824`, `:329-372`, `:1446-1454`;
`src/interceptors/android-adb-interceptor.js:102-104`, `:183`, `:871-875`,
`:1305-1331`; `src/interceptors/docker-interceptor.js:179-183`;
`src/interceptors/browser-paths.js:72-74`, `:94-95`;
`src/interceptors/browser-interceptor.js:53-58`.

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
The new Compose case prevents pass 6 from counting as clean.

Pass 9 verified related browser PATH handling failures. On Linux, set
`PATH=/opt/browser ` with a literal trailing space and make Chromium available
only at `/opt/browser /chromium`. Discovery trims the directory before lookup,
returns no browser, and reports `browser-not-installed`. Leading whitespace in
a relative directory and literal leading/trailing double quotes are also altered.
Empty PATH components naming the working directory are skipped. If a distinct
lowercase `path` variable appears before `PATH`, the case-insensitive lookup
uses that wrong variable instead.

The pinned [glibc PATH lookup](https://github.com/bminor/glibc/blob/glibc-2.42/posix/execvpe.c#L85-L125)
uses exact `PATH`, preserves each colon-delimited directory, and treats an empty
component as the working directory. Production browser discovery and availability
checks, with injected filesystem predicates and a source-derived lookup oracle,
fail for nine such configurations. Three ordinary/value-order controls work;
FreeKit's production Fresh Terminal resolver finds the intended executable in
all twelve. No actual Linux filesystem, command or browser was executed.
Expected: preserve platform-specific PATH values and lookup semantics. This new
configuration-value manifestation makes pass 9 non-clean. All these related
literal-value handling failures share one entry.

Pass 12 verified the same PATH transformations in JDK 8 tool discovery, plus
trimming of `JAVA_HOME`. In a simulated available JDK 8 installation with
`PATH=/opt/jdk/bin ` and a `java` symlink in that literal directory, production
`_runAttachHelper` emits `java -cp /fixture/attach AttachProxy ...`, omitting the
owning JDK's available `lib/tools.jar`. The ordinary-directory control includes
that jar. A fallback `JAVA_HOME=/opt/jdk ` is similarly changed before lookup.

Ten literal PATH/JAVA_HOME configurations omit the dependency; four controls
retain it. The unchanged production module was evaluated with POSIX path,
filesystem and command doubles. The helper imports `VirtualMachine`, and
[Java 8 class-loading documentation](https://docs.oracle.com/javase/8/docs/technotes/tools/windows/findingclasses.html)
requires tools classes to be on the user classpath. The resulting missing
dependency is source-backed; no Java compiler, runtime or attach was executed.
Expected: preserve the configured directories when discovering the required
JDK 8 classpath. This additional material case makes pass 12 non-clean.

### BUG-005 — Mock transform rerenders overwrite edited replacement bodies

**Resolution: Fixed.** Rendering action controls no longer reinitializes the
action from captured defaults. Mode changes and selecting the same action type
retain current request/response drafts, including explicit empty bodies; actual
type changes still initialize or migrate fields. Eight new regression tests
failed before the fix and pass afterward; 50 focused tests passed. Root reviewed
the change and independently reran the eight regressions before commit.

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

**Resolution: Fixed.** Import validation now checks the API-card metadata object,
parameter collection/entries, and consumed text/boolean fields before publishing
traffic. Invalid rows reject the whole batch and discard an invalid staged
transaction; optional null fields, references and schema/extension data remain
supported. Validation: 234 import/export and identity tests passed with two
existing unavailable Go/PHP skips; 15 focused checks passed. Root reviewed the
validator and independently reran three atomic-import/detail-render regressions.

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

**Resolution: Fixed.** Send now uses the shared case-insensitive header-value
reader before choosing a response view. Arrays, mixed-case repeated fields and
empty values produce a string without changing captured headers or body bytes.
Validation: 40 targeted tests passed, including an actual duplicate-header
origin and binary/decoded-preview controls. Root reviewed the one-line fix and
independently reran 12 response/draft regressions before commit.

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

**Resolution: Fixed.** UI-settings reads now wait until pending saves settle and
discard older read responses. Upstream saves and rotations reject superseded
completions and reconcile authoritative server state after overlapping writes,
including failures. Regression coverage separates server application order from
response order and checks optimistic state, rollback, rotation events and later
saves. All 63 focused tests passed, including behavioral no-proxy save/restore
coverage; the production changes and ordering matrix were reviewed before commit.

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

**Resolution: Fixed.** Certificate and trusted-CA additions clear inputs only
when the complete submitted draft is still unchanged. Editing any certificate
field preserves the whole new draft while the saved list still updates. The
regressions cover each field, whitespace-only edits, empty drafts and ordinary
successful clearing; both new tests failed before the fix. Review and all 19
focused settings/certificate tests passed.

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

### BUG-010 — Method case folding changes exports and mislabels API operations

**Severity: Medium (exported request differs from captured request).** Locations:
`src/ui/request-export.js:474`, `:518`, `:740`, `:761`;
`src/proxy/proxy-server.js:12055`, `:12082`;
`src/api/api-server.js:2335`, `:3410-3417`; `src/ui/app.js:3791-3820`.

Export and execute a request with method `MiXeD` as Python Requests, or `pOsT`
as JavaScript Fetch, against a local raw TCP listener. Python sends `MIXED` and
Fetch sends `POST`. This was verified for both raw and multipart generated
snippets (Python Requests 2.34.2; Fetch on bundled Node 26.7.0).

HTTP method tokens are case-sensitive. Expected: preserve the token or clearly
report that exact export is unsupported. The application and Node HTTP exporter
preserve casing, but the generated Requests/Fetch calls normalize these methods.
All body-format variants are grouped as one export-fidelity defect.

Pass 11 verified a related case-folding error in OpenAPI matching. Import a spec
with a GET operation `getResource` at `/same`, then use Send with the custom
method `gEt` or `get` at that URL. The actual method remains unchanged on the
loopback origin's wire and in captured traffic, but `matchApiSpec` lowercases it
and incorrectly attaches the GET operation's documentation. Explicit
`GET /api/specs/match` returns the same wrong operation. Ordinary GET correctly
matches; POST correctly has no match.

Expected: distinct case-sensitive HTTP method tokens must not share an operation
annotation merely because their lowercase spelling is equal. This additional
case is **Low severity, metadata only**: it mislabels the detail card without
altering routing or request bytes. The real spec-import, Send, capture-enrichment
and explicit-match API flows were exercised; UI display is established by the
detail renderer's source. Both subsystems lose method-case identity and share
this entry. The new annotation manifestation makes pass 11 non-clean.

### BUG-011 — PHP cURL exports suppress explicitly empty headers

**Resolution: Fixed.** Raw, URL-encoded and multipart PHP exports now share
libcurl's empty-header serialization with the cURL exporter: a trailing semicolon
preserves an empty value instead of suppressing the field. PHP string escaping
and ordered repeated fields remain intact. Validation: 60 tests passed, with
two existing unavailable Go/PHP runtime skips. New regressions decode the exact
generated PHP header literals and verify them against a real loopback curl
request; PHP itself remains unavailable. The source and generated values were
reviewed against the [libcurl header contract](https://curl.se/libcurl/c/CURLOPT_HTTPHEADER.html).

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

**Resolution: Fixed.** Fixed replacements retain binary bytes. Rule cloning,
loading, settings persistence and failed-save rollback preserve Buffer values;
canonical JSON Buffer bodies are strictly validated and revived only in body
slots. Malformed byte arrays remain invalid. All 50 new tests and 114 related
tests passed, covering actual request/response bytes, empty and string controls,
modern/legacy/nested rules, caller ownership, memory/JSON/disk restoration and
atomic failures. Review reran the 50 new tests successfully.

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

**Resolution: Fixed.** Early responses now use the method/status-appropriate
payload for both transmission and capture. This also suppresses HEAD bodies
behind Send's internal POST transport envelope. Existing explicit response
headers are retained. Direct proxy and Send POST/HEAD regressions verify wire,
capture and HAR body/size parity with no origin request. Validation: 30 targeted
tests passed; independent review exposed the Send case, and root reviewed the
final correction and reran all nine body-limit tests before commit.

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

**Resolution: Fixed.** Summary surfaces now use their paired input foreground;
High Contrast summary labels and status badges explicitly use that black text.
Dark/Light colors remain unchanged. Validation: 12 focused tests and 39 actual
Chrome checks passed. High Contrast Send labels, duration, all status families,
Traffic summary text and the input control measured 21:1. Root reviewed the CSS,
browser evidence and regression assertions, then reran the contrast suite.

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

**Resolution: Fixed.** Successfully admitted SSE responses now disable their
idle timeout; pending uploads and ordinary management requests retain it.
Local tests exercise real SDK transports and the production stdio bridge after
idle time, verify ping delivery and disconnect/EOF/shutdown cleanup, and check
ordinary and incomplete-request timeouts. All 141 focused MCP/API tests and four
Send timeout/cancellation tests passed; independent review reran the three new
lifetime tests successfully.

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

**Resolution: Fixed.** Bodyless HEAD exports use cURL's `--head` or PHP's
`CURLOPT_NOBODY`. HEAD uploads, including multipart entities, explicitly direct
users to Node export instead of silently losing request bytes or mishandling the
response. Real cURL regressions verify successful HEAD responses with nonzero
representation lengths and GET/POST controls. All 30 focused tests passed;
independent review reran the three new tests. PHP behavior was checked against
the [libcurl option contract](https://curl.se/libcurl/c/CURLOPT_NOBODY.html);
PHP itself remains unavailable.

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

**Resolution: Fixed.** The request-body pill now uses the same effective
perspective as the body viewer. Renderer regressions cover all four perspectives
with text, binary, truncated and unavailable original bodies, and verify that
capture metadata remains unchanged. The regression failed before the one-line
fix; review and all 22 focused detail/body-view tests passed.

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

**Resolution: Fixed.** Global Chrome recognizes the documented Linux
`/usr/bin/chromium` to `/usr/lib/chromium/chromium` launcher transition. It records
the observed binary and retains exact PID/start/executable checks for subsequent
refresh, recovery and cleanup. Stubbed lifecycle tests exercise discovery,
activation, persisted-journal recovery and cleanup, with direct-launch and
wrong-path/platform/browser/process-identity controls. All 90 focused and
surrounding browser tests passed; review reran the nine new tests. No real browser
or process was launched or signaled by these regressions.

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

### BUG-019 — Equivalent IPv6 addresses fail host-based routing and rule matching

**Resolution: Fixed.** Bypass destinations and entries now share IPv6 address
normalization, as do bracketed host/hostname matcher values. Explicit ports and
existing DNS, IDNA and wildcard behavior are retained. New regressions verify
real direct-versus-upstream routing and rule selection across compressed,
expanded and IPv4-mapped spellings, with wrong-port/address controls. All three
new tests failed before the fix; peer review found no blocking issues and all
23 focused tests passed independently.

**Severity: Medium (incorrect upstream routing or missed rules).** Locations:
`src/proxy/proxy-server.js:3062-3105`;
`src/proxy/upstream-proxy-config.js:27-33`; host/hostname matchers at
`src/proxy/proxy-server.js:10364-10379`.

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

Pass 7 verified the same asymmetric normalization in mock host/hostname
matchers. A validated `hostname` matcher for `[0:0:0:0:0:0:0:1]` misses a request
whose URL uses that address, while changing only the matcher to `[::1]` matches.
The `host` matcher behaves the same way with `:54321` appended. A loopback proxy
with the tested fixed-response rule returning 201 and a wildcard fallback
returning 202 confirms 202 for expanded forms and 201 for compressed controls,
without contacting an origin. The actual URL is canonicalized; the expected
matcher value is only lowercased. These address-identity cases share this entry,
but the newly verified matcher case makes pass 7 non-clean.

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

### BUG-022 — Inconsistent captured hosts create mocks and breakpoints that never match

**Resolution: Fixed.** HTTP/HTTPS capture emissions consistently derive `host`
from the URL hostname, including pending updates. Mock and breakpoint creation
also derive hostname conditions from the URL to support older records. Ten
actual CONNECT/TLS HTTP/1 and HTTP/2 cases cover IPv4, DNS, IPv6 and default or
nondefault ports; legacy authority/bare-IPv6 records are covered too. Eight tests
failed before the fix. All 55 focused checks passed, and independent lifecycle
review passed 71 tests plus partial/invalid/non-HTTP record controls.

**Severity: Medium (rules derived from captured traffic fail on the same request).**
Locations: `src/proxy/proxy-server.js:8645-8656`, `:6485`, `:10364-10379`;
`src/ui/app.js:15660-15662`, `:16059`.

Enable HTTP/2 All and capture a native HTTP/2 request to
`https://example.test:54321/same`, answered by a temporary wildcard fixed-response
mock, then use Create Mock or Create Breakpoint. Disable the temporary rule
before testing the derived rule. The capture stores `host` as
`example.test:54321`; both UI actions copy it into a `hostname` matcher. Runtime
matching compares that value to `new URL(url).hostname`, which has no port, so
the derived rule cannot match the original request. IPv4 and IPv6 nondefault
ports fail identically; default HTTPS port controls work.

A second capture path has the same host-contract problem: with HTTP/2 mode
disabled, buffered TLS/HTTP/1.1 traffic to `[::1]` stores bare `::1`. Both derived
rules then compare it to bracketed `[::1]` and miss, on default and nondefault
ports. IPv4 controls work; the HTTP/1.1 fallback engine used in HTTP/2 All mode
keeps the bracketed IPv6 hostname and also works.

An isolated real CONNECT/TLS/H2/H1 probe uses fixed-response mocks to generate
these captures without an origin. The production UI derivation functions and
runtime matcher reproduce both failures across ten protocol/authority controls.
Expected: mocks and breakpoints created from a capture match that same request.
Normalize the capture's hostname contract consistently or derive the matcher
from its parsed URL. Both protocol manifestations share one capture-to-rule
contract defect; the nondefault-port case also affects DNS/IPv4 and differs from
BUG-019's equivalent IPv6 spelling mismatch.

### BUG-023 — Send silently rewrites raw request-body newlines

**Resolution: Fixed.** Send retains the exact loaded body alongside the editor's
displayed text until an actual edit. Fallback/Monaco initialization and reloads
preserve that source for payloads, exports and workspace persistence. Regressions
cover CRLF, LF, mixed/lone-CR endings, Unicode, binary controls, genuine and empty
edits, HAR multipart and pasted cURL. All 309 Send/HAR tests passed; review reran
37 focused tests. Actual Chrome checks passed for fallback (72) and shipped
Monaco (74), including fresh-page reload and locally intercepted Send payloads.

**Severity: Medium (an unedited replay sends and saves different body bytes).**
Locations: `src/ui/app.js:10252-10277`, `:10317-10360`, `:12269`, `:12505`,
`:12791-12808`.

With the fallback Send editor active, resend captured UTF-8 text
`alpha\r\nbeta\r\n` without editing it. Assigning it to the textarea changes CRLF
to LF; reading the editor produces `alpha\nbeta\n`. Production preparation and
Send dispatch submit 11 bytes instead of 13, and workspace persistence saves
that changed body. Pasting cURL containing the same literal CRLF body also
changes it, although the cURL parser itself preserves the original text.

HAR multipart reconstruction initially produces correct CRLF framing. Loading
that reconstructed body into raw Send strips the CR characters while retaining
its multipart Content-Type and boundary: a one-field 121-byte fixture becomes
116 bytes. The submitted body therefore loses the original multipart framing.
Node's local `Response.formData()` parser accepts the original field and rejects
the changed body; no claim is made that every multipart server rejects it.
This differs from BUG-020's generated exports of an empty structured form.

The real shipped Monaco editor preserves uniform CRLF when already initialized,
but also changes mixed newlines without an edit: the 23-byte body
`alpha\r\nbeta\ngamma\rdelta` becomes 25 bytes with CRLF throughout. The fallback
turns the same body into 22 bytes with LF throughout. LF-only and base64-encoded
body controls preserve their exact bytes.

Directly invoking the real Monaco initializer also changes uniform CRLF through
its reconciliation with the fallback textarea. This initialization path was
exercised directly; a separate initial-page workspace reload was not executed.

These results use Chrome running the actual page and shipped editor. The editor,
`prepareSendRequestPayload`, locally intercepted `/api/send` JSON, and persisted
workspace body all agree on the changed content; no origin request was made.
Expected: preserve unedited raw body bytes across loading, sending and saving,
including mixed line endings. The fallback and Monaco variants share one
editor-to-payload preservation defect.
