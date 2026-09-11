# Image builds

Status: implementation under verification. Phase 7 is not yet published as available.

Source preparation creates a durable `deployment.build` work item in the same
transaction that moves the deployment to `building`. PostgreSQL owns attempts,
leases, build logs, and the resulting image record. Redis carries a versioned
work-item identifier and can be reconstructed by reconciliation.

Before invoking BuildKit, the worker copies the retained source into a private
build directory and verifies its canonical context digest and Dockerfile digest.
The adapter uses argument-based process execution, a dedicated Docker client
configuration, bounded output, a deadline, and process-group cancellation.
Build commands request resource limits and disable networking for build steps.

Successful builds retain an exact image ID, manifest digest, platform, size,
source identity, and context identity. A stable image reference permits a retry
to adopt a verified result after a crash. Image metadata and the transition from
`building` to `deploying` commit together under the work item's current lease.
Permanent failures move the deployment to `build_failed`; transient failures
use the durable retry policy.

Logs are redacted before persistence and constrained by both adapter and
database retention limits. Pattern redaction is best effort: repository output
must never be treated as a safe destination for secrets. This milestone does
not supply build secrets or SSH credentials.

## Verification

`pnpm test` exercises process execution, output limits, cancellation, progress
redaction, and job routing without Docker. `pnpm test:database` and
`pnpm test:queue` require disposable PostgreSQL and Redis targets.
`pnpm test:buildkit` requires the configured `launchrail-builder` Buildx builder
and exercises actual image creation, adoption, failure, cache reuse, output
redaction, timeout, cancellation, and output limits. The quality workflow
provisions the pinned builder and runs this acceptance suite.

## Current boundaries

The Docker daemon and BuildKit host are trusted infrastructure. Disabling build
step networking does not prevent the builder from fetching base images or
remote build inputs. This is not a hostile multi-tenant sandbox. Registry
publication, signing, scanning, runtime startup, browser log streaming, and the
deployment-start interface remain subsequent work.

The acceptance builder disables external Dockerfile frontends. Dockerfiles that
request an external `syntax` frontend are rejected; ordinary Dockerfiles use the
frontend bundled with the pinned BuildKit daemon.
