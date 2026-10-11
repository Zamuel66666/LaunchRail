# Local acceptance evidence

This is an incremental verification record, not a release approval. Remaining gates are tracked in the [release checklist](release-checklist.md).

## 2026-10-11 verification

The supported Linux host ran Node 22.23.2, pnpm 11.9.0, Docker Engine 29.7.2, Buildx 0.36.1, pinned BuildKit 0.32.2, PostgreSQL 18, Redis 8, and pinned Traefik 3.3.6. A separate `launchrail_release_acceptance` database held synthetic identities and deployment history; normal database suites used the disposable development database.

- Unit coverage: 313 tests passed, including delayed HTTP startup, aborted response handling, build-context permissions, exact-Git checkout, authenticated benchmark requests, and private infrastructure directory checks.
- PostgreSQL coverage: 78 tests passed, including transactional intent creation, concurrent verified-delivery deduplication, preview/failure history scoping, and monotonic source cleanup recording.
- HTTP coverage: 14 tests passed; the two database-dependent suites skipped by this command were covered by the PostgreSQL gate above.
- Queue/restart coverage: 15 tests passed. Runtime adapters are injected into queue recovery fixtures so they cannot inventory or remove live Docker resources.
- BuildKit coverage: eight real-image tests passed, including a non-root, read-only, network-disabled image reading nested copied assets.
- Routing coverage: the real Traefik fixture passed with its upstream bound only to `127.0.0.1`, matching production runtime port bindings.
- Full type checks, lint, formatting, documentation lint, and the production web build passed. The production dependency audit reported no known vulnerabilities.

## Real deployment and browser observations

A manual authenticated API deployment of exact published revision `152f68d5d76ed8bdfcedc112749e5be16a45769c` fetched the public repository, built the healthy example, started the restricted runtime, passed HTTP health, and became active. The generated localhost hostname served the expected example HTML through Traefik. A candidate configured with `/missing-health` recorded HTTP 404 as `health_unhealthy`; the prior active preview continued returning HTTP 200 before unrelated service-test execution. A queue fixture subsequently exposed unsafe real-adapter usage and was corrected; a fresh healthy release was deployed afterward.

The Chromium browser checks used the real API on port 4100 and production web server on port 3100. They exercised owner sign-in, project editing, exact-revision deployment, automatic timeline state updates, health history, empty build/runtime log states, and active preview links. A real viewer identity could read history and preview links, had zero deployment-control buttons, and received HTTP 403 for a direct deployment-creation request. Owner and viewer timeline checks reported no axe-core WCAG 2 A/AA or WCAG 2.1 A/AA violations; the 390-pixel viewport had no horizontal overflow. Open history polling produced two requests in 4.5 seconds.

Closing the timeline produced zero history requests over the same 4.5-second observation window. The generated SVG application icon removed the previous missing-icon response after a production rebuild.

These checks do not yet establish full keyboard onboarding coverage, every control race, all interruption boundaries, benchmark performance, or release readiness. Node example startup has intermittently exceeded the example acceptance window on hosted CI; bounded process diagnostics are retained on failure rather than suppressing the failure.
