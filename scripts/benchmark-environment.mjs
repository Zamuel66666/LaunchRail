import { spawnSync } from "node:child_process";
import os from "node:os";

const fullCommitPattern = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

export function benchmarkEnvironment() {
  const requestedCommit = process.env.LAUNCHRAIL_BENCHMARK_COMMIT;
  if (requestedCommit !== undefined && !fullCommitPattern.test(requestedCommit))
    throw new RangeError("LAUNCHRAIL_BENCHMARK_COMMIT must be a full lowercase Git commit SHA");
  const configuredCommit = requestedCommit ?? process.env.GITHUB_SHA;
  let commit = fullCommitPattern.test(configuredCommit ?? "") ? configuredCommit : null;
  let workingTreeClean = null;
  if (commit === null) {
    const revision = spawnSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_000,
    });
    const candidate = revision.status === 0 ? revision.stdout.trim() : "";
    if (fullCommitPattern.test(candidate)) commit = candidate;
  }
  const status = spawnSync("git", ["status", "--porcelain"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 1_000,
  });
  if (status.status === 0) workingTreeClean = status.stdout.trim().length === 0;

  return {
    launchRailCommit: commit,
    workingTreeClean,
    operatingSystem: `${os.type()} ${os.release()}`,
    architecture: os.arch(),
    processorModel: os.cpus()[0]?.model ?? null,
    processorCount: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
  };
}
