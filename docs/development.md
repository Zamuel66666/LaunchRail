# Development workflow

## Current repository state

Phases 1 through 6 provide the currently accepted runnable TypeScript workspace, web/API/worker processes, deployment-domain/PostgreSQL transition persistence, authenticated organization/project routes, encrypted environment-variable storage, PostgreSQL-authoritative BullMQ work, and hardened public GitHub source preparation through `building`. No deployment-start use case, HTTP route, web flow, or image build exists yet.

## Prerequisites

- Node.js 22.22 or newer (the exact development version is in `.nvmrc`).
- Corepack with pnpm 11.9.0.
- Docker Engine and Docker Compose for PostgreSQL and Redis.
- Linux with Git available at `/usr/bin/git` for the production source adapter.

The workspace pins application dependencies in `pnpm-lock.yaml`. Do not replace a frozen install with an unreviewed lockfile update in CI or setup instructions.

## Clean setup

From a fresh clone:

```bash
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
# Generate a local 32-byte project-secret key without printing it.
node -e "process.stdout.write('LAUNCHRAIL_SECRET_KEYRING=1:'+require('node:crypto').randomBytes(32).toString('base64url')+'\nLAUNCHRAIL_ACTIVE_SECRET_KEY_VERSION=1\n')" >> .env
pnpm services:up
pnpm db:migrate
# Configure LAUNCHRAIL_BOOTSTRAP_* in .env for a new database.
pnpm auth:bootstrap
pnpm dev
```

`pnpm services:up` waits until PostgreSQL and Redis pass their container health checks. `pnpm dev` builds shared packages once, then starts the web, API, and worker processes together.

Open:

- Web application: `http://localhost:3000`
- Project workspace: `http://localhost:3000/projects`
- Web health: `http://localhost:3000/api/health`
- API health: `http://localhost:4000/health`
- Worker health: `http://localhost:4001/health`

Each health response uses the shared contract:

```json
{
  "service": "api",
  "status": "ok",
  "timestamp": "2026-07-21T09:00:00.000Z",
  "version": "0.1.0"
}
```

The timestamp varies. These endpoints prove process liveness only. The worker's durable heartbeat and queue integration do not turn `/health` or the health smoke test into a queue/database readiness check.

## Stopping and cleanup

Stop the foreground application processes with `Ctrl+C`. Stop development services while preserving database/Redis volumes:

```bash
pnpm services:down
```

Inspect service state with `pnpm services:status`. To intentionally delete local service data, run:

```bash
docker compose down --volumes
```

The volume-deleting command is not wrapped in the normal shutdown script so data loss remains explicit.

## Environment configuration

`.env.example` is the safe local template. The API and worker load the root `.env` through Node's `--env-file-if-exists` option. The smoke test uses `.env` when present and falls back to `.env.example`.

