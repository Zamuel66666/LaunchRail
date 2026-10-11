import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function privateDirectory(path) {
  if (!isAbsolute(path) || path === parse(path).root || resolve(path) !== path)
    throw new Error(
      "Local infrastructure paths must be absolute, normalized, non-root directories",
    );
  let ancestor = path;
  while (true) {
    try {
      if ((await realpath(ancestor)) !== ancestor)
        throw new Error("Local infrastructure paths may not contain symlinked directories");
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      ancestor = dirname(ancestor);
    }
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink() || stats.uid !== process.getuid())
    throw new Error(`Directory must be owned by the current user and not a symlink: ${path}`);
  await chmod(path, 0o700);
}

export async function prepareEnvironment() {
  const envPath = resolve(projectRoot, ".env");
  let existing;
  try {
    existing = await lstat(envPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (existing === undefined) {
    const template = await readFile(resolve(projectRoot, ".env.example"), "utf8");
    const contents =
      template.replace(
        "WORKER_TRAEFIK_DYNAMIC_CONFIG_DIR=/absolute/path/to/LaunchRail/.launchrail/traefik",
        `WORKER_TRAEFIK_DYNAMIC_CONFIG_DIR=${JSON.stringify(resolve(projectRoot, ".launchrail/traefik"))}`,
      ) +
      `\nLAUNCHRAIL_SECRET_KEYRING=1:${randomBytes(32).toString("base64url")}\nLAUNCHRAIL_ACTIVE_SECRET_KEY_VERSION=1\nWORKER_INTERNAL_TOKEN=${randomBytes(32).toString("hex")}\n`;
    await writeFile(envPath, contents, { flag: "wx", mode: 0o600 });
  } else {
    if (!existing.isFile() || existing.isSymbolicLink() || existing.uid !== process.getuid())
      throw new Error("The existing .env must be a regular file owned by the current user");
    await chmod(envPath, 0o600);
  }
  process.loadEnvFile(envPath);
}

export async function prepareServices() {
  await privateDirectory(resolve(projectRoot, ".launchrail"));
  const directory = resolve(
    projectRoot,
    process.env.TRAEFIK_DYNAMIC_CONFIG_DIR ?? ".launchrail/traefik",
  );
  await privateDirectory(directory);
  const workerDirectory = process.env.WORKER_TRAEFIK_DYNAMIC_CONFIG_DIR;
  if (workerDirectory !== undefined && workerDirectory !== directory)
    throw new Error(
      "WORKER_TRAEFIK_DYNAMIC_CONFIG_DIR must match the Compose TRAEFIK_DYNAMIC_CONFIG_DIR; replace the example absolute path with the repository path",
    );
}
