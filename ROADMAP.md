# LaunchRail roadmap

## How to read this roadmap

The roadmap reports verified repository state, not aspirations as completed features. A phase moves to **Available** only when its acceptance criteria are implemented, tested, documented, and reproducible from a clean setup. Work may be split across several focused development sessions.

## Current status

### Available

- **Phase 0 — Product definition:** scope, users, non-goals, architecture, data-model outline, deployment state model, threat model, technology decisions, and delivery plan.
- **Phase 1 — Repository foundation:** runnable pnpm workspace, web/API/worker health endpoints, shared configuration, PostgreSQL, Redis, Docker Compose, tests, builds, CI, and open-source license.
- **Phase 2 — Domain model and persistence:** organization-owned records, generated migrations, immutable deployment snapshots, centrally validated state transitions, transactional events, idempotency, and atomic active-release promotion.
- **Phase 3 — Authentication and authorization:** bootstrapped owners, password verification, secure opaque sessions, organization roles, hardened requests, audited membership changes, and sign-in UI.
- **Phase 4 — Project management:** validated organization-scoped project configuration, encrypted environment variables, optimistic archival, audited APIs, and a permission-aware project UI.
- **Phase 5 — Queue and worker foundation:** strict identifier-only wake-ups, PostgreSQL-authoritative attempts/leases/dead letters, restart reconciliation, operational heartbeats, and bounded graceful draining.
- **Phase 6 — Repository preparation:** public GitHub revision verification, isolated exact-SHA checkout, source limits and containment, immutable preparation metadata, and restart-safe source jobs.
- **Phase 7 — Build pipeline:** constrained BuildKit execution, immutable image identity, bounded redacted logs, cancellation, cleanup, build-failure handling, and clean-CI acceptance proof.
- **Phase 8 — Runtime deployment:** restricted idempotent Docker lifecycle, durable runtime handoff, bounded log reads, and clean-CI lifecycle acceptance.
- **Phase 9 — Routing and preview URLs:** organization-scoped preview records, atomic Traefik file updates, and real loopback-only proxy acceptance.

### In progress

- **Phase 10 — Health checks and activation:** health outcomes, prior-route preservation, and interrupted-grace cleanup are implemented; release acceptance is underway.
- **Phase 11 — Deployment controls:** API controls, retry lineage, timeline history, confirmations, actionable browser feedback, and deployment-scoped operator audit history are implemented. Durable rollback now prepares retained runtimes and requires fresh health before switching; broader race/failure-injection acceptance remains.
- **Phase 12 — GitHub webhooks:** verified signed pushes persist normalized retry data, idempotently create deployments, publish wake-ups, expose processing outcomes, and support scoped operator retry; release acceptance is underway.
- **Phase 13 — Observability:** route-level metrics, lifecycle/health metrics, a local dashboard, bounded API database and worker database/Redis readiness, W3C API request spans, and queue-to-worker trace propagation with OTLP/HTTP export are implemented; independent verification and remote aggregation remain.
- **Phase 14 — Failure recovery:** reconciliation inventories managed Docker containers and BuildKit images, protects active resources with durable leases/records, prunes unreferenced images and stale source/build/proxy staging files after 24 hours, and removes completed source checkouts after source/build leases end; builds now bootstrap the explicitly configured Buildx builder, while daemon/container-loss recovery, broad interruption coverage, and independent verification remain.
- **Phase 15 — User experience and accessibility:** operators can start a deployment for an exact commit SHA and inspect retained build output plus an on-demand bounded runtime log tail in the project timeline; a guided `/demo` walkthrough is available, while onboarding polish and independent accessibility/user-flow verification remain.
- **Phase 16 — Benchmarks and public release:** bounded loopback API liveness and explicitly opted-in end-to-end deployment benchmark scripts plus a public release checklist are available; measured results and clean-release evidence remain.

### Planned later

- Remaining exit-gate work listed in Phases 10–16 below.

### Not currently planned

- Kubernetes, multi-region deployments, billing, public multi-tenant hosting, enterprise SSO, multiple cloud providers, a custom runtime, AI recommendations, mobile apps, and a plugin marketplace.

## Release path

