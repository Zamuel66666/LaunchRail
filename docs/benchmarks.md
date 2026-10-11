# Benchmark methodology

## Current status

No benchmarks have been run and LaunchRail publishes no performance results. A versioned API liveness benchmark is now available; the broader deployment, queue, build, recovery, webhook, and resource scenarios remain planned. Do not treat the script or its output as production-capacity evidence.

This document prevents unsupported claims by defining how results must be collected and reported.

## Principles

- Benchmark an observable user/operator outcome, not an internal function chosen because it is easy to time.
- Use a versioned scenario and fixed dataset or example application.
- Separate warm-up from recorded runs and state cache conditions explicitly.
- Record failures and saturation; do not average them away.
- Compare revisions only under the same controlled environment.
- Publish median and p95 where the sample size supports them, plus run count and range/outliers.
- Store raw machine-readable results when they contain no secrets or personal data.
- Never hand-edit results or invent measurements.

## Required environment record

Every report includes:

- LaunchRail commit and configuration profile.
- Date and benchmark script revision.
- Operating system, kernel, architecture, CPU, memory, and storage type.
- Docker, BuildKit, Node.js, pnpm, PostgreSQL, Redis, and proxy versions.
- Process/container CPU and memory limits.
- Concurrent clients/workers and queue/build concurrency.
- Dataset size, application revision, image/cache state, and network assumptions.
- Warm-up count, measured run count, duration, and known background load.

## Planned scenarios

| Scenario               | Primary measurements                                 | Correctness checks                                   |
| ---------------------- | ---------------------------------------------------- | ---------------------------------------------------- |
| API latency            | requests/second, median/p95 latency, error ratio     | response schema and authorization remain correct     |
| Concurrent log streams | connection success, delivery lag, throughput, memory | ordering, reconnect, bounds, no cross-tenant output  |
| Queue throughput       | enqueue-to-start, completion rate, retry overhead    | no lost authoritative work or duplicate side effects |
| Deployment transitions | command-to-persisted-event latency, conflict rate    | valid states/events and one active release           |
| Rollback               | request-to-observed-route duration                   | target healthy, route correct, previous release safe |
| Build cache            | cold/warm duration, bytes/resources used             | same source/image outcome and declared cache state   |
| Worker recovery        | interruption-to-convergence duration                 | no duplicate resources, explicit final state         |
| Duplicate webhook      | deliveries/second, deduplication latency             | exactly one deployment intent per delivery key       |
| Resource use           | CPU, memory, disk, network over scenario             | no limit violation or leaked orphan resource         |

## Run protocol

### API liveness baseline

Start the API locally, then run:

```bash
pnpm benchmark:api --requests=1000 --concurrency=10 --warmup=100
```

The default target is `http://127.0.0.1:4000/health`. `LAUNCHRAIL_BENCHMARK_URL` may select another loopback `/health` URL only. The command emits one JSON report with request count, concurrency, throughput, median/p95 latency, response codes, Node/platform metadata, and run time. It deliberately does not save a result file; retain the stdout artifact alongside the exact commit, OS/kernel, CPU/memory/storage, API configuration, and host load if publishing a result. The health endpoint measures process liveness only.

1. Start from the documented clean environment and verify health.
2. Record versions/configuration and confirm no unrelated workloads.
3. Seed the specified deterministic dataset.
4. Run correctness assertions before measurement.
5. Warm up for the scenario-defined count/time.
6. Run the recorded repetitions without changing configuration.
7. Capture raw results and system telemetry.
8. Run correctness assertions again and inventory orphan resources.
9. Summarize with a versioned script; inspect outliers rather than deleting them silently.
10. Commit methodology, raw-safe data, summary, and limitations together.

## Report template

```markdown
# <scenario> benchmark — <date>

## Question

What user or operator outcome is measured?

## Environment

Exact hardware, software, limits, revision, and configuration.

## Method

Dataset, warm-up, run count, concurrency, duration, and cache/network state.

## Results

Raw artifact link plus median, p95, errors, and resource observations.

## Correctness evidence

Assertions run before/after and orphan inventory.

## Limitations

Confounders, non-production assumptions, and what the result does not prove.
```

## CI use

Normal CI will verify benchmark scripts on tiny correctness workloads, not enforce noisy laptop performance thresholds. Performance regression gates require a controlled runner and a statistically justified baseline. Until then, changes are compared manually using the same documented host.
