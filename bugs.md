# Bug audit

This file records 47 reproducible defects found during a repository-wide audit and their resolution status. Findings are grouped by subsystem rather than discovery order. Evidence and line numbers describe the original audited revision and may differ from the fixed implementation on current `main`.

## Current status

All 47 findings below are **Fixed**. Their reviewed fixes and integration hardening are merged into `main`.

Final verification completed with 2,130 tests passed, 3 skipped, and 0 failed. Both production and complete dependency audits report 0 vulnerabilities.

## Audit completion gate

Completion requires one complete repository-wide pass with no new findings. A complete pass covers application startup and settings, API and MCP, proxy protocols and mocking, interceptors, Electron and packaging, UI state and rendering, dependencies, documentation, and tests.

| Pass | Result | Clean-pass streak |
| --- | --- | ---: |
| 1 | 47 new bugs found and documented below | 0/1 |
| 2 | 47/47 fixed; repository-wide tests and dependency audits passed | 1/1 |

## Security and renderer boundaries

### BUG-377 — High — Imported traffic can inject persistent markup into the traffic table

- Status: **Fixed** — merged and verified on current `main`.
- Evidence: traffic import validates `method` and `source` only as strings (`src/api/api-server.js:816-847`), and backend HAR conversion preserves an arbitrary method (`:1336-1345`). `buildTrafficRowHtml()` places `req.method` raw in a class attribute and `source` raw in class/title attributes before assigning the result to `tbody.innerHTML` (`src/ui/app.js:1251-1297,1326-1340`).
- Impact: a crafted JSON/HAR import can create arbitrary elements or event-handler attributes in the authenticated Electron management origin, where captured traffic and privileged management operations are available.
- Reproduction: import a record whose method is `GET\" data-audit=\"present` or whose source contains the same attribute delimiter. The API returns 200, retains the string, and the rendered row contains the injected attribute instead of literal text.
- Expected: imported fields must be validated to their protocol grammar and escaped for their exact HTML context, or rendered with DOM properties.

### BUG-378 — High — Rule backups can inject persistent markup into the mock-rule renderer

- Status: **Fixed** — merged and verified on current `main`.
- Evidence: `isCompleteMockMatcher()` accepts any non-empty string as a method matcher (`src/proxy/mock-rule-validation.js:308-320`), and `.htkrules` imports retain matcher values after removing IDs (`src/api/api-server.js:119-143,1470-1496`). `mockRuleSummary()` returns the method verbatim, and `renderMockRuleRow()` inserts it raw into both a class and element content (`src/ui/app.js:6157-6166,6287-6318`). Breakpoint summaries have the same raw method-class sink (`:6533-6539`).
- Impact: opening an untrusted rule backup can inject active markup into the Electron management page.
- Reproduction: import a valid rule whose method matcher contains an inert closing-attribute/tag marker. Validation succeeds and the marker becomes a new DOM node when the rules list renders.
- Expected: constrain methods to valid HTTP tokens and context-escape every summary value.

### BUG-379 — High — Send header and form values are escaped as text inside quoted attributes

- Status: **Fixed** — merged and verified on current `main`.
- Evidence: `esc()` escapes text-node markup but not quotation marks (`src/ui/app.js:12115-12120`). Send headers and text form fields place `esc(...)` inside `value="..."` and then assign the string to `innerHTML` (`:8628-8650,8811-8825`). Captured/HAR headers reach these editors through Resend, and pasted cURL headers do too.
- Impact: a quoted captured or imported value can cross the `value` boundary and add attributes or markup when the user chooses Resend or imports cURL.
- Reproduction: load a Send header value containing `\" data-audit=\"present`; rerendering creates a `data-audit` attribute rather than showing the exact value.
- Expected: use `escapeHtmlAttribute()` or create inputs and assign `.value`.

### BUG-380 — High — Linux update URLs cross an HTML attribute boundary

- Status: **Fixed** — merged and verified on current `main`.
- Evidence: `validateDownloadUrl()` parses with `new URL(source)` but returns the original unnormalized string (`electron/updater.cjs:125-137`). Linux release notes or `UPDATE_URL` are forwarded unchanged (`:155-164,477-481`), then placed in a quoted `href` using a text-node escaper that does not encode quotes (`src/ui/app.js:13579-13595`).
- Impact: remote/custom-feed metadata can inject anchor attributes or markup into the authenticated Electron management origin.
- Reproduction: `https://updates.example/path\" data-audit=\"present` passes URL validation and reaches the markup unchanged; `new URL(value).href` would instead percent-encode the delimiters.
- Expected: return the normalized URL and set the anchor's `href` property, or apply attribute-context escaping.

## Proxy, mocking, API, and MCP

### BUG-381 — Medium — Valid prototype-named headers disappear or corrupt values across proxy/import paths

