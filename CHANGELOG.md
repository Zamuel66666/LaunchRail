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

### Current limitations

- Authentication is local-password only and does not yet include password recovery, invitations, MFA, SSO, or session administration.
- The runnable product does not yet contain project management UI, queue processing, builds, deployments, log streaming, preview URLs, or rollback controls.
- Application health endpoints currently report process liveness rather than dependency readiness.
- No release has been tagged.

[Unreleased]: https://github.com/Zamuel66666/LaunchRail/commits/main
