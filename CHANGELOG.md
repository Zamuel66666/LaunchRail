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

### Current limitations

- The runnable foundation does not yet contain authentication, persistence schema, project management, queue processing, builds, deployments, log streaming, preview URLs, or rollback.
- Application health endpoints currently report process liveness rather than dependency readiness.
- No release has been tagged.

[Unreleased]: https://github.com/Zamuel66666/LaunchRail/commits/main