Tagged releases are created only for meaningful runnable milestones:

| Target   | Demonstrable outcome                                                                  |
| -------- | ------------------------------------------------------------------------------------- |
| `v0.1.0` | Local environment, authentication, and project management work from a clean setup.    |
| `v0.2.0` | A background worker clones repositories and builds images with live progress.         |
| `v0.3.0` | Built applications run behind generated local preview URLs.                           |
| `v0.4.0` | Health-checked activation preserves healthy releases and supports rollback.           |
| `v0.5.0` | Verified GitHub push webhooks safely trigger deployments.                             |
| `v1.0.0` | The complete local demonstration is stable, documented, observable, and reproducible. |

Versions and contents may change as implementation evidence becomes available. Phase 0 itself is not tagged because it has no runnable product.

## Phase details

### Phase 0 — Product definition

**Status:** Available

Delivered:

- Recruiter-readable product explanation and honest current status.
- Target users, workflow, product principles, success criteria, and non-goals.
- Modular-monolith architecture, infrastructure boundaries, and initial data model.
- Explicit deployment states, transitions, invariants, activation, cancellation, rollback, and recovery design.
- Initial security policy and threat model.
- Accepted ADRs for the application stack, persistence/jobs, and deployment infrastructure.
- Contribution, development, testing, observability, and benchmark guidance.

Exit evidence: documentation link/format validation and review against the Phase 0 acceptance criteria.

### Phase 1 — Repository foundation

**Status:** Available

Delivered:

- pnpm workspace with `apps/web`, `apps/api`, `apps/worker`, and shared packages.
- Apache 2.0 license and recorded licensing decision.
- Next.js web foundation plus Fastify and worker health servers.
- Shared health contracts, validated configuration, and redacted structured logger setup.
- Loopback-only PostgreSQL and Redis Compose services with persistent volumes and health checks.
- Pinned Node.js, pnpm, TypeScript, formatting, ESLint, Vitest, build, and smoke-test tooling.
- GitHub Actions jobs for code quality, application health, and real PostgreSQL/Redis health.
- Clean-setup, configuration, health, verification, and cleanup instructions.

Exit evidence: frozen install, format/lint/type/unit/integration/build checks, all application health smoke tests, valid Compose model, published image manifests, and green GitHub Actions service health checks.

### Phase 2 — Domain model and persistence

**Status:** Available

Delivered:

- Organization-scoped users, memberships, projects, deployments, events, build logs, runtime instances, encrypted-variable metadata, webhook deliveries, and audit events.
- Generated Drizzle migrations with database constraints for ownership, ordered records, failure details, health-gated releases, and one active release per project.
- Immutable source and configuration snapshots protected by a PostgreSQL trigger.
- Framework-independent domain and application packages with one exhaustive transition map.
- PostgreSQL transition adapter with row locks, command idempotency, ordered events, audit records, and transactional failure rollback.
- Healthy promotion transaction that serializes on the project and atomically supersedes the prior release.

Exit evidence: clean migrations and real-PostgreSQL integration tests in GitHub Actions prove tenant ownership, snapshot immutability, atomic state/event writes, replay behavior, failed-candidate preservation, and concurrent single-release promotion.

### Phase 3 — Authentication and authorization

**Status:** Available

Delivered:

- One-time first-owner bootstrap with scrypt password hashing and no secret output.
- Cryptographically random opaque sessions stored only as SHA-256 hashes, with absolute and rolling idle expiry plus revocation.
- Owner, admin, developer, and viewer permission matrices shared by the API and session principals.
- Authenticated organization, membership, role-change, and audit-history endpoints with cross-organization concealment.
- Strict mutation-origin validation, HttpOnly SameSite cookies, production Secure cookies, bounded request bodies, security headers, and sign-in rate limiting.
- Audit records for bootstrap, accepted/rejected sign-in, sign-out, and membership role changes.
- Responsive sign-in/session UI with accessible controls and clear unavailable-service feedback.

Exit evidence: exhaustive domain policy tests and real-PostgreSQL API integration tests cover every role, every protected cross-organization route, privileged role changes, final-owner protection, session hashing/revocation, request hardening, and generic credential failures.

