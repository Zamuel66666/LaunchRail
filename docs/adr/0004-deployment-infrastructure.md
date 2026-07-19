# ADR-0004: Docker BuildKit, Traefik, and server-sent events

- **Status:** Accepted
- **Date:** 2026-07-19

## Context

The local platform needs repeatable container builds, restricted workload execution, generated preview routing, and near-real-time one-way delivery of logs and deployment events to browsers.

## Decision

Use Docker BuildKit for image builds, Docker Engine for the initial container runtime adapter, Traefik for preview routing, and server-sent events (SSE) for browser log/event streams. Control actions remain ordinary authenticated HTTP requests.

Build and runtime access will be isolated behind adapters with bounded timeouts and cancellation. Routes will be derived from persisted desired state and reconciled after restart. SSE events will carry sequence identifiers so clients can reconnect and resume where retained data allows.

## Consequences

- The entire demonstration runs on common local container tooling.
- BuildKit provides cache support and structured progress without inventing a builder.
- Traefik supports dynamic routes, but reconciliation and safe configuration ownership still need implementation.
- SSE is simpler than bidirectional WebSockets for server-to-browser streams and works with normal HTTP infrastructure.
- Docker socket access is highly privileged; the worker boundary, workload restrictions, and host trust assumptions must be documented and tested.
- A later remote runtime can implement the same application ports without changing deployment rules.

## Alternatives considered

- **Caddy:** attractive for local routing, but Traefik's dynamic service model aligns more directly with container deployments.
- **WebSockets:** unnecessary for one-way streams because user controls can use HTTP.
- **Kubernetes:** intentionally outside the first product boundary.
