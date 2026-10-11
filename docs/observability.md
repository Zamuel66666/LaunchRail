# Observability design

## Plain-language goal

When a deployment is slow or fails, a user should see which stage failed and what they can do. An operator should be able to follow the same deployment across the browser request, queue job, worker steps, Docker resources, health checks, and route update without searching unrelated text logs.

Phase 1 establishes structured Pino logging, shared credential redaction, and process-health endpoints. Phase 5 adds bounded completion, retry, dead-letter, fencing, reconciliation, infrastructure, heartbeat-failure, and shutdown control-plane events. Phase 6 adds safe source-prepared, source-retry/dead-letter, source-fencing, and source-failure-persistence events plus durable portable source metadata. The API and worker now expose request, webhook, health, runtime, active-job, reconciliation, and runtime-orphan cleanup metrics; a versioned local Prometheus/Grafana dashboard is included. These additions await the independent verification requested for the current implementation pass.

## Correlation model

Every applicable signal carries stable, bounded identifiers:

- `correlation_id` for an incoming request or webhook processing chain.
- `organization_id` and `project_id` as internal opaque IDs.
- `deployment_id` for the complete release attempt.
- `job_id` and `attempt` for queue execution.
- `runtime_instance_id` for a managed container record.
- `webhook_delivery_id` as a hashed/opaque value when needed for correlation.

The Phase 6 BullMQ payload contains only its contract version, one of the two supported job kinds, and an opaque PostgreSQL work-item ID. Organization, deployment, source input, and future trace context are reloaded from authoritative storage rather than copied into Redis. User-supplied repository names, URLs, commit messages, paths, log content, and environment values are not metric labels.

## Structured logs

API and worker logs are JSON in production-like modes and readable locally. Phase 5/6 worker events use stable names and opaque work-item/worker identifiers; completion, retry, and dead-letter records include the durable attempt where applicable. Source success includes only adoption, file count, and total bytes—not repository content, raw Git output, arguments, paths, or provider responses. Safe retry codes/messages live in PostgreSQL, while logs use fixed operator-safe messages and never interpolate thrown exception details. Future phases add successful enqueue/claim events and full cross-component correlation.

The target event families include:

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

The API exposes request counters/histograms and webhook processing counters/histograms at `/metrics` with bounded route-template, method, status-class, event-class, and outcome labels. The worker `/metrics` exposes process uptime/RSS, active-job gauge, reconciliation/dispatch counters, health-check counters/histograms, runtime handoff/failure counters, and orphan-runtime cleanup counters. Labels intentionally omit repository, organization, deployment, request, and delivery identifiers.

Measurements still to add:

- Active SSE streams, reconnects, dropped/limited chunks, and delivery lag.
- Queue depth by supported state, job wait/run duration, retries, timeouts, and dead-letter count.
- Deployment stage duration, end-to-end duration, success/failure/cancellation count.
- Build cache outcome and duration without repository labels.
- Runtime start/stop/cleanup duration and current orphan inventory gauge.
- Health-check grace-period exhaustion.
- Route apply/reconcile duration, failures, and desired/observed mismatch count.
- Worker heartbeat age, active jobs, and reconciliation results.

Per-deployment investigation uses traces, events, and logs rather than a high-cardinality `deployment_id` metric label.

## Tracing

OpenTelemetry spans will cover API handlers, database operations where safe/useful, job publish/consume, source preparation, build, runtime, health, route, webhook, and reconciliation steps. Span status records stable failure categories. Large logs, source content, Git output, local paths, secret values, raw headers, URLs containing credentials, and environment variables are never span attributes.

Queue propagation creates linked asynchronous traces rather than pretending the original HTTP request stays open through a deployment.

## Health and readiness