- Status: **Fixed** — merged and verified on current `main`.
- Evidence: Node accepts `__proto__` as an HTTP header name. Although `_rawHeadersToObject()` defines it safely, `_stripHopByHopHeaders()`, `_stripUpstreamHeaders()`, `_currentHeadersWithRawCase()`, and `_cleanTrailers()` copy fields into ordinary `{}` objects (`src/proxy/proxy-server.js:2442-2447,2789-2832,2858-2887`). Backend HAR conversion and the cURL parser do the same (`src/api/api-server.js:46-60`; `src/ui/curl-parser.js:44-65`).
- Impact: requests, responses, and trailers using this valid name are silently changed; inherited names such as `constructor` can also be combined with prototype values instead of the actual field.
- Reproduction: direct Node HTTP/1 and HTTP/2 origins retain an own `__proto__` header. Through `ProxyServer`, the request header, upstream response header, and request/response trailers are absent. A cURL or backend HAR import containing the name also loses it.
- Expected: header maps must use null prototypes or own-property definitions throughout.

### BUG-382 — Medium — HTTPS and native HTTP/2 webhook rules return 200 without sending a webhook

- Status: **Fixed** — merged and verified on current `main`.
- Evidence: plain HTTP dispatch implements webhook delivery in `_serveMockResponse()` (`src/proxy/proxy-server.js:8391-8410,8665-8746`). The intercepted HTTPS/HTTP-1 branch reaches its fixed-response default at `:5105-5119`, and native HTTP/2 reaches its fixed-response default at `:6514-6910`; neither branch handles `action.type === 'webhook'`.
- Impact: clients receive an empty successful mock response while the configured notification is never delivered or recorded as a delivery failure.
- Reproduction: the same webhook rule delivers for a plain HTTP target, but real intercepted HTTPS/1.1 and native H2 requests return empty 200 responses with zero requests at the webhook listener.
- Expected: every supported ingress protocol must execute the webhook action consistently.

### BUG-383 — Medium — Request transforms are followed by breakpoint matching against the original body

- Status: **Fixed** — merged and verified on current `main`.
- Evidence: each HTTP/1, HTTPS, H2, and H2-fallback path calculates `matcherBody` before `_applyMockRequestTransform()`, then passes that stale value to `_checkBreakpoint()` (`src/proxy/proxy-server.js:3932-3995,4688-5161,5648-5712,6083-6155`). Transformed method, URL, and headers are used, making the body exception internally inconsistent.
- Impact: a breakpoint intended to match the body actually sent upstream can miss, while a rule for content no longer sent can pause the request.
- Reproduction: transform a request body from `before` to `after`, add a body breakpoint for `after`, and send `before`; the origin receives `after` but the breakpoint does not trigger.
- Expected: post-transform breakpoint matching must use the transformed body.

### BUG-384 — Medium — Fixed mock responses accept informational-only status codes and then reset clients

- Status: **Fixed** — merged and verified on current `main`.
- Evidence: action validation and the editor allow fixed statuses 100-599 (`src/proxy/mock-rule-validation.js:85-90`; `src/ui/app.js:6918-6924`). Fixed response branches pass that value to HTTP/1 `writeHead()` or H2 `:status` as if it were final (`src/proxy/proxy-server.js:5105-5119,6880-6907,8957-8970`).
- Impact: accepted configurations such as 100 or 199 emit an informational response without a final response; HTTP/1 clients subsequently see `ECONNRESET`, and H2 behavior is likewise invalid.
- Reproduction: configure a fixed 199 response and request it with Node's HTTP client. The client receives information and then a reset instead of a completed response.
- Expected: fixed final responses must be limited to 200-599, or a distinct action must send informational plus final responses.

### BUG-385 — Medium — Global or sticky legacy regular-expression rules alternate between match and miss

- Status: **Fixed** — merged and verified on current `main`.
- Evidence: legacy rules explicitly support `RegExp` URL patterns (`src/proxy/mock-rule-validation.js:363-371`). `_findMockRule()` calls `.test()` without preserving `lastIndex` (`src/proxy/proxy-server.js:8190-8217`), even though the streaming precheck elsewhere saves/restores it.
- Impact: a `/pattern/g` or `/pattern/y` rule mutates itself, so identical requests can alternate between mocked and passed-through responses.
- Reproduction: install a legacy rule using `/example/g` and call `_findMockRule()` twice with the same URL; the first matches and the second misses.
- Expected: reset or restore `lastIndex` around every test.

### BUG-386 — Low/Medium — UTF-8 capture truncation can split a code point and report impossible byte metadata

- Status: **Fixed** — merged and verified on current `main`.
- Evidence: `_safeBodyString()` truncates a validated UTF-8 buffer at exactly 512 KiB before decoding (`src/proxy/proxy-server.js:9397-9444`). A multibyte code point crossing that byte boundary is decoded as the replacement character, whose encoded length is larger than the captured prefix.
- Impact: the displayed body is corrupted and `capturedSize` can exceed the actual retained source bytes, undermining export and truncation diagnostics.
- Reproduction: pass 524,287 ASCII bytes followed by a four-byte UTF-8 character. The result contains U+FFFD and reports `capturedSize: 524290` for a 524,288-byte slice.
- Expected: move the cut to a UTF-8 boundary while retaining byte-accurate metadata.

