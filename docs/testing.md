# Testing strategy

## Purpose

LaunchRail tests observable outcomes and safety invariants across domain logic, persistence, queues, infrastructure adapters, and browser workflows. A green unit suite alone cannot prove that a deployment survives real process and service failures, so each layer has a distinct job.

Phase 1 provides Vitest unit tests for the health/configuration contracts, Fastify injection tests, a real worker HTTP-socket test, a web route test, and an application health smoke script. The broader scenarios below remain required as implementation phases land.

## Test layers

| Layer                | Main evidence                                                                 | Intended tools                                 |
| -------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------- |
| Domain unit          | Valid/invalid transitions, value objects, policy decisions, redaction rules   | Vitest                                         |
| Application unit     | Use-case orchestration through deterministic fake ports                       | Vitest                                         |
| Database integration | Constraints, transactions, locks, migrations, organization isolation          | Vitest + disposable PostgreSQL                 |
| Queue integration    | Typed contracts, retry/backoff, timeout, duplicate jobs, dead-letter behavior | Vitest + disposable Redis/BullMQ               |
| Adapter contract     | Git, BuildKit, Docker, Traefik, health and streaming behavior                 | Vitest + controlled local services             |
| API integration      | Schemas, auth/authz, rate limits, webhooks, idempotency, OpenAPI              | Fastify injection + real database where needed |
| Browser end to end   | Sign-in, projects, deployment progress/controls, errors, accessibility        | Playwright                                     |
| Resilience           | Process/service interruption and reconciliation                               | Failure-injection harness                      |
| Security             | Injection, isolation, signature, redaction, runtime restrictions              | Layer-appropriate regression suites            |
| Benchmarks           | Repeatable latency, throughput, recovery, cache, and resources                | Versioned scripts and documented environment   |

## Required scenario matrix

### Deployment domain

- Every allowed state transition and every disallowed pair.
- Transactional state/event updates and optimistic/concurrent conflicts.
- One active release per project under concurrent promotion.
- Failed and cancelled candidates preserve the active release.
- Rollback validates ownership, health history, and route safety.

### Queue and recovery

- Duplicate enqueue, duplicate consumption, retry exhaustion, timeout, and dead-letter behavior.
- Worker termination before and after each external side effect.
- Lost Redis queue state reconstructed from PostgreSQL.
- Stale leases and labeled resource adoption without duplication.
- Graceful shutdown stops claiming work and leaves recoverable state.

### Sources, builds, and runtime

- Healthy Node.js and Python examples.
- Missing/unsafe Dockerfile, invalid revision, oversized/slow clone, and clone timeout.
- Successful, failing, cached, slow, cancelled, and timed-out builds.
- Starts, logs, stops, cleanup, resource limits, non-root policy, and orphan reconciliation.
- Delayed startup, unhealthy application, health timeout, and malformed response.

### Webhooks and authorization

- Valid/invalid signatures over exact raw payload bytes.
- Duplicate delivery ID, unsupported event, branch mismatch, oversized body, and replay.
- Viewer/developer/admin permissions for every mutation.
- Cross-organization identifiers rejected without information leakage.

### Logs and secrets

- Ordered sequence IDs, reconnect/resume, bounded chunks, retention, and backpressure.
- Control characters and HTML-like output displayed as text.
- Canary secrets absent from logs, API errors, events, audit entries, metrics, traces, job payloads, images, and screenshots.

## Determinism and isolation

- Freeze time and random sources through injected clocks/ID generators in unit tests.
- Use per-test organization/project IDs and database transactions or isolated schemas.
- Label Docker/Traefik resources with a unique test-run ID and clean only matching resources.
- Avoid external GitHub/network dependencies in normal CI; use fixtures and local HTTP servers.
- Keep retry timings short and configurable in tests without changing production policy semantics.
- Seeded randomized/property tests must print the seed on failure.

## Example applications

The `examples/` directory will contain small versioned fixtures for healthy Node.js, healthy Python, failed build, failed health, delayed startup, structured logs, and slow build behavior. Fixtures are product test inputs, not toy samples; integration and browser suites should reference them rather than reproducing behavior inline.

## Quality-gate policy

Each commit runs the smallest complete set that covers its behavior. Pull requests run the repository's full practical CI baseline. Nightly or explicitly invoked suites may hold resource-heavy Docker, resilience, security scanning, and benchmarks. Skipped tests must report the exact environmental blocker and must not be described as passed.

The current baseline is `pnpm test` for package/web unit tests, `pnpm test:integration` for API and worker HTTP behavior, and `pnpm smoke:health` after a production build. A separate GitHub Actions job starts and probes real PostgreSQL and Redis services.

## Defect workflow

Reproduce a defect at the lowest layer that captures the observable failure, add a regression test where practical, implement the focused correction, and run adjacent integration coverage. Do not weaken an invariant or assertion merely to make a failure disappear.
