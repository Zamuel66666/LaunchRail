# Queue and worker operations

## Current scope

Phase 6 extends LaunchRail's durable background-work foundation through source preparation. PostgreSQL owns every work item's identity, organization/deployment relationship, status, attempt count, due time, lease, safe failure, completion/dead-letter result, immutable source input/output, and worker heartbeat. Redis and BullMQ provide at-least-once wake-ups only.

Two job kinds are implemented. `deployment.claim` advances an eligible deployment from `queued` to `cloning` and durably hands off `deployment.prepare_source`; the source job verifies and checks out the immutable public GitHub revision, stores portable metadata, and advances `cloning` to `building`. There is no deployment-start use case, HTTP endpoint, or web flow, and the worker does not build an image, start a container, route traffic, activate a release, or expose deployment controls.

## Identifier-only wake-up contract

BullMQ receives a strict, runtime-validated version 1 payload:

```json
{
  "contractVersion": 1,
  "kind": "deployment.prepare_source",
  "workItemId": "3b953ca5-a02b-446f-ad13-04bf6896e010"
}
```

No other field is accepted. In particular, Redis receives no organization/deployment authority, correlation metadata, repository/configuration data, environment-variable value, ciphertext, or key metadata. The worker uses `workItemId` to reload the deployment and organization through PostgreSQL.

The only supported kinds are `deployment.claim` and `deployment.prepare_source`. Stable identifiers are derived from their kind and UUID:

- Claim BullMQ/transition IDs: `deployment-claim-v1-<workItemId>` and `worker-claim-v1-<workItemId>`
- Source BullMQ/success/failure IDs: `deployment-prepare-source-v1-<workItemId>`, `worker-source-ready-v1-<workItemId>`, and `worker-source-failure-v1-<workItemId>`

The BullMQ ID intentionally contains no colon. Re-publishing the same work item therefore addresses the same wake-up rather than creating a new logical operation.

## Durable work-item lifecycle

| Status          | Meaning                                                                  |
| --------------- | ------------------------------------------------------------------------ |
| `pending`       | Persisted, has not run, and is eligible at its recorded due time.        |
| `running`       | Exclusively leased to one worker with a heartbeat and expiry.            |
| `retry_wait`    | A safe failure was persisted and the next attempt has a future due time. |
| `completed`     | The job's fenced state transition/output and completion were persisted.  |
| `dead_lettered` | A permanent source failure occurred or the attempt ceiling was reached.  |

Creation is idempotent for one deployment/job kind. A claim transaction reloads the organization-owned deployment, checks due/status eligibility, increments the attempt count, creates a unique lease token, and records worker ownership, heartbeat, and expiry. Heartbeat, completion, and failure calls must present that exact unexpired token. PostgreSQL `clock_timestamp()` evaluates due work, lease creation/extension/expiry, retry availability, recovery, and worker freshness, so a skewed worker clock cannot revive or steal a lease. A stale worker cannot mutate a lease after expiry or after another worker obtains a replacement token.

Under a claim lease, one PostgreSQL transaction applies or replays `queued` to `cloning`, inserts the unique source-preparation work item, and marks the claim complete. Under a source lease, success inserts or compares immutable portable source metadata, applies or replays `cloning` to `building`, and marks source work complete. Permanent or exhausted source failure atomically applies `cloning` to `build_failed` and dead-letters the work item. Each transition, event, audit record, command result, handoff/output, and terminal job mutation commits together; a stale token cannot commit them, and replay does not append duplicates.

## Retry, timeout, and dead-letter policy

Both implemented kinds use deterministic capped exponential backoff with stable 75–100% jitter. First calculate the cap for the attempt:

```text
attemptCap = min(WORKER_BACKOFF_CAP_MS, WORKER_BACKOFF_BASE_MS * 2^(attemptCount - 1))
delay = stableHash(workItemId, attemptCount) mapped to [ceil(0.75 * attemptCap), attemptCap]
```

The same work-item/attempt pair always yields the same delay, so reconciliation does not depend on queue-only randomness. The calculated due time is stored in PostgreSQL. Tests use short injected values without changing the production formula. An overall `WORKER_JOB_TIMEOUT_MS` deadline covers claim, provider/checkout work, transition, and finalization; source resolution and Git checkout also have smaller configured bounds. If an authoritative database or checkout operation has not settled at the deadline, the handler does not race a failure write against it: the operation remains tracked, and its existing lease stays authoritative until the operation settles or lease recovery schedules the next attempt.

Before the maximum attempt count, a retryable failure clears the lease and moves the row to `retry_wait` with a safe error code/message and next due time. At the maximum, it moves to `dead_lettered`; permanent source-input/integrity/Dockerfile failures dead-letter at the real current attempt without pretending the attempt ceiling was reached. Each BullMQ wake-up has one delivery attempt and is removed after success or failure; BullMQ provides neither the retry scheduler nor a durable dead-letter queue. Dead-letter truth is the PostgreSQL row, and LaunchRail does not claim exactly-once execution.

## Reconciliation and restart behavior

The bounded reconciliation loop:

1. Creates missing claim work for eligible `queued` deployments and missing source work for eligible `cloning` deployments.
2. Recovers expired `running` leases into `retry_wait` or `dead_lettered` according to their durable attempt count.
3. Lists due `pending` and `retry_wait` rows in bounded batches.
4. Publishes identifier-only wake-ups with their stable BullMQ job IDs.

This repairs enqueue failures, deleted/missing Redis jobs, and worker interruption across claim and source preparation. Duplicate wake-ups either find a busy/complete/dead-lettered row or replay existing durable results. A validated final checkout carries a trusted manifest marker and is adopted only after complete revalidation, covering a crash after atomic rename but before the database commit. No restart silently marks work complete.

