# ADR-0001: Modular monolith with a separate worker

- **Status:** Accepted
- **Date:** 2026-07-19

## Context

LaunchRail needs clear domain boundaries and independently scalable long-running deployment work, but its first supported environment is one local machine. Splitting every capability into a network service would add deployment, versioning, tracing, and consistency costs before there is evidence those costs solve a real problem.

## Decision

Build the product as a modular monolith with three runnable entry points: a Next.js web application, a Fastify API, and a separate deployment worker. Domain and application packages are shared in-process. The API and worker coordinate through PostgreSQL and a typed BullMQ queue.

Module boundaries will be enforced through package imports, narrow interfaces, and tests. A module may be extracted into a service later only when scaling, ownership, isolation, or reliability evidence justifies the operational cost.

## Consequences

- Local setup, transactions, refactoring, and end-to-end testing remain manageable.
- Long-running work cannot block API request handling and can restart independently.
- API and worker releases must keep job contracts backward-compatible during rolling restarts.
- The single database is a shared dependency and requires disciplined module ownership.
- Independent scaling is limited to the web, API, and worker processes rather than every module.

## Alternatives considered

- **Microservices:** rejected initially because network and data-consistency complexity would dominate the product milestone.
- **One process for API and jobs:** rejected because builds are long-running, resource-heavy, and failure-prone.
- **Kubernetes operators:** outside the initial single-host scope.
