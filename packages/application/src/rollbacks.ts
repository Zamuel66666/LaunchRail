import type {
  DeploymentRuntimeInput,
  StartedDeploymentRuntimeMetadata,
} from "./deployment-jobs.js";

export interface DeploymentRollbackLease {
  readonly id: string;
  readonly leaseToken: string;
  readonly sourceDeploymentId: string;
  readonly runtime: DeploymentRuntimeInput;
}

export interface DeploymentRollbackStore {
  claim(command: {
    readonly workerId: string;
    readonly leaseDurationMs: number;
  }): Promise<DeploymentRollbackLease | null>;
  heartbeat(command: {
    readonly id: string;
    readonly leaseToken: string;
    readonly leaseDurationMs: number;
  }): Promise<boolean>;
  finish(command: {
    readonly id: string;
    readonly leaseToken: string;
    readonly result:
      | {
          readonly runtime: StartedDeploymentRuntimeMetadata;
          readonly healthDurationMs: number;
          readonly healthStatusCode: number;
          readonly healthCheckedAt: Date;
        }
      | {
          readonly runtime?: StartedDeploymentRuntimeMetadata;
          readonly healthFailure?: {
            readonly statusCode: number | null;
            readonly durationMs: number;
            readonly checkedAt: Date;
          };
          readonly errorCode:
            | "rollback_unhealthy"
            | "rollback_infrastructure_unavailable"
            | "rollback_invalid_snapshot";
        };
  }): Promise<boolean>;
}
