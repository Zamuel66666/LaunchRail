# Demonstration image review

The 2026-10-12 release review uses Trivy 0.75.0, downloaded from the official release and verified against its published SHA-256. Local Docker images were scanned with `--scanners vuln --image-src docker` against the recorded vulnerability database. The [generated finding projection](security/image-review.json) retains immutable image digests, raw-report hashes, all severity counts, and every HIGH/CRITICAL package finding. Duplicate package/module findings are not collapsed. It is a generated projection, not the full scanner report and not a reachability analysis.

## Updated dependencies

| Image                               | Earlier critical / high | Reviewed critical / high |
| ----------------------------------- | ----------------------- | ------------------------ |
| Traefik 3.3.6 → 3.7.14              | 4 / 74                  | 0 / 4                    |
| BuildKit 0.32.2 → 0.34.0            | 0 / 200                 | 0 / 102                  |
| Grafana 12.4.0 → 13.2.3             | 6 / 143                 | 0 / 64                   |
| Node example 22.23.2 → 22.23.3      | 1 / 13                  | 0 / 11                   |
| PostgreSQL 18 Alpine                | —                       | 1 / 24                   |
| Redis 8 Alpine                      | —                       | 0 / 0                    |
| Prometheus 3.15.0                   | —                       | 0 / 8                    |
| Current Python 3.12 slim example    | —                       | 0 / 44                   |
| Pinned BusyBox 1.37.0 musl examples | —                       | 0 / 0                    |

All Compose service images and runnable example bases are now digest-pinned and protected by regression tests. Pins make inputs reproducible; they do not prove authenticity, vulnerability freedom, or runtime isolation. Upstream release provenance is the official Docker image repositories and upstream release records; no cryptographic publisher-signature verification is claimed.

## Remaining risk and release decision

Current upstream images still have findings. PostgreSQL's critical result identifies the Go standard library in its `gosu` privilege-drop helper, rather than the PostgreSQL server itself. The scanner does not prove that the affected TLS/session-resumption functionality is reachable; this is **not** grounds to erase the result or declare it fixed. HIGH findings also remain in current BuildKit, proxy, dashboard, example, and metrics images. Review the retained IDs and fixed versions before any wider deployment.

The supported demonstration keeps control-plane services and preview endpoints on loopback, trusts the host/operator and reviewed Dockerfiles, and does not support hostile tenants. BuildKit is privileged and must remain private. Application containers must not receive Docker sockets, host namespaces, or control-plane secrets. Optional Grafana is not a reason to expose an administration surface publicly. These constraints reduce exposure but do not certify every advisory as unreachable.

Independent review and release-owner acceptance of the documented residual image risk remain a publishing gate. Do not call the image set vulnerability-free or publish a production-security claim. Re-scan immediately before approval: the database and upstream fixes change over time.

## Reproduction

For each exact digest in the Compose files and example Dockerfiles:

```bash
trivy image --scanners vuln --image-src docker --format json \
  --output /absolute/private/image-scan.json IMAGE@sha256:DIGEST
```

Keep the full report, scanner/database versions, command output, immutable digest, and SHA-256 with release evidence. A scanner execution error is not a zero-finding result. The dependency-only `pnpm audit --prod` check is separate from these image scans.