### BUG-387 — Medium/High — Create Mock turns binary bytes into literal data-URI text

- Status: **Fixed** — merged and verified on current `main`.
- Evidence: binary captures are represented as data URIs with encoding metadata (`src/proxy/proxy-server.js:9323-9339,9447-9452`; `src/ui/har-import.js:71-89`). Create Mock excludes only `[Binary ...]` placeholders from request-body matchers and drops response encoding (`src/ui/app.js:12037-12059`), while runtime matching sees raw bytes and fixed responses write the action string directly (`src/proxy/proxy-server.js:8223-8232,8957-8970`).
- Impact: derived rules fail to match binary requests and return ASCII `data:...;base64,...` instead of the captured response bytes.
- Reproduction: Create Mock from a binary POST or a tiny image response, then repeat the exchange.
- Expected: derive byte-aware rules or reject unsupported binary derivation clearly.

### BUG-388 — Medium — Derived mocks and breakpoints do not match non-default ports

- Status: **Fixed** — merged and verified on current `main`.
- Evidence: captured `req.host` is hostname-only (`src/ui/har-import.js:195-203`; native capture uses `targetUrl.hostname`). Create Mock and Create Breakpoint use it as a `host` matcher (`src/ui/app.js:12027-12035,12339-12354`), but runtime `host` matching compares `new URL(url).host`, which includes a non-default port; `hostname` is the portless matcher (`src/proxy/proxy-server.js:8248-8264`).
- Impact: rules derived from common development URLs such as `localhost:3000` never trigger for the very request they came from.
- Reproduction: a `host = 127.0.0.1` matcher fails for `http://127.0.0.1:3000/api`; changing only its type to `hostname` succeeds.
- Expected: derive a `hostname` matcher or retain the authority including port.

### BUG-389 — Medium — A scalar HTTPS whitelist is accepted, persisted, and crashes HTTPS handling

- Status: **Fixed** — merged and verified on current `main`.
- Evidence: `POST /api/https-whitelist` passes `req.body.hosts || []` without array validation (`src/api/api-server.js:2038-2048`). `setHttpsWhitelist()` stores any truthy value, while `_isHttpsWhitelisted()` later calls `.some()` (`src/proxy/proxy-server.js:2745-2764`).
- Impact: one accepted malformed setting makes HTTPS requests fail with `TypeError` and survives restart through settings persistence.
- Reproduction: POST `{ "hosts": "example.test" }`; the route reports success, then the next whitelist check throws because strings have no `.some()`.
- Expected: reject non-array/non-string entries before mutation and persistence.

### BUG-390 — Low/Medium — Missing client-certificate and trusted-CA files are reported as configured

- Status: **Fixed** — merged and verified on current `main`.
- Evidence: `setClientCertificates()` and `setTrustedCAs()` catch file-read failures and omit the loaded material while retaining the configured paths (`src/proxy/proxy-server.js:2708-2743`). Their API routes persist the values and return success (`src/api/api-server.js:1916-1922,1924-1979,2004-2022`).
- Impact: the UI and persisted settings claim TLS material is active although requests use neither the client certificate nor the trusted CA; typos and stale paths fail only in logs.
- Reproduction: add a nonexistent PFX or PEM path through the item endpoint. It returns success and lists the path, but the corresponding loaded-options array remains empty.
- Expected: reject unreadable files atomically or surface an explicit inactive/error state.

### BUG-391 — Medium — Traffic-list exclusions reject every IPv6 literal

- Status: **Fixed** — merged and verified on current `main`.
- Evidence: normalization preserves brackets for bracketed request hosts but permits only `[a-z\d*.-]` in patterns (`src/traffic/default-exclusions.js:51-59,76-106`). Bare `::1`, bracketed `[::1]`, and `http://[::1]/...` all fail validation.
- Impact: users cannot hide/allowlist IPv6 traffic even though the proxy supports IPv6 targets.
- Reproduction: `normalizeDefaultExclusions(['::1'])`, `['[::1]']`, and `['http://[::1]/api']` each throw `invalid hostname pattern`.
- Expected: canonicalize and match valid bracketed/bare IPv6 literals.

### BUG-392 — Low — Repeated traffic-search query keys produce 500 responses