| Variable                                   | Purpose                         | Local default             |
| ------------------------------------------ | ------------------------------- | ------------------------- |
| `NODE_ENV`                                 | Runtime policy                  | `development`             |
| `LOG_LEVEL`                                | API/worker structured log level | `info`                    |
| `API_HOST`, `API_PORT`                     | API health listener             | `127.0.0.1:4000`          |
| `WORKER_HEALTH_HOST`, `WORKER_HEALTH_PORT` | Worker health listener          | `127.0.0.1:4001`          |
| `WORKER_MODE`                              | Full worker or health-only      | `run`                     |
| `WORKER_QUEUE_NAME`, `WORKER_QUEUE_PREFIX` | Bounded BullMQ identifiers      | See `.env.example`        |
| `WORKER_CONCURRENCY`                       | Concurrent job handlers         | `2`                       |
| `WORKER_MAX_ATTEMPTS`                      | Durable attempt ceiling         | `5`                       |
| `WORKER_JOB_TIMEOUT_MS`                    | Per-job execution bound         | `300000`                  |
| `WORKER_BACKOFF_BASE_MS`, `*_CAP_MS`       | Deterministic retry bounds      | `1000`, `60000`           |
| `WORKER_LEASE_MS`                          | PostgreSQL job lease            | `60000`                   |
| `WORKER_HEARTBEAT_INTERVAL_MS`             | Job/worker heartbeat interval   | `10000`                   |
| `WORKER_RECONCILIATION_INTERVAL_MS`        | Recovery scan interval          | `15000`                   |
| `WORKER_RECONCILIATION_BATCH_SIZE`         | Maximum rows per recovery scan  | `100`                     |
| `WORKER_SHUTDOWN_GRACE_MS`                 | Active-work drain bound         | `30000`                   |
| `WORKER_SOURCE_ROOT`                       | Private retained checkout root  | `/tmp/launchrail-sources` |
| `WORKER_SOURCE_RESOLVE_*`                  | GitHub response/deadline bounds | See `.env.example`        |
| `WORKER_SOURCE_CLONE_TIMEOUT_MS`           | Source preparation deadline     | `120000`                  |
| `WORKER_SOURCE_GIT_*`                      | Git directory/output bounds     | See `.env.example`        |
| `WORKER_SOURCE_MAX_*`                      | Checkout file/byte/path bounds  | See `.env.example`        |
| `WEB_HOST`, `WEB_PORT`                     | Next.js listener                | `127.0.0.1:3000`          |
| `NEXT_PUBLIC_API_BASE_URL`                 | Browser-facing API base URL     | `http://localhost:4000`   |
| `DATABASE_URL`                             | PostgreSQL connection URL       | Local Compose service     |
| `REDIS_URL`                                | Redis connection URL            | Local Compose service     |
| `WEB_ORIGIN`                               | Allowed browser request origin  | `http://localhost:3000`   |
| `SESSION_*`                                | Cookie and session lifetimes    | See `.env.example`        |
| `SIGN_IN_RATE_LIMIT_MAX`                   | Sign-in attempts/client/minute  | `5`                       |
| `LAUNCHRAIL_SECRET_KEYRING`                | Versioned AES-256 project keys  | No default                |
| `LAUNCHRAIL_ACTIVE_SECRET_KEY_VERSION`     | Key version for new writes      | No default                |
| `LAUNCHRAIL_BOOTSTRAP_*`                   | One-time initial owner fields   | No active default         |
| `POSTGRES_*`, `REDIS_PORT`                 | Compose service configuration   | See `.env.example`        |

Configuration parsing reports every invalid field without echoing supplied values. Production mode rejects the documented development database password and an insecure browser origin. Source sub-timeouts cannot exceed the job timeout, the individual-file ceiling cannot exceed the checkout ceiling, and the source root must be absolute, normalized, non-root, private, and owned by the worker user. The API has no encryption-key default: its comma-separated keyring accepts one to eight unique positive versions with exact 32-byte base64url keys, and the selected active version must exist. Never commit `.env`; retain historical keys during manual rotation until every affected value has been replaced. The public GitHub adapter deliberately uses no credentials; future webhook/private-source credentials must have no insecure defaults.

## Workspace layout

```text
apps/api                  Fastify identity/project boundary and health endpoint
apps/web                  Next.js sign-in/project interface and web health endpoint
apps/worker               BullMQ claim/source worker, recovery loops, and health server
packages/config           Runtime-validated process configuration
packages/contracts        Shared transport and health contracts
packages/observability    Redacted structured logger conventions
scripts                   Repeatable application smoke checks
packages/domain           Deployment transitions and safe project value rules
packages/application      Deployment/project/source use cases and persistence ports
packages/database         Identity/project/deployment plus durable job/source/heartbeat adapters
packages/queue            BullMQ identifier-only wake-up adapter
packages/source           Public GitHub resolver and hardened exact-SHA Git checkout
```

Infrastructure packages depend on application/domain contracts rather than the reverse; package builds run in topological order.

