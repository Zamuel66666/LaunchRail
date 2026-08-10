# Queue and worker operations

## Current scope

Phase 5 provides LaunchRail's durable background-work foundation. PostgreSQL owns every work item's identity, organization/deployment relationship, status, attempt count, due time, lease, safe failure, completion/dead-letter result, and worker heartbeat. Redis and BullMQ provide at-least-once wake-ups only.

The single implemented job kind claims an eligible deployment from `queued` to `cloning`. This deliberately bounded side effect provides verified evidence for duplicate delivery and worker restart behavior. There is no deployment-start use case, HTTP endpoint, or web flow, and the worker does not contact GitHub, clone source, build an image, start a container, route traffic, activate a release, or expose deployment controls.

## Identifier-only wake-up contract

BullMQ receives a strict, runtime-validated version 1 payload:

```json
{
  "contractVersion": 1,
  "kind": "deployment.claim",
  "workItemId": "3b953ca5-a02b-446f-ad13-04bf6896e010"
}
```

No other field is accepted. In particular, Redis receives no organization/deployment authority, correlation metadata, repository/configuration data, environment-variable value, ciphertext, or key metadata. The worker uses `workItemId` to reload the deployment and organization through PostgreSQL.

Stable identifiers are derived from that UUID:

- BullMQ job ID: `deployment-claim-v1-<workItemId>`
- PostgreSQL transition idempotency key: `worker-claim-v1-<workItemId>`

The BullMQ ID intentionally contains no colon. Re-publishing the same work item therefore addresses the same wake-up rather than creating a new logical operation.

## Durable work-item lifecycle

| Status          | Meaning                                                                  |
| --------------- | ------------------------------------------------------------------------ |
| `pending`       | Persisted, has not run, and is eligible at its recorded due time.        |
| `running`       | Exclusively leased to one worker with a heartbeat and expiry.            |
| `retry_wait`    | A safe failure was persisted and the next attempt has a future due time. |
| `completed`     | The fenced claim side effect and completion were persisted.              |
| `dead_lettered` | The durable maximum attempt count was exhausted.                         |

Creation is idempotent for one deployment/job kind. A claim transaction reloads the organization-owned deployment, checks due/status eligibility, increments the attempt count, creates a unique lease token, and records worker ownership, heartbeat, and expiry. Heartbeat, completion, and failure calls must present that exact unexpired token. PostgreSQL `clock_timestamp()` evaluates due work, lease creation/extension/expiry, retry availability, recovery, and worker freshness, so a skewed worker clock cannot revive or steal a lease. A stale worker cannot mutate a lease after expiry or after another worker obtains a replacement token.

Under the current lease, one PostgreSQL transaction applies or replays `queued` to `cloning` with the stable work-item-derived idempotency key and marks the work item complete. The transition, deployment event, audit record, command result, and work-item completion commit together; a stale token cannot commit them, and replay does not append duplicates.

## Retry, timeout, and dead-letter policy

Phase 5 uses deterministic capped exponential backoff with stable 75–100% jitter. First calculate the cap for the attempt:

```text
attemptCap = min(WORKER_BACKOFF_CAP_MS, WORKER_BACKOFF_BASE_MS * 2^(attemptCount - 1))
delay = stableHash(workItemId, attemptCount) mapped to [ceil(0.75 * attemptCap), attemptCap]
```

The same work-item/attempt pair always yields the same delay, so reconciliation does not depend on queue-only randomness. The calculated due time is stored in PostgreSQL. Tests use short injected values without changing the production formula. An overall `WORKER_JOB_TIMEOUT_MS` deadline covers claim, transition, and finalization. If an authoritative database operation has not settled at the deadline, the handler does not race a failure write against it: the operation remains tracked, and its existing lease stays authoritative until the transaction settles or lease recovery schedules the next attempt.

Before the maximum attempt count, failure clears the lease and moves the row to `retry_wait` with a safe error code/message and next due time. At the maximum, it clears the lease and moves the row to `dead_lettered` with a timestamp. Each BullMQ wake-up has one delivery attempt and is removed after success or failure; BullMQ provides neither the retry scheduler nor a durable dead-letter queue. Dead-letter truth is the PostgreSQL row, and Phase 5 does not claim exactly-once execution.

## Reconciliation and restart behavior

The bounded reconciliation loop:

1. Creates missing claim work items for eligible persisted `queued` deployments.
2. Recovers expired `running` leases into `retry_wait` or `dead_lettered` according to their durable attempt count.
3. Lists due `pending` and `retry_wait` rows in bounded batches.
4. Publishes identifier-only wake-ups with their stable BullMQ job IDs.

This repairs enqueue failures, deleted/missing Redis jobs, and worker interruption at the demonstrated claim boundary. Duplicate wake-ups either find a busy/complete/dead-lettered row or replay the existing transition result. No restart silently marks work complete.

