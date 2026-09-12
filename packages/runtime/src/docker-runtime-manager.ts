import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, parse, resolve } from "node:path";

import {
  RuntimeStartError,
  type DeploymentRuntimeManager,
  type StartDeploymentRuntimeCommand,
  type StartedDeploymentRuntime,
  type StopDeploymentRuntimeCommand,
} from "@launchrail/application";
import {
  SpawnBuildxCommandExecutor,
  type BuildxCommandExecutor,
  type BuildxCommandResult,
} from "@launchrail/build";

export interface RuntimeLimits {
  readonly commandOutputBytes: number;
  readonly commandLineBytes: number;
  readonly stopGraceSeconds: number;
  readonly tmpfsMegabytes: number;
}

export const runtimeDefaultLimits: RuntimeLimits = {
  commandLineBytes: 65_536,
  commandOutputBytes: 262_144,
  stopGraceSeconds: 10,
  tmpfsMegabytes: 64,
};

export interface DockerDeploymentRuntimeManagerOptions {
  readonly dockerBinary?: string;
  readonly dockerConfigDirectory: string;
  readonly dockerHost?: string;
  readonly executor?: BuildxCommandExecutor;
  readonly limits?: Partial<RuntimeLimits>;
  readonly timeoutMs: number;
}

interface DockerInspection {
  readonly Config?: { readonly Labels?: Readonly<Record<string, string>>; readonly User?: string };
  readonly HostConfig?: {
    readonly CapDrop?: readonly string[];
    readonly Memory?: number;
    readonly MemorySwap?: number;
    readonly NetworkMode?: string;
    readonly PidsLimit?: number;
    readonly PortBindings?: Readonly<
      Record<string, readonly { readonly HostIp?: string; readonly HostPort?: string }[]>
    >;
    readonly ReadonlyRootfs?: boolean;
    readonly SecurityOpt?: readonly string[];
  };
  readonly Id?: string;
  readonly State?: { readonly Running?: boolean };
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const shaPattern = /^sha256:[0-9a-f]{64}$/;
const idPattern = /^[0-9a-f]{64}$/;

function fail(
  code: ConstructorParameters<typeof RuntimeStartError>[0]["code"],
  message: string,
  retryable: boolean,
): RuntimeStartError {
  return new RuntimeStartError({ code, message, retryable });
}

function assertSafeRuntimeCommand(command: StartDeploymentRuntimeCommand): void {
  const { identity, image, healthCheckPort, runtimeConfig } = command;
  if (
    ![
      identity.deploymentId,
      identity.organizationId,
      identity.projectId,
      identity.workItemId,
    ].every((value) => uuidPattern.test(value))
  ) {
    throw new RangeError("Runtime identity must contain lowercase UUIDs");
  }
  if (
    !shaPattern.test(image.imageId) ||
    !shaPattern.test(image.manifestDigest) ||
    image.imageReference.length === 0 ||
    image.imageReference.length > 255
  ) {
    throw new RangeError("Runtime image identity is invalid");
  }
  if (!Number.isSafeInteger(healthCheckPort) || healthCheckPort < 1 || healthCheckPort > 65_535) {
    throw new RangeError("Runtime health port must be a valid TCP port");
  }
  if (
    !Number.isSafeInteger(runtimeConfig.cpuMillicores) ||
    !Number.isSafeInteger(runtimeConfig.memoryMegabytes) ||
    !Number.isSafeInteger(runtimeConfig.processLimit)
  ) {
    throw new RangeError("Runtime limits must be integers");
  }
}

function nameFor(deploymentId: string): string {
  return `launchrail-runtime-${deploymentId}`;
}

function labels(command: StartDeploymentRuntimeCommand): Readonly<Record<string, string>> {
  return {
    "dev.launchrail.deployment-id": command.identity.deploymentId,
    "dev.launchrail.managed": "true",
    "dev.launchrail.organization-id": command.identity.organizationId,
    "dev.launchrail.project-id": command.identity.projectId,
    "dev.launchrail.work-item-id": command.identity.workItemId,
    "dev.launchrail.image-id": command.image.imageId,
    "dev.launchrail.manifest-digest": command.image.manifestDigest,
  };
}

export class DockerDeploymentRuntimeManager implements DeploymentRuntimeManager {
  private readonly dockerBinary: string;
  private readonly dockerConfigDirectory: string;
  private readonly dockerHost: string;
  private readonly executor: BuildxCommandExecutor;
  private readonly limits: RuntimeLimits;
  private readonly timeoutMs: number;

