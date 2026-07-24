# Development workflow

## Current repository state

Phases 1 and 2 provide a runnable TypeScript workspace, web/API/worker processes, shared foundations, a framework-independent deployment domain, and a PostgreSQL persistence package with generated migrations and transactional transition operations. Authentication and API wiring begin in Phase 3.

## Prerequisites

- Node.js 22.22 or newer (the exact development version is in `.nvmrc`).
- Corepack with pnpm 11.9.0.
- Docker Engine and Docker Compose for PostgreSQL and Redis.
- Git.

The workspace pins application dependencies in `pnpm-lock.yaml`. Do not replace a frozen install with an unreviewed lockfile update in CI or setup instructions.

## Clean setup

From a fresh clone:

```bash
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
pnpm services:up
pnpm dev
```

`pnpm services:up` waits until PostgreSQL and Redis pass their container health checks. `pnpm dev` builds shared packages once, then starts the web, API, and worker processes together.

Open:

- Web application: `http://localhost:3000`
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

The timestamp varies. These endpoints prove process liveness only; dependency readiness is planned with persistence and queue integration.

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

| Variable                                   | Purpose                         | Local default           |
| ------------------------------------------ | ------------------------------- | ----------------------- |
| `NODE_ENV`                                 | Runtime policy                  | `development`           |
| `LOG_LEVEL`                                | API/worker structured log level | `info`                  |
| `API_HOST`, `API_PORT`                     | API health listener             | `127.0.0.1:4000`        |
| `WORKER_HEALTH_HOST`, `WORKER_HEALTH_PORT` | Worker health listener          | `127.0.0.1:4001`        |
| `WEB_HOST`, `WEB_PORT`                     | Next.js listener                | `127.0.0.1:3000`        |
| `NEXT_PUBLIC_API_BASE_URL`                 | Browser-facing API base URL     | `http://localhost:4000` |
| `DATABASE_URL`                             | PostgreSQL connection URL       | Local Compose service   |
| `REDIS_URL`                                | Redis connection URL            | Local Compose service   |
| `POSTGRES_*`, `REDIS_PORT`                 | Compose service configuration   | See `.env.example`      |

Configuration parsing reports every invalid field without echoing supplied values. Production mode rejects the documented development database password. Encryption, session, GitHub, and webhook secrets will have no insecure production defaults when those features are introduced.

## Workspace layout

```text
apps/api                  Fastify HTTP boundary and health endpoint
apps/web                  Next.js interface and web health endpoint
apps/worker               Worker process and health server
packages/config           Runtime-validated process configuration
packages/contracts        Shared transport and health contracts
packages/observability    Redacted structured logger conventions
scripts                   Repeatable application smoke checks
packages/domain           Deployment states and transition invariants
packages/application      Deployment use cases and persistence ports
packages/database         Drizzle schema, migrations, and PostgreSQL adapter
```

The dependency direction is `database -> application -> domain`; package builds run in topological order.

## Quality commands

Run all applicable checks before committing:

```bash
pnpm format:check
pnpm docs:lint
pnpm lint
pnpm typecheck
pnpm test
pnpm test:database
pnpm test:integration
pnpm build
pnpm smoke:health
docker compose --env-file .env.example config --quiet
```

`pnpm smoke:health` starts built applications on temporary loopback ports, validates each service/status payload, prints logs on failure, and shuts the processes down. It does not require PostgreSQL or Redis because Phase 1 health is intentionally liveness-only.

`pnpm test:database` requires `DATABASE_URL` and a PostgreSQL database that may be truncated by the suite. GitHub Actions starts a disposable database, applies migrations from empty state, runs the database integration suite, verifies Redis, and removes the service volumes.

See [persistence.md](persistence.md) for the schema, migration, transaction, and clean-database workflow.

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

## API changes

Update runtime request/response schemas, generated OpenAPI output, authorization tests, and integration tests together. Errors use stable machine-readable categories and safe human-readable messages. Do not expose adapter exception text directly.

## Worker and infrastructure changes

Document retry, timeout, idempotency, cancellation, cleanup, and crash behavior. Tests should use fake ports for domain/application behavior and real disposable services for adapter contracts. Docker integration commands must operate only on resources labeled for their isolated test run.

## User-interface changes

Exercise loading, empty, success, permission-denied, and failure states. Run relevant component and Playwright tests, check keyboard navigation and responsive layout, and capture screenshots only for complete user-facing milestones.

## Troubleshooting

- `Cannot connect to the Docker daemon`: start the host's Docker service and confirm `docker info` works for the current user.
- Port already in use: change the corresponding port in `.env`; the smoke test selects temporary ports automatically.
- Invalid configuration: read the complete field list in the startup error and compare it with `.env.example`.
- Stale generated output: remove ignored `dist`/`.next` directories and rerun `pnpm build`; do not delete source or service volumes.