Phase 14 remains responsible for the broader failure matrix involving source, build, runtime, proxy, cancellation, cleanup, and orphan-resource adoption.

## Worker heartbeat and shutdown

PostgreSQL stores worker status as `starting`, `ready`, `draining`, or `stopped`, with version, start/heartbeat time, and active-job count. A missing update makes a worker stale for operational inspection only; job lease expiry, not worker-heartbeat state, authorizes recovery, and neither condition alone proves an application deployment failed.

On `SIGINT` or `SIGTERM`, the worker:

1. Stops periodic scheduling, pauses new BullMQ claims, and records `draining`.
2. Allows active handlers, authoritative database operations, and reconciliation to settle within `WORKER_SHUTDOWN_GRACE_MS` while maintaining durable ownership.
3. After a clean drain, records `stopped` while closing the BullMQ clients; a forced drain leaves the durable worker status as `draining`.
4. The process-level shutdown then closes the PostgreSQL client and health listener under the same signal-time watchdog.

If the process cannot drain within the bound or terminates abruptly, it does not fabricate completion. The expiring lease and reconciliation path make the work recoverable by another worker.

## Configuration

The safe local defaults are documented in `.env.example`:

| Setting                             | Default                  | Purpose                              |
| ----------------------------------- | ------------------------ | ------------------------------------ |
| `WORKER_MODE`                       | `run`                    | Full queue worker or `health-only`.  |
| `WORKER_QUEUE_NAME`                 | `launchrail-deployments` | BullMQ queue name.                   |
| `WORKER_QUEUE_PREFIX`               | `launchrail`             | Bounded Redis key prefix.            |
| `WORKER_CONCURRENCY`                | `2`                      | Maximum concurrent claim handlers.   |
| `WORKER_MAX_ATTEMPTS`               | `5`                      | Durable attempt ceiling.             |
| `WORKER_JOB_TIMEOUT_MS`             | `300000`                 | Per-attempt execution timeout.       |
| `WORKER_BACKOFF_BASE_MS`            | `1000`                   | First retry delay.                   |
| `WORKER_BACKOFF_CAP_MS`             | `60000`                  | Retry-delay ceiling.                 |
| `WORKER_LEASE_MS`                   | `60000`                  | Exclusive PostgreSQL lease duration. |
| `WORKER_HEARTBEAT_INTERVAL_MS`      | `10000`                  | Job/worker heartbeat cadence.        |
| `WORKER_RECONCILIATION_INTERVAL_MS` | `15000`                  | Recovery scan cadence.               |
| `WORKER_RECONCILIATION_BATCH_SIZE`  | `100`                    | Maximum rows handled per scan.       |
| `WORKER_SHUTDOWN_GRACE_MS`          | `30000`                  | Bounded active-work drain.           |

Configuration validation requires the backoff base not exceed its cap, heartbeat and reconciliation intervals to be shorter than the lease, and the job timeout to exceed the heartbeat interval. Queue/prefix identifiers reject unsafe punctuation.

Redis uses `noeviction` in the local Compose service because silently evicting BullMQ keys is unsafe. PostgreSQL still permits reconciliation after Redis loss, but Redis capacity exhaustion must surface as an operational failure rather than deleting arbitrary queue state.

## Local operation and evidence

Start PostgreSQL and Redis, apply migrations, then run the applications:

```bash
pnpm services:up
pnpm db:migrate
pnpm dev
```

The default `WORKER_MODE=run` requires both configured services. `WORKER_MODE=health-only` exists for the application health smoke test only; it starts the process-liveness listener without asserting queue/database readiness.

Phase 5 acceptance combines strict contract/unit tests with `pnpm test:database` against PostgreSQL and `pnpm test:queue` against PostgreSQL plus Redis. The suites cover duplicate delivery, durable attempts, timeout, deterministic retry, exhaustion/dead-lettering, lease fencing, missing/due/expired-work reconciliation, heartbeat freshness, the single atomic claim transition/completion, and bounded graceful draining. [GitHub Actions run 31408251857](https://github.com/Zamuel66666/LaunchRail/actions/runs/31408251857) passed these suites after clean migrations and service health checks; a Redis `PING` alone is not acceptance evidence.

## Explicit boundaries

- No deployment-start HTTP endpoint or UI.
- No repository existence/access check, exact revision resolution, cloning, or Dockerfile containment; Phase 6 owns those controls.
- No image build/log stream, application runtime, route, health-gated activation, deployment control, webhook, or rollback execution.
- No project configuration or secret value in Redis, and no runtime secret decryption/injection.
- No queue-readiness HTTP endpoint, metrics, traces, dashboards, or full operator UI; Phase 13 owns full telemetry.
- No broad process/service interruption or external-resource convergence claim; Phase 14 owns that evidence.
- No `v0.2.0` tag: that release target requires repository cloning and image builds.
