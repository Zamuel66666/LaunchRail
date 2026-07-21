# Architecture decision records

Architecture decision records (ADRs) capture choices that materially shape LaunchRail. Each record states its status, context, decision, and consequences so future contributors can distinguish deliberate constraints from accidental implementation details.

Accepted ADRs can be superseded by a later record; published records are not rewritten to hide earlier reasoning.

## Index

- [ADR-0001: Modular monolith with a separate worker](0001-modular-monolith-and-worker.md)
- [ADR-0002: Fastify, Next.js, and shared TypeScript contracts](0002-application-stack.md)
- [ADR-0003: PostgreSQL, Drizzle, Redis, and BullMQ](0003-persistence-and-jobs.md)
- [ADR-0004: Docker BuildKit, Traefik, and server-sent events](0004-deployment-infrastructure.md)
- [ADR-0005: License LaunchRail under Apache 2.0](0005-apache-2-license.md)

## Template

New records should include:

1. Title, date, and status.
2. The concrete decision pressure and constraints.
3. The decision in testable terms.
4. Positive and negative consequences.
5. Alternatives considered.
