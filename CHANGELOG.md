# Changelog

All notable user-facing changes will be documented here. LaunchRail follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) structure and intends to use Semantic Versioning once runnable milestones are released.

## [Unreleased]

### Added

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

### Current limitations

- Authentication is local-password only and does not yet include password recovery, invitations, MFA, SSO, or session administration.
- Project configuration does not yet verify GitHub existence/access, resolve revisions, authenticate private repositories, clone source, or prove Dockerfile containment after symlink resolution.
- Project configuration and encrypted variables are not yet injected into deployment jobs or application runtimes, and key re-encryption is manual/not yet automated.
- No deployment-start HTTP endpoint or deployment UI exists yet; the Phase 5 consumer is an internal worker foundation.
- Repository access, cloning, builds, application runtimes, activation, log streaming, preview URLs, deployment controls, webhooks, and full telemetry are not implemented.
- Application health endpoints and the health smoke test report process liveness rather than queue/database readiness; durable heartbeats are operational records, not an HTTP readiness claim.
- The current production dependency audit reports 11 high and 7 moderate advisories in existing Next.js/Fastify dependency paths; dependency remediation remains required before production use.
- The Phase 4 migration intentionally rejects databases containing legacy environment-variable rows because those rows have no AES-GCM authentication tag; back up and re-enter those values before migration.
- No release has been tagged.

[Unreleased]: https://github.com/Zamuel66666/LaunchRail/commits/main
