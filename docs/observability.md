# Observability design

## Plain-language goal

When a deployment is slow or fails, a user should see which stage failed and what they can do. An operator should be able to follow the same deployment across the browser request, queue job, worker steps, Docker resources, health checks, and route update without searching unrelated text logs.

Phase 1 establishes structured Pino logging, shared credential redaction, and process-health endpoints. Phase 5 adds bounded completion, retry, dead-letter, fencing, reconciliation, infrastructure, heartbeat-failure, and shutdown control-plane events. Phase 6 adds safe source-prepared, source-retry/dead-letter, source-fencing, and source-failure-persistence events plus durable portable source metadata. The API and worker now expose request, webhook, health, runtime, active-job, reconciliation, runtime-orphan, and source/build cleanup metrics; a versioned local Prometheus/Grafana dashboard is included. These additions await the independent verification requested for the current implementation pass.

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

API and worker logs are JSON in production-like modes and readable locally. Phase 5/6 worker events use stable names and opaque work-item/worker identifiers; completion, retry, and dead-letter records include the durable attempt where applicable. Source success includes only adoption, file count, and total bytes—not repository content, raw Git output, arguments, paths, or provider responses. Safe retry codes/messages live in PostgreSQL, while logs use fixed operator-safe messages and never interpolate thrown exception details. API request spans and BullMQ producer/consumer spans preserve W3C trace context through BullMQ's telemetry metadata, not the strict job data payload; worker processing, reconciliation, and persistence-adapter methods add bounded spans. Persistence spans name only the fixed store/method pair and omit SQL, bind parameters, record identifiers, and user data. Remote metrics aggregation and individual SQL-statement spans remain future work.

The target event families include:

- Request accepted/completed/rejected.
- Job enqueued/claimed/retried/exhausted/completed.
- Deployment transition accepted/rejected.
- Clone/build/runtime/health/route step started/completed/failed/cancelled.
- Worker heartbeat, shutdown, stale-work detection, and reconciliation result.
- Webhook verified/rejected/deduplicated/mapped.
- Security-relevant audit outcomes without secret data.

Application build/runtime output is a separate bounded stream, not mixed into control-plane JSON fields as trusted structure.

Completed API requests and worker processing logs include validated `traceId` and `spanId` when a span is active. API handler/store operations run within the request span's asynchronous context. Migration `0014` stores an immutable, validated W3C `trace_parent` on new deployment intents; reconstruction of later source/build/runtime wake-ups reloads that anchor into queue telemetry metadata, never into job data. Headers, arbitrary tracestate, cookies, parameters, and environment values are not persisted as trace context. Legacy deployments with a null anchor cannot reconstruct their original request trace. Independently reconciled maintenance and rollback preparation have their own traces.

## Metrics

Prometheus-compatible metrics will use low-cardinality labels such as service, route template, method, status class, job type, deployment stage, outcome, and failure category.

The API exposes request counters/histograms, webhook processing counters/histograms, and lifecycle final-outcome counters/duration histograms at `/metrics` with bounded route-template, method, status-class, event-class, and outcome labels. API and worker readiness probes also expose bounded ready/not-ready counters; the API records readiness-check duration. The worker `/metrics` exposes process uptime/RSS, active-job and active-queue-handler gauges, a last-successful-heartbeat timestamp, queue depth by fixed BullMQ state, queue wait and handler-processing histograms, durable deployment-job outcome counters and processing histograms by supported kind, build-cache hit/miss step histograms, runtime start/stop and preview-route apply/reconciliation duration histograms, reconciliation/dispatch counters, lost-runtime failure counters, health-check counters/histograms, runtime handoff/failure counters, orphan-runtime, source/build-stage, completed-checkout, orphan-image, interrupted-route-file, route-restoration, and resource-recovery failure counters. Queue depth is refreshed on the worker heartbeat interval, so it is an operational snapshot rather than an instantaneous guarantee. Queue metrics label only fixed states, supported job kinds, and fixed outcomes; labels intentionally omit repository, organization, deployment, request, and delivery identifiers.

