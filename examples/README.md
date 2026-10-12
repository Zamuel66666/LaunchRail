# Example applications

Use `https://github.com/Zamuel66666/LaunchRail` as the project repository and select a full published commit SHA. Set the Dockerfile path from this table, health port `3000`, and health path `/` unless indicated. Every runtime uses a non-root user and supports a read-only root filesystem; no package installation or outbound build-step network is needed.

| Example                | Dockerfile                           | Expected result                                                                                  |
| ---------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Small healthy web page | `examples/apps/healthy/Dockerfile`   | HTTP 200 and a working preview                                                                   |
| Node.js service        | `examples/apps/node/Dockerfile`      | HTTP 200 JSON and stdout request logs                                                            |
| Python service         | `examples/apps/python/Dockerfile`    | HTTP 200 JSON and request logs                                                                   |
| Failed health check    | `examples/apps/unhealthy/Dockerfile` | Set health path `/missing-health`; HTTP 404 fails the candidate and preserves the active release |
| Failed build           | `examples/build/failure/Dockerfile`  | Build fails before a runtime starts                                                              |
| Slow build             | `examples/build/timeout/Dockerfile`  | Used for cancellation and timeout acceptance                                                     |

The remaining `examples/build` fixtures exercise image metadata, cache reuse, redaction, and output limits. They are adapter fixtures and do not all contain runnable HTTP servers. Base images are pinned to verified manifest digests so the selected source commit determines the example inputs.

Startup speed depends on host load and the configured CPU quota; the examples do not promise a five-second startup SLA. Real runtime acceptance retains the CPU/memory/security restrictions and requires a valid HTTP response within a bounded 30-second readiness window, reporting the measured startup duration. For slower Node/Python hosts, configure `WORKER_HEALTH_GRACE_MS=30000` before starting the worker; the total `WORKER_JOB_TIMEOUT_MS` must cover Docker startup, grace, and the health window. Docker command deadlines remain independently bounded by `WORKER_RUNTIME_TIMEOUT_MS`.