- Status: **Fixed** — merged and verified on current `main`.
- Evidence: Express represents duplicate keys as arrays. `/api/traffic` calls `filter.toLowerCase()`, and `/api/traffic/search` calls `method.toUpperCase()`/`status.endsWith()` without scalar validation (`src/api/routes/traffic-routes.js:51-74,133-155`).
- Impact: malformed but ordinary query syntax becomes an internal error instead of a stable 400 response.
- Reproduction: request `/api/traffic?filter=a&filter=b` or `/api/traffic/search?method=GET&method=POST`; the handler throws `TypeError` and returns 500.
- Expected: reject repeated scalar parameters or define deterministic multi-value semantics.

### BUG-393 — Medium — MCP search returns lifecycle identities that request detail cannot select

- Status: **Fixed** — merged and verified on current `main`.
- Evidence: `search_traffic` returns both `id` and `trafficLifecycleId` (`src/mcp/mcp-server.js:619-631`), but `get_request_detail` accepts only `request_id` and selects the first matching ID (`:405-442,651-676`). `select_request` already supports the lifecycle discriminator (`:1005-1025`), and the HTTP detail route returns 409 for an ambiguous ID.
- Impact: when request IDs are reused, an MCP client can see multiple distinct results but can retrieve only the oldest record's bodies/details.
- Reproduction: seed two records with the same ID and different lifecycle IDs. Search returns both; detail for that ID always returns the first body.
- Expected: accept `traffic_lifecycle_id` and reject ambiguous ID-only lookups.

### BUG-394 — Medium — Edits made while a traffic-list save is in flight are silently discarded

- Status: **Fixed** — merged and verified on current `main`.
- Evidence: controls remain editable and call `markTrafficListsChanged()` (`src/ui/app.js:10024-10056,10190-10205`). `saveTrafficLists()` snapshots state into the request but, on response, replaces live state with the submitted server echo and clears dirty state (`:10429-10447`; `synchronizeTrafficLists()` at `:10087-10103`). The generation guard detects only another save, not intervening edits.
- Impact: a slow save response overwrites newer rules while showing “All changes saved.”
- Reproduction: delay the PUT response, edit a pattern after clicking Save, then release the old response; the later edit disappears and the save button disables.
- Expected: lock editing, merge/reapply newer edits, or compare a mutation generation before synchronizing.

## Interceptors

### BUG-395 — High — Android status refresh can resurrect stopped ownership and its recovery journal

- Status: **Fixed** — merged and verified on current `main`.
- Evidence: manager `getAll()` calls `isActive()` outside the per-interceptor lifecycle lock (`src/interceptors/interceptor-manager.js:180-192`). Android reconciliation snapshots active records, awaits ADB queries, then mutates the map/journal without confirming the record is still current (`src/interceptors/android-adb-interceptor.js:361-467,574-625,1931-1975`).
- Impact: a successful Stop can be undone in memory and durably; a stale refresh can also overwrite a newer activation's cleanup baseline.
- Reproduction: pause an Android status query, complete manager deactivation, then resolve the stale query as active. The device reappears in `activatedDevices` and the deleted recovery file is recreated.
- Expected: discard results whose record/reference or lifecycle generation was superseded.

### BUG-396 — High — JVM status refresh can resurrect old state or delete newer PID ownership

- Status: **Fixed** — merged and verified on current `main`.
- Evidence: `_syncActivatedProcesses()` snapshots a PID record, awaits identity classification, and then sets/forgets ownership by PID without verifying that the map still contains that record (`src/interceptors/jvm-interceptor.js:292-319,621-639`). Manager status calls run outside the lifecycle lock (`src/interceptors/interceptor-manager.js:180-192`).
- Impact: stale status can resurrect a stopped target; a stale `gone/replaced` result can delete a newer activation and its journal, leaving JVM proxy/TLS changes without restoration ownership.
- Reproduction: pause classification for an old PID record, replace or deactivate it, then resolve the old classification; the old record returns or the replacement disappears.
- Expected: guard every post-await mutation with record identity/generation checks.

### BUG-397 — High — Android Stop clears ownership before the companion VPN has stopped

- Status: **Fixed** — merged and verified on current `main`.
- Evidence: `_deactivateHttpToolkitApp()` treats successful `am start -W` output as teardown completion, removes the reverse tunnel, and returns without calling `_getHttpToolkitVpnStatus()` (`src/interceptors/android-adb-interceptor.js:1155-1182`). `-W` waits for activity launch, while the companion completes VPN shutdown asynchronously.
- Impact: Stop can report success and delete recovery ownership while the VPN remains active or teardown failed, leaving the device without connectivity and no retryable cleanup record.
- Reproduction: mock `Status: ok` while VPN status remains active; deactivation returns true and performs zero status readbacks.
- Expected: confirm VPN inactivity before removing the tunnel or ownership.

### BUG-398 — Medium — An empty Windows `ProxyServer` value consumes the next registry row

