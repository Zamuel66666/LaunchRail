# Security policy

## Current security status

LaunchRail has a runnable Phase 6 source-preparation foundation, but it is not production-ready and must not be exposed publicly or used to run untrusted workloads. It validates process/project/job/source configuration, rejects documented development credentials in production, binds development services to loopback, uses scrypt password hashes, stores only hashes of opaque sessions, enforces organization roles, and audits identity/project/deployment changes. Environment-variable values are encrypted with AES-256-GCM and never returned by read APIs or placed in Redis. BullMQ carries only a strict versioned kind and opaque PostgreSQL work-item ID; durable ownership, attempts, leases, safe errors, and dead letters remain in PostgreSQL. The source adapter accepts unauthenticated public GitHub repositories only, fixes every network request to GitHub-controlled origins, disables ambient Git credentials/configuration, verifies an exact commit/tree/blob manifest, and applies bounded filesystem and Dockerfile-containment checks. There is no deployment-start HTTP/UI path or image/container execution yet. Password recovery, invitations, MFA, SSO, private-repository authentication, deployment-time secret injection, and container execution controls are not implemented. `pnpm audit --prod` currently reports no known vulnerabilities for the lockfile, but recurring dependency and image scanning remain mandatory pre-production work.

The first implementation will target a trusted operator on a local Docker host. Docker daemon access is effectively host-level privilege; container restrictions reduce workload risk but do not turn the initial design into a hardened hostile multi-tenant platform.

## Reporting a vulnerability

Do not publish exploit details, credentials, personal data, or live secrets in a GitHub issue.

Use GitHub's private vulnerability-reporting feature for this repository when it is available. Include:

- The affected revision or release.
- Preconditions and a minimal reproduction.
- Expected and observed impact.
- Any suggested mitigation.
- Whether the issue is already public or actively exploited.

If private vulnerability reporting is unavailable, open a public issue containing only a request for a private maintainer contact and no sensitive technical details. A dedicated security contact will be added before the first runnable release.

Non-sensitive hardening suggestions and dependency-maintenance work may use ordinary issues and pull requests.

## Supported versions

There are no released or supported versions yet. This table will be updated when the first tagged milestone is published.

| Version           | Supported                                          |
| ----------------- | -------------------------------------------------- |
| Unreleased `main` | Active development; no production security support |

## Security principles

- Deny access unless organization membership and role allow it.
- Validate and normalize all input at trust boundaries.
- Never pass raw user input to a shell.
- Keep secrets encrypted at rest and redacted from every output channel.
- Treat repositories, Dockerfiles, images, webhooks, logs, and deployed applications as untrusted input.
- Run build and application workloads with bounded time, CPU, memory, storage, privileges, and network access.
- Verify webhook signatures before parsing business events and deduplicate deliveries afterward.
- Record security-relevant actions in immutable organization-scoped audit events.
- Prefer short-lived, scoped credentials and support rotation.
- Fail closed while preserving the last known healthy release.

## Minimum controls before the deployment demonstration

- [x] Validated environment configuration with no committed default secrets.
- [x] Secure session cookies, origin-based request protection, sign-in rate limiting, and security headers.
- [x] Organization-scoped authorization and cross-organization integration tests.
- [x] Canonical GitHub HTTPS URL normalization plus branch/path command-injection regression tests.
- [x] Encrypted environment variables with authenticated context and versioned key metadata.
- [x] Strict identifier-only queue contracts, PostgreSQL lease fencing, bounded retries/timeouts, and duplicate/malformed wake-up tests verified on clean PostgreSQL/Redis services.
- [x] Fixed-origin public GitHub resolution with no redirects or ambient credentials, exact commit/tree validation, bounded response/tree data, and deterministic hostile-provider tests.
- [x] Shell-free isolated Git checkout with process-tree cancellation, source limits, blob verification, special-file/LFS rejection, symlink containment, and Dockerfile hashing.
- GitHub webhook HMAC verification using the raw request body and constant-time comparison.
- Restricted build/runtime policies, timeouts, cancellation, and cleanup.
- [x] Structured logger redaction for request values, passwords, tokens, cookies, authorization headers, and keyring fields.
- Full canary redaction before future logs, events, metrics, traces, job payloads, images, and runtime output leave their boundary.
- Dependency and container-image scanning in documented quality gates.

## Secrets and test data

Never commit production credentials, `.env` files, GitHub tokens, webhook secrets, encryption keys, private repository URLs, or screenshots containing personal data. Examples and fixtures must use unmistakably fake values. If a secret is committed, revoke it first, then remove it from the current tree; history rewriting requires explicit maintainer coordination.

Project secret encryption has no fallback key. Generate a 32-byte base64url value locally, place it only in the untracked `.env` file as `LAUNCHRAIL_SECRET_KEYRING=1:<key>`, and set `LAUNCHRAIL_ACTIVE_SECRET_KEY_VERSION=1`. The API refuses to start if the active version is absent from the one-to-eight-entry keyring.

Phase 5 and 6 queue jobs never contain repository data, organization/deployment authority, correlation metadata, environment-variable values, ciphertext, or key identifiers. The worker obtains the immutable source input, deployment, and organization only by joining the opaque work-item ID through PostgreSQL before applying a fenced state change. GitHub requests are deliberately unauthenticated; host Git credential helpers and proxy/token variables are not inherited by the checkout process.

To rotate, append a new `version:key` entry, retain every older key needed to decrypt existing rows, and select the new version as active. New writes use the active version while old rows remain readable by their recorded version. Automated re-encryption is not implemented, so removing a historical key before affected rows are replaced makes those values undecryptable. See [project management](docs/project-management.md) for the exact procedure.

## Further detail

See [docs/threat-model.md](docs/threat-model.md) for assets, trust boundaries, threat scenarios, mitigations, and accepted early limitations.
