import { execFileSync } from "node:child_process";
import { join } from "node:path";

import {
  prepareEnvironment,
  prepareServices,
  privateDirectory,
  projectRoot,
} from "./local-environment.mjs";

if (process.platform !== "linux")
  throw new Error("The supported local demonstration requires Linux");
await prepareEnvironment();
await prepareServices();
const buildRoot = process.env.WORKER_BUILD_ROOT ?? join(projectRoot, ".launchrail/builds");
const dockerConfig = join(buildRoot, "docker-config");
await privateDirectory(buildRoot);
await privateDirectory(dockerConfig);
const builderName = process.env.WORKER_BUILDX_BUILDER_NAME ?? "launchrail-builder";
if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(builderName))
  throw new Error("Invalid local builder name");
const run = (args, env = process.env) =>
  execFileSync("docker", args, { cwd: projectRoot, env, stdio: "inherit" });
run(["buildx", "version"]);
run(["compose", "--profile", "build", "up", "-d", "--wait"]);
const builderEnvironment = { ...process.env, DOCKER_CONFIG: dockerConfig };
try {
  execFileSync("docker", ["buildx", "inspect", "--builder", builderName], {
    env: builderEnvironment,
    stdio: "ignore",
  });
} catch {
  run(
    [
      "buildx",
      "create",
      "--name",
      builderName,
      "--driver",
      "remote",
      "docker-container://launchrail-buildkit",
    ],
    builderEnvironment,
  );
}
run(["buildx", "inspect", "--builder", builderName, "--bootstrap"], builderEnvironment);
process.stdout.write(
  "Local services and the worker's isolated BuildKit builder are ready. Configure owner bootstrap values in .env, then run pnpm db:migrate and pnpm auth:bootstrap.\n",
);