- Status: **Fixed** — merged and verified on current `main`.
- Evidence: the `ProxyServer` parser uses `\s+` around `REG_SZ`, allowing CR/LF consumption (`src/interceptors/system-proxy-interceptor.js:207-220`), while the adjacent override parser correctly limits whitespace to spaces/tabs.
- Impact: activation journals a bogus server and Stop/crash recovery writes part of the `ProxyOverride` row into `ProxyServer`, corrupting the user's proxy baseline.
- Reproduction: parse `reg query` output with an empty `ProxyServer` followed by `ProxyOverride`; the reported server becomes `ProxyOverride  REG_SZ ...` instead of empty.
- Expected: horizontal whitespace must not cross registry rows.

### BUG-399 — Medium — JVM attach-helper cache accepts corrupt bytecode indefinitely

- Status: **Fixed** — merged and verified on current `main`.
- Evidence: `_ensureAttachHelper()` checks only that `AttachProxy.class` exists and the separate source-hash stamp matches (`src/interceptors/jvm-interceptor.js:1166-1199`). It validates neither class content nor size, unlike the agent-JAR cache.
- Impact: a zero-byte/tampered helper is reused for every attach until the cache is manually deleted; modified bytecode is executed as the FreeKit user.
- Reproduction: write a zero-byte class plus the correct source stamp. `_ensureAttachHelper()` returns it with zero compiler calls.
- Expected: validate cached class integrity and rebuild invalid content.

### BUG-400 — Medium — Browser `openUrl()` reports success after an immediate nonzero exit

- Status: **Fixed** — merged and verified on current `main`.
- Evidence: both launch paths resolve on the child `spawn` event, immediately unref, and never observe exit status (`src/interceptors/browser-interceptor.js:453-529`).
- Impact: API/UI says a URL opened even when no browser accepted it.
- Reproduction: use `process.execPath` as the configured browser with arguments that exit 9; direct execution exits 9, while `openUrl()` returns `{ success: true }`.
- Expected: distinguish a confirmed handoff/zero exit from an immediate nonzero failure.

### BUG-401 — Low — Existing-terminal CMD instructions expand percent sequences in valid paths

- Status: **Fixed** — merged and verified on current `main`.
- Evidence: generated `set "NAME=value"` commands do not escape percent expansion (`src/interceptors/terminal-interceptors.js:64-65,93-102`).
- Impact: certificate paths containing `%NAME%` are changed when pasted; inherited values containing CMD metacharacters can alter the command.
- Reproduction: generate instructions for `C:\%WINDIR%\http-freekit-ca.pem`; real `cmd.exe` sets `SSL_CERT_FILE=C:\C:\Windows\http-freekit-ca.pem`.
- Expected: preserve literal filesystem paths under CMD expansion rules.

### BUG-402 — Low — Docker instructions misquote commas and shell substitutions in mount paths

- Status: **Fixed** — merged and verified on current `main`.
- Evidence: mount syntax is emitted as `--mount type=bind,source="...",target=...,readonly` (`src/interceptors/docker-interceptor.js:102-125`). POSIX shell parsing removes the inner quotes before Docker's CSV parser sees the value, while double quotes still evaluate command substitutions.
- Impact: valid comma-containing certificate paths split into bogus mount fields, and special shell syntax in a path is evaluated when instructions are pasted.
- Reproduction: shell-tokenize the generated command for `/tmp/a,b.pem`; Docker receives `type=bind,source=/tmp/a,b.pem,...`, where `b.pem` is a separate CSV field.
- Expected: quote the entire `--mount` value with syntax safe for the target shell/Docker parser.

## Send, import/export, and UI behavior

### BUG-403 — High — Pasted cURL commands inherit stale credentials and bodies from the active Send tab

- Status: **Fixed** — merged and verified on current `main`.
- Evidence: cURL paste replaces headers only when the parsed set is nonempty and replaces body only when `hasData` is true; it never resets body type, URL-encoded fields, or multipart fields (`src/ui/app.js:13619-13627`). The existing header reset helper is at `:8886-8893` but is skipped for headerless commands.
- Impact: pasting a request for a new host can send the previous tab's Authorization header or body to that host.
- Reproduction: populate Authorization and a body, then paste `curl https://other.example.test/path`; the new URL appears while the old sensitive state remains authoritative.
- Expected: cURL import must atomically replace the entire request, including omitted state.

### BUG-404 — High — Resend encodes captured binary bodies as data-URI text

- Status: **Fixed** — merged and verified on current `main`.
- Evidence: binary captures/HAR bodies use a base64 data URI plus `requestBodyEncoding` (`src/ui/har-import.js:71-89,195-206`; `src/proxy/proxy-server.js:9323-9339,9447-9452`). Resend copies only the display string (`src/ui/app.js:1685-1740`), and raw Send encodes it as UTF-8 (`:9738-9741`); the API decodes bytes only when explicitly told `base64` (`src/api/api-server.js:2812-2816,2981`).
- Impact: replay silently changes arbitrary request bytes and can make signed uploads/protocol messages invalid.
- Reproduction: capture bytes `00 ff 41`, choose Resend, and send. The wire body is the ASCII text `data:application/octet-stream;base64,AP9B` instead of three bytes.
- Expected: preserve encoding provenance and original bytes, or reject exact replay.