### Phase 4 — Project management

**Status:** Available

Delivered:

- Organization-scoped project creation, listing, detail, optimistic update, and soft archival with audited writes and cross-organization concealment.
- Canonical public `github.com` HTTPS repository input and strict branch, relative Dockerfile path, origin-only health path, port, and runtime-resource bounds.
- AES-256-GCM environment-variable encryption with a fresh nonce and authentication tag, versioned keyring, and authenticated context bound to organization, project, and variable name.
- Write-only environment-variable values; owner/admin users can manage secrets and read names/timestamps, developers can create/update projects, and viewers can read project configuration.
- Soft archival that hides projects, purges their secrets, preserves terminal deployment history, and rejects projects with an active release or non-terminal deployment.
- Responsive project workspace with organization selection, loading/empty/error states, optimistic-conflict feedback, confirmation for archival, and role-aware controls.

Exit evidence: domain/cipher tests exercise malicious inputs, authenticated-encryption tampering and key rotation; Fastify tests cover route schemas, secret response boundaries, and role behavior; clean PostgreSQL tests cover organization scope, concurrency, audit records, archival, secret purging, and history preservation; production builds and browser verification exercise the project workflow.

### Phase 5 — Queue and worker foundation

**Status:** Available

Delivered:

- Strict runtime-validated `deployment.claim` version 1 contract containing only an opaque PostgreSQL work-item ID, plus deterministic BullMQ and transition idempotency keys.
- PostgreSQL work items with constrained statuses, attempts, due times, exclusive expiring leases, fencing tokens, safe failure details, dead-letter timestamps, and worker heartbeats.
- BullMQ used as an at-least-once wake-up channel while workers re-read PostgreSQL ownership and state before acting.
- Deterministic capped exponential backoff, bounded job execution, durable retry exhaustion, and PostgreSQL-authoritative dead-letter handling.
- Reconciliation for missing queued work, due work absent from Redis, and expired leases, without claiming exactly-once delivery.
- Best-effort immediate stage wake-ups after committed completion, scoped to the eligible next PostgreSQL work item. Creation and retry also wake accepted work immediately; publisher failure preserves acceptance and leaves periodic reconciliation as the recovery path. Regression coverage includes stale/foreign/future work, cancellation, shutdown, and failed diagnostics.
- An atomic, lease-fenced `queued` to `cloning` transition plus work-item completion, periodic operational heartbeat, and bounded graceful shutdown that stops new claims before draining active work.

