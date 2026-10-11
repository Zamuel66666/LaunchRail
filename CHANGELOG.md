# Changelog

All notable user-facing changes will be documented here. LaunchRail follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) structure and intends to use Semantic Versioning once runnable milestones are released.

## [Unreleased]

### Added

- Pinned Traefik file-provider routing with collision-resistant deployment hostnames, atomic private route files, bounded targets, stale-file reconciliation, and real proxy acceptance coverage.
- Added a loopback-only HTTP health-check adapter with strict path, port, timeout bounds, and worker runtime-completion gating.
- Completed the routing milestone with persisted preview-route ownership, restart reconciliation, organization fencing, promotion preservation, and terminal cleanup.
- Added authenticated, idempotent deployment stop control alongside promotion, cancellation, health history, and event history APIs.
- Added transactional rollback from the active release to the latest superseded release, including pointer switching, ordered events, and audit records.
- Added authenticated retry creation for terminal failed deployments, preserving the original source revision and linking the retry lineage.
- Added bounded organization/project deployment history reads for timeline consumers.
- Added a basic project-workspace deployment timeline backed by the deployment history API.
- Added deployment-scoped audit-history filtering and owner/admin audit presentation in the project timeline.
- Added retry actions for terminal failed deployments directly in the project timeline.
- Added an active-release stop action to the project timeline.
- Added per-deployment health attempt history to the project workspace.
- Added durable failure recording for health timeouts, invalid responses, and unhealthy HTTP statuses before candidate promotion.
- Added startup grace and unhealthy candidate behavior to deployment lifecycle documentation.
- Added health-failure acceptance proving the previous active preview route remains in place and interrupted startup grace removes the unpromoted candidate without running a health probe.
- Added confirmed cancel, stop, and rollback actions plus client-safe conflict feedback to the project deployment timeline.
- Added on-demand recorded deployment activity to the project timeline.
- Added worker-driven promotion after a successful bounded health check, preserving the atomic promotion path and idempotent command record.
- Added shared GitHub webhook signature verification and strict push-event parsing contracts.
- Added organization-scoped webhook delivery persistence with provider/delivery deduplication.
- Added an optional authenticated GitHub webhook ingestion endpoint bound to a configured organization.
- Added a low-cardinality Prometheus-compatible API request counter endpoint.
- Added a deduplicated webhook deployment-trigger hook for verified GitHub pushes.
- Verified matching GitHub pushes now publish their durable deployment-claim wake-up immediately, with worker reconciliation retained as a Redis-failure fallback.
- Added durable GitHub delivery processing outcomes, normalized retry payloads, and operator retry controls.
- Made retried webhook events reuse their original per-project deployment instead of creating duplicate deployment history.
- Added authenticated, organization-scoped webhook delivery history and retry presentation in the project workspace.
- Added bounded Prometheus histograms and gauges for API latency, webhook outcomes, worker load, health checks, and runtime handoffs.
- Added an optional loopback-only Prometheus/Grafana Compose overlay with provisioned dashboard and data source.
- Preserved exact raw webhook request bytes during API parsing for signature verification.
- Verified pushes now create deployment snapshots for matching configured projects and branches.
- Unsupported GitHub event types are rejected deterministically after signature verification.
- Newly created webhook deployments now begin with an immutable queued lifecycle event.
- Added API request correlation IDs and route-template labels to request metrics.
- Added worker process uptime and resident-memory metrics to the health server.
- Added worker reconciliation, dispatch, recovery, and dead-letter counters to the Prometheus metrics endpoint.
- Blank optional GitHub webhook values in local configuration now correctly disable webhook ingestion.
- Added worker inventory and ownership-verified cleanup for orphaned or terminal LaunchRail runtime containers, preserving containers protected by unexpired runtime leases.
- Persisted runtime cleanup completion/failure state and exposed bounded orphan-cleanup metrics and warning logs for later reconciliation.
- Added authenticated exact-commit deployment creation for deployment controllers with database-authoritative claim creation and queue reconciliation fallback.
- Added organization-scoped, sequence-ordered API access to retained build output and lazy build-log viewing in the project deployment timeline.
- Added the dependency-free loopback API liveness benchmark command and a public release readiness checklist.
- Added 24-hour, lease-aware cleanup for abandoned source-checkout and private build-context staging directories.
- Added lease-aware removal and PostgreSQL cleanup markers for completed source-checkout directories.
- Added organization-authorized recent runtime log tails through a shared-secret API-to-worker endpoint.
- Added 24-hour cleanup for unreferenced LaunchRail images while protecting database-recorded images and live build leases.
- Added optional OpenTelemetry OTLP/HTTP export with W3C request spans, BullMQ producer/consumer propagation, worker processing spans, and bounded reconciliation spans.
- Added recovery cleanup for stale, interrupted Traefik route-file writes with bounded-age checks and separate metrics.
- Added an in-app demo walkthrough covering prerequisites, the exact-revision release flow, and explicit product boundaries.
- Added an opt-in exact-SHA deployment benchmark that records request-to-healthy-release latency without exposing its session cookie.
- Builds now bootstrap the explicitly configured Buildx builder before work, allowing recovery of a stopped node without selecting or creating a different builder.
- Improved confirmation-dialog labels and Escape-key dismissal, and honored reduced-motion preferences.
- Instrumented API and worker readiness outcomes with bounded metrics.
- Worker readiness now rechecks PostgreSQL and Redis on an isolated bounded probe connection, without interfering with BullMQ's blocking consumer.
- Route restoration failures no longer abort a reconciliation pass before it republishes durable deployment work.
- Both benchmark scripts now accept IPv6 loopback origins while continuing to reject non-loopback targets.
- Confirmation flows now restore keyboard focus to their trigger or a stable contextual fallback after dismissal.
- Resource-recovery inventory failures are now isolated from durable wake-up dispatch and retried on the next reconciliation pass.
- Added bounded worker metrics for queue depth by state, queue wait, job processing duration/outcome, and active queue handlers, with Grafana panels and integration coverage.
- Added separate durable deployment-job outcome and processing-duration metrics so scheduled retries and dead letters are not confused with successful queue-handler execution.
- Added privacy-safe BuildKit cache-hit and cache-miss step histograms, excluding recovered/adopted builds to avoid double-counting.
- Added bounded runtime start/stop and preview-route apply/reconciliation timings plus a Prometheus-computable worker heartbeat-age gauge and dashboard panels.
- Route adapter exceptions now persist a fixed operator-safe failure message rather than arbitrary thrown text.
- Worker readiness now checks Docker daemon access and bootstraps only the configured Buildx builder, with a heartbeat-interval cache to bound probe work.
- Reconciliation now fails an active deployment when healthy Docker inventory confirms its managed runtime is missing, while protecting live runtime leases and clearing stale route intent atomically.