The worker also counts durable job retries, timeout outcomes, and exhausted health-grace windows; records build and runtime-cleanup durations; and exposes the current managed-orphan inventory and route configuration repairs. The optional Prometheus profile provisions starter alert rules for worker/heartbeat availability, sustained queue backlog, dead-lettered work, persistent runtime orphans, route configuration drift, and elevated job failure ratio. Tune thresholds to the deployment's configured heartbeat, worker concurrency, workload, and service-level targets before paging operators.

Final-outcome observations run only after successful database commits, including direct stage failures, exhausted leases, and successful rollback source/target transitions. Duplicate commands, stale leases, and rolled-back transactions do not emit outcomes. Dedicated `launchrail_rollbacks_total{outcome}` and `launchrail_rollback_duration_seconds` distinguish completed and failed rollback preparation; retaining the current release after failed preparation is not a new activation. Instrumentation errors never reverse a committed state change. These counters are process-local, not durable exactly-once accounting: a crash between commit and observation can omit a sample, and restarting resets counters. Lifecycle duration measures creation to the observed final transition, not deployment startup performance; use the dedicated benchmark stage timings for performance claims.

The dedicated loopback acceptance collector in `scripts/acceptance-collector.mjs` rejects synthetic and operator-supplied private-value fixtures before retaining payloads, limits request and retained byte counts, and supports bounded HTTP 503 injection. It is a temporary test receiver, not a production telemetry service. SDK tests cover failed export and bounded queue dropping without losing application work.

Measurements still to add:

- Active SSE streams, reconnects, dropped/limited chunks, and delivery lag.
- Queue retry/timeout stage attribution beyond the worker-level counters.

Per-deployment investigation uses traces, events, and logs rather than a high-cardinality `deployment_id` metric label.

## Tracing

The optional OTLP/HTTP exporter sends API request, queue publish/consume, worker processing, reconciliation, and persistence-adapter method spans when `OTEL_EXPORTER_OTLP_ENDPOINT` is configured with a trusted collector URL (base URL or `/v1/traces`). Span status records success or a fixed error category; source/build/runtime operations run under the worker processing span. BullMQ persists only its telemetry metadata for W3C propagation; its deployment job payload remains identifier-only. Large logs, source content, Git output, SQL text, bind parameters, local paths, secret values, raw headers, URLs containing credentials, and environment variables are never span attributes. The telemetry collector is an operator-controlled destination and should be protected as deployment metadata can include opaque work-item identifiers.

Queue propagation creates linked asynchronous traces rather than pretending the original HTTP request stays open through a deployment.

## Health and readiness

- API `/health` reports process liveness. `/ready` executes a bounded PostgreSQL `SELECT 1`, returning only a generic 200/503 result; pool queries have a 2-second timeout.
- Worker `/health` reports process liveness. `/ready` rechecks PostgreSQL and both Redis queue connections with bounded probes after runtime startup and initial reconciliation, checks Docker daemon access, and bootstraps only the configured Buildx builder. The Docker/BuildKit result is cached for up to one worker heartbeat interval. It returns 503 during health-only mode, startup, shutdown, or a failed dependency probe. Health-only smoke mode intentionally does not connect to PostgreSQL, Redis, Docker, or BuildKit.
- Phase 6 persists worker status/heartbeat/active-job records for operational inspection. Lease expiry, not the worker-heartbeat row, drives work recovery; readiness is not a queue-depth or proxy health guarantee.
- Docker, BuildKit, and proxy dependency state appears in operator diagnostics without leaking configuration secrets.

## Dashboards and alerts

The provisioned local Grafana dashboard currently charts API request rate, webhook outcomes, health-check outcomes/duration, worker dispatch failures/memory, orphan-runtime cleanup outcomes, source/build staging cleanup volume/failures, completed checkout removals, orphan build-image cleanup outcomes, queue depth/wait, durable deployment stage outcomes and retries/timeouts, build duration/cache reuse, runtime cleanup inventory/duration, runtime start/stop duration, route apply/reconciliation duration and configuration repair, health-grace exhaustion, and worker heartbeat age. Follow-on dashboard panels should answer:

