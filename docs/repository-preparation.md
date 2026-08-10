# Repository preparation and source security

## Available outcome

Phase 6 turns an already-persisted immutable deployment source into a verified local checkout and advances the deployment from `cloning` to `building`. It does not build or execute repository content.

The implemented path supports unauthenticated public repositories on `github.com` only. PostgreSQL remains authoritative for the deployment, work lease, retry/dead-letter result, and portable preparation metadata. Redis carries only the source work-item UUID and job kind.

## Immutable source boundary

A deployment stores two separate values:

- `source_revision`: the exact lowercase 40-character Git commit SHA used as authority.
- A version 1 source snapshot: provider, owner, repository, requested revision, and configured Dockerfile path.

`createDeploymentSourcePersistence` converts a validated provider result into those fields so a future deployment-start use case can resolve a mutable branch or tag before inserting the immutable deployment. The current worker begins only after such a deployment already exists; no HTTP route or UI creates it yet.

Source work never reloads mutable project configuration. It joins the opaque work-item ID to the immutable deployment, then asks the provider for the persisted exact SHA rather than re-resolving the saved branch. The originally requested revision is retained for traceability. A branch moving after initial resolution therefore cannot change the checked-out commit.

## Public GitHub provider

`GitHubRepositoryProvider` makes bounded `GET` requests only to the fixed GitHub API repository, commit, and recursive-tree endpoints. It:

- Omits credentials, sends no authorization header, disables caching, and rejects redirects.
- Requires repository visibility to be public and the returned full name to match the normalized owner/repository.
- Resolves branch-, tag-, or SHA-shaped input through the commits endpoint and requires exact lowercase SHA-1 commit and tree identifiers.
- Requires a non-truncated recursive tree whose declared SHA matches the commit tree.
- Accepts only directories, regular/executable blobs, and symlink blobs; gitlinks/submodules and unsupported modes are rejected.
- Bounds every response while streaming it and bounds total entries, logical bytes, individual blob bytes, path bytes, and path depth before Git runs.
- Treats 404/invalid/malformed/integrity/limit results as safe permanent source failures. Rate limits, 5xx responses, network failures, and resolution timeouts are safe retryable availability failures.

The application contract allows provider injection, so acceptance tests use deterministic fake HTTP rather than depending on GitHub availability or rate limits.

## Hardened exact-SHA checkout

`HardenedGitRepositoryCheckout` owns one dedicated absolute, normalized, non-root source directory. It creates the directory with mode `0700` and refuses a symlink, a different owner, group/other permission bits, or a real path different from the configured path.

Git is invoked as a fixed absolute executable with an argument array and `shell: false`. Each child uses a new process group and an allowlisted environment. The adapter:

- Sets private temporary `HOME`, `XDG_CONFIG_HOME`, and `TMPDIR` directories.
- Disables system/global Git configuration, credential helpers, terminal/askpass prompts, redirects, hooks, submodule recursion, attributes, and user-selected protocols.
- Omits host token/proxy/Git environment variables and allows HTTPS transport only in production.
- Initializes a bare staging repository, fetches only the exact verified SHA with no tags or submodules into a private ref, then verifies both commit and tree before detached checkout.
- Caps combined child output and polls the Git object directory during fetch; an exceeded bound aborts the complete process group.
- On abort or timeout, sends a signal to the process group, escalates after a bounded grace period, waits for child closure, and removes the validated staging directory.

The disk monitor is a polling guard, not a kernel-enforced quota, so a brief overshoot is possible. A production hostile-tenancy claim would require stronger filesystem isolation and quotas.

## Checkout and Dockerfile validation

After checkout, the adapter walks with `lstat` and does not follow entries during enumeration. It compares every live path with the provider tree and verifies regular-file and symlink Git blob SHA-1 values. It rejects missing, extra, duplicate, type/mode-mismatched, or content-mismatched entries.

The live scan re-applies file-count, total-byte, individual-file, path-byte, and depth limits. FIFOs, devices, sockets, and other special files are rejected. Git LFS pointer files are rejected because Phase 6 neither downloads nor verifies LFS objects.

Symlinks may target a regular file inside the checkout. Absolute, escaping, dangling, cyclic, or otherwise unresolvable links fail the preparation. Containment uses resolved paths and relative-path checks rather than string-prefix comparison.

The configured Dockerfile must:

- Use the already-validated relative POSIX path.
- Resolve inside the checkout, including through any allowed internal symlink.
- Resolve to a non-empty regular file within the individual-file limit.

The result records both configured and resolved relative paths, byte size, and SHA-256 digest. No absolute worker path is stored in PostgreSQL or sent through Redis.

## Durable workflow and atomicity

The source workflow is the second identifier-only background step:

