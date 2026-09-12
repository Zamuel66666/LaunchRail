import type { ProjectRuntimeConfig } from "@launchrail/domain";

export const runtimeStartErrorCodes = [
  "runtime_policy_rejected",
  "runtime_start_failed",
  "runtime_timeout",
  "runtime_unavailable",
  "runtime_metadata_invalid",
  "runtime_cleanup_failed",
] as const;

export type RuntimeStartErrorCode = (typeof runtimeStartErrorCodes)[number];

export interface DeploymentRuntimeIdentity {
  readonly deploymentId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly workItemId: string;
}

export interface RuntimeImage {
  readonly imageId: string;
  readonly imageReference: string;
  readonly manifestDigest: string;
  readonly platform: string;
}

export interface StartDeploymentRuntimeCommand {
  readonly healthCheckPort: number;
  readonly identity: DeploymentRuntimeIdentity;
  readonly image: RuntimeImage;
  readonly runtimeConfig: ProjectRuntimeConfig;
  readonly signal: AbortSignal;
}

export interface StartedDeploymentRuntime {
  readonly containerId: string;
  readonly hostPort: number;
  readonly resourceMetadata: Readonly<Record<string, unknown>>;
}

export interface StopDeploymentRuntimeCommand {
  readonly containerId: string;
  readonly identity: DeploymentRuntimeIdentity;
  readonly signal: AbortSignal;
}

export interface ReadDeploymentRuntimeLogsCommand {
  readonly containerId: string;
  readonly identity: DeploymentRuntimeIdentity;
  readonly signal: AbortSignal;
  readonly tail: number;
}

export interface DeploymentRuntimeManager {
  readLogs(command: ReadDeploymentRuntimeLogsCommand): Promise<string>;
  start(command: StartDeploymentRuntimeCommand): Promise<StartedDeploymentRuntime>;
  stop(command: StopDeploymentRuntimeCommand): Promise<void>;
}

export class RuntimeStartError extends Error {
  public readonly code: RuntimeStartErrorCode;
  public readonly retryable: boolean;

  public constructor(options: {
    readonly code: RuntimeStartErrorCode;
    readonly message: string;
    readonly retryable: boolean;
  }) {
    super(options.message);
    this.name = "RuntimeStartError";
    this.code = options.code;
    this.retryable = options.retryable;
  }
}
