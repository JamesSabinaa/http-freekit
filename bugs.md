# Repository bug audit

This ledger records findings from a repository-wide audit of `main` at `b97e8f2`.
The audit covers startup and settings, the management API and MCP, proxy protocols
and mocking, certificates, interceptors, Electron lifecycle and packaging, renderer
behavior, styling and accessibility, dependencies, documentation, tests, and dead
code. Findings are documented only; this audit does not change product code.

## Completion gate

Completion requires two consecutive complete passes over the current candidate with
no new bugs, broken features, broken styling, or dead code. A pass that finds
anything resets the clean-pass streak.

| Pass | Result | Clean-pass streak |
| --- | --- | ---: |
| 1 | 5 new findings confirmed through source tracing and live-browser diagnostics | 0/2 |
| 2 | 1 new runtime integration failure confirmed in the shipped renderer | 0/2 |
| 3 | **Clean** — complete cross-domain source review, route interaction smoke test, runtime exception trace, and static/dependency checks | 1/2 |
| 4 | 1 new broken theme feature confirmed while independently checking the rendered theme variants | 0/2 |
| 5 | **Clean** — UI/runtime value-contract, asset-resolution, startup-order, failure-marker, and package-surface review | 1/2 |
| 6 | **Clean** — renderer/API route-parity, backend validation/lifecycle, fresh-browser bootstrap, and full verification review | **2/2** |

## Findings

### BUG-001 — Medium — Built-in Dark and Light theme text fails WCAG AA contrast

- **Status:** Open.
- **Evidence:** live Lighthouse accessibility audits of Intercept, View, Mock,
  Send, and every Settings section in Dark report contrast failures. The orange
  `--pop-color` text is only 3.58:1 against the footer, 2.95:1 against Settings
  cards, and 2.65:1 on an active Settings navigation item; the Mock “Add a new
  rule” label is 3.69:1. Light also renders the active navigation item at 3.32:1
  and footer values at 3.75:1. Normal text requires 4.5:1. These combinations
  come from the theme tokens and contextual rules in `src/ui/styles.css`, plus
  inline `color:var(--pop-color)` uses in `src/ui/index.html:671-672`.
- **Impact:** port values, active Settings navigation, Settings values, and the
  primary add-rule affordance are hard to read for low-vision users and fail
  WCAG 1.4.3. Depending on the route, Lighthouse's accessibility score falls to
  0.91–0.97.
- **Coverage gap:** `test/ui/theme-contrast.test.js` checks selected token pairs,
  but not the actual `color-mix()` backgrounds or inline foreground/background
  combinations rendered in these controls.
- **Expected:** every normal-text foreground/background pair in each built-in
  theme should have a contrast ratio of at least 4.5:1, including active,
  disabled, footer, and card states.

### BUG-002 — Medium — Generated primary controls override their visible labels with different accessible names

- **Status:** Open.
- **Evidence:** Interceptor cards render a button containing the interceptor name,
  description, and state, then replace that content's accessible name with an
  action-only `aria-label` such as “Start intercepting Chrome”
  (`src/ui/app.js:6260-6305`). The manual “Anything” card is similarly renamed
  “Show manual proxy setup instructions” (`:6333-6343`). Mock-rule disclosure
  buttons visibly contain method, matcher, and action text but are renamed only
  “Show rule details” or “Collapse rule details” (`:7990-8018`). Lighthouse's
  `label-content-name-mismatch` audit flags the live Intercept cards and default
  Mock rule.
- **Impact:** speech-input users cannot reliably activate these controls using
  their full visible labels, while screen-reader users hear a different label
  from the information shown on screen. This fails the WCAG 2.5.3 label-in-name
  requirement.
- **Expected:** keep the visible identifying text in the computed accessible name
  and expose action/state without replacing it (for example, with a label that
  contains the visible text or with separately associated descriptive text).

### BUG-003 — Medium — Mock and Send expose invalid ARIA control structures

- **Status:** Open.
- **Evidence:** each `.mock-rule-card` is a plain draggable `div` with
  `aria-expanded`, although that attribute is not permitted for its implicit
  generic role; the nested disclosure button already carries the valid expanded
  state (`src/ui/app.js:8004-8018`). The Send tab list contains presentation
  wrappers with both a tab and a close button and appends a “New request tab”
  button directly to the tab list (`src/ui/app.js:10861-10919`), although a
  `tablist` requires owned `tab` children. Lighthouse reports
  `aria-allowed-attr` on Mock and `aria-required-children` on Send.
- **Impact:** assistive technologies can ignore or misrepresent expansion state
  and tab membership, making rule navigation and request-tab management
  unreliable.
- **Expected:** put expanded state only on a control/role that supports it, and
  structure the request tabs so the tab list owns only tabs while close/add
  actions remain valid, separately operable controls.

### BUG-004 — Low — Backend and interceptor compatibility APIs and state have no production consumer

- **Status:** Open (dead code).
- **Evidence:** `ApiServer._transferTrafficGeneration()` is declaration-only
  (`src/api/api-server.js:2703-2709`). `ProxyServer._normalizeNoProxyEntries()`
  and `_normalizeTlsHostname()` are declaration-only while live code calls the
  imported normalization helpers directly (`src/proxy/proxy-server.js:2992-2994,
  3372-3374`). `filterDefaultExclusions()` has no caller, and
  `matchesDefaultExclusion()` is used only by tests
  (`src/traffic/default-exclusions.js:205-212`). System Proxy's
  `activeWinHttpSettings` and Existing Terminal's `proxyPort` are only assigned
  or cleared and are never read
  (`src/interceptors/system-proxy-interceptor.js:23,649,734,843,874,951`;
  `src/interceptors/terminal-interceptors.js:1582,1594,1617`).
