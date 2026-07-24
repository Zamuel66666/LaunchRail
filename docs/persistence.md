# Persistence model

## Purpose

PostgreSQL is LaunchRail's authoritative record of tenant ownership and deployment intent. Phase 2 adds the first complete schema and the transaction boundary used to move a deployment through its lifecycle. Redis, workers, containers, and routes remain downstream effects; none may silently replace persisted truth.

## Package boundaries

- `packages/domain` owns the deployment states, failure categories, and valid transition map.
- `packages/application` exposes transition and promotion use cases through a persistence port.
- `packages/database` owns the Drizzle schema, explicit SQL migrations, and PostgreSQL adapter.

This direction keeps Fastify, BullMQ, Docker, and Drizzle out of the domain rules.

## Stored entities

The initial schema includes users, organizations, memberships, projects, deployments, deployment events, build logs, runtime instances, active releases, encrypted environment-variable metadata, webhook deliveries, audit events, and idempotent deployment commands.

Organization-owned relationships use composite foreign keys so a valid identifier from one organization cannot be attached to a record in another. The active-release table has one row per project and a composite constraint proving that its deployment belongs to the same project and organization.

Deployment source revision, source snapshot, configuration snapshot, retry origin, project, and organization are immutable after insertion. A PostgreSQL trigger rejects direct changes to those fields. State-specific checks require structured failure details for failure states and a recorded successful health check for active or superseded releases.

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

## Current limitations

The persistence adapter is not yet connected to authenticated HTTP handlers or the deployment worker. Queue publication and stream notification happen after a future API/worker integration; this milestone stores no plaintext environment-variable value and does not yet implement encryption/decryption. Rollback, cancellation cleanup, and route reconciliation require later infrastructure phases even though their legal state pairs are already centralized.
