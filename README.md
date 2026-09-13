# LaunchRail

**A self-hosted platform that turns a GitHub repository into a health-checked application deployment with live logs, preview URLs, release history, and safe rollback.**

> **Phase 9 is Available.** Clean CI verifies restricted runtimes, persisted preview-route ownership, organization-fenced reconciliation, and safe promotion/terminal cleanup.

## What LaunchRail does

LaunchRail is designed to take an application stored on GitHub, build it automatically, run it in an isolated container, check whether it started successfully, and give the user a URL where it can be accessed.

The finished local demonstration will let a user:

- Connect a GitHub repository and select a revision to deploy.
- Watch build and runtime logs as they happen.
- Open a generated preview URL after health checks pass.
- Inspect deployment history and actionable failure details.
- Retry, cancel, stop, or roll back a release.
- Trigger deployments from verified GitHub push webhooks.

The engineering challenge goes beyond starting a container: LaunchRail must coordinate long-running jobs, preserve the last healthy release when a new one fails, recover safely after worker restarts, isolate organizations, and expose enough telemetry to explain what happened.

## How it fits together

```mermaid
flowchart LR
    User["User"] --> Web["Next.js web app"]
    Web --> API["Fastify API"]
    GitHub["GitHub"] --> API
    GitHub --> Worker
    API --> DB[("PostgreSQL")]
    API --> Queue["Redis and BullMQ"]
    Queue --> Worker["Deployment worker"]
    Worker --> Build["Docker BuildKit"]
    Worker --> Runtime["Docker runtime"]
    Runtime --> Proxy["Traefik proxy"]
    Proxy --> Preview["Preview URL"]
    Worker --> Telemetry["Logs, metrics, and traces"]
```

LaunchRail will use a modular monolith for the web/API boundary and a separate worker for deployment jobs. Infrastructure-specific behavior sits behind explicit interfaces so the core deployment rules do not depend directly on Docker, GitHub, Redis, or the web framework. See [ARCHITECTURE.md](ARCHITECTURE.md) for the technical design.

## Current status

### Available

