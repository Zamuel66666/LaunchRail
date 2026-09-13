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

export interface RollbackDeploymentCommand {
  readonly actorUserId?: string;
  readonly deploymentId: string;
  readonly idempotencyKey: string;
  readonly organizationId: string;
}

export interface DeploymentHistorySummary {
  readonly createdAt: Date;
  readonly deploymentId: string;
  readonly finishedAt: Date | null;
  readonly healthCheckedAt: Date | null;
  readonly projectId: string;
  readonly sourceRevision: string;
  readonly state: DeploymentState;
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
  listDeployments?(query: {
    readonly limit: number;
    readonly organizationId: string;
    readonly projectId: string;
  }): Promise<readonly DeploymentHistorySummary[]>;
  listEvents?(query: {
    readonly deploymentId: string;
    readonly organizationId: string;
    readonly limit: number;
  }): Promise<
    readonly {
      readonly createdAt: Date;
      readonly fromState: DeploymentState | null;
      readonly kind: string;
      readonly metadata: Readonly<Record<string, unknown>>;
      readonly sequence: number;
      readonly toState: DeploymentState;
    }[]
  >;
  promote(command: PromoteDeploymentCommand): Promise<DeploymentTransitionResult>;
  rollback?(command: RollbackDeploymentCommand): Promise<DeploymentTransitionResult>;
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

export class RollbackDeployment {
  public constructor(private readonly store: DeploymentTransitionStore) {}

  public execute(command: RollbackDeploymentCommand): Promise<DeploymentTransitionResult> {
    if (this.store.rollback === undefined) throw new Error("Rollback is not supported");
    return this.store.rollback(command);
  }
}