### BUG-405 — High — Content-encoded requests replay decoded bytes with the original encoding metadata

- Status: **Fixed** — merged and verified on current `main`.
- Evidence: streaming capture passes `Content-Encoding` to `_safeBodyString()`, which decompresses for display (`src/proxy/proxy-server.js:918-930,9397-9444`). Resend keeps `Content-Encoding` (`src/ui/app.js:1697-1705`), and snippet export keeps it plus stale `Content-Length` (`src/ui/request-export.js:25-32,299-321`).
- Impact: replay/export labels plaintext as gzip/br/etc.; recipients fail decoding, and generated snippets can also advertise the old compressed byte count.
- Reproduction: capture `gzip("hello")`; generated cURL contains `content-encoding: gzip`, the compressed content length, and `--data-raw 'hello'`.
- Expected: retain compressed bytes, recompress, or remove incompatible headers with an explicit semantic-replay warning.

### BUG-406 — Medium — Imported or resent custom HTTP methods silently become GET

- Status: **Fixed** — merged and verified on current `main`.
- Evidence: the Send method select contains only seven verbs (`src/ui/index.html:233-235`). Resend/restored state and cURL paste assign arbitrary methods (`src/ui/app.js:9526-9529,13619-13621`); a missing option leaves the value empty, and `/api/send` defaults an empty method to GET (`src/api/api-server.js:2257-2263`).
- Impact: TRACE, PROPFIND, PATCH-like extensions, and other valid tokens are sent with different semantics without warning.
- Reproduction: paste `curl -X PROPFIND https://example.test/resource`; the selector is blank and the outbound method is GET.
- Expected: preserve arbitrary valid HTTP tokens or reject unsupported verbs visibly.

### BUG-407 — Medium — Supported cURL options make explicit GET order-dependent

- Status: **Fixed** — merged and verified on current `main`.
- Evidence: the parser initializes to GET, applies `-X GET`, then promotes any current GET to POST when it sees data (`src/ui/curl-parser.js:64-65,106-139`). It cannot distinguish default GET from an explicit method.
- Impact: semantically equivalent cURL commands import as different methods.
- Reproduction: `curl -X GET URL --data q=one` parses as POST, while `curl --data q=one -X GET URL` parses as GET; real cURL sends GET with a body in both orders.
- Expected: explicit `-X` must remain authoritative regardless of option order.

### BUG-408 — Medium — Unsupported cURL options can be mistaken for the destination URL

- Status: **Fixed** — merged and verified on current `main`.
- Evidence: the parser handles a small exact-token set and treats the first non-dash token as the URL (`src/ui/curl-parser.js:106-160`). It has no generic option-operand skipping and no attached/`--name=value` support.
- Impact: common commands are silently imported as different requests rather than rejected.
- Reproduction: `curl --proxy http://proxy.example:3128 https://target.example/path` imports the proxy as the destination; `curl --request=POST https://target.example/path` remains GET. Attached `-XPOST` has the same problem.
- Expected: parse supported cURL grammar or return an explicit unsupported-option error.

### BUG-409 — Medium — PowerShell and PHP multipart exports collapse duplicate text fields

- Status: **Fixed** — merged and verified on current `main`.
- Evidence: request export represents multipart entries in order but PowerShell emits repeated `$form['name'] = ...` assignments and PHP emits duplicate keys in one associative array (`src/ui/request-export.js`, multipart PowerShell/PHP generators).
- Impact: valid multipart bodies with repeated field names are not replayed; only the final value survives.
- Reproduction: export two text parts named `tag` with values `one` and `two`; both generated programs overwrite `one` with `two` before sending.
- Expected: use repeat-capable multipart APIs or mark exact replay unavailable for those formats.

### BUG-410 — Medium — Browser Fetch multipart export reuses the first file for every file part

- Status: **Fixed** — merged and verified on current `main`.
- Evidence: every generated file variable reads the identical `document.querySelector('input[type="file"]').files[0]` expression (`src/ui/request-export.js:154-165`).
- Impact: a multipart request containing multiple different files sends the same first file for every part.
- Reproduction: export parts `front.png` and `back.png`; `file0` and `file1` both reference the first input's first file.
- Expected: generate distinct selectors/indexes or return an unavailable template.

### BUG-411 — Low/Medium — Fetch snippets with GET or HEAD bodies are guaranteed to throw

- Status: **Fixed** — merged and verified on current `main`.
- Evidence: raw and multipart Fetch generators add every nonempty body without a GET/HEAD guard (`src/ui/request-export.js:154-169,339-349`). Browser Fetch forbids bodies for those methods.
- Impact: the advertised snippet fails before making any network request.
- Reproduction: export a captured GET with a body and execute the JavaScript Fetch snippet; the constructor/request rejects.
- Expected: generate a compatible alternative or state that this replay is unavailable.

