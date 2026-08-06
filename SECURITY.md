# Security policy

## Current security status

LaunchRail has a runnable Phase 3 authentication boundary, but it is not production-ready and must not be exposed publicly or used to run untrusted workloads. It validates process configuration, rejects documented development credentials in production, binds development services to loopback, uses scrypt password hashes, stores only hashes of opaque sessions, enforces organization roles, rejects cross-origin mutations, throttles sign-in, and records identity audit events. Password recovery, invitations, MFA, SSO, encrypted application secrets, repository processing, and container execution controls are not implemented.

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
- Repository URL allowlisting/normalization and command-injection regression tests.
- Encrypted environment variables with versioned key metadata.
- GitHub webhook HMAC verification using the raw request body and constant-time comparison.
- Restricted build/runtime policies, timeouts, cancellation, and cleanup.
- Central secret redaction applied before logs, events, metrics, and traces leave a process.
- Dependency and container-image scanning in documented quality gates.

## Secrets and test data

Never commit production credentials, `.env` files, GitHub tokens, webhook secrets, encryption keys, private repository URLs, or screenshots containing personal data. Examples and fixtures must use unmistakably fake values. If a secret is committed, revoke it first, then remove it from the current tree; history rewriting requires explicit maintainer coordination.

## Further detail

See [docs/threat-model.md](docs/threat-model.md) for assets, trust boundaries, threat scenarios, mitigations, and accepted early limitations.
