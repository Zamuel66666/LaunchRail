# Project management and secrets

## Available behavior

Phase 4 provides an authenticated `/projects` workspace and organization-scoped APIs for creating, listing, reading, updating, and archiving project configuration. PostgreSQL remains authoritative, every write is audited, and reads exclude archived projects.

Project updates and archival include the last observed integer `version`. A stale `expectedVersion` returns `409 version_mismatch` instead of silently overwriting a newer change.

## Accepted project configuration

The API rejects unknown fields and validates the same safety rules in the domain and database layers.

| Field                  | Accepted value                                                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Project name           | Trimmed, 1–80 characters; unique case-insensitively among active projects in an organization                                  |
| Repository             | Canonical `https://github.com/owner/repository`; no credentials, query, fragment, `.git`, or other host                       |
| Default branch         | Safe Git reference syntax, 1–255 characters; no traversal, reflog, lock, control, or shell metacharacter forms                |
| Dockerfile path        | Relative POSIX path, 1–256 characters; no absolute, empty, `.`/`..`, percent-encoded, or backslash segments                   |
| Health-check path      | Origin-only path beginning with `/`, at most 256 characters; no query, fragment, encoding, traversal, or scheme-relative form |
| Health-check port      | Integer from 1 through 65,535                                                                                                 |
| CPU                    | Integer from 100 through 4,000 millicores                                                                                     |
| Memory                 | Integer from 64 through 8,192 MiB                                                                                             |
| Process limit          | Integer from 16 through 1,024                                                                                                 |
| Read-only root setting | Boolean                                                                                                                       |

Project create/update syntax validation deliberately does not contact GitHub. Phase 6 adds a separate application/provider boundary that can resolve a public requested reference to exact immutable deployment source fields, and the worker later verifies/checks out that exact commit with source limits and Dockerfile containment. No deployment-start HTTP route calls that bridge yet. Private-repository authentication is not available.

## Role behavior

| Capability                               | Owner | Admin | Developer | Viewer |
| ---------------------------------------- | :---: | :---: | :-------: | :----: |
| Read project configuration               |  Yes  |  Yes  |    Yes    |  Yes   |
| Create and update projects               |  Yes  |  Yes  |    Yes    |   No   |
| Archive projects                         |  Yes  |  Yes  |    No     |   No   |
| Read environment-variable names/metadata |  Yes  |  Yes  |    No     |   No   |
| Create, replace, or delete variables     |  Yes  |  Yes  |    No     |   No   |

Unauthorized organization IDs are concealed using the same not-found behavior as other organization routes. Developers and viewers receive an empty `environmentVariables` list rather than secret metadata.

## HTTP API

All routes require a valid session. `:organizationId` and `:projectId` are UUIDs.

| Method   | Route                                                                               | Permission       | Result                                  |
| -------- | ----------------------------------------------------------------------------------- | ---------------- | --------------------------------------- |
| `GET`    | `/v1/organizations/:organizationId/projects`                                        | `project:read`   | `{ projects: [...] }`                   |
| `POST`   | `/v1/organizations/:organizationId/projects`                                        | `project:create` | `201 { project }`                       |
| `GET`    | `/v1/organizations/:organizationId/projects/:projectId`                             | `project:read`   | `{ project }`                           |
| `PATCH`  | `/v1/organizations/:organizationId/projects/:projectId`                             | `project:update` | `{ project }`                           |
| `DELETE` | `/v1/organizations/:organizationId/projects/:projectId`                             | `project:delete` | `204`                                   |
| `PUT`    | `/v1/organizations/:organizationId/projects/:projectId/environment-variables/:name` | `secret:manage`  | `{ environmentVariable: { metadata } }` |
| `DELETE` | `/v1/organizations/:organizationId/projects/:projectId/environment-variables/:name` | `secret:manage`  | `204`                                   |

Create sends the project fields in the validation table. Update sends the same fields plus `expectedVersion`; project deletion sends `{ "expectedVersion": number }`. Secret upsert sends `{ "value": string }`. Variable names use `^[A-Z_][A-Z0-9_]*$` with a 128-character limit; values must be non-empty, contain no null byte, and encode to at most 16,384 UTF-8 bytes.

Project responses contain configuration, version, and timestamps. When permitted, variable entries contain only `id`, `name`, `createdAt`, and `updatedAt`. Stored or submitted plaintext, ciphertext, nonce, authentication tag, algorithm, and key version are never part of the HTTP response.

## Encryption envelope