### BUG-412 — Medium — JSON traffic export ignores Traffic Lists and Safe Fonts export settings

- Status: **Fixed** — merged and verified on current `main`.
- Evidence: settings say Traffic Lists affect exports and Safe Fonts are filtered (`src/ui/index.html:379-387`). Renderer JSON export serializes the raw global `requests` array (`src/ui/app.js:10551-10573`), whereas server exports apply lists and HAR also applies font/tunnel settings (`src/api/routes/traffic-routes.js:103-130`; `src/api/api-server.js:796-813`).
- Impact: requests users deliberately hid can be disclosed in exported JSON.
- Reproduction: blacklist `hidden.example` and enable Safe Fonts filtering; hidden rows still appear in renderer JSON export.
- Expected: all traffic export formats must honor the stated filters consistently.

### BUG-413 — Medium — Malformed protobuf imports persistently replace the last working schema set

- Status: **Fixed** — merged and verified on current `main`.
- Evidence: schema save writes local storage and swaps live files before parsing (`src/ui/app.js:3208-3216`); failed rebuilding leaves `protobufRoot = null` (`:3170-3194`). Import has no rollback after merging/replacing (`:3226-3252`).
- Impact: one malformed import disables prior decoding, persists across restart, and requires manual clearing/reimport.
- Reproduction: import a valid schema, then a malformed replacement with the same filename; the error is shown after the invalid set is already durable and active decoding stops.
- Expected: validate a candidate root before committing live/durable state.

### BUG-414 — Medium — Mobile CSS stacks the Send tab strip inside a fixed 38-pixel height

- Status: **Fixed** — merged and verified on current `main`.
- Evidence: at widths up to 768px, `#panel-send > div` applies `flex-direction: column` to both direct children (`src/ui/styles.css:3939-3946`). Those children include the tab bar, which remains a 38px-high flex container (`src/ui/index.html:225-228`; `styles.css:4241-4259`).
- Impact: multiple tabs and the add button stack vertically into a one-row viewport and become clipped/difficult to reach.
- Reproduction: open two Send tabs and resize the viewport to 768px or narrower.
- Expected: only the Send content panel should stack; the tab strip should remain horizontally usable.

### BUG-415 — Low/Medium — HAR WebSocket handshakes are imported as ordinary HTTP

- Status: **Fixed** — merged and verified on current `main`.
- Evidence: HAR normalization maps HTTP/2 specially, HTTPS URLs to `https`, and every other scheme—including `ws`/`wss`—to `http` (`src/ui/har-import.js:195-203`). The renderer enables WebSocket behavior only for `ws`/`wss` (`src/ui/app.js:128-134`).
- Impact: valid WebSocket handshakes lose their presentation, frame affordances, and secure-WebSocket metadata.
- Reproduction: import a status-101 `wss://socket.example.test/chat` HAR entry; its protocol becomes `http`.
- Expected: preserve `ws` and `wss` schemes.

### BUG-416 — Low — Imported HTTP version metadata is ignored in request details

- Status: **Fixed** — merged and verified on current `main`.
- Evidence: HAR normalization preserves request/response HTTP version (`src/ui/har-import.js:128-161,210,224`), but detail rendering hard-codes HTTP/2, HTTP/1.1, or the nonstandard `HTTPS/1.1` label (`src/ui/app.js:2404-2414`).
- Impact: imported HTTP/1.0 and other versions are shown incorrectly despite carrying exact metadata.
- Reproduction: import an HTTP/1.0 HAR exchange and open details; it displays HTTP/1.1/HTTPS/1.1.
- Expected: display preserved version fields when available.

### BUG-417 — Low — Keyboard focus lands on fully transparent actions

- Status: **Fixed** — merged and verified on current `main`.
- Evidence: mock action buttons and decoded-value copy buttons are natively focusable (`src/ui/app.js:6322-6374,3870-3871`), but their containers use `opacity: 0` and reveal only on pointer hover, with no `:focus-within` rule (`src/ui/styles.css:1444-1457,3564-3573`).
- Impact: keyboard users tab through invisible controls, and inherited opacity also hides their focus outline.
- Reproduction: navigate those views using Tab without moving the pointer; focus stops on controls that remain invisible.
- Expected: reveal action groups on focus or remove hidden controls from tab order.

## Electron, build, documentation, and dependencies

### BUG-418 — Medium — A hung renderer blocks Quit before backend cleanup begins

