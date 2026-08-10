# Persistence model

## Purpose

PostgreSQL is LaunchRail's authoritative record of tenant ownership, project configuration, deployment intent, and background-work status. Phase 2 introduced the schema/deployment transaction boundary; Phase 4 added safe project mutation and authenticated environment-variable envelopes; Phase 5 adds durable job attempts, due times, leases/fencing, dead letters, and worker heartbeats. Redis, workers, containers, and routes remain downstream effects; none may silently replace persisted truth.

## Package boundaries

- `packages/domain` owns deployment states/transitions and normalized project/variable rules.
- `packages/application` exposes deployment, project, job, and heartbeat use cases through narrow ports.
- `packages/database` owns Drizzle schema/migrations, PostgreSQL adapters, durable work-item/heartbeat state, and the AES-256-GCM cipher implementation.

This direction keeps Fastify, BullMQ, Docker, and Drizzle out of the domain rules.

## Stored entities

The schema includes users, organizations, memberships, projects, deployments, deployment events, build logs, runtime instances, active releases, encrypted environment-variable metadata, webhook deliveries, audit events, idempotent deployment commands, durable deployment jobs, and worker heartbeats.

Organization-owned relationships use composite foreign keys so a valid identifier from one organization cannot be attached to a record in another. The active-release table has one row per project and a composite constraint proving that its deployment belongs to the same project and organization.

Deployment source revision, source snapshot, configuration snapshot, retry origin, project, and organization are immutable after insertion. A PostgreSQL trigger rejects direct changes to those fields. State-specific checks require structured failure details for failure states and a recorded successful health check for active or superseded releases.

Active project names are unique case-insensitively per organization. Project rows carry a positive optimistic `version` and nullable `archived_at`; all active API reads filter out archived rows. Database checks mirror project name, GitHub owner/repository, branch, relative Dockerfile, origin health path/port, and exact runtime JSON shape/bounds.

Environment-variable rows store base64url ciphertext, 96-bit nonce, 128-bit authentication tag, `aes-256-gcm` algorithm, and positive key version—never plaintext. The keyring remains outside PostgreSQL. The cipher's additional authenticated data binds the envelope to its organization, project, and normalized variable name, and a uniqueness constraint prevents a key-version/nonce pair from being reused.

## Transaction behavior

An ordinary transition:

1. Locks and reloads the organization-scoped deployment.
2. Returns a prior result when the same deployment/idempotency key was committed.
3. Validates the state pair against the domain transition map.
4. Updates state, version, failure fields, and event sequence.
5. Appends the ordered deployment event, command result, and audit event.
6. Commits all writes together.

Healthy promotion additionally locks the project, verifies the recorded health result, supersedes the prior active deployment when present, promotes the candidate, replaces the active pointer, and appends release/audit events in one transaction. Project locking serializes competing promotions.

Activation cannot use the ordinary transition method. Failed candidates never enter the promotion transaction and therefore cannot change the active pointer.

A project create transaction inserts configuration and its audit event. Update locks the active organization-scoped project and compares `expectedVersion` before writing an incremented version and changed-field-only audit metadata. Environment-variable replacement writes a newly encrypted envelope and a value-free audit record atomically.

Archive also locks and version-checks the project. It rejects any active release or deployment outside a terminal state. A successful transaction sets `archived_at`, increments the version, deletes all encrypted variables, and records the deleted count; it does not delete the project or its terminal deployment/event history.

## Durable background work

Each Phase 5 deployment work item belongs to one organization-owned deployment and records one supported contract version/kind, a constrained status, attempts, next due time, optional exclusive lease, safe failure details, completion/dead-letter time, and timestamps. The unique deployment/kind constraint makes creation idempotent. A running row must carry a worker ID, heartbeat, expiry, and unique lease token; every heartbeat, completion, and failure mutation must present that token, and the store refuses stale, expired, or replaced ownership.

BullMQ carries only the contract version, supported kind, and work-item UUID; it carries no deployment authority, configuration, or secrets. Claim reloads the joined deployment and organization from PostgreSQL, increments the durable attempt, creates a new fencing token, and sets a bounded lease. PostgreSQL's live clock—not a caller timestamp—decides due status, lease ownership/expiry, retry availability, recovery, and heartbeat freshness. Under that lease, one PostgreSQL transaction applies or replays the stable-idempotency `queued` to `cloning` transition and marks the work item complete; neither write can commit without the other. Safe failure either records a deterministic next due time or dead-letters the row when attempts are exhausted. Redis state never changes those facts directly.

Reconciliation creates missing work for eligible queued deployments, republishes due work absent from Redis, and recovers expired running leases into retry or dead-letter state. Worker heartbeats persist `starting`, `ready`, `draining`, and `stopped` status plus active-job count; they are operational records, not a replacement for an HTTP readiness endpoint.

## Migrations and tests

Generate a new reviewable migration after changing the schema:

```bash
pnpm db:generate
```

Apply all pending migrations:

```bash
pnpm db:migrate
```

Run the destructive database integration suite only against a disposable database:

```bash
DATABASE_URL=postgresql://launchrail:launchrail_dev_only@127.0.0.1:5432/launchrail \
  pnpm test:database
```

GitHub Actions creates fresh Compose volumes, applies the migration history, exercises the PostgreSQL invariants, and deletes the volumes. Local unit and static checks do not claim that real-database tests passed when PostgreSQL is unavailable.

The Phase 4 migration upgrades the Phase 2 `{}` runtime placeholder to bounded defaults. It stops before adding the required authentication tag if any legacy `environment_variables` row exists because those ciphertext rows cannot be authenticated as AES-GCM. Back up and re-enter those values through the Phase 4 API; do not bypass the guard or invent a tag. See [project management](project-management.md#migration-note).

## Current limitations

Identity and project adapters are connected to authenticated HTTP handlers; there is still no deployment-start HTTP/UI path. The Phase 5 worker connects only the `queued` to `cloning` claim and does not access repository source. Encrypted values are stored safely but are absent from Redis and are not decrypted/injected for a runtime; key-version re-encryption is not automated. Stream notification, source/build/runtime orchestration, rollback, cancellation cleanup, route reconciliation, and broad interruption recovery require later phases even though their legal deployment-state pairs are centralized.

See [queue and worker operations](queue-worker.md) for the Redis boundary, retry formula, reconciliation loop, and shutdown behavior.