- Plain-language product scope, target users, core workflow, success criteria, and explicit non-goals.
- Initial architecture for the web application, API, worker, persistence, queue, build/runtime, routing, and observability boundaries.
- Architecture decision records for the modular monolith and selected technology stack.
- Deployment lifecycle with explicit states, valid transitions, activation, cancellation, rollback, retry, and recovery rules.
- Initial security policy and threat model covering privileged build/runtime operations.
- Phased roadmap, contributor workflow, validation strategy, observability plan, and benchmark methodology.
- Runnable pnpm workspace with Next.js web, Fastify API, worker, and shared packages.
- Process health endpoints and deterministic health-contract tests for every application.
- Runtime-validated service configuration with safe production credential guards.
- Structured redacted logger foundation for API and worker processes.
- Local PostgreSQL 18 and Redis 8 Compose services with persistence and health checks.
- Pinned formatting, linting, type checking, unit, integration, build, and smoke-test commands.
- GitHub Actions quality and real development-service health verification.
- Apache 2.0 license and licensing architecture decision.
- Recruiter-readable web foundation page and milestone screenshot.
- Organization-owned PostgreSQL schema for identity, projects, deployments, events, logs, runtime records, encrypted-variable metadata, webhook deliveries, and audit history.
- Reviewable Drizzle migrations and an immutable deployment source/configuration snapshot guard.
- Framework-independent domain and application packages with an exhaustive fourteen-state deployment transition map.
- Transactional PostgreSQL transition and promotion operations with row locking, ordered events, audit records, idempotent replay, and tenant-scoped lookup.
- Disposable-PostgreSQL CI coverage for clean migrations, constraints, rollback, failed-candidate preservation, and concurrent promotion.
- Scrypt password credentials, one-time first-owner bootstrap, and disabled-user support.
- Hashed opaque sessions with absolute and rolling idle expiration plus explicit revocation.
- Shared owner/admin/developer/viewer authorization policy and organization-scoped identity adapter.
- Fastify sign-in, sign-out, session, organization, membership, role-update, and audit-history endpoints.
- Strict mutation-origin enforcement, HttpOnly/SameSite cookies, production Secure cookies, security headers, bounded bodies, and sign-in throttling.
- Responsive Next.js sign-in and active-session experience.
- Real-PostgreSQL tests for every role, every protected cross-organization path, membership conflicts, token storage, and audit outcomes.
- Organization-scoped project create, list, detail, optimistic update, and soft-archive APIs with audited writes and cross-organization concealment.
- Canonical GitHub HTTPS repository normalization with safe branch, Dockerfile, health-check, and bounded runtime configuration.
- AES-256-GCM environment-variable encryption with fresh nonces, authentication tags, versioned keys, and organization/project/name-bound authenticated context.
- Write-only secret APIs that expose only environment-variable names and timestamps to owner/admin users.
- Project archival that purges encrypted variables, preserves terminal deployment history, and rejects active or in-flight projects.
- Responsive project workspace with organization selection, accessible state handling, role-aware controls, optimistic-conflict feedback, and archive confirmation.
- Structured logger redaction for secret values, passwords, authorization/cookie data, and secret-keyring fields.
- Strict `deployment.claim` version 1 runtime contract containing only an opaque durable work-item ID, with deterministic colon-free BullMQ and transition keys.
- PostgreSQL-authoritative deployment work items with attempts, due times, exclusive expiring leases, fencing tokens, safe retry/dead-letter details, and constrained lifecycle states.
- Durable worker heartbeat records covering startup, readiness, bounded draining, and stopped state.
- BullMQ at-least-once wake-up delivery with PostgreSQL-managed deterministic capped exponential backoff, bounded job timeouts, reconciliation of missing/due/expired work, and graceful shutdown.
- Idempotent worker claims that advance eligible deployments from `queued` to `cloning` once even when Redis delivery is duplicated or the worker restarts.
- Unit tests plus disposable PostgreSQL/Redis integration suites for contract validation, duplicate consumption, retry exhaustion, timeout, lease fencing, dead letters, reconciliation, heartbeat freshness, graceful shutdown, and restart recovery.
- Typed repository-provider and checkout ports, a source-preparation use case, and a versioned deployment source-snapshot bridge that keeps the immutable resolved commit separate from requested source metadata.
- Fixed-origin public GitHub revision resolution with no redirects/authentication, bounded responses and trees, exact commit/tree validation, and safe permanent/transient failure categories.
- An isolated exact-SHA Git checkout adapter with ambient configuration/credentials disabled, bounded process output/time/disk use, process-group cancellation, and staging cleanup.
- Post-checkout commit/tree/blob verification, file/byte/path/depth limits, special-file and LFS rejection, full symlink containment, and contained non-empty Dockerfile hashing.
- Immutable portable source-preparation records plus the identifier-only `deployment.prepare_source` work item, lease-fenced `cloning` to `building` completion, atomic source-failure handling, and missing/expired-work reconciliation.
- Restart-safe checkout adoption and a disposable PostgreSQL/Redis recovery test that proves duplicate claim/source wake-ups produce one preparation and exactly the expected deployment history.
- Durable `deployment.build` work items with PostgreSQL-authoritative leases, lease-fenced bounded build logs, immutable local image artifacts, and atomic `building` to `deploying` completion.
- Private sealed build-context snapshots, constrained BuildKit execution, stable local image adoption, safe process-tree cancellation, and source-checkout cleanup.
- Pinned BuildKit CI acceptance coverage for healthy/failing builds, cache reuse, log redaction, deadline/cancellation, output limits, and cleanup.
- Durable runtime-start work with lease fencing, immutable image-to-runtime handoff, one runtime instance per deployment, retries/dead letters, and `deploying` to `health_checking` completion.
- Restricted Docker lifecycle adapter with label-verified adoption, loopback-only dynamic ports, least privilege, resource limits, bounded runtime log reads, and explicit stop/removal.
- Real Docker CI acceptance for create/adopt/policy-inspection/stop/removal, alongside PostgreSQL/Redis runtime-handoff recovery coverage.