## Quality commands

Run all applicable checks before committing:

```bash
pnpm format:check
pnpm docs:lint
pnpm lint
pnpm typecheck
pnpm test
pnpm test:database
pnpm test:queue
pnpm test:integration
pnpm build
pnpm smoke:health
pnpm audit --prod
docker compose --env-file .env.example config --quiet
```

`pnpm smoke:health` starts built applications on temporary loopback ports, synthesizes an ephemeral keyring only when the environment lacks one, forces `WORKER_MODE=health-only`, validates each service/status payload, prints logs on failure, and shuts the processes down. It intentionally does not prove queue/database readiness.

`pnpm test:database` requires `DATABASE_URL` and a PostgreSQL database that may be truncated by the suite. `pnpm test:queue` requires both `DATABASE_URL` and `REDIS_URL`; both targets must be disposable. GitHub Actions starts both services, applies migrations from empty state, runs the real database and queue/worker integration suites, and removes the service volumes.

See [persistence.md](persistence.md) for the schema, migration, transaction, and clean-database workflow; [authentication.md](authentication.md) for bootstrap/session behavior; [project-management.md](project-management.md) for project routes, bounds, encryption, archival, and key rotation; [queue-worker.md](queue-worker.md) for job contracts, durable retry/recovery state, operation, and shutdown; and [repository-preparation.md](repository-preparation.md) for provider, checkout, filesystem, persistence, and security boundaries.

## Session workflow

1. Inspect repository status, recent commits, README, roadmap, and relevant documents.
2. Identify the next incomplete phase and choose a bounded milestone.
3. Confirm the worktree does not contain unrelated user changes.
4. Define observable acceptance evidence before implementation.
5. Implement domain behavior and adapters in their proper boundaries.
6. Add deterministic tests and update documentation with the same change.
7. Run applicable gates and inspect the complete/staged diff.
8. Commit coherent units with precise messages and push without rewriting published history.
9. Update visible status only after the milestone is proven.

## Database changes

Every schema change must include a generated, reviewable migration and tests from a clean database. Migrations should be forward-safe for the supported unreleased/release path; if rollback is supported, test it. Never edit an already-published migration to disguise a later change.

The Phase 4 migration intentionally refuses databases that already contain legacy environment-variable rows because those rows lack an authentication tag. Follow the backup/re-entry procedure in [project-management.md](project-management.md#migration-note) rather than bypassing the guard.

## API changes

Update runtime request/response schemas, generated OpenAPI output, authorization tests, and integration tests together. Errors use stable machine-readable categories and safe human-readable messages. Do not expose adapter exception text directly.

## Worker and infrastructure changes

Document retry, timeout, idempotency, cancellation, cleanup, and crash behavior. Tests should use fake ports for domain/application behavior and controlled local fixtures or real disposable services for adapter contracts. Queue tests require both PostgreSQL and Redis because Redis delivery alone cannot prove authoritative recovery; source tests use fake HTTP and local real-Git repositories rather than external GitHub. Docker integration commands must operate only on resources labeled for their isolated test run.

## User-interface changes

Exercise loading, empty, success, permission-denied, and failure states. Run relevant component and Playwright tests, check keyboard navigation and responsive layout, and capture screenshots only for complete user-facing milestones.

## Troubleshooting

- `Cannot connect to the Docker daemon`: start the host's Docker service and confirm `docker info` works for the current user.
- Port already in use: change the corresponding port in `.env`; the smoke test selects temporary ports automatically.
- Invalid configuration: read the complete field list in the startup error and compare it with `.env.example`.
- Missing active secret key: generate the local key once, then confirm the active version exists in `LAUNCHRAIL_SECRET_KEYRING`; do not replace old keys during rotation until their rows have been re-encrypted.
- Stale generated output: remove ignored `dist`/`.next` directories and rerun `pnpm build`; do not delete source or service volumes.