  public constructor(options: DockerDeploymentRuntimeManagerOptions) {
    if (
      !isAbsolute(options.dockerConfigDirectory) ||
      resolve(options.dockerConfigDirectory) !== options.dockerConfigDirectory ||
      options.dockerConfigDirectory === parse(options.dockerConfigDirectory).root
    )
      throw new RangeError("Docker configuration directory must be an absolute non-root path");
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)
      throw new RangeError("Runtime timeout must be positive");
    this.dockerBinary = options.dockerBinary ?? "/usr/bin/docker";
    this.dockerConfigDirectory = options.dockerConfigDirectory;
    this.dockerHost = options.dockerHost ?? "unix:///var/run/docker.sock";
    this.executor = options.executor ?? new SpawnBuildxCommandExecutor();
    this.limits = { ...runtimeDefaultLimits, ...options.limits };
    this.timeoutMs = options.timeoutMs;
  }

  private async prepareDockerConfiguration(): Promise<void> {
    await mkdir(this.dockerConfigDirectory, { mode: 0o700, recursive: true });
    const stats = await lstat(this.dockerConfigDirectory);
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      (stats.mode & 0o077) !== 0 ||
      (await realpath(this.dockerConfigDirectory)) !== this.dockerConfigDirectory
    )
      throw fail("runtime_unavailable", "The Docker client configuration is not private", true);
    const configPath = join(this.dockerConfigDirectory, "config.json");
    try {
      await readFile(configPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        await writeFile(configPath, "{}\n", { mode: 0o600 });
      else throw error;
    }
  }

  private environment(): Readonly<Record<string, string>> {
    return {
      DOCKER_CONFIG: this.dockerConfigDirectory,
      DOCKER_HOST: this.dockerHost,
      HOME: this.dockerConfigDirectory,
      LANG: "C",
      LC_ALL: "C",
      NO_COLOR: "1",
      PATH: "/usr/bin:/bin",
      TZ: "UTC",
    };
  }

