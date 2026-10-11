import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, parse, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const deploymentIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hostnamePattern =
  /^d-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.localhost$/;

export interface PreviewRoute {
  readonly deploymentId: string;
  readonly hostname: string;
}

export interface RouteTarget {
  readonly hostPort: number;
}

export interface RouteManager {
  apply(route: PreviewRoute, target: RouteTarget): Promise<void>;
  remove(route: PreviewRoute): Promise<void>;
  reconcile?(routes: readonly DesiredPreviewRoute[]): Promise<number | void>;
  cleanupTemporaryFiles?(options: { readonly olderThan: Date }): Promise<number>;
}

export interface DesiredPreviewRoute extends PreviewRoute {
  readonly target: RouteTarget;
}

export interface TraefikFileRouteManagerOptions {
  readonly configurationDirectory: string;
  readonly upstreamHost?: string;
}

function validateRoute(route: PreviewRoute): void {
  const match = hostnamePattern.exec(route.hostname);
  if (!deploymentIdPattern.test(route.deploymentId) || match?.[1] !== route.deploymentId) {
    throw new RangeError(
      "Preview routes must use the exact deployment UUID in a localhost hostname",
    );
  }
}

function validateTarget(target: RouteTarget): void {
  if (!Number.isSafeInteger(target.hostPort) || target.hostPort < 1 || target.hostPort > 65_535) {
    throw new RangeError("Preview route targets must use a valid loopback host port");
  }
}

function fileName(route: PreviewRoute): string {
  return `launchrail-${route.deploymentId}.yaml`;
}

function render(route: PreviewRoute, target: RouteTarget, upstreamHost: string): string {
  const identifier = `launchrail-${route.deploymentId.replaceAll("-", "")}`;
  return [
    "http:",
    "  routers:",
    `    ${identifier}:`,
    `      rule: \"Host(\`${route.hostname}\`)\"`,
    `      service: ${identifier}`,
    "  services:",
    `    ${identifier}:`,
    "      loadBalancer:",
    "        servers:",
    `          - url: \"http://${upstreamHost}:${target.hostPort}\"`,
    "",
  ].join("\n");
}

export class TraefikFileRouteManager implements RouteManager {
  private readonly configurationDirectory: string;
  private readonly upstreamHost: string;

  public constructor(options: TraefikFileRouteManagerOptions) {
    if (
      !isAbsolute(options.configurationDirectory) ||
      resolve(options.configurationDirectory) !== options.configurationDirectory ||
      options.configurationDirectory === parse(options.configurationDirectory).root
    ) {
      throw new RangeError("Traefik configuration directory must be an absolute non-root path");
    }
    this.configurationDirectory = options.configurationDirectory;
    this.upstreamHost = options.upstreamHost ?? "127.0.0.1";
    if (!/^[a-z0-9.-]{1,253}$/u.test(this.upstreamHost)) {
      throw new RangeError("Traefik upstream host must be a safe DNS name");
    }
  }

  private async prepareDirectory(): Promise<void> {
    await mkdir(this.configurationDirectory, { mode: 0o700, recursive: true });
    const stats = await lstat(this.configurationDirectory);
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      (stats.mode & 0o077) !== 0 ||
      (await realpath(this.configurationDirectory)) !== this.configurationDirectory
    ) {
      throw new Error("Traefik configuration directory must be private and non-symlinked");
    }
  }

  public async apply(route: PreviewRoute, target: RouteTarget): Promise<void> {
    validateRoute(route);
    validateTarget(target);
    await this.prepareDirectory();
    const destination = join(this.configurationDirectory, fileName(route));
    const temporary = join(this.configurationDirectory, `.${fileName(route)}.${randomUUID()}.tmp`);
    await writeFile(temporary, render(route, target, this.upstreamHost), {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, destination);
  }

  public async remove(route: PreviewRoute): Promise<void> {
    validateRoute(route);
    await this.prepareDirectory();
    const destination = join(this.configurationDirectory, fileName(route));
    if (basename(destination) !== fileName(route)) {
      throw new Error("Refusing to remove an unsafe Traefik configuration path");
    }
    await rm(destination, { force: true });
  }

  public async cleanupTemporaryFiles(options: { readonly olderThan: Date }): Promise<number> {
    if (!Number.isFinite(options.olderThan.getTime())) {
      throw new RangeError("Temporary route cleanup cutoff must be a valid date");
    }
    await this.prepareDirectory();
    let removed = 0;
    const temporaryPattern = /^\.launchrail-[0-9a-f-]{36}\.yaml\.[0-9a-f-]{36}\.tmp$/u;
    for (const entry of await readdir(this.configurationDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !temporaryPattern.test(entry.name)) continue;
      const path = join(this.configurationDirectory, entry.name);
      const stats = await lstat(path);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.mtimeMs >= options.olderThan.getTime())
        continue;
      await rm(path, { force: true });
      removed += 1;
    }
    return removed;
  }

  /** Restore the file-provider directory to the persisted desired route set. */
  public async reconcile(routes: readonly DesiredPreviewRoute[]): Promise<number> {
    await this.prepareDirectory();
    const desired = new Set<string>();
    let mismatches = 0;
    for (const route of routes) {
      validateRoute(route);
      validateTarget(route.target);
      const name = fileName(route);
      desired.add(name);
      const destination = join(this.configurationDirectory, name);
      let current: string | undefined;
      try {
        const stats = await lstat(destination);
        if (stats.isFile() && !stats.isSymbolicLink())
          current = await readFile(destination, "utf8");
      } catch (error) {
        if (
          typeof error !== "object" ||
          error === null ||
          !("code" in error) ||
          error.code !== "ENOENT"
        )
          throw error;
      }
      if (current !== render(route, route.target, this.upstreamHost)) mismatches += 1;
      await this.apply(route, route.target);
    }
    for (const entry of await readdir(this.configurationDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith("launchrail-") || !entry.name.endsWith(".yaml"))
        continue;
      if (!desired.has(entry.name)) {
        mismatches += 1;
        await rm(join(this.configurationDirectory, entry.name), { force: true });
      }
    }
    return mismatches;
  }
}