Phase 14 remains responsible for the broader process/service interruption matrix and hard-crash orphan cleanup across source, build, runtime, proxy, cancellation, and later resources.

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

| Setting                                | Default                   | Purpose                              |
| -------------------------------------- | ------------------------- | ------------------------------------ |
| `WORKER_MODE`                          | `run`                     | Full queue worker or `health-only`.  |
| `WORKER_QUEUE_NAME`                    | `launchrail-deployments`  | BullMQ queue name.                   |
| `WORKER_QUEUE_PREFIX`                  | `launchrail`              | Bounded Redis key prefix.            |
| `WORKER_CONCURRENCY`                   | `2`                       | Maximum concurrent job handlers.     |
| `WORKER_MAX_ATTEMPTS`                  | `5`                       | Durable attempt ceiling.             |
| `WORKER_JOB_TIMEOUT_MS`                | `300000`                  | Per-attempt execution timeout.       |
| `WORKER_BACKOFF_BASE_MS`               | `1000`                    | First retry delay.                   |
| `WORKER_BACKOFF_CAP_MS`                | `60000`                   | Retry-delay ceiling.                 |
| `WORKER_LEASE_MS`                      | `60000`                   | Exclusive PostgreSQL lease duration. |
| `WORKER_HEARTBEAT_INTERVAL_MS`         | `10000`                   | Job/worker heartbeat cadence.        |
| `WORKER_RECONCILIATION_INTERVAL_MS`    | `15000`                   | Recovery scan cadence.               |
| `WORKER_RECONCILIATION_BATCH_SIZE`     | `100`                     | Maximum rows handled per scan.       |
| `WORKER_SHUTDOWN_GRACE_MS`             | `30000`                   | Bounded active-work drain.           |
| `WORKER_SOURCE_ROOT`                   | `/tmp/launchrail-sources` | Dedicated private checkout root.     |
| `WORKER_SOURCE_RESOLVE_TIMEOUT_MS`     | `10000`                   | GitHub resolution deadline.          |
| `WORKER_SOURCE_RESOLVE_RESPONSE_BYTES` | `4194304`                 | Per-provider-response byte ceiling.  |
| `WORKER_SOURCE_CLONE_TIMEOUT_MS`       | `120000`                  | Provider-plus-checkout deadline.     |
| `WORKER_SOURCE_GIT_DIRECTORY_BYTES`    | `402653184`               | Git object-directory ceiling.        |
| `WORKER_SOURCE_GIT_OUTPUT_BYTES`       | `65536`                   | Combined process-output ceiling.     |
| `WORKER_SOURCE_MAX_FILES`              | `20000`                   | Checkout file ceiling.               |
| `WORKER_SOURCE_MAX_BYTES`              | `268435456`               | Checkout logical byte ceiling.       |
| `WORKER_SOURCE_MAX_FILE_BYTES`         | `16777216`                | Individual file byte ceiling.        |
| `WORKER_SOURCE_MAX_PATH_BYTES`         | `1024`                    | Relative path byte ceiling.          |
| `WORKER_SOURCE_MAX_DEPTH`              | `64`                      | Relative path depth ceiling.         |

Configuration validation requires the backoff base not exceed its cap, heartbeat and reconciliation intervals to be shorter than the lease, the job timeout to exceed the heartbeat interval, and source sub-timeouts not to exceed the job timeout. The per-file limit cannot exceed the total checkout limit. Queue/prefix identifiers reject unsafe punctuation. The source root must be an absolute normalized non-root path; at runtime it must be owned by the worker user and private to that user.

Redis uses `noeviction` in the local Compose service because silently evicting BullMQ keys is unsafe. PostgreSQL still permits reconciliation after Redis loss, but Redis capacity exhaustion must surface as an operational failure rather than deleting arbitrary queue state.

## Local operation and evidence

Start PostgreSQL and Redis, apply migrations, then run the applications:

```bash
pnpm services:up
pnpm db:migrate
pnpm dev
```

The default `WORKER_MODE=run` requires both configured services. `WORKER_MODE=health-only` exists for the application health smoke test only; it starts the process-liveness listener without asserting queue/database readiness.

Phase 6 acceptance combines strict contract/source/worker unit tests with `pnpm test:database` against PostgreSQL and `pnpm test:queue` against PostgreSQL plus Redis. The suites cover duplicate delivery, durable attempts, timeout, deterministic retry, permanent/exhausted dead letters, lease fencing, missing/due/expired-work reconciliation, heartbeat freshness, both atomic transition/completion paths, immutable source output, checkout adoption, and bounded graceful draining. [GitHub Actions run 31414001234](https://github.com/Zamuel66666/LaunchRail/actions/runs/31414001234) passed these suites after clean migrations and service health checks; a Redis `PING` alone is not acceptance evidence.

## Explicit boundaries

- No deployment-start HTTP endpoint or UI.
- Public GitHub only: no private credentials, Git LFS, submodules, arbitrary Git hosts, or external-network acceptance smoke.
- Prepared checkouts remain on the trusted worker host for Phase 7; broad hard-crash staging/orphan cleanup remains Phase 14 work.
- No image build/log stream, application runtime, route, health-gated activation, deployment control, webhook, or rollback execution.
- No project configuration or secret value in Redis, and no runtime secret decryption/injection.
- No queue-readiness HTTP endpoint, metrics, traces, dashboards, or full operator UI; Phase 13 owns full telemetry.
- No broad process/service interruption or external-resource convergence claim; Phase 14 owns that evidence.
- No `v0.2.0` tag: that release target also requires image builds and live progress.
