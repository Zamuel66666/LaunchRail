# Initial threat model

## Plain-language overview

LaunchRail handles unusually powerful operations: it downloads code, builds Dockerfiles, starts containers, stores application secrets, and changes network routes. A malicious repository or stolen account could therefore affect more than one deployment. The design treats source code and workloads as untrusted even though the first supported operator and host are trusted.

This initial model identifies security requirements. Phases 1 through 4 implement foundational structured-log redaction, loopback-bound services, organization-scoped foreign keys, immutable deployment snapshots, health-gated active-release constraints, password authentication, hashed opaque sessions, organization role enforcement, request hardening, validated project input, authenticated environment-variable encryption, and identity/project/deployment audit insertion. Password recovery/second factors, repository retrieval, deployment-time secret injection, workload isolation, and the remaining controls are not claimed as complete.

## Scope and assumptions

### In scope

- Browser, web application, API, worker, database, Redis queue, telemetry path, and local reverse proxy.
- GitHub repository input and webhook delivery.
- Build context, BuildKit, image artifacts, Docker runtime, preview routes, and cleanup.
- User sessions, organization boundaries, encrypted environment variables, logs, and audit events.
- Single-host development and demonstration deployments.

### Assumptions

- The machine owner and LaunchRail operator are trusted.
- PostgreSQL, Redis, Docker, and internal telemetry services are not exposed directly to the public internet.
- TLS termination for non-local access is configured outside or at the proxy boundary.
- GitHub and pinned upstream packages are external dependencies, not fully trusted components.
- Docker daemon compromise is equivalent to host compromise in the initial design.

### Out of scope for the initial release

- Protection against a malicious host administrator.
- Strong isolation for mutually hostile public tenants.
- Multi-host control-plane security and cross-region secrets.
- Billing fraud, enterprise identity federation, and regulatory certification.

## Assets

| Asset                        | Security need                                                       |
| ---------------------------- | ------------------------------------------------------------------- |
| User session                 | Confidentiality, integrity, revocation, bounded lifetime            |
| Organization/project data    | Tenant isolation and authorized modification                        |
| Environment variables        | Encryption, access control, redaction, rotation                     |
| GitHub/webhook credentials   | Minimal scope, signature integrity, rotation                        |
| Source checkout              | Exact revision integrity and bounded contents                       |
| Built image                  | Traceability to source/configuration and tamper detection           |
| Docker host                  | Protection from workload escape and resource exhaustion             |
| Active route                 | Integrity and availability; must target an approved healthy release |
| Deployment history/audit log | Integrity, ordering, retention, actor attribution                   |
| Logs/metrics/traces          | Availability without leaking secrets or tenant data                 |
| Encryption keys              | Separation from ciphertext, restricted access, versioned rotation   |

## Actors

- **Viewer:** reads permitted projects, deployments, and redacted logs.
- **Developer:** creates projects and deployments and manages non-administrative configuration.
- **Organization owner/administrator:** manages memberships, archival, sensitive settings, and secrets.
- **LaunchRail operator:** controls the host and infrastructure configuration.
- **GitHub:** supplies source data and signed webhook events.
- **Deployed application:** untrusted workload that may be vulnerable or intentionally malicious.
- **External attacker:** may target public HTTP endpoints, preview applications, or leaked credentials.
- **Compromised account/repository/dependency:** acts with legitimate-looking input or credentials.

## Trust boundaries

```mermaid
flowchart LR
    subgraph Internet["Untrusted network"]
        Browser["Browser"]
        GitHub["GitHub"]
        Attacker["External attacker"]
    end

    subgraph Control["LaunchRail control plane"]
        Web["Web and API"]
        Worker["Worker"]
        DB[("PostgreSQL")]
        Queue[("Redis/BullMQ")]
        Telemetry["Telemetry pipeline"]
    end

    subgraph Host["Privileged container host"]
        Build["BuildKit"]
        Docker["Docker Engine"]
        Proxy["Traefik"]
    end

    subgraph Workloads["Untrusted workload boundary"]
        App["Application container"]
    end

    Browser --> Web
    GitHub --> Web
    Attacker --> Web
    Web --> DB
    Web --> Queue
    Queue --> Worker
    Worker --> DB
    Worker --> Build
    Worker --> Docker
    Worker --> Proxy
    Docker --> App
    Proxy --> App
    Web --> Telemetry
    Worker --> Telemetry
```

Crossing a boundary requires authenticated protocols, validated schemas, bounded payloads, explicit authorization, and safe error handling appropriate to that boundary.

## Threat scenarios and required mitigations