Exit evidence: [GitHub Actions run 31408251857](https://github.com/Zamuel66666/LaunchRail/actions/runs/31408251857) passed the strict-contract and worker unit checks, clean PostgreSQL migrations and transaction tests, and the disposable PostgreSQL/Redis suite for duplicate delivery, retries, timeout, fencing, dead letters, missing/expired work, operational heartbeats, graceful draining, and restart behavior. Duplicate jobs preserve authoritative state and append the demonstrated claim transition once.

### Phase 6 — Repository preparation

**Status:** Available

Delivered:

- Typed repository-provider and checkout ports plus an application use case that preserves requested revision, resolved commit, tree identity, and versioned deployment source snapshot separately.
- A fixed-origin, public-only GitHub adapter that rejects redirects and authentication, bounds response bodies and recursive trees, resolves branch/tag/SHA-shaped references to an exact commit, and rejects truncated, malformed, unsupported, or oversized source metadata.
- An isolated Git checkout adapter that uses argument arrays rather than a shell, disables ambient credentials/configuration/hooks/smudge/submodules, fetches only the verified SHA, enforces process output/time/disk bounds, and terminates the full process group on cancellation.
- A post-checkout manifest that verifies commit/tree/blob integrity; bounds file count, bytes, path bytes, depth, and individual files; rejects special files, LFS pointers, and unsafe symlinks; and proves the configured Dockerfile resolves to a contained, non-empty regular file with a stored SHA-256 digest.
- A second identifier-only `deployment.prepare_source` work item with PostgreSQL-authoritative leases, retries, permanent source failures, and reconciliation. Successful preparation atomically stores immutable portable metadata, advances `cloning` to `building`, and completes the work item; terminal failure atomically records `build_failed` without changing an active release.
- Crash-safe checkout adoption that revalidates the trusted marker and complete manifest before reuse, with staging cleanup on ordinary failure and abort paths.

Exit evidence: [GitHub Actions run 31414001234](https://github.com/Zamuel66666/LaunchRail/actions/runs/31414001234) passed formatting, documentation, lint, types, 250 unit tests, ordinary integration/build/health checks, clean PostgreSQL migrations and transaction tests, and the disposable PostgreSQL/Redis restart suite. Deterministic fake-HTTP and local real-Git fixtures cover revision races, malformed/oversized provider responses, hostile Git configuration, command injection, output/time/disk limits, process-tree cancellation, blob/tree mismatches, symlink escapes, special files, LFS pointers, Dockerfile failures, checkout tampering/adoption, duplicate delivery, lease fencing, retry/dead-letter behavior, and worker restart from claim through `building` without contacting external GitHub during CI.

### Phase 7 — Build pipeline

**Status:** Available

Constrained BuildKit execution creates a private verified context snapshot, builds a stable labeled local image, persists immutable image metadata and bounded redacted logs, and advances `building` to `deploying` under a fenced lease. The worker adopts a verified image after a retry, cleans consumed source checkouts, and records terminal build failures as `build_failed`.

Delivered:

- A typed image-builder port and constrained Buildx adapter that runs argument-based commands with isolated Docker client state, bounded output, deterministic log redaction, deadlines, process-group cancellation, verified image inspection, and exact owned-image removal.
- Stable identity labels and a local image marker that let a retry adopt only an image matching the deployment, source/tree/context/Dockerfile digests, platform, and worker work item.
- Private source snapshots that re-hash their canonical manifest and Dockerfile before build, reject changed source, remove sealed read-only directories safely, and restrict Dockerfile frontends to the frontend bundled with the pinned BuildKit daemon.
- A `deployment.build` work item with PostgreSQL leases, retry/dead-letter handling, bounded lease-fenced logs, immutable artifact records, reconciliation, and an atomic `building` to `deploying` transition.

Exit evidence: [GitHub Actions run 34689195299](https://github.com/Zamuel66666/LaunchRail/actions/runs/34689195299) passed formatting, documentation, lint, types, unit/integration/build/health checks, clean PostgreSQL migrations and worker recovery, plus a real pinned BuildKit acceptance suite. The BuildKit suite verifies healthy and failed Dockerfiles, cache reuse, redaction, adapter deadline, worker cancellation, raw-output limits, stable image adoption, source-seal failures, and cleanup.

Exit gate: healthy/failing applications exercise success, failure, timeout, cancellation, cache, redaction, output limits, source-seal validation, and cleanup against a pinned constrained BuildKit daemon in CI.

### Phase 8 — Runtime deployment

**Status:** Available

Delivered:

- A restricted Docker runtime adapter with private client state, argument-only commands, deadlines/output bounds, stable ownership labels, and exact-label adoption after duplicate delivery or worker restart.
- Loopback-only dynamic port publication, non-root execution, dropped capabilities, no-new-privileges, process/memory/CPU limits, optional read-only roots, isolated tmpfs, bounded timestamped log reads, and controlled stop/removal.
- A durable `deployment.start_runtime` work item that loads only immutable image/project metadata, lease-fences runtime start, records one runtime instance, and advances `deploying` to `health_checking`; retries and terminal runtime failures remain PostgreSQL-authoritative.
- A migration that constrains runtime instance ownership to one deployment plus real PostgreSQL recovery coverage and a real Docker lifecycle acceptance test in CI.

Exit evidence: [GitHub Actions run 34690600740](https://github.com/Zamuel66666/LaunchRail/actions/runs/34690600740) passed formatting, docs, lint, types, unit/integration/build/health checks, clean PostgreSQL/Redis recovery, constrained BuildKit acceptance, and a real Docker lifecycle test that inspects resource policy and proves create/adopt/stop/removal.

### Phase 9 — Routing and preview URLs

**Status:** Available

Add collision-resistant hostnames, Traefik route registration/removal/restoration, and observed-state reconciliation.

Delivered:

- A pinned Traefik file-provider adapter with exact deployment-bound localhost hostnames, private atomic writes, safe removal, and stale-file reconciliation.
- A real Traefik acceptance path that proves a generated preview route reaches only the loopback-published host port.

Exit evidence: [GitHub Actions run 34771181289](https://github.com/Zamuel66666/LaunchRail/actions/runs/34771181289). Worker restart restoration reads persisted route ownership with organization-fenced joins and terminal cleanup.

Exit gate: local preview routing works after proxy/worker restart and cannot cross project or organization boundaries.

### Phase 10 — Health checks and activation

**Status:** In progress — implementation complete; release acceptance underway

Delivered:

- Bounded loopback-only HTTP checks with strict path, port, timeout, and response validation; durable attempts distinguish timeout, invalid response, unhealthy status, and passing status.
- Configurable startup grace, worker-driven promotion only after a passing check, and terminal candidate cleanup/failure when checks do not pass.
- Transactional failure coverage proving an unhealthy candidate leaves the prior active release and preview route untouched; interruption during startup grace cleans up the candidate without probing or promoting it.
- On-demand deployment-health history in the workspace with response status, duration, timestamp, and loading/empty/error states.

Implementation evidence: unit and PostgreSQL acceptance cases cover delayed checks, health classification, failed-candidate route preservation, and interrupted-grace cleanup. Run these suites and the constrained runtime acceptance before marking the phase Available.

Browser-driven Node acceptance exposed a Docker published-port startup race: pre-header connection resets were classified as invalid responses. The checker now retries resets/refusals only before headers and within the original deadline; continuous startup resets time out, aborted response bodies still fail, and HTTP 503 remains unhealthy. Regression tests and a real Node retry with zero startup grace passed, retaining the prior release on the original failure.

### Phase 11 — Deployment controls

**Status:** In progress — health-gated durable rollback implemented; broader race/failure-injection acceptance remains

Organization-scoped deployment listing/event history, idempotent promotion, cancellation, stop controls, transactional rollback, authenticated retry creation, and a recruiter-readable timeline are available with permission checks and bounded inputs. Browser controls require confirmation, surface actionable client-safe errors, and reveal recorded activity on demand. Owner/admin audit readers can now inspect the scoped audit actions associated with each deployment.

Exit gate: independent concurrency and failure-injection verification proves safe control races and route switching.

### Phase 12 — GitHub webhooks

**Status:** In progress — implementation complete; release acceptance underway

Signature verification, strict push-event parsing, safe wildcard branch filtering, organization-scoped delivery persistence with provider/delivery deduplication, and configured-organization API ingestion create queued deployments for matching project branches. Each durable deployment immediately publishes its deterministic claim wake-up; worker reconciliation remains the safe fallback if Redis is unavailable. Processing state and safe error codes are durable, owners/admins can inspect recent delivery results, and deployment controllers can retry failed verified deliveries. Per-delivery/project trigger records prevent retry from creating duplicate deployment rows.

Exit gate: independently verify invalid, duplicate, unsupported, oversized, retried, partially failed, and valid deliveries against clean PostgreSQL and Redis services.

### Phase 13 — Observability

**Status:** In progress — live correlation and dashboard queries verified; clean-release independent acceptance remains

Structured logs and worker health are available. API/worker metrics include bounded request and webhook counters/histograms, active jobs and queue handlers, queue depth by state, queue wait and handler-processing duration, durable deployment-job stage duration/outcome by supported kind, deployment final-outcome/duration, build-cache hits/misses, worker heartbeat age, build/runtime cleanup duration, retry/timeout and health-grace exhaustion counters, orphan inventory, route configuration repairs, reconciliation, health-check outcomes/latency, runtime failures, and resource cleanup. Worker readiness also checks Docker daemon access and configured Buildx builder bootstrap, cached for one heartbeat interval. A loopback-only optional Compose overlay provisions Prometheus and Grafana with a read-only data source, operations dashboard, and starter alert rules. API server spans extract W3C trace context, capture route-template/status/duration, and export through the optional OTLP/HTTP endpoint. BullMQ producer and consumer spans carry W3C context in BullMQ telemetry metadata, separate from the identifier-only job data; worker processing, reconciliation, and persistence-adapter operations add bounded spans without SQL statements or parameters. Remote metrics aggregation, individual SQL-statement spans, and independent canary-secret/collector verification remain.

Exit gate: independently verify a full deployment/failure correlation across logs, metrics, traces, events, dashboard queries, and worker state without exposing secrets; verify collector failure/drop behavior and secret-free OTLP payloads.

Incremental evidence: the real 17-check lifecycle scenario correlates successful and failed work through HTTP, persistence, reconstructed queue stages, worker logs, and post-commit outcome metrics. Local collector canaries and failure injection passed; the bounded SDK export test preserves all 1,500 application operations while dropping excess spans. A real Prometheus receiver evaluated all 39 versioned dashboard queries, scraped API/worker successfully, and observed a recent worker heartbeat and activation outcomes; all seven starter alert rules pass `promtool` validation. Grafana provisioned all 34 panels and rendered real request/health data, with a retained screenshot. Exact-clean-release independent review remains.

Request-boundary review removed raw URL/path/query/header/body data from automatic request logs. Real chunked HTTP regressions prove webhook raw capture rejects over-limit uploads before EOF, including URLs with query strings, without invoking a handler. Exact whitespace/Unicode byte preservation and safe HTTP error responses remain covered. Security documentation now accurately distinguishes implemented runtime controls from unsupported hostile-tenant isolation and secret injection.

### Phase 14 — Failure recovery

**Status:** In progress — managed runtime orphan recovery implemented; broader interruption acceptance remains

A guarded physical interruption scenario now owns its test processes and checks inspected Compose targets without deleting volumes. It covers accepted-intent API loss, observed in-flight build worker loss, Redis/database/proxy outages, readiness, exact-route recovery, activation-event uniqueness, and durable resource convergence. Unsafe-input guards are tested; real clean-clone execution remains an acceptance gate, not claimed complete merely by adding the command.

The first clean-clone run verified accepted queued intent across an actual API `SIGKILL`, followed by one activation and the expected preview. It then rejected the driver's incomplete project-update body. The driver now sends the full versioned configuration, with regression coverage excluding response metadata; the full physical matrix remains pending until a successful report is retained.

Physical worker loss during an observed uncached build and Redis outage both recovered to unique activations while retaining prior preview availability. PostgreSQL interruption then exposed unhandled idle-pool errors crashing both services. The shared client now handles these events without raw-error diagnostics and keeps readiness/database authority fail-closed; connection acquisition is bounded. Deterministic pool-error/recovery regressions pass; the complete physical matrix must be repeated before this gate closes.

Queue acceptance reliability: CI exposed a fixture deadlock when its deliberately held runtime occupied the only handler slot before duplicate wake-ups. The fixture now deterministically holds one of two supported slots and verifies duplicate processing in the other, preserving all assertions and deadlines. Two consecutive local runs passed all 15 queue/restart tests; physical interruption coverage remains a separate open gate.

Worker reconciliation inventories only containers bearing LaunchRail's managed label, verifies every ownership label before removal, and preserves containers whose runtime job still has a live PostgreSQL lease. If a healthy Docker inventory shows a persisted active runtime is missing, reconciliation now records a fixed failure, clears the active-release pointer, marks the runtime record failed, and reconciles the route set; a live runtime lease protects in-progress work. Unrecorded containers and containers attached to terminal deployments are cleaned; database cleanup state, metrics, and structured failure logs make repeated cleanup failures visible. Source checkout directories are removed when the deployment has moved past `building` and no unexpired source/build lease uses them; PostgreSQL records the cleanup timestamp. Abandoned `.prepare-*` and `.build-*` staging directories and orphaned BuildKit images are removed only after a 24-hour grace period; database-known image IDs and work items with live build leases are protected. Interrupted Traefik route temp files are removed after the same grace period and tracked separately. Route-restoration and resource-inventory failures are logged and retried without blocking durable job dispatch. Build execution and worker readiness bootstrap only the configured Buildx builder; worker readiness now reports Docker/BuildKit availability, while restarting a lost Docker daemon remains an operator action. Broader interruption, database/Redis outage, and control-race convergence still need recovery acceptance coverage.

Exit gate: repeatable failure-injection tests show convergence or an explicit actionable terminal failure for each managed resource type and interruption boundary.

### Phase 15 — User experience and accessibility

**Status:** In progress — exact-revision deployment and live timeline implemented; full accessible onboarding acceptance remains

Deployment controllers can create a deployment from a full exact commit SHA, with project/organization authorization and a durable database job before best-effort queue publication. The project timeline exposes retained, sequence-ordered build logs and an on-demand last-100-line runtime tail under organization read access. The API-to-worker hop uses a shared secret, fixed configured destination, bounded tail, and no-store responses. Runtime output is application-controlled and may contain sensitive data; access is limited to organization project readers, and operators should avoid printing secrets. The landing page links to a guided `/demo` walkthrough with a first-run checklist, exact-revision release path, and explicit product boundaries; all top-level screens include a keyboard skip link to their main content. Confirmation prompts have accessible names/descriptions, Escape dismissal, initial focus, and focus return; reduced-motion preferences suppress decorative transitions. Screenshot refresh and broad keyboard/responsive/accessibility review remain.

Exit gate: Playwright accessibility/user-flow checks pass, logs and deployment controls are correctly scoped, and the README demonstrates a real working milestone.

Incremental browser evidence: landing, walkthrough, sign-in, signed-out workspace, owner project editor, owner active deployment/log views, and viewer timeline passed WCAG 2 A/AA and WCAG 2.1 A/AA axe-core checks at 1280 and 390 pixels with no horizontal overflow. Keyboard testing corrected skip-link focus. Real owner sign-in, invalid-field focus, project creation/editing, exact-SHA activation, and confirmation Escape/focus return passed. Retry acceptance found and fixed an acknowledgement/history contract mismatch that crashed date rendering; readback now uses persisted history and warns against duplicate requests if history is unavailable. The corrected retry activated and displayed non-empty Node logs. Viewer UI hides restricted controls, and actual viewer creation/stop requests return HTTP 403. Current screenshots are retained. Complete operator-flow and independent review remain.

### Phase 16 — Benchmarks and public release

**Status:** In progress — exact-revision local API/deployment baselines published; isolated scenarios and clean-release evidence remain

The versioned `pnpm benchmark:api` and `pnpm benchmark:deployment` scenarios retain raw correctness and timing reports. Clean published revision `d013bb4` passed five sequential warm-cache deployments and three 1,000-request API runs after separate warm-ups; unedited reports, exact service/resource settings, host load, cache conditions, and sample-size limitations are published in [benchmark methodology](docs/benchmarks.md). The deployment median was 44.467 seconds, with periodic durable stage waits dominating the intervals. Each run creates durable records and may replace the active release; it deliberately does not auto-clean resources. The public release checklist still requires full clean-clone, recovery, security, independent review, and publishing evidence. Repeated isolated queue/build/recovery scenarios remain open; these shared-host local baselines are not production-capacity evidence.

Exit gate: clean setup is independently reproducible, controlled results include methodology and environment, known limitations are current, and release notes describe user outcomes.

Dispatch refinement: clean published revision `c43d5d8` passed a separate warm-up and five measured deployments of the same example/source revision and configured limits. All activated; the observed median was 2.696 seconds after removing periodic stage waits. Unedited reports and post-batch host/profile data are published. Cache/host differences and the five-sample limitation preclude a production speed-up or stable p95 claim.

Image review: all Compose/example images are digest-pinned. Current stable Traefik, BuildKit, Grafana, Node, and Python updates reduce observed advisories; upgraded proxy routing and eight BuildKit acceptance cases passed. The generated [image review](docs/image-review.md) retains every HIGH/CRITICAL finding and explicitly leaves residual-risk review/owner acceptance open. Scanner results are not represented as vulnerability-free.

## Change discipline

Each session selects one incomplete milestone, preserves unrelated changes, adds behavior tests and documentation together, runs applicable gates, and publishes one to four coherent Conventional Commits. The roadmap is updated only when evidence changes a phase's status.
