# Single-host operations

These procedures cover the supported trusted Linux demonstration. They do not establish production availability, hostile multi-tenant isolation, or a disaster-recovery SLA.

## Backup and restore

PostgreSQL is authoritative for identity, project configuration, encrypted variables, deployment intents, leases, events, and active-release pointers. Redis wake-ups are reconstructible and are not a substitute for a database backup. Build caches and source checkouts are disposable; runtime images and configuration must be available when recovering a release.

Create a private backup directory and a PostgreSQL custom-format archive. For example, after selecting the correct database and ensuring the destination is new:

```bash
set -e
umask 077
mkdir -m 700 /absolute/private/launchrail-backup
docker compose exec -T postgres pg_dump -U launchrail -d launchrail --format=custom \
  > /absolute/private/launchrail-backup/database.dump
```

`pg_dump` takes a consistent database snapshot even while the application writes. Keep the archive private: it contains password hashes, session hashes, deployment metadata, and encrypted secret envelopes. Separately retain the matching encryption keyring, active key version, and service configuration in an access-controlled offline secret store. Losing historical key versions makes their saved variables unreadable; placing the keyring beside the archive under identical access controls defeats that separation. Never commit either backup data or key material.

Rehearse restoration into a **new, empty database**, not an existing deployment database:

```bash
set -e
docker compose exec -T postgres createdb -U launchrail launchrail_restore_rehearsal
docker compose exec -T postgres pg_restore -U launchrail -d launchrail_restore_rehearsal \
  --exit-on-error < /absolute/private/launchrail-backup/database.dump
docker compose exec -T postgres psql -U launchrail -d launchrail_restore_rehearsal \
  -c 'select count(*) from drizzle.__drizzle_migrations;'
```

If the destination already exists, select another new name; do not add `--clean`, drop a database, or bypass errors to make the rehearsal pass. Compare identity/project/event counts and verify the migration history and constraints. Before using the restored database, apply any later migrations with its explicit `DATABASE_URL`. Test encrypted-variable reads with the matching keyring through the persistence adapter before accepting a disaster-recovery procedure.

Do not start a second worker against a restored database on the same Docker host. Orphan reconciliation treats its database as authoritative for all LaunchRail-managed Docker resources and could remove another instance's runtimes. Restore on an isolated host, or first stop the original worker and explicitly reconcile the original runtime inventory with the restored state. Route files are reconstructed from database records; they are not authority for release ownership.

The 2026-10-12 rehearsal restored a private custom-format archive of the synthetic acceptance database into a new database: two users, two memberships, nine deployments, and all 13 migrations were retained. This proves the logical database round trip, not point-in-time recovery, image preservation, encrypted-variable recovery, or a production backup policy.

## Service interruptions

- API interruption does not revoke accepted database intents; retry reads after API readiness recovers. Do not blindly repeat a mutation after an ambiguous connection failure.
- Redis loss delays identifier-only wake-ups. PostgreSQL remains authoritative; worker reconciliation republishes eligible work after Redis recovers.
- PostgreSQL loss fences authoritative work; do not promote a runtime or infer release state from Redis or proxy files alone.
- Worker interruption leaves leases durable. Expired work is recovered within configured retry limits; pending cancellation and terminal cleanup remain in database state.
- Proxy interruption temporarily removes preview availability, not the durable active-release pointer. Restart Traefik and verify the exact hostname returns the expected application.
- Docker daemon recovery remains an operator action. Start Docker, verify worker readiness, and inspect runtime inventory. A missing active runtime is recorded as an actionable terminal failure, not silently reported healthy.

After each interruption, check API and worker `/ready`, deployment history/events, queue/reconciliation metrics, and the exact preview hostname. `/health` proves process liveness only. Readiness does not prove proxy availability or correct application content.

## Physical interruption acceptance

`pnpm acceptance:interruptions` owns its API/worker child processes and tests five documented boundaries on the dedicated Linux demonstration: API abrupt exit after accepted queued intent, worker abrupt exit during an observed uncached build step, Redis loss while accepting queued work, PostgreSQL loss while a prior preview is active, and proxy loss while database authority remains active. It verifies readiness, eventual activation, one activation event, exact preview content, and scenario-container cleanup through durable stop/reconciliation. It stops and restarts only inspected `launchrail` Compose service containers; volumes are never deleted.

Start from a clean committed clone with a **new acceptance database**, fresh generated private configuration, synthetic `@launchrail.test` owner bootstrap, no LaunchRail-managed containers, no other worker, and free API/worker ports. The database name must use a `launchrail_` acceptance/release name. The API and worker must bind to `127.0.0.1`. Keep the original database and a private backup. Use a fresh dedicated BuildKit cache: a cached sleep step is rejected rather than misreported as an in-progress build fault. Do not clear unrelated caches to satisfy this requirement.

After installing, setting up services, migrating, bootstrapping the owner, and building the clone:

```bash
LAUNCHRAIL_ACCEPTANCE_ALLOW_MUTATION=DEDICATED_LOCAL_ACCEPTANCE \
LAUNCHRAIL_ACCEPTANCE_SOURCE_REVISION=FULL_PUBLISHED_COMMIT_SHA \
  pnpm acceptance:interruptions > /absolute/private/interruption-report.json
```

The command reads `.env` but never publishes passwords/cookies/key material. Child logs live in a private generated `output/interruptions-*` directory; successful stdout is a machine-readable report. It restores scoped stopped services and drains its processes even on failure. Failed-scenario records/resources are preserved for diagnosis; inspect them before repeating. One boundary per component is not proof of every crash point, simultaneous outages, physical Docker-host loss, or an availability SLA.

## Alerts and recovery ownership

The optional [observability stack](observability.md) includes starter worker-availability/heartbeat, queue backlog, dead-letter, runtime-orphan, route-drift, and deployment-failure alerts. They are local operator aids, not externally delivered incident notifications. Review alert labels and thresholds against the configured heartbeat/reconciliation intervals. Keep the Docker host and privileged BuildKit daemon trusted, inventory managed resources before cleanup, and preserve unrelated containers.
