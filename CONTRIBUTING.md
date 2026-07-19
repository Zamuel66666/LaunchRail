# Contributing to LaunchRail

LaunchRail is developed as a sequence of small, demonstrable milestones. Contributions should make the real product more complete without claiming behavior that has not been implemented and verified.

## Before starting

1. Read [README.md](README.md), [ROADMAP.md](ROADMAP.md), and the relevant technical document.
2. Check open issues and pull requests for overlapping work.
3. Run `git status` and preserve unrelated local changes.
4. Select one bounded roadmap outcome and identify its acceptance evidence.
5. Discuss changes that alter a trust boundary, state invariant, public API, or accepted ADR before implementation.

## Development setup

The repository is currently documentation-only. See [docs/development.md](docs/development.md) for current validation and the planned Phase 1 local environment. Do not add untested setup commands to the README.

## Change requirements

- Keep domain rules independent from Fastify, Next.js, Docker, GitHub, Redis, and other adapters.
- Validate untrusted input at runtime and use explicit types internally.
- Add tests for behavior changes and regression tests for defects where practical.
- Update public documentation, schemas, examples, or operational guidance with the behavior they describe.
- Do not commit secrets, personal data, private repository details, generated build output, or benchmark results without source evidence.
- Do not describe LaunchRail as production-ready.

## Commits

Prefer one logical change per commit and Conventional Commits where practical:

```text
feat(deployments): add explicit deployment state machine
test(webhooks): cover duplicate delivery handling
security(runtime): enforce container resource limits
docs: explain local recovery behavior
```

A commit must leave the repository valid and pass its applicable checks. Review the staged diff with `git diff --cached` before committing. Avoid formatting-only or “miscellaneous” commits that hide the reason for a change.

## Pull requests

A pull request should explain:

- What user or developer outcome changed.
- Why the change belongs in the current milestone.
- Important design or security trade-offs.
- Tests and manual checks run, including anything that could not run.
- Documentation, screenshots, migrations, or benchmark evidence added.
- Remaining limitations.

Keep pull requests reviewable. Split independent behavior rather than coupling unrelated features, but do not create artificial commits solely to increase activity.

## Quality gates

Run every applicable repository command before requesting review. The planned Phase 1 baseline is:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
```

Use Playwright, Docker Compose validation/builds, clean database migrations, OpenAPI generation checks, and security or benchmark suites when the changed area requires them. Report skipped checks precisely.

## Documentation and screenshots

Documentation must distinguish plain-language outcomes from technical detail and reflect current code. Store useful user-facing evidence in `docs/assets/` with descriptive filenames. Remove tokens, personal data, local secrets, and private URLs before committing an image.

## Security issues

Follow [SECURITY.md](SECURITY.md). Never publish exploit details or secrets in an ordinary issue.