- **Impact:** unused alternate APIs and write-only state enlarge the maintenance
  and test surface while suggesting lifecycle behavior that the product does not
  implement through those fields.
- **Expected:** remove the wrappers, unused export, and write-only fields; test
  the production normalization and filtering entry points directly.

### BUG-005 — Low — Renderer declarations and legacy stylesheet blocks are orphaned

- **Status:** Open (dead code).
- **Evidence:** production cross-reference finds declaration-only
  `parseTrafficViewHash()`, `parseTrafficViewLifecycleHash()`,
  `contentTypeToMonacoLanguage()`, `toggleHexView()`, deprecated no-ops
  `updateSendBodyPreview()`/`toggleSendBodyView()`, and `tryPrettyJson()` in
  `src/ui/app.js`. `loadSendHeadersFromJson()` is called only by test harnesses.
  `INTERCEPTOR_COLORS`, renderer `MOCK_MATCHER_TYPES`, `methodColor`, and
  `perspectiveLabels` are unused. Queries for nonexistent `mockBadgeCount` and
  `manualProxyPort` elements remain, with the latter supplied only by a test
  stub. Orphan CSS includes the old header/search/sidebar fragments
  (`src/ui/styles.css:520-566,620-687`), detail tabs/sections/header tables
  (`:1239-1386`), legacy panel/mock form selectors (`:2303-2359`),
  `.settings-section` (`:2531-2546`), and the removed Send form/response and
  footer-child selectors (`:2890-2945,3047-3052`).
- **Impact:** stale code is shipped to every renderer, tests preserve pseudo-APIs
  that users cannot reach, and obsolete CSS obscures which layout rules still
  affect the product.
- **Expected:** remove orphan declarations and selectors, and migrate tests from
  test-only renderer helpers to live production entry points.

### BUG-006 — Medium — Pako fails to load, breaking every compressed gRPC preview

- **Status:** Open.
- **Evidence:** the page loads Monaco's AMD loader before the Pako UMD bundle
  (`src/ui/index.html:679-692`). In a live Chrome renderer, Pako's anonymous AMD
  registration throws `Error: Can only have one anonymous define call per script
  file` from Monaco's loader, leaving `typeof window.pako === "undefined"` on
  every route. `decompressGrpcMessage()` requires `window.pako.Inflate` and
  otherwise throws “streaming pako decompression is not available”
  (`src/ui/app.js:4962-4985`). The same startup also logs a duplicate
  `vs/editor/editor.main` module warning, showing that the foreign UMD registration
  is contaminating Monaco's module queue.
- **Impact:** any gRPC or Connect message whose compressed flag is set and whose
  encoding is gzip or deflate cannot be decompressed or decoded in the body
  viewer. Users receive only an “unable to decompress” diagnostic for valid
  captured traffic.
- **Coverage gap:** `test/ui/grpc-decompression-limits.test.js` imports Pako as a
  Node module and injects a handcrafted `window.pako`, while dependency tests
  check that the bundle exists but never load the real script sequence from
  `index.html`.
- **Expected:** load Pako without registering it into Monaco's AMD loader (for
  example, before the loader is installed or as an explicit module) and add a
  browser-level bootstrap test that proves `window.pako.Inflate` is available
  without uncaught startup exceptions.

### BUG-007 — Medium — The advertised High Contrast theme cannot be selected

- **Status:** Open.
- **Evidence:** Settings offers `<option value="high-contrast">High Contrast</option>`
  (`src/ui/index.html:580-584`) and the README advertises it as a built-in theme
  (`README.md:182-189`), but `VALID_THEME_SELECTIONS` contains only `dark`,
  `light`, `auto`, and `custom` (`src/ui/app.js:16725`). `setTheme()`
  rejects anything outside that list before applying or persisting it
  (`:17027-17036`). A live selection attempt returns `false`, retains the prior
  `data-theme` and stored selection, and shows “Theme selection is invalid”. In
  addition, only Dark and Light Monaco themes are defined (`:16374,16418`), and
  both `getMonacoTheme()` and `setTheme()` map every non-Light palette to the
  Dark editor theme (`:16665-16668,17060`).
- **Impact:** the accessibility-oriented theme is unreachable from the product
  despite its complete CSS palette and visible Settings option. The dropdown can
  temporarily display High Contrast while the page still uses the prior colors,
  which makes the setting actively misleading.
- **Coverage gap:** `test/ui/theme-contrast.test.js` validates the dormant
  high-contrast CSS variables but never exercises the Settings option through
  `setTheme()` or verifies persistence and reload behavior.
- **Expected:** accept, apply, persist, and restore `high-contrast`, define a
  matching high-contrast editor theme, and cover the real selection path in
  addition to auditing its CSS tokens.

## Validation notes

- Repository-pinned runtime: Node.js 26.7.0.
- Two independent serialized suite runs each report 2,459 total; 2,455 passed;
  0 failed; 4 intentional environment skips.
- Production and full dependency audits report zero vulnerabilities.
- Source syntax checks and `git diff --check` pass.
- Live Chrome checks covered all five primary routes at the supported 700×600
  minimum and the 1366×768 default, with accessibility audits for all primary
  routes and all Settings sections.
- A fresh-browser bootstrap trace and read-only management-API/asset smoke test
  found no additional failures beyond the documented Pako/Monaco integration.
