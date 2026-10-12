# Benchmark methodology

## Current status

Initial exact-revision API liveness and warm-cache deployment baselines are retained below. They establish measured local behavior, not production capacity or a stable service-level objective. Repeated stage-isolated queue, build/recovery, webhook, and resource scenarios remain planned.

This document prevents unsupported claims by defining how results must be collected and reported.

## Published local baseline — `d013bb4`

All reports record clean published revision `d013bb47f0f684679963a710b89b2fa3df143061`, whose [three CI jobs passed](https://github.com/Zamuel66666/LaunchRail/actions/runs/38251914782). The host was a shared Linux development laptop, not a dedicated production host: eight logical i5-10300H CPUs, approximately 16 GiB RAM, and NVMe storage. Three unrelated user containers remained running. No local test suites or other deployment workloads ran during the measured batch; normal metrics, JSON logging, OTLP, and local dashboard services remained enabled. The [host/profile record](benchmarks/host-d013bb4.json) retains exact service versions, resource settings, observed load/memory, and limitations.

One [unmeasured exact-revision deployment](benchmarks/deployment-warmup-d013bb4.json) warmed the existing BuildKit cache, followed by [five sequential measured deployments](benchmarks/deployment-d013bb4.json) of the repository's healthy example, with two configured worker slots, a 15-second reconciliation interval, zero startup grace, 500-millicore/512-MiB/128-process read-only runtimes, and a pinned two-CPU/two-GiB BuildKit daemon. All five activated, with no failed or timed-out runs. Observed client elapsed time ranged from 36.393 to 45.548 seconds; the median was 44.467 seconds. Event-derived stage medians were 20 ms initial queue wait, 16.261 seconds source interval, 13.556 seconds build interval, 14.677 seconds runtime interval, and 22 ms health/promotion. These intervals include durable stage dispatch waits, not just adapter execution. With five samples, the nearest-rank p95 is the maximum, not a stable population estimate.

Three separate API runs each used 100 warm-up and 1,000 measured requests with ten concurrent clients. Every warm-up and measured response passed the health JSON checks:

| Raw run                                   | Median latency | p95 latency | Requests/second |
| ----------------------------------------- | -------------- | ----------- | --------------- |
| [Run 1](benchmarks/api-d013bb4-run1.json) | 6.870 ms       | 13.737 ms   | 1,342.71        |
| [Run 2](benchmarks/api-d013bb4-run2.json) | 7.934 ms       | 15.265 ms   | 1,195.24        |
| [Run 3](benchmarks/api-d013bb4-run3.json) | 6.219 ms       | 12.326 ms   | 1,431.49        |

This is loopback `/health` performance only: it does not benchmark database readiness, authorization, deployment capacity, or application traffic. Existing caches were not cleared; no cold-build claim is made. The retained JSON files are byte-for-byte stdout copies and excluded from automatic formatting. The measured deployment file's SHA-256 is `4a5f406174c8bf5edccdb5bf9681b5251c59ee55159ab6a599ce9c803a68cd6e`.

The baseline highlights periodic stage dispatch as a refinement target. Follow-up measurements must retain the same workload/profile and document any source, cache, host-load, or configuration differences; do not combine this baseline with a changed pipeline or fabricate aggregate results.

## Immediate stage dispatch — `c43d5d8`

A separate [warm-up](benchmarks/deployment-warmup-c43d5d8.json) followed by [five measured deployments](benchmarks/deployment-c43d5d8.json) exercised clean published revision `c43d5d832f90eb1c60fa06721a8be0efd3562297`. All five activated without failures or timeouts. Client elapsed times were 4.241, 3.277, 2.696, 2.674, and 2.662 seconds: median 2.696 seconds. Event-derived medians were 25 ms queue wait, 1.435 seconds source preparation, 814 ms build, 426 ms runtime start, and 35 ms health/promotion. Immediate post-commit wake-ups remove periodic dispatch waits without changing the 15-second recovery reconciler.

The source application remains exact revision `d013bb4`, and worker concurrency, zero startup grace, runtime limits, and BuildKit limits match the earlier baseline. The [profile](benchmarks/host-c43d5d8.json) records these settings and host load sampled **after** measurement. Existing cache and host activity can differ, so the lower observed latency is a local refinement result, not a controlled production speed-up or stable p95. Each raw report is retained unchanged; no unit/build workloads ran during this batch.

## Measurement principles

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

| Scenario               | Primary measurements                                 | Correctness checks                                       |
| ---------------------- | ---------------------------------------------------- | -------------------------------------------------------- |
| API latency            | requests/second, median/p95 latency, error ratio     | response schema and authorization remain correct         |
| Deployment lifecycle   | exact-SHA request-to-healthy-release duration        | health-gated state and route safety remain authoritative |
| Concurrent log streams | connection success, delivery lag, throughput, memory | ordering, reconnect, bounds, no cross-tenant output      |
| Queue throughput       | enqueue-to-start, completion rate, retry overhead    | no lost authoritative work or duplicate side effects     |
| Deployment transitions | command-to-persisted-event latency, conflict rate    | valid states/events and one active release               |
| Rollback               | request-to-observed-route duration                   | target healthy, route correct, previous release safe     |
| Build cache            | cold/warm duration, bytes/resources used             | same source/image outcome and declared cache state       |
| Worker recovery        | interruption-to-convergence duration                 | no duplicate resources, explicit final state             |
| Duplicate webhook      | deliveries/second, deduplication latency             | exactly one deployment intent per delivery key           |
| Resource use           | CPU, memory, disk, network over scenario             | no limit violation or leaked orphan resource             |

## Run protocol

### API liveness baseline

Start the API locally, then run:

```bash
pnpm benchmark:api --requests=1000 --concurrency=10 --warmup=100
```

The default target is `http://127.0.0.1:4000/health`. `LAUNCHRAIL_BENCHMARK_URL` may select another IPv4/IPv6 loopback `/health` URL only. The command emits one JSON report with request count, concurrency, throughput, median/p95 latency, response codes, Node/platform metadata, current Git commit and working-tree cleanliness when available, operating system, CPU model/count, memory, and run time. `LAUNCHRAIL_BENCHMARK_COMMIT` may explicitly provide the full lowercase SHA when the script runs outside the checkout. It deliberately does not save a result file; retain the stdout artifact alongside kernel, storage, API configuration, service versions, and host load if publishing a result. The health endpoint measures process liveness only.

Latency includes consuming the complete response body, not merely receiving headers. Correctness requires the API health JSON fields (`service`, `status`, `version`, and `timestamp`), not just HTTP 200. Invalid bodies and transport failures are counted separately from non-2xx responses; transport failures use status 0. Warm-up correctness failures are also recorded. Any invalid or failed warm-up or measured response makes the command exit unsuccessfully while preserving the report.

### End-to-end deployment baseline

This scenario creates a real deployment and may activate it, replacing the project's current
release. Use only a dedicated local demo project with a selected exact commit. It does not clean up
the deployment or runtime afterwards. Do not point it at production or a shared project.

Set the API origin, organization/project UUIDs, full lowercase commit SHA, and a dedicated
`launchrail_session` cookie in the environment. Then require the explicit mutation acknowledgement
and run once:

```bash
export LAUNCHRAIL_BENCHMARK_API_URL='http://127.0.0.1:4000'
export WEB_ORIGIN='http://localhost:3000' # Must match the API's configured mutation origin.
export LAUNCHRAIL_BENCHMARK_ORGANIZATION_ID='00000000-0000-4000-8000-000000000001'
export LAUNCHRAIL_BENCHMARK_PROJECT_ID='00000000-0000-4000-8000-000000000002'
export LAUNCHRAIL_BENCHMARK_SOURCE_REVISION='<full-lowercase-commit-sha>'
export LAUNCHRAIL_BENCHMARK_SESSION_COOKIE='launchrail_session=<dedicated-session-value>'
export LAUNCHRAIL_BENCHMARK_ALLOW_RELEASE_MUTATION='I_UNDERSTAND_THIS_CREATES_A_DEPLOYMENT'
export LAUNCHRAIL_BENCHMARK_RUNS='1' # Optional: 1–10 sequential deployments; each may replace the active release.
pnpm benchmark:deployment
```

The script restricts the destination to IPv4/IPv6 loopback, creates exactly one deployment, polls the
organization/project-scoped deployment history until activation or terminal failure, then reads the
persisted deployment events for queue-wait, source, build, runtime-start, and health/promotion
durations. It emits one JSON report with the per-run outcomes and stage samples plus median/p95
summaries, and does not output the cookie. `LAUNCHRAIL_BENCHMARK_RUNS` defaults to one and is capped
at ten sequential deployment attempts. Stage intervals use database event timestamps, so missing
events are reported as `null` and never inferred from the client poll interval. A timed-out run
remains in progress and must be inspected or stopped through the UI before starting another. Record
cache state, storage type, service versions, resource limits, and host load separately; the report
includes the current Git commit and working-tree cleanliness when available plus operating system,
CPU model/count, and memory.
these lifecycle stages are event intervals, not isolated resource timings.

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
