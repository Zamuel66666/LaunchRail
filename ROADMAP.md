# LaunchRail roadmap

## How to read this roadmap

The roadmap reports verified repository state, not aspirations as completed features. A phase moves to **Available** only when its acceptance criteria are implemented, tested, documented, and reproducible from a clean setup. Work may be split across several focused development sessions.

## Current status

### Available

- **Phase 0 — Product definition:** scope, users, non-goals, architecture, data-model outline, deployment state model, threat model, technology decisions, and delivery plan.

### In progress

- No phase is currently in progress.

### Planned next

- **Phase 1 — Repository foundation:** runnable pnpm workspace, web/API/worker health endpoints, shared configuration, PostgreSQL, Redis, Docker Compose, tests, and CI.

### Planned later

- Phases 2–16 below.

### Not currently planned

- Kubernetes, multi-region deployments, billing, public multi-tenant hosting, enterprise SSO, multiple cloud providers, a custom runtime, AI recommendations, mobile apps, and a plugin marketplace.

## Release path

Tagged releases are created only for meaningful runnable milestones:

| Target | Demonstrable outcome |
| --- | --- |
| `v0.1.0` | Local environment, authentication, and project management work from a clean setup. |
| `v0.2.0` | A background worker clones repositories and builds images with live progress. |
| `v0.3.0` | Built applications run behind generated local preview URLs. |
| `v0.4.0` | Health-checked activation preserves healthy releases and supports rollback. |
| `v0.5.0` | Verified GitHub push webhooks safely trigger deployments. |
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

**Status:** Planned next

Scope:

- pnpm workspace with `apps/web`, `apps/api`, `apps/worker`, and shared packages.
- An explicitly selected open-source license before implementation contributions expand.
- Next.js, Fastify, and worker health endpoints.
- PostgreSQL and Redis through Docker Compose.
- Runtime-validated environment configuration and actionable startup errors.
- Formatting, linting, type checking, Vitest, builds, and GitHub Actions.
- Tested clean-setup instructions.

Exit gate: a fresh clone can start infrastructure and all applications, observe health, and pass the documented quality commands.

### Phase 2 — Domain model and persistence

**Status:** Planned

Add users, organizations, memberships, projects, deployments, events, logs, runtime instances, encrypted-variable metadata, webhook deliveries, audit events, and the centrally tested deployment state machine.

Exit gate: clean migrations succeed and transactional tests prove ownership and transition invariants.

### Phase 3 — Authentication and authorization

**Status:** Planned

Add secure sessions, membership roles, organization isolation, rate limiting, security headers, audit events, and sign-in UI.

Exit gate: positive and negative integration tests cover every role and cross-organization access path.

### Phase 4 — Project management

**Status:** Planned

Add project CRUD, safe GitHub repository configuration, Dockerfile/health/runtime settings, encrypted environment variables, and project UI.

Exit gate: a user can configure a valid project without exposing secrets or accepting unsafe repository input.

### Phase 5 — Queue and worker foundation

**Status:** Planned

Add typed BullMQ contracts, idempotency, retry/timeout policies, dead-letter handling, heartbeat, reconciliation entry points, and graceful shutdown.

Exit gate: duplicate jobs and worker restarts preserve authoritative state and do not duplicate demonstrated side effects.

### Phase 6 — Repository preparation

**Status:** Planned

Add the Git provider/cloner ports, public GitHub adapter, exact revision resolution, bounded cloning, metadata storage, and Dockerfile validation.

Exit gate: healthy and malicious source fixtures prove revision integrity, constraints, failure categories, and timeouts.

### Phase 7 — Build pipeline

**Status:** Planned

Add BuildKit integration, immutable image tags, context preparation, cache behavior, live build logs, cancellation, cleanup, timeouts, and failed-build handling.

Exit gate: included healthy/failing applications exercise success, failure, timeout, cancellation, cache, redaction, and cleanup paths.

### Phase 8 — Runtime deployment

**Status:** Planned

Add the runtime port and Docker adapter, restricted container creation, port discovery, stop/removal, runtime logs, and reconciliation labels.

Exit gate: lifecycle tests inspect resource limits and prove idempotent start/stop/cleanup behavior.

### Phase 9 — Routing and preview URLs

**Status:** Planned

Add collision-resistant hostnames, Traefik route registration/removal/restoration, and observed-state reconciliation.

Exit gate: local preview routing works after proxy/worker restart and cannot cross project or organization boundaries.

### Phase 10 — Health checks and activation

**Status:** Planned

Add configurable HTTP checks, grace periods, atomic healthy promotion, previous-release preservation, and detailed health presentation.

Exit gate: delayed and unhealthy examples prove that only healthy candidates become active and failed candidates leave the previous route intact.

### Phase 11 — Deployment controls

**Status:** Planned

Add history, retry, stop, cancellation, rollback, superseded release handling, confirmations, timeline UI, and audit events.

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
