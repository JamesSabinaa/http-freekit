# Bug audit resolution

## Outcome

All 91 findings in the current repository-wide audit were reviewed against the repository-pinned Node.js 26.7.0 runtime.

- **86 clear bugs were resolved**, with regression coverage added for the affected behavior and failure paths.
- **5 findings were retained without code changes** because they were cleanup-only observations or did not reproduce on the supported runtime.
- **0 clear actionable bugs remain open** in this ledger.

The fixes cover startup and settings, API and MCP behavior, HTTP/1.1 and HTTP/2 proxying, CONNECT and WebSocket handling, mocking and capture, certificates and trust, interceptors, Electron lifecycle and packaging, import/export, Send workspace persistence, renderer behavior, accessibility, styling, and dependency safety.

## Completion gate

Completion required two consecutive, independent, complete read-only audit passes with no new clear findings. Any finding reset the streak and was fixed before the gate restarted.

| Pass | Result | Validation |
| --- | --- | --- |
| 1 | **Clean** | Full diff and cross-domain review; 2,459 tests, 2,455 passed, 0 failed, 4 intentional environment skips; focused terminal/identity and Send/MCP/backup suites clean; syntax, diff, and dependency checks clean. |
| 2 | **Clean** | Independent full-diff review; 2,459 tests, 2,455 passed, 0 failed, 4 intentional environment skips; changed production syntax, diff, and both dependency audits clean. |

## Retained findings

### BUG-468 — Backend/interceptor compatibility paths and state have no production consumer

- **Disposition:** Retained as cleanup-only.
- The cited wrappers, unreachable compatibility branches, and write-only state increase maintenance surface, but the audit did not establish a product behavior failure. Removing them would be refactoring rather than a clear bug fix.

### BUG-469 — Renderer helpers, constants, and legacy stylesheet blocks are orphaned

- **Disposition:** Retained as cleanup-only.
- The cited declarations and selectors appear unused, but no user-visible failure was demonstrated. Removing them would be maintenance cleanup rather than a clear bug fix.

### BUG-474 — Direct WebSocket upgrades cannot connect to IPv6 origins

- **Disposition:** Retained as not reproduced.
- Targeted checks on Node.js 26.7.0 showed that bracketed IPv6 hostnames are accepted by the relevant Node socket/request path and proceed to a connection attempt. With no listener, the observed result was `ECONNREFUSED`, not a hostname or DNS parsing failure.

### BUG-486 — Generated Node.js requests use bracketed IPv6 socket hostnames

- **Disposition:** Retained as not reproduced.
- Targeted raw and multipart request checks on Node.js 26.7.0 accepted the bracketed IPv6 hostname and reached the network connection attempt. The claimed hostname-resolution failure did not reproduce.

### BUG-496 — IPv6-literal mock webhooks cannot be delivered

- **Disposition:** Retained as not reproduced.
- Targeted webhook transport checks on Node.js 26.7.0 accepted the bracketed IPv6 hostname and reached the network connection attempt. The claimed hostname parsing failure did not reproduce.

## Final validation

- Repository-pinned runtime: Node.js 26.7.0.
- Two consecutive independent audits completed clean on the same candidate.
- Full serialized suite in each clean pass: **2,459 total; 2,455 passed; 0 failed; 4 skipped** for unavailable external runtimes.
- Focused regression suites, changed-source syntax checks, `git diff --check`, production dependency audit, and full dependency audit passed.