- API liveness reports only process health; a future readiness endpoint will check required dependencies within bounded time.
- Worker `/health` and `pnpm smoke:health` report process liveness only. Health-only smoke mode intentionally does not connect to PostgreSQL or Redis.
- Phase 6 persists worker status/heartbeat/active-job records for operational inspection and later operator presentation. Lease expiry, not the worker-heartbeat row, drives work recovery; no HTTP queue-readiness contract or UI exists.
- Docker, BuildKit, and proxy dependency state appears in operator diagnostics without leaking configuration secrets.

## Dashboards and alerts

The provisioned local Grafana dashboard currently charts API request rate, webhook outcomes, health-check outcomes/duration, worker dispatch failures/memory, and orphan-runtime cleanup outcomes. Follow-on dashboard panels should answer:

1. Are API and worker processes available?
2. Is queued work growing or stuck?
3. Which deployment stage is slow or failing?
4. Are health checks or route applications degrading?
5. Are retries, dead letters, orphan resources, or reconciliation mismatches increasing?

Local alert rules are not yet configured. They should focus on actionable conditions: stale worker heartbeat, sustained queue age, elevated failure ratio with a minimum sample, dead letters, route mismatch, and orphan growth. Thresholds must be measured and documented rather than invented.

## Redaction and access

One shared redaction package will sanitize control-plane logs, deployment events, adapter errors, and telemetry attributes before export. Tests inject canary secrets and search every output. User-visible application logs are organization-authorized and retention-limited. Telemetry endpoints and Grafana are local/operator surfaces, not unauthenticated public routes.

## Delivery stages

1. **Available:** establish JSON logging, baseline credential redaction, and process health conventions in the repository foundation.
2. **Available:** safe completion/retry/dead-letter/fencing/reconciliation/shutdown events and durable worker heartbeat state are verified for Phase 5.
3. **Available:** safe source success/retry/dead-letter/fencing/reconciliation events and immutable preparation metadata are verified for Phase 6.
4. Instrument API latency, verified webhook outcomes, health attempts, active work, and runtime outcomes with low-cardinality metrics.
5. Provision an optional local Prometheus/Grafana stack and version the operator dashboard.
6. Add distributed trace propagation/export and dependency-readiness endpoints.
7. Run canary-secret/cardinality reviews and demonstrate successful/failed flows before marking observability available.

## Evidence required

Observability becomes “Available” only when a recorded demonstration can trace a successful and failed deployment across events/signals, dashboard queries are versioned, metrics scrape successfully, worker health is visible, and canary-secret tests prove sensitive values are absent.

# Local metrics and dashboards

The API and worker expose Prometheus text format at `/metrics`. The API includes route-template request counts and latency plus bounded GitHub delivery outcomes and processing duration. The worker reports process uptime/RSS, active jobs, job reconciliation/dispatch outcomes, runtime handoffs, health-check outcomes/duration, terminal/retryable runtime failures, and orphan-runtime cleanup results. Metric labels intentionally avoid organization, project, deployment, request, and delivery identifiers.

The optional local dashboard stack is isolated from the default development services. It uses Linux host networking to reach API and worker metrics, so this overlay is currently supported on Linux hosts:

```bash
export GF_SECURITY_ADMIN_PASSWORD='choose-a-unique-local-password'
docker compose -f compose.yaml -f compose.observability.yaml --profile observability up -d --wait
```

Start the API and worker with `pnpm dev`, then open Prometheus at `http://localhost:9090` and Grafana at `http://localhost:3001`. Grafana provisions a read-only Prometheus data source and the LaunchRail Operations dashboard automatically. The development dashboard is bound to loopback, uses local-only credentials, and retains Prometheus data for 15 days. Stop it without deleting its volume with:

```bash
docker compose -f compose.yaml -f compose.observability.yaml --profile observability down
```

The current request ID is returned as `x-request-id` and is attached to API logs. Worker logs include durable work-item IDs, while deployment events and webhook delivery IDs provide database pivots between the two. This is operational correlation, not distributed tracing: trace/span export, exemplars, alert policies, and remote log aggregation remain future work.