| Threat                                  | Example impact                                                | Planned controls                                                                                                                         | Evidence required before claiming mitigation           |
| --------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Session theft or fixation               | Account takeover                                              | Hashed opaque sessions, secure/HTTP-only/SameSite cookies, absolute/idle expiry, revocation, origin defense                              | Implemented for local passwords; integration tested    |
| Cross-organization access               | Read or mutate another team's project/secrets                 | Membership lookup, role checks, organization-scoped queries, deny-by-default policies                                                    | Identity/project routes integration tested             |
| Server-side request forgery             | Repository or health URL reaches internal services            | Canonical GitHub URLs, direct runtime health targets, blocked link-local/private destinations where appropriate                          | URL syntax tested; network adapters remain future      |
| Command injection                       | Crafted branch, path, or environment value runs host commands | Typed validated values, library APIs/argument arrays, no shell interpolation, checkout containment                                       | Project input tested; adapter tests remain future      |
| Malicious Dockerfile/build              | Host compromise, secret theft, denial of service              | Dedicated BuildKit policy, no control-plane secrets in context, bounded resources/time/storage/network, cleanup                          | Adversarial example builds and resource tests          |
| Container escape or Docker socket abuse | Host takeover                                                 | No Docker socket in workloads, non-root user, dropped capabilities, read-only filesystem where viable, seccomp/AppArmor, resource limits | Runtime policy inspection and escape-oriented tests    |
| Secret leakage                          | Credentials in logs, UI, metrics, images, cache, traces       | Authenticated encryption, scoped metadata/read APIs, structured-log redaction, no secret job/build arguments by default                  | Control-plane canaries tested; future channels pending |
| Forged/replayed webhook                 | Unauthorized or duplicate deployment                          | HMAC verification over raw bytes, timestamp/size controls, unique delivery ID, branch filters                                            | Invalid-signature and duplicate-delivery tests         |
| Queue message tampering/duplication     | Invalid transitions or repeated side effects                  | Private Redis, typed schemas, stable idempotency keys, state re-read, bounded retries                                                    | Duplicate-job and malformed-contract tests             |
| Route takeover/collision                | Traffic sent to wrong organization or release                 | Deterministic collision-resistant hostnames, unique constraints, authorized route intent, reconciliation                                 | Collision tests and proxy integration tests            |
| Log injection/resource exhaustion       | Misleading UI or unavailable telemetry                        | Structured encoding, display escaping, chunk/rate/retention limits, sequence IDs                                                         | Control-character, high-volume, and reconnect tests    |
| Dependency or image compromise          | Malicious control-plane/runtime code                          | Lockfile, reviewable updates, provenance where available, dependency/image scanning                                                      | CI scan results and documented triage policy           |
| Destructive control misuse              | Unauthorized stop/cancel/rollback                             | Role checks, confirmation UI, idempotent commands, audit events                                                                          | Authorization and audit integration tests              |
| Worker crash at side-effect boundary    | Duplicate containers or incorrect active route                | Persist-before-act, labeled resources, leases, idempotent adapters, reconciliation                                                       | Failure-injection tests at each boundary               |

## Repository and build policy

- Accept canonical GitHub HTTPS repository references initially; reject local paths, alternate schemes, credentials in URLs, and ambiguous hosts.
- Resolve a branch/tag to an exact commit, then clone/fetch that commit within size, file-count, time, and path limits.
- Keep control-plane credentials out of the build context and `.dockerignore` generated metadata.
- Validate the Dockerfile path remains inside the checkout.
- Treat Dockerfile directives and build output as untrusted; never convert them into shell commands or HTML.
- Label images and containers with opaque LaunchRail IDs for reconciliation, not user-provided names.

Phase 4 implements only the first syntax boundary plus branch, Dockerfile, health path, and runtime bounds. It does not prove a repository is public or exists, authenticate private repositories, resolve a reference, clone content, or contain symlinks. Those controls and their network/filesystem evidence belong to Phase 6.

## Workload isolation baseline

The exact policy will be tested against the supported Docker version. The initial target is:

- Non-root application user or explicit documented exception.
- No privileged containers, host PID/IPC namespace, host devices, or Docker socket.
- Dropped Linux capabilities with only demonstrated additions.
- CPU, memory, process, storage, log, and execution-time limits.
- Read-only root filesystem and temporary writable mounts where compatible.
- Controlled network attachment and no access to control-plane service networks.
- Bounded port exposure only through the reverse proxy.
- Cleanup and reconciliation for stopped/orphaned resources.

Build isolation remains weaker than a hardened remote builder because BuildKit and Docker share the trusted host. This residual risk is accepted only for trusted local operation in early releases.

## Secret lifecycle

1. Validate secret names and size at the API boundary.
2. Encrypt values with AES-256-GCM, a fresh nonce/tag, and organization/project/name authenticated context.
3. Store ciphertext, nonce, authentication tag, algorithm, and key version in PostgreSQL; store the keyring separately.
4. Decrypt only in the worker immediately before runtime injection.
5. Redact exact and encoded canary forms before emitting logs/events.
6. Never return stored plaintext through read APIs.
7. Audit create, update, delete, and access operations without recording the value.
8. Support key rotation by version and re-encryption without changing the logical secret.

Phase 4 implements steps 1–3, the no-plaintext API part of step 6, value-free write/delete audit events in step 7, and versioned active/historical keys for step 8. Runtime decryption/injection, exact/encoded runtime-output redaction, secret-access auditing, and automated re-encryption remain future work. Operators must retain historical keys until every referenced row is replaced.

## Security verification gates

- Threat-model review when a trust boundary or privileged adapter changes.
- Dependency review and automated vulnerability scanning.
- Static checks for secrets and unsafe patterns.
- Authentication, authorization, webhook, redaction, and runtime-policy tests.
- Adversarial example applications for build, health, and log behavior.
- Manual inspection of Docker and proxy configuration in release setup verification.

## Residual risks

Even after planned controls, the single Docker host, third-party dependencies, execution of user-supplied builds, locally managed keyring, and absent automated key re-encryption remain material risks. Phase 4 validates repository-shaped input but does not inspect remote source, so only trusted intended-public repositories should be configured. Production-readiness claims require an updated model, external review, isolation testing, incident processes, backups, managed keys, and operational evidence beyond the current milestone.

## Review triggers

Review this model whenever LaunchRail adds private repositories, new authentication methods, multi-host execution, shared public hosting, new build/runtime engines, outbound application networking controls, secret providers, or a new external telemetry destination. Also review it after any security incident or failed isolation test.
