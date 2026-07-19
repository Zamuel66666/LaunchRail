# ADR-0003: PostgreSQL, Drizzle, Redis, and BullMQ

- **Status:** Accepted
- **Date:** 2026-07-19

## Context

Deployment state requires transactions, constraints, auditable history, and recovery after process restarts. Background builds need retries, timeouts, concurrency control, and delayed jobs. Queue delivery can be duplicated, so persistence and job processing must have explicit ownership.

## Decision

Use PostgreSQL as the authoritative store, Drizzle ORM for typed schema/query access and explicit SQL migrations, Redis for ephemeral coordination, and BullMQ for background job delivery.

The API persists deployment intent before enqueueing. Jobs carry identifiers, not authoritative mutable state. Workers re-read PostgreSQL, apply idempotency rules, and record transitions transactionally. A reconciliation task finds persisted queued or interrupted work that is absent from the queue.

## Consequences

- Database constraints and transactions protect core deployment invariants.
- Drizzle keeps SQL and migrations visible while reducing unsafe query construction.
- BullMQ supplies practical retry and scheduling behavior for the local platform.
- The system has two datastores to operate and observe.
- Redis loss can delay work but must not erase authoritative deployment state.
- Exactly-once processing is not claimed; duplicate jobs and deliveries require tests.

## Alternatives considered

- **Prisma:** a reasonable option, but Drizzle better matches the goal of explicit SQL and lightweight shared packages.
- **PostgreSQL-only job polling:** reduces infrastructure but requires implementing queue behavior that BullMQ already provides.
- **Redis as deployment state:** rejected because durable relational constraints and transaction history are required.
