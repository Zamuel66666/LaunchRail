# Security policy

## Current security status

LaunchRail implements a public-GitHub deployment pipeline with restricted Docker runtimes, health-gated activation, preview routing, rollback, and authenticated operator controls. It is undergoing release acceptance for a trusted, loopback-only Linux demonstration, not production hosting or mutually hostile tenants. Password recovery, invitations, MFA, SSO, private-source authentication, and deployment-time secret injection are not implemented.

Control-plane configuration is validated; development credentials are rejected in production. Passwords use scrypt, opaque sessions are hashed, organization roles are enforced, and security-relevant mutations are audited. Project variables use versioned AES-256-GCM envelopes and write-only APIs; they are not passed to builds or runtimes. Identifier-only queue payloads cannot supply authority: PostgreSQL owns immutable snapshots, attempts, leases, fencing, and dead letters. Public source resolution fixes GitHub origins, verifies exact commit/tree/blob identity, disables ambient credentials/configuration, and bounds checkout contents.

Workloads use non-root users, dropped capabilities, no-new-privileges, bounded CPU/memory/process counts, loopback port bindings, read-only roots where configured, and no Docker socket. BuildKit remains privileged on the trusted host. These restrictions do not prevent every container escape or malicious workload network access. Operators must review repositories and Dockerfiles; public multi-tenant execution is unsupported.

Automatic request logging keeps only bounded IDs, methods, and route templates; raw paths, query values, headers, bodies, hosts, and remote addresses are omitted. Raw webhook capture is bounded while streaming, including chunked requests and URLs with query strings, before persistence or trigger processing. Signature checks use exact bytes. Controlled telemetry canaries, scoped log APIs, strict job contracts, and immutable receipt tests provide evidence, not a universal guarantee against application-output secrets. Runtime and build output are application-controlled and must be treated as sensitive. Dependency/image reviews and the independent release checklist remain required.

The first implementation will target a trusted operator on a local Docker host. Docker daemon access is effectively host-level privilege; container restrictions reduce workload risk but do not turn the initial design into a hardened hostile multi-tenant platform.

## Image dependency review

The current [image dependency review](docs/image-review.md) records scanner findings, updates, and residual risk requiring release-owner review. Package/module matches are not proof of exploit reachability; they are not silently dismissed either.

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
- [x] GitHub webhook HMAC verification using bounded raw request bytes and constant-time comparison, scoped deduplication, and rejected-first recovery.
- [x] Restricted build/runtime policies, timeouts, cancellation, and managed-resource cleanup implemented and adapter-tested; broad interruption acceptance remains open.
- [x] Structured logger redaction for request values, passwords, tokens, cookies, authorization headers, and keyring fields.
- Control-plane secret-canary verification across logs and traces; arbitrary application output cannot be guaranteed secret-free.
- Dependency and container-image scanning in documented quality gates.

## Secrets and test data

Never commit production credentials, `.env` files, GitHub tokens, webhook secrets, encryption keys, private repository URLs, or screenshots containing personal data. Examples and fixtures must use unmistakably fake values. If a secret is committed, revoke it first, then remove it from the current tree; history rewriting requires explicit maintainer coordination.

Project secret encryption has no fallback key. Generate a 32-byte base64url value locally, place it only in the untracked `.env` file as `LAUNCHRAIL_SECRET_KEYRING=1:<key>`, and set `LAUNCHRAIL_ACTIVE_SECRET_KEY_VERSION=1`. The API refuses to start if the active version is absent from the one-to-eight-entry keyring.

Phase 5 and 6 queue jobs never contain repository data, organization/deployment authority, correlation metadata, environment-variable values, ciphertext, or key identifiers. The worker obtains the immutable source input, deployment, and organization only by joining the opaque work-item ID through PostgreSQL before applying a fenced state change. GitHub requests are deliberately unauthenticated; host Git credential helpers and proxy/token variables are not inherited by the checkout process.

To rotate, append a new `version:key` entry, retain every older key needed to decrypt existing rows, and select the new version as active. New writes use the active version while old rows remain readable by their recorded version. Automated re-encryption is not implemented, so removing a historical key before affected rows are replaced makes those values undecryptable. See [project management](docs/project-management.md) for the exact procedure.

## Further detail

See [docs/threat-model.md](docs/threat-model.md) for assets, trust boundaries, threat scenarios, mitigations, and accepted early limitations.