1. Completing `deployment.claim` atomically applies `queued` to `cloning`, creates the unique `deployment.prepare_source` row, and completes the claim row.
2. Reconciliation also creates missing source work for an eligible `cloning` deployment and republishes due work absent from Redis.
3. A source worker claims the expected job kind with a PostgreSQL-clock lease and fencing token, then loads immutable source input through that token.
4. Provider and checkout work run under the worker deadline while lease heartbeats preserve valid ownership.
5. Success atomically inserts or compares the one-to-one source-preparation record, applies `cloning` to `building`, and completes the work item.
6. A permanent source error, or a retryable error at exhaustion, atomically applies `cloning` to `build_failed` and dead-letters the real attempt. Earlier retryable errors schedule deterministic PostgreSQL backoff.

The source-preparation table stores checkout ID, exact commit/tree, file count, logical bytes, configured/resolved Dockerfile paths, digest, and preparation time. Composite ownership/revision foreign keys bind it to the deployment, checks bound every field, and a trigger makes the row immutable. The completion transaction rechecks the unexpired lease after the source transition so lease expiry rolls back metadata, events, audit/command records, and job completion together.

## Restart and checkout adoption

Ordinary failure and cancellation remove only the adapter-created staging directory. After validation, the adapter removes Git metadata and private helper directories, writes a versioned marker, and atomically renames staging to the deterministic checkout ID.

A crash can occur after that rename and before PostgreSQL commits. On retry, the adapter never trusts the marker alone: it re-reads the bounded marker, rescans every source entry and Git blob identity, recomputes the Dockerfile digest, and compares all identities and totals before returning `adopted: true`. Same-size file tampering therefore fails. Concurrent preparation converges by adopting the winner after complete validation.

Successful checkouts remain available for Phase 7's build context. Cleanup of abandoned final checkouts and staging directories left by a hard process/host crash is part of the broader Phase 14 recovery inventory.

## Safe failure reporting

Provider/Git response bodies, Git arguments/output, local paths, raw exceptions, repository content, and credentials are never persisted as user-facing failure text. The worker maps failures to stable categories:

| Condition                                        | Category                     | Retry |
| ------------------------------------------------ | ---------------------------- | ----- |
| Public provider/network or checkout unavailable  | `source_unavailable`         | Yes   |
| Overall source preparation timeout               | `clone_timeout`              | Yes   |
| Configured Dockerfile absent                     | `dockerfile_missing`         | No    |
| Invalid source, limit, containment, or integrity | `source_invalid`             | No    |
| Unexpected infrastructure failure                | `infrastructure_unavailable` | Yes   |

Failure state/events use fixed safe messages, categories, attempts, and opaque work-item identifiers. The successful source event may additionally report only adoption status and bounded file/byte totals.

## Configuration

Source settings and defaults are listed in [queue and worker operations](queue-worker.md#configuration). The important relationships are validated at startup: provider and provider-plus-checkout timeouts cannot exceed the overall job timeout, the per-file ceiling cannot exceed the checkout ceiling, paths have a 1,024-byte maximum, and the source root must be a dedicated absolute non-root directory.

`/usr/bin/git` is the current production executable contract. CI records deterministic adapter evidence on Linux; portability to other operating systems or Git installations is not claimed.

## Verification evidence

Ordinary tests require no external GitHub connection. Fake HTTP fixtures cover fixed origins, no credentials/redirects, public/private/not-found/rate-limit/server responses, malformed and oversized bodies, SHA/tag/ref input, tree truncation, and entry limits. Real local Git fixtures cover exact-SHA checkout, a branch moving from commit A to B after resolution, hostile ambient credential/filter configuration, argument injection, commit/tree/blob mismatch, output flood, timeout/abort with a grandchild process, disk/file/path/depth limits, symlink and special-file attacks, LFS pointers, Dockerfile failures, cleanup, concurrency, and tampered checkout adoption.

The disposable PostgreSQL/Redis suite covers kind binding, immutable input loading, source handoff, duplicate delivery, retry/permanent/exhausted failure, lease fencing and expiry rollback, missing/expired work, checkout adoption, clean shutdown, and restart from a crashed claim through one `building` result. [GitHub Actions run 31414001234](https://github.com/Zamuel66666/LaunchRail/actions/runs/31414001234) passed that clean-service gate with the repository's static, unit, integration, build, and health checks.

## Current boundaries

- Public GitHub only; no private credentials, enterprise GitHub, arbitrary hosts, submodules, or Git LFS.
- No deployment-start HTTP endpoint or UI; an already-persisted immutable deployment is required.
- No BuildKit/image/log work yet. Phase 7 consumes the retained checkout without re-resolving the source.
- No external GitHub smoke test in acceptance CI; provider behavior is deterministic and network-independent there.
- The current adapter accepts 40-character Git SHA-1 identifiers. The database format is future-capable for 64-character hashes, but the GitHub adapter does not claim SHA-256 repository support.
- Source controls reduce exposure on a trusted single-user local host; they do not create a hardened hostile multi-tenant build service.
