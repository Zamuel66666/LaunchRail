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

### Planned next

- **Phase 9 — Routing and preview URLs:** collision-resistant local preview routing and observed-state reconciliation.

### Planned later

- Phases 9–16 below.

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

**Status:** In progress

The runtime boundary now includes a bounded loopback-only HTTP checker with strict path, port, and timeout validation, and worker composition can gate runtime completion on a successful response. Durable health jobs, grace periods, and promotion orchestration remain to be implemented.

Add configurable HTTP checks, grace periods, atomic healthy promotion, previous-release preservation, and detailed health presentation.

Exit gate: delayed and unhealthy examples prove that only healthy candidates become active and failed candidates leave the previous route intact.

### Phase 11 — Deployment controls

**Status:** In progress

Organization-scoped event history, idempotent promotion, cancellation, stop controls, and transactional rollback to the previous superseded release are now available with permission checks and bounded inputs. Retry, confirmations, timeline UI, and broader audit presentation remain to be implemented.

Exit gate: concurrency and failure-injection tests prove safe control races and route switching.

### Phase 12 — GitHub webhooks

**Status:** Planned

Add signature verification, push parsing, branch filters, delivery persistence/deduplication, and automatic deployment triggering.

Exit gate: invalid, duplicate, unsupported, oversized, and valid deliveries have deterministic tested outcomes.

### Phase 13 — Observability

**Status:** Planned

Add structured logs, correlation/deployment IDs, request/queue/deployment/health metrics, worker health, distributed traces, and Grafana evidence.

Exit gate: an operator can explain a sample deployment and failure across logs, metrics, traces, events, and worker state without exposing canary secrets.

### Phase 14 — Failure recovery

**Status:** Planned

Exercise API/worker/Redis/database/proxy interruption, duplicate/stale jobs, orphan resources, cleanup failures, and cancellation races; implement reconciliation gaps found.

Exit gate: repeatable failure-injection tests show convergence or an explicit actionable terminal failure.

### Phase 15 — User experience and accessibility

**Status:** Planned

Improve onboarding, empty/loading/error states, keyboard and responsive behavior, log viewing, demonstration data, and safe screenshots.

Exit gate: Playwright accessibility/user-flow checks pass and the README demonstrates a real working milestone.

### Phase 16 — Benchmarks and public release

**Status:** Planned

Add repeatable API, stream, queue, transition, rollback, cache, recovery, webhook, and resource benchmarks; finalize walkthroughs and release evidence.

Exit gate: clean setup is independently reproducible, results include methodology and environment, known limitations are current, and release notes describe user outcomes.

## Change discipline

Each session selects one incomplete milestone, preserves unrelated changes, adds behavior tests and documentation together, runs applicable gates, and publishes one to four coherent Conventional Commits. The roadmap is updated only when evidence changes a phase's status.
