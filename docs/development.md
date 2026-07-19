# Development workflow

## Current repository state

Phase 0 contains Markdown product and engineering documentation. There is no package manifest, application process, database migration, Docker Compose file, or test suite yet. Commands that imply those artifacts work are intentionally omitted.

## Phase 0 validation

Before committing documentation:

```bash
git diff --check
npx --yes markdownlint-cli2@0.18.1 "**/*.md" "#node_modules"
```

Also verify:

- Every relative Markdown link resolves to a tracked file or a real heading.
- Mermaid blocks use valid diagram syntax.
- The README, roadmap, changelog, and detailed documents agree on current status.
- Planned behavior is labeled as planned rather than available.
- No token, credential, personal data, private URL, or invented result appears in the diff.
- The staged diff represents one logical change.

The Markdown command pins its validator version and reads `.markdownlint-cli2.jsonc`. Phase 1 will move formatting and lint dependencies into the workspace lockfile.

## Session workflow

1. Inspect repository status, recent commits, README, roadmap, and relevant documents.
2. Identify the next incomplete phase and choose a bounded milestone.
3. Confirm the worktree does not contain unrelated user changes.
4. Define the observable acceptance evidence before implementation.
5. Implement domain behavior and adapters in their proper boundaries.
6. Add deterministic tests and update documentation with the same change.
7. Run applicable gates and inspect the complete/staged diff.
8. Commit coherent units with precise messages and push without rewriting published history.
9. Update visible status only after the milestone is proven.

## Planned Phase 1 environment

Phase 1 will pin Node.js and pnpm versions and introduce tested commands. The target workflow is:

```bash
pnpm install --frozen-lockfile
docker compose up -d postgres redis
pnpm dev
```

These commands are a design target, not currently executable. Phase 1 is complete only after they are tested from a fresh clone and the actual environment variables, ports, health endpoints, and cleanup commands are documented here.

## Planned workspace responsibilities

```text
apps/api       HTTP, authentication, authorization, webhooks, streams
apps/web       user interface
apps/worker    queue consumers and deployment orchestration
packages/domain        state and invariants without framework imports
packages/application   use cases and infrastructure ports
packages/database      Drizzle schema, migrations, repositories
packages/contracts     runtime schemas for API, events, and jobs
packages/config        environment parsing and validation
packages/observability logs, metrics, and tracing conventions
```

## Environment configuration rules

- A committed `.env.example` will contain names and safe examples only.
- Startup validates every required value and reports actionable errors without printing secrets.
- Tests use isolated configuration and generated fake credentials.
- Encryption, session, GitHub, and webhook secrets have no insecure production default.
- Service URLs are parsed as URLs rather than concatenated strings.

## Database changes

Every schema change must include a generated, reviewable migration and tests from a clean database. Migrations should be forward-safe for the supported unreleased/release path; if rollback is supported, test it. Never edit an already-published migration to disguise a later change.

## API changes

Update runtime request/response schemas, generated OpenAPI output, authorization tests, and integration tests together. Errors use stable machine-readable categories and safe human-readable messages. Do not expose adapter exception text directly.

## Worker and infrastructure changes

Document retry, timeout, idempotency, cancellation, cleanup, and crash behavior. Tests should use fake ports for domain/application behavior and real disposable services for adapter contracts. Any Docker integration command must operate only on resources labeled for its isolated test run.

## User-interface changes

Exercise loading, empty, success, permission-denied, and failure states. Run relevant component and Playwright tests, check keyboard navigation and responsive layout, and capture screenshots only for complete user-facing milestones.

## Long-running checks

Builds, end-to-end suites, failure injection, and benchmarks may take longer than unit checks. Run them with explicit scope, preserve their logs/results, and report duration/environment rather than repeatedly polling them.
