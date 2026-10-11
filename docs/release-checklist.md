# Release checklist

This checklist is the release gate for a public LaunchRail version. No version is ready merely because the application builds locally.

## Before proposing a release

- [ ] Select the target version and scope; do not publish a tag until all required Phase 16 checks have independent evidence.
- [ ] Start from a clean clone and follow the README setup without relying on ignored local files or previously generated artifacts.
- [ ] Apply migrations to a clean PostgreSQL database and start Redis, API, worker, proxy, and web services.
- [ ] Complete a real public-repository deployment from an exact revision; verify build logs, health history, preview routing, promotion, rollback, cancellation, and stop behavior.
- [ ] Exercise signed webhook success, duplicate delivery, invalid signature, failed processing, and operator retry.
- [ ] Interrupt API, worker, Redis, PostgreSQL, and proxy at documented lifecycle boundaries; confirm recovery or actionable terminal failure and inventory Docker resources.
- [ ] Run all unit, integration, database, queue, runtime, routing, BuildKit, lint, format, type, and build gates in the supported environment. Record command output and service versions.
- [ ] Run the documented benchmarks only on a controlled host. Publish raw, unedited machine-readable results with commit, environment, methodology, correctness evidence, and limitations.
- [ ] Review authorization, secret redaction, dependency updates, image provenance, backup/restore, operational alerts, accessibility, and the threat model.
- [ ] Update README, roadmap, changelog, setup instructions, screenshots, known limitations, and recovery procedures so every public claim matches observable behavior.
- [ ] Have an independent reviewer inspect the release diff and evidence. Resolve all blocking findings before release.

## Publishing

1. Merge the approved release change to `main` using the repository's normal review process.
2. Confirm CI is green for the exact `main` commit and that the local checkout and published source match that commit.
3. Create a signed annotated version tag only after the release owner approves the final commit and notes.
4. Publish release notes describing user-visible changes, upgrade/migration steps, known limitations, and rollback guidance.
5. After publishing, verify the tag/release page, install instructions, migration path, and downloadable artifacts from a clean environment.

## Current status

LaunchRail is not release-ready. Recovery acceptance, full distributed tracing, browser runtime log viewing, broad reproducible benchmarks, independent verification of recent features, and production operations remain outstanding. Do not create a release tag based on this checklist alone.
