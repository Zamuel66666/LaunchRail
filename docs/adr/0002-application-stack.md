# ADR-0002: Fastify, Next.js, and shared TypeScript contracts

- **Status:** Accepted
- **Date:** 2026-07-19

## Context

The platform needs a professional browser interface, a small explicit HTTP layer, runtime validation, generated API documentation, and consistent types across API, worker, and web packages.

## Decision

Use TypeScript throughout a pnpm workspace. Use Next.js with React for the web application and Fastify for the API. Define transport, event, and job payloads with runtime schemas in a shared contracts package; infer TypeScript types from those schemas rather than maintaining parallel definitions.

Fastify plugins will be composed at the application edge. Domain and application packages will not import Fastify or Next.js. OpenAPI output will be derived from the same API schemas used for request and response validation.

## Consequences

- Contributors use one language and one package manager across the main system.
- Runtime validation closes the gap left by compile-time types at network and queue boundaries.
- Fastify keeps the API surface explicit and provides a straightforward plugin/testing model.
- Next.js adds framework complexity, so server features will be used only where they improve the product.
- Shared contracts require compatibility discipline between independently restarted API and worker processes.

## Alternatives considered

- **NestJS:** capable, but its dependency-injection and decorator conventions add structure the initial team does not need.
- **Separate frontend and backend languages:** would increase tooling and contract duplication without a current benefit.
- **Type-only shared interfaces:** rejected because external input requires runtime validation.