Environment-variable values use AES-256-GCM with a fresh 96-bit nonce and a 128-bit authentication tag for every write. PostgreSQL stores base64url ciphertext, nonce, tag, algorithm, and key version; a uniqueness constraint prevents reusing a nonce with the same key version.

Additional authenticated data binds the envelope version and fixed purpose to the organization ID, project ID, and normalized variable name. Moving ciphertext between organizations, projects, or names therefore fails authentication. Decryption failures are generic and do not expose key or ciphertext details.

Structured logging redacts request values, passwords, tokens, cookies, authorization headers, and keyring-shaped fields. Audit records contain the action, actor, project, and variable name where relevant, never the value.

## Local key setup

The repository contains no encryption key and the API has no insecure default. After copying `.env.example`, append a freshly generated 32-byte key to the ignored `.env` file:

```bash
node -e "process.stdout.write('LAUNCHRAIL_SECRET_KEYRING=1:'+require('node:crypto').randomBytes(32).toString('base64url')+'\nLAUNCHRAIL_ACTIVE_SECRET_KEY_VERSION=1\n')" >> .env
```

Do not run that command repeatedly against the same file, print the resulting key in logs, or commit `.env`. Store operational keys in an access-controlled secret manager before any non-local deployment.

`LAUNCHRAIL_SECRET_KEYRING` accepts one to eight comma-separated `positive-version:base64url-32-byte-key` entries. Versions must be unique, and `LAUNCHRAIL_ACTIVE_SECRET_KEY_VERSION` must identify one of them. The API fails closed on malformed configuration.

## Rotation

To rotate from version 1 to version 2:

1. Generate a new independent 32-byte key.
2. Configure `LAUNCHRAIL_SECRET_KEYRING=1:<old-key>,2:<new-key>`.
3. Configure `LAUNCHRAIL_ACTIVE_SECRET_KEY_VERSION=2` and restart the API.
4. Replace existing environment variables through the API so those rows are encrypted with version 2.
5. Remove version 1 only after proving no row references it and after retaining an appropriate recovery backup.

New writes always use the active version; historical versions remain decryptable while their keys remain present. LaunchRail does not yet automate re-encryption or report per-version rotation progress.

## Archival and history

Archive is a soft delete: it sets `archivedAt`, increments the version, hides the project from project APIs/UI, and frees its case-insensitive name for reuse. The same transaction permanently purges that project's encrypted environment variables and records the count in the audit event.

An active release or any non-terminal/in-flight deployment causes `409 project_in_use`; stop or finish that work first. When archival succeeds, terminal deployment records and their event history remain attached to the archived project for auditability. There is currently no restore or hard-delete API.

## Migration note

The Phase 4 migration is clean-database safe and upgrades legacy empty runtime settings to bounded defaults. It intentionally stops if `environment_variables` already contains rows: pre-Phase-4 rows have no AES-GCM authentication tag and cannot be authenticated. Back up the database, record which variables must be recreated, remove those legacy rows, apply the migration, and re-enter values through the API. Do not describe legacy ciphertext as recoverable through the new envelope.

## Verification

The milestone's evidence includes:

- Domain tests for canonicalization, malicious branch/path input, runtime bounds, variable names, byte limits, and null bytes.
- Cipher tests for randomized envelopes, historical-key reads, tampering, malformed fields, missing versions, and wrong organization/project/name context.
- Fastify tests for schemas, stable safe errors, write-only responses, and role permissions.
- Disposable-PostgreSQL tests for clean migration, tenant isolation, optimistic conflicts, encrypted storage/audit canaries, archive rejection, secret purging, and terminal-history preservation.
- Production web build plus browser checks for sign-in, empty/create/edit flows, write-only secret clearing, archive confirmation, and a 390-pixel responsive layout; route tests cover role and conflict behavior.

Run the repository gates from [development.md](development.md). Real-database claims require the disposable PostgreSQL suite; browser claims require a running API/web stack.

## Current boundaries

- Public GitHub source verification and containment are available only for an already-persisted immutable deployment; project save itself remains an offline syntax operation.
- Private repositories, Git LFS, submodules, arbitrary Git hosts, and deployment-start HTTP/UI are not available.
- Saved project configuration and decrypted values are not yet placed in queue messages, builds, or runtime environments.
- Identifier-only queue consumption and source preparation are available; image builds, application containers, readiness checks, live logs, previews, deployment controls, and rollback do not exist yet.
- Authentication is local-password only, and health endpoints report liveness rather than dependency readiness.
- Automated key re-encryption and external key-management integration are not implemented.
