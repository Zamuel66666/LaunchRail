# Observability design

## Plain-language goal

When a deployment is slow or fails, a user should see which stage failed and what they can do. An operator should be able to follow the same deployment across the browser request, queue job, worker steps, Docker resources, health checks, and route update without searching unrelated text logs.

Phase 1 establishes structured Pino logging, shared credential redaction, and process-health endpoints. Phase 5 adds bounded completion, retry, dead-letter, fencing, reconciliation, infrastructure, heartbeat-failure, and shutdown control-plane events. End-to-end correlation, metrics, traces, dashboards, dependency-readiness endpoints, and successful enqueue/claim events remain planned.

## Correlation model

Every applicable signal carries stable, bounded identifiers:

- `correlation_id` for an incoming request or webhook processing chain.
- `organization_id` and `project_id` as internal opaque IDs.
- `deployment_id` for the complete release attempt.
- `job_id` and `attempt` for queue execution.
- `runtime_instance_id` for a managed container record.
- `webhook_delivery_id` as a hashed/opaque value when needed for correlation.

The Phase 5 BullMQ payload contains only its contract version, `deployment.claim` kind, and opaque PostgreSQL work-item ID. Organization, deployment, and future trace context are reloaded from authoritative storage rather than copied into Redis. User-supplied repository names, URLs, commit messages, log content, and environment values are not metric labels.

## Structured logs

API and worker logs are JSON in production-like modes and readable locally. Phase 5 worker events use stable names and opaque work-item/worker identifiers; completion, retry, and dead-letter records include the durable attempt where applicable. Safe retry codes/messages live in PostgreSQL, while logs use fixed operator-safe messages and never interpolate thrown exception details. Future phases add successful enqueue/claim events and full cross-component correlation.

Required event families include:

- Request accepted/completed/rejected.
- Job enqueued/claimed/retried/exhausted/completed.
- Deployment transition accepted/rejected.
- Clone/build/runtime/health/route step started/completed/failed/cancelled.
- Worker heartbeat, shutdown, stale-work detection, and reconciliation result.
- Webhook verified/rejected/deduplicated/mapped.
- Security-relevant audit outcomes without secret data.

Application build/runtime output is a separate bounded stream, not mixed into control-plane JSON fields as trusted structure.

## Metrics

Prometheus-compatible metrics will use low-cardinality labels such as service, route template, method, status class, job type, deployment stage, outcome, and failure category.

Planned measurements:

- HTTP request count and duration.
- Active SSE streams, reconnects, dropped/limited chunks, and delivery lag.
- Queue depth by supported state, job wait/run duration, retries, timeouts, and dead-letter count.
- Deployment stage duration, end-to-end duration, success/failure/cancellation count.
- Build cache outcome and duration without repository labels.
- Runtime start/stop/cleanup duration and orphan count.
- Health-check attempts, duration, outcome, and grace-period exhaustion.
- Route apply/reconcile duration, failures, and desired/observed mismatch count.
- Worker heartbeat age, active jobs, and reconciliation results.

Per-deployment investigation uses traces, events, and logs rather than a high-cardinality `deployment_id` metric label.

## Tracing

OpenTelemetry spans will cover API handlers, database operations where safe/useful, job publish/consume, clone, build, runtime, health, route, webhook, and reconciliation steps. Span status records stable failure categories. Large logs, source content, secret values, raw headers, URLs containing credentials, and environment variables are never span attributes.

Queue propagation creates linked asynchronous traces rather than pretending the original HTTP request stays open through a deployment.

## Health and readiness

- API liveness reports only process health; a future readiness endpoint will check required dependencies within bounded time.
- Worker `/health` and `pnpm smoke:health` report process liveness only. Health-only smoke mode intentionally does not connect to PostgreSQL or Redis.
- Phase 5 persists worker status/heartbeat/active-job records for operational inspection and later operator presentation. Lease expiry, not the worker-heartbeat row, drives work recovery; no HTTP queue-readiness contract or UI exists.
- Docker, BuildKit, and proxy dependency state appears in operator diagnostics without leaking configuration secrets.

## Dashboards and alerts

The first Grafana dashboard will answer:

1. Are API and worker processes available?
2. Is queued work growing or stuck?
3. Which deployment stage is slow or failing?
4. Are health checks or route applications degrading?
5. Are retries, dead letters, orphan resources, or reconciliation mismatches increasing?

Local alert rules will focus on actionable conditions: stale worker heartbeat, sustained queue age, elevated failure ratio with a minimum sample, dead letters, route mismatch, and orphan growth. Thresholds will be measured and documented rather than invented in Phase 0.

## Redaction and access

One shared redaction package will sanitize control-plane logs, deployment events, adapter errors, and telemetry attributes before export. Tests inject canary secrets and search every output. User-visible application logs are organization-authorized and retention-limited. Telemetry endpoints and Grafana are local/operator surfaces, not unauthenticated public routes.

## Delivery stages

1. **Available:** establish JSON logging, baseline credential redaction, and process health conventions in the repository foundation.
2. **Available:** safe completion/retry/dead-letter/fencing/reconciliation/shutdown events and durable worker heartbeat state are verified for Phase 5.
3. Add end-to-end correlation IDs and instrument API/queue boundaries when the deployment-start API is introduced.
4. Add stage metrics and traces with each lifecycle implementation.
5. Add dependency-readiness endpoints, dashboards, and documented queries.
6. Run canary-secret and cardinality reviews before marking observability available.

## Evidence required

Observability becomes “Available” only when a recorded demonstration can trace a successful and failed deployment across events/signals, dashboard queries are versioned, metrics scrape successfully, worker health is visible, and canary-secret tests prove sensitive values are absent.