### Changed

- Upgraded Next.js, Fastify, and their runtime dependency graph; `pnpm audit --prod` now reports no known vulnerabilities for the current lockfile.

### Current limitations

- Authentication is local-password only and does not yet include password recovery, invitations, MFA, SSO, or session administration.
- Source preparation supports public GitHub repositories only; private-repository authentication, Git LFS, and submodules are intentionally unsupported.
- Project configuration and encrypted variables are not yet injected into deployment jobs or application runtimes, and key re-encryption is manual/not yet automated.
- No deployment-start HTTP endpoint or deployment UI exists yet; source preparation currently begins only for an internally persisted immutable deployment.
- Preview routing, activation, browser log streaming, deployment controls, webhooks, registry publication/signing/scanning, and full telemetry are not implemented. Runtime log reads are worker-side only and not retained or exposed through the browser.
- Application health endpoints and the health smoke test report process liveness rather than queue/database readiness; durable heartbeats are operational records, not an HTTP readiness claim.
- Repository checkouts are retained on the trusted worker host for the next build phase; hard-crash staging/orphan cleanup and hostile multi-tenant isolation are not complete.
- The Phase 4 migration intentionally rejects databases containing legacy environment-variable rows because those rows have no AES-GCM authentication tag; back up and re-enter those values before migration.
- No release has been tagged.

[Unreleased]: https://github.com/Zamuel66666/LaunchRail/commits/main