- Status: **Fixed** — merged and verified on current `main`.
- Evidence: `runQuitCleanup()` awaits `webContents.executeJavaScript()` without a deadline and does not destroy the window or call server shutdown until it settles (`electron/quit-cleanup.cjs:9-33`). `electron/main.cjs:599-629` retains the pending `quitCleanupPromise`, so later quit requests return early.
- Impact: a frozen renderer prevents normal Quit indefinitely; force termination can bypass interceptor and system/device proxy restoration.
- Reproduction: provide a live `webContents` whose `executeJavaScript()` never settles. Cleanup remains pending with zero destroy/shutdown calls.
- Expected: bound renderer preflight independently and always continue to backend cleanup.

### BUG-419 — Low/Medium — Packaged path rewriting targets an ancestor `app.asar`

- Status: **Fixed** — merged and verified on current `main`.
- Evidence: server startup uses unanchored `.replace('app.asar', 'app.asar.unpacked')` (`electron/main.cjs:92-96`), while MCP launch replaces the first exact segment named `app.asar` (`electron/mcp-launch.cjs:17-22`). Neither ensures it rewrites the archive under `resources`.
- Impact: desktop server startup fails when a checkout/custom install parent contains `app.asar`; packaged MCP fails when an ancestor segment has that exact name.
- Reproduction: resolving from `C:\apps\app.asar-builds\HTTP FreeKit\resources\app.asar\electron` rewrites the parent substring and leaves the real archive untouched.
- Expected: target only the terminal `resources/app.asar` segment.

### BUG-420 — Low — Desktop API-port discovery has a release-and-rebind race

- Status: **Fixed** — merged and verified on current `main`.
- Evidence: `findFreePort()` binds port 0, records it, and closes the listener (`electron/main.cjs:65-73`); a later child process independently binds that released number (`:79-121`). There is no listener handoff or retry.
- Impact: another local process can claim the port in between, producing `EADDRINUSE`, a Startup Error, and app exit.
- Reproduction: bind the returned port after discovery resolves but before spawning `src/index.js`.
- Expected: reserve/hand off the socket or retry port allocation on bind collision.

### BUG-421 — Low/Medium — Desktop server logging grows without bound across launches

- Status: **Fixed** — merged and verified on current `main`.
- Evidence: desktop always targets the same `server.log` (`electron/main.cjs:82-89`) and opens it permanently in append mode (`electron/server-log.cjs:86`). No size cap, truncation, rotation, or retention policy exists.
- Impact: repeated TLS/upstream errors or sustained remote traffic can eventually exhaust the user's volume.
- Reproduction: repeatedly trigger logged upstream failures and restart; the same file grows monotonically.
- Expected: rotate or bound persistent diagnostic logs.

### BUG-422 — Low — README promises background Linux updates that are always manual

- Status: **Fixed** — merged and verified on current `main`.
- Evidence: the desktop update documentation says updates download in the background without a platform qualification and lists Linux support (`README.md:196-205`). Every Linux path instead prompts “Open Download Page” and only calls `shell.openExternal()` (`electron/updater.cjs:341-359`), including AppImage.
- Impact: Linux users are given incorrect update behavior and deployment expectations.
- Reproduction: offer an update to a packaged Linux build; it opens a browser and requires manual download/install.
- Expected: implement the documented behavior where supported or document Linux's manual flow.

### BUG-423 — High — The locked dependency graph fails the project's production security gate

- Status: **Fixed** — merged and verified on current `main`.
- Evidence: `npm run audit:prod` reports two high-severity production vulnerabilities (`fast-uri` 3.0.0-3.1.4 host confusion and `js-yaml` 4.0.0-4.3.0 quadratic CPU use) plus three moderate findings through DOMPurify/Monaco and Hono. Full `npm run audit` adds high-severity `brace-expansion` 5.0.0-5.0.8. The CI workflow runs the high-level audit (`.github/workflows/ci.yml:30-33`).
- Impact: current clean installs contain known vulnerable transitive code, and the repository's own audit job fails.
- Reproduction: run `npm run audit:prod` (2 high, 3 moderate) or `npm run audit` (3 high, 3 moderate); both exit nonzero.
- Expected: the committed lockfile should pass the configured audit threshold, with any accepted advisory documented and scoped explicitly.

## Original discovery-pass verification

- Reviewed all 51 tracked files under `src/**`, all 19 files under `electron/**`, root/build/scripts/workflow/documentation files, assets, and the complete tracked test inventory.
- Baseline `npm test`: 1,774 tests; 1,772 passed, 0 failed, 2 environment-dependent skips.
- Focused proxy suite: 182 passed, 0 failed.
- Full interceptor suite: 518 tests; 516 passed, 0 failed, 2 environment-dependent skips.
- UI-related suites: 1,385 tests; 1,383 passed, 0 failed, 2 environment-dependent skips; all seven UI JavaScript files passed `node --check`.
- Build/desktop suites: 167 passed, 0 failed; all tracked non-`src` JavaScript/CJS files passed syntax checking.
- Focused runtime harnesses exercised every finding above. At the time of the original audit, `npm run audit` and `npm run audit:prod` failed as recorded in BUG-423; both now pass with 0 vulnerabilities.