  private async execute(
    arguments_: readonly string[],
    signal: AbortSignal,
  ): Promise<BuildxCommandResult> {
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        controller.abort(
          fail("runtime_timeout", "The runtime operation exceeded its time limit", false),
        ),
      this.timeoutMs,
    );
    try {
      return await this.executor.execute({
        arguments: arguments_,
        binary: this.dockerBinary,
        cwd: this.dockerConfigDirectory,
        environment: this.environment(),
        maxLineBytes: this.limits.commandLineBytes,
        maxOutputBytes: this.limits.commandOutputBytes,
        signal: AbortSignal.any([signal, controller.signal]),
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async inspect(name: string, signal: AbortSignal): Promise<DockerInspection | undefined> {
    try {
      const parsed = JSON.parse((await this.execute(["inspect", name], signal)).stdout) as unknown;
      return Array.isArray(parsed) && parsed.length === 1
        ? (parsed[0] as DockerInspection)
        : undefined;
    } catch {
      return undefined;
    }
  }

  private validateInspection(
    inspected: DockerInspection,
    command: StartDeploymentRuntimeCommand,
  ): StartedDeploymentRuntime {
    const expectedLabels = labels(command);
    const actual = inspected.Config?.Labels ?? {};
    if (
      !Object.entries(expectedLabels).every(([key, value]) => actual[key] === value) ||
      inspected.Config?.User !== "65532:65532" ||
      inspected.HostConfig?.ReadonlyRootfs !== command.runtimeConfig.readOnlyRootFilesystem ||
      inspected.HostConfig?.NetworkMode !== "bridge" ||
      !inspected.HostConfig?.CapDrop?.includes("ALL") ||
      !inspected.HostConfig?.SecurityOpt?.includes("no-new-privileges:true") ||
      inspected.HostConfig.PidsLimit !== command.runtimeConfig.processLimit ||
      inspected.HostConfig.Memory !== command.runtimeConfig.memoryMegabytes * 1024 * 1024 ||
      inspected.HostConfig.MemorySwap !== command.runtimeConfig.memoryMegabytes * 1024 * 1024
    )
      throw fail(
        "runtime_metadata_invalid",
        "The existing runtime does not match LaunchRail policy",
        false,
      );
    const bindings = inspected.HostConfig.PortBindings?.[`${command.healthCheckPort}/tcp`];
    const binding = bindings?.[0];
    const hostPort = Number(binding?.HostPort);
    if (
      !idPattern.test(inspected.Id ?? "") ||
      binding?.HostIp !== "127.0.0.1" ||
      !Number.isSafeInteger(hostPort) ||
      hostPort < 1 ||
      hostPort > 65_535
    )
      throw fail(
        "runtime_metadata_invalid",
        "The existing runtime has an invalid published port",
        false,
      );
    return {
      containerId: inspected.Id!,
      hostPort,
      resourceMetadata: {
        capDrop: ["ALL"],
        memoryMegabytes: command.runtimeConfig.memoryMegabytes,
        networkMode: "bridge",
        pidsLimit: command.runtimeConfig.processLimit,
        readOnlyRootFilesystem: command.runtimeConfig.readOnlyRootFilesystem,
        user: "65532:65532",
      },
    };
  }

  public async start(command: StartDeploymentRuntimeCommand): Promise<StartedDeploymentRuntime> {
    assertSafeRuntimeCommand(command);
    await this.prepareDockerConfiguration();
    if (command.signal.aborted) throw command.signal.reason;
    const name = nameFor(command.identity.deploymentId);
    const existing = await this.inspect(name, command.signal);
    if (existing !== undefined) {
      const runtime = this.validateInspection(existing, command);
      if (!existing.State?.Running) await this.execute(["start", name], command.signal);
      return runtime;
    }
    const args = [
      "create",
      "--name",
      name,
      "--network",
      "bridge",
      "--publish",
      `127.0.0.1::${command.healthCheckPort}/tcp`,
      "--user",
      "65532:65532",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--pids-limit",
      String(command.runtimeConfig.processLimit),
      "--memory",
      `${command.runtimeConfig.memoryMegabytes}m`,
      "--memory-swap",
      `${command.runtimeConfig.memoryMegabytes}m`,
      "--cpus",
      String(command.runtimeConfig.cpuMillicores / 1000),
      "--read-only",
      "--tmpfs",
      `/tmp:rw,noexec,nosuid,size=${this.limits.tmpfsMegabytes}m`,
      "--restart",
      "no",
    ];
    for (const [key, value] of Object.entries(labels(command)).sort(([left], [right]) =>
      left.localeCompare(right),
    ))
      args.push("--label", `${key}=${value}`);
    args.push(command.image.imageId);
    try {
      await this.execute(args, command.signal);
    } catch (error) {
      if ((await this.inspect(name, command.signal)) === undefined)
        throw fail("runtime_start_failed", "The runtime container could not be created", true);
    }
    try {
      await this.execute(["start", name], command.signal);
    } catch {
      throw fail("runtime_start_failed", "The runtime container could not be started", true);
    }
    const inspected = await this.inspect(name, command.signal);
    if (inspected === undefined || !inspected.State?.Running)
      throw fail(
        "runtime_start_failed",
        "The runtime container did not enter the running state",
        true,
      );
    return this.validateInspection(inspected, command);
  }

  public async stop(command: StopDeploymentRuntimeCommand): Promise<void> {
    if (!uuidPattern.test(command.identity.deploymentId) || !idPattern.test(command.containerId))
      throw new RangeError("Runtime cleanup identity is invalid");
    await this.prepareDockerConfiguration();
    try {
      await this.execute(
        ["stop", "--time", String(this.limits.stopGraceSeconds), command.containerId],
        command.signal,
      );
    } catch {
      /* an already stopped container remains removable */
    }
    try {
      await this.execute(["rm", command.containerId], command.signal);
    } catch {
      throw fail("runtime_cleanup_failed", "The runtime container could not be removed", true);
    }
  }
}
