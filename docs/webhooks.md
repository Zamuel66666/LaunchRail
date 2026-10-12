# GitHub webhook operations

LaunchRail accepts GitHub `push` deliveries at `POST /v1/webhooks/github`. Configure the webhook with the API's `GITHUB_WEBHOOK_SECRET`, select JSON delivery, and subscribe to push events. Set `GITHUB_WEBHOOK_ORGANIZATION_ID` to the organization whose projects may be triggered. The secret must not be committed or copied into project environment variables.

The API verifies the HMAC-SHA256 signature over the original request bytes before parsing the event. It stores only the payload digest and the normalized branch/repository/revision fields needed to retry a verified push. Raw request bodies and signature values are not persisted. Delivery IDs are bounded and deduplicated within the configured organization and provider.

Matching project branches create immutable deployment snapshots and deterministic claim wake-ups. A durable per-delivery/project mapping makes operator retry idempotent: a repeated delivery reuses the deployment already associated with that event instead of adding a second history row. PostgreSQL work state remains authoritative if Redis publication is temporarily unavailable; the worker reconciler republishes dispatchable jobs.

Audit readers can inspect recent results in the project workspace or request `GET /v1/organizations/{organizationId}/webhook-deliveries?limit=50`. Results include the verification state, processing outcome, safe error code, attempt count, and receipt time, but not the stored payload. A deployment controller can retry a failed verified push with `POST /v1/organizations/{organizationId}/webhook-deliveries/{deliveryId}/retry`. Invalid signatures, malformed pushes, and unsupported events cannot be retried through this route.

Processing errors are safe low-cardinality codes, not exception text. Retrying requires an authenticated organization member with deployment-control permission and a request from the configured web origin.

## Service-backed acceptance

`pnpm test:database` includes a webhook suite requiring both `DATABASE_URL` and `REDIS_URL`. It verifies signatures against raw request bytes, delivery/project deduplication, one atomic intent/claim and a real identifier-only Redis wake-up, unsupported/invalid/oversized inputs, branch mismatch, and partial processing followed by authenticated operator retry. A viewer receives HTTP 403 for retry, an unsigned session receives HTTP 401, and a foreign organization is concealed with HTTP 404. A dispatch-failure fixture proves a verified delivery retains authoritative pending work for later reconciliation; this fixture is not evidence of a physical Redis outage.

The suite uses an isolated Redis prefix and removes only that prefix's queue. Queue recovery fixtures hold and explicitly settle their fake runtime adapter before shutdown, making graceful-drain assertions independent of Docker command timeout settings and protecting live host resources.