- Product scope, target users, success criteria, and non-goals.
- Proposed architecture and initial technology decisions.
- Deployment lifecycle and explicit state-machine design.
- Initial threat model, security boundaries, and phased roadmap.
- Pinned pnpm workspace with Next.js web, Fastify API, worker, and shared packages.
- Health endpoints for all three applications and structured API/worker logging.
- Validated environment configuration with actionable errors and production guards.
- Loopback-only PostgreSQL and Redis development services with health checks.
- Formatting, linting, type checking, unit/integration tests, builds, smoke tests, and GitHub Actions.
- Apache 2.0 open-source license.
- Organization-scoped users, memberships, projects, deployments, events, logs, runtime instances, encrypted-variable metadata, webhook deliveries, and audit events.
- Generated Drizzle migrations plus an immutable deployment snapshot guard.
- Central fourteen-state deployment lifecycle with exhaustive valid/invalid transition tests.
- Transactional, idempotent PostgreSQL transitions that append ordered events and audit records.
- Health-gated promotion that atomically supersedes the previous release and maintains one active pointer.
- Scrypt password credentials and bootstrapped first-owner setup without logged secrets.
- Hashed opaque sessions with absolute/idle expiry, rolling activity, and revocation.
- Owner, admin, developer, and viewer permission policies enforced at organization API boundaries.
- Cross-organization concealment, strict origin checks, sign-in throttling, secure cookie policy, and security headers.
- Organization member management, audit-history APIs, and a responsive sign-in/session surface.
- Real-PostgreSQL authorization coverage for every role and protected cross-organization path.
- Organization-scoped project create, read, update, and soft-archive APIs with optimistic versions and audited writes.
- Canonical `https://github.com/owner/repository` input plus safe branch, Dockerfile, health-check, and bounded runtime configuration.
- AES-256-GCM environment-variable storage with fresh nonces, authentication tags, a versioned keyring, and organization/project/name-bound authenticated context.
- Write-only secret values: owner/admin users receive names and timestamps, while plaintext is never returned by project APIs.
- Responsive `/projects` workspace with role-aware create, edit, archive, and environment-variable controls.
- Strict `deployment.claim` and `deployment.prepare_source` wake-ups carrying only a contract version, supported kind, and opaque PostgreSQL work-item ID.
- Durable PostgreSQL attempts, due times, leases, fencing, dead-letter state, and operational worker heartbeats are implemented.
- The worker uses at-least-once BullMQ wake-ups, PostgreSQL-managed retry/reconciliation, and lease-fenced transactions for both the `queued` to `cloning` claim and `cloning` to `building` source handoff.
- Fixed-origin, public-only GitHub resolution verifies repository visibility, requested revision, exact commit/tree identity, and bounded tree metadata without redirects or ambient credentials.
- Hardened Git checkout uses no shell, isolates configuration and credentials, fetches the verified SHA, bounds time/output/disk use, and cancels the complete process group.
- Post-checkout inspection verifies Git blob identities, enforces file/byte/path/depth limits, rejects unsupported files/LFS/unsafe symlinks, and stores a contained Dockerfile path and digest.
- Immutable portable source-preparation metadata and revalidated checkout adoption make duplicate delivery and worker restart safe without storing absolute host paths.
- Clean disposable PostgreSQL/Redis acceptance, source fixtures, code-quality, build, and health checks are verified by [GitHub Actions run 31414001234](https://github.com/Zamuel66666/LaunchRail/actions/runs/31414001234).
- Restricted Docker runtimes use stable ownership labels, loopback-only dynamic ports, a non-root user, dropped Linux capabilities, no-new-privileges, resource limits, optional read-only root filesystems, bounded timestamped log reads, and idempotent adoption/removal.
- Clean PostgreSQL/Redis recovery plus real constrained BuildKit and Docker lifecycle acceptance are verified by [GitHub Actions run 34690600740](https://github.com/Zamuel66666/LaunchRail/actions/runs/34690600740).
- Pinned Traefik file-provider routing uses collision-resistant deployment hostnames, atomic private configuration files, bounded targets, and observed-state reconciliation; real proxy acceptance is verified by [GitHub Actions run 34769727393](https://github.com/Zamuel66666/LaunchRail/actions/runs/34769727393).
- Runtime startup can gate completion on a bounded loopback-only HTTP health check; durable health jobs, retries, and activation remain in progress.
- Authenticated deployment controls currently expose bounded health/event history plus idempotent promote, cancel, and stop operations; retry and rollback orchestration remain in progress.

### Planned next

- Persisted running runtime metadata is reconciled into Traefik routes by the worker after restart.
- Run HTTP health checks before promoting a deployment to the active release.

### Not currently planned

- Kubernetes, multi-region deployment, billing, enterprise SSO, and public multi-tenant hosting.
- A custom container runtime, mobile apps, or AI deployment recommendations.

## Try it locally

Prerequisites: Node.js 22.22 or newer, Corepack/pnpm 11.9, Docker, and Docker Compose.

```bash
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
# Generate a local project-secret key directly into the untracked .env file.
node -e "process.stdout.write('LAUNCHRAIL_SECRET_KEYRING=1:'+require('node:crypto').randomBytes(32).toString('base64url')+'\nLAUNCHRAIL_ACTIVE_SECRET_KEY_VERSION=1\n')" >> .env
pnpm services:up
pnpm db:migrate
# Set the LAUNCHRAIL_BOOTSTRAP_* values in .env, then run:
pnpm auth:bootstrap
pnpm dev
```

Never commit `.env` or the generated key. Open [http://localhost:3000/projects](http://localhost:3000/projects) for project management or [http://localhost:3000](http://localhost:3000) for the recruiter-readable overview. Health endpoints are available at:

- Web: `http://localhost:3000/api/health`
- API: `http://localhost:4000/health`
- Worker: `http://localhost:4001/health`

Stop the application processes with `Ctrl+C`, then stop PostgreSQL and Redis without deleting their volumes:

```bash
pnpm services:down
```

See the [development guide](docs/development.md) for verification, configuration, cleanup, and troubleshooting.

## Documentation

- [Product scope](docs/product-scope.md)
- [Architecture](ARCHITECTURE.md)
- [Deployment lifecycle](docs/deployment-lifecycle.md)
- [Security policy](SECURITY.md) and [threat model](docs/threat-model.md)
- [Roadmap](ROADMAP.md) and [changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md) and [development workflow](docs/development.md)
- [Testing strategy](docs/testing.md), [observability design](docs/observability.md), and [benchmark methodology](docs/benchmarks.md)
- [Persistence model and transaction rules](docs/persistence.md)
- [Authentication and authorization](docs/authentication.md)
- [Project management and secret rotation](docs/project-management.md)
- [Queue and worker operations](docs/queue-worker.md)
- [Repository preparation and source security](docs/repository-preparation.md)
- [Image builds and BuildKit boundaries](docs/image-builds.md)
- [Architecture decisions](docs/adr/)

## Current limitations

LaunchRail is not production-ready. Authentication remains local-password only without password reset, invitations, MFA, SSO, or session administration. There is no deployment-start HTTP endpoint or deployment UI yet, so the worker operates only for an already-persisted immutable deployment. Source preparation supports unauthenticated public GitHub repositories only; private repositories, Git LFS, submodules, and external-network smoke tests are intentionally unsupported. Checkouts and local images/runtimes remain on a trusted worker host; broad hard-crash orphan cleanup remains Phase 14 work. Saved secrets are not placed in Redis or injected into workloads, and automated key re-encryption is not implemented. Preview routing, HTTP health activation, browser log streaming, deployment controls, webhooks, registry publication/signing/scanning, and full telemetry remain later phases. The BuildKit daemon and Docker host are trusted infrastructure, so current limits do not make a single-host worker a hostile multi-tenant sandbox. Application health endpoints and `pnpm smoke:health` prove process liveness only, not queue/database readiness.

## License

LaunchRail is licensed under the [Apache License 2.0](LICENSE). See [ADR-0005](docs/adr/0005-apache-2-license.md) for the decision.
