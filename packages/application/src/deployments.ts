import type { DeploymentFailureCategory, DeploymentState } from "@launchrail/domain";

export interface TransitionDeploymentCommand {
  readonly actorUserId?: string;
  readonly deploymentId: string;
  readonly failure?: {
    readonly category: DeploymentFailureCategory;
    readonly message: string;
  };
  readonly idempotencyKey: string;
  readonly organizationId: string;
  readonly to: DeploymentState;
}

export interface PromoteDeploymentCommand {
  readonly actorUserId?: string;
  readonly deploymentId: string;
  readonly idempotencyKey: string;
  readonly organizationId: string;
}

export interface DeploymentTransitionResult {
  readonly deploymentId: string;
  readonly eventSequence: number;
  readonly from: DeploymentState;
  readonly idempotentReplay: boolean;
  readonly to: DeploymentState;
  readonly version: number;
}

export interface DeploymentTransitionStore {
  promote(command: PromoteDeploymentCommand): Promise<DeploymentTransitionResult>;
  transition(command: TransitionDeploymentCommand): Promise<DeploymentTransitionResult>;
}

export class TransitionDeployment {
  public constructor(private readonly store: DeploymentTransitionStore) {}

  public execute(command: TransitionDeploymentCommand): Promise<DeploymentTransitionResult> {
    return this.store.transition(command);
  }
}

export class PromoteDeployment {
  public constructor(private readonly store: DeploymentTransitionStore) {}

  public execute(command: PromoteDeploymentCommand): Promise<DeploymentTransitionResult> {
    return this.store.promote(command);
  }
}
