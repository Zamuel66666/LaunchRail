# Product scope

## Plain-language overview

Deploying a small application should not require someone to manually build images, start containers, configure routes, watch logs in several terminals, and remember which previous version was healthy. LaunchRail brings those steps into one self-hosted workflow that runs on a developer's own machine.

LaunchRail is intended to be understandable to someone evaluating the product and credible to someone evaluating its engineering. It will show the full path from a GitHub commit to a running, health-checked release while making failures visible and recoverable.

## Target users

### Primary users

- Developers who want to learn or demonstrate how a deployment platform works end to end.
- Small teams that need a repeatable local deployment environment without paid services.
- Maintainers evaluating deployment orchestration, reliability, and observability patterns.

### Secondary audience

- Recruiters and engineering managers assessing the product's value, current progress, and technical depth.
- Contributors looking for bounded milestones with explicit acceptance criteria.

## Problem statement

Existing platform-as-a-service products make deployment convenient but hide much of the machinery. Building a comparable learning project often produces a happy-path demo that cannot explain failures or recover safely. LaunchRail will make the orchestration visible and treat failure handling as part of the product rather than an afterthought.

## Core user workflow

1. Sign in and create a project from a GitHub repository.
2. Validate the repository, selected revision, and Dockerfile.
3. Queue a deployment without blocking the web request.
4. Clone the exact revision and build it with Docker BuildKit.
5. Stream build progress to the browser.
6. Start the resulting image with restricted resources.
7. Register an isolated preview route and run health checks.
8. Promote the release only when it becomes healthy.
9. Preserve the previous healthy release when the candidate fails.
10. Inspect history and logs, then retry, cancel, stop, or roll back.
11. Optionally start the same flow from a verified GitHub push webhook.

## Product principles

- **Safe promotion:** a failed candidate never silently replaces a healthy release.
- **Explainable operation:** users can see state, logs, failure categories, and relevant timings.
- **Recoverable work:** retries, restarts, and duplicate delivery are expected conditions.
- **Secure boundaries:** repository input, secrets, container execution, and tenant access receive explicit controls.
- **Honest status:** documentation distinguishes implemented behavior from planned behavior.
- **Local ownership:** the complete demonstration runs without paid services.

## Initial success criteria

The first stable demonstration is successful when a new contributor can follow tested local instructions to deploy the included healthy example, observe its logs and health result, open its preview URL, deploy an unhealthy revision without losing the healthy route, and roll back from the interface. The same flow must produce structured logs, metrics, and traceable deployment events.

## Non-goals

The initial product will not include:

- Kubernetes or a custom scheduler.
- Multi-host or multi-region deployment.
- Billing, usage metering, or public hosted service operations.
- Enterprise SSO or complex identity federation.
- Multiple cloud-provider integrations.
- A custom container runtime.
- Mobile applications.
- AI deployment recommendations.
- A general-purpose plugin marketplace.

These boundaries keep the project focused on a reliable single-host deployment lifecycle. They can be reconsidered only after the documented local workflow is stable and measured.

## Demonstration strategy

The repository will include healthy and intentionally failing example applications. Each user-facing milestone will add evidence such as a safe screenshot, repeatable command, integration test, or benchmark methodology. Results will include the environment and limitations; unmeasured performance claims will not be published.

## Delivery boundary

LaunchRail is an educational, recruitment-grade engineering project—not a production hosting service. Early versions will trust a single operator and local Docker host while still modeling organization isolation, audit events, and restricted workloads so the design can be evaluated realistically.
