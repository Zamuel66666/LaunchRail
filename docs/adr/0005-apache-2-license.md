# ADR-0005: License LaunchRail under Apache 2.0

- **Status:** Accepted
- **Date:** 2026-07-21

## Context

LaunchRail is intended to be an open-source engineering project. Before implementation contributions expand, users and contributors need explicit permission to use, modify, and distribute the work. The license should also address patent grants because the project implements infrastructure and orchestration techniques.

## Decision

License LaunchRail under the Apache License, Version 2.0. Repository package metadata identifies `Apache-2.0`, and the complete license text is stored at the repository root.

Contributions intentionally submitted to this repository are accepted under the same license unless a separate written agreement applies. Third-party dependencies and example assets retain their own licenses and must be reviewed before inclusion.

## Consequences

- Individuals and organizations receive broad permission to use, modify, and distribute LaunchRail.
- Contributors provide an explicit patent grant for applicable contributions, with the license's patent-termination protection.
- Redistributed copies and modified files must follow the Apache 2.0 notice requirements.
- The license does not grant rights to project trademarks and provides no warranty.
- Dependency and asset licensing still requires separate review and attribution where applicable.

## Alternatives considered

- **MIT:** simpler and permissive, but does not contain the same explicit patent grant and termination terms.
- **GPLv3:** provides strong reciprocal terms, but would make reuse in differently licensed deployment tooling more restrictive than intended.
- **No license:** rejected because public source without a license does not meet the project's open-source goal.