1. Are API and worker processes available?
2. Is queued work growing or stuck?
3. Which deployment stage is slow or failing?
4. Are health checks or route applications degrading?
5. Are retries, dead letters, orphan resources, or reconciliation mismatches increasing?

Starter local alert rules are provisioned from `ops/observability/launchrail-alerts.yml`. They intentionally use conservative demonstration thresholds rather than measured production SLOs; operators should tune them against a controlled workload before enabling paging.

## Redaction and access

The shared redaction package sanitizes control-plane logs, deployment events, adapter errors, and telemetry attributes before export. Existing canary-secret tests inspect multiple outputs; recent log/API/dashboard additions still require independent review. User-visible build output is organization-authorized and retained within configured database bounds. Telemetry endpoints and Grafana are local/operator surfaces, not unauthenticated public routes.

## Delivery stages

1. **Available:** establish JSON logging, baseline credential redaction, and process health conventions in the repository foundation.
2. **Available:** safe completion/retry/dead-letter/fencing/reconciliation/shutdown events and durable worker heartbeat state are verified for Phase 5.
3. **Available:** safe source success/retry/dead-letter/fencing/reconciliation events and immutable preparation metadata are verified for Phase 6.
4. Instrument API latency, verified webhook outcomes, health attempts, active work, and runtime outcomes with low-cardinality metrics.
5. Provision an optional local Prometheus/Grafana stack and version the operator dashboard.
6. W3C trace propagation/export and bounded startup/dependency-readiness endpoints are implemented; independent verification remains outstanding.
7. Run canary-secret/cardinality reviews and demonstrate successful/failed flows before marking observability available.

## Evidence required

Observability becomes “Available” only when a recorded demonstration can trace a successful and failed deployment across events/signals, dashboard queries are versioned, metrics scrape successfully, worker health is visible, and canary-secret tests prove sensitive values are absent.

## Local metrics and dashboards

The API and worker expose Prometheus text format at `/metrics`. The API includes route-template request counts and latency plus bounded GitHub delivery outcomes and processing duration. The worker reports process uptime/RSS, queue depth by state, active jobs and queue handlers, queue wait and handler-processing durations, durable per-stage processing duration/outcome by supported job kind, build cache hit/miss step counts, job reconciliation/dispatch outcomes, runtime handoffs, health-check outcomes/duration, terminal/retryable runtime failures, and resource cleanup results. Queue depth refreshes on the worker heartbeat interval. Metric labels intentionally avoid organization, project, deployment, request, and delivery identifiers.

The optional local dashboard stack is isolated from the default development services. It uses Linux host networking to reach API and worker metrics, so this overlay is currently supported on Linux hosts:

```bash
export GF_SECURITY_ADMIN_PASSWORD='choose-a-unique-local-password'
docker compose -f compose.yaml -f compose.observability.yaml --profile observability up -d --wait
```

Start the API and worker with `pnpm dev`, then open Prometheus at `http://localhost:9090` and Grafana at `http://localhost:3001`. Grafana provisions a read-only Prometheus data source and the LaunchRail Operations dashboard automatically. The development dashboard is bound to loopback, uses local-only credentials, and retains Prometheus data for 15 days. Stop it without deleting its volume with:

```bash
docker compose -f compose.yaml -f compose.observability.yaml --profile observability down
```

The current request ID is returned as `x-request-id` and is attached to API logs. W3C trace context links instrumented API requests through persistence-adapter and BullMQ producer/consumer spans to worker processing; work-item IDs and ordered deployment events remain additional pivots. Exemplars, remote metrics/log aggregation, individual SQL-statement spans, and independent OTLP canary-secret verification remain future work.

The project timeline can request a bounded tail of runtime output through an API-to-worker endpoint. Set the same random `WORKER_INTERNAL_TOKEN` (at least 32 characters) for the API and worker, and configure `WORKER_INTERNAL_URL` on the API; without the token, runtime log access stays disabled. The API authorizes the organization reader before proxying, the worker verifies the shared secret and matches the deployment and organization against managed-container labels, and responses are not cached. Runtime output is controlled by the deployed application and may include sensitive values; do not print credentials or other secrets from application code.
