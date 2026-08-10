# Testing strategy

## Purpose

LaunchRail tests observable outcomes and safety invariants across domain logic, persistence, queues, infrastructure adapters, and browser workflows. A green unit suite alone cannot prove that a deployment survives real process and service failures, so each layer has a distinct job.

Phases 1 through 5 provide Vitest tests for health/configuration contracts, deployment transitions, project validation and encryption, role policy, password hashing, Fastify/web boundaries, strict job contracts, durable work items/heartbeats, and BullMQ worker behavior. Unit tests plus disposable PostgreSQL and Redis suites collectively exercise clean migrations, ownership constraints, transactional rollback, idempotency, immutable snapshots, failed-candidate safety, serialized promotion, authorization, project archival/secret storage, duplicate wake-up handling, leases/fencing, retries/timeouts, dead letters, reconciliation, heartbeat freshness, and graceful draining. [GitHub Actions run 31408251857](https://github.com/Zamuel66666/LaunchRail/actions/runs/31408251857) verifies the Phase 5 clean-service gate.

## Test layers

| Layer                | Main evidence                                                                | Intended tools                                 |
| -------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------- |
| Domain unit          | Valid/invalid transitions, value objects, policy decisions, redaction rules  | Vitest                                         |
| Application unit     | Use-case orchestration through deterministic fake ports                      | Vitest                                         |
| Database integration | Constraints, transactions, locks, migrations, organization isolation         | Vitest + disposable PostgreSQL                 |
| Queue and worker     | Contracts, retry/timeout, duplicate jobs, leases, recovery, bounded shutdown | Vitest fakes + disposable PostgreSQL/Redis     |
| Adapter contract     | Git, BuildKit, Docker, Traefik, health and streaming behavior                | Vitest + controlled local services             |
| API integration      | Schemas, auth/authz, rate limits, webhooks, idempotency, OpenAPI             | Fastify injection + real database where needed |
| Browser end to end   | Sign-in, projects, deployment progress/controls, errors, accessibility       | Playwright                                     |
| Resilience           | Process/service interruption and reconciliation                              | Failure-injection harness                      |
| Security             | Injection, isolation, signature, redaction, runtime restrictions             | Layer-appropriate regression suites            |
| Benchmarks           | Repeatable latency, throughput, recovery, cache, and resources               | Versioned scripts and documented environment   |

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

Phase 5's clean-service suites cover this matrix for the identifier-only `deployment.claim` wake-up and its demonstrated `queued` to `cloning` transition. Termination around clone, build, container, health, route, and cleanup side effects remains part of those later adapters and the Phase 14 recovery milestone.

### Sources, builds, and runtime

- Healthy Node.js and Python examples.
- Missing/unsafe Dockerfile, invalid revision, oversized/slow clone, and clone timeout.
- Successful, failing, cached, slow, cancelled, and timed-out builds.
- Starts, logs, stops, cleanup, resource limits, non-root policy, and orphan reconciliation.
- Delayed startup, unhealthy application, health timeout, and malformed response.

### Authentication, webhooks, and authorization

- Password verification, opaque token hashing, absolute/idle expiry, revocation, and disabled users.
- Generic credential failures, strict mutation origin, secure cookie attributes, security headers, and sign-in throttling.
- Owner/admin/developer/viewer permissions for every protected organization, membership, project, and environment-variable route.
- Cross-organization identifiers concealed on every organization detail, member, role-change, audit-history, project, and secret path.

- Valid/invalid signatures over exact raw payload bytes.
- Duplicate delivery ID, unsupported event, branch mismatch, oversized body, and replay.

### Project configuration and secrets

- Canonical GitHub HTTPS normalization plus malformed hosts, credentials, encodings, Git reference, traversal, Dockerfile, and health-path input.
- Exact runtime fields and integer bounds for CPU, memory, process count, health port, and read-only-root setting.
- Environment-variable name syntax, UTF-8 byte limits, null-byte rejection, and response bodies that never echo values or envelope fields.
- AES-256-GCM randomized envelopes, authentication-tag/ciphertext tampering, malformed encoding, missing key versions, historical-key reads, and wrong organization/project/name context.
- Optimistic version conflicts, active-name conflicts, write/audit atomicity, cross-organization scoping, and canary absence from database plaintext/audit/API output.
- Archive rejection for active/in-flight projects, encrypted-variable purging, active-read hiding, and terminal deployment-history preservation.
- Browser loading, signed-out, no-membership, empty, read-only, create/edit/conflict, secret, archive-confirmation, unavailable, keyboard-focus, and responsive states.

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

The current baseline is `pnpm test` for package/web unit tests, `pnpm test:integration` for API and worker HTTP behavior, `pnpm test:database` against disposable PostgreSQL, `pnpm test:queue` against disposable PostgreSQL and Redis, and `pnpm smoke:health` after a production build. The service CI job applies migrations from an empty database before running persistence, authenticated identity/project API, and queue/worker recovery tests. `pnpm smoke:health` uses health-only worker mode and is liveness evidence, not queue readiness. When local services are unavailable, their suites must be reported as unverified locally and proven by the GitHub Actions service job.

## Defect workflow

Reproduce a defect at the lowest layer that captures the observable failure, add a regression test where practical, implement the focused correction, and run adjacent integration coverage. Do not weaken an invariant or assertion merely to make a failure disappear.
